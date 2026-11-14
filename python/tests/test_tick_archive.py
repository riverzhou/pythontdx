"""历史逐笔本地归档的离线测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

import tdx_bridge
from tick_archive import (
    TickArchiveError,
    latest_tick_archive,
    list_tick_archives,
    read_tick_archive,
    write_tick_archive,
)


def ticks(count: int = 3) -> list[dict]:
    return [
        {
            "index": index,
            "time": f"09:30:{index:02d}",
            "timeSeconds": 34200 + index,
            "timeMinutes": 570,
            "price": 10.0 + index / 100,
            "volume": 100 + index,
            "orderCount": 1,
            "status": 0,
            "side": "buy",
            "eventKind": "trade",
        }
        for index in range(count)
    ]


class TestTickArchive(unittest.TestCase):
    def test_roundtrip_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = write_tick_archive(root, "sh600519", "2026-10-30", ticks())
            self.assertEqual(saved["rows"], 3)
            self.assertTrue(saved["sha256"])
            loaded = read_tick_archive(root, "sh600519", "20261030")
            self.assertEqual(loaded["rows"], 3)
            self.assertEqual(loaded["ticks"][1]["price"], 10.01)
            self.assertEqual(loaded["manifest"]["schema"], "pythontdx.ticks.v1")
            items = list_tick_archives(root)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["code"], "sh600519")

    def test_valid_archive_is_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_tick_archive(root, "sh600519", "2026-10-30", ticks(3))
            second = write_tick_archive(root, "sh600519", "2026-10-30", ticks(2))
            self.assertTrue(second["skipped"])
            self.assertEqual(read_tick_archive(root, "sh600519", "2026-10-30")["rows"], 3)

    def test_corrupt_archive_may_be_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_tick_archive(root, "sh600519", "2026-10-30", ticks(3))
            manifest_path = root / "trade_date=2026-10-30" / "sh600519.manifest.json"
            manifest = json.loads(manifest_path.read_text("utf-8"))
            manifest["sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            write_tick_archive(root, "sh600519", "2026-10-30", ticks(2))
            self.assertEqual(read_tick_archive(root, "sh600519", "2026-10-30")["rows"], 2)

    def test_missing_and_corrupt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                read_tick_archive(root, "sh600519", "2026-10-30")
            write_tick_archive(root, "sh600519", "2026-10-30", ticks())
            manifest_path = root / "trade_date=2026-10-30" / "sh600519.manifest.json"
            manifest = json.loads(manifest_path.read_text("utf-8"))
            manifest["sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(TickArchiveError):
                read_tick_archive(root, "sh600519", "2026-10-30")

    def test_trades_prefers_archive_and_slices(self) -> None:
        bridge = object.__new__(tdx_bridge.Bridge)
        bridge.conn = None
        bridge.index = None
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(
                tdx_bridge, "pythontdx_data_dir", return_value=Path(directory)
            ):
                write_tick_archive(
                    Path(directory) / "lake" / "ticks", "sh600519", "2026-10-30", ticks(5)
                )
                page = bridge.trades(
                    "sh600519", start=1, count=2, trading_date="2026-10-30"
                )
        self.assertEqual([item["index"] for item in page], [1, 2])

    def test_latest_tick_archive_prefers_newest_date(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_tick_archive(root, "sh600519", "2026-10-29", ticks(3))
            write_tick_archive(root, "sh600519", "2026-10-30", ticks(5))
            latest = latest_tick_archive(root, "sh600519")
            self.assertEqual(latest["tradeDate"], "2026-10-30")
            self.assertEqual(latest["rows"], 5)

    def test_latest_tick_archive_missing_raises(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                latest_tick_archive(Path(directory), "sh600519")

    def test_prefer_tick_archive_only_when_market_closed(self) -> None:
        # 周六：全天读归档
        self.assertTrue(
            tdx_bridge.prefer_tick_archive(datetime(2026, 10, 31, 10, 0), "2026-10-30")
        )
        # 周五收盘后，且归档就是当天：读归档
        self.assertTrue(
            tdx_bridge.prefer_tick_archive(datetime(2026, 10, 30, 15, 5), "2026-10-30")
        )
        # 周五盘中/午休：仍走实时
        self.assertFalse(
            tdx_bridge.prefer_tick_archive(datetime(2026, 10, 30, 14, 0), "2026-10-30")
        )
        # 收盘后但归档不是当天（当天数据未落地）：仍走实时
        self.assertFalse(
            tdx_bridge.prefer_tick_archive(datetime(2026, 10, 30, 15, 10), "2026-10-29")
        )

    def test_trades_reads_latest_archive_when_market_closed(self) -> None:
        bridge = object.__new__(tdx_bridge.Bridge)
        bridge.conn = None
        bridge.index = None
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(
                tdx_bridge, "pythontdx_data_dir", return_value=Path(directory)
            ):
                write_tick_archive(
                    Path(directory) / "lake" / "ticks", "sh600519", "2026-10-30", ticks(5)
                )
                with mock.patch.object(
                    tdx_bridge, "prefer_tick_archive", return_value=True
                ):
                    page = bridge.trades("sh600519", start=1, count=2)
        self.assertEqual([item["index"] for item in page], [1, 2])

    def test_save_fetches_all_pages_and_skips_existing(self) -> None:
        bridge = object.__new__(tdx_bridge.Bridge)
        calls: list[int] = []

        def fake_trades(code: str, start: int = 0, count: int = 1800, trading_date=None):
            calls.append(start)
            if start == 0:
                return ticks(1800)
            if start == 1800:
                rendered = ticks(2)
                rendered[0]["index"] = 1800
                rendered[1]["index"] = 1801
                return rendered
            return []

        bridge.trades = fake_trades
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(
                tdx_bridge, "pythontdx_data_dir", return_value=Path(directory)
            ):
                saved = bridge.tick_archive_save("sh600519", "2026-10-30")
                again = bridge.tick_archive_save("sh600519", "2026-10-30")
        self.assertEqual(saved["rows"], 1802)
        self.assertTrue(again["skipped"])
        self.assertEqual(calls, [0, 1800])


if __name__ == "__main__":
    unittest.main()
