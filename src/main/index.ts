/**
 * 主进程入口。
 *
 * 职责边界（很重要，别让主进程变成第二个业务层）：
 *   主进程 = 窗口生命周期 + 网络访问 + 持久化 + 定时器
 *   渲染进程 = 界面与交互，通过 preload 白名单 API 取数
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, session } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import { registerIpcHandlers } from './ipc'
import { QuotePoller } from './services/poller'
import { PushHub } from './services/push'
import { fetchPushTask } from './services/push-fetch'
import { closeTdx, fetchMarketStatus, warmTdxBridge } from './services/tdx'
import { setMarketCalendarStatus } from '@shared/market'
import { AppStore } from './services/store'
import { migrateLegacyPortableData, migrateLegacyUserData } from './services/legacy'
import {
  installLinuxDesktopIntegration,
  readAppImageHandler,
  shouldOfferAppImageFix
} from './services/linux-desktop'
import { createMainWindow } from './window'
import { destroyTray, setupTray } from './tray'

const APP_ID = 'com.pythontdx.app'
const APP_NAME = 'pythontdx'
const STATE_FILE = 'pythontdx.json'
/** 便携版放在 exe 旁边的数据目录名 */
const PORTABLE_DATA_DIR = 'pythontdx-data'

let mainWindow: BrowserWindow | null = null
let store: AppStore | undefined
let poller: QuotePoller | undefined
let pushHub: PushHub | undefined
let flushing = false
let quitting = false

/**
 * 便携版（electron-builder 的 portable 目标）会把 exe 所在目录注入到
 * 环境变量 `PORTABLE_EXECUTABLE_DIR`。这时把配置写在 exe 旁边的
 * `pythontdx-data/` 里，「拷走 exe + 这个目录」就等于换台电脑继续用，
 * 系统里不留任何痕迹（不写注册表、不碰 %APPDATA%）。
 *
 * 如果目录不可写（放在只读介质、Program Files、网络盘等），
 * 静默退回系统默认目录，而不是让应用起不来。
 */
function resolvePortableUserData(): string | undefined {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (!portableDir) return undefined

  const candidate = join(portableDir, PORTABLE_DATA_DIR)
  // 旧版便携目录先复制到新目录，再检查可写；旧目录保留，不删除用户数据。
  migrateLegacyPortableData(portableDir)
  try {
    mkdirSync(candidate, { recursive: true })
    // 真正写一次才能确认可写：mkdir 成功但目录只读的情况是存在的
    const probe = join(candidate, '.write-probe')
    writeFileSync(probe, '')
    rmSync(probe)
    return candidate
  } catch {
    console.warn('[main] 便携版数据目录不可写，回退到系统默认目录：', candidate)
    return undefined
  }
}

/**
 * Linux 运行时图形后端（Chromium 当前不允许 Wayland 表面 + Vulkan 同时启用）：
 * - 默认 wayland：原生 Wayland，OpenGL/EGL；最稳；
 * - x11：XWayland/X11 + OpenGL；
 * - vulkan：XWayland/X11 + ANGLE Vulkan（需要真实 Vulkan 驱动）；
 * 可用 PYTHONTDX_GRAPHICS=wayland|x11|vulkan 覆盖。
 */
function requestedGraphicsMode(): 'wayland' | 'x11' | 'vulkan' {
  const requested = (process.env.PYTHONTDX_GRAPHICS ?? 'wayland').toLowerCase()
  return requested === 'x11' || requested === 'vulkan' ? requested : 'wayland'
}

function configureLinuxGraphics(): void {
  if (process.platform !== 'linux') return
  const mode = requestedGraphicsMode()
  if (mode === 'wayland') {
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
    app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations')
    app.commandLine.appendSwitch('enable-wayland-ime')
  } else {
    app.commandLine.appendSwitch('ozone-platform', 'x11')
    if (mode === 'vulkan') {
      app.commandLine.appendSwitch('use-angle', 'vulkan')
      app.commandLine.appendSwitch('enable-features', 'Vulkan')
    }
  }
  console.log(
    `[runtime] platform=linux session=${process.env.XDG_SESSION_TYPE ?? 'unknown'} ` +
      `wayland=${process.env.WAYLAND_DISPLAY ?? '-'} graphics=${mode}`
  )
}

