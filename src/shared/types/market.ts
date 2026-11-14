/**
 * 行情与盘口：报价、排行榜、公式选股结果、逐笔、分时、K 线、板块、涨跌家数、榜单。
 *
 * 由 `shared/types.ts` 门面统一再导出；外部一律 `from '@shared/types'`。
 */
/** 支持的交易市场 */
export type Market = 'SH' | 'SZ' | 'BJ' | 'HK' | 'US' | 'UNKNOWN'

export const MARKET_LABEL: Record<Market, string> = {
  SH: '沪',
  SZ: '深',
  BJ: '京',
  HK: '港',
  US: '美',
  UNKNOWN: '—'
}

/* ------------------------------------------------------------------ 行情 */

/** 盘口一档（价格 + 挂单量，A 股单位为「手」） */
export interface OrderLevel {
  price: number
  volume: number
}

/** 单只股票的实时快照 */
export interface Quote {
  /** 带市场前缀的标准代码，如 sh600519 / hk00700 */
  code: string
  /** 不带前缀的交易代码，如 600519 */
  symbol: string
  name: string
  market: Market

  /** 最新价 */
  price: number
  /** 昨收 */
  prevClose: number
  /** 今开 */
  open: number
  /** 最高 */
  high: number
  /** 最低 */
  low: number
  /** 涨跌额 */
  change: number
  /** 涨跌幅（%） */
  changePct: number

  /** 成交量：A 股为「手」，港股为「股」 */
  volume: number
  /** 内盘（手），部分行情源不提供 */
  innerVolume?: number
  /** 外盘（手），部分行情源不提供 */
  outerVolume?: number
  /** 成交额：统一换算为「元」 */
  amount: number

  /** 换手率（%） */
  turnoverRate?: number
  /** 市盈率 TTM */
  peTtm?: number
  /** 市盈率（动态） */
  peDynamic?: number
  /** 市盈率（静态） */
  peStatic?: number
  /** 市净率 */
  pb?: number
  /** 振幅（%） */
  amplitude?: number
  /** 涨速（%） */
  riseSpeed?: number
  /** 量比 */
  volumeRatio?: number
  /** 均价 */
  avgPrice?: number
  /** 涨停价 */
  limitUp?: number
  /** 跌停价 */
  limitDown?: number
  /** 流通市值（亿元） */
  floatCap?: number
  /** 总市值（亿元） */
  totalCap?: number
  /** 币种，如 CNY / HKD */
  currency: string

  /** 交易所行情时间（epoch ms） */
  time: number
  /** 0x0547 记录内的更新时间原始值；作为下一次增量刷新的游标 */
  updateTime?: number
  /** true = 竞价阶段由 0x056a 兜底的价格，不是正式成交 */
  auction?: boolean
  /** 竞价兜底点的时间 HH:MM:SS */
  auctionTime?: string
  /** 买一 ~ 买五 */
  bids: OrderLevel[]
  /** 卖一 ~ 卖五 */
  asks: OrderLevel[]

  /** 本地接收时间（epoch ms），用于展示数据新鲜度 */
  receivedAt: number
}

/** 0x054b 分类行情额外字段；榜单页使用，普通行情不保证存在 */
export interface CategoryQuote extends Quote {
  riseSpeed?: number
  shortTurnover?: number
  lockedAmount?: number
  openingRush?: number
  volRiseSpeed?: number
  depth?: number
  active2?: number
  /** 资金流排行：主力净流入（元） */
  mainNet?: number
  /** 资金流排行：主力净流入 / 成交额（%） */
  mainRatio?: number
  /** 资金流排行：5 日大单净额（元） */
  largeNet5d?: number
}

export type ScreenSortBy =
  'changePct' | 'amount' | 'turnoverRate' | 'amplitude' | 'pb' | 'floatCap' | 'totalCap'

/** 全市场条件选股；金额单位统一为元 */
export interface ScreenRequest {
  minPrice?: number
  maxPrice?: number
  minChangePct?: number
  maxChangePct?: number
  minAmount?: number
  maxAmount?: number
  minTurnoverRate?: number
  maxTurnoverRate?: number
  minAmplitude?: number
  maxAmplitude?: number
  minPb?: number
  maxPb?: number
  /** 亿元，对应 quote.floatCap */
  minFloatCap?: number
  maxFloatCap?: number
  /** 亿元，对应 quote.totalCap */
  minTotalCap?: number
  maxTotalCap?: number
  /** 通达信行业名；空/未传表示全市场 */
  industry?: string
  sortBy?: ScreenSortBy
  ascending?: boolean
  limit?: number
}

