import type { PushTask, PushUpdate } from '@shared/types'
import { api } from './client'

/**
 * 面板级推送订阅。
 *
 * 组件只声明「要什么」，`http-api` 的统一适配器按任务调度并回调；
 * 返回的清理函数会取消订阅，切 tab/卸载不会留下孤儿定时器。
 */
export function subscribePush<T>(
  task: PushTask,
  intervalMs: number,
  onData: (data: T, update: PushUpdate) => void,
  onError?: (message: string) => void
): () => void {
  let id = 0
  let active = true
  const pending: PushUpdate[] = []
  const apply = (update: PushUpdate): void => {
    if (update.error) {
      onError?.(update.error)
      return
    }
    if (update.data !== undefined) onData(update.data as T, update)
  }
  const dispose = api.push.onUpdate((update: PushUpdate) => {
    if (!active) return
    if (id === 0) {
      // 首帧可能比 subscribe() 的返回值先到，先缓存，拿到 id 后再过滤。
      pending.push(update)
      return
    }
    if (update.id !== id) return
    apply(update)
  })

  void api.push
    .subscribe(task, intervalMs)
    .then((next) => {
      if (!active) {
        void api.push.unsubscribe(next)
        return
      }
      id = next
      for (const update of pending) {
        if (update.id === id) apply(update)
      }
      pending.length = 0
    })
    .catch((error: unknown) => {
      if (active) onError?.(error instanceof Error ? error.message : String(error))
    })

  return () => {
    active = false
    dispose()
    if (id) void api.push.unsubscribe(id)
  }
}
