/**
 * 集合竞价过程（0x056a）。
 *
 * 当日每 1 秒拉快照；历史日期优先读本地归档（服务器只保留最近交易日），
 * 没有归档才回退实时查询。归档写入数据湖 `lake/auction/trade_date=.../`，
 * 虚拟匹配量不是真实成交，只用于观察竞价过程。
 */
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import type { AuctionPoint } from '@shared/types'
import { fixed, thousands, timeOfDay } from '@shared/format'
import { createValueFlash } from '../../lib/dom'
import { api, errorMessage } from '../../lib/client'
import { subscribePush } from '../../lib/push'

interface AuctionTapeProps {
  code: string
}

type AuctionSource = 'live' | 'archive' | 'none'
type AuctionSession = 'open' | 'close' | 'all'

const REFRESH_MS = 1000

export function AuctionTape(props: AuctionTapeProps): JSX.Element {
  const [rows, setRows] = createSignal<AuctionPoint[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [date, setDate] = createSignal('')
  const [source, setSource] = createSignal<AuctionSource>('live')
  const [archiveBusy, setArchiveBusy] = createSignal(false)
  const [archiveNote, setArchiveNote] = createSignal<string | null>(null)
  const [lastAt, setLastAt] = createSignal(0)
  /** 0x056a selector=0 只到 09:25；selector=1 才包含 14:57–15:00 尾盘竞价。 */
  const [session, setSession] = createSignal<AuctionSession>('open')
  /** 用户往上翻看历史点时不要强行拽回底部 */
  const [stickToBottom, setStickToBottom] = createSignal(true)
  const displayRows = (): AuctionPoint[] => {
    if (session() === 'close') return rows().filter((point) => point.time >= '14:57')
    return rows()
  }
  const latest = () => displayRows()[displayRows().length - 1]
  const flash = createValueFlash(() => latest()?.price)
  let requestId = 0
  let liveDispose: (() => void) | undefined
  let scroller: HTMLDivElement | undefined
  let lastKey = ''

  const load = async (code: string, tradingDate = date()): Promise<void> => {
    const current = ++requestId
    setLoading(true)
    try {
      if (tradingDate && session() === 'open') {
        try {
          const archive = await api.auction.archiveRead(code, tradingDate)
          if (current !== requestId) return
          if (archive.found && archive.points.length > 0) {
            setRows(archive.points)
            setSource('archive')
            setError(null)
            setLastAt(0)
            return
          }
        } catch (cause) {
          if (current !== requestId) return
          // 归档损坏不应该挡住实时兜底，把原因留在工具栏下方。
          setArchiveNote(`本地归档读取失败：${errorMessage(cause)}`)
        }
      }
      const data = await api.auction.series(
        code,
        tradingDate || undefined,
        session() === 'open' ? 0 : 1
      )
      if (current !== requestId) return
      setRows(data)
      setSource(data.length > 0 ? 'live' : 'none')
      setError(null)
      setLastAt(Date.now())
    } catch (cause) {
      if (current !== requestId) return
      setRows([])
      setSource('none')
      setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  createEffect(() => {
    const tradingDate = date()
    const mode = session()
    liveDispose?.()
    liveDispose = undefined
    if (tradingDate || mode !== 'open') {
      void load(props.code, tradingDate)
    } else {
      liveDispose = subscribePush<AuctionPoint[]>(
        { kind: 'auction', code: props.code },
        REFRESH_MS,
        (data, update) => {
          setRows(data)
          setSource(data.length > 0 ? 'live' : 'none')
          setError(null)
          setLastAt(update.at)
          setLoading(false)
        },
        (message) => {
          setRows([])
          setSource('none')
          setError(message)
          setLoading(false)
        }
      )
    }
    onCleanup(() => {
      liveDispose?.()
      liveDispose = undefined
    })
  })

  /*
   * 竞价过程是从 09:15 顺序增长的；用户看的是「最新一条」，但它在一长串
   * 历史点的最下面。没有自动滚动时，越活跃的票（科创板常见 150+ 点）
   * 越像「价格不动了」。这里跟随到底部，用户主动上翻时暂停跟随。
   */
  createEffect(() => {
    const key = `${props.code}:${date()}`
    rows()
    if (key !== lastKey) {
      lastKey = key
      setStickToBottom(true)
    }
    if (!stickToBottom() || !scroller) return
    const element = scroller
    queueMicrotask(() => {
      element.scrollTop = element.scrollHeight
    })
  })

  const onScroll = (): void => {
    if (!scroller) return
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    setStickToBottom(distance < 28)
  }

  const previousTradingDate = (): string => {
    const value = new Date()
    value.setDate(value.getDate() - 1)
    while (value.getDay() === 0 || value.getDay() === 6) value.setDate(value.getDate() - 1)
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
      value.getDate()
    ).padStart(2, '0')}`
  }

  const changeDate = (value: string): void => {
    setArchiveNote(null)
    setDate(value)
  }

  const saveArchive = async (): Promise<void> => {
    if (archiveBusy() || loading()) return
    setArchiveBusy(true)
    setArchiveNote(null)
    try {
      const result = await api.auction.archiveSave(props.code, date() || undefined)
      setArchiveNote(
        result.skipped
          ? `已有归档 ${result.tradeDate} · ${result.rows} 点，未覆盖`
          : `已归档 ${result.tradeDate} · ${result.rows} 点`
      )
      if (date() && result.tradeDate === date()) {
        setRows(result.points)
        setSource('archive')
      }
    } catch (cause) {
      setArchiveNote(`归档失败：${errorMessage(cause)}`)
    } finally {
      setArchiveBusy(false)
    }
  }

  const sourceLabel = (): string => {
    if (source() === 'archive') return '本地归档'
    if (date() || session() !== 'open') return '单次查询'
    return '每 1 秒'
  }

  return (
    <div class="auction">
      <div class="auction__meta">
        <span>{loading() ? '刷新中…' : `${displayRows().length} 点`}</span>
        <span>
          {sourceLabel()}
          {date() ? ` · ${date()}` : ''}
          {lastAt() > 0 ? ` · 更新 ${timeOfDay(lastAt())}` : ''}
        </span>
      </div>

      <div class="auction__toolbar">
        <button
          class="auction__today"
          classList={{ 'auction__today--on': session() === 'open' }}
          onClick={() => setSession('open')}
        >
          早盘
        </button>
        <button
          class="auction__today"
          classList={{ 'auction__today--on': session() === 'close' }}
          onClick={() => setSession('close')}
        >
          尾盘
        </button>
        <button
          class="auction__today"
          classList={{ 'auction__today--on': session() === 'all' }}
          onClick={() => setSession('all')}
        >
          全天
        </button>
        <input
          class="auction__date"
          type="date"
          value={date()}
          aria-label="竞价日期"
          onChange={(event) => changeDate(event.currentTarget.value)}
        />
        <Show
          when={date()}
          fallback={
            <button class="auction__today" onClick={() => changeDate(previousTradingDate())}>
              历史
            </button>
          }
        >
          <button class="auction__today" onClick={() => changeDate('')}>
            回今天
          </button>
        </Show>
        <button
          class="auction__today auction__archive"
          disabled={archiveBusy() || loading() || rows().length === 0 || session() !== 'open'}
          title="写入本地数据湖，供服务器不再保留该日期后回看"
          onClick={() => void saveArchive()}
        >
          {archiveBusy() ? '归档中…' : '归档'}
        </button>
      </div>

      <Show when={archiveNote()}>{(message) => <div class="auction__note">{message()}</div>}</Show>

      <Show when={error()}>
        {(message) => (
          <div class="auction__error" role="alert">
            {message()}
            <button class="auction__retry" onClick={() => void load(props.code)}>
              重试
            </button>
          </div>
        )}
      </Show>

      {/*
        竞价页签最常看的是「现在虚拟撮合到多少」，但它在一长串历史点的末尾。
        顶部固定一条最新读数，列表再自动跟随到底部，避免误以为价格没刷新。
      */}
      <Show when={latest()}>
        {(point) => (
          <div class="auction__latest" data-testid="auction-latest">
            <div class="auction__latest-main">
              <span class="auction__latest-label">最新</span>
              <span
                class="auction__latest-price num"
                classList={{
                  'auction__latest-price--up': flash() === 'up',
                  'auction__latest-price--down': flash() === 'down'
                }}
              >
                {fixed(point().price)}
              </span>
              <span class="auction__latest-time num">{point().time}</span>
            </div>
            <div class="auction__latest-meta">
              <span>匹配 {thousands(point().matchedVolume)}</span>
              <span
                classList={{
                  'tone-up': point().unmatchedDirection > 0,
                  'tone-down': point().unmatchedDirection < 0
                }}
              >
                未匹配 {thousands(point().unmatchedVolume)}
              </span>
              <span>虚拟撮合</span>
            </div>
          </div>
        )}
      </Show>

      <div class="auction__head">
        <span>时间</span>
        <span class="auction__num">价格</span>
        <span class="auction__num">匹配</span>
        <span class="auction__num">未匹配</span>
      </div>

      <div
        class="auction__rows"
        data-testid="auction-rows"
        ref={(element: HTMLDivElement) => {
          scroller = element
        }}
        onScroll={onScroll}
      >
        <For each={displayRows()}>
          {(point) => (
            <div class="auction__row" title={`${point.time} · 虚拟撮合快照`}>
              <span class="auction__time num">{point.time}</span>
              <span class="auction__num">{fixed(point.price)}</span>
              <span class="auction__num">{thousands(point.matchedVolume)}</span>
              <span
                class="auction__num"
                classList={{
                  'tone-up': point.unmatchedDirection > 0,
                  'tone-down': point.unmatchedDirection < 0
                }}
              >
                {thousands(point.unmatchedVolume)}
              </span>
            </div>
          )}
        </For>
      </div>

      <Show when={!loading() && displayRows().length === 0 && !error()}>
        <div class="auction__empty">
          {date() ? '该日期没有实时数据，也没有本地归档；通达信只保留最近交易日' : '暂无竞价数据'}
        </div>
      </Show>

      <div class="auction__foot">
        {session() === 'close'
          ? '14:57–15:00 尾盘集合竞价 · 虚拟匹配量，不是成交'
          : session() === 'all'
            ? '09:15–09:25 开盘 + 14:57–15:00 尾盘 · 虚拟匹配量'
            : '09:15–09:25 开盘集合竞价 · 虚拟匹配量，不是成交 · 可归档到本地'}
      </div>
    </div>
  )
}
