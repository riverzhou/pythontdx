/**
 * 内联 SVG 图标集。
 *
 * 为什么不装 iconfont / lucide？
 *  - 桌面包体积敏感，几十个图标没必要引一整个库；
 *  - 内联 SVG 可以直接吃 currentColor，跟随主题和 hover 变色；
 *  - 每个图标就是一个组件，Solid 会把它编译成极小的 DOM 操作。
 *
 * 统一规格：24×24 视图框、2px 描边、圆头圆角。
 */
import type { JSX } from 'solid-js'

export interface IconProps {
  size?: number
  class?: string
  /** 描边粗细，密集区域可以调细一点 */
  strokeWidth?: number
}

function svgProps(props: IconProps, strokeWidth?: number): JSX.SvgSVGAttributes<SVGSVGElement> {
  return {
    width: props.size ?? 14,
    height: props.size ?? 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    // 注意：Solid 的 JSX 属性沿用 SVG 的 kebab-case 写法
    'stroke-width': strokeWidth ?? props.strokeWidth ?? 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: props.class,
    'aria-hidden': 'true'
  }
}

export function IconSearch(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  )
}

export function IconStar(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M12 3.6l2.6 5.3 5.8.84-4.2 4.1 1 5.76L12 16.9l-5.2 2.7 1-5.76-4.2-4.1 5.8-.84z" />
    </svg>
  )
}

export function IconStarFilled(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)} fill="currentColor">
      <path d="M12 3.6l2.6 5.3 5.8.84-4.2 4.1 1 5.76L12 16.9l-5.2 2.7 1-5.76-4.2-4.1 5.8-.84z" />
    </svg>
  )
}

export function IconClose(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function IconMinimize(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props, props.strokeWidth ?? 1.6)}>
      <path d="M5 12h14" />
    </svg>
  )
}

export function IconMaximize(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props, props.strokeWidth ?? 1.6)}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  )
}

export function IconRestore(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props, props.strokeWidth ?? 1.6)}>
      <rect x="4" y="8" width="12" height="12" rx="2" />
      <path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" />
    </svg>
  )
}

export function IconRefresh(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  )
}

export function IconSun(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

export function IconMoon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </svg>
  )
}

export function IconChart(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 20h18" />
      <path d="M6 16V9M11 16V5M16 16v-4M21 16v-7" />
    </svg>
  )
}

export function IconColumns(props: IconProps): JSX.Element {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="3.6" height="11" rx="0.8" />
      <rect x="6.2" y="2.5" width="3.6" height="11" rx="0.8" />
      <rect x="10.9" y="2.5" width="3.6" height="11" rx="0.8" />
    </svg>
  )
}

export function IconGrid(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

export function IconInfo(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.6v.1" />
    </svg>
  )
}

export function IconArrowUp(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props, props.strokeWidth ?? 2.4)}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  )
}

export function IconArrowDown(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props, props.strokeWidth ?? 2.4)}>
      <path d="M12 5v14M18 13l-6 6-6-6" />
    </svg>
  )
}

export function IconPlus(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconBell(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9z" />
      <path d="M10 21h4" />
    </svg>
  )
}

export function IconFilter(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 5h18l-7 8v6l-4 2v-8z" />
    </svg>
  )
}

export function IconSettings(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21h-4v-.08A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3v-4h.08A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3h4v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21v4h-.08a1.7 1.7 0 0 0-1.52 1z" />
    </svg>
  )
}

export function IconList(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}

export function IconDatabase(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  )
}

export function IconServer(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  )
}

export function IconKeyboard(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10" />
    </svg>
  )
}

/** 板块/概念：三层堆叠，和「列表/网格」区分开 */
export function IconLayers(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
      <path d="m4 12 8 4.5 8-4.5" />
      <path d="m4 16.5 8 4.5 8-4.5" />
    </svg>
  )
}

/** 整页/行情墙：四角向外扩，比空方块更直观 */
export function IconExpand(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M9 3H3v6M15 3h6v6M21 15v6h-6M3 15v6h6" />
    </svg>
  )
}

/** 侧栏开关：左侧带竖线的面板 */
export function IconSidebar(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

/** 左栏标题「导航」：指南针 */
export function IconNav(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9 4.9-2.1Z" />
    </svg>
  )
}

/** 进入全屏：四角外扩的取景框 */
export function IconFullscreen(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 9V4.5A1.5 1.5 0 0 1 4.5 3H9" />
      <path d="M15 3h4.5A1.5 1.5 0 0 1 21 4.5V9" />
      <path d="M21 15v4.5a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M9 21H4.5A1.5 1.5 0 0 1 3 19.5V15" />
    </svg>
  )
}

/** 退出全屏：四角向内收 */
export function IconFullscreenExit(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 3v5H3" />
      <path d="M16 3v5h5" />
      <path d="M21 16h-5v5" />
      <path d="M3 16h5v5" />
    </svg>
  )
}
