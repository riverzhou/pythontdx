/**
 * 图表卡片：分时 / 五日 / 日K / 周K / 月K 切换 + 数据加载与自动刷新。
 *
 * 标题区还有一个「十字光标联动读数」：鼠标在图上移动时，
 * 图例会被替换成当前光标位置的 时间 / 价格 / 涨跌幅 / 均价 / 成交量，
 * 移开后又变回图例。这是专业行情软件的标配交互。
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX
} from 'solid-js'
import type {
  KLineAdjust,
  KLinePeriod,
  KLineSeries,
  MinuteTrend,
  MultiDayTrend
} from '@shared/types'
import { fixed, signedPct, thousands, timeOfDay } from '@shared/format'
import { isIndexCode, marketSession, shanghaiClock } from '@shared/market'
import { api, errorMessage, shell } from '../../lib/client'
import { subscribePush } from '../../lib/push'
import {
  applyLiveQuoteToKline,
  chartRefreshMs,
  isIntradayPeriod,
  mergeKlineSeries,
  quoteTimeSeconds,
  usableCachedSeries,
  type LiveTrendTick
} from '../../lib/realtime'
import { clockNow } from '../../stores/clock'
import { quoteOf } from '../../stores/quotes'
import { downloadText } from '../../lib/download'
import { toCsv } from '@shared/csv'
import { appState, updateSettings } from '../../stores/app'
import { openPopup, openView } from '../../stores/workspace'
import { normalizeMaPeriods } from '@shared/ma'
import type { KLineRangeStats } from '../../lib/chart-geometry'
import type { SmartDrawingPlan } from '@shared/patterns'
import { toneOf } from '../../lib/tone'
import { readTrendCache, writeTrendCache } from '../../lib/trend-cache'
import { KLineChart } from '../charts/KLineChart'
import { ChartSkeleton } from '../charts/ChartSkeleton'
import { TrendChart, type TrendHover } from '../charts/TrendChart'
import { IconRefresh } from '../atoms/Icons'
import { IndicatorSubchart, type SubIndicator } from '../charts/IndicatorSubchart'
import type { DrawingMode } from '../charts/KLineChart'

type Tab = 'minute' | 'five' | KLinePeriod

/** 统一成两种渲染模式：折线（分时/五日）与蜡烛（K 线） */
type ChartData = { kind: 'trend'; days: MinuteTrend[] } | { kind: 'kline'; series: KLineSeries }

const TABS: { key: Tab; label: string }[] = [
  { key: 'minute', label: '分时' },
  { key: 'five', label: '五日' },
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
  { key: 'quarter', label: '季K' },
  { key: 'year', label: '年K' }
]

const MINUTE_PERIODS: KLinePeriod[] = ['5s', '15s', '1m', '5m', '10m', '15m', '20m', '30m', '60m']

const EXT_PERIODS: Array<[KLinePeriod, string]> = [
  ['2m', '2分'],
  ['3m', '3分'],
  ['4m', '4分'],
  ['6m', '6分'],
  ['8m', '8分'],
  ['12m', '12分'],
  ['18m', '18分'],
  ['24m', '24分'],
  ['36m', '36分'],
  ['48m', '48分'],
  ['2d', '2日'],
  ['3d', '3日'],
  ['4d', '4日'],
  ['6d', '6日'],
  ['9d', '9日'],
  ['12d', '12日'],
  ['18d', '18日'],
  ['24d', '24日'],
  ['45d', '45日']
]

const MA_COLORS = ['#f0b429', '#5b8cff', '#c084fc', '#22d3ee', '#f472b6'] as const

const maLegend = (): Array<{ label: string; color: string }> =>
  normalizeMaPeriods(appState.settings.maPeriods).map((period, index) => ({
    label: `MA${period}`,
    color: MA_COLORS[index] ?? MA_COLORS[0]
  }))

/** K 线取多少根 —— 与缩放的最大档位一致：不可能显示比拉回来的更多 */
/** 一次请求 800 根历史：可见窗口最多 500 根，均线用完整 800 根计算。 */
const KLINE_COUNT = 800

export interface ChartPanelProps {
  code: string
  /** 切到分时/五日时通知外壳联动右侧逐笔 */
  onChartTabChange?: (tab: Tab) => void
}

