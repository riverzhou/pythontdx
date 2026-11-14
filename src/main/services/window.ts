/**
 * 无边框窗口的创建与几何状态管理。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { DisplayInfo } from '@shared/types'
import { centerOnWorkArea } from '@shared/window'
import { setupCapture } from './capture'
import { attachDiagnostics } from './diagnostics'
import type { WindowBounds } from './store'

/**
 * 窗口尺寸策略（2026-11-14 用户要求）：
 *   · 设计基准 1920×1080，最低支持 1440×900；
 *   · 默认最大化启动；从最大化「还原」时回到 1440×900（也是最小尺寸）；
 *   · 低于 1440×900 不再适配 —— 最小尺寸直接卡死，避免布局在更小窗口里挤坏。
 */
const DEFAULT_WIDTH = 1440
const DEFAULT_HEIGHT = 900
const MIN_WIDTH = 1440
const MIN_HEIGHT = 900

/** 深色底：与渲染层 --bg-base 保持一致，避免启动瞬间白屏闪烁 */
const BACKGROUND_COLOR = '#0a0c12'

/**
 * 开发期给任务栏/Alt-Tab 一个像样的图标；
 * 打包后图标由 electron-builder 写进可执行文件，这里返回 undefined 即可。
 */
function resolveWindowIcon(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [join(__dirname, '../../build/icon.ico'), join(__dirname, '../../resources/icon.png')]
      : [join(__dirname, '../../resources/icon.png')]

  return candidates.find((file) => existsSync(file))
}

export interface CreateWindowOptions {
  bounds?: WindowBounds
  onBoundsChange?: (bounds: WindowBounds) => void
  /**
   * 退出前把内存里的状态落盘。
   * 截图工具走的是 `app.exit()`，它会跳过 `before-quit`，
   * 「点完档位马上退出」那次就因此丢过设置（见 capture.ts）。
   */
  flushState?: () => Promise<void>
  /** 直接加载的 URL（统一传输后是本地 HTTP 服务） */
  url?: string
}

export function createMainWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const icon = resolveWindowIcon()

  // 旧默认尺寸（1600×1000 / 1600×900 / 1280×820）升级到 1440×900；用户自定义尺寸保持原样。
  const legacyDefault =
    (options.bounds?.width === 1600 && options.bounds?.height === 1000) ||
    (options.bounds?.width === 1600 && options.bounds?.height === 900) ||
    (options.bounds?.width === 1280 && options.bounds?.height === 820)
      ? options.bounds
      : undefined
  // 屏幕小于默认尺寸时按工作区收缩（但不会小于最小尺寸）
  const area = screen.getPrimaryDisplay().workAreaSize
  const defaultWidth = Math.max(MIN_WIDTH, Math.min(DEFAULT_WIDTH, area.width))
  const defaultHeight = Math.max(MIN_HEIGHT, Math.min(DEFAULT_HEIGHT, area.height))
  const window = new BrowserWindow({
    title: 'pythontdx',
    width: legacyDefault ? defaultWidth : (options.bounds?.width ?? defaultWidth),
    height: legacyDefault ? defaultHeight : (options.bounds?.height ?? defaultHeight),
    x: legacyDefault?.x ?? options.bounds?.x,
    y: legacyDefault?.y ?? options.bounds?.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    // 自绘标题栏：Windows/Linux 完全去边框，macOS 保留原生红绿灯
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 16 },
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 渲染层保持隔离与沙箱，只通过 preload 暴露的白名单 API 通信
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 行情页不需要背景节流，避免最小化恢复后图表卡顿
      backgroundThrottling: false
    }
  })

  // 先隐藏渲染，等首屏画完再显示，杜绝白屏
  window.on('ready-to-show', () => window.show())

  /**
   * 默认最大化启动。
   *
   * 首次启动（没有保存过窗口几何）直接最大化；之后记住上次是否最大化：
   * 用户按还原并调整过尺寸，下次就回到那个尺寸。截图工具不能最大化
   * （capture 用 setContentSize 指定视口，最大化后尺寸改不动），所以跳过。
   */
  const capturing = Boolean(
    process.env.PYTHONTDX_CAPTURE || process.env.PYTHONTDX_CAPTURE_SERIES
  )
  if (!capturing && options.bounds?.maximized !== false) {
    window.maximize()
  }

  // 外部链接交给系统浏览器，不在 App 内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  attachDiagnostics(window)
  setupCapture(window, options.flushState)

  const reportBounds = debounce(() => {
    if (!window.isMaximized() && !window.isMinimized() && !window.isFullScreen()) {
      options.onBoundsChange?.({ ...window.getNormalBounds(), maximized: false })
    }
  }, 400)

  window.on('resize', reportBounds)
  window.on('move', reportBounds)

  // 最大化状态变化要通知渲染层，好切换标题栏按钮的图标
  const notifyState = (): void => {
    window.webContents.send('window:state', {
      maximized: window.isMaximized(),
      focused: window.isFocused(),
      fullscreen: window.isFullScreen(),
      platform: process.platform
    })
  }
  window.on('maximize', () => {
    notifyState()
    // 记住「退出时是最大化」：正常尺寸交给 getNormalBounds，下次启动据此还原
    options.onBoundsChange?.({ ...window.getNormalBounds(), maximized: true })
  })
  window.on('unmaximize', () => {
    notifyState()
    options.onBoundsChange?.({ ...window.getNormalBounds(), maximized: false })
  })
  window.on('enter-full-screen', notifyState)
  window.on('leave-full-screen', notifyState)
  window.on('focus', notifyState)
  window.on('blur', notifyState)

  if (options.url) {
    void window.loadURL(options.url)
  } else if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** 列出显示器；Web 端由 http-api 自己返回虚拟项。 */
export function listDisplays(window: BrowserWindow): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay()
  const current = screen.getDisplayMatching(window.getBounds())
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: `显示器 ${index + 1}${display.id === primary.id ? ' · 主屏' : ''}`,
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
    primary: display.id === primary.id,
    current: display.id === current.id
  }))
}

/**
 * 把当前窗口居中放到目标显示器。
 *
 * 先取消最大化，否则部分窗口管理器会把 setPosition 当成无效操作；
 * 尺寸不跨屏改变，保留用户当前窗口大小。
 */
export function moveWindowToDisplay(window: BrowserWindow, displayId: number): boolean {
  const target = screen.getAllDisplays().find((display) => display.id === displayId)
  if (!target) return false
  if (window.isMaximized()) window.unmaximize()
  if (window.isFullScreen()) window.setFullScreen(false)
  const bounds = window.getBounds()
  const position = centerOnWorkArea(bounds, target.workArea)
  window.setPosition(position.x, position.y)
  window.focus()
  return true
}

function debounce<T extends (...args: never[]) => void>(fn: T, delay: number): T {
  let timer: NodeJS.Timeout | null = null
  return ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }) as T
}
