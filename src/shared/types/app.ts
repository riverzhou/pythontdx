/**
 * 应用状态：搜索、自选、设置、持仓、画线、预警、公式、版面与默认值。
 *
 * 由 `shared/types.ts` 门面统一再导出；外部一律 `from '@shared/types'`。
 */
import type { OfflineSyncPreferences } from './data'
import type { KLineAdjust, KLinePeriod, Market, Quote, ScreenSortBy } from './market'
export interface SearchItem {
  /** 带市场前缀的标准代码 */
  code: string
  symbol: string
  name: string
  market: Market
  /** 证券类型，如 GP-A / ZS / JJ / ZQ */
  kind: string
}

/* ------------------------------------------------------------- 自选与配置 */

export type ThemeMode = 'dark' | 'light'

export interface WatchItem {
  code: string
  name: string
  market: Market
}

/** 自选股分组 */
export interface WatchGroup {
  id: string
  name: string
  items: WatchItem[]
}

export interface IndicatorParams {
  macdFast: number
  macdSlow: number
  macdSignal: number
  kdjPeriod: number
  kdjM1: number
  kdjM2: number
  rsiPeriod: number
  bollPeriod: number
  bollK: number
  wrPeriod?: number
  cciPeriod?: number
  biasShort?: number
  biasMid?: number
  biasLong?: number
  dmiPeriod?: number
  rocPeriod?: number
  psyPeriod?: number
  vrPeriod?: number
  crPeriod?: number
  dmaShort?: number
  dmaLong?: number
  dmaSignal?: number
  trixPeriod?: number
  trixSignal?: number
  sarStep?: number
  sarMax?: number
}

export interface PortfolioPosition {
  code: string
  shares: number
  cost: number
}

export interface ChartDrawing {
  id: string
  code: string
  period: KLinePeriod
  /** 复权方式；旧数据没有该字段时按 qfq 处理 */
  adjust?: 'none' | 'qfq' | 'hfq'
  type: 'horizontal' | 'trend' | 'vertical' | 'text' | 'fib' | 'measure' | 'arrow' | 'channel'
  price?: number
  startIndex?: number
  startPrice?: number
  endIndex?: number
  endPrice?: number
  /** 画线锚定日期；数据前插/翻页后比下标更稳 */
  startDate?: string
  endDate?: string
  text?: string
  /** 斐波那契是否追加 127.2%/161.8% 扩展位 */
  extended?: boolean
  /** 平行通道的垂直价格偏移 */
  offset?: number
  /** 智能画线生成（重新智能画线时替换旧智能线） */
  smart?: boolean
}

export interface AppSettings {
  /** 行情轮询间隔（ms） */
  refreshInterval: number
  theme: ThemeMode
  /** 是否随窗口失焦暂停刷新 */
  pauseWhenHidden: boolean
  /** 自选股行内是否显示迷你走势图 */
  showSparkline: boolean
  /**
   * K 线可见根数（缩放档位），下次打开还用它。
   * 可选：默认值与合法档位由图表层给（`KLINE_BARS_MAX` / `nearestZoomLevel()`），
   * 档位表属于图表几何，不该复制一份到 shared 来（复制就一定会漂移）。
   */
  klineZoom?: number
  /** 图表上次停留的周期 */
  chartTab?: 'minute' | 'five' | KLinePeriod
  /** 上次复权口径 */
  klineAdjust?: KLineAdjust
  /** 主图是否叠加 BOLL */
  showBoll?: boolean
  /** 是否显示已保存的画线；默认关闭 */
  showDrawings?: boolean
  /** 是否显示均线；默认开启，可关闭只看裸 K/BOLL */
  showAverages?: boolean
  /** 画线是否吸附开/高/低/收；默认开启 */
  snapDrawings?: boolean
  /** 指标面板参数 */
  indicatorParams?: IndicatorParams
  /** K 线副图 */
  subIndicator?:
    | 'none'
    | 'macd'
    | 'kdj'
    | 'rsi'
    | 'wr'
    | 'cci'
    | 'bias'
    | 'dmi'
    | 'obv'
    | 'roc'
    | 'psy'
    | 'vr'
    | 'cr'
    | 'bbi'
    | 'dma'
    | 'trix'
    | 'sar'
  /** 价格坐标是否对数 */
  logScale?: boolean
  /** K 线画线（按 code/period 保存） */
  chartDrawings?: ChartDrawing[]
  /** 上次读取的本地 .day 路径 */
  localDayPath?: string
  /** 关闭窗口时隐藏到托盘 */
  closeToTray?: boolean
  /** 自选侧栏宽度（px） */
  sidebarWidth?: number
  /** 一键隐藏自选侧栏 */
  sidebarHidden?: boolean
  /** 右侧盘口栏宽度（px） */
  railWidth?: number
  /** 自定义版面槽（最多 3 个） */
  layoutSlots?: LayoutSlot[]
  /** 条件选股预设（最多 10 个） */
  screenPresets?: ScreenPreset[]
  /** 主图叠加公式；为空则关闭 */
  mainFormula?: string
  /** 主图三条均线周期 */
  maPeriods?: number[]
  /** 最近搜索（最多 8 条） */
  recentSearches?: SearchItem[]
  /** 收盘后自动归档全市场快照 */
  autoArchive?: boolean
  /** 自动归档最近成功日期 YYYY-MM-DD */
  autoArchiveLastDate?: string
  /** 正在自动跟踪的预设 id；为空则不跟踪 */
  trackingPresetId?: string
  /** 可同时跟踪多个预设 */
  trackingPresetIds?: string[]
  /** 上次离线同步的勾选/范围/数据源/并发，下次打开数据工具恢复 */
  offlineSync?: OfflineSyncPreferences
}

