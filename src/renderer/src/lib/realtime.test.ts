import { describe, expect, it } from 'vitest'
import type { KLineSeries, Quote } from '@shared/types'
import {
  applyLiveQuoteToKline,
  chartRefreshMs,
  isIntradayPeriod,
  liveBarLabel,
  mergeKlineSeries,
  multiRefreshMs,
  quoteTimeSeconds,
  tapeRefreshMs,
  tradingSlot,
  usableCachedSeries,
  withOpeningBaseline
} from './realtime'

const series = (bars: number, miss = false): KLineSeries => ({
  code: 'sh600519',
  period: 'day',
  bars: Array.from({ length: bars }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1
  })),
  miss
})

const quote = (patch: Partial<Quote> = {}): Quote => ({
  code: 'sh600519',
  symbol: '600519',
  name: '贵州茅台',
  market: 'SH',
  price: 1460,
  prevClose: 1450,
  open: 1451,
  high: 1462,
  low: 1449,
  change: 10,
  changePct: 0.69,
  volume: 1234,
  amount: 1,
  currency: 'CNY',
  time: Date.parse('2026-11-03T01:30:05Z'), // 北京时间 09:30:05
  receivedAt: Date.parse('2026-11-03T01:30:05Z'),
  updateTime: 93005,
  bids: [],
  asks: [],
  ...patch
})

describe('isIntradayPeriod', () => {
  it('秒线 / 分钟线属于盘中周期', () => {
    expect(isIntradayPeriod('5s')).toBe(true)
    expect(isIntradayPeriod('15s')).toBe(true)
    expect(isIntradayPeriod('1m')).toBe(true)
    expect(isIntradayPeriod('60m')).toBe(true)
  })

  it('日线及以上不是盘中周期', () => {
    expect(isIntradayPeriod('day')).toBe(false)
    expect(isIntradayPeriod('week')).toBe(false)
    expect(isIntradayPeriod('2d')).toBe(false)
  })
})

describe('chartRefreshMs', () => {
  it('交易时段所有分时/K 线都是 1 秒', () => {
    expect(chartRefreshMs('minute', 'trading')).toBe(1000)
    expect(chartRefreshMs('five', 'trading')).toBe(1000)
    expect(chartRefreshMs('1m', 'trading')).toBe(1000)
    expect(chartRefreshMs('day', 'trading')).toBe(1000)
  })

  it('集合竞价也是 1 秒', () => {
    expect(chartRefreshMs('minute', 'pre-open')).toBe(1000)
    expect(chartRefreshMs('1m', 'pre-open')).toBe(1000)
  })

  it('午休与收盘后降频，避免空转', () => {
    expect(chartRefreshMs('minute', 'lunch-break')).toBe(30_000)
    expect(chartRefreshMs('day', 'closed')).toBe(60_000)
    expect(chartRefreshMs('minute', 'weekend')).toBe(60_000)
    expect(chartRefreshMs('minute', 'holiday')).toBe(60_000)
  })
})

describe('tapeRefreshMs', () => {
  it('交易/竞价 1 秒，午休 30 秒，收盘后 60 秒', () => {
    expect(tapeRefreshMs('trading')).toBe(1000)
    expect(tapeRefreshMs('pre-open')).toBe(1000)
    expect(tapeRefreshMs('lunch-break')).toBe(30_000)
    expect(tapeRefreshMs('closed')).toBe(60_000)
    expect(tapeRefreshMs('weekend')).toBe(60_000)
    expect(tapeRefreshMs('holiday')).toBe(60_000)
  })
})

describe('multiRefreshMs', () => {
  it('交易时段九宫格分时和 K 线都是 1 秒', () => {
    expect(multiRefreshMs('minute', 'trading')).toBe(1000)
    expect(multiRefreshMs('day', 'trading')).toBe(1000)
  })

  it('非交易时段统一 60 秒', () => {
    expect(multiRefreshMs('minute', 'closed')).toBe(60_000)
    expect(multiRefreshMs('1m', 'lunch-break')).toBe(60_000)
  })
})

describe('分时槽位与报价时间', () => {
  it('09:30 是 0，11:30 是 120，15:00 是 240', () => {
    expect(tradingSlot(9 * 3600 + 30 * 60)).toBe(0)
    expect(tradingSlot(11 * 3600 + 30 * 60)).toBe(120)
    expect(tradingSlot(15 * 3600)).toBe(240)
  })

  it('优先使用 0x0547 的 updateTime，其次本地接收时间', () => {
    expect(quoteTimeSeconds(quote())).toBe(9 * 3600 + 30 * 60 + 5)
    expect(quoteTimeSeconds(quote({ updateTime: undefined }))).toBe(9 * 3600 + 30 * 60 + 5)
  })
})

describe('liveBarLabel', () => {
  it('日线只到日期，1 分钟线按分钟取整', () => {
    expect(liveBarLabel('day', quote())).toBe('2026-11-03')
    expect(liveBarLabel('1m', quote({ updateTime: 93059, time: Date.parse('2026-11-03T01:30:59Z') }))).toBe(
      '2026-11-03 09:30'
    )
    expect(liveBarLabel('5s', quote({ updateTime: 93057, time: Date.parse('2026-11-03T01:30:57Z') }))).toBe(
      '2026-11-03 09:30:55'
    )
  })
})

