/**
 * 多股同列：固定 3×3 九宫格，铺满窗口。
 *
 * 每一格都是真实 K 线（蜡烛 + 成交量 + MA5/10/20），不是收盘价折线：
 *   · 9 张图共用同一个「可见根数」，↑ 放大、↓ 缩小，不需要先点某张图；
 *   · 窗口永远贴住最后一根 K 线，右侧就是最新时间；
 *   · 周期只放基础档：日/周/月/60/30/15/5/1 分钟。
 * 纯展示，不引入第二套数据源。
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX
} from 'solid-js'
import type { KLineBar, KLinePeriod, KLineSeries, MinuteTrend, Quote } from '@shared/types'
import { compactVolume, fixed, timeOfDay, signedPct } from '@shared/format'
import { marketSession } from '@shared/market'
import { appState, moveWatchItem } from '../../stores/app'
import { quoteOf } from '../../stores/quotes'
import { clockNow } from '../../stores/clock'
import { api } from '../../lib/client'
import { subscribePush } from '../../lib/push'
import {
  applyLiveQuoteToKline,
  mergeKlineSeries,
  multiRefreshMs,
  quoteTimeSeconds,
  tradingSlot
} from '../../lib/realtime'
import { IconClose } from '../atoms/Icons'

interface MultiStockPanelProps {
  onClose: () => void
  onSelect: (code: string) => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}

type Period = 'minute' | 'day' | 'week' | 'month' | '60m' | '30m' | '15m' | '5m' | '1m'

const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'minute', label: '分时' },
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
  { key: '60m', label: '60分' },
  { key: '30m', label: '30分' },
  { key: '15m', label: '15分' },
  { key: '5m', label: '5分' },
  { key: '1m', label: '1分' }
]

/** 可见根数档位：↑ 往前一档（放大），↓ 往后一档（缩小） */
const ZOOM_LEVELS = [20, 26, 32, 40, 50, 60, 80, 100, 120, 160, 200, 260]
const DEFAULT_ZOOM = 5
const FETCH_COUNT = 320
/** A 股一天 240 个分钟点：分时横轴固定全天，不随已有数据缩短 */
const DAY_POINTS = 240
const PERIOD_LABEL: Record<Period, string> = {
  minute: '分时',
  day: '日线',
  week: '周线',
  month: '月线',
  '60m': '60分钟',
  '30m': '30分钟',
  '15m': '15分钟',
  '5m': '5分钟',
  '1m': '1分钟'
}

interface Card {
  code: string
  name: string
  market: string
  bars: KLineBar[]
  minute?: MinuteTrend
  quote?: Quote
  error?: string
}

interface MiniKlineProps {
  bars: KLineBar[]
  count: number
}

const W = 320
const H = 176
const PAD = 6
/** 右侧不留大缝：刻度紧贴图 */
const RIGHT_PAD = 2
const PRICE_H = 118
const VOL_TOP = 128
const VOL_H = 40

/** 小图内部的均线，不依赖全局设置，保证 9 张图一致 */
const MA_PERIODS = [5, 10, 20] as const
const MA_COLORS: Record<number, string> = { 5: '#f0b429', 10: '#5b8cff', 20: '#c084fc' }

function movingAveragePath(
  bars: KLineBar[],
  start: number,
  end: number,
  period: number,
  yOf: (price: number) => number,
  xOf: (index: number) => number
): string {
  const points: string[] = []
  for (let index = start; index < end; index += 1) {
    if (index + 1 < period) continue
    let sum = 0
    for (let back = 0; back < period; back += 1) sum += bars[index - back]?.close ?? 0
    points.push(
      `${points.length === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)} ${yOf(sum / period).toFixed(1)}`
    )
  }
  return points.join(' ')
}

