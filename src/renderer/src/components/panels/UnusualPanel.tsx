/**
 * 市场异动 / 涨停 / 跌停 / 炸板。
 *
 * 异动来自 MAC 0x1237；涨跌停由全市场 MAC 快照在本地按板块涨跌幅限制判定。
 * 仅做行情筛选，不生成交易指令。
 */
import { createMemo, createSignal, For, onMount, Show, type JSX } from 'solid-js'
import type { MacUnusualItem, Quote } from '@shared/types'
import { compactAmount, fixed, signedPct } from '@shared/format'
import { limitRowsFromQuotes, type LimitKind } from '@shared/limits'
import { buildChangeDistribution } from '@shared/distribution'
import { api, errorMessage } from '../../lib/client'
import { openStockMenu } from '../../stores/stockMenu'
import { IconClose, IconRefresh } from '../atoms/Icons'

const LIMIT = 360
type Mode = 'unusual' | LimitKind

const TABS: Array<{ key: Mode; label: string }> = [
  { key: 'unusual', label: '异动' },
  { key: 'up', label: '涨停' },
  { key: 'down', label: '跌停' },
  { key: 'broken', label: '炸板' }
]

export function UnusualPanel(props: {
  onClose: () => void
  onSelect: (code: string) => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}): JSX.Element {
  const [items, setItems] = createSignal<MacUnusualItem[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [mode, setMode] = createSignal<Mode>('unusual')
  const [quotes, setQuotes] = createSignal<Quote[]>([])
  const [limitLoading, setLimitLoading] = createSignal(false)
  const [limitError, setLimitError] = createSignal<string | null>(null)
  let limitPromise: Promise<void> | null = null

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setItems((await api.mac.unusual(600)).slice(0, LIMIT))
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const loadLimits = async (): Promise<void> => {
    if (quotes().length > 0 || limitPromise) return limitPromise ?? undefined
    setLimitLoading(true)
    setLimitError(null)
    limitPromise = (async () => {
      try {
        const catalog = await api.quote.catalog()
        const codes = catalog
          .filter(
            (item) =>
              item.kind === 'GP-A' &&
              ((item.market === 'SH' && /^(600|601|603|605|688|689)/.test(item.symbol)) ||
                (item.market === 'SZ' && /^(000|001|002|003|300|301|302)/.test(item.symbol)) ||
                (item.market === 'BJ' && /^[489]/.test(item.symbol)))
          )
          .map((item) => item.code)
        const all: Quote[] = []
        for (let start = 0; start < codes.length; start += 500) {
          all.push(...(await api.quote.macQuotes(codes.slice(start, start + 500))))
        }
        setQuotes(all)
      } catch (cause) {
        setLimitError(errorMessage(cause))
      } finally {
        setLimitLoading(false)
        limitPromise = null
      }
    })()
    return limitPromise
  }

  onMount(() => void load())

  const upRows = createMemo(() => limitRowsFromQuotes(quotes(), 'up'))
  const downRows = createMemo(() => limitRowsFromQuotes(quotes(), 'down'))
  const brokenRows = createMemo(() => limitRowsFromQuotes(quotes(), 'broken'))
  const limitRows = createMemo(() =>
    mode() === 'up' ? upRows() : mode() === 'down' ? downRows() : brokenRows()
  )

  const switchMode = (next: Mode): void => {
    setMode(next)
    if (next !== 'unusual' && quotes().length === 0) void loadLimits()
  }

  const count = (): number => (mode() === 'unusual' ? items().length : limitRows().length)

  const distribution = createMemo(() =>
    buildChangeDistribution(quotes().map((quote) => quote.changePct))
  )
  const maxBucket = createMemo(() => Math.max(...distribution().map((bucket) => bucket.count), 1))

  return (
    <div
      class="unusual-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="unusual-panel"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="市场异动"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="unusual__head">
          <div>
            <div class="unusual__eyebrow">
              {mode() === 'unusual'
                ? 'MAC 0x1237 · 沪深合并 · 时间倒序'
                : '全市场 MAC 快照 · 本地涨跌停判定'}
            </div>
            <h2 class="unusual__title">市场异动</h2>
          </div>
          <div class="unusual__actions">
            <span>{count()} 条</span>
            <button
              class="btn btn--icon btn--bare unusual-refresh"
              title="刷新"
              onClick={() => void (mode() === 'unusual' ? load() : loadLimits())}
            >
              <IconRefresh size={14} />
            </button>
            <button class="btn btn--icon btn--bare" title="关闭" onClick={() => props.onClose()}>
              <IconClose size={16} />
            </button>
          </div>
        </header>

        <div class="unusual__tabs">
          <For each={TABS}>
            {(tab) => (
              <button
                class={`unusual__tab unusual__tab--${tab.key}`}
                data-active={mode() === tab.key}
                onClick={() => switchMode(tab.key)}
              >
                {tab.label}
                <Show when={tab.key !== 'unusual' && quotes().length > 0}>
                  <span class="unusual__tab-count">
                    {tab.key === 'up'
                      ? upRows().length
                      : tab.key === 'down'
                        ? downRows().length
                        : brokenRows().length}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>

        <Show when={mode() !== 'unusual' && quotes().length > 0}>
          <div class="unusual__dist">
            <div class="unusual__dist-head">
              <span>全市场涨跌分布 · {quotes().length} 只</span>
              <span class="num">
                涨停 {upRows().length} / 跌停 {downRows().length}
              </span>
            </div>
            <div class="unusual__dist-bars">
              <For each={distribution()}>
                {(bucket) => (
                  <div
                    class={`unusual__dist-bucket unusual__dist-bucket--${bucket.tone}`}
                    title={`${bucket.label}：${bucket.count} 只`}
                  >
                    <em>{bucket.count}</em>
                    <span
                      class="unusual__dist-bar"
                      style={{ height: `${Math.max(2, (bucket.count / maxBucket()) * 100)}%` }}
                    />
                    <small>{bucket.label}</small>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={mode() === 'unusual' ? error() : limitError()}>
          {(message) => <div class="unusual__error">{message()}</div>}
        </Show>

        <Show when={mode() === 'unusual'}>
          <div class="unusual__table-wrap">
            <table class="unusual__table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>代码</th>
                  <th>名称</th>
                  <th>异动</th>
                  <th class="unusual__num">数值</th>
                </tr>
              </thead>
              <tbody>
                <For each={items()}>
                  {(item) => (
                    <tr
                      onClick={() => props.onSelect(item.code)}
                      onContextMenu={(event) =>
                        openStockMenu(event, { code: item.code, name: item.name })
                      }
                    >
                      <td class="num">{item.time}</td>
                      <td class="num">{item.code.toUpperCase()}</td>
                      <td>{item.name}</td>
                      <td class="unusual__desc">{item.desc}</td>
                      <td class="unusual__num num">{item.value || '—'}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={loading()}>
              <div class="unusual__loading">加载异动快照…</div>
            </Show>
            <Show when={!loading() && items().length === 0}>
              <div class="unusual__loading">暂无异动</div>
            </Show>
          </div>
        </Show>

        <Show when={mode() !== 'unusual'}>
          <div class="unusual__table-wrap">
            <table class="unusual__table">
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th class="unusual__num">现价</th>
                  <th class="unusual__num">涨幅</th>
                  <th class="unusual__num">最高</th>
                  <th class="unusual__num">最低</th>
                  <th class="unusual__num">成交额</th>
                </tr>
              </thead>
              <tbody>
                <For each={limitRows()}>
                  {(row) => (
                    <tr onClick={() => props.onSelect(row.code)}>
                      <td class="num">{row.code.toUpperCase()}</td>
                      <td>{row.name}</td>
                      <td class="unusual__num num">{fixed(row.price)}</td>
                      <td
                        class="unusual__num num"
                        classList={{ 'tone-up': row.changePct > 0, 'tone-down': row.changePct < 0 }}
                      >
                        {signedPct(row.changePct)}
                      </td>
                      <td class="unusual__num num">{fixed(row.high)}</td>
                      <td class="unusual__num num">{fixed(row.low)}</td>
                      <td class="unusual__num num">{compactAmount(row.amount)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={limitLoading()}>
              <div class="unusual__loading">加载全市场涨跌停…</div>
            </Show>
            <Show when={!limitLoading() && limitRows().length === 0}>
              <div class="unusual__loading">
                当前无{mode() === 'up' ? '涨停' : mode() === 'down' ? '跌停' : '炸板'}
              </div>
            </Show>
          </div>
        </Show>
      </section>
    </div>
  )
}
