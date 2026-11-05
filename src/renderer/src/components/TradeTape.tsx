/**
 * 成交明细（0x0fc5 当日 / 0x0fc6 历史）。
 *
 * 交易时段每 1 秒拉当日最近 60 笔，午休 30 秒、收盘后 60 秒；选历史日期后停轮询，改查 0x0fc6。
 * 竞价快照（status=8）不是成交，弱化显示，不参与金额。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { marketSession } from '@shared/market'
import type { TradeTick } from '@shared/types'
import { fixed, thousands } from '@shared/format'
import { mergeTickPage } from '@shared/trades'
import { api, errorMessage } from '../lib/ipc'
import { subscribePush } from '../lib/push'
import { tapeRefreshMs } from '../lib/realtime'
import { clockNow } from '../stores/clock'

interface TradeTapeProps {
  code: string
}

const PAGE_SIZE = 60

function TickList(props: {
  rows: TradeTick[]
  selected: number
  large?: boolean
  onSelect: (index: number) => void
  onOpen: () => void
}): JSX.Element {
  return (
    <div class="tape__rows" classList={{ 'tape__rows--large': props.large }}>
      <div class="tape__head">
        <span>时间</span>
        <span class="tape__num">价格</span>
        <span class="tape__num">量</span>
        <span class="tape__num tape__extra">笔数</span>
        <span class="tape__num tape__extra">金额</span>
        <span class="tape__side">方向</span>
      </div>
      <For each={props.rows}>
        {(tick, index) => (
          <div
            class="tape__row"
            classList={{
              'tape__row--auction': tick.eventKind === 'auction_snapshot',
              'tape__row--after': tick.status === 5,
              'tape__row--selected': index() === props.selected
            }}
            title={`${tick.time} · ${tick.orderCount} 笔 · ${
              tick.eventKind === 'opening_match' ? '开盘撮合' : tick.eventKind
            }`}
            onClick={() => props.onSelect(index())}
            onDblClick={props.onOpen}
          >
            <span class="tape__time num">{tick.time}</span>
            <span
              class="tape__price num"
              classList={{
                'tone-up': tick.side === 'buy',
                'tone-down': tick.side === 'sell'
              }}
            >
              {fixed(tick.price)}
            </span>
            <span class="tape__vol num">{thousands(tick.volume)}</span>
            <span class="tape__num tape__extra">{thousands(tick.orderCount)}</span>
            <span class="tape__num tape__extra">
              {tick.tradeAmount ? thousands(Math.round(tick.tradeAmount)) : '—'}
            </span>
            <span class="tape__side">
              {tick.eventKind === 'auction_snapshot'
                ? '竞价'
                : tick.status === 5
                  ? '盘后'
                  : tick.side === 'buy'
                    ? 'B'
                    : tick.side === 'sell'
                      ? 'S'
                      : '—'}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

export function TradeTape(props: TradeTapeProps): JSX.Element {
  const [ticks, setTicks] = createSignal<TradeTick[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [date, setDate] = createSignal('')
  const [expanded, setExpanded] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [loadingAll, setLoadingAll] = createSignal(false)
  const [allProgress, setAllProgress] = createSignal(0)
  const [hasMore, setHasMore] = createSignal(true)
  const [selected, setSelected] = createSignal(-1)
  const [large, setLarge] = createSignal(false)
  let panelRef: HTMLElement | undefined
  let requestId = 0
  let liveDispose: (() => void) | undefined
  const rows = createMemo(() => [...ticks()].reverse())
  // 收盘后逐笔不再变化：跟随主图从 1 秒降到 60 秒，避免空转请求。
  const liveSession = createMemo(() => marketSession(new Date(clockNow())))
  const refreshMs = createMemo(() => tapeRefreshMs(liveSession()))

  const isTyping = (event: KeyboardEvent): boolean => {
    const target = event.target as HTMLElement | null
    if (!target) return false
    return (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    )
  }

  const scrollSelected = (): void => {
    queueMicrotask(() => {
      for (const element of document.querySelectorAll('.tape__row--selected')) {
        element.scrollIntoView({ block: 'nearest' })
      }
    })
  }

  const moveSelection = (delta: number): void => {
    if (rows().length === 0) return
    setSelected((current) => {
      const next = current < 0 ? 0 : Math.min(rows().length - 1, Math.max(0, current + delta))
      return next
    })
    scrollSelected()
  }

  const onTapeKeys = (event: KeyboardEvent): void => {
    if (isTyping(event)) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    moveSelection(event.key === 'ArrowDown' ? 1 : -1)
  }

  const sameTicks = (next: TradeTick[]): boolean => {
    const current = ticks()
    if (current.length !== next.length) return false
    return next.every((tick, index) => {
      const previous = current[index]
      return (
        previous !== undefined &&
        previous.index === tick.index &&
        previous.time === tick.time &&
        previous.price === tick.price &&
        previous.volume === tick.volume &&
        previous.orderCount === tick.orderCount
      )
    })
  }

  const load = async (code: string, tradingDate = '', start = 0, silent = false): Promise<void> => {
    const current = ++requestId
    // 1 秒轮询是后台刷新：有数据时不要把“刷新中”写回界面，避免整块闪烁。
    if (!silent || ticks().length === 0) setLoading(true)
    try {
      const data = await api.trade.ticks({
        code,
        start,
        count: PAGE_SIZE,
        date: tradingDate || undefined
      })
      if (current !== requestId) return
      if (silent && sameTicks(data)) {
        setError(null)
        return
      }
      setTicks(data)
      setHasMore(data.length === PAGE_SIZE)
      setError(null)
    } catch (cause) {
      if (current !== requestId) return
      setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  let lastKey = ''
  createEffect(() => {
    const code = props.code
    const tradingDate = date()
    const intervalMs = refreshMs()
    // 只有代码/日期变化才重置交互状态；收盘降频重建订阅时保留用户选择。
    const key = `${code}@${tradingDate}`
    if (key !== lastKey) {
      lastKey = key
      setExpanded(false)
      setLarge(false)
      setSelected(-1)
    }
    liveDispose?.()
    liveDispose = undefined
    if (tradingDate) {
      void load(code, tradingDate, 0)
    } else {
      liveDispose = subscribePush<TradeTick[]>(
        { kind: 'ticks', code, start: 0, count: PAGE_SIZE },
        intervalMs,
        (data) => {
          setTicks(data)
          setHasMore(data.length === PAGE_SIZE)
          setLoading(false)
          setError(null)
        },
        (message) => {
          setLoading(false)
          setError(message)
        }
      )
    }
    onCleanup(() => {
      liveDispose?.()
      liveDispose = undefined
    })
  })

  const chooseDate = (value: string): void => {
    setDate(value)
    setTicks([])
    setSelected(-1)
    setExpanded(false)
    setLarge(false)
  }

  const openLarge = (): void => {
    setLarge(true)
    queueMicrotask(() => panelRef?.focus())
  }

  const loadAll = async (): Promise<void> => {
    if (loadingAll() || loadingMore() || ticks().length === 0) return
    liveDispose?.()
    liveDispose = undefined
    const current = ++requestId
    const tradingDate = date() || undefined
    setLoadingAll(true)
    setAllProgress(0)
    try {
      let all: TradeTick[] = []
      let offset = 0
      // 单页 1800 是 0x0fc5/0x0fc6 的上限；MAC 0x122F 单页 1000，
      // Python 侧会按 1800 拆成多页。循环到短页/重复页为止。
      for (let page = 0; page < 200; page += 1) {
        const data = await api.trade.ticks({
          code: props.code,
          start: offset,
          count: 1800,
          date: tradingDate
        })
        if (current !== requestId) return
        if (data.length === 0) break
        const merged = mergeTickPage(all, data)
        if (merged.added === 0) break
        // 服务端分页从新到旧；每次把更旧的一页拼到前面，最终保持时间正序。
        all = merged.ticks
        offset += data.length
        setAllProgress(all.length)
        if (data.length < 1800) break
      }
      if (current !== requestId) return
      setTicks(all)
      setExpanded(true)
      setHasMore(false)
      setError(null)
    } catch (cause) {
      if (current !== requestId) return
      setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoadingAll(false)
    }
  }

  const loadMore = async (): Promise<void> => {
    if (!hasMore() || loadingMore()) return
    liveDispose?.()
    liveDispose = undefined
    const current = ++requestId
    setLoadingMore(true)
    setExpanded(true)
    try {
      const data = await api.trade.ticks({
        code: props.code,
        start: ticks().length,
        count: PAGE_SIZE,
        date: date() || undefined
      })
      if (current !== requestId) return
      // 服务端较旧一页仍按时间正序；拼到当前页前面，整体保持正序
      setTicks([...data, ...ticks()])
      setHasMore(data.length === PAGE_SIZE)
      setError(null)
    } catch (cause) {
      if (current !== requestId) return
      setExpanded(false)
      setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoadingMore(false)
    }
  }

  const resetLatest = (): void => {
    setExpanded(false)
    void load(props.code, date(), 0)
  }

  return (
    <>
      <div
        class="tape"
        tabindex="0"
        aria-label="逐笔成交：上下键翻行，双击放大"
        onKeyDown={onTapeKeys}
        onClick={(event) => {
          const target = event.target as HTMLElement
          if (target.closest('input, button, select')) return
          event.currentTarget.focus()
        }}
      >
        <div class="tape__meta">
          <span>{ticks().length} 笔</span>
          <span>
            {expanded() ? '已展开' : date() ? '历史' : `每 ${Math.round(refreshMs() / 1000)} 秒`}
          </span>
        </div>

        <div class="tape__toolbar">
          <input
            class="tape__date"
            type="date"
            value={date()}
            aria-label="成交明细日期"
            title="选择日期查看历史逐笔"
            onChange={(event) => chooseDate(event.currentTarget.value)}
          />
          <Show when={date()}>
            <button
              class="tape__today"
              onClick={() => {
                chooseDate('')
              }}
            >
              回今天
            </button>
          </Show>
          <button
            class="tape__today tape__large"
            disabled={ticks().length === 0}
            onClick={openLarge}
          >
            放大
          </button>
          <Show
            when={expanded()}
            fallback={
              <>
                <button
                  class="tape__today tape__all"
                  disabled={loadingAll() || loadingMore() || ticks().length === 0}
                  onClick={() => void loadAll()}
                >
                  {loadingAll() ? `加载中 ${allProgress()}…` : '全部'}
                </button>
                <button
                  class="tape__today tape__more"
                  disabled={!hasMore() || loadingMore() || loadingAll() || ticks().length === 0}
                  onClick={() => void loadMore()}
                >
                  {loadingMore() ? '…' : hasMore() ? '更早' : '最早'}
                </button>
              </>
            }
          >
            <button class="tape__today tape__more" onClick={resetLatest}>
              最新
            </button>
          </Show>
        </div>

        <Show when={error()}>
          {(message) => (
            <div class="tape__error" role="alert">
              {message()}
              <button class="tape__retry" onClick={() => void load(props.code, date())}>
                重试
              </button>
            </div>
          )}
        </Show>

        <TickList rows={rows()} selected={selected()} onSelect={setSelected} onOpen={openLarge} />

        <Show when={!loading() && ticks().length === 0 && !error()}>
          <div class="tape__empty">
            {date() ? '该日暂无成交（非交易日或历史数据未就绪）' : '暂无成交'}
          </div>
        </Show>
      </div>

      <Portal>
        <Show when={large()}>
          <div class="tape-large-backdrop" onClick={() => setLarge(false)}>
            <section
              class="tape-large"
              role="dialog"
              aria-modal="true"
              aria-label="放大逐笔成交"
              tabindex="0"
              ref={(element) => {
                panelRef = element
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setLarge(false)
                  return
                }
                onTapeKeys(event)
              }}
            >
              <header class="tape-large__head">
                <div>
                  <div class="data__label">逐笔成交 · {props.code.toUpperCase()}</div>
                  <div class="data__sub">{ticks().length} 笔 · 上下键翻行 · 双击行可继续放大</div>
                </div>
                <div class="tape-large__actions">
                  <button
                    class="btn"
                    disabled={loadingAll() || ticks().length === 0}
                    onClick={() => void loadAll()}
                  >
                    {loadingAll() ? `加载中 ${allProgress()}…` : '全部'}
                  </button>
                  <button class="btn" onClick={resetLatest}>
                    最新
                  </button>
                  <button
                    class="btn btn--icon btn--bare"
                    title="关闭"
                    onClick={() => setLarge(false)}
                  >
                    ×
                  </button>
                </div>
              </header>
              <div class="tape-large__meta">
                <span>{date() || '今天'}</span>
                <span>
                  {selected() >= 0 ? `第 ${selected() + 1} / ${rows().length} 笔` : '未选中'}
                </span>
              </div>
              <TickList
                large
                rows={rows()}
                selected={selected()}
                onSelect={setSelected}
                onOpen={() => undefined}
              />
            </section>
          </div>
        </Show>
      </Portal>
    </>
  )
}
