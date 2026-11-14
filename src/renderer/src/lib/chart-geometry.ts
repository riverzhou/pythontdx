/**
 * 图表几何计算 —— **纯函数**，不依赖 DOM、不依赖 SolidJS。
 *
 * 为什么要把这些从组件里抽出来？
 *
 * 分时图有「横轴槽位 → 像素」「价格 → 像素」「成交量 → 像素」三套映射，
 * 它们相互耦合（纵轴范围变了，三套映射都要跟着变）。
 * 留在组件里时，唯一的验证手段是「截图看一眼」——
 * 而截图看不出「第 137 个点的 y 坐标算错了 1.5px」这种问题。
 *
 * 抽成纯函数之后：
 *   · 可以用单元测试锁住边界（首点、末点、空数据、只有一天、极窄区间）；
 *   · 组件只负责把返回的数字塞进 SVG，读起来也清爽得多。
 *
 * 约定：所有函数都是「输入数据 + 画布尺寸 → 输出数字」，没有任何副作用。
 */
import type { KLineBar, MinutePoint, MinuteTrend } from '@shared/types'
import { toneOf, type Tone } from './tone'

/* ============================================================ 公共类型 */

export interface Padding {
  top: number
  right: number
  bottom: number
  left: number
}

/** 纵轴刻度：单日模式带涨跌幅（pct），多日模式只有价格 */
export interface AxisLevel {
  value: number
  pct: number | null
}

export interface TimeTick {
  /** 在整条横轴上的槽位 */
  slot: number
  label: string
  anchor: 'start' | 'middle' | 'end'
}

/* ============================================================ 分时图 */

/** 一个交易日的分时槽位数（09:30–11:30 + 13:01–15:00 共 241 个点，索引 0..240） */
export const DAY_SLOTS = 241

/** 分时图的默认留白（右侧留给价格与涨跌幅双刻度） */
export const TREND_PADDING: Padding = { top: 18, right: 64, bottom: 22, left: 10 }

/** 成交量区占绘图高度的比例 */
const VOLUME_RATIO = 0.2

/** 价格区与成交量区之间的留白 */
const VOLUME_GAP = 12

/** 绘图区最小可用尺寸，小于它就返回 null 由界面显示占位 */
const MIN_WIDTH = 120
const MIN_HEIGHT = 140

export interface TrendGeometry {
  width: number
  height: number
  padding: Padding
  plotW: number
  priceTop: number
  priceBottom: number
  volumeTop: number
  volumeBottom: number
  /** 当前可见范围的槽位跨度（默认单日 240，五日 1204） */
  totalSlots: number
  /** 可见范围首/末槽位（缩放到某一段时非 0/240） */
  slotStart: number
  slotEnd: number
  yMax: number
  yMin: number
  maxVolume: number
  /** 成交量柱宽度（已保底 1px） */
  barWidth: number
  /** 槽位 → 横坐标 */
  x(slot: number): number
  /** 价格 → 纵坐标 */
  yPrice(value: number): number
  /** 成交量 → 纵坐标（柱顶） */
  yVolume(value: number): number
}

/** 分时图可见槽位范围；单日缩放到 09:45–10:30 这类区间时使用。 */
export interface TrendView {
  start: number
  end: number
}

/** 把多个交易日的点摊平成一条横轴上的序列 */
export interface FlatTrendPoint {
  point: MinutePoint
  dayIndex: number
  slot: number
}

export function flattenTrendPoints(days: MinuteTrend[]): FlatTrendPoint[] {
  return days.flatMap((day, dayIndex) =>
    day.points.map((point, pointIndex) => ({
      point,
      dayIndex,
      slot: dayIndex * DAY_SLOTS + pointIndex
    }))
  )
}

/** 单日模式的基准线取最后一天的昨收 */
export function trendBaseline(days: MinuteTrend[]): number {
  const last = days[days.length - 1]
  return last?.prevClose || days[0]?.points[0]?.price || 0
}

