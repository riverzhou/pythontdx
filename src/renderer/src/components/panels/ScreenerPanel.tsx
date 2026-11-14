/**
 * 条件选股：全市场扫描价格/涨幅/成交额/换手/振幅/PE/PB/量比。
 *
 * 扫描由 Python 后端翻页拉取 0x054b；这里只负责条件输入与结果表格。
 * 不做未来函数、不生成交易指令。
 */
import { createSignal, For, Show, type JSX } from 'solid-js'
import type {
  CategoryQuote,
  FormulaMarketBacktestResult,
  FormulaScreenResult,
  ScreenResult,
  ScreenSortBy
} from '@shared/types'
import { compactAmount, fixed, signedPct, thousands } from '@shared/format'
import { api, errorMessage } from '../../lib/client'
import { openStockMenu } from '../../stores/stockMenu'
import { IconClose } from '../atoms/Icons'
import { appState, createGroupWithItems, updateSettings } from '../../stores/app'
import type { ScreenPreset } from '@shared/types'

interface ScreenerPanelProps {
  onClose: () => void
  onSelect: (quote: CategoryQuote) => void
  /** 作为主工作区标签页渲染（非弹窗） */
  embedded?: boolean
}

const SORTS: Array<{ value: ScreenSortBy; label: string }> = [
  { value: 'changePct', label: '涨幅' },
  { value: 'amount', label: '成交额' },
  { value: 'turnoverRate', label: '换手率' },
  { value: 'amplitude', label: '振幅' },
  { value: 'pb', label: '市净率' },
  { value: 'floatCap', label: '流通市值' },
  { value: 'totalCap', label: '总市值' }
]

