/**
 * 大盘资料（7615 大盘 F10）。
 *
 * 上证指数概况 / 市场两融 / 新股分析 / 增发与市场概览；
 * 只读展示，不生成交易动作。
 */
import { createEffect, createSignal, For, Show, type JSX } from 'solid-js'
import type { F10TradingTable } from '@shared/types'
import { api, errorMessage } from '../../lib/client'
import { downloadText } from '../../lib/download'
import { toCsv } from '@shared/csv'
import { IconClose, IconRefresh } from '../atoms/Icons'

const TABS: Array<{ key: string; label: string }> = [
  { key: 'basic', label: '指数概况' },
  { key: 'margin', label: '市场两融' },
  { key: 'new', label: '新股分析' },
  { key: 'capital', label: '增发/概览' }
]

const LIMIT = 240

export function MarketReportPanel(props: {
  onClose: () => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}): JSX.Element {
  const [section, setSection] = createSignal('basic')
  const [table, setTable] = createSignal<F10TradingTable | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  let requestId = 0

  const load = async (key: string): Promise<void> => {
    const current = ++requestId
    setLoading(true)
    setError(null)
    try {
      const data = await api.f10.market(key)
      if (current !== requestId) return
      setTable(data)
    } catch (cause) {
      if (current === requestId) setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  createEffect(() => void load(section()))

  return (
    <div
      class="mreport-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="mreport-panel"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="大盘资料"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="mreport__head">
          <div>
            <div class="mreport__eyebrow">7615 · 大盘 F10 · 免费资料</div>
            <h2 class="mreport__title">大盘资料</h2>
          </div>
          <div class="mreport__actions">
            <span>{table()?.count ?? 0} 行</span>
            <button
              class="btn mreport-export"
              title="导出当前分区 CSV"
              onClick={() => {
                const current = table()
                if (!current) return
                downloadText(
                  `pythontdx-market-${current.section}.csv`,
                  toCsv(current.columns, current.rows as Array<Array<string | number>>)
                )
              }}
            >
              导出
            </button>
            <button
              class="btn btn--icon btn--bare mreport-refresh"
              title="刷新大盘资料"
              onClick={() => void load(section())}
            >
              <IconRefresh size={14} />
            </button>
            <button
              class="btn btn--icon btn--bare"
              title="关闭大盘资料"
              onClick={() => props.onClose()}
            >
              <IconClose size={16} />
            </button>
          </div>
        </header>

        <div class="mreport__tabs">
          <For each={TABS}>
            {(tab) => (
              <button
                class={`mreport__tab mreport__tab--${tab.key}`}
                data-active={section() === tab.key}
                onClick={() => setSection(tab.key)}
              >
                {tab.label}
              </button>
            )}
          </For>
          <span class="mreport__hint">显示前 {LIMIT} 行</span>
        </div>

        <Show when={error()}>{(message) => <div class="mreport__error">{message()}</div>}</Show>

        <div class="mreport__table-wrap">
          <table class="mreport__table">
            <thead>
              <tr>
                <For each={table()?.columns ?? []}>{(column) => <th>{column}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={(table()?.rows ?? []).slice(0, LIMIT)}>
                {(row) => (
                  <tr>
                    <For each={row}>
                      {(cell) => (
                        <td classList={{ num: typeof cell === 'number' }}>
                          {cell === null || cell === undefined || cell === '' ? '—' : String(cell)}
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={loading()}>
            <div class="mreport__loading">加载大盘资料…</div>
          </Show>
          <Show when={!loading() && (table()?.rows.length ?? 0) === 0}>
            <div class="mreport__loading">暂无数据</div>
          </Show>
        </div>
      </section>
    </div>
  )
}
