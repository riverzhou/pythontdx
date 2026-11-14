"""通用归档 manifest 审计测试；不联网。"""

import gzip
import tempfile
import unittest
from pathlib import Path

from data_integrity import _verify_generic, verify_data_integrity
from protocol_archive import read_dataset_archive, write_dataset_archive


class TestGenericIntegrity(unittest.TestCase):
    def test_manifest_ok_and_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "lake" / "finance"
            write_dataset_archive(
                target,
                "finance",
                [{"code": "sh600519", "netProfit": 1}],
                source="test",
                trade_date="2026-11-04",
                fields=["code", "netProfit"],
            )
            ok = _verify_generic(root, "finance", "lake/finance/**/manifest.json")
            self.assertEqual(ok["checked"], 1)
            self.assertEqual(ok["failed"], 0)

            jsonl = next(target.glob("trade_date=*/*.jsonl.gz"))
            with gzip.open(jsonl, "at", encoding="utf-8") as handle:
                handle.write("{}\n")
            bad = _verify_generic(root, "finance", "lake/finance/**/manifest.json")
            self.assertEqual(bad["failed"], 1)
            self.assertIn("SHA256", bad["details"][0]["error"])

    def test_full_verify_counts_generic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_dataset_archive(
                root / "lake" / "finance",
                "finance",
                [{"code": "sh600519"}],
                source="test",
                trade_date="2026-11-04",
            )
            result = verify_data_integrity(root)
            self.assertTrue(result["ok"])
            self.assertGreaterEqual(result["checked"], 1)

    def test_read_dataset_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_dataset_archive(
                root,
                "finance",
                [{"code": "sh600519", "netProfit": 1}],
                source="test",
                trade_date="2026-11-04",
            )
            result = read_dataset_archive(root, "finance", "2026-11-04")
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["rows"][0]["code"], "sh600519")
            with self.assertRaises(ValueError):
                read_dataset_archive(root, "../x", "2026-11-04")


if __name__ == "__main__":
    unittest.main()
