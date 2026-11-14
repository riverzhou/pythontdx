#!/usr/bin/env node
/**
 * Python 命令的统一入口。
 *
 * 为什么不用 `python3` 直接写进 package.json：
 *   · Windows 上通常是 `python` 或 `py -3`，没有 `python3`；
 *   · 用户可能用 PYTHONTDX_PYTHON 指定解释器；
 *   · 找不到时给一句能看懂的中文，而不是 ENOENT。
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const command = process.argv[2]
if (command !== 'test' && command !== 'build' && command !== 'audit' && command !== 'social') {
  console.error('用法：node scripts/python.mjs <test|build|audit|social>')
  process.exit(1)
}

const candidates = process.env.PYTHONTDX_PYTHON
  ? [[process.env.PYTHONTDX_PYTHON, []]]
  : process.platform === 'win32'
    ? [
        ['python', []],
        ['py', ['-3']]
      ]
    : [
        ['python3', []],
        ['python', []]
      ]

function usable(executable, prefix) {
  const probe = spawnSync(executable, [...prefix, '-c', 'import sys'], { stdio: 'ignore' })
  return probe.status === 0
}

const found = candidates.find(([executable, prefix]) => usable(executable, prefix))
if (!found) {
  console.error('找不到 Python 3。请安装后重试，或设置 PYTHONTDX_PYTHON 指向解释器。')
  process.exit(1)
}

const [executable, prefix] = found
const args =
  command === 'test'
    ? ['-m', 'unittest', 'discover', '-s', 'python', '-p', 'test_*.py', '-v']
    : command === 'audit'
      ? ['scripts/data/data_audit.py', '--json']
      : command === 'social'
        ? ['scripts/dev/social-preview.py']
        : ['python/build.py']

const result = spawnSync(executable, [...prefix, ...args], {
  cwd: process.cwd(),
  stdio: 'inherit'
})

process.exit(result.status ?? 1)
