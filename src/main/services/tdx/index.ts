/**
 * 通达信行情门面。
 *
 * 真正的 TCP/协议/解析在 Python 桥接进程里；这里只做：
 *   · 把渲染层的请求翻译成 JSON 命令；
 *   · 缓存 K 线/分时这类低频数据；
 *   · 维护代码表 + 拼音搜索索引。
 */
import type {
  AuctionArchiveBatchResult,
  AuctionArchiveItem,
  AuctionArchiveResult,
  AuctionPoint,
  BlockKind,
  BlockList,
  CategoryQuote,
  F10Announcement,
  F10NewsItem,
  MarketBreadth,
  LocalDayBar,
  LocalDayResult,
  DataBackupCreateResult,
  DataBackupInspectResult,
  DataBackupProgress,
  DataBackupRestoreResult,
  DatasetArchiveResult,
  DataCoverageResult,
  DataIntegrityResult,
  DataInventory,
  KLineCacheResult,
  OfflineSyncCatalog,
  OfflineSyncOptions,
  OfflineSyncStatus,
  TopBoardResult,
  UnusualEvent,
  VolumeProfileResult,
  LimitReviewResult,
  KLineExportResult,
  SnapshotArchiveItem,
  SnapshotArchiveResult,
  TickArchiveBatchResult,
  TickArchiveItem,
  TickArchiveResult,
  LocalImportResult,
  LocalDayWriteResult,
  F10TradingTable,
  F10ProfileTable,
  FormulaScreenRequest,
  FormulaScreenResult,
  FormulaMarketBacktestResult,
  F10Section,
  IndustryList,
  KLineAdjust,
  KLinePeriod,
  KLineSeries,
  ServerSpeedResult,
  MinuteTrend,
  MacMoneyFlow,
  MacMoneyFlowPoint,
  MacBoard,
  MacUnusualItem,
  MoneyFlowRecord,
  MultiDayTrend,
  Quote,
  ScreenRequest,
  ScreenResult,
  SearchItem,
  StatsCsvExport,
  StatsParquetExport,
  StatsQueryResult,
  TdxStatsExport,
  TdxStatsSummary,
  TradeTick
} from '@shared/types'
import type { ChartPatternsRequest, ChartPatternsResult } from '@shared/patterns'
import type { CategoryRequest, TradesRequest } from '@shared/ipc'
import { fetchLiveKline, type LiveKlineState } from '@shared/kline-live'
import { splitCode } from '@shared/market'
import { TtlCache } from '../cache'
import { CODE_LIST_TIMEOUT_MS, QUOTES_TIMEOUT_MS, TdxBridge, TdxError } from './bridge'
import { buildSearchEntries, searchEntries, type SearchEntry, type SearchSecurity } from './search'
import type { SecurityInfo } from './types'

const bridge = new TdxBridge()

/** 实时行情一次编排内部最多串行 4 个 7709 请求，总时长要给足 */
const LIVE_QUOTES_TIMEOUT_MS = 35_000

const minuteCache = new TtlCache<MinuteTrend>(10_000)
const fiveDayCache = new TtlCache<MultiDayTrend>(60_000)
const klineCache = new TtlCache<KLineSeries>(60_000)

/** 实时 K 线的增量策略与 Web 共用，见 @shared/kline-live */
const liveKlineCache = new Map<string, LiveKlineState>()

interface CodeIndex {
  byCode: Map<string, SecurityInfo>
  entries: SearchEntry[]
}

let codeIndex: CodeIndex | null = null
let codeIndexLoading: Promise<CodeIndex> | null = null
let codeIndexFailedAt = 0

/* ------------------------------------------------------------ 代码表 */

async function loadCodeIndex(): Promise<CodeIndex> {
  const all = await bridge.send<SecurityInfo[]>('code_list', {}, CODE_LIST_TIMEOUT_MS)
  return {
    byCode: new Map(all.map((item) => [item.code, item])),
    entries: buildSearchEntries(all)
  }
}

function ensureCodeIndex(): Promise<CodeIndex> {
  if (codeIndex) return Promise.resolve(codeIndex)
  if (codeIndexLoading) return codeIndexLoading

  if (Date.now() - codeIndexFailedAt < 60_000) {
    return Promise.reject(new TdxError('证券代码表暂时不可用，请稍后重试'))
  }

  codeIndexLoading = loadCodeIndex()
    .then((index) => {
      codeIndex = index
      return index
    })
    .catch((error: unknown) => {
      codeIndexFailedAt = Date.now()
      codeIndexLoading = null
      throw error
    })

  return codeIndexLoading
}

