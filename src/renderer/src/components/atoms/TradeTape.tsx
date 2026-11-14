/**
 * 成交明细（0x0fc5 当日 / 0x0fc6 历史）。
 *
 * 交易时段每 1 秒拉当日最近 60 笔，午休 30 秒、收盘后 60 秒；选历史日期后停轮询，改查 0x0fc6。
 * 竞价快照（status=8）不是成交，弱化显示，不参与金额。
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX
} from 'solid-js'
import { marketSession } from '@shared/market'
import type { TradeTick } from '@shared/types'
import { fixed, thousands } from '@shared/format'
import { mergeTickPage } from '@shared/trades'
import { api, errorMessage } from '../../lib/client'
import { subscribePush } from '../../lib/push'
import { tapeRefreshMs } from '../../lib/realtime'
import { clockNow } from '../../stores/clock'
import { openView } from '../../stores/workspace'

interface TradeTapeProps {
  code: string
  /** 主区「逐笔明细」标签里不再重复显示“放大”入口 */
  showExpand?: boolean
  /**
   * rail  = 右栏 60 笔（默认）
   * board = 主区整页：自动载入全天、按列铺开、跟随最新（自动滚屏）
   */
  variant?: 'rail' | 'board'
}

/** 方向列文案：竞价快照与盘后成交不是普通买卖 */
function sideLabel(tick: TradeTick): string {
  if (tick.eventKind === 'auction_snapshot') return '竞价'
  if (tick.status === 5) return '盘后'
  if (tick.side === 'buy') return 'B'
  if (tick.side === 'sell') return 'S'
  return '—'
}

/**
 * 逐笔的颜色语义（与全 App 的「红涨绿跌」一致）：
 *   buy 红 / sell 绿 / auction 紫（虚拟撮合）/ after 灰（盘后）/ neutral 灰。
 * 价格、方向徽标、行左侧色条都用这一套，不再各处自己判断颜色。
 */
type TickTone = 'buy' | 'sell' | 'auction' | 'after' | 'neutral'

function tickTone(tick: TradeTick): TickTone {
  if (tick.eventKind === 'auction_snapshot') return 'auction'
  if (tick.status === 5) return 'after'
  if (tick.side === 'buy') return 'buy'
  if (tick.side === 'sell') return 'sell'
  return 'neutral'
}

const PAGE_SIZE = 60

