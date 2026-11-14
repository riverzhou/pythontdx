/**
 * Web 入口：与 Electron 使用同一份渲染层、同一套 HTTP 数据面。
 *
 * 不再注入 `window.api`；桌面壳能力由 `window.desktop` 提供（浏览器没有）。
 */
import '../renderer/src/main'
