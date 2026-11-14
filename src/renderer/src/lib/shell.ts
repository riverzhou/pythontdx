/**
 * 统一壳入口。
 *
 * Electron：`window.desktop`（preload 白名单，见 src/preload/index.ts）。
 * 浏览器：同形状的降级实现，窗口/本机文件等能力返回空结果。
 *
 * 组件只 import 这里的 `shell`，不直接摸 `window.desktop`，
 * 这样 Web 构建不会因为缺少 preload 而报错。
 */
import {
  DEFAULT_GROUP_ID,
  DEFAULT_SETTINGS,
  SEED_GROUPS,
  STATE_VERSION,
  type AppInfo,
  type AppState,
  type AppSettings
} from '@shared/types'
import type { ShellApi } from '@shared/desktop'
import { webVersion } from '@shared/version'

declare const __APP_VERSION__: string

const WEB_VERSION = webVersion(typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0')
const STORAGE_KEY = 'pythontdx:web:state'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function defaultState(): AppState {
  const groups = clone(SEED_GROUPS)
  return {
    version: STATE_VERSION,
    groups,
    activeGroupId: DEFAULT_GROUP_ID,
    settings: { ...DEFAULT_SETTINGS },
    activeCode: groups[0]?.items[0]?.code ?? null,
    alerts: [],
    formulas: [],
    positions: []
  }
}

function loadWebState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppState
      if (Array.isArray(parsed.groups) && parsed.groups.length > 0) {
        return {
          version: STATE_VERSION,
          groups: parsed.groups,
          activeGroupId: parsed.activeGroupId || parsed.groups[0].id,
          settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
          activeCode: parsed.activeCode ?? parsed.groups[0]?.items[0]?.code ?? null,
          alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
          formulas: Array.isArray(parsed.formulas) ? parsed.formulas : [],
          positions: Array.isArray(parsed.positions) ? parsed.positions : [],
          alertEvents: Array.isArray(parsed.alertEvents) ? parsed.alertEvents : []
        }
      }
    }
  } catch {
    // 坏配置不阻塞页面，回到种子数据
  }
  return defaultState()
}

function createWebShell(): ShellApi {
  let state = loadWebState()
  return {
    isDesktop: false,
    info: async (): Promise<AppInfo> => ({
      name: 'pythontdx Web',
      version: WEB_VERSION,
      electron: '—',
      chrome: navigator.userAgent,
      node: '—',
      platform: 'web'
    }),
    state: {
      get: async () => state,
      patch: async (patch) => {
        state = {
          ...state,
          ...patch,
          settings: { ...state.settings, ...(patch.settings as Partial<AppSettings>) }
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
        return state
      }
    },
    window: {
      control: async () => ({
        focused: true,
        maximized: false,
        fullscreen: false,
        platform: 'web'
      }),
      toggleAlwaysOnTop: async () => false,
      displays: async () => [
        {
          id: 0,
          label: '浏览器窗口',
          width: window.screen.width,
          height: window.screen.height,
          scaleFactor: window.devicePixelRatio || 1,
          primary: true,
          current: true
        }
      ],
      moveToDisplay: async () => false,
      onStateChange: () => () => undefined
    },
    dialogs: {
      save: async () => null,
      open: async () => null,
      directory: async () => null
    },
    app: {
      graphics: async () => ({
        session: 'web',
        wayland: false,
        requested: 'web',
        platform: 'web',
        gpuFeatureStatus: {}
      }),
      installLinuxDesktop: async () => {
        throw new Error('浏览器版没有 Linux 桌面环境，请在 AppImage 桌面端操作')
      },
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      notify: async (title, body) => {
        // 不在触发时申请权限（会被浏览器拦），只在已经授权时发系统通知
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body })
        }
      }
    }
  }
}

const desktop = window.desktop
export const shell: ShellApi = desktop ?? createWebShell()