/* -------------------------------------------------------------- 实时行情 */

function normalizeCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => code.trim().toLowerCase()).filter(Boolean))]
}

/**
 * 批量拉取实时行情。
 *
 * 编排（0x054c 快照 → 0x0547 增量 → 合并 → 竞价兜底 → MAC 兜底）统一在
 * `Bridge.live_quotes` 内完成，Electron IPC / HTTP / SSE / WebSocket 共用一份，
 * 避免两边各写一套合并逻辑后漂移。这里只负责去重、取消检查与透传。
 */
export async function fetchQuotes(codes: string[], signal?: AbortSignal): Promise<Quote[]> {
  const unique = normalizeCodes(codes)
  if (unique.length === 0) return []
  if (signal?.aborted) throw new TdxError('请求已取消')

  // 内部最多串行 4 个 7709 请求；给足总时长，行情是全局 1 秒主时钟，插队执行。
  return bridge.send<Quote[]>('live_quotes', { codes: unique }, LIVE_QUOTES_TIMEOUT_MS, true)
}

/** 0x054b 服务端排序的一页分类行情；category=6 是沪深 A 股。 */
export async function fetchMacQuotes(codes: string[]): Promise<Quote[]> {
  return bridge.send<Quote[]>('mac_quotes', { codes: normalizeCodes(codes) }, 30_000)
}

/** 全市场市值排行：MAC 报价后补 0x0010 财务；财务失败仍返回行情。 */
export async function fetchMacQuotesFinance(codes: string[]): Promise<Quote[]> {
  return bridge.send<Quote[]>('mac_quotes_finance', { codes: normalizeCodes(codes) }, 90_000)
}

export async function fetchCategoryQuotes(request: CategoryRequest): Promise<CategoryQuote[]> {
  return bridge.send<CategoryQuote[]>('category', { ...request }, QUOTES_TIMEOUT_MS)
}

/** 0x0fc5 / 0x0fc6 成交明细；date 省略走当日。 */
export async function fetchTrades(request: TradesRequest): Promise<TradeTick[]> {
  // 逐笔面板 1 秒一刷，且首屏直接决定观感；插到队首，别排在自选迷你图/历史 K 后面。
  return bridge.send<TradeTick[]>('trades', { ...request }, QUOTES_TIMEOUT_MS, true)
}

/** 0x0ffc 资金流：最近 5 个交易日。 */
export async function fetchMoneyFlow(code: string): Promise<MoneyFlowRecord[]> {
  return bridge.send<MoneyFlowRecord[]>('money_flow', { code }, QUOTES_TIMEOUT_MS)
}

/** 0x056a 集合竞价过程；date 省略为当日。 */
export async function fetchMacBoards(boardType = 255): Promise<MacBoard[]> {
  return bridge.send<MacBoard[]>('mac_boards', { boardType }, QUOTES_TIMEOUT_MS)
}

export async function fetchMacUnusual(count = 600): Promise<MacUnusualItem[]> {
  return bridge.send<MacUnusualItem[]>('mac_unusual', { count }, QUOTES_TIMEOUT_MS)
}

export async function fetchMacMoneyFlow(code: string): Promise<MacMoneyFlow> {
  return bridge.send<MacMoneyFlow>('mac_money_flow', { code }, QUOTES_TIMEOUT_MS)
}

/** 批量 0x1218；单只失败由 Python 侧跳过，不阻断整张榜。 */
export async function fetchMacMoneyFlowBatch(
  codes: string[],
  workers = 12
): Promise<MacMoneyFlowPoint[]> {
  return bridge.send<MacMoneyFlowPoint[]>(
    'mac_money_flow_batch',
    { codes: normalizeCodes(codes), workers },
    90_000
  )
}

export async function fetchAuctions(
  code: string,
  date?: string,
  selector = 0
): Promise<AuctionPoint[]> {
  return bridge.send<AuctionPoint[]>(
    'auctions',
    { code, date: date || undefined, selector, limit: 500 },
    QUOTES_TIMEOUT_MS
  )
}

