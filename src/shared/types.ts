/**
 * 主进程 / preload / 渲染进程 三方共享的数据契约。
 *
 * 设计原则：
 *  1. 这个文件只能有「类型」和「常量」，不能 import 任何 Electron / Node / DOM API，
 *     因为它同时被 tsconfig.node.json 和 tsconfig.web.json 编译。
 *  2. 所有跨进程传输的数据都必须是「可结构化克隆」的纯数据（无类实例、无函数、无 Map/Set）。
 */

/* ------------------------------------------------------------------ 市场 */

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

/** 0x0ffc 资金流日记录；接口固定最近 5 个交易日 */
export interface MacBoard {
  market: number
  code: string
  name: string
  price: number
  riseSpeed: number
  preClose: number
  leaderMarket: number
  leaderCode: string
  leaderName: string
  leaderPrice: number
  leaderRiseSpeed: number
  leaderPreClose: number
  type: number
}

export interface MacUnusualItem {
  market: Market
  code: string
  symbol: string
  name: string
  time: string
  desc: string
  value: string
  type: number
  index: number
}

export interface MacMoneyFlow {
  mainIn: number
  mainOut: number
  mainNet: number
  retailIn: number
  retailOut: number
  retailNet: number
  largeNet5d: number
  midNet5d: number
  receivedAt: number
}

/** 批量资金流（0x1218）返回的一行；code 由批量命令补上。 */
export interface MacMoneyFlowPoint extends MacMoneyFlow {
  code: string
}

export interface MoneyFlowRecord {
  code: string
  market: Market
  symbol: string
  date: string
  totalAmount: number
  buckets: number[]
  mainNet: number
  mainRatio: number
  mainBuyNet: number
  mainBuyRatio: number
  mainSuperLargeNet: number
  mainLargeNet: number
  mainMediumNet: number
  mainSmallNet: number
  mainBuySuperLargeNet: number
  mainBuyLargeNet: number
  mainBuyMediumNet: number
  mainBuySmallNet: number
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

/** 本地竞价归档（lake/auction/trade_date=.../*.jsonl.gz + manifest）。 */
export interface AuctionArchiveResult {
  code: string
  tradeDate: string
  points: AuctionPoint[]
  rows: number
  source: 'archive'
  found: boolean
  /** 已有校验通过的归档时不再覆盖 */
  skipped?: boolean
  dir?: string
  sha256?: string
  generatedAt?: string
}

/** 竞价归档目录项；不含点数据。 */
export interface AuctionArchiveItem {
  code: string
  tradeDate: string
  rows: number
  bytes: number
  sha256?: string
  generatedAt?: string
  dir: string
}

export interface AuctionArchiveBatchSaved {
  code: string
  tradeDate: string
  rows: number
  dir?: string
  sha256?: string
}

export interface AuctionArchiveBatchResult {
  tradeDate: string
  saved: AuctionArchiveBatchSaved[]
  failed: Array<{ code: string; error: string }>
  savedCount: number
  failedCount: number
}

export interface TickArchiveItem {
  code: string
  tradeDate: string
  rows: number
  bytes: number
  sha256?: string
  generatedAt?: string
  dir: string
}

export interface TickArchiveResult {
  code: string
  tradeDate: string
  rows: number
  dir?: string
  sha256?: string
  generatedAt?: string
  skipped?: boolean
}

export interface TickArchiveBatchResult {
  tradeDate: string
  saved: TickArchiveResult[]
  failed: Array<{ code: string; error: string }>
  savedCount: number
  failedCount: number
}

/** 0x02cf F10 段落目录 */
export interface F10Section {
  name: string
  filename: string
  start: number
  length: number
}

export interface F10ProfileTable {
  columns: string[]
  rows: Array<Array<string | number | null>>
  reportDate?: string
  template?: number
  kind?: string
  full?: boolean
}

export interface LocalDayBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  amount: number
  volume: number
}

export interface LocalDayWriteResult {
  path: string
  count: number
}

export interface SnapshotArchiveItem {
  dir: string
  tradeDate: string
  rows: number
  sha256: string
  generatedAt: string
  size: number
}

export interface SnapshotArchiveResult {
  dir: string
  rows: number
  sha256: string
  generatedAt: string
  tradeDate: string
  /** 当日分区已存在时跳过重复写入 */
  skipped?: boolean
}

export interface KLineExportResult {
  dir: string
  files: string[]
  rows: number
  codes: number
  generatedAt: string
  failed: Array<{ code: string; error: string }>
}

