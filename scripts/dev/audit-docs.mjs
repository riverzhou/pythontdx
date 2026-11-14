#!/usr/bin/env node
/**
 * 文档自检：链接、截图、路径引用、HTTP 契约。
 *
 * 为什么需要：文档散落在 26 篇里，路径/截图/计数靠人记必然漂移。
 * 这个脚本只做四件能自动判定的事，不做主观判断：
 *   1. Markdown 里的相对链接是否指向真实文件；
 *   2. `docs/assets/*.png` 截图引用是否存在；
 *   3. 反引号里的仓库路径是否存在（允许少量历史/外部路径白名单）；
 *   4. 客户端调用的 `/api/*` 是否都在服务端有路由。
 *
 * 用法：`npm run audit:docs`；任何一项失败返回 1。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC_FILES = [
  'README.md',
  'AGENTS.md',
  'PLAN.md',
  'PRINCIPLES.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`)
]

/** 历史条目/外部仓库/构建产物：不要求在本仓库存在 */
const PATH_ALLOW = [
  /^docs\/[0-9]{2}$/, // 简写：docs/23 → docs/23-xxx.md
  /^docs\/(benchmark|security|ARCHITECTURE|F10|methods)/, // 外部调研仓库路径
  /^src\/eltdx\//,
  /^(python\/dist|resources\/tdx-bridge|resources\/web)\//,
  /^docs\/NN-/,
  /^src\/main\/ipc\.ts$/, // 1.7.0 已删除，仅出现在历史说明
  /^src\/shared\/ipc\.ts$/, // 更早的 IPC 契约，仅出现在历史说明
  /^src\/web\/http-api\.ts$/,
  /^scripts\/(before-pack\.cjs|sign-win\.ps1)$/, // 2.0.0 前的旧路径，见 docs/07 路径说明
  /^src\/renderer\/src\/styles\/app\.css$/,
  /^python\/test_/,
  /^src\/main\/(window|tray|capture|diagnostics|native-ipc)\.ts$/
]

const failures = []
const notes = []

function fail(section, message) {
  failures.push(`[${section}] ${message}`)
}

// ---------------------------------------------------------------- 1. 链接
for (const file of DOC_FILES) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const base = dirname(file)
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = match[1]
    if (/^(https?:|#|mailto:)/.test(href)) continue
    const target = join(ROOT, base, href.split('#')[0])
    if (!existsSync(target)) fail('link', `${file} → ${href}`)
  }
}

// ---------------------------------------------------------------- 2. 截图
let shots = 0
for (const file of DOC_FILES) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  for (const match of text.matchAll(/docs\/assets\/[A-Za-z0-9._-]+\.png/g)) {
    shots += 1
    if (!existsSync(join(ROOT, match[0]))) fail('asset', `${file} → ${match[0]}`)
  }
}

// ---------------------------------------------------------------- 3. 路径引用
let paths = 0
for (const file of DOC_FILES) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  for (const match of text.matchAll(/`((?:src|python|scripts|docs|\.github)\/[A-Za-z0-9_./-]+)`/g)) {
    const value = match[1].replace(/[.,;:]+$/, '')
    if (value.endsWith('/') || /[*<>{}|$]/.test(value)) continue
    if (PATH_ALLOW.some((pattern) => pattern.test(value))) continue
    paths += 1
    if (!existsSync(join(ROOT, value))) fail('path', `${file} → ${value}`)
  }
}

// ---------------------------------------------------------------- 4. 契约
const server = readFileSync(join(ROOT, 'python/tdx_server.py'), 'utf8')
const client = readFileSync(join(ROOT, 'src/renderer/src/lib/http-api.ts'), 'utf8')
const routes = new Set([...server.matchAll(/(["'])(\/api\/[a-z_0-9]+)\1/g)].map((m) => m[2]))
const calls = new Set([...client.matchAll(/[`'](\/api\/[a-z_0-9]+)/g)].map((m) => m[1]))
for (const call of calls) {
  if (!routes.has(call)) fail('api', `客户端调用没有服务端路由：${call}`)
}
notes.push(`服务端路由 ${routes.size} 条，客户端调用 ${calls.size} 条（全部有对应路由）`)

// ---------------------------------------------------------------- 汇总
console.log(`链接/截图/路径检查：${DOC_FILES.length} 篇文档、${shots} 处截图、${paths} 处路径引用`)
for (const note of notes) console.log(`  ${note}`)
if (failures.length > 0) {
  console.error(`\n发现 ${failures.length} 个问题：`)
  for (const failure of failures.slice(0, 40)) console.error(`  ${failure}`)
  if (failures.length > 40) console.error(`  …还有 ${failures.length - 40} 个`)
  process.exit(1)
}
console.log('文档自检通过。')
