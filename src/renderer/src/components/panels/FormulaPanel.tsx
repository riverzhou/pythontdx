/**
 * 公式预览：对当前股票的日 K 求值一段安全公式，并与收盘价叠加显示。
 *
 * 支持变量赋值、多语句/多输出、常用指标函数与绘图函数（绘图只取条件序列）；
 * 不执行任意代码，未知函数/变量直接报错。
 */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import type { KLineBar } from '@shared/types'
import { fixed, signedPct } from '@shared/format'
import {
  backtestFormula,
  backtestPortfolio,
  evaluateFormula,
  type FormulaBacktest,
  type FormulaPortfolioBacktest,
  type FormulaResult
} from '@shared/formula'
import {
  activeItems,
  appState,
  removeFormula,
  saveFormula,
  updateFormula,
  updateSettings
} from '../../stores/app'
import { api, errorMessage } from '../../lib/client'
import { IconClose } from '../atoms/Icons'

interface FormulaPanelProps {
  code: string
  name: string
  onClose: () => void
  onSelect: (code: string) => void
}

const EXAMPLES = [
  'MA(CLOSE,5)',
  'MA(CLOSE,20)',
  'EMA(CLOSE,12)-EMA(CLOSE,26)',
  '(HIGH+LOW)/2',
  'CROSS(CLOSE,MA(CLOSE,20))',
  'A:=MA(C,5); B:=MA(C,20); A:A,COLORRED; B:B,COLORBLUE;'
]

const WIDTH = 900
const HEIGHT = 300
const PAD = 18
const LINE_COLORS = ['#3e63dd', '#e5484d', '#30a46c', '#e8b931', '#d6409f']

