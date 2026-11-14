/**
 * 数据面契约：Web 与 Electron 完全共用。
 *
 * 桌面窗口和浏览器都通过本地 HTTP/WebSocket 调用同一批 Python 方法，
 * 因此这份接口只有一种实现（`src/renderer/src/lib/http-api.ts`），
 * 不再有「preload 一套、Web 一套」的双份适配器。
 *
 * 窗口、本机状态文件、文件对话框等壳能力见 `desktop.ts`。
 */
import type { ChartPatternsRequest, ChartPatternsResult } from './patterns'
import type {
  AuctionArchiveBatchResult,
  AuctionArchiveItem,
  AuctionArchiveResult,
  AuctionPoint,
  BlockKind,
  BlockList,
  CategoryQuote,
  DataBackupCreateResult,
  DataBackupInspectResult,
  DataBackupProgress,
  DataBackupRestoreResult,
  DatasetArchiveResult,
  DataCoverageResult,
  DataIntegrityResult,
  DataInventory,
  F10Announcement,
  F10NewsItem,
  F10ProfileTable,
  F10Section,
  F10TradingTable,
  FormulaMarketBacktestResult,
  FormulaScreenRequest,
  FormulaScreenResult,
  IndustryList,
  KLineAdjust,
  KLineCacheResult,
  KLineExportResult,
  KLinePeriod,
  KLineSeries,
  LimitReviewResult,
  LocalDayBar,
  LocalDayResult,
  LocalImportResult,
  LocalDayWriteResult,
  MacBoard,
  MacMoneyFlow,
  MacMoneyFlowPoint,
  MacUnusualItem,
  MarketBreadth,
  MarketCalendarStatus,
  MinuteTrend,
  MoneyFlowRecord,
  MultiDayTrend,
  OfflineSyncCatalog,
  OfflineSyncOptions,
  OfflineSyncStatus,
  PushTask,
  PushUpdate,
  Quote,
  QuoteUpdate,
  ScreenRequest,
  ScreenResult,
  SearchItem,
  ServerSpeedResult,
  SnapshotArchiveItem,
  SnapshotArchiveResult,
  StatsCsvExport,
  StatsParquetExport,
  StatsQueryResult,
  TdxStatsExport,
  TdxStatsSummary,
  TickArchiveBatchResult,
  TickArchiveItem,
  TickArchiveResult,
  TopBoardResult,
  TradeTick,
  UnusualEvent,
  VolumeProfileResult
} from './types'
import type { SearchSecurity } from './search'

export interface KLineRequest {
  code: string
  period: KLinePeriod
  /** 取多少根 K 线 */
  count?: number
  /** 复权口径；默认前复权 */
  adjust?: KLineAdjust
  /** 定点复权锚点日期 YYYY-MM-DD；仅 fixed_qfq/fixed_hfq 使用 */
  anchorDate?: string
  /** 只读本地缓存；启动首屏用，不访问行情服务器 */
  cacheOnly?: boolean
}

/** 0x054b 分类行情请求；category=6 是沪深 A 股 */
export interface CategoryRequest {
  category?: number
  sortType?: number
  start?: number
  count?: number
  ascending?: boolean
  filterRaw?: number
}

/** 0x0fc5 / 0x0fc6 成交明细请求；date 省略时走当日 */
export interface TradesRequest {
  code: string
  start?: number
  count?: number
  /** YYYY-MM-DD 或 YYYYMMDD */
  date?: string
}

/**
 * 行情与数据 API。两端共用同一份实现，组件不感知部署方式。
 */
