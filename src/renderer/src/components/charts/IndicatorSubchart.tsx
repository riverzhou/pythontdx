/**
 * K 线副图：MACD / KDJ / RSI。
 *
 * 与指标面板共用 shared/indicators 的纯函数；只画最后 160 根，避免副图挤成噪声。
 */
import { createMemo, For, Show, type JSX } from 'solid-js'
import type { IndicatorParams, KLineBar } from '@shared/types'
import { fixed } from '@shared/format'
import {
  bbi,
  bias,
  cci,
  cr,
  dmi,
  dma as dmaIndicator,
  kdj,
  macd,
  obv,
  psy,
  roc,
  rsi,
  trix as trixIndicator,
  sar,
  vr,
  wr
} from '@shared/indicators'

export type SubIndicator =
  | 'macd'
  | 'kdj'
  | 'rsi'
  | 'wr'
  | 'cci'
  | 'bias'
  | 'dmi'
  | 'obv'
  | 'roc'
  | 'psy'
  | 'vr'
  | 'cr'
  | 'bbi'
  | 'dma'
  | 'trix'
  | 'sar'

const W = 900
const H = 120
const PAD_X = 10
const PAD_RIGHT = 64
const PAD_Y = 12
const VISIBLE = 160

const COLORS = {
  dif: '#5b8cff',
  dea: '#f0b429',
  k: '#5b8cff',
  d: '#f0b429',
  j: '#c084fc',
  rsi: '#5b8cff',
  wr: '#22d3ee',
  cci: '#f59e0b',
  roc: '#5b8cff',
  psy: '#22d3ee',
  vr: '#c084fc',
  cr: '#f0b429',
  bbi: '#22d3ee',
  dma: '#5b8cff',
  ama: '#f0b429',
  trix: '#22d3ee',
  trixSignal: '#c084fc',
  sar: '#22d3ee',
  bias6: '#5b8cff',
  bias12: '#f0b429',
  bias24: '#c084fc',
  plusDi: '#5b8cff',
  minusDi: '#f0b429',
  adx: '#22d3ee'
}