export function buildTrendGeometry(
  days: MinuteTrend[],
  width: number,
  height: number,
  padding: Padding = TREND_PADDING,
  view?: TrendView
): TrendGeometry | null {
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null

  const allFlat = flattenTrendPoints(days)
  if (allFlat.length === 0) return null

  const maxSlot = Math.max(0, days.length * DAY_SLOTS - 1)
  const slotStart = view ? Math.min(maxSlot, Math.max(0, Math.round(view.start))) : 0
  const slotEnd = view ? Math.min(maxSlot, Math.max(slotStart, Math.round(view.end))) : maxSlot
  const visible = view
    ? allFlat.filter((item) => item.slot >= slotStart && item.slot <= slotEnd)
    : allFlat
  // 缩放范围落在无数据时段（如午休）时退回全量，避免空图。
  const flat = visible.length > 0 ? visible : allFlat
  const rangeStart = visible.length > 0 ? slotStart : 0
  const rangeEnd = visible.length > 0 ? slotEnd : maxSlot

  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom
  if (plotW <= 0 || plotH <= 0) return null

  const volumeH = plotH * VOLUME_RATIO
  const priceH = plotH - volumeH - VOLUME_GAP
  if (priceH <= 0) return null

  const priceTop = padding.top
  const priceBottom = priceTop + priceH
  const volumeTop = priceBottom + VOLUME_GAP
  const volumeBottom = volumeTop + volumeH

  const multiDay = days.length > 1
  let yMin: number
  let yMax: number

  if (multiDay) {
    // 多日：按可见交易日的真实价格区间取范围
    let low = Infinity
    let high = -Infinity
    for (const item of flat) {
      low = Math.min(low, item.point.price, item.point.avg)
      high = Math.max(high, item.point.price, item.point.avg)
    }
    const paddingValue = (high - low) * 0.06 || high * 0.01
    yMax = high + paddingValue
    yMin = Math.max(0, low - paddingValue)
  } else {
    // 单日：以昨收为中心上下对称，一眼看出偏离基准多少
    const baseline = trendBaseline(days)
    let deviation = 0
    for (const item of flat) {
      deviation = Math.max(
        deviation,
        Math.abs(item.point.price - baseline),
        Math.abs(item.point.avg - baseline)
      )
    }
    // 全天几乎不动时给一个最小可视区间，避免除以 0
    if (deviation < baseline * 1e-4) deviation = baseline * 0.002
    const paddingValue = deviation * 1.02
    yMax = baseline + paddingValue
    yMin = baseline - paddingValue
  }

  // 防御：纵轴退化成一个点时给一个安全区间
  if (!(yMax > yMin)) {
    yMax = (yMax || 1) * 1.01
    yMin = (yMin || 1) * 0.99
  }

  const maxVolume = Math.max(1, ...flat.map((item) => item.point.volume))
  const totalSlots = Math.max(1, rangeEnd - rangeStart)

  return {
    width,
    height,
    padding,
    plotW,
    priceTop,
    priceBottom,
    volumeTop,
    volumeBottom,
    totalSlots,
    slotStart: rangeStart,
    slotEnd: rangeEnd,
    yMax,
    yMin,
    maxVolume,
    barWidth: Math.max(1, (plotW / (totalSlots + 1)) * 0.64),
    x: (slot: number) => padding.left + ((slot - rangeStart) / totalSlots) * plotW,
    yPrice: (value: number) => priceTop + ((yMax - value) / (yMax - yMin)) * priceH,
    yVolume: (value: number) => volumeBottom - (value / maxVolume) * volumeH
  }
}

/**
 * 纵轴刻度。
 *
 * 单日模式围绕昨收对称，步长按波动幅度在 0.5% / 1% / 2% / 5% / 10% 之间自动切换，
 * 保证「波动 0.8% 的股票也能看清细节」；多日模式没有统一基准，改用价格刻度。
 */
