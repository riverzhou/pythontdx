/**
 * 让渲染进程的 TypeScript 知道 `window.desktop` 长什么样。
 *
 * 数据面已统一为 HTTP/WebSocket，`window.api` 不再存在；
 * 桌面壳能力只通过 `window.desktop` 暴露，Web 端没有这个对象。
 */
import type { DesktopApi } from '@shared/desktop'

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}

export {}
