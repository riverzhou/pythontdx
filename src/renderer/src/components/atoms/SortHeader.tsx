/**
 * 可点击排序的表头单元格：全市场 / 板块 / 排行榜三张表共用。
 *
 * 为什么用 `<th>` 自己接收点击而不是塞一个 `<button>`：
 * 表头是 `table-layout: fixed` 的固定列宽单元格，按钮要再解决一遍对齐、
 * 内边距和右侧数字列的 `text-align: right`；而 WAI 的表格排序模式本来就
 * 是在 `th` 上挂 `aria-sort` + 键盘处理，语义更准。
 *
 * 箭头三态：未排序显示淡 `↕`（提示这一列能点），升序 `▲`、降序 `▼`。
 * 一直占着 9px 宽度，切换方向时列宽不会跳。
 */
import type { JSX } from 'solid-js'
import { nextSort, sortIndicator, type SortDir, type SortState } from '../../lib/table-sort'

export interface SortHeaderProps {
  label: string
  /** 列标识，与 `SortState.key` 对应 */
  sortKey: string
  sort: SortState | null
  onSort: (next: SortState) => void
  /** 第一次点的方向：数值列默认降序，代码/名称默认升序 */
  firstDir?: SortDir
  /** 复用各表自己的表头类名（num / ranking__num …） */
  class?: string
  /** 悬停提示，默认「按 XX 排序」 */
  title?: string
}

export function SortHeader(props: SortHeaderProps): JSX.Element {
  const dir = (): SortDir | null => sortIndicator(props.sort, props.sortKey)
  const apply = (): void =>
    props.onSort(nextSort(props.sort, props.sortKey, props.firstDir ?? 'desc'))

  return (
    <th
      class={props.class ? `sort-head ${props.class}` : 'sort-head'}
      classList={{
        'sort-head--asc': dir() === 'asc',
        'sort-head--desc': dir() === 'desc'
      }}
      data-sort={props.sortKey}
      aria-sort={dir() === 'asc' ? 'ascending' : dir() === 'desc' ? 'descending' : 'none'}
      tabIndex={0}
      title={props.title ?? `按${props.label}排序`}
      onClick={apply}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        apply()
      }}
    >
      {props.label}
      <span class="sort-head__arrow" aria-hidden="true">
        {dir() === 'desc' ? '▼' : dir() === 'asc' ? '▲' : '↕'}
      </span>
    </th>
  )
}
