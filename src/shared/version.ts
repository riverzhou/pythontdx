/**
 * 版本号格式化。
 *
 * 真正的版本由构建注入（Web：Vite define；桌面：preload 的 app.info），
 * 这里只负责统一 Web 后缀，避免页面里再出现写死的 `v0.7.0-web` 之类常量。
 */
export function webVersion(version: string): string {
  return `${version}-web`
}
