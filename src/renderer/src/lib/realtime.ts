/**
 * 图表实时刷新节奏与「最后一秒」合成。
 *
 * 2026-11-03 用户要求：所有分时、所有 K 线都必须是 1 秒级；开盘第一秒就要
 * 有分时线。协议的现实是：
 *   · 分时接口只有「每分钟一个点」，09:31 才给第一根；
 *   · K 线全量 800 根一秒拉一次会堵住串行 sidecar。
 *
 * 所以这里分成两件事：
 *   1. 推送节奏在交易时段统一 1 秒；
 *   2. 显示层用最新报价补「当前秒」的分时点 / K 线最后一根，
 *      官方数据到了再覆盖。这样既能 1 秒可见，又不会伪造历史。
 */
import type { KLineBar, KLinePeriod, KLineSeries, MinuteTrend, Quote } from '@shared/types'
import type { MarketSession } from '@shared/market'
import { shanghaiClock } from '@shared/market'
import { timeOfDay } from '@shared/format'

export type ChartTab = 'minute' | 'five' | KLinePeriod

/** 分时图上的「当前秒」点；官方分钟点到达后会被过滤掉 */
export interface LiveTrendTick {
  timeSeconds: number
  price: number
  avg: number
}

const INTRADAY_PERIOD = /^(5s|15s|\d+m)$/

export function isIntradayPeriod(period: KLinePeriod): boolean {
  return INTRADAY_PERIOD.test(period)
}

function isLive(session: MarketSession): boolean {
  return session === 'trading' || session === 'pre-open'
}

/** 交易/竞价 1 秒；午休 30 秒；收盘后 60 秒（数据已不再变化）。 */
function liveRefreshMs(session: MarketSession): number {
  if (isLive(session)) return 1000
  if (session === 'lunch-break') return 30_000
  return 60_000
}

/** 单主图：交易时段所有周期 1 秒；非交易时段降频。 */
export function chartRefreshMs(_tab: ChartTab, session: MarketSession): number {
  return liveRefreshMs(session)
}

/** 逐笔面板：收盘后逐笔不再变化，跟随主图一起降频。 */
export function tapeRefreshMs(session: MarketSession): number {
  return liveRefreshMs(session)
}

/** 多股同列：交易时段也是 1 秒；非交易时段统一 60 秒。 */
export function multiRefreshMs(
  _period: 'minute' | Exclude<KLinePeriod, '5s' | '15s'>,
  session: MarketSession
): number {
  return isLive(session) ? 1000 : 60_000
}

/** A 股分时横轴：09:30 为 0，11:30 为 120，15:00 为 240。 */
export function tradingSlot(timeSeconds: number): number {
  const open = 9 * 3600 + 30 * 60
  const noon = 11 * 3600 + 30 * 60
  const afternoon = 13 * 3600
  if (timeSeconds <= open) return 0
  if (timeSeconds <= noon) return (timeSeconds - open) / 60
  if (timeSeconds < afternoon) return 120
  return Math.min(240, 120 + (timeSeconds - afternoon) / 60)
}

/**
 * 官方第一根分钟线要等 09:31；09:30:00–09:31:00 用昨收造一个 09:30 基准点，
 * 让分时图先有坐标系，实时 tick 才有地方画。
 */
export function withOpeningBaseline(
  days: MinuteTrend[],
  ticks: readonly LiveTrendTick[]
): MinuteTrend[] {
  if (ticks.length === 0 || days.length === 0) return days
  const last = days[days.length - 1]
  if (!last || last.points.length > 0) return days
  const base = last.prevClose > 0 ? last.prevClose : ticks[0].price
  return [
    ...days.slice(0, -1),
    {
      ...last,
      points: [{ time: '09:30', price: base, avg: base, volume: 0 }]
    }
  ]
}

