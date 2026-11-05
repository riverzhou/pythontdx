/**
 * 带过期时间的内存缓存。
 *
 * 分时/K线这类数据没必要每次界面切换都重新拉：
 *  - 分时 10 秒内复用（行情本身就是分钟级）
 *  - K 线 60 秒内复用（日线级别几乎不变）
 */
interface Entry<T> {
  value: T
  expiresAt: number
}

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>()
  /** 在途请求：同一个 key 的并发调用共享同一个 Promise */
  private readonly pending = new Map<string, Promise<T>>()

  /** 固定时长，或按当前时段动态计算（写入时求值） */
  constructor(private readonly ttl: number | (() => number)) {}

  private ttlMs(): number {
    return typeof this.ttl === 'function' ? this.ttl() : this.ttl
  }

  get(key: string): T | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: T): T {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs() })
    return value
  }

  clear(): void {
    this.store.clear()
    this.pending.clear()
  }

  /**
   * 读缓存；未命中则调用 loader 并写回。
   *
   * 关键点：**并发合并**。
   * 界面上多个组件或多次重试可能在同一瞬间请求同一份数据，
   * 如果不做合并，每一次都会真的打一次上游接口——网络抖动时很容易演变成请求风暴。
   * 这里让同一个 key 的并发调用共享同一个 Promise，保证同一时刻最多只有一个真实请求。
   */
  async resolve(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key)
    if (cached !== undefined) return cached

    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const task = Promise.resolve()
      .then(loader)
      .then(
        (value) => {
          this.pending.delete(key)
          return this.set(key, value)
        },
        (error: unknown) => {
          // 失败不写缓存，但一定要把在途标记清掉，否则后续请求会被永久挂住
          this.pending.delete(key)
          throw error
        }
      )

    this.pending.set(key, task)
    return task
  }
}
