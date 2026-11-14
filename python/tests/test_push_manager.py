import queue
import unittest

from push_manager import PushManager


class TestPushManager(unittest.TestCase):
    def test_first_frame_and_task_are_published(self) -> None:
        calls: list[bool] = []

        def fetch(task: dict, first: bool) -> dict:
            calls.append(first)
            return {"kind": task["kind"], "first": first}

        manager = PushManager(fetch)
        stream = manager.register_client("c1")
        sub_id = manager.subscribe("c1", {"kind": "minute"}, 1000)
        payload = stream.get(timeout=2)
        self.assertEqual(payload["type"], "push")
        self.assertEqual(payload["id"], sub_id)
        self.assertEqual(payload["task"], {"kind": "minute"})
        self.assertEqual(payload["data"], {"kind": "minute", "first": True})
        manager.unsubscribe("c1", sub_id)
        manager.close()

    def test_subscribe_before_sse_connection_still_gets_frame(self) -> None:
        """SSE 建连与 HTTP 订阅是两条请求，先订阅不能报错/丢首帧。"""
        manager = PushManager(lambda task, first: {"ok": True})
        sub_id = manager.subscribe("c2", {"kind": "ticks"}, 1000)
        stream = manager.register_client("c2")
        payload = stream.get(timeout=2)
        self.assertEqual(payload["id"], sub_id)
        manager.close()

    def test_client_isolation_and_cleanup(self) -> None:
        manager = PushManager(lambda task, first: {"ok": True})
        a = manager.register_client("a")
        b = manager.register_client("b")
        manager.subscribe("a", {"kind": "minute"}, 1000)
        manager.subscribe("b", {"kind": "fiveDay"}, 1000)
        self.assertEqual(a.get(timeout=2)["task"]["kind"], "minute")
        self.assertEqual(b.get(timeout=2)["task"]["kind"], "fiveDay")
        manager.unregister_client("a")
        with self.assertRaises(queue.Empty):
            a.get(timeout=0.2)
        manager.close()


if __name__ == "__main__":
    unittest.main()
