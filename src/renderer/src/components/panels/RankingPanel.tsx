/**
 * 排行榜（0x054b / MAC 0x122B / MAC 0x1218）。
 *
 * 服务端排序的一页 A 股行情，切换 tab 只改 `sortType`，不在前端重排。
 * 「资金流」是全市场两步榜：先取 MAC 报价，再批量补 0x1218 主力净额；
 * 单只资金流失败会跳过该只，不把缺失值当成 0 参与排名。
 * 点击某一行把该股行情塞进 quote store 再切过去，不强行加入自选。
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { CategoryQuote, MacMoneyFlowPoint } from '@shared/types'
import { compactAmount, fixed, signedPct } from '@shared/format'
import {
  amplitudePercent,
  filterCapQuotes,
  formatNetFlow,
  mergeMoneyFlowRanking
} from '@shared/ranking'
import { api, errorMessage } from '../../lib/client'
import { createSparklineLoader, requestVisibleSparklines, sparklineOf } from '../../stores/sparklines'
import { openStockMenu } from '../../stores/stockMenu'
import { subscribePush } from '../../lib/push'
import { IconClose } from '../atoms/Icons'
import { Sparkline } from '../charts/Sparkline'
import { EXTRA_COLUMNS, ExtraColumnCells, ExtraColumnHeaders } from '../atoms/StockExtraColumns'

interface RankingPanelProps {
  onClose: () => void
  onSelect: (quote: CategoryQuote) => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}

interface SortTab {
  label: string
  sortType: number
  metric: (quote: CategoryQuote) => number
  full: boolean
  /** 该排序只在全市场 MAC 模式有效 */
  fullOnly?: boolean
  /** 全市场本地排序方向 */
  ascending?: boolean
}

const SORTS: SortTab[] = [
  { label: '涨幅', sortType: 0x000e, metric: (quote) => quote.changePct, full: true },
  {
    label: '跌幅',
    sortType: 0x000e,
    metric: (quote) => quote.changePct,
    full: true,
    fullOnly: true,
    ascending: true
  },
  { label: '成交额', sortType: 0x000a, metric: (quote) => quote.amount, full: true },
  { label: '涨速', sortType: 0x002e, metric: (quote) => quote.riseSpeed ?? 0, full: true },
  {
    label: '换手率',
    sortType: 0x00cd,
    metric: (quote) => quote.turnoverRate ?? 0,
    full: true,
    fullOnly: true
  },
  {
    label: '振幅',
    sortType: 0,
    // MAC 0x122B 没有直接给振幅，用 (最高-最低)/昨收 计算，避免全市场榜全是 0。
    metric: (quote) => amplitudePercent(quote),
    full: true,
    fullOnly: true
  },
  {
    label: '流通市值',
    sortType: 0,
    metric: (quote) => quote.floatCap ?? 0,
    full: true,
    fullOnly: true
  },
  {
    label: '总市值',
    sortType: 0,
    metric: (quote) => quote.totalCap ?? 0,
    full: true,
    fullOnly: true
  },
  {
    label: '量比',
    sortType: 0x00ce,
    metric: (quote) => quote.volumeRatio ?? 0,
    full: true,
    fullOnly: true
  },
  { label: '短换手', sortType: 0x00cc, metric: (quote) => quote.shortTurnover ?? 0, full: false },
  { label: '封单额', sortType: 0x001c, metric: (quote) => quote.lockedAmount ?? 0, full: false },
  {
    label: '资金流',
    sortType: 0,
    metric: (quote) => quote.mainNet ?? Number.NEGATIVE_INFINITY,
    full: true,
    fullOnly: true
  }
]

