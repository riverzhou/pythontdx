/**
 * 板块分类的统一加载入口。
 *
 * SectorPicker（左栏选板块）和 BlockPanel（板块/概念大窗口）必须用同一套
 * 分类与同一份数据，否则两处会出现「这里 7 类、那里 5 类」的问题。
 *
 *   rs1 / rs2        → TDXRSHY（tdxhy.cfg rsCode），名单取 MAC 0x1231 的 0/1 类
 *   industry         → tdxhy.cfg 的 111 个通达信行业
 *   gn/fg/zs/general → 0x06b9 的 block_*.dat
 */
import type { BlockGroup, BlockKind, IndustryList } from '@shared/types'
import { api } from './client'

export type BoardCategory = 'rs1' | 'rs2' | 'industry' | BlockKind

export const BOARD_CATEGORIES: Array<{ key: BoardCategory; label: string }> = [
  { key: 'rs1', label: '一级行业' },
  { key: 'rs2', label: '二级行业' },
  { key: 'industry', label: '通达信行业' },
  { key: 'gn', label: '概念' },
  { key: 'fg', label: '风格' },
  { key: 'zs', label: '指数板块' },
  { key: 'general', label: '一般' }
]

let industryCache: IndustryList | null = null
const macNames = new Map<number, string[]>()

async function researchBoards(boardType: 0 | 1): Promise<BlockGroup[]> {
  if (!industryCache) industryCache = (await api.block.industries()) as IndustryList
  let names = macNames.get(boardType)
  if (!names) {
    const boards = await api.mac.boards(boardType)
    names = boards.map((board) => board.name)
    macNames.set(boardType, names)
  }
  const allowed = new Set(names)
  return (industryCache.rsBlocks ?? []).filter((board) => allowed.has(board.name))
}

/** 分类 → 板块列表（带成分股）。同一分类重复调用会重新请求，由调用方做缓存。 */
export async function loadBoardCategory(category: BoardCategory): Promise<BlockGroup[]> {
  if (category === 'industry') {
    const data = (await api.block.industries()) as IndustryList
    industryCache = data
    return data.blocks
  }
  if (category === 'rs1') return researchBoards(0)
  if (category === 'rs2') return researchBoards(1)
  return (await api.block.list(category)).blocks
}
