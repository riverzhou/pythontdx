/**
 * 股票列表的「主图上方那排指标」附加列，全市场 / 板块 / 排行榜共用。
 *
 * 只放纯数值列，代码/名称/走势由各表自己处理；统一表头、宽度和取值口径，
 * 三张表就不会出现「市场表有、板块表没有」或列头/内容错位。
 */
import { For, Show, type JSX } from 'solid-js'
import type { Quote } from '@shared/types'
import { compactVolume, fixed } from '@shared/format'

export interface ExtraColumn {
  key: string
  label: string
  width: number
}

export const EXTRA_COLUMNS: ExtraColumn[] = [
  { key: 'open', label: '今开', width: 58 },
  { key: 'high', label: '最高', width: 58 },
  { key: 'low', label: '最低', width: 58 },
  { key: 'prevClose', label: '昨收', width: 58 },
  { key: 'volume', label: '成交量', width: 64 },
  { key: 'avgPrice', label: '均价', width: 58 },
  { key: 'amplitude', label: '振幅', width: 54 },
  { key: 'limitUp', label: '涨停', width: 58 },
  { key: 'limitDown', label: '跌停', width: 58 },
  { key: 'totalCap', label: '总市值', width: 64 },
  { key: 'floatCap', label: '流通市值', width: 66 }
]

const percent = (value: number | undefined): string =>
  value === undefined ? '—' : `${value.toFixed(2)}%`

const cap = (value: number | undefined): string =>
  value === undefined ? '—' : `${value.toFixed(2)}亿`

/** MAC 报价不带均价/振幅时按成交额和最高最低补算 */
function avgPriceOf(quote: Quote): number | undefined {
  if (quote.avgPrice !== undefined && quote.avgPrice > 0) return quote.avgPrice
  if (quote.volume > 0 && quote.amount > 0) return quote.amount / (quote.volume * 100)
  return undefined
}

function amplitudeOf(quote: Quote): number | undefined {
  if (quote.amplitude !== undefined) return quote.amplitude
  if (quote.prevClose <= 0) return undefined
  return ((quote.high - quote.low) / quote.prevClose) * 100
}

/** 涨跌停价：行情源给了就用，没给按 ST/北证/科创/主板规则算 */
function limitPrice(quote: Quote, direction: 'up' | 'down'): number | undefined {
  const given = direction === 'up' ? quote.limitUp : quote.limitDown
  if (given !== undefined) return given
  if (quote.prevClose <= 0) return undefined
  const upper = quote.name.toUpperCase().includes('ST')
  const pct = upper ? 5 : quote.market === 'BJ' ? 30 : /^(300|301|302|688|689)/.test(quote.symbol) ? 20 : 10
  const price = quote.prevClose * (1 + (direction === 'up' ? pct : -pct) / 100)
  return Math.round(price * 100) / 100
}

export function ExtraColumnHeaders(): JSX.Element {
  return (
    <For each={EXTRA_COLUMNS}>
      {(column) => (
        <th class="num" data-col={column.key}>
          {column.label}
        </th>
      )}
    </For>
  )
}

export function ExtraColumnCells(props: { quote?: Quote }): JSX.Element {
  return (
    <Show
      when={props.quote}
      fallback={
        <For each={EXTRA_COLUMNS}>
          {(column) => (
            <td class="num" data-col={column.key}>
              —
            </td>
          )}
        </For>
      }
    >
      {(quote) => (
        <>
          <td class="num" data-col="open">
            {fixed(quote().open)}
          </td>
          <td class="num" data-col="high">
            {fixed(quote().high)}
          </td>
          <td class="num" data-col="low">
            {fixed(quote().low)}
          </td>
          <td class="num" data-col="prevClose">
            {fixed(quote().prevClose)}
          </td>
          <td class="num" data-col="volume">
            {compactVolume(quote().volume)}
          </td>
          <td class="num" data-col="avgPrice">
            {fixed(avgPriceOf(quote()))}
          </td>
          <td class="num" data-col="amplitude">
            {percent(amplitudeOf(quote()))}
          </td>
          <td class="num tone-up" data-col="limitUp">
            {fixed(limitPrice(quote(), 'up'))}
          </td>
          <td class="num tone-down" data-col="limitDown">
            {fixed(limitPrice(quote(), 'down'))}
          </td>
          <td class="num" data-col="totalCap">
            {cap(quote().totalCap)}
          </td>
          <td class="num" data-col="floatCap">
            {cap(quote().floatCap)}
          </td>
        </>
      )}
    </Show>
  )
}
