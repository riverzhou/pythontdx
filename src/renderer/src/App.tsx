/**
 * 应用根组件：主工作区标签页 + 三栏布局。
 *
 * 页面逻辑（2026-11-14 重整）：
 *   · 行情相关的显示（排行榜、板块、全市场、多股同列、选股、复盘、组合、
 *     预警、龙虎榜、异动、大盘资料、自选行情墙）全部是工作区标签页；
 *   · 只有设置、数据、F10/公告、公式/指标编辑器、服务器、快捷键是弹窗；
 *   · 左栏始终是自选/板块/自定义，右栏只在「行情」标签出现。
 */
import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX
} from 'solid-js'
import type { Quote } from '@shared/types'
import { AlertPanel } from './components/panels/AlertPanel'
import { AlertToast } from './components/atoms/AlertToast'
import { AnnouncementsPanel } from './components/panels/AnnouncementsPanel'
import { AuctionTape } from './components/atoms/AuctionTape'
import { BlockPanel } from './components/panels/BlockPanel'
import { ChartPanel } from './components/panels/ChartPanel'
import { DataPanel } from './components/panels/DataPanel'
import { DragonPanel } from './components/panels/DragonPanel'
import { EmptyState } from './components/atoms/EmptyState'
import { F10Panel } from './components/panels/F10Panel'
import { FormulaPanel } from './components/panels/FormulaPanel'
import { IndicatorPanel } from './components/panels/IndicatorPanel'
import { MarketListPanel } from './components/panels/MarketListPanel'
import { MarketReportPanel } from './components/panels/MarketReportPanel'
import { MoneyFlow } from './components/atoms/MoneyFlow'
import { MultiStockPanel } from './components/panels/MultiStockPanel'
import { OrderBook } from './components/atoms/OrderBook'
import { PortfolioPanel } from './components/panels/PortfolioPanel'
import { PriceDistribution } from './components/atoms/PriceDistribution'
import { QuoteHeader } from './components/atoms/QuoteHeader'
import { RankingPanel } from './components/panels/RankingPanel'
import { ReplayPanel } from './components/panels/ReplayPanel'
import { ScreenerPanel } from './components/panels/ScreenerPanel'
import { SectorPicker } from './components/atoms/SectorPicker'
import { ServerWindow } from './components/atoms/ServerWindow'
import { SettingsPanel } from './components/panels/SettingsPanel'
import { ShortcutsPanel } from './components/panels/ShortcutsPanel'
import { Sidebar } from './components/chrome/Sidebar'
import { StatsGrid } from './components/atoms/StatsGrid'
import { StatusBar } from './components/chrome/StatusBar'
import { StockMenu } from './components/atoms/StockMenu'
import { TitleBar } from './components/chrome/TitleBar'
import { TradeTape } from './components/atoms/TradeTape'
import { UnusualPanel } from './components/panels/UnusualPanel'
import { WatchlistFullscreen } from './components/atoms/WatchlistFullscreen'
import { WorkspaceTabs } from './components/chrome/WorkspaceTabs'
import {
  activeQuoteCode,
  appInfo,
  appReady,
  appState,
  bootstrapAppState,
  initWindowSync,
  startAutoArchive,
  startMarketCalendar,
  toggleTheme,
  updateSettings,
  watchCodes
} from './stores/app'
import {
  applyQuotes,
  createQuoteStream,
  loadCachedQuotes,
  quoteOf,
  refreshQuotes
} from './stores/quotes'
import { api, shell } from './lib/client'
import { createSparklineLoader } from './stores/sparklines'
import { dismissLatestAlert, hydrateAlertEvents, latestAlert } from './stores/alerts'
import { startScreenTracking } from './stores/screenTracking'
import { startClock } from './stores/clock'
import { trackSector } from './stores/sector'
import {
  activeView,
  closePopup,
  closeView,
  openPopup,
  openView,
  popup,
  selectStock,
  togglePopup
} from './stores/workspace'

const COMMANDS: Record<string, 'ranking' | 'market' | 'dragon'> = {
  '60': 'ranking',
  '63': 'market',
  '77': 'dragon'
}

