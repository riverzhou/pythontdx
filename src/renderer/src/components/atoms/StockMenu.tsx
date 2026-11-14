/**
 * 个股右键菜单：把当前列表里的股票加入自选股或某个自定义板块。
 *
 * 分组是互斥的（一只股票只属于一个分组），所以这里的行为是「放进目标分组」：
 * 不在任何分组就新增，已在别的分组就移动过去，已在目标分组只切换选中。
 */
import { createMemo, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { splitCode } from '@shared/market'
import { addStockToGroup, appState } from '../../stores/app'
import { closeStockMenu, stockMenu } from '../../stores/stockMenu'

export function StockMenu(): JSX.Element {
  /** 主自选分组：名字叫「自选」的优先，否则用第一个 */
  const primary = createMemo(
    () => appState.groups.find((group) => group.name === '自选') ?? appState.groups[0]
  )
  const customGroups = createMemo(() =>
    appState.groups.filter((group) => group.id !== primary()?.id)
  )
  const currentGroup = createMemo(() => {
    const target = stockMenu()
    if (!target) return undefined
    return appState.groups.find((group) => group.items.some((item) => item.code === target.code))
  })

  const add = (groupId: string): void => {
    const target = stockMenu()
    if (!target) return
    const { market } = splitCode(target.code)
    addStockToGroup({ code: target.code, name: target.name, market }, groupId)
    closeStockMenu()
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeStockMenu()
    }
    const onDismiss = (): void => closeStockMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDismiss)
    window.addEventListener('wheel', onDismiss, { passive: true })
    onCleanup(() => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDismiss)
      window.removeEventListener('wheel', onDismiss)
    })
  })

  return (
    <Show when={stockMenu()}>
      {(target) => (
        <div
          class="stock-menu"
          role="menu"
          aria-label="个股操作"
          style={{
            left: `${Math.max(8, Math.min(target().x, window.innerWidth - 246))}px`,
            top: `${Math.max(8, Math.min(target().y, window.innerHeight - 320))}px`
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div class="stock-menu__head">
            <strong>{target().name}</strong>
            <span class="num">{target().code.toUpperCase()}</span>
          </div>

          <Show when={primary()}>
            {(group) => (
              <>
                <div class="stock-menu__section">添加到自选股</div>
                <button class="stock-menu__item" role="menuitem" onClick={() => add(group().id)}>
                  <span class="stock-menu__name">{group().name}</span>
                  <Show when={currentGroup()?.id === group().id}>
                    <span class="stock-menu__badge">已在</span>
                  </Show>
                  <span class="stock-menu__count num">{group().items.length}</span>
                </button>
              </>
            )}
          </Show>

          <Show when={customGroups().length > 0}>
            <div class="stock-menu__section">添加到自定义板块</div>
            <For each={customGroups()}>
              {(group) => (
                <button class="stock-menu__item" role="menuitem" onClick={() => add(group.id)}>
                  <span class="stock-menu__name">{group.name}</span>
                  <Show when={currentGroup()?.id === group.id}>
                    <span class="stock-menu__badge">已在</span>
                  </Show>
                  <span class="stock-menu__count num">{group.items.length}</span>
                </button>
              )}
            </For>
          </Show>

          <Show when={customGroups().length === 0}>
            <div class="stock-menu__hint">还没有自定义板块：左栏「+」新建分组后即可添加</div>
          </Show>

          <div class="stock-menu__foot">已在别的分组时会移动到所选板块</div>
        </div>
      )}
    </Show>
  )
}