export function buildTrendLevels(days: MinuteTrend[], geo: TrendGeometry): AxisLevel[] {
  // 刻度数跟着图高走：700 高的窗口里 12 条会糊成一团，短窗口自动降到 4~6 条。
  const target = Math.max(3, Math.min(12, Math.floor(geo.height / 46)))
  if (days.length > 1) {
    const step = niceAxisStep(geo.yMax - geo.yMin, target)
    const result: AxisLevel[] = []
    for (let value = Math.ceil(geo.yMin / step) * step; value <= geo.yMax; value += step) {
      result.push({ value: Number(value.toFixed(3)), pct: null })
    }
    return result
  }

  const base = trendBaseline(days)
  if (!(base > 0)) return []

  const rangePct = ((geo.yMax - geo.yMin) / base) * 100
  // 右侧百分比刻度要密一些：目标约 target 条，同时避免 0.05% 这类过细标签。
  const candidates = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20]
  const step = candidates.find((value) => value >= rangePct / (target + 2)) ?? 20

  // 基准线一定在
  const result: AxisLevel[] = [{ value: base, pct: 0 }]
  for (let pct = step; pct <= rangePct / 2 + step; pct += step) {
    const up = base * (1 + pct / 100)
    const down = base * (1 - pct / 100)
    if (up < geo.yMax) result.push({ value: up, pct })
    if (down > geo.yMin) result.push({ value: down, pct: -pct })
  }
  return result.sort((a, b) => b.value - a.value)
}

/** 横轴标签：单日给时间刻，多日给每个交易日的日期；传 geo 时只保留可见刻度 */
export function buildTrendTicks(days: MinuteTrend[], geo?: TrendGeometry): TimeTick[] {
  const ticks: TimeTick[] =
    days.length > 1
      ? days.map((day, dayIndex) => ({
          slot: dayIndex * DAY_SLOTS,
          label: formatMonthDay(day.date),
          anchor: 'start' as const
        }))
      : [
          { slot: 0, label: '09:30', anchor: 'start' as const },
          { slot: 60, label: '10:30', anchor: 'middle' as const },
          { slot: 120, label: '11:30/13:00', anchor: 'middle' as const },
          { slot: 180, label: '14:00', anchor: 'middle' as const },
          { slot: 240, label: '15:00', anchor: 'end' as const }
        ]
  if (!geo) return ticks
  return ticks.filter((tick) => tick.slot >= geo.slotStart && tick.slot <= geo.slotEnd)
}

/** 交易日之间的分隔线槽位（仅多日模式） */
export function buildTrendSeparators(days: MinuteTrend[], geo?: TrendGeometry): number[] {
  if (days.length <= 1) return []
  const slots = days.slice(1).map((_, index) => (index + 1) * DAY_SLOTS)
  return geo ? slots.filter((slot) => slot >= geo.slotStart && slot <= geo.slotEnd) : slots
}

export interface TrendDayPath {
  dayIndex: number
  tone: Tone
  /** 价格折线 */
  line: string
  /** 折线 + 底边围成的面积路径 */
  area: string
  /** 该交易日最后一个点的槽位 */
  lastSlot: number
}

/** 每个交易日一条折线，各自按当天的涨跌上色；缩放时只取可见点。 */
export function buildTrendDayPaths(days: MinuteTrend[], geo: TrendGeometry): TrendDayPath[] {
  return days.map((day, dayIndex) => {
    const last = day.points[day.points.length - 1]
    const tone = toneOf((last?.price ?? 0) - day.prevClose)
    const visible = day.points
      .map((point, pointIndex) => ({
        point,
        slot: dayIndex * DAY_SLOTS + pointIndex
      }))
      .filter((item) => item.slot >= geo.slotStart && item.slot <= geo.slotEnd)

    const line = visible
      .map((item, index) => {
        const x = geo.x(item.slot)
        const y = geo.yPrice(item.point.price)
        return `${index === 0 ? 'M' : 'L'}${round(x)},${round(y)}`
      })
      .join(' ')

    const firstSlot = visible[0]?.slot ?? 0
    const lastSlot = visible[visible.length - 1]?.slot ?? 0
    const area = line
      ? `${line} L${round(geo.x(lastSlot))},${round(geo.priceBottom)} L${round(geo.x(firstSlot))},${round(geo.priceBottom)} Z`
      : ''

    return { dayIndex, tone, line, area, lastSlot }
  })
}

