/**
 * 数据工具：下载 zhb.zip、查看 tdxstat 摘要、写规范化层。
 *
 * 只做只读数据管理，不碰交易；导出路径由 Python 后端决定并在界面上明确展示。
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type {
  StatsCsvExport,
  StatsParquetExport,
  StatsQueryResult,
  AuctionArchiveItem,
  TdxStatsExport,
  TdxStatsSummary,
  LocalDayResult,
  LocalImportResult,
  LocalDayWriteResult,
  DataBackupCreateResult,
  DataBackupInspectResult,
  DataBackupProgress,
  DataBackupRestoreResult,
  DataCoverageResult,
  DataIntegrityResult,
  DataInventory,
  OfflineSyncCatalog,
  OfflineSyncStatus,
  OfflineSyncOptions,
  KLineExportResult,
  SnapshotArchiveResult,
  SnapshotArchiveItem,
  LimitReviewResult
} from '@shared/types'

// 自动续跑只对同一个 jobId 尝试一次；面板关闭重开不能反复拉起计划。
const autoResumeAttempted = new Set<string>()
import { fixed, signedPct, thousands } from '@shared/format'
import { appState, updateSettings, watchCodes } from '../../stores/app'
import { api, errorMessage, shell } from '../../lib/client'
import { downloadText } from '../../lib/download'
import { toCsv } from '@shared/csv'
import { IconClose } from '../atoms/Icons'

interface DataPanelProps {
  onClose: () => void
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 秒'
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * 通用耗时操作进度：能拿到百分比就画确定进度，拿不到就画不确定动画。
 * 所有下载/扫描/归档/导入都用它，避免只有按钮文字「处理中…」。
 */
function OpProgress(props: {
  active: boolean
  label: string
  detail?: string
  percent?: number
}): JSX.Element {
  const [elapsed, setElapsed] = createSignal(0)
  createEffect(() => {
    if (!props.active) {
      setElapsed(0)
      return
    }
    const startedAt = performance.now()
    const timer = setInterval(() => setElapsed((performance.now() - startedAt) / 1000), 200)
    onCleanup(() => clearInterval(timer))
  })
  const done = (): number =>
    props.percent === undefined ? 0 : Math.max(0, Math.min(100, props.percent))
  return (
    <Show when={props.active}>
      <div class="data__op-progress">
        <div
          class="data__op-bar"
          classList={{ 'data__op-bar--indeterminate': props.percent === undefined }}
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(done())}
        >
          <span style={{ width: props.percent === undefined ? '30%' : `${done()}%` }} />
        </div>
        <div class="data__op-meta" title={props.detail ?? ''}>
          <span>{props.label}</span>
          <span class="num">{elapsed().toFixed(1)} s</span>
          <Show when={props.detail}>
            <span class="data__op-detail">{props.detail}</span>
          </Show>
        </div>
      </div>
    </Show>
  )
}

/** 备份/恢复共用的真实字节进度条；扫描阶段没有 total，用不确定态表示仍在工作。 */
function BackupProgressBar(props: {
  operation: 'backup' | 'restore'
  progress: DataBackupProgress | null
  busy: boolean
}): JSX.Element {
  const percent = (): number => {
    const progress = props.progress
    if (!progress) return 0
    if (progress.phase === 'done') return 100
    if (progress.totalBytes <= 0) return 0
    return Math.max(0, Math.min(100, (progress.doneBytes / progress.totalBytes) * 100))
  }

  const indeterminate = (): boolean => {
    if (!props.busy) return false
    const progress = props.progress
    return (
      !progress ||
      progress.phase === 'scan' ||
      (progress.phase !== 'done' && (progress.totalBytes <= 0 || progress.doneBytes <= 0))
    )
  }

  const phaseLabel = (): string => {
    const progress = props.progress
    if (!progress) return '准备中'
    if (progress.phase === 'scan') return '正在扫描数据目录'
    if (progress.phase === 'hash') return '正在计算 SHA256'
    if (progress.phase === 'done') return '完成'
    return props.operation === 'backup' ? '正在写入备份' : '正在恢复数据'
  }

  const meta = (): string => {
    const progress = props.progress
    if (!progress || progress.phase === 'scan') {
      return `${props.operation === 'backup' ? '备份' : '恢复'} · ${phaseLabel()}…`
    }
    const bytes =
      progress.totalBytes > 0
        ? `${formatBytes(progress.doneBytes)} / ${formatBytes(progress.totalBytes)}`
        : formatBytes(progress.doneBytes)
    const parts = [
      `${props.operation === 'backup' ? '备份' : '恢复'} · ${phaseLabel()}`,
      bytes,
      `${progress.doneFiles} / ${progress.totalFiles} 文件`,
      `${Math.round(percent())}%`
    ]
    if (progress.current && progress.phase !== 'done') parts.push(progress.current)
    return parts.join(' · ')
  }

  return (
    <div class="data__backup-progress">
      <div
        class="data__backup-bar"
        classList={{ 'data__backup-bar--indeterminate': indeterminate() }}
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(percent())}
      >
        <span style={{ width: indeterminate() ? '30%' : `${percent().toFixed(1)}%` }} />
      </div>
      <div class="data__backup-progress-meta" title={props.progress?.current ?? ''}>
        {meta()}
      </div>
    </div>
  )
}

