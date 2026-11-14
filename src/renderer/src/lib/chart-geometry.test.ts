import { describe, expect, it } from 'vitest'
import type { KLineBar, MinuteTrend } from '@shared/types'
import {
  DAY_SLOTS,
  KLINE_BARS_MAX,
  KLINE_PADDING,
  KLINE_ZOOM_LEVELS,
  TREND_PADDING,
  WHEEL_STEP_DELTA,
  accumulateWheel,
  buildKLineGeometry,
  klineRangeStats,
  buildKLineLevels,
  buildKLineTicks,
  buildLinePath,
  buildTrendAveragePath,
  buildTrendDayPaths,
  buildTrendGeometry,
  buildTrendLevels,
  buildTrendSeparators,
  buildTrendTicks,
  cursorFromX,
  downsample,
  flattenTrendPoints,
  formatMonthDay,
  klineWindow,
  locateTrendSlot,
  movingAverage,
  nearestZoomLevel,
  nextZoomLevel,
  niceAxisStep,
  niceStep,
  slotFromX,
  stepCursor,
  trendBaseline,
  zoomWindow
} from './chart-geometry'

/* ------------------------------------------------------------ fixture */

function makeDay(date: string, prices: number[], prevClose: number, avg = 0): MinuteTrend {
  return {
    code: 'sh600519',
    name: '贵州茅台',
    date,
    prevClose,
    points: prices.map((price, index) => ({
      time: String(930 + index).padStart(4, '0'),
      price,
      avg: price + avg,
      volume: 100 + index * 10
    }))
  }
}

const ONE_DAY = [makeDay('20260921', [100, 102, 101, 103, 105], 100)]
const FIVE_DAYS = [
  makeDay('20260915', [100, 101, 99], 98),
  makeDay('20260916', [99, 98, 97], 101),
  makeDay('20260917', [97, 99, 100], 97),
  makeDay('20260918', [100, 102, 101], 100),
  makeDay('20260921', [101, 103, 105], 101)
]

function makeBars(closes: number[]): KLineBar[] {
  return closes.map((close, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    open: close - 1,
    close,
    high: close + 2,
    low: close - 3,
    volume: 1000 + index * 100
  }))
}

/* ------------------------------------------------------- 摊平与基准 */

describe('flattenTrendPoints', () => {
  it('单日：槽位就是点序号', () => {
    const flat = flattenTrendPoints(ONE_DAY)
    expect(flat.map((item) => item.slot)).toEqual([0, 1, 2, 3, 4])
    expect(flat.every((item) => item.dayIndex === 0)).toBe(true)
  })

  it('多日：第 N 天从 N × 241 开始，各天不重叠', () => {
    const flat = flattenTrendPoints(FIVE_DAYS)
    expect(flat[0].slot).toBe(0)
    expect(flat[3].slot).toBe(DAY_SLOTS) // 第二天的第一个点
    expect(flat[6].slot).toBe(DAY_SLOTS * 2)
    // 槽位严格递增
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i].slot).toBeGreaterThan(flat[i - 1].slot)
    }
  })

  it('空数据返回空数组', () => {
    expect(flattenTrendPoints([])).toEqual([])
  })
})

describe('trendBaseline', () => {
  it('取最后一个交易日的昨收', () => {
    expect(trendBaseline(ONE_DAY)).toBe(100)
    expect(trendBaseline(FIVE_DAYS)).toBe(101)
  })

  it('没有数据时返回 0，不抛异常', () => {
    expect(trendBaseline([])).toBe(0)
  })
})

/* ------------------------------------------------------------ 几何 */

