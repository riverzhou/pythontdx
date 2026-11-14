/**
 * 全局应用状态：自选股分组、设置、选中项、运行时信息。
 *
 * 单一数据源放在渲染进程，主进程只负责「持久化」。
 * 这样界面上任何操作都是先改本地状态（立刻响应），再异步落盘（不阻塞 UI）。
 */
import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  DEFAULT_GROUP_ID,
  DEFAULT_SETTINGS,
  STATE_VERSION,
  type AlertEvent,
  type AlertRule,
  type AppInfo,
  type AppSettings,
  type AppState,
  type PortfolioPosition,
  type SavedFormula,
  type SearchItem,
  type WatchGroup,
  type WatchItem
} from '@shared/types'
import { mergeImportedGroups } from '@shared/watchlist'
import { localDateKey, shouldAutoArchive } from '@shared/archive'
import { setMarketCalendarStatus } from '@shared/market'
import { api, shell } from '../lib/client'

const [state, setState] = createStore<AppState>({
  version: STATE_VERSION,
  groups: [],
  activeGroupId: DEFAULT_GROUP_ID,
  settings: { ...DEFAULT_SETTINGS },
  activeCode: null,
  alerts: [],
  formulas: []
})

const [appInfo, setAppInfo] = createSignal<AppInfo | null>(null)
const [ready, setReady] = createSignal(false)
/** 正在被拖拽的股票代码，用于给落点加高亮 */
const [draggingCode, setDraggingCode] = createSignal<string | null>(null)

export { state as appState, appInfo, ready as appReady, draggingCode, setDraggingCode }

/* ------------------------------------------------------------------ 派生 */

export const activeGroup = (): WatchGroup | undefined =>
  state.groups.find((group) => group.id === state.activeGroupId)

export const activeItems = (): WatchItem[] => activeGroup()?.items ?? []

/**
 * 自选股唯一的那一级：名字叫「自选」的分组，没有就用第一组。
 *
 * 产品约定（2026-11-01 用户指令）：自选股只有一层，不再有分组；
 * 其余分组都属于「自定义板块」，由左栏「自定义」页签管理。
 */
export const defaultGroup = (): WatchGroup | undefined =>
  state.groups.find((group) => group.name === '自选') ?? state.groups[0]

export const watchItems = (): WatchItem[] => defaultGroup()?.items ?? []

/** 全部分组的代码合集（行情订阅用，去重） */
export const watchCodes = (): string[] => [
  ...new Set(state.groups.flatMap((group) => group.items.map((item) => item.code)))
]

export const activeQuoteCode = (): string | null => state.activeCode

/** 跨分组查找某只股票 */
export function watchItemOf(code: string): WatchItem | undefined {
  for (const group of state.groups) {
    const item = group.items.find((entry) => entry.code === code)
    if (item) return item
  }
  return undefined
}

/** 把 store 代理转成纯对象，跨进程传输前必须做这一步 */
function plainGroups(groups: readonly WatchGroup[]): WatchGroup[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    items: group.items.map((item) => ({ ...item }))
  }))
}

/* ------------------------------------------------------------------ 启动 */

export async function bootstrapAppState(): Promise<void> {
  const [persisted, info] = await Promise.all([shell.state.get(), shell.info()])

  const mergedSettings = { ...DEFAULT_SETTINGS, ...persisted.settings }
  // 旧版默认栏宽（264/318、280/330 等）统一迁移到更省横向空间的 264/300。
  if (
    (mergedSettings.sidebarWidth === 264 && mergedSettings.railWidth === 318) ||
    (mergedSettings.sidebarWidth === 300 && mergedSettings.railWidth === 320) ||
    (mergedSettings.sidebarWidth === 340 && mergedSettings.railWidth === 330) ||
    (mergedSettings.sidebarWidth === 280 && mergedSettings.railWidth === 330)
  ) {
    mergedSettings.sidebarWidth = 264
    mergedSettings.railWidth = 300
  }
  // 九项要求默认刷新 1 秒；旧默认 3 秒的配置一次性迁移。
  if (mergedSettings.refreshInterval === 3000) {
    mergedSettings.refreshInterval = 1000
  }

  setState({
    version: persisted.version,
    groups: persisted.groups.length > 0 ? persisted.groups : [],
    activeGroupId: persisted.activeGroupId,
    settings: mergedSettings,
    activeCode: persisted.activeCode ?? persisted.groups[0]?.items[0]?.code ?? null,
    alerts: Array.isArray(persisted.alerts) ? persisted.alerts : [],
    formulas: Array.isArray(persisted.formulas) ? persisted.formulas : [],
    alertEvents: Array.isArray(persisted.alertEvents) ? persisted.alertEvents : [],
    positions: Array.isArray(persisted.positions) ? persisted.positions : []
  })
  // 把迁移后的刷新/布局设置写回持久化层，避免下次启动又读到旧默认 3 秒。
  void shell.state.patch({ settings: mergedSettings }).catch(() => undefined)
  setAppInfo(info)

  // 告诉 CSS 当前平台，macOS 需要给原生红绿灯留位置
  document.documentElement.dataset.platform = info.platform
  setReady(true)
}

