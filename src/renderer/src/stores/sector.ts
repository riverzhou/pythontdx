/**
 * 左栏视图与「当前板块」。
 *
 * 板块选择器已经从全屏弹窗改成主工作区视图；选中后写这里，
 * 左栏「板块」页签与主区共享同一个板块，不再各存一份。
 */
import { createSignal } from 'solid-js'
import type { BlockKind } from '@shared/types'

export type SidebarView = 'watch' | 'sector' | 'custom'

export interface SectorSelection {
  /** 稳定 key：`${kind}:${id}`，用于记住选中项 */
  key: string
  kind: 'industry' | BlockKind | 'custom'
  name: string
  codes: string[]
  names: Record<string, string>
  indexCode?: string
  /** 自定义板块对应的分组 id */
  groupId?: string
}

const [sidebarView, setSidebarView] = createSignal<SidebarView>('watch')
const [sector, setSector] = createSignal<SectorSelection | null>(null)

export { sidebarView, sector, setSidebarView }

export function trackSector(selection: SectorSelection): void {
  setSector(selection)
  setSidebarView('sector')
}
