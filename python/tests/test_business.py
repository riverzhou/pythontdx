"""归档键与分片的回归：同一交易日多个 key、旧布局兼容、损坏重写、空行跳过、key 清洗。

被测对象：`tdxproto/business.py` 的 `_write_keyed_archive` / `_merge_archive_lists` /
`_archive_key`，以及 `code_archive` / `protocol_archive` 的落盘格式。
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import tdx_bridge as tdx
from code_archive import list_code_archives
from protocol_archive import write_dataset_archive


class TestKeyedArchive(unittest.TestCase):
    def test_two_keys_same_day_both_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = tdx._write_keyed_archive(
                root,
                "category_quotes",
                "c6_s0",
                [{"code": "sh600000"}],
                source="test",
                trade_date="2026-11-04",
            )
            second = tdx._write_keyed_archive(
                root,
                "category_quotes",
                "c7_s0",
                [{"code": "sz000001"}],
                source="test",
                trade_date="2026-11-04",
            )
            self.assertFalse(first["skipped"])
            self.assertFalse(second["skipped"])
            self.assertEqual(len(list_code_archives(root)), 2)
            merged = tdx._merge_archive_lists(root, 50)
            self.assertEqual(len(merged), 2)

    def test_legacy_layout_still_listed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_dataset_archive(
                root,
                "category_quotes",
                [{"code": "sh600000"}],
                source="legacy",
                trade_date="2026-11-03",
            )
            tdx._write_keyed_archive(
                root,
                "category_quotes",
                "c6_s0",
                [{"code": "sh600000"}],
                source="test",
                trade_date="2026-11-04",
            )
            merged = tdx._merge_archive_lists(root, 50)
            self.assertEqual(len(merged), 2)

    def test_dataset_archive_corrupt_is_rebuilt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = write_dataset_archive(
                root,
                "special_limits",
                [{"code": "sz000010"}],
                source="test",
                trade_date="2026-11-04",
            )
            self.assertFalse(first["skipped"])
            data = root / "trade_date=2026-11-04" / "special_limits.jsonl.gz"
            data.write_bytes(b"broken")
            second = write_dataset_archive(
                root,
                "special_limits",
                [{"code": "sz000010"}, {"code": "sz000011"}],
                source="test",
                trade_date="2026-11-04",
            )
            self.assertFalse(second["skipped"])
            self.assertEqual(second["rows"], 2)
            third = write_dataset_archive(
                root,
                "special_limits",
                [{"code": "sz000012"}],
                source="test",
                trade_date="2026-11-04",
            )
            self.assertTrue(third["skipped"])
            self.assertEqual(third["rows"], 2)

    def test_empty_rows_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            result = tdx._write_keyed_archive(
                Path(directory),
                "market_news",
                "tab3_p1",
                [],
                source="test",
                trade_date="2026-11-04",
            )
            self.assertTrue(result["skipped"])
            self.assertTrue(result.get("empty"))

    def test_key_sanitized(self):
        self.assertEqual(tdx._archive_key("sh600000/../../etc"), "sh600000_etc")


if __name__ == "__main__":
    unittest.main()
