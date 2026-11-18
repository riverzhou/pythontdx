/**
 * 全市场列表：A 股 / 指数 / 科创板 / 创业板 / 北证。
 *
 * 代码与名称来自代码表；当前页报价通过 0x054c 批量快照补齐。
 * 不按 0x054b 的“分类”猜测市场——分类编号在不同主站上并不稳定。
 *
 * 排序：点表头。代码/名称用代码表字段直接排；数值列要先有**全表**报价，
 * 否则「涨幅降序」只排已加载的那 200 行，看着像对、其实是错的。
 * 所以第一次点数值表头时用 MAC 批量拉全表快照（按 400 只分批，进度可见），
 * 之后换列/换方向只在内存里重排，不再请求。
 * 顺序来自这份快照，**表里显示的价格仍按当前页现取**：两者可能差一点点，
 * 但滚动换页始终有新价，不会因为排序把整张表冻在十几秒前。
 */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import type { Quote } from '@shared/types'
import type { SearchEntry, SearchSecurity } from '@shared/search'
import { compactAmount, fixed, signedPct } from '@shared/format'
import { api, errorMessage } from '../../lib/client'
import { openStockMenu } from '../../stores/stockMenu'
import { downloadText } from '../../lib/download'
import { toCsv } from '@shared/csv'
import {
  createSparklineLoader,
  requestVisibleSparklines,
  sparklineOf
} from '../../stores/sparklines'
import { quoteSortValue, sortRows, type QuoteSortKey, type SortState } from '../../lib/table-sort'
import { IconClose } from '../atoms/Icons'
import { Sparkline } from '../charts/Sparkline'
import { SortHeader } from '../atoms/SortHeader'
import { EXTRA_COLUMNS, ExtraColumnCells, ExtraColumnHeaders } from '../atoms/StockExtraColumns'

type TabKey = 'all' | 'index' | 'fund' | 'reit' | 'bond' | 'kcb' | 'cyb' | 'bj' | 'b'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: '全部 A 股' },
  { key: 'index', label: '指数' },
  { key: 'fund', label: '基金' },
  { key: 'reit', label: 'REITs' },
  { key: 'bond', label: '债券' },
  { key: 'kcb', label: '科创板' },
  { key: 'cyb', label: '创业板' },
  { key: 'bj', label: '北证' },
  { key: 'b', label: 'B股' }
]

const PAGE_SIZE = 200

/** 页脚「当前按 XX 降序」用的中文列名 */
const SORT_LABEL: Record<string, string> = {
  code: '代码',
  name: '名称',
  price: '现价',
  change: '涨跌幅',
  amount: '成交额',
  turnover: '换手',
  volume: '量比',
  speed: '涨速'
}

function isAShare(item: SearchSecurity): boolean {
  const symbol = item.symbol
  if (item.kind !== 'GP-A') return false
  if (item.market === 'SH') return /^(600|601|603|605|688|689)/.test(symbol)
  if (item.market === 'SZ') return /^(000|001|002|003|300|301|302)/.test(symbol)
  if (item.market === 'BJ') return /^[489]/.test(symbol)
  return false
}

function matches(tab: TabKey, item: SearchSecurity): boolean {
  const symbol = item.symbol
  if (tab === 'index') return item.kind === 'ZS'
  if (tab === 'fund') return item.kind === 'JJ'
  if (tab === 'reit') return item.kind === 'JJ' && /^(508|180)/.test(symbol)
  if (tab === 'bond') return item.kind === 'ZQ'
  if (tab === 'b') return item.kind === 'GP-B'
  if (!isAShare(item)) return false
  if (tab === 'kcb') return symbol.startsWith('688') || symbol.startsWith('689')
  if (tab === 'cyb')
    return symbol.startsWith('300') || symbol.startsWith('301') || symbol.startsWith('302')
  if (tab === 'bj') return item.market === 'BJ'
  return true
}

