/**
 * 自选股单行。
 *
 * 组成：名称/代码 + 迷你走势图 + 最新价/涨跌幅 + 删除按钮。
 * 同时是拖拽排序的拖拽源与落点：
 *   · 拖自己        → dataTransfer 里带上代码；
 *   · 拖到别人身上  → 按鼠标在行内的上下半区决定插到前面还是后面；
 *   · 拖到分组标签  → 移到那个分组（由 Sidebar 处理）。
 */
import { createSignal, Show, type JSX } from 'solid-js'
import type { Quote, WatchItem } from '@shared/types'
import { fixed, signedPct } from '@shared/format'
import { createValueFlash } from '../../lib/dom'
import { toneOf, type Tone } from '../../lib/tone'
import {
  appState,
  draggingCode,
  moveWatchItem,
  removeWatchItem,
  setDraggingCode
} from '../../stores/app'
import { selectStock } from '../../stores/workspace'
import { quoteOf } from '../../stores/quotes'
import { sparklineOf } from '../../stores/sparklines'
import { openStockMenu } from '../../stores/stockMenu'
import { IconClose } from './Icons'
import { Sparkline } from '../charts/Sparkline'

export interface WatchRowProps {
  item: WatchItem
  /** 在当前分组中的位置 */
  index: number
  groupId: string
}

export function WatchRow(props: WatchRowProps): JSX.Element {
  const quote = (): Quote | undefined => quoteOf(props.item.code)
  const displayName = (): string => quote()?.name || props.item.name
  const longName = (): boolean => displayName().length > 4
  const tone = (): Tone => toneOf(quote()?.changePct)
  const flash = createValueFlash(() => quote()?.price)
  const auction = (): boolean => quote()?.auction === true
  const active = (): boolean => appState.activeCode === props.item.code
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
  const isDragging = (): boolean => draggingCode() === props.item.code

  const onDragStart = (event: DragEvent): void => {
    setDraggingCode(props.item.code)
    event.dataTransfer?.setData('text/plain', props.item.code)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  const onDragOver = (event: DragEvent): void => {
    const source = draggingCode()
    // 拖到自己身上没有意义，也不允许把落点标记画出来
    if (!source || source === props.item.code) return
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
    event.preventDefault()
    event.stopPropagation()

    const code = draggingCode() ?? event.dataTransfer?.getData('text/plain')
    const side = dropSide()
    setDropSide(null)
    setDraggingCode(null)
    if (!code || code === props.item.code) return

    moveWatchItem(code, props.groupId, side === 'after' ? props.index + 1 : props.index)
  }

  return (
    <button
      class="watch-row"
      classList={{
        'watch-row--active': active(),
        'watch-row--dragging': isDragging(),
        'watch-row--drop-before': dropSide() === 'before',
        'watch-row--drop-after': dropSide() === 'after',
        'watch-row--long-name': longName()
      }}
      draggable={true}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropSide(null)}
      onDrop={onDrop}
      onDragEnd={() => {
        setDraggingCode(null)
        setDropSide(null)
      }}
      onClick={() => selectStock(props.item.code)}
      onContextMenu={(event) =>
        openStockMenu(event, { code: props.item.code, name: displayName() })
      }
      title={`${displayName()} ${props.item.code.toUpperCase()}（可拖拽排序，右键加入自定义板块）`}
    >
      <div class="watch-row__main">
        <div class="watch-row__name">{displayName()}</div>
        <div class="watch-row__code num">{props.item.code.toUpperCase()}</div>
      </div>

      <div class="watch-row__spark-slot">
        <Show when={appState.settings.showSparkline}>
          <Show when={sparklineOf(props.item.code)}>
            {(data) => (
              <Sparkline
                values={sparkValues(data().values)}
                baseline={data().prevClose}
                width={46}
                height={22}
                title="当日分时走势（末点跟随 1 秒报价）"
              />
            )}
          </Show>
        </Show>
      </div>

      <div class="watch-row__nums">
        <div
          class="watch-row__price num"
          classList={{
            [tone()]: true,
            'watch-row__price--up': flash() === 'up',
            'watch-row__price--down': flash() === 'down'
          }}
        >
          {fixed(quote()?.price)}
        </div>
        <div
          class="watch-row__chg num"
          classList={{ [tone()]: !auction(), 'watch-row__chg--auction': auction() }}
          title={auction() ? `集合竞价虚拟撮合价 ${quote()?.auctionTime ?? ''}` : undefined}
        >
          {auction() ? '竞价' : signedPct(quote()?.changePct)}
        </div>
      </div>

      <span
        class="watch-row__remove"
        role="button"
        aria-label="移出自选"
        title="移出自选"
        onClick={(event) => {
          event.stopPropagation()
          removeWatchItem(props.item.code, props.groupId)
        }}
      >
        <IconClose size={11} />
      </span>
    </button>
  )
}
