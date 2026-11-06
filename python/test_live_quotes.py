"""Bridge.live_quotes 的编排测试：不连行情服务器，只验证合并与兜底顺序。"""

import unittest
from datetime import datetime
from unittest.mock import patch

from tdx_bridge import (
    Bridge,
    _merge_auction_quotes,
    _merge_quotes,
    _merge_snapshot_prices,
    _normalize_codes,
    ms_until_session_change,
    shanghai_clock,
)


class FakeBridge:
    """只实现 live_quotes 依赖的四个行情方法。"""

    def __init__(
        self,
        snapshots=None,
        refreshed=None,
        auctions=None,
        mac=None,
        refresh_error=None,
    ):
        self.snapshot_result = list(snapshots or [])
        self.refresh_result = list(refreshed or [])
        self.auction_result = list(auctions or [])
        self.mac_result = list(mac or [])
        self.refresh_error = refresh_error
        self.snapshot_calls = []
        self.refresh_calls = []
        self.auction_calls = []
        self.mac_calls = []

    def snapshots(self, codes):
        self.snapshot_calls.append(list(codes))
        return list(self.snapshot_result)

    def refresh_quotes(self, codes, cursors=None):
        self.refresh_calls.append(list(codes))
        if self.refresh_error is not None:
            raise self.refresh_error
        return list(self.refresh_result)

    def auction_quotes(self, codes):
        self.auction_calls.append(list(codes))
        return list(self.auction_result)

    def mac_quotes(self, codes):
        self.mac_calls.append(list(codes))
        return list(self.mac_result)


def live(bridge, codes, clock=("10:00:00", "trading")):
    with patch("tdx_bridge.shanghai_clock", return_value=clock):
        return Bridge.live_quotes(bridge, codes)


def quote(code, price, **extra):
    return {"code": code, "price": price, **extra}


class NormalizeTests(unittest.TestCase):
    def test_normalize_lowercases_trims_and_dedupes(self):
        self.assertEqual(
            _normalize_codes([" SH600519 ", "sh600519", "", "sz000001"]),
            ["sh600519", "sz000001"],
        )


class MergeTests(unittest.TestCase):
    def test_merge_quotes_incoming_wins(self):
        merged = _merge_quotes([quote("a", 1)], [quote("a", 2), quote("b", 3)])
        self.assertEqual([item["price"] for item in merged], [2, 3])

    def test_snapshot_price_wins_refresh_keeps_depth(self):
        snapshots = [
            quote("a", 11, prevClose=10, open=10.5, high=12, low=9.8, volume=100, amount=1100)
        ]
        refreshed = [
            {
                "code": "a",
                "price": 10,
                "prevClose": 10,
                "open": 10.5,
                "high": 11,
                "low": 9.9,
                "volume": 90,
                "amount": 900,
                "bids": [{"price": 10.99, "volume": 1}],
                "asks": [{"price": 11.01, "volume": 2}],
                "updateTime": 123,
            }
        ]
        merged = _merge_snapshot_prices(snapshots, refreshed)[0]
        self.assertEqual(merged["price"], 11)
        self.assertEqual(merged["high"], 12)
        self.assertEqual(merged["low"], 9.8)
        self.assertEqual(len(merged["bids"]), 1)
        # 快照没有交易所时间：字段必须缺失，不能是 null（JSON null 会被
        # StatusBar 的 `!== undefined` 当成有效时间显示成「—」）。
        self.assertNotIn("updateTime", merged)

    def test_snapshot_empty_returns_refresh(self):
        refreshed = [quote("a", 10)]
        self.assertEqual(_merge_snapshot_prices([], refreshed), refreshed)

    def test_refresh_empty_returns_snapshots(self):
        snapshots = [quote("a", 10)]
        self.assertEqual(_merge_snapshot_prices(snapshots, []), snapshots)

    def test_auction_keeps_existing_depth_and_prev_close(self):
        base = [quote("a", 10, prevClose=9, open=9.5, bids=[{"price": 9.9, "volume": 1}])]
        auctions = [quote("a", 10.5, high=10.6, low=10.4, auctionTime="09:25:00")]
        merged = _merge_auction_quotes(base, auctions)[0]
        self.assertEqual(merged["price"], 10.5)
        self.assertEqual(merged["prevClose"], 9)
        self.assertEqual(merged["open"], 9.5)
        self.assertEqual(len(merged["bids"]), 1)
        self.assertTrue(merged["auction"])


class ClockTests(unittest.TestCase):
    def test_sessions(self):
        from datetime import datetime

        def at(hour, minute, second=0):
            return shanghai_clock(
                datetime(2026, 11, 5, hour, minute, second, tzinfo=_tz())
            )[1]

        self.assertEqual(at(9, 14), "closed")
        self.assertEqual(at(9, 15), "pre-open")
        self.assertEqual(at(9, 30), "trading")
        self.assertEqual(at(11, 30), "lunch-break")
        self.assertEqual(at(13, 0), "trading")
        self.assertEqual(at(15, 0), "trading")
        self.assertEqual(at(15, 1), "closed")


def _tz():
    from datetime import timedelta, timezone

    return timezone(timedelta(hours=8))