export function MarketListPanel(props: {
  onClose: () => void
  onSelect: (quote: Quote) => void
  onOpenBlocks: () => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}): JSX.Element {
  const [catalog, setCatalog] = createSignal<SearchSecurity[]>([])
  const [tab, setTab] = createSignal<TabKey>('all')
  const [query, setQuery] = createSignal('')
  const [limit, setLimit] = createSignal(PAGE_SIZE)
  let loadedCount = 0
  let quoteKey = ''
  const [quotes, setQuotes] = createSignal<Quote[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [sort, setSort] = createSignal<SortState | null>(null)
  /** 全表报价快照：只有点数值表头时才会拉，拉到后换列不再请求 */
  const [snapshot, setSnapshot] = createSignal<Map<string, Quote>>(new Map())
  const [snapshotKey, setSnapshotKey] = createSignal('')
  const [snapshotLoading, setSnapshotLoading] = createSignal(false)
  const [snapshotProgress, setSnapshotProgress] = createSignal('')
  const [pinyinReady, setPinyinReady] = createSignal(false)
  let requestId = 0
  let snapshotRequestId = 0
  /** 拼音索引按需构建（pinyin-pro 词典较大，动态 import 让首屏不背这份体积） */
  let searchIndex: SearchEntry[] | undefined
  let pinyinMatcher: ((entry: SearchEntry, keyword: string) => boolean) | undefined
  let pinyinLoading: Promise<void> | undefined

  const loadPinyinIndex = (): Promise<void> => {
    if (searchIndex) return Promise.resolve()
    // 在同步段读取响应式代码表：异步回调里读不会触发依赖跟踪
    const items = catalog()
    pinyinLoading ??= import('@shared/search').then((module) => {
      pinyinLoading = undefined
      if (items.length === 0) return
      pinyinMatcher = module.matchesPinyin
      searchIndex = module.buildSearchEntries(items)
      setPinyinReady(true)
    })
    return pinyinLoading
  }

  createEffect(() => {
    // 只在输入看起来像拼音时构建索引，纯数字/中文查询不付这份成本
    if (catalog().length > 0 && /^[a-z]{2,}$/i.test(query().trim())) void loadPinyinIndex()
  })

  createEffect(() => {
    void (async () => {
      try {
        const data = await api.quote.catalog()
        setCatalog(data)
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setLoading(false)
      }
    })()
  })

  const filtered = createMemo(() => {
    const text = query().trim().toLowerCase()
    // 订阅索引就绪状态：拼音索引异步建好后要让过滤重新跑一遍
    const entries = pinyinReady() ? searchIndex : undefined
    const entryOf = entries ? new Map(entries.map((entry) => [entry.info.code, entry])) : null
    const phonetic = text.replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
    return catalog()
      .filter((item) => matches(tab(), item))
      .filter((item) => {
        if (!text) return true
        if (item.code.toLowerCase().includes(text) || item.name.toLowerCase().includes(text)) {
          return true
        }
        const entry = entryOf?.get(item.code)
        if (!entry || !phonetic || !pinyinMatcher) return false
        return pinyinMatcher(entry, phonetic)
      })
  })

  /** 排序 + 搜索共同决定「当前这一份列表」，快照按它缓存 */
  const viewKey = createMemo(() => `${tab()}|${query()}`)

  /**
   * 快照是否覆盖当前列表。
   * 只有 key 对得上才算——换了 tab 或改了搜索词，旧快照里的代码就不是这一份了。
   *
   * 必须声明在 `loadKey` 之前：`createMemo` 建好就会算一次初值，
   * 后面的 memo 读到这里会直接拿到值；写在后面就是 TDZ（渲染层白屏 + 控制台
   * 「Cannot access 'X' before initialization」）。
   */
  const snapshotReady = createMemo(() => snapshot().size > 0 && snapshotKey() === viewKey())

  /**
   * 当前页报价对应的是「哪一份排序后的前 N 行」。
   * 改排序会让同样的 200 个位置换成另一批股票，所以排序状态也算进 key；
   * 快照到位时也要重算一次 —— 那时才第一次知道该取哪 200 行。
   */
  const loadKey = createMemo(() => {
    const state = sort()
    return `${viewKey()}|${state?.key ?? ''}|${state?.dir ?? ''}|${snapshotReady() ? 'S' : '-'}`
  })

  /** 数值列排序 + 整表快照还在路上：此刻既不知道该取哪 200 行，也不该重排 */
  const waitingSnapshot = (): boolean => {
    const key = sort()?.key
    if (key === undefined || key === 'code' || key === 'name') return false
    return snapshotLoading()
  }

  const displayed = createMemo(() => {
    const state = sort()
    const base = filtered()
    if (!state) return base
    // 快照还没到时先按原顺序显示：数值全缺，sortRows 会原样返回
    const map = snapshotReady() ? snapshot() : null
    return sortRows(base, state, (item) => {
      if (state.key === 'code') return item.code
      if (state.key === 'name') return item.name
      return quoteSortValue(map?.get(item.code), state.key as QuoteSortKey)
    })
  })

  // 垂直滚动加载：初始 200 行，滚到底再加 200；不再用上/下翻页
  const visibleItems = createMemo(() => displayed().slice(0, limit()))

  /**
   * 拉全表快照。一次要几千只，只能分批；连续点表头时用 300ms 合并成一次，
   * 免得「涨幅 → 成交额 → 涨跌幅」连点打出三轮全表请求。
   */
  const loadSnapshot = async (): Promise<void> => {
    const key = viewKey()
    if (snapshotKey() === key && snapshot().size > 0) return
    const current = ++snapshotRequestId
    setSnapshotLoading(true)
    setError(null)
    try {
      const codes = filtered().map((item) => item.code)
      const map = new Map<string, Quote>()
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (current !== snapshotRequestId) return
      // 一次 5,600 只会让 Electron IPC 响应过大；按 400 只分批，进度可见。
      for (let start = 0; start < codes.length; start += 400) {
        setSnapshotProgress(`${Math.min(start + 400, codes.length)} / ${codes.length}`)
        const data = await api.quote.macQuotes(codes.slice(start, start + 400))
        for (const quote of data) map.set(quote.code, quote)
        if (current !== snapshotRequestId) return
      }
      setSnapshotKey(key)
      setSnapshot(map)
      setSnapshotProgress('')
    } catch (cause) {
      if (current === snapshotRequestId) setError(errorMessage(cause))
    } finally {
      if (current === snapshotRequestId) setSnapshotLoading(false)
    }
  }

  const applySort = (next: SortState): void => {
    setSort(next)
    setLimit(PAGE_SIZE)
    // 代码/名称是代码表自带字段，不需要报价快照
    if (next.key !== 'code' && next.key !== 'name') void loadSnapshot()
  }

  createEffect(() => {
    if (loadKey() !== quoteKey) {
      quoteKey = loadKey()
      loadedCount = 0
      requestId += 1
      /*
       * 整表快照还在路上时先留着上一批报价：这时显示顺序还没变，
       * 清空只会把整张表刷成一片「—」等十几秒。快照到位后 loadKey 会再变一次，
       * 那时才清空并取排序后的前 200 行。
       */
      if (!waitingSnapshot()) setQuotes([])
      if (limit() !== PAGE_SIZE) {
        setLimit(PAGE_SIZE)
        return
      }
    }
    // 快照回来之前不知道该取哪 200 行，先别按旧顺序白拉一轮
    if (waitingSnapshot()) return

    const items = displayed()
    const target = Math.min(limit(), items.length)
    if (target <= loadedCount) return
    const current = ++requestId
    const codes = items.slice(loadedCount, target).map((item) => item.code)
    setLoading(true)
    void (async () => {
      try {
        const data: Quote[] = []
        for (let start = 0; start < codes.length; start += 400) {
          data.push(...(await api.quote.macQuotesFinance(codes.slice(start, start + 400))))
          if (current !== requestId) return
        }
        loadedCount = target
        if (current !== requestId) return
        setQuotes((previous) => [...previous, ...data])
        setError(null)
      } catch (cause) {
        if (current === requestId) setError(errorMessage(cause))
      } finally {
        if (current === requestId) setLoading(false)
      }
    })()
  })

  const quoteMap = createMemo(() => {
    const map = new Map<string, Quote>()
    if (snapshotReady()) for (const [code, quote] of snapshot()) map.set(code, quote)
    for (const quote of quotes()) map.set(quote.code, quote)
    return map
  })
  // 当前页 100 只，排队加载分时（限并发），翻页自动换一批
  createSparklineLoader(() => visibleItems().map((item) => item.code))

  return (
    <div
      class="market-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="market-panel"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="全市场列表"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="market__head">
          <div>
            <div class="market__eyebrow">代码表 + 0x054c 批量快照</div>
            <h2 class="market__title">市场列表</h2>
          </div>
          <button
            class="btn btn--icon btn--bare"
            title="关闭市场列表"
            onClick={() => props.onClose()}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div class="market__tabs" role="tablist">
          <For each={TABS}>
            {(item) => (
              <button
                class={`market__tab market__tab--${item.key}`}
                data-active={tab() === item.key}
                onClick={() => {
                  setTab(item.key)
                  setLimit(PAGE_SIZE)
                  setSort(null)
                }}
              >
                {item.label}
              </button>
            )}
          </For>
          <input
            class="market__search"
            type="search"
            placeholder="搜索代码 / 名称 / 拼音首字母"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setLimit(PAGE_SIZE)
              setSort(null)
            }}
          />
        </div>

        <Show when={error()}>{(message) => <div class="market__error">{message()}</div>}</Show>

        <div
          class="market__table-wrap"
          onScroll={(event) => {
            const el = event.currentTarget
            requestVisibleSparklines(el)
            if (el.scrollTop + el.clientHeight < el.scrollHeight - 240) return
            if (loading() || visibleItems().length >= filtered().length) return
            setLimit((value) => value + PAGE_SIZE)
          }}
        >
          <table class="market__table">
            <colgroup>
              <col style="width: 78px" />
              <col style="width: 76px" />
              <col style="width: 74px" />
              <col style="width: 76px" />
              <col style="width: 82px" />
              <col style="width: 58px" />
              <col style="width: 52px" />
              <col style="width: 60px" />
              <For each={EXTRA_COLUMNS}>
                {(column) => <col data-col={column.key} style={{ width: `${column.width}px` }} />}
              </For>
              {/* 走势列：不设尾列，表格多出的宽度按比例摊到各列，右侧不再留空 */}
              <col style="width: 58px" />
            </colgroup>
            <thead>
              <tr>
                <SortHeader
                  label="代码"
                  sortKey="code"
                  firstDir="asc"
                  sort={sort()}
                  onSort={applySort}
                />
                <SortHeader
                  label="名称"
                  sortKey="name"
                  firstDir="asc"
                  sort={sort()}
                  onSort={applySort}
                />
                <SortHeader
                  label="现价"
                  sortKey="price"
                  class="num"
                  sort={sort()}
                  onSort={applySort}
                />
                <SortHeader
                  label="涨跌幅"
                  sortKey="change"
                  class="num"
                  sort={sort()}
                  onSort={applySort}
                />
                <SortHeader
                  label="成交额"
                  sortKey="amount"
                  class="num"
                  sort={sort()}
                  onSort={applySort}
                />
                <SortHeader
                  label="换手"
                  sortKey="turnover"
                  class="num"
                  sort={sort()}
                  onSort={applySort}
                />
                <SortHeader
                  label="量比"
                  sortKey="volume"
                  class="num"
                  sort={sort()}
                  onSort={applySort}
                />
                <SortHeader
                  label="涨速"
                  sortKey="speed"
                  class="num"
                  sort={sort()}
                  onSort={applySort}
                />
                <ExtraColumnHeaders />
                <th class="num market__spark-head">走势</th>
              </tr>
            </thead>
            <tbody>
              <For each={visibleItems()}>
                {(item) => {
                  const quote = () => quoteMap().get(item.code)
                  return (
                    <tr
                      data-code={item.code}
                      onClick={() => {
                        const current = quote()
                        if (current) {
                          props.onSelect(current)
                          props.onClose()
                        }
                      }}
                      onContextMenu={(event) =>
                        openStockMenu(event, {
                          code: item.code,
                          name: quote()?.name || item.name
                        })
                      }
                    >
                      <td>{item.code.toUpperCase()}</td>
                      <td>{quote()?.name || item.name}</td>
                      <td class="num">{quote() ? fixed(quote()!.price) : '—'}</td>
                      <td
                        class="num"
                        classList={{
                          'tone-up': (quote()?.changePct ?? 0) > 0,
                          'tone-down': (quote()?.changePct ?? 0) < 0
                        }}
                      >
                        {quote() ? signedPct(quote()!.changePct) : '—'}
                      </td>
                      <td class="num">{quote() ? compactAmount(quote()!.amount) : '—'}</td>
                      <td class="num">
                        {quote()?.turnoverRate !== undefined
                          ? `${quote()!.turnoverRate!.toFixed(2)}%`
                          : '—'}
                      </td>
                      <td class="num">
                        {quote()?.volumeRatio !== undefined
                          ? quote()!.volumeRatio!.toFixed(2)
                          : '—'}
                      </td>
                      <td class="num">
                        {quote()?.riseSpeed !== undefined
                          ? `${quote()!.riseSpeed!.toFixed(2)}%`
                          : '—'}
                      </td>
                      <ExtraColumnCells quote={quote()} />
                      <td class="num market__spark-cell">
                        <Show
                          when={sparklineOf(item.code)}
                          fallback={<span class="market__spark-empty">—</span>}
                        >
                          {(data) => (
                            <Sparkline
                              values={data().values}
                              baseline={data().prevClose}
                              width={46}
                              height={20}
                            />
                          )}
                        </Show>
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
          <Show when={loading()}>
            <div class="market__loading">加载当前页报价…</div>
          </Show>
          <Show when={snapshotLoading()}>
            <div class="market__loading">MAC 拉全表报价并排序… {snapshotProgress()}</div>
          </Show>
          <Show when={!loading() && visibleItems().length === 0}>
            <div class="market__empty">没有匹配的证券</div>
          </Show>
        </div>

        <footer class="market__foot">
          <span>
            共 {filtered().length} 条 · 已显示 {visibleItems().length} 条 · 滚动加载更多
            <Show when={sort()}>
              {(state) => (
                <>
                  {' · '}按{SORT_LABEL[state().key] ?? state().key}
                  {state().dir === 'desc' ? '降序' : '升序'}
                  <button
                    class="market__reset"
                    onClick={() => {
                      setSort(null)
                      setLimit(PAGE_SIZE)
                    }}
                  >
                    恢复默认顺序
                  </button>
                </>
              )}
            </Show>
          </span>
          <button
            class="btn market__export"
            onClick={() => {
              const rows = visibleItems().map((item) => {
                const quote = quoteMap().get(item.code)
                return [
                  item.code,
                  item.name,
                  item.market,
                  item.kind,
                  quote?.price ?? '',
                  quote?.changePct ?? '',
                  quote?.amount ?? '',
                  quote?.turnoverRate ?? '',
                  quote?.volumeRatio ?? '',
                  quote?.riseSpeed ?? ''
                ]
              })
              downloadText(
                `pythontdx-market-${visibleItems().length}.csv`,
                toCsv(
                  [
                    '代码',
                    '名称',
                    '市场',
                    '类型',
                    '现价',
                    '涨跌幅',
                    '成交额',
                    '换手率',
                    '量比',
                    '涨速'
                  ],
                  rows
                )
              )
            }}
          >
            导出本页
          </button>
          <button
            class="btn market__blocks"
            onClick={() => {
              props.onClose()
              props.onOpenBlocks()
            }}
          >
            板块个股
          </button>
        </footer>
      </section>
    </div>
  )
}