describe('buildTrendGeometry', () => {
  it('画布过小时返回 null，交给界面显示占位', () => {
    expect(buildTrendGeometry(ONE_DAY, 50, 400)).toBeNull()
    expect(buildTrendGeometry(ONE_DAY, 400, 50)).toBeNull()
    expect(buildTrendGeometry(ONE_DAY, 0, 0)).toBeNull()
  })

  it('没有数据时返回 null', () => {
    expect(buildTrendGeometry([], 800, 400)).toBeNull()
    expect(buildTrendGeometry([makeDay('20260921', [], 100)], 800, 400)).toBeNull()
  })

  it('横轴两端精确对齐绘图区左右边界', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    expect(geo.x(0)).toBeCloseTo(TREND_PADDING.left, 5)
    expect(geo.x(geo.totalSlots)).toBeCloseTo(800 - TREND_PADDING.right, 5)
  })

  it('单日：纵轴严格以昨收为中心对称', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    const baseline = 100
    expect(geo.yMax - baseline).toBeCloseTo(baseline - geo.yMin, 6)
    // 基准线落在价格区正中
    const center = (geo.priceTop + geo.priceBottom) / 2
    expect(geo.yPrice(baseline)).toBeCloseTo(center, 5)
  })

  it('单日：全天几乎不动时也不会除以 0', () => {
    const flatDay = [makeDay('20260921', [100, 100, 100], 100)]
    const geo = buildTrendGeometry(flatDay, 800, 400)!
    expect(Number.isFinite(geo.yPrice(100))).toBe(true)
    expect(geo.yMax).toBeGreaterThan(geo.yMin)
  })

  it('多日：纵轴覆盖全部交易日的最高最低价', () => {
    const geo = buildTrendGeometry(FIVE_DAYS, 800, 400)!
    const prices = FIVE_DAYS.flatMap((day) => day.points.map((point) => point.price))
    expect(geo.yMax).toBeGreaterThanOrEqual(Math.max(...prices))
    expect(geo.yMin).toBeLessThanOrEqual(Math.min(...prices))
  })

  it('多日：横轴槽位数为 天数 × 241 - 1', () => {
    const geo = buildTrendGeometry(FIVE_DAYS, 800, 400)!
    expect(geo.totalSlots).toBe(FIVE_DAYS.length * DAY_SLOTS - 1)
  })

  it('三个区域自上而下依次排布且不重叠', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    expect(geo.priceTop).toBeLessThan(geo.priceBottom)
    expect(geo.priceBottom).toBeLessThan(geo.volumeTop)
    expect(geo.volumeTop).toBeLessThan(geo.volumeBottom)
    expect(geo.volumeBottom).toBeLessThanOrEqual(400 - TREND_PADDING.bottom + 0.001)
  })

  it('价格越高纵坐标越小（y 轴向下）', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    expect(geo.yPrice(geo.yMax)).toBeLessThan(geo.yPrice(geo.yMin))
  })

  it('缩放到指定槽位时横轴/纵轴只按可见点计算', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400, undefined, { start: 1, end: 3 })!
    expect(geo.slotStart).toBe(1)
    expect(geo.slotEnd).toBe(3)
    expect(geo.totalSlots).toBe(2)
    expect(geo.x(1)).toBeCloseTo(TREND_PADDING.left, 5)
    expect(geo.x(3)).toBeCloseTo(800 - TREND_PADDING.right, 5)
    expect(geo.yMax).toBeGreaterThan(103)
    const path = buildTrendDayPaths(ONE_DAY, geo)[0]
    expect(path.line.match(/M/g)?.length).toBe(1)
    expect(path.line.match(/L/g)?.length).toBe(2)
    expect(buildTrendAveragePath(ONE_DAY, geo).startsWith('M')).toBe(true)
    expect(slotFromX(geo.x(2), 0, geo)).toBe(2)
  })

  it('缩放范围没有数据时回退到全量，避免空图', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400, undefined, { start: 100, end: 120 })!
    expect(geo.slotStart).toBe(0)
    expect(geo.slotEnd).toBe(DAY_SLOTS - 1)
    expect(geo.totalSlots).toBe(DAY_SLOTS - 1)
  })

  it('五日分时也能缩放到某一天的一段', () => {
    const geo = buildTrendGeometry(FIVE_DAYS, 800, 400, undefined, {
      start: DAY_SLOTS + 1,
      end: DAY_SLOTS + 2
    })!
    expect(geo.slotStart).toBe(DAY_SLOTS + 1)
    expect(geo.slotEnd).toBe(DAY_SLOTS + 2)
    const paths = buildTrendDayPaths(FIVE_DAYS, geo)
    expect(paths[0].line).toBe('')
    expect(paths[1].line.match(/M/g)?.length).toBe(1)
    expect(paths[1].line.match(/L/g)?.length).toBe(1)
  })

  it('成交量柱宽度至少 1px（五日时每格很窄）', () => {
    const narrow = buildTrendGeometry(FIVE_DAYS, 200, 400)!
    expect(narrow.barWidth).toBeGreaterThanOrEqual(1)
  })

  it('成交量最大值兜底为 1，避免除以 0', () => {
    const zeroVolume: MinuteTrend[] = [
      {
        ...makeDay('20260921', [100], 100),
        points: [{ time: '0930', price: 100, avg: 100, volume: 0 }]
      }
    ]
    const geo = buildTrendGeometry(zeroVolume, 800, 400)!
    expect(geo.maxVolume).toBe(1)
    expect(Number.isFinite(geo.yVolume(0))).toBe(true)
  })
})

/* ---------------------------------------------------------- 纵轴刻度 */

