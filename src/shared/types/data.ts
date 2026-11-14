/**
 * 数据面：本地文件、归档、数据工具统计、覆盖/完整性、备份、离线同步。
 *
 * 由 `shared/types.ts` 门面统一再导出；外部一律 `from '@shared/types'`。
 */
import type { AuctionPoint } from './market'
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