class SessionBoundaryTests(unittest.TestCase):
    def test_boundary_before_open_and_lunch(self):
        before_open = datetime(2026, 11, 5, 9, 29, 0, tzinfo=_tz())
        self.assertAlmostEqual(ms_until_session_change(before_open), 60_000, delta=1)
        before_afternoon = datetime(2026, 11, 5, 12, 59, 50, tzinfo=_tz())
        self.assertAlmostEqual(ms_until_session_change(before_afternoon), 10_000, delta=1)
        # 低频等待可能正好在 12:59:59.6 醒来：400ms 的边界不能被跳过
        just_before = datetime(2026, 11, 5, 12, 59, 59, 600000, tzinfo=_tz())
        self.assertAlmostEqual(ms_until_session_change(just_before), 400, delta=1)
        exact = datetime(2026, 11, 5, 13, 0, 0, tzinfo=_tz())
        self.assertEqual(ms_until_session_change(exact), 0)

    def test_weekend_skips_to_monday(self):
        friday_evening = datetime(2026, 11, 6, 16, 0, 0, tzinfo=_tz())
        # 周五 16:00 → 周一 09:15，共 65 小时 15 分
        self.assertAlmostEqual(
            ms_until_session_change(friday_evening), (65 * 60 + 15) * 60_000, delta=1
        )


class LiveQuotesTests(unittest.TestCase):
    def test_intraday_merges_snapshot_and_refresh(self):
        bridge = FakeBridge(
            snapshots=[quote("sh600519", 1700, prevClose=1650, high=1710, low=1690)],
            refreshed=[quote("sh600519", 1660, prevClose=1650, high=1700, low=1680)],
        )
        result = live(bridge, ["sh600519"])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["price"], 1700)
        self.assertEqual(len(bridge.snapshot_calls), 1)
        self.assertEqual(len(bridge.refresh_calls), 1)

    def test_intraday_refresh_failure_keeps_snapshots(self):
        bridge = FakeBridge(
            snapshots=[quote("sh600519", 1700, prevClose=1650)],
            refresh_error=RuntimeError("7709 down"),
        )
        result = live(bridge, ["sh600519"])
        self.assertEqual(result[0]["price"], 1700)

    def test_pre_open_skips_refresh_when_snapshots_cover_codes(self):
        bridge = FakeBridge(
            snapshots=[quote("sh600519", 1700, prevClose=1650)],
            refreshed=[quote("sh600519", 1650)],
        )
        result = live(bridge, ["sh600519"], clock=("09:20:00", "pre-open"))
        self.assertEqual(bridge.refresh_calls, [])
        self.assertEqual(result[0]["price"], 1700)

    def test_opening_grace_skips_refresh(self):
        bridge = FakeBridge(
            snapshots=[quote("sh600519", 1700)],
            refreshed=[quote("sh600519", 1650)],
        )
        result = live(bridge, ["sh600519"], clock=("09:30:05", "trading"))
        self.assertEqual(bridge.refresh_calls, [])
        self.assertEqual(result[0]["price"], 1700)

    def test_opening_window_refreshes_when_snapshots_incomplete(self):
        bridge = FakeBridge(
            snapshots=[quote("sh600519", 1700)],
            refreshed=[quote("sh600519", 1650), quote("sz000001", 12)],
        )
        result = live(bridge, ["sh600519", "sz000001"], clock=("09:20:00", "pre-open"))
        self.assertEqual(len(bridge.refresh_calls), 1)
        self.assertEqual([item["code"] for item in result], ["sh600519", "sz000001"])
        self.assertEqual(result[0]["price"], 1700)
        self.assertEqual(result[1]["price"], 12)

    def test_pre_open_auction_fallback_fills_zero_price(self):
        bridge = FakeBridge(
            snapshots=[],
            refreshed=[quote("sh600519", 0, prevClose=1650)],
            auctions=[quote("sh600519", 1680, auctionTime="09:20:03")],
        )
        result = live(bridge, ["sh600519"], clock=("09:20:00", "pre-open"))
        self.assertEqual(bridge.auction_calls, [["sh600519"]])
        self.assertEqual(result[0]["price"], 1680)
        self.assertEqual(result[0]["prevClose"], 1650)
        self.assertEqual(result[0]["auctionTime"], "09:20:03")

    def test_auction_only_fills_missing_when_over_limit(self):
        codes = [f"sh{600000 + index}" for index in range(81)]
        missing = codes[0]
        bridge = FakeBridge(
            snapshots=[],
            refreshed=[quote(code, 10) for code in codes[1:]],
            auctions=[quote(missing, 11)],
        )
        live(bridge, codes, clock=("09:20:00", "pre-open"))
        self.assertEqual(bridge.auction_calls, [[missing]])

    def test_mac_fallback_when_all_empty(self):
        bridge = FakeBridge(mac=[quote("sh600519", 1700)])
        result = live(bridge, ["sh600519"])
        self.assertEqual(len(bridge.mac_calls), 1)
        self.assertEqual(result[0]["price"], 1700)

    def test_returns_requested_order_and_dedupes(self):
        bridge = FakeBridge(
            snapshots=[quote("sh600519", 1700), quote("sz000001", 12)],
            refreshed=[quote("sh600519", 1700), quote("sz000001", 12)],
        )
        result = live(bridge, ["sz000001", " SH600519 ", "sz000001"])
        self.assertEqual([item["code"] for item in result], ["sz000001", "sh600519"])

    def test_empty_codes_short_circuit(self):
        bridge = FakeBridge()
        self.assertEqual(live(bridge, []), [])
        self.assertEqual(bridge.snapshot_calls, [])


if __name__ == "__main__":
    unittest.main()
