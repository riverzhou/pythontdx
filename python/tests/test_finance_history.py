"""gpcw 历史财务解析/清单/zip 限额的离线测试。"""

from __future__ import annotations

import io
import struct
import unittest
import zipfile

from finance_history import (
    FinanceHistoryError,
    extract_dat,
    parse_dat,
    parse_file_list,
    parse_zip,
)


def build_dat(report_date: int = 20260930) -> bytes:
    header = struct.pack("<hIHLLL", 0, report_date, 2, 0, 8, 0)
    data_offset = len(header) + 2 * 11
    index = struct.pack("<6scL", b"600519", b"\x01", data_offset)
    index += struct.pack("<6scL", b"000001", b"\x00", data_offset + 8)
    rows = struct.pack("<2f", 1.5, 2.5) + struct.pack("<2f", 3.5, 4.5)
    return header + index + rows


class TestFinanceHistory(unittest.TestCase):
    def test_parse_file_list(self):
        entries = parse_file_list(
            b"gpcw20260930.zip,abc,5489471\ngpcw20261231.zip,def,164\nbad-line\n"
        )
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["filename"], "gpcw20260930.zip")
        self.assertEqual(entries[0]["size"], 5489471)

    def test_parse_dat(self):
        rows = parse_dat(build_dat())
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["code"], "sh600519")
        self.assertEqual(rows[0]["reportDate"], "2026-09-30")
        self.assertEqual(rows[0]["fieldCount"], 2)
        self.assertEqual(rows[0]["fields"], [1.5, 2.5])
        self.assertEqual(rows[1]["code"], "sz000001")
        self.assertEqual(rows[1]["fields"], [3.5, 4.5])

    def test_parse_zip(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("gpcw20260930.dat", build_dat())
        rows = parse_zip(buffer.getvalue())
        self.assertEqual(len(rows), 2)

    def test_duplicate_offset_rejected(self):
        data = bytearray(build_dat())
        # 第二条索引指向与第一条相同的数据偏移
        offset = struct.unpack_from("<L", data, 20 + 11 + 7)[0]
        struct.pack_into("<L", data, 20 + 11 + 7, struct.unpack_from("<L", data, 20 + 7)[0])
        self.assertNotEqual(offset, 0)
        # 重复偏移只丢这一条，不丢整包
        rows = parse_dat(bytes(data))
        self.assertEqual(len(rows), 1)

    def test_bad_report_size_rejected(self):
        header = struct.pack("<hIHLLL", 0, 20260930, 0, 0, 6, 0)
        with self.assertRaises(FinanceHistoryError):
            parse_dat(header)

    def test_zip_without_dat_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("readme.txt", "x")
        with self.assertRaises(FinanceHistoryError):
            extract_dat(buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