function linePath(values: number[], min: number, max: number): string {
  const span = max - min || 1
  let path = ''
  let pen = false
  values.forEach((value, index) => {
    const x = PAD + (index / Math.max(1, values.length - 1)) * (WIDTH - PAD * 2)
    const y = HEIGHT - PAD - ((value - min) / span) * (HEIGHT - PAD * 2)
    if (!Number.isFinite(value)) {
      pen = false
      return
    }
    path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `
    pen = true
  })
  return path.trim()
}

export function FormulaPanel(props: FormulaPanelProps): JSX.Element {
  const [bars, setBars] = createSignal<KLineBar[]>([])
  const [expression, setExpression] = createSignal('MA(CLOSE,20)')
  const [formulaName, setFormulaName] = createSignal('')
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [result, setResult] = createSignal<FormulaResult | null>(null)
  const [backtest, setBacktest] = createSignal<FormulaBacktest | null>(null)
  const [portfolio, setPortfolio] = createSignal<FormulaPortfolioBacktest | null>(null)
  const [portfolioLoading, setPortfolioLoading] = createSignal(false)
  const [portfolioError, setPortfolioError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [scanning, setScanning] = createSignal(false)
  const [scanResults, setScanResults] = createSignal<
    Array<{ code: string; name: string; latest: number }>
  >([])
  const [scanError, setScanError] = createSignal<string | null>(null)
  const [scanned, setScanned] = createSignal(false)
  let requestId = 0

  const calculate = (data: KLineBar[]): void => {
    try {
      const next = evaluateFormula(expression(), data)
      setResult(next)
      setBacktest(backtestFormula(next, data))
      setError(null)
    } catch (cause) {
      setResult(null)
      setBacktest(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const run = (): void => {
    calculate(bars())
  }

  const portfolioCurve = createMemo(() => {
    const curve = portfolio()?.curve ?? []
    if (curve.length < 2) return ''
    return linePath(curve, Math.min(...curve), Math.max(...curve))
  })

  const runPortfolio = async (): Promise<void> => {
    if (portfolioLoading()) return
    setPortfolioLoading(true)
    setPortfolioError(null)
    setPortfolio(null)
    try {
      const items = activeItems().slice(0, 20)
      if (items.length === 0) throw new Error('自选池为空')
      const series: Array<{ bars: KLineBar[]; result: FormulaResult }> = []
      for (const item of items) {
        const data = await api.trend.kline({ code: item.code, period: 'day', count: 120 })
        series.push({ bars: data.bars, result: evaluateFormula(expression(), data.bars) })
      }
      setPortfolio(backtestPortfolio(series))
    } catch (cause) {
      setPortfolioError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPortfolioLoading(false)
    }
  }

  const applyMain = (): void => {
    try {
      evaluateFormula(expression(), bars())
      updateSettings({ mainFormula: expression() })
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const save = (): void => {
    if (!expression().trim()) return
    if (editingId()) updateFormula(editingId()!, formulaName(), expression())
    else saveFormula(formulaName(), expression())
    setFormulaName('')
    setEditingId(null)
  }

  const scanWatchlist = async (): Promise<void> => {
    if (scanning()) return
    setScanning(true)
    setScanError(null)
    setScanned(false)
    const matches: Array<{ code: string; name: string; latest: number }> = []
    try {
      for (const item of activeItems().slice(0, 20)) {
        try {
          const series = await api.trend.kline({ code: item.code, period: 'day', count: 120 })
          const evaluated = evaluateFormula(expression(), series.bars)
          if (evaluated.latest !== null && evaluated.latest > 0) {
            matches.push({ code: item.code, name: item.name, latest: evaluated.latest })
          }
        } catch {
          // 单只失败不影响其余自选
        }
      }
      setScanResults(matches)
      setScanned(true)
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setScanning(false)
    }
  }

  const load = async (): Promise<void> => {
    const current = ++requestId
    setLoading(true)
    setError(null)
    try {
      const series = await api.trend.kline({ code: props.code, period: 'day', count: 320 })
      if (current !== requestId) return
      setBars(series.bars)
      calculate(series.bars)
    } catch (cause) {
      if (current === requestId) setError(errorMessage(cause))
    } finally {
      if (current === requestId) setLoading(false)
    }
  }

  createEffect(() => {
    if (!props.code) return
    void load()
  })

  const chart = createMemo(() => {
    const data = bars()
    const formula = result()
    if (data.length === 0) return { close: '', lines: [] }
    const outputs =
      formula?.outputs && formula.outputs.length > 0
        ? formula.outputs
        : formula
          ? [{ name: '公式', values: formula.values }]
          : []
    const all = [...data.map((bar) => bar.close), ...outputs.flatMap((line) => line.values)].filter(
      (value) => Number.isFinite(value)
    )
    if (all.length === 0) return { close: '', lines: [] }
    const min = Math.min(...all)
    const max = Math.max(...all)
    return {
      close: linePath(
        data.map((bar) => bar.close),
        min,
        max
      ),
      lines: outputs
        .map((line, index) => ({
          name: line.name,
          color: line.color ?? LINE_COLORS[index % LINE_COLORS.length],
          path: linePath(line.values, min, max)
        }))
        .filter((line) => line.path.length > 0)
    }
  })

  const latestBar = createMemo(() => bars()[bars().length - 1])
  const latestChange = createMemo(() => {
    const bars_ = bars()
    const last = bars_[bars_.length - 1]
    const previous = bars_[bars_.length - 2]
    if (!last || !previous || previous.close === 0) return 0
    return ((last.close - previous.close) / previous.close) * 100
  })

  return (
    <div class="formula-backdrop" onClick={() => props.onClose()}>
      <section
        class="formula-panel"
        role="dialog"
        aria-modal="true"
        aria-label="公式预览"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="formula__head">
          <div>
            <div class="formula__eyebrow">安全公式 · 赋值 / 多输出 / 指标函数</div>
            <h2 class="formula__title">
              {props.name} <code>{props.code.toUpperCase()}</code>
            </h2>
          </div>
          <button class="btn btn--icon btn--bare" title="关闭公式" onClick={() => props.onClose()}>
            <IconClose size={16} />
          </button>
        </header>

        <div class="formula__form">
          <input
            class="formula__input"
            value={expression()}
            aria-label="指标公式"
            placeholder="例如 MA(CLOSE,20)"
            onInput={(event) => setExpression(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') run()
            }}
          />
          <button class="btn btn--primary formula__run" disabled={loading()} onClick={run}>
            计算
          </button>
        </div>

        <div class="formula__examples">
          <For each={EXAMPLES}>
            {(example) => (
              <button
                class="formula__example"
                onClick={() => {
                  setExpression(example)
                  run()
                }}
              >
                {example}
              </button>
            )}
          </For>
        </div>

        <div class="formula__savebar">
          <input
            class="formula__name"
            placeholder={editingId() ? '更新名称…' : '保存为…（留空用表达式）'}
            value={formulaName()}
            onInput={(event) => setFormulaName(event.currentTarget.value)}
          />
          <button
            class="btn formula__scan"
            disabled={scanning() || loading()}
            onClick={() => void scanWatchlist()}
          >
            {scanning() ? '筛选中…' : '筛选自选'}
          </button>
          <button
            class="btn formula__portfolio-run"
            disabled={portfolioLoading()}
            onClick={() => void runPortfolio()}
          >
            {portfolioLoading() ? '组合回测…' : '自选组合回测'}
          </button>
          <button class="btn formula__save" onClick={save}>
            {editingId() ? '更新公式' : '保存公式'}
          </button>
          <button
            class="btn formula__apply-main"
            title="归一化叠加到主图，仅看形态"
            disabled={loading() || bars().length === 0}
            onClick={applyMain}
          >
            应用到主图
          </button>
        </div>

        <Show when={scanError()}>{(message) => <div class="formula__error">{message()}</div>}</Show>
        <Show when={scanned()}>
          <div class="formula__matches">
            <span>自选池匹配 {scanResults().length} 只</span>
            <For each={scanResults()}>
              {(match) => (
                <button
                  class="formula__match"
                  onClick={() => {
                    props.onSelect(match.code)
                    props.onClose()
                  }}
                >
                  {match.name} <code>{match.code.toUpperCase()}</code> {fixed(match.latest)}
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={appState.formulas.length > 0}>
          <div class="formula__saved">
            <For each={appState.formulas}>
              {(item) => (
                <div class="formula__saved-item">
                  <button
                    class="formula__saved-apply"
                    title="载入表达式并进入编辑"
                    onClick={() => {
                      setExpression(item.expression)
                      setFormulaName(item.name)
                      setEditingId(item.id)
                      run()
                    }}
                  >
                    <span>{item.name}</span>
                    <code>{item.expression}</code>
                  </button>
                  <button
                    class="formula__saved-delete"
                    title="删除公式"
                    onClick={() => {
                      if (editingId() === item.id) {
                        setEditingId(null)
                        setFormulaName('')
                      }
                      removeFormula(item.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={error()}>
          {(message) => (
            <div class="formula__error" role="alert">
              {message()}
            </div>
          )}
        </Show>

        <div class="formula__chart">
          <Show
            when={!loading() && bars().length > 0}
            fallback={<div class="formula__loading">{loading() ? '加载日 K…' : '没有数据'}</div>}
          >
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="公式曲线">
              <line
                x1={PAD}
                y1={HEIGHT - PAD}
                x2={WIDTH - PAD}
                y2={HEIGHT - PAD}
                class="formula__axis"
              />
              <path d={chart().close} class="formula__close" />
              <For each={chart().lines}>
                {(line) => (
                  <path
                    d={line.path}
                    class="formula__line"
                    style={{ stroke: line.color }}
                    fill="none"
                    stroke-width="2"
                  />
                )}
              </For>
            </svg>
            <div class="formula__legend">
              <span class="formula__legend-close">收盘价</span>
              <For each={chart().lines}>
                {(line) => (
                  <span class="formula__legend-line" style={{ color: line.color }}>
                    {line.name}
                  </span>
                )}
              </For>
              <Show when={latestBar()}>
                {(last) => (
                  <span class="formula__latest">
                    {last().date} · 收盘 {fixed(last().close)} ·{' '}
                    <span
                      classList={{
                        'tone-up': latestChange() > 0,
                        'tone-down': latestChange() < 0
                      }}
                    >
                      {signedPct(latestChange())}
                    </span>
                    <Show when={result()}>
                      {(data) => (
                        <Show when={data().latest !== null}> · 公式 {fixed(data().latest!)}</Show>
                      )}
                    </Show>
                  </span>
                )}
              </Show>
            </div>
          </Show>
        </div>

        <Show when={backtest()}>
          {(data) => (
            <div class="formula__backtest">
              <span class="formula__backtest-title">单标的回测</span>
              <span>
                策略{' '}
                <span
                  classList={{
                    'tone-up': data().strategyReturn > 0,
                    'tone-down': data().strategyReturn < 0
                  }}
                >
                  {signedPct(data().strategyReturn)}
                </span>
              </span>
              <span>买入持有 {signedPct(data().holdReturn)}</span>
              <span>年化 {signedPct(data().annualizedReturn)}</span>
              <span>交易 {data().trades} 次</span>
              <span>胜率 {fixed(data().winRate)}%</span>
              <span>最大回撤 {fixed(data().maxDrawdown)}%</span>
            </div>
          )}
        </Show>

        <Show when={portfolio()}>
          {(data) => (
            <div class="formula__backtest formula__portfolio">
              <span class="formula__backtest-title">自选等权组合</span>
              <span>组合 {signedPct(data().strategyReturn)}</span>
              <span>平均持有 {signedPct(data().holdReturn)}</span>
              <span>最大回撤 {fixed(data().maxDrawdown)}%</span>
              <span>
                {data().stocks} 只 · {data().days} 天 · {data().trades} 次调仓
              </span>
              <svg
                class="formula__portfolio-curve"
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                preserveAspectRatio="none"
              >
                <path d={portfolioCurve()} fill="none" stroke="var(--accent)" stroke-width="2" />
              </svg>
            </div>
          )}
        </Show>
        <Show when={portfolioError()}>
          <div class="formula__error" role="alert">
            {portfolioError()}
          </div>
        </Show>

        <div class="formula__meta">
          <Show when={result()}>
            {(data) => (
              <>
                <span>最新 {data().latest === null ? '—' : fixed(data().latest!)}</span>
                <span>最小 {data().min === null ? '—' : fixed(data().min!)}</span>
                <span>最大 {data().max === null ? '—' : fixed(data().max!)}</span>
                <span>{data().outputs?.length ?? 1} 条输出</span>
                <span>{bars().length} 根日 K</span>
              </>
            )}
          </Show>
        </div>

        <footer class="formula__foot">
          <span>支持赋值/多输出与 MA/EMA/SMA/DMA/REF/HHV/LLV/FILTER/CROSS 等函数</span>
          <span>回测按上一根信号成交 · 手续费 0.03%</span>
        </footer>
      </section>
    </div>
  )
}
