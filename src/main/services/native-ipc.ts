/**
 * 桌面壳 IPC：只注册浏览器做不到的能力。
 *
 * 行情/图表/F10 等数据请求全部走本地 HTTP（见 services/server.ts），
 * 因此这里没有 `quote:*` / `trend:*` / `f10:*` 之类的通道；
 * 主进程不再成为第二条数据路径。
 */
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import type { AppState, WindowAction } from '@shared/types'
import { NATIVE_IPC, type OpenDialogOptions, type SaveDialogOptions } from '@shared/desktop'
import { installLinuxDesktopIntegration } from './linux-desktop'
import type { AppStore } from './store'
import { listDisplays, moveWindowToDisplay } from './window'

export interface NativeContext {
  store: AppStore
  getWindow: () => BrowserWindow | null
}

function ownerWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

export function registerNativeHandlers(context: NativeContext): void {
  const { store, getWindow } = context

  /* ------------------------------------------------------------ 状态 */
  ipcMain.handle(NATIVE_IPC.stateGet, () => store.state)
  ipcMain.handle(NATIVE_IPC.statePatch, (_event, patch: Partial<AppState>) =>
    store.patchState(patch)
  )

  /* ------------------------------------------------------------ 窗口 */
  ipcMain.handle(NATIVE_IPC.windowControl, (event, action: WindowAction) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? getWindow()
    if (!window) {
      return { maximized: false, focused: false, fullscreen: false, platform: process.platform }
    }
    switch (action) {
      case 'minimize':
        window.minimize()
        break
      case 'toggle-maximize':
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        break
      case 'toggle-fullscreen':
        window.setFullScreen(!window.isFullScreen())
        break
      case 'close':
        window.close()
        break
      case 'toggle-devtools':
        window.webContents.toggleDevTools()
        break
      default:
        break
    }
    return {
      maximized: window.isMaximized(),
      focused: window.isFocused(),
      fullscreen: window.isFullScreen(),
      platform: process.platform
    }
  })

  ipcMain.handle(NATIVE_IPC.windowAlwaysOnTop, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    const next = !window.isAlwaysOnTop()
    window.setAlwaysOnTop(next)
    return next
  })

  ipcMain.handle(NATIVE_IPC.windowDisplays, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? getWindow()
    return window ? listDisplays(window) : []
  })

  ipcMain.handle(NATIVE_IPC.windowMoveDisplay, (event, displayId: number) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? getWindow()
    return window ? moveWindowToDisplay(window, displayId) : false
  })

  /* ------------------------------------------------------------ 对话框 */
  ipcMain.handle(NATIVE_IPC.dialogSave, async (_event, options: SaveDialogOptions = {}) => {
    const config = {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters
    }
    const owner = ownerWindow()
    const result = owner
      ? await dialog.showSaveDialog(owner, config)
      : await dialog.showSaveDialog(config)
    return result.canceled || !result.filePath ? null : result.filePath
  })

  ipcMain.handle(NATIVE_IPC.dialogOpen, async (_event, options: OpenDialogOptions = {}) => {
    const config = {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties: ['openFile' as const]
    }
    const owner = ownerWindow()
    const result = owner
      ? await dialog.showOpenDialog(owner, config)
      : await dialog.showOpenDialog(config)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(NATIVE_IPC.dialogDirectory, async (_event, options: OpenDialogOptions = {}) => {
    const config = {
      title: options.title,
      defaultPath: options.defaultPath,
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const owner = ownerWindow()
    const result = owner
      ? await dialog.showOpenDialog(owner, config)
      : await dialog.showOpenDialog(config)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  /* -------------------------------------------------------- 系统能力 */
  ipcMain.handle(NATIVE_IPC.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    appImage: Boolean(process.env.APPIMAGE)
  }))

  ipcMain.handle(NATIVE_IPC.appGraphics, () => ({
    session: process.env.XDG_SESSION_TYPE ?? 'unknown',
    wayland: Boolean(process.env.WAYLAND_DISPLAY),
    requested: process.env.PYTHONTDX_GRAPHICS ?? 'wayland',
    platform: process.platform,
    gpuFeatureStatus: app.getGPUFeatureStatus()
  }))

  ipcMain.handle(NATIVE_IPC.appLinuxDesktop, async () => {
    const appImagePath = process.env.APPIMAGE
    if (process.platform !== 'linux' || !appImagePath) {
      throw new Error('桌面集成只在 Linux AppImage 中可用；deb 安装版已自动注册菜单')
    }
    const iconPath = process.env.APPDIR ? `${process.env.APPDIR}/pythontdx.png` : undefined
    return installLinuxDesktopIntegration({
      appImagePath,
      iconPath,
      name: app.getName(),
      version: app.getVersion()
    })
  })

  ipcMain.handle(NATIVE_IPC.appOpenExternal, (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  ipcMain.handle(NATIVE_IPC.appNotify, (_event, title: string, body: string) => {
    try {
      if (Notification.isSupported()) {
        new Notification({ title: String(title), body: String(body) }).show()
      }
    } catch (error) {
      console.error('[notify] 系统通知失败：', error)
    }
  })
}