export function DataPanel(props: DataPanelProps): JSX.Element {
  /** 备份/恢复要读写本机文件：浏览器版没有文件对话框能力，按钮直接置灰并给出说明 */
  const desktop = shell.isDesktop
  const [summary, setSummary] = createSignal<TdxStatsSummary | null>(null)
  const [exported, setExported] = createSignal<TdxStatsExport | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [exporting, setExporting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [sql, setSql] = createSignal(
    'SELECT stats_date, code, beta60, pe_ttm FROM tdxstat ORDER BY stats_date DESC, code LIMIT 20'
  )
  const [querying, setQuerying] = createSignal(false)
  const [query, setQuery] = createSignal<StatsQueryResult | null>(null)
  const [queryError, setQueryError] = createSignal<string | null>(null)
  const [engine, setEngine] = createSignal<'sqlite' | 'duckdb' | 'local'>('sqlite')
  const [csvExporting, setCsvExporting] = createSignal(false)
  const [csvResult, setCsvResult] = createSignal<StatsCsvExport | null>(null)
  const [parquetExporting, setParquetExporting] = createSignal(false)
  const [parquetResult, setParquetResult] = createSignal<StatsParquetExport | null>(null)
  const [localPath, setLocalPath] = createSignal(appState.settings.localDayPath ?? '')
  const [klineExporting, setKlineExporting] = createSignal(false)
  const [klineExport, setKlineExport] = createSignal<KLineExportResult | null>(null)
  const [klinePeriod, setKlinePeriod] = createSignal('day')
  const [klineCount, setKlineCount] = createSignal(240)
  const [inventory, setInventory] = createSignal<DataInventory | null>(null)
  // 不自动扫几十万文件：数据面板打开时同步命令还在排队，扫描会把桥接进程
  // 拖到 20s 超时并被 Electron 杀掉。改为用户点「扫描」或同步结束后再扫。
  const [inventoryLoading, setInventoryLoading] = createSignal(false)
  const [inventoryError, setInventoryError] = createSignal<string | null>(null)
  const [coverage, setCoverage] = createSignal<DataCoverageResult | null>(null)
  const [integrity, setIntegrity] = createSignal<DataIntegrityResult | null>(null)
  const [integrityBusy, setIntegrityBusy] = createSignal(false)
  const [integrityElapsed, setIntegrityElapsed] = createSignal(0)
  const [integrityError, setIntegrityError] = createSignal<string | null>(null)
  const runIntegrity = async (): Promise<void> => {
    if (syncRunning() || inventoryLoading()) return
    setIntegrityBusy(true)
    setIntegrityError(null)
    setIntegrity(null)
    setIntegrityElapsed(0)
    const startedAt = performance.now()
    const timer = setInterval(
      () => setIntegrityElapsed((performance.now() - startedAt) / 1000),
      200
    )
    try {
      // 先出统计（文件数/大小/日期覆盖），再跑耗时的逐份校验
      const [inventoryData, coverageData] = await Promise.all([
        api.data.inventory(),
        api.data.coverage()
      ])
      setInventory(inventoryData)
      setCoverage(coverageData)
      setIntegrity(await api.data.integrity())
    } catch (cause) {
      setIntegrityError(errorMessage(cause))
    } finally {
      clearInterval(timer)
      setIntegrityBusy(false)
    }
  }

  const inventoryTotals = (): { files: number; bytes: number } | null => {
    const data = inventory()
    if (!data) return null
    const sections = [data.raw, data.cache, data.lake, data.exports, data.normalized, data.local]
    return {
      files: sections.reduce((sum, item) => sum + item.files, 0),
      bytes: sections.reduce((sum, item) => sum + item.bytes, 0)
    }
  }

  const exportIntegrityReport = (): void => {
    const report = integrity()
    if (!report) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    downloadText(
      `pythontdx-integrity-${stamp}.json`,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          root: inventory()?.root ?? '',
          inventory: inventory(),
          coverage: coverage(),
          integrity: report
        },
        null,
        2
      )
    )
  }

  /* ---------------------------------------------------- 离线数据备份/恢复 */
  const [backupPath, setBackupPath] = createSignal('')
  const [backupBusy, setBackupBusy] = createSignal(false)
  const [backupResult, setBackupResult] = createSignal<DataBackupCreateResult | null>(null)
  const [backupError, setBackupError] = createSignal<string | null>(null)
  const [backupProgress, setBackupProgress] = createSignal<DataBackupProgress | null>(null)
  const [restorePath, setRestorePath] = createSignal('')
  const [restoreBusy, setRestoreBusy] = createSignal(false)
  const [inspectBusy, setInspectBusy] = createSignal(false)
  const [backupInfo, setBackupInfo] = createSignal<DataBackupInspectResult | null>(null)
  const [restoreResult, setRestoreResult] = createSignal<DataBackupRestoreResult | null>(null)
  const [restoreError, setRestoreError] = createSignal<string | null>(null)
  const [restoreProgress, setRestoreProgress] = createSignal<DataBackupProgress | null>(null)

  /* ------------------------------------- 并行离线同步（多进程×多线程×多服务器） */
  const savedSync = appState.settings.offlineSync
  // Solid store 里的数组是 Proxy，直接塞进 IPC payload 会 "could not be cloned"。
  // 初始化时就复制成普通数组；后续 toggle 也返回新数组。
  const savedDatasets = savedSync?.datasets ? [...savedSync.datasets] : []
  const [syncCatalog, setSyncCatalog] = createSignal<OfflineSyncCatalog | null>(null)
  const [syncStatus, setSyncStatus] = createSignal<OfflineSyncStatus | null>(null)
  const [syncSelection, setSyncSelection] = createSignal<string[]>(savedDatasets)
  const [syncScope, setSyncScope] = createSignal<'watchlist' | 'all'>(
    savedSync?.scope ?? 'watchlist'
  )
  const [syncSource, setSyncSource] = createSignal<'auto' | 'mac' | '7709'>(
    savedSync?.source ?? 'auto'
  )
  const [syncProcesses, setSyncProcesses] = createSignal(
    Math.min(48, Math.max(1, savedSync?.processes ?? 8))
  )
  const [syncThreads, setSyncThreads] = createSignal(
    Math.min(4, Math.max(1, savedSync?.threads ?? 4))
  )
  const [syncSkipExisting, setSyncSkipExisting] = createSignal(savedSync?.skipExisting ?? true)
  const [syncAutoResume, setSyncAutoResume] = createSignal(savedSync?.autoResume ?? true)
  const [syncBusy, setSyncBusy] = createSignal(false)
  const [syncError, setSyncError] = createSignal<string | null>(null)
  let syncTimer: number | undefined
  // 有保存记录（哪怕是用户主动清空）就不再套 daily 预设。
  let syncSelectionTouched = savedSync?.datasets !== undefined

  createEffect(() => {
    updateSettings({
      offlineSync: {
        datasets: [...syncSelection()],
        scope: syncScope(),
        source: syncSource(),
        processes: syncProcesses(),
        threads: syncThreads(),
        skipExisting: syncSkipExisting(),
        autoResume: syncAutoResume()
      }
    })
  })

  const syncRunning = (): boolean =>
    ['probing', 'planning', 'running'].includes(syncStatus()?.state ?? '')

  const syncPercent = (): number => {
    const status = syncStatus()
    const totals = status?.totals
    if (!totals || totals.total <= 0) return 0
    // 完成态必须画满：失败任务也已处理完，不能卡在 97.x%。
    if (status?.state === 'completed') return 100
    const processed = totals.done + totals.skipped + totals.failed
    return Math.max(0, Math.min(100, (processed / Math.max(1, totals.total)) * 100))
  }

  const syncWindowLabel = (): string => {
    const window = syncStatus()?.window ?? syncCatalog()?.window
    if (!window) return '窗口状态未知'
    if (window.open) return `可下载 · 下一个保护点 ${window.pauseAt?.slice(11, 16) ?? '—'}`
    return `保护中 · ${window.nextOpenAt?.slice(11, 16) ?? '15:45'} 后可下载`
  }

  const refreshSync = async (): Promise<void> => {
    try {
      const [catalog, status] = await Promise.all([
        api.data.offlineSyncCatalog(),
        api.data.offlineSyncStatus()
      ])
      setSyncCatalog(catalog)
      setSyncStatus(status)
      const last = status.lastSummary
      if (
        syncAutoResume() &&
        last &&
        !autoResumeAttempted.has(last.jobId) &&
        status.state === 'idle' &&
        last.state === 'incomplete' &&
        (last.options?.datasets?.length ?? 0) > 0
      ) {
        autoResumeAttempted.add(last.jobId)
        void resumeLastSync(last)
      }
      if (syncSelectionTouched) {
        const valid = new Set(catalog.datasets.map((item) => item.key))
        setSyncSelection((current) => {
          const kept = current.filter((key) => valid.has(key))
          return kept.length === current.length ? current : kept
        })
      }
      // 只在用户尚未手动改过选择时套用 daily 预设；否则清空选择会被轮询悄悄覆盖。
      if (!syncSelectionTouched && syncSelection().length === 0 && catalog.datasets.length > 0) {
        const preset = catalog.presets.daily
        setSyncSelection(preset?.datasets ?? catalog.datasets.slice(0, 3).map((item) => item.key))
      }
    } catch (cause) {
      setSyncError(errorMessage(cause))
    }
  }

  const toggleSyncDataset = (key: string): void => {
    syncSelectionTouched = true
    setSyncSelection((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    )
  }

  const applySyncPreset = (key: string): void => {
    const preset = syncCatalog()?.presets[key]
    if (!preset) return
    syncSelectionTouched = true
    setSyncSelection([...preset.datasets])
    if (preset.scope === 'all' || preset.scope === 'watchlist') {
      setSyncScope(preset.scope)
    }
  }

  const startSync = async (): Promise<void> => {
    if (syncBusy() || syncRunning() || integrityBusy() || inventoryLoading()) return
    if (syncSelection().length === 0) {
      setSyncError('至少选择一个数据集')
      return
    }
    if (syncScope() === 'watchlist' && watchCodes().length === 0) {
      setSyncError('自选股为空：请先添加自选，或改为全 A 股')
      return
    }
    setSyncBusy(true)
    setSyncError(null)
    try {
      const status = await api.data.offlineSyncStart({
        datasets: [...syncSelection()],
        scope: syncScope(),
        codes: [...watchCodes()],
        source: syncSource(),
        processes: syncProcesses(),
        threads: syncThreads(),
        skipExisting: syncSkipExisting(),
        f10Sections: 'core'
      })
      setSyncStatus(status)
      if (status.state === 'blocked') {
        setSyncError(status.reason ?? '当前处于交易时段保护窗口，15:45 后再试')
      }
    } catch (cause) {
      setSyncError(errorMessage(cause))
    } finally {
      setSyncBusy(false)
    }
  }

  const resumeLastSync = async (summary = syncStatus()?.lastSummary): Promise<void> => {
    const last = summary
    if (!last?.options?.datasets?.length || syncRunning() || syncBusy()) return
    setSyncBusy(true)
    setSyncError(null)
    try {
      const options = {
        ...last.options,
        jobId: undefined,
        // 中断任务续跑：已有有效归档跳过，只补失败/未完成的。
        skipExisting: true
      } as OfflineSyncOptions
      if (options.scope === 'watchlist' && !options.codes?.length) {
        options.codes = [...watchCodes()]
      }
      const status = await api.data.offlineSyncStart(options)
      setSyncStatus(status)
    } catch (cause) {
      setSyncError(errorMessage(cause))
    } finally {
      setSyncBusy(false)
    }
  }

  const cancelSync = async (): Promise<void> => {
    if (syncBusy()) return
    setSyncBusy(true)
    try {
      setSyncStatus(await api.data.offlineSyncCancel())
    } catch (cause) {
      setSyncError(errorMessage(cause))
    } finally {
      setSyncBusy(false)
    }
  }

  const [klineExportError, setKlineExportError] = createSignal<string | null>(null)
  const [snapshotExporting, setSnapshotExporting] = createSignal(false)
  const [snapshotResult, setSnapshotResult] = createSignal<number | null>(null)
  const [snapshotError, setSnapshotError] = createSignal<string | null>(null)
  const [archiving, setArchiving] = createSignal(false)
  const [archive, setArchive] = createSignal<SnapshotArchiveResult | null>(null)
  const [archiveError, setArchiveError] = createSignal<string | null>(null)
  const [auctionArchiving, setAuctionArchiving] = createSignal(false)
  const [auctionArchiveNote, setAuctionArchiveNote] = createSignal<string | null>(null)
  const [auctionArchives, setAuctionArchives] = createSignal<AuctionArchiveItem[]>([])
  const [auctionArchivesLoading, setAuctionArchivesLoading] = createSignal(false)
  const [auctionArchivesError, setAuctionArchivesError] = createSignal<string | null>(null)
  const [archives, setArchives] = createSignal<SnapshotArchiveItem[]>([])
  const [archivesLoading, setArchivesLoading] = createSignal(false)
  const [archivesError, setArchivesError] = createSignal<string | null>(null)
  const [limitDate, setLimitDate] = createSignal(new Date().toISOString().slice(0, 10))
  const [limitReview, setLimitReview] = createSignal<LimitReviewResult | null>(null)
  const [limitLoading, setLimitLoading] = createSignal(false)
  const [limitError, setLimitError] = createSignal<string | null>(null)
  const [localDay, setLocalDay] = createSignal<LocalDayResult | null>(null)
  const [localLoading, setLocalLoading] = createSignal(false)
  const [localError, setLocalError] = createSignal<string | null>(null)
  const [importLoading, setImportLoading] = createSignal(false)
  const [importResult, setImportResult] = createSignal<LocalImportResult | null>(null)
  const [importError, setImportError] = createSignal<string | null>(null)
  const [writeLoading, setWriteLoading] = createSignal(false)
  const [writeResult, setWriteResult] = createSignal<LocalDayWriteResult | null>(null)
  const [writeError, setWriteError] = createSignal<string | null>(null)

  const loadInventory = async (): Promise<void> => {
    if (syncRunning() || integrityBusy()) return
    setInventoryLoading(true)
    setInventoryError(null)
    try {
      setInventory(await api.data.inventory())
    } catch (cause) {
      setInventoryError(errorMessage(cause))
    } finally {
      setInventoryLoading(false)
    }
  }

  /* ---------------------------------------------------- 离线数据备份/恢复 */

  /** 默认文件名带时间戳：同名备份在后端会直接报错，不让它悄悄覆盖旧的 */
  const defaultBackupName = (): string => {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    return (
      `pythontdx-offline-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}.zip`
    )
  }

  const pickBackupPath = async (): Promise<void> => {
    setBackupError(null)
    if (!shell.isDesktop) {
      setBackupError('浏览器版不能读写本机文件；请在桌面端备份/恢复。')
      return
    }
    try {
      const picked = await shell.dialogs.save({
        title: '保存离线数据备份',
        defaultPath: defaultBackupName(),
        filters: [{ name: 'ZIP 备份', extensions: ['zip'] }]
      })
      if (picked) {
        setBackupPath(picked)
        setBackupProgress(null)
      }
    } catch (cause) {
      setBackupError(errorMessage(cause))
    }
  }

  const runBackup = async (): Promise<void> => {
    setBackupError(null)
    setBackupResult(null)
    setBackupProgress(null)
    if (!shell.isDesktop) {
      setBackupError('浏览器版不能读写本机文件；请在桌面端备份/恢复。')
      return
    }
    let target = backupPath().trim()
    if (!target) {
      try {
        const picked = await shell.dialogs.save({
          title: '保存离线数据备份',
          defaultPath: defaultBackupName(),
          filters: [{ name: 'ZIP 备份', extensions: ['zip'] }]
        })
        if (!picked) return
        target = picked
        setBackupPath(picked)
      } catch (cause) {
        setBackupError(errorMessage(cause))
        return
      }
    }
    setBackupBusy(true)
    try {
      const result = await api.data.backupCreate(target)
      setBackupResult(result)
      // 备份完顺手填到恢复框里，方便校验或直接换机恢复
      setRestorePath(result.path)
      void loadInventory()
    } catch (cause) {
      setBackupError(errorMessage(cause))
      setBackupProgress(null)
    } finally {
      setBackupBusy(false)
    }
  }

  const pickRestorePath = async (): Promise<void> => {
    setRestoreError(null)
    if (!shell.isDesktop) {
      setRestoreError('浏览器版不能读写本机文件；请在桌面端备份/恢复。')
      return
    }
    try {
      const picked = await shell.dialogs.open({
        title: '选择离线数据备份',
        filters: [{ name: 'ZIP 备份', extensions: ['zip'] }]
      })
      if (picked) {
        setRestorePath(picked)
        setBackupInfo(null)
        setRestoreResult(null)
        setRestoreProgress(null)
      }
    } catch (cause) {
      setRestoreError(errorMessage(cause))
    }
  }

  const inspectRestore = async (): Promise<void> => {
    const path = restorePath().trim()
    if (!path) {
      setRestoreError('请先选择备份文件')
      return
    }
    setInspectBusy(true)
    setRestoreError(null)
    setBackupInfo(null)
    try {
      setBackupInfo(await api.data.backupInspect(path))
    } catch (cause) {
      setRestoreError(errorMessage(cause))
    } finally {
      setInspectBusy(false)
    }
  }

  const runRestore = async (): Promise<void> => {
    const path = restorePath().trim()
    if (!path) {
      setRestoreError('请先选择备份文件')
      return
    }
    setRestoreBusy(true)
    setRestoreError(null)
    setRestoreResult(null)
    setRestoreProgress(null)
    try {
      setRestoreResult(await api.data.backupRestore(path))
      void loadInventory()
    } catch (cause) {
      setRestoreError(errorMessage(cause))
      setRestoreProgress(null)
    } finally {
      setRestoreBusy(false)
    }
  }

  const loadLimitReview = async (): Promise<void> => {
    const date = limitDate().trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setLimitError('日期格式应为 YYYY-MM-DD')
      return
    }
    setLimitLoading(true)
    setLimitError(null)
    try {
      setLimitReview(await api.data.limitReview(date))
    } catch (cause) {
      setLimitError(errorMessage(cause))
    } finally {
      setLimitLoading(false)
    }
  }

  const loadArchives = async (): Promise<void> => {
    setArchivesLoading(true)
    setArchivesError(null)
    try {
      setArchives(await api.data.lakeArchives(20))
    } catch (cause) {
      setArchivesError(errorMessage(cause))
    } finally {
      setArchivesLoading(false)
    }
  }

  const runArchive = async (): Promise<void> => {
    if (archiving()) return
    setArchiving(true)
    setArchiveError(null)
    try {
      setArchive(await api.data.archiveSnapshot())
      await loadArchives()
    } catch (cause) {
      setArchiveError(errorMessage(cause))
    } finally {
      setArchiving(false)
    }
  }

  const runAuctionArchive = async (): Promise<void> => {
    if (auctionArchiving()) return
    const codes = watchCodes()
    if (codes.length === 0) {
      setAuctionArchiveNote('自选池为空')
      return
    }
    setAuctionArchiving(true)
    setAuctionArchiveNote(null)
    try {
      const result = await api.auction.archiveBatch(codes)
      setAuctionArchiveNote(
        `竞价归档 ${result.savedCount}/${codes.length} 只 · ${result.tradeDate}${
          result.failedCount > 0 ? ` · ${result.failedCount} 只失败` : ''
        }`
      )
      await loadAuctionArchives()
    } catch (cause) {
      setAuctionArchiveNote(`竞价归档失败：${errorMessage(cause)}`)
    } finally {
      setAuctionArchiving(false)
    }
  }

  const loadAuctionArchives = async (): Promise<void> => {
    setAuctionArchivesLoading(true)
    setAuctionArchivesError(null)
    try {
      setAuctionArchives(await api.auction.archiveList(20))
    } catch (cause) {
      setAuctionArchivesError(errorMessage(cause))
    } finally {
      setAuctionArchivesLoading(false)
    }
  }

  const runSnapshotExport = async (): Promise<void> => {
    if (snapshotExporting()) return
    setSnapshotExporting(true)
    setSnapshotError(null)
    try {
      const catalog = await api.quote.catalog()
      const codes = catalog
        .filter(
          (item) =>
            item.kind === 'GP-A' &&
            ((item.market === 'SH' && /^(600|601|603|605|688|689)/.test(item.symbol)) ||
              (item.market === 'SZ' && /^(000|001|002|003|300|301|302)/.test(item.symbol)) ||
              (item.market === 'BJ' && /^[489]/.test(item.symbol)))
        )
        .map((item) => item.code)
      const quotes = []
      for (let start = 0; start < codes.length; start += 500) {
        quotes.push(...(await api.quote.macQuotes(codes.slice(start, start + 500))))
      }
      downloadText(
        `pythontdx-market-snapshot-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(
          ['代码', '名称', '现价', '昨收', '涨跌幅', '成交额', '换手率', '量比', '涨速'],
          quotes.map((quote) => [
            quote.code,
            quote.name,
            quote.price,
            quote.prevClose,
            quote.changePct,
            quote.amount,
            quote.turnoverRate ?? '',
            quote.volumeRatio ?? '',
            quote.riseSpeed ?? ''
          ])
        )
      )
      setSnapshotResult(quotes.length)
    } catch (cause) {
      setSnapshotError(errorMessage(cause))
    } finally {
      setSnapshotExporting(false)
    }
  }

  const runKlineExport = async (): Promise<void> => {
    if (klineExporting()) return
    setKlineExporting(true)
    setKlineExportError(null)
    try {
      setKlineExport(
        await api.data.exportKlines({
          codes: watchCodes(),
          period: klinePeriod(),
          count: klineCount(),
          adjust: 'qfq'
        })
      )
    } catch (cause) {
      setKlineExportError(errorMessage(cause))
    } finally {
      setKlineExporting(false)
    }
  }

  const loadSummary = async (): Promise<void> => {
    if (loading()) return
    setLoading(true)
    setError(null)
    try {
      setSummary(await api.data.statsSummary())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const runExport = async (): Promise<void> => {
    if (exporting()) return
    setExporting(true)
    setError(null)
    try {
      const result = await api.data.statsExport()
      setExported(result)
      setSummary(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setExporting(false)
    }
  }

  const runCsv = async (): Promise<void> => {
    if (csvExporting()) return
    setCsvExporting(true)
    setError(null)
    try {
      setCsvResult(await api.data.statsCsv())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCsvExporting(false)
    }
  }

  const runParquet = async (): Promise<void> => {
    if (parquetExporting()) return
    setParquetExporting(true)
    setError(null)
    try {
      setParquetResult(await api.data.statsParquet())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setParquetExporting(false)
    }
  }

  const outputPath = (): string => {
    const source = localPath().trim()
    if (!source) return ''
    const match = source.match(/\.[^.\\/]+$/)
    if (!match) return `${source}.out.day`
    return `${source.slice(0, -match[0].length)}.out${match[0].toLowerCase()}`
  }

  const runLocalWrite = async (): Promise<void> => {
    const data = localDay()
    if (!data || writeLoading()) return
    setWriteLoading(true)
    setWriteError(null)
    try {
      const target = outputPath()
      setWriteResult(
        target.toLowerCase().endsWith('.day')
          ? await api.data.localDayWrite(target, data.bars)
          : await api.data.localMinWrite(target, data.bars)
      )
    } catch (cause) {
      setWriteError(errorMessage(cause))
    } finally {
      setWriteLoading(false)
    }
  }

  const runLocalImport = async (): Promise<void> => {
    if (importLoading()) return
    const path = localPath().trim()
    if (!path) {
      setImportError('请先读取本地文件')
      return
    }
    setImportLoading(true)
    setImportError(null)
    try {
      setImportResult(await api.data.localImport(path))
      updateSettings({ localDayPath: path })
    } catch (cause) {
      setImportError(errorMessage(cause))
    } finally {
      setImportLoading(false)
    }
  }

  const exportLocalCsv = (): void => {
    const data = localDay()
    if (!data) return
    const header = 'date,open,high,low,close,amount,volume\n'
    const body = data.bars
      .map((bar) =>
        [bar.date, bar.open, bar.high, bar.low, bar.close, bar.amount, bar.volume].join(',')
      )
      .join('\n')
    const blob = new Blob([`\ufeff${header}${body}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${data.path.split(/[\\/]/).pop() ?? 'local'}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const runLocalDay = async (): Promise<void> => {
    if (localLoading()) return
    const path = localPath().trim()
    if (!path) {
      setLocalError('请输入 .day 文件绝对路径')
      return
    }
    setLocalLoading(true)
    setLocalError(null)
    try {
      setLocalDay(await api.data.localDay(path, 500))
      updateSettings({ localDayPath: path })
    } catch (cause) {
      setLocalDay(null)
      setLocalError(errorMessage(cause))
    } finally {
      setLocalLoading(false)
    }
  }

  const runQuery = async (): Promise<void> => {
    if (querying()) return
    setQuerying(true)
    setQueryError(null)
    try {
      setQuery(
        engine() === 'duckdb'
          ? await api.data.duckQuery(sql(), 100)
          : engine() === 'local'
            ? await api.data.localQuery(sql(), 100)
            : await api.data.statsQuery(sql(), 100)
      )
    } catch (cause) {
      setQuery(null)
      setQueryError(errorMessage(cause))
    } finally {
      setQuerying(false)
    }
  }

  onMount(() => {
    const stopProgress = api.data.onBackupProgress((progress) => {
      if (progress.operation === 'backup') setBackupProgress(progress)
      else setRestoreProgress(progress)
    })
    // 先拉同步状态（priority 请求），再扫本地目录；目录扫描在几十 GB 时很慢，
    // 不能让它把进度徽标饿死。
    void refreshSync()
    void loadAuctionArchives()
    // 并行同步是后台任务，面板打开期间每 2.5 秒拉一次进度；任务结束后继续拉
    // 也没有副作用（status 只是一次本地 JSON 读取）。
    syncTimer = window.setInterval(() => {
      // 完整性校验/目录扫描也是单线程 Python 命令；它们运行时不要再发 status，
      // 否则请求排队到超时会把桥接进程杀掉，连正在下载的 worker 一起断。
      if (!syncBusy() && !integrityBusy() && !inventoryLoading()) void refreshSync()
    }, 2500)
    onCleanup(() => {
      stopProgress()
      if (syncTimer !== undefined) window.clearInterval(syncTimer)
    })
  })

  return (
    <div class="data-backdrop" onClick={() => props.onClose()}>
      <section
        class="data-panel"
        role="dialog"
        aria-modal="true"
        aria-label="数据工具"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="data__head">
          <div>
            <div class="data__eyebrow">0x06b9 · 原始文件 / 规范化层</div>
            <h2 class="data__title">数据工具</h2>
          </div>
          <button
            class="btn btn--icon btn--bare"
            title="关闭数据工具"
            onClick={() => props.onClose()}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div class="data__body">
          <div class="data__intro">
            下载官方 <code>zhb.zip</code>，先看摘要；规范化会写原始 ZIP、按交易日分区的
            JSONL.gz、SQLite 查询层和 manifest。
          </div>

          <section class="data__download data__sync">
            <div class="data__inventory-head">
              <div>
                <div class="data__label">并行离线同步 · 多进程 × 多线程 × 多服务器</div>
                <div class="data__sub">
                  任务切片后分发到全部可达主站；交易日 08:45–15:45 自动保护，暂停后可续跑。
                </div>
              </div>
              <div class="data__download-select">
                <button class="btn data__sync-refresh" onClick={() => void refreshSync()}>
                  刷新状态
                </button>
                <span
                  classList={{
                    'data__sync-badge': true,
                    'data__sync-badge--closed': !(syncStatus()?.window.open ?? true)
                  }}
                >
                  {syncWindowLabel()}
                </span>
              </div>
            </div>

            <div class="data__sync-controls">
              <label class="data__sync-field">
                <span>预设</span>
                <select
                  disabled={syncRunning() || syncBusy()}
                  onChange={(event) => {
                    applySyncPreset(event.currentTarget.value)
                    event.currentTarget.value = ''
                  }}
                >
                  <option value="">选择预设…</option>
                  <For each={Object.entries(syncCatalog()?.presets ?? {})}>
                    {([key, preset]) => <option value={key}>{preset.label}</option>}
                  </For>
                </select>
              </label>
              <label class="data__sync-field">
                <span>范围</span>
                <select
                  value={syncScope()}
                  disabled={syncRunning()}
                  onChange={(event) =>
                    setSyncScope(event.currentTarget.value as 'watchlist' | 'all')
                  }
                >
                  <option value="watchlist">仅自选（{watchCodes().length}）</option>
                  <option value="all">全 A 股</option>
                </select>
              </label>
              <label class="data__sync-field">
                <span>数据源</span>
                <select
                  value={syncSource()}
                  disabled={syncRunning()}
                  onChange={(event) =>
                    setSyncSource(event.currentTarget.value as 'auto' | 'mac' | '7709')
                  }
                >
                  <option value="auto">自动（MAC 优先）</option>
                  <option value="mac">仅 MAC</option>
                  <option value="7709">仅 7709</option>
                </select>
              </label>
              <label class="data__sync-field">
                <span>进程</span>
                <input
                  type="number"
                  min={1}
                  max={48}
                  value={syncProcesses()}
                  disabled={syncRunning()}
                  onChange={(event) => setSyncProcesses(Number(event.currentTarget.value) || 1)}
                />
              </label>
              <label class="data__sync-field">
                <span>线程/进程</span>
                <input
                  type="number"
                  min={1}
                  max={4}
                  value={syncThreads()}
                  disabled={syncRunning()}
                  onChange={(event) => setSyncThreads(Number(event.currentTarget.value) || 1)}
                />
              </label>
              <label class="data__incremental">
                <input
                  type="checkbox"
                  checked={syncSkipExisting()}
                  disabled={syncRunning()}
                  onChange={() => setSyncSkipExisting((value) => !value)}
                />
                跳过已有
              </label>
              <label
                class="data__incremental"
                title="桥接重启或应用重开后，自动续跑最近一次 incomplete 任务一次"
              >
                <input
                  type="checkbox"
                  checked={syncAutoResume()}
                  disabled={syncRunning()}
                  onChange={() => setSyncAutoResume((value) => !value)}
                />
                自动续跑
              </label>
            </div>

            <div class="data__download-list data__sync-datasets">
              <For each={syncCatalog()?.datasets ?? []}>
                {(item) => (
                  <label class="data__download-item">
                    <input
                      type="checkbox"
                      checked={syncSelection().includes(item.key)}
                      disabled={syncRunning()}
                      onChange={() => toggleSyncDataset(item.key)}
                    />
                    <span>
                      <strong>
                        {item.label}
                        <span class="data__sync-tag">{item.group}</span>
                      </strong>
                      <small>{item.description}</small>
                    </span>
                  </label>
                )}
              </For>
            </div>

            <div class="data__download-actions">
              <Show when={syncRunning()}>
                <button class="btn data__bulk-cancel" onClick={() => void cancelSync()}>
                  终止同步
                </button>
              </Show>
              <button
                class="btn btn--primary data__download-run"
                disabled={syncRunning() || syncBusy() || integrityBusy() || inventoryLoading()}
                onClick={() => void startSync()}
              >
                {syncRunning() ? '同步中…' : syncBusy() ? '处理中…' : '开始并行同步'}
              </button>
            </div>

            <OpProgress
              active={syncBusy() || (syncRunning() && (syncStatus()?.totals?.total ?? 0) === 0)}
              label={
                syncBusy()
                  ? '提交同步任务'
                  : syncStatus()?.state === 'probing'
                    ? '探测可用主站'
                    : '生成下载计划'
              }
              detail={
                syncStatus()?.state === 'probing' ? '多服务器 TCP 探活' : '任务切片 / 分发给 worker'
              }
            />

            <Show when={syncStatus()?.totals && (syncStatus()?.totals?.total ?? 0) > 0}>
              <div class="data__bulk-progress">
                <span style={{ width: `${syncPercent()}%` }} />
              </div>
              <div class="data__bulk-meta">
                {syncStatus()?.state} · 完成 {syncStatus()?.totals?.done ?? 0} · 跳过{' '}
                {syncStatus()?.totals?.skipped ?? 0} · 失败 {syncStatus()?.totals?.failed ?? 0} ·{' '}
                {thousands(syncStatus()?.totals?.rows ?? 0)} 行 ·{' '}
                {(syncStatus()?.throughputPerSecond ?? 0).toFixed(1)} 任务/秒
                {syncStatus()?.etaSeconds != null
                  ? ` · 预计 ${Math.ceil((syncStatus()?.etaSeconds ?? 0) / 60)} 分钟`
                  : ''}
              </div>
            </Show>

            <Show when={(syncStatus()?.workers?.length ?? 0) > 0}>
              <div class="data__sync-workers">
                <For each={syncStatus()?.workers ?? []}>
                  {(worker) => (
                    <span>
                      #{worker.index} · {worker.state} · {worker.done ?? 0}/{worker.total ?? 0}
                      {worker.current ? ` · ${worker.current}` : ''}
                    </span>
                  )}
                </For>
              </div>
            </Show>

            <Show when={(syncStatus()?.failures?.length ?? 0) > 0}>
              <div class="data__sync-failures">
                <For each={(syncStatus()?.failures ?? []).slice(-6)}>
                  {(failure) => (
                    <div>
                      {failure.task?.dataset} {failure.task?.code ?? failure.task?.codes?.join(',')}{' '}
                      · {failure.error}
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={syncStatus()?.state === 'failed'}>
              <div class="data__query-error">
                同步失败：
                {syncStatus()?.error || 'worker 未能启动，详见 lake/offline_sync/<job>/logs/'}
              </div>
            </Show>
            <Show when={syncStatus()?.lastSummary}>
              {(last) => (
                <div class="data__sync-summary">
                  <div class="data__sync-summary-head">
                    <strong>最近任务摘要</strong>
                    <span
                      classList={{
                        'data__sync-summary-state': true,
                        'data__sync-summary-state--ok': last().state === 'completed',
                        'data__sync-summary-state--bad': [
                          'failed',
                          'incomplete',
                          'cancelled'
                        ].includes(last().state)
                      }}
                    >
                      {last().state}
                    </span>
                  </div>
                  <div class="data__sync-summary-meta">
                    计划 {thousands(last().planned)} · 完成 {thousands(last().totals.done)} · 跳过{' '}
                    {thousands(last().totals.skipped)} · 失败 {thousands(last().totals.failed)} ·{' '}
                    {thousands(last().totals.rows)} 行 · 耗时{' '}
                    {formatDuration(
                      last().elapsedSeconds ??
                        (last().startedAt && last().finishedAt
                          ? Math.max(
                              0,
                              (Date.parse(last().finishedAt!) - Date.parse(last().startedAt!)) /
                                1000
                            )
                          : 0)
                    )}
                    {last().finishedAt ? ` · ${last().finishedAt}` : ''}
                  </div>
                  <div class="data__sync-summary-meta">任务：{last().jobId}</div>
                  <div class="data__sync-summary-datasets">
                    <For each={Object.entries(last().datasets).slice(0, 12)}>
                      {([name, count]) => (
                        <span>
                          {name} {thousands(Number(count))}
                        </span>
                      )}
                    </For>
                  </div>
                  <Show when={last().error}>
                    <div class="data__query-error">{last().error}</div>
                  </Show>
                  <code class="data__sync-summary-dir">{last().dir}</code>
                  <Show
                    when={
                      ['incomplete', 'failed', 'cancelled'].includes(last().state) &&
                      (last().options?.datasets?.length ?? 0) > 0
                    }
                  >
                    <button
                      class="btn data__sync-summary-resume"
                      disabled={syncRunning() || syncBusy()}
                      onClick={() => void resumeLastSync()}
                    >
                      继续未完成任务（跳过已有）
                    </button>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={syncError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
          </section>

          <section class="data__inventory">
            <div class="data__inventory-head">
              <div>
                <div class="data__label">本地离线数据</div>
                <div class="data__sub">
                  扫描 raw / cache / lake / exports / normalized / local 六个目录。
                </div>
              </div>
              <button
                class="btn data__inventory-refresh"
                disabled={inventoryLoading() || syncRunning()}
                onClick={() => void loadInventory()}
              >
                {inventoryLoading() ? '扫描中…' : '重新扫描'}
              </button>
            </div>
            <OpProgress
              active={inventoryLoading()}
              label="扫描 raw / cache / lake / exports / normalized / local"
            />
            <Show when={inventoryError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
            <Show when={inventory()}>
              {(data) => (
                <>
                  <div class="data__path">
                    <span>数据根目录</span>
                    <code>{data().root}</code>
                  </div>
                  <div class="data__inventory-grid">
                    <For
                      each={
                        [
                          ['raw', '原始报文'],
                          ['cache', 'K 线缓存'],
                          ['lake', '数据湖'],
                          ['exports', '导出'],
                          ['normalized', '规范化'],
                          ['local', '本地文件']
                        ] as const
                      }
                    >
                      {([key, label]) => (
                        <div class="data__metric">
                          <span>{label}</span>
                          <strong>
                            {data()[key].files} 文件 / {formatBytes(data()[key].bytes)}
                          </strong>
                        </div>
                      )}
                    </For>
                  </div>
                  <div class="data__kline-manifest">
                    K 线缓存：{data().klineCache.files} 文件 · {data().klineCache.codes} 只 ·{' '}
                    {data().klineCache.periods.join(' / ') || '无'} · 最近{' '}
                    {data().klineCache.latest > 0
                      ? new Date(data().klineCache.latest).toLocaleString('zh-CN')
                      : '无'}
                  </div>
                </>
              )}
            </Show>

            <div class="data__integrity">
              <div class="data__integrity-head">
                <div>
                  <div class="data__label">本地离线数据校验</div>
                  <div class="data__sub">
                    逐份校验 K 线 / tick / 竞价 / F10 / 资金流 / 服务器文件的 manifest 与
                    SHA256，发现缺失、损坏或行数非法会列出来；不修改行情数据， 缺失的 K 线 manifest
                    会补索引。
                  </div>
                </div>
                <div class="data__integrity-actions">
                  <button
                    class="btn data__integrity-run"
                    disabled={integrityBusy() || syncRunning() || inventoryLoading()}
                    onClick={() => void runIntegrity()}
                  >
                    {integrityBusy() ? '统计/校验中…' : '统计与校验'}
                  </button>
                  <button
                    class="btn data__integrity-export"
                    disabled={!integrity()}
                    onClick={exportIntegrityReport}
                  >
                    导出报告
                  </button>
                </div>
              </div>
              <Show when={integrityError()}>
                {(message) => <div class="data__query-error">{message()}</div>}
              </Show>
              <Show when={integrityBusy()}>
                <div class="data__integrity-busy">
                  <div class="data__integrity-bar">
                    <span
                      style={{
                        width: `${Math.min(92, 8 + integrityElapsed() * 9).toFixed(1)}%`
                      }}
                    />
                  </div>
                  <span>
                    正在扫描目录并逐份校验 manifest / SHA256… 已等待 {integrityElapsed().toFixed(1)}
                    s
                  </span>
                </div>
              </Show>
              <Show when={integrity()}>
                {(report) => (
                  <div class="data__integrity-report">
                    <div class="data__integrity-summary">
                      <span
                        class="data__integrity-badge"
                        classList={{ 'data__integrity-badge--bad': !report().ok }}
                      >
                        {report().ok ? '校验通过' : '发现问题'}
                      </span>
                      <span>
                        共校验 {report().checked} 份 · 失败 {report().failed} 份
                      </span>
                      <span class="data__integrity-time">{new Date().toLocaleString('zh-CN')}</span>
                    </div>
                    <Show when={coverage()}>
                      {(data) => (
                        <div class="data__coverage">
                          <div class="data__coverage-summary">
                            数据集 {data().datasets.length} 项 · 覆盖 {data().totalFiles} 文件 /{' '}
                            {formatBytes(data().totalBytes)}
                            <Show when={inventoryTotals()}>
                              {(totals) => (
                                <span>
                                  {' '}
                                  · 六个目录合计 {totals().files} 文件 /{' '}
                                  {formatBytes(totals().bytes)}
                                </span>
                              )}
                            </Show>{' '}
                            · 扫描于 {new Date(data().generatedAt).toLocaleString('zh-CN')}
                          </div>
                          <div class="data__coverage-grid">
                            <For each={data().datasets}>
                              {(item) => (
                                <div class="data__coverage-item">
                                  <span class="data__coverage-name">{item.name}</span>
                                  <span>
                                    {item.files} 文件 / {formatBytes(item.bytes)}
                                  </span>
                                  <span class="data__coverage-range">
                                    {item.oldest ?? '—'} ~ {item.newest ?? '—'}
                                  </span>
                                  <span
                                    class="data__coverage-state"
                                    classList={{
                                      'data__coverage-state--empty': item.status !== 'ok'
                                    }}
                                  >
                                    {item.status === 'ok' ? '有数据' : '空'}
                                  </span>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      )}
                    </Show>
                    <Show when={integrityBusy()}>
                      <div class="data__integrity-progress">正在逐份校验 manifest / SHA256…</div>
                    </Show>
                    <div class="data__integrity-checks">
                      <For each={report().checks}>
                        {(check) => (
                          <div class="data__integrity-check">
                            <span class="data__integrity-name">{check.name}</span>
                            <span class="num">
                              {check.checked} 份 / 失败 {check.failed}
                            </span>
                            <span
                              class="data__integrity-state"
                              classList={{ 'data__integrity-state--bad': check.failed > 0 }}
                            >
                              {check.failed > 0 ? '异常' : '正常'}
                            </span>
                            <Show when={check.details.length > 0}>
                              <ul class="data__integrity-details">
                                <For each={check.details.slice(0, 5)}>
                                  {(detail) => (
                                    <li>
                                      {detail.manifest}：{detail.error}
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                    <div class="data__integrity-backfill">
                      K 线 manifest 补齐：新建 {report().klineBackfill.created} · 已有{' '}
                      {report().klineBackfill.skipped} · 失败 {report().klineBackfill.failed}
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </section>

          <section class="data__backup">
            <div class="data__inventory-head">
              <div>
                <div class="data__label">离线数据备份 / 恢复</div>
                <Show when={!desktop}>
                  <div class="data__sub data__sub--web">
                    浏览器版不能读写本机文件：备份/恢复请用桌面端；下面的数据湖 / 导出仍可在浏览器下载。
                  </div>
                </Show>
                <div class="data__sub">
                  把 raw / cache / lake / exports / normalized / local 全部打成一个 zip
                  （行情本身已压缩，这里只做单文件封装）。拷到 NAS 后，重装或换机时选它就能补回，
                  不用重新从服务器下载。
                </div>
              </div>
              <button
                class="btn data__backup-start"
                disabled={backupBusy() || !desktop}
                title={desktop ? undefined : '浏览器版不能读写本机文件，请在桌面端备份'}
                onClick={() => void runBackup()}
              >
                {backupBusy() ? '备份中…' : '备份到…'}
              </button>
            </div>

            <div class="data__backup-row">
              <input
                class="data__backup-path data__backup-input"
                placeholder="备份 zip 保存路径（也可点「选择路径」）"
                value={backupPath()}
                disabled={backupBusy()}
                onInput={(event) => {
                  setBackupPath(event.currentTarget.value)
                  setBackupProgress(null)
                }}
              />
              <button
                class="btn"
                disabled={backupBusy() || !desktop}
                title={desktop ? undefined : '浏览器版不能读写本机文件，请在桌面端备份'}
                onClick={() => void pickBackupPath()}
              >
                选择路径
              </button>
            </div>
            <Show when={backupBusy() || backupProgress()}>
              <BackupProgressBar
                operation="backup"
                progress={backupProgress()}
                busy={backupBusy()}
              />
            </Show>
            <Show when={backupError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
            <Show when={backupResult()}>
              {(result) => (
                <div class="data__kline-manifest">
                  备份完成：{result().fileCount} 个文件 · 原始 {formatBytes(result().totalBytes)} ·
                  压缩包 {formatBytes(result().archiveBytes)} · SHA256{' '}
                  {result().sha256.slice(0, 16)}…
                </div>
              )}
            </Show>

            <div class="data__backup-restore">
              <div class="data__sub">
                恢复采用全量覆盖：备份里的同名文件直接覆盖本地；备份里没有的本地文件保留。
              </div>
              <div class="data__backup-row">
                <input
                  class="data__backup-path data__backup-input"
                  placeholder="备份 zip 路径"
                  value={restorePath()}
                  disabled={restoreBusy()}
                  onInput={(event) => {
                    setRestorePath(event.currentTarget.value)
                    setRestoreProgress(null)
                  }}
                />
                <button
                  class="btn"
                  disabled={restoreBusy() || !desktop}
                  title={desktop ? undefined : '浏览器版不能读写本机文件，请在桌面端恢复'}
                  onClick={() => void pickRestorePath()}
                >
                  选择备份
                </button>
                <button
                  class="btn"
                  disabled={inspectBusy() || restoreBusy() || !restorePath().trim()}
                  onClick={() => void inspectRestore()}
                >
                  {inspectBusy() ? '读取中…' : '校验'}
                </button>
                <button
                  class="btn data__backup-restore-btn"
                  disabled={restoreBusy() || !restorePath().trim()}
                  onClick={() => void runRestore()}
                >
                  {restoreBusy() ? '恢复中…' : '恢复'}
                </button>
              </div>
              <Show when={restoreBusy() || restoreProgress()}>
                <BackupProgressBar
                  operation="restore"
                  progress={restoreProgress()}
                  busy={restoreBusy()}
                />
              </Show>
              <Show when={restoreError()}>
                {(message) => <div class="data__query-error">{message()}</div>}
              </Show>
              <Show when={backupInfo()}>
                {(info) => (
                  <div class="data__kline-manifest">
                    备份内容：{info().fileCount} 个文件 · 原始 {formatBytes(info().totalBytes)} ·
                    压缩包 {formatBytes(info().archiveBytes)}
                    {info().createdAt > 0
                      ? ` · 打包于 ${new Date(info().createdAt).toLocaleString('zh-CN')}`
                      : ''}
                  </div>
                )}
              </Show>
              <Show when={restoreResult()}>
                {(result) => (
                  <div class="data__kline-manifest">
                    恢复完成：新补 {result().restored} 个 · 覆盖 {result().overwritten} 个（
                    {formatBytes(result().bytes)}）· 跳过 {result().skipped} 个。
                  </div>
                )}
              </Show>
            </div>
          </section>

          <section class="data__limit-review">
            <div class="data__inventory-head">
              <div>
                <div class="data__label">历史涨停复盘</div>
                <div class="data__sub">扫描本地全历史日 K，按交易日报出涨停/跌停/炸板。</div>
              </div>
              <div class="data__limit-actions">
                <input
                  class="data__limit-date"
                  type="date"
                  value={limitDate()}
                  onChange={(event) => setLimitDate(event.currentTarget.value)}
                />
                <button
                  class="btn data__limit-run"
                  disabled={limitLoading()}
                  onClick={() => void loadLimitReview()}
                >
                  {limitLoading() ? '扫描中…' : '扫描'}
                </button>
              </div>
            </div>
            <OpProgress active={limitLoading()} label="扫描本地全历史日 K，计算涨停/跌停/炸板" />
            <Show when={limitError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
            <Show when={limitReview()}>
              {(result) => (
                <>
                  <div class="data__limit-meta">
                    {result().date} · 扫描 {result().scanned} 只缓存 · 命中 {result().rows.length}{' '}
                    只
                  </div>
                  <div class="data__limit-list">
                    <For each={result().rows.slice(0, 120)}>
                      {(row) => (
                        <div class="data__limit-row">
                          <span>
                            {row.name} <small>{row.code.toUpperCase()}</small>
                          </span>
                          <span class="num">{fixed(row.close)}</span>
                          <span
                            classList={{
                              'tone-up': row.changePct > 0,
                              'tone-down': row.changePct < 0
                            }}
                          >
                            {signedPct(row.changePct)}
                          </span>
                          <b
                            classList={{
                              'data__limit-kind--up': row.kind === 'up',
                              'data__limit-kind--down': row.kind === 'down'
                            }}
                          >
                            {row.kind === 'up' ? '涨停' : row.kind === 'down' ? '跌停' : '炸板'}
                          </b>
                        </div>
                      )}
                    </For>
                  </div>
                </>
              )}
            </Show>
          </section>

          <section class="data__kline">
            <div>
              <div class="data__label">自选 K 线导出</div>
              <div class="data__sub">
                最近 {klineCount()} 根
                {klinePeriod() === 'day' ? '日' : klinePeriod() === 'week' ? '周' : '月'} K，CSV +
                JSONL.gz + manifest。
              </div>
            </div>
            <div class="data__kline-options">
              <select
                class="data__kline-period"
                value={klinePeriod()}
                onChange={(event) => setKlinePeriod(event.currentTarget.value)}
              >
                <option value="day">日 K</option>
                <option value="week">周 K</option>
                <option value="month">月 K</option>
              </select>
              <select
                class="data__kline-count"
                value={String(klineCount())}
                onChange={(event) => setKlineCount(Number(event.currentTarget.value))}
              >
                <option value="120">120 根</option>
                <option value="240">240 根</option>
                <option value="480">480 根</option>
              </select>
              <button
                class="btn data__kline-export"
                disabled={klineExporting() || watchCodes().length === 0}
                onClick={() => void runKlineExport()}
              >
                {klineExporting() ? '导出中…' : `导出 ${watchCodes().length} 只`}
              </button>
            </div>
            <OpProgress
              active={klineExporting()}
              label={`导出 ${watchCodes().length} 只自选 K 线`}
              detail={`${klineCount()} 根 · ${klinePeriod()}`}
            />
          </section>
          <Show when={klineExportError()}>
            {(message) => <div class="data__query-error">{message()}</div>}
          </Show>
          <Show when={klineExport()}>
            {(data) => (
              <div class="data__summary data__summary--kline">
                <div class="data__path">
                  <span>K 线导出</span>
                  <code>{data().dir}</code>
                </div>
                <div class="data__path">
                  <span>结果</span>
                  <code>
                    {data().codes} 只 / {data().rows} 根 / {data().files.length} 个文件
                  </code>
                </div>
                <Show when={data().failed.length > 0}>
                  <div class="data__query-error">
                    失败 {data().failed.length} 只：
                    {data()
                      .failed.map((item) => item.code)
                      .join(', ')}
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <section class="data__kline">
            <div>
              <div class="data__label">全市场快照</div>
              <div class="data__sub">MAC 批量报价 5,615 只 A 股，导出 CSV 用于离线分析。</div>
            </div>
            <button
              class="btn data__snapshot"
              disabled={snapshotExporting()}
              onClick={() => void runSnapshotExport()}
            >
              {snapshotExporting() ? '拉取中…' : '导出全市场 CSV'}
            </button>
            <OpProgress
              active={snapshotExporting()}
              label="MAC 全市场报价 → CSV"
              detail="约 5,600 只"
            />
          </section>
          <section class="data__kline">
            <div>
              <div class="data__label">归档到数据湖</div>
              <div class="data__sub">
                lake/quotes/trade_date=/quotes.jsonl.gz + CSV + manifest（MAC 全 A 快照）。
              </div>
            </div>
            <button
              class="btn data__archive"
              disabled={archiving()}
              onClick={() => void runArchive()}
            >
              {archiving() ? '归档中…' : '归档全市场'}
            </button>
            <OpProgress active={archiving()} label="归档全市场快照到数据湖" detail="lake/quotes" />
          </section>
          <section class="data__kline">
            <div>
              <div class="data__label">自选竞价归档</div>
              <div class="data__sub">
                {
                  'lake/auction/trade_date=YYYY-MM-DD/{code}.jsonl.gz + manifest；服务器只保留最近交易日。'
                }
              </div>
            </div>
            <button
              class="btn data__auction-archive"
              disabled={auctionArchiving()}
              onClick={() => void runAuctionArchive()}
            >
              {auctionArchiving() ? '归档中…' : '归档自选竞价'}
            </button>
            <OpProgress active={auctionArchiving()} label="归档自选竞价" detail="lake/auction" />
          </section>
          <Show when={auctionArchiveNote()}>
            {(note) => <div class="data__sub data__auction-note">{note()}</div>}
          </Show>
          <section class="data__kline">
            <div>
              <div class="data__label">竞价归档历史</div>
              <div class="data__sub">lake/auction 最近 20 个文件；只读清单，不修改原始数据。</div>
            </div>
            <button
              class="btn data__auction-list"
              disabled={auctionArchivesLoading()}
              onClick={() => void loadAuctionArchives()}
            >
              {auctionArchivesLoading() ? '读取中…' : '刷新'}
            </button>
            <OpProgress active={auctionArchivesLoading()} label="读取竞价归档清单" />
          </section>
          <Show when={auctionArchivesError()}>
            {(message) => <div class="data__query-error">{message()}</div>}
          </Show>
          <div class="data__auction-archive-list">
            <For each={auctionArchives()}>
              {(item) => (
                <div class="data__auction-archive-row">
                  <span>{item.tradeDate}</span>
                  <code>{item.code.toUpperCase()}</code>
                  <span class="num">{thousands(item.rows)} 点</span>
                  <span class="num">{formatBytes(item.bytes)}</span>
                </div>
              )}
            </For>
          </div>
          <Show
            when={
              !auctionArchivesLoading() && auctionArchives().length === 0 && !auctionArchivesError()
            }
          >
            <div class="data__sub">暂无竞价归档；先点「归档自选竞价」。</div>
          </Show>
          <label class="data__auto-archive">
            <input
              type="checkbox"
              checked={appState.settings.autoArchive ?? false}
              onChange={(event) => updateSettings({ autoArchive: event.currentTarget.checked })}
            />
            <span>工作日 15:05–15:40 自动归档全市场快照 + 自选竞价/逐笔/资金流/5s/15s</span>
            <Show when={appState.settings.autoArchiveLastDate}>
              {(date) => <em>最近 {date()}</em>}
            </Show>
          </label>
          <Show when={archiveError()}>
            {(message) => <div class="data__query-error">{message()}</div>}
          </Show>
          <Show when={archive()}>
            {(data) => (
              <div class="data__summary data__summary--archive">
                <div class="data__path">
                  <span>数据湖目录</span>
                  <code>{data().dir}</code>
                </div>
                <div class="data__path">
                  <span>分区 / 行数</span>
                  <code>
                    {data().tradeDate} / {data().rows}
                    {data().skipped ? ' · 已存在，已跳过' : ''}
                  </code>
                </div>
                <div class="data__path">
                  <span>SHA256</span>
                  <code>{data().sha256}</code>
                </div>
              </div>
            )}
          </Show>

          <section class="data__lake">
            <div class="data__lake-head">
              <div>
                <div class="data__label">数据湖归档历史</div>
                <div class="data__sub">lake/quotes 下最近 20 个 trade_date 分区。</div>
              </div>
              <button
                class="btn data__lake-refresh"
                disabled={archivesLoading()}
                onClick={() => void loadArchives()}
              >
                {archivesLoading() ? '读取中…' : '刷新归档'}
              </button>
            </div>
            <OpProgress active={archivesLoading()} label="读取 lake/quotes 归档分区" />
            <Show when={archivesError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
            <Show when={archives().length > 0}>
              <table class="data__table data__lake-table">
                <thead>
                  <tr>
                    <th>分区</th>
                    <th class="num">行数</th>
                    <th class="num">大小</th>
                    <th>SHA256</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={archives()}>
                    {(item) => (
                      <tr>
                        <td>{item.tradeDate}</td>
                        <td class="num">{thousands(item.rows)}</td>
                        <td class="num">{formatBytes(item.size)}</td>
                        <td class="data__lake-sha">{item.sha256.slice(0, 12)}…</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </section>

          <Show when={snapshotError()}>
            {(message) => <div class="data__query-error">{message()}</div>}
          </Show>
          <Show when={snapshotResult()}>
            {(count) => (
              <div class="data__summary data__summary--snapshot">
                <div class="data__path">
                  <span>全市场快照</span>
                  <code>{count()} 只已下载 CSV</code>
                </div>
              </div>
            )}
          </Show>

          <div class="data__actions">
            <button
              class="btn btn--primary data__load"
              disabled={loading() || exporting()}
              onClick={() => void loadSummary()}
            >
              {loading() ? '下载解析中…' : '下载摘要'}
            </button>
            <button
              class="btn data__export"
              disabled={loading() || exporting()}
              onClick={() => void runExport()}
            >
              {exporting() ? '导出中…' : '规范化导出'}
            </button>
            <button
              class="btn data__parquet"
              disabled={loading() || exporting() || parquetExporting()}
              onClick={() => void runParquet()}
            >
              {parquetExporting() ? '导出 Parquet…' : '导出 Parquet'}
            </button>
            <button
              class="btn data__csv"
              disabled={loading() || exporting() || csvExporting()}
              onClick={() => void runCsv()}
            >
              {csvExporting() ? '导出 CSV…' : '导出 CSV'}
            </button>
            <span class="data__hint">只读操作，不访问付费/加密数据</span>
          </div>
          <OpProgress
            active={loading() || exporting() || parquetExporting() || csvExporting()}
            label={
              loading()
                ? '下载并解析 zhb.zip'
                : exporting()
                  ? '规范化导出'
                  : parquetExporting()
                    ? '导出 Parquet'
                    : '导出 CSV'
            }
            detail={loading() ? '约 17 MB，按 60 KB 分块读取' : undefined}
          />

          <Show when={error()}>
            {(message) => (
              <div class="data__error" role="alert">
                {message()}
                <button class="data__retry" onClick={() => void loadSummary()}>
                  重试摘要
                </button>
              </div>
            )}
          </Show>

          <Show when={summary()}>
            {(data) => (
              <div class="data__summary">
                <div class="data__grid">
                  <div class="data__metric">
                    <span>ZIP</span>
                    <strong>{formatBytes(data().zipBytes)}</strong>
                  </div>
                  <div class="data__metric">
                    <span>下载块</span>
                    <strong>{thousands(data().chunks)}</strong>
                  </div>
                  <div class="data__metric">
                    <span>ZIP 条目</span>
                    <strong>{thousands(data().zipEntries)}</strong>
                  </div>
                  <div class="data__metric">
                    <span>tdxstat 行</span>
                    <strong>{thousands(data().statCount)}</strong>
                  </div>
                  <div class="data__metric">
                    <span>tdxstat2 行</span>
                    <strong>{thousands(data().stat2Count)}</strong>
                  </div>
                  <div class="data__metric">
                    <span>主日期</span>
                    <strong>{data().statsDate ?? '—'}</strong>
                  </div>
                </div>
                <div class="data__path">
                  <span>原始 ZIP</span>
                  <code>{data().savedTo}</code>
                </div>
                <div class="data__path">
                  <span>SHA256</span>
                  <code>{data().sha256}</code>
                </div>
                <Show when={data().statSamples.length > 0}>
                  <table class="data__table">
                    <thead>
                      <tr>
                        <th>代码</th>
                        <th>日期</th>
                        <th class="num">Beta60</th>
                        <th class="num">PE TTM</th>
                        <th class="num">流通股本(万)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={data().statSamples}>
                        {(row) => (
                          <tr>
                            <td>{row.code}</td>
                            <td>{row.statsDate}</td>
                            <td class="num">{row.beta60 ?? '—'}</td>
                            <td class="num">{row.peTtm ?? '—'}</td>
                            <td class="num">{thousands(row.freeFloatShares10k ?? 0)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </div>
            )}
          </Show>

          <Show when={parquetResult()}>
            {(data) => (
              <div class="data__summary data__summary--parquet">
                <div class="data__path">
                  <span>Parquet 目录</span>
                  <code>{data().target}</code>
                </div>
                <div class="data__path">
                  <span>manifest</span>
                  <code>{data().manifest}</code>
                </div>
                <div class="data__partitions">
                  <span class="data__partition">{thousands(data().rowCount)} 行</span>
                  <span class="data__partition">{data().files.length} 个文件</span>
                  <span class="data__partition">schema v{data().schemaVersion}</span>
                </div>
              </div>
            )}
          </Show>

          <Show when={csvResult()}>
            {(data) => (
              <div class="data__summary data__summary--csv">
                <div class="data__path">
                  <span>tdxstat.csv</span>
                  <code>{data().statCsv}</code>
                </div>
                <div class="data__path">
                  <span>tdxstat2.csv</span>
                  <code>{data().stat2Csv}</code>
                </div>
                <div class="data__partitions">
                  <span class="data__partition">{thousands(data().statCount)} 行</span>
                  <span class="data__partition">{thousands(data().stat2Count)} 行</span>
                </div>
              </div>
            )}
          </Show>

          <Show when={exported()}>
            {(data) => (
              <div class="data__summary data__summary--export">
                <div class="data__grid">
                  <div class="data__metric">
                    <span>有效行</span>
                    <strong>{thousands(data().statCount)}</strong>
                  </div>
                  <div class="data__metric">
                    <span>分区</span>
                    <strong>{data().partitions.length}</strong>
                  </div>
                  <div class="data__metric">
                    <span>空日期跳过</span>
                    <strong>{data().statSkipped}</strong>
                  </div>
                  <div class="data__metric">
                    <span>生成时间</span>
                    <strong>{data().generatedAt.slice(0, 19)}</strong>
                  </div>
                </div>
                <div class="data__path">
                  <span>规范化目录</span>
                  <code>{data().normalizedTo}</code>
                </div>
                <div class="data__path">
                  <span>SQLite</span>
                  <code>{data().database}</code>
                </div>
                <div class="data__path">
                  <span>manifest</span>
                  <code>{data().manifest}</code>
                </div>
                <div class="data__partitions">
                  <For each={data().partitions.slice(0, 6)}>
                    {(partition) => (
                      <span class="data__partition">
                        {partition.tradeDate} · {thousands(partition.statCount)}
                      </span>
                    )}
                  </For>
                  <Show when={data().partitions.length > 6}>
                    <span class="data__partition">… 共 {data().partitions.length} 个分区</span>
                  </Show>
                </div>
              </div>
            )}
          </Show>

          <section class="data__local">
            <div class="data__query-head">
              <div>
                <strong>本地行情文件（读/写）</strong>
                <span>.day / .lc1 / .lc5 / .5；只读，成交量按手换算，最多 500 根</span>
              </div>
              <button
                class="btn data__local-run"
                disabled={localLoading()}
                onClick={() => void runLocalDay()}
              >
                {localLoading() ? '读取中…' : '读取'}
              </button>
            </div>
            <input
              class="data__local-path"
              value={localPath()}
              placeholder="/path/to/sh600519.day 或 .lc1"
              aria-label=".day 文件路径"
              onInput={(event) => setLocalPath(event.currentTarget.value)}
            />
            <OpProgress
              active={localLoading() || importLoading() || writeLoading()}
              label={
                localLoading()
                  ? '读取本地行情文件'
                  : importLoading()
                    ? '导入数据湖'
                    : '写回本地文件'
              }
              detail={localPath()}
            />
            <Show when={localError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
            <Show when={localDay()}>
              {(data) => (
                <div class="data__local-result">
                  <div class="data__query-meta">
                    {data().count} 根 · {data().firstDate} → {data().lastDate}
                    <button class="btn data__local-csv" onClick={exportLocalCsv}>
                      导出 CSV
                    </button>
                    <button
                      class="btn data__local-import"
                      disabled={importLoading()}
                      onClick={() => void runLocalImport()}
                    >
                      {importLoading() ? '导入中…' : '导入数据湖'}
                    </button>
                    <button
                      class="btn data__local-write"
                      disabled={writeLoading()}
                      onClick={() => void runLocalWrite()}
                    >
                      {writeLoading() ? '写入中…' : '写回文件'}
                    </button>
                  </div>
                  <div class="data__query-table-wrap">
                    <table class="data__query-table">
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>开</th>
                          <th>高</th>
                          <th>低</th>
                          <th>收</th>
                          <th>量(手)</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={data().bars.slice(-10)}>
                          {(bar) => (
                            <tr>
                              <td class="num">{bar.date}</td>
                              <td class="num">{bar.open.toFixed(2)}</td>
                              <td class="num">{bar.high.toFixed(2)}</td>
                              <td class="num">{bar.low.toFixed(2)}</td>
                              <td class="num">{bar.close.toFixed(2)}</td>
                              <td class="num">{thousands(bar.volume)}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Show>
            <Show when={writeError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
            <Show when={writeResult()}>
              {(data) => (
                <div class="data__local-imported">
                  已写入 {data().count} 根 · <code>{data().path}</code>
                </div>
              )}
            </Show>
            <Show when={importError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
            <Show when={importResult()}>
              {(data) => (
                <div class="data__local-imported">
                  <div>
                    已导入 {data().rows} 行 · 累计 {data().totalRows} 行 · {data().code}
                  </div>
                  <code>{data().jsonlPath}</code>
                  <code>{data().database}</code>
                </div>
              )}
            </Show>
          </section>

          <section class="data__query">
            <div class="data__query-head">
              <div>
                <strong>SQL 查询</strong>
                <span>只读 SELECT/WITH，最多 500 行</span>
              </div>
              <div class="data__engines">
                <button
                  class="data__engine"
                  data-active={engine() === 'sqlite'}
                  onClick={() => setEngine('sqlite')}
                >
                  SQLite
                </button>
                <button
                  class="data__engine data__duck"
                  data-active={engine() === 'duckdb'}
                  onClick={() => setEngine('duckdb')}
                >
                  DuckDB
                </button>
                <button
                  class="data__engine data__local-engine"
                  data-active={engine() === 'local'}
                  onClick={() => {
                    setEngine('local')
                    setSql('SELECT code, date, close, volume FROM bars ORDER BY date DESC LIMIT 20')
                  }}
                >
                  本地
                </button>
              </div>
              <Show when={engine() === 'local'}>
                <button
                  class="btn data__cross-example"
                  title="local_bars + stats.tdxstat 跨库查询"
                  onClick={() =>
                    setSql(
                      'SELECT b.code, b.date, b.close, s.pe_ttm FROM bars b LEFT JOIN stats.tdxstat s ON s.code = b.code AND s.stats_date = b.date LIMIT 20'
                    )
                  }
                >
                  跨库示例
                </button>
              </Show>
              <button
                class="btn data__query-run"
                disabled={querying()}
                onClick={() => void runQuery()}
              >
                {querying() ? '查询中…' : '执行'}
              </button>
            </div>
            <textarea
              class="data__sql"
              rows="3"
              value={sql()}
              aria-label="SQL 查询"
              onInput={(event) => setSql(event.currentTarget.value)}
            />
            <OpProgress
              active={querying()}
              label={`${engine().toUpperCase()} 只读查询`}
              detail="最多 500 行"
            />
            <Show when={queryError()}>
              {(message) => <div class="data__query-error">{message()}</div>}
            </Show>
            <Show when={query()}>
              {(result) => (
                <div class="data__query-result">
                  <div class="data__query-meta">
                    {result().rowCount} 行{result().limited ? '（已截断）' : ''}
                  </div>
                  <div class="data__query-table-wrap">
                    <table class="data__query-table">
                      <thead>
                        <tr>
                          <For each={result().columns}>{(column) => <th>{column}</th>}</For>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={result().rows}>
                          {(row) => (
                            <tr>
                              <For each={row}>
                                {(cell) => (
                                  <td class="num">{cell === null ? '—' : String(cell)}</td>
                                )}
                              </For>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Show>
          </section>
        </div>

        <footer class="data__foot">
          <span>Python 后端下载/解析，Electron 只负责展示</span>
          <span>写入用户数据目录，不修改原始行情</span>
        </footer>
      </section>
    </div>
  )
}
