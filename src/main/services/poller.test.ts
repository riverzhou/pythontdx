import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Quote } from '@shared/types'
import { QuotePoller } from './poller'
import { fetchQuotes } from './tdx'

vi.mock('./tdx', () => ({ fetchQuotes: vi.fn() }))

const mockedFetch = vi.mocked(fetchQuotes)

function quote(code: string): Quote {
  return {
    code,
    symbol: code.slice(2),
    name: code,
    market: 'SH',
    price: 10,
    prevClose: 10,
    open: 10,
    high: 10,
    low: 10,
    change: 0,
    changePct: 0,
    volume: 1,
    amount: 10,
    currency: 'CNY',
    time: Date.now(),
    receivedAt: Date.now(),
    bids: [],
    asks: []
  }
}

describe('QuotePoller 生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockedFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('取消订阅会中止在途请求，且不会再被 finally 复活', async () => {
    let release: (quotes: Quote[]) => void = () => {}
    mockedFetch.mockImplementation(
      () =>
        new Promise<Quote[]>((resolve) => {
          release = resolve
        })
    )
    const emit = vi.fn()
    const poller = new QuotePoller({ emit })

    poller.setSubscription(['sh600519'], 1000)
    expect(mockedFetch).toHaveBeenCalledTimes(1)

    poller.setSubscription([], 1000)
    release([quote('sh600519')])
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(120_000)

    expect(mockedFetch).toHaveBeenCalledTimes(1)
    // 主动取消不算行情错误，不能推 error 帧
    expect(emit).not.toHaveBeenCalled()
  })

  it('订阅变化后按间隔继续轮询', async () => {
    mockedFetch.mockResolvedValue([quote('sh600519')])
    const emit = vi.fn()
    const poller = new QuotePoller({ emit })

    poller.setSubscription(['sh600519'], 1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)

    // 交易时段外会降频；把系统时间固定在交易时段
    vi.setSystemTime(new Date('2026-11-02T02:00:00Z'))
    poller.setSubscription(['sh600519'], 2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })
})