/**
 * 请求 Vulkan 但驱动/Chromium 报告不可用时，明确回退到 Wayland 并重启一次。
 * 用环境变量防循环；正常 Wayland 默认路径不会进入这里。
 */
function fallbackVulkanIfUnavailable(): boolean {
  if (
    process.platform !== 'linux' ||
    requestedGraphicsMode() !== 'vulkan' ||
    process.env.PYTHONTDX_GPU_FALLBACK === '1'
  ) {
    return false
  }
  const vulkan =
    (app.getGPUFeatureStatus() as unknown as Record<string, string>).vulkan ?? 'unknown'
  if (!vulkan.startsWith('disabled')) return false

  console.warn(`[runtime] Vulkan unavailable (${vulkan}); fallback to wayland and relaunch once`)
  process.env.PYTHONTDX_GRAPHICS = 'wayland'
  process.env.PYTHONTDX_GPU_FALLBACK = '1'
  app.relaunch({ args: process.argv.slice(1) })
  app.exit(0)
  return true
}

configureLinuxGraphics()

/*
 * AppImage 首次双击仍会被系统当成磁盘镜像，所以给一个不用开窗口的修复入口：
 *   ./pythontdx-1.1.0.AppImage --install-desktop
 * 安装完成后同一文件双击即可启动。GUI 首次启动也会询问一次。
 */
// 截图/自动化可以用独立 userData，避免与正在运行的用户实例抢单实例锁。
app.setName(APP_NAME)
if (process.env.PYTHONTDX_USER_DATA) {
  app.setPath('userData', process.env.PYTHONTDX_USER_DATA)
}

if (
  process.argv.includes('--install-desktop') ||
  app.commandLine.hasSwitch('install-desktop')
) {
  app.setName(APP_NAME)
  app
    .whenReady()
    .then(() => installDesktopFromAppImage())
    .then(() => {
      console.log('[linux-desktop] 已安装桌面入口与 AppImage 启动器')
      app.exit(0)
    })
    .catch((error) => {
      console.error('[linux-desktop] 安装失败：', error)
      app.exit(1)
    })
} else if (!app.requestSingleInstanceLock()) {
  /* --------------------------------------------------------- 单实例锁 */
  // 第二次启动时不再开新窗口，而是把已有窗口拉到前面（行情软件的标准行为）
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  // 必须在读取 userData 路径之前改名，否则开发环境和打包后的数据目录会不一致
  app.setName(APP_NAME)

  // 便携版优先：把数据放在 exe 旁边（必须在 ready 之前设置）
  const portableUserData = resolvePortableUserData()
  if (portableUserData) {
    app.setPath('userData', portableUserData)
  } else {
    // 系统安装版：旧 StockLens 的 userData（设置/窗口/localStorage）复制到 pythontdx。
    const migrated = migrateLegacyUserData(app.getPath('appData'), app.getPath('userData'))
    if (migrated.length > 0) {
      console.log('[migrate] 已迁移旧用户目录：', migrated.join(', '))
    }
  }

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !store?.state.settings.closeToTray) app.quit()
  })

  // 退出前把内存里的状态落盘（写入是异步的，所以要先拦一下退出流程）
  app.on('before-quit', (event) => {
    quitting = true
    destroyTray()
    if (flushing || !store) return
    flushing = true
    event.preventDefault()
    poller?.stop()
    pushHub?.stop()
    closeTdx()
    void store.flush().finally(() => app.quit())
  })

  app.whenReady().then(onReady).catch(console.error)
}