export default function App(): JSX.Element {
  const [railTab, setRailTab] = createSignal<'tape' | 'stats' | 'price' | 'flow' | 'auction'>(
    'tape'
  )
  const [widths, setWidths] = createSignal<{ sidebar: number; rail: number } | null>(null)
  const [liveStarted, setLiveStarted] = createSignal(false)
  let stopResize: (() => void) | null = null
  let commandBuffer = ''
  let commandTimer: ReturnType<typeof setTimeout> | undefined

  const pickQuote = (quote: Quote): void => {
    applyQuotes([quote])
    selectStock(quote.code)
  }

  onMount(() => {
    // 行情推送晚 250ms 起步：把桥接队列先让给图表缓存和逐笔归档，
    // 首屏先出图/出逐笔，行情头继续用 localStorage 快照顶着。
    const liveTimer = setTimeout(() => setLiveStarted(true), 250)
    onCleanup(() => clearTimeout(liveTimer))
    void bootstrapAppState().then(() => {
      applyQuotes(loadCachedQuotes())
      hydrateAlertEvents()
    })
    startClock()
    startScreenTracking()
    startAutoArchive()
    startMarketCalendar()
    initWindowSync()

    const runCommand = (command: string): void => {
      const view = COMMANDS[command]
      if (view) openView(view)
    }
    const pushCommandDigit = (digit: string): void => {
      commandBuffer += digit
      if (commandBuffer.length > 2) commandBuffer = commandBuffer.slice(-2)
      if (commandTimer) clearTimeout(commandTimer)
      commandTimer = setTimeout(() => {
        commandBuffer = ''
      }, 700)
      if (COMMANDS[commandBuffer]) {
        runCommand(commandBuffer)
        commandBuffer = ''
      }
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!appReady() || event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'Escape') {
        if (popup()) {
          closePopup()
          return
        }
        if (activeView() !== 'chart') {
          closeView(activeView())
          return
        }
        return
      }

      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
      ) {
        return
      }

      if (event.key === 'F11') {
        event.preventDefault()
        if (appInfo()?.platform === 'web') {
          if (document.fullscreenElement) void document.exitFullscreen()
          else void document.documentElement.requestFullscreen()
        } else {
          void shell.window.control('toggle-fullscreen')
        }
        return
      }
      if (event.key === 'F10') {
        event.preventDefault()
        if (activeQuoteCode()) togglePopup('f10')
        return
      }
      if (event.key === 'F3') {
        event.preventDefault()
        selectStock('sh000001')
        return
      }
      if (event.key === 'F4') {
        event.preventDefault()
        selectStock('sz399001')
        return
      }
      if (event.key === 'F5') {
        event.preventDefault()
        if (activeView() !== 'chart') openView('chart')
        else window.dispatchEvent(new CustomEvent('pythontdx:chart-toggle'))
        return
      }
      if (event.key === 'F6') {
        event.preventDefault()
        openView('chart')
        return
      }
      if (event.key === 'F7') {
        event.preventDefault()
        if (activeQuoteCode()) openPopup('announcements')
        return
      }
      if (event.key === 'F9') {
        event.preventDefault()
        openView('screener')
        return
      }

      if (event.key === '/') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.search__input')?.focus()
        return
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        void refreshQuotes(watchCodes())
        return
      }
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        toggleTheme()
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        openPopup('shortcuts')
        return
      }
      if (/^[0-9]$/.test(event.key)) {
        pushCommandDigit(event.key)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown)
      if (commandTimer) clearTimeout(commandTimer)
    })
  })

  // 主题：把设置写进 <html data-theme>，CSS 变量会自动切换
  createEffect(() => {
    document.documentElement.dataset.theme = appState.settings.theme
  })

  // 行情推送：自选股 + 当前选中股（排行榜点进来的股票不在自选里，也要能刷新）
  const quoteCodes = (): string[] => {
    if (!appReady() || !liveStarted()) return []
    const active = activeQuoteCode()
    return active ? [...new Set([...watchCodes(), active])] : watchCodes()
  }

  createQuoteStream(quoteCodes, () => appState.settings.refreshInterval)

  /*
   * 从搜索结果/排行榜选中一只不在自选里的股票时，行情流要等下一拍才回来，
   * 这段时间主区会停在空态，看起来像「点不开」。这里主动补一次快照，
   * 让行情头立刻出现；行情流随后会用同一份数据覆盖，不会多出第二套状态。
   */
  createEffect(() => {
    const code = activeQuoteCode()
    if (!appReady() || !code || quoteOf(code)) return
    let cancelled = false
    void api.quote
      .snapshot([code])
      .then((quotes) => {
        if (!cancelled) applyQuotes(quotes)
      })
      .catch(() => {
        // 失败时行情流仍会按自己的节奏重试，不在这里弹错
      })
    onCleanup(() => {
      cancelled = true
    })
  })

  // 自选股行内迷你走势图：并发受限地补齐并定期刷新
  createSparklineLoader(() => (appReady() ? watchCodes() : []))

  const activeQuote = (): Quote | undefined => quoteOf(activeQuoteCode())

  const currentWidths = (): { sidebar: number; rail: number } =>
    widths() ?? {
      sidebar: appState.settings.sidebarWidth ?? 280,
      rail: appState.settings.railWidth ?? 330
    }

  const beginResize = (side: 'sidebar' | 'rail', event: PointerEvent): void => {
    event.preventDefault()
    stopResize?.()
    const initialWidths = currentWidths()
    const onMove = (moveEvent: PointerEvent): void => {
      const next =
        side === 'sidebar'
          ? Math.min(380, Math.max(200, Math.round(moveEvent.clientX)))
          : Math.min(460, Math.max(260, Math.round(window.innerWidth - moveEvent.clientX)))
      setWidths({
        sidebar: side === 'sidebar' ? next : initialWidths.sidebar,
        rail: side === 'rail' ? next : initialWidths.rail
      })
    }
    const finish = (): void => {
      const value = widths()
      if (value) updateSettings({ sidebarWidth: value.sidebar, railWidth: value.rail })
      setWidths(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      stopResize = null
    }
    stopResize = finish
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
  }

  onCleanup(() => stopResize?.())

  const appStyle = (): JSX.CSSProperties =>
    ({
      '--sidebar-w': `${currentWidths().sidebar}px`,
      '--rail-w': `${currentWidths().rail}px`
    }) as JSX.CSSProperties

  const missingQuote = (view: string): JSX.Element => (
    <div class="view-empty">
      <div class="view-empty__title">{view}需要先选一只股票</div>
      <div class="view-empty__hint">从左侧自选或「报价」菜单里选一只股票后再打开。</div>
      <button class="btn" onClick={() => closeView(activeView())}>
        返回行情
      </button>
    </div>
  )

  return (
    <div
      class="app"
      classList={{
        'app--empty': !activeQuote() && activeView() === 'chart',
        'app--sidebar-hidden': appState.settings.sidebarHidden === true,
        'app--view': activeView() !== 'chart'
      }}
      style={appStyle()}
    >
      <TitleBar />
      <Sidebar />

      <main class="workspace">
        <WorkspaceTabs />
        <div class="workspace__body">
          <Switch
            fallback={
              <Show when={activeQuote()} fallback={<EmptyState />}>
                {(quote) => (
                  <>
                    <QuoteHeader quote={quote()} />
                    <ChartPanel
                      code={quote().code}
                      onChartTabChange={(next) => {
                        if (next === 'minute' || next === 'five') setRailTab('tape')
                      }}
                    />
                  </>
                )}
              </Show>
            }
          >
            <Match when={activeView() === 'ranking'}>
              <RankingPanel
                embedded
                onClose={() => closeView('ranking')}
                onSelect={(quote) => {
                  pickQuote(quote)
                }}
              />
            </Match>
            <Match when={activeView() === 'blocks'}>
              <BlockPanel
                embedded
                onClose={() => closeView('blocks')}
                onSelect={(quote) => pickQuote(quote)}
              />
            </Match>
            <Match when={activeView() === 'sector'}>
              <SectorPicker
                embedded
                onClose={() => closeView('sector')}
                onPick={(selection) => {
                  trackSector(selection)
                  closeView('sector')
                }}
              />
            </Match>
            <Match when={activeView() === 'market'}>
              <MarketListPanel
                embedded
                onClose={() => closeView('market')}
                onSelect={(quote) => pickQuote(quote)}
                onOpenBlocks={() => openView('blocks')}
              />
            </Match>
            <Match when={activeView() === 'screener'}>
              <ScreenerPanel
                embedded
                onClose={() => closeView('screener')}
                onSelect={(quote) => pickQuote(quote)}
              />
            </Match>
            <Match when={activeView() === 'multi'}>
              <MultiStockPanel
                embedded
                onClose={() => closeView('multi')}
                onSelect={(code) => selectStock(code)}
              />
            </Match>
            <Match when={activeView() === 'watch'}>
              <WatchlistFullscreen
                embedded
                onClose={() => closeView('watch')}
                onSelect={(code) => selectStock(code)}
              />
            </Match>
            <Match when={activeView() === 'tape'}>
              <Show when={activeQuote()} fallback={missingQuote('逐笔明细')}>
                {(quote) => (
                  <div class="view-shell">
                    <header class="view-shell__head">
                      <span class="view-shell__title">
                        逐笔成交 · {quote().name}{' '}
                        <span class="num view-shell__code">{quote().code.toUpperCase()}</span>
                      </span>
                      <button
                        class="btn btn--icon btn--bare"
                        title="关闭逐笔明细"
                        onClick={() => closeView('tape')}
                      >
                        ×
                      </button>
                    </header>
                    <div class="view-shell__body">
                      <TradeTape code={quote().code} showExpand={false} variant="board" />
                    </div>
                  </div>
                )}
              </Show>
            </Match>
            <Match when={activeView() === 'portfolio'}>
              <PortfolioPanel
                embedded
                onClose={() => closeView('portfolio')}
                onSelect={(quote) => selectStock(quote.code)}
              />
            </Match>
            <Match when={activeView() === 'report'}>
              <MarketReportPanel embedded onClose={() => closeView('report')} />
            </Match>
            <Match when={activeView() === 'dragon'}>
              <DragonPanel
                embedded
                onClose={() => closeView('dragon')}
                onSelect={(code) => selectStock(code)}
              />
            </Match>
            <Match when={activeView() === 'unusual'}>
              <UnusualPanel
                embedded
                onClose={() => closeView('unusual')}
                onSelect={(code) => selectStock(code)}
              />
            </Match>
            <Match when={activeView() === 'replay'}>
              <Show when={activeQuote()} fallback={missingQuote('复盘')}>
                {(quote) => (
                  <ReplayPanel
                    embedded
                    code={quote().code}
                    name={quote().name}
                    onClose={() => closeView('replay')}
                  />
                )}
              </Show>
            </Match>
            <Match when={activeView() === 'alerts'}>
              <AlertPanel
                embedded
                quote={activeQuote()}
                onClose={() => closeView('alerts')}
                onSelect={(code) => selectStock(code)}
              />
            </Match>
          </Switch>
        </div>
      </main>

      <Show when={activeView() === 'chart' ? activeQuote() : undefined}>
        {(quote) => (
          <aside class="rail rail--stacked">
            <section class="card panel panel--book">
              <div class="panel__head">
                <span class="card__title">五档盘口</span>
                <span class="statusbar__text">手</span>
              </div>
              <div class="panel__body panel__body--fill">
                <OrderBook quote={quote()} />
              </div>
            </section>

            <section class="card panel panel--detail">
              <div class="panel__head panel__head--tabs">
                <div class="rail-tabs" role="tablist" aria-label="成交与指标">
                  <button
                    class="rail-tab rail-tab--tape"
                    classList={{ 'rail-tab--active': railTab() === 'tape' }}
                    role="tab"
                    aria-selected={railTab() === 'tape'}
                    onClick={() => setRailTab('tape')}
                  >
                    明细
                  </button>
                  <button
                    class="rail-tab rail-tab--stats"
                    classList={{ 'rail-tab--active': railTab() === 'stats' }}
                    role="tab"
                    aria-selected={railTab() === 'stats'}
                    onClick={() => setRailTab('stats')}
                  >
                    指标
                  </button>
                  <button
                    class="rail-tab rail-tab--price"
                    classList={{ 'rail-tab--active': railTab() === 'price' }}
                    role="tab"
                    aria-selected={railTab() === 'price'}
                    onClick={() => setRailTab('price')}
                  >
                    分价
                  </button>
                  <button
                    class="rail-tab rail-tab--flow"
                    classList={{ 'rail-tab--active': railTab() === 'flow' }}
                    role="tab"
                    aria-selected={railTab() === 'flow'}
                    onClick={() => setRailTab('flow')}
                  >
                    资金
                  </button>
                  <button
                    class="rail-tab rail-tab--auction"
                    classList={{ 'rail-tab--active': railTab() === 'auction' }}
                    role="tab"
                    aria-selected={railTab() === 'auction'}
                    onClick={() => setRailTab('auction')}
                  >
                    竞价
                  </button>
                </div>
                <span class="statusbar__text">
                  {railTab() === 'tape'
                    ? '60 笔'
                    : railTab() === 'stats'
                      ? 'A 股'
                      : railTab() === 'flow'
                        ? '5 日'
                        : '快照'}
                </span>
              </div>
              <div class="panel__body panel__body--fill">
                <Switch fallback={<TradeTape code={quote().code} />}>
                  <Match when={railTab() === 'stats'}>
                    <StatsGrid quote={quote()} />
                  </Match>
                  <Match when={railTab() === 'price'}>
                    <PriceDistribution code={quote().code} />
                  </Match>
                  <Match when={railTab() === 'flow'}>
                    <MoneyFlow code={quote().code} />
                  </Match>
                  <Match when={railTab() === 'auction'}>
                    <AuctionTape code={quote().code} />
                  </Match>
                </Switch>
              </div>
            </section>
          </aside>
        )}
      </Show>

      <StatusBar />

      {/* ------------------------------------------------ 允许保留的弹窗 */}
      <Show when={popup() === 'f10' ? activeQuote() : undefined}>
        {(quote) => (
          <F10Panel code={quote().code} name={quote().name} onClose={() => closePopup()} />
        )}
      </Show>
      <Show when={popup() === 'announcements' ? activeQuote() : undefined}>
        {(quote) => (
          <AnnouncementsPanel
            code={quote().code}
            name={quote().name}
            onClose={() => closePopup()}
          />
        )}
      </Show>
      <Show when={popup() === 'formula' ? activeQuote() : undefined}>
        {(quote) => (
          <FormulaPanel
            code={quote().code}
            name={quote().name}
            onClose={() => closePopup()}
            onSelect={(code) => {
              selectStock(code)
            }}
          />
        )}
      </Show>
      <Show when={popup() === 'indicators' ? activeQuote() : undefined}>
        {(quote) => (
          <IndicatorPanel code={quote().code} name={quote().name} onClose={() => closePopup()} />
        )}
      </Show>
      <Show when={popup() === 'data'}>
        <DataPanel onClose={() => closePopup()} />
      </Show>
      <Show when={popup() === 'settings'}>
        <SettingsPanel onClose={() => closePopup()} />
      </Show>
      <Show when={popup() === 'servers'}>
        <div
          class="server-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) closePopup()
          }}
        >
          <section class="server-shell" role="dialog" aria-modal="true" aria-label="行情服务器">
            <ServerWindow onClose={() => closePopup()} />
          </section>
        </div>
      </Show>
      <Show when={popup() === 'shortcuts'}>
        <ShortcutsPanel onClose={() => closePopup()} />
      </Show>

      <Show when={latestAlert()}>
        {(event) => (
          <AlertToast
            event={event()}
            onDismiss={dismissLatestAlert}
            onSelect={(code) => selectStock(code)}
          />
        )}
      </Show>

      <div
        class="layout-resizer layout-resizer--sidebar"
        role="separator"
        title="拖动调整导航栏宽度，双击恢复 264px"
        aria-label="调整导航栏宽度"
        onPointerDown={(event) => beginResize('sidebar', event)}
        onDblClick={() => updateSettings({ sidebarWidth: 264 })}
      />
      <div
        class="layout-resizer layout-resizer--rail"
        role="separator"
        aria-label="调整盘口栏宽度"
        onPointerDown={(event) => beginResize('rail', event)}
        onDblClick={() => updateSettings({ railWidth: 300 })}
      />
      {/* 任意个股列表右键弹出的「加入自选/自定义板块」菜单 */}
      <StockMenu />
    </div>
  )
}
