/**
 * before-pack 的平台判定测试。
 *
 * 起源（2026-11-01）：Windows 上 Nuitka 产出 `python/dist/tdx-bridge.exe`，
 * 而脚本写死去找 `python/dist/tdx-bridge`，`npm run build:win` 必然报
 * “找不到 sidecar”。这条测试锁住文件名映射，避免再犯。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { sidecarFileName, sidecarPath, machoArches, sidecarProblem } = require('./before-pack.cjs')

const CPU_X64 = 0x01000007
const CPU_ARM64 = 0x0100000c

/** 构造一个 thin Mach-O 头（64 位、小端存储，和真实文件一致） */
function thinMacho(cpu) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpu, 4)
  return header
}

/** 构造一个 fat/universal 头（大端，表项 20 字节） */
function fatMacho(cpus) {
  const header = Buffer.alloc(8 + cpus.length * 20)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(cpus.length, 4)
  cpus.forEach((cpu, index) => header.writeUInt32BE(cpu, 8 + index * 20))
  return header
}

describe('before-pack 的 sidecar 路径', () => {
  it('Windows 找 .exe', () => {
    expect(sidecarFileName('win32')).toBe('tdx-bridge.exe')
    expect(sidecarPath('D:\\app', 'win32')).toBe(
      join('D:\\app', 'python', 'dist', 'tdx-bridge.exe')
    )
  })

  it('Linux / macOS 不带扩展名', () => {
    expect(sidecarFileName('linux')).toBe('tdx-bridge')
    expect(sidecarFileName('darwin')).toBe('tdx-bridge')
    expect(sidecarPath('/app', 'linux')).toBe(join('/app', 'python', 'dist', 'tdx-bridge'))
  })
})

/**
 * 起源（2026-11-02 macOS 实机打包）：Nuitka 产出的单架构 sidecar 是
 * `cf fa ed fe`（小端 MH_MAGIC_64），而这里当初用 readUInt32BE 比较
 * `0xfeedfacf`——系统自带的二进制都是 universal（`ca fe ba be`）所以没暴露，
 * 于是 macOS 打包必然报「不是 Mach-O」。顺带补上架构校验：在 arm64 上
 * 顺手打 x64 会得到「x64 外壳 + arm64 sidecar」的坏包，Intel 机器上行情起不来。
 */
describe('before-pack 的 sidecar 架构', () => {
  it('thin Mach-O 按小端读魔数', () => {
    expect(machoArches(thinMacho(CPU_ARM64))).toEqual(['arm64'])
    expect(machoArches(thinMacho(CPU_X64))).toEqual(['x64'])
  })

  it('universal 二进制解析出全部架构', () => {
    expect(machoArches(fatMacho([CPU_X64, CPU_ARM64]))).toEqual(['x64', 'arm64'])
  })

  it('不是 Mach-O 时返回 undefined', () => {
    expect(machoArches(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBeUndefined()
    expect(machoArches(Buffer.alloc(0))).toBeUndefined()
  })

  it('架构匹配的 sidecar 放行', () => {
    expect(sidecarProblem('darwin', 'arm64', thinMacho(CPU_ARM64))).toBeUndefined()
    // electron-builder 的 Arch 是数字：3 = arm64
    expect(sidecarProblem('darwin', 3, thinMacho(CPU_ARM64))).toBeUndefined()
  })

  it('x64 / universal 目标直接拒绝（macOS 只支持 Apple Silicon）', () => {
    for (const arch of ['x64', 1, 'universal', 4]) {
      const problem = sidecarProblem('darwin', arch, thinMacho(CPU_ARM64))
      expect(problem).toContain('arm64')
      expect(problem).toContain('不支持 Intel')
    }
  })

  it('架构不匹配时给出人话', () => {
    const problem = sidecarProblem('darwin', 'arm64', thinMacho(CPU_X64))
    expect(problem).toContain('arm64')
    expect(problem).toContain('x64')
    expect(problem).toContain('Apple Silicon')
  })

  it('非 Mach-O 的 darwin sidecar 仍然拒绝', () => {
    // 真实场景：拿 Linux 的 ELF 来打 macOS 包（或反过来）
    expect(sidecarProblem('darwin', 'arm64', Buffer.from('\x7fELF'))).toContain('Mach-O')
    expect(sidecarProblem('darwin', 'arm64', Buffer.from('MZ\x90\x00'))).toContain('Mach-O')
    // 文件头不完整时给通用错误，而不是误判成某种平台
    expect(sidecarProblem('darwin', 'arm64', Buffer.from('MZ'))).toContain('文件头')
  })

  it('Windows / Linux 的魔数判定不受影响', () => {
    expect(sidecarProblem('win32', 1, Buffer.from('MZ\x90\x00'))).toBeUndefined()
    expect(sidecarProblem('win32', 1, Buffer.from('\x7fELF'))).toBeDefined()
    expect(sidecarProblem('linux', 1, Buffer.from('\x7fELF'))).toBeUndefined()
    expect(sidecarProblem('linux', 1, Buffer.from('MZ'))).toBeDefined()
  })
})
