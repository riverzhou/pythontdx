/**
 * 自绘标题栏 = 品牌 + 搜索 + 时钟 + 全局工具按钮。
 *
 * 导航分三层，每个功能只有一个入口（2026-11-14 用户要求）：
 *   ① 左栏顶部（Sidebar）：自选 / 板块 / 自定义 三种列表、选择板块、新建、隐藏；
 *   ② 标题栏右侧（本文件）：数据工具、行情服务器、快捷键、设置、主题、预警；
 *   ③ 主区标签栏的「+」（WorkspaceTabs）：打开所有工作区页面
 *      （排行榜 / 全部 A 股 / 板块 / 多股同列 / 选股 / 复盘 / 组合 / 龙虎榜 …）。
 *
 * 旧版把 14 个页面入口塞进「报价 / 分析 / 资讯」三个下拉菜单，同一功能在菜单和
 * 「+」里各出现一次，点两次才能进页面。现在菜单整体移除：页面只从「+」进，
 * 工具只从右上角按钮进，左栏只放左栏自己的操作。
 */
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { WindowAction } from '@shared/types'
import { shell } from '../../lib/client'
import { appInfo, appState, toggleTheme, updateSettings } from '../../stores/app'
import { currentClock } from '../../stores/clock'
import { openPopup, openView } from '../../stores/workspace'
import {
  IconBell,
  IconClose,
  IconDatabase,
  IconFullscreen,
  IconFullscreenExit,
  IconKeyboard,
  IconMaximize,
  IconMinimize,
  IconMoon,
  IconRestore,
  IconServer,
  IconSettings,
  IconSidebar,
  IconSun
} from '../atoms/Icons'
import { SearchBox } from './SearchBox'

export function TitleBar(): JSX.Element {
  return (
    <header class="titlebar">
      <div class="titlebar__brand">
        <div class="titlebar__logo" />
        <span class="titlebar__title">pythontdx</span>
      </div>

      {/* 左右两个弹性空白，让搜索框大致居中 */}
      <div class="titlebar__drag" />
      <SearchBox />
      <div class="titlebar__drag" />

      <MarketClock />

      <div class="titlebar__actions">
        <button
          type="button"
          class="titlebar__tool sidebar-toggle"
          title={appState.settings.sidebarHidden === true ? '显示导航栏' : '隐藏导航栏'}
          aria-label={appState.settings.sidebarHidden === true ? '显示导航栏' : '隐藏导航栏'}
          onClick={() =>
            updateSettings({ sidebarHidden: appState.settings.sidebarHidden !== true })
          }
        >
          <IconSidebar size={14} />
        </button>
        <button
          type="button"
          class="titlebar__tool alerts-open"
          title="预警（规则与触发记录）"
          aria-label="打开预警"
          onClick={() => openView('alerts')}
        >
          <IconBell size={14} />
          <Show when={appState.alerts.length > 0}>
            <span class="titlebar__badge num">{appState.alerts.length}</span>
          </Show>
        </button>

        <span class="titlebar__divider" aria-hidden="true" />

        <button
          type="button"
          class="titlebar__tool data-open"
          title="数据工具：离线同步、备份恢复、数据湖"
          aria-label="数据工具"
          onClick={() => openPopup('data')}
        >
          <IconDatabase size={14} />
        </button>
        <button
          type="button"
          class="titlebar__tool servers-open"
          title="行情服务器：主站列表与测速"
          aria-label="行情服务器"
          onClick={() => openPopup('servers')}
        >
          <IconServer size={14} />
        </button>
        <button
          type="button"
          class="titlebar__tool shortcuts-open"
          title="快捷键（?）"
          aria-label="快捷键"
          onClick={() => openPopup('shortcuts')}
        >
          <IconKeyboard size={14} />
        </button>
        <span class="titlebar__divider" aria-hidden="true" />

        <button
          type="button"
          class="titlebar__tool settings-open"
          title="设置"
          aria-label="设置"
          onClick={() => openPopup('settings')}
        >
          <IconSettings size={14} />
        </button>
        <button
          type="button"
          class="titlebar__tool"
          title={appState.settings.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-label="切换主题"
          onClick={toggleTheme}
        >
          <Show when={appState.settings.theme === 'dark'} fallback={<IconSun size={14} />}>
            <IconMoon size={14} />
          </Show>
        </button>
        <WindowControls />
      </div>
    </header>
  )
}

/**
 * 主界面时钟。
 *
 * 行情软件里「现在几点」直接决定能不能交易、离收盘还有多久；固定显示北京时间，
 * 不跟随系统时区。
 */
function MarketClock(): JSX.Element {
  const clock = () => currentClock()
  return (
    <div
      class="market-clock"
      data-testid="market-clock"
      title={`北京时间 ${clock().date} ${clock().weekday} ${clock().time} · ${clock().sessionLabel}`}
    >
      <div class="market-clock__time num">
        <Show when={clock().trading}>
          <span class="market-clock__pulse" aria-hidden="true" />
        </Show>
        {clock().time}
      </div>
      <div class="market-clock__meta">
        <span>{clock().date}</span>
        <span>{clock().weekday}</span>
        <span class="market-clock__session">{clock().sessionLabel}</span>
      </div>
    </div>
  )
}

function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = createSignal(false)
  const [fullscreen, setFullscreen] = createSignal(false)

  onMount(() => {
    const dispose = shell.window.onStateChange((state) => {
      setMaximized(state.maximized)
      setFullscreen(state.fullscreen === true)
    })
    onCleanup(dispose)
  })

  const control = (action: WindowAction): void => {
    void shell.window.control(action).then((state) => {
      setMaximized(state.maximized)
      setFullscreen(state.fullscreen === true)
    })
  }

  return (
    <Show when={appInfo()?.platform !== 'darwin' && appInfo()?.platform !== 'web'}>
      <div class="win-controls">
        <button
          class="win-btn win-btn--fullscreen"
          title={fullscreen() ? '退出全屏' : '全屏'}
          aria-label={fullscreen() ? '退出全屏' : '全屏'}
          onClick={() => control('toggle-fullscreen')}
        >
          <Show when={fullscreen()} fallback={<IconFullscreen size={15} />}>
            <IconFullscreenExit size={15} />
          </Show>
        </button>
        <button class="win-btn" title="最小化" onClick={() => control('minimize')}>
          <IconMinimize size={16} />
        </button>
        <button
          class="win-btn"
          title={maximized() ? '向下还原' : '最大化'}
          onClick={() => control('toggle-maximize')}
        >
          <Show when={maximized()} fallback={<IconMaximize size={15} />}>
            <IconRestore size={15} />
          </Show>
        </button>
        <button class="win-btn win-btn--close" title="关闭" onClick={() => control('close')}>
          <IconClose size={16} />
        </button>
      </div>
    </Show>
  )
}
