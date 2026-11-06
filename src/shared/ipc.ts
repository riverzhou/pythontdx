/**
 * IPC 通道契约。
 *
 * 主进程和 preload 都 import 这里的常量，避免「字符串写错但编译通过」这类低级事故。
 * 渲染层不直接接触通道名——它只使用 preload 暴露的 window.api。
 */
import type { ChartPatternsRequest, ChartPatternsResult } from './patterns'
import type {
  AppInfo,
  GraphicsInfo,
  LinuxDesktopResult,
  ServerSpeedResult,
  AppState,
  AuctionArchiveBatchResult,
  AuctionArchiveItem,
  AuctionArchiveResult,
  AuctionPoint,
  BlockKind,
  BlockList,
  CategoryQuote,
  F10Announcement,
  F10NewsItem,
  F10TradingTable,
  FormulaScreenRequest,
  FormulaScreenResult,
  FormulaMarketBacktestResult,
  F10ProfileTable,
  F10Section,
  IndustryList,
  KLineAdjust,
  KLinePeriod,
  MacBoard,
  KLineSeries,
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
  MacMoneyFlow,
  MacMoneyFlowPoint,
  MacUnusualItem,
  MarketBreadth,
  MarketCalendarStatus,
  MinuteTrend,
  MoneyFlowRecord,
  MultiDayTrend,
  Quote,
  PushTask,
  PushUpdate,
  QuoteUpdate,
  SearchItem,
  ScreenRequest,
  ScreenResult,
  StatsCsvExport,
  StatsParquetExport,
  StatsQueryResult,
  TdxStatsExport,
  TdxStatsSummary,
  TradeTick,
  DisplayInfo,
  WindowAction,
  WindowState
} from './types'
import type { SearchSecurity } from './search'