export async function fetchAuctionArchiveSave(
  code: string,
  date?: string
): Promise<AuctionArchiveResult> {
  return bridge.send<AuctionArchiveResult>(
    'auction_archive_save',
    { code, date: date || undefined },
    QUOTES_TIMEOUT_MS
  )
}

export async function fetchAuctionArchiveRead(
  code: string,
  date: string
): Promise<AuctionArchiveResult> {
  return bridge.send<AuctionArchiveResult>(
    'auction_archive_read',
    { code, date },
    QUOTES_TIMEOUT_MS
  )
}

export async function fetchAuctionArchiveList(limit = 50): Promise<AuctionArchiveItem[]> {
  return bridge.send<AuctionArchiveItem[]>('auction_archive_list', { limit }, QUOTES_TIMEOUT_MS)
}

export async function fetchAuctionArchiveBatch(
  codes: string[],
  date?: string
): Promise<AuctionArchiveBatchResult> {
  return bridge.send<AuctionArchiveBatchResult>(
    'auction_archive_batch',
    { codes: normalizeCodes(codes), date: date || undefined },
    90_000
  )
}

/** 单只历史逐笔归档；整日数据可能多页，给足 5 分钟。 */
export async function saveTickArchive(code: string, date: string): Promise<TickArchiveResult> {
  return bridge.send<TickArchiveResult>('tick_archive_save', { code, date }, 300_000)
}

/** 批量逐笔归档；UI 已按只调用，保留批量给脚本/HTTP。 */
export async function fetchTickArchiveBatch(
  codes: string[],
  date: string
): Promise<TickArchiveBatchResult> {
  return bridge.send<TickArchiveBatchResult>(
    'tick_archive_batch',
    { codes: normalizeCodes(codes), date },
    600_000
  )
}

export async function fetchTickArchiveDates(
  code: string,
  start?: string,
  end?: string,
  days = 20
): Promise<string[]> {
  return bridge.send<string[]>(
    'tick_archive_dates',
    { code, start: start || undefined, end: end || undefined, days },
    120_000
  )
}

export async function fetchTickArchiveList(limit = 20): Promise<TickArchiveItem[]> {
  return bridge.send<TickArchiveItem[]>('tick_archive_list', { limit }, 20_000)
}

/** 0x02cf F10 段落目录。 */
export async function fetchF10Catalog(code: string): Promise<F10Section[]> {
  return bridge.send<F10Section[]>('f10_catalog', { code }, QUOTES_TIMEOUT_MS)
}

/** 0x02d0 F10 段落正文。 */
export async function fetchF10ChangePlans(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_change_plans', { code }, QUOTES_TIMEOUT_MS)
}

export async function fetchF10Controller(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_controller', { code }, QUOTES_TIMEOUT_MS)
}

export async function fetchF10Institutions(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_institutions', { code }, QUOTES_TIMEOUT_MS)
}

export async function fetchF10ShareholderChanges(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_shareholder_changes', { code }, QUOTES_TIMEOUT_MS)
}

export async function fetchF10CirculatingShareholders(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_circulating_shareholders', { code }, QUOTES_TIMEOUT_MS)
}

export async function fetchF10Capital(code: string, section: string): Promise<F10TradingTable> {
  return bridge.send<F10TradingTable>('f10_capital', { code, section }, QUOTES_TIMEOUT_MS)
}

export async function fetchF10ShareholderCount(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_shareholder_count', { code }, QUOTES_TIMEOUT_MS)
}

export async function fetchF10Dividend(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_dividend', { code }, QUOTES_TIMEOUT_MS)
}

export async function fetchF10Market(section: string): Promise<F10TradingTable> {
  return bridge.send<F10TradingTable>('f10_market', { section }, 20_000)
}

export async function fetchF10LhbMarket(): Promise<F10TradingTable> {
  return bridge.send<F10TradingTable>('f10_lhb_market', {}, 20_000)
}

export async function fetchF10Content(code: string, section: F10Section): Promise<string> {
  return bridge.send<string>(
    'f10_content',
    {
      code,
      filename: section.filename,
      start: section.start,
      length: section.length
    },
    QUOTES_TIMEOUT_MS
  )
}