/** 均价线：多日时用同一条虚线贯穿，避免五种颜色太花；缩放时只取可见点。 */
export function buildTrendAveragePath(days: MinuteTrend[], geo: TrendGeometry): string {
  return days
    .flatMap((day, dayIndex) => {
      const visible = day.points
        .map((point, pointIndex) => ({
          point,
          slot: dayIndex * DAY_SLOTS + pointIndex
        }))
        .filter((item) => item.slot >= geo.slotStart && item.slot <= geo.slotEnd)
      return visible.map((item, index) => {
        const x = geo.x(item.slot)
        const y = geo.yPrice(item.point.avg)
        return `${index === 0 ? 'M' : 'L'}${round(x)},${round(y)}`
      })
    })
    .join(' ')
}

/**
 * 槽位 → (第几天, 第几个点)。
 *
 * 每天的槽位是连续的，所以直接整除取余即可 —— 不需要遍历查找。
 * 边界要做钳位：鼠标移到最右侧时算出的槽位可能超出实际点数。
 */
export function locateTrendSlot(
  slot: number,
  days: MinuteTrend[]
): { dayIndex: number; pointIndex: number } | null {
  if (days.length === 0) return null
  if (!Number.isFinite(slot)) return null

  const dayIndex = Math.min(days.length - 1, Math.max(0, Math.floor(slot / DAY_SLOTS)))
  const day = days[dayIndex]
  if (!day || day.points.length === 0) return null

  const pointIndex = Math.min(
    day.points.length - 1,
    Math.max(0, Math.round(slot - dayIndex * DAY_SLOTS))
  )
  return { dayIndex, pointIndex }
}

/** 横坐标 → 槽位（把鼠标位置换算成槽位，注意剔除左留白） */
export function slotFromX(
  clientX: number,
  containerLeft: number,
  geo: TrendGeometry
): number | null {
  if (geo.plotW <= 0) return null
  const ratio = (clientX - containerLeft - geo.padding.left) / geo.plotW
  if (!Number.isFinite(ratio)) return null
  return Math.round(geo.slotStart + ratio * (geo.slotEnd - geo.slotStart))
}

/* ============================================================ K 线图 */

// 顶部给 MA 图例/缩放提示留空间，底部留给最高/最低价和横轴标签。
export const KLINE_PADDING: Padding = { top: 54, right: 64, bottom: 30, left: 10 }

export interface KLineGeometry {
  width: number
  height: number
  padding: Padding
  plotW: number
  priceTop: number
  priceBottom: number
  volumeBottom: number
  yMax: number
  yMin: number
  maxVolume: number
  /** 每根 K 线占用的横向宽度 */
  slot: number
  /** 蜡烛实体宽度（已保底 1px） */
  bodyWidth: number
  x(index: number): number
  yPrice(value: number): number
  priceFromY(y: number): number
  yVolume(value: number): number
}