export interface FormulaQuote extends CategoryQuote {
  formulaValue: number
}

export interface FormulaScreenRequest {
  expression: string
  /** 按成交额取前 N；0 表示全市场 */
  scope?: number
  limit?: number
  /** 分块扫描起点 */
  offset?: number
  /** 每块扫描数量 */
  batchSize?: number
}

export interface FormulaMarketDay {
  date: string
  sum: number
  count: number
}

export interface FormulaMarketBacktestResult {
  scanned: number
  total: number
  nextOffset: number
  done: boolean
  trades: number
  stocks: number
  daily: FormulaMarketDay[]
  expression: string
  generatedAt: number
}

export interface FormulaScreenResult {
  scanned: number
  total: number
  nextOffset: number
  done: boolean
  matched: number
  quotes: FormulaQuote[]
  expression: string
  generatedAt: number
}

export interface ScreenResult {
  scanned: number
  matched: number
  quotes: CategoryQuote[]
  sortBy: ScreenSortBy
  generatedAt: number
}

/** 0x0fc5 / 0x0fc6 成交明细 */
export type TradeSide = 'buy' | 'sell' | 'neutral' | `status_${number}`
export type TradeEventKind = 'trade' | 'opening_match' | 'auction_snapshot'

export interface TradeTick {
  /** 服务端分页内的绝对序号 */
  index: number
  timeMinutes: number
  /** MAC 0x122F 的当日秒数；7709 分钟级兜底时为空 */
  timeSeconds?: number
  /** HH:MM:SS（MAC）或 HH:MM（7709 兜底） */
  time: string
  price: number
  /** 手 */
  volume: number
  orderCount: number
  /** 0 买 / 1 卖 / 2 中性 / 5 盘后 / 8 竞价快照 */
  status: number
  side: TradeSide
  eventKind: TradeEventKind
  tailRaw?: number
  /** 只对非竞价快照计算；单位元 */
  tradeAmount?: number
}

/** 0x056a 集合竞价过程快照 */
export interface AuctionPoint {
  index: number
  timeMinutes: number
  second: number
  /** HH:MM:SS */
  time: string
  timeSeconds: number
  price: number
  priceMilli: number
  /** 虚拟匹配量，单位手；不是真实成交 */
  matchedVolume: number
  unmatchedVolume: number
  /** 1 买方剩余 / -1 卖方剩余 */
  unmatchedDirection: number
}

export interface MarketBreadth {
  up: number
  down: number
  flat: number
  limitUp?: number
  limitDown?: number
  total: number
  updatedAt: number
}

/** Python 侧用 TDX 数据生成的交易日历状态。 */
export interface MarketCalendarStatus {
  schema: string
  /** 服务端认为的今天（YYYY-MM-DD） */
  today: string
  /** 最近一个交易日；today != lastTradingDay 表示今天休市 */
  lastTradingDay: string
  isTradingDay: boolean
  /** TDX 官方节假日快照 + 用户追加休市日（YYYY-MM-DD） */
  holidays: string[]
  holidaySource: string
  source: string
  fetchedAt: number
  /** 缓存日期不是本地日期时为 true；前端仍按 isTradingDay 判断 */
  stale: boolean
  error: string
  time: string
  date: string
  session: string
}

export type BlockKind = 'gn' | 'fg' | 'zs' | 'general'

export interface BlockGroup {
  id: string
  name: string
  kind: BlockKind | 'industry' | 'custom'
  /** 文件里记录的股票数（含未解析的代码） */
  count: number
  /** 对应的 880xxx 板块指数（tdxzs.cfg），没有则为空 */
  indexCode?: string
  /** 已解析成带市场前缀的代码 */
  codes: string[]
  /** 代码 → 名称，来自 0x044d 代码表 */
  names: Record<string, string>
}

export interface BlockList {
  kind: BlockKind
  label: string
  file: string
  bytes: number
  chunks: number
  sha256: string
  savedTo: string
  blockCount: number
  codeCount: number
  blocks: BlockGroup[]
}

export interface IndustryList {
  kind: 'industry'
  label: string
  file: string
  bytes: number
  chunks: number
  sha256: string
  savedTo: string
  /** incon.dat 在 zhb.zip 内的原始保存路径 */
  inconFrom: string
  zhbChunks: number
  blockCount: number
  codeCount: number
  blocks: BlockGroup[]
  /**
   * 通达信研发行业（TDXRSHY）：tdxhy.cfg 的 rsCode 分组。
   * MAC 0x1231 的一级/二级行业用的就是这套分类（名字 128/128、345/345 对得上），
   * 过去只用 tdxCode，这一份一直没接。
   */
  rsLabel?: string
  rsBlockCount?: number
  rsCodeCount?: number
  rsBlocks?: BlockGroup[]
}