/** 7615 TQLEX 在线公告（免费，不拉研报正文）。 */
export async function fetchF10Announcements(code: string): Promise<F10Announcement[]> {
  return bridge.send<F10Announcement[]>('f10_announcements', { code }, 20_000)
}

export async function fetchF10Profile(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_profile', { code }, 20_000)
}

export async function fetchF10Valuation(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_valuation', { code }, 20_000)
}

export async function fetchF10Finance(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_finance', { code }, 20_000)
}

export async function fetchF10Business(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_business', { code }, 20_000)
}

export async function fetchF10Shareholders(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_shareholders', { code }, 20_000)
}

export async function fetchF10Reports(code: string): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_reports', { code }, 20_000)
}

export async function fetchF10News(code: string): Promise<F10NewsItem[]> {
  return bridge.send<F10NewsItem[]>('f10_news', { code }, 20_000)
}

export async function fetchF10Industry(code: string, section: string): Promise<F10TradingTable> {
  return bridge.send<F10TradingTable>('f10_industry', { code, section }, 20_000)
}

export async function fetchF10Trading(code: string, section: string): Promise<F10TradingTable> {
  return bridge.send<F10TradingTable>('f10_trading', { code, section }, 20_000)
}

export async function fetchF10Statement(
  code: string,
  kind: string,
  full = false
): Promise<F10ProfileTable> {
  return bridge.send<F10ProfileTable>('f10_statement', { code, kind, full }, 20_000)
}

/* ---------------------------------------------------------------- 数据工具 */

interface BreadthPage {
  up: number
  down: number
  flat: number
  limitUp: number
  limitDown: number
  total: number
  nextStart: number | null
  updatedAt: number
}

/**
 * 涨跌家数按页扫：每 8 页（640 只）发一次请求，页间让 priority 的图表请求
 * 插队。整包扫描会独占串行 sidecar 5~7 秒，期间切股票/切分时都要等。
 */
export async function fetchMarketBreadth(): Promise<MarketBreadth> {
  let start = 0
  let up = 0
  let down = 0
  let flat = 0
  let limitUp = 0
  let limitDown = 0

  for (let request = 0; request < 200; request += 1) {
    const page = await bridge.send<BreadthPage>('market_breadth_page', { start, pages: 8 }, 60_000)
    up += page.up
    down += page.down
    flat += page.flat
    limitUp += page.limitUp
    limitDown += page.limitDown
    if (page.nextStart == null) {
      return {
        up,
        down,
        flat,
        limitUp,
        limitDown,
        total: up + down + flat,
        updatedAt: page.updatedAt
      }
    }
    start = page.nextStart
  }
  throw new TdxError('涨跌家数分页异常')
}

const DATA_TIMEOUT_MS = 180_000

/** 0x06b9 下载 zhb.zip 并解析 tdxstat 摘要。 */
export async function fetchTdxStatsSummary(): Promise<TdxStatsSummary> {
  return bridge.send<TdxStatsSummary>('tdx_stats', {}, DATA_TIMEOUT_MS)
}

/** 0x06b9 下载并写原始 ZIP + JSONL.gz + SQLite + manifest。 */
export async function fetchTdxStatsExport(): Promise<TdxStatsExport> {
  return bridge.send<TdxStatsExport>('tdx_stats_export', {}, DATA_TIMEOUT_MS)
}

/** stats.db 只读查询；SQL 只允许 SELECT/WITH。 */
export async function fetchStatsQuery(sql: string, limit = 200): Promise<StatsQueryResult> {
  return bridge.send<StatsQueryResult>('stats_query', { sql, limit }, 30_000)
}

export async function fetchStatsCsv(): Promise<StatsCsvExport> {
  return bridge.send<StatsCsvExport>('stats_csv', {}, 30_000)
}

export async function fetchStatsParquet(): Promise<StatsParquetExport> {
  return bridge.send<StatsParquetExport>('stats_parquet', {}, 120_000)
}

export async function fetchDuckQuery(sql: string, limit = 200): Promise<StatsQueryResult> {
  return bridge.send<StatsQueryResult>('stats_duck_query', { sql, limit }, 30_000)
}

const BLOCK_TIMEOUT_MS = 90_000

/** 0x06b9 下载 block_*.dat 并解析板块成分。 */
export async function fetchBlocks(kind: BlockKind): Promise<BlockList> {
  return bridge.send<BlockList>('blocks', { kind }, BLOCK_TIMEOUT_MS)
}