export function buildKLineGeometry(
  bars: KLineBar[],
  width: number,
  height: number,
  padding: Padding = KLINE_PADDING,
  extraValues: number[] = [],
  logScale = false
): KLineGeometry | null {
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null
  if (bars.length === 0) return null

  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom
  if (plotW <= 0 || plotH <= 0) return null

  const volumeH = plotH * VOLUME_RATIO
  const priceH = plotH - volumeH - VOLUME_GAP
  if (priceH <= 0) return null

  const priceTop = padding.top
  const priceBottom = priceTop + priceH
  const volumeTop = priceBottom + VOLUME_GAP
  const volumeBottom = volumeTop + volumeH

  let low = Infinity
  let high = -Infinity
  for (const bar of bars) {
    low = Math.min(low, bar.low)
    high = Math.max(high, bar.high)
  }
  for (const value of extraValues) {
    if (!Number.isFinite(value)) continue
    low = Math.min(low, value)
    high = Math.max(high, value)
  }

  const span = high - low
  const paddingValue = span * 0.06 || high * 0.01
  const yMax = high + paddingValue
  const yMin = Math.max(0, low - paddingValue)

  const maxVolume = Math.max(1, ...bars.map((bar) => bar.volume))
  const slot = plotW / bars.length

  const safeMin = yMax > yMin ? yMin : yMax - 1
  const useLog = logScale && safeMin > 0 && yMax > 0
  const logMin = useLog ? Math.log(safeMin) : 0
  const logSpan = useLog ? Math.log(yMax) - logMin : 1

  return {
    width,
    height,
    padding,
    plotW,
    priceTop,
    priceBottom,
    volumeBottom,
    yMax,
    yMin: safeMin,
    maxVolume,
    slot,
    bodyWidth: Math.max(1, slot * 0.6),
    x: (index: number) => padding.left + (index + 0.5) * slot,
    yPrice: (value: number) =>
      useLog
        ? priceTop + ((Math.log(yMax) - Math.log(Math.max(value, safeMin))) / logSpan) * priceH
        : priceTop + ((yMax - value) / (yMax - safeMin)) * priceH,
    priceFromY: (y: number) => {
      const ratio = (priceBottom - y) / priceH
      return useLog ? Math.exp(logMin + ratio * logSpan) : safeMin + ratio * (yMax - safeMin)
    },
    yVolume: (value: number) => volumeBottom - (value / maxVolume) * volumeH
  }
}

/* ---------------------------------------------------------------- 缩放档位 */

/**
 * K 线缩放档位（可见根数），从「看清细节」到「看清趋势」。
 *
 * 为什么用离散档位，而不是每按一次乘一个系数？
 *   · 键盘上每按一下应该有**确定**的结果，按几下就能到想要的尺度；
 *   · 档位有限，就不会出现「按住不放缩到只剩 3 根」这种失控状态。
 *
 * 相邻档位的比例约 1.2（最大 1.25）。第一版是 `160/120/80/50/30`，
 * 比例 1.5~1.67，用户实测后反馈「缩放幅度太大，一下跳太多」，于是把档次加密。
 * 代价是换档要多按几下 —— 所以滚轮（能连续滚）才是它的主要入口。
 *
 * 最大档位同时是**取数上限**：不可能显示比拉回来的更多的 K 线。
 */
export const KLINE_ZOOM_LEVELS = [
  30, 35, 40, 50, 60, 70, 85, 100, 120, 140, 160, 200, 250, 300, 375, 450, 500
] as const

/** 默认（最大）档位：显示全部 K 线，与「引入缩放之前」的行为一致 */
export const KLINE_BARS_MAX: number = KLINE_ZOOM_LEVELS[KLINE_ZOOM_LEVELS.length - 1]

export interface KLineWindow {
  /** 在全量数组里的起始下标 */
  start: number
  /** 实际可见根数 */
  count: number
}

/**
 * 把「想显示多少根」换算成「取哪一段」。
 *
 * **默认右对齐**：不传 start 时永远取最后 count 根 —— 看行情关心的是最近发生了什么。
 * 传了 start 就被钳进 `[0, total - count]`：既不能滚到数据之前，也不能滚过最新一根。
 *
 * 两条钳位：
 *   · count 不能超过实际拥有的根数（新股、停牌、取数不足都可能不够）；
 *   · 空数组直接返回 0，交给上层显示占位，别让几何计算去处理空切片。
 */