describe('buildTrendLevels', () => {
  it('单日：一定包含昨收基准线，且 pct 为 0', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    const levels = buildTrendLevels(ONE_DAY, geo)
    const baseline = levels.find((level) => level.pct === 0)
    expect(baseline).toBeDefined()
    expect(baseline!.value).toBeCloseTo(100, 6)
    expect(levels.length).toBeGreaterThanOrEqual(5)
  })

  it('短窗口仍能生成刻度且不越界', () => {
    const short = buildTrendGeometry(ONE_DAY, 800, 200)!
    const levels = buildTrendLevels(ONE_DAY, short)
    expect(levels.length).toBeGreaterThanOrEqual(3)
    for (const level of levels) {
      expect(level.value).toBeGreaterThanOrEqual(short.yMin - 1e-9)
      expect(level.value).toBeLessThanOrEqual(short.yMax + 1e-9)
    }
  })

  it('单日：围绕基准线上下成对出现', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    const levels = buildTrendLevels(ONE_DAY, geo)
    const ups = levels.filter((level) => (level.pct ?? 0) > 0)
    const downs = levels.filter((level) => (level.pct ?? 0) < 0)
    expect(ups.length).toBe(downs.length)
  })

  it('单日：所有刻度都落在纵轴范围内', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    for (const level of buildTrendLevels(ONE_DAY, geo)) {
      expect(level.value).toBeGreaterThanOrEqual(geo.yMin - 1e-9)
      expect(level.value).toBeLessThanOrEqual(geo.yMax + 1e-9)
    }
  })

  it('单日：刻度从高到低排序（与 y 轴方向一致）', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    const values = buildTrendLevels(ONE_DAY, geo).map((level) => level.value)
    const sorted = [...values].sort((a, b) => b - a)
    expect(values).toEqual(sorted)
  })

  it('多日：没有统一基准，pct 一律为 null', () => {
    const geo = buildTrendGeometry(FIVE_DAYS, 800, 400)!
    const levels = buildTrendLevels(FIVE_DAYS, geo)
    expect(levels.length).toBeGreaterThan(0)
    expect(levels.every((level) => level.pct === null)).toBe(true)
  })

  it('昨收缺失（为 0）时回退到当天首个分时价，刻度照常可用', () => {
    // 这是有意的防御：接口没给昨收时不能让整个纵轴塌掉
    const broken = [makeDay('20260921', [100, 101], 0)]
    const geo = buildTrendGeometry(broken, 800, 400)!
    const levels = buildTrendLevels(broken, geo)
    expect(levels.length).toBeGreaterThan(0)
    expect(levels.find((level) => level.pct === 0)!.value).toBeCloseTo(100, 6)
  })

  it('价格本身为 0（脏数据）时返回空数组而不是除以 0', () => {
    const garbage: MinuteTrend[] = [
      {
        code: 'sh600519',
        name: '脏数据',
        date: '20260921',
        prevClose: 0,
        points: [{ time: '0930', price: 0, avg: 0, volume: 0 }]
      }
    ]
    const geo = buildTrendGeometry(garbage, 800, 400)!
    expect(buildTrendLevels(garbage, geo)).toEqual([])
  })
})

/* -------------------------------------------------------- 横轴与路径 */

describe('buildTrendTicks', () => {
  it('单日：给出五个时间刻，首尾对齐两端', () => {
    const ticks = buildTrendTicks(ONE_DAY)
    expect(ticks.map((tick) => tick.label)).toEqual([
      '09:30',
      '10:30',
      '11:30/13:00',
      '14:00',
      '15:00'
    ])
    expect(ticks[0].anchor).toBe('start')
    expect(ticks[ticks.length - 1].anchor).toBe('end')
  })

  it('多日：每个交易日一个 MM-DD 标签', () => {
    const ticks = buildTrendTicks(FIVE_DAYS)
    expect(ticks.map((tick) => tick.label)).toEqual(['09-15', '09-16', '09-17', '09-18', '09-21'])
    expect(ticks[1].slot).toBe(DAY_SLOTS)
  })
})

describe('buildTrendSeparators', () => {
  it('单日不画分隔线', () => {
    expect(buildTrendSeparators(ONE_DAY)).toEqual([])
  })

  it('五日给出 4 条分隔线', () => {
    expect(buildTrendSeparators(FIVE_DAYS)).toEqual([
      DAY_SLOTS,
      DAY_SLOTS * 2,
      DAY_SLOTS * 3,
      DAY_SLOTS * 4
    ])
  })
})

describe('buildTrendDayPaths', () => {
  it('每天段的颜色按「当天收盘 vs 当天昨收」判定', () => {
    const geo = buildTrendGeometry(FIVE_DAYS, 800, 400)!
    const paths = buildTrendDayPaths(FIVE_DAYS, geo)
    // 第一天 99 vs 昨收 98 → 涨
    expect(paths[0].tone).toBe('up')
    // 第二天 97 vs 昨收 101 → 跌
    expect(paths[1].tone).toBe('down')
  })

  it('路径以 M 开头，面积路径以 Z 收尾', () => {
    const geo = buildTrendGeometry(FIVE_DAYS, 800, 400)!
    const paths = buildTrendDayPaths(FIVE_DAYS, geo)
    for (const path of paths) {
      expect(path.line.startsWith('M')).toBe(true)
      expect(path.area.endsWith('Z')).toBe(true)
      expect(path.area.startsWith(path.line)).toBe(true)
    }
  })

  it('空的一天产生空路径而不是崩溃', () => {
    const withEmpty = [makeDay('20260921', [], 100), ...ONE_DAY]
    const geo = buildTrendGeometry(withEmpty, 800, 400)!
    const paths = buildTrendDayPaths(withEmpty, geo)
    expect(paths[0].line).toBe('')
    expect(paths[0].area).toBe('')
  })

  it('均价线路径贯穿所有交易日', () => {
    const geo = buildTrendGeometry(FIVE_DAYS, 800, 400)!
    const path = buildTrendAveragePath(FIVE_DAYS, geo)
    // 每天都以 M 起新段（多日时是 5 段）
    expect(path.match(/M/g)?.length).toBe(FIVE_DAYS.length)
  })
})

/* ---------------------------------------------------------- 槽位定位 */

