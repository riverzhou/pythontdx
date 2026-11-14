"""响应解析的回归：0x054c 记录头校验（按记录自带的代码切分，而不是按请求顺序硬对）。

被测对象：`tdxproto/parsers.py` 的 `_split_quote_records`。
"""

from __future__ import annotations

import unittest

import tdx_bridge as tdx


class TestSnapshotRecordHeader(unittest.TestCase):
    def test_single_foreign_record_uses_record_code(self):
        data = bytes([1]) + b"600519" + b"\x00" * 10
        records = tdx._split_quote_records(data, [(1, "000001")])
        self.assertEqual(len(records), 1)
        market, symbol, _ = records[0]
        self.assertEqual((market, symbol), (1, "600519"))

    def test_single_matching_record(self):
        data = bytes([1]) + b"600519" + b"\x00" * 10
        records = tdx._split_quote_records(data, [(1, "600519")])
        self.assertEqual(records[0][:2], (1, "600519"))

    def test_multiple_records_sorted_by_position(self):
        first = bytes([1]) + b"600000" + b"\x00" * 4
        second = bytes([0]) + b"000001" + b"\x00" * 4
        data = second + first  # 服务端顺序与请求顺序相反
        records = tdx._split_quote_records(
            data, [(1, "600000"), (0, "000001")]
        )
        self.assertEqual([item[:2] for item in records], [(0, "000001"), (1, "600000")])


if __name__ == "__main__":
    unittest.main()
