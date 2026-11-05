import { describe, expect, it, vi } from 'vitest'
import {
  fetchLiveKline,
  KLINE_FULL_REFRESH_MS,
  KLINE_TAIL_COUNT,
  liveKlineKey,
  mergeBarLists,
  type LiveKlineState
} from './kline-live'
import type { KLineBar, KLineSeries } from './types'

function bar(date: string, close = 10): KLineBar {
  return { date, open: close, close, high: close, low: close, volume: 1 }
}

function series(bars: KLineBar[]): KLineSeries {
  return { code: 'sh600519', period: 'day', bars }
}

const REQUEST = { code: 'sh600519', period: 'day' as const, count: 800, adjust: 'qfq' as const }

describe('mergeBarLists', () => {
  it('按日期覆盖并按时间排序', () => {
    const merged = mergeBarLists(
      [bar('2026-11-03'), bar('2026-11-04')],
      [bar('2026-11-04', 11), bar('2026-11-05', 12)]
    )
    expect(merged.map((item) => item.date)).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-05'
    ])
    expect(merged[1]?.close).toBe(11)
  })
})

describe('fetchLiveKline', () => {
  it('首帧取全量并写入缓存', async () => {
    const store = new Map<string, LiveKlineState>()
    const fetchSeries = vi.fn(async () => series([bar('2026-11-04')]))
    const result = await fetchLiveKline(REQUEST, true, fetchSeries, store, 1000)
    expect(fetchSeries).toHaveBeenCalledWith(800, false)
    expect(result.bars).toHaveLength(1)
    expect(store.get(liveKlineKey(REQUEST, 800))?.fullAt).toBe(1000)
  })

  it('60 秒内只取 tail 并合并进全量缓存', async () => {
    const store = new Map<string, LiveKlineState>()
    store.set(liveKlineKey(REQUEST, 800), {
      series: series([bar('2026-11-03'), bar('2026-11-04')]),
      fullAt: 1000
    })
    const fetchSeries = vi.fn(async () =>
      series([bar('2026-11-04', 11), bar('2026-11-05', 12)])
    )
    const result = await fetchLiveKline(REQUEST, false, fetchSeries, store, 2000)
    expect(fetchSeries).toHaveBeenCalledWith(KLINE_TAIL_COUNT, true)
    expect(result.tail).toBe(true)
    expect(result.bars.map((item) => item.date)).toEqual(['2026-11-04', '2026-11-05'])
    // 缓存里保留历史，只更新尾部
    const cached = store.get(liveKlineKey(REQUEST, 800))
    expect(cached?.series.bars.map((item) => item.date)).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-05'
    ])
  })

  it('tail 首根晚于缓存末根时判定断层，重取全量', async () => {
    const store = new Map<string, LiveKlineState>()
    store.set(liveKlineKey(REQUEST, 800), {
      series: series([bar('2026-11-01'), bar('2026-11-02')]),
      fullAt: 1000
    })
    // tail 必须满 20 根才可能断层；第一根已经比缓存末根新，说明中间漏了一段
    const tailBars = Array.from({ length: KLINE_TAIL_COUNT }, (_, index) =>
      bar(`2026-11-${String(index + 3).padStart(2, '0')}`)
    )
    const fetchSeries = vi
      .fn<(count: number, tail: boolean) => Promise<KLineSeries>>()
      .mockResolvedValueOnce(series(tailBars))
      .mockResolvedValueOnce(series([bar('2026-11-01'), bar('2026-11-03')]))
    const result = await fetchLiveKline(REQUEST, false, fetchSeries, store, 2000)
    expect(fetchSeries).toHaveBeenCalledTimes(2)
    expect(fetchSeries).toHaveBeenLastCalledWith(800, false)
    expect(result.tail).toBeUndefined()
    expect(store.get(liveKlineKey(REQUEST, 800))?.series.bars).toHaveLength(2)
  })

  it('超过 60 秒重新取全量', async () => {
    const store = new Map<string, LiveKlineState>()
    store.set(liveKlineKey(REQUEST, 800), {
      series: series([bar('2026-11-04')]),
      fullAt: 1000
    })
    const fetchSeries = vi.fn(async () => series([bar('2026-11-05')]))
    await fetchLiveKline(REQUEST, false, fetchSeries, store, 1000 + KLINE_FULL_REFRESH_MS)
    expect(fetchSeries).toHaveBeenCalledWith(800, false)
  })

  it('count 钳制在 1~800，缓存键使用钳制后的值', async () => {
    const store = new Map<string, LiveKlineState>()
    const fetchSeries = vi.fn(async () => series([]))
    await fetchLiveKline({ ...REQUEST, count: 5000 }, true, fetchSeries, store, 1000)
    expect(fetchSeries).toHaveBeenCalledWith(800, false)
    expect(store.has(liveKlineKey(REQUEST, 800))).toBe(true)
  })
})
