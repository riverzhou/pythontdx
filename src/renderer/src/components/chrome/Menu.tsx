/**
 * 轻量下拉菜单（标题栏功能菜单、标签栏“+”共用）。
 *
 * 面板用 Portal 挂到 body：标题栏和标签栏都有 overflow/层叠上下文，
 * 直接绝对定位会被裁掉（标签栏的“+”菜单曾只露出半截）。Portal + fixed
 * 定位也让菜单能盖住右侧盘口栏。
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'

export type MenuItem =
  | { separator: true }
  /** 分组标题：只用于「+」这类长菜单，让分组一眼可见 */
  | { section: string }
  | {
      separator?: false
      label: string
      hint?: string
      /** 稳定标识，供截图/端到端测试定位 */
      id?: string
      disabled?: boolean
      onSelect: () => void
    }

interface MenuProps {
  label: string
  items: MenuItem[]
  class?: string
  /** 下拉面板对齐方向；标题栏右侧菜单用 right */
  align?: 'left' | 'right'
  title?: string
  icon?: JSX.Element
}

interface MenuPosition {
  left: number
  top: number
  transform: string
}

export function Menu(props: MenuProps): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [position, setPosition] = createSignal<MenuPosition>({ left: 0, top: 0, transform: '' })
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  let panel: HTMLDivElement | undefined

  /**
   * 计算面板位置：默认贴触发器左缘，但必须夹在视口内。
   * 「+」在标签栏最右侧，左对齐会直接跑到窗口外面；这里按面板实际宽高
   * 夹取，下方放不下就翻到触发器上方。
   */
  const place = (): void => {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 8
    const width = panel?.offsetWidth || 220
    const height = panel?.offsetHeight || 320
    const preferred = props.align === 'right' ? rect.right - width : rect.left
    const left = Math.max(margin, Math.min(preferred, window.innerWidth - width - margin))
    let top = rect.bottom + 5
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - height - 5)
    }
    setPosition({ left, top, transform: '' })
  }

  createEffect(() => {
    if (!open()) return
    place()
    // 首次渲染时面板还没量到宽高，下一帧按真实尺寸再夹一次
    queueMicrotask(place)
  })

  onMount(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!open()) return
      const target = event.target as Node
      if (root?.contains(target) || panel?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && open()) {
        event.stopPropagation()
        setOpen(false)
      }
    }
    const onResize = (): void => {
      if (open()) place()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onResize)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onResize)
    })
  })

  return (
    <div
      class={`menu ${props.class ?? ''}`}
      ref={(element) => {
        root = element
      }}
    >
      <button
        type="button"
        ref={(element) => {
          trigger = element
        }}
        class="menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open()}
        title={props.title}
        onClick={() => setOpen((value) => !value)}
      >
        <Show when={props.icon}>{props.icon}</Show>
        <span class="menu__label">{props.label}</span>
        <span class="menu__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={(element) => {
              panel = element
            }}
            class="menu__panel menu__panel--portal"
            classList={{ 'menu__panel--right': props.align === 'right' }}
            role="menu"
            style={{
              left: `${position().left}px`,
              top: `${position().top}px`,
              transform: position().transform
            }}
          >
            <For each={props.items}>
              {(item) =>
                'section' in item ? (
                  <div class="menu__section" role="presentation">
                    {item.section}
                  </div>
                ) : item.separator ? (
                  <div class="menu__separator" role="separator" />
                ) : (
                  <button
                    type="button"
                    class="menu__item"
                    role="menuitem"
                    data-menu-id={item.id}
                    disabled={item.disabled}
                    onClick={() => {
                      if (item.disabled) return
                      setOpen(false)
                      item.onSelect()
                    }}
                  >
                    <span class="menu__label">{item.label}</span>
                    <Show when={item.hint}>
                      <span class="menu__hint">{item.hint}</span>
                    </Show>
                  </button>
                )
              }
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  )
}
