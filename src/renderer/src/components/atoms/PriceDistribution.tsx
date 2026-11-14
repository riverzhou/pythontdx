/**
 * 分价表：把当日逐笔按成交价聚合，展示每个价位的成交量/笔数/占比。
 *
 * 只使用 0x0fc5 当日逐笔，不做估算；最多取 1800 笔。
 */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import type { TradeTick } from '@shared/types'
import { fixed, thousands } from '@shared/format'
import { localDate } from '@shared/alerts'
import { api, errorMessage } from '../../lib/client'

interface PriceRow {
  price: number
  volume: number
  count: number
  share: number
}

export function PriceDistribution(props: { code: string }): JSX.Element {
  const [ticks, setTicks] = createSignal<TradeTick[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [date, setDate] = createSignal('')
  const [minVolume, setMinVolume] = createSignal('0')
  let requestId = 0

  createEffect(() => {
    const current = ++requestId
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const data = await api.trade.ticks({
          code: props.code,
          count: 1800,
          date: date() || undefined
        })
        if (current !== requestId) return
        setTicks(data)
      } catch (cause) {
        if (current === requestId) setError(errorMessage(cause))
      } finally {
        if (current === requestId) setLoading(false)
      }
    })()
  })

  const rows = createMemo<PriceRow[]>(() => {
    const threshold = Math.max(0, Number(minVolume()) || 0)
    const map = new Map<number, { volume: number; count: number }>()
    for (const tick of ticks()) {
      if (!Number.isFinite(tick.price) || tick.volume <= 0 || tick.volume < threshold) continue
      const key = Math.round(tick.price * 100) / 100
      const item = map.get(key) ?? { volume: 0, count: 0 }
      item.volume += tick.volume
      item.count += 1
      map.set(key, item)
    }
    const total = [...map.values()].reduce((sum, item) => sum + item.volume, 0) || 1
    return [...map.entries()]
      .map(([price, item]) => ({
        price,
        volume: item.volume,
        count: item.count,
        share: (item.volume / total) * 100
      }))
      .sort((a, b) => b.price - a.price)
  })

  const maxVolume = createMemo(() => Math.max(1, ...rows().map((row) => row.volume)))
  const totalVolume = createMemo(() => rows().reduce((sum, row) => sum + row.volume, 0))

  return (
    <div class="price-dist">
      <Show when={!loading()} fallback={<div class="panel-empty">加载逐笔…</div>}>
        <Show when={!error()} fallback={<div class="panel-error">{error()}</div>}>
          <Show when={rows().length > 0} fallback={<div class="panel-empty">暂无成交</div>}>
            <div class="price-dist__controls">
              <input
                type="date"
                class="replay__date-input price-dist__date"
                value={date()}
                aria-label="分价日期"
                onChange={(event) => setDate(event.currentTarget.value)}
              />
              <button
                class="btn price-dist__yesterday"
                onClick={() => setDate(localDate(Date.now() - 86_400_000))}
              >
                昨日
              </button>
              <button class="btn" onClick={() => setDate('')}>
                今日
              </button>
              <label class="price-dist__threshold">
                ≥
                <input
                  type="number"
                  min="0"
                  step="10"
                  value={minVolume()}
                  aria-label="大单门槛（手）"
                  onInput={(event) => setMinVolume(event.currentTarget.value)}
                />
                手
              </label>
            </div>
            <div class="price-dist__head">
              <span>{rows().length} 个价位</span>
              <span>总量 {thousands(totalVolume())} 手</span>
            </div>
            <div class="price-dist__rows">
              <For each={rows()}>
                {(row) => (
                  <div class="price-dist__row">
                    <span class="num price-dist__price">{fixed(row.price)}</span>
                    <span class="price-dist__bar">
                      <span style={{ width: `${(row.volume / maxVolume()) * 100}%` }} />
                    </span>
                    <span class="num">{thousands(row.volume)}</span>
                    <span class="num price-dist__share">{fixed(row.share)}%</span>
                    <span class="num price-dist__count">{row.count} 笔</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