export interface LocalImportResult {
  code: string
  rows: number
  totalRows: number
  sha256: string
  rawPath: string
  jsonlPath: string
  database: string
  manifest: string
}

export interface LocalDayResult {
  path: string
  count: number
  firstDate: string
  lastDate: string
  bars: LocalDayBar[]
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

export interface F10TradingTable {
  section: string
  rawColumns: string[]
  columns: string[]
  rows: Array<Array<string | number>>
  count: number
}

export interface F10NewsItem {
  id: string
  date: string
  title: string
  source: string
}

export interface F10Announcement {
  id: string
  date: string
  title: string
  type: string
  source: string
  url: string
}

/* --------------------------------------------------------------- 数据工具 */

export interface TdxStatSample {
  market: number | null
  code: string
  beta60: number | null
  peTtm: number | null
  statsDate: string
  freeFloatShares10k: number | null
  yearLimitUpDays: number | null
  limitUpStreakDays: number | null
}

export interface TdxStat2Sample {
  market: number | null
  code: string
  statsDate: string
  amount10k: number | null
  sealAmount10k: number | null
  openAmount10k: number | null
}

export interface TdxStatsSummary {
  zipBytes: number
  zipEntries: number
  statCount: number
  stat2Count: number
  statsDate: string | null
  statsDateTop: Array<[string, number]>
  statSamples: TdxStatSample[]
  stat2Samples: TdxStat2Sample[]
  chunks: number
  sha256: string
  savedTo: string
}

export interface TdxStatsPartition {
  tradeDate: string
  statCount: number
  stat2Count: number
  path: string
}

export interface TdxStatsExport {
  normalizedTo: string
  manifest: string
  database: string
  sha256: string
  generatedAt: string
  partitions: TdxStatsPartition[]
  statCount: number
  stat2Count: number
  statSkipped: number
  stat2Skipped: number
  chunks: number
  rawSavedTo: string
  rawBytes: number
}

export interface StatsQueryResult {
  columns: string[]
  rows: Array<Array<string | number | null>>
  rowCount: number
  limited: boolean
}

export interface StatsParquetExport {
  rowCount: number
  target: string
  manifest: string
  schemaVersion: number
  files: Array<{ table: string; tradeDate: string; rows: number; path: string }>
}

export interface StatsCsvExport {
  statCsv: string
  stat2Csv: string
  statCount: number
  stat2Count: number
}

/* --------------------------------------------------------------- 板块数据 */

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

export interface DataInventorySection {
  files: number
  bytes: number
  path: string
}

export interface DataInventory {
  root: string
  raw: DataInventorySection
  cache: DataInventorySection
  lake: DataInventorySection
  exports: DataInventorySection
  normalized: DataInventorySection
  local: DataInventorySection
  klineCache: {
    files: number
    codes: number
    periods: string[]
    latest: number
  }
}

/* --------------------------------------------------- 离线数据覆盖统计 */

export interface DataCoverageItem {
  name: string
  files: number
  bytes: number
  oldest: string | null
  newest: string | null
  status: string
  periods?: Record<string, number>
}

export interface DataCoverageResult {
  generatedAt: string
  root: string
  datasets: DataCoverageItem[]
  totalFiles: number
  totalBytes: number
}

/* --------------------------------------------------- 离线数据完整性校验 */

export interface DataIntegrityDetail {
  manifest: string
  error: string
}

export interface DataIntegrityCheck {
  name: string
  checked: number
  failed: number
  details: DataIntegrityDetail[]
}

export interface DataIntegrityResult {
  ok: boolean
  checks: DataIntegrityCheck[]
  klineBackfill: { created: number; skipped: number; failed: number }
  checked: number
  failed: number
}

/* --------------------------------------------------- 离线数据备份 / 恢复 */

/** 备份文件内的清单（`_pythontdx_backup.json`） */
export interface DataBackupManifest {
  format: number
  app: string
  createdAt: number
  dataRoot: string
  fileCount: number
  totalBytes: number
}

export interface DataBackupCreateResult {
  path: string
  fileCount: number
  totalBytes: number
  archiveBytes: number
  sha256: string
  createdAt: number
  dataRoot: string
}

export interface DataBackupInspectResult {
  path: string
  archiveBytes: number
  fileCount: number
  totalBytes: number
  createdAt: number
  dataRoot: string
  format: number
}

export interface DataBackupRestoreResult {
  path: string
  /** 本次新补回的文件数 */
  restored: number
  /** 同名覆盖的文件数 */
  overwritten: number
  /** 跳过的文件数（manifest 等） */
  skipped: number
  /** 写入的字节数 */
  bytes: number
  dataRoot: string
}

/** 备份/恢复过程中的真实进度；由 Python sidecar 的 stderr 进度行转换而来。 */
export interface DataBackupProgress {
  operation: 'backup' | 'restore'
  phase: 'scan' | 'write' | 'hash' | 'done'
  /** 已处理的原始字节数；hash 阶段是压缩包已哈希字节数 */
  doneBytes: number
  /** 总原始字节数；hash 阶段是压缩包字节数，scan 阶段可能为 0 */
  totalBytes: number
  doneFiles: number
  totalFiles: number
  /** 当前文件（相对数据目录），可能为空 */
  current: string
}

/* ------------------------------------------- 板块/财务/龙虎榜离线归档 */

export interface DatasetArchiveFile {
  file: string
  rows?: number
  bytes?: number
  sha256?: string
  skipped?: boolean
  error?: string
}

export interface DatasetArchiveResult {
  dir: string
  sectorRows: number
  lhbRows: number
  financeCodes: number
  /** 三大报表（资产负债表/利润表/现金流量表）写入的行数。 */
  statementRows: number
  /** 财务整只抓取失败的代码（网络/停牌等），成功为空数组。 */
  financeFailed: string[]
  manifest: string
  files: DatasetArchiveFile[]
}

export interface KLineCacheResult {
  cached: number
  skipped: number
  failed: Array<{ code: string; error: string }>
  period: string
  count: number
  dir: string
}

/* ------------------------------------------- 7709 原生扩展（gotdx 吸收） */

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

/**
 * 离线数据的可下载窗口。交易日 08:45–15:45 官方集中发行情数据，窗口关闭；
 * 关闭时启动会返回 `blocked`，运行中的任务会在 08:45 暂停、15:45 后续跑。
 */
export interface OfflineSyncWindow {
  open: boolean
  now: string
  tradingDay: boolean
  windowStart: string
  windowEnd: string
  reason: string
  /** 窗口关闭时给出下次可下载时间 */
  nextOpenAt: string | null
  /** 运行中的任务应在该时间点暂停 */
  pauseAt: string | null
  holidaysLoaded: number
}

export interface OfflineSyncDatasetMeta {
  key: string
  label: string
  group: string
  /** per_code：每只代码一份文件；bulk：按交易日合并一份 */
  mode: 'per_code' | 'bulk'
  description: string
  weight: number
}

export interface OfflineSyncPreset {
  label: string
  datasets: string[]
  scope?: string
  periods?: string[]
  f10Sections?: string
}

export interface OfflineSyncCatalog {
  datasets: OfflineSyncDatasetMeta[]
  presets: Record<string, OfflineSyncPreset>
  window: OfflineSyncWindow
}

export type OfflineSyncState =
  | 'idle'
  | 'blocked'
  | 'probing'
  | 'planning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface OfflineSyncOptions {
  preset?: string
  datasets?: string[] | string
  scope?: 'all' | 'watchlist' | 'codes'
  /** scope=watchlist/codes 时的代码 */
  codes?: string[]
  periods?: string[] | string
  adjust?: string
  /** auto=MAC 优先失败回退 7709；mac=只用 MAC；7709=只用主站 */
  source?: 'auto' | 'mac' | '7709'
  /** auction/ticks/history_minute 的交易日；空表示今天 */
  dates?: string[] | string
  f10Sections?: 'core' | 'full'
  minuteAuxKinds?: string[] | string
  processes?: number
  threads?: number
  retries?: number
  enforceWindow?: boolean
  /** 仅用于测试：允许在窗口内启动 */
  allowInsideWindow?: boolean
  skipExisting?: boolean
  delistedCodes?: string[]
  includeIndexes?: boolean
  maxCodes?: number
  jobId?: string
}