export function RankingPanel(props: RankingPanelProps): JSX.Element {
  const [sort, setSort] = createSignal(SORTS[0])
  const [rows, setRows] = createSignal<CategoryQuote[]>([])
  createSparklineLoader(() => rows().map((quote) => quote.code))
  /**
   * 0x054b 不返回量比；用一次 MAC 批量报价补齐缺字段（只补空值，不覆盖原数据）。
   * 同一批代码只补一次，避免 setRows 触发循环。
   */
  let enrichedKey = ''
  createEffect(() => {
    const list = rows()
    if (list.length === 0) return
    if (list.every((quote) => quote.volumeRatio !== undefined)) return
    const key = list.map((quote) => quote.code).join(',')
    if (key === enrichedKey) return
    enrichedKey = key
    void api.quote
      .macQuotesFinance(list.map((quote) => quote.code))
      .then((mac) => {
        const extra = new Map(mac.map((quote) => [quote.code, quote]))
        setRows((previous) =>
          previous.map((quote) => {
            const more = extra.get(quote.code)
            if (!more) return quote
            return {
              ...quote,
              turnoverRate: quote.turnoverRate ?? more.turnoverRate,
              volumeRatio: quote.volumeRatio ?? more.volumeRatio,
              riseSpeed: quote.riseSpeed ?? more.riseSpeed,
              avgPrice: quote.avgPrice ?? more.avgPrice,
              amplitude: quote.amplitude ?? more.amplitude,
              pb: quote.pb ?? more.pb,
              totalCap: quote.totalCap ?? more.totalCap,
              floatCap: quote.floatCap ?? more.floatCap
            }
          })
        )
      })
      .catch(() => undefined)
  })
  const [loading, setLoading] = createSignal(true)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [hasMore, setHasMore] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [fullMode, setFullMode] = createSignal(false)
  const [fullTotal, setFullTotal] = createSignal(0)
  const [flowProgress, setFlowProgress] = createSignal<{ done: number; total: number } | null>(null)
  const [flowMatched, setFlowMatched] = createSignal(0)
  let requestId = 0
  let pushDispose: (() => void) | undefined

  const flowMode = (): boolean => sort().label === '资金流'
  const financeMode = (): boolean => sort().label === '流通市值' || sort().label === '总市值'

  const loadFull = async (current: number): Promise<void> => {
    const catalog = await api.quote.catalog()
    const codes = catalog
      .filter(
        (item) =>
          item.kind === 'GP-A' &&
          ((item.market === 'SH' && /^(600|601|603|605|688|689)/.test(item.symbol)) ||
            (item.market === 'SZ' && /^(000|001|002|003|300|301|302)/.test(item.symbol)) ||
            (item.market === 'BJ' && /^[489]/.test(item.symbol)))
      )
      .map((item) => item.code)
    const quotes: CategoryQuote[] = []
    for (let start = 0; start < codes.length; start += 500) {
      const chunk = financeMode()
        ? await api.quote.macQuotesFinance(codes.slice(start, start + 500))
        : await api.quote.macQuotes(codes.slice(start, start + 500))
      if (current !== requestId) return
      quotes.push(...(chunk as CategoryQuote[]))
    }
    const activeSort = sort()
    if (activeSort.label === '资金流') {
      // 两步榜：报价只负责代码/名称/成交额，净额全部来自 0x1218。
      setFlowProgress({ done: 0, total: quotes.length })
      const flows: MacMoneyFlowPoint[] = []
      let failedChunks = 0
      for (let start = 0; start < quotes.length; start += 400) {
        const chunk = quotes.slice(start, start + 400).map((quote) => quote.code)
        try {
          flows.push(...(await api.money.macFlowBatch(chunk, 12)))
        } catch {
          // 单个分块失败不应让已经拿到的资金流全部作废
          failedChunks += 1
        }
        if (current !== requestId) return
        setFlowProgress({
          done: Math.min(start + 400, quotes.length),
          total: quotes.length
        })
      }
      if (current !== requestId) return
      const ranked = mergeMoneyFlowRanking(quotes, flows)
      setFlowMatched(ranked.matched)
      setFullTotal(ranked.total)
      setRows(ranked.quotes.slice(0, 300))
      setHasMore(false)
      setError(
        ranked.quotes.length === 0 && quotes.length > 0
          ? `资金流批量接口没有返回数据${failedChunks > 0 ? `（${failedChunks} 个分块失败）` : ''}`
          : null
      )
      return
    }
    setFlowProgress(null)
    setFlowMatched(0)
    let ranked = quotes
    if (financeMode()) {
      const capKey = activeSort.label === '总市值' ? 'totalCap' : 'floatCap'
      const filtered = filterCapQuotes(quotes, capKey)
      if (filtered.quotes.length === 0) {
        setRows([])
        setFullTotal(0)
        setHasMore(false)
        setError('0x0010 财务数据不可用，无法生成市值排行')
        return
      }
      ranked = filtered.quotes
    }
    ranked.sort((a, b) =>
      activeSort.ascending
        ? activeSort.metric(a) - activeSort.metric(b)
        : activeSort.metric(b) - activeSort.metric(a)
    )
    setFullTotal(ranked.length)
    setRows(ranked.slice(0, 300))
    setHasMore(false)
    setError(null)
  }

  const load = async (): Promise<void> => {
    const current = ++requestId
    setLoading(true)
    try {
      if (fullMode()) {
        await loadFull(current)
        return
      }
      const data = await api.quote.category({
        category: 6,
        sortType: sort().sortType,
        count: 80
      })
      if (current !== requestId) return
      setRows(data)
      setHasMore(data.length === 80)
      setError(null)
    } catch (cause) {
      if (current !== requestId) return
      setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  const loadMore = async (): Promise<void> => {
    if (fullMode() || !hasMore() || loadingMore()) return
    const current = ++requestId
    setLoadingMore(true)
    setExpanded(true)
    try {
      const data = await api.quote.category({
        category: 6,
        sortType: sort().sortType,
        start: rows().length,
        count: 80
      })
      if (current !== requestId) return
      setRows([...rows(), ...data])
      setHasMore(data.length === 80)
      setError(null)
    } catch (cause) {
      if (current !== requestId) return
      setExpanded(false)
      setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoadingMore(false)
    }
  }

  // sort() 变化 → 重新向服务端要第一页；首次挂载也会走这里
  createEffect(() => {
    const active = sort()
    const full = fullMode()
    pushDispose?.()
    pushDispose = undefined
    setExpanded(false)
    void load()
    if (!full && active.label !== '资金流') {
      pushDispose = subscribePush<CategoryQuote[]>(
        {
          kind: 'category',
          category: 6,
          sortType: active.sortType,
          start: 0,
          count: 80
        },
        1000,
        (data) => {
          if (expanded() || sort().label !== active.label) return
          setRows(data)
          setHasMore(data.length === 80)
          setError(null)
        },
        (message) => {
          if (!expanded()) setError(message)
        }
      )
    }
    onCleanup(() => {
      pushDispose?.()
      pushDispose = undefined
    })
  })

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  return (
    <div
      class="ranking-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="ranking"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="A 股排行榜"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="ranking__head">
          <div>
            <div class="ranking__eyebrow">
              沪深 A 股 ·{' '}
              {flowMode()
                ? 'MAC 0x1218 全市场资金流'
                : fullMode()
                  ? 'MAC 全市场排序'
                  : '0x054b 服务端排序'}
            </div>
            <h2 class="ranking__title">排行榜</h2>
          </div>
          <div class="ranking__actions">
            <button
              class="btn ranking-full"
              data-active={fullMode()}
              disabled={flowMode()}
              title={flowMode() ? '资金流排行固定为全市场' : '全市场 MAC 排序'}
              onClick={() => {
                if (flowMode()) return
                const next = !fullMode()
                if (next && !sort().full) setSort(SORTS[0])
                if (!next && sort().fullOnly) setSort(SORTS[0])
                setFullMode(next)
              }}
            >
              {fullMode() ? '全市场' : '前 80'}
            </button>
            <button
              class="btn btn--icon btn--bare"
              title="关闭排行榜"
              onClick={() => props.onClose()}
            >
              <IconClose size={16} />
            </button>
          </div>
        </header>

        <div class="ranking__tabs" role="tablist" aria-label="排序方式">
          <For each={SORTS}>
            {(item) => (
              <button
                class="ranking__tab"
                classList={{ 'ranking__tab--active': item.label === sort().label }}
                disabled={fullMode() && !item.full}
                title={fullMode() && !item.full ? '该指标仅 0x054b 提供' : undefined}
                role="tab"
                aria-selected={item.label === sort().label}
                onClick={() => {
                  if (item.fullOnly && !fullMode()) setFullMode(true)
                  setSort(item)
                }}
              >
                {item.label}
              </button>
            )}
          </For>
          <span class="ranking__count">
            <Show
              when={loading()}
              fallback={
                flowMode()
                  ? `已匹配 ${flowMatched()}/${fullTotal()} 只`
                  : fullMode()
                    ? `${fullTotal()} 只中前 ${rows().length}`
                    : `${rows().length} 只`
              }
            >
              <Show when={flowProgress()} fallback="刷新中…">
                {(progress) => `扫描资金流 ${progress().done}/${progress().total}`}
              </Show>
            </Show>
          </span>
        </div>

        <Show when={error()}>
          {(message) => (
            <div class="ranking__error" role="alert">
              {message()}
              <button class="ranking__retry" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}
        </Show>

        <div
          class="ranking__table-wrap"
          onScroll={(event) => {
            const el = event.currentTarget
            requestVisibleSparklines(el)
            if (el.scrollTop + el.clientHeight < el.scrollHeight - 240) return
            if (hasMore() && !loadingMore() && !fullMode()) void loadMore()
          }}
        >
          <table class="ranking__table">
            <colgroup>
              <col style="width: 36px" />
              <col style="width: 70px" />
              <col style="width: 72px" />
              <col style="width: 72px" />
              <col style="width: 74px" />
              <col style="width: 84px" />
              <col style="width: 56px" />
              <col style="width: 50px" />
              <col style="width: 58px" />
              <For each={EXTRA_COLUMNS}>
                {(column) => (
                  <col data-col={column.key} style={{ width: `${column.width}px` }} />
                )}
              </For>
              <Show when={flowMode()}>
                <col style="width: 86px" />
              </Show>
              {/* 走势列：不设尾列，右侧不留空 */}
              <col style="width: 58px" />
            </colgroup>
            <thead>
              <tr>
                <th class="ranking__rank">#</th>
                <th>代码</th>
                <th>名称</th>
                <th class="ranking__num">现价</th>
                <th class="ranking__num">涨幅</th>
                <th class="ranking__num">成交额</th>
                <th class="ranking__num">换手</th>
                <th class="ranking__num">量比</th>
                <th class="ranking__num">涨速</th>
                <ExtraColumnHeaders />
                <Show when={flowMode()}>
                  <th class="ranking__num">主力净额 / 占比</th>
                </Show>
                <th class="ranking__num ranking__spark-head">走势</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(quote, index) => (
                  <tr
                    data-code={quote.code}
                    class="ranking__row"
                    onClick={() => props.onSelect(quote)}
                    onContextMenu={(event) =>
                      openStockMenu(event, { code: quote.code, name: quote.name })
                    }
                  >
                    <td class="ranking__rank num">{index() + 1}</td>
                    <td class="ranking__code">{quote.code.toUpperCase()}</td>
                    <td class="ranking__name">{quote.name}</td>
                    <td class="ranking__num num">{fixed(quote.price)}</td>
                    <td
                      class="ranking__num num"
                      classList={{
                        'tone-up': quote.changePct > 0,
                        'tone-down': quote.changePct < 0
                      }}
                    >
                      {signedPct(quote.changePct)}
                    </td>
                    <td class="ranking__num num">{compactAmount(quote.amount)}</td>
                    <td class="ranking__num num">
                      {quote.turnoverRate !== undefined ? `${quote.turnoverRate.toFixed(2)}%` : '—'}
                    </td>
                    <td class="ranking__num num">
                      {quote.volumeRatio !== undefined ? quote.volumeRatio.toFixed(2) : '—'}
                    </td>
                    <td class="ranking__num num">
                      {quote.riseSpeed !== undefined ? `${quote.riseSpeed.toFixed(2)}%` : '—'}
                    </td>
                    <ExtraColumnCells quote={quote} />
                    <Show when={flowMode()}>
                      <td
                        class="ranking__num num"
                        classList={{
                          'tone-up': (quote.mainNet ?? 0) > 0,
                          'tone-down': (quote.mainNet ?? 0) < 0
                        }}
                      >
                        {metricText(quote, sort())}
                      </td>
                    </Show>
                    <td class="ranking__num ranking__spark-cell">
                      <Show
                        when={sparklineOf(quote.code)}
                        fallback={<span class="ranking__spark-empty">—</span>}
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
                )}
              </For>
            </tbody>
          </table>
          <Show when={!loading() && rows().length === 0 && !error()}>
            <div class="ranking__empty">这一页没有数据</div>
          </Show>
        </div>

        <footer class="ranking__foot">
          <span>
            数据源：通达信{' '}
            {flowMode()
              ? 'MAC 0x1218 · 主力净额 / 成交额'
              : financeMode()
                ? 'MAC 0x122B + 0x0010 财务'
                : fullMode()
                  ? 'MAC 0x122B'
                  : '0x054b'}
          </span>
          <Show
            when={!fullMode() && hasMore()}
            fallback={
              <span>
                {flowMode()
                  ? `全市场前 300 · 匹配 ${flowMatched()}/${fullTotal()}`
                  : fullMode()
                    ? '全市场前 300'
                    : '已到末尾'}
              </span>
            }
          >
            <span>{loadingMore() ? '加载中…' : '滚动到底自动加载'}</span>
          </Show>
        </footer>
      </section>
    </div>
  )
}

function metricText(quote: CategoryQuote, tab: SortTab): string {
  const value = tab.metric(quote)
  if (tab.label === '资金流') {
    return `${formatNetFlow(value)} · ${fixed(quote.mainRatio ?? 0)}%`
  }
  if (tab.sortType === 0x000a || tab.sortType === 0x001c) return compactAmount(value)
  if (tab.sortType === 0x000e) return signedPct(value)
  if (tab.label === '量比') return `${fixed(value)}x`
  if (tab.label === '流通市值' || tab.label === '总市值') return `${fixed(value)}亿`
  return `${fixed(value)}%`
}
