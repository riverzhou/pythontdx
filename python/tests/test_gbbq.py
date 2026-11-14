"""GBBQ 解密/解析测试（用本机 gbbq 首条记录做真实密文 fixture）。"""

from __future__ import annotations

import struct
import tempfile
import unittest
from pathlib import Path

import gbbq


class TestGbbq(unittest.TestCase):
    # 首条记录（29B）来自通达信 gbbq，明文：sz000001 1990-03-01 配股价 3.56
    RECORD = bytes.fromhex(
        "631224b0f311c9a953c0bb1806866a39dcbc5c5514c3e1d2000000803f"
    )

    def test_key_size(self):
        self.assertEqual(len(gbbq._KEY), 4176)

    def test_read_first_record(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gbbq"
            path.write_bytes(struct.pack("<I", 1) + self.RECORD)
            rows = gbbq.read_gbbq(path)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["code"], "sz000001")
        self.assertEqual(row["date"], "1990-03-01")
        self.assertEqual(row["category"], 1)
        self.assertEqual(row["categoryName"], "除权除息")
        self.assertAlmostEqual(row["c2"], 3.56, places=4)
        self.assertAlmostEqual(row["c4"], 1.0, places=4)

    def test_truncated_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gbbq"
            path.write_bytes(struct.pack("<I", 2) + self.RECORD)
            with self.assertRaises(ValueError):
                gbbq.read_gbbq(path)

    def test_empty_and_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gbbq"
            path.write_bytes(b"")
            self.assertEqual(gbbq.read_gbbq(path), [])
        with self.assertRaises(FileNotFoundError):
            gbbq.read_gbbq(Path(directory) / "missing")


if __name__ == "__main__":
    unittest.main()
