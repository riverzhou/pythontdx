/**
 * 实时 K 线推送的共用策略。
 *
 * 桌面把状态放在主进程，Web 把状态放在浏览器标签页里，但「首帧全量、每秒
 * 只取最近 20 根、每 60 秒补一次全量」的规则必须只有一份，否则两边迟早会
 * 各自漂移。这里只做纯计算，拉取方式与缓存容器都由调用方注入。
 */
import type { KLineAdjust, KLinePeriod, KLineSeries } from './types'

/** 每秒增量只取最近 20 根，避免 IPC/HTTP 每秒搬 800 根 */
export const KLINE_TAIL_COUNT = 20
/** 每 60 秒补一次全量，防止 20 根窗口被长时间运行甩开 */
export const KLINE_FULL_REFRESH_MS = 60_000

export interface LiveKlineRequest {
  code: string
  period: KLinePeriod
  count: number
  adjust: KLineAdjust
}

export interface LiveKlineState {
  series: KLineSeries
  fullAt: number
}

/** 按 `date` 合并 K 线；tail 只有最近 20 根，不能覆盖掉本地 800 根历史。 */
export function mergeBarLists(
  base: KLineSeries['bars'],
  incoming: KLineSeries['bars']
): KLineSeries['bars'] {
  const byDate = new Map(base.map((bar) => [bar.date, bar]))
  for (const bar of incoming) byDate.set(bar.date, bar)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function liveKlineKey(req: LiveKlineRequest, count: number): string {
  return `${req.code}:${req.period}:${count}:${req.adjust}`
}

/**
 * 每次推送要发的 K 线。
 *
 * `first` 由订阅方在首帧传 true；`fetchSeries(count, tail)` 中 tail=true 表示
 * 只取最近 20 根（调用方可据此放宽超时）。缓存由调用方提供，按标签页/进程隔离。
 */
export async function fetchLiveKline(
  req: LiveKlineRequest,
  first: boolean,
  fetchSeries: (count: number, tail: boolean) => Promise<KLineSeries>,
  store: Map<string, LiveKlineState>,
  now: number = Date.now()
): Promise<KLineSeries> {
  const count = Math.min(800, Math.max(1, Math.trunc(req.count)))
  const key = liveKlineKey(req, count)
  const cached = store.get(key)

  if (first || !cached || now - cached.fullAt >= KLINE_FULL_REFRESH_MS) {
    const series = await fetchSeries(count, false)
    store.set(key, { series, fullAt: now })
    return series
  }

  const tail = await fetchSeries(KLINE_TAIL_COUNT, true)
  const lastCached = cached.series.bars[cached.series.bars.length - 1]
  /*
   * tail 窗口 20 根；如果第一根都比本地最后一根新，说明已经超过 20 根没补，
   * 再合并就会出现一段空洞。直接重取全量。
   */
  if (tail.bars.length >= KLINE_TAIL_COUNT && lastCached && tail.bars[0].date > lastCached.date) {
    const series = await fetchSeries(count, false)
    store.set(key, { series, fullAt: now })
    return series
  }

  cached.series = {
    ...cached.series,
    bars: mergeBarLists(cached.series.bars, tail.bars)
  }
  store.set(key, cached)
  return {
    code: req.code,
    period: req.period,
    bars: tail.bars,
    source: 'network',
    tail: true
  }
}