export interface PythonTdxApi {
  quote: {
    /** 一次性拉取给定代码的行情快照 */
    snapshot(codes: string[]): Promise<Quote[]>
    /** 订阅推送；重复调用会覆盖上一次的订阅集合 */
    subscribe(codes: string[], intervalMs: number): Promise<void>
    unsubscribe(): Promise<void>
    /** 监听推送，返回取消监听的函数 */
    onUpdate(listener: (update: QuoteUpdate) => void): () => void
    /** 服务端排序的一页分类行情（排行榜） */
    category(req: CategoryRequest): Promise<CategoryQuote[]>
    catalog(): Promise<SearchSecurity[]>
    macQuotes(codes: string[]): Promise<Quote[]>
    /** MAC 报价 + 财务；市值排序用，财务失败时字段缺失 */
    macQuotesFinance(codes: string[]): Promise<Quote[]>
  }
  push: {
    /** 订阅一个面板级推送任务，返回订阅 id */
    subscribe(task: PushTask, intervalMs: number): Promise<number>
    /** 取消订阅 */
    unsubscribe(id: number): Promise<void>
    /** 监听推送，返回取消监听的函数 */
    onUpdate(listener: (update: PushUpdate) => void): () => void
  }
  trade: {
    /** 成交明细：不传 date 走当日 0x0fc5，传 date 走历史 0x0fc6 */
    ticks(req: TradesRequest): Promise<TradeTick[]>
  }
  money: {
    /** 最近 5 日资金流（0x0ffc） */
    flow(code: string): Promise<MoneyFlowRecord[]>
    macFlow(code: string): Promise<MacMoneyFlow>
    /** 批量 0x1218；全市场资金流排行，单只失败会跳过 */
    macFlowBatch(codes: string[], workers?: number): Promise<MacMoneyFlowPoint[]>
  }
  mac: {
    /** 沪深异动（0x1237） */
    unusual(count?: number): Promise<MacUnusualItem[]>
    /** 板块列表（0x1231） */
    boards(boardType?: number): Promise<MacBoard[]>
  }
  auction: {
    /** 集合竞价过程快照（0x056a）；date 省略为当日，selector=1 含尾盘竞价 */
    series(code: string, date?: string, selector?: number): Promise<AuctionPoint[]>
    /** 写入本地归档；date 省略时从分时推断交易日 */
    archiveSave(code: string, date?: string): Promise<AuctionArchiveResult>
    /** 读取本地归档；不存在返回 found=false */
    archiveRead(code: string, date: string): Promise<AuctionArchiveResult>
    /** 列出已归档的竞价文件 */
    archiveList(limit?: number): Promise<AuctionArchiveItem[]>
    /** 批量归档（收盘自动归档自选）；单只失败记录在 failed */
    archiveBatch(codes: string[], date?: string): Promise<AuctionArchiveBatchResult>
  }
  market: {
    breadth(): Promise<MarketBreadth>
    /** 通达信交易日历：今天是否交易日/最近交易日/覆盖范围 */
    status(force?: boolean): Promise<MarketCalendarStatus>
  }
  f10: {
    /** 公司资料目录（0x02cf） */
    catalog(code: string): Promise<F10Section[]>
    /** 公司资料正文（0x02d0） */
    content(code: string, section: F10Section): Promise<string>
    /** 7615 TQLEX 在线公告列表 */
    announcements(code: string): Promise<F10Announcement[]>
    profile(code: string): Promise<F10ProfileTable>
    valuation(code: string): Promise<F10ProfileTable>
    finance(code: string): Promise<F10ProfileTable>
    business(code: string): Promise<F10ProfileTable>
    shareholders(code: string): Promise<F10ProfileTable>
    reports(code: string): Promise<F10ProfileTable>
    news(code: string): Promise<F10NewsItem[]>
    industry(code: string, section: string): Promise<F10TradingTable>
    trading(code: string, section: string): Promise<F10TradingTable>
    lhbMarket(): Promise<F10TradingTable>
    market(section: string): Promise<F10TradingTable>
    dividend(code: string): Promise<F10ProfileTable>
    shareholderCount(code: string): Promise<F10ProfileTable>
    capital(code: string, section: string): Promise<F10TradingTable>
    circulatingShareholders(code: string): Promise<F10ProfileTable>
    shareholderChanges(code: string): Promise<F10ProfileTable>
    institutions(code: string): Promise<F10ProfileTable>
    controller(code: string): Promise<F10ProfileTable>
    changePlans(code: string): Promise<F10ProfileTable>
    statement(code: string, kind: string, full?: boolean): Promise<F10ProfileTable>
  }
  data: {
    /** 下载 zhb.zip 并返回 tdxstat 摘要 */
    statsSummary(): Promise<TdxStatsSummary>
    /** 下载并写原始 ZIP + JSONL.gz + SQLite + manifest */
    statsExport(): Promise<TdxStatsExport>
    /** 在 stats.db 上执行只读 SELECT/WITH */
    statsQuery(sql: string, limit?: number): Promise<StatsQueryResult>
    /** 把 tdxstat/tdxstat2 全量导出为 CSV */
    statsCsv(): Promise<StatsCsvExport>
    statsParquet(): Promise<StatsParquetExport>
    duckQuery(sql: string, limit?: number): Promise<StatsQueryResult>
    localDay(path: string, limit?: number): Promise<LocalDayResult>
    localImport(path: string): Promise<LocalImportResult>
    localQuery(sql: string, limit?: number): Promise<StatsQueryResult>
    localDayWrite(path: string, bars: LocalDayBar[]): Promise<LocalDayWriteResult>
    localMinWrite(path: string, bars: LocalDayBar[]): Promise<LocalDayWriteResult>
    exportKlines(req: {
      codes: string[]
      period?: string
      count?: number
      adjust?: string
    }): Promise<KLineExportResult>
    integrity(): Promise<DataIntegrityResult>
    coverage(): Promise<DataCoverageResult>
    inventory(): Promise<DataInventory>
    cacheKlines(req: {
      codes: string[]
      period?: string
      count?: number
      adjust?: string
      skipExisting?: boolean
    }): Promise<KLineCacheResult>
    /** 离线全量同步：数据集/预设/可下载窗口 */
    offlineSyncCatalog(): Promise<OfflineSyncCatalog>
    /** 离线全量同步：当前任务状态（含进度、失败、窗口） */
    offlineSyncStatus(): Promise<OfflineSyncStatus>
    /** 离线全量同步：启动多进程+多线程任务；窗口内返回 blocked */
    offlineSyncStart(options: OfflineSyncOptions): Promise<OfflineSyncStatus>
    /** 离线全量同步：取消任务（worker 子进程一并回收） */
    offlineSyncCancel(): Promise<OfflineSyncStatus>
    /** 0x053f 排行榜：一次请求拿 9 个榜单 */
    topBoard(category?: number, size?: number): Promise<TopBoardResult>
    /** 0x0563 主力监控（异动事件） */
    unusual(count?: number): Promise<UnusualEvent[]>
    /** 0x051a 成交分布（筹码分布） */
    volumeProfile(code: string): Promise<VolumeProfileResult>
    limitReview(date: string): Promise<LimitReviewResult>
    patterns(req: ChartPatternsRequest): Promise<ChartPatternsResult>
    /** 离线数据备份成单个 zip；路径由壳的文件对话框选，已存在则不覆盖 */
    backupCreate(path: string): Promise<DataBackupCreateResult>
    /** 读备份清单（文件数 / 原始字节数 / 打包时间） */
    backupInspect(path: string): Promise<DataBackupInspectResult>
    /** 从备份恢复；只补缺失文件，已存在的跳过 */
    backupRestore(path: string): Promise<DataBackupRestoreResult>
    /** 订阅备份/恢复的真实字节进度；返回取消订阅函数 */
    onBackupProgress(listener: (progress: DataBackupProgress) => void): () => void
    /** 板块/财务/龙虎榜全量落盘到数据湖（同一天不覆盖已有文件） */
    archiveDatasets(codes: string[]): Promise<DatasetArchiveResult>
    archiveSnapshot(): Promise<SnapshotArchiveResult>
    lakeArchives(limit?: number): Promise<SnapshotArchiveItem[]>
    tickArchiveSave(code: string, date: string): Promise<TickArchiveResult>
    tickArchiveDates(code: string, start?: string, end?: string, days?: number): Promise<string[]>
    tickArchiveBatch(codes: string[], date: string): Promise<TickArchiveBatchResult>
    tickArchiveList(limit?: number): Promise<TickArchiveItem[]>
  }
  block: {
    /** 0x06b9 下载并解析 block_*.dat */
    list(kind: BlockKind): Promise<BlockList>
    /** tdxhy.cfg + incon.dat 行业分类 */
    industries(): Promise<IndustryList>
  }
  screen: {
    /** 全市场扫描；结果最多 200 条 */
    run(request: ScreenRequest): Promise<ScreenResult>
    formula(request: FormulaScreenRequest): Promise<FormulaScreenResult>
    formulaBacktest(request: FormulaScreenRequest): Promise<FormulaMarketBacktestResult>
  }
  trend: {
    minute(code: string): Promise<MinuteTrend>
    /** 五日分时 */
    fiveDay(code: string): Promise<MultiDayTrend>
    kline(req: KLineRequest): Promise<KLineSeries>
  }
  search: {
    hint(keyword: string): Promise<SearchItem[]>
  }
  server: {
    /** 测试通达信公开行情主站 TCP 时延 */
    speedTest(): Promise<ServerSpeedResult>
    /** 选择首选行情主站并持久化 */
    select(host: string): Promise<{ preferred: string }>
  }
}