/** tdxhy.cfg + incon.dat 通达信行业分类。 */
export async function fetchIndustries(): Promise<IndustryList> {
  return bridge.send<IndustryList>('industries', {}, BLOCK_TIMEOUT_MS)
}

/** 全市场条件选股；后端按 60 秒缓存全市场分类行情。 */
export async function fetchScreen(request: ScreenRequest): Promise<ScreenResult> {
  return bridge.send<ScreenResult>('screen', { filters: request }, BLOCK_TIMEOUT_MS)
}

export async function fetchFormulaScreen(
  request: FormulaScreenRequest
): Promise<FormulaScreenResult> {
  return bridge.send<FormulaScreenResult>(
    'formula_screen',
    {
      expression: request.expression,
      scope: request.scope,
      limit: request.limit,
      offset: request.offset,
      batchSize: request.batchSize
    },
    180_000
  )
}

export async function fetchLakeArchives(limit = 20): Promise<SnapshotArchiveItem[]> {
  return bridge.send<SnapshotArchiveItem[]>('lake_archives', { limit }, 20_000)
}

export async function archiveSnapshot(): Promise<SnapshotArchiveResult> {
  return bridge.send<SnapshotArchiveResult>('archive_snapshot', {}, 120_000)
}

export async function dataInventory(): Promise<DataInventory> {
  return bridge.send<DataInventory>('data_inventory', {}, 120_000)
}

/** 离线归档 manifest + SHA256 全量校验，可能跑几分钟 */
export async function dataIntegrity(): Promise<DataIntegrityResult> {
  return bridge.send<DataIntegrityResult>('data_integrity', {}, 10 * 60_000)
}

/** 各数据集文件数/大小/日期覆盖，只读扫描 */
export async function dataCoverage(): Promise<DataCoverageResult> {
  return bridge.send<DataCoverageResult>('data_coverage', {}, 2 * 60_000)
}

/**
 * 备份整个离线数据目录。
 *
 * 超时给到 2 小时：用户的数据湖可能有几 GB，走的是真实磁盘写入 + NAS 路径，
 * 主进程不能按普通报表请求的 20 秒去掐断。
 */
export async function backupOfflineData(path: string): Promise<DataBackupCreateResult> {
  return bridge.send<DataBackupCreateResult>('backup_create', { path }, 2 * 60 * 60_000)
}

/** 订阅备份/恢复的真实进度；主进程把它转发成 IPC 事件。 */
export function onBackupProgress(listener: (progress: DataBackupProgress) => void): () => void {
  return bridge.onProgress(listener)
}

export async function inspectOfflineBackup(path: string): Promise<DataBackupInspectResult> {
  return bridge.send<DataBackupInspectResult>('backup_inspect', { path }, 120_000)
}

export async function restoreOfflineData(path: string): Promise<DataBackupRestoreResult> {
  return bridge.send<DataBackupRestoreResult>('backup_restore', { path }, 2 * 60 * 60_000)
}

/** 板块 / 财务 / 龙虎榜全量落盘；财务按传入代码逐只抓，耗时可能很长。 */
export async function archiveDatasets(codes: string[]): Promise<DatasetArchiveResult> {
  return bridge.send<DatasetArchiveResult>('archive_datasets', { codes }, 2 * 60 * 60_000)
}

export async function fetchChartPatterns(req: ChartPatternsRequest): Promise<ChartPatternsResult> {
  return bridge.send<ChartPatternsResult>('chart_patterns', { ...req }, 120_000)
}

export async function limitReview(date: string): Promise<LimitReviewResult> {
  return bridge.send<LimitReviewResult>('limit_review', { date }, 120_000)
}

export async function speedTestServers(): Promise<ServerSpeedResult> {
  return bridge.send<ServerSpeedResult>('server_speed_test', {}, 30_000)
}

export async function selectServer(host: string): Promise<{ preferred: string }> {
  return bridge.send<{ preferred: string }>('select_server', { host }, 20_000)
}

export async function cacheKlines(req: {
  codes: string[]
  period?: string
  count?: number
  adjust?: string
  skipExisting?: boolean
}): Promise<KLineCacheResult> {
  return bridge.send<KLineCacheResult>('cache_klines', req, 60_000)
}