export function klineWindow(total: number, count: number, start?: number): KLineWindow {
  const safeTotal = Math.max(0, Math.floor(total))
  if (safeTotal === 0) return { start: 0, count: 0 }

  const size = Math.max(1, Math.min(safeTotal, Math.floor(count) || 1))
  const last = safeTotal - size

  const raw = start === undefined ? last : Math.floor(start)
  const safeStart = Number.isFinite(raw) ? Math.min(last, Math.max(0, raw)) : last
  return { start: safeStart, count: size }
}

/**
 * 缩放窗口，并把**锚点那一根钉在屏幕上的同一处**。
 *
 * 为什么必须有这个函数？用户实测反馈：缩放后光标指到的 K 线「漂移」了。
 * 根因是旧实现只存了相对下标，窗口一变，同一个下标就指向了另一根 K 线。
 * 主流行情软件的做法是以光标为锚点缩放 —— 两边的 K 线向它聚拢或散开
 *（见 `docs/06` 第 23 条）。
 *
 * anchor 传 null 时退回右对齐：没有光标时，缩放贴着最新一根走。
 */
export function zoomWindow(
  window: KLineWindow,
  total: number,
  nextCount: number,
  anchor: number | null
): KLineWindow {
  if (anchor === null || window.count === 0) return klineWindow(total, nextCount)

  // 锚点在窗口里的相对位置换成比例，缩放后让它落在同一个比例上
  const ratio = (anchor - window.start + 0.5) / window.count
  const start = Math.round(anchor - ratio * nextCount + 0.5)
  return klineWindow(total, nextCount, start)
}

export interface KLineCursorMove {
  /** 移动后的光标（绝对下标） */
  cursor: number
  /** 可能被一起平移的窗口 */
  window: KLineWindow
}

/**
 * 左右键移动光标。
 *
 * 三个约定，都对齐主流行情软件：
 *   1. 还没有光标时，第一次按键只把它放到**可见区最新的一根**上，不移动
 *      （相当于主流的「进入十字光标模式」，天勤是双击进入，我们不用多开一个模式）；
 *   2. 光标走到窗口边缘还继续按，**窗口跟着平移一格** —— 这样光标能一路走到
 *      任意一根，而不是卡在屏幕边上；
 *   3. 到了数据两端就停住，不环绕。
 */
export function stepCursor(
  cursor: number | null,
  delta: number,
  window: KLineWindow,
  total: number
): KLineCursorMove {
  const safeTotal = Math.max(0, Math.floor(total))
  if (safeTotal === 0 || window.count === 0) {
    return { cursor: 0, window }
  }

  if (cursor === null) {
    const newestVisible = window.start + window.count - 1
    return { cursor: Math.min(safeTotal - 1, newestVisible), window }
  }

  const next = Math.min(safeTotal - 1, Math.max(0, cursor + delta))

  // 越出窗口时，把窗口平移「最少」的格数让它重新可见（不做多余滚动）
  let start = window.start
  if (next < start) {
    start = next
  } else if (next > start + window.count - 1) {
    start = next - window.count + 1
  }

  return { cursor: next, window: klineWindow(safeTotal, window.count, start) }
}

/**
 * 鼠标 x 坐标 → 光标（绝对下标）。
 *
 * 越出绘图区时钳到两端而不是返回 null：光标不该因为手抖一下就消失。
 * 返回 null 只有一种情况 —— 还没有数据。
 */
export function cursorFromX(
  x: number,
  window: KLineWindow,
  plotLeft: number,
  plotW: number
): number | null {
  if (window.count === 0 || plotW <= 0) return null

  const ratio = (x - plotLeft) / plotW
  const index = Math.floor(ratio * window.count)
  return window.start + Math.min(window.count - 1, Math.max(0, index))
}

/**
 * 上下键换档：`in` = 放大（可见根数变少、蜡烛变宽），`out` = 缩小。
 *
 * 已经到顶 / 到底时返回原值，**不做环绕** —— 环绕会让人按久了突然跳回另一头。
 */