export interface OfflineSyncTotals {
  total: number
  done: number
  skipped: number
  failed: number
  rows: number
}

export interface OfflineSyncDatasetProgress {
  done: number
  skipped: number
  failed: number
  rows: number
}

export interface OfflineSyncFailure {
  task?: {
    dataset?: string
    code?: string
    codes?: string[]
    key?: string
    period?: string
    date?: string
  }
  status?: string
  error?: string
}

export interface OfflineSyncWorker {
  index: number | null
  pid: number | null
  state: string | null
  total: number | null
  done: number | null
  failed: number | null
  current: string | null
  updatedAt: string | null
}

export interface OfflineSyncLastSummary {
  jobId: string
  dir: string
  state: string
  error: string
  planned: number
  totals: OfflineSyncTotals
  datasets: Record<string, number>
  elapsedSeconds?: number | null
  /** 中断任务的原选项，用于窗口里的「继续未完成任务」。 */
  options?: Partial<OfflineSyncOptions>
  codes?: number
  startedAt?: string | null
  finishedAt?: string | null
}

export interface OfflineSyncStatus {
  state: OfflineSyncState
  jobId?: string
  dir?: string
  reason?: string
  error?: string
  window: OfflineSyncWindow
  options?: OfflineSyncOptions
  startedAt?: string
  finishedAt?: string
  elapsedSeconds?: number
  totals?: OfflineSyncTotals
  datasets?: Record<string, OfflineSyncDatasetProgress>
  workers?: OfflineSyncWorker[]
  failures?: OfflineSyncFailure[]
  throughputPerSecond?: number
  etaSeconds?: number | null
  summary?: Record<string, unknown> | null
  lastSummary?: OfflineSyncLastSummary | null
  catalog?: OfflineSyncDatasetMeta[]
  presets?: Record<string, OfflineSyncPreset>
}

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