export const IPC = {
  /** 主动拉取一次快照（invoke） */
  quoteSnapshot: 'quote:snapshot',
  /** 订阅推送，并声明关心哪些代码（invoke） */
  quoteSubscribe: 'quote:subscribe',
  /** 取消订阅（invoke） */
  quoteUnsubscribe: 'quote:unsubscribe',
  /** 主进程 → 渲染进程的行情推送（on） */
  quoteUpdate: 'quote:update',
  /** 订阅面板级推送任务，返回订阅 id（invoke） */
  pushSubscribe: 'push:subscribe',
  /** 取消面板级推送（invoke） */
  pushUnsubscribe: 'push:unsubscribe',
  /** 主进程 → 渲染进程的面板数据推送（on） */
  pushUpdate: 'push:update',
  /** 分类行情/排行榜（invoke） */
  quoteCategory: 'quote:category',
  /** 成交明细（invoke） */
  tradeTicks: 'trade:ticks',
  /** 资金流日数据（invoke） */
  moneyFlow: 'money:flow',
  /** MAC 0x1218 资金流（invoke） */
  moneyMac: 'money:mac',
  /** MAC 0x1218 批量资金流（全市场资金流排行） */
  moneyMacBatch: 'money:mac-batch',
  /** MAC 0x1237 异动（invoke） */
  macUnusual: 'mac:unusual',
  macBoards: 'mac:boards',
  /** MAC 0x1231 板块列表（invoke） */
  /** 集合竞价过程（invoke） */
  auctionSeries: 'auction:series',
  /** 本地竞价归档：写入/读取（invoke） */
  auctionArchiveSave: 'auction:archive-save',
  auctionArchiveRead: 'auction:archive-read',
  auctionArchiveList: 'auction:archive-list',
  auctionArchiveBatch: 'auction:archive-batch',
  /** 本地逐笔归档：单只/批量/清单（invoke） */
  tickArchiveSave: 'tick:archive-save',
  tickArchiveDates: 'tick:archive-dates',
  tickArchiveBatch: 'tick:archive-batch',
  tickArchiveList: 'tick:archive-list',
  /** F10 段落目录（invoke） */
  f10Catalog: 'f10:catalog',
  /** F10 段落正文（invoke） */
  f10Content: 'f10:content',
  /** 7615 在线公告（invoke） */
  f10Announcements: 'f10:announcements',
  /** 7615 在线公司概况（invoke） */
  f10Profile: 'f10:profile',
  /** 7615 在线估值（invoke） */
  f10Valuation: 'f10:valuation',
  /** 7615 财务主要指标（invoke） */
  f10Finance: 'f10:finance',
  /** 7615 主营构成（invoke） */
  f10Business: 'f10:business',
  /** 7615 十大股东（invoke） */
  f10Shareholders: 'f10:shareholders',
  /** 7615 公司研报列表（invoke） */
  f10Reports: 'f10:reports',
  /** 7615 公司新闻（invoke） */
  f10News: 'f10:news',
  /** 7615 行业分析（invoke） */
  f10Industry: 'f10:industry',
  /** 7615 两融/大宗/龙虎榜/沪深股通（invoke） */
  f10Trading: 'f10:trading',
  /** 沪深龙虎榜（invoke） */
  f10LhbMarket: 'f10:lhb-market',
  /** 大盘资料（invoke） */
  f10Market: 'f10:market',
  /** 分红融资（invoke） */
  f10Dividend: 'f10:dividend',
  /** 股东人数历史（invoke） */
  f10ShareholderCount: 'f10:shareholder-count',
  /** 股本结构/变动/回购/限售（invoke） */
  f10Capital: 'f10:capital',
  /** 十大流通股东（invoke） */
  f10CirculatingShareholders: 'f10:circulating-shareholders',
  /** 股东增减持（invoke） */
  f10ShareholderChanges: 'f10:shareholder-changes',
  /** 机构持仓（invoke） */
  f10Institutions: 'f10:institutions',
  /** 控股股东/实际控制人（invoke） */
  f10Controller: 'f10:controller',
  /** 股东增减持计划（invoke） */
  f10ChangePlans: 'f10:change-plans',
  /** 全 A 股涨跌家数（invoke） */
  marketBreadth: 'market:breadth',
  /** 通达信交易日历状态（invoke） */
  marketStatus: 'market:status',
  /** 读取本地 .day 日线（invoke） */
  localDayRead: 'local:day',
  /** 本地行情导入数据湖（invoke） */
  localImport: 'local:import',
  /** 查询 local_bars.db（invoke） */
  localQuery: 'local:query',
  /** 写本地 .day（invoke） */
  localDayWrite: 'local:write',
  /** 批量导出 K 线（invoke） */
  exportKlines: 'data:export-klines',
  /** 预热自选 K 线本地缓存（invoke） */
  cacheKlines: 'data:cache-klines',
  /** 离线全量同步：数据集/预设/窗口目录（invoke） */
  offlineSyncCatalog: 'data:offline-sync-catalog',
  /** 离线全量同步：当前任务状态（invoke） */
  offlineSyncStatus: 'data:offline-sync-status',
  /** 离线全量同步：启动多进程+多线程任务（invoke） */
  offlineSyncStart: 'data:offline-sync-start',
  /** 离线全量同步：取消任务（invoke） */
  offlineSyncCancel: 'data:offline-sync-cancel',
  /** 0x053f 九榜排行（invoke） */
  topBoard: 'data:top-board',
  /** 0x0563 主力监控（invoke） */
  unusual: 'data:unusual',
  /** 0x051a 成交分布（invoke） */
  volumeProfile: 'data:volume-profile',
  /** 离线数据目录清单（invoke） */
  dataInventory: 'data:inventory',
  /** 离线数据完整性校验（invoke） */
  dataIntegrity: 'data:integrity',
  /** 离线数据覆盖统计（invoke） */
  dataCoverage: 'data:coverage',
  /** 离线数据备份成单个 zip（invoke） */
  dataBackupCreate: 'data:backup-create',
  /** 读取备份清单（invoke） */
  dataBackupInspect: 'data:backup-inspect',
  /** 从备份恢复离线数据（invoke） */
  dataBackupRestore: 'data:backup-restore',
  /** 备份/恢复真实进度（主进程推送） */
  dataBackupProgress: 'data:backup-progress',
  /** 板块/财务/龙虎榜落盘到数据湖（invoke） */
  dataArchiveDatasets: 'data:archive-datasets',
  /** 保存对话框：选备份文件路径（invoke） */
  dataChooseBackupPath: 'data:choose-backup-path',
  /** 打开对话框：选要恢复的备份文件（invoke） */
  dataChooseRestorePath: 'data:choose-restore-path',
  /** 本地日 K 缓存涨停复盘（invoke） */
  limitReview: 'data:limit-review',
  /** Python 技术形态识别（invoke） */
  chartPatterns: 'chart:patterns',
  /** 全市场快照归档到数据湖（invoke） */
  archiveSnapshot: 'data:archive-snapshot',
  /** 数据湖归档列表（invoke） */
  lakeArchives: 'data:lake-archives',
  /** 写本地分钟文件（invoke） */
  localMinWrite: 'local:write-min',
  /** 7615 财务报表关键科目（invoke） */
  f10Statement: 'f10:statement',
  /** tdxstat 摘要（invoke） */
  dataStatsSummary: 'data:stats-summary',
  /** tdxstat 规范化导出（invoke） */
  dataStatsExport: 'data:stats-export',
  /** stats.db 只读查询（invoke） */
  dataStatsQuery: 'data:stats-query',
  /** stats.db 导出 CSV（invoke） */
  dataStatsCsv: 'data:stats-csv',
  /** stats.db 导出 Parquet（invoke） */
  dataStatsParquet: 'data:stats-parquet',
  /** stats Parquet DuckDB 只读查询（invoke） */
  dataDuckQuery: 'data:duck-query',
  /** 板块列表/成分（invoke） */
  blockList: 'block:list',
  /** 行业分类/成分（invoke） */
  blockIndustries: 'block:industries',
  /** 通达信客户端本地自定义板块（invoke） */
  /** 全市场条件选股（invoke） */
  screenRun: 'screen:run',
  /** 公式选股（invoke） */
  screenFormula: 'screen:formula',
  /** 全市场/前 N 公式组合回测（invoke） */
  screenFormulaBacktest: 'screen:formula_backtest',

  /** 当日分时（invoke） */
  trendMinute: 'trend:minute',
  /** 五日分时（invoke） */
  trendFiveDay: 'trend:five-day',
  /** K 线（invoke） */
  trendKline: 'trend:kline',

  /** 股票联想搜索（invoke） */
  searchHint: 'search:hint',
  /** 全量证券代码表（invoke） */
  quoteCatalog: 'quote:catalog',
  /** 显式 MAC 批量报价（invoke） */
  quoteMac: 'quote:mac',
  /** MAC 批量报价 + 0x0010 财务（市值排行） */
  quoteMacFinance: 'quote:mac-finance',

  /** 读取持久化状态（invoke） */
  stateGet: 'state:get',
  /** 增量写入持久化状态（invoke） */
  statePatch: 'state:patch',

  /** 窗口控制（invoke） */
  windowControl: 'window:control',
  /** 打开独立 K 线窗口（invoke） */
  windowChart: 'window:chart',
  /** 打开第二个主窗口（invoke） */
  windowSecondary: 'window:secondary',
  /** 当前窗口置顶切换（invoke，返回新状态） */
  windowAlwaysOnTop: 'window:always-on-top',
  /** 显示器列表（invoke） */
  windowDisplays: 'window:displays',
  /** 将当前窗口移到指定显示器（invoke） */
  windowMoveDisplay: 'window:move-display',
  /** 窗口状态变化（on） */
  windowState: 'window:state',

  /** 运行时版本信息（invoke） */
  appInfo: 'app:info',
  /** 用系统默认浏览器打开链接（invoke） */
  appOpenExternal: 'app:open-external',
  /** 系统通知（invoke） */
  appNotify: 'app:notify',
  /** 图形后端诊断（invoke） */
  appGraphics: 'app:graphics',
  /** Linux AppImage 桌面集成：修复文件管理器双击不启动（invoke） */
  appLinuxDesktop: 'app:linux-desktop',
  /** 行情主站测速（invoke） */
  serverSpeedTest: 'app:server-speed-test',
  /** 选择行情主站（invoke） */
  serverSelect: 'app:server-select'
} as const

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
 * preload 通过 contextBridge 暴露给渲染进程的完整 API。
 * 渲染进程的 window.api 就是这个类型（见 src/preload/index.d.ts）。
 */
