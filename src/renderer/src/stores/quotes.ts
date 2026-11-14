/**
 * 行情数据流。
 *
 * 数据方向是「Python 调度、渲染层收」：
 *   渲染层只声明自己关心哪些代码、多久刷一次，
 *   真正的订阅调度在 Python SubscriptionHub（/ws 或 /api/stream）。
 */
import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { ConnectionStatus, Quote, QuoteUpdate } from '@shared/types'
import { api, errorMessage } from '../lib/client'
import { appState, renameWatchItem, watchItemOf } from './app'
import { scanAlerts } from './alerts'

const [quoteMap, setQuoteMap] = createStore<Record<string, Quote>>({})
const [connection, setConnection] = createSignal<ConnectionStatus>('idle')
const [lastUpdateAt, setLastUpdateAt] = createSignal(0)
const [streamError, setStreamError] = createSignal<string | null>(null)
const [pageVisible, setPageVisible] = createSignal(
  typeof document === 'undefined' || document.visibilityState !== 'hidden'
)

/** 上次行情快照：让重启后的首屏先显示上次数据，网络回来再覆盖。 */
const QUOTE_CACHE_KEY = 'pythontdx.quote-cache-v1'
let cacheSavedAt = 0

function readQuoteCache(): Quote[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(QUOTE_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Quote =>
            item && typeof item.code === 'string' && typeof item.price === 'number'
        )
      : []
  } catch {
    return []
  }
}

function saveQuoteCache(quotes: Quote[]): void {
  if (typeof localStorage === 'undefined') return
  const now = Date.now()
  if (now - cacheSavedAt < 2000) return
  cacheSavedAt = now
  try {
    localStorage.setItem(
      QUOTE_CACHE_KEY,
      JSON.stringify(quotes.slice(0, 200).map((quote) => ({ ...quote })))
    )
  } catch {
    // 私密模式/配额不足时静默放弃；网络行情仍可用。
  }
}

/** 启动时同步读取；不触发额外 IPC。 */
export function loadCachedQuotes(): Quote[] {
  return readQuoteCache()
}

export { quoteMap, connection, lastUpdateAt, streamError }

/** 取某只股票的行情快照 */
export function quoteOf(code: string | null | undefined): Quote | undefined {
  return code ? quoteMap[code] : undefined
}

/** 批量写入（主进程推送的一帧） */
export function applyQuotes(quotes: Quote[]): void {
  for (const quote of quotes) {
    setQuoteMap(quote.code, quote)

    // 名称纠偏：从搜索结果或手输代码加入的条目，名字可能只是占位符。
    // 代码表还没加载完时 quote.name 会退化成 6 位代码，不能拿它覆盖真实名称。
    const known = watchItemOf(quote.code)
    if (known && quote.name && !/^\d{6}$/.test(quote.name) && known.name !== quote.name) {
      renameWatchItem(quote.code, quote.name)
    }
  }
  saveQuoteCache(quotes)
}

/**
 * 订阅主进程推送。必须在组件的响应式作用域内调用一次。
 *
 * @param codes      关心的代码列表（响应式）
 * @param intervalMs 期望的刷新间隔（响应式）
 */
export function createQuoteStream(codes: Accessor<string[]>, intervalMs: Accessor<number>): void {
  const dispose = api.quote.onUpdate((update: QuoteUpdate) => {
    setLastUpdateAt(update.at)

    if (update.error) {
      // 失败时保留上一帧数据，只把状态标记为异常
      setStreamError(update.error)
      setConnection('error')
      return
    }

    setStreamError(null)
    applyQuotes(update.quotes)
    scanAlerts(update.quotes)
    setConnection('live')
  })

  onCleanup(dispose)

  if (typeof document !== 'undefined') {
    const onVisibility = (): void => {
      setPageVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', onVisibility)
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibility))
  }

  createEffect(() => {
    const list = codes()
    const interval = intervalMs()

    if (list.length === 0) {
      void api.quote.unsubscribe()
      setConnection('idle')
      return
    }
    if (appState.settings.pauseWhenHidden && !pageVisible()) {
      void api.quote.unsubscribe()
      setConnection('paused')
      return
    }

    setConnection((previous) => (previous === 'live' ? previous : 'connecting'))
    void api.quote.subscribe(list, interval).catch((error) => {
      setStreamError(errorMessage(error))
      setConnection('error')
    })
  })
}

/** 手动刷新一帧（状态栏的刷新按钮） */
export async function refreshQuotes(codes: string[]): Promise<void> {
  if (codes.length === 0) return
  try {
    const quotes = await api.quote.snapshot(codes)
    applyQuotes(quotes)
    scanAlerts(quotes)
    setStreamError(null)
    setConnection('live')
    setLastUpdateAt(Date.now())
  } catch (error) {
    setStreamError(errorMessage(error))
    setConnection('error')
  }
}
