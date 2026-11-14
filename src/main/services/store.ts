/**
 * 本地持久化。
 *
 * 为什么不用 electron-store？
 *  - electron-store v9+ 是纯 ESM 包，与主进程的 CJS 产物搭配需要额外处理；
 *  - 需求本身很简单（读写一个 JSON），手写一遍反而更有助于理解 Electron 的 userData 目录。
 *
 * 写入策略：150ms 防抖 + 临时文件原子替换，避免频繁 IO 和「写一半崩了」导致文件损坏。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_GROUP_ID,
  DEFAULT_SETTINGS,
  SEED_GROUPS,
  STATE_VERSION,
  type AppSettings,
  type AppState,
  type WatchGroup,
  type WatchItem
} from '@shared/types'

/** 与界面无关、单独存放的窗口几何信息 */
export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  /** 上次退出时是否最大化；旧存档没有这个字段，按「首次启动」处理 */
  maximized?: boolean
}

/** v1 的旧结构：自选股是一个扁平数组，没有分组 */
interface LegacyState {
  watchlist?: WatchItem[]
  settings?: Partial<AppSettings>
  activeCode?: string | null
}

interface PersistedFile {
  version: number
  state: AppState | (Partial<AppState> & LegacyState)
  window?: WindowBounds
  secondaryWindow?: WindowBounds
  chartWindow?: WindowBounds
  /** 窗口默认尺寸的迁移版本：老存档做一次性重置，见 DEFAULT_WINDOW */
  windowSizeVersion?: number
}

/**
 * 1.8.0 期间调整过窗口默认值（1600×1000 → 1440×900，并改为最大化启动）。
 * 老存档里可能存着旧默认或测出来的尺寸，这里做一次性重置：
 * 「还原」统一回到 1440×900，方便按最低支持分辨率验收。
 */
const WINDOW_SIZE_VERSION = 1
const DEFAULT_WINDOW: WindowBounds = { width: 1440, height: 900 }

const SAVE_DEBOUNCE_MS = 150

function createDefaultState(): AppState {
  return {
    version: STATE_VERSION,
    groups: SEED_GROUPS.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item }))
    })),
    activeGroupId: SEED_GROUPS[0]?.id ?? DEFAULT_GROUP_ID,
    settings: { ...DEFAULT_SETTINGS },
    activeCode: SEED_GROUPS[0]?.items[0]?.code ?? null,
    alerts: [],
    formulas: [],
    positions: []
  }
}

/**
 * 把任意历史版本的持久化数据归一化成当前结构。
 *
 * 这是「数据结构演进」的成本最低的做法：读的时候兼容旧格式，
 * 写的时候永远只写新格式，用户无感知完成迁移。
 */
function normalizeGroups(
  raw: Partial<AppState> & LegacyState,
  fallback: WatchGroup[]
): WatchGroup[] {
  if (Array.isArray(raw.groups) && raw.groups.length > 0) {
    return raw.groups.map((group) => ({
      id: typeof group?.id === 'string' && group.id ? group.id : DEFAULT_GROUP_ID,
      name: typeof group?.name === 'string' && group.name ? group.name : '自选',
      items: Array.isArray(group?.items) ? group.items : []
    }))
  }

  // v1 → v2：旧的扁平自选股整体放进一个分组
  if (Array.isArray(raw.watchlist)) {
    return [{ id: DEFAULT_GROUP_ID, name: '自选', items: raw.watchlist }]
  }

  return fallback
}

export class AppStore {
  private data: PersistedFile = { version: STATE_VERSION, state: createDefaultState() }
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(private readonly filePath: string) {}

  /** 同步读取：启动阶段调用一次，简单直接 */
  load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<PersistedFile>
      // 一次性把窗口尺寸重置到 1440×900（保留是否最大化的记忆）
      const window =
        parsed.windowSizeVersion === WINDOW_SIZE_VERSION
          ? parsed.window
          : { ...DEFAULT_WINDOW, maximized: parsed.window?.maximized }
      this.data = {
        version: STATE_VERSION,
        state: this.mergeState(parsed.state),
        window,
        secondaryWindow: parsed.secondaryWindow,
        chartWindow: parsed.chartWindow,
        windowSizeVersion: WINDOW_SIZE_VERSION
      }
    } catch (error) {
      // 文件损坏时不要炸掉整个 App，退回默认值并留个日志
      console.error('[store] 配置文件解析失败，已回退到默认配置：', error)
    }
  }

  get state(): AppState {
    return this.data.state as AppState
  }

  get bounds(): WindowBounds | undefined {
    return this.data.window
  }

  get secondaryBounds(): WindowBounds | undefined {
    return this.data.secondaryWindow
  }

  get chartBounds(): WindowBounds | undefined {
    return this.data.chartWindow
  }

  /** 增量更新状态（浅合并 settings，groups 整体替换） */
  patchState(patch: Partial<AppState>): AppState {
    this.data.state = this.mergeState({ ...this.state, ...patch })
    this.scheduleSave()
    return this.state
  }

  saveBounds(bounds: WindowBounds): void {
    this.data.window = bounds
    this.scheduleSave()
  }

  saveSecondaryBounds(bounds: WindowBounds): void {
    this.data.secondaryWindow = bounds
    this.scheduleSave()
  }

  saveChartBounds(bounds: WindowBounds): void {
    this.data.chartWindow = bounds
    this.scheduleSave()
  }

  /** 立即落盘（退出前调用） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return
    await this.write()
  }

  private mergeState(raw?: (Partial<AppState> & LegacyState) | undefined): AppState {
    const fallback = createDefaultState()
    const source = raw ?? {}
    const groups = normalizeGroups(source, fallback.groups)

    // activeGroupId 必须指向真实存在的分组，否则界面会找不到当前分组
    const activeGroupId = groups.some((group) => group.id === source.activeGroupId)
      ? (source.activeGroupId as string)
      : groups[0].id

    return {
      version: STATE_VERSION,
      groups,
      activeGroupId,
      settings: { ...fallback.settings, ...source.settings },
      activeCode: source.activeCode ?? fallback.activeCode,
      alerts: Array.isArray(source.alerts) ? source.alerts : [],
      formulas: Array.isArray(source.formulas) ? source.formulas : [],
      alertEvents: Array.isArray(source.alertEvents) ? source.alertEvents : [],
      positions: Array.isArray(source.positions) ? source.positions : []
    }
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.write()
    }, SAVE_DEBOUNCE_MS)
  }

  private async write(): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8')
      await rename(tmpPath, this.filePath)
      this.dirty = false
    } catch (error) {
      console.error('[store] 写入配置失败：', error)
    }
  }
}
