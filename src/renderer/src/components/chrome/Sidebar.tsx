/**
 * 自选股列表（左栏）：分组标签 + 当前分组的股票列表。
 *
 * 这里有**两种**拖拽，落点判断必须区分开，否则会互相打架：
 *   ① 拖动「股票行」→ 目标是分组标签（跨组移动）或同组其它行（排序）；
 *   ② 拖动「分组标签」→ 目标是另一个分组标签（调整分组顺序）。
 *
 * 判断依据是 `draggingCode()`（来自 store，股票行设置）
 * 与 `draggingGroup()`（本组件内部，分组标签设置）。
 *
 * 其它交互：点标签切换分组；双击标签就地改名；悬停时出现删除按钮；
 * 列表空白处也能接收拖入（追加到末尾）；空分组显示引导文案。
 */
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import type { Quote, WatchGroup } from '@shared/types'
import {
  appState,
  createGroup,
  defaultGroup,
  draggingCode,
  moveWatchItem,
  removeGroup,
  removeWatchItem,
  renameGroup,
  setActiveGroup,
  setDraggingCode,
  updateSettings,
  watchItems
} from '../../stores/app'
import { quoteOf } from '../../stores/quotes'
import { createSparklineLoader, requestVisibleSparklines } from '../../stores/sparklines'
import { sector, setSidebarView, sidebarView, type SectorSelection } from '../../stores/sector'
import { openView, selectStock } from '../../stores/workspace'
import {
  IconColumns,
  IconExpand,
  IconFilter,
  IconGrid,
  IconLayers,
  IconList,
  IconNav,
  IconPlus
} from '../atoms/Icons'
import { StockRow } from '../atoms/StockRow'

