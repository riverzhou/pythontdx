/**
 * 个股行情头部：名称、代码、最新价、涨跌，以及一排核心指标。
 */
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { MARKET_LABEL, type AuctionPoint, type Quote } from '@shared/types'
import {
  compactAmount,
  compactVolume,
  fixed,
  hhmmssLabel,
  signed,
  signedPct,
  timeOfDay
} from '@shared/format'
import { marketSession } from '@shared/market'
import { createValueFlash } from '../../lib/dom'
import { toneOf, toneVsPrevClose, type Tone } from '../../lib/tone'
import { addWatchItem, defaultGroup, removeWatchItem } from '../../stores/app'
import { clockNow } from '../../stores/clock'
import { openPopup } from '../../stores/workspace'
import { api } from '../../lib/client'
import { subscribePush } from '../../lib/push'
import { IconStar, IconStarFilled } from './Icons'

export interface QuoteHeaderProps {
  quote: Quote
}

export function QuoteHeader(props: QuoteHeaderProps): JSX.Element {
  const session = createMemo(() => marketSession(new Date(clockNow())))
  const [auction, setAuction] = createSignal<AuctionPoint | null>(null)
  /*
   * 集合竞价阶段，部分股票（科创板尤其明显）的 0x0547 增量刷新拿不到
   * 新的撮合价，行情头会一直停在昨收附近。0x056a 是专门的竞价过程接口，
   * 09:15–09:25 用它补一个「虚拟撮合价」；它只用于展示，不写进行情缓存。
   */
  const displayPrice = (): number =>
    session() === 'pre-open' && auction()?.price ? auction()!.price : props.quote.price
  const displayChange = (): number => {
    const price = displayPrice()
    return props.quote.prevClose > 0 ? price - props.quote.prevClose : props.quote.change
  }
  const displayPct = (): number => {
    const price = displayPrice()
    return props.quote.prevClose > 0
      ? ((price - props.quote.prevClose) / props.quote.prevClose) * 100
      : props.quote.changePct
  }
  const tone = (): Tone => toneOf(displayPct())
  const flash = createValueFlash(displayPrice)
  /** 0x0547 的 updateTime 是交易所侧的 HHMMSS；缺失时退回本地接收时间 */
  const marketTime = (): string =>
    session() === 'pre-open' && auction()
      ? auction()!.time
      : props.quote.updateTime && props.quote.updateTime > 0
        ? hhmmssLabel(props.quote.updateTime)
        : timeOfDay(props.quote.time)
  const [baseVolume, setBaseVolume] = createSignal<number | undefined>(undefined)
  let volumeRequest = 0
  const limits = (): { up?: number; down?: number } => limitPrices(props.quote)
  const volumeRatio = (): number | undefined =>
    props.quote.volumeRatio ??
    (baseVolume() && baseVolume()! > 0 ? props.quote.volume / baseVolume()! : undefined)

  createEffect(() => {
    const code = props.quote.code
    setAuction(null)
    if (session() !== 'pre-open') return
    const dispose = subscribePush<AuctionPoint[]>({ kind: 'auction', code }, 1000, (points) => {
      if (props.quote.code !== code) return
      setAuction(points[points.length - 1] ?? null)
    })
    onCleanup(dispose)
  })

  createEffect(() => {
    const code = props.quote.code
    const request = ++volumeRequest
    setBaseVolume(undefined)
    void (async () => {
      try {
        const kline = await api.trend.kline({ code, period: 'day', count: 6 })
        if (request !== volumeRequest || kline.bars.length < 2) return
        const history = kline.bars.slice(0, -1).slice(-5)
        const average =
          history.reduce((sum, bar) => sum + bar.volume, 0) / Math.max(1, history.length)
        if (average > 0) setBaseVolume(average)
      } catch {
        // 量比是辅助值，失败保持 —
      }
    })()
  })

  // 星标只代表「在自选股里」；同一只票还可以同时属于多个自定义板块
  const inWatchlist = (): boolean =>
    defaultGroup()?.items.some((item) => item.code === props.quote.code) === true

  /** 涨停 / 跌停判定（接口直接给了涨跌停价，顺手做个醒目标记） */
  const limitState = (): 'up' | 'down' | null => {
    const price = displayPrice()
    const { limitUp, limitDown } = props.quote
    if (limitUp !== undefined && price >= limitUp - 1e-6) return 'up'
    if (limitDown !== undefined && price <= limitDown + 1e-6) return 'down'
    return null
  }

  const toggleWatch = (): void => {
    if (inWatchlist()) {
      removeWatchItem(props.quote.code)
    } else {
      addWatchItem({
        code: props.quote.code,
        name: props.quote.name,
        market: props.quote.market
      })
    }
  }

  return (
    <section class="card quote-header animate-rise">
      <div class="quote-header__top">
        <div class="quote-header__identity">
          <div class="quote-header__name">
            <span>{props.quote.name}</span>
            <span class="tag">{MARKET_LABEL[props.quote.market]}</span>
            {limitState() === 'up' && <span class="tag tag--up">涨停</span>}
            {limitState() === 'down' && <span class="tag tag--down">跌停</span>}

            <button
              class="btn btn--icon btn--bare"
              title={inWatchlist() ? '移出自选' : '加入自选'}
              onClick={toggleWatch}
              style={{ color: inWatchlist() ? 'var(--chart-avg)' : 'var(--text-3)' }}
            >
              {inWatchlist() ? <IconStarFilled size={14} /> : <IconStar size={14} />}
            </button>
            <button
              class="btn btn--bare f10-open"
              title="F10 公司资料"
              onClick={() => openPopup('f10')}
            >
              F10
            </button>
            <button
              class="btn btn--bare announcements-open"
              title="在线公告"
              onClick={() => openPopup('announcements')}
            >
              公告
            </button>
          </div>

          <div
            class="quote-header__code num"
            title={`交易所行情时间 ${marketTime()} · 本地接收 ${timeOfDay(props.quote.time)}`}
          >
            {props.quote.code.toUpperCase()} · {props.quote.currency} · 行情 {marketTime()} · 接收{' '}
            {timeOfDay(props.quote.time)}
          </div>
          <Show
            when={
              props.quote.peTtm !== undefined ||
              props.quote.pb !== undefined ||
              props.quote.totalCap !== undefined ||
              props.quote.floatCap !== undefined
            }
          >
            <div class="quote-header__valuation">
              <Show when={props.quote.peTtm !== undefined}>
                <span>
                  PE <b class="num">{fixed(props.quote.peTtm)}</b>
                </span>
              </Show>
              <Show when={props.quote.pb !== undefined}>
                <span>
                  PB <b class="num">{fixed(props.quote.pb)}</b>
                </span>
              </Show>
              <Show when={props.quote.floatCap !== undefined}>
                <span>
                  流通 <b class="num">{compactAmount(props.quote.floatCap! * 1e8)}</b>
                </span>
              </Show>
              <Show when={props.quote.totalCap !== undefined}>
                <span>
                  总市值 <b class="num">{compactAmount(props.quote.totalCap! * 1e8)}</b>
                </span>
              </Show>
            </div>
          </Show>
        </div>

        <div class="quote-header__price-block">
          <div
            class="quote-header__price num"
            classList={{
              [tone()]: true,
              'quote-header__price--up': flash() === 'up',
              'quote-header__price--down': flash() === 'down'
            }}
          >
            {fixed(displayPrice())}
          </div>
          <div class="quote-header__delta num" classList={{ [tone()]: true }}>
            <span>{signed(displayChange())}</span>
            <span>{signedPct(displayPct())}</span>
          </div>
          <Show when={session() === 'pre-open' && auction()}>
            {(point) => (
              <div class="quote-header__auction" title="集合竞价虚拟撮合价，不是正式成交">
                集合竞价 {fixed(point().price)} · {point().time}
              </div>
            )}
          </Show>
        </div>
      </div>

      <div class="quote-metrics">
        {/* 价格类指标一律以昨收为基准染色；涨停红、跌停绿是交易所语义 */}
        <Metric
          label="今开"
          value={fixed(props.quote.open)}
          tone={toneVsPrevClose(props.quote.open, props.quote.prevClose)}
        />
        <Metric
          label="最高"
          value={fixed(props.quote.high)}
          tone={toneVsPrevClose(props.quote.high, props.quote.prevClose)}
        />
        <Metric
          label="最低"
          value={fixed(props.quote.low)}
          tone={toneVsPrevClose(props.quote.low, props.quote.prevClose)}
        />
        <Metric label="昨收" value={fixed(props.quote.prevClose)} />
        {/* 换手 / 量比 / 振幅 / 成交量 / 成交额没有涨跌方向，染红绿会误导，保持中性 */}
        <Metric label="换手" value={percent(props.quote.turnoverRate)} />
        <Metric label="量比" value={fixed(volumeRatio())} />
        <Metric label="振幅" value={percent(props.quote.amplitude)} />
        <Metric
          label="均价"
          value={fixed(props.quote.avgPrice)}
          tone={toneVsPrevClose(props.quote.avgPrice, props.quote.prevClose)}
        />
        <Metric label="涨停" value={fixed(limits().up)} tone="up" />
        <Metric label="跌停" value={fixed(limits().down)} tone="down" />
        <Metric label="成交量" value={compactVolume(props.quote.volume)} />
        <Metric label="成交额" value={compactAmount(props.quote.amount)} />
      </div>
    </section>
  )
}

function limitPrices(quote: Quote): { up?: number; down?: number } {
  if (quote.limitUp !== undefined && quote.limitDown !== undefined) {
    return { up: quote.limitUp, down: quote.limitDown }
  }
  if (!(quote.prevClose > 0)) return {}
  const limitPct = quote.name.toUpperCase().includes('ST')
    ? 5
    : quote.market === 'BJ'
      ? 30
      : /^(300|301|302|688|689)/.test(quote.symbol)
        ? 20
        : 10
  return {
    up: roundPrice(quote.prevClose * (1 + limitPct / 100)),
    down: roundPrice(quote.prevClose * (1 - limitPct / 100))
  }
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100
}

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(2)}%`
}

interface MetricProps {
  label: string
  value: string
  tone?: Tone
}

function Metric(props: MetricProps): JSX.Element {
  return (
    <div class="metric">
      <span class="metric__label">{props.label}</span>
      <span class="metric__value num" classList={{ [props.tone ?? 'flat']: !!props.tone }}>
        {props.value}
      </span>
    </div>
  )
}
