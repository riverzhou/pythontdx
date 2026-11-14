/**
 * 图表加载骨架屏。
 *
 * 为什么需要它：首屏拉数据时 `createResource` 的值还是 undefined，
 * 图表组件拿不到数据就不会渲染 —— 结果是主区一整块空白，
 * 看起来像「界面坏了」而不是「正在加载」。
 *
 * 这里用 CSS 拼出一个「图表形状」的占位：横向网格线 + 价格区 + 成交量柱，
 * 配合已有的 `.skeleton` 微光动画。柱子高度用固定的正弦序列生成，
 * 保证每次渲染一致（不能用 Math.random，否则每帧都在跳）。
 */
import { For, type JSX } from 'solid-js'

/** 成交量柱的占位高度（百分比），用正弦序列保证确定性 */
const BAR_HEIGHTS = Array.from({ length: 56 }, (_, index) =>
  Math.round(16 + Math.abs(Math.sin(index * 1.7)) * 66)
)

export function ChartSkeleton(): JSX.Element {
  return (
    <div class="chart-skeleton" aria-hidden="true">
      {/* 网格线 */}
      <div class="chart-skeleton__grid">
        <For each={[0, 1, 2, 3, 4]}>{() => <span class="chart-skeleton__line" />}</For>
      </div>

      {/* 价格区 */}
      <div class="chart-skeleton__area skeleton" />

      {/* 成交量区 */}
      <div class="chart-skeleton__volume">
        <For each={BAR_HEIGHTS}>
          {(height) => (
            <span class="chart-skeleton__bar skeleton" style={{ height: `${height}%` }} />
          )}
        </For>
      </div>
    </div>
  )
}
