"""F10 point-in-time 快照的离线测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from f10_pit import (
    F10SnapshotError,
    list_f10_snapshots,
    read_f10_snapshot,
    write_f10_snapshot,
)


class TestF10Pit(unittest.TestCase):
    def test_roundtrip_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = {
                "报告期": "2026-09-30",
                "tables": [{"columns": ["指标"], "rows": [["EPS"]]}],
            }
            saved = write_f10_snapshot(
                root, "sh600519", "f10_finance", payload, snapshot_date="2026-10-31"
            )
            self.assertFalse(saved["skipped"])
            loaded = read_f10_snapshot(
                root, "sh600519", "f10_finance", "2026-10-31"
            )
            self.assertEqual(loaded["reportDate"], "2026-09-30")
            self.assertEqual(loaded["payload"]["tables"][0]["rows"][0][0], "EPS")
            self.assertEqual(loaded["rows"], 1)
            self.assertEqual(list_f10_snapshots(root)[0]["table"], "f10_finance")

    def test_same_day_is_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_f10_snapshot(
                root, "sh600519", "f10_valuation", {"value": 1}, snapshot_date="2026-10-31"
            )
            second = write_f10_snapshot(
                root, "sh600519", "f10_valuation", {"value": 2}, snapshot_date="2026-10-31"
            )
            self.assertTrue(second["skipped"])
            loaded = read_f10_snapshot(
                root, "sh600519", "f10_valuation", "2026-10-31"
            )
            self.assertEqual(loaded["payload"]["value"], 1)

    def test_corrupt_snapshot_can_be_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_f10_snapshot(
                root, "sh600519", "f10_news", [{"title": "a"}], snapshot_date="2026-10-31"
            )
            manifest_path = (
                root
                / "snapshot_date=2026-10-31"
                / "f10_news"
                / "sh600519.manifest.json"
            )
            manifest = json.loads(manifest_path.read_text("utf-8"))
            manifest["sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            write_f10_snapshot(
                root, "sh600519", "f10_news", [{"title": "b"}], snapshot_date="2026-10-31"
            )
            loaded = read_f10_snapshot(root, "sh600519", "f10_news", "2026-10-31")
            self.assertEqual(loaded["payload"][0]["title"], "b")

    def test_missing_and_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                read_f10_snapshot(root, "sh600519", "f10_finance", "2026-10-31")
            with self.assertRaises(F10SnapshotError):
                write_f10_snapshot(root, "bad", "f10_finance", {})


if __name__ == "__main__":
    unittest.main()
