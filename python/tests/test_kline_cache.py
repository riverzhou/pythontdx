"""K 线本地缓存读写测试；不依赖网络。"""

import os
import tempfile
import unittest
from pathlib import Path

import tdx_bridge


class TestKlineCache(unittest.TestCase):
    def setUp(self):
        self.previous = os.environ.get("PYTHONTDX_DATA_DIR")
        self.temp = tempfile.TemporaryDirectory()
        os.environ["PYTHONTDX_DATA_DIR"] = self.temp.name

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("PYTHONTDX_DATA_DIR", None)
        else:
            os.environ["PYTHONTDX_DATA_DIR"] = self.previous
        self.temp.cleanup()

    def test_write_and_read_cache(self):
        bars = [
            {
                "date": "2026-10-30",
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "volume": 100,
                "amount": 105000,
            }
        ]
        path = tdx_bridge._write_kline_cache("sh600519", "day", 30, "qfq", bars, "network")
        self.assertTrue(Path(path).exists())
        cached = tdx_bridge._read_kline_cache("sh600519", "day", 30, "qfq")
        self.assertIsNotNone(cached)
        self.assertEqual(cached["source"], "cache")
        self.assertEqual(cached["bars"][0]["close"], 10.5)
        self.assertEqual(cached["bars"][0]["amount"], 105000)

    def test_missing_cache_returns_none(self):
        self.assertIsNone(tdx_bridge._read_kline_cache("sh600519", "day", 99, "qfq"))

    def test_cache_only_miss_is_an_empty_series_not_an_error(self):
        """首屏缓存探测：miss 是正常结果，不能抛异常污染 Electron 日志。"""
        bridge = tdx_bridge.Bridge()
        try:
            result = bridge.kline("sh600519", "day", 30, "qfq", cache_only=True)
        finally:
            bridge.close()
        self.assertTrue(result["miss"])
        self.assertEqual(result["bars"], [])
        self.assertEqual(result["source"], "cache")

    def test_cache_only_hit_returns_cached_bars(self):
        bars = [
            {
                "date": "2026-10-30",
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "volume": 100,
            }
        ]
        tdx_bridge._write_kline_cache("sh600519", "day", 30, "qfq", bars, "network")
        bridge = tdx_bridge.Bridge()
        try:
            result = bridge.kline("sh600519", "day", 30, "qfq", cache_only=True)
        finally:
            bridge.close()
        self.assertFalse(result.get("miss", False))
        self.assertEqual(result["source"], "cache")
        self.assertEqual(result["bars"][-1]["close"], 10.5)
