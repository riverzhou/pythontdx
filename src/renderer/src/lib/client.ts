/**
 * 渲染层的唯一出口：数据面 + 壳能力。
 *
 * 组件 / store 只从这里取 `api`（数据，走本地 HTTP）与 `shell`（窗口、文件、
 * 通知，桌面走 preload、浏览器降级）；不直接 `fetch`，也不直接读 `window.desktop`。
 *
 * 1.8.0 之前这里叫 `ipc.ts`：通讯统一成 HTTP 之后 IPC 已不是数据通道，
 * 名字跟着事实走，改为 `client.ts`。壳能力实现在 `./shell`。
 */
import type { PythonTdxApi } from '@shared/api'
import { createHttpApi } from './http-api'

export const api: PythonTdxApi = createHttpApi()
export { shell } from './shell'

/**
 * 把后端/网络异常洗成人话。
 * Electron 旧版会把错误包装成 "Error invoking remote method 'x': ..."，
 * 现在统一走 HTTP，但仍保留这层兼容，避免历史错误串直接展示给用户。
 */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '')
      .trim() || '未知错误'
  )
}
