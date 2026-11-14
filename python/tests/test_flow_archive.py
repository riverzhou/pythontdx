"""资金流归档离线测试。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from flow_archive import FlowArchiveError, list_flow_archives, read_flow_archive, write_flow_archive


class TestFlowArchive(unittest.TestCase):
    def test_roundtrip_and_skip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = {"mainNet": 1.0, "receivedAt": 1793444686414}
            first = write_flow_archive(root, "sh600519", payload)
            self.assertFalse(first["skipped"])
            second = write_flow_archive(root, "sh600519", {"mainNet": 2.0, "receivedAt": 1793444686414})
            self.assertTrue(second["skipped"])
            loaded = read_flow_archive(root, "sh600519", first["tradeDate"])
            self.assertEqual(loaded["payload"]["mainNet"], 1.0)
            self.assertEqual(len(list_flow_archives(root)), 1)

    def test_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FlowArchiveError):
                write_flow_archive(Path(directory), "bad", {"a": 1})
            with self.assertRaises(FileNotFoundError):
                read_flow_archive(Path(directory), "sh600519", "2026-10-31")


if __name__ == "__main__":
    unittest.main()
