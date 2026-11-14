/**
 * 板块选择器：在一个大窗口里按分类挑板块，再回左栏看该板块的个股排行。
 *
 * 为什么要有独立的大窗口：概念 269 个、风格 161 个、指数板块 117 个、一般 100 个、
 * 行业 111 个，塞进 240px 的左栏只能变成一条看不清的长列表（参考通达信的做法）。
 *
 * 数据来源：
 *   行业      → tdxhy.cfg（111 个通达信行业，带成分股）
 *   一级/二级行业 → TDXRSHY（tdxhy.cfg rsCode，按 MAC 0x1231 名单分层）
 *   概念/风格/指数板块/一般 → block_*.dat（0x06b9 文件通道）
 *
 * 自定义板块不在这里：它只有一层，由左栏「自定义」页签里的下拉框直接选择。
 */
import { createEffect, createMemo, createSignal, For, onMount, Show, type JSX } from 'solid-js'
import type { BlockKind } from '@shared/types'
import { BOARD_CATEGORIES, loadBoardCategory, type BoardCategory } from '../../lib/board-categories'
import { errorMessage } from '../../lib/client'
import type { SectorSelection } from '../../stores/sector'
import { IconClose } from './Icons'

type CategoryKey = BoardCategory

type PickerBoard = {
  id: string
  name: string
  kind: 'industry' | BlockKind | 'custom'
  count: number
  codes: string[]
  names: Record<string, string>
  indexCode: string
}

interface SectorPickerProps {
  onClose: () => void
  onPick: (selection: SectorSelection) => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}

export function SectorPicker(props: SectorPickerProps): JSX.Element {
  const [category, setCategory] = createSignal<CategoryKey>('industry')
  const [query, setQuery] = createSignal('')
  const [lists, setLists] = createSignal<Partial<Record<CategoryKey, PickerBoard[]>>>({})
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let requestId = 0

  const load = async (key: CategoryKey): Promise<void> => {
    if (lists()[key]) return
    const current = ++requestId
    setLoading(true)
    setError(null)
    try {
      const blocks = await loadBoardCategory(key)
      if (current !== requestId) return
      setLists((prev) => ({ ...prev, [key]: blocks }))
    } catch (cause) {
      if (current === requestId) setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  createEffect(() => void load(category()))

  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const boards = createMemo<PickerBoard[]>(() => lists()[category()] ?? [])

  const filtered = createMemo(() => {
    const keyword = query().trim().toLowerCase()
    const all = boards()
    if (!keyword) return all
    return all.filter((board) => board.name.toLowerCase().includes(keyword))
  })

  const pick = (board: PickerBoard): void => {
    const key = category()
    props.onPick({
      key: `${key}:${board.id}`,
      // 一级/二级行业在数据上都是成分股列表
      kind: key === 'rs1' || key === 'rs2' ? 'industry' : key,
      name: board.name,
      codes: [...board.codes],
      names: { ...board.names },
      indexCode: board.indexCode || undefined
    })
    props.onClose()
  }

  return (
    <div
      class="sector-picker"
      classList={{ 'panel-embed': props.embedded === true }}
      role={props.embedded ? 'region' : 'dialog'}
      aria-modal={props.embedded ? undefined : 'true'}
      aria-label="选择板块"
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <div
        class="sector-picker__panel"
        onClick={(event) => event.stopPropagation()}
        role="document"
      >
        <header class="sector-picker__head">
          <div>
            <div class="sector-picker__eyebrow">板块 · 成分股排行</div>
            <h2 class="sector-picker__title">选择板块</h2>
          </div>
          <button class="btn btn--icon" aria-label="关闭板块选择" onClick={() => props.onClose()}>
            <IconClose size={14} />
          </button>
        </header>

        {/* 两级菜单：左栏是「分类方式」，右栏才是具体板块。
            分类方式有多种（行业/概念/风格/一般/客户端自定义…），平铺一行放不下，也不能并列。 */}
        <div class="sector-picker__layout">
          <nav class="sector-picker__rail" role="tablist" aria-orientation="vertical">
            <For each={BOARD_CATEGORIES}>
              {(item) => (
                <button
                  class={`sector-picker__tab sector-picker__tab--${item.key}`}
                  role="tab"
                  data-active={category() === item.key}
                  onClick={() => {
                    setCategory(item.key)
                    setQuery('')
                  }}
                >
                  {item.label}
                </button>
              )}
            </For>
          </nav>

          <div class="sector-picker__main">
            <input
              class="sector-picker__search"
              placeholder="搜索板块名称"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              autofocus
            />

            <Show when={error()}>
              {(message) => <div class="sector-picker__error">{message()}</div>}
            </Show>

            <div class="sector-picker__body">
              <Show
                when={!loading() || filtered().length > 0}
                fallback={<div class="sector-picker__hint">加载板块列表…</div>}
              >
                <Show
                  when={filtered().length > 0}
                  fallback={
                    <div class="sector-picker__hint">
                      {query() ? '没有匹配的板块' : '没有板块数据'}
                    </div>
                  }
                >
                  <div class="sector-picker__grid">
                    <For each={filtered()}>
                      {(board) => (
                        <button
                          class="sector-card"
                          data-kind={category()}
                          title={`${board.name} · ${board.codes.length} 只成分股`}
                          onClick={() => pick(board)}
                        >
                          <span class="sector-card__name">{board.name}</span>
                          <span class="sector-card__count num">{board.codes.length}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </div>

        <footer class="sector-picker__foot">
          共 {filtered().length} 个板块 · 选中后左栏按涨跌幅显示成分股排行
        </footer>
      </div>
    </div>
  )
}