/* ------------------------------------------------ Linux AppImage 双击修复 */
/**
 * 文件管理器双击 AppImage 不启动，通常不是可执行位，而是 MIME 关联被
 * `gnome-disk-image-mounter.desktop` 接管（见 services/linux-desktop.ts）。
 *
 * 只在「打包后的 Linux AppImage + 系统默认仍是磁盘挂载器 + 用户没拒绝过」
 * 时提示一次；用户点「立即修复」才写配置。不静默改系统关联。
 */
const DESKTOP_MARKER = 'linux-desktop.json'

interface DesktopMarker {
  installedAt?: number
  declinedAt?: number
  appImage?: string
}

function readDesktopMarker(path: string): DesktopMarker {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DesktopMarker
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDesktopMarker(path: string, marker: DesktopMarker): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.warn('[linux-desktop] 写入标记失败：', error)
  }
}

async function installDesktopFromAppImage(): Promise<void> {
  const appImagePath = process.env.APPIMAGE
  if (!appImagePath) throw new Error('当前不是 AppImage 启动')
  const iconPath = process.env.APPDIR
    ? join(process.env.APPDIR, 'pythontdx.png')
    : undefined
  await installLinuxDesktopIntegration({
    appImagePath,
    iconPath: iconPath && existsSync(iconPath) ? iconPath : undefined,
    name: app.getName(),
    version: app.getVersion()
  })
}

async function offerLinuxDesktopFix(window: BrowserWindow): Promise<void> {
  if (process.platform !== 'linux' || !app.isPackaged || !process.env.APPIMAGE) return
  if (process.env.PYTHONTDX_NO_DESKTOP_PROMPT === '1') return

  const markerPath = join(app.getPath('userData'), DESKTOP_MARKER)
  const marker = readDesktopMarker(markerPath)

  // 已经安装过：AppImage 路径变了就静默更新桌面入口，不再弹框
  if (marker.installedAt) {
    if (marker.appImage === process.env.APPIMAGE) return
    try {
      await installDesktopFromAppImage()
      writeDesktopMarker(markerPath, {
        ...marker,
        installedAt: Date.now(),
        appImage: process.env.APPIMAGE
      })
    } catch (error) {
      console.warn('[linux-desktop] 更新桌面入口失败：', error)
    }
    return
  }
  if (marker.declinedAt) return

  const handler = await readAppImageHandler()
  if (!shouldOfferAppImageFix(handler)) return

  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: '修复 AppImage 双击打开',
    message: '系统当前把 AppImage 当成磁盘镜像，双击不会启动程序',
    detail:
      '是否安装一个通用 AppImage 启动器，并把 application/vnd.appimage 的默认打开方式改为它？\n\n' +
      '这只影响「双击 AppImage」这一种文件；之后仍可从命令行启动。',
    buttons: ['立即修复', '暂不'],
    defaultId: 0,
    cancelId: 1
  })

  if (response !== 0) {
    writeDesktopMarker(markerPath, { declinedAt: Date.now() })
    return
  }

  try {
    await installDesktopFromAppImage()
    writeDesktopMarker(markerPath, {
      installedAt: Date.now(),
      appImage: process.env.APPIMAGE
    })
    await dialog.showMessageBox(window, {
      type: 'info',
      title: '已修复',
      message: '现在双击 AppImage 会直接启动',
      detail: '应用菜单里也已加入 pythontdx；如果文件管理器仍缓存旧关联，注销重新登录一次即可。'
    })
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: 'error',
      title: '桌面集成失败',
      message: error instanceof Error ? error.message : String(error),
      detail: '可以稍后在「设置 → Linux 桌面集成」里重试。'
    })
  }
}

