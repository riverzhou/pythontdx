/**
 * K 线图（蜡烛图 + 均线 + 成交量）。
 *
 * 手绘 SVG 的另一个好处：想加什么就加什么。
 * 这里实现了 5/10/20 日均线、量价联动的成交量柱、十字光标与浮层读数。
 *
 * 与分时图一样，坐标换算全部委托给 `lib/chart-geometry.ts` 里的纯函数。
 */
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX
} from 'solid-js'
import type { ChartDrawing, KLineSeries } from '@shared/types'
import { fixed, signedPct, thousands, compactAmount } from '@shared/format'
import { boll } from '@shared/indicators'
import { evaluateFormula } from '@shared/formula'
import { ruleConditions } from '@shared/alerts'
import { normalizeMaPeriods } from '@shared/ma'
import {
  accumulateWheel,
  buildKLineGeometry,
  buildKLineLevels,
  buildKLineTicks,
  buildLinePath,
  cursorFromX,
  KLINE_BARS_MAX,
  type KLineGeometry,
  klineRangeStats,
  type KLineRangeStats,
  klineWindow,
  movingAverage,
  nearestZoomLevel,
  nextZoomLevel,
  stepCursor,
  zoomWindow
} from '../../lib/chart-geometry'
import { chartOwnsKeys } from '../../lib/chart-keys'
import { useElementSize } from '../../lib/dom'
import {
  arrowHeadPoints,
  channelOffsetAt,
  fibonacciLevels,
  measurementBars,
  measurementPercent
} from '@shared/drawing'
import type { SmartDrawingPlan } from '@shared/patterns'
import { appState, updateSettings } from '../../stores/app'

/** 均线配色；周期来自设置 */
const MA_COLORS = ['#f0b429', '#5b8cff', '#c084fc', '#22d3ee', '#f472b6'] as const

export type DrawingMode =
  | 'none'
  | 'horizontal'
  | 'trend'
  | 'vertical'
  | 'text'
  | 'fib'
  | 'fibExt'
  | 'measure'
  | 'arrow'
  | 'channel'

interface KLineDrawing {
  id: number
  type: 'horizontal' | 'trend' | 'vertical' | 'text' | 'fib' | 'measure' | 'arrow' | 'channel'
  price?: number
  startIndex?: number
  startPrice?: number
  endIndex?: number
  endPrice?: number
  startDate?: string
  endDate?: string
  smart?: boolean
  text?: string
  extended?: boolean
  offset?: number
}

export interface KLineChartProps {
  series: KLineSeries
  /** 是否叠加 BOLL */
  boll?: boolean
  /** BOLL 周期，默认 20 */
  bollPeriod?: number
  /** BOLL 倍数，默认 2 */
  bollK?: number
  /** 对数价格坐标 */
  logScale?: boolean
  /** 当前复权方式；画线按 code + period + adjust 隔离 */
  adjust?: 'none' | 'qfq' | 'hfq'
  onRangeStats?: (stats: KLineRangeStats | null) => void
  /** 清除区间统计选区 */
  clearRangeKey?: number
  /** Python 技术形态识别结果 */
  smartPlans?: SmartDrawingPlan[]
  /** 区间统计跟随鼠标的屏幕坐标 */
  onRangeAnchor?: (anchor: { x: number; y: number } | null) => void
  /** 光标绝对下标变化（用于副图十字线联动） */
  onCursorChange?: (index: number | null) => void
  /** 可见窗口变化（副图必须复用同一窗口和宽度才能对齐横轴） */
  onWindowChange?: (window: { start: number; count: number; width: number }) => void
  /** 画线模式 */
  drawMode?: DrawingMode
  /** 文字标注内容 */
  drawingText?: string
  /** 除权除息日标记（只画日线/周线等日级周期） */
  dividends?: Array<{ date: string; label: string }>
  /** 主图叠加公式；归一化显示 */
  overlayFormula?: string
  /** 是否显示已保存的画线（默认关闭） */
  showDrawings?: boolean
  /** 是否显示均线（默认开启） */
  showAverages?: boolean
  /** 画线是否吸附 OHLC（默认开启） */
  snapDrawings?: boolean
  /** 改变时清空画线 */
  clearDrawingsKey?: number
  /** 外部触发撤销/重做 */
  undoDrawingsKey?: number
  redoDrawingsKey?: number
}

/** 默认档位：显示全部 K 线 */
const DEFAULT_COUNT = KLINE_BARS_MAX