/** 交易日历每 5 分钟刷新一次；主进程也在启动时预热一份。 */
let calendarTimer: ReturnType<typeof setInterval> | null = null
export function startMarketCalendar(): void {
  if (calendarTimer) return
  const refresh = (): void => {
    void api.market
      .status()
      .then((status) => setMarketCalendarStatus(status))
      .catch(() => undefined)
  }
  // 首帧行情优先：日历状态晚 1 秒再拉，避免和 sidecar 首批行情抢队列。
  setTimeout(refresh, 1000)
  calendarTimer = setInterval(refresh, 5 * 60_000)
}

/* ------------------------------------------------------------------ 选中 */

let windowChannel: BroadcastChannel | null = null

function postWindow(message: unknown): void {
  windowChannel?.postMessage(message)
}

export function initWindowSync(): void {
  if (windowChannel || typeof BroadcastChannel === 'undefined') return
  windowChannel = new BroadcastChannel('pythontdx-windows')
  windowChannel.onmessage = (event: MessageEvent) => {
    const message = event.data as
      { type: 'active'; code: string | null } | { type: 'settings'; settings: AppSettings }
    if (message?.type === 'active') {
      setState('activeCode', message.code)
      persist({ activeCode: message.code })
    } else if (message?.type === 'settings') {
      setState('settings', message.settings)
      persist({ settings: plainSettings() })
    }
  }
}

export function setActiveCode(code: string | null): void {
  setState('activeCode', code)
  persist({ activeCode: code })
  postWindow({ type: 'active', code })
}

/* ---------------------------------------------------------------- 分组 */

export function setActiveGroup(id: string): void {
  setState('activeGroupId', id)
  persist({ activeGroupId: id })
}

/** 同一毫秒内连续新建分组时也不能撞 id */
let idSequence = 0
function newId(prefix: string): string {
  idSequence += 1
  return `${prefix}${Date.now().toString(36)}${idSequence.toString(36)}`
}

export function createGroup(name?: string): void {
  const id = newId('g')
  const groups = [...plainGroups(state.groups), { id, name: name?.trim() || '新分组', items: [] }]
  setState('groups', groups)
  setState('activeGroupId', id)
  persist({ groups, activeGroupId: id })
}

export function createGroupWithItems(
  name: string,
  items: ReadonlyArray<Pick<WatchItem, 'code' | 'name' | 'market'>>
): number {
  const id = newId('g')
  const seen = new Set<string>()
  const unique = items.filter((item) => {
    if (!item.code || seen.has(item.code)) return false
    seen.add(item.code)
    return true
  })
  const groups = [
    ...plainGroups(state.groups),
    { id, name: name.trim() || '选股池', items: unique.map((item) => ({ ...item })) }
  ]
  setState('groups', groups)
  setState('activeGroupId', id)
  persist({ groups, activeGroupId: id })
  return unique.length
}

/** 自动选股池：存在则整组替换，不存在则追加；不切当前分组。 */
export function replaceGroupItems(
  id: string,
  name: string,
  items: ReadonlyArray<Pick<WatchItem, 'code' | 'name' | 'market'>>
): number {
  const seen = new Set<string>()
  const unique = items.filter((item) => {
    if (!item.code || seen.has(item.code)) return false
    seen.add(item.code)
    return true
  })
  const groups = plainGroups(state.groups)
  const index = groups.findIndex((group) => group.id === id)
  const next = { id, name, items: unique.map((item) => ({ ...item })) }
  if (index >= 0) groups[index] = next
  else groups.push(next)
  setState('groups', groups)
  persist({ groups })
  return unique.length
}