describe('locateTrendSlot', () => {
  it('单日：槽位直接对应点序号', () => {
    expect(locateTrendSlot(0, ONE_DAY)).toEqual({ dayIndex: 0, pointIndex: 0 })
    expect(locateTrendSlot(3, ONE_DAY)).toEqual({ dayIndex: 0, pointIndex: 3 })
  })

  it('多日：跨过 241 就进入第二天', () => {
    expect(locateTrendSlot(DAY_SLOTS, FIVE_DAYS)).toEqual({ dayIndex: 1, pointIndex: 0 })
    expect(locateTrendSlot(DAY_SLOTS + 2, FIVE_DAYS)).toEqual({ dayIndex: 1, pointIndex: 2 })
  })

  it('超出该日实际点数时钳位到最后一个点', () => {
    // 每一天只有 3 个点，槽位 200 属于第一天但远超其点数
    expect(locateTrendSlot(200, FIVE_DAYS)).toEqual({ dayIndex: 0, pointIndex: 2 })
  })

  it('超出整条横轴时钳位到最后一个交易日的最后一个点', () => {
    expect(locateTrendSlot(99999, FIVE_DAYS)).toEqual({ dayIndex: 4, pointIndex: 2 })
  })

  it('负数槽位钳位到起点', () => {
    expect(locateTrendSlot(-50, FIVE_DAYS)).toEqual({ dayIndex: 0, pointIndex: 0 })
  })

  it('非法输入返回 null', () => {
    expect(locateTrendSlot(10, [])).toBeNull()
    expect(locateTrendSlot(NaN, FIVE_DAYS)).toBeNull()
    expect(locateTrendSlot(0, [makeDay('20260921', [], 100)])).toBeNull()
  })
})

describe('slotFromX', () => {
  it('左边界对应槽位 0，右边界对应最后一个槽位', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    expect(slotFromX(TREND_PADDING.left, 0, geo)).toBe(0)
    expect(slotFromX(800 - TREND_PADDING.right, 0, geo)).toBe(geo.totalSlots)
  })

  it('容器有偏移时依然正确（剔除容器左边距与画布留白）', () => {
    const geo = buildTrendGeometry(ONE_DAY, 800, 400)!
    expect(slotFromX(120 + TREND_PADDING.left, 120, geo)).toBe(0)
  })
})

/* ------------------------------------------------------------ K 线 */

describe('buildKLineGeometry', () => {
  const bars = makeBars([10, 12, 11, 13, 15, 14, 16, 18, 17, 19])

  it('区间统计闭区间且越界钳位', () => {
    const stats = klineRangeStats(bars, 2, 5)!
    expect(stats.bars).toBe(4)
    expect(stats.high).toBe(Math.max(...bars.slice(2, 6).map((bar) => bar.high)))
    expect(stats.volume).toBe(bars.slice(2, 6).reduce((sum, bar) => sum + bar.volume, 0))
    expect(klineRangeStats(bars, 99, 100)).not.toBeNull()
  })

  it('空数据或画布过小返回 null', () => {
    expect(buildKLineGeometry([], 800, 400)).toBeNull()
    expect(buildKLineGeometry(bars, 60, 400)).toBeNull()
    expect(buildKLineGeometry(bars, 800, 60)).toBeNull()
  })

  it('纵轴覆盖全部最高最低价', () => {
    const geo = buildKLineGeometry(bars, 800, 400)!
    expect(geo.yMax).toBeGreaterThanOrEqual(Math.max(...bars.map((bar) => bar.high)))
    expect(geo.yMin).toBeLessThanOrEqual(Math.min(...bars.map((bar) => bar.low)))
  })

  it('对数坐标保持高低价顺序', () => {
    const geo = buildKLineGeometry(bars, 800, 400, undefined, [], true)!
    expect(geo.yPrice(geo.yMax)).toBeLessThan(geo.yPrice(geo.yMin))
    expect(geo.yPrice(10)).toBeGreaterThan(geo.yPrice(20))
  })

  it('额外指标值扩展纵轴范围', () => {
    const geo = buildKLineGeometry(bars, 800, 400, undefined, [100])!
    expect(geo.yMax).toBeGreaterThanOrEqual(100)
  })

  it('每根 K 线居中于自己的槽位', () => {
    const geo = buildKLineGeometry(bars, 800, 400)!
    const first = geo.x(0)
    const second = geo.x(1)
    expect(second - first).toBeCloseTo(geo.slot, 6)
    expect(first - KLINE_PADDING.left).toBeCloseTo(geo.slot / 2, 6)
  })

  it('实体宽度至少 1px（K 线很多时）', () => {
    const many = makeBars(Array.from({ length: 300 }, (_, index) => 10 + Math.sin(index) * 3))
    const geo = buildKLineGeometry(many, 300, 400)!
    expect(geo.bodyWidth).toBeGreaterThanOrEqual(1)
  })

  it('成交量区在价格区下方', () => {
    const geo = buildKLineGeometry(bars, 800, 400)!
    expect(geo.priceBottom).toBeLessThan(geo.volumeBottom)
  })
})

/**
 * 缩放档位带来的**视觉**后果，用数字固化下来。
 *
 * 为什么值得写这条？「蜡烛看起来粗细合适吗」本来只能靠肉眼，
 * 但「宽度落在什么区间」是能算的 —— 算出来就能进回归测试，
 * 以后谁加了离谱的档位（比如 5 根或 500 根），这里会先炸。
 */
