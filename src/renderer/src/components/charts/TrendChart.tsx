/**
 * 分时图（纯 SVG 手绘，零依赖）。支持 1 日与多日（五日分时）。
 *
 * 几个「像专业软件」的细节：
 *  1. 横轴按交易日固定分格：一天 241 个分钟点。盘中只画到当前时刻、
 *     右侧留白，而不是把已有数据拉伸铺满整个宽度；
 *  2. 单日时纵轴以昨收为中心上下对称，右轴同时给「价格」和「涨跌幅」两套刻度；
 *     多日时改用价格区间 + 好看的数字刻度，并按天分段上色；
 *  3. 下方叠一条成交量柱，颜色跟随该分钟的涨跌方向；
 *  4. 十字光标 + 浮层读数，并可通过 onHover 回调把读数抛给外部（标题区联动）。
 *
 * 所有的坐标换算都在 `lib/chart-geometry.ts` 里，那部分是纯函数且有单元测试。
 * 本组件只负责「把返回的数字画出来」。
 */
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from 'solid-js'
import type { MinuteTrend } from '@shared/types'
import { fixed, minuteLabel, signed, signedPct } from '@shared/format'
import { ruleConditions } from '@shared/alerts'
import { appState } from '../../stores/app'
import {
  DAY_SLOTS,
  buildTrendAveragePath,
  buildTrendDayPaths,
  buildTrendGeometry,
  buildTrendLevels,
  buildTrendSeparators,
  buildTrendTicks,
  flattenTrendPoints,
  formatMonthDay,
  locateTrendSlot,
  slotFromX
} from '../../lib/chart-geometry'
import { useElementSize } from '../../lib/dom'
import { toneLineVar, toneOf } from '../../lib/tone'
import { tradingSlot, withOpeningBaseline, type LiveTrendTick } from '../../lib/realtime'

/** 悬浮读数：由 onHover 抛给外部，用于让卡片标题区跟着十字光标联动 */
export interface TrendHover {
  /** 单日显示 HH:MM，多日显示 MM-DD HH:MM */
  label: string
  price: number
  avg: number
  volume: number
  change: number
  changePct: number
}

export interface TrendChartProps {
  /** 从旧到新排列的交易日；单日分时传一个元素即可 */
  days: MinuteTrend[]
  /** 1 秒一次的报价轨迹；只画在官方分钟点之后，官方点到了就淡出 */
  liveTicks?: LiveTrendTick[]
  onHover?: (hover: TrendHover | null) => void
}