/** 数据工具上次使用的并行同步选项；空对象表示从未保存过。 */
export interface OfflineSyncPreferences {
  datasets: string[]
  scope: 'watchlist' | 'all'
  source: 'auto' | 'mac' | '7709'
  processes: number
  threads: number
  skipExisting: boolean
  /** 上次任务 incomplete 时，桥接重启后自动续跑一次 */
  autoResume?: boolean
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
  sidebarWidth: 280,
  railWidth: 330
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

export type WindowAction =
  'minimize' | 'toggle-maximize' | 'toggle-fullscreen' | 'close' | 'toggle-devtools'

export interface WindowState {
  maximized: boolean
  focused: boolean
  /** 是否处于系统全屏 */
  fullscreen?: boolean
  /** win32 / darwin / linux / web */
  platform: string
}

/** 一块物理/逻辑显示器；Web 端返回一个虚拟项。 */
export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  scaleFactor: number
  primary: boolean
  /** 当前窗口是否在这块屏上 */
  current: boolean
}

export interface GraphicsInfo {
  session: string
  wayland: boolean
  requested: string
  platform: string
  gpuFeatureStatus: Record<string, string>
}

export interface ServerHostResult {
  host: string
  port: number
  latencyMs: number
  status: 'ok' | 'error'
  error: string
  preferred: boolean
}

export interface ServerSpeedResult {
  hosts: ServerHostResult[]
  preferred: string | null
  /** connect.cfg 路径或 builtin-public-list */
  source: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  /** 是否从 Linux AppImage 启动（设置面板据此显示「修复双击」） */
  appImage?: boolean
}

/** Linux AppImage 桌面集成结果（修复「文件管理器双击不启动」）。 */
export interface LinuxDesktopResult {
  desktopFile: string
  launcherScript: string
  launcherDesktopFile: string
  mimeAppsFile: string
  changed: boolean
  previousHandler: string | null
}

/** 主进程推送的一帧行情更新 */
export interface QuoteUpdate {
  /** 本次拉到的行情；失败时为空数组 */
  quotes: Quote[]
  /** 本地生成时间（epoch ms） */
  at: number
  /** 本次拉取失败时的原因（此时 quotes 为空，渲染层应保留上一帧数据） */
  error?: string
}

/**
 * 面板级推送任务。
 *
 * 上游 0x0547 已实测为快照，不能做真正的服务端推送；这里由主进程持有
 * 订阅、拉取并推给渲染层，界面组件不再各自 setInterval。任务只描述
 * 「要什么数据」，调度和 IPC 都在主进程，避免每个面板各拉一套。
 */
export type PushTask =
  | {
      kind: 'category'
      category: number
      sortType: number
      start: number
      count: number
      ascending?: boolean
    }
  | { kind: 'ticks'; code: string; date?: string; start?: number; count?: number }
  | { kind: 'auction'; code: string; date?: string }
  | { kind: 'moneyFlow'; code: string }
  | { kind: 'kline'; code: string; period: KLinePeriod; count: number; adjust: KLineAdjust }
  | { kind: 'minute'; code: string }
  | { kind: 'fiveDay'; code: string }

/** 主进程推给某个面板订阅的一帧数据 */
export interface PushUpdate {
  id: number
  at: number
  task: PushTask
  data?: unknown
  error?: string
}

/* ------------------------------------------------------------------ 状态 */

/** 行情连接质量，用于状态栏指示灯 */
export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'error'
