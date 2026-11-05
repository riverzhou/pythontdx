import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketBreadth } from '@shared/types'
import {
  BREADTH_CLOSED_TTL_MS,
  BREADTH_LUNCH_TTL_MS,
  BREADTH_TRADING_TTL_MS,
  breadthTtlMs,
  createBreadthLoader
} from './breadth'

function breadth(up: number): MarketBreadth {
  return { up, down: 0, flat: 0, total: up, updatedAt: 0 }
}

describe('breadthTtlMs', () => {
  it('交易/竞价用短 TTL，午休次之，收盘最长', () => {
    expect(breadthTtlMs('trading')).toBe(BREADTH_TRADING_TTL_MS)
    expect(breadthTtlMs('pre-open')).toBe(BREADTH_TRADING_TTL_MS)
    expect(breadthTtlMs('lunch-break')).toBe(BREADTH_LUNCH_TTL_MS)
    expect(breadthTtlMs('closed')).toBe(BREADTH_CLOSED_TTL_MS)
    expect(breadthTtlMs('weekend')).toBe(BREADTH_CLOSED_TTL_MS)
  })
})

describe('createBreadthLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('TTL 内复用缓存，过期后重新扫描', async () => {
    const now = new Date('2026-11-05T10:00:00+08:00')
    const load = vi.fn(async () => breadth(load.mock.calls.length))
    const cached = createBreadthLoader({ ttlMs: () => 1000, now: () => now })

    const first = await cached(load)
    vi.advanceTimersByTime(500)
    expect(await cached(load)).toBe(first)

    vi.advanceTimersByTime(600)
    expect(await cached(load)).not.toBe(first)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('跨日强制失效，即使 TTL 未到期', async () => {
    let now = new Date('2026-11-05T23:59:00+08:00')
    const load = vi.fn(async () => breadth(1))
    const cached = createBreadthLoader({ ttlMs: () => 60_000, now: () => now })

    await cached(load)
    now = new Date('2026-11-06T00:00:30+08:00')
    await cached(load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('并发请求共享同一轮扫描', async () => {
    let release: (value: MarketBreadth) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<MarketBreadth>((resolve) => {
          release = resolve
        })
    )
    const cached = createBreadthLoader({ ttlMs: () => 60_000 })

    const first = cached(load)
    const second = cached(load)
    // loader 在微任务里执行，先让出一轮再断言
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)

    release(breadth(1))
    await expect(first).resolves.toEqual(breadth(1))
    await expect(second).resolves.toEqual(breadth(1))
  })

  it('失败不写缓存，下次请求会重试', async () => {
    const load = vi
      .fn<() => Promise<MarketBreadth>>()
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValueOnce(breadth(2))
    const cached = createBreadthLoader({ ttlMs: () => 60_000 })

    await expect(cached(load)).rejects.toThrow('scan failed')
    await expect(cached(load)).resolves.toEqual(breadth(2))
    expect(load).toHaveBeenCalledTimes(2)
  })
})
