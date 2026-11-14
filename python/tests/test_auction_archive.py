"""集合竞价本地归档的离线测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tdx_bridge
from auction_archive import (
    AuctionArchiveError,
    list_auction_archives,
    read_auction_archive,
    write_auction_archive,
)


def points(count: int = 3) -> list[dict]:
    return [
        {
            "index": index,
            "time": f"09:15:{index:02d}",
            "timeSeconds": 33300 + index,
            "price": 10.0 + index,
            "matchedVolume": 100 + index,
            "unmatchedVolume": index,
            "unmatchedDirection": 1,
        }
        for index in range(count)
    ]


class TestAuctionArchive(unittest.TestCase):
    def test_roundtrip_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = write_auction_archive(root, "sh600519", "2026-10-30", points())
            self.assertEqual(saved["rows"], 3)
            self.assertTrue(saved["sha256"])
            loaded = read_auction_archive(root, "sh600519", "20261030")
            self.assertEqual(loaded["rows"], 3)
            self.assertEqual(loaded["points"][1]["price"], 11.0)
            self.assertEqual(loaded["source"], "archive")
            self.assertEqual(loaded["manifest"]["parserVersion"], 1)
            items = list_auction_archives(root)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["code"], "sh600519")

    def test_valid_archive_is_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_auction_archive(root, "sh600519", "2026-10-30", points(3))
            second = write_auction_archive(root, "sh600519", "2026-10-30", points(2))
            self.assertTrue(second["skipped"])
            loaded = read_auction_archive(root, "sh600519", "2026-10-30")
            self.assertEqual(loaded["rows"], 3)

    def test_corrupt_archive_may_be_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_auction_archive(root, "sh600519", "2026-10-30", points(3))
            manifest_path = root / "trade_date=2026-10-30" / "sh600519.manifest.json"
            manifest = json.loads(manifest_path.read_text("utf-8"))
            manifest["sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            write_auction_archive(root, "sh600519", "2026-10-30", points(2))
            loaded = read_auction_archive(root, "sh600519", "2026-10-30")
            self.assertEqual(loaded["rows"], 2)

    def test_missing_and_corrupt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                read_auction_archive(root, "sh600519", "2026-10-30")
            write_auction_archive(root, "sh600519", "2026-10-30", points())
            manifest_path = root / "trade_date=2026-10-30" / "sh600519.manifest.json"
            manifest = json.loads(manifest_path.read_text("utf-8"))
            manifest["sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(AuctionArchiveError):
                read_auction_archive(root, "sh600519", "2026-10-30")

    def test_bridge_infers_trade_date_and_reads_back(self) -> None:
        bridge = object.__new__(tdx_bridge.Bridge)
        bridge.auctions = lambda code, **kwargs: points(2)
        bridge.minute = lambda code: {"date": "2026-10-30"}
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(
                tdx_bridge, "pythontdx_data_dir", return_value=Path(directory)
            ):
                saved = bridge.auction_archive_save("sh600519")
                self.assertEqual(saved["tradeDate"], "2026-10-30")
                loaded = bridge.auction_archive_read("sh600519", "20261030")
        self.assertTrue(loaded["found"])
        self.assertEqual(loaded["rows"], 2)

    def test_batch_archives_watchlist_and_reports_failure(self) -> None:
        bridge = object.__new__(tdx_bridge.Bridge)
        bridge.auctions = lambda code, **kwargs: points(2)
        bridge.minute = lambda code: {"date": "2026-10-30"}
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(
                tdx_bridge, "pythontdx_data_dir", return_value=Path(directory)
            ):
                result = bridge.auction_archive_batch(
                    ["sh600519", "bad", "sz000001", "sh600519"]
                )
                first = bridge.auction_archive_read("sh600519", "2026-10-30")
        self.assertEqual(result["tradeDate"], "2026-10-30")
        self.assertEqual(result["savedCount"], 2)
        self.assertEqual(result["failedCount"], 1)
        self.assertEqual(first["rows"], 2)

    def test_invalid_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(AuctionArchiveError):
                write_auction_archive(root, "hk00700", "2026-10-30", points())
            with self.assertRaises(AuctionArchiveError):
                write_auction_archive(root, "sh600519", "2026-02-30", points())
            with self.assertRaises(AuctionArchiveError):
                write_auction_archive(root, "sh600519", "2026-10-30", [])


if __name__ == "__main__":
    unittest.main()