export function ChartPanel(props: ChartPanelProps): JSX.Element {
  const [tab, setTab] = createSignal<Tab>(appState.settings.chartTab ?? 'minute')
  const [adjust, setAdjust] = createSignal<KLineAdjust>(appState.settings.klineAdjust ?? 'qfq')
  const [showBoll, setShowBoll] = createSignal(appState.settings.showBoll ?? false)
  const [showDrawings, setShowDrawings] = createSignal(appState.settings.showDrawings ?? false)
  const [showAverages, setShowAverages] = createSignal(appState.settings.showAverages ?? true)
  const [snapDrawings, setSnapDrawings] = createSignal(appState.settings.snapDrawings ?? true)
  const [drawMenuOpen, setDrawMenuOpen] = createSignal(false)
  const [subIndicator, setSubIndicator] = createSignal<'none' | SubIndicator>(
    appState.settings.subIndicator ?? 'none'
  )
  const [logScale, setLogScale] = createSignal(appState.settings.logScale ?? false)
  /*
   * 时段信号每秒重算，但只在「交易中/集合竞价/午休/收盘」切换时才通知下游；
   * 这样刷新间隔会跟着开盘收盘自动变化，又不会每秒重建推送订阅。
   */
  const liveSession = createMemo(() => marketSession(new Date(clockNow())))
  const marketDate = createMemo(() => shanghaiClock(new Date(clockNow())).date)
  const refreshMs = createMemo(() => chartRefreshMs(tab(), liveSession()))
  const [clearRangeKey, setClearRangeKey] = createSignal(0)
  const [smartPlans, setSmartPlans] = createSignal<SmartDrawingPlan[] | null>(null)
  const [smartLoading, setSmartLoading] = createSignal(false)
  const [smartError, setSmartError] = createSignal<string | null>(null)
  const [rangeStats, setRangeStats] = createSignal<KLineRangeStats | null>(null)
  const [rangeAnchor, setRangeAnchor] = createSignal<{ x: number; y: number } | null>(null)
  const [chartCardEl, setChartCardEl] = createSignal<HTMLElement | undefined>(undefined)
  const [drawMode, setDrawMode] = createSignal<DrawingMode>('none')
  const [drawingText, setDrawingText] = createSignal('标注')
  const [clearDrawingsKey, setClearDrawingsKey] = createSignal(0)
  const [undoDrawingsKey, setUndoDrawingsKey] = createSignal(0)
  const [redoDrawingsKey, setRedoDrawingsKey] = createSignal(0)
  const [pinned, setPinned] = createSignal(false)
  const [dividends, setDividends] = createSignal<Array<{ date: string; label: string }>>([])

  // 首屏可能在 state 落盘读取完成前创建，设置到达后再同步一次
  createEffect(() => {
    const savedTab = appState.settings.chartTab
    if (savedTab && savedTab !== tab()) setTab(savedTab)
  })
  createEffect(() => {
    const savedAdjust = appState.settings.klineAdjust
    if (savedAdjust && savedAdjust !== adjust()) setAdjust(savedAdjust)
  })
  createEffect(() => {
    const savedBoll = appState.settings.showBoll
    if (savedBoll !== undefined && savedBoll !== showBoll()) setShowBoll(savedBoll)
  })
  createEffect(() => {
    const savedDrawings = appState.settings.showDrawings
    if (savedDrawings !== undefined && savedDrawings !== showDrawings()) {
      setShowDrawings(savedDrawings)
    }
  })
  createEffect(() => {
    const savedAverages = appState.settings.showAverages
    if (savedAverages !== undefined && savedAverages !== showAverages()) {
      setShowAverages(savedAverages)
    }
  })
  createEffect(() => {
    const savedSnap = appState.settings.snapDrawings
    if (savedSnap !== undefined && savedSnap !== snapDrawings()) {
      setSnapDrawings(savedSnap)
    }
  })
  const chooseDrawMode = (mode: DrawingMode): void => {
    const next = drawMode() === mode ? 'none' : mode
    setDrawMode(next)
    if (next !== 'none' && !showDrawings()) {
      setShowDrawings(true)
      updateSettings({ showDrawings: true })
    }
    setDrawMenuOpen(false)
  }

  createEffect(() => {
    const saved = appState.settings.subIndicator
    if (saved && saved !== subIndicator()) setSubIndicator(saved)
  })
  createEffect(() => {
    const saved = appState.settings.logScale
    if (saved !== undefined && saved !== logScale()) setLogScale(saved)
  })
  const [pushed, setPushed] = createSignal<ChartData | null>(null)
  /** 主进程最近一次推送时间；让用户能确认「图确实在刷新」 */
  const [lastPushAt, setLastPushAt] = createSignal(0)
  const [hover, setHover] = createSignal<TrendHover | null>(null)
  const [subCursor, setSubCursor] = createSignal<number | null>(null)
  const [subWindow, setSubWindow] = createSignal({ start: 0, count: 0, width: 0 })

  /**
   * 用 memo 把 code 稳定下来。
   *
   * props.code 本身是响应式 getter，而父组件每 3 秒就会推来一个新的 quote 对象，
   * 直接读 props.code 会让 createResource 的 source 每次都「看起来变了」，
   * 导致图表每 3 秒重新拉一次数据。memo 默认做值比较，字符串没变就不会向下游传播。
   */
  const code = createMemo(() => props.code)
  const isTrend = (): boolean => tab() === 'minute' || tab() === 'five'
  /**
   * 分时图的「当前秒」轨迹。
   *
   * 官方分时接口一分钟才给一个点；这里把 1 秒一次的报价追加成一条
   * 临时折线，等官方点到达后由 TrendChart 过滤掉，既保证开盘第一秒有图，
   * 也不会污染历史数据。
   */
  const [liveTicks, setLiveTicks] = createSignal<LiveTrendTick[]>([])
  let liveTickKey = ''
  createEffect(
    on([code, () => tab(), marketDate], () => {
      setLiveTicks([])
      liveTickKey = ''
    })
  )
  createEffect(() => {
    const currentTab = tab()
    if (currentTab !== 'minute' && currentTab !== 'five') return
    const session = liveSession()
    if (session !== 'trading' && session !== 'pre-open') return
    const quote = quoteOf(code())
    if (!quote || !(quote.price > 0)) return
    const seconds = quoteTimeSeconds(quote)
    // 集合竞价也要从 09:15 开始刷新主图；09:15 之前没有撮合价，不画。
    if (seconds === null || seconds < 9 * 3600 + 15 * 60) return
    const key = `${seconds}:${quote.price}`
    if (key === liveTickKey) return
    liveTickKey = key
    const tick: LiveTrendTick = {
      timeSeconds: seconds,
      price: quote.price,
      avg: quote.avgPrice && quote.avgPrice > 0 ? quote.avgPrice : quote.price
    }
    // 分时实时段只保留「当前这一秒」：每次报价重画一条从最后官方分钟点
    // 到当前价的短线，而不是把一整天/一整分钟的 tick 叠成越来越粗的轨迹。
    setLiveTicks([tick])
  })
  const [cachedSeries, setCachedSeries] = createSignal<KLineSeries | null>(null)
  const [cachedTrend, setCachedTrend] = createSignal<{
    days: MinuteTrend[]
    savedAt: number
  } | null>(null)
  let cacheSequence = 0

  const [data, { refetch }] = createResource<
    ChartData,
    { code: string; tab: Tab; adjust: KLineAdjust }
  >(
    () => ({ code: code(), tab: tab(), adjust: adjust() }),
    async (source) => {
      const sequence = ++cacheSequence
      setCachedSeries(null)
      setCachedTrend(null)
      if (source.tab === 'five') {
        const cached = readTrendCache<MultiDayTrend>('five', source.code)
        if (cached && sequence === cacheSequence) {
          setCachedTrend({ days: cached.data.days, savedAt: cached.savedAt })
        }
        try {
          const multi = await api.trend.fiveDay(source.code)
          writeTrendCache('five', source.code, multi)
          if (sequence === cacheSequence) setCachedTrend(null)
          return { kind: 'trend', days: multi.days }
        } catch (error) {
          // 离线时先用上一帧快照，别把已经画出来的图换成错误页。
          if (cached) return { kind: 'trend', days: cached.data.days }
          throw error
        }
      }
      if (source.tab === 'minute') {
        const cached = readTrendCache<MinuteTrend>('minute', source.code)
        if (cached && sequence === cacheSequence) {
          setCachedTrend({ days: [cached.data], savedAt: cached.savedAt })
        }
        try {
          const trend = await api.trend.minute(source.code)
          writeTrendCache('minute', source.code, trend)
          if (sequence === cacheSequence) setCachedTrend(null)
          return { kind: 'trend', days: [trend] }
        } catch (error) {
          if (cached) return { kind: 'trend', days: [cached.data] }
          throw error
        }
      }
      /*
       * K 线首屏：先读本地缓存，再把网络请求排在它后面。
       *
       * 以前 cacheOnly 是单独 effect，createResource 的网络请求先发，本地读
       * 反而排在网络请求后面（启动时实测 3.1 秒）。放进 fetcher 后顺序固定，
       * 缓存一到就 setCachedSeries，图表不用等网络。
       */
      const cached = await api.trend
        .kline({
          code: source.code,
          period: source.tab,
          count: KLINE_COUNT,
          adjust: source.adjust,
          cacheOnly: true
        })
        .catch(() => null)
      /*
       * cacheOnly 在本地没有缓存时返回 miss + 空 bars（不再 reject）。
       * 空结果只是「首屏没有快照」，不能把它当成可回退的数据源，
       * 否则网络失败时会拿着一张空图冒充缓存。
       */
      const cachedBars = usableCachedSeries(cached)
      if (cachedBars && sequence === cacheSequence) setCachedSeries(cachedBars)
      try {
        return {
          kind: 'kline',
          series: await api.trend.kline({
            code: source.code,
            period: source.tab,
            count: KLINE_COUNT,
            adjust: source.adjust
          })
        }
      } catch (error) {
        // 离线时缓存就是唯一数据源；不要把已经画出来的图替换成错误页。
        if (cachedBars) return { kind: 'kline', series: cachedBars }
        throw error
      }
    }
  )

  createEffect(() => {
    const currentCode = code()
    const currentTab = tab()
    const currentAdjust = adjust()
    // 时段变化时重新订阅，刷新间隔随开盘/午休/收盘切换
    const interval = refreshMs()
    setPushed(null)
    setLastPushAt(0)
    const task =
      currentTab === 'minute'
        ? ({ kind: 'minute', code: currentCode } as const)
        : currentTab === 'five'
          ? ({ kind: 'fiveDay', code: currentCode } as const)
          : ({
              kind: 'kline',
              code: currentCode,
              period: currentTab,
              count: KLINE_COUNT,
              adjust: currentAdjust
            } as const)
    const dispose = subscribePush<MinuteTrend | MultiDayTrend | KLineSeries>(
      task,
      interval,
      (payload, update) => {
        if (code() !== currentCode || tab() !== currentTab) return
        setLastPushAt(update.at)
        if (currentTab === 'minute') {
          const trend = payload as MinuteTrend
          writeTrendCache('minute', currentCode, trend)
          setPushed({ kind: 'trend', days: [trend] })
        } else if (currentTab === 'five') {
          const multi = payload as MultiDayTrend
          writeTrendCache('five', currentCode, multi)
          setPushed({ kind: 'trend', days: multi.days })
        } else {
          // 首帧是全量，之后每秒只回最近 20 根；本地保留 800 根历史再合并
          setPushed({
            kind: 'kline',
            series: mergeKlineSeries(klineSeries(), payload as KLineSeries)
          })
        }
      }
    )
    onCleanup(dispose)
  })

  const trendDays = (): MinuteTrend[] | undefined => {
    const pushedData = pushed()
    if (pushedData?.kind === 'trend') return pushedData.days
    const current = data()
    if (current?.kind === 'trend') return current.days
    return cachedTrend()?.days
  }

  const klineSeries = (): KLineSeries | undefined => {
    const pushedData = pushed()
    if (pushedData?.kind === 'kline') return pushedData.series
    const current = data()
    if (current?.kind === 'kline') return current.series
    return cachedSeries() ?? undefined
  }

  /**
   * 显示用 K 线：在官方尾部数据之上，再用最新报价补当前秒的 close/high/low。
   * 官方 tail 一秒一次，报价也一秒一次；两者谁先到都不会让最后一根停在旧值。
   */
  const displaySeries = createMemo(() => {
    const series = klineSeries()
    if (!series || isTrend()) return series
    return applyLiveQuoteToKline(series, quoteOf(code()), tab() as KLinePeriod)
  })

  const rangeInfo = createMemo(() => {
    const stats = rangeStats()
    const series = displaySeries()
    if (!stats || !series) return null
    const from = Math.max(0, Math.min(series.bars.length - 1, Math.min(stats.start, stats.end)))
    const to = Math.max(0, Math.min(series.bars.length - 1, Math.max(stats.start, stats.end)))
    const first = series.bars[from]
    const last = series.bars[to]
    if (!first || !last) return null
    return {
      ...stats,
      startDate: first.date,
      endDate: last.date,
      open: first.open,
      close: last.close
    }
  })

  const rangeTooltipPos = createMemo(() => {
    const anchor = rangeAnchor()
    const rect = chartCardEl()?.getBoundingClientRect()
    if (!rect) return { left: 220, top: 160 }
    return {
      left: Math.max(
        8,
        Math.min((anchor?.x ?? rect.left + 220) - rect.left + 14, rect.width - 226)
      ),
      top: Math.max(8, Math.min((anchor?.y ?? rect.top + 160) - rect.top + 14, rect.height - 200))
    }
  })

  const isEmpty = (): boolean => {
    if (data.loading || data.error) return false
    const current = data()
    if (!current) return false
    if (current.kind === 'kline') return current.series.bars.length === 0
    return current.days.every((day) => day.points.length === 0)
  }

  /**
   * 开盘第一分钟不是「客户端没刷新」：通达信第一根分钟线在 09:31 才出现。
   * 把提示写清楚，避免用户以为行情断了（2026-11-03 实盘反馈）。
   */
  const emptyMessage = (): string => {
    const current = data()
    if (current && liveSession() === 'trading') {
      if (current.kind === 'trend' && tab() === 'minute') {
        return '开盘首分钟：通达信在 09:31 给出第一根分钟线'
      }
      if (current.kind === 'kline' && isIntradayPeriod(tab() as KLinePeriod)) {
        return '等待首根分钟 K 线（09:31 上屏）'
      }
    }
    return '暂无行情数据（可能停牌或尚未开盘）'
  }

  const runSmartDrawings = async (): Promise<void> => {
    if (smartLoading()) return
    setSmartLoading(true)
    setSmartError(null)
    try {
      const result = await api.data.patterns({
        code: props.code,
        period: tab(),
        adjust: adjust() as 'none' | 'qfq' | 'hfq',
        lookback: 160
      })
      setSmartPlans(result.plans)
      setShowDrawings(true)
      updateSettings({ showDrawings: true })
      setDrawMenuOpen(false)
    } catch (cause) {
      setSmartError(errorMessage(cause))
    } finally {
      setSmartLoading(false)
    }
  }

  /** 切 tab 或切股票时清掉残留的读数，避免显示上一只票的数值 */
  const exportSeries = (): void => {
    const series = klineSeries()
    if (series) {
      downloadText(
        `pythontdx-${props.code}-${series.period}.csv`,
        toCsv(
          [
            '日期',
            '开盘',
            '最高',
            '最低',
            '收盘',
            '成交量(手)',
            '成交额(元)',
            '上涨家数',
            '下跌家数'
          ],
          series.bars.map((bar) => [
            bar.date,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            bar.amount ?? '',
            bar.upCount ?? '',
            bar.downCount ?? ''
          ])
        )
      )
      return
    }
    const days = trendDays()
    if (!days) return
    const rows = days.flatMap((day) =>
      day.points.map((point) => [day.date, point.time, point.price, point.avg, point.volume])
    )
    downloadText(
      `pythontdx-${props.code}-${tab()}.csv`,
      toCsv(['日期', '时间', '价格', '均价', '成交量(手)'], rows)
    )
  }

  createEffect(() => {
    const code = props.code
    // 指数没有分红送转，也没有「除权」这件事。7615 的 F10 只按 6 位 symbol 查，
    // sh000001 会被当成 sz000001（平安银行），所以这里直接不发请求。
    if (isIndexCode(code)) {
      setDividends([])
      return
    }
    void api.f10
      .dividend(code)
      .then((table) => {
        const dateIndex = table.columns.indexOf('除权派息日')
        const planIndex = table.columns.indexOf('分红方案')
        if (dateIndex < 0) {
          setDividends([])
          return
        }
        setDividends(
          table.rows
            .map((row) => ({
              date: String(row[dateIndex] ?? ''),
              label: String(planIndex >= 0 ? (row[planIndex] ?? '除权除息') : '除权除息')
            }))
            .filter((item) => /^\d{4}-\d{2}-\d{2}/.test(item.date))
        )
      })
      .catch(() => setDividends([]))
  })

  const switchTab = (next: Tab): void => {
    setHover(null)
    setTab(next)
    updateSettings({ chartTab: next })
    props.onChartTabChange?.(next)
  }

  // 通达信 F5：分时/五日 ↔ 日 K。主窗口的快捷键只发事件，图表自己决定切到哪一档。
  onMount(() => {
    const toggle = (): void => {
      const current = tab()
      switchTab(current === 'minute' || current === 'five' ? 'day' : 'minute')
    }
    window.addEventListener('pythontdx:chart-toggle', toggle)
    onCleanup(() => window.removeEventListener('pythontdx:chart-toggle', toggle))
  })

  return (
    <section class="card chart-card" ref={setChartCardEl}>
      <div class="chart-card__head">
        <div class="chart-toolbar chart-toolbar--primary">
          <div class="segmented">
            <For each={TABS}>
              {(item) => (
                <button
                  class={`segmented__item chart-tab-${item.key}`}
                  data-active={tab() === item.key}
                  onClick={() => switchTab(item.key)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>

          <div class="chart-minute-tabs" aria-label="分钟 K 周期">
            <For each={MINUTE_PERIODS}>
              {(period) => (
                <button
                  class={`chart-minute-tab chart-tab-${period}`}
                  data-active={tab() === period}
                  title={period.endsWith('s') ? period : `${period.replace('m', '')} 分钟 K`}
                  onClick={() => switchTab(period)}
                >
                  {period.endsWith('s') ? period : period.replace('m', '')}
                </button>
              )}
            </For>
          </div>

          <Show when={!isTrend()}>
            <select
              class="chart-ext-select"
              value={EXT_PERIODS.some(([period]) => period === tab()) ? tab() : ''}
              aria-label="扩展周期"
              onChange={(event) => {
                const value = event.currentTarget.value
                if (value) switchTab(value as KLinePeriod)
              }}
            >
              <option value="">扩展</option>
              <For each={EXT_PERIODS}>
                {([period, label]) => <option value={period}>{label}</option>}
              </For>
            </select>
          </Show>

          <Show when={!isTrend()}>
            <select
              class="chart-sub-select"
              value={subIndicator()}
              aria-label="K 线副图"
              onChange={(event) => {
                const value = event.currentTarget.value as 'none' | SubIndicator
                setSubIndicator(value)
                updateSettings({ subIndicator: value })
              }}
            >
              <option value="none">副图</option>
              <option value="macd">MACD</option>
              <option value="kdj">KDJ</option>
              <option value="rsi">RSI</option>
              <option value="wr">WR</option>
              <option value="cci">CCI</option>
              <option value="bias">BIAS</option>
              <option value="dmi">DMI</option>
              <option value="obv">OBV</option>
              <option value="roc">ROC</option>
              <option value="psy">PSY</option>
              <option value="vr">VR</option>
              <option value="cr">CR</option>
              <option value="bbi">BBI</option>
              <option value="dma">DMA</option>
              <option value="trix">TRIX</option>
              <option value="sar">SAR</option>
            </select>
          </Show>
        </div>

        {/*
         * 工具 + 读数 + 操作共用一行：工具常驻排在 指标/公式/复盘 左侧，不折叠也不弹层。
         * 推送时间不再做成徽标常驻（用户 2026-11-14 觉得位置难看、且和行情头的
         * 「行情/接收」时间重复），改为挂在 ↻ 按钮的 title 里，需要时悬停就能看到。
         */}
        <div class="chart-headline">
          <Show when={!isTrend() && klineSeries()?.source === 'cache'}>
            <span class="chart-cache-badge" title={klineSeries()?.cachePath ?? '本地缓存'}>
              离线缓存
            </span>
          </Show>

          <Show when={isTrend() && cachedTrend()}>
            <span
              class="chart-cache-badge"
              title={`本地快照 ${timeOfDay(cachedTrend()?.savedAt ?? 0)}`}
            >
              离线缓存
            </span>
          </Show>

          <div class="chart-tools">
            {/* 指数没有复权概念，隐藏复权档位；否则点「前复权」看起来像生效了，其实没意义 */}
            <Show when={!isTrend() && !isIndexCode(props.code)}>
              <div class="chart-adjust-group">
                <For
                  each={[
                    { value: 'none' as KLineAdjust, label: '不复权' },
                    { value: 'qfq' as KLineAdjust, label: '前复权' },
                    { value: 'hfq' as KLineAdjust, label: '后复权' }
                  ]}
                >
                  {(item) => (
                    <button
                      class={`chip chart-adjust chart-adjust--${item.value}`}
                      data-active={adjust() === item.value}
                      onClick={() => {
                        setAdjust(item.value)
                        updateSettings({ klineAdjust: item.value })
                        setHover(null)
                      }}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={!isTrend()}>
              <button
                class="chip chart-ma"
                data-active={showAverages()}
                title="均线显示（默认开启）"
                onClick={() => {
                  const next = !showAverages()
                  setShowAverages(next)
                  updateSettings({ showAverages: next })
                }}
              >
                均线
              </button>
              <button
                class="chip chart-boll"
                data-active={showBoll()}
                title="布林线叠加（默认关闭）"
                onClick={() => {
                  const next = !showBoll()
                  setShowBoll(next)
                  updateSettings({ showBoll: next })
                }}
              >
                BOLL
              </button>
            </Show>

            <Show when={!isTrend()}>
              <button
                class="chip chart-log"
                data-active={logScale()}
                onClick={() => {
                  const next = !logScale()
                  setLogScale(next)
                  updateSettings({ logScale: next })
                }}
              >
                {logScale() ? '对数' : '线性'}
              </button>
            </Show>

            <Show when={!isTrend()}>
              <div class="chart-draw">
                <button
                  class="chip chart-draw-toggle"
                  data-active={showDrawings()}
                  title="画线：默认隐藏，打开后可选择工具"
                  onClick={() => setDrawMenuOpen((value) => !value)}
                >
                  画线
                </button>
                <Show when={drawMenuOpen()}>
                  <div class="chart-draw-menu">
                    <label class="chart-draw-menu__show">
                      <input
                        type="checkbox"
                        checked={showDrawings()}
                        onChange={(event) => {
                          const next = event.currentTarget.checked
                          setShowDrawings(next)
                          if (!next) setDrawMode('none')
                          updateSettings({ showDrawings: next })
                        }}
                      />
                      显示画线
                      <span class="chart-draw-menu__snap">
                        <input
                          type="checkbox"
                          checked={snapDrawings()}
                          onChange={(event) => {
                            const next = event.currentTarget.checked
                            setSnapDrawings(next)
                            updateSettings({ snapDrawings: next })
                          }}
                        />
                        吸附
                      </span>
                    </label>
                    <div class="chart-draw-menu__tools">
                      <button
                        class="chip chart-draw-horizontal"
                        data-active={drawMode() === 'horizontal'}
                        title="点击图表放置水平线"
                        onClick={() => chooseDrawMode('horizontal')}
                      >
                        水平
                      </button>
                      <button
                        class="chip chart-draw-vertical"
                        data-active={drawMode() === 'vertical'}
                        title="点击图表放置垂直线"
                        onClick={() => chooseDrawMode('vertical')}
                      >
                        垂线
                      </button>
                      <button
                        class="chip chart-draw-text"
                        data-active={drawMode() === 'text'}
                        title="输入文字后点击图表放置标注"
                        onClick={() => chooseDrawMode('text')}
                      >
                        文字
                      </button>
                      <button
                        class="chip chart-draw-trend"
                        data-active={drawMode() === 'trend'}
                        title="点两下画趋势线"
                        onClick={() => chooseDrawMode('trend')}
                      >
                        趋势
                      </button>
                      <button
                        class="chip chart-draw-measure"
                        data-active={drawMode() === 'measure'}
                        title="点两下测量涨跌幅与跨过的 K 线根数"
                        onClick={() => chooseDrawMode('measure')}
                      >
                        测量
                      </button>
                      <button
                        class="chip chart-draw-arrow"
                        data-active={drawMode() === 'arrow'}
                        title="点两下画箭头"
                        onClick={() => chooseDrawMode('arrow')}
                      >
                        箭头
                      </button>
                      <button
                        class="chip chart-draw-channel"
                        data-active={drawMode() === 'channel'}
                        title="点三下画平行通道：基线两点 + 偏移一点"
                        onClick={() => chooseDrawMode('channel')}
                      >
                        通道
                      </button>
                      <button
                        class="chip chart-draw-fib"
                        data-active={drawMode() === 'fib'}
                        title="点两下画斐波那契回撤"
                        onClick={() => chooseDrawMode('fib')}
                      >
                        斐波
                      </button>
                      <button
                        class="chip chart-draw-fib-ext"
                        data-active={drawMode() === 'fibExt'}
                        title="点两下画斐波那契扩展（含 127.2%/161.8%）"
                        onClick={() => chooseDrawMode('fibExt')}
                      >
                        扩展
                      </button>
                      <button
                        class="chip chart-draw-smart"
                        disabled={smartLoading()}
                        title="由 Python 识别主要摆动，自动画斐波那契、趋势线、通道和支撑/压力"
                        onClick={() => void runSmartDrawings()}
                      >
                        {smartLoading() ? '分析中…' : '智能'}
                      </button>
                    </div>
                    <Show when={smartError()}>
                      {(message) => <div class="chart-draw-menu__error">{message()}</div>}
                    </Show>
                    <div class="chart-draw-menu__foot">
                      <button
                        class="chip chart-draw-undo"
                        title="撤销画线操作（Ctrl+Z）"
                        onClick={() => setUndoDrawingsKey((value) => value + 1)}
                      >
                        撤销
                      </button>
                      <button
                        class="chip chart-draw-redo"
                        title="重做画线操作（Ctrl+Y / Ctrl+Shift+Z）"
                        onClick={() => setRedoDrawingsKey((value) => value + 1)}
                      >
                        重做
                      </button>
                      <button
                        class="chip chart-draw-clear"
                        title="清除所有画线"
                        onClick={() => setClearDrawingsKey((value) => value + 1)}
                      >
                        清线
                      </button>
                      <span>拖线体平移 · Ctrl+C/V 复制 · Delete 删除</span>
                    </div>
                    <Show when={drawMode() === 'text'}>
                      <input
                        class="chart-draw-text-input"
                        value={drawingText()}
                        maxlength="20"
                        placeholder="标注文字"
                        aria-label="标注文字"
                        onInput={(event) => setDrawingText(event.currentTarget.value)}
                      />
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={!isTrend()}>
              <button
                class="chip chart-range-toggle"
                title="清除区间统计选区"
                onClick={() => {
                  setRangeStats(null)
                  setRangeAnchor(null)
                  setClearRangeKey((value) => value + 1)
                }}
              >
                清除区间
              </button>
            </Show>
          </div>

          {/* 十字光标联动读数：有悬浮时显示读数，否则显示图例 */}
          <Show when={hover()}>
            {(current) => (
              <div class="chart-readout">
                <span class="chart-readout__time num">{current().label}</span>
                <span
                  class="chart-readout__price num"
                  style={{ color: `var(--${toneOf(current().changePct)})` }}
                >
                  {fixed(current().price)}
                </span>
                <span
                  class="chart-readout__pct num"
                  style={{ color: `var(--${toneOf(current().changePct)})` }}
                >
                  {signedPct(current().changePct)}
                </span>
                <span class="chart-readout__item">
                  均价 <b class="num">{fixed(current().avg)}</b>
                </span>
                <span class="chart-readout__item">
                  量 <b class="num">{thousands(current().volume)}</b> 手
                </span>
              </div>
            )}
          </Show>

          {/* 操作组靠右：左边留给工具，整行从左往右读 */}
          <div class="chart-headline__actions">
            <button
              class="btn btn--bare indicator-open"
              title="技术指标"
              onClick={() => openPopup('indicators')}
            >
              指标
            </button>
            <button
              class="btn btn--bare formula-open"
              title="指标公式预览"
              onClick={() => openPopup('formula')}
            >
              公式
            </button>
            <Show when={appState.settings.mainFormula}>
              <button
                class="btn btn--bare chart-formula-clear"
                title={`清除主图公式：${appState.settings.mainFormula}`}
                onClick={() => updateSettings({ mainFormula: undefined })}
              >
                清公式
              </button>
            </Show>
            <button
              class="btn btn--bare replay-open"
              title="日 K 复盘"
              onClick={() => openView('replay')}
            >
              复盘
            </button>
            <button
              class="btn btn--bare chart-pin"
              title="当前窗口置顶（再次点击取消）"
              data-active={pinned()}
              onClick={() => void shell.window.toggleAlwaysOnTop().then(setPinned)}
            >
              {pinned() ? '取消置顶' : '置顶'}
            </button>
            <button
              class="btn btn--bare chart-export"
              title="导出当前图表 CSV"
              onClick={exportSeries}
            >
              导出
            </button>
            <button
              class="btn btn--icon btn--bare"
              title={
                lastPushAt() > 0
                  ? `刷新图表数据（最近推送 ${timeOfDay(lastPushAt())}，间隔 ${Math.round(
                      refreshMs() / 1000
                    )} 秒）`
                  : '刷新图表数据'
              }
              onClick={() => void refetch()}
            >
              <IconRefresh size={13} />
            </button>
          </div>
        </div>
      </div>

      <Show when={rangeStats()}>
        <div
          class="chart-tooltip chart-range-stats"
          style={{
            position: 'absolute',
            left: `${rangeTooltipPos().left}px`,
            top: `${rangeTooltipPos().top}px`
          }}
        >
          <Show
            when={rangeInfo()}
            fallback={<div class="chart-tooltip__row">右键在 K 线上拖拽选择区间</div>}
          >
            {(info) => (
              <>
                <div class="chart-tooltip__row">
                  <span class="chart-tooltip__label">区间</span>
                  <span class="num">{info().bars} 根</span>
                </div>
                <div class="chart-tooltip__row">
                  <span class="chart-tooltip__label">日期</span>
                  <span class="num">
                    {info().startDate} ~ {info().endDate}
                  </span>
                </div>
                <div class="chart-tooltip__row">
                  <span class="chart-tooltip__label">涨跌幅</span>
                  <span
                    class="num"
                    classList={{
                      'tone-up': info().changePct > 0,
                      'tone-down': info().changePct < 0
                    }}
                  >
                    {signedPct(info().changePct)}
                  </span>
                </div>
                <div class="chart-tooltip__row">
                  <span class="chart-tooltip__label">开/高</span>
                  <span class="num">
                    {fixed(info().open)} / {fixed(info().high)}
                  </span>
                </div>
                <div class="chart-tooltip__row">
                  <span class="chart-tooltip__label">低/收</span>
                  <span class="num">
                    {fixed(info().low)} / {fixed(info().close)}
                  </span>
                </div>
                <div class="chart-tooltip__row">
                  <span class="chart-tooltip__label">成交量</span>
                  <span class="num">{thousands(info().volume)} 手</span>
                </div>
                <div class="chart-tooltip__row">
                  <span class="chart-tooltip__label">振幅</span>
                  <span class="num">{fixed(info().amplitude)}%</span>
                </div>
              </>
            )}
          </Show>
        </div>
      </Show>

      <div
        class="chart-card__body"
        classList={{
          'chart-card__body--sub': subIndicator() !== 'none' && displaySeries() !== undefined
        }}
      >
        <div class="chart-ma-overlay" classList={{ 'chart-ma-overlay--hidden': hover() !== null }}>
          <Show
            when={isTrend()}
            fallback={
              <Show when={showAverages()}>
                <For each={maLegend()}>
                  {(item) => (
                    <span class="chart-legend__item">
                      <span class="chart-legend__swatch" style={{ background: item.color }} />
                      {item.label}
                    </span>
                  )}
                </For>
              </Show>
            }
          >
            <span class="chart-legend__item">
              <span class="chart-legend__swatch" style={{ background: 'var(--accent)' }} />
              价格
            </span>
            <span class="chart-legend__item">
              <span class="chart-legend__swatch" style={{ background: 'var(--chart-avg)' }} />
              均价
            </span>
          </Show>
        </div>
        <Show
          when={!data.error}
          fallback={
            <div class="chart-empty">
              <div style={{ display: 'grid', gap: '10px', 'place-items': 'center' }}>
                <span style={{ color: 'var(--up)' }}>{errorMessage(data.error)}</span>
                <button class="btn" onClick={() => void refetch()}>
                  <IconRefresh size={12} />
                  重新加载
                </button>
              </div>
            </div>
          }
        >
          {/*
            首屏加载时给骨架屏；已经有数据时再刷新（data() 仍是旧值）就继续显示图表，
            避免每次定时刷新都闪一下白。
          */}
          <Show
            when={!data.loading || data() || cachedSeries() || cachedTrend()}
            fallback={<ChartSkeleton />}
          >
            <Show when={!isEmpty()} fallback={<div class="chart-empty">{emptyMessage()}</div>}>
              <Show when={trendDays()}>
                {(days) => <TrendChart days={days()} liveTicks={liveTicks()} onHover={setHover} />}
              </Show>
              <Show when={displaySeries()}>
                {(series) => (
                  <KLineChart
                    series={series()}
                    adjust={adjust() as 'none' | 'qfq' | 'hfq'}
                    boll={showBoll()}
                    showAverages={showAverages()}
                    bollPeriod={appState.settings.indicatorParams?.bollPeriod ?? 20}
                    bollK={appState.settings.indicatorParams?.bollK ?? 2}
                    logScale={logScale()}
                    clearRangeKey={clearRangeKey()}
                    smartPlans={smartPlans() ?? undefined}
                    onRangeStats={setRangeStats}
                    onRangeAnchor={setRangeAnchor}
                    onCursorChange={setSubCursor}
                    onWindowChange={setSubWindow}
                    drawMode={drawMode()}
                    showDrawings={showDrawings()}
                    snapDrawings={snapDrawings()}
                    overlayFormula={appState.settings.mainFormula}
                    dividends={dividends()}
                    clearDrawingsKey={clearDrawingsKey()}
                    undoDrawingsKey={undoDrawingsKey()}
                    redoDrawingsKey={redoDrawingsKey()}
                  />
                )}
              </Show>
              <Show when={subIndicator() !== 'none' ? displaySeries() : undefined}>
                {(series) => (
                  <IndicatorSubchart
                    bars={series().bars}
                    kind={subIndicator() as SubIndicator}
                    params={appState.settings.indicatorParams}
                    cursorIndex={subCursor()}
                    windowStart={subWindow().start}
                    windowCount={subWindow().count}
                    renderWidth={subWindow().width}
                  />
                )}
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  )
}
