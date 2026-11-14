/**
 * 桌面壳能力契约（只包含浏览器做不到的事）。
 *
 * 数据面已经统一：Electron 与 Web 都通过本地 HTTP/WebSocket 取行情，
 * `PythonTdxApi` 不再区分两端。这里只保留窗口、文件对话框、系统通知、
 * 本机状态文件这类必须由 Electron 主进程完成的能力。
 *
 * Web 端由 `src/renderer/src/lib/shell.ts` 提供同形状的降级实现，
 * 组件只依赖 `ShellApi`，不直接摸 `window.desktop`。
 */
import type {
  AppInfo,
  AppState,
  DisplayInfo,
  GraphicsInfo,
  LinuxDesktopResult,
  WindowAction,
  WindowState
} from './types'

export const NATIVE_IPC = {
  stateGet: 'state:get',
  statePatch: 'state:patch',
  windowControl: 'window:control',
  windowAlwaysOnTop: 'window:always-on-top',
  windowDisplays: 'window:displays',
  windowMoveDisplay: 'window:move-display',
  windowState: 'window:state',
  appInfo: 'app:info',
  appGraphics: 'app:graphics',
  appLinuxDesktop: 'app:linux-desktop',
  appOpenExternal: 'app:open-external',
  appNotify: 'app:notify',
  dialogSave: 'dialog:save',
  dialogOpen: 'dialog:open',
  dialogDirectory: 'dialog:directory'
} as const

export interface DialogFilter {
  name: string
  extensions: string[]
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
}

export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
}

/** 桌面端 preload 暴露的 `window.desktop`；Web 端没有这个对象。 */
export interface DesktopApi {
  readonly isDesktop: true
  info(): Promise<AppInfo>
  state: {
    get(): Promise<AppState>
    patch(patch: Partial<AppState>): Promise<AppState>
  }
  window: {
    control(action: WindowAction): Promise<WindowState>
    toggleAlwaysOnTop(): Promise<boolean>
    displays(): Promise<DisplayInfo[]>
    moveToDisplay(displayId: number): Promise<boolean>
    onStateChange(listener: (state: WindowState) => void): () => void
  }
  dialogs: {
    /** 保存文件；取消返回 null */
    save(options: SaveDialogOptions): Promise<string | null>
    /** 打开文件；取消返回 null */
    open(options: OpenDialogOptions): Promise<string | null>
    /** 选择目录；取消返回 null */
    directory(options?: OpenDialogOptions): Promise<string | null>
  }
  app: {
    graphics(): Promise<GraphicsInfo>
    installLinuxDesktop(): Promise<LinuxDesktopResult>
    openExternal(url: string): Promise<void>
    notify(title: string, body: string): Promise<void>
  }
}

/** 渲染层使用的统一壳接口：桌面用 preload，Web 用降级实现。 */
export interface ShellApi {
  readonly isDesktop: boolean
  info(): Promise<AppInfo>
  state: DesktopApi['state']
  window: DesktopApi['window']
  dialogs: DesktopApi['dialogs']
  app: DesktopApi['app']
}
