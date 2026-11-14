import json
import tempfile
import unittest
from pathlib import Path

from snapshot_archive import write_snapshot_archive


class TestSnapshotArchive(unittest.TestCase):
    def test_writes_partitioned_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "trade_date=2026-10-30"
            result = write_snapshot_archive(
                root,
                [{"code": "sh600519", "name": "贵州茅台", "price": 1392.05, "changePct": 2.81}],
                "2026-10-30",
                "2026-10-30T20:00:00+08:00",
            )
            self.assertEqual(result["rows"], 1)
            self.assertTrue((root / "quotes.jsonl.gz").exists())
            self.assertTrue((root / "quotes.csv").exists())
            manifest = json.loads((root / "manifest.json").read_text("utf-8"))
            self.assertEqual(manifest["tradeDate"], "2026-10-30")
            self.assertEqual(manifest["rows"], 1)


if __name__ == "__main__":
    unittest.main()


class TestListSnapshotArchives(unittest.TestCase):
    def test_lists_latest_first(self):
        from snapshot_archive import list_snapshot_archives

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for date in ("2026-10-29", "2026-10-30"):
                write_snapshot_archive(
                    root / f"trade_date={date}",
                    [{"code": "sh600519", "name": "贵州茅台"}],
                    date,
                    f"{date}T20:00:00+08:00",
                )
            items = list_snapshot_archives(root)
            self.assertEqual([item["tradeDate"] for item in items], ["2026-10-30", "2026-10-29"])
            self.assertGreater(items[0]["size"], 0)
