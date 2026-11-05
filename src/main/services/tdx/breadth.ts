/**
 * 桌面端涨跌家数缓存。
 *
 * 整轮扫描要扫全市场 5000+ 只 A 股（约 70 次 0x054b 往返），耗时 3~7 秒。
 * 状态栏 30 秒轮询一次，收盘后数据根本不变，没有缓存就是整夜空转。
 * 与 Web 端 /api/market_breadth 保持同一套口径：
 *   · 交易/竞价 15 秒
 *   · 午休 120 秒
 *   · 收盘/周末 300 秒
 *   · 跨日强制失效（缓存 key 带北京时间日期）
 */
import { marketSession, shanghaiClock, type MarketSession } from '@shared/market'
import type { MarketBreadth } from '@shared/types'
import { TtlCache } from '../cache'

export const BREADTH_TRADING_TTL_MS = 15_000
export const BREADTH_LUNCH_TTL_MS = 120_000
export const BREADTH_CLOSED_TTL_MS = 300_000

export function breadthTtlMs(session: MarketSession): number {
  if (session === 'trading' || session === 'pre-open') return BREADTH_TRADING_TTL_MS
  if (session === 'lunch-break') return BREADTH_LUNCH_TTL_MS
  return BREADTH_CLOSED_TTL_MS
}

export interface BreadthCacheOptions {
  /** 默认按时段取 TTL；测试可注入固定值 */
  ttlMs?: () => number
  now?: () => Date
}

/**
 * @returns 带缓存与并发合并的加载函数：同一时刻最多只有一轮真实扫描。
 */
export function createBreadthLoader(
  options: BreadthCacheOptions = {}
): (load: () => Promise<MarketBreadth>) => Promise<MarketBreadth> {
  const ttlMs = options.ttlMs ?? (() => breadthTtlMs(marketSession()))
  const now = options.now ?? (() => new Date())
  const cache = new TtlCache<MarketBreadth>(ttlMs)
  return (load) => cache.resolve(shanghaiClock(now()).date, load)
}
