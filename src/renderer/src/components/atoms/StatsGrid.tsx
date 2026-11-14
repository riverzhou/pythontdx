/**
 * 关键指标面板：估值、市值、交易活跃度。
 *
 * 行情快照能提供的字段直接用；市盈率/分位/PS/PEG 从 7615 valuation 补，
 * 交易类指标（换手/量比/振幅/均价/涨跌停）已移到主图上方行情栏；
 * 此面板只保留估值、财务和市值。接口暂缺的字段明确显示「—」。
 */
import { createEffect, createMemo, createSignal, For, type JSX } from 'solid-js'
import type { Quote } from '@shared/types'
import { compactCap, fixed } from '@shared/format'
import { api } from '../../lib/client'

export interface StatsGridProps {
  quote: Quote
}

interface StatRow {
  label: string
  value: string
  hint?: string
}

interface ExtraStats {
  peTtm?: number
  pePct?: number
  pb?: number
  pbPct?: number
  ps?: number
  peg?: number
  peDynamic?: number
  peStatic?: number
  eps?: number
  roe?: number
  grossMargin?: number
  profitYoy?: number
  revenueYoy?: number
  reportDate?: string
  disclosureDate?: string
}

export function StatsGrid(props: StatsGridProps): JSX.Element {
  const [extra, setExtra] = createSignal<ExtraStats>({})
  const code = createMemo(() => props.quote.code)

  createEffect(() => {
    const currentCode = code()
    setExtra({})
    void (async () => {
      const next: ExtraStats = {}
      try {
        const [valuation, finance] = await Promise.all([
          api.f10.valuation(currentCode).catch(() => null),
          api.f10.finance(currentCode).catch(() => null)
        ])
        if (valuation && valuation.rows.length > 0) {
          const row = valuation.rows[0]
          const value = (label: string): number | undefined => {
            const index = valuation.columns.indexOf(label)
            const parsed = index >= 0 ? Number(row[index]) : Number.NaN
            return Number.isFinite(parsed) ? parsed : undefined
          }
          next.peTtm = value('PE(TTM)')
          next.pePct = value('PE 分位')
          next.pb = value('PB(MRQ)')
          next.pbPct = value('PB 分位')
          next.ps = value('PS(TTM)')
          next.peg = value('PEG')
        }
        if (finance && finance.rows.length > 0) {
          const row = finance.rows[0]
          const field = (label: string): number | undefined => {
            const index = finance.columns.indexOf(label)
            const parsed = index >= 0 ? Number(row[index]) : Number.NaN
            return Number.isFinite(parsed) ? parsed : undefined
          }
          const report = String(row[0] ?? '')
          const month = Number(report.slice(5, 7))
          const annualFactor = month === 3 ? 4 : month === 6 ? 2 : month === 9 ? 4 / 3 : 1
          const annualRow = finance.rows.find((item) => String(item[0]).endsWith('12-31'))
          const annualEps = annualRow
            ? Number(annualRow[finance.columns.indexOf('每股收益')])
            : Number.NaN
          const eps = field('每股收益')
          const price = props.quote.price
          if (eps !== undefined && eps > 0) {
            next.peDynamic = price / (eps * annualFactor)
          }
          if (Number.isFinite(annualEps) && annualEps > 0) {
            next.peStatic = price / annualEps
          }
          next.eps = eps
          next.roe = field('净资产收益率')
          next.grossMargin = field('毛利率')
          next.profitYoy = field('净利润同比')
          next.revenueYoy = field('营收同比')
          next.reportDate = report
          const textField = (label: string): string | undefined => {
            const index = finance.columns.indexOf(label)
            if (index < 0) return undefined
            const value = String(row[index] ?? '').trim()
            return value || undefined
          }
          next.disclosureDate =
            textField('预约披露日期') ?? textField('预计披露日期') ?? textField('披露日期')
        }
      } catch {
        // 指标面板是辅助信息，单个接口失败不阻断行情主链路。
      }
      setExtra(next)
    })()
  })

  const rows = (): StatRow[] => {
    const { quote } = props
    return [
      {
        label: '市盈率 TTM',
        value: positiveFixed(quote.peTtm ?? extra().peTtm),
        hint: '最近四个季度滚动净利润口径'
      },
      {
        label: '市盈率 动态',
        value: positiveFixed(extra().peDynamic),
        hint: '现价 / 最新报告期每股收益年化'
      },
      {
        label: '市盈率 静态',
        value: positiveFixed(extra().peStatic),
        hint: '现价 / 最近年度每股收益'
      },
      {
        label: 'PE 分位',
        value: pct(extra().pePct),
        hint: '7615 估值分位'
      },
      { label: '每股收益', value: fixed(extra().eps), hint: '最新报告期' },
      { label: '净资产收益率', value: pct(extra().roe), hint: '最新报告期' },
      { label: '毛利率', value: pct(extra().grossMargin), hint: '最新报告期' },
      { label: '净利润同比', value: pct(extra().profitYoy), hint: '最新报告期' },
      { label: '营收同比', value: pct(extra().revenueYoy), hint: '最新报告期' },
      {
        label: '市净率',
        value: fixed(quote.pb ?? extra().pb),
        hint: '行情快照或 7615 valuation'
      },
      { label: 'PB 分位', value: pct(extra().pbPct), hint: '7615 估值分位' },
      { label: 'PS(TTM)', value: fixed(extra().ps), hint: '7615 valuation' },
      { label: 'PEG', value: fixed(extra().peg), hint: '7615 valuation' },
      { label: '总市值', value: compactCap(quote.totalCap), hint: '现价 × 总股本' },
      { label: '流通市值', value: compactCap(quote.floatCap), hint: '现价 × 流通股本' },
      { label: '财报期', value: extra().reportDate || '—', hint: '7615 财务指标最新报告期' },
      {
        label: '预计披露',
        value: extra().disclosureDate || '—',
        hint: '预约披露日期；7615 未提供时留空，不做猜测'
      }
    ]
  }

  return (
    <div class="stats">
      <For each={rows()}>
        {(row) => (
          <div class="stats__item" title={row.hint}>
            <span class="stats__label">{row.label}</span>
            <span class="stats__value num">{row.value}</span>
          </div>
        )}
      </For>
    </div>
  )
}

function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(2)}%`
}

function positiveFixed(value: number | undefined): string {
  return value === undefined || value <= 0 ? '—' : fixed(value)
}