function buildPath(values: number[], min: number, max: number, left: number, plot: number): string {
  const span = max - min || 1
  return values
    .map((value, index) => {
      if (!Number.isFinite(value)) return ''
      const x = left + (index + 0.5) * (plot / Math.max(1, values.length))
      const y = H - PAD_Y - ((value - min) / span) * (H - PAD_Y * 2)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .filter(Boolean)
    .join(' ')
}

export function IndicatorSubchart(props: {
  bars: KLineBar[]
  kind: SubIndicator
  params?: IndicatorParams
  cursorIndex?: number | null
  windowStart?: number
  windowCount?: number
  renderWidth?: number
}): JSX.Element {
  /** 主图不是固定 900px；把主图的左右留白和绘图区按像素比例映射进副图 viewBox。 */
  const layout = createMemo(() => {
    const width = props.renderWidth && props.renderWidth > 0 ? props.renderWidth : W
    const scale = W / width
    return {
      left: PAD_X * scale,
      plot: (width - PAD_X - PAD_RIGHT) * scale
    }
  })
  const path = (values: number[], min: number, max: number): string =>
    buildPath(values, min, max, layout().left, layout().plot)
  const window = createMemo(() => {
    const count = Math.min(
      props.bars.length,
      Math.max(1, props.windowCount && props.windowCount > 0 ? props.windowCount : VISIBLE)
    )
    const start = Math.min(
      Math.max(0, props.bars.length - count),
      Math.max(0, props.windowStart ?? props.bars.length - count)
    )
    return { start, count }
  })
  const visible = createMemo(() => {
    const current = window()
    return props.bars.slice(current.start, current.start + current.count)
  })
  const cursorX = createMemo(() => {
    const index = props.cursorIndex
    const data = visible()
    if (index === undefined || index === null || data.length < 2) return null
    const local = index - window().start
    if (local < 0 || local >= data.length) return null
    return layout().left + (local + 0.5) * (layout().plot / data.length)
  })

  const chart = createMemo(() => {
    const data = visible()
    if (data.length < 2) return null
    const all = props.bars
    const slice = (values: number[]): number[] => {
      const start = window().start
      return values.slice(start, start + window().count)
    }
    if (props.kind === 'macd') {
      const values = macd(
        all,
        props.params?.macdFast ?? 12,
        props.params?.macdSlow ?? 26,
        props.params?.macdSignal ?? 9
      )
      const dif = slice(values.dif)
      const dea = slice(values.dea)
      const hist = slice(values.hist)
      const numbers = [...dif, ...dea, ...hist].filter(Number.isFinite)
      const min = Math.min(0, ...numbers)
      const max = Math.max(0, ...numbers)
      const zeroY = H - PAD_Y - ((0 - min) / (max - min || 1)) * (H - PAD_Y * 2)
      const slot = layout().plot / Math.max(1, hist.length)
      const barWidth = Math.max(1, slot * 0.6)
      return {
        lines: [
          { label: 'DIF', color: COLORS.dif, d: path(dif, min, max) },
          { label: 'DEA', color: COLORS.dea, d: path(dea, min, max) }
        ],
        hist: hist.map((value, index) => ({
          x: layout().left + (index + 0.5) * slot - barWidth / 2,
          w: barWidth,
          y: value >= 0 ? H - PAD_Y - ((value - min) / (max - min || 1)) * (H - PAD_Y * 2) : zeroY,
          h: Math.abs((value / (max - min || 1)) * (H - PAD_Y * 2)),
          up: value >= 0
        })),
        latest: `DIF ${fixed(dif.at(-1) ?? 0)} · DEA ${fixed(dea.at(-1) ?? 0)} · MACD ${fixed(hist.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'kdj') {
      const values = kdj(
        all,
        props.params?.kdjPeriod ?? 9,
        props.params?.kdjM1 ?? 3,
        props.params?.kdjM2 ?? 3
      )
      const k = slice(values.k)
      const d = slice(values.d)
      const j = slice(values.j)
      const numbers = [...k, ...d, ...j]
      const min = Math.min(...numbers)
      const max = Math.max(...numbers)
      return {
        lines: [
          { label: 'K', color: COLORS.k, d: path(k, min, max) },
          { label: 'D', color: COLORS.d, d: path(d, min, max) },
          { label: 'J', color: COLORS.j, d: path(j, min, max) }
        ],
        hist: [],
        latest: `K ${fixed(k.at(-1) ?? 0)} · D ${fixed(d.at(-1) ?? 0)} · J ${fixed(j.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'wr') {
      const values = slice(wr(all, props.params?.wrPeriod ?? 14))
      return {
        lines: [{ label: 'WR14', color: COLORS.wr, d: path(values, 0, 100) }],
        hist: [],
        latest: `WR14 ${fixed(values.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'cci') {
      const values = slice(cci(all, props.params?.cciPeriod ?? 14))
      const numbers = values.filter(Number.isFinite)
      const min = Math.min(...numbers)
      const max = Math.max(...numbers)
      return {
        lines: [{ label: 'CCI14', color: COLORS.cci, d: path(values, min, max) }],
        hist: [],
        latest: `CCI14 ${fixed(values.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'bias') {
      const shortPeriod = props.params?.biasShort ?? 6
      const midPeriod = props.params?.biasMid ?? 12
      const longPeriod = props.params?.biasLong ?? 24
      const b6 = slice(bias(all, shortPeriod))
      const b12 = slice(bias(all, midPeriod))
      const b24 = slice(bias(all, longPeriod))
      const numbers = [...b6, ...b12, ...b24].filter(Number.isFinite)
      const min = Math.min(...numbers)
      const max = Math.max(...numbers)
      return {
        lines: [
          { label: `BIAS${shortPeriod}`, color: COLORS.bias6, d: path(b6, min, max) },
          { label: `BIAS${midPeriod}`, color: COLORS.bias12, d: path(b12, min, max) },
          { label: `BIAS${longPeriod}`, color: COLORS.bias24, d: path(b24, min, max) }
        ],
        hist: [],
        latest: `${shortPeriod} ${fixed(b6.at(-1) ?? 0)} · ${midPeriod} ${fixed(b12.at(-1) ?? 0)} · ${longPeriod} ${fixed(b24.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'dmi') {
      const values = dmi(all, props.params?.dmiPeriod ?? 14)
      const pdi = slice(values.plus)
      const mdi = slice(values.minus)
      const adx = slice(values.adx)
      const numbers = [...pdi, ...mdi, ...adx].filter(Number.isFinite)
      const min = Math.min(...numbers)
      const max = Math.max(...numbers)
      return {
        lines: [
          { label: '+DI', color: COLORS.plusDi, d: path(pdi, min, max) },
          { label: '-DI', color: COLORS.minusDi, d: path(mdi, min, max) },
          { label: 'ADX', color: COLORS.adx, d: path(adx, min, max) }
        ],
        hist: [],
        latest: `+DI ${fixed(pdi.at(-1) ?? 0)} · -DI ${fixed(mdi.at(-1) ?? 0)} · ADX ${fixed(adx.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'obv') {
      const values = slice(obv(all))
      const min = Math.min(...values)
      const max = Math.max(...values)
      return {
        lines: [{ label: 'OBV', color: COLORS.adx, d: path(values, min, max) }],
        hist: [],
        latest: `OBV ${fixed(values.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'roc') {
      const period = props.params?.rocPeriod ?? 12
      const values = slice(roc(all, period))
      const min = Math.min(...values.filter(Number.isFinite))
      const max = Math.max(...values.filter(Number.isFinite))
      return {
        lines: [{ label: `ROC${period}`, color: COLORS.roc, d: path(values, min, max) }],
        hist: [],
        latest: `ROC${period} ${fixed(values.at(-1) ?? 0)}%`
      }
    }
    if (props.kind === 'psy') {
      const period = props.params?.psyPeriod ?? 12
      const values = slice(psy(all, period))
      return {
        lines: [{ label: `PSY${period}`, color: COLORS.psy, d: path(values, 0, 100) }],
        hist: [],
        latest: `PSY${period} ${fixed(values.at(-1) ?? 0)}%`
      }
    }
    if (props.kind === 'vr') {
      const period = props.params?.vrPeriod ?? 26
      const values = slice(vr(all, period))
      const finite = values.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 100
      return {
        lines: [{ label: `VR${period}`, color: COLORS.vr, d: path(values, min, max) }],
        hist: [],
        latest: `VR${period} ${fixed(values.at(-1) ?? 0)}%`
      }
    }
    if (props.kind === 'cr') {
      const period = props.params?.crPeriod ?? 26
      const values = slice(cr(all, period))
      const finite = values.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 100
      return {
        lines: [{ label: `CR${period}`, color: COLORS.cr, d: path(values, min, max) }],
        hist: [],
        latest: `CR${period} ${fixed(values.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'bbi') {
      const values = slice(bbi(all))
      const finite = values.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [{ label: 'BBI', color: COLORS.bbi, d: path(values, min, max) }],
        hist: [],
        latest: `BBI ${fixed(values.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'dma') {
      const result = dmaIndicator(
        all,
        props.params?.dmaShort ?? 10,
        props.params?.dmaLong ?? 50,
        props.params?.dmaSignal ?? 10
      )
      const dif = slice(result.dma)
      const ama = slice(result.ama)
      const finite = [...dif, ...ama].filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [
          { label: 'DMA', color: COLORS.dma, d: path(dif, min, max) },
          { label: 'AMA', color: COLORS.ama, d: path(ama, min, max) }
        ],
        hist: [],
        latest: `DMA ${fixed(dif.at(-1) ?? 0)} · AMA ${fixed(ama.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'trix') {
      const period = props.params?.trixPeriod ?? 12
      const result = trixIndicator(all, period, props.params?.trixSignal ?? 9)
      const line = slice(result.trix)
      const signalLine = slice(result.signal)
      const finite = [...line, ...signalLine].filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [
          { label: `TRIX${period}`, color: COLORS.trix, d: path(line, min, max) },
          { label: 'MATRIX', color: COLORS.trixSignal, d: path(signalLine, min, max) }
        ],
        hist: [],
        latest: `TRIX ${fixed(line.at(-1) ?? 0)} · MATRIX ${fixed(signalLine.at(-1) ?? 0)}`
      }
    }
    if (props.kind === 'sar') {
      const values = slice(sar(all, props.params?.sarStep ?? 0.02, props.params?.sarMax ?? 0.2))
      const finite = values.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [{ label: 'SAR', color: COLORS.sar, d: path(values, min, max) }],
        hist: [],
        latest: `SAR ${fixed(values.at(-1) ?? 0)}`
      }
    }
    const values = slice(rsi(all, props.params?.rsiPeriod ?? 14))
    return {
      lines: [{ label: 'RSI14', color: COLORS.rsi, d: path(values, 0, 100) }],
      hist: [],
      latest: `RSI14 ${fixed(values.at(-1) ?? 0)}`
    }
  })

  return (
    <div class="indicator-subchart">
      <div class="indicator-subchart__head">
        <span>{props.kind.toUpperCase()}</span>
        <span class="num">{chart()?.latest ?? '—'}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="indicator-subchart__svg">
        <line
          x1={layout().left}
          y1={H - PAD_Y}
          x2={layout().left + layout().plot}
          y2={H - PAD_Y}
          class="indicator-subchart__axis"
        />
        <Show when={cursorX() !== null}>
          <line x1={cursorX()!} y1={0} x2={cursorX()!} y2={H} class="indicator-subchart__cursor" />
        </Show>
        <For each={chart()?.hist ?? []}>
          {(bar) => (
            <rect
              x={bar.x}
              y={bar.y}
              width={bar.w ?? 2}
              height={Math.max(1, bar.h)}
              class={bar.up ? 'indicator__hist-up' : 'indicator__hist-down'}
            />
          )}
        </For>
        <For each={chart()?.lines ?? []}>
          {(line) => <path d={line.d} fill="none" stroke={line.color} stroke-width="1.2" />}
        </For>
      </svg>
    </div>
  )
}