export function KLineChart(props: KLineChartProps): JSX.Element {
  const { size, ref } = useElementSize<HTMLDivElement>()
  /** 图表容器元素：滚轮监听要显式声明非 passive，所以得自己拿到它 */
  let host: HTMLDivElement | undefined

  /**
   * 可见根数（缩放档位）。
   * 初值取自上次运行存下来的档位，先吸附回档位表 ——
   * 万一存档里的值不在表上（改过档位表 / 手改过设置文件），也不会卡在一个怪状态。
   */
  const [count, setCount] = createSignal<number>(
    nearestZoomLevel(appState.settings.klineZoom ?? DEFAULT_COUNT)
  )
  /** 窗口左端下标；null = 贴着最新一根（右对齐） */
  const [start, setStart] = createSignal<number | null>(null)
  /**
   * 光标所在的**绝对**下标。
   * 存绝对值而不是窗口内的相对下标，是「缩放后不漂移」的关键（`docs/06` 第 23 条）。
   */
  const [cursor, setCursor] = createSignal<number | null>(null)
  /**
   * 鼠标是否停在图表上。
   * 键盘归属判断要用它：滚轮**不用点**就能用，键盘也不该要求先点一下（见 `onKeyDown`）。
   */
  const [hovering, setHovering] = createSignal(false)
  const [rangeStart, setRangeStart] = createSignal<number | null>(null)
  const [rangeEnd, setRangeEnd] = createSignal<number | null>(null)
  const [rangeDragging, setRangeDragging] = createSignal(false)
  const [drawings, setDrawings] = createSignal<KLineDrawing[]>([])
  const [selectedId, setSelectedId] = createSignal<number | null>(null)
  const [undoStack, setUndoStack] = createSignal<KLineDrawing[][]>([])
  const [redoStack, setRedoStack] = createSignal<KLineDrawing[][]>([])
  let dragSnapshot: KLineDrawing[] | null = null
  const [dragId, setDragId] = createSignal<number | null>(null)
  const [dragPart, setDragPart] = createSignal<'start' | 'end' | 'offset' | 'move'>('end')
  const [dragOrigin, setDragOrigin] = createSignal<{
    index: number
    price: number
    drawing: KLineDrawing
  } | null>(null)
  const [editing, setEditing] = createSignal<{
    id: number
    left: number
    top: number
    value: string
  } | null>(null)
  const [pendingPoint, setPendingPoint] = createSignal<{ index: number; price: number } | null>(
    null
  )
  const [pendingSecond, setPendingSecond] = createSignal<{ index: number; price: number } | null>(
    null
  )
  let drawingId = 0
  let drawClipboard: KLineDrawing | null = null
  let suppressContextUntil = 0

  /** 全量 K 线 */
  const allBars = (): KLineSeries['bars'] => props.series.bars

  const drawingAdjust = (): 'none' | 'qfq' | 'hfq' => props.adjust ?? 'qfq'
  const dateIndex = (date: string | undefined): number | undefined => {
    if (!date) return undefined
    const index = allBars().findIndex((bar) => bar.date === date)
    return index >= 0 ? index : undefined
  }
  const anchorDate = (index: number | undefined): string | undefined =>
    index === undefined ? undefined : allBars()[index]?.date
  const savedDrawings = (): ChartDrawing[] =>
    (appState.settings.chartDrawings ?? []).filter(
      (drawing) =>
        drawing.code === props.series.code &&
        drawing.period === props.series.period &&
        (drawing.adjust ?? 'qfq') === drawingAdjust()
    )

  const persistDrawings = (next: KLineDrawing[]): void => {
    const others = (appState.settings.chartDrawings ?? [])
      .filter(
        (drawing) =>
          drawing.code !== props.series.code ||
          drawing.period !== props.series.period ||
          (drawing.adjust ?? 'qfq') !== drawingAdjust()
      )
      .map((drawing) => ({ ...drawing }))
    const saved: ChartDrawing[] = next.map((drawing, index) => ({
      id: `${props.series.code}:${props.series.period}:${drawingAdjust()}:${drawingId}:${index}`,
      code: props.series.code,
      period: props.series.period,
      adjust: drawingAdjust(),
      type: drawing.type,
      price: drawing.price,
      startIndex: drawing.startIndex,
      startPrice: drawing.startPrice,
      endIndex: drawing.endIndex,
      endPrice: drawing.endPrice,
      startDate: anchorDate(drawing.startIndex),
      endDate: anchorDate(drawing.endIndex),
      smart: drawing.smart,
      text: drawing.text,
      extended: drawing.extended,
      offset: drawing.offset
    }))
    updateSettings({ chartDrawings: [...others, ...saved].slice(-200) })
    setDrawings(
      next.map((drawing) => ({
        ...drawing,
        startDate: anchorDate(drawing.startIndex),
        endDate: anchorDate(drawing.endIndex)
      }))
    )
  }

  const cloneDrawings = (items: KLineDrawing[]): KLineDrawing[] =>
    items.map((drawing) => ({ ...drawing }))

  const pushUndo = (snapshot: KLineDrawing[] = drawings()): void => {
    setUndoStack((stack) => [...stack, cloneDrawings(snapshot)].slice(-50))
    setRedoStack([])
  }

  const commitDrawings = (next: KLineDrawing[]): void => {
    pushUndo()
    setDrawings(next)
    persistDrawings(next)
  }

  const undoDrawings = (): void => {
    const stack = undoStack()
    if (stack.length === 0) return
    const previous = stack[stack.length - 1]
    setUndoStack(stack.slice(0, -1))
    setRedoStack((redo) => [...redo, cloneDrawings(drawings())].slice(-50))
    setSelectedId(null)
    setDrawings(previous)
    persistDrawings(previous)
  }

  const redoDrawings = (): void => {
    const stack = redoStack()
    if (stack.length === 0) return
    const next = stack[stack.length - 1]
    setRedoStack(stack.slice(0, -1))
    setUndoStack((undo) => [...undo, cloneDrawings(drawings())].slice(-50))
    setSelectedId(null)
    setDrawings(next)
    persistDrawings(next)
  }

  let lastUndoKey = 0
  let lastRedoKey = 0
  createEffect(() => {
    const key = props.undoDrawingsKey ?? 0
    if (key > lastUndoKey) {
      lastUndoKey = key
      undoDrawings()
    }
  })
  createEffect(() => {
    const key = props.redoDrawingsKey ?? 0
    if (key > lastRedoKey) {
      lastRedoKey = key
      redoDrawings()
    }
  })

  createEffect(
    on(
      () => `${props.series.code}:${props.series.period}:${drawingAdjust()}`,
      () => {
        drawingId = 0
        setRangeStart(null)
        setRangeEnd(null)
        setDrawings(
          savedDrawings().map((drawing) => ({
            ...drawing,
            startIndex: dateIndex(drawing.startDate) ?? drawing.startIndex,
            endIndex: dateIndex(drawing.endDate) ?? drawing.endIndex,
            id: ++drawingId
          }))
        )
        setUndoStack([])
        setRedoStack([])
        setPendingPoint(null)
        setPendingSecond(null)
        props.onRangeStats?.(null)
        props.onRangeAnchor?.(null)
      }
    )
  )

  createEffect(
    on(
      () =>
        `${allBars().length}:${allBars()[0]?.date ?? ''}:${
          allBars()[allBars().length - 1]?.date ?? ''
        }`,
      () => {
        if (allBars().length === 0) return
        setDrawings((current) =>
          current.map((drawing) => ({
            ...drawing,
            startIndex: dateIndex(drawing.startDate) ?? drawing.startIndex,
            endIndex: dateIndex(drawing.endDate) ?? drawing.endIndex
          }))
        )
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => props.clearRangeKey,
      () => {
        setRangeStart(null)
        setRangeEnd(null)
        props.onRangeStats?.(null)
        props.onRangeAnchor?.(null)
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => props.smartPlans,
      (plans) => {
        if (!plans || plans.length === 0) return
        const mapped: KLineDrawing[] = []
        for (const plan of plans) {
          const startIndex = dateIndex(plan.startDate) ?? plan.startIndex
          const endIndex = dateIndex(plan.endDate) ?? plan.endIndex
          if (plan.type !== 'horizontal' && (startIndex === undefined || endIndex === undefined)) {
            continue
          }
          mapped.push({
            id: 0,
            type: plan.type,
            startIndex,
            endIndex,
            startPrice: plan.startPrice,
            endPrice: plan.endPrice,
            price: plan.price,
            offset: plan.offset,
            extended: plan.extended,
            startDate: plan.startDate,
            endDate: plan.endDate,
            smart: true
          })
        }
        if (mapped.length === 0) return
        const manual = drawings().filter((drawing) => !drawing.smart)
        const base = drawingId
        const next = [
          ...manual,
          ...mapped.map((drawing, index) => ({ ...drawing, id: base + index + 1 }))
        ]
        drawingId = base + mapped.length
        setSelectedId(null)
        commitDrawings(next)
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => props.clearDrawingsKey,
      () => {
        if (drawings().length > 0) commitDrawings([])
        setSelectedId(null)
        setPendingPoint(null)
        setPendingSecond(null)
      },
      { defer: true }
    )
  )

  createEffect(() => {
    void props.drawMode
    setPendingPoint(null)
    setPendingSecond(null)
  })
  const total = (): number => allBars().length

  /** 可见窗口：默认右对齐，被左右键平移过就按 start 走（两端自动钳位） */
  const win = createMemo(() => klineWindow(total(), count(), start() ?? undefined))

  /** 光标下标：数据换了（切股票 / 切周期）也得钳在有效范围内 */
  const cursorIndex = createMemo(() => {
    const value = cursor()
    if (value === null || total() === 0) return null
    return Math.min(total() - 1, Math.max(0, value))
  })

  createEffect(() => {
    props.onCursorChange?.(cursorIndex())
  })

  createEffect(() => {
    props.onWindowChange?.({ ...win(), width: size().width })
  })

  /** 真正参与绘制的切片 —— 几何层拿到它之后会自动重算蜡烛宽度 */
  const bars = createMemo(() => {
    const view = win()
    return allBars().slice(view.start, view.start + view.count)
  })

  /**
   * 各条均线：必须在**全量**上计算。
   * 只拿可见切片去算的话，窗口起点那几根的 MA 会因为缺少前置数据而变成 null，
   * 看起来就像均线在图表左边被「剪掉」了一截。
   */
  const averages = createMemo(() => {
    const periods = normalizeMaPeriods(appState.settings.maPeriods)
    return periods.map((period, index) => ({
      period,
      color: MA_COLORS[index] ?? MA_COLORS[0],
      values: movingAverage(allBars(), period)
    }))
  })

  /** 均线同样要切片，否则 x 坐标会和蜡烛整体错位 */
  const visibleAverages = createMemo(() => {
    if (props.showAverages === false) return []
    const view = win()
    return averages().map((average) => ({
      ...average,
      values: average.values.slice(view.start, view.start + view.count)
    }))
  })

  const bollBands = createMemo(() =>
    props.boll ? boll(allBars(), props.bollPeriod ?? 20, props.bollK ?? 2) : null
  )
  const visibleBoll = createMemo(() => {
    const bands = bollBands()
    if (!bands) return null
    const slice = (values: number[]): number[] =>
      values.slice(win().start, win().start + win().count)
    return {
      upper: slice(bands.upper),
      middle: slice(bands.middle),
      lower: slice(bands.lower)
    }
  })

  const geometry = createMemo(() => {
    const bands = visibleBoll()
    const extra = bands ? [...bands.upper, ...bands.middle, ...bands.lower] : []
    return buildKLineGeometry(bars(), size().width, size().height, undefined, extra, props.logScale)
  })
  const selectedDrawing = createMemo(
    () => drawings().find((drawing) => drawing.id === selectedId()) ?? null
  )
  const selectedAnchors = createMemo(() => {
    const drawing = selectedDrawing()
    if (!drawing || !geometry()) return []
    const drawX = (index: number): number => geometry()!.x(index - win().start)
    if (drawing.type === 'horizontal') {
      return [
        {
          x: geometry()!.width - geometry()!.padding.right - 4,
          y: geometry()!.yPrice(drawing.price ?? 0)
        }
      ]
    }
    if (drawing.type === 'vertical') {
      return [{ x: drawX(drawing.startIndex ?? 0), y: geometry()!.priceTop + 8 }]
    }
    if (drawing.type === 'text') {
      return [
        {
          x: drawX(drawing.startIndex ?? 0),
          y: geometry()!.yPrice(drawing.price ?? 0)
        }
      ]
    }
    const points = [
      {
        x: drawX(drawing.startIndex ?? 0),
        y: geometry()!.yPrice(drawing.startPrice ?? 0)
      },
      {
        x: drawX(drawing.endIndex ?? 0),
        y: geometry()!.yPrice(drawing.endPrice ?? 0)
      }
    ]
    if (drawing.type === 'channel') {
      points.push({
        x: points[1].x,
        y: geometry()!.yPrice((drawing.endPrice ?? 0) + (drawing.offset ?? 0))
      })
    }
    return points
  })
  createEffect(() => {
    if (!props.showDrawings) setSelectedId(null)
  })
  const extremes = createMemo(() => {
    const data = bars()
    const geo = geometry()
    if (!geo || data.length === 0) return null
    let high = Number.NEGATIVE_INFINITY
    let low = Number.POSITIVE_INFINITY
    for (const bar of data) {
      if (bar.high > high) high = bar.high
      if (bar.low < low) low = bar.low
    }
    return {
      high,
      low,
      highY: geo.yPrice(high),
      lowY: geo.yPrice(low)
    }
  })

  const formulaOverlay = createMemo(() => {
    const expression = props.overlayFormula
    const geo = geometry()
    if (!expression || !geo || allBars().length === 0) return null
    try {
      const result = evaluateFormula(expression, allBars())
      const values = result.values.slice(win().start, win().start + bars().length)
      const finite = values.filter((value) => Number.isFinite(value))
      if (finite.length < 2) return null
      const min = Math.min(...finite)
      const max = Math.max(...finite)
      const span = max - min || 1
      const path = buildLinePath(
        values.map((value, index) =>
          Number.isFinite(value)
            ? {
                x: geo.x(index),
                y: geo.priceBottom - ((value - min) / span) * (geo.priceBottom - geo.priceTop)
              }
            : null
        )
      )
      return { path, label: expression, min, max }
    } catch {
      return null
    }
  })

  const rangeOverlay = createMemo(() => {
    const start = rangeStart()
    const geo = geometry()
    if (start === null || !geo) return null
    const end = rangeEnd() ?? cursorIndex() ?? start
    const from = Math.min(start, end)
    const to = Math.max(start, end)
    const x1 = geo.x(from - win().start) - geo.slot / 2
    const x2 = geo.x(to - win().start) + geo.slot / 2
    return { x: x1, width: Math.max(1, x2 - x1) }
  })

  const levels = createMemo(() => {
    const geo = geometry()
    return geo ? buildKLineLevels(geo) : []
  })
  const dividendMarks = createMemo(() => {
    const geo = geometry()
    if (!geo || !props.dividends || props.dividends.length === 0) return []
    const marks: Array<{ x: number; label: string; date: string }> = []
    const byDate = new Map(props.dividends.map((item) => [item.date.slice(0, 10), item]))
    bars().forEach((bar, index) => {
      const item = byDate.get(bar.date.slice(0, 10))
      if (item) marks.push({ x: geo.x(index), label: item.label, date: item.date.slice(0, 10) })
    })
    return marks
  })

  const alertPrices = createMemo(() => {
    const result: Array<{ price: number; label: string }> = []
    for (const rule of appState.alerts) {
      if (!rule.enabled || rule.code !== props.series.code) continue
      for (const condition of ruleConditions(rule)) {
        if (condition.metric === 'price') {
          result.push({ price: condition.value, label: rule.name })
        }
      }
    }
    return result
  })

  const dateTicks = createMemo(() => buildKLineTicks(bars()))

  /**
   * 光标那一根的读数。鼠标悬停和键盘左右键**共用同一份状态**，
   * 所以两者不会各指一根、也不会互相打架。
   */
  const cursorReadout = createMemo(() => {
    const absolute = cursorIndex()
    const geo = geometry()
    if (absolute === null || !geo) return null

    const bar = allBars()[absolute]
    if (!bar) return null

    // 涨跌幅要跟前一根比。窗口最左边那根的前一根不在窗口里，得回全量数组去取，
    // 否则它会被算成 0（看起来像是那天没涨没跌）。
    const previous = allBars()[absolute - 1]
    return {
      bar,
      x: geo.x(absolute - win().start),
      y: geo.yPrice(bar.close),
      changePct: previous ? ((bar.close - previous.close) / previous.close) * 100 : 0,
      averages:
        props.showAverages === false
          ? []
          : averages().map((average) => ({
              period: average.period,
              color: average.color,
              value: average.values[absolute]
            }))
    }
  })

  const localPoint = (
    event: PointerEvent,
    geo: KLineGeometry
  ): { index: number; price: number } | null => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const index = cursorFromX(event.clientX - rect.left, win(), geo.padding.left, geo.plotW)
    if (index === null) return null
    return { index, price: geo.priceFromY(event.clientY - rect.top) }
  }

  const snapPoint = (
    point: { index: number; price: number },
    geo: KLineGeometry
  ): { index: number; price: number } => {
    if (props.snapDrawings === false) return point
    const bar = allBars()[point.index]
    if (!bar) return point
    let best = point.price
    let bestDistance = 8
    for (const candidate of [bar.open, bar.high, bar.low, bar.close]) {
      const distance = Math.abs(geo.yPrice(candidate) - geo.yPrice(point.price))
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }
    return { index: point.index, price: best }
  }

  /** 命中水平线/垂直线/趋势线端点时进入拖动。 */
  const hitDrawing = (
    event: PointerEvent,
    geo: KLineGeometry
  ): { drawing: KLineDrawing; part: 'start' | 'end' | 'offset' | 'move' } | null => {
    if (props.drawMode !== 'none') return null
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    for (const drawing of drawings()) {
      // 画线存的是绝对下标；geo.x 要的是当前可见窗口内的下标。
      const drawX = (index: number): number => geo.x(index - win().start)
      if (drawing.type === 'horizontal' && Math.abs(geo.yPrice(drawing.price ?? 0) - y) <= 6) {
        return { drawing, part: 'end' }
      }
      if (drawing.type === 'vertical' && Math.abs(drawX(drawing.startIndex ?? 0) - x) <= 6) {
        return { drawing, part: 'end' }
      }
      if (drawing.type === 'text') {
        const point = {
          x: drawX(drawing.startIndex ?? 0),
          y: geo.yPrice(drawing.price ?? 0)
        }
        if (Math.hypot(point.x - x, point.y - y) <= 10) return { drawing, part: 'end' }
      }
      if (
        drawing.type === 'trend' ||
        drawing.type === 'fib' ||
        drawing.type === 'measure' ||
        drawing.type === 'arrow' ||
        drawing.type === 'channel'
      ) {
        const start = {
          x: drawX(drawing.startIndex ?? 0),
          y: geo.yPrice(drawing.startPrice ?? 0)
        }
        const end = {
          x: drawX(drawing.endIndex ?? 0),
          y: geo.yPrice(drawing.endPrice ?? 0)
        }
        const distance = (point: { x: number; y: number }): number =>
          Math.hypot(point.x - x, point.y - y)
        if (distance(start) <= 8) return { drawing, part: 'start' }
        if (distance(end) <= 8) return { drawing, part: 'end' }
        if (drawing.type === 'channel') {
          const offsetPoint = {
            x: end.x,
            y: geo.yPrice((drawing.endPrice ?? 0) + (drawing.offset ?? 0))
          }
          if (distance(offsetPoint) <= 8) return { drawing, part: 'offset' }
        }
        const segmentDistance = (
          a: { x: number; y: number },
          b: { x: number; y: number }
        ): number => {
          const dx = b.x - a.x
          const dy = b.y - a.y
          const length = dx * dx + dy * dy
          if (length === 0) return Math.hypot(x - a.x, y - a.y)
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length))
          return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
        }
        if (segmentDistance(start, end) <= 6) return { drawing, part: 'move' }
      }
    }
    return null
  }

  const commitEditing = (): void => {
    const edit = editing()
    if (!edit) return
    const next = drawings().map((drawing) =>
      drawing.id === edit.id ? { ...drawing, text: edit.value } : drawing
    )
    commitDrawings(next)
    setEditing(null)
  }

  const onDoubleClick = (event: MouseEvent): void => {
    const geo = geometry()
    if (!geo || props.drawMode !== 'none') return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const target = drawings().find(
      (drawing) =>
        drawing.type === 'text' &&
        Math.hypot(
          geo.x((drawing.startIndex ?? 0) - win().start) - x,
          geo.yPrice(drawing.price ?? 0) - y
        ) <= 12
    )
    if (!target) return
    event.preventDefault()
    setEditing({
      id: target.id,
      left: geo.x((target.startIndex ?? 0) - win().start) + 8,
      top: Math.max(2, geo.yPrice(target.price ?? 0) - 12),
      value: target.text || ''
    })
  }

  const onPointerDown = (event: PointerEvent): void => {
    host?.focus({ preventScroll: true })
    const geo = geometry()
    if (!geo) return
    if (event.button === 2) {
      event.preventDefault()
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const index = cursorFromX(event.clientX - rect.left, win(), geo.padding.left, geo.plotW)
      if (index === null) return
      setRangeStart(index)
      setRangeEnd(index)
      setRangeDragging(true)
      props.onRangeAnchor?.({ x: event.clientX, y: event.clientY })
      props.onRangeStats?.(klineRangeStats(allBars(), index, index))
      try {
        ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      } catch {
        // 合成事件没有 pointerId
      }
      return
    }
    const hit = hitDrawing(event, geo)
    if (hit) {
      dragSnapshot = cloneDrawings(drawings())
      const origin = localPoint(event, geo)
      if (origin) setDragOrigin({ ...origin, drawing: { ...hit.drawing } })
      setSelectedId(hit.drawing.id)
      setDragId(hit.drawing.id)
      setDragPart(hit.part)
      try {
        ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      } catch {
        // 合成 PointerEvent（截图/测试）没有有效 pointerId，忽略捕获即可。
      }
      return
    }
    setSelectedId(null)
    if (props.drawMode && props.drawMode !== 'none') {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const index = cursorFromX(event.clientX - rect.left, win(), geo.padding.left, geo.plotW)
      if (index === null) return
      const snapped = snapPoint({ index, price: geo.priceFromY(event.clientY - rect.top) }, geo)
      const price = snapped.price
      if (props.drawMode === 'horizontal') {
        drawingId += 1
        const next = [...drawings(), { id: drawingId, type: 'horizontal' as const, price }]
        setSelectedId(drawingId)
        commitDrawings(next)
        return
      }
      if (props.drawMode === 'vertical') {
        drawingId += 1
        const next = [
          ...drawings(),
          { id: drawingId, type: 'vertical' as const, startIndex: index }
        ]
        setSelectedId(drawingId)
        commitDrawings(next)
        return
      }
      if (props.drawMode === 'text') {
        drawingId += 1
        const next = [
          ...drawings(),
          {
            id: drawingId,
            type: 'text' as const,
            startIndex: index,
            price,
            text: props.drawingText || '标注'
          }
        ]
        setSelectedId(drawingId)
        commitDrawings(next)
        return
      }
      if (props.drawMode === 'channel') {
        const first = pendingPoint()
        if (!first) {
          setPendingPoint({ index, price })
          return
        }
        const second = pendingSecond()
        if (!second) {
          setPendingSecond({ index, price })
          return
        }
        drawingId += 1
        const offset =
          channelOffsetAt(first.index, first.price, second.index, second.price, index, price) ?? 0
        const next = [
          ...drawings(),
          {
            id: drawingId,
            type: 'channel' as const,
            startIndex: first.index,
            startPrice: first.price,
            endIndex: second.index,
            endPrice: second.price,
            offset
          }
        ]
        setSelectedId(drawingId)
        commitDrawings(next)
        setPendingPoint(null)
        setPendingSecond(null)
        return
      }
      const pending = pendingPoint()
      if (!pending) {
        setPendingPoint({ index, price })
        return
      }
      drawingId += 1
      const next = [
        ...drawings(),
        {
          id: drawingId,
          type:
            props.drawMode === 'measure'
              ? ('measure' as const)
              : props.drawMode === 'arrow'
                ? ('arrow' as const)
                : props.drawMode === 'fib' || props.drawMode === 'fibExt'
                  ? ('fib' as const)
                  : ('trend' as const),
          extended: props.drawMode === 'fibExt',
          startIndex: pending.index,
          startPrice: pending.price,
          endIndex: index,
          endPrice: price
        }
      ]
      setSelectedId(drawingId)
      commitDrawings(next)
      setPendingPoint(null)
      return
    }
  }

  const onPointerMove = (event: PointerEvent): void => {
    const geo = geometry()
    if (!geo) return
    if (rangeDragging()) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const index = cursorFromX(event.clientX - rect.left, win(), geo.padding.left, geo.plotW)
      if (index === null) return
      setRangeEnd(index)
      suppressContextUntil = performance.now() + 600
      props.onRangeAnchor?.({ x: event.clientX, y: event.clientY })
      const start = rangeStart()
      if (start !== null) props.onRangeStats?.(klineRangeStats(allBars(), start, index))
      return
    }
    const drag = dragId()
    if (drag !== null) {
      const rawPoint = localPoint(event, geo)
      if (!rawPoint) return
      const point = dragPart() === 'move' ? rawPoint : snapPoint(rawPoint, geo)
      const origin = dragOrigin()
      setDrawings((current) =>
        current.map((drawing) => {
          if (drawing.id !== drag) return drawing
          if (dragPart() === 'move' && origin) {
            const indexDelta = point.index - origin.index
            const priceDelta = point.price - origin.price
            return {
              ...drawing,
              startIndex:
                drawing.startIndex === undefined ? undefined : drawing.startIndex + indexDelta,
              endIndex: drawing.endIndex === undefined ? undefined : drawing.endIndex + indexDelta,
              startPrice:
                drawing.startPrice === undefined ? undefined : drawing.startPrice + priceDelta,
              endPrice: drawing.endPrice === undefined ? undefined : drawing.endPrice + priceDelta,
              price: drawing.price === undefined ? undefined : drawing.price + priceDelta
            }
          }
          if (drawing.type === 'horizontal') return { ...drawing, price: point.price }
          if (drawing.type === 'vertical') return { ...drawing, startIndex: point.index }
          if (drawing.type === 'channel' && dragPart() === 'offset') {
            return {
              ...drawing,
              offset:
                channelOffsetAt(
                  drawing.startIndex ?? 0,
                  drawing.startPrice ?? 0,
                  drawing.endIndex ?? 0,
                  drawing.endPrice ?? 0,
                  point.index,
                  point.price
                ) ?? 0
            }
          }
          if (
            drawing.type === 'trend' ||
            drawing.type === 'fib' ||
            drawing.type === 'measure' ||
            drawing.type === 'arrow' ||
            drawing.type === 'channel'
          ) {
            return dragPart() === 'start'
              ? { ...drawing, startIndex: point.index, startPrice: point.price }
              : { ...drawing, endIndex: point.index, endPrice: point.price }
          }
          if (drawing.type === 'text') {
            return { ...drawing, startIndex: point.index, price: point.price }
          }
          return drawing
        })
      )
      return
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    // 用鼠标位置换算**绝对**下标：缩放或平移之后，同一个屏幕位置对应的 K 线变了，
    // 但我们记的是「哪一根」，所以窗口动的时候光标不会跟着跑。
    setCursor(cursorFromX(event.clientX - rect.left, win(), geo.padding.left, geo.plotW))
  }

  const onPointerUp = (): void => {
    if (rangeDragging()) {
      setRangeDragging(false)
      const start = rangeStart()
      const end = rangeEnd()
      if (start !== null && end !== null) {
        props.onRangeStats?.(klineRangeStats(allBars(), start, end))
      }
      return
    }
    if (dragId() === null) return
    setDragId(null)
    setDragOrigin(null)
    const snapshot = dragSnapshot
    dragSnapshot = null
    if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(drawings())) {
      pushUndo(snapshot)
    }
    persistDrawings(drawings())
  }

  const onContextMenu = (event: MouseEvent): void => {
    if (performance.now() < suppressContextUntil) {
      event.preventDefault()
      return
    }
    const geo = geometry()
    if (!geo) return
    const hit = hitDrawing(event as PointerEvent, geo)
    if (!hit) return
    event.preventDefault()
    const next = drawings().filter((drawing) => drawing.id !== hit.drawing.id)
    setSelectedId(null)
    commitDrawings(next)
  }

  /**
   * 换档。以**锚点那一根**为锚：缩放前后它落在屏幕上的同一处，
   * 不会出现「指着的 K 线换了一根」（`docs/06` 第 23 条）。
   * 锚点默认是当前光标；滚轮会传鼠标位置算出来的那一根。
   */
  const zoomBy = (direction: 'in' | 'out', anchor: number | null = cursorIndex()): void => {
    const next = nextZoomLevel(count(), direction)
    if (next === count()) return // 已经到顶 / 到底
    const anchored = zoomWindow(win(), total(), next, anchor)
    setCount(anchored.count)
    setStart(anchored.start)
    // 记住档位：下次打开还是这个尺度（设置项是可选的，读的时候用 ?? 兜底）
    updateSettings({ klineZoom: anchored.count })
  }

  /** 左右键移动光标；走到窗口边上时窗口跟着平移，这样能一路走到任意一根 */
  const stepCursorBy = (delta: number): void => {
    const moved = stepCursor(cursorIndex(), delta, win(), total())
    setCursor(moved.cursor)
    setStart(moved.window.start)
  }

  /** End：回到最新一根 —— 平移之后总得有条一键回来的路（主流软件都有） */
  const goLatest = (): void => {
    setStart(null)
    setCursor(total() === 0 ? null : total() - 1)
  }

  /** 滚轮累计量：攒够一格才换档，余量留到下一次（见 accumulateWheel） */
  let wheelAccumulated = 0

  /**
   * 滚轮缩放：向上滚放大（与 `↑` 一致），锚点是**鼠标位置那一根**。
   *
   * 为什么要手动 addEventListener，而不是用 Solid 的 `onWheel`？
   * 因为必须显式声明 `passive: false` —— Chrome 对滚动类事件默认按 passive 处理，
   * 那种情况下 `preventDefault()` 无效（控制台会提示
   * "Unable to preventDefault inside passive event listener"）。
   * `onWheel` 是 addEventListener 的语法糖，给不了这个选项。
   */
  const onWheel = (event: WheelEvent): void => {
    // 图表里没有可滚动的内容，但这样能保证滚轮「只用于缩放」，不会顺手滚动页面
    event.preventDefault()

    const step = accumulateWheel(wheelAccumulated, event.deltaY)
    wheelAccumulated = step.rest
    if (!step.direction) return

    const geo = geometry()
    if (!geo) return

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const anchor = cursorFromX(event.clientX - rect.left, win(), geo.padding.left, geo.plotW)
    // 光标跟着鼠标走：滚轮缩放时人是盯着指针的，读数该同步过去
    setCursor(anchor)
    zoomBy(step.direction, anchor)
  }

  onMount(() => {
    if (!host) return
    host.addEventListener('wheel', onWheel, { passive: false })
    // 键盘监听挂在 window 上而不是图表自己身上，理由见 onKeyDown 的注释
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      host?.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    })
  })

  /** 事件落点是不是输入控件：搜索框正在用 ↑↓ 选联想项，侧栏改名框也在等按键 */
  const isTyping = (event: KeyboardEvent): boolean => {
    const element = event.target as HTMLElement | null
    return (
      element?.tagName === 'INPUT' ||
      element?.tagName === 'TEXTAREA' ||
      element?.isContentEditable === true
    )
  }

  /**
   * 键盘操作。**监听挂在 window 上**，而不是挂在图表自己身上。
   *
   * 为什么？挂在图表上就等于「必须先点一下图，键盘才生效」，可滚轮不用点就能用 ——
   * 同一张图两套规则，用户第一次用键盘必然踩空：点完「日K」标签后焦点还留在那个按钮上，
   * `↑` 落在按钮上，图一动不动，焦点圈反而亮到了标签上（用户实测反馈）。
   * 所以改成「指针在图上，或图有焦点」就归这张图管（判断抽在 `lib/chart-keys.ts` 里单测），
   * 并且在接管的那一刻把焦点收回图表 —— 否则「现在是谁在响应键盘」在界面上看不出来。
   *
   * 键位对齐主流行情软件：
   *   ↑ / ↓  横向伸张 / 收缩（柱子变宽 / 变窄）
   *   ← / →  移动十字光标，走到边上就平移窗口
   *   End    回到最新一根
   *   Esc    收起光标
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    const owned = chartOwnsKeys({
      hovering: hovering(),
      chartFocused: document.activeElement === host,
      typing: isTyping(event)
    })
    if (!owned) return

    if (document.activeElement !== host) host?.focus({ preventScroll: true })

    const command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redoDrawings()
      else undoDrawings()
      return
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redoDrawings()
      return
    }
    if (command && event.key.toLowerCase() === 'c') {
      const selected = selectedDrawing()
      if (selected) {
        event.preventDefault()
        drawClipboard = { ...selected }
      }
      return
    }
    if (command && event.key.toLowerCase() === 'v') {
      if (!drawClipboard) return
      event.preventDefault()
      drawingId += 1
      const source = drawClipboard
      const next = [
        ...drawings(),
        {
          ...source,
          id: drawingId,
          startIndex: source.startIndex === undefined ? undefined : source.startIndex + 3,
          endIndex: source.endIndex === undefined ? undefined : source.endIndex + 3
        }
      ]
      setSelectedId(drawingId)
      commitDrawings(next)
      return
    }

    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        // 不拦下来的话，方向键会去滚动容器（默认行为）
        event.preventDefault()
        zoomBy(event.key === 'ArrowUp' ? 'in' : 'out')
        return
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault()
        stepCursorBy(event.key === 'ArrowLeft' ? -1 : 1)
        return
      case 'End':
        event.preventDefault()
        goLatest()
        return
      case 'Delete':
      case 'Backspace': {
        const id = selectedId()
        if (id === null) return
        event.preventDefault()
        const next = drawings().filter((drawing) => drawing.id !== id)
        setSelectedId(null)
        commitDrawings(next)
        return
      }
      case 'Escape':
        setCursor(null)
        return
      default:
        return
    }
  }

  return (
    <div
      class="chart-host"
      classList={{ 'chart-host--dragging': dragId() !== null }}
      ref={(element: HTMLDivElement) => {
        host = element
        ref(element)
      }}
      tabindex="0"
      aria-label="K 线图：滚轮或上下键缩放、左右键移动光标"
      onPointerEnter={() => setHovering(true)}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onDblClick={onDoubleClick}
      onPointerLeave={() => {
        // 指针离开就交还键盘、收起光标：别让「谁在响应键盘」含糊着
        setHovering(false)
        setCursor(null)
      }}
    >
      <Show when={geometry()} fallback={<div class="chart-empty">正在加载 K 线数据…</div>}>
        {(geo) => (
          <svg class="chart-svg" width={geo().width} height={geo().height}>
            {/* ---------- 横向价格网格 + 右轴刻度 ---------- */}
            <For each={levels()}>
              {(value) => {
                const y = (): number => geo().yPrice(value)
                return (
                  <g>
                    <line
                      x1={geo().padding.left}
                      x2={geo().width - geo().padding.right}
                      y1={y()}
                      y2={y()}
                      stroke="var(--chart-grid)"
                    />
                    <text
                      x={geo().width - geo().padding.right + 8}
                      y={y() + 3.5}
                      fill="var(--chart-axis)"
                      font-size="10"
                      class="num"
                    >
                      {fixed(value, 2)}
                    </text>
                  </g>
                )
              }}
            </For>

            {/* ---------- 预警目标价 ---------- */}
            <For each={alertPrices()}>
              {(alert) => (
                <g class="chart-alert">
                  <title>{`${alert.label} · 预警 ${fixed(alert.price)}`}</title>
                  <line
                    x1={geo().padding.left}
                    x2={geo().width - geo().padding.right}
                    y1={geo().yPrice(alert.price)}
                    y2={geo().yPrice(alert.price)}
                  />
                  <text
                    x={geo().width - geo().padding.right - 2}
                    y={geo().yPrice(alert.price) - 3}
                    text-anchor="end"
                  >
                    预警 {fixed(alert.price)}
                  </text>
                </g>
              )}
            </For>

            {/* ---------- 窗口最高/最低价标记 ---------- */}
            <Show when={extremes()}>
              {(current) => (
                <g class="chart-extremes">
                  <line
                    x1={geo().padding.left}
                    x2={geo().width - geo().padding.right}
                    y1={current().highY}
                    y2={current().highY}
                    class="chart-extreme-line chart-extreme-line--high"
                  />
                  <text
                    x={geo().width - geo().padding.right + 7}
                    y={current().highY + 4}
                    class="chart-extreme-label chart-extreme-label--high"
                  >
                    最高 {fixed(current().high, 2)}
                  </text>
                  <line
                    x1={geo().padding.left}
                    x2={geo().width - geo().padding.right}
                    y1={current().lowY}
                    y2={current().lowY}
                    class="chart-extreme-line chart-extreme-line--low"
                  />
                  <text
                    x={geo().width - geo().padding.right + 7}
                    y={Math.min(geo().height - 24, current().lowY + 14)}
                    class="chart-extreme-label chart-extreme-label--low"
                  >
                    最低 {fixed(current().low, 2)}
                  </text>
                </g>
              )}
            </Show>

            {/* ---------- 成交量柱 ---------- */}
            <For each={bars()}>
              {(bar, index) => (
                <rect
                  x={geo().x(index()) - geo().bodyWidth / 2}
                  y={geo().yVolume(bar.volume)}
                  width={geo().bodyWidth}
                  height={Math.max(0, geo().volumeBottom - geo().yVolume(bar.volume))}
                  fill={bar.close >= bar.open ? 'var(--up)' : 'var(--down)'}
                  opacity="0.5"
                />
              )}
            </For>

            {/* ---------- 蜡烛 ---------- */}
            <For each={bars()}>
              {(bar, index) => {
                const rising = (): boolean => bar.close >= bar.open
                const color = (): string => (rising() ? 'var(--up)' : 'var(--down)')
                const bodyTop = (): number => geo().yPrice(Math.max(bar.open, bar.close))
                const bodyHeight = (): number =>
                  Math.max(1, Math.abs(geo().yPrice(bar.open) - geo().yPrice(bar.close)))
                return (
                  <g>
                    <line
                      x1={geo().x(index())}
                      x2={geo().x(index())}
                      y1={geo().yPrice(bar.high)}
                      y2={geo().yPrice(bar.low)}
                      stroke={color()}
                      stroke-width="1"
                    />
                    <rect
                      x={geo().x(index()) - geo().bodyWidth / 2}
                      y={bodyTop()}
                      width={geo().bodyWidth}
                      height={bodyHeight()}
                      fill={rising() ? 'transparent' : color()}
                      stroke={color()}
                      stroke-width="1"
                    />
                  </g>
                )
              }}
            </For>

            {/* ---------- 均线 ---------- */}
            <For each={visibleAverages()}>
              {(average) => (
                <path
                  d={buildLinePath(
                    average.values.map((value, index) =>
                      value === null ? null : { x: geo().x(index), y: geo().yPrice(value) }
                    )
                  )}
                  fill="none"
                  stroke={average.color}
                  stroke-width="1.2"
                  opacity="0.92"
                />
              )}
            </For>

            {/* ---------- BOLL 叠加 ---------- */}
            <Show when={visibleBoll()}>
              {(bands) => (
                <g>
                  <For
                    each={[
                      { values: bands().upper, color: '#f0b429', label: 'UP' },
                      { values: bands().middle, color: '#5b8cff', label: 'MID' },
                      { values: bands().lower, color: '#c084fc', label: 'LOW' }
                    ]}
                  >
                    {(line) => (
                      <path
                        d={buildLinePath(
                          line.values.map((value, index) =>
                            Number.isFinite(value)
                              ? { x: geo().x(index), y: geo().yPrice(value) }
                              : null
                          )
                        )}
                        fill="none"
                        stroke={line.color}
                        stroke-width="1.1"
                        opacity="0.8"
                      />
                    )}
                  </For>
                </g>
              )}
            </Show>

            {/* ---------- 主图公式叠加（归一化） ---------- */}
            <Show when={formulaOverlay()}>
              {(overlay) => (
                <g>
                  <path
                    class="chart-formula"
                    d={overlay().path}
                    fill="none"
                    stroke="#22d3ee"
                    stroke-width="1.2"
                    opacity="0.85"
                  />
                  <text x={geo().padding.left + 120} y="12" fill="#22d3ee" font-size="10">
                    公式 {overlay().label}
                  </text>
                </g>
              )}
            </Show>

            {/* ---------- 日期轴 ---------- */}
            <For each={dateTicks()}>
              {(tick) => (
                <text
                  x={geo().x(tick.index)}
                  y={geo().height - 6}
                  fill="var(--text-3)"
                  font-size="10"
                  text-anchor="middle"
                >
                  {tick.label}
                </text>
              )}
            </For>

            {/* ---------- 缩放档位 ---------- */}
            {/*
              写在图表自己的上边距里，而不是卡片头部：
              头部在 1024 最小窗口下已经被 tab + 图例占满，再塞一块会把图例挤到 tab 上。
              这里是天然的空白带，永远不会压到蜡烛和网格线。
            */}
            <text
              class="chart-zoom"
              x={geo().padding.left}
              y="12"
              fill="var(--text-3)"
              font-size="10"
            >
              {`↑↓ 缩放 · 近 ${win().count} 根`}
            </text>

            {/* ---------- 除权除息标记 ---------- */}
            <For each={dividendMarks()}>
              {(mark) => (
                <g class="chart-dividend">
                  <title>{`${mark.date} ${mark.label}`}</title>
                  <line x1={mark.x} x2={mark.x} y1={geo().priceTop} y2={geo().volumeBottom} />
                  <circle cx={mark.x} cy={geo().priceTop + 5} r="2.5" />
                  <text
                    x={mark.x}
                    y={geo().priceTop + 18}
                    fill="var(--accent)"
                    font-size="9"
                    text-anchor="middle"
                  >
                    D
                  </text>
                </g>
              )}
            </For>

            {/* ---------- 画线（默认隐藏，由工具栏开关控制） ---------- */}
            <Show when={props.showDrawings ?? false}>
              <For each={drawings()}>
                {(drawing) =>
                  drawing.type === 'horizontal' ? (
                    <>
                      <line
                        class="chart-drawing"
                        x1={geo().padding.left}
                        x2={geo().width - geo().padding.right}
                        y1={geo().yPrice(drawing.price ?? 0)}
                        y2={geo().yPrice(drawing.price ?? 0)}
                      />
                      <text
                        class="chart-drawing-label"
                        x={geo().width - geo().padding.right - 2}
                        y={geo().yPrice(drawing.price ?? 0) - 3}
                        text-anchor="end"
                      >
                        {fixed(drawing.price ?? 0)}
                      </text>
                    </>
                  ) : drawing.type === 'vertical' ? (
                    <>
                      <line
                        class="chart-drawing"
                        x1={geo().x((drawing.startIndex ?? 0) - win().start)}
                        x2={geo().x((drawing.startIndex ?? 0) - win().start)}
                        y1={geo().priceTop}
                        y2={geo().volumeBottom}
                      />
                      <text
                        class="chart-drawing-label"
                        x={geo().x((drawing.startIndex ?? 0) - win().start) + 4}
                        y={geo().priceTop + 12}
                      >
                        {allBars()[drawing.startIndex ?? 0]?.date ?? ''}
                      </text>
                    </>
                  ) : drawing.type === 'text' ? (
                    <g>
                      <circle
                        class="chart-drawing-point"
                        cx={geo().x((drawing.startIndex ?? 0) - win().start)}
                        cy={geo().yPrice(drawing.price ?? 0)}
                        r="2.5"
                      />
                      <text
                        class="chart-drawing-text"
                        x={geo().x((drawing.startIndex ?? 0) - win().start) + 5}
                        y={geo().yPrice(drawing.price ?? 0) - 5}
                      >
                        {drawing.text || '标注'}
                      </text>
                    </g>
                  ) : drawing.type === 'fib' ? (
                    <g>
                      <For
                        each={fibonacciLevels(
                          drawing.startPrice ?? 0,
                          drawing.endPrice ?? 0,
                          drawing.extended
                        )}
                      >
                        {(level) => {
                          const y = geo().yPrice(level.price)
                          const inside = y >= geo().priceTop && y <= geo().priceBottom
                          return (
                            <Show when={inside}>
                              <g>
                                <line
                                  class="chart-drawing chart-drawing-fib"
                                  x1={geo().x((drawing.startIndex ?? 0) - win().start)}
                                  x2={geo().x((drawing.endIndex ?? 0) - win().start)}
                                  y1={y}
                                  y2={y}
                                />
                                <text
                                  class="chart-drawing-label"
                                  x={geo().x((drawing.endIndex ?? 0) - win().start) + 4}
                                  y={Math.max(
                                    geo().priceTop + 9,
                                    Math.min(y - 2, geo().priceBottom - 4)
                                  )}
                                >
                                  {(level.ratio * 100).toFixed(1)}% {fixed(level.price)}
                                </text>
                              </g>
                            </Show>
                          )
                        }}
                      </For>
                    </g>
                  ) : drawing.type === 'measure' ? (
                    <g>
                      {(() => {
                        const percent = measurementPercent(
                          drawing.startPrice ?? 0,
                          drawing.endPrice ?? 0
                        )
                        const bars = measurementBars(drawing.startIndex ?? 0, drawing.endIndex ?? 0)
                        return (
                          <>
                            <line
                              class="chart-drawing chart-drawing-measure"
                              x1={geo().x((drawing.startIndex ?? 0) - win().start)}
                              y1={geo().yPrice(drawing.startPrice ?? 0)}
                              x2={geo().x((drawing.endIndex ?? 0) - win().start)}
                              y2={geo().yPrice(drawing.endPrice ?? 0)}
                            />
                            <circle
                              class="chart-drawing-point"
                              cx={geo().x((drawing.startIndex ?? 0) - win().start)}
                              cy={geo().yPrice(drawing.startPrice ?? 0)}
                              r="2.5"
                            />
                            <circle
                              class="chart-drawing-point"
                              cx={geo().x((drawing.endIndex ?? 0) - win().start)}
                              cy={geo().yPrice(drawing.endPrice ?? 0)}
                              r="2.5"
                            />
                            <text
                              class="chart-drawing-label"
                              x={Math.max(
                                geo().padding.left + 34,
                                Math.min(
                                  geo().x((drawing.endIndex ?? 0) - win().start),
                                  geo().width - geo().padding.right - 34
                                )
                              )}
                              y={geo().priceBottom + 10}
                              text-anchor="middle"
                            >
                              {percent === null
                                ? '—'
                                : `${percent >= 0 ? '+' : ''}${fixed(percent)}% / ${bars} 根`}
                            </text>
                          </>
                        )
                      })()}
                    </g>
                  ) : drawing.type === 'arrow' ? (
                    <g>
                      <line
                        class="chart-drawing"
                        x1={geo().x((drawing.startIndex ?? 0) - win().start)}
                        y1={geo().yPrice(drawing.startPrice ?? 0)}
                        x2={geo().x((drawing.endIndex ?? 0) - win().start)}
                        y2={geo().yPrice(drawing.endPrice ?? 0)}
                      />
                      <polygon
                        class="chart-drawing-arrow"
                        points={arrowHeadPoints(
                          {
                            x: geo().x((drawing.startIndex ?? 0) - win().start),
                            y: geo().yPrice(drawing.startPrice ?? 0)
                          },
                          {
                            x: geo().x((drawing.endIndex ?? 0) - win().start),
                            y: geo().yPrice(drawing.endPrice ?? 0)
                          }
                        )
                          .map((point) => `${point.x},${point.y}`)
                          .join(' ')}
                      />
                    </g>
                  ) : drawing.type === 'channel' ? (
                    <g>
                      <polygon
                        class="chart-drawing-channel-fill"
                        points={[
                          [drawing.startIndex ?? 0, drawing.startPrice ?? 0],
                          [drawing.endIndex ?? 0, drawing.endPrice ?? 0],
                          [drawing.endIndex ?? 0, (drawing.endPrice ?? 0) + (drawing.offset ?? 0)],
                          [
                            drawing.startIndex ?? 0,
                            (drawing.startPrice ?? 0) + (drawing.offset ?? 0)
                          ]
                        ]
                          .map(
                            ([index, price]) =>
                              `${geo().x(index - win().start)},${geo().yPrice(price)}`
                          )
                          .join(' ')}
                      />
                      <line
                        class="chart-drawing"
                        x1={geo().x((drawing.startIndex ?? 0) - win().start)}
                        y1={geo().yPrice(drawing.startPrice ?? 0)}
                        x2={geo().x((drawing.endIndex ?? 0) - win().start)}
                        y2={geo().yPrice(drawing.endPrice ?? 0)}
                      />
                      <line
                        class="chart-drawing"
                        x1={geo().x((drawing.startIndex ?? 0) - win().start)}
                        y1={geo().yPrice((drawing.startPrice ?? 0) + (drawing.offset ?? 0))}
                        x2={geo().x((drawing.endIndex ?? 0) - win().start)}
                        y2={geo().yPrice((drawing.endPrice ?? 0) + (drawing.offset ?? 0))}
                      />
                      <circle
                        class="chart-drawing-point chart-drawing-channel-handle"
                        cx={geo().x((drawing.endIndex ?? 0) - win().start)}
                        cy={geo().yPrice((drawing.endPrice ?? 0) + (drawing.offset ?? 0))}
                        r="4"
                      />
                    </g>
                  ) : (
                    <>
                      <line
                        class="chart-drawing"
                        x1={geo().x((drawing.startIndex ?? 0) - win().start)}
                        y1={geo().yPrice(drawing.startPrice ?? 0)}
                        x2={geo().x((drawing.endIndex ?? 0) - win().start)}
                        y2={geo().yPrice(drawing.endPrice ?? 0)}
                      />
                      <text
                        class="chart-drawing-label"
                        x={
                          geo().x((drawing.startIndex ?? 0) - win().start) +
                          (geo().x((drawing.startIndex ?? 0) - win().start) <
                          geo().width - geo().padding.right - 36
                            ? 4
                            : -4)
                        }
                        y={Math.max(
                          geo().priceTop + 9,
                          Math.min(geo().yPrice(drawing.startPrice ?? 0) - 4, geo().priceBottom - 4)
                        )}
                        text-anchor={
                          geo().x((drawing.startIndex ?? 0) - win().start) <
                          geo().width - geo().padding.right - 36
                            ? 'start'
                            : 'end'
                        }
                      >
                        {fixed(drawing.startPrice ?? 0)}
                      </text>
                      <text
                        class="chart-drawing-label"
                        x={geo().x((drawing.endIndex ?? 0) - win().start) - 4}
                        y={Math.max(
                          geo().priceTop + 9,
                          Math.min(geo().yPrice(drawing.endPrice ?? 0) - 4, geo().priceBottom - 4)
                        )}
                        text-anchor="end"
                      >
                        {fixed(drawing.endPrice ?? 0)}
                      </text>
                    </>
                  )
                }
              </For>

              {/* ---------- 区间统计选区 ---------- */}
              <Show when={rangeOverlay()}>
                {(box) => (
                  <rect
                    class="chart-range"
                    x={box().x}
                    y={geo().priceTop}
                    width={box().width}
                    height={geo().volumeBottom - geo().priceTop}
                  />
                )}
              </Show>
            </Show>

            {/* ---------- 选中画线的手柄 ---------- */}
            <Show when={selectedDrawing() ? selectedAnchors() : null}>
              {(points) => (
                <g class="chart-drawing-selection">
                  <For each={points()}>
                    {(point) => (
                      <>
                        <circle cx={point.x} cy={point.y} r="7" />
                        <circle cx={point.x} cy={point.y} r="3" />
                      </>
                    )}
                  </For>
                </g>
              )}
            </Show>

            {/* ---------- 十字光标 ---------- */}
            <Show when={cursorReadout()}>
              {(current) => (
                <g>
                  <line
                    class="chart-crosshair-v"
                    x1={current().x}
                    x2={current().x}
                    y1={geo().priceTop}
                    y2={geo().volumeBottom}
                    stroke="var(--chart-crosshair)"
                    stroke-dasharray="3 3"
                  />
                  <line
                    x1={geo().padding.left}
                    x2={geo().width - geo().padding.right}
                    y1={current().y}
                    y2={current().y}
                    stroke="var(--chart-crosshair)"
                    stroke-dasharray="3 3"
                  />
                </g>
              )}
            </Show>
          </svg>
        )}
      </Show>

      <Show when={cursorReadout()}>
        {(current) => (
          <div
            class="chart-tooltip"
            style={{
              left: `${Math.min(current().x + 14, Math.max(0, size().width - 172))}px`,
              top: '10px'
            }}
          >
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">日期</span>
              <span class="num">{current().bar.date}</span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">收盘</span>
              <span
                class="num"
                style={{
                  color: current().bar.close >= current().bar.open ? 'var(--up)' : 'var(--down)'
                }}
              >
                {fixed(current().bar.close)}
              </span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">涨跌幅</span>
              <span class="num">{signedPct(current().changePct)}</span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">开/高</span>
              <span class="num">
                {fixed(current().bar.open)} / {fixed(current().bar.high)}
              </span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">低/收</span>
              <span class="num">
                {fixed(current().bar.low)} / {fixed(current().bar.close)}
              </span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">成交量</span>
              <span class="num">{thousands(current().bar.volume)} 手</span>
            </div>
            <Show when={(current().bar.amount ?? 0) > 0}>
              <div class="chart-tooltip__row">
                <span class="chart-tooltip__label">成交额</span>
                <span class="num">{compactAmount(current().bar.amount)} 元</span>
              </div>
            </Show>
            <For each={current().averages}>
              {(average) => (
                <div class="chart-tooltip__row">
                  <span class="chart-tooltip__label" style={{ color: average.color }}>
                    MA{average.period}
                  </span>
                  <span class="num">{fixed(average.value ?? undefined)}</span>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>

      <Show when={editing()}>
        {(edit) => (
          <input
            class="chart-edit-input"
            style={{ left: `${edit().left}px`, top: `${edit().top}px` }}
            value={edit().value}
            maxlength="20"
            autofocus
            ref={(element) => queueMicrotask(() => element.focus())}
            onInput={(event) =>
              setEditing((current) =>
                current ? { ...current, value: event.currentTarget.value } : current
              )
            }
            onBlur={commitEditing}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitEditing()
              if (event.key === 'Escape') setEditing(null)
            }}
          />
        )}
      </Show>
    </div>
  )
}
