/**
 * 行情轮询器。
 *
 * 为什么把定时器放在主进程而不是渲染进程？
 *  1. 渲染进程可能因为窗口最小化被 Chromium 节流，setInterval 会漂移；
 *  2. 主进程可以统一做「窗口不可见就停拉」「非交易时段降频」这类优化；
 *  3. 将来要多窗口/托盘常驻时，只需要一个数据源。
 */
import type { Quote, QuoteUpdate } from '@shared/types'
import { msUntilSessionChange, pollDelayMs } from '@shared/market'
import { fetchQuotes } from './tdx'

export interface QuotePollerOptions {
  /** 每拉到一帧（或失败）时回调 */
  emit: (update: QuoteUpdate) => void
  /** 返回 false 时跳过本次拉取（例如窗口被最小化） */
  canFetch?: () => boolean
}

export class QuotePoller {
  private codes: string[] = []
  private intervalMs = 3000
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private latest: Quote[] = []
  private abortController: AbortController | null = null
  /** 连续失败次数：用于断线后的快速重连退避 */
  private failures = 0
  /**
   * 是否有有效订阅。取消订阅/清空代码后，在途请求的 finally 不能再把定时器
   * 复活；否则 setSubscription([]) 之后仍会每 30 秒空转拉一次。
   */
  private active = false

  constructor(private readonly options: QuotePollerOptions) {}

  /** 最近一次成功拉取的数据 */
  get snapshot(): Quote[] {
    return this.latest
  }

  /**
   * 更新订阅集合。代码列表没变化时保持当前节奏，避免频繁重建定时器。
   */
  setSubscription(codes: string[], intervalMs: number): void {
    const nextCodes = [...new Set(codes.map((code) => code.trim().toLowerCase()).filter(Boolean))]
    const codesChanged = nextCodes.join(',') !== this.codes.join(',')
    const intervalChanged = intervalMs !== this.intervalMs

    this.codes = nextCodes
    this.intervalMs = Math.max(1000, intervalMs)
    this.active = nextCodes.length > 0

    if (!this.active) {
      this.stop()
      return
    }

    if (codesChanged) void this.refreshNow()
    if (codesChanged || intervalChanged || !this.timer) this.schedule()
  }

  /** 立即拉取一帧（用于「手动刷新」和订阅变更后的首帧） */
  async refreshNow(): Promise<Quote[]> {
    if (this.codes.length === 0) return this.latest
    await this.tick(true)
    return this.latest
  }

  stop(): void {
    this.active = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.abortController?.abort()
    this.abortController = null
  }

  /**
   * 交易时段用用户设置的间隔；盘后自动降频到 30 秒以上。
   */
  private effectiveInterval(): number {
    return pollDelayMs(this.intervalMs)
  }

  private schedule(delay?: number): void {
    if (!this.active) return
    if (this.timer) clearTimeout(this.timer)
    /*
     * 午休/收盘会把间隔降到 30 秒；如果低频定时器恰好在 12:59:30 之后
     * 才醒，13:00 开盘会被拖到 13:00:30 才恢复 1 秒推送。把下一次唤醒
     * 压在交易时段边界上（最多等 0.25 秒），开盘/集合竞价不再迟到。
     */
    const wait = delay ?? Math.min(this.effectiveInterval(), msUntilSessionChange() + 250)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick(false)
    }, wait)
  }

  private async tick(force: boolean): Promise<void> {
    if (!this.active || this.inFlight) return
    if (!force && this.options.canFetch && !this.options.canFetch()) {
      // 窗口不可见：跳过这一拍，但保持定时器继续走
      this.schedule()
      return
    }

    this.inFlight = true
    this.abortController = new AbortController()

    try {
      const quotes = await fetchQuotes(this.codes, this.abortController.signal)
      // 请求返回时订阅可能已经被取消；不要把旧结果推给界面。
      if (!this.active) return
      this.latest = quotes
      this.failures = 0
      this.options.emit({ quotes, at: Date.now() })
    } catch (error) {
      // 主动 stop() 会 abort 在途请求；这不是行情错误，不能推给界面。
      if (this.active) {
        const message = error instanceof Error ? error.message : String(error)
        this.failures += 1
        this.options.emit({ quotes: [], at: Date.now(), error: message })
      }
    } finally {
      this.inFlight = false
      this.abortController = null
      if (this.active) {
        // 断线后 1s/2s/4s/8s 快速重连；连续失败到 10s 后回到正常节奏。
        // 行情请求是只读的，重试不会产生交易副作用。
        const retryDelay =
          this.failures > 0 ? Math.min(1000 * 2 ** (this.failures - 1), 10_000) : undefined
        this.schedule(retryDelay)
      }
    }
  }
}
