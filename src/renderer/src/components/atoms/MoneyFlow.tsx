/**
 * 资金流（0x0ffc）：最近 5 个交易日的主力/主买净额。
 *
 * 服务端固定返回 5 天，不能翻页；盘口右侧栏「资金流」页签使用。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import type { MacMoneyFlow, MoneyFlowRecord } from '@shared/types'
import { compactAmount, compactVolume, signedPct } from '@shared/format'
import { subscribePush } from '../../lib/push'
import { quoteOf } from '../../stores/quotes'

interface MoneyFlowProps {
  code: string
}

const REFRESH_MS = 60_000

export function MoneyFlow(props: MoneyFlowProps): JSX.Element {
  const [rows, setRows] = createSignal<MoneyFlowRecord[]>([])
  const [loading, setLoading] = createSignal(true)
  const [retry, setRetry] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)
  const [mac, setMac] = createSignal<MacMoneyFlow | null>(null)
  const [selectedDate, setSelectedDate] = createSignal<string | null>(null)
  const quote = (): ReturnType<typeof quoteOf> => quoteOf(props.code)
  const selected = createMemo(
    () => rows().find((row) => row.date === selectedDate()) ?? rows()[0] ?? null
  )

  createEffect(() => {
    retry()
    const code = props.code
    const dispose = subscribePush<{ flow: MoneyFlowRecord[]; mac: MacMoneyFlow | null }>(
      { kind: 'moneyFlow', code },
      REFRESH_MS,
      (data) => {
        setRows(data.flow)
        setMac(data.mac)
        if (data.flow.length > 0 && !data.flow.some((row) => row.date === selectedDate())) {
          setSelectedDate(data.flow[0].date)
        }
        setError(null)
        setLoading(false)
      },
      (message) => {
        setError(message)
        setLoading(false)
      }
    )
    onCleanup(dispose)
  })

  return (
    <div class="flow">
      <div class="flow__meta">
        <span>{loading() ? '刷新中…' : `${rows().length} 个交易日`}</span>
        <span>每 60 秒</span>
      </div>

      <Show when={(quote()?.innerVolume ?? 0) + (quote()?.outerVolume ?? 0) > 0}>
        <div class="flow__innerouter">
          <span>
            内盘 <strong class="num">{compactVolume(quote()?.innerVolume ?? 0)}</strong>
          </span>
          <span>
            外盘 <strong class="num">{compactVolume(quote()?.outerVolume ?? 0)}</strong>
          </span>
          <span>
            外盘占比{' '}
            <strong class="num">
              {(
                ((quote()?.outerVolume ?? 0) /
                  ((quote()?.innerVolume ?? 0) + (quote()?.outerVolume ?? 0) || 1)) *
                100
              ).toFixed(1)}
              %
            </strong>
          </span>
        </div>
      </Show>

      <Show when={error()}>
        {(message) => (
          <div class="flow__error" role="alert">
            {message()}
            <button class="flow__retry" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </div>
        )}
      </Show>

      <div class="flow__head">
        <span>日期</span>
        <span class="flow__num">主力净额</span>
        <span class="flow__num">占比</span>
        <span class="flow__num">主买净额</span>
      </div>

      <div class="flow__rows">
        <For each={rows()}>
          {(row) => (
            <div
              class="flow__row"
              classList={{
                'flow__row--positive': row.mainNet > 0,
                'flow__row--negative': row.mainNet < 0
              }}
              title={`${row.date} · 成交额 ${compactAmount(row.totalAmount)}`}
              onClick={() => setSelectedDate(row.date)}
              data-active={selected()?.date === row.date}
            >
              <span class="flow__date num">{row.date.slice(5)}</span>
              <span class="flow__num">{compactAmount(row.mainNet)}</span>
              <span class="flow__num">{signedPct(row.mainRatio)}</span>
              <span class="flow__num">{compactAmount(row.mainBuyNet)}</span>
            </div>
          )}
        </For>
      </div>

      <Show when={!loading() && rows().length === 0 && !error()}>
        <div class="flow__empty">暂无资金流</div>
      </Show>

      <Show when={selected()}>
        {(row) => (
          <div class="flow__detail">
            <div class="flow__detail-head">
              <span>四档明细 · {row().date.slice(5)}</span>
              <span>成交 {compactAmount(row().totalAmount)}</span>
            </div>
            <For
              each={
                [
                  ['超大单', row().mainSuperLargeNet],
                  ['大单', row().mainLargeNet],
                  ['中单', row().mainMediumNet],
                  ['小单', row().mainSmallNet]
                ] as const
              }
            >
              {([label, value]) => (
                <div class="flow__tier">
                  <span>{label}</span>
                  <b class={value >= 0 ? 'tone-up' : 'tone-down'}>{compactAmount(value)}</b>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>

      <div class="flow__foot">
        <span>0x0ffc · 主力 = 超大 + 大单</span>
      </div>

      <Show when={mac()}>
        {(data) => (
          <div class="flow__mac">
            <div class="flow__mac-title">MAC 0x1218 · 今日 / 5 日</div>
            <div class="flow__mac-grid">
              <span>主力净额</span>
              <b class={data().mainNet >= 0 ? 'tone-up' : 'tone-down'}>
                {compactAmount(data().mainNet)}
              </b>
              <span>散户净额</span>
              <b class={data().retailNet >= 0 ? 'tone-up' : 'tone-down'}>
                {compactAmount(data().retailNet)}
              </b>
              <span>5 日大单</span>
              <b class={data().largeNet5d >= 0 ? 'tone-up' : 'tone-down'}>
                {compactAmount(data().largeNet5d)}
              </b>
              <span>5 日中单</span>
              <b class={data().midNet5d >= 0 ? 'tone-up' : 'tone-down'}>
                {compactAmount(data().midNet5d)}
              </b>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