export function nextZoomLevel(
  current: number,
  direction: 'in' | 'out',
  levels: readonly number[] = KLINE_ZOOM_LEVELS
): number {
  const list = [...levels].sort((a, b) => a - b)
  if (list.length === 0) return current

  const candidates =
    direction === 'in'
      ? list.filter((level) => level < current) // 放大：比当前小的档位里取最大的
      : list.filter((level) => level > current) // 缩小：比当前大的档位里取最小的

  if (candidates.length > 0) {
    return direction === 'in' ? candidates[candidates.length - 1] : candidates[0]
  }
  return direction === 'in' ? list[0] : list[list.length - 1]
}

/**
 * 把任意数值吸附到最近的一档。
 *
 * 用在哪？持久化下来的档位来自上一次运行 —— 档位表改过、或设置文件被人手改过时，
 * 读回来的值可能根本不在档位上（比如 47）。先吸附再进界面，
 * 就不会出现「当前档位不在表里，上下键怎么按都别扭」的状态。
 *
 * 正好卡在两档中间时取**较小**的那一档（根数更少、蜡烛更宽），行为是确定的。
 */
export function nearestZoomLevel(
  value: number,
  levels: readonly number[] = KLINE_ZOOM_LEVELS
): number {
  if (levels.length === 0) return value
  const target = Number.isFinite(value) ? value : levels[0]
  return levels.reduce((best, level) =>
    Math.abs(level - target) < Math.abs(best - target) ? level : best
  )
}

/** 滚轮「一格」的累计量：标准鼠标滚轮一格约 100（Chrome 归一化后的像素值） */
export const WHEEL_STEP_DELTA = 100

export interface WheelStep {
  /** 这一下该换哪一档；还没攒够一格就是 null */
  direction: 'in' | 'out' | null
  /** 留到下一次的余量 */
  rest: number
}

/**
 * 滚轮累加器：`deltaY` 攒够一格才换档。
 *
 * 为什么不按事件数换档？
 *   · 鼠标滚轮一格给出约 ±100 的 `deltaY`，一次事件就是一格；
 *   · 触控板给出的是**很多个很小的 `deltaY`**，一次事件远不够一格 ——
 *     按事件数算的话，触控板轻轻一划就会从头缩到尾。
 * 统一按「累计量」判断，两种设备的手感才一致。
 *
 * 两个刻意的限制：
 *   · **一次事件最多换一档**：快速甩动滚轮不该一次跳好几档（要的就是幅度小）；
 *   · **反向滚动丢掉余量**：否则一个小回滚会带着之前的惯性触发反向换档。
 */
export function accumulateWheel(
  accumulated: number,
  deltaY: number,
  threshold: number = WHEEL_STEP_DELTA
): WheelStep {
  if (!Number.isFinite(deltaY) || deltaY === 0 || threshold <= 0) {
    return { direction: null, rest: accumulated }
  }

  const sameDirection = accumulated === 0 || Math.sign(accumulated) === Math.sign(deltaY)
  const total = (sameDirection ? accumulated : 0) + deltaY

  // 向上滚（deltaY < 0）= 放大，与 ↑ 一致
  if (total <= -threshold) return { direction: 'in', rest: 0 }
  if (total >= threshold) return { direction: 'out', rest: 0 }
  return { direction: null, rest: total }
}

/** K 线纵轴刻度：用「好看的数字」取步长 */
export function buildKLineLevels(geo: KLineGeometry): number[] {
  const step = niceAxisStep(geo.yMax - geo.yMin, 12)
  const result: number[] = []
  for (let value = Math.ceil(geo.yMin / step) * step; value <= geo.yMax; value += step) {
    result.push(Number(value.toFixed(4)))
  }
  return result
}

/** 日期轴标签：均匀取若干个 */
export function buildKLineTicks(
  bars: KLineBar[],
  maxTicks = 6
): { index: number; label: string }[] {
  if (bars.length === 0) return []
  const count = Math.min(maxTicks, bars.length)
  const ticks: { index: number; label: string }[] = []
  for (let i = 0; i < count; i++) {
    const index = Math.round((i * (bars.length - 1)) / Math.max(1, count - 1))
    ticks.push({ index, label: bars[index].date.slice(5) })
  }
  return ticks
}