export function renameGroup(id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  const groups = plainGroups(state.groups).map((group) =>
    group.id === id ? { ...group, name: trimmed } : group
  )
  setState('groups', groups)
  persist({ groups })
}

/**
 * 调整分组顺序。
 * 与 moveWatchItem 一样：先摘出来再插进去，
 * 所以 targetIndex 用的是**原始数组**里的下标。
 */
export function moveGroup(id: string, targetIndex: number): void {
  const from = state.groups.findIndex((group) => group.id === id)
  if (from < 0) return

  const groups = plainGroups(state.groups)
  const [moved] = groups.splice(from, 1)
  if (!moved) return

  groups.splice(Math.max(0, Math.min(targetIndex, groups.length)), 0, moved)
  setState('groups', groups)
  persist({ groups })
}

/**
 * 删除分组。至少保留一个分组；被删分组里的股票会**并入第一个分组**而不是直接丢弃，
 * 避免误删造成数据丢失。
 */
export function removeGroup(id: string): void {
  if (state.groups.length <= 1) return

  const index = state.groups.findIndex((group) => group.id === id)
  if (index < 0) return

  const removed = state.groups[index]
  const rest = state.groups.filter((group) => group.id !== id)
  const groups = plainGroups(rest)
  const first = groups[0]

  for (const item of removed.items) {
    if (!first.items.some((existing) => existing.code === item.code)) {
      first.items.push({ ...item })
    }
  }

  setState('groups', groups)
  if (state.activeGroupId === id) {
    setState('activeGroupId', first.id)
  }
  persist({ groups, activeGroupId: state.activeGroupId })
}

/* ---------------------------------------------------------------- 自选股 */

export function addWatchItem(
  item: Pick<WatchItem, 'code' | 'name' | 'market'>,
  groupId?: string
): void {
  // 不指定分组时进「自选股」，而不是当前浏览的自定义板块：
  // 搜索/右键「加入自选」的语义是固定的那一份自选，不该跟着页面状态漂移。
  const targetId = groupId ?? defaultGroup()?.id ?? state.activeGroupId
  const groups = plainGroups(state.groups)
  const target = groups.find((group) => group.id === targetId) ?? groups[0]
  if (!target) return

  // 只在「目标分组」里去重：同一只股票可以既在自选、又在多个自定义板块里
  const already = target.items.some((entry) => entry.code === item.code)
  if (already) {
    setActiveGroup(target.id)
    setActiveCode(item.code)
    return
  }
  target.items.push({ ...item })

  setState('groups', groups)
  setActiveGroup(target.id)
  setActiveCode(item.code)
  persist({ groups })
}

export function addSearchItem(item: SearchItem): void {
  addWatchItem({ code: item.code, name: item.name, market: item.market })
}

/** 导入自选备份：追加分组，不覆盖现有数据。 */
export function importWatchGroups(groups: readonly WatchGroup[]): void {
  const merged = mergeImportedGroups(state.groups, groups)
  setState('groups', merged)
  const active = merged[merged.length - 1]
  if (active) setState('activeGroupId', active.id)
  persist({ groups: merged, activeGroupId: state.activeGroupId })
}

/**
 * 右键菜单用：把一只股票放进指定分组。
 *
 * 分组是互斥的（一只股票只属于一个分组，拖拽就是「移动」），所以：
 *   · 不在任何分组 → 新增到目标分组；
 *   · 已在别的分组 → 移动过去；
 *   · 已在目标分组 → 只切换选中，不重复加。
 */
export function addStockToGroup(
  item: Pick<WatchItem, 'code' | 'name' | 'market'>,
  groupId: string
): void {
  const target = state.groups.find((group) => group.id === groupId)
  if (!target) return
  const already = target.items.some((entry) => entry.code === item.code)
  if (already) {
    setActiveCode(item.code)
    return
  }
  // 只加到目标分组，保留它在自选/其它自定义板块里的归属
  const groups = plainGroups(state.groups)
  const group = groups.find((entry) => entry.id === groupId)
  if (!group) return
  group.items.push({ ...item })
  setState('groups', groups)
  setActiveCode(item.code)
  persist({ groups })
}

