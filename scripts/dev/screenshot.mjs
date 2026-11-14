/**
 * 启动 Electron 并截一张界面图。
 *
 *   node scripts/screenshot.mjs [输出路径] [等待毫秒]
 *
 * 前置条件：先执行 `npm run build`（本脚本用的是生产产物，顺带验证打包结果）。
 * 通常不需要直接调用它，用 `npm run shot` 即可。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const target = resolve(ROOT, process.argv[2] ?? 'screenshots/app.png')
const delay = process.argv[3] ?? '4000'

mkdirSync(dirname(target), { recursive: true })

const env = {
  ...process.env,
  PYTHONTDX_CAPTURE: target,
  PYTHONTDX_CAPTURE_DELAY: delay,
  // 与用户正在运行的 pythontdx 隔离，避免单实例锁导致截图进程直接退出。
  PYTHONTDX_USER_DATA: join(ROOT, '.tmp', `capture-userdata-${process.pid}`)
}
// 当前终端可能带着这个变量（它会让 Electron 退化成纯 Node 模式，窗口根本不会出现）
delete env.ELECTRON_RUN_AS_NODE

console.log(`[shot] 启动 Electron 截图 → ${target}`)

const child = spawn(electronPath, [ROOT], { cwd: ROOT, stdio: 'inherit', env })

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (error) => {
  console.error('[shot] 启动 Electron 失败：', error)
  process.exit(1)
})