/* --------------------------------------------------------------- 分时图 */

/** 分时的分钟点：价格为该分钟收盘价，avg 为当日累计均价 */
export interface MinutePoint {
  /** HHMM，如 0930 */
  time: string
  price: number
  avg: number
  /** 该分钟成交量（手） */
  volume: number
}

export interface MinuteTrend {
  code: string
  name: string
  /** 交易日 YYYYMMDD */
  date: string
  /** 昨收，分时图的基准线 */
  prevClose: number
  points: MinutePoint[]
}

/** 多日分时（五日分时图）：days 按时间从旧到新排列 */
export interface MultiDayTrend {
  code: string
  name: string
  days: MinuteTrend[]
}

/* ----------------------------------------------------------------- K 线 */

export type KLinePeriod =
  | '5s'
  | '15s'
  | '1m'
  | '5m'
  | '10m'
  | '15m'
  | '20m'
  | '30m'
  | '60m'
  | '2m'
  | '3m'
  | '4m'
  | '6m'
  | '8m'
  | '12m'
  | '18m'
  | '24m'
  | '36m'
  | '48m'
  | 'day'
  | 'week'
  | 'month'
  | '2d'
  | '3d'
  | '4d'
  | '6d'
  | '9d'
  | '12d'
  | '18d'
  | '24d'
  | '45d'
  | 'quarter'
  | 'year'
export type KLineAdjust = 'none' | 'qfq' | 'hfq' | 'fixed_qfq' | 'fixed_hfq'

export interface KLineBar {
  /** YYYY-MM-DD，分钟 K 为 YYYY-MM-DD HH:MM */
  date: string
  open: number
  close: number
  high: number
  low: number
  /** 成交量（手） */
  volume: number
  /** 成交额（元）；0.9.x 旧缓存没有该列，读取后可能为 undefined */
  amount?: number
  /** 指数 K 线的上涨家数；个股/旧缓存为 undefined */
  upCount?: number
  /** 指数 K 线的下跌家数；个股/旧缓存为 undefined */
  downCount?: number
}

export interface KLineSeries {
  code: string
  period: KLinePeriod
  bars: KLineBar[]
  /** network = 通达信实时；cache = 网络失败后的本地缓存 */
  source?: 'network' | 'cache'
  cachePath?: string
  /** 仅 cacheOnly 探测：本地没有缓存，bars 为空；不是错误 */
  miss?: boolean
  /** 主进程增量推送：bars 只是最近 N 根，渲染层需与本地全量合并 */
  tail?: boolean
}

/** 0x053f 排行榜：9 个榜单一次返回 */
export interface TopBoardRow {
  code: string
  market: string
  symbol: string
  price: number
  value: number
  name: string
}

export interface TopBoardResult {
  category: number
  requestedSize: number
  size: number
  boards: Record<string, TopBoardRow[]>
}

/** 0x0563 主力监控（异动） */
export interface UnusualEvent {
  code: string
  name: string
  market: string
  symbol: string
  index: number
  event: number
  desc: string
  value: string
  time: string
  raw: string
}

export interface VolumeProfileLevel {
  price: number
  volume: number
}

export interface VolumeProfilePoint {
  price: number
  volume: number
  buy: number
  sell: number
}

/** 0x051a 成交分布（筹码分布）；免费主站暂不响应，保留数据契约 */
export interface VolumeProfileResult {
  code: string
  name: string
  market: string
  symbol: string
  marketId: number
  active: number
  serverTimeRaw: number
  time: string
  close: number
  preClose: number
  open: number
  high: number
  low: number
  negPrice: number
  volume: number
  currentVolume: number
  amount: number
  inVolume: number
  outVolume: number
  sellAmount: number
  openAmount: number
  bids: VolumeProfileLevel[]
  asks: VolumeProfileLevel[]
  count: number
  profile: VolumeProfilePoint[]
}

/* ------------------------------------------- 离线全量同步（多进程多线程） */

export interface LimitReviewRow {
  code: string
  name: string
  date: string
  close: number
  prevClose: number
  changePct: number
  high: number
  low: number
  limitPrice: number
  kind: 'up' | 'down' | 'broken'
}

export interface LimitReviewResult {
  date: string
  rows: LimitReviewRow[]
  scanned: number
}

/* ----------------------------------------------------------------- 搜索 */