export function removeWatchItem(code: string, groupId?: string): void {
  const targetId = groupId ?? defaultGroup()?.id
  const group = state.groups.find((entry) => entry.id === targetId)
  if (!group) return
  const index = group.items.findIndex((item) => item.code === code)
  if (index < 0) return

  const groups = plainGroups(state.groups).map((entry) =>
    entry.id === group.id
      ? { ...entry, items: entry.items.filter((item) => item.code !== code) }
      : entry
  )
  setState('groups', groups)
  persist({ groups })

  // 删掉的正好是当前选中项时，顺延到相邻的一只，避免主区突然空掉
  if (state.activeCode === code) {
    const next = groups.find((entry) => entry.id === group.id)?.items[index]
    setActiveCode(next?.code ?? watchCodes()[0] ?? null)
  }
}

/** 名称纠偏：从搜索结果或手输代码加入的条目，名字可能是占位符 */
export function renameWatchItem(code: string, name: string): void {
  if (!name) return
  const groups = plainGroups(state.groups)
  let changed = false
  for (const group of groups) {
    for (const item of group.items) {
      if (item.code === code && item.name !== name) {
        item.name = name
        changed = true
      }
    }
  }
  if (!changed) return
  setState('groups', groups)
  persist({ groups })
}

/**
 * 把某只股票移动到「目标分组的指定位置」。
 * 组内排序与跨组移动都走这一个函数，逻辑只需要维护一份。
 */
export function moveWatchItem(code: string, targetGroupId: string, targetIndex: number): void {
  const groups = plainGroups(state.groups)
  const target = groups.find((group) => group.id === targetGroupId)
  if (!target) return

  // 只调整目标分组里的位置；同一只票在其它分组（自选/别的自定义板块）的归属保持不变
  const existing = target.items.findIndex((item) => item.code === code)
  let item: WatchItem | undefined
  let index = targetIndex
  if (existing >= 0) {
    item = target.items.splice(existing, 1)[0]
    if (existing < index) index -= 1
  } else {
    const source = state.groups.flatMap((group) => group.items).find((entry) => entry.code === code)
    if (!source) return
    item = { ...source }
  }
  if (!item) return

  const insertAt = Math.max(0, Math.min(index, target.items.length))
  target.items.splice(insertAt, 0, item)

  setState('groups', groups)
  persist({ groups })
}

/* ------------------------------------------------------------------ 设置 */

export function savePositions(positions: PortfolioPosition[]): void {
  const plain = positions
    .filter((position) => position.shares > 0 && position.cost > 0)
    .map((position) => ({ ...position }))
  setState('positions', plain)
  persist({ positions: plain })
}

function plainSettings(): AppSettings {
  // Solid store 的嵌套对象/数组是代理，直接走 IPC 会 "could not be cloned"；
  // 这里把设置里的嵌套结构显式拍平。
  return {
    ...state.settings,
    chartDrawings: state.settings.chartDrawings?.map((drawing) => ({ ...drawing })),
    layoutSlots: state.settings.layoutSlots?.map((slot) => ({ ...slot })),
    screenPresets: state.settings.screenPresets?.map((preset) => ({ ...preset })),
    recentSearches: state.settings.recentSearches?.map((item) => ({ ...item })),
    maPeriods: state.settings.maPeriods ? [...state.settings.maPeriods] : undefined,
    indicatorParams: state.settings.indicatorParams
      ? { ...state.settings.indicatorParams }
      : undefined,
    trackingPresetIds: state.settings.trackingPresetIds?.slice(),
    offlineSync: state.settings.offlineSync
      ? {
          ...state.settings.offlineSync,
          datasets: [...state.settings.offlineSync.datasets]
        }
      : undefined
  }
}

export function updateSettings(patch: Partial<AppSettings>): void {
  setState('settings', patch)
  const settings = plainSettings()
  persist({ settings })
  postWindow({ type: 'settings', settings })
}

export function toggleTheme(): void {
  updateSettings({ theme: state.settings.theme === 'dark' ? 'light' : 'dark' })
}

/* ------------------------------------------------------------------ 预警 */

function plainAlerts(): AlertRule[] {
  return state.alerts.map((rule) => ({ ...rule }))
}

export function addAlert(
  input: Pick<AlertRule, 'code' | 'name' | 'metric' | 'direction' | 'value'> & {
    conditions?: AlertRule['conditions']
    conditionMode?: AlertRule['conditionMode']
    groups?: AlertRule['groups']
    groupMode?: AlertRule['groupMode']
  }
): void {
  const rule: AlertRule = {
    ...input,
    id: `a${Date.now().toString(36)}`,
    enabled: true
  }
  const alerts = [...plainAlerts(), rule]
  setState('alerts', alerts)
  persist({ alerts })
}

