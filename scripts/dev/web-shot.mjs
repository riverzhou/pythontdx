/**
 * `npm run shot:web` 的启动器。
 *
 * 为什么不直接 `electron scripts/dev/web-shot.cjs`：
 * 终端里可能带着 `ELECTRON_RUN_AS_NODE=1`（Electron 会退化成纯 Node 跑，
 * 窗口不会出现、`require('electron').app` 是 undefined）。桌面截图脚本
 * 已经在 spawn 前删掉它，Web 截图以前没有，于是在这种 shell 里直接报错。
 *
 * 这里统一在 spawn 前清理环境变量，用法与 `scripts/dev/screenshot.mjs` 一致。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, [join(here, 'web-shot.cjs')], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (error) => {
  console.error('[shot:web] 启动 Electron 失败：', error)
  process.exit(1)
})
