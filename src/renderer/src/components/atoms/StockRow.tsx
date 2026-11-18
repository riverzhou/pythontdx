/**
 * 左栏股票行：自选股 / 板块成分股 / 自定义板块 三张列表**共用这一个组件**。
 *
 * 为什么只留一个行组件：三张列表的行内容本来就一样 ——
 *   名称 + 代码 | 迷你走势 | 最新价 + 涨跌幅 | 删除位（只有自选股有按钮）。
 * 以前自选股用 WatchRow、板块和自定义用 Sidebar 里的 SectorRow，两套 JSX 两套
 * 样式各自长大：同一个左栏里板块行比自选行字号大、留白多，名称还被挤成「生益…」
 * （2026-11-18 反馈）。布局只留一份，三张列表想不一样都难。
 *
 * 可选能力按列表按需打开：
 *   · `groupId` + `index` → 可拖拽排序（自选股、自定义板块；板块成分股是板块数据，不排序）
 *   · `onRemove`          → 悬停出现「移出」按钮（自选股、自定义板块）
 *   · `removeTitle`       → 按钮文案（「移出自选」/「移出板块」）
 *   · `flash`             → 价格跳动时闪一下。只给行数少的列表开：板块列表 237 行、
 *                           每秒按涨跌幅重排，逐行闪烁会变成一片频闪
 */
import { createSignal, Show, type JSX } from 'solid-js'
import type { Quote } from '@shared/types'
import { fixed, signedPct } from '@shared/format'
import { createValueFlash } from '../../lib/dom'
import { toneOf, type Tone } from '../../lib/tone'
import { appState, draggingCode, moveWatchItem, setDraggingCode } from '../../stores/app'
import { quoteOf } from '../../stores/quotes'
import { sparklineOf } from '../../stores/sparklines'
import { openStockMenu } from '../../stores/stockMenu'
import { IconClose } from './Icons'
import { Sparkline } from '../charts/Sparkline'

export interface StockRowProps {
  code: string
  /** 行情还没回来时的兜底名称（列表数据自带） */
  name: string
  /** 拖拽排序的目标分组；与 `index` 同时给出才允许拖动 */
  groupId?: string
  /** 在当前分组中的位置 */
  index?: number
  /** 给出就渲染「移出」按钮；不传则列表只读（板块成分股） */
  onRemove?: () => void
  /** 移出按钮的文案与提示，默认「移出自选」 */
  removeTitle?: string
  /** 价格变化时闪烁（见文件头注释：默认关闭） */
  flash?: boolean
  onPick: () => void
}

export function StockRow(props: StockRowProps): JSX.Element {
  const quote = (): Quote | undefined => quoteOf(props.code)
  const displayName = (): string => quote()?.name || props.name
  const tone = (): Tone => toneOf(quote()?.changePct)
  /*
   * flash 关掉时不读报价 → effect 不订阅价格，等于零开销；
   * 打开时按价格变化闪一下（不用条件创建 effect，免得每个列表各写一套）。
   */
  const flashDirection = createValueFlash(() => (props.flash === true ? quote()?.price : undefined))
  const auction = (): boolean => quote()?.auction === true
  const active = (): boolean => appState.activeCode === props.code
  const canDrag = (): boolean => props.groupId !== undefined && props.index !== undefined

  /**
   * 迷你走势的末点用当前报价替换：官方分时 60 秒才补一次，
   * 但价格是 1 秒的；这样列表里的线也能跟着跳，不必再打 30 次分时请求。
   */
  const sparkValues = (values: number[]): number[] => {
    const price = quote()?.price
    if (!price || price <= 0) return values
    if (values.length === 0) return [price, price]
    return [...values.slice(0, -1), price]
  }

  /** 落点位置：插到这行前面还是后面 */
  const [dropSide, setDropSide] = createSignal<'before' | 'after' | null>(null)
  const isDragging = (): boolean => draggingCode() === props.code

  const onDragStart = (event: DragEvent): void => {
    if (!canDrag()) return
    setDraggingCode(props.code)
    event.dataTransfer?.setData('text/plain', props.code)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  const onDragOver = (event: DragEvent): void => {
    const source = draggingCode()
    // 拖到自己身上没有意义，也不允许把落点标记画出来
    if (!canDrag() || !source || source === props.code) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : null
    if (!rect) return
    setDropSide(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
  }

  const onDrop = (event: DragEvent): void => {
    if (!canDrag()) return
    event.preventDefault()
    event.stopPropagation()

    const code = draggingCode() ?? event.dataTransfer?.getData('text/plain')
    const side = dropSide()
    const groupId = props.groupId
    const index = props.index
    setDropSide(null)
    setDraggingCode(null)
    if (!code || code === props.code || groupId === undefined || index === undefined) return

    moveWatchItem(code, groupId, side === 'after' ? index + 1 : index)
  }

  const hint = (): string => {
    const parts: string[] = []
    if (canDrag()) parts.push('可拖拽排序')
    parts.push(props.onRemove ? (props.removeTitle ?? '移出自选') : '右键加入自定义板块')
    return `（${parts.join('，')}）`
  }

  return (
    <button
      class="stock-row"
      classList={{
        'stock-row--active': active(),
        'stock-row--dragging': isDragging(),
        'stock-row--drop-before': dropSide() === 'before',
        'stock-row--drop-after': dropSide() === 'after'
      }}
      data-code={props.code}
      draggable={canDrag()}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropSide(null)}
      onDrop={onDrop}
      onDragEnd={() => {
        setDraggingCode(null)
        setDropSide(null)
      }}
      onClick={() => props.onPick()}
      onContextMenu={(event) => openStockMenu(event, { code: props.code, name: displayName() })}
      title={`${displayName()} ${props.code.toUpperCase()}${hint()}`}
    >
      <span class="stock-row__main">
        <span class="stock-row__name">{displayName()}</span>
        <span class="stock-row__code num">{props.code.toUpperCase()}</span>
      </span>

      <span class="stock-row__spark">
        <Show when={appState.settings.showSparkline}>
          <Show when={sparklineOf(props.code)}>
            {(data) => (
              <Sparkline
                values={sparkValues(data().values)}
                baseline={data().prevClose}
                width={46}
                height={20}
                title="当日分时走势（末点跟随 1 秒报价）"
              />
            )}
          </Show>
        </Show>
        {/* 删除按钮压在这一列上：不再为它单独留 20px 空白，右侧不留死区 */}
        <Show when={props.onRemove}>
          <span
            class="stock-row__remove"
            role="button"
            aria-label={props.removeTitle ?? '移出自选'}
            title={props.removeTitle ?? '移出自选'}
            onClick={(event) => {
              event.stopPropagation()
              props.onRemove?.()
            }}
          >
            <IconClose size={11} />
          </span>
        </Show>
      </span>

      <span class="stock-row__nums">
        <span
          class="stock-row__price num"
          classList={{
            [tone()]: true,
            'stock-row__price--up': flashDirection() === 'up',
            'stock-row__price--down': flashDirection() === 'down'
          }}
        >
          {fixed(quote()?.price)}
        </span>
        <span
          class="stock-row__chg num"
          classList={{ [tone()]: !auction(), 'stock-row__chg--auction': auction() }}
          title={auction() ? `集合竞价虚拟撮合价 ${quote()?.auctionTime ?? ''}` : undefined}
        >
          {auction() ? '竞价' : signedPct(quote()?.changePct)}
        </span>
      </span>
    </button>
  )
}
