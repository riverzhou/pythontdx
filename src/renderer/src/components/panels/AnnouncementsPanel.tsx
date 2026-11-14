/**
 * 7615 TQLEX 在线资料：公告列表 + 公司概况。
 *
 * 只调用免费 HTTP 网关；公告详情交系统浏览器，不抓取研报正文，也不绕过授权。
 */
import {
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX
} from 'solid-js'
import type { F10Announcement, F10NewsItem, F10ProfileTable, F10TradingTable } from '@shared/types'
import { api, errorMessage, shell } from '../../lib/client'
import { downloadText } from '../../lib/download'
import { markdownDocument, markdownTable } from '@shared/markdown'
import { IconClose } from '../atoms/Icons'
import { MarkdownView } from '../atoms/MarkdownView'

interface AnnouncementsPanelProps {
  code: string
  name: string
  onClose: () => void
}

type OnlineTab =
  | 'announcements'
  | 'profile'
  | 'valuation'
  | 'finance'
  | 'business'
  | 'shareholders'
  | 'reports'
  | 'dividend'
  | 'shareholderCount'
  | 'capital'
  | 'circulating'
  | 'shareholderChanges'
  | 'institutions'
  | 'controller'
  | 'changePlans'
  | 'statement'
  | 'news'
  | 'trading'
  | 'industry'

