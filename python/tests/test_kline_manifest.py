"""K 线缓存 manifest 的离线测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from kline_manifest import (
    backfill_kline_manifests,
    manifest_path,
    verify_kline_manifests,
    write_kline_manifest,
)
from parquet_store import write_bars


class TestKlineManifest(unittest.TestCase):
    def test_write_and_verify(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "sh600519_day_3_qfq.parquet"
            write_bars(
                target,
                "sh600519",
                [
                    {"date": "2026-10-30", "open": 1, "close": 2, "high": 3, "low": 0.5, "volume": 10}
                ],
            )
            manifest = write_kline_manifest(target, {"period": "day"})
            self.assertEqual(manifest["rows"], 1)
            self.assertTrue(manifest_path(target).is_file())
            result = verify_kline_manifests(root)
            self.assertEqual(result["checked"], 1)
            self.assertEqual(result["failed"], 0)

    def test_corrupt_and_backfill(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "sh600519_5s_2_none.parquet"
            write_bars(
                target,
                "sh600519",
                [
                    {"date": "2026-10-30 09:30", "open": 1, "close": 2, "high": 3, "low": 0.5, "volume": 10}
                ],
            )
            # 没有 manifest 的旧缓存可由 backfill 补
            self.assertEqual(backfill_kline_manifests(root)["created"], 1)
            manifest = json.loads(manifest_path(target).read_text("utf-8"))
            manifest["sha256"] = "0" * 64
            manifest_path(target).write_text(json.dumps(manifest), encoding="utf-8")
            result = verify_kline_manifests(root)
            self.assertEqual(result["failed"], 1)


if __name__ == "__main__":
    unittest.main()
