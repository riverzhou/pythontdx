/**
 * 主工作区标签栏 + 「打开功能页」选择器。
 *
 * 「+」是**所有工作区页面唯一的入口**（标题栏不再有页面菜单）：
 *   · 行情：排行榜 / 全部 A 股 / 板块 / 多股同列 / 自选行情墙 / 逐笔明细
 *   · 分析：条件选股 / 复盘 / 组合分析
 *   · 资讯：龙虎榜 / 沪深异动 / 大盘资料
 * 板块选择属于左栏「板块」视图（Sidebar），预警属于标题栏铃铛，都不在这里重复。
 */
import { For, Show, type JSX } from 'solid-js'
import {
  activeView,
  closeView,
  openView,
  tabs,
  VIEW_LABELS,
  VIEW_SECTIONS,
  type WorkspaceView
} from '../../stores/workspace'
import { IconClose, IconPlus } from '../atoms/Icons'
import { Menu, type MenuItem } from './Menu'

/** 右键/悬停提示里带的通达信数字命令，方便老用户继续用键盘 */
const SHORTCUT_HINTS: Partial<Record<WorkspaceView, string>> = {
  ranking: '60',
  market: '63',
  screener: 'F9',
  dragon: '77'
}

function menuItems(): MenuItem[] {
  const items: MenuItem[] = []
  for (const section of VIEW_SECTIONS) {
    if (items.length > 0) items.push({ separator: true })
    items.push({ section: section.title })
    for (const view of section.views) {
      items.push({
        label: VIEW_LABELS[view],
        hint: SHORTCUT_HINTS[view],
        id: `open-${view}`,
        onSelect: () => openView(view)
      })
    }
  }
  return items
}

export function WorkspaceTabs(): JSX.Element {
  return (
    <div class="workspace-tabbar">
      <div class="workspace-tabs" role="tablist" aria-label="工作区标签">
        <For each={tabs()}>
          {(view) => (
            <div
              class="workspace-tab"
              classList={{ 'workspace-tab--active': activeView() === view }}
              role="tab"
              aria-selected={activeView() === view}
              tabindex={activeView() === view ? 0 : -1}
              onClick={() => openView(view)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  openView(view)
                }
              }}
            >
              <span class="workspace-tab__label">{VIEW_LABELS[view]}</span>
              <Show when={view !== 'chart'}>
                <button
                  type="button"
                  class="workspace-tab__close"
                  title={`关闭${VIEW_LABELS[view]}`}
                  aria-label={`关闭${VIEW_LABELS[view]}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeView(view)
                  }}
                >
                  <IconClose size={11} />
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Menu
        class="workspace-tabs__new"
        label=""
        title="打开功能页（行情 / 分析 / 资讯）"
        icon={<IconPlus size={12} />}
        items={menuItems()}
      />
    </div>
  )
}
