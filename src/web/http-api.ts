/**
 * Web 端的 window.api 实现。
 *
 * 桌面走 preload + IPC；浏览器不能碰 IPC，所以这里用只读 HTTP API 实现同一份
 * PythonTdxApi 契约。组件仍然只依赖 window.api，不需要知道自己在哪一端。
 */
import type { ChartPatternsResult } from '@shared/patterns'
import type {
  AppInfo,
  ServerSpeedResult,
  GraphicsInfo,
  LinuxDesktopResult,
  AppState,
  AuctionArchiveBatchResult,
  AuctionArchiveItem,
  AuctionArchiveResult,
  AuctionPoint,
  BlockKind,
  BlockList,
  DisplayInfo,
  CategoryQuote,
  F10Announcement,
  F10NewsItem,
  F10TradingTable,
  LocalDayResult,
  DataCoverageResult,
  DataIntegrityResult,
  DataInventory,
  KLineCacheResult,
  OfflineSyncCatalog,
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
  MacBoard,
  MacUnusualItem,
  MarketBreadth,
  F10ProfileTable,
  FormulaScreenRequest,
  FormulaScreenResult,
  FormulaMarketBacktestResult,
  F10Section,
  IndustryList,
  KLineSeries,
  MinuteTrend,
  MoneyFlowRecord,
  MultiDayTrend,
  Quote,
  QuoteUpdate,
  PushTask,
  PushUpdate,
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
import type { CategoryRequest, KLineRequest, PythonTdxApi, TradesRequest } from '@shared/ipc'
import type { SearchEntry, SearchSecurity } from '@shared/search'
import { DEFAULT_GROUP_ID, DEFAULT_SETTINGS, SEED_GROUPS, STATE_VERSION } from '@shared/types'
import { WEB_VERSION } from './version'

const BASE = (import.meta.env.VITE_PYTHONTDX_API ?? '').replace(/\/$/, '')
const FORCE_POLLING = new URLSearchParams(window.location.search).get('transport') === 'poll'
const STORAGE_KEY = 'pythontdx:web:state'

interface ApiEnvelope<T> {
  ok: boolean
  result?: T
  error?: string
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  })
  let payload: ApiEnvelope<T>
  try {
    payload = (await response.json()) as ApiEnvelope<T>
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`)
  }
  return payload.result as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppState
      if (Array.isArray(parsed.groups) && parsed.groups.length > 0) {
        return {
          version: STATE_VERSION,
          groups: parsed.groups,
          activeGroupId: parsed.activeGroupId || parsed.groups[0].id,
          settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
          activeCode: parsed.activeCode ?? parsed.groups[0]?.items[0]?.code ?? null,
          alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
          formulas: Array.isArray(parsed.formulas) ? parsed.formulas : [],
          positions: Array.isArray(parsed.positions) ? parsed.positions : []
        }
      }
    }
  } catch {
    // 坏配置不阻塞页面，回到种子数据
  }
  const groups = clone(SEED_GROUPS)
  return {
    version: STATE_VERSION,
    groups,
    activeGroupId: DEFAULT_GROUP_ID,
    settings: { ...DEFAULT_SETTINGS },
    activeCode: groups[0]?.items[0]?.code ?? null,
    alerts: [],
    formulas: [],
    positions: []
  }
}

export function createHttpApi(): PythonTdxApi {
  let state = loadState()
  const listeners = new Set<(update: QuoteUpdate) => void>()
  let codes: string[] = []
  let timer: number | undefined
  let stream: EventSource | undefined
  let ws: WebSocket | undefined
  let pollId = 0
  let searchCache: SearchEntry[] | null = null
  let searchModule: Promise<typeof import('@shared/search')> | null = null

  const save = (): AppState => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    return state
  }

  const poll = async (): Promise<void> => {
    const current = ++pollId
    try {
      const quotes = await post<Quote[]>('/api/quotes', { codes })
      if (current !== pollId) return
      const update: QuoteUpdate = { quotes, at: Date.now() }
      listeners.forEach((listener) => listener(update))
    } catch (error) {
      if (current !== pollId) return
      const update: QuoteUpdate = {
        quotes: [],
        at: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      }
      listeners.forEach((listener) => listener(update))
    }
  }

  const stopPolling = (): void => {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
    stream?.close()
    stream = undefined
    ws?.close()
    ws = undefined
    pollId += 1
  }

  const startPolling = (intervalMs: number): void => {
    timer = window.setInterval(() => void poll(), Math.max(1000, intervalMs || 3000))
  }

  const startSse = (intervalMs: number): void => {
    const params = new URLSearchParams({
      codes: codes.join(','),
      interval: String(Math.max(1000, intervalMs || 3000))
    })
    stream = new EventSource(`${BASE}/api/stream?${params.toString()}`)
    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          ok: boolean
          result?: { quotes: Quote[]; at: number }
        }
        if (!payload.ok || !payload.result) return
        const update: QuoteUpdate = {
          quotes: payload.result.quotes,
          at: payload.result.at
        }
        listeners.forEach((listener) => listener(update))
      } catch {
        // 单帧坏数据不打断连接
      }
    }
  }

  const startWs = (intervalMs: number): void => {
    const origin = BASE || window.location.origin
    const url = `${origin.replace(/^http/i, 'ws')}/ws`
    const socket = new WebSocket(url)
    ws = socket
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          codes,
          intervalMs: Math.max(1000, intervalMs || 3000)
        })
      )
    }
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type: string
          quotes?: Quote[]
          at?: number
          error?: string
        }
        if (payload.type !== 'quote' || !payload.quotes) return
        const update: QuoteUpdate = {
          quotes: payload.quotes,
          at: payload.at ?? Date.now()
        }
        listeners.forEach((listener) => listener(update))
      } catch {
        // 单帧坏数据不打断连接
      }
    }
    socket.onerror = () => {
      socket.close()
    }
    socket.onclose = () => {
      if (ws !== socket) return
      ws = undefined
      if (codes.length === 0) return
      // WebSocket 不可用时退回 SSE/轮询，保证只读页仍能刷新
      if (typeof EventSource !== 'undefined') startSse(intervalMs)
      else startPolling(intervalMs)
    }
  }

  const searchHint = async (keyword: string): Promise<SearchItem[]> => {
    if (!keyword.trim()) return []
    // pinyin-pro 词典较大，首次搜索时才加载，避免拖慢首屏
    searchModule ??= import('@shared/search')
    const { buildSearchEntries, searchEntries } = await searchModule
    if (!searchCache) {
      const all = await request<SearchSecurity[]>('/api/code_list')
      searchCache = buildSearchEntries(all)
    }
    return searchEntries(searchCache, keyword)
  }

  const pushListeners = new Set<(update: PushUpdate) => void>()
  const pushTimers = new Map<number, number>()
  let nextPushId = 1

  const fetchPushTask = (task: PushTask): Promise<unknown> => {
    switch (task.kind) {
      case 'category':
        return post<CategoryQuote[]>('/api/category', {
          category: task.category,
          sortType: task.sortType,
          start: task.start,
          count: task.count,
          ascending: task.ascending
        })
      case 'ticks':
        return post<TradeTick[]>('/api/trades', {
          code: task.code,
          date: task.date,
          start: task.start,
          count: task.count
        })
      case 'auction':
        return post<AuctionPoint[]>('/api/auctions', { code: task.code, date: task.date })
      case 'moneyFlow':
        return Promise.all([
          post<MoneyFlowRecord[]>('/api/money_flow', { code: task.code }),
          post<MacMoneyFlow>('/api/mac_money_flow', { code: task.code })
        ]).then(([flow, mac]) => ({ flow, mac }))
      case 'kline': {
        const params = new URLSearchParams({
          code: task.code,
          period: task.period,
          count: String(task.count),
          adjust: task.adjust
        })
        return request<KLineSeries>(`/api/kline?${params.toString()}`)
      }
      case 'minute':
        return request<MinuteTrend>(`/api/minute?code=${encodeURIComponent(task.code)}`)
      case 'fiveDay':
        return request<MultiDayTrend>(`/api/five_day?code=${encodeURIComponent(task.code)}`)
    }
  }

  const emitPush = (update: PushUpdate): void => {
    pushListeners.forEach((listener) => listener(update))
  }

  const push = {
    subscribe: async (task: PushTask, intervalMs: number): Promise<number> => {
      const id = nextPushId++
      const tick = async (): Promise<void> => {
        try {
          emitPush({ id, at: Date.now(), task, data: await fetchPushTask(task) })
        } catch (error) {
          emitPush({
            id,
            at: Date.now(),
            task,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      await tick()
      const timer = window.setInterval(() => void tick(), Math.max(1000, intervalMs))
      pushTimers.set(id, timer)
      return id
    },
    unsubscribe: async (id: number): Promise<void> => {
      const timer = pushTimers.get(id)
      if (timer !== undefined) window.clearInterval(timer)
      pushTimers.delete(id)
    },
    onUpdate: (listener: (update: PushUpdate) => void): (() => void) => {
      pushListeners.add(listener)
      return () => pushListeners.delete(listener)
    }
  }

  const market = {
    breadth: () => post<MarketBreadth>('/api/market_breadth', {})
  }

  const api: PythonTdxApi = {
    quote: {
      snapshot: (list) => post<Quote[]>('/api/quotes', { codes: list }),
      subscribe: async (list, intervalMs) => {
        codes = [...list]
        stopPolling()
        if (codes.length === 0) return
        await poll()
        if (FORCE_POLLING) {
          startPolling(intervalMs)
          return
        }
        if (typeof WebSocket !== 'undefined') {
          startWs(intervalMs)
          return
        }
        if (typeof EventSource === 'undefined') {
          startPolling(intervalMs)
          return
        }
        startSse(intervalMs)
      },
      unsubscribe: async () => {
        stopPolling()
        codes = []
      },
      onUpdate: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      category: (req: CategoryRequest) => post<CategoryQuote[]>('/api/category', req),
      catalog: () => request<SearchSecurity[]>('/api/code_list'),
      macQuotes: (codes) => post<Quote[]>('/api/mac_quotes', { codes }),
      macQuotesFinance: (codes) => post<Quote[]>('/api/mac_quotes_finance', { codes })
    },
    push,
    market,
    trade: {
      ticks: (req: TradesRequest) => post<TradeTick[]>('/api/trades', req)
    },
    money: {
      flow: (code) => post<MoneyFlowRecord[]>('/api/money_flow', { code }),
      macFlow: (code) => post<MacMoneyFlow>('/api/mac_money_flow', { code }),
      macFlowBatch: (codes, workers) =>
        post<MacMoneyFlowPoint[]>('/api/mac_money_flow_batch', { codes, workers })
    },
    mac: {
      unusual: (count) => post<MacUnusualItem[]>('/api/mac_unusual', { count }),
      boards: (boardType) => post<MacBoard[]>('/api/mac_boards', { boardType })
    },
    auction: {
      series: (code, date, selector) =>
        post<AuctionPoint[]>('/api/auctions', { code, date, selector }),
      archiveSave: (code, date) =>
        post<AuctionArchiveResult>('/api/auction_archive_save', { code, date }),
      archiveRead: (code, date) =>
        post<AuctionArchiveResult>('/api/auction_archive_read', { code, date }),
      archiveList: (limit) => post<AuctionArchiveItem[]>('/api/auction_archive_list', { limit }),
      archiveBatch: (codes, date) =>
        post<AuctionArchiveBatchResult>('/api/auction_archive_batch', { codes, date })
    },
    f10: {
      catalog: (code) => post<F10Section[]>('/api/f10_catalog', { code }),
      content: (code, section) =>
        post<string>('/api/f10_content', {
          code,
          filename: section.filename,
          start: section.start,
          length: section.length
        }),
      announcements: (code) => post<F10Announcement[]>('/api/f10_announcements', { code }),
      profile: (code) => post<F10ProfileTable>('/api/f10_profile', { code }),
      valuation: (code) => post<F10ProfileTable>('/api/f10_valuation', { code }),
      finance: (code) => post<F10ProfileTable>('/api/f10_finance', { code }),
      business: (code) => post<F10ProfileTable>('/api/f10_business', { code }),
      shareholders: (code) => post<F10ProfileTable>('/api/f10_shareholders', { code }),
      reports: (code) => post<F10ProfileTable>('/api/f10_reports', { code }),
      news: (code) => post<F10NewsItem[]>('/api/f10_news', { code }),
      industry: (code, section) => post<F10TradingTable>('/api/f10_industry', { code, section }),
      trading: (code, section) => post<F10TradingTable>('/api/f10_trading', { code, section }),
      lhbMarket: () => post<F10TradingTable>('/api/f10_lhb_market', {}),
      market: (section) => post<F10TradingTable>('/api/f10_market', { section }),
      dividend: (code) => post<F10ProfileTable>('/api/f10_dividend', { code }),
      shareholderCount: (code) => post<F10ProfileTable>('/api/f10_shareholder_count', { code }),
      capital: (code, section) => post<F10TradingTable>('/api/f10_capital', { code, section }),
      circulatingShareholders: (code) =>
        post<F10ProfileTable>('/api/f10_circulating_shareholders', { code }),
      shareholderChanges: (code) => post<F10ProfileTable>('/api/f10_shareholder_changes', { code }),
      institutions: (code) => post<F10ProfileTable>('/api/f10_institutions', { code }),
      controller: (code) => post<F10ProfileTable>('/api/f10_controller', { code }),
      changePlans: (code) => post<F10ProfileTable>('/api/f10_change_plans', { code }),
      statement: (code, kind, full) =>
        post<F10ProfileTable>('/api/f10_statement', { code, kind, full: full ?? false })
    },
    data: {
      statsSummary: () => post<TdxStatsSummary>('/api/stats_summary', {}),
      statsExport: () => post<TdxStatsExport>('/api/stats_export', {}),
      statsQuery: (sql, limit) => post<StatsQueryResult>('/api/stats_query', { sql, limit }),
      statsCsv: () => post<StatsCsvExport>('/api/stats_csv', {}),
      statsParquet: () => post<StatsParquetExport>('/api/stats_parquet', {}),
      duckQuery: (sql, limit) => post<StatsQueryResult>('/api/duck_query', { sql, limit }),
      localDay: (path, limit) => post<LocalDayResult>('/api/local_day', { path, limit }),
      localImport: (path) => post<LocalImportResult>('/api/local_import', { path }),
      localQuery: (sql, limit) => post<StatsQueryResult>('/api/local_query', { sql, limit }),
      localDayWrite: (path, bars) => post<LocalDayWriteResult>('/api/local_write', { path, bars }),
      localMinWrite: (path, bars) =>
        post<LocalDayWriteResult>('/api/local_write_min', { path, bars }),
      exportKlines: (req) => post<KLineExportResult>('/api/export_klines', req),
      cacheKlines: (req) => post<KLineCacheResult>('/api/cache_klines', req),
      offlineSyncCatalog: () => post<OfflineSyncCatalog>('/api/offline_sync_catalog', {}),
      offlineSyncStatus: () => post<OfflineSyncStatus>('/api/offline_sync_status', {}),
      offlineSyncStart: (options) => post<OfflineSyncStatus>('/api/offline_sync_start', options),
      offlineSyncCancel: () => post<OfflineSyncStatus>('/api/offline_sync_cancel', {}),
      topBoard: (category, size) => post<TopBoardResult>('/api/top_board', { category, size }),
      unusual: (count) => post<UnusualEvent[]>('/api/unusual', { count }),
      volumeProfile: (code) => post<VolumeProfileResult>('/api/volume_profile', { code }),
      integrity: () => post<DataIntegrityResult>('/api/data_integrity', {}),
      coverage: () => post<DataCoverageResult>('/api/data_coverage', {}),
      inventory: () => post<DataInventory>('/api/data_inventory', {}),
      // 备份/恢复要读写本机磁盘路径，浏览器端没有这个能力；桌面端走 Electron IPC。
      backupCreate: async () => {
        throw new Error('浏览器版不支持离线数据备份，请在桌面端操作')
      },
      backupInspect: async () => {
        throw new Error('浏览器版不支持离线数据备份，请在桌面端操作')
      },
      backupRestore: async () => {
        throw new Error('浏览器版不支持离线数据备份，请在桌面端操作')
      },
      onBackupProgress: () => () => undefined,
      archiveDatasets: async () => {
        throw new Error('浏览器版不支持离线数据归档，请在桌面端操作')
      },
      chooseBackupPath: async () => null,
      chooseRestorePath: async () => null,
      limitReview: (date) => post<LimitReviewResult>('/api/limit_review', { date }),
      patterns: (req) => post<ChartPatternsResult>('/api/chart_patterns', req),
      archiveSnapshot: () => post<SnapshotArchiveResult>('/api/archive_snapshot', {}),
      lakeArchives: (limit) => post<SnapshotArchiveItem[]>('/api/lake_archives', { limit }),
      tickArchiveSave: (code, date) =>
        post<TickArchiveResult>('/api/tick_archive_save', { code, date }),
      tickArchiveDates: (code, start, end, days) =>
        post<string[]>('/api/tick_archive_dates', { code, start, end, days }),
      tickArchiveBatch: (codes, date) =>
        post<TickArchiveBatchResult>('/api/tick_archive_batch', { codes, date }),
      tickArchiveList: (limit) => post<TickArchiveItem[]>('/api/tick_archive_list', { limit })
    },
    block: {
      list: (kind: BlockKind) => post<BlockList>('/api/blocks', { kind }),
      industries: () => post<IndustryList>('/api/industries', {})
      // 客户端自定义板块要读本机 D:\tdx 目录，浏览器端没有这个能力
    },
    screen: {
      run: (request: ScreenRequest) => post<ScreenResult>('/api/screen', request),
      formula: (request: FormulaScreenRequest) =>
        post<FormulaScreenResult>('/api/formula_screen', request),
      formulaBacktest: (request: FormulaScreenRequest) =>
        post<FormulaMarketBacktestResult>('/api/formula_backtest', request)
    },
    trend: {
      minute: (code) => request<MinuteTrend>(`/api/minute?code=${encodeURIComponent(code)}`),
      fiveDay: (code) => request<MultiDayTrend>(`/api/five_day?code=${encodeURIComponent(code)}`),
      kline: (req: KLineRequest) => {
        const params = new URLSearchParams({
          code: req.code,
          period: req.period,
          count: String(req.count ?? 200),
          adjust: req.adjust ?? 'qfq',
          ...(req.anchorDate ? { anchorDate: req.anchorDate } : {}),
          ...(req.cacheOnly ? { cacheOnly: '1' } : {})
        })
        return request<KLineSeries>(`/api/kline?${params.toString()}`)
      }
    },
    search: { hint: searchHint },
    state: {
      get: async () => state,
      patch: async (patch) => {
        state = {
          ...state,
          ...patch,
          settings: { ...state.settings, ...patch.settings }
        }
        return save()
      }
    },
    window: {
      control: async () => ({
        focused: true,
        maximized: false,
        fullscreen: false,
        platform: 'web'
      }),
      openChart: async () => {
        throw new Error('浏览器版不支持独立窗口')
      },
      openSecondary: async () => {
        throw new Error('浏览器版不支持第二窗口')
      },
      toggleAlwaysOnTop: async () => false,
      displays: async (): Promise<DisplayInfo[]> => [
        {
          id: 0,
          label: '浏览器窗口',
          width: window.screen.width,
          height: window.screen.height,
          scaleFactor: window.devicePixelRatio || 1,
          primary: true,
          current: true
        }
      ],
      moveToDisplay: async () => false,
      onStateChange: () => () => undefined
    },
    app: {
      graphics: async (): Promise<GraphicsInfo> => ({
        session: 'web',
        wayland: false,
        requested: 'web',
        platform: 'web',
        gpuFeatureStatus: {}
      }),
      info: async (): Promise<AppInfo> => ({
        name: 'pythontdx Web',
        version: WEB_VERSION,
        electron: '—',
        chrome: navigator.userAgent,
        node: '—',
        platform: 'web'
      }),
      installLinuxDesktop: async (): Promise<LinuxDesktopResult> => {
        throw new Error('浏览器版没有 Linux 桌面环境，请在 AppImage 桌面端操作')
      },
      serverSpeedTest: () => post<ServerSpeedResult>('/api/server_speed_test', {}),
      selectServer: (host) => post<{ preferred: string }>('/api/select_server', { host }),
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      notify: async (title, body) => {
        // 不在触发时申请权限（会被浏览器拦），只在已经授权时发系统通知
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body })
        }
      }
    }
  }
  return api
}