function TickList(props: {
  rows: TradeTick[]
  selected: number
  onSelect: (index: number) => void
}): JSX.Element {
  /** 与整页逐笔同一套分档：≥90 分位是大单、≥50 分位是中单 */
  const volumeTiers = createMemo(() => {
    const values = props.rows
      .map((tick) => tick.volume)
      .filter((value) => value > 0)
      .sort((a, b) => a - b)
    if (values.length < 10) return { mid: Number.POSITIVE_INFINITY, big: Number.POSITIVE_INFINITY }
    return {
      mid: values[Math.floor(values.length * 0.5)],
      big: values[Math.floor(values.length * 0.9)]
    }
  })

  const volumeClass = (volume: number): string => {
    if (volume <= 0) return ''
    if (volume >= volumeTiers().big) return 'tape__vol--big'
    if (volume >= volumeTiers().mid) return 'tape__vol--mid'
    return ''
  }

  return (
    <div class="tape__rows">
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
            <span class={`tape__vol num ${volumeClass(tick.volume)}`}>
              {thousands(tick.volume)}
            </span>
            <span class="tape__num tape__extra">{thousands(tick.orderCount)}</span>
            <span class="tape__num tape__extra">
              {tick.tradeAmount ? thousands(Math.round(tick.tradeAmount)) : '—'}
            </span>
            <span class={`tape__side tape__side--${tickTone(tick)}`}>{sideLabel(tick)}</span>
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
  let requestId = 0
  let liveDispose: (() => void) | undefined
  const rows = createMemo(() => [...ticks()].reverse())
  const isBoard = (): boolean => props.variant === 'board'

  /* ------------------------------------------------------ 整页逐笔（board） */
  let boardScroller: HTMLDivElement | undefined
  const [boardCols, setBoardCols] = createSignal(4)
  const [autoFollow, setAutoFollow] = createSignal(true)

  /** 整页视图的列：把「最新 → 最旧」的序列按列切开，一屏看到更多笔 */
  const boardColumns = createMemo(() => {
    const list = rows()
    const cols = Math.max(1, boardCols())
    if (list.length === 0) return []
    const per = Math.ceil(list.length / cols)
    const out: TradeTick[][] = []
    for (let start = 0; start < list.length; start += per) {
      out.push(list.slice(start, start + per))
    }
    return out
  })

  /** 成交量分档：≥90 分位算大单，≥50 分位算中单，用来给整页逐笔上色 */
  const volumeTiers = createMemo(() => {
    const values = ticks()
      .map((tick) => tick.volume)
      .filter((value) => value > 0)
      .sort((a, b) => a - b)
    if (values.length < 20) return { mid: Number.POSITIVE_INFINITY, big: Number.POSITIVE_INFINITY }
    return {
      mid: values[Math.floor(values.length * 0.5)],
      big: values[Math.floor(values.length * 0.9)]
    }
  })

  const volumeClass = (volume: number): string => {
    if (volume <= 0) return ''
    if (volume >= volumeTiers().big) return 'tape-col__vol--big'
    if (volume >= volumeTiers().mid) return 'tape-col__vol--mid'
    return ''
  }

  /** 新一页（start=0，最新）按 index 去重后追加到尾部：序列始终时间正序 */
  const appendLatest = (current: TradeTick[], page: TradeTick[]): TradeTick[] => {
    const seen = new Set(current.map((tick) => tick.index))
    const fresh = page.filter((tick) => !seen.has(tick.index))
    return fresh.length > 0 ? [...current, ...fresh] : current
  }

  // 新数据到达时钉住最新：整页是「最新在左上」，scrollTop=0 就是跟随。
  createEffect(
    on(ticks, () => {
      if (isBoard() && autoFollow() && boardScroller) boardScroller.scrollTop = 0
    })
  )
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
      setSelected(-1)
    }
    liveDispose?.()
    liveDispose = undefined
    if (isBoard()) {
      void loadBoard(code, tradingDate, intervalMs)
      onCleanup(() => {
        liveDispose?.()
        liveDispose = undefined
      })
      return
    }
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

  /**
   * 整页逐笔：一次翻完全天（1800/页，直到短页），然后盘中只接最新一页合并。
   * 与 rail 的 loadAll 区别：它会订阅最新页、把新成交追加到已有序列，保证
   * 整页视图在交易时段也是活的，而不是停在你点开那一刻。
   */
  const loadBoard = async (
    code: string,
    tradingDate: string,
    intervalMs: number
  ): Promise<void> => {
    const current = ++requestId
    setLoading(true)
    setLoadingAll(true)
    setAllProgress(0)
    try {
      let all: TradeTick[] = []
      let offset = 0
      for (let page = 0; page < 200; page += 1) {
        const data = await api.trade.ticks({
          code,
          start: offset,
          count: 1800,
          date: tradingDate || undefined
        })
        if (current !== requestId) return
        if (data.length === 0) break
        const merged = mergeTickPage(all, data)
        if (merged.added === 0) break
        all = merged.ticks
        offset += data.length
        setAllProgress(all.length)
        if (data.length < 1800) break
      }
      if (current !== requestId) return
      setTicks(all)
      setHasMore(false)
      setError(null)
      setLoading(false)
      if (tradingDate) return
      liveDispose = subscribePush<TradeTick[]>(
        { kind: 'ticks', code, start: 0, count: 1800 },
        intervalMs,
        (data) => setTicks((previous) => appendLatest(previous, data)),
        (message) => setError(message)
      )
    } catch (cause) {
      if (current !== requestId) return
      setError(errorMessage(cause))
    } finally {
      if (current === requestId) {
        setLoadingAll(false)
        setLoading(false)
      }
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

  const BoardView = (): JSX.Element => {
    onMount(() => {
      if (!boardScroller || typeof ResizeObserver === 'undefined') return
      const target = boardScroller
      const apply = (width: number): void => {
        // 每列约 208px：1440 宽主区 5 列，1920 宽 7 列
        setBoardCols(Math.max(1, Math.min(8, Math.floor(width / 208))))
      }
      apply(target.clientWidth)
      const observer = new ResizeObserver((entries) => {
        apply(entries[0]?.contentRect.width ?? target.clientWidth)
      })
      observer.observe(target)
      onCleanup(() => observer.disconnect())
    })

    return (
      <div class="tape tape--board">
        <div class="tape__toolbar tape__toolbar--board">
          <span class="tape__board-count num">
            {loadingAll() ? `载入中 ${allProgress()}` : `${ticks().length} 笔`}
          </span>
          <input
            class="tape__date"
            type="date"
            value={date()}
            aria-label="成交明细日期"
            title="选择日期查看历史逐笔"
            onChange={(event) => chooseDate(event.currentTarget.value)}
          />
          <Show when={date()}>
            <button class="tape__today" onClick={() => chooseDate('')}>
              回今天
            </button>
          </Show>
          <span class="tape__board-gap" />
          <button
            class="tape__today"
            classList={{ 'tape__today--active': autoFollow() }}
            title="新成交到达时自动回到最新一笔"
            onClick={() => setAutoFollow((value) => !value)}
          >
            {autoFollow() ? '自动滚屏 · 开' : '自动滚屏 · 关'}
          </button>
          <button
            class="tape__today"
            onClick={() => {
              setAutoFollow(true)
              if (boardScroller) boardScroller.scrollTop = 0
            }}
          >
            回到最新
          </button>
        </div>

        <Show when={error()}>
          {(message) => (
            <div class="tape__error" role="alert">
              {message()}
              <button
                class="tape__retry"
                onClick={() => void loadBoard(props.code, date(), refreshMs())}
              >
                重试
              </button>
            </div>
          )}
        </Show>

        <Show when={!loading() && ticks().length === 0 && !error()}>
          <div class="tape__empty">
            {date() ? '该日暂无成交（非交易日或历史数据未就绪）' : '暂无成交'}
          </div>
        </Show>

        <div
          class="tape-board"
          ref={(element) => {
            boardScroller = element
          }}
          style={{ '--board-cols': String(boardCols()) }}
        >
          <For each={boardColumns()}>
            {(column, columnIndex) => (
              <section class="tape-col" aria-label={`逐笔第 ${columnIndex() + 1} 列`}>
                <div class="tape-col__head">
                  <span>时间</span>
                  <span class="num">价格</span>
                  <span class="num">量</span>
                  <span class="tape-col__side-head">方向</span>
                </div>
                <For each={column}>
                  {(tick) => (
                    <div
                      class="tape-col__row"
                      data-side={tickTone(tick)}
                      title={`${tick.time} · ${tick.orderCount} 笔 · ${fixed(tick.price)}`}
                    >
                      <span class="tape-col__time num">{tick.time}</span>
                      <span class="tape-col__price num">{fixed(tick.price)}</span>
                      <span class={`tape-col__vol num ${volumeClass(tick.volume)}`}>
                        {thousands(tick.volume)}
                      </span>
                      <span class={`tape-col__side tape-col__side--${tickTone(tick)}`}>
                        {sideLabel(tick)}
                      </span>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </div>
    )
  }

  const RailView = (): JSX.Element => (
    <>
      <div
        class="tape"
        classList={{ 'tape--view': props.showExpand === false }}
        tabindex="0"
        aria-label="逐笔成交：上下键翻行"
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
          <Show when={props.showExpand !== false}>
            <button
              class="tape__today tape__large"
              disabled={ticks().length === 0}
              title="在主工作区打开逐笔明细"
              onClick={() => openView('tape')}
            >
              放大
            </button>
          </Show>
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

        <TickList rows={rows()} selected={selected()} onSelect={setSelected} />

        <Show when={!loading() && ticks().length === 0 && !error()}>
          <div class="tape__empty">
            {date() ? '该日暂无成交（非交易日或历史数据未就绪）' : '暂无成交'}
          </div>
        </Show>
      </div>
    </>
  )

  return (
    <Show when={isBoard()} fallback={<RailView />}>
      <BoardView />
    </Show>
  )
}