export function Sidebar(): JSX.Element {
  /* ------------------------------------------- 自选股 / 板块 / 自定义 三种视图 */
  /** 自选股列表对应的分组（拖拽排序与删除都作用在它上面） */
  const watchGroupId = (): string => defaultGroup()?.id ?? appState.activeGroupId
  /** 自定义视图当前选中的分组 */
  const [customSector, setCustomSector] = createSignal<SectorSelection | null>(null)

  const groupSelection = (group: WatchGroup): SectorSelection => ({
    key: `custom:${group.id}`,
    kind: 'custom',
    name: group.name,
    codes: group.items.map((item) => item.code),
    names: Object.fromEntries(group.items.map((item) => [item.code, item.name])),
    groupId: group.id
  })

  const openSectorPicker = (): void => {
    openView('sector')
  }

  const openSectorView = (): void => {
    setSidebarView('sector')
    if (!sector()) openSectorPicker()
  }

  const openCustomView = (): void => {
    setSidebarView('custom')
    if (!customSector()) {
      // 自选不是自定义板块：默认选第一个真正的自定义分组
      const group = appState.groups.find((item) => item.id !== defaultGroup()?.id)
      if (group) {
        setCustomSector(groupSelection(group))
        setActiveGroup(group.id)
      }
    }
  }

  /** 按涨跌幅从高到低：排行列表的唯一排序规则 */
  const rankRows = (
    selection: SectorSelection | null
  ): Array<{ code: string; name: string; quote: Quote | undefined }> => {
    if (!selection) return []
    return selection.codes
      .map((code) => ({
        code,
        name: selection.names[code] || quoteOf(code)?.name || code,
        quote: quoteOf(code)
      }))
      .sort(
        (a, b) =>
          (b.quote?.changePct ?? Number.NEGATIVE_INFINITY) -
          (a.quote?.changePct ?? Number.NEGATIVE_INFINITY)
      )
  }

  const sectorRows = createMemo(() => rankRows(sector()))
  // 按「显示顺序」预热，而不是按板块原始代码顺序；否则涨跌幅排序后首屏可能没有走势图。
  createSparklineLoader(() => sectorRows().map((row) => row.code))
  /**
   * 自定义板块按 groupId 现算，而不是用选择时的快照：
   * 用户在这个分组里加/删股票后，排行要立刻跟着变。
   */
  const customBoard = createMemo(() => {
    const selection = customSector()
    if (!selection?.groupId) return selection
    const group = appState.groups.find((item) => item.id === selection.groupId)
    return group ? groupSelection(group) : selection
  })
  // 自定义板块按添加顺序展示（与多股同列一致），不按涨跌幅重排
  const customRows = createMemo(() => {
    const selection = customBoard()
    if (!selection) return []
    return selection.codes.map((code) => ({
      code,
      name: selection.names[code] || quoteOf(code)?.name || code,
      quote: quoteOf(code)
    }))
  })
  createSparklineLoader(() => customRows().map((row) => row.code))
  /** 「自定义板块」= 除自选之外的所有分组；自选那一组不再以分组形式出现 */
  const customGroups = createMemo(() =>
    appState.groups.filter((group) => group.id !== defaultGroup()?.id)
  )

  /** 自定义板块只有一层：一个下拉框 + 改名/删除；新建时弹输入框设名字 */
  const [nameDialog, setNameDialog] = createSignal<{
    mode: 'create' | 'rename'
    value: string
  } | null>(null)

  const openCreateDialog = (): void => {
    setNameDialog({ mode: 'create', value: '' })
  }

  const openRenameDialog = (): void => {
    const current = customBoard()
    if (!current?.groupId) return
    setNameDialog({ mode: 'rename', value: current.name })
  }

  const confirmName = (): void => {
    const dialog = nameDialog()
    if (!dialog) return
    const name = dialog.value.trim()
    if (!name) return
    if (dialog.mode === 'create') {
      createGroup(name)
      const created = appState.groups[appState.groups.length - 1]
      if (created) {
        setCustomSector(groupSelection(created))
        setActiveGroup(created.id)
        setSidebarView('custom')
      }
    } else {
      const current = customBoard()
      if (current?.groupId) {
        renameGroup(current.groupId, name)
        setCustomSector({ ...current, name })
      }
    }
    setNameDialog(null)
  }

  const deleteCustomBoard = (): void => {
    const current = customBoard()
    if (!current?.groupId) return
    removeGroup(current.groupId)
    setCustomSector(null)
  }

  /**
   * 把一只股票移出当前自定义板块。
   *
   * 分组 id 必须现读：`customBoard()` 可能还没选中分组，`undefined` 传给
   * `removeWatchItem` 会退回「自选」分组，一点「移出」就把自选里的同一只删掉。
   * 所以拿不到 id 时直接不动。
   */
  const removeFromCustomBoard = (code: string): void => {
    const groupId = customBoard()?.groupId
    if (!groupId) return
    removeWatchItem(code, groupId)
  }

  /** 拖到列表空白处 → 追加到自选股末尾（自选只有一层） */
  const dropStockOnList = (event: DragEvent): void => {
    event.preventDefault()
    const code = draggingCode() ?? event.dataTransfer?.getData('text/plain')
    setDraggingCode(null)
    if (!code) return
    const groupId = defaultGroup()?.id
    if (!groupId) return
    moveWatchItem(code, groupId, watchItems().length)
  }

  return (
    <aside class="sidebar">
      <div class="sidebar__head">
        <div class="sidebar__title">
          <IconNav size={12} />
          导航
        </div>
        {/* 新建板块留在标题行；快捷页栏只放页面入口，避免同一功能两个按钮 */}
        <Show when={sidebarView() !== 'sector'}>
          <button
            class="btn btn--icon btn--bare"
            title="新建自定义板块"
            aria-label="新建自定义板块"
            onClick={openCreateDialog}
          >
            <IconPlus size={13} />
          </button>
        </Show>
        <button
          class="btn btn--icon btn--bare sidebar-hide"
          title="隐藏导航栏"
          aria-label="隐藏导航栏"
          onClick={() => updateSettings({ sidebarHidden: true })}
        >
          «
        </button>
      </div>

      {/* 快捷页面栏：与标签栏「+」同源，只挑最常用的六个；放不下时收缩不换行 */}
      <div class="sidebar__quick" role="toolbar" aria-label="快捷页面">
        <button
          class="sidebar__quick-btn quick-ranking"
          title="排行榜（60）"
          aria-label="打开排行榜"
          onClick={() => openView('ranking')}
        >
          <IconList size={13} />
        </button>
        <button
          class="sidebar__quick-btn quick-market"
          title="全部 A 股（63）"
          aria-label="打开全部 A 股"
          onClick={() => openView('market')}
        >
          <IconGrid size={13} />
        </button>
        <button
          class="sidebar__quick-btn quick-blocks"
          title="板块 / 概念"
          aria-label="打开板块概念"
          onClick={() => openView('blocks')}
        >
          <IconLayers size={13} />
        </button>
        <button
          class="sidebar__quick-btn quick-multi"
          title="多股同列"
          aria-label="打开多股同列"
          onClick={() => openView('multi')}
        >
          <IconColumns size={13} />
        </button>
        <button
          class="sidebar__quick-btn quick-screener"
          title="条件选股（F9）"
          aria-label="打开条件选股"
          onClick={() => openView('screener')}
        >
          <IconFilter size={13} />
        </button>
        <button
          class="sidebar__quick-btn quick-watch"
          title="自选行情墙"
          aria-label="打开自选行情墙"
          onClick={() => openView('watch')}
        >
          <IconExpand size={13} />
        </button>
      </div>

      <div class="sidebar__modes" role="tablist" aria-label="左侧列表类型">
        <button
          class="sidebar__mode"
          role="tab"
          data-active={sidebarView() === 'watch'}
          onClick={() => {
            setSidebarView('watch')
            // 切回自选时把「当前分组」也复位，其它面板（多股同列/组合/全屏）才不会停在上一个自定义板块
            const group = defaultGroup()
            if (group) setActiveGroup(group.id)
          }}
        >
          自选股
        </button>
        <button
          class="sidebar__mode"
          role="tab"
          data-active={sidebarView() === 'sector'}
          onClick={openSectorView}
        >
          板块
        </button>
        <button
          class="sidebar__mode"
          role="tab"
          data-active={sidebarView() === 'custom'}
          onClick={openCustomView}
        >
          自定义
        </button>
      </div>

      <Show when={sidebarView() === 'watch'}>
        <div
          class="sidebar__list"
          onDragOver={(event) => draggingCode() && event.preventDefault()}
          onDrop={dropStockOnList}
        >
          <Show
            when={watchItems().length > 0}
            fallback={
              <div class="group-empty">
                自选股还是空的
                <br />
                搜索添加，或右键其它列表「加入自选股」
              </div>
            }
          >
            <For each={watchItems()}>
              {(item, index) => (
                <StockRow
                  code={item.code}
                  name={item.name}
                  index={index()}
                  groupId={watchGroupId()}
                  flash
                  onPick={() => selectStock(item.code)}
                  onRemove={() => removeWatchItem(item.code, watchGroupId())}
                />
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={sidebarView() === 'sector'}>
        <div class="sector-head">
          <button class="sector-head__pick" title="选择板块" onClick={() => openSectorPicker()}>
            <span class="sector-head__name">{sector()?.name ?? '选择板块'}</span>
            <span class="sector-head__count num">{sector()?.codes.length ?? 0}</span>
          </button>
          <button
            class="btn btn--icon btn--bare"
            title="换一个板块"
            aria-label="换一个板块"
            onClick={() => openSectorPicker()}
          >
            <IconGrid size={13} />
          </button>
        </div>
        <div
          class="sidebar__list sector-list"
          onScroll={(event) => requestVisibleSparklines(event.currentTarget)}
        >
          <Show
            when={sector()}
            fallback={
              <div class="group-empty">
                点上方「选择板块」
                <br />
                按涨跌幅查看该板块个股排行
              </div>
            }
          >
            <For each={sectorRows()}>
              {(row) => (
                <StockRow code={row.code} name={row.name} onPick={() => selectStock(row.code)} />
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={sidebarView() === 'custom'}>
        <div class="custom-bar">
          <select
            class="custom-select"
            aria-label="选择自定义板块"
            value={customBoard()?.groupId ?? ''}
            onChange={(event) => {
              const group = appState.groups.find((item) => item.id === event.currentTarget.value)
              if (!group) return
              setCustomSector(groupSelection(group))
              setActiveGroup(group.id)
            }}
          >
            <Show when={customGroups().length === 0}>
              <option value="">暂无自定义板块</option>
            </Show>
            <For each={customGroups()}>
              {(group) => (
                <option value={group.id}>{`${group.name}（${group.items.length}）`}</option>
              )}
            </For>
          </select>
          <button class="btn" disabled={!customBoard()?.groupId} onClick={openRenameDialog}>
            改名
          </button>
          <button class="btn" disabled={!customBoard()?.groupId} onClick={deleteCustomBoard}>
            删除
          </button>
        </div>
        <div
          class="sidebar__list sector-list"
          onScroll={(event) => requestVisibleSparklines(event.currentTarget)}
        >
          <Show
            when={customSector()}
            fallback={
              <div class="group-empty">
                点上方选择一个自定义板块
                <br />
                （自定义板块就是自选分组，可用「+」新建）
              </div>
            }
          >
            <For each={customRows()}>
              {(row, index) => (
                <StockRow
                  code={row.code}
                  name={row.name}
                  index={index()}
                  groupId={customBoard()?.groupId}
                  flash
                  onPick={() => selectStock(row.code)}
                  onRemove={() => removeFromCustomBoard(row.code)}
                  removeTitle="移出板块"
                />
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={nameDialog()}>
        {(dialog) => (
          <div class="name-dialog" onClick={() => setNameDialog(null)}>
            <div class="name-dialog__panel" onClick={(event) => event.stopPropagation()}>
              <div class="name-dialog__title">
                {dialog().mode === 'create' ? '新建自定义板块' : '重命名自定义板块'}
              </div>
              <input
                class="name-dialog__input"
                value={dialog().value}
                autofocus
                placeholder="板块名称"
                onInput={(event) =>
                  setNameDialog((prev) =>
                    prev ? { ...prev, value: event.currentTarget.value } : prev
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') confirmName()
                  if (event.key === 'Escape') setNameDialog(null)
                }}
              />
              <div class="name-dialog__actions">
                <button class="btn" onClick={() => setNameDialog(null)}>
                  取消
                </button>
                <button class="btn btn--primary" onClick={confirmName}>
                  确定
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <div class="sidebar__foot" title="数据来源：通达信行情；行情有延迟，仅供参考，不构成投资建议">
        数据来源通达信 · 仅供参考
      </div>
    </aside>
  )
}