export interface PythonTdxApi {
  quote: {
    /** 一次性拉取给定代码的行情快照 */
    snapshot(codes: string[]): Promise<Quote[]>
    /** 订阅推送；重复调用会覆盖上一次的订阅集合 */
    subscribe(codes: string[], intervalMs: number): Promise<void>
    unsubscribe(): Promise<void>
    /** 监听主进程推送，返回取消监听的函数 */
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
    /** 监听主进程推送，返回取消监听的函数 */
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
    /** 离线数据备份成单个 zip；路径由对话框选，已存在则不覆盖 */
    backupCreate(path: string): Promise<DataBackupCreateResult>
    /** 读备份清单（文件数 / 原始字节数 / 打包时间） */
    backupInspect(path: string): Promise<DataBackupInspectResult>
    /** 从备份恢复；只补缺失文件，已存在的跳过 */
    backupRestore(path: string): Promise<DataBackupRestoreResult>
    /** 订阅备份/恢复的真实字节进度；返回取消订阅函数 */
    onBackupProgress(listener: (progress: DataBackupProgress) => void): () => void
    /** 板块/财务/龙虎榜全量落盘到数据湖（同一天不覆盖已有文件） */
    archiveDatasets(codes: string[]): Promise<DatasetArchiveResult>
    /** 保存对话框；取消返回 null */
    chooseBackupPath(defaultName: string): Promise<string | null>
    /** 打开对话框；取消返回 null */
    chooseRestorePath(): Promise<string | null>
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
  state: {
    get(): Promise<AppState>
    patch(patch: Partial<AppState>): Promise<AppState>
  }
  window: {
    control(action: WindowAction): Promise<WindowState>
    openChart(code: string): Promise<void>
    openSecondary(): Promise<void>
    toggleAlwaysOnTop(): Promise<boolean>
    /** 显示器列表；current 表示窗口当前在哪块屏 */
    displays(): Promise<DisplayInfo[]>
    /** 将当前窗口移到指定显示器；找不到返回 false */
    moveToDisplay(displayId: number): Promise<boolean>
    onStateChange(listener: (state: WindowState) => void): () => void
  }
  app: {
    info(): Promise<AppInfo>
    /** Linux 图形后端 / GPU 帧特性诊断 */
    graphics(): Promise<GraphicsInfo>
    /** 安装 Linux 桌面入口 + 通用 AppImage 启动器（仅 AppImage 有效） */
    installLinuxDesktop(): Promise<LinuxDesktopResult>
    /** 测试通达信公开行情主站 TCP 时延 */
    serverSpeedTest(): Promise<ServerSpeedResult>
    /** 选择首选行情主站并持久化 */
    selectServer(host: string): Promise<{ preferred: string }>
    /** 交给系统浏览器打开，避免在应用内弹出新窗口 */
    openExternal(url: string): Promise<void>
    /** 系统通知；不支持/未授权时静默失败 */
    notify(title: string, body: string): Promise<void>
  }
}
