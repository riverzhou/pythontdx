/**
 * 五档盘口。
 *
 * 视觉要点：每一档背后有一条按「挂单量占最大挂单量的比例」生长的条形，
 * 让买卖力量的对比一眼可见。
 */
import { For, type JSX } from 'solid-js'
import type { OrderLevel, Quote } from '@shared/types'
import { fixed, thousands } from '@shared/format'

export interface OrderBookProps {
  quote: Quote
}

const ASK_LABELS = ['卖五', '卖四', '卖三', '卖二', '卖一']
const BID_LABELS = ['买一', '买二', '买三', '买四', '买五']

/** 补齐成固定 5 档，缺失的档位用 null 占位，避免标签错位 */
function padLevels(levels: OrderLevel[]): (OrderLevel | null)[] {
  return Array.from({ length: 5 }, (_, index) => levels[index] ?? null)
}

export function OrderBook(props: OrderBookProps): JSX.Element {
  const asks = (): (OrderLevel | null)[] => padLevels(props.quote.asks)
  const bids = (): (OrderLevel | null)[] => padLevels(props.quote.bids)

  const maxVolume = (): number => {
    const volumes = [...props.quote.asks, ...props.quote.bids].map((level) => level.volume)
    return Math.max(1, ...volumes)
  }

  const spread = (): string => {
    const ask1 = props.quote.asks[0]?.price
    const bid1 = props.quote.bids[0]?.price
    if (ask1 === undefined || bid1 === undefined) return '—'
    return (ask1 - bid1).toFixed(2)
  }

  /** 卖盘从「卖五」倒序排到「卖一」，和真实交易软件一致 */
  const askRows = (): { label: string; level: OrderLevel | null }[] =>
    [...asks()].reverse().map((level, index) => ({ label: ASK_LABELS[index], level }))

  return (
    <div class="orderbook">
      <For each={askRows()}>
        {(row) => <LevelRow label={row.label} level={row.level} side="ask" max={maxVolume()} />}
      </For>

      <div class="ob-spread">
        <span>价差</span>
        <span class="ob-spread__value num">{spread()}</span>
        <span>最新 {fixed(props.quote.price)}</span>
      </div>

      <For each={bids()}>
        {(level, index) => (
          <LevelRow label={BID_LABELS[index()]} level={level} side="bid" max={maxVolume()} />
        )}
      </For>
    </div>
  )
}

interface LevelRowProps {
  label: string
  level: OrderLevel | null
  side: 'ask' | 'bid'
  max: number
}

function LevelRow(props: LevelRowProps): JSX.Element {
  const width = (): string =>
    props.level ? `${Math.max(2, (props.level.volume / props.max) * 100)}%` : '0%'

  return (
    <div
      class="ob-row"
      classList={{ 'ob-row--ask': props.side === 'ask', 'ob-row--bid': props.side === 'bid' }}
    >
      <span class="ob-row__label">{props.label}</span>
      <span
        class="ob-row__price num"
        style={{ color: props.side === 'ask' ? 'var(--up)' : 'var(--down)' }}
      >
        {props.level ? fixed(props.level.price) : '—'}
      </span>
      <span class="ob-row__vol num">{props.level ? thousands(props.level.volume) : '—'}</span>
      <span class="ob-row__bar" style={{ '--w': width() }} />
    </div>
  )
}