/** 单格 K 线：蜡烛 + 量 + 三条均线，窗口右对齐到最新一根 */
function MiniKline(props: MiniKlineProps): JSX.Element {
  const view = () => {
    const bars = props.bars
    if (bars.length === 0) return null
    const count = Math.max(4, Math.min(props.count, bars.length))
    const start = bars.length - count
    const end = bars.length
    const visible = bars.slice(start, end)
    let min = Infinity
    let max = -Infinity
    let volMax = 0
    for (const bar of visible) {
      if (bar.low < min) min = bar.low
      if (bar.high > max) max = bar.high
      if (bar.volume > volMax) volMax = bar.volume
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    const span = max - min || Math.max(1, max * 0.01)
    const step = (W - PAD - RIGHT_PAD) / visible.length
    const body = Math.max(1, step * 0.62)
    const yOf = (price: number): number => PAD + (1 - (price - min) / span) * (PRICE_H - PAD * 2)
    const xOf = (index: number): number => PAD + (index - start + 0.5) * step
    const candles = visible.map((bar, offset) => {
      const index = start + offset
      const x = xOf(index)
      const up = bar.close >= bar.open
      const top = yOf(Math.max(bar.open, bar.close))
      const bottom = yOf(Math.min(bar.open, bar.close))
      return {
        x,
        wickTop: yOf(bar.high),
        wickBottom: yOf(bar.low),
        bodyTop: top,
        height: Math.max(1, bottom - top),
        up,
        volume: bar.volume
      }
    })
    const maPaths = MA_PERIODS.map((period) => ({
      period,
      d: movingAveragePath(bars, start, end, period, yOf, xOf)
    })).filter((item) => item.d.length > 0)
    const axisTicks = Array.from({ length: 5 }, (_, index) => ({
      value: max - ((max - min) * index) / 4,
      top: ((PAD + (index / 4) * (PRICE_H - PAD * 2)) / H) * 100
    }))
    return {
      start,
      end,
      visible,
      min,
      max,
      volMax,
      step,
      body,
      yOf,
      xOf,
      candles,
      maPaths,
      axisTicks
    }
  }

  return (
    <Show when={view()} fallback={<div class="multi-card__state">暂无 K 线</div>}>
      {(data) => (
        <div class="multi-card__plot">
          <svg
            class="multi-card__kline"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <For each={[0.25, 0.5, 0.75]}>
              {(ratio) => (
                <line
                  x1={PAD}
                  x2={W - RIGHT_PAD}
                  y1={PAD + ratio * (PRICE_H - PAD * 2)}
                  y2={PAD + ratio * (PRICE_H - PAD * 2)}
                  class="multi-kline__grid"
                />
              )}
            </For>
            <For each={data().candles}>
              {(candle) => (
                <g classList={{ 'multi-kline__up': candle.up, 'multi-kline__down': !candle.up }}>
                  <line
                    x1={candle.x}
                    x2={candle.x}
                    y1={candle.wickTop}
                    y2={candle.wickBottom}
                    class="multi-kline__wick"
                  />
                  <rect
                    x={candle.x - data().body / 2}
                    y={candle.bodyTop}
                    width={data().body}
                    height={candle.height}
                    class="multi-kline__body"
                  />
                </g>
              )}
            </For>
            <For each={data().maPaths}>
              {(path) => (
                <path
                  d={path.d}
                  fill="none"
                  stroke-width="1.1"
                  stroke={MA_COLORS[path.period]}
                  opacity="0.85"
                />
              )}
            </For>
            <For each={data().candles}>
              {(candle) => (
                <rect
                  x={candle.x - data().body / 2}
                  y={VOL_TOP + VOL_H - (candle.volume / (data().volMax || 1)) * VOL_H}
                  width={data().body}
                  height={Math.max(1, (candle.volume / (data().volMax || 1)) * VOL_H)}
                  classList={{
                    'multi-kline__volume-up': candle.up,
                    'multi-kline__volume-down': !candle.up
                  }}
                />
              )}
            </For>
          </svg>
          <div class="multi-card__axis">
            <For each={data().axisTicks}>
              {(tick) => (
                <span class="num" style={{ top: `${tick.top.toFixed(2)}%` }}>
                  {fixed(tick.value)}
                </span>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  )
}

/** 单格分时：价格线 + 均价线 + 量 + 昨收基准，右对齐到最新 */
function MiniMinute(props: {
  trend: MinuteTrend
  live?: { price: number; timeSeconds: number }
}): JSX.Element {
  const view = () => {
    const points = props.trend.points.slice(0, DAY_POINTS)
    if (points.length === 0 && !props.live) return null
    // 主站的 avg 字段是差分编码，不同股票/市场口径不一致；这里用「累计成交额/累计量」重算 VWAP
    const avgSeries: number[] = []
    let cumulativeVolume = 0
    let cumulativeAmount = 0
    for (const point of points) {
      cumulativeVolume += point.volume
      cumulativeAmount += point.price * point.volume
      avgSeries.push(cumulativeVolume > 0 ? cumulativeAmount / cumulativeVolume : point.price)
    }
    const visible = points.map((point, index) => ({
      ...point,
      avg: avgSeries[index] ?? point.price
    }))
    const base =
      props.trend.prevClose > 0
        ? props.trend.prevClose
        : (visible[0]?.price ?? props.live?.price ?? 0)
    let diff = 0
    let volMax = 0
    for (const point of visible) {
      diff = Math.max(diff, Math.abs(point.price - base), Math.abs(point.avg - base))
      if (point.volume > volMax) volMax = point.volume
    }
    // 分时以昨收为中心对称展开，0.00% 始终在中间，和官方一致
    diff = Math.max(diff, base * 0.004, 0.01)
    const min = base - diff
    const max = base + diff
    const span = max - min
    // 横轴固定 240 个交易分钟，未走完的部分留白；数据到了线才往前延伸
    const step = (W - PAD - RIGHT_PAD) / DAY_POINTS
    const yOf = (price: number): number => PAD + (1 - (price - min) / span) * (PRICE_H - PAD * 2)
    const xOf = (index: number): number => PAD + (index + 0.5) * step
    const pricePath = visible
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)} ${yOf(point.price).toFixed(1)}`
      )
      .join(' ')
    const avgPath = visible
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)} ${yOf(point.avg).toFixed(1)}`
      )
      .join(' ')
    const axisTicks = Array.from({ length: 5 }, (_, index) => {
      const value = max - (span * index) / 4
      return {
        value,
        pct: base > 0 ? ((value - base) / base) * 100 : 0,
        top: ((PAD + (index / 4) * (PRICE_H - PAD * 2)) / H) * 100
      }
    })
    const live =
      props.live && props.live.price > 0
        ? {
            x: PAD + Math.min(DAY_POINTS, tradingSlot(props.live.timeSeconds)) * step,
            y: yOf(props.live.price),
            startX: visible.length > 0 ? xOf(visible.length - 1) : PAD,
            startY: visible.length > 0 ? yOf(visible[visible.length - 1].price) : yOf(base)
          }
        : null
    return {
      visible,
      pricePath,
      avgPath,
      volMax,
      step,
      yOf,
      xOf,
      axisTicks,
      live,
      baseline: props.trend.prevClose > 0 ? yOf(props.trend.prevClose) : null
    }
  }

  return (
    <Show when={view()} fallback={<div class="multi-card__state">暂无分时</div>}>
      {(data) => (
        <div class="multi-card__plot">
          <svg
            class="multi-card__kline"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <For each={[60, 120, 180]}>
              {(index) => (
                <line
                  x1={PAD + ((index + 0.5) / DAY_POINTS) * (W - PAD - RIGHT_PAD)}
                  x2={PAD + ((index + 0.5) / DAY_POINTS) * (W - PAD - RIGHT_PAD)}
                  y1={PAD}
                  y2={VOL_TOP + VOL_H}
                  class="multi-min__time"
                />
              )}
            </For>
            <For each={[0.25, 0.5, 0.75]}>
              {(ratio) => (
                <line
                  x1={PAD}
                  x2={W - RIGHT_PAD}
                  y1={PAD + ratio * (PRICE_H - PAD * 2)}
                  y2={PAD + ratio * (PRICE_H - PAD * 2)}
                  class="multi-kline__grid"
                />
              )}
            </For>
            <Show when={data().baseline ?? undefined}>
              {(baseline) => (
                <line
                  x1={PAD}
                  x2={W - RIGHT_PAD}
                  y1={baseline()}
                  y2={baseline()}
                  class="multi-min__baseline"
                />
              )}
            </Show>
            <path d={data().avgPath} fill="none" stroke="#f0b429" stroke-width="1" opacity="0.85" />
            <path d={data().pricePath} fill="none" stroke="var(--accent)" stroke-width="1.2" />
            <Show when={data().live}>
              {(live) => (
                <g class="multi-min__live">
                  <path
                    d={`M${live().startX.toFixed(1)} ${live().startY.toFixed(
                      1
                    )} L${live().x.toFixed(1)} ${live().y.toFixed(1)}`}
                    fill="none"
                    stroke="var(--accent)"
                    stroke-width="1.2"
                  />
                  <circle cx={live().x} cy={live().y} r="2" fill="var(--accent)" />
                </g>
              )}
            </Show>
            <For each={data().visible}>
              {(point, index) => (
                <rect
                  x={PAD + index() * data().step + data().step * 0.2}
                  y={VOL_TOP + VOL_H - (point.volume / (data().volMax || 1)) * VOL_H}
                  width={Math.max(1, data().step * 0.6)}
                  height={Math.max(1, (point.volume / (data().volMax || 1)) * VOL_H)}
                  class="multi-min__volume"
                />
              )}
            </For>
          </svg>
          <div class="multi-card__axis multi-card__axis--minute">
            <For each={data().axisTicks}>
              {(tick) => (
                <span
                  class="num"
                  style={{ top: `${tick.top.toFixed(2)}%` }}
                  classList={{
                    'tone-up': tick.pct > 0.005,
                    'tone-down': tick.pct < -0.005
                  }}
                >
                  {signedPct(tick.pct)}
                </span>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  )
}

export function MultiStockPanel(props: MultiStockPanelProps): JSX.Element {
  const [period, setPeriod] = createSignal<Period>('minute')
  const [zoom, setZoom] = createSignal(DEFAULT_ZOOM)
  const [page, setPage] = createSignal(0)
  const [dragCode, setDragCode] = createSignal<string | null>(null)
  const [dropIndex, setDropIndex] = createSignal<number | null>(null)
  const [sourceId, setSourceId] = createSignal(appState.activeGroupId)
  const [cards, setCards] = createSignal<Card[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [updatedAt, setUpdatedAt] = createSignal(0)
  const liveSession = createMemo(() => marketSession(new Date(clockNow())))

  const sourceGroup = () =>
    appState.groups.find((group) => group.id === sourceId()) ?? appState.groups[0]
  const allItems = () => sourceGroup()?.items ?? []
  const pageCount = () => Math.max(1, Math.ceil(allItems().length / 9))
  const sourceItems = () => allItems().slice(page() * 9, page() * 9 + 9)
  const count = () => ZOOM_LEVELS[zoom()] ?? 60
  /** 只按代码序列重建九宫格，行情改名/报价对象变化不会让九张图重新订阅 */
  const codeKey = createMemo(() =>
    sourceItems()
      .map((item) => item.code)
      .join('|')
  )

  const applyCard = (code: string, patch: Partial<Card>): void => {
    setCards((current) =>
      current.map((card) => (card.code === code ? { ...card, ...patch } : card))
    )
  }

  /*
   * 九宫格实时刷新。
   *
   * 以前这里只 load 一次，开面板后所有图就冻住了；现在每张图各订阅一个
   * 主进程推送任务，按交易时段自动 3 秒（分时）/10 秒（K 线）刷新。
   * 周期、页码、来源、交易时段变化时整体重建订阅；卡片内部数据增量更新，
   * 不会让 9 张图一起闪骨架。
   */
  createEffect(
    on([codeKey, period, liveSession], () => {
      const items = sourceItems()
      const currentPeriod = period()
      const interval = multiRefreshMs(currentPeriod, liveSession())
      setCards(
        items.map((item) => ({
          code: item.code,
          name: item.name,
          market: item.market,
          bars: []
        }))
      )
      setLoading(items.length > 0)
      setError(null)
      setUpdatedAt(0)
      if (items.length === 0) {
        setLoading(false)
        return
      }

      const remaining = new Set(items.map((item) => item.code))
      const markLoaded = (code: string): void => {
        remaining.delete(code)
        if (remaining.size === 0) setLoading(false)
      }

      const disposers = items.map((item) =>
        subscribePush<MinuteTrend | KLineSeries>(
          currentPeriod === 'minute'
            ? { kind: 'minute', code: item.code }
            : {
                kind: 'kline',
                code: item.code,
                period: currentPeriod as KLinePeriod,
                count: FETCH_COUNT,
                adjust: appState.settings.klineAdjust ?? 'qfq'
              },
          interval,
          (payload, update) => {
            if (currentPeriod === 'minute') {
              applyCard(item.code, { minute: payload as MinuteTrend, error: undefined })
            } else {
              const incoming = payload as KLineSeries
              const card = cards().find((entry) => entry.code === item.code)
              const base: KLineSeries | null = card
                ? {
                    code: item.code,
                    period: currentPeriod as KLinePeriod,
                    bars: card.bars
                  }
                : null
              applyCard(item.code, {
                bars: mergeKlineSeries(base, incoming).bars,
                error: undefined
              })
            }
            setUpdatedAt(update.at)
            markLoaded(item.code)
          },
          (message) => {
            applyCard(item.code, { error: message })
            markLoaded(item.code)
          }
        )
      )

      // 顶部数据行的量比/换手仍来自 MAC 批量报价；只拉一次，不跟图表抢队列
      void api.quote
        .macQuotes(items.map((item) => item.code))
        .then((quotes) => {
          const byCode = new Map(quotes.map((quote) => [quote.code, quote]))
          for (const item of items) {
            const quote = byCode.get(item.code)
            if (quote) applyCard(item.code, { quote })
          }
        })
        .catch(() => {
          // 行情补字段失败不影响 K 线/分时主体
        })

      onCleanup(() => disposers.forEach((dispose) => dispose()))
    })
  )

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        props.onClose()
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        setPage((value) => {
          const next = event.key === 'ArrowLeft' ? value - 1 : value + 1
          return Math.max(0, Math.min(pageCount() - 1, next))
        })
        return
      }
      if (period() === 'minute') return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      setZoom((value) => {
        const next = event.key === 'ArrowUp' ? value - 1 : value + 1
        return Math.max(0, Math.min(ZOOM_LEVELS.length - 1, next))
      })
    }
    // 缩放窗口在面板级别监听：9 张图同步，不需要先聚焦某一张
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  return (
    <div
      class="multi-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="multi-panel"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="多股同列"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="multi__head">
          <div class="multi__titles">
            <div class="multi__eyebrow">
              九宫格 · {period() === 'minute' ? '分时全天' : `${count()} 根`} ·{' '}
              {sourceGroup()?.name ?? '自选'}
            </div>
            <h2 class="multi__title">多股同列</h2>
          </div>
          <select
            class="multi__source"
            aria-label="多股同列来源"
            value={sourceId()}
            onChange={(event) => {
              setSourceId(event.currentTarget.value)
              setPage(0)
            }}
          >
            <For each={appState.groups}>
              {(group) => <option value={group.id}>{group.name}</option>}
            </For>
          </select>
          <div class="multi__periods" role="tablist" aria-label="K 线周期">
            <For each={PERIODS}>
              {(item) => (
                <button
                  class={`multi__mode multi-period-${item.key}`}
                  data-active={period() === item.key}
                  onClick={() => setPeriod(item.key)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
          <Show when={pageCount() > 1}>
            <div class="multi__pager">
              <button
                class="multi__mode multi-page-prev"
                disabled={page() === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                ‹
              </button>
              <span class="multi__page">
                {page() + 1} / {pageCount()}
              </span>
              <button
                class="multi__mode multi-page-next"
                disabled={page() >= pageCount() - 1}
                onClick={() => setPage((value) => Math.min(pageCount() - 1, value + 1))}
              >
                ›
              </button>
            </div>
          </Show>
          <span class="multi__hint">↑↓ 缩放</span>
          <button
            class="btn btn--icon btn--bare"
            title="关闭多股同列"
            onClick={() => props.onClose()}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div class="multi__body">
          <Show when={!loading()} fallback={<div class="multi__empty">加载 9 只行情…</div>}>
            <Show when={!error()} fallback={<div class="multi__error">{error()}</div>}>
              <Show
                when={cards().length > 0}
                fallback={<div class="multi__empty">这个分组没有股票</div>}
              >
                <div class="multi__grid">
                  <For each={cards()}>
                    {(card, index) => {
                      const quote = () => quoteOf(card.code) ?? card.quote
                      const liveMinute = () => {
                        const current = quote()
                        if (!current || !(current.price > 0)) return undefined
                        const seconds = quoteTimeSeconds(current)
                        return seconds === null
                          ? undefined
                          : { price: current.price, timeSeconds: seconds }
                      }
                      const minutePoints = () => card.minute?.points ?? []
                      const minuteTrend = (): MinuteTrend =>
                        card.minute ?? {
                          code: card.code,
                          name: card.name,
                          date: '',
                          prevClose: quote()?.prevClose ?? 0,
                          points: []
                        }
                      /** 官方 tail 之外，再用 1 秒报价补最后一根 K 线 */
                      const liveBars = () => {
                        const current = quote()
                        if (period() === 'minute' || !current) return card.bars
                        return applyLiveQuoteToKline(
                          {
                            code: card.code,
                            period: period() as KLinePeriod,
                            bars: card.bars
                          },
                          current,
                          period() as KLinePeriod
                        ).bars
                      }
                      const lastPrice = () =>
                        period() === 'minute'
                          ? (minutePoints()[minutePoints().length - 1]?.price ?? 0)
                          : (liveBars()[liveBars().length - 1]?.close ?? 0)
                      const changePct = () => {
                        if (period() === 'minute') {
                          const points = minutePoints()
                          const tail = points[points.length - 1]
                          const base = card.minute?.prevClose ?? 0
                          return tail && base > 0 ? ((tail.price - base) / base) * 100 : 0
                        }
                        const bars = liveBars()
                        const tail = bars[bars.length - 1]
                        const prev = bars[bars.length - 2]
                        if (!tail || !prev || prev.close === 0) return 0
                        return ((tail.close - prev.close) / prev.close) * 100
                      }
                      const lastDate = () =>
                        period() === 'minute'
                          ? (card.minute?.date ?? '')
                          : (liveBars()[liveBars().length - 1]?.date ?? '')
                      const price = () => quote()?.price ?? lastPrice()
                      const change = () => quote()?.changePct ?? changePct()
                      const delta = () => {
                        const current = quote()
                        if (!current || current.prevClose <= 0) return '—'
                        const value = current.price - current.prevClose
                        return `${value >= 0 ? '▲' : '▼'}${Math.abs(value).toFixed(2)}`
                      }
                      const lastVolume = () =>
                        period() === 'minute'
                          ? (minutePoints()[minutePoints().length - 1]?.volume ?? 0)
                          : (liveBars()[liveBars().length - 1]?.volume ?? 0)
                      const turnover = () =>
                        quote()?.turnoverRate === undefined
                          ? '—'
                          : `${quote()!.turnoverRate!.toFixed(2)}%`
                      const ratio = () =>
                        quote()?.volumeRatio === undefined ? '—' : quote()!.volumeRatio!.toFixed(2)
                      const average = () =>
                        period() === 'minute'
                          ? fixed(
                              minutePoints()[minutePoints().length - 1]?.avg ?? quote()?.avgPrice
                            )
                          : '—'
                      return (
                        <button
                          class="multi-card"
                          classList={{
                            'multi-card--down': changePct() < 0,
                            'multi-card--dragging': dragCode() === card.code,
                            'multi-card--drop': dropIndex() === index()
                          }}
                          draggable={true}
                          title="拖动可调整多股同列顺序"
                          onDragStart={(event) => {
                            setDragCode(card.code)
                            event.dataTransfer?.setData('text/plain', card.code)
                            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragOver={(event) => {
                            if (!dragCode() || dragCode() === card.code) return
                            event.preventDefault()
                            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                            setDropIndex(index())
                          }}
                          onDragLeave={() => {
                            if (dropIndex() === index()) setDropIndex(null)
                          }}
                          onDrop={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            const code = dragCode() ?? event.dataTransfer?.getData('text/plain')
                            const groupId = sourceGroup()?.id
                            const target = page() * 9 + index()
                            setDragCode(null)
                            setDropIndex(null)
                            if (!code || !groupId || code === card.code) return
                            moveWatchItem(code, groupId, target)
                          }}
                          onDragEnd={() => {
                            setDragCode(null)
                            setDropIndex(null)
                          }}
                          onClick={() => {
                            props.onSelect(card.code)
                            props.onClose()
                          }}
                        >
                          <div class="multi-card__head" title={lastDate()}>
                            <span class="multi-card__name">{card.name}</span>
                            <span class="multi-card__period">{PERIOD_LABEL[period()]}</span>
                            <span class="multi-card__code num">{card.code.toUpperCase()}</span>
                          </div>
                          <div class="multi-card__quote">
                            <span class="multi-card__price num">{fixed(price())}</span>
                            <span
                              class="num"
                              classList={{
                                'tone-up': change() > 0,
                                'tone-down': change() < 0
                              }}
                            >
                              {signedPct(change())}
                            </span>
                            <span
                              class="num"
                              classList={{
                                'tone-up': change() > 0,
                                'tone-down': change() < 0
                              }}
                            >
                              {delta()}
                            </span>
                            <span>现量 {compactVolume(lastVolume())}</span>
                            <span>换手 {turnover()}</span>
                            <span>量比 {ratio()}</span>
                            <Show when={period() === 'minute'}>
                              <span>均价 {average()}</span>
                            </Show>
                          </div>
                          <div class="multi-card__chart">
                            <Show
                              when={
                                period() === 'minute'
                                  ? minutePoints().length > 0 || liveMinute() !== undefined
                                  : liveBars().length > 0
                              }
                              fallback={
                                <div class="multi-card__state">
                                  {card.error ?? (period() === 'minute' ? '暂无分时' : '暂无 K 线')}
                                </div>
                              }
                            >
                              <Show
                                when={period() === 'minute'}
                                fallback={<MiniKline bars={liveBars()} count={count()} />}
                              >
                                <MiniMinute trend={minuteTrend()} live={liveMinute()} />
                              </Show>
                            </Show>
                          </div>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </div>

        <footer class="multi__foot">
          <span>
            {period() === 'minute'
              ? '点击卡片切换主图 · 分时固定全天，不支持缩放'
              : '点击卡片切换主图 · ↑ 放大 / ↓ 缩小，9 张同步'}
          </span>
          <span>
            周期：{PERIODS.find((item) => item.key === period())?.label}
            <Show when={updatedAt() > 0}> · 更新 {timeOfDay(updatedAt())}</Show>
          </span>
        </footer>
      </section>
    </div>
  )
}
