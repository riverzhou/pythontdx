/**
 * 桌面壳：窗口、显示、图形、服务器与应用信息、Linux 集成。
 *
 * 由 `shared/types.ts` 门面统一再导出；外部一律 `from '@shared/types'`。
 */
export type WindowAction =
  'minimize' | 'toggle-maximize' | 'toggle-fullscreen' | 'close' | 'toggle-devtools'

export interface WindowState {
  maximized: boolean
  focused: boolean
  /** 是否处于系统全屏 */
  fullscreen?: boolean
  /** win32 / darwin / linux / web */
  platform: string
}

/** 一块物理/逻辑显示器；Web 端返回一个虚拟项。 */
export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  scaleFactor: number
  primary: boolean
  /** 当前窗口是否在这块屏上 */
  current: boolean
}

export interface GraphicsInfo {
  session: string
  wayland: boolean
  requested: string
  platform: string
  gpuFeatureStatus: Record<string, string>
}

export interface ServerHostResult {
  host: string
  port: number
  latencyMs: number
  status: 'ok' | 'error'
  error: string
  preferred: boolean
}

export interface ServerSpeedResult {
  hosts: ServerHostResult[]
  preferred: string | null
  /** connect.cfg 路径或 builtin-public-list */
  source: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  /** 是否从 Linux AppImage 启动（设置面板据此显示「修复双击」） */
  appImage?: boolean
}

/** Linux AppImage 桌面集成结果（修复「文件管理器双击不启动」）。 */
export interface LinuxDesktopResult {
  desktopFile: string
  launcherScript: string
  launcherDesktopFile: string
  mimeAppsFile: string
  changed: boolean
  previousHandler: string | null
}