describe('缩放档位对应的蜡烛宽度', () => {
  // 中间栏的真实宽度区间：1024 最小窗口下约 420px，1280 窗口下约 700px
  const WIDTHS = [420, 560, 700, 900]
  const bars = makeBars(Array.from({ length: KLINE_BARS_MAX }, (_, index) => 100 + index))

  const widthAt = (level: number, width: number): number => {
    const { start, count } = klineWindow(bars.length, level)
    const geo = buildKLineGeometry(bars.slice(start, start + count), width, 420)
    return geo!.bodyWidth
  }

  it('根数越少蜡烛越宽，单调且肉眼可辨', () => {
    const widths = KLINE_ZOOM_LEVELS.map((level) => widthAt(level, 700))
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeLessThanOrEqual(widths[i - 1])
    }
  })

  it('最密与最疏两档相差 3 倍以上，缩放才有意义', () => {
    const ratio = widthAt(KLINE_ZOOM_LEVELS[0], 700) / widthAt(KLINE_BARS_MAX, 700)
    expect(ratio).toBeGreaterThan(3)
  })

  it('任何档位、任何宽度下，蜡烛都既不会看不见也不会糊成一片', () => {
    for (const width of WIDTHS) {
      for (const level of KLINE_ZOOM_LEVELS) {
        const body = widthAt(level, width)
        expect(body).toBeGreaterThanOrEqual(1) // 下限：最密时仍有实体
        expect(body).toBeLessThanOrEqual(20) // 上限：再粗就不像 K 线了
      }
    }
  })
})

describe('buildKLineLevels', () => {
  it('刻度递增且落在纵轴范围内', () => {
    const bars = makeBars([10, 12, 11, 13, 15, 14, 16, 18, 17, 19])
    const geo = buildKLineGeometry(bars, 800, 400)!
    const levels = buildKLineLevels(geo)
    expect(levels.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThan(levels[i - 1])
    }
    expect(levels[0]).toBeGreaterThanOrEqual(geo.yMin)
    expect(levels[levels.length - 1]).toBeLessThanOrEqual(geo.yMax)
  })
})

describe('buildKLineTicks', () => {
  it('首尾必然是第一根与最后一根', () => {
    const bars = makeBars(Array.from({ length: 50 }, (_, index) => 10 + index * 0.1))
    const ticks = buildKLineTicks(bars)
    expect(ticks[0].index).toBe(0)
    expect(ticks[ticks.length - 1].index).toBe(bars.length - 1)
    expect(ticks.length).toBeLessThanOrEqual(6)
  })

  it('数据少于刻度数时不会重复', () => {
    const bars = makeBars([10, 11, 12])
    const ticks = buildKLineTicks(bars)
    expect(new Set(ticks.map((tick) => tick.index)).size).toBe(ticks.length)
  })

  it('空数据返回空数组', () => {
    expect(buildKLineTicks([])).toEqual([])
  })
})

describe('movingAverage', () => {
  it('前 period-1 个位置为 null，之后是算术平均', () => {
    const bars = makeBars([1, 2, 3, 4, 5])
    const ma = movingAverage(bars, 3)
    expect(ma[0]).toBeNull()
    expect(ma[1]).toBeNull()
    expect(ma[2]).toBeCloseTo(2, 6)
    expect(ma[3]).toBeCloseTo(3, 6)
    expect(ma[4]).toBeCloseTo(4, 6)
  })

  it('周期为 1 时等于自身', () => {
    const bars = makeBars([5, 7, 9])
    expect(movingAverage(bars, 1)).toEqual([5, 7, 9])
  })

  it('数据不足一个周期时全是 null', () => {
    const bars = makeBars([1, 2])
    expect(movingAverage(bars, 5)).toEqual([null, null])
  })
})

describe('buildLinePath', () => {
  it('遇到 null 会另起一段 M', () => {
    const path = buildLinePath([{ x: 0, y: 0 }, { x: 1, y: 1 }, null, { x: 2, y: 2 }])
    expect(path).toBe('M0.00,0.00 L1.00,1.00 M2.00,2.00')
  })

  it('全是 null 时返回空串', () => {
    expect(buildLinePath([null, null])).toBe('')
  })
})

/* ------------------------------------------------------------ 工具 */

describe('niceAxisStep', () => {
  it('比 1/2/5 更细，能给出 25/30/40 等步长', () => {
    expect(niceAxisStep(300, 12)).toBe(25)
    expect(niceAxisStep(400, 12)).toBe(40)
    expect(niceAxisStep(0, 12)).toBe(1)
  })
})

describe('niceStep', () => {
  it('步长永远是 1 / 2 / 5 × 10ⁿ', () => {
    for (const range of [0.7, 3, 12, 45, 130, 900, 4200]) {
      const step = niceStep(range, 5)
      const magnitude = Math.pow(10, Math.floor(Math.log10(step)))
      expect([1, 2, 5, 10]).toContain(Math.round(step / magnitude))
    }
  })

  it('非法输入返回 1 而不是 NaN', () => {
    expect(niceStep(0, 5)).toBe(1)
    expect(niceStep(-5, 5)).toBe(1)
    expect(niceStep(NaN, 5)).toBe(1)
  })
})