describe('applyLiveQuoteToKline', () => {
  /** 2026-11-03 是周二，09:30:05 属于交易时段 */
  const TRADING_NOW = new Date('2026-11-03T09:30:05+08:00')

  it('日线最后一根会被最新价更新', () => {
    const source: KLineSeries = {
      code: 'sh600519',
      period: 'day',
      bars: [{ date: '2026-11-03', open: 1450, high: 1455, low: 1448, close: 1455, volume: 100 }]
    }
    const next = applyLiveQuoteToKline(source, quote(), 'day', TRADING_NOW)
    expect(next.bars).toHaveLength(1)
    expect(next.bars[0].close).toBe(1460)
    expect(next.bars[0].high).toBe(1462)
    expect(next.bars[0].volume).toBe(1234)
  })

  it('09:30 没有官方分钟线时先造出第一根，后续官方 tail 会覆盖', () => {
    const next = applyLiveQuoteToKline(
      { code: 'sh600519', period: '1m', bars: [] },
      quote(),
      '1m',
      TRADING_NOW
    )
    expect(next.bars).toHaveLength(1)
    expect(next.bars[0].date).toBe('2026-11-03 09:30')
    expect(next.bars[0].close).toBe(1460)
  })

  it('周线不凭空追加新周期', () => {
    const source: KLineSeries = {
      code: 'sh600519',
      period: 'week',
      bars: [{ date: '2026-10-30', open: 1, high: 2, low: 1, close: 2, volume: 1 }]
    }
    const next = applyLiveQuoteToKline(source, quote(), 'week', TRADING_NOW)
    expect(next.bars).toHaveLength(1)
    expect(next.bars[0].close).toBe(1460)
  })

  it('周末不凭空追加一根日线', () => {
    // 2026-11-14 是周六；报价的 time 是本地接收时间，不能当作交易日。
    const source: KLineSeries = {
      code: 'sz301218',
      period: 'day',
      bars: [
        { date: '2026-11-12', open: 94, high: 94.59, low: 86, close: 86.6, volume: 1 },
        { date: '2026-11-13', open: 87.26, high: 103.92, low: 87.26, close: 99.86, volume: 1 }
      ]
    }
    const next = applyLiveQuoteToKline(
      source,
      quote({
        code: 'sz301218',
        price: 99.86,
        open: 87.26,
        high: 103.92,
        low: 87.26,
        volume: 236645,
        time: Date.parse('2026-11-14T01:40:41+08:00')
      }),
      'day',
      new Date('2026-11-14T01:40:41+08:00')
    )
    expect(next.bars).toHaveLength(2)
    expect(next.bars[1].date).toBe('2026-11-13')
  })

  it('交易日收盘后仍可补出当天日线', () => {
    const source: KLineSeries = {
      code: 'sz301218',
      period: 'day',
      bars: [{ date: '2026-11-12', open: 94, high: 94.59, low: 86, close: 86.6, volume: 1 }]
    }
    const next = applyLiveQuoteToKline(
      source,
      quote({
        code: 'sz301218',
        price: 99.86,
        time: Date.parse('2026-11-13T20:00:00+08:00')
      }),
      'day',
      new Date('2026-11-13T20:00:00+08:00')
    )
    expect(next.bars).toHaveLength(2)
    expect(next.bars[1].date).toBe('2026-11-13')
  })

  it('交易日开盘前不追加当天日线', () => {
    const source: KLineSeries = {
      code: 'sz301218',
      period: 'day',
      bars: [
        { date: '2026-11-13', open: 87.26, high: 103.92, low: 87.26, close: 99.86, volume: 1 }
      ]
    }
    const next = applyLiveQuoteToKline(
      source,
      quote({
        code: 'sz301218',
        price: 99.86,
        time: Date.parse('2026-11-16T08:30:00+08:00')
      }),
      'day',
      new Date('2026-11-16T08:30:00+08:00')
    )
    expect(next.bars).toHaveLength(1)
    expect(next.bars[0].date).toBe('2026-11-13')
  })
})

describe('mergeKlineSeries', () => {
  it('tail 按日期合并进全量，不丢历史也不重复', () => {
    const base = series(3)
    const incoming: KLineSeries = {
      code: 'sh600519',
      period: 'day',
      bars: [{ date: '2026-10-03', open: 2, high: 2, low: 2, close: 2, volume: 2 }],
      tail: true
    }
    const merged = mergeKlineSeries(base, incoming)
    expect(merged.bars).toHaveLength(3)
    expect(merged.bars[2].close).toBe(2)
    expect(merged.tail).toBe(false)
  })

  it('没有 tail 标记时直接使用新序列', () => {
    const incoming = series(2)
    expect(mergeKlineSeries(series(5), incoming)).toBe(incoming)
  })
})

describe('withOpeningBaseline', () => {
  it('开盘第一秒没有官方分钟点时补一个 09:30 基准点', () => {
    const days = [
      {
        code: 'sh600519',
        name: '贵州茅台',
        date: '2026-11-03',
        prevClose: 1450,
        points: []
      }
    ]
    const next = withOpeningBaseline(days, [{ timeSeconds: 34201, price: 1451, avg: 1451 }])
    expect(next[0].points).toHaveLength(1)
    expect(next[0].points[0]).toEqual({ time: '09:30', price: 1450, avg: 1450, volume: 0 })
  })

  it('官方点已经出现时不再注入，避免污染真实历史', () => {
    const days = [
      {
        code: 'sh600519',
        name: '贵州茅台',
        date: '2026-11-03',
        prevClose: 1450,
        points: [{ time: '09:31', price: 1451, avg: 1451, volume: 1 }]
      }
    ]
    expect(withOpeningBaseline(days, [{ timeSeconds: 34201, price: 1451, avg: 1451 }])).toBe(days)
  })
})

describe('usableCachedSeries', () => {
  it('有数据的缓存可以回退', () => {
    expect(usableCachedSeries(series(3))?.bars).toHaveLength(3)
  })

  it('cacheOnly 的 miss 不是数据源', () => {
    expect(usableCachedSeries(series(0, true))).toBeNull()
    expect(usableCachedSeries(series(0))).toBeNull()
    expect(usableCachedSeries(null)).toBeNull()
  })
})
