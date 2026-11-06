"""进程内行情订阅 Hub：同一组代码只向主站轮询一次，结果扇出给所有订阅者。

为什么需要它：`/api/stream`（SSE）与 `/ws`（WebSocket）原来是「每个连接自己
sleep + 拉一次」。10 个页面看同一组自选，就是 10 倍上游请求；页面越多越慢，
越容易被主站限流。

gotdx 的 `Subscriber`（`client_subscribe_factory.go`）给出的是同一套语义：
按数据源 Key 合并轮询、首帧立即推基线、拉取失败跳过本轮、订阅取消不影响
其它订阅。这里在 Python 侧独立实现（不复制源码）：

  * Key = 规范化后的代码集合 + 轮询间隔；相同 Key 共享一条轮询线程；
  * 每个订阅者有独立有界队列（满了丢最旧），慢客户端不拖垮轮询；
  * 首帧：若缓存里的快照足够新（<500ms）直接复用，否则同步拉一次；
  * 拉取异常只推一条 error，线程继续跑，下轮重试；
  * 最后一个订阅者退出时轮询线程自动收敛，不泄漏线程。
"""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

BASELINE_FRESH_SECONDS = 0.5
MAX_QUEUE = 8


@dataclass
class Subscription:
    key: tuple[int, tuple[str, ...]]
    queue: "queue.Queue[dict[str, Any]]" = field(
        default_factory=lambda: queue.Queue(maxsize=MAX_QUEUE)
    )
    closed: bool = False

    def push(self, payload: dict[str, Any]) -> None:
        if self.closed:
            return
        try:
            self.queue.put_nowait(payload)
        except queue.Full:
            # 慢客户端：丢最旧的一帧，保证它看到的是最新行情而不是积压。
            try:
                self.queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(payload)
            except queue.Full:
                pass

    def get(self, timeout: float) -> dict[str, Any] | None:
        try:
            return self.queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self) -> None:
        self.closed = True
        try:
            self.queue.put_nowait({"closed": True})
        except queue.Full:
            pass


@dataclass
class _Task:
    key: tuple[int, tuple[str, ...]]
    codes: tuple[str, ...]
    interval: float
    subscribers: list[Subscription] = field(default_factory=list)
    stop: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None
    started: bool = False
    last_payload: dict[str, Any] | None = None
    last_at: float = 0.0


