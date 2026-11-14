/**
 * 主进程 / preload / 渲染进程 三方共享的数据契约（门面）。
 *
 * 设计原则：
 *  1. 这里只能有「类型」和「常量」，不能 import 任何 Electron / Node / DOM API，
 *     因为它同时被 tsconfig.node.json 和 tsconfig.web.json 编译。
 *  2. 所有跨进程传输的数据都必须是「可结构化克隆」的纯数据（无类实例、无函数、无 Map/Set）。
 *
 * 具体定义按领域拆在 `types/` 下；外部一律 `import type { X } from '@shared/types'`，
 * 不要直接引 `types/market` 这类实现文件。
 */
export * from './types/market'
export * from './types/mac'
export * from './types/f10'
export * from './types/data'
export * from './types/app'
export * from './types/shell'
export * from './types/push'