export function TrendChart(props: TrendChartProps): JSX.Element {
  const { size, ref } = useElementSize<HTMLDivElement>()
  const [hoverSlot, setHoverSlot] = createSignal<number | null>(null)
  /** 单日分时的可见槽位；null 表示 09:30–15:00 全量 */
  const [view, setView] = createSignal<{ start: number; end: number } | null>(null)
  const [drag, setDrag] = createSignal<{ x: number; start: number; end: number } | null>(null)

  const days = (): MinuteTrend[] => props.days

  /**
   * 开盘第一秒官方还没有任何分钟点；用昨收造一个 09:30 基准点，
   * 让几何/坐标轴先成立，后面的 liveTicks 才有地方画。
   */
  const chartDays = createMemo(() => withOpeningBaseline(days(), props.liveTicks ?? []))
  const isMultiDay = (): boolean => chartDays().length > 1

  // 切股票/切日期时复位缩放，避免把上一只股票的视窗带过来。
  createEffect(
    on(
      () => `${days()[0]?.code ?? ''}:${days()[0]?.date ?? ''}:${days().length}`,
      () => {
        setView(null)
        setDrag(null)
      }
    )
  )

  const geometry = createMemo(() =>
    buildTrendGeometry(chartDays(), size().width, size().height, undefined, view() ?? undefined)
  )
  const bars = createMemo(() => {
    const geo = geometry()
    const flat = flattenTrendPoints(chartDays())
    return geo
      ? flat.filter((item) => item.slot >= geo.slotStart && item.slot <= geo.slotEnd)
      : flat
  })
  const zoomLabel = (): string => {
    if (!view() || bars().length === 0) return '滚轮缩放 · 拖动平移 · 双击复位'
    const first = bars()[0]
    const last = bars()[bars().length - 1]
    const startLabel = isMultiDay()
      ? `${formatMonthDay(chartDays()[first.dayIndex]?.date ?? '')} ${minuteLabel(first.point.time)}`
      : minuteLabel(first.point.time)
    const endLabel = isMultiDay()
      ? `${formatMonthDay(chartDays()[last.dayIndex]?.date ?? '')} ${minuteLabel(last.point.time)}`
      : minuteLabel(last.point.time)
    return `${startLabel}–${endLabel} · 拖动平移 · 双击复位`
  }
  const levels = createMemo(() => {
    const geo = geometry()
    return geo ? buildTrendLevels(chartDays(), geo) : []
  })
  const alertPrices = createMemo(() => {
    const code = chartDays()[0]?.code
    if (!code) return []
    const result: Array<{ price: number; label: string }> = []
    for (const rule of appState.alerts) {
      if (!rule.enabled || rule.code !== code) continue
      for (const condition of ruleConditions(rule)) {
        if (condition.metric === 'price') result.push({ price: condition.value, label: rule.name })
      }
    }
    return result
  })

  const ticks = createMemo(() => {
    const geo = geometry()
    return geo ? buildTrendTicks(chartDays(), geo) : []
  })
  const separators = createMemo(() => {
    const geo = geometry()
    return geo ? buildTrendSeparators(chartDays(), geo) : []
  })
  const dayPaths = createMemo(() => {
    const geo = geometry()
    return geo ? buildTrendDayPaths(chartDays(), geo) : []
  })
  const averagePath = createMemo(() => {
    const geo = geometry()
    return geo ? buildTrendAveragePath(chartDays(), geo) : ''
  })

  /**
   * 1 秒报价轨迹：从最后一个官方分钟点（没有则从昨收）连到当前秒。
   * 官方点到达后，旧 tick 会被 lastSeconds 过滤掉，不会污染历史。
   */
  const liveTrace = createMemo(() => {
    const geo = geometry()
    const ticks = props.liveTicks ?? []
    const current = chartDays()
    if (!geo || ticks.length === 0 || current.length === 0) return null
    const dayIndex = current.length - 1
    const day = current[dayIndex]
    const lastPoint = day.points[day.points.length - 1]
    /*
     * 不能按时间过滤：通达信的分钟标签会比当前时间超前约一分钟
     * （13:15:40 时最后一点已经是 13:16），按 timeSeconds 比会把当前
     * 报价全部当成「历史」丢掉。按槽位过滤才和画出来的横轴一致。
     * 09:30 的基准点是人工补的，允许同一槽位上的第一个实时点。
     */
    const lastSlot = dayIndex * DAY_SLOTS + Math.max(0, day.points.length - 1)
    // 集合竞价的最后一秒（09:25:00）也必须留在图上：竞价点都归到 09:30
    // 槽位，若官方已有 09:30 基准点/旧点，按 lastSlot 过滤会把最后撮合价
    // 丢掉。竞价阶段直接按 slotStart 放行，并从昨收画到当前价。
    const isPreOpen = ticks.some((tick) => tick.timeSeconds < 9 * 3600 + 30 * 60)
    const filtered = ticks.filter((tick) => {
      const slot = dayIndex * DAY_SLOTS + tradingSlot(tick.timeSeconds)
      if (slot < geo.slotStart || slot > geo.slotEnd) return false
      if (isPreOpen) return true
      // 用 >=：开盘第一秒的 tick 可能与人工 09:30 基准点同槽；
      // 官方 09:31 点也可能在同一槽，丢掉它会让第一秒又变成空白。
      return slot >= lastSlot
    })
    if (filtered.length === 0) return null

    const start = isPreOpen
      ? {
          x: geo.x(dayIndex * DAY_SLOTS),
          y: geo.yPrice(day.prevClose || lastPoint?.price || filtered[0].price)
        }
      : lastPoint
        ? {
            x: geo.x(dayIndex * DAY_SLOTS + day.points.length - 1),
            y: geo.yPrice(lastPoint.price)
          }
        : { x: geo.x(dayIndex * DAY_SLOTS), y: geo.yPrice(day.prevClose) }
    const points = filtered.map((tick) => ({
      x: geo.x(dayIndex * DAY_SLOTS + tradingSlot(tick.timeSeconds)),
      y: geo.yPrice(tick.price)
    }))
    const last = points[points.length - 1]
    const tail = filtered[filtered.length - 1]
    return {
      path: `M${start.x.toFixed(1)} ${start.y.toFixed(1)} ${points
        .map((point) => `L${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
        .join(' ')}`,
      last,
      changePct: day.prevClose > 0 ? ((tail.price - day.prevClose) / day.prevClose) * 100 : 0
    }
  })

  const hovered = createMemo(() => {
    const slot = hoverSlot()
    const geo = geometry()
    if (slot === null || !geo) return null

    const located = locateTrendSlot(slot, chartDays())
    if (!located) return null

    const day = chartDays()[located.dayIndex]
    const point = day.points[located.pointIndex]
    const change = point.price - day.prevClose

    return {
      point,
      x: geo.x(located.dayIndex * DAY_SLOTS + located.pointIndex),
      y: geo.yPrice(point.price),
      change,
      changePct: day.prevClose > 0 ? (change / day.prevClose) * 100 : 0,
      label: isMultiDay()
        ? `${formatMonthDay(day.date)} ${minuteLabel(point.time)}`
        : minuteLabel(point.time)
    }
  })

  /*
   * 把悬浮读数抛给外部（卡片标题区联动）。
   * 用 createEffect + on(hovered, ...) 而不是裸 createMemo：
   * 前者只在 hovered 真的变化时才执行副作用，后者是「用 memo 做副作用」的坏味道。
   */
  createEffect(
    on(hovered, (current) => {
      props.onHover?.(
        current
          ? {
              label: current.label,
              price: current.point.price,
              avg: current.point.avg,
              volume: current.point.volume,
              change: current.change,
              changePct: current.changePct
            }
          : null
      )
    })
  )

  const onPointerMove = (event: PointerEvent): void => {
    const geo = geometry()
    if (!geo || bars().length === 0) return
    const currentDrag = drag()
    if (currentDrag) {
      const span = currentDrag.end - currentDrag.start
      const delta = Math.round(((-1 * (event.clientX - currentDrag.x)) / geo.plotW) * span)
      const maxSlot = Math.max(DAY_SLOTS - 1, chartDays().length * DAY_SLOTS - 1)
      const start = Math.max(0, Math.min(maxSlot - span, currentDrag.start + delta))
      setView({ start, end: start + span })
      return
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const slot = slotFromX(event.clientX, rect.left, geo)
    if (slot !== null) setHoverSlot(slot)
  }

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const geo = geometry()
    if (!geo) return
    const maxSlot = Math.max(DAY_SLOTS - 1, chartDays().length * DAY_SLOTS - 1)
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const anchor = slotFromX(event.clientX, rect.left, geo) ?? (geo.slotStart + geo.slotEnd) / 2
    const span = geo.slotEnd - geo.slotStart
    const nextSpan = Math.max(
      30,
      Math.min(maxSlot, Math.round(span * (event.deltaY < 0 ? 0.8 : 1.25)))
    )
    if (nextSpan >= maxSlot) {
      setView(null)
      return
    }
    const ratio = span > 0 ? (anchor - geo.slotStart) / span : 0
    const start = Math.max(0, Math.min(maxSlot - nextSpan, Math.round(anchor - ratio * nextSpan)))
    setView({ start, end: start + nextSpan })
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const geo = geometry()
    if (!geo) return
    setDrag({ x: event.clientX, start: geo.slotStart, end: geo.slotEnd })
  }

  const clearHover = (): void => {
    setDrag(null)
    setHoverSlot(null)
    props.onHover?.(null)
  }

  return (
    <div
      class="chart-host"
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={clearHover}
      onWheel={onWheel}
      onDblClick={() => setView(null)}
    >
      <Show when={geometry()} fallback={<div class="chart-empty">正在加载分时数据…</div>}>
        {(geo) => (
          <svg
            class="chart-svg"
            width={geo().width}
            height={geo().height}
            data-live-ticks={props.liveTicks?.length ?? 0}
            data-live-last={chartDays().at(-1)?.points.at(-1)?.time ?? ''}
            data-live-tick-last={props.liveTicks?.at(-1)?.timeSeconds ?? ''}
            data-live-trace={liveTrace() ? '1' : '0'}
          >
            <defs>
              <linearGradient
                id="trend-area"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={geo().priceTop}
                x2="0"
                y2={geo().priceBottom}
              >
                <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.24" />
                <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
              </linearGradient>
            </defs>

            {/* ---------- 交易日分隔线 ---------- */}
            <For each={separators()}>
              {(slot) => (
                <line
                  x1={geo().x(slot)}
                  x2={geo().x(slot)}
                  y1={geo().priceTop}
                  y2={geo().volumeBottom}
                  stroke="var(--border-strong)"
                />
              )}
            </For>

            {/* ---------- 纵向时间网格 ---------- */}
            <For each={ticks()}>
              {(tick) => (
                <line
                  x1={geo().x(tick.slot)}
                  x2={geo().x(tick.slot)}
                  y1={geo().priceTop}
                  y2={geo().volumeBottom}
                  stroke="var(--chart-grid)"
                />
              )}
            </For>

            {/* ---------- 横向价格网格 + 右轴刻度 ---------- */}
            <For each={levels()}>
              {(level) => {
                const y = (): number => geo().yPrice(level.value)
                return (
                  <g>
                    <line
                      x1={geo().padding.left}
                      x2={geo().width - geo().padding.right}
                      y1={y()}
                      y2={y()}
                      stroke="var(--chart-grid)"
                      stroke-dasharray={level.pct === 0 ? undefined : '3 5'}
                    />
                    <text
                      x={geo().width - geo().padding.right + 8}
                      y={y() + 3.5}
                      fill={level.pct === 0 ? 'var(--text-3)' : 'var(--chart-axis)'}
                      font-size="10"
                      class="num"
                    >
                      {fixed(level.value, 2)}
                    </text>
                    <Show when={level.pct !== null}>
                      <text
                        x={geo().width - geo().padding.right + 8}
                        y={y() + 14}
                        fill="var(--text-3)"
                        font-size="9"
                        class="num"
                      >
                        {level.pct === 0 ? '0.00%' : signedPct(level.pct)}
                      </text>
                    </Show>
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

            {/* ---------- 成交量柱 ---------- */}
            <For each={bars()}>
              {(item, index) => {
                const previousPrice = (): number => {
                  if (index() === 0) return chartDays()[0]?.prevClose ?? item.point.price
                  return bars()[index() - 1].point.price
                }
                return (
                  <rect
                    x={geo().x(item.slot) - geo().barWidth / 2}
                    y={geo().yVolume(item.point.volume)}
                    width={geo().barWidth}
                    height={Math.max(0, geo().volumeBottom - geo().yVolume(item.point.volume))}
                    fill={item.point.price >= previousPrice() ? 'var(--up)' : 'var(--down)'}
                    opacity="0.55"
                  />
                )
              }}
            </For>

            {/* ---------- 面积 + 每日折线 ---------- */}
            <For each={dayPaths()}>
              {(day) => (
                <g>
                  <path d={day.area} fill="url(#trend-area)" />
                  <path
                    d={day.line}
                    fill="none"
                    stroke={toneLineVar(day.tone)}
                    stroke-width="1.6"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                </g>
              )}
            </For>

            <path
              d={averagePath()}
              fill="none"
              stroke="var(--chart-avg)"
              stroke-width="1.1"
              stroke-dasharray="4 3"
              opacity="0.9"
            />

            {/* ---------- 当前秒的实时轨迹（官方分钟点到达后自动让位） ---------- */}
            <Show when={liveTrace()}>
              {(live) => (
                <g class="trend-live" pointer-events="none">
                  <path
                    d={live().path}
                    fill="none"
                    stroke={toneLineVar(toneOf(live().changePct))}
                    stroke-width="1.8"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                  <circle
                    cx={live().last.x}
                    cy={live().last.y}
                    r="3.2"
                    fill="var(--panel-solid)"
                    stroke={toneLineVar(toneOf(live().changePct))}
                    stroke-width="1.8"
                  />
                </g>
              )}
            </Show>

            {/* ---------- 横轴标签 ---------- */}
            <For each={ticks()}>
              {(tick) => (
                <text
                  x={geo().x(tick.slot)}
                  y={geo().height - 6}
                  fill="var(--text-3)"
                  font-size="10"
                  text-anchor={tick.anchor}
                >
                  {tick.label}
                </text>
              )}
            </For>

            {/* ---------- 十字光标 ---------- */}
            <Show when={hovered()}>
              {(current) => (
                <g>
                  <line
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
                  <circle
                    cx={current().x}
                    cy={current().y}
                    r="3.4"
                    fill="var(--panel-solid)"
                    stroke={toneLineVar(toneOf(current().change))}
                    stroke-width="1.6"
                  />
                </g>
              )}
            </Show>
          </svg>
        )}
      </Show>

      <div class="chart-zoom-hint">{zoomLabel()}</div>

      {/* ---------- 浮层读数 ---------- */}
      <Show when={hovered()}>
        {(current) => (
          <div
            class="chart-tooltip"
            style={{
              left: `${Math.min(current().x + 14, Math.max(0, size().width - 160))}px`,
              top: '10px'
            }}
          >
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">时间</span>
              <span class="num">{current().label}</span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">价格</span>
              <span class="num" style={{ color: toneLineVar(toneOf(current().change)) }}>
                {fixed(current().point.price)}
              </span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">涨跌幅</span>
              <span class="num" style={{ color: toneLineVar(toneOf(current().change)) }}>
                {signedPct(current().changePct)}
              </span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">涨跌额</span>
              <span class="num">{signed(current().change)}</span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">均价</span>
              <span class="num" style={{ color: 'var(--chart-avg)' }}>
                {fixed(current().point.avg)}
              </span>
            </div>
            <div class="chart-tooltip__row">
              <span class="chart-tooltip__label">成交量</span>
              <span class="num">{current().point.volume.toFixed(0)} 手</span>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
