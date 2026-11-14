/**
 * 技术指标面板：MACD / KDJ / RSI / WR / CCI / BIAS / DMI / OBV / BOLL。
 *
 * 纯本地计算，不请求额外数据；图表只取最近 160 根日 K 显示。
 */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import type { KLineBar } from '@shared/types'
import { fixed } from '@shared/format'
import {
  bbi,
  bias,
  boll,
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
import { api, errorMessage } from '../../lib/client'
import { appState, updateSettings } from '../../stores/app'
import { IconClose } from '../atoms/Icons'

type Tab =
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
  | 'boll'

const W = 900
const H = 300
const PAD = 20
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
  adx: '#22d3ee',
  close: '#d7dce7',
  upper: '#f0b429',
  middle: '#5b8cff',
  lower: '#c084fc'
}

function linePath(values: number[], min: number, max: number): string {
  const span = max - min || 1
  return values
    .map((value, index) => {
      if (!Number.isFinite(value)) return ''
      const x = PAD + (index / Math.max(1, values.length - 1)) * (W - PAD * 2)
      const y = H - PAD - ((value - min) / span) * (H - PAD * 2)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .filter(Boolean)
    .join(' ')
    .replace(/([ML])\s*$/, '')
}

export function IndicatorPanel(props: {
  code: string
  name: string
  onClose: () => void
}): JSX.Element {
  const [tab, setTab] = createSignal<Tab>('macd')
  const [bars, setBars] = createSignal<KLineBar[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [macdFast, setMacdFast] = createSignal('12')
  const [macdSlow, setMacdSlow] = createSignal('26')
  const [macdSignal, setMacdSignal] = createSignal('9')
  const [kdjPeriod, setKdjPeriod] = createSignal('9')
  const [kdjM1, setKdjM1] = createSignal('3')
  const [kdjM2, setKdjM2] = createSignal('3')
  const [rsiPeriod, setRsiPeriod] = createSignal('14')
  const [wrPeriod, setWrPeriod] = createSignal('14')
  const [cciPeriod, setCciPeriod] = createSignal('14')
  const [bollPeriod, setBollPeriod] = createSignal('20')
  const [bollK, setBollK] = createSignal('2')
  const [biasShort, setBiasShort] = createSignal('6')
  const [biasMid, setBiasMid] = createSignal('12')
  const [biasLong, setBiasLong] = createSignal('24')
  const [dmiPeriod, setDmiPeriod] = createSignal('14')
  const [rocPeriod, setRocPeriod] = createSignal('12')
  const [psyPeriod, setPsyPeriod] = createSignal('12')
  const [vrPeriod, setVrPeriod] = createSignal('26')
  const [crPeriod, setCrPeriod] = createSignal('26')
  const [dmaShort, setDmaShort] = createSignal('10')
  const [dmaLong, setDmaLong] = createSignal('50')
  const [dmaSignal, setDmaSignal] = createSignal('10')
  const [trixPeriod, setTrixPeriod] = createSignal('12')
  const [trixSignal, setTrixSignal] = createSignal('9')
  const [sarStep, setSarStep] = createSignal('0.02')
  const [sarMax, setSarMax] = createSignal('0.2')

  const num = (value: () => string, fallback: number): number => {
    const parsed = Number(value())
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(200, Math.floor(parsed)) : fallback
  }

  const decimal = (value: () => string, fallback: number): number => {
    const parsed = Number(value())
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback
  }

  let paramsHydrated = false

  createEffect(() => {
    const saved = appState.settings.indicatorParams
    if (paramsHydrated || !saved) return
    paramsHydrated = true
    setMacdFast(String(saved.macdFast))
    setMacdSlow(String(saved.macdSlow))
    setMacdSignal(String(saved.macdSignal))
    setKdjPeriod(String(saved.kdjPeriod))
    setKdjM1(String(saved.kdjM1))
    setKdjM2(String(saved.kdjM2))
    setRsiPeriod(String(saved.rsiPeriod))
    setWrPeriod(String(saved.wrPeriod ?? 14))
    setCciPeriod(String(saved.cciPeriod ?? 14))
    setBollPeriod(String(saved.bollPeriod))
    setBollK(String(saved.bollK))
    setBiasShort(String(saved.biasShort ?? 6))
    setBiasMid(String(saved.biasMid ?? 12))
    setBiasLong(String(saved.biasLong ?? 24))
    setDmiPeriod(String(saved.dmiPeriod ?? 14))
    setRocPeriod(String(saved.rocPeriod ?? 12))
    setPsyPeriod(String(saved.psyPeriod ?? 12))
    setVrPeriod(String(saved.vrPeriod ?? 26))
    setCrPeriod(String(saved.crPeriod ?? 26))
    setDmaShort(String(saved.dmaShort ?? 10))
    setDmaLong(String(saved.dmaLong ?? 50))
    setDmaSignal(String(saved.dmaSignal ?? 10))
    setTrixPeriod(String(saved.trixPeriod ?? 12))
    setTrixSignal(String(saved.trixSignal ?? 9))
    setSarStep(String(saved.sarStep ?? 0.02))
    setSarMax(String(saved.sarMax ?? 0.2))
  })

  const persistParams = (): void => {
    paramsHydrated = true
    updateSettings({
      indicatorParams: {
        macdFast: num(macdFast, 12),
        macdSlow: num(macdSlow, 26),
        macdSignal: num(macdSignal, 9),
        kdjPeriod: num(kdjPeriod, 9),
        kdjM1: num(kdjM1, 3),
        kdjM2: num(kdjM2, 3),
        rsiPeriod: num(rsiPeriod, 14),
        wrPeriod: num(wrPeriod, 14),
        cciPeriod: num(cciPeriod, 14),
        bollPeriod: num(bollPeriod, 20),
        bollK: num(bollK, 2),
        biasShort: num(biasShort, 6),
        biasMid: num(biasMid, 12),
        biasLong: num(biasLong, 24),
        dmiPeriod: num(dmiPeriod, 14),
        rocPeriod: num(rocPeriod, 12),
        psyPeriod: num(psyPeriod, 12),
        vrPeriod: num(vrPeriod, 26),
        crPeriod: num(crPeriod, 26),
        dmaShort: num(dmaShort, 10),
        dmaLong: num(dmaLong, 50),
        dmaSignal: num(dmaSignal, 10),
        trixPeriod: num(trixPeriod, 12),
        trixSignal: num(trixSignal, 9),
        sarStep: decimal(sarStep, 0.02),
        sarMax: decimal(sarMax, 0.2)
      }
    })
  }
  let requestId = 0

  createEffect(() => {
    const current = ++requestId
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const series = await api.trend.kline({ code: props.code, period: 'day', count: 320 })
        if (current !== requestId) return
        setBars(series.bars)
      } catch (cause) {
        if (current === requestId) setError(errorMessage(cause))
      } finally {
        if (current === requestId) setLoading(false)
      }
    })()
  })

  const visible = createMemo(() => bars().slice(-VISIBLE))

  const chart = createMemo(() => {
    const data = visible()
    if (data.length < 2) return null
    const all = bars()
    const offset = Math.max(0, all.length - data.length)
    const slice = (values: number[]): number[] => values.slice(offset)
    if (tab() === 'macd') {
      const values = macd(all, num(macdFast, 12), num(macdSlow, 26), num(macdSignal, 9))
      const dif = slice(values.dif)
      const dea = slice(values.dea)
      const hist = slice(values.hist)
      const numbers = [...dif, ...dea, ...hist].filter(Number.isFinite)
      const min = Math.min(0, ...numbers)
      const max = Math.max(0, ...numbers)
      const zeroY = H - PAD - ((0 - min) / (max - min || 1)) * (H - PAD * 2)
      const barWidth = Math.max(1, (W - PAD * 2) / Math.max(1, hist.length) - 1)
      return {
        lines: [
          { label: 'DIF', color: COLORS.dif, path: linePath(dif, min, max) },
          { label: 'DEA', color: COLORS.dea, path: linePath(dea, min, max) }
        ],
        hist: hist.map((value, index) => ({
          x: PAD + (index / Math.max(1, hist.length - 1)) * (W - PAD * 2) - barWidth / 2,
          y: value >= 0 ? H - PAD - ((value - min) / (max - min || 1)) * (H - PAD * 2) : zeroY,
          height: Math.abs(((value - 0) / (max - min || 1)) * (H - PAD * 2)),
          up: value >= 0
        })),
        latest: [
          ['DIF', dif.at(-1)],
          ['DEA', dea.at(-1)],
          ['MACD', hist.at(-1)]
        ] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'kdj') {
      const values = kdj(all, num(kdjPeriod, 9), num(kdjM1, 3), num(kdjM2, 3))
      const k = slice(values.k)
      const d = slice(values.d)
      const j = slice(values.j)
      const numbers = [...k, ...d, ...j]
      const min = Math.min(...numbers)
      const max = Math.max(...numbers)
      return {
        lines: [
          { label: 'K', color: COLORS.k, path: linePath(k, min, max) },
          { label: 'D', color: COLORS.d, path: linePath(d, min, max) },
          { label: 'J', color: COLORS.j, path: linePath(j, min, max) }
        ],
        hist: [],
        latest: [
          ['K', k.at(-1)],
          ['D', d.at(-1)],
          ['J', j.at(-1)]
        ] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'rsi') {
      const values = rsi(all, num(rsiPeriod, 14))
      const line = slice(values)
      return {
        lines: [{ label: 'RSI14', color: COLORS.rsi, path: linePath(line, 0, 100) }],
        hist: [],
        latest: [['RSI14', line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'wr') {
      const values = wr(all, num(wrPeriod, 14))
      const line = slice(values)
      return {
        lines: [{ label: 'WR14', color: COLORS.wr, path: linePath(line, 0, 100) }],
        hist: [],
        latest: [['WR14', line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'cci') {
      const values = cci(all, num(cciPeriod, 14))
      const line = slice(values)
      const numbers = line.filter(Number.isFinite)
      const min = Math.min(...numbers)
      const max = Math.max(...numbers)
      return {
        lines: [{ label: 'CCI14', color: COLORS.cci, path: linePath(line, min, max) }],
        hist: [],
        latest: [['CCI14', line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'bias') {
      const shortPeriod = num(biasShort, 6)
      const midPeriod = num(biasMid, 12)
      const longPeriod = num(biasLong, 24)
      const b6 = slice(bias(all, shortPeriod))
      const b12 = slice(bias(all, midPeriod))
      const b24 = slice(bias(all, longPeriod))
      const numbers = [...b6, ...b12, ...b24].filter(Number.isFinite)
      const min = Math.min(...numbers)
      const max = Math.max(...numbers)
      return {
        lines: [
          { label: `BIAS${shortPeriod}`, color: COLORS.bias6, path: linePath(b6, min, max) },
          { label: `BIAS${midPeriod}`, color: COLORS.bias12, path: linePath(b12, min, max) },
          { label: `BIAS${longPeriod}`, color: COLORS.bias24, path: linePath(b24, min, max) }
        ],
        hist: [],
        latest: [
          [`BIAS${shortPeriod}`, b6.at(-1)],
          [`BIAS${midPeriod}`, b12.at(-1)],
          [`BIAS${longPeriod}`, b24.at(-1)]
        ] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'dmi') {
      const values = dmi(all, num(dmiPeriod, 14))
      const pdi = slice(values.plus)
      const mdi = slice(values.minus)
      const adx = slice(values.adx)
      const numbers = [...pdi, ...mdi, ...adx].filter(Number.isFinite)
      const min = Math.min(...numbers)
      const max = Math.max(...numbers)
      return {
        lines: [
          { label: '+DI', color: COLORS.plusDi, path: linePath(pdi, min, max) },
          { label: '-DI', color: COLORS.minusDi, path: linePath(mdi, min, max) },
          { label: 'ADX', color: COLORS.adx, path: linePath(adx, min, max) }
        ],
        hist: [],
        latest: [
          ['+DI', pdi.at(-1)],
          ['-DI', mdi.at(-1)],
          ['ADX', adx.at(-1)]
        ] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'obv') {
      const line = slice(obv(all))
      const min = Math.min(...line)
      const max = Math.max(...line)
      return {
        lines: [{ label: 'OBV', color: COLORS.adx, path: linePath(line, min, max) }],
        hist: [],
        latest: [['OBV', line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'roc') {
      const period = num(rocPeriod, 12)
      const line = slice(roc(all, period))
      const finite = line.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [{ label: `ROC${period}`, color: COLORS.roc, path: linePath(line, min, max) }],
        hist: [],
        latest: [[`ROC${period}`, line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'psy') {
      const period = num(psyPeriod, 12)
      const line = slice(psy(all, period))
      return {
        lines: [{ label: `PSY${period}`, color: COLORS.psy, path: linePath(line, 0, 100) }],
        hist: [],
        latest: [[`PSY${period}`, line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'vr') {
      const period = num(vrPeriod, 26)
      const line = slice(vr(all, period))
      const finite = line.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 100
      return {
        lines: [{ label: `VR${period}`, color: COLORS.vr, path: linePath(line, min, max) }],
        hist: [],
        latest: [[`VR${period}`, line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'cr') {
      const period = num(crPeriod, 26)
      const line = slice(cr(all, period))
      const finite = line.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 100
      return {
        lines: [{ label: `CR${period}`, color: COLORS.cr, path: linePath(line, min, max) }],
        hist: [],
        latest: [[`CR${period}`, line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'bbi') {
      const line = slice(bbi(all))
      const finite = line.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [{ label: 'BBI', color: COLORS.bbi, path: linePath(line, min, max) }],
        hist: [],
        latest: [['BBI', line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'dma') {
      const values = dmaIndicator(all, num(dmaShort, 10), num(dmaLong, 50), num(dmaSignal, 10))
      const dif = slice(values.dma)
      const ama = slice(values.ama)
      const finite = [...dif, ...ama].filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [
          { label: 'DMA', color: COLORS.dma, path: linePath(dif, min, max) },
          { label: 'AMA', color: COLORS.ama, path: linePath(ama, min, max) }
        ],
        hist: [],
        latest: [
          ['DMA', dif.at(-1)],
          ['AMA', ama.at(-1)]
        ] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'trix') {
      const period = num(trixPeriod, 12)
      const values = trixIndicator(all, period, num(trixSignal, 9))
      const line = slice(values.trix)
      const signalLine = slice(values.signal)
      const finite = [...line, ...signalLine].filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [
          { label: `TRIX${period}`, color: COLORS.trix, path: linePath(line, min, max) },
          { label: 'MATRIX', color: COLORS.trixSignal, path: linePath(signalLine, min, max) }
        ],
        hist: [],
        latest: [
          [`TRIX${period}`, line.at(-1)],
          ['MATRIX', signalLine.at(-1)]
        ] as Array<[string, number | undefined]>
      }
    }
    if (tab() === 'sar') {
      const line = slice(sar(all, decimal(sarStep, 0.02), decimal(sarMax, 0.2)))
      const finite = line.filter(Number.isFinite)
      const min = finite.length > 0 ? Math.min(...finite) : 0
      const max = finite.length > 0 ? Math.max(...finite) : 1
      return {
        lines: [{ label: 'SAR', color: COLORS.sar, path: linePath(line, min, max) }],
        hist: [],
        latest: [['SAR', line.at(-1)]] as Array<[string, number | undefined]>
      }
    }
    const values = boll(all, num(bollPeriod, 20), num(bollK, 2))
    const upper = slice(values.upper)
    const middle = slice(values.middle)
    const lower = slice(values.lower)
    const close = slice(all.map((bar) => bar.close))
    const numbers = [...upper, ...middle, ...lower, ...close].filter(Number.isFinite)
    const min = Math.min(...numbers)
    const max = Math.max(...numbers)
    return {
      lines: [
        { label: 'UPPER', color: COLORS.upper, path: linePath(upper, min, max) },
        { label: 'MID', color: COLORS.middle, path: linePath(middle, min, max) },
        { label: 'LOWER', color: COLORS.lower, path: linePath(lower, min, max) },
        { label: 'CLOSE', color: COLORS.close, path: linePath(close, min, max) }
      ],
      hist: [],
      latest: [
        ['UPPER', upper.at(-1)],
        ['MID', middle.at(-1)],
        ['LOWER', lower.at(-1)]
      ] as Array<[string, number | undefined]>
    }
  })

  return (
    <div class="indicator-backdrop" onClick={() => props.onClose()}>
      <section
        class="indicator-panel"
        role="dialog"
        aria-modal="true"
        aria-label="技术指标"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="indicator__head">
          <div>
            <div class="indicator__eyebrow">本地计算 · 最近 {VISIBLE} 根日 K</div>
            <h2 class="indicator__title">
              {props.name} <code>{props.code.toUpperCase()}</code>
            </h2>
          </div>
          <button class="btn btn--icon btn--bare" title="关闭指标" onClick={() => props.onClose()}>
            <IconClose size={16} />
          </button>
        </header>

        <div class="indicator-tabs">
          <For
            each={
              [
                ['macd', 'MACD'],
                ['kdj', 'KDJ'],
                ['rsi', 'RSI'],
                ['wr', 'WR'],
                ['cci', 'CCI'],
                ['bias', 'BIAS'],
                ['dmi', 'DMI'],
                ['obv', 'OBV'],
                ['roc', 'ROC'],
                ['psy', 'PSY'],
                ['vr', 'VR'],
                ['cr', 'CR'],
                ['bbi', 'BBI'],
                ['dma', 'DMA'],
                ['trix', 'TRIX'],
                ['sar', 'SAR'],
                ['boll', 'BOLL']
              ] as Array<[Tab, string]>
            }
          >
            {([value, label]) => (
              <button
                class="indicator-tab"
                data-active={tab() === value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            )}
          </For>
        </div>

        <div class="indicator-params">
          <Show when={tab() === 'macd'}>
            <label>
              <span>快</span>
              <input
                type="number"
                min="2"
                max="60"
                value={macdFast()}
                onInput={(e) => {
                  setMacdFast(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>慢</span>
              <input
                type="number"
                min="3"
                max="120"
                value={macdSlow()}
                onInput={(e) => {
                  setMacdSlow(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>信号</span>
              <input
                type="number"
                min="2"
                max="60"
                value={macdSignal()}
                onInput={(e) => {
                  setMacdSignal(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'kdj'}>
            <label>
              <span>N</span>
              <input
                type="number"
                min="2"
                max="60"
                value={kdjPeriod()}
                onInput={(e) => {
                  setKdjPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>M1</span>
              <input
                type="number"
                min="1"
                max="20"
                value={kdjM1()}
                onInput={(e) => {
                  setKdjM1(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>M2</span>
              <input
                type="number"
                min="1"
                max="20"
                value={kdjM2()}
                onInput={(e) => {
                  setKdjM2(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'rsi'}>
            <label>
              <span>周期</span>
              <input
                type="number"
                min="2"
                max="120"
                value={rsiPeriod()}
                onInput={(e) => {
                  setRsiPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'wr'}>
            <label>
              <span>N</span>
              <input
                type="number"
                min="2"
                max="60"
                value={wrPeriod()}
                onInput={(e) => {
                  setWrPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'cci'}>
            <label>
              <span>N</span>
              <input
                type="number"
                min="2"
                max="60"
                value={cciPeriod()}
                onInput={(e) => {
                  setCciPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'boll'}>
            <label>
              <span>周期</span>
              <input
                type="number"
                min="2"
                max="120"
                value={bollPeriod()}
                onInput={(e) => {
                  setBollPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>倍数</span>
              <input
                type="number"
                min="0.5"
                step="0.5"
                max="10"
                value={bollK()}
                onInput={(e) => {
                  setBollK(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'bias'}>
            <label>
              <span>短</span>
              <input
                type="number"
                min="2"
                max="120"
                value={biasShort()}
                onInput={(e) => {
                  setBiasShort(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>中</span>
              <input
                type="number"
                min="2"
                max="120"
                value={biasMid()}
                onInput={(e) => {
                  setBiasMid(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>长</span>
              <input
                type="number"
                min="2"
                max="120"
                value={biasLong()}
                onInput={(e) => {
                  setBiasLong(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'dmi'}>
            <label>
              <span>周期</span>
              <input
                type="number"
                min="2"
                max="120"
                value={dmiPeriod()}
                onInput={(e) => {
                  setDmiPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'roc'}>
            <label>
              <span>N</span>
              <input
                type="number"
                min="2"
                max="120"
                value={rocPeriod()}
                onInput={(e) => {
                  setRocPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'psy'}>
            <label>
              <span>N</span>
              <input
                type="number"
                min="2"
                max="120"
                value={psyPeriod()}
                onInput={(e) => {
                  setPsyPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'vr'}>
            <label>
              <span>N</span>
              <input
                type="number"
                min="2"
                max="120"
                value={vrPeriod()}
                onInput={(e) => {
                  setVrPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'cr'}>
            <label>
              <span>N</span>
              <input
                type="number"
                min="2"
                max="120"
                value={crPeriod()}
                onInput={(e) => {
                  setCrPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'dma'}>
            <label>
              <span>短</span>
              <input
                type="number"
                min="2"
                max="120"
                value={dmaShort()}
                onInput={(e) => {
                  setDmaShort(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>长</span>
              <input
                type="number"
                min="2"
                max="200"
                value={dmaLong()}
                onInput={(e) => {
                  setDmaLong(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>M</span>
              <input
                type="number"
                min="2"
                max="120"
                value={dmaSignal()}
                onInput={(e) => {
                  setDmaSignal(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'trix'}>
            <label>
              <span>N</span>
              <input
                type="number"
                min="2"
                max="120"
                value={trixPeriod()}
                onInput={(e) => {
                  setTrixPeriod(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>M</span>
              <input
                type="number"
                min="2"
                max="120"
                value={trixSignal()}
                onInput={(e) => {
                  setTrixSignal(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
          <Show when={tab() === 'sar'}>
            <label>
              <span>步长</span>
              <input
                type="number"
                min="0.001"
                max="1"
                step="0.001"
                value={sarStep()}
                onInput={(e) => {
                  setSarStep(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
            <label>
              <span>上限</span>
              <input
                type="number"
                min="0.001"
                max="1"
                step="0.001"
                value={sarMax()}
                onInput={(e) => {
                  setSarMax(e.currentTarget.value)
                  persistParams()
                }}
              />
            </label>
          </Show>
        </div>

        <div class="indicator__body">
          <Show
            when={!loading() && chart()}
            fallback={<div class="indicator__loading">{loading() ? '加载日 K…' : '没有数据'}</div>}
          >
            {(data) => (
              <Show when={!error()} fallback={<div class="indicator__error">{error()}</div>}>
                <svg
                  viewBox={`0 0 ${W} ${H}`}
                  class="indicator__svg"
                  role="img"
                  aria-label="技术指标"
                >
                  <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} class="indicator__axis" />
                  <For each={data().hist}>
                    {(bar) => (
                      <rect
                        x={bar.x}
                        y={bar.y}
                        width={2}
                        height={Math.max(1, bar.height)}
                        class={bar.up ? 'indicator__hist-up' : 'indicator__hist-down'}
                      />
                    )}
                  </For>
                  <For each={data().lines}>
                    {(line) => (
                      <path d={line.path} fill="none" stroke={line.color} stroke-width="1.4" />
                    )}
                  </For>
                </svg>
                <div class="indicator__legend">
                  <For each={data().lines}>
                    {(line) => <span style={{ color: line.color }}>{line.label}</span>}
                  </For>
                </div>
              </Show>
            )}
          </Show>
        </div>

        <div class="indicator__latest">
          <For each={chart()?.latest ?? []}>
            {([label, value]) => (
              <span>
                {label}{' '}
                <strong>
                  {value === undefined || !Number.isFinite(value) ? '—' : fixed(value)}
                </strong>
              </span>
            )}
          </For>
        </div>

        <footer class="indicator__foot">
          <span>
            MACD({num(macdFast, 12)},{num(macdSlow, 26)},{num(macdSignal, 9)}) · KDJ(
            {num(kdjPeriod, 9)},{num(kdjM1, 3)},{num(kdjM2, 3)}) · RSI{num(rsiPeriod, 14)} · BOLL(
            {num(bollPeriod, 20)},{num(bollK, 2)}) · ROC{num(rocPeriod, 12)} · PSY
            {num(psyPeriod, 12)} · VR{num(vrPeriod, 26)} · CR{num(crPeriod, 26)} · DMA(
            {num(dmaShort, 10)},{num(dmaLong, 50)},{num(dmaSignal, 10)}) · TRIX(
            {num(trixPeriod, 12)},{num(trixSignal, 9)}) · SAR(
            {decimal(sarStep, 0.02)},{decimal(sarMax, 0.2)})
          </span>
          <span>不构成交易建议</span>
        </footer>
      </section>
    </div>
  )
}