export function AnnouncementsPanel(props: AnnouncementsPanelProps): JSX.Element {
  const [tab, setTab] = createSignal<OnlineTab>('announcements')
  const [markdownOpen, setMarkdownOpen] = createSignal(false)
  const [markdownCopied, setMarkdownCopied] = createSignal(false)
  const [rows, setRows] = createSignal<F10Announcement[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [profile, setProfile] = createSignal<F10ProfileTable | null>(null)
  const [profileLoading, setProfileLoading] = createSignal(true)
  const [profileError, setProfileError] = createSignal<string | null>(null)
  const [valuation, setValuation] = createSignal<F10ProfileTable | null>(null)
  const [valuationLoading, setValuationLoading] = createSignal(true)
  const [valuationError, setValuationError] = createSignal<string | null>(null)
  const [finance, setFinance] = createSignal<F10ProfileTable | null>(null)
  const [financeLoading, setFinanceLoading] = createSignal(true)
  const [financeError, setFinanceError] = createSignal<string | null>(null)
  const [business, setBusiness] = createSignal<F10ProfileTable | null>(null)
  const [businessLoading, setBusinessLoading] = createSignal(true)
  const [businessError, setBusinessError] = createSignal<string | null>(null)
  const [shareholders, setShareholders] = createSignal<F10ProfileTable | null>(null)
  const [shareholdersLoading, setShareholdersLoading] = createSignal(true)
  const [shareholdersError, setShareholdersError] = createSignal<string | null>(null)
  const [reports, setReports] = createSignal<F10ProfileTable | null>(null)
  const [reportsLoading, setReportsLoading] = createSignal(true)
  const [reportsError, setReportsError] = createSignal<string | null>(null)
  const [dividend, setDividend] = createSignal<F10ProfileTable | null>(null)
  const [dividendLoading, setDividendLoading] = createSignal(true)
  const [dividendError, setDividendError] = createSignal<string | null>(null)
  const [shareholderCount, setShareholderCount] = createSignal<F10ProfileTable | null>(null)
  const [shareholderCountLoading, setShareholderCountLoading] = createSignal(true)
  const [shareholderCountError, setShareholderCountError] = createSignal<string | null>(null)
  const [capital, setCapital] = createSignal<F10TradingTable | null>(null)
  const [capitalSection, setCapitalSection] = createSignal('structure')
  const [capitalLoading, setCapitalLoading] = createSignal(true)
  const [capitalError, setCapitalError] = createSignal<string | null>(null)
  const [circulating, setCirculating] = createSignal<F10ProfileTable | null>(null)
  const [circulatingLoading, setCirculatingLoading] = createSignal(true)
  const [circulatingError, setCirculatingError] = createSignal<string | null>(null)
  const [shareholderChanges, setShareholderChanges] = createSignal<F10ProfileTable | null>(null)
  const [shareholderChangesLoading, setShareholderChangesLoading] = createSignal(true)
  const [shareholderChangesError, setShareholderChangesError] = createSignal<string | null>(null)
  const [institutions, setInstitutions] = createSignal<F10ProfileTable | null>(null)
  const [institutionsLoading, setInstitutionsLoading] = createSignal(true)
  const [institutionsError, setInstitutionsError] = createSignal<string | null>(null)
  const [controller, setController] = createSignal<F10ProfileTable | null>(null)
  const [controllerLoading, setControllerLoading] = createSignal(true)
  const [controllerError, setControllerError] = createSignal<string | null>(null)
  const [changePlans, setChangePlans] = createSignal<F10ProfileTable | null>(null)
  const [changePlansLoading, setChangePlansLoading] = createSignal(true)
  const [changePlansError, setChangePlansError] = createSignal<string | null>(null)
  const [statementKind, setStatementKind] = createSignal('zcfzb')
  const [statement, setStatement] = createSignal<F10ProfileTable | null>(null)
  const [statementLoading, setStatementLoading] = createSignal(true)
  const [statementError, setStatementError] = createSignal<string | null>(null)
  const [statementFull, setStatementFull] = createSignal(false)
  const [news, setNews] = createSignal<F10NewsItem[]>([])
  const [newsLoading, setNewsLoading] = createSignal(true)
  const [newsError, setNewsError] = createSignal<string | null>(null)
  const [trading, setTrading] = createSignal<F10TradingTable | null>(null)
  const [industry, setIndustry] = createSignal<F10TradingTable | null>(null)
  const [industrySection, setIndustrySection] = createSignal('summary')
  const [industryLoading, setIndustryLoading] = createSignal(true)
  const [industryError, setIndustryError] = createSignal<string | null>(null)
  const [tradingSection, setTradingSection] = createSignal('margin')
  const [tradingLoading, setTradingLoading] = createSignal(true)
  const [tradingError, setTradingError] = createSignal<string | null>(null)
  let requestId = 0

  const loadAnnouncements = async (): Promise<void> => {
    const current = ++requestId
    setLoading(true)
    setError(null)
    try {
      const data = await api.f10.announcements(props.code)
      if (current !== requestId) return
      setRows(data)
    } catch (cause) {
      if (current === requestId) setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  const loadProfile = async (): Promise<void> => {
    setProfileLoading(true)
    setProfileError(null)
    try {
      setProfile(await api.f10.profile(props.code))
    } catch (cause) {
      setProfileError(errorMessage(cause))
    } finally {
      setProfileLoading(false)
    }
  }

  const loadValuation = async (): Promise<void> => {
    setValuationLoading(true)
    setValuationError(null)
    try {
      setValuation(await api.f10.valuation(props.code))
    } catch (cause) {
      setValuationError(errorMessage(cause))
    } finally {
      setValuationLoading(false)
    }
  }

  const loadFinance = async (): Promise<void> => {
    setFinanceLoading(true)
    setFinanceError(null)
    try {
      setFinance(await api.f10.finance(props.code))
    } catch (cause) {
      setFinanceError(errorMessage(cause))
    } finally {
      setFinanceLoading(false)
    }
  }

  const loadBusiness = async (): Promise<void> => {
    setBusinessLoading(true)
    setBusinessError(null)
    try {
      setBusiness(await api.f10.business(props.code))
    } catch (cause) {
      setBusinessError(errorMessage(cause))
    } finally {
      setBusinessLoading(false)
    }
  }

  const loadShareholders = async (): Promise<void> => {
    setShareholdersLoading(true)
    setShareholdersError(null)
    try {
      setShareholders(await api.f10.shareholders(props.code))
    } catch (cause) {
      setShareholdersError(errorMessage(cause))
    } finally {
      setShareholdersLoading(false)
    }
  }

  const loadReports = async (): Promise<void> => {
    setReportsLoading(true)
    setReportsError(null)
    try {
      setReports(await api.f10.reports(props.code))
    } catch (cause) {
      setReportsError(errorMessage(cause))
    } finally {
      setReportsLoading(false)
    }
  }

  const loadStatement = async (kind: string, full = statementFull()): Promise<void> => {
    setStatementKind(kind)
    setStatementFull(full)
    setStatementLoading(true)
    setStatementError(null)
    try {
      setStatement(await api.f10.statement(props.code, kind, full))
    } catch (cause) {
      setStatementError(errorMessage(cause))
    } finally {
      setStatementLoading(false)
    }
  }

  const loadTrading = async (section: string): Promise<void> => {
    setTradingSection(section)
    setTradingLoading(true)
    setTradingError(null)
    try {
      setTrading(await api.f10.trading(props.code, section))
    } catch (cause) {
      setTrading(null)
      setTradingError(errorMessage(cause))
    } finally {
      setTradingLoading(false)
    }
  }

  const loadChangePlans = async (): Promise<void> => {
    setChangePlansLoading(true)
    setChangePlansError(null)
    try {
      setChangePlans(await api.f10.changePlans(props.code))
    } catch (cause) {
      setChangePlansError(errorMessage(cause))
    } finally {
      setChangePlansLoading(false)
    }
  }

  const loadController = async (): Promise<void> => {
    setControllerLoading(true)
    setControllerError(null)
    try {
      setController(await api.f10.controller(props.code))
    } catch (cause) {
      setControllerError(errorMessage(cause))
    } finally {
      setControllerLoading(false)
    }
  }

  const loadInstitutions = async (): Promise<void> => {
    setInstitutionsLoading(true)
    setInstitutionsError(null)
    try {
      setInstitutions(await api.f10.institutions(props.code))
    } catch (cause) {
      setInstitutionsError(errorMessage(cause))
    } finally {
      setInstitutionsLoading(false)
    }
  }

  const loadShareholderChanges = async (): Promise<void> => {
    setShareholderChangesLoading(true)
    setShareholderChangesError(null)
    try {
      setShareholderChanges(await api.f10.shareholderChanges(props.code))
    } catch (cause) {
      setShareholderChangesError(errorMessage(cause))
    } finally {
      setShareholderChangesLoading(false)
    }
  }

  const loadCirculating = async (): Promise<void> => {
    setCirculatingLoading(true)
    setCirculatingError(null)
    try {
      setCirculating(await api.f10.circulatingShareholders(props.code))
    } catch (cause) {
      setCirculatingError(errorMessage(cause))
    } finally {
      setCirculatingLoading(false)
    }
  }

  const loadCapital = async (section: string): Promise<void> => {
    setCapitalLoading(true)
    setCapitalError(null)
    try {
      setCapital(await api.f10.capital(props.code, section))
    } catch (cause) {
      setCapitalError(errorMessage(cause))
    } finally {
      setCapitalLoading(false)
    }
  }

  const loadShareholderCount = async (): Promise<void> => {
    setShareholderCountLoading(true)
    setShareholderCountError(null)
    try {
      setShareholderCount(await api.f10.shareholderCount(props.code))
    } catch (cause) {
      setShareholderCountError(errorMessage(cause))
    } finally {
      setShareholderCountLoading(false)
    }
  }

  const loadDividend = async (): Promise<void> => {
    setDividendLoading(true)
    setDividendError(null)
    try {
      setDividend(await api.f10.dividend(props.code))
    } catch (cause) {
      setDividendError(errorMessage(cause))
    } finally {
      setDividendLoading(false)
    }
  }

  const loadNews = async (): Promise<void> => {
    setNewsLoading(true)
    setNewsError(null)
    try {
      setNews(await api.f10.news(props.code))
    } catch (cause) {
      setNewsError(errorMessage(cause))
    } finally {
      setNewsLoading(false)
    }
  }

  const loadIndustry = async (section: string): Promise<void> => {
    setIndustryLoading(true)
    setIndustryError(null)
    try {
      setIndustry(await api.f10.industry(props.code, section))
    } catch (cause) {
      setIndustryError(errorMessage(cause))
    } finally {
      setIndustryLoading(false)
    }
  }

  const loadedTabs = new Set<OnlineTab>()

  const ensureTab = (next: OnlineTab): void => {
    if (loadedTabs.has(next)) return
    loadedTabs.add(next)
    switch (next) {
      case 'announcements':
        void loadAnnouncements()
        break
      case 'profile':
        void loadProfile()
        break
      case 'valuation':
        void loadValuation()
        break
      case 'finance':
        void loadFinance()
        break
      case 'business':
        void loadBusiness()
        break
      case 'shareholders':
        void loadShareholders()
        break
      case 'reports':
        void loadReports()
        break
      case 'dividend':
        void loadDividend()
        break
      case 'shareholderCount':
        void loadShareholderCount()
        break
      case 'capital':
        void loadCapital('structure')
        break
      case 'circulating':
        void loadCirculating()
        break
      case 'shareholderChanges':
        void loadShareholderChanges()
        break
      case 'institutions':
        void loadInstitutions()
        break
      case 'controller':
        void loadController()
        break
      case 'changePlans':
        void loadChangePlans()
        break
      case 'statement':
        void loadStatement('zcfzb')
        break
      case 'news':
        void loadNews()
        break
      case 'trading':
        void loadTrading('margin')
        break
      case 'industry':
        void loadIndustry('summary')
        break
    }
  }

  createEffect(() => ensureTab(tab()))

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  const cell = (value: string | number | null | undefined): string =>
    value === null || value === undefined || value === '' ? '—' : String(value)

  const tabLabel = (): string =>
    ({
      announcements: '公告',
      profile: '公司概况',
      valuation: '估值',
      finance: '财务指标',
      business: '主营构成',
      shareholders: '十大股东',
      reports: '研报列表',
      dividend: '分红',
      shareholderCount: '股东人数',
      capital: '股本',
      circulating: '流通股东',
      shareholderChanges: '增减持',
      institutions: '机构持仓',
      controller: '实控人',
      changePlans: '增减计划',
      statement: '财务报表',
      news: '公司新闻',
      trading: '交易数据',
      industry: '行业分析'
    })[tab()]

  const tableMarkdown = (table: F10ProfileTable | F10TradingTable | null | undefined): string =>
    table ? markdownTable(table.columns, table.rows) : '> 暂无数据\n'

  const currentMarkdown = (): string => {
    let body: string
    if (tab() === 'announcements') {
      body = markdownTable(
        ['日期', '标题', '类型', '来源'],
        rows().map((row) => [row.date, row.title, row.type, row.source])
      )
    } else if (tab() === 'news') {
      body = markdownTable(
        ['时间', '标题', '来源'],
        news().map((row) => [row.date, row.title, row.source])
      )
    } else {
      const table =
        tab() === 'profile'
          ? profile()
          : tab() === 'valuation'
            ? valuation()
            : tab() === 'finance'
              ? finance()
              : tab() === 'business'
                ? business()
                : tab() === 'shareholders'
                  ? shareholders()
                  : tab() === 'reports'
                    ? reports()
                    : tab() === 'dividend'
                      ? dividend()
                      : tab() === 'shareholderCount'
                        ? shareholderCount()
                        : tab() === 'capital'
                          ? capital()
                          : tab() === 'circulating'
                            ? circulating()
                            : tab() === 'shareholderChanges'
                              ? shareholderChanges()
                              : tab() === 'institutions'
                                ? institutions()
                                : tab() === 'controller'
                                  ? controller()
                                  : tab() === 'changePlans'
                                    ? changePlans()
                                    : tab() === 'statement'
                                      ? statement()
                                      : tab() === 'trading'
                                        ? trading()
                                        : tab() === 'industry'
                                          ? industry()
                                          : null
      body = tableMarkdown(table)
    }
    return markdownDocument(`${props.name}（${props.code.toUpperCase()}）· F10`, [
      `> 数据来源：通达信 7615 免费资料网关；生成时间：${new Date().toLocaleString()}`,
      `## ${tabLabel()}\n\n${body.trim()}`
    ])
  }

  const copyMarkdown = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(currentMarkdown())
      setMarkdownCopied(true)
      setTimeout(() => setMarkdownCopied(false), 1500)
    } catch {
      setMarkdownCopied(false)
    }
  }

  return (
    <div class="announcements-backdrop" onClick={() => props.onClose()}>
      <section
        class="announcements"
        role="dialog"
        aria-modal="true"
        aria-label={`${props.name} 在线资料`}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="announcements__head">
          <div>
            <div class="announcements__eyebrow">7615 TQLEX · 在线资料</div>
            <h2 class="announcements__title">
              {props.name} <code>{props.code.toUpperCase()}</code>
            </h2>
          </div>
          <div class="announcements__head-actions">
            <button
              class="btn f10-markdown-open"
              title="把当前 F10 页签格式化为 Markdown"
              onClick={() => setMarkdownOpen(true)}
            >
              Markdown
            </button>
            <button
              class="btn btn--icon btn--bare"
              title="关闭在线资料"
              onClick={() => props.onClose()}
            >
              <IconClose size={16} />
            </button>
          </div>
        </header>

        <div class="online-tabs">
          <button
            class="online-tab"
            data-active={tab() === 'announcements'}
            onClick={() => setTab('announcements')}
          >
            公告
          </button>
          <button
            class="online-tab online-profile-tab"
            data-active={tab() === 'profile'}
            onClick={() => setTab('profile')}
          >
            公司概况
          </button>
          <button
            class="online-tab online-valuation-tab"
            data-active={tab() === 'valuation'}
            onClick={() => setTab('valuation')}
          >
            估值
          </button>
          <button
            class="online-tab online-finance-tab"
            data-active={tab() === 'finance'}
            onClick={() => setTab('finance')}
          >
            财务
          </button>
          <button
            class="online-tab online-business-tab"
            data-active={tab() === 'business'}
            onClick={() => setTab('business')}
          >
            主营
          </button>
          <button
            class="online-tab online-shareholders-tab"
            data-active={tab() === 'shareholders'}
            onClick={() => setTab('shareholders')}
          >
            股东
          </button>
          <button
            class="online-tab online-reports-tab"
            data-active={tab() === 'reports'}
            onClick={() => setTab('reports')}
          >
            研报
          </button>
          <button
            class="online-tab online-dividend-tab"
            data-active={tab() === 'dividend'}
            onClick={() => setTab('dividend')}
          >
            分红
          </button>
          <button
            class="online-tab online-shcount-tab"
            data-active={tab() === 'shareholderCount'}
            onClick={() => setTab('shareholderCount')}
          >
            股东人数
          </button>
          <button
            class="online-tab online-plan-tab"
            data-active={tab() === 'changePlans'}
            onClick={() => setTab('changePlans')}
          >
            增减计划
          </button>
          <button
            class="online-tab online-controller-tab"
            data-active={tab() === 'controller'}
            onClick={() => setTab('controller')}
          >
            实控人
          </button>
          <button
            class="online-tab online-institutions-tab"
            data-active={tab() === 'institutions'}
            onClick={() => setTab('institutions')}
          >
            机构持仓
          </button>
          <button
            class="online-tab online-cgbd-tab"
            data-active={tab() === 'shareholderChanges'}
            onClick={() => setTab('shareholderChanges')}
          >
            增减持
          </button>
          <button
            class="online-tab online-circulating-tab"
            data-active={tab() === 'circulating'}
            onClick={() => setTab('circulating')}
          >
            流通股东
          </button>
          <button
            class="online-tab online-capital-tab"
            data-active={tab() === 'capital'}
            onClick={() => {
              setTab('capital')
              void loadCapital(capitalSection())
            }}
          >
            股本
          </button>
          <button
            class="online-tab online-statement-tab"
            data-active={tab() === 'statement'}
            onClick={() => setTab('statement')}
          >
            报表
          </button>
          <button
            class="online-tab online-news-tab"
            data-active={tab() === 'news'}
            onClick={() => setTab('news')}
          >
            新闻
          </button>
          <button
            class="online-tab online-industry-tab"
            data-active={tab() === 'industry'}
            onClick={() => {
              setTab('industry')
              void loadIndustry(industrySection())
            }}
          >
            行业
          </button>
          <button
            class="online-tab online-trading-tab"
            data-active={tab() === 'trading'}
            onClick={() => setTab('trading')}
          >
            交易
          </button>
        </div>

        <div class="announcements__body">
          <Switch>
            <Match when={tab() === 'announcements'}>
              <Show when={!loading()} fallback={<div class="announcements__empty">加载公告…</div>}>
                <Show when={!error()} fallback={<div class="announcements__error">{error()}</div>}>
                  <Show
                    when={rows().length > 0}
                    fallback={<div class="announcements__empty">暂无公告</div>}
                  >
                    <div class="announcements__meta">共 {rows().length} 条 · 点击标题打开原文</div>
                    <div class="announcements__list">
                      <div class="announcement-row announcement-row--head">
                        <span>日期</span>
                        <span>标题</span>
                        <span>类型</span>
                        <span>来源</span>
                      </div>
                      <For each={rows()}>
                        {(row) => (
                          <div class="announcement-row">
                            <span class="announcement-row__date num">{row.date}</span>
                            <button
                              class="announcement-row__title"
                              title={row.url || row.title}
                              disabled={!row.url}
                              onClick={() => void shell.app.openExternal(row.url)}
                            >
                              {row.title}
                            </button>
                            <span class="announcement-row__type">{row.type}</span>
                            <span class="announcement-row__source">{row.source}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'profile'}>
              <Show
                when={!profileLoading()}
                fallback={<div class="announcements__empty">加载公司概况…</div>}
              >
                <Show
                  when={!profileError()}
                  fallback={<div class="announcements__error">{profileError()}</div>}
                >
                  <Show
                    when={profile()}
                    fallback={<div class="announcements__empty">暂无概况</div>}
                  >
                    {(table) => (
                      <div class="profile-grid">
                        <For each={table().columns}>
                          {(column, index) => (
                            <div class="profile-cell">
                              <span>{column}</span>
                              <strong>{cell(table().rows[0]?.[index()])}</strong>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'valuation'}>
              <Show
                when={!valuationLoading()}
                fallback={<div class="announcements__empty">加载估值…</div>}
              >
                <Show
                  when={!valuationError()}
                  fallback={<div class="announcements__error">{valuationError()}</div>}
                >
                  <Show
                    when={valuation()}
                    fallback={<div class="announcements__empty">暂无估值</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'finance'}>
              <Show
                when={!financeLoading()}
                fallback={<div class="announcements__empty">加载财务指标…</div>}
              >
                <Show
                  when={!financeError()}
                  fallback={<div class="announcements__error">{financeError()}</div>}
                >
                  <Show
                    when={finance()}
                    fallback={<div class="announcements__empty">暂无财务指标</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table finance-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'business'}>
              <Show
                when={!businessLoading()}
                fallback={<div class="announcements__empty">加载主营构成…</div>}
              >
                <Show
                  when={!businessError()}
                  fallback={<div class="announcements__error">{businessError()}</div>}
                >
                  <Show
                    when={business()}
                    fallback={<div class="announcements__empty">暂无主营构成</div>}
                  >
                    {(table) => (
                      <>
                        <div class="announcements__meta">
                          报告期 {table().reportDate ?? '—'} · 按地区/业务/产品拆分
                        </div>
                        <div class="valuation-table-wrap">
                          <table class="valuation-table finance-table">
                            <thead>
                              <tr>
                                <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                              </tr>
                            </thead>
                            <tbody>
                              <For each={table().rows}>
                                {(row) => (
                                  <tr>
                                    <For each={row}>
                                      {(value) => <td class="num">{cell(value)}</td>}
                                    </For>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'shareholders'}>
              <Show
                when={!shareholdersLoading()}
                fallback={<div class="announcements__empty">加载股东…</div>}
              >
                <Show
                  when={!shareholdersError()}
                  fallback={<div class="announcements__error">{shareholdersError()}</div>}
                >
                  <Show
                    when={shareholders()}
                    fallback={<div class="announcements__empty">暂无股东数据</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'reports'}>
              <Show
                when={!reportsLoading()}
                fallback={<div class="announcements__empty">加载研报列表…</div>}
              >
                <Show
                  when={!reportsError()}
                  fallback={<div class="announcements__error">{reportsError()}</div>}
                >
                  <Show
                    when={reports()}
                    fallback={<div class="announcements__empty">暂无研报</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table report-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'shareholderCount'}>
              <Show
                when={!shareholderCountLoading()}
                fallback={<div class="announcements__empty">加载股东人数…</div>}
              >
                <Show
                  when={!shareholderCountError()}
                  fallback={<div class="announcements__error">{shareholderCountError()}</div>}
                >
                  <Show
                    when={shareholderCount()}
                    fallback={<div class="announcements__empty">暂无股东人数</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'changePlans'}>
              <Show
                when={!changePlansLoading()}
                fallback={<div class="announcements__empty">加载增减持计划…</div>}
              >
                <Show
                  when={!changePlansError()}
                  fallback={<div class="announcements__error">{changePlansError()}</div>}
                >
                  <Show
                    when={changePlans()}
                    fallback={<div class="announcements__empty">暂无增减持计划</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table plan-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'controller'}>
              <Show
                when={!controllerLoading()}
                fallback={<div class="announcements__empty">加载实控人…</div>}
              >
                <Show
                  when={!controllerError()}
                  fallback={<div class="announcements__error">{controllerError()}</div>}
                >
                  <Show
                    when={controller()}
                    fallback={<div class="announcements__empty">暂无实控人数据</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table controller-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'institutions'}>
              <Show
                when={!institutionsLoading()}
                fallback={<div class="announcements__empty">加载机构持仓…</div>}
              >
                <Show
                  when={!institutionsError()}
                  fallback={<div class="announcements__error">{institutionsError()}</div>}
                >
                  <Show
                    when={institutions()}
                    fallback={<div class="announcements__empty">暂无机构持仓</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table institutions-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'shareholderChanges'}>
              <Show
                when={!shareholderChangesLoading()}
                fallback={<div class="announcements__empty">加载增减持…</div>}
              >
                <Show
                  when={!shareholderChangesError()}
                  fallback={<div class="announcements__error">{shareholderChangesError()}</div>}
                >
                  <Show
                    when={shareholderChanges()}
                    fallback={<div class="announcements__empty">暂无增减持数据</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table cgbd-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'circulating'}>
              <Show
                when={!circulatingLoading()}
                fallback={<div class="announcements__empty">加载流通股东…</div>}
              >
                <Show
                  when={!circulatingError()}
                  fallback={<div class="announcements__error">{circulatingError()}</div>}
                >
                  <Show
                    when={circulating()}
                    fallback={<div class="announcements__empty">暂无流通股东数据</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table circulating-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'capital'}>
              <div class="trading__sections">
                <For
                  each={
                    [
                      ['structure', '股本结构'],
                      ['changes', '股本变动'],
                      ['buyback', '股票回购'],
                      ['restricted', '限售流通']
                    ] as const
                  }
                >
                  {([key, label]) => (
                    <button
                      class={`trading-section trading-section--${key}`}
                      data-active={capitalSection() === key}
                      onClick={() => {
                        setCapitalSection(key)
                        void loadCapital(key)
                      }}
                    >
                      {label}
                    </button>
                  )}
                </For>
                <span class="trading__count">{capital()?.count ?? 0} 行</span>
              </div>
              <Show
                when={!capitalLoading()}
                fallback={<div class="announcements__empty">加载股本…</div>}
              >
                <Show
                  when={!capitalError()}
                  fallback={<div class="announcements__error">{capitalError()}</div>}
                >
                  <Show
                    when={capital()}
                    fallback={<div class="announcements__empty">暂无股本数据</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table capital-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'dividend'}>
              <Show
                when={!dividendLoading()}
                fallback={<div class="announcements__empty">加载分红…</div>}
              >
                <Show
                  when={!dividendError()}
                  fallback={<div class="announcements__error">{dividendError()}</div>}
                >
                  <Show
                    when={dividend()}
                    fallback={<div class="announcements__empty">暂无分红数据</div>}
                  >
                    {(table) => (
                      <div class="valuation-table-wrap">
                        <table class="valuation-table shareholder-table">
                          <thead>
                            <tr>
                              <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={table().rows}>
                              {(row) => (
                                <tr>
                                  <For each={row}>
                                    {(value) => <td class="num">{cell(value)}</td>}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'statement'}>
              <div class="statement-kinds">
                <button
                  class="statement-kind"
                  data-active={statementKind() === 'zcfzb'}
                  onClick={() => void loadStatement('zcfzb')}
                >
                  资产负债
                </button>
                <button
                  class="statement-kind"
                  data-active={statementKind() === 'lyb'}
                  onClick={() => void loadStatement('lyb')}
                >
                  利润
                </button>
                <button
                  class="statement-kind"
                  data-active={statementKind() === 'xjllb'}
                  onClick={() => void loadStatement('xjllb')}
                >
                  现金流
                </button>
                <button
                  class="statement-kind statement-full-toggle"
                  data-active={statementFull()}
                  onClick={() => void loadStatement(statementKind(), !statementFull())}
                >
                  {statementFull() ? '关键科目' : '全部科目'}
                </button>
              </div>
              <Show
                when={!statementLoading()}
                fallback={<div class="announcements__empty">加载报表…</div>}
              >
                <Show
                  when={!statementError()}
                  fallback={<div class="announcements__error">{statementError()}</div>}
                >
                  <Show
                    when={statement()}
                    fallback={<div class="announcements__empty">暂无报表</div>}
                  >
                    {(table) => (
                      <>
                        <div class="announcements__meta">
                          最近 4 期 · 模板 {table().template ?? 0} ·{' '}
                          {statementFull() ? '全部原始列' : '关键科目'}
                        </div>
                        <div class="valuation-table-wrap">
                          <table class="valuation-table finance-table">
                            <thead>
                              <tr>
                                <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                              </tr>
                            </thead>
                            <tbody>
                              <For each={table().rows}>
                                {(row) => (
                                  <tr>
                                    <For each={row}>
                                      {(value) => <td class="num">{cell(value)}</td>}
                                    </For>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'trading'}>
              <div class="trading-sections">
                <For
                  each={
                    [
                      ['margin', '两融'],
                      ['margin_history', '两融历史'],
                      ['block', '大宗'],
                      ['dragon', '龙虎榜'],
                      ['north', '沪股通'],
                      ['reports', '研报席位'],
                      ['kcb', '科创'],
                      ['limit_up', '涨停'],
                      ['limit_down', '跌停'],
                      ['bonds', '可转债'],
                      ['main_force', '主力']
                    ] as Array<[string, string]>
                  }
                >
                  {([value, label]) => (
                    <button
                      class={`trading-section trading-section--${value}`}
                      data-active={tradingSection() === value}
                      onClick={() => void loadTrading(value)}
                    >
                      {label}
                    </button>
                  )}
                </For>
              </div>
              <Show
                when={!tradingLoading()}
                fallback={<div class="announcements__empty">加载交易数据…</div>}
              >
                <Show
                  when={!tradingError()}
                  fallback={<div class="announcements__error">{tradingError()}</div>}
                >
                  <Show
                    when={(trading()?.count ?? 0) > 0}
                    fallback={
                      <div class="announcements__empty">暂无记录（原始表 table0 为空）</div>
                    }
                  >
                    <div class="announcements__meta">
                      共 {trading()?.count ?? 0} 行 · 原始列 {trading()?.rawColumns.join(' / ')}
                    </div>
                    <div class="finance-table-wrap">
                      <table class="finance-table trading-table">
                        <thead>
                          <tr>
                            <For each={trading()?.columns ?? []}>
                              {(column) => <th>{column}</th>}
                            </For>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={trading()?.rows ?? []}>
                            {(row) => (
                              <tr>
                                <For each={row}>
                                  {(value) => <td class="num">{String(value)}</td>}
                                </For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={tab() === 'news'}>
              <Show
                when={!newsLoading()}
                fallback={<div class="announcements__empty">加载新闻…</div>}
              >
                <Show
                  when={!newsError()}
                  fallback={<div class="announcements__error">{newsError()}</div>}
                >
                  <Show
                    when={news().length > 0}
                    fallback={<div class="announcements__empty">暂无新闻</div>}
                  >
                    <div class="announcements__meta">共 {news().length} 条</div>
                    <div class="announcements__list">
                      <div class="announcement-row announcement-row--head">
                        <span>时间</span>
                        <span>标题</span>
                        <span>来源</span>
                        <span />
                      </div>
                      <For each={news()}>
                        {(row) => (
                          <div class="announcement-row">
                            <span class="announcement-row__date num">{row.date}</span>
                            <span class="announcement-row__title">{row.title}</span>
                            <span class="announcement-row__source">{row.source}</span>
                            <span />
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Match>
            <Match when={tab() === 'industry'}>
              <div class="trading__sections">
                <For
                  each={
                    [
                      ['summary', '行业汇总'],
                      ['news', '行业新闻'],
                      ['reports', '行业研报']
                    ] as const
                  }
                >
                  {([key, label]) => (
                    <button
                      class={`trading-section trading-section--${key}`}
                      data-active={industrySection() === key}
                      onClick={() => {
                        setIndustrySection(key)
                        void loadIndustry(key)
                      }}
                    >
                      {label}
                    </button>
                  )}
                </For>
                <span class="trading__count">{industry()?.count ?? 0} 行</span>
              </div>
              <Show
                when={!industryLoading()}
                fallback={<div class="announcements__empty">加载行业数据…</div>}
              >
                <Show
                  when={!industryError()}
                  fallback={<div class="announcements__error">{industryError()}</div>}
                >
                  <Show
                    when={(industry()?.count ?? 0) > 0}
                    fallback={<div class="announcements__empty">暂无行业数据</div>}
                  >
                    <div class="finance-table-wrap">
                      <table class="finance-table trading-table industry-table">
                        <thead>
                          <tr>
                            <For each={industry()?.columns ?? []}>
                              {(column) => <th>{column}</th>}
                            </For>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={industry()?.rows ?? []}>
                            {(row) => (
                              <tr>
                                <For each={row}>
                                  {(value) => <td class="num">{String(value)}</td>}
                                </For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Match>
          </Switch>
        </div>

        <Show when={markdownOpen()}>
          <div class="f10-md-backdrop" onClick={() => setMarkdownOpen(false)}>
            <section
              class="f10-md"
              role="dialog"
              aria-modal="true"
              aria-label="F10 Markdown 预览"
              onClick={(event) => event.stopPropagation()}
            >
              <header class="f10-md__head">
                <div>
                  <div class="announcements__eyebrow">Markdown · 可复制 / 下载</div>
                  <h3>
                    {props.name} · {tabLabel()}
                  </h3>
                </div>
                <div class="f10-md__actions">
                  <button class="btn f10-md-copy" onClick={() => void copyMarkdown()}>
                    {markdownCopied() ? '已复制' : '复制'}
                  </button>
                  <button
                    class="btn btn--primary f10-md-download"
                    onClick={() => downloadText(`f10-${props.code}-${tab()}.md`, currentMarkdown())}
                  >
                    下载 .md
                  </button>
                  <button class="btn btn--icon btn--bare" onClick={() => setMarkdownOpen(false)}>
                    <IconClose size={16} />
                  </button>
                </div>
              </header>
              <div class="f10-md__body">
                <MarkdownView source={currentMarkdown()} />
              </div>
            </section>
          </div>
        </Show>

        <footer class="announcements__foot">
          <span>数据来自通达信 7615 免费资料网关</span>
          <span>PDF 由系统浏览器打开</span>
        </footer>
      </section>
    </div>
  )
}
