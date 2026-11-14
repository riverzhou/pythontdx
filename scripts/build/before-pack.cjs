/**
 * electron-builder 打包前检查 sidecar 平台与架构。
 *
 * electron-builder 允许在 Linux 上 `--win dir`、在 Apple Silicon 上 `--x64`，
 * 但它只会把当前平台的 `python/dist/tdx-bridge` 原样复制进去——Linux 版是 ELF，
 * Windows 包拿到后无法启动；macOS 只交付 arm64（2026-11-02 决定不支持 Intel），
 * x64/universal 目标会被直接拒绝。宁可打包失败，也不要产出“看起来成功”的坏包。
 *
 * 文件名也要按平台区分：Nuitka 在 Windows 上产出的叫 `tdx-bridge.exe`，
 * 早先这里只找不带扩展名的那个，导致 Windows 打包 100% 报“找不到 sidecar”
 * （2026-11-01 实测）。所以路径推导抽成纯函数，由 `before-pack.test.mjs` 守住。
 *
 * 2026-11-02 macOS 实机打包又踩到一个：单架构 Mach-O 的 magic 是小端存储的
 * `cf fa ed fe`，这里当初只用 `readUInt32BE` 比较 `0xfeedfacf`，永远不相等。
 * 系统自带二进制都是 universal（`ca fe ba be`）所以一直没暴露；Nuitka 产出的
 * 是 thin arm64，于是 macOS 打包必然报“不是 Mach-O”。现在统一按小端读 thin，
 * 并且把架构也一起校验（Arch 数字：1 = x64、3 = arm64、4 = universal）。
 */
const { closeSync, openSync, readSync } = require('node:fs')
const { join } = require('node:path')

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c
/** fat/universal 头（大端），64 位版本的表项是 32 字节而不是 20 字节 */
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
/** thin Mach-O 的 magic（文件里按小端存，读出来才是 0xfeedfacx） */
const MH_MAGIC = 0xfeedface
const MH_MAGIC_64 = 0xfeedfacf

/** sidecar 的文件名：Windows 带 .exe，Linux/macOS 不带扩展名 */
function sidecarFileName(platform) {
  return platform === 'win32' ? 'tdx-bridge.exe' : 'tdx-bridge'
}

/** sidecar 的完整路径（由 `npm run build:python` 产出） */
function sidecarPath(projectDir, platform) {
  return join(projectDir, 'python', 'dist', sidecarFileName(platform))
}

function cpuName(cpu) {
  if (cpu === CPU_TYPE_ARM64) return 'arm64'
  if (cpu === CPU_TYPE_X86_64) return 'x64'
  // 其他架构（arm64e、i386…）照实写出来，报错时能直接看出拿到了什么
  return `cpu:${cpu.toString(16)}`
}

/**
 * Mach-O 里声明的架构列表；不是 Mach-O 返回 undefined。
 *
 * thin 头只有 8 字节就够（magic + cputype）；universal 要读 arch 表，
 * 每个表项 20 字节（64 位 fat 是 32 字节）。调用方给 4 KB 文件头足够。
 */
function machoArches(buffer) {
  if (!buffer || buffer.length < 8) return undefined

  const bigEndianMagic = buffer.readUInt32BE(0)
  if (bigEndianMagic === FAT_MAGIC || bigEndianMagic === FAT_MAGIC_64) {
    const count = buffer.readUInt32BE(4)
    const stride = bigEndianMagic === FAT_MAGIC_64 ? 32 : 20
    const arches = []
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * stride
      if (offset + 4 > buffer.length) break
      arches.push(cpuName(buffer.readUInt32BE(offset)))
    }
    return arches
  }

  // thin Mach-O：x86_64 / arm64 都是小端，magic 在文件里是 cf fa ed fe
  const magic = buffer.readUInt32LE(0)
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return undefined
  return [cpuName(buffer.readUInt32LE(4))]
}

/** electron-builder 的 Arch → 架构名；已经是字符串时原样返回 */
function targetArchName(arch) {
  if (typeof arch === 'string') return arch
  return { 1: 'x64', 3: 'arm64', 4: 'universal' }[arch]
}

function isPe(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a
}

function isElf(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  )
}

/**
 * 校验 sidecar 能不能用于「目标平台 + 目标架构」。
 *
 * @returns {string | undefined} 不匹配时返回可以直接给用户看的中文，匹配返回 undefined
 */
function sidecarProblem(platform, arch, buffer) {
  if (!buffer || buffer.length < 4) return '读不到 sidecar 的文件头，无法判断平台。'

  if (platform === 'win32') {
    return isPe(buffer)
      ? undefined
      : 'Windows 包需要 Windows 版 sidecar（PE），当前不是 PE。请在 Windows 上构建，或先交叉编译 sidecar。'
  }

  if (platform === 'darwin') {
    const arches = machoArches(buffer)
    if (!arches) return 'macOS 包需要 Mach-O 版 sidecar，当前不是 Mach-O。请在 macOS 上构建。'

    const want = targetArchName(arch) ?? process.arch
    if (want !== 'arm64') {
      // 2026-11-02 用户决定 macOS 只维护 Apple Silicon，不做 Intel / universal。
      return `macOS 只发布 arm64 版本（不支持 Intel）；当前目标是 ${want}。请在 Apple Silicon 上用 npm run build:mac 构建。`
    }
    if (arches.includes('arm64')) return undefined
    return `macOS arm64 包需要 arm64 版 sidecar，当前是 ${arches.join('/')}。请在 Apple Silicon 上构建（npm run build:mac）。`
  }

  if (platform === 'linux') {
    return isElf(buffer) ? undefined : 'Linux 包需要 ELF 版 sidecar，当前不是 ELF。'
  }

  return undefined
}

/** 只读文件头：sidecar 二十多 MB，没必要整个读进内存 */
function headerOf(path, length = 4096) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

exports.sidecarFileName = sidecarFileName
exports.sidecarPath = sidecarPath
exports.machoArches = machoArches
exports.sidecarProblem = sidecarProblem

exports.default = async function beforePack(context) {
  const platform = context.electronPlatformName
  const bridge = sidecarPath(context.packager.projectDir, platform)
  const header = headerOf(bridge)
  if (!header) {
    throw new Error(`找不到 sidecar：${bridge}，请先运行 npm run build:python`)
  }
  const problem = sidecarProblem(platform, context.arch, header)
  if (problem) throw new Error(problem)
}
