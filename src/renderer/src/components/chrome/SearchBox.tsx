/**
 * 顶部搜索框：带防抖、键盘导航和「直接输入代码」兜底。
 */
import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js'
import { MARKET_LABEL, type SearchItem } from '@shared/types'
import { normalizeCode } from '@shared/market'
import { api } from '../../lib/client'
import { addSearchItem, addWatchItem, appState, updateSettings } from '../../stores/app'
import { selectStock } from '../../stores/workspace'
import { IconSearch } from '../atoms/Icons'

/** 输入防抖：避免每次按键都在 5 万多条本地代码表里重算 */
const DEBOUNCE_MS = 240

export function SearchBox(): JSX.Element {
  const [keyword, setKeyword] = createSignal('')
  const [items, setItems] = createSignal<SearchItem[]>([])
  const [open, setOpen] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [cursor, setCursor] = createSignal(0)

  const recent = (): SearchItem[] => appState.settings.recentSearches ?? []
  const suggestions = (): SearchItem[] => (keyword().trim() ? items() : recent())

  /**
   * Solid 支持 `ref={变量}` 这种写法，但它依赖编译器的隐式赋值，
   * ESLint 无法确认变量真的被写过（no-unassigned-vars 会报错）。
   * 用显式回调既消除了歧义，也更容易读。
   */
  let inputElement: HTMLInputElement | undefined
  /** 请求序号：只接受最后一次请求的结果，防止旧响应覆盖新响应 */
  let sequence = 0

  createEffect(
    on(keyword, (value) => {
      const text = value.trim()
      if (!text) {
        sequence++
        setItems([])
        setLoading(false)
        return
      }

      setLoading(true)
      const token = ++sequence
      const timer = setTimeout(() => {
        api.search
          .hint(text)
          .then((result) => {
            if (token !== sequence) return
            setItems(result)
            setCursor(0)
            setOpen(true)
          })
          .catch(() => {
            if (token !== sequence) return
            setItems([])
            setOpen(true)
          })
          .finally(() => {
            if (token === sequence) setLoading(false)
          })
      }, DEBOUNCE_MS)

      onCleanup(() => clearTimeout(timer))
    })
  )

  const remember = (item: SearchItem): void => {
    updateSettings({
      recentSearches: [item, ...recent().filter((entry) => entry.code !== item.code)].slice(0, 8)
    })
  }

  const commit = (item: SearchItem): void => {
    remember(item)
    addSearchItem(item)
    setKeyword('')
    setItems([])
    setOpen(false)
    inputElement?.blur()
    selectStock(item.code)
  }

  /** 用户直接粘贴/输入 6 位代码时，不走联想接口也能加进来 */
  const commitRawCode = (): void => {
    const code = normalizeCode(keyword())
    if (!code) return
    const symbol = code.slice(2)
    const item: SearchItem = {
      code,
      symbol,
      name: symbol,
      market: code.slice(0, 2).toUpperCase() as SearchItem['market'],
      kind: 'GP-A'
    }
    remember(item)
    addWatchItem({ code, name: symbol, market: item.market })
    setKeyword('')
    setOpen(false)
    inputElement?.blur()
    selectStock(code)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }

    const list = suggestions()
    if (list.length === 0) {
      if (event.key === 'Enter') commitRawCode()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((index) => (index + 1) % list.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((index) => (index - 1 + list.length) % list.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = list[cursor()]
      if (item) commit(item)
      else commitRawCode()
    }
  }

  return (
    <div class="search-wrap">
      <div class="search">
        <IconSearch size={13} class="search__icon" />
        <input
          ref={(element: HTMLInputElement) => {
            inputElement = element
          }}
          class="search__input"
          type="text"
          spellcheck={false}
          autocomplete="off"
          placeholder="搜索股票 / 代码 / 拼音首字母，回车添加自选"
          value={keyword()}
          onInput={(event) => setKeyword(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setCursor(0)
            setOpen(true)
          }}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
        />
        <Show when={loading()}>
          <span class="search__spinner" />
        </Show>
      </div>

      <Show when={open()}>
        <div class="search-pop">
          <Show when={keyword().trim()}>
            <Show
              when={items().length > 0}
              fallback={<div class="search-pop__empty">没有匹配的证券</div>}
            >
              <For each={items()}>
                {(item, index) => (
                  <button
                    class="search-pop__item"
                    data-cursor={index() === cursor()}
                    onMouseEnter={() => setCursor(index())}
                    /*
                     * 不要在 mousedown 时让输入框失焦：失焦 140ms 后弹层会被移除，
                     * 用户点得稍慢（mousedown→mouseup 超过 140ms）时 click 落在
                     * 已移除的节点上，就出现「点了没反应、偶尔成功」。
                     */
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commit(item)}
                  >
                    <span class="tag">{MARKET_LABEL[item.market]}</span>
                    <span class="search-pop__name">{item.name}</span>
                    <span class="search-pop__code num">{item.code.toUpperCase()}</span>
                  </button>
                )}
              </For>
            </Show>
          </Show>

          <Show when={!keyword().trim()}>
            <Show
              when={recent().length > 0}
              fallback={<div class="search-pop__empty">输入名称、拼音或代码</div>}
            >
              <div class="search-pop__head">
                <span>最近搜索</span>
                <button
                  class="search-pop__clear"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    updateSettings({ recentSearches: [] })
                    setCursor(0)
                  }}
                >
                  清空
                </button>
              </div>
              <For each={recent()}>
                {(item, index) => (
                  <button
                    class="search-pop__item"
                    data-cursor={index() === cursor()}
                    onMouseEnter={() => setCursor(index())}
                    /*
                     * 不要在 mousedown 时让输入框失焦：失焦 140ms 后弹层会被移除，
                     * 用户点得稍慢（mousedown→mouseup 超过 140ms）时 click 落在
                     * 已移除的节点上，就出现「点了没反应、偶尔成功」。
                     */
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commit(item)}
                  >
                    <span class="tag">{MARKET_LABEL[item.market]}</span>
                    <span class="search-pop__name">{item.name}</span>
                    <span class="search-pop__code num">{item.code.toUpperCase()}</span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  )
}