export async function offlineSyncCatalog(): Promise<OfflineSyncCatalog> {
  // 优先级：数据面板打开时 data_inventory 可能在扫几十 GB 目录，串行队列会把
  // 这个纯本地读取压到最后；priority 插队，保证进度徽标立刻有状态。
  return bridge.send<OfflineSyncCatalog>('offline_sync_catalog', {}, 120_000, true)
}

export async function offlineSyncStatus(): Promise<OfflineSyncStatus> {
  return bridge.send<OfflineSyncStatus>('offline_sync_status', {}, 120_000, true)
}

export async function offlineSyncStart(options: OfflineSyncOptions): Promise<OfflineSyncStatus> {
  // 规划阶段要探测服务器 + 拉代码表；给 2 分钟，任务本体在后台继续跑。
  return bridge.send<OfflineSyncStatus>(
    'offline_sync_start',
    { ...options } as unknown as Record<string, unknown>,
    120_000,
    true
  )
}

export async function offlineSyncCancel(): Promise<OfflineSyncStatus> {
  return bridge.send<OfflineSyncStatus>('offline_sync_cancel', {}, 120_000, true)
}

export async function topBoard(category = 0, size = 20): Promise<TopBoardResult> {
  return bridge.send<TopBoardResult>('top_board', { category, size }, 30_000)
}

export async function unusual(count = 600): Promise<UnusualEvent[]> {
  return bridge.send<UnusualEvent[]>('unusual', { count }, 30_000)
}

export async function volumeProfile(code: string): Promise<VolumeProfileResult> {
  return bridge.send<VolumeProfileResult>('volume_profile', { code }, 30_000)
}

export async function exportKlines(req: {
  codes: string[]
  period?: string
  count?: number
  adjust?: string
}): Promise<KLineExportResult> {
  return bridge.send<KLineExportResult>('export_klines', req, 60_000)
}

export async function writeLocalDay(
  path: string,
  bars: LocalDayBar[]
): Promise<LocalDayWriteResult> {
  return bridge.send<LocalDayWriteResult>('local_day_write', { path, bars }, 20_000)
}

export async function writeLocalMin(
  path: string,
  bars: LocalDayBar[]
): Promise<LocalDayWriteResult> {
  return bridge.send<LocalDayWriteResult>('local_min_write', { path, bars }, 20_000)
}

export async function fetchLocalQuery(sql: string, limit = 200): Promise<StatsQueryResult> {
  return bridge.send<StatsQueryResult>('local_query', { sql, limit }, 20_000)
}

export async function fetchLocalImport(path: string): Promise<LocalImportResult> {
  return bridge.send<LocalImportResult>('local_import', { path }, 60_000)
}

export async function fetchLocalDay(path: string, limit = 0): Promise<LocalDayResult> {
  return bridge.send<LocalDayResult>('local_day_read', { path, limit }, 20_000)
}

export async function fetchFormulaBacktest(
  request: FormulaScreenRequest
): Promise<FormulaMarketBacktestResult> {
  return bridge.send<FormulaMarketBacktestResult>(
    'formula_backtest',
    {
      expression: request.expression,
      scope: request.scope,
      offset: request.offset,
      batchSize: request.batchSize
    },
    180_000
  )
}

/* ------------------------------------------------------------------ K 线 */

export async function fetchKline(
  code: string,
  period: KLinePeriod,
  count = 200,
  adjust: KLineAdjust = 'qfq',
  signal?: AbortSignal,
  cacheOnly = false,
  fresh = false,
  anchorDate?: string
): Promise<KLineSeries> {
  assertSupported(code)
  if (signal?.aborted) throw new TdxError('请求已取消')

  const safeCount = Math.min(800, Math.max(1, Math.trunc(count)))
  const request = {
    code,
    period,
    count: safeCount,
    adjust,
    ...(anchorDate ? { anchorDate } : {})
  }
  if (cacheOnly) {
    // 首屏本地缓存：插到队首，别排在行情/迷你图后面。
    return bridge.send<KLineSeries>(
      'kline',
      { ...request, cacheOnly: true },
      QUOTES_TIMEOUT_MS,
      true
    )
  }
  /*
   * fresh 是给「主进程推送」用的：面板订阅必须拿到本次请求的真实行情，
   * 不能把 60 秒 TTL 的旧 K 线当成实时推送。用户手动点刷新仍走缓存合并。
   */
  if (fresh) {
    return bridge.send<KLineSeries>('kline', request)
  }
  const key = `${code}:${period}:${safeCount}:${adjust}:${anchorDate ?? ''}`

  return klineCache.resolve(key, () => bridge.send<KLineSeries>('kline', request))
}

