"""面板级推送的服务端调度。

为什么放在 Python：
  · 渲染层定时器在窗口最小化/标签页后台时会被节流，节奏不可控；
  · 同一个任务在桌面和浏览器各起一套 Timer，迟早出现两套间隔；
  · 数据由 Bridge 产生，调度贴在数据旁边，客户端只负责收 SSE。

每个订阅一个线程，线程内串行拉取（防重入），按“上次结束 + interval”
链式等待；客户端断开时整组订阅一起停止，不留下孤儿线程。
"""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

MIN_INTERVAL_MS = 1000
MAX_QUEUE = 256


@dataclass
class PushSubscription:
    id: int
    client_id: str
    task: dict[str, Any]
    interval: float
    fetched: bool = False
    stop: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None


class PushManager:
    def __init__(self, fetch: Callable[[dict[str, Any], bool], Any]) -> None:
        self._fetch = fetch
        self._lock = threading.Lock()
        self._clients: dict[str, queue.Queue[dict[str, Any]]] = {}
        self._subs: dict[tuple[str, int], PushSubscription] = {}
        self._next_id = 1

    def register_client(self, client_id: str) -> queue.Queue[dict[str, Any]]:
        with self._lock:
            stream = self._clients.get(client_id)
            if stream is None:
                stream = queue.Queue(maxsize=MAX_QUEUE)
                self._clients[client_id] = stream
            return stream

    def unregister_client(self, client_id: str) -> None:
        with self._lock:
            self._clients.pop(client_id, None)
            subs = [sub for (cid, _), sub in self._subs.items() if cid == client_id]
            for key in [key for key in self._subs if key[0] == client_id]:
                self._subs.pop(key, None)
        for sub in subs:
            sub.stop.set()

    def subscribe(
        self,
        client_id: str,
        task: dict[str, Any],
        interval_ms: int,
        sub_id: int | None = None,
    ) -> int:
        interval = max(MIN_INTERVAL_MS, int(interval_ms)) / 1000.0
        with self._lock:
            # SSE 建连与 HTTP 订阅是两条请求，存在竞态：订阅先到也可以先建队列，
            # 等 /api/push 连上后从同一个队列读，首帧不会丢。
            if client_id not in self._clients:
                self._clients[client_id] = queue.Queue(maxsize=MAX_QUEUE)
            if sub_id is not None:
                old = self._subs.pop((client_id, int(sub_id)), None)
                if old is not None:
                    old.stop.set()
                next_id = int(sub_id)
            else:
                next_id = self._next_id
                self._next_id += 1
            sub = PushSubscription(
                id=next_id,
                client_id=client_id,
                task=dict(task),
                interval=interval,
            )
            self._subs[(client_id, sub.id)] = sub
            sub.thread = threading.Thread(
                target=self._run,
                args=(sub,),
                name=f"push-{client_id}-{sub.id}",
                daemon=True,
            )
        sub.thread.start()
        return sub.id

    def unsubscribe(self, client_id: str, sub_id: int) -> None:
        with self._lock:
            sub = self._subs.pop((client_id, int(sub_id)), None)
        if sub is not None:
            sub.stop.set()

    def close(self) -> None:
        with self._lock:
            subs = list(self._subs.values())
            self._subs.clear()
            self._clients.clear()
        for sub in subs:
            sub.stop.set()

    # -- internals ----------------------------------------------------

    def _publish(self, client_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            stream = self._clients.get(client_id)
        if stream is None:
            return
        try:
            stream.put_nowait(payload)
        except queue.Full:
            try:
                stream.get_nowait()
            except queue.Empty:
                pass
            try:
                stream.put_nowait(payload)
            except queue.Full:
                pass

    def _run(self, sub: PushSubscription) -> None:
        while not sub.stop.is_set():
            started = time.monotonic()
            try:
                data = self._fetch(sub.task, not sub.fetched)
                payload = {
                    "type": "push",
                    "id": sub.id,
                    "at": int(time.time() * 1000),
                    "task": sub.task,
                    "data": data,
                }
            except Exception as error:  # noqa: BLE001 - 单轮失败不终止订阅
                payload = {
                    "type": "push",
                    "id": sub.id,
                    "at": int(time.time() * 1000),
                    "task": sub.task,
                    "error": str(error),
                }
            sub.fetched = True
            self._publish(sub.client_id, payload)
            elapsed = time.monotonic() - started
            wait = max(0.05, sub.interval - elapsed)
            if sub.stop.wait(wait):
                return