/** 简单移动平均，不足周期的位置返回 null */
export function movingAverage(bars: KLineBar[], period: number): (number | null)[] {
  const result: (number | null)[] = []
  let sum = 0
  for (let index = 0; index < bars.length; index++) {
    sum += bars[index].close
    if (index >= period) sum -= bars[index - period].close
    result.push(index >= period - 1 ? sum / period : null)
  }
  return result
}

/** 把「可能有断点」的点列转成 SVG 路径（遇 null 起新段） */
export function buildLinePath(points: ({ x: number; y: number } | null)[]): string {
  let path = ''
  let pending = false
  for (const point of points) {
    if (!point) {
      pending = false
      continue
    }
    path += `${pending ? 'L' : 'M'}${round(point.x)},${round(point.y)} `
    pending = true
  }
  return path.trim()
}

/* ============================================================ 小工具 */

/** 取一个「好看」的刻度步长：1 / 2 / 5 × 10ⁿ */
/** 更密的轴步长：允许 1/1.25/1.5/2/2.5/3/4/5/6/8/10，避免总跳到 5×10ⁿ。 */
export function niceAxisStep(range: number, targetTicks = 12): number {
  const raw = range / Math.max(1, targetTicks)
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const normalized = raw / magnitude
  const steps = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  const step = steps.find((value) => value >= normalized - 1e-9) ?? 10
  return step * magnitude
}

export function niceStep(range: number, targetTicks: number): number {
  const raw = range / targetTicks
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const normalized = raw / magnitude
  const step = normalized >= 5 ? 10 : normalized >= 2 ? 5 : normalized >= 1 ? 2 : 1
  return step * magnitude
}

/** 'YYYYMMDD' → 'MM-DD' */
export function formatMonthDay(date: string): string {
  return date.length === 8 ? `${date.slice(4, 6)}-${date.slice(6, 8)}` : date
}

/**
 * 等距降采样，用于迷你走势图。
 *
 * 末尾始终保留原始序列的最后一个点 —— 它代表「最新价」，
 * 是这条线里最不能丢的信息（否则缩略图的终点会和旁边显示的现价对不上）。
 */
export function downsample(values: number[], maxPoints: number): number[] {
  if (maxPoints < 1) return []
  if (values.length <= maxPoints) return [...values]

  const step = values.length / maxPoints
  const result: number[] = []
  for (let index = 0; index < maxPoints; index++) {
    result.push(values[Math.floor(index * step)])
  }
  result[result.length - 1] = values[values.length - 1]
  return result
}

/** 统一保留两位小数，避免路径字符串里塞满浮点噪声 */
function round(value: number): string {
  return value.toFixed(2)
}

export interface KLineRangeStats {
  start: number
  end: number
  bars: number
  high: number
  low: number
  volume: number
  changePct: number
  amplitude: number
}

/** 区间统计：闭区间，按可见/绝对下标传入；越界或空区间返回 null。 */
export function klineRangeStats(
  bars: readonly KLineBar[],
  start: number,
  end: number
): KLineRangeStats | null {
  if (bars.length === 0) return null
  const from = Math.max(0, Math.min(bars.length - 1, Math.min(start, end)))
  const to = Math.max(0, Math.min(bars.length - 1, Math.max(start, end)))
  let high = -Infinity
  let low = Infinity
  let volume = 0
  for (let index = from; index <= to; index += 1) {
    high = Math.max(high, bars[index].high)
    low = Math.min(low, bars[index].low)
    volume += bars[index].volume
  }
  const base = bars[from].close
  const last = bars[to].close
  return {
    start: from,
    end: to,
    bars: to - from + 1,
    high,
    low,
    volume,
    changePct: base > 0 ? ((last - base) / base) * 100 : 0,
    amplitude: base > 0 ? ((high - low) / base) * 100 : 0
  }
}
