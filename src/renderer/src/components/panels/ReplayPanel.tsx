/**
 * 复盘：日 K 逐根回放 + 当日分时逐分钟回放。
 *
 * 切片只喂给渲染层，不请求未来数据；日 K 用 320 根，分时用当日 241 个分钟点。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import type { KLineBar, KLineSeries, MinutePoint, MinuteTrend, TradeTick } from '@shared/types'
import { fixed, minuteLabel, signedPct, thousands } from '@shared/format'
import { localDate } from '@shared/alerts'
import { api, errorMessage } from '../../lib/client'
import { KLineChart } from '../charts/KLineChart'
import { TrendChart } from '../charts/TrendChart'
import { IconClose } from '../atoms/Icons'

interface ReplayPanelProps {
  code: string
  name: string
  onClose: () => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}

type Mode = 'day' | 'minute' | 'tick'

const PLAY_MS = 700

export function ReplayPanel(props: ReplayPanelProps): JSX.Element {
  const [mode, setMode] = createSignal<Mode>('day')
  const [bars, setBars] = createSignal<KLineBar[]>([])
  const [index, setIndex] = createSignal(0)
  const [minute, setMinute] = createSignal<MinuteTrend | null>(null)
  const [minuteIndex, setMinuteIndex] = createSignal(0)
  const [ticks, setTicks] = createSignal<TradeTick[]>([])
  const [tickIndex, setTickIndex] = createSignal(0)
  const [tickDate, setTickDate] = createSignal('')
  const [playing, setPlaying] = createSignal(false)
  const [speed, setSpeed] = createSignal(1)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  let requestId = 0

  const points = (): MinutePoint[] => minute()?.points ?? []

  const load = async (): Promise<void> => {
    const current = ++requestId
    setLoading(true)
    setError(null)
    setPlaying(false)
    try {
      if (mode() === 'day') {
        const series = await api.trend.kline({ code: props.code, period: 'day', count: 320 })
        if (current !== requestId) return
        setBars(series.bars)
        setIndex(
          Math.max(0, Math.min(series.bars.length - 1, Math.floor(series.bars.length * 0.7)))
        )
      } else if (mode() === 'minute') {
        const trend = await api.trend.minute(props.code)
        if (current !== requestId) return
        setMinute(trend)
        setMinuteIndex(
          Math.max(0, Math.min(trend.points.length - 1, Math.floor(trend.points.length * 0.7)))
        )
      } else {
        const data = await api.trade.ticks({
          code: props.code,
          count: 500,
          date: tickDate() || undefined
        })
        if (current !== requestId) return
        setTicks(data)
        setTickIndex(Math.max(0, Math.min(data.length - 1, Math.floor(data.length * 0.7))))
      }
    } catch (cause) {
      if (current === requestId) setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  createEffect(() => {
    if (!props.code) return
    void mode()
    void load()
  })

  createEffect(() => {
    if (!playing()) return
    const delay = Math.max(50, PLAY_MS / speed())
    const timer = window.setInterval(() => {
      const total =
        mode() === 'day' ? bars().length : mode() === 'minute' ? points().length : ticks().length
      const set = mode() === 'day' ? setIndex : mode() === 'minute' ? setMinuteIndex : setTickIndex
      set((value) => {
        if (value >= total - 1) {
          setPlaying(false)
          return value
        }
        return value + 1
      })
    }, delay)
    onCleanup(() => window.clearInterval(timer))
  })

  const dailyCurrent = createMemo(() => bars()[index()])
  const dailyPrevious = createMemo(() => bars()[index() - 1])
  const dailySeries = createMemo<KLineSeries>(() => ({
    code: props.code,
    period: 'day',
    bars: bars().slice(0, index() + 1)
  }))
  const dailyChangePct = createMemo(() => {
    const bar = dailyCurrent()
    const prev = dailyPrevious()
    if (!bar || !prev || prev.close === 0) return 0
    return ((bar.close - prev.close) / prev.close) * 100
  })

  const minuteCurrent = createMemo(() => points()[minuteIndex()])
  const minuteSlice = createMemo<MinuteTrend | undefined>(() => {
    const trend = minute()
    if (!trend) return undefined
    return { ...trend, points: trend.points.slice(0, minuteIndex() + 1) }
  })
  const minuteChangePct = createMemo(() => {
    const trend = minute()
    const point = minuteCurrent()
    if (!trend || !point || trend.prevClose === 0) return 0
    return ((point.price - trend.prevClose) / trend.prevClose) * 100
  })

  const total = (): number =>
    mode() === 'day' ? bars().length : mode() === 'minute' ? points().length : ticks().length
  const position = (): number =>
    mode() === 'day' ? index() : mode() === 'minute' ? minuteIndex() : tickIndex()
  const setPosition = (value: number): void => {
    const safe = Math.max(0, Math.min(total() - 1, value))
    if (mode() === 'day') setIndex(safe)
    else if (mode() === 'minute') setMinuteIndex(safe)
    else setTickIndex(safe)
  }

  const step = (delta: number): void => {
    setPlaying(false)
    setPosition(position() + delta)
  }

  const switchMode = (next: Mode): void => {
    if (next === mode()) return
    setPlaying(false)
    setMode(next)
  }

  const currentReady = (): boolean =>
    mode() === 'day'
      ? dailyCurrent() !== undefined
      : mode() === 'minute'
        ? minuteCurrent() !== undefined
        : ticks()[tickIndex()] !== undefined

  return (
    <div
      class="replay-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="replay-panel"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="复盘"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="replay__head">
          <div>
            <div class="replay__eyebrow">
              {mode() === 'day'
                ? '日 K 回放 · 只使用当前日期之前的数据'
                : mode() === 'minute'
                  ? '分时回放 · 只使用当前分钟之前的数据'
                  : '逐笔回放 · 只使用当前笔之前的数据'}
            </div>
            <h2 class="replay__title">
              {props.name} <code>{props.code.toUpperCase()}</code>
            </h2>
          </div>
          <div class="replay__modes">
            <button
              class="replay__mode"
              data-active={mode() === 'day'}
              onClick={() => switchMode('day')}
            >
              日 K
            </button>
            <button
              class="replay__mode replay-minute-tab"
              data-active={mode() === 'minute'}
              onClick={() => switchMode('minute')}
            >
              分时
            </button>
            <button
              class="replay__mode replay-tick-tab"
              data-active={mode() === 'tick'}
              onClick={() => switchMode('tick')}
            >
              逐笔
            </button>
          </div>
          <button class="btn btn--icon btn--bare" title="关闭复盘" onClick={() => props.onClose()}>
            <IconClose size={16} />
          </button>
        </header>

        <Show when={error()}>
          {(message) => (
            <div class="replay__error" role="alert">
              {message()}
            </div>
          )}
        </Show>

        <Show when={mode() === 'tick'}>
          <div class="replay__tickbar">
            <input
              type="date"
              class="replay__date-input"
              value={tickDate()}
              aria-label="逐笔日期"
              onChange={(event) => {
                setTickDate(event.currentTarget.value)
                void load()
              }}
            />
            <button
              class="btn replay-tick-prev"
              onClick={() => {
                setTickDate(localDate(Date.now() - 86_400_000))
                void load()
              }}
            >
              昨日
            </button>
            <button
              class="btn"
              onClick={() => {
                setTickDate('')
                void load()
              }}
            >
              今日
            </button>
            <span class="replay__tick-date-note">{tickDate() || '当前交易日'}</span>
          </div>
        </Show>

        <Show
          when={!loading() && currentReady()}
          fallback={
            <div class="replay__loading">
              {loading()
                ? `加载${mode() === 'day' ? '日 K' : mode() === 'minute' ? '分时' : '逐笔'}…`
                : '没有可回放的数据'}
            </div>
          }
        >
          <Show when={mode() === 'day' && dailyCurrent()}>
            {(bar) => (
              <>
                <div class="replay__quotes">
                  <span class="replay__date">{bar().date}</span>
                  <span class="replay__price num">{fixed(bar().close)}</span>
                  <span
                    class="replay__change num"
                    classList={{
                      'tone-up': dailyChangePct() > 0,
                      'tone-down': dailyChangePct() < 0
                    }}
                  >
                    {signedPct(dailyChangePct())}
                  </span>
                  <span class="replay__ohlc">
                    开 {fixed(bar().open)} · 高 {fixed(bar().high)} · 低 {fixed(bar().low)}
                  </span>
                  <span class="replay__ohlc">量 {thousands(bar().volume)} 手</span>
                </div>

                <div class="replay__chart">
                  <KLineChart series={dailySeries()} />
                </div>
              </>
            )}
          </Show>

          <Show when={mode() === 'minute' && minuteCurrent()}>
            {(point) => (
              <>
                <div class="replay__quotes">
                  <span class="replay__date">
                    {minute()?.date} {minuteLabel(point().time)}
                  </span>
                  <span class="replay__price num">{fixed(point().price)}</span>
                  <span
                    class="replay__change num"
                    classList={{
                      'tone-up': minuteChangePct() > 0,
                      'tone-down': minuteChangePct() < 0
                    }}
                  >
                    {signedPct(minuteChangePct())}
                  </span>
                  <span class="replay__ohlc">均价 {fixed(point().avg)}</span>
                  <span class="replay__ohlc">量 {thousands(point().volume)} 手</span>
                </div>

                <div class="replay__chart">
                  <Show when={minuteSlice()}>{(trend) => <TrendChart days={[trend()]} />}</Show>
                </div>
              </>
            )}
          </Show>

          <Show when={mode() === 'tick' && ticks()[tickIndex()]}>
            {(tick) => (
              <>
                <div class="replay__quotes">
                  <span class="replay__date">{tick().time}</span>
                  <span class="replay__price num">{fixed(tick().price)}</span>
                  <span class="replay__ohlc">
                    {tick().side === 'buy' ? '主动买' : tick().side === 'sell' ? '主动卖' : '中性'}
                  </span>
                  <span class="replay__ohlc">量 {thousands(tick().volume)} 手</span>
                  <span class="replay__ohlc">笔数 {tick().orderCount}</span>
                </div>
                <div class="replay__ticks">
                  <For each={ticks().slice(Math.max(0, tickIndex() - 19), tickIndex() + 1)}>
                    {(item) => (
                      <div class="replay__tick-row">
                        <span class="num">{item.time}</span>
                        <span class="num">{fixed(item.price)}</span>
                        <span class="num">{thousands(item.volume)}</span>
                        <span
                          classList={{
                            'tone-up': item.side === 'buy',
                            'tone-down': item.side === 'sell'
                          }}
                        >
                          {item.side === 'buy' ? 'B' : item.side === 'sell' ? 'S' : '—'}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </>
            )}
          </Show>

          <div class="replay__controls">
            <button class="btn" onClick={() => step(-1)} disabled={position() <= 0 || playing()}>
              上一步
            </button>
            <button
              class="btn btn--primary replay__play"
              onClick={() => {
                if (position() >= total() - 1) setPosition(0)
                setPlaying((value) => !value)
              }}
            >
              {playing() ? '暂停' : '播放'}
            </button>
            <button
              class="btn"
              onClick={() => step(1)}
              disabled={position() >= total() - 1 || playing()}
            >
              下一步
            </button>
            <div class="replay__speeds" aria-label="播放速度">
              <For each={[0.5, 1, 2, 4]}>
                {(value) => (
                  <button
                    class={`btn replay__speed replay__speed-${String(value).replace('.', '-')}`}
                    data-active={speed() === value}
                    onClick={() => setSpeed(value)}
                  >
                    {value}x
                  </button>
                )}
              </For>
            </div>
            <input
              class="replay__slider"
              type="range"
              min="0"
              max={Math.max(0, total() - 1)}
              value={position()}
              aria-label="回放位置"
              onInput={(event) => {
                setPlaying(false)
                setPosition(Number(event.currentTarget.value))
              }}
            />
            <span class="replay__position num">
              {position() + 1} / {total()}
            </span>
          </div>
        </Show>

        <footer class="replay__foot">
          <span>回放切片只喂给渲染层，不请求未来数据</span>
          <span>
            {mode() === 'day'
              ? '日 K 700ms/根'
              : mode() === 'minute'
                ? '分时 700ms/分钟'
                : '逐笔 700ms/笔'}
          </span>
        </footer>
      </section>
    </div>
  )
}