describe('formatMonthDay', () => {
  it('YYYYMMDD 转 MM-DD', () => {
    expect(formatMonthDay('20260921')).toBe('09-21')
  })

  it('格式不符时原样返回', () => {
    expect(formatMonthDay('2026-09-21')).toBe('2026-09-21')
  })
})

describe('downsample（迷你走势图降采样）', () => {
  it('点数不超上限时原样返回（且是副本，不共享引用）', () => {
    const values = [1, 2, 3]
    const result = downsample(values, 10)
    expect(result).toEqual([1, 2, 3])
    expect(result).not.toBe(values)
  })

  it('降采样后长度正好等于上限', () => {
    const values = Array.from({ length: 241 }, (_, index) => index)
    expect(downsample(values, 60)).toHaveLength(60)
  })

  it('末尾始终保留最新价（否则终点会和旁边的现价对不上）', () => {
    const values = Array.from({ length: 241 }, (_, index) => index)
    const result = downsample(values, 60)
    expect(result[result.length - 1]).toBe(240)
  })

  it('保留首点', () => {
    const values = Array.from({ length: 241 }, (_, index) => index)
    expect(downsample(values, 60)[0]).toBe(0)
  })

  it('上限为 0 时返回空数组而不是崩溃', () => {
    expect(downsample([1, 2, 3], 0)).toEqual([])
    expect(downsample([1, 2, 3], -1)).toEqual([])
  })

  it('恰好等于上限时不改动', () => {
    const values = [1, 2, 3, 4]
    expect(downsample(values, 4)).toEqual([1, 2, 3, 4])
  })
})

