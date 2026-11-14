/**
 * 开发期诊断：把渲染进程里发生的事搬到终端里来。
 *
 * 新手最容易踩的坑是「界面白屏，但终端一片安静」——
 * 渲染层的报错默认只出现在 DevTools 里，很容易被忽略。
 * 把这些事件接到主进程后，`npm run dev` 的终端就是唯一的排错入口。
 */
import { is } from '@electron-toolkit/utils'
import type { BrowserWindow } from 'electron'

export function attachDiagnostics(window: BrowserWindow): void {
  const { webContents } = window

  // 这两个事件在开发和打包后都应该有记录
  webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] 渲染进程异常退出：', details.reason, details.exitCode)
  })

  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer] 页面加载失败：${errorDescription} (${errorCode}) ${validatedURL}`)
  })

  if (!is.dev) return

  // Solid 的报错、未捕获异常、以及任何 console.* 都会走这里
  webContents.on('console-message', (details) => {
    const tag = `[renderer:${details.level}]`
    const location = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''
    if (details.level === 'error') console.error(`${tag} ${details.message}${location}`)
    else if (details.level === 'warning') console.warn(`${tag} ${details.message}${location}`)
    else console.log(`${tag} ${details.message}`)
  })
}