function numberOrUndefined(value: string): number | undefined {
  const text = value.trim()
  if (!text) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 界面输入「亿」，后端 floatCap/totalCap 也是「亿」；不要乘 1e8。 */
function toCap(value: string): number | undefined {
  return numberOrUndefined(value)
}

export function ScreenerPanel(props: ScreenerPanelProps): JSX.Element {
  const [minChange, setMinChange] = createSignal('3')
  const [minAmountYi, setMinAmountYi] = createSignal('1')
  const [minTurnover, setMinTurnover] = createSignal('')
  const [minAmplitude, setMinAmplitude] = createSignal('')
  const [maxPrice, setMaxPrice] = createSignal('')
  const [maxPb, setMaxPb] = createSignal('')
  const [minFloatCapYi, setMinFloatCapYi] = createSignal('')
  const [maxFloatCapYi, setMaxFloatCapYi] = createSignal('')
  const [minTotalCapYi, setMinTotalCapYi] = createSignal('')
  const [maxTotalCapYi, setMaxTotalCapYi] = createSignal('')
  const [sortBy, setSortBy] = createSignal<ScreenSortBy>('changePct')
  const [result, setResult] = createSignal<ScreenResult | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [poolNotice, setPoolNotice] = createSignal<string | null>(null)
  const [industry, setIndustry] = createSignal('')
  const [formula, setFormula] = createSignal('CLOSE > MA(CLOSE,20)')
  const [formulaScope, setFormulaScope] = createSignal('100')
  const [formulaResult, setFormulaResult] = createSignal<FormulaScreenResult | null>(null)
  const [formulaLoading, setFormulaLoading] = createSignal(false)
  const [formulaError, setFormulaError] = createSignal<string | null>(null)
  const [formulaProgress, setFormulaProgress] = createSignal<{
    offset: number
    total: number
  } | null>(null)
  let formulaCancelled = false
  const [marketBacktest, setMarketBacktest] = createSignal<{
    strategyReturn: number
    maxDrawdown: number
    trades: number
    stocks: number
    days: number
  } | null>(null)
  const [backtestLoading, setBacktestLoading] = createSignal(false)
  const [backtestProgress, setBacktestProgress] = createSignal<{
    offset: number
    total: number
  } | null>(null)
  let backtestCancelled = false

  const runFormula = async (): Promise<void> => {
    if (formulaLoading()) {
      formulaCancelled = true
      return
    }
    formulaCancelled = false
    setFormulaLoading(true)
    setFormulaError(null)
    setFormulaResult(null)
    setFormulaProgress(null)
    const matches: FormulaScreenResult['quotes'] = []
    const expression = formula()
    let offset = 0
    let total: number
    try {
      do {
        const data = await api.screen.formula({
          expression,
          scope: Number(formulaScope()),
          offset,
          batchSize: 100,
          limit: 200
        })
        matches.push(...data.quotes)
        total = data.total
        offset = data.nextOffset
        setFormulaProgress({ offset, total })
        if (formulaCancelled) break
      } while (offset < total)
      if (!formulaCancelled) {
        setFormulaResult({
          scanned: total,
          total,
          nextOffset: offset,
          done: true,
          matched: matches.length,
          quotes: matches,
          expression,
          generatedAt: Date.now()
        })
      }
    } catch (cause) {
      setFormulaResult(null)
      setFormulaError(errorMessage(cause))
    } finally {
      setFormulaLoading(false)
    }
  }

  const runMarketBacktest = async (): Promise<void> => {
    if (backtestLoading()) {
      backtestCancelled = true
      return
    }
    backtestCancelled = false
    setBacktestLoading(true)
    setMarketBacktest(null)
    setFormulaError(null)
    setBacktestProgress(null)
    const daily = new Map<string, { sum: number; count: number }>()
    let offset = 0
    let total: number
    let trades = 0
    let stocks = 0
    try {
      do {
        const data: FormulaMarketBacktestResult = await api.screen.formulaBacktest({
          expression: formula(),
          scope: Number(formulaScope()),
          offset,
          batchSize: 100
        })
        for (const day of data.daily) {
          const bucket = daily.get(day.date) ?? { sum: 0, count: 0 }
          bucket.sum += day.sum
          bucket.count += day.count
          daily.set(day.date, bucket)
        }
        trades += data.trades
        stocks += data.stocks
        total = data.total
        offset = data.nextOffset
        setBacktestProgress({ offset, total })
        if (backtestCancelled) break
      } while (offset < total)
      if (!backtestCancelled) {
        let equity = 100_000
        let peak = equity
        let maxDrawdown = 0
        const dates = [...daily.keys()].sort()
        for (const date of dates) {
          const bucket = daily.get(date)!
          if (bucket.count === 0) continue
          equity *= 1 + bucket.sum / bucket.count
          peak = Math.max(peak, equity)
          maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0)
        }
        setMarketBacktest({
          strategyReturn: (equity / 100_000 - 1) * 100,
          maxDrawdown: maxDrawdown * 100,
          trades,
          stocks,
          days: dates.length
        })
      }
    } catch (cause) {
      setFormulaError(errorMessage(cause))
    } finally {
      setBacktestLoading(false)
    }
  }

  const run = async (): Promise<void> => {
    if (loading()) return
    setLoading(true)
    setError(null)
    try {
      const amountYi = numberOrUndefined(minAmountYi())
      const data = await api.screen.run({
        minChangePct: numberOrUndefined(minChange()),
        minAmount: amountYi === undefined ? undefined : amountYi * 100_000_000,
        minTurnoverRate: numberOrUndefined(minTurnover()),
        minAmplitude: numberOrUndefined(minAmplitude()),
        maxPrice: numberOrUndefined(maxPrice()),
        maxPb: numberOrUndefined(maxPb()),
        minFloatCap: toCap(minFloatCapYi()),
        maxFloatCap: toCap(maxFloatCapYi()),
        minTotalCap: toCap(minTotalCapYi()),
        maxTotalCap: toCap(maxTotalCapYi()),
        industry: industry().trim() || undefined,
        sortBy: sortBy(),
        limit: 100
      })
      setResult(data)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const savePreset = (): void => {
    const preset: ScreenPreset = {
      id: `p${Date.now().toString(36)}`,
      name: `预设 ${new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)}`,
      minChange: minChange(),
      minAmountYi: minAmountYi(),
      minTurnover: minTurnover(),
      minAmplitude: minAmplitude(),
      maxPrice: maxPrice(),
      maxPb: maxPb(),
      minFloatCapYi: minFloatCapYi(),
      maxFloatCapYi: maxFloatCapYi(),
      minTotalCapYi: minTotalCapYi(),
      maxTotalCapYi: maxTotalCapYi(),
      industry: industry(),
      sortBy: sortBy(),
      createdAt: Date.now()
    }
    updateSettings({
      screenPresets: [preset, ...(appState.settings.screenPresets ?? [])].slice(0, 10)
    })
    setPoolNotice(`已保存预设：${preset.name}`)
  }

  const applyPreset = async (preset: ScreenPreset): Promise<void> => {
    setMinChange(preset.minChange)
    setMinAmountYi(preset.minAmountYi)
    setMinTurnover(preset.minTurnover)
    setMinAmplitude(preset.minAmplitude)
    setMaxPrice(preset.maxPrice)
    setMaxPb(preset.maxPb ?? '')
    setMinFloatCapYi(preset.minFloatCapYi ?? '')
    setMaxFloatCapYi(preset.maxFloatCapYi ?? '')
    setMinTotalCapYi(preset.minTotalCapYi ?? '')
    setMaxTotalCapYi(preset.maxTotalCapYi ?? '')
    setIndustry(preset.industry)
    setSortBy(preset.sortBy)
    setPoolNotice(`已载入预设：${preset.name}`)
    await run()
  }

  const tracked = (id: string): boolean => {
    const settings = appState.settings
    const ids = settings.trackingPresetIds ?? []
    if (ids.length > 0) return ids.includes(id)
    return settings.trackingPresetId === id
  }

  const removePreset = (id: string): void => {
    updateSettings({
      screenPresets: (appState.settings.screenPresets ?? []).filter((preset) => preset.id !== id),
      trackingPresetIds: (appState.settings.trackingPresetIds ?? []).filter((item) => item !== id),
      trackingPresetId:
        appState.settings.trackingPresetId === id ? undefined : appState.settings.trackingPresetId
    })
  }

  const toggleTracking = (preset: ScreenPreset): void => {
    const active = tracked(preset.id)
    const ids = new Set(
      appState.settings.trackingPresetIds ??
        (appState.settings.trackingPresetId ? [appState.settings.trackingPresetId] : [])
    )
    if (active) ids.delete(preset.id)
    else ids.add(preset.id)
    updateSettings({ trackingPresetIds: [...ids], trackingPresetId: undefined })
    setPoolNotice(
      active ? `已停止跟踪：${preset.name}` : `开始跟踪：${preset.name}（每 60 秒更新自动池）`
    )
  }

  const saveAsPool = (): void => {
    const quotes = formulaResult()?.quotes ?? result()?.quotes ?? []
    if (quotes.length === 0) return
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '')
    const count = createGroupWithItems(
      `选股 ${stamp}`,
      quotes.map((quote) => ({ code: quote.code, name: quote.name, market: quote.market }))
    )
    setPoolNotice(`已存为股票池：${count} 只`)
  }

  return (
    <div
      class="screener-backdrop"
      classList={{ 'panel-embed': props.embedded === true }}
      onClick={() => {
        if (!props.embedded) props.onClose()
      }}
    >
      <section
        class="screener"
        role={props.embedded ? 'region' : 'dialog'}
        aria-modal={props.embedded ? undefined : 'true'}
        aria-label="条件选股"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="screener__head">
          <div>
            <div class="screener__eyebrow">全市场 · 0x054b · 本地条件</div>
            <h2 class="screener__title">条件选股</h2>
          </div>
          <div class="screener__head-actions">
            <button class="btn screener__pool" onClick={saveAsPool}>
              存为股票池
            </button>
            <button
              class="btn btn--icon btn--bare"
              title="关闭选股"
              onClick={() => props.onClose()}
            >
              <IconClose size={16} />
            </button>
          </div>
        </header>

        <Show when={poolNotice()}>
          {(message) => <div class="screener__pool-notice">{message()}</div>}
        </Show>

        <div class="screener__presets">
          <span class="screener__presets-label">条件预设</span>
          <button class="btn screener__preset-save" onClick={savePreset}>
            保存当前
          </button>
          <For each={appState.settings.screenPresets ?? []}>
            {(preset) => (
              <span class="screener__preset">
                <button
                  class="screener__preset-apply"
                  title={`${preset.minChange}% / ${preset.minAmountYi}亿`}
                  onClick={() => void applyPreset(preset)}
                >
                  {preset.name}
                </button>
                <button
                  class={`screener__preset-track ${tracked(preset.id) ? 'is-tracking' : ''}`}
                  title="每 60 秒重扫并更新自动池"
                  onClick={() => toggleTracking(preset)}
                >
                  {tracked(preset.id) ? '跟踪中' : '跟踪'}
                </button>
                <button
                  class="screener__preset-remove"
                  title="删除预设"
                  onClick={() => removePreset(preset.id)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>

        <div class="screener__filters">
          <label class="screener__field">
            <span>涨幅 ≥</span>
            <input
              type="number"
              step="0.1"
              value={minChange()}
              onInput={(event) => setMinChange(event.currentTarget.value)}
            />
            <em>%</em>
          </label>
          <label class="screener__field">
            <span>成交额 ≥</span>
            <input
              type="number"
              step="0.1"
              value={minAmountYi()}
              onInput={(event) => setMinAmountYi(event.currentTarget.value)}
            />
            <em>亿</em>
          </label>
          <label class="screener__field">
            <span>换手 ≥</span>
            <input
              type="number"
              step="0.1"
              value={minTurnover()}
              onInput={(event) => setMinTurnover(event.currentTarget.value)}
            />
            <em>%</em>
          </label>
          <label class="screener__field">
            <span>振幅 ≥</span>
            <input
              type="number"
              step="0.1"
              value={minAmplitude()}
              onInput={(event) => setMinAmplitude(event.currentTarget.value)}
            />
            <em>%</em>
          </label>
          <label class="screener__field">
            <span>价格 ≤</span>
            <input
              type="number"
              step="0.1"
              value={maxPrice()}
              onInput={(event) => setMaxPrice(event.currentTarget.value)}
            />
            <em>元</em>
          </label>
          <label class="screener__field">
            <span>PB ≤</span>
            <input
              type="number"
              step="0.1"
              value={maxPb()}
              onInput={(event) => setMaxPb(event.currentTarget.value)}
            />
          </label>
          <label class="screener__field">
            <span>流通市值 ≥</span>
            <input
              type="number"
              step="1"
              value={minFloatCapYi()}
              onInput={(event) => setMinFloatCapYi(event.currentTarget.value)}
            />
            <em>亿</em>
          </label>
          <label class="screener__field">
            <span>流通市值 ≤</span>
            <input
              type="number"
              step="1"
              value={maxFloatCapYi()}
              onInput={(event) => setMaxFloatCapYi(event.currentTarget.value)}
            />
            <em>亿</em>
          </label>
          <label class="screener__field">
            <span>总市值 ≥</span>
            <input
              type="number"
              step="1"
              value={minTotalCapYi()}
              onInput={(event) => setMinTotalCapYi(event.currentTarget.value)}
            />
            <em>亿</em>
          </label>
          <label class="screener__field">
            <span>总市值 ≤</span>
            <input
              type="number"
              step="1"
              value={maxTotalCapYi()}
              onInput={(event) => setMaxTotalCapYi(event.currentTarget.value)}
            />
            <em>亿</em>
          </label>
          <label class="screener__field">
            <span>行业</span>
            <input
              type="text"
              placeholder="如 银行"
              value={industry()}
              onInput={(event) => setIndustry(event.currentTarget.value)}
            />
          </label>
          <label class="screener__field screener__field--sort">
            <span>排序</span>
            <select
              value={sortBy()}
              onChange={(event) => setSortBy(event.currentTarget.value as ScreenSortBy)}
            >
              <For each={SORTS}>{(item) => <option value={item.value}>{item.label}</option>}</For>
            </select>
          </label>
          <button
            class="btn btn--primary screener__run"
            disabled={loading()}
            onClick={() => void run()}
          >
            {loading() ? '扫描全市场…' : '开始筛选'}
          </button>
        </div>

        <Show when={error()}>
          {(message) => (
            <div class="screener__error" role="alert">
              {message()}
            </div>
          )}
        </Show>

        <div class="screener__summary">
          <Show
            when={result()}
            fallback={<span>设置条件后点击「开始筛选」；全市场约 5,500 只。</span>}
          >
            {(data) => (
              <>
                <span>
                  扫描 {thousands(data().scanned)} 只 · 命中 {thousands(data().matched)} 只
                </span>
                <span>
                  {new Date(data().generatedAt).toLocaleTimeString('zh-CN')} · 最多显示 100 条
                </span>
              </>
            )}
          </Show>
        </div>

        <div class="screener__formula">
          <input
            class="screener__formula-input"
            value={formula()}
            placeholder="公式，如 CLOSE > MA(CLOSE,20)"
            onInput={(event) => setFormula(event.currentTarget.value)}
          />
          <select
            class="screener__formula-scope"
            value={formulaScope()}
            onChange={(event) => setFormulaScope(event.currentTarget.value)}
          >
            <option value="100">成交额前 100</option>
            <option value="500">成交额前 500</option>
            <option value="0">全市场（约 1–2 分钟）</option>
          </select>
          <Show when={formulaScope() === '0'}>
            <span class="screener__formula-note">逐只拉日 K，期间没有进度条</span>
          </Show>
          <button class="btn screener__formula-run" onClick={() => void runFormula()}>
            {formulaLoading() ? '取消扫描' : '公式选股'}
          </button>
          <button class="btn screener__backtest-run" onClick={() => void runMarketBacktest()}>
            {backtestLoading() ? '取消回测' : '组合回测'}
          </button>
        </div>
        <Show when={formulaLoading() && formulaProgress()}>
          {(value) => (
            <div class="screener__formula-meta">
              公式扫描 {value().offset} / {value().total}
            </div>
          )}
        </Show>
        <Show when={formulaLoading() && !formulaProgress()}>
          <div class="screener__formula-meta">公式扫描准备中…</div>
        </Show>

        <Show when={backtestLoading() && backtestProgress()}>
          {(value) => (
            <div class="screener__formula-meta">
              组合回测 {value().offset} / {value().total}
            </div>
          )}
        </Show>
        <Show when={marketBacktest()}>
          {(data) => (
            <div class="screener__backtest">
              <span>等权组合 {signedPct(data().strategyReturn)}</span>
              <span>最大回撤 {fixed(data().maxDrawdown)}%</span>
              <span>
                {data().stocks} 只 · {data().days} 天 · {data().trades} 次调仓
              </span>
            </div>
          )}
        </Show>

        <Show when={formulaError()}>
          {(message) => <div class="screener__error">{message()}</div>}
        </Show>
        <Show when={formulaResult()}>
          {(data) => (
            <div class="screener__formula-result">
              <div class="screener__formula-meta">
                {data().expression} · 扫描 {data().scanned} 只 · 命中 {data().matched} 只
              </div>
              <div class="screener__table-wrap">
                <table class="screener__table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>代码</th>
                      <th class="num">价格</th>
                      <th class="num">涨跌幅</th>
                      <th class="num">公式值</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={data().quotes}>
                      {(quote) => (
                        <tr
                          onClick={() => {
                            props.onSelect(quote)
                            props.onClose()
                          }}
                        >
                          <td>{quote.name}</td>
                          <td class="num">{quote.code.toUpperCase()}</td>
                          <td class="num">{fixed(quote.price)}</td>
                          <td class="num">{signedPct(quote.changePct)}</td>
                          <td class="num">{fixed(quote.formulaValue)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Show>

        <div class="screener__table-wrap">
          <Show when={result()} fallback={<div class="screener__empty">结果会显示在这里</div>}>
            {(data) => (
              <table class="screener__table">
                <thead>
                  <tr>
                    <th>代码 / 名称</th>
                    <th class="num">现价</th>
                    <th class="num">涨幅</th>
                    <th class="num">成交额</th>
                    <th class="num">换手</th>
                    <th class="num">流通市值</th>
                    <th class="num">总市值</th>
                    <th class="num">PB</th>
                    <th class="num">振幅</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={data().quotes}>
                    {(quote) => (
                      <tr
                        class="screener__row"
                        onClick={() => props.onSelect(quote)}
                        onContextMenu={(event) =>
                          openStockMenu(event, { code: quote.code, name: quote.name })
                        }
                      >
                        <td>
                          <div class="screener__name">{quote.name}</div>
                          <div class="screener__code num">{quote.code.toUpperCase()}</div>
                        </td>
                        <td class="num">{fixed(quote.price)}</td>
                        <td
                          class="num"
                          classList={{
                            'tone-up': quote.changePct > 0,
                            'tone-down': quote.changePct < 0
                          }}
                        >
                          {signedPct(quote.changePct)}
                        </td>
                        <td class="num">{compactAmount(quote.amount)}</td>
                        <td class="num">
                          {quote.turnoverRate === undefined ? '—' : `${fixed(quote.turnoverRate)}%`}
                        </td>
                        <td class="num">
                          {quote.floatCap === undefined ? '—' : `${fixed(quote.floatCap)}亿`}
                        </td>
                        <td class="num">
                          {quote.totalCap === undefined ? '—' : `${fixed(quote.totalCap)}亿`}
                        </td>
                        <td class="num">{quote.pb === undefined ? '—' : fixed(quote.pb)}</td>
                        <td class="num">
                          {quote.amplitude === undefined ? '—' : `${fixed(quote.amplitude)}%`}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            )}
          </Show>
        </div>

        <footer class="screener__foot">
          <span>数据源：通达信 7709 · 0x054b · 全市场扫描</span>
          <span>仅筛选，不生成交易指令；扫描结果缓存 60 秒</span>
        </footer>
      </section>
    </div>
  )
}