/** 从 Quote 里尽量拿交易所时间（HHMMSS），拿不到再用本地接收时间。 */
export function quoteTimeSeconds(quote: Quote): number | null {
  const raw = quote.updateTime
  if (raw && raw > 0 && raw <= 235959) {
    const text = String(Math.trunc(raw)).padStart(6, '0')
    const hour = Number(text.slice(0, 2))
    const minute = Number(text.slice(2, 4))
    const second = Number(text.slice(4, 6))
    if (hour <= 23 && minute <= 59 && second <= 59) {
      return hour * 3600 + minute * 60 + second
    }
  }
  const text = timeOfDay(quote.time)
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(text)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** 当前 K 线最后一根的日期标签；与 Python parse_bars 的格式保持一致。 */
export function liveBarLabel(period: KLinePeriod, quote: Quote): string {
  const clock = shanghaiClock(new Date(quote.time || Date.now()))
  const seconds = quoteTimeSeconds(quote)
  if (seconds === null || !isIntradayPeriod(period)) return clock.date

  const hour = Math.floor(seconds / 3600)
  const minute = Math.floor((seconds % 3600) / 60)
  const second = seconds % 60
  if (period === '5s' || period === '15s') {
    const step = period === '5s' ? 5 : 15
    const floored = Math.floor(second / step) * step
    return `${clock.date} ${pad(hour)}:${pad(minute)}:${pad(floored)}`
  }

  const step = Number(period.replace('m', ''))
  const totalMinutes = hour * 60 + minute
  const flooredMinutes = Math.floor(totalMinutes / step) * step
  return `${clock.date} ${pad(Math.floor(flooredMinutes / 60) % 24)}:${pad(flooredMinutes % 60)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 用最新报价补 K 线最后一根（或开盘第一秒的新 K 线）。
 *
 * 只改 close/high/low，日线额外用累计成交量；分钟线的成交量仍等官方 tail，
 * 避免把「累计量」错当成「单根量」。
 */
export function applyLiveQuoteToKline(
  series: KLineSeries,
  quote: Quote | undefined,
  period: KLinePeriod
): KLineSeries {
  if (!quote || !(quote.price > 0)) return series
  const price = quote.price
  const label = liveBarLabel(period, quote)
  const bars = series.bars
  if (bars.length === 0) {
    return {
      ...series,
      bars: [
        {
          date: label,
          open: quote.open > 0 ? quote.open : price,
          high: period === 'day' && quote.high > 0 ? Math.max(price, quote.high) : price,
          low: period === 'day' && quote.low > 0 ? Math.min(price, quote.low) : price,
          close: price,
          volume: period === 'day' ? quote.volume : 0,
          ...(period === 'day' ? { amount: quote.amount } : {})
        }
      ]
    }
  }

  const last = bars[bars.length - 1]
  const patch = (bar: KLineBar, volume?: number): KLineBar => {
    // 日线的 high/low 就是全天累计值，可以直接用报价；分钟线不能用，
    // 因为 quote.high/low 是全天最高/最低，不是这一根 K 线的。
    const high =
      period === 'day' ? Math.max(bar.high, price, quote.high > 0 ? quote.high : price) : Math.max(bar.high, price)
    const low =
      period === 'day' ? Math.min(bar.low, price, quote.low > 0 ? quote.low : price) : Math.min(bar.low, price)
    return {
      ...bar,
      close: price,
      high,
      low,
      ...(volume === undefined ? {} : { volume }),
      ...(period === 'day' ? { amount: quote.amount } : {})
    }
  }

  const canAppend = period === 'day' || isIntradayPeriod(period)
  if (last.date === label) {
    const next = bars.slice(0, -1)
    next.push(
        patch(
          last,
          period === 'day' ? quote.volume : undefined
        )
      )
    return { ...series, bars: next }
  }

  if (canAppend && last.date < label) {
    return {
      ...series,
      bars: [
        ...bars,
        {
          date: label,
          open: quote.open > 0 ? quote.open : price,
          high: period === 'day' && quote.high > 0 ? Math.max(price, quote.high) : price,
          low: period === 'day' && quote.low > 0 ? Math.min(price, quote.low) : price,
          close: price,
          volume: period === 'day' ? quote.volume : 0,
          ...(period === 'day' ? { amount: quote.amount } : {})
        }
      ]
    }
  }

  // 周/月/季/年与多日 K：只更新当前最后一根，不凭空造新周期
  const next = bars.slice(0, -1)
  next.push(patch(last))
  return { ...series, bars: next }
}

/**
 * 把推送回来的 tail 合并进本地全量序列。
 * 主进程每秒只发最近 20 根；渲染层保留 800 根历史，避免每秒传全量。
 */
export function mergeKlineSeries(
  base: KLineSeries | null | undefined,
  incoming: KLineSeries
): KLineSeries {
  if (!incoming.tail) return incoming
  if (!base || base.bars.length === 0) return incoming
  const byDate = new Map(base.bars.map((bar) => [bar.date, bar]))
  for (const bar of incoming.bars) byDate.set(bar.date, bar)
  return {
    ...base,
    bars: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    source: incoming.source ?? base.source,
    tail: false
  }
}

/**
 * 首屏缓存探测的可用性：miss 或空 bars 都不能当作「可以回退的旧图」。
 * 之前把 miss 当成数据源，网络失败时会用一张空图冒充缓存，控制台还会
 * 每次点击都打一条 IPC handler 异常。
 */
export function usableCachedSeries(series: KLineSeries | null | undefined): KLineSeries | null {
  if (!series || series.miss === true || series.bars.length === 0) return null
  return series
}