describe('klineWindow（可见窗口）', () => {
  it('右对齐：永远取最后 N 根', () => {
    expect(klineWindow(160, 50)).toEqual({ start: 110, count: 50 })
  })

  it('start + count 恒等于总数（右对齐不变量）', () => {
    for (const total of [1, 7, 40, 160]) {
      for (const count of [1, 30, 160, 999]) {
        const { start, count: size } = klineWindow(total, count)
        expect(start + size).toBe(total)
      }
    }
  })

  it('要求显示全部时从 0 开始', () => {
    expect(klineWindow(160, 160)).toEqual({ start: 0, count: 160 })
  })

  it('数据不足时钳到实际根数（新股 / 停牌 / 取数不足）', () => {
    expect(klineWindow(40, 160)).toEqual({ start: 0, count: 40 })
    expect(klineWindow(12, 30)).toEqual({ start: 0, count: 12 })
  })

  it('空数组返回 0，交给上层显示占位', () => {
    expect(klineWindow(0, 50)).toEqual({ start: 0, count: 0 })
  })

  it('非法档位不会算出负数或 0 根', () => {
    for (const bad of [0, -5, NaN, 0.4]) {
      const { count, start } = klineWindow(160, bad)
      expect(count).toBeGreaterThanOrEqual(1)
      expect(start).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('缩放档位表本身', () => {
  it('严格递增，都能显示（大于 0）', () => {
    for (let i = 1; i < KLINE_ZOOM_LEVELS.length; i++) {
      expect(KLINE_ZOOM_LEVELS[i]).toBeGreaterThan(KLINE_ZOOM_LEVELS[i - 1])
    }
    expect(KLINE_ZOOM_LEVELS[0]).toBeGreaterThan(0)
  })

  it('相邻档位的比例不超过 1.25 —— 用户要的「缩放幅度小一点」就是这条', () => {
    // 第一版是 160/120/80/50/30，比例到 1.67，用户实测反馈「一下跳太多」。
    for (let i = 1; i < KLINE_ZOOM_LEVELS.length; i++) {
      const ratio = KLINE_ZOOM_LEVELS[i] / KLINE_ZOOM_LEVELS[i - 1]
      expect(ratio).toBeLessThanOrEqual(1.25)
    }
  })

  it('从最宽到最细要按足够多下（说明档次确实加密了）', () => {
    expect(KLINE_ZOOM_LEVELS.length).toBeGreaterThanOrEqual(8)
  })
})

describe('nearestZoomLevel（把持久化的档位吸附回档位表）', () => {
  it('本来就在档位上就原样返回', () => {
    for (const level of KLINE_ZOOM_LEVELS) {
      expect(nearestZoomLevel(level)).toBe(level)
    }
  })

  it('不在档位上时取最近的一档', () => {
    expect(nearestZoomLevel(47)).toBe(50)
    expect(nearestZoomLevel(32)).toBe(30)
    expect(nearestZoomLevel(159)).toBe(160) // 旧版本的 160 读数
  })

  it('正好卡在两档中间时取较小的一档（行为确定，不来回抖）', () => {
    expect(nearestZoomLevel(45)).toBe(40) // 40 与 50 的中点
    expect(nearestZoomLevel(1)).toBe(30)
    expect(nearestZoomLevel(9999)).toBe(KLINE_BARS_MAX)
  })

  it('脏数据不崩：NaN 落到最小档，空表原样返回', () => {
    expect(nearestZoomLevel(Number.NaN)).toBe(KLINE_ZOOM_LEVELS[0])
    expect(nearestZoomLevel(47, [])).toBe(47)
  })
})

describe('accumulateWheel（滚轮累加换档）', () => {
  it('鼠标滚轮一格（±100）正好换一档，向上滚是放大', () => {
    expect(accumulateWheel(0, -WHEEL_STEP_DELTA)).toEqual({ direction: 'in', rest: 0 })
    expect(accumulateWheel(0, WHEEL_STEP_DELTA)).toEqual({ direction: 'out', rest: 0 })
  })

  it('触控板那种「很多个小 deltaY」要攒够一格才换档', () => {
    let accumulated = 0
    let steps = 0
    // 10 次 -10 才够一格：前 9 次都不动
    for (let i = 0; i < 10; i++) {
      const result = accumulateWheel(accumulated, -10)
      accumulated = result.rest
      if (result.direction) steps++
    }
    expect(steps).toBe(1)
    expect(accumulated).toBe(0)
  })

  it('快速甩动时一次事件最多换一档（不跳档）', () => {
    expect(accumulateWheel(0, -1000)).toEqual({ direction: 'in', rest: 0 })
  })

  it('反向滚动丢掉余量，不带惯性触发反向换档', () => {
    // 先往上攒了 -80，再往下滚满一格：应当立刻缩小。
    // 若余量不丢（-80 + 100 = 20），这一下就会被吞掉 —— 这个用例专门分辨这件事。
    expect(accumulateWheel(-80, 100)).toEqual({ direction: 'out', rest: 0 })
  })

  it('没攒够就把余量留着；deltaY 为 0 时什么都不变', () => {
    expect(accumulateWheel(0, -40)).toEqual({ direction: null, rest: -40 })
    expect(accumulateWheel(-40, 0)).toEqual({ direction: null, rest: -40 })
    expect(accumulateWheel(-40, Number.NaN)).toEqual({ direction: null, rest: -40 })
  })

  it('阈值可配置，阈值非法就不换档', () => {
    expect(accumulateWheel(0, -10, 5)).toEqual({ direction: 'in', rest: 0 })
    expect(accumulateWheel(0, -1000, 0)).toEqual({ direction: null, rest: 0 })
  })
})

describe('nextZoomLevel（上下键换档）', () => {
  it('放大时可见根数一路变少，正好走完整个档位表', () => {
    let level = KLINE_BARS_MAX
    const seen: number[] = [level]
    for (let i = 0; i < KLINE_ZOOM_LEVELS.length - 1; i++) {
      level = nextZoomLevel(level, 'in')
      seen.push(level)
    }
    expect(seen).toEqual([...KLINE_ZOOM_LEVELS].reverse())
    // 顺带钉住头几步：表被改动时这条测试不该变成「怎么都对」
    expect(seen.slice(0, 3)).toEqual([500, 450, 375])
  })

  it('缩小时可见根数一路变多，正好是放大的逆序', () => {
    let level: number = KLINE_ZOOM_LEVELS[0]
    const seen: number[] = [level]
    for (let i = 0; i < KLINE_ZOOM_LEVELS.length - 1; i++) {
      level = nextZoomLevel(level, 'out')
      seen.push(level)
    }
    expect(seen).toEqual([...KLINE_ZOOM_LEVELS])
  })

  it('到顶 / 到底后按不动，不环绕', () => {
    expect(nextZoomLevel(30, 'in')).toBe(30)
    expect(nextZoomLevel(KLINE_BARS_MAX, 'out')).toBe(KLINE_BARS_MAX)
  })

  it('当前值不在档位上（被数据量钳过）也能继续换档', () => {
    // 只有 37 根时，界面上的档位其实是 37（klineWindow 钳出来的）
    expect(nextZoomLevel(37, 'in')).toBe(35)
    expect(nextZoomLevel(37, 'out')).toBe(40)
    // 再缩小会给出 40，但 klineWindow 会把它钳回 37 —— 表现就是「按了没反应」
    expect(klineWindow(37, 40).count).toBe(37)
  })

  it('档位表可以替换，且不要求有序', () => {
    expect(nextZoomLevel(100, 'in', [200, 10, 50])).toBe(50)
    expect(nextZoomLevel(100, 'out', [200, 10, 50])).toBe(200)
  })

  it('空档位表返回原值，不崩', () => {
    expect(nextZoomLevel(80, 'in', [])).toBe(80)
    expect(nextZoomLevel(80, 'out', [])).toBe(80)
  })

  it('最大档位就是取数上限（不可能显示比拉回来的更多）', () => {
    expect(KLINE_BARS_MAX).toBe(Math.max(...KLINE_ZOOM_LEVELS))
  })
})

describe('klineWindow 的 start 参数（窗口可以平移了）', () => {
  it('不传 start 时仍是右对齐（默认行为不变）', () => {
    expect(klineWindow(160, 50)).toEqual({ start: 110, count: 50 })
  })

  it('传了 start 就按它取，并钳进 [0, total - count]', () => {
    expect(klineWindow(160, 50, 40)).toEqual({ start: 40, count: 50 })
    expect(klineWindow(160, 50, -20)).toEqual({ start: 0, count: 50 }) // 不能滚到数据之前
    expect(klineWindow(160, 50, 999)).toEqual({ start: 110, count: 50 }) // 不能滚过最新一根
  })
})

describe('zoomWindow（以光标为锚点缩放）', () => {
  const total = 160
  // 锚点在窗口里的相对位置；容差 1 位小数是因为 start 必须是整数，
  // 缩放后最多差不到一根 K 线的位置 —— 人眼看不出来，但「指到的 K 线换了」能看出来。
  const fraction = (anchor: number, w: { start: number; count: number }): number =>
    (anchor - w.start + 0.5) / w.count

  it('光标在中间（两侧都有数据）时，缩放前后它在屏幕上的位置完全不变', () => {
    const before = klineWindow(total, 80, 40) // 40..120
    const anchor = before.start + 40 // 屏幕正中那一根

    for (const nextCount of [30, 50, 120, 160]) {
      const after = zoomWindow(before, total, nextCount, anchor)
      expect(after.count).toBe(nextCount)
      expect(fraction(anchor, after)).toBeCloseTo(fraction(anchor, before), 1)
    }
  })

  it('贴着右端时位置只能钳位，但光标必须还在窗口里', () => {
    // 「位置完全不动」与「右侧不留白」是互斥的：要完全不动，就得允许窗口滚过最新一根、
    // 在右边空出一块（主流软件里那是 End 键切换的另一个功能）。
    // 这里选择贴合数据，代价是贴边缩放时光标在屏幕上会挪一点 —— 但它指的仍是同一根。
    const before = klineWindow(total, 80) // 80..160，已贴右端
    const anchor = before.start + 20

    for (const nextCount of [30, 50, 120, 160]) {
      const after = zoomWindow(before, total, nextCount, anchor)
      expect(after.count).toBe(nextCount)
      // 硬性要求一：光标还在窗口里，不会跑到屏幕外
      expect(anchor).toBeGreaterThanOrEqual(after.start)
      expect(anchor).toBeLessThan(after.start + after.count)
      // 硬性要求二：窗口不会滚过最新一根
      expect(after.start + after.count).toBeLessThanOrEqual(total)
    }
  })

  it('没有锚点时退回右对齐（贴着最新一根缩放）', () => {
    expect(zoomWindow(klineWindow(total, 160), total, 50, null)).toEqual({ start: 110, count: 50 })
  })

  it('锚点在最右端时，放大后依然贴着右端', () => {
    expect(zoomWindow(klineWindow(total, 160), total, 50, total - 1)).toEqual({
      start: 110,
      count: 50
    })
  })

  it('锚点靠近左端时不会滚到数据之前', () => {
    const before = klineWindow(total, 80)
    const after = zoomWindow(before, total, 30, before.start + 1)
    expect(after.start).toBeGreaterThanOrEqual(0)
    expect(after.start + after.count).toBeLessThanOrEqual(total)
  })
})

describe('stepCursor（左右键移动光标）', () => {
  const total = 160

  it('还没有光标时，第一次按键只把它放到可见区最新一根上，不移动', () => {
    const w = klineWindow(total, 50)
    expect(stepCursor(null, -1, w, total)).toEqual({ cursor: 159, window: w })
    expect(stepCursor(null, 1, w, total)).toEqual({ cursor: 159, window: w })
  })

  it('窗口内逐根移动时，窗口不动', () => {
    const w = klineWindow(total, 50)
    expect(stepCursor(159, -1, w, total)).toEqual({ cursor: 158, window: w })
  })

  it('走到窗口左缘再按，窗口跟着平移（否则光标会卡在屏幕边上）', () => {
    const w = klineWindow(total, 50) // 110..160
    const moved = stepCursor(110, -1, w, total)
    expect(moved.cursor).toBe(109)
    expect(moved.window).toEqual({ start: 109, count: 50 })
  })

  it('一直往左能走到第一根，然后停住', () => {
    let cursor: number | null = 159
    let w = klineWindow(total, 30)
    for (let i = 0; i < 500; i++) {
      const next = stepCursor(cursor, -1, w, total)
      cursor = next.cursor
      w = next.window
    }
    expect(cursor).toBe(0)
    expect(w).toEqual({ start: 0, count: 30 })
  })

  it('往右到最新一根后停住，不环绕', () => {
    expect(stepCursor(159, 1, klineWindow(total, 30), total).cursor).toBe(159)
  })

  it('空数据不崩', () => {
    expect(stepCursor(null, -1, klineWindow(0, 30), 0).cursor).toBe(0)
  })
})

describe('cursorFromX（鼠标位置 → 光标）', () => {
  const window = klineWindow(160, 50) // 110..160

  it('映射成窗口内的绝对下标', () => {
    expect(cursorFromX(5, window, 0, 500)).toBe(110)
    expect(cursorFromX(495, window, 0, 500)).toBe(159)
  })

  it('越出绘图区时钳到两端，而不是返回 null —— 手抖不该让光标消失', () => {
    expect(cursorFromX(-100, window, 0, 500)).toBe(110)
    expect(cursorFromX(9999, window, 0, 500)).toBe(159)
  })

  it('没有数据时返回 null', () => {
    expect(cursorFromX(10, klineWindow(0, 50), 0, 500)).toBeNull()
    expect(cursorFromX(10, window, 0, 0)).toBeNull()
  })
})