export interface ScreenPreset {
  id: string
  name: string
  minChange: string
  minAmountYi: string
  minTurnover: string
  minAmplitude: string
  maxPrice: string
  industry: string
  sortBy: ScreenSortBy
  /** 估值/市值条件；旧预设可缺省 */
  maxPb?: string
  minFloatCapYi?: string
  maxFloatCapYi?: string
  minTotalCapYi?: string
  maxTotalCapYi?: string
  createdAt: number
}

export interface LayoutSlot {
  sidebar: number
  rail: number
  savedAt: number
}

export type AlertMetric = 'price' | 'changePct' | 'volumeRatio' | 'turnoverRate' | 'amplitude'
export type AlertDirection = 'above' | 'below' | 'crossAbove' | 'crossBelow'

export interface AlertCondition {
  metric: AlertMetric
  direction: AlertDirection
  value: number
}

export interface AlertRule {
  id: string
  code: string
  name: string
  metric: AlertMetric
  direction: AlertDirection
  value: number
  /** 可选：全部条件同时满足才触发；为空时使用顶层 metric/direction/value */
  conditions?: AlertCondition[]
  /** 组合条件关系：默认且 */
  conditionMode?: 'and' | 'or'
  /** 两级嵌套：每组内部为「且」，组间按 groupMode */
  groups?: AlertCondition[][]
  groupMode?: 'and' | 'or'
  enabled: boolean
  /** 最近一次触发的本地日期 YYYY-MM-DD；同一天不重复 */
  lastTriggeredDate?: string
}

export interface AlertEvent {
  rule: AlertRule
  quote: Quote
  at: number
  message: string
}

export interface SavedFormula {
  id: string
  name: string
  expression: string
  createdAt: number
}

export interface AppState {
  /** 数据结构版本，便于做迁移（v1 = 扁平 watchlist，v2 = 分组 groups） */
  version: number
  groups: WatchGroup[]
  /** 当前选中的分组 */
  activeGroupId: string
  settings: AppSettings
  /** 当前选中的股票代码 */
  activeCode: string | null
  /** 本地行情预警；不落交易指令 */
  alerts: AlertRule[]
  /** 本地保存的指标公式 */
  formulas: SavedFormula[]
  /** 最近 50 条预警触发记录（跨重启保留） */
  alertEvents?: AlertEvent[]
  /** 本地持仓（股数/成本） */
  positions?: PortfolioPosition[]
}

/** 持久化数据的当前版本 */
export const STATE_VERSION = 2

export const DEFAULT_GROUP_ID = 'default'

export const DEFAULT_SETTINGS: AppSettings = {
  closeToTray: true,
  refreshInterval: 1000,
  theme: 'dark',
  pauseWhenHidden: true,
  showSparkline: true,
  maPeriods: [5, 10, 20, 60, 120],
  subIndicator: 'none',
  showBoll: false,
  showDrawings: false,
  showAverages: true,
  snapDrawings: true,
  sidebarHidden: false,
  sidebarWidth: 264,
  railWidth: 300
}

/** 首次启动只内置四个宽基指数，不预置任何个股。 */
const SEED_ITEMS: WatchItem[] = [
  { code: 'sh000001', name: '上证指数', market: 'SH' },
  { code: 'sz399001', name: '深证成指', market: 'SZ' },
  { code: 'sz399006', name: '创业板指', market: 'SZ' },
  { code: 'sh000688', name: '科创50', market: 'SH' }
]

/**
 * 默认分组（老用户从 v1 迁移过来时也落到这个分组）。
 *
 * 港股分组已移除：通达信 7709 不提供港股行情，留着只会显示一行「—」。
 * 老用户的持久化数据不会被动删，港股自选会保留但暂时没有行情。
 */
export const SEED_GROUPS: WatchGroup[] = [
  { id: DEFAULT_GROUP_ID, name: '自选', items: SEED_ITEMS },
  { id: 'tech', name: '科技', items: [] }
]

/* --------------------------------------------------------------- 窗口/应用 */

/** 行情连接质量，用于状态栏指示灯 */
export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'paused' | 'error'