/**
 * 每秒推送给图表的 K 线：
 *  - 首帧由 fetchPushTask 调 fetchKline 拿全量；
 *  - 这里只取最近 20 根，并在主进程合并进 800 根缓存；
 *  - 每 60 秒补一次全量，避免 20 根窗口被长时间运行甩开。
 *
 * 增量策略与 Web 共用 `fetchLiveKline`，这里只注入 IPC 拉取与主进程缓存。
 */
export async function fetchKlineLive(
  code: string,
  period: KLinePeriod,
  count = 800,
  adjust: KLineAdjust = 'qfq',
  first = false
): Promise<KLineSeries> {
  assertSupported(code)
  return fetchLiveKline(
    { code, period, count, adjust },
    first,
    (wanted, tail) =>
      bridge.send<KLineSeries>(
        'kline',
        { code, period, count: wanted, adjust },
        tail ? QUOTES_TIMEOUT_MS : undefined
      ),
    liveKlineCache
  )
}

/* ------------------------------------------------------------------ 分时 */

export async function fetchMinuteTrend(
  code: string,
  signal?: AbortSignal,
  fresh = false
): Promise<MinuteTrend> {
  assertSupported(code)
  if (signal?.aborted) throw new TdxError('请求已取消')

  /*
   * 分时是默认 tab，首屏必须插到行情 refresh 前面：
   * sidecar 冷启动后 refresh 可能要 1.75s，分时排它后面就是「打开软件
   * 十几秒才出图」的直接原因（K 线 cacheOnly 早就 priority=true）。
   */
  if (fresh) return bridge.send<MinuteTrend>('minute', { code }, undefined, true)
  return minuteCache.resolve(code, () =>
    bridge.send<MinuteTrend>('minute', { code }, undefined, true)
  )
}

export async function fetchFiveDayTrend(
  code: string,
  signal?: AbortSignal,
  fresh = false
): Promise<MultiDayTrend> {
  assertSupported(code)
  if (signal?.aborted) throw new TdxError('请求已取消')

  if (fresh) return bridge.send<MultiDayTrend>('five_day', { code }, undefined, true)
  return fiveDayCache.resolve(code, () =>
    bridge.send<MultiDayTrend>('five_day', { code }, undefined, true)
  )
}

/* ------------------------------------------------------------------ 搜索 */

export async function fetchSecurityCatalog(): Promise<SearchSecurity[]> {
  const index = await ensureCodeIndex()
  return index.entries.map((entry) => ({ ...entry.info }))
}

export async function fetchSearchHint(keyword: string): Promise<SearchItem[]> {
  const trimmed = keyword.trim()
  if (!trimmed) return []

  let index: CodeIndex
  try {
    index = await ensureCodeIndex()
  } catch {
    throw new TdxError('证券代码表加载失败，请稍后重试')
  }

  return searchEntries(index.entries, trimmed)
}

/* ------------------------------------------------------------------ 其它 */

function assertSupported(code: string): void {
  const { market } = splitCode(code)
  if (market !== 'SH' && market !== 'SZ' && market !== 'BJ') {
    throw new TdxError('当前数据源暂不支持港股/美股')
  }
}

/** 供「强制刷新」使用：清掉所有行情衍生缓存 */
export function invalidateTrendCache(): void {
  minuteCache.clear()
  fiveDayCache.clear()
  klineCache.clear()
  liveKlineCache.clear()
}

/** 应用退出时释放 Python 子进程 */
export function closeTdx(): void {
  bridge.close()
}

/**
 * 提前拉起 Python sidecar。
 *
 * 窗口/渲染层加载和 Python 进程启动可以并行；如果在第一次数据请求时才启动，
 * 首屏缓存读取要额外等一次进程拉起（打包版是 Nuitka 单文件，冷启动更明显）。
 */
export function warmTdxBridge(): void {
  void bridge.send('ping', {}, 5_000).catch(() => undefined)
}