export function removeAlert(id: string): void {
  const alerts = plainAlerts().filter((rule) => rule.id !== id)
  setState('alerts', alerts)
  persist({ alerts })
}

export function toggleAlert(id: string): void {
  const alerts = plainAlerts().map((rule) =>
    rule.id === id ? { ...rule, enabled: !rule.enabled } : rule
  )
  setState('alerts', alerts)
  persist({ alerts })
}

/** 只更新触发过的规则；调用方传入 evaluateAlerts 的 updated。 */
export function appendAlertEvents(events: readonly AlertEvent[]): void {
  if (events.length === 0) return
  const merged = [...events, ...(state.alertEvents ?? [])].slice(0, 50)
  setState('alertEvents', merged)
  persist({ alertEvents: merged })
}

export function clearAlertEventHistory(): void {
  setState('alertEvents', [])
  persist({ alertEvents: [] })
}

export function markAlertsTriggered(updated: readonly AlertRule[]): void {
  if (updated.length === 0) return
  const changed = new Map(updated.map((rule) => [rule.id, rule]))
  const alerts = plainAlerts().map((rule) => changed.get(rule.id) ?? rule)
  setState('alerts', alerts)
  persist({ alerts })
}

/* ------------------------------------------------------------------ 公式 */

export function saveFormula(name: string, expression: string): SavedFormula {
  const formula: SavedFormula = {
    id: `f${Date.now().toString(36)}`,
    name: name.trim() || expression.trim(),
    expression: expression.trim(),
    createdAt: Date.now()
  }
  const formulas = [...state.formulas.map((item) => ({ ...item })), formula]
  setState('formulas', formulas)
  persist({ formulas })
  return formula
}

export function updateFormula(id: string, name: string, expression: string): void {
  const formulas = state.formulas.map((item) =>
    item.id === id
      ? {
          ...item,
          name: name.trim() || expression.trim(),
          expression: expression.trim()
        }
      : { ...item }
  )
  setState('formulas', formulas)
  persist({ formulas })
}

export function removeFormula(id: string): void {
  const formulas = state.formulas.filter((item) => item.id !== id).map((item) => ({ ...item }))
  setState('formulas', formulas)
  persist({ formulas })
}

/* ------------------------------------------------------------------ 落盘 */

function persist(patch: Partial<AppState>): void {
  void shell.state.patch(patch).catch((error) => {
    console.error('[app-state] 保存失败：', error)
  })
}

/** 收盘后自动归档：每分钟检查一次；成功才记录日期，失败下分钟重试。 */
let autoArchiveTimer: ReturnType<typeof setInterval> | undefined
let autoArchiveRunning = false

export function startAutoArchive(): void {
  if (autoArchiveTimer) return
  const tick = async (): Promise<void> => {
    if (autoArchiveRunning) return
    const now = new Date()
    if (
      !shouldAutoArchive(
        now,
        state.settings.autoArchive ?? false,
        state.settings.autoArchiveLastDate
      )
    ) {
      return
    }
    autoArchiveRunning = true
    try {
      await api.data.archiveSnapshot()
      // 竞价只保留最近交易日：顺手把自选池的当日竞价也归档。
      const codes = watchCodes()
      const date = localDateKey(now)
      if (codes.length > 0) {
        const auction = await api.auction.archiveBatch(codes)
        if (auction.failedCount > 0) {
          console.warn(`自动归档竞价：${auction.savedCount} 成功 / ${auction.failedCount} 失败`)
        }
        for (const code of codes) {
          try {
            await api.data.tickArchiveSave(code, date)
            // 资金流查询成功后由 Python 侧自动写 lake/money_flow。
            await api.money.macFlow(code)
            // 5s/15s 只保留服务器当前可回溯窗口，收盘后把自选池的最近 800 根缓存下来。
            for (const period of ['5s', '15s']) {
              await api.data.cacheKlines({
                codes: [code],
                period,
                count: 800,
                adjust: 'none',
                skipExisting: true
              })
            }
          } catch (cause) {
            console.warn(`自动归档 ${code} 失败`, cause)
          }
        }
      }
      updateSettings({ autoArchiveLastDate: date })
    } catch (cause) {
      console.warn('自动归档失败，下一分钟重试', cause)
    } finally {
      autoArchiveRunning = false
    }
  }
  autoArchiveTimer = setInterval(() => void tick(), 60_000)
  void tick()
}
