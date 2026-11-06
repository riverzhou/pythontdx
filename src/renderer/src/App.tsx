/**
 * 应用根组件：负责布局、主题注入和行情订阅的启动。
 *
 * 布局用 CSS Grid 划成「标题栏 / 侧栏 + 工作区 / 状态栏」三块，
 * 这里只做结构，具体样式在 styles/app.css。
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
import { AlertPanel } from './components/AlertPanel'
import { AlertToast } from './components/AlertToast'
import { AuctionTape } from './components/AuctionTape'
import { BlockPanel } from './components/BlockPanel'
import { ChartPanel } from './components/ChartPanel'
import { AnnouncementsPanel } from './components/AnnouncementsPanel'
import { DataPanel } from './components/DataPanel'
import { EmptyState } from './components/EmptyState'
import { F10Panel } from './components/F10Panel'
import { FormulaPanel } from './components/FormulaPanel'
import { IndicatorPanel } from './components/IndicatorPanel'
import { MoneyFlow } from './components/MoneyFlow'
import { MultiStockPanel } from './components/MultiStockPanel'
import { OrderBook } from './components/OrderBook'
import { QuoteHeader } from './components/QuoteHeader'
import { RankingPanel } from './components/RankingPanel'
import { ReplayPanel } from './components/ReplayPanel'
import { ScreenerPanel } from './components/ScreenerPanel'
import { Sidebar } from './components/Sidebar'
import { WatchlistFullscreen } from './components/WatchlistFullscreen'
import { StatsGrid } from './components/StatsGrid'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { TradeTape } from './components/TradeTape'
import { PriceDistribution } from './components/PriceDistribution'
import { SettingsPanel } from './components/SettingsPanel'
import { ServerWindow } from './components/ServerWindow'
import { PortfolioPanel } from './components/PortfolioPanel'
import { MarketListPanel } from './components/MarketListPanel'
import { UnusualPanel } from './components/UnusualPanel'
import { DragonPanel } from './components/DragonPanel'
import { MarketReportPanel } from './components/MarketReportPanel'
import { ShortcutsPanel } from './components/ShortcutsPanel'
import { StockMenu } from './components/StockMenu'
import {
  activeQuoteCode,
  appInfo,
  appReady,
  appState,
  bootstrapAppState,
  initWindowSync,
  setActiveCode,
  toggleTheme,
  updateSettings,
  watchCodes,
  startAutoArchive,
  startMarketCalendar
} from './stores/app'
import {
  applyQuotes,
  createQuoteStream,
  loadCachedQuotes,
  quoteOf,
  refreshQuotes
} from './stores/quotes'
import { api } from './lib/ipc'
import { createSparklineLoader } from './stores/sparklines'
import { dismissLatestAlert, hydrateAlertEvents, latestAlert } from './stores/alerts'
import { startScreenTracking } from './stores/screenTracking'
import { startClock } from './stores/clock'

export default function App(): JSX.Element {
  const [rankingOpen, setRankingOpen] = createSignal(false)
  const [blocksOpen, setBlocksOpen] = createSignal(false)
  const [screenerOpen, setScreenerOpen] = createSignal(false)
  const [replayOpen, setReplayOpen] = createSignal(false)
  const [formulaOpen, setFormulaOpen] = createSignal(false)
  const [indicatorOpen, setIndicatorOpen] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [serversOpen, setServersOpen] = createSignal(false)
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false)
  const [portfolioOpen, setPortfolioOpen] = createSignal(false)
  const [marketOpen, setMarketOpen] = createSignal(false)
  const [unusualOpen, setUnusualOpen] = createSignal(false)
  const [dragonOpen, setDragonOpen] = createSignal(false)
  const [marketReportOpen, setMarketReportOpen] = createSignal(false)
  const [f10Open, setF10Open] = createSignal(false)
  const [announcementsOpen, setAnnouncementsOpen] = createSignal(false)
  const [multiOpen, setMultiOpen] = createSignal(false)
  const [fullWatchlistOpen, setFullWatchlistOpen] = createSignal(false)
  const [dataOpen, setDataOpen] = createSignal(false)
  const [alertsOpen, setAlertsOpen] = createSignal(false)
  const [railTab, setRailTab] = createSignal<'tape' | 'stats' | 'price' | 'flow' | 'auction'>(
    'tape'
  )
  const [widths, setWidths] = createSignal<{ sidebar: number; rail: number } | null>(null)
  const [liveStarted, setLiveStarted] = createSignal(false)
  let stopResize: (() => void) | null = null

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
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!appReady() || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'F11') {
        event.preventDefault()
        if (appInfo()?.platform === 'web') {
          if (document.fullscreenElement) void document.exitFullscreen()
          else void document.documentElement.requestFullscreen()
        } else {
          void api.window.control('toggle-fullscreen')
        }
        return
      }
      if (event.key === 'F10') {
        event.preventDefault()
        setF10Open((value) => !value)
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
      if (event.key === '/') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.search__input')?.focus()
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        void refreshQuotes(quoteCodes())
      } else if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        toggleTheme()
      } else if (event.key === '?') {
        event.preventDefault()
        setShortcutsOpen((value) => !value)
      } else if (event.key === 'Escape' && shortcutsOpen()) {
        setShortcutsOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
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

  return (
    <div
      class="app"
      classList={{
        'app--empty': !activeQuote(),
        'app--sidebar-hidden': appState.settings.sidebarHidden === true
      }}
      style={appStyle()}
    >
      <TitleBar
        onOpenData={() => setDataOpen(true)}
        onOpenUnusual={() => setUnusualOpen(true)}
        onOpenDragon={() => setDragonOpen(true)}
        onOpenAlerts={() => setAlertsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenServers={() => setServersOpen(true)}
        sidebarHidden={appState.settings.sidebarHidden === true}
        onToggleSidebar={() =>
          updateSettings({ sidebarHidden: !(appState.settings.sidebarHidden === true) })
        }
      />
      <Show when={appState.settings.sidebarHidden === true}>
        <button
          class="sidebar-reveal"
          title="展开自选栏"
          onClick={() => updateSettings({ sidebarHidden: false })}
        >
          自选 »
        </button>
      </Show>
      <Sidebar
        onOpenRanking={() => setRankingOpen(true)}
        onOpenBlocks={() => setBlocksOpen(true)}
        onOpenScreener={() => setScreenerOpen(true)}
        onOpenMulti={() => setMultiOpen(true)}
        onOpenPortfolio={() => setPortfolioOpen(true)}
        onOpenMarket={() => setMarketOpen(true)}
        onOpenFullWatchlist={() => setFullWatchlistOpen(true)}
      />

      {/* 主区只有两块：行情头部 + 图表。图表用 flex 吃掉全部剩余高度 */}
      <main class="workspace">
        <Show when={activeQuote()} fallback={<EmptyState />}>
          {(quote) => (
            <>
              <QuoteHeader
                quote={quote()}
                onOpenF10={() => setF10Open(true)}
                onOpenAnnouncements={() => setAnnouncementsOpen(true)}
              />
              <ChartPanel
                code={quote().code}
                onOpenReplay={() => setReplayOpen(true)}
                onOpenFormula={() => setFormulaOpen(true)}
                onOpenIndicators={() => setIndicatorOpen(true)}
                onChartTabChange={(next) => {
                  if (next === 'minute' || next === 'five') setRailTab('tape')
                }}
              />
            </>
          )}
        </Show>
      </main>

      {/* 右栏：盘口在上（自适应撑开），指标在下（内容高度） */}
      <aside class="rail rail--stacked">
        <Show when={activeQuote()}>
          {(quote) => (
            <>
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
                        ? quote().market === 'HK'
                          ? '港股'
                          : 'A 股'
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
            </>
          )}
        </Show>
      </aside>

      <StatusBar
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenMarketReport={() => setMarketReportOpen(true)}
      />

      <Show when={rankingOpen()}>
        <RankingPanel
          onClose={() => setRankingOpen(false)}
          onSelect={(quote) => {
            // 排行里的股票通常不在自选：先塞进行情 store，再让 active code 进入订阅
            applyQuotes([quote])
            setActiveCode(quote.code)
            setRankingOpen(false)
          }}
        />
      </Show>

      <Show when={f10Open() ? activeQuote() : undefined}>
        {(quote) => (
          <F10Panel code={quote().code} name={quote().name} onClose={() => setF10Open(false)} />
        )}
      </Show>

      <Show when={blocksOpen()}>
        <BlockPanel
          onClose={() => setBlocksOpen(false)}
          onSelect={(quote) => {
            applyQuotes([quote])
            setActiveCode(quote.code)
            setBlocksOpen(false)
          }}
        />
      </Show>

      <Show when={screenerOpen()}>
        <ScreenerPanel
          onClose={() => setScreenerOpen(false)}
          onSelect={(quote) => {
            applyQuotes([quote])
            setActiveCode(quote.code)
            setScreenerOpen(false)
          }}
        />
      </Show>

      <Show when={dataOpen()}>
        <DataPanel onClose={() => setDataOpen(false)} />
      </Show>

      <Show when={replayOpen() ? activeQuote() : undefined}>
        {(quote) => (
          <ReplayPanel
            code={quote().code}
            name={quote().name}
            onClose={() => setReplayOpen(false)}
          />
        )}
      </Show>

      <Show when={multiOpen()}>
        <MultiStockPanel
          onClose={() => setMultiOpen(false)}
          onSelect={(code) => setActiveCode(code)}
        />
      </Show>

      <Show when={fullWatchlistOpen()}>
        <WatchlistFullscreen onClose={() => setFullWatchlistOpen(false)} onSelect={setActiveCode} />
      </Show>

      <Show when={announcementsOpen() ? activeQuote() : undefined}>
        {(quote) => (
          <AnnouncementsPanel
            code={quote().code}
            name={quote().name}
            onClose={() => setAnnouncementsOpen(false)}
          />
        )}
      </Show>

      <Show when={marketReportOpen()}>
        <MarketReportPanel onClose={() => setMarketReportOpen(false)} />
      </Show>

      <Show when={dragonOpen()}>
        <DragonPanel
          onClose={() => setDragonOpen(false)}
          onSelect={(code) => {
            setActiveCode(code)
            setDragonOpen(false)
          }}
        />
      </Show>

      <Show when={unusualOpen()}>
        <UnusualPanel
          onClose={() => setUnusualOpen(false)}
          onSelect={(code) => {
            setActiveCode(code)
            setUnusualOpen(false)
          }}
        />
      </Show>

      <Show when={marketOpen()}>
        <MarketListPanel
          onClose={() => setMarketOpen(false)}
          onSelect={(quote) => {
            applyQuotes([quote])
            setActiveCode(quote.code)
            setMarketOpen(false)
          }}
          onOpenBlocks={() => setBlocksOpen(true)}
        />
      </Show>

      <Show when={portfolioOpen()}>
        <PortfolioPanel
          onClose={() => setPortfolioOpen(false)}
          onSelect={(quote) => setActiveCode(quote.code)}
        />
      </Show>

      <Show when={shortcutsOpen()}>
        <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />
      </Show>

      <Show when={serversOpen()}>
        <div
          class="server-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setServersOpen(false)
          }}
        >
          <section class="server-shell" aria-label="行情服务器">
            <ServerWindow onClose={() => setServersOpen(false)} />
          </section>
        </div>
      </Show>

      <Show when={settingsOpen()}>
        <SettingsPanel onClose={() => setSettingsOpen(false)} />
      </Show>

      <Show when={indicatorOpen() ? activeQuote() : undefined}>
        {(quote) => (
          <IndicatorPanel
            code={quote().code}
            name={quote().name}
            onClose={() => setIndicatorOpen(false)}
          />
        )}
      </Show>

      <Show when={formulaOpen() ? activeQuote() : undefined}>
        {(quote) => (
          <FormulaPanel
            code={quote().code}
            name={quote().name}
            onClose={() => setFormulaOpen(false)}
            onSelect={(code) => {
              setActiveCode(code)
              setFormulaOpen(false)
            }}
          />
        )}
      </Show>

      <Show when={alertsOpen()}>
        <AlertPanel
          quote={activeQuote()}
          onClose={() => setAlertsOpen(false)}
          onSelect={(code) => {
            setActiveCode(code)
            setAlertsOpen(false)
          }}
        />
      </Show>

      <Show when={latestAlert()}>
        {(event) => (
          <AlertToast
            event={event()}
            onDismiss={dismissLatestAlert}
            onSelect={(code) => setActiveCode(code)}
          />
        )}
      </Show>
      <div
        class="layout-resizer layout-resizer--sidebar"
        role="separator"
        title="拖动调整自选栏宽度，双击恢复 280px"
        aria-label="调整自选栏宽度"
        onPointerDown={(event) => beginResize('sidebar', event)}
        onDblClick={() => updateSettings({ sidebarWidth: 280 })}
      />
      <div
        class="layout-resizer layout-resizer--rail"
        role="separator"
        aria-label="调整盘口栏宽度"
        onPointerDown={(event) => beginResize('rail', event)}
        onDblClick={() => updateSettings({ railWidth: 318 })}
      />
      {/* 任意个股列表右键弹出的「加入自选/自定义板块」菜单 */}
      <StockMenu />
    </div>
  )
}