function onReady(): void {
  electronApp.setAppUserModelId(APP_ID)
  console.log(`[runtime] gpu-feature-status ${JSON.stringify(app.getGPUFeatureStatus())}`)
  if (fallbackVulkanIfUnavailable()) return

  // 数据导出走浏览器下载；显式落到系统下载目录，避免 Electron 默认行为随版本漂移。
  session.defaultSession.on('will-download', (_event, item) => {
    const target = join(app.getPath('downloads'), item.getFilename())
    item.setSavePath(target)
    console.log(`[download] ${target}`)
  })

  // 开发模式下放开 F12 / Ctrl+R 之类的快捷键
  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  store = new AppStore(join(app.getPath('userData'), STATE_FILE))
  store.load()

  const currentStore = store

  poller = new QuotePoller({
    emit: (update) => {
      // 多窗口：每扇窗都订阅了同一份行情流，不能只推主窗口。
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC.quoteUpdate, update)
      }
    },
    // 窗口不可见时跳过拉取，省流量也省上游压力（可在设置里关掉）
    canFetch: () => {
      if (!currentStore.state.settings.pauseWhenHidden) return true
      if (!mainWindow || mainWindow.isDestroyed()) return false
      return mainWindow.isVisible() && !mainWindow.isMinimized()
    }
  })

  const canFetch = (): boolean => {
    if (!currentStore.state.settings.pauseWhenHidden) return true
    if (!mainWindow || mainWindow.isDestroyed()) return false
    return mainWindow.isVisible() && !mainWindow.isMinimized()
  }

  pushHub = new PushHub(
    (update) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC.pushUpdate, update)
      }
    },
    fetchPushTask,
    canFetch
  )

  registerIpcHandlers({
    store: currentStore,
    poller,
    pushHub,
    getWindow: () => mainWindow
  })

  // 先拉起 Python，窗口加载与 sidecar 启动并行；首屏缓存请求不用再等进程冷启动。
  warmTdxBridge()

  // 主进程也持有一份 TDX 交易日历：QuotePoller 的降频要用它，且渲染层
  // 的 IPC 实例与主进程不是同一个模块实例。
  const refreshCalendar = (): void => {
    void fetchMarketStatus()
      .then((status) => setMarketCalendarStatus(status))
      .catch(() => undefined)
  }
  // 首帧行情优先：日历状态晚 1 秒再拉，避免和 sidecar 首批行情抢队列。
  const firstCalendar = setTimeout(refreshCalendar, 1000)
  firstCalendar.unref()
  const calendarTimer = setInterval(refreshCalendar, 5 * 60_000)
  calendarTimer.unref()

  mainWindow = createMainWindow({
    bounds: currentStore.bounds,
    onBoundsChange: (bounds) => currentStore.saveBounds(bounds),
    // 截图工具用 app.exit() 退出，绕过 before-quit，所以得自己把状态落盘
    flushState: () => currentStore.flush()
  })

  mainWindow.on('close', (event) => {
    if (!quitting && currentStore.state.settings.closeToTray !== false) {
      event.preventDefault()
      console.log('[tray] 关闭窗口 -> 隐藏到托盘')
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    poller?.stop()
    pushHub?.stop()
  })

  setupTray(mainWindow)

  // 等首屏画完再问，别让对话框挡住启动；失败只记录日志，不影响行情。
  const windowForPrompt = mainWindow
  setTimeout(() => {
    void offerLinuxDesktopFix(windowForPrompt).catch((error) => {
      console.warn('[linux-desktop] 检查失败：', error)
    })
  }, 1500)

  // macOS 点 Dock 图标时重新开窗
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    mainWindow = createMainWindow({
      bounds: currentStore.bounds,
      onBoundsChange: (bounds) => currentStore.saveBounds(bounds),
      flushState: () => currentStore.flush()
    })
  })

  if (is.dev) {
    console.log(`[main] 配置文件：${join(app.getPath('userData'), STATE_FILE)}`)
  }
}

/* ------------------------------------------------------------ 兜底日志 */
// 主进程里的异常如果没人接住，Electron 会直接崩掉且不给任何提示，这里至少留个记录
process.on('uncaughtException', (error) => {
  console.error('[main] 未捕获异常：', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理的 Promise 拒绝：', reason)
})
