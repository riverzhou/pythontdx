/**
 * 沪深龙虎榜（7615 大盘 F10）。
 *
 * 原始数据为「股票 × 上榜原因 × 营业部」明细，这里做只读表 + 搜索，
 * 点击行切换当前股票；不做交易动作。
 */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import type { F10TradingTable } from '@shared/types'
import { api, errorMessage } from '../../lib/client'
import { downloadText } from '../../lib/download'
import { toCsv } from '@shared/csv'
import { IconClose, IconRefresh } from '../atoms/Icons'

function fullCode(row: Array<string | number>, columns: string[]): string | null {
  const code = String(row[columns.indexOf('代码')] ?? '')
  if (!/^\d{6}$/.test(code)) return null
  const market = Number(row[columns.indexOf('市场')])
  const prefix = market === 1 ? 'sh' : market === 2 ? 'bj' : 'sz'
  return `${prefix}${code}`
}

export function DragonPanel(props: {
  onClose: () => void
  onSelect: (code: string) => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}): JSX.Element {
  const [table, setTable] = createSignal<F10TradingTable | null>(null)
  const [query, setQuery] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setTable(await api.f10.lhbMarket())
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => void load())

  const rows = createMemo(() => {
    const current = table()
    if (!current) return []
    const text = query().trim().toLowerCase()
    const codeIndex = current.columns.indexOf('代码')
    const nameIndex = current.columns.indexOf('名称')
    return current.rows.filter((row) => {
      if (!text) return true
      return (
        String(row[codeIndex] ?? '')
          .toLowerCase()
          .includes(text) ||
        String(row[nameIndex] ?? '')
          .toLowerCase()
          .includes(text)
      )
    })
  })

  const visibleColumns = createMemo(() =>
    (table()?.columns ?? [])
      .map((name, index) => ({ name, index }))
      .filter(({ name }) => !['市场', '板块代码', '行业代码', '排名'].includes(name))
  )

  return (
    <div
      class="dragon-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="dragon-panel"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="沪深龙虎榜"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="dragon__head">
          <div>
            <div class="dragon__eyebrow">7615 · 大盘 F10 · 营业部买卖明细</div>
            <h2 class="dragon__title">沪深龙虎榜</h2>
          </div>
          <div class="dragon__actions">
            <span>{table()?.count ?? 0} 条</span>
            <button
              class="btn dragon-export"
              title="导出当前筛选结果 CSV"
              onClick={() => {
                const current = table()
                if (!current) return
                const indexes = visibleColumns().map((column) => column.index)
                downloadText(
                  'pythontdx-dragon.csv',
                  toCsv(
                    visibleColumns().map((column) => column.name),
                    rows().map((row) => indexes.map((index) => row[index] as string | number))
                  )
                )
              }}
            >
              导出
            </button>
            <button
              class="btn btn--icon btn--bare dragon-refresh"
              title="刷新龙虎榜"
              onClick={() => void load()}
            >
              <IconRefresh size={14} />
            </button>
            <button
              class="btn btn--icon btn--bare"
              title="关闭龙虎榜"
              onClick={() => props.onClose()}
            >
              <IconClose size={16} />
            </button>
          </div>
        </header>

        <div class="dragon__tools">
          <input
            class="dragon__search"
            type="search"
            placeholder="搜索代码 / 名称"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
            }}
          />
          <span class="dragon__hint">共 {rows().length} 条 · 滚动查看（点击切股票）</span>
        </div>

        <Show when={error()}>{(message) => <div class="dragon__error">{message()}</div>}</Show>

        <div class="dragon__table-wrap">
          <table class="dragon__table">
            <thead>
              <tr>
                <For each={visibleColumns()}>
                  {(column) => <th data-key={column.name}>{column.name}</th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => {
                  const code = (): string | null => fullCode(row, table()?.columns ?? [])
                  return (
                    <tr
                      classList={{ 'dragon__row--link': Boolean(code()) }}
                      onClick={() => {
                        const current = code()
                        if (current) {
                          props.onSelect(current)
                          props.onClose()
                        }
                      }}
                    >
                      <For each={visibleColumns()}>
                        {(column) => (
                          <td
                            classList={{ num: typeof row[column.index] === 'number' }}
                            data-key={column.name}
                          >
                            {String(row[column.index] ?? '')}
                          </td>
                        )}
                      </For>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
          <Show when={loading()}>
            <div class="dragon__loading">加载龙虎榜…</div>
          </Show>
          <Show when={!loading() && rows().length === 0}>
            <div class="dragon__loading">没有匹配记录</div>
          </Show>
        </div>
      </section>
    </div>
  )
}
