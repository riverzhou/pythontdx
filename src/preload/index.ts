/**
 * 预加载脚本 —— 渲染进程与 Electron 主进程之间唯一的「官方通道」。
 *
 * 统一传输后，行情数据不再经过这里：Electron 和浏览器都用同一套
 * HTTP/WebSocket（见 `src/renderer/src/lib/http-api.ts`）。
 * 这里只暴露壳能力：窗口控制、本机状态文件、文件对话框、通知。
 *
 * 安全模型不变：
 *   1. contextIsolation: true；
 *   2. nodeIntegration: false；
 *   3. 只挂载白名单 API，绝不把 ipcRenderer 整个丢出去。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  NATIVE_IPC,
  type DesktopApi,
  type OpenDialogOptions,
  type SaveDialogOptions
} from '@shared/desktop'
import type { WindowState } from '@shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const desktop: DesktopApi = {
  isDesktop: true,
  info: () => ipcRenderer.invoke(NATIVE_IPC.appInfo),
  state: {
    get: () => ipcRenderer.invoke(NATIVE_IPC.stateGet),
    patch: (patch) => ipcRenderer.invoke(NATIVE_IPC.statePatch, patch)
  },
  window: {
    control: (action) => ipcRenderer.invoke(NATIVE_IPC.windowControl, action),
    toggleAlwaysOnTop: () => ipcRenderer.invoke(NATIVE_IPC.windowAlwaysOnTop),
    displays: () => ipcRenderer.invoke(NATIVE_IPC.windowDisplays),
    moveToDisplay: (displayId) => ipcRenderer.invoke(NATIVE_IPC.windowMoveDisplay, displayId),
    onStateChange: (listener) => subscribe<WindowState>(NATIVE_IPC.windowState, listener)
  },
  dialogs: {
    save: (options: SaveDialogOptions) => ipcRenderer.invoke(NATIVE_IPC.dialogSave, options),
    open: (options: OpenDialogOptions) => ipcRenderer.invoke(NATIVE_IPC.dialogOpen, options),
    directory: (options: OpenDialogOptions = {}) =>
      ipcRenderer.invoke(NATIVE_IPC.dialogDirectory, options)
  },
  app: {
    graphics: () => ipcRenderer.invoke(NATIVE_IPC.appGraphics),
    installLinuxDesktop: () => ipcRenderer.invoke(NATIVE_IPC.appLinuxDesktop),
    openExternal: (url) => ipcRenderer.invoke(NATIVE_IPC.appOpenExternal, url),
    notify: (title, body) => ipcRenderer.invoke(NATIVE_IPC.appNotify, title, body)
  }
}

contextBridge.exposeInMainWorld('desktop', desktop)