class SubscriptionHub:
    """线程安全的订阅工厂；`fetch` 由调用方注入，便于测试不碰网络。

    `interval_for` 用于按时段调整实际轮询间隔：Web 端没有主进程 poller，
    收盘/午休的降频由服务端统一处理，客户端仍按自己的 interval 声明订阅。
    `boundary_for` 返回距下一次交易时段切换的毫秒数，用于给低频等待封顶，
    避免午休/收盘的 30 秒等待把开盘第一帧拖后。
    """

    def __init__(
        self,
        fetch: Callable[[list[str]], list[dict[str, Any]]],
        clock: Callable[[], float] = time.monotonic,
        interval_for: Callable[[float], float] | None = None,
        boundary_for: Callable[[], float] | None = None,
    ) -> None:
        self._fetch = fetch
        self._clock = clock
        self._interval_for = interval_for or (lambda interval: interval)
        self._boundary_for = boundary_for
        self._lock = threading.Lock()
        self._tasks: dict[tuple[int, tuple[str, ...]], _Task] = {}
        self._closed = False

    def wait_seconds(self, interval: float) -> float:
        """本轮实际等待秒数：时段间隔与下一次边界取小，边界后留 250ms。"""
        delay = max(0.2, float(self._interval_for(interval)))
        if self._boundary_for is not None:
            boundary = self._boundary_for() / 1000.0
            if boundary >= 0:
                delay = min(delay, max(0.25, boundary + 0.25))
        return max(0.2, delay)

    # -- public --------------------------------------------------------

    def subscribe(
        self, codes: list[str], interval_ms: int, baseline: bool = True
    ) -> Subscription:
        normalized = tuple(sorted({str(code).strip().lower() for code in codes if str(code).strip()}))
        if not normalized:
            raise ValueError("订阅代码不能为空")
        interval = max(0.2, float(interval_ms) / 1000.0)
        key = (int(interval_ms), normalized)
        subscription = Subscription(key=key)
        with self._lock:
            if self._closed:
                raise RuntimeError("订阅 Hub 已关闭")
            task = self._tasks.get(key)
            if task is None:
                task = _Task(key=key, codes=normalized, interval=interval)
                task.thread = threading.Thread(
                    target=self._run, args=(task,), name=f"subscribe-{normalized[0]}-{interval_ms}", daemon=True
                )
                self._tasks[key] = task
            task.subscribers.append(subscription)
        # 先同步推基线，再启动轮询线程：基线失败/成功的顺序对订阅者可见，
        # 不会出现线程抢先消费掉「第一次失败」这种不可复现行为。
        try:
            if baseline:
                self._deliver_baseline(task, subscription)
        finally:
            with self._lock:
                if not task.started and self._tasks.get(key) is task:
                    task.started = True
                    task.thread.start()
        return subscription

    def unsubscribe(self, subscription: Subscription) -> None:
        with self._lock:
            task = self._tasks.get(subscription.key)
            if task is not None:
                try:
                    task.subscribers.remove(subscription)
                except ValueError:
                    pass
                if not task.subscribers:
                    task.stop.set()
                    self._tasks.pop(subscription.key, None)
        subscription.close()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            tasks = list(self._tasks.values())
            self._tasks.clear()
        for task in tasks:
            task.stop.set()
            for subscription in list(task.subscribers):
                subscription.close()

    # -- internals -----------------------------------------------------

    def _deliver_baseline(self, task: _Task, subscription: Subscription) -> None:
        now = self._clock()
        if task.last_payload is not None and now - task.last_at <= BASELINE_FRESH_SECONDS:
            subscription.push(task.last_payload)
            return
        try:
            quotes = self._fetch(list(task.codes))
        except Exception as error:  # noqa: BLE001 - 基线失败不影响后续轮询
            subscription.push({"ok": False, "error": str(error)})
            return
        payload = {
            "ok": True,
            "result": {"quotes": quotes, "at": int(time.time() * 1000)},
        }
        task.last_payload = payload
        # 记录完成时刻而不是发起时刻：行情拉取本身可能超过基线新鲜度阈值，
        # 否则轮询线程会误判基线已过期，紧接着再拉一次。
        task.last_at = self._clock()
        subscription.push(payload)

    def _run(self, task: _Task) -> None:
        first_round = True
        while not task.stop.is_set():
            if (
                first_round
                and task.last_payload is not None
                and self._clock() - task.last_at <= BASELINE_FRESH_SECONDS
            ):
                # 基线刚拉过，别立刻重复请求；等一个周期再进入常规轮询。
                first_round = False
                task.stop.wait(self.wait_seconds(task.interval))
                continue
            first_round = False
            started = self._clock()
            payload: dict[str, Any]
            try:
                quotes = self._fetch(list(task.codes))
                payload = {
                    "ok": True,
                    "result": {"quotes": quotes, "at": int(time.time() * 1000)},
                }
            except Exception as error:  # noqa: BLE001 - 单轮失败不终止订阅
                payload = {"ok": False, "error": str(error)}
            with self._lock:
                subscribers = list(task.subscribers)
                if payload.get("ok"):
                    task.last_payload = payload
                    task.last_at = self._clock()
            for subscription in subscribers:
                subscription.push(payload)
            remaining = self._interval_for(task.interval) - (self._clock() - started)
            if remaining > 0:
                task.stop.wait(min(remaining, self.wait_seconds(task.interval)))


def normalize_key(codes: list[str], interval_ms: int) -> tuple[int, tuple[str, ...]]:
    normalized = tuple(sorted({str(code).strip().lower() for code in codes if str(code).strip()}))
    return int(interval_ms), normalized
