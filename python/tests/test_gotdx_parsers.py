"""gotdx 吸收的三条 7709 命令（0x0563 / 0x053f / 0x051a）离线解析测试。"""

from __future__ import annotations

import struct
import unittest

import tdx_bridge


def encode_varint(value: int) -> bytes:
    """按 read_varint 的规则编码：首字节 6 位数据 + 符号位，续接字节 7 位。"""
    negative = value < 0
    remaining = -value if negative else value
    first = remaining & 0x3F
    remaining >>= 6
    if negative:
        first |= 0x40
    output = bytearray([first | (0x80 if remaining else 0)])
    while remaining:
        chunk = remaining & 0x7F
        remaining >>= 7
        output.append(chunk | (0x80 if remaining else 0))
    return bytes(output)


class TestUnusual(unittest.TestCase):
    def test_parse_event(self):
        record = bytearray(32)
        struct.pack_into("<H", record, 0, 1)  # 上海
        record[2:8] = b"600519"
        record[9] = 0x04  # 加速拉升
        struct.pack_into("<H", record, 11, 7)
        struct.pack_into("<f", record, 16, 0.05)
        record[29] = 10
        struct.pack_into("<H", record, 30, 305)  # 10:03:05
        body = struct.pack("<H", 1) + bytes(record)
        rows = tdx_bridge.parse_unusual(body)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["code"], "sh600519")
        self.assertEqual(rows[0]["desc"], "加速拉升")
        self.assertEqual(rows[0]["value"], "5.00%")
        self.assertEqual(rows[0]["time"], "10:03:05")
        self.assertEqual(rows[0]["index"], 7)

    def test_known_event_types(self):
        for event, text in (
            (0x03, "主力买入"),
            (0x06, "低位反弹"),
            (0x16, "盘中强势"),
            (0x1D, "急速拉升"),
        ):
            payload = bytearray(13)
            struct.pack_into("<f", payload, 1, 0.01)
            self.assertEqual(tdx_bridge._unusual_text(event, bytes(payload))[0], text)

    def test_truncated_rejected(self):
        with self.assertRaises(tdx_bridge.TdxError):
            tdx_bridge.parse_unusual(b"\x05\x00\x00")


class TestTopBoard(unittest.TestCase):
    def test_parse_nine_boards(self):
        size = 2
        body = bytearray([size])
        for board in range(9):
            for row in range(size):
                code = f"60051{board}".encode("ascii")[:6]
                body += bytes([1])
                body += code
                body += struct.pack("<ff", 10.5 + row, 1.25 + board)
        result = tdx_bridge.parse_top_board(bytes(body))
        self.assertEqual(result["size"], 2)
        self.assertEqual(len(result["boards"]), 9)
        first = result["boards"]["increase"][0]
        self.assertEqual(first["code"], "sh600510")
        self.assertAlmostEqual(first["price"], 10.5, places=3)
        self.assertAlmostEqual(first["value"], 1.25, places=3)

    def test_truncated_rejected(self):
        with self.assertRaises(tdx_bridge.TdxError):
            tdx_bridge.parse_top_board(bytes([5]) + b"\x00" * 10)


class TestVolumeProfile(unittest.TestCase):
    def build_body(self) -> bytes:
        body = bytearray()
        body += struct.pack("<H", 1)  # 档数
        body += bytes([1])  # 市场
        body += b"600519"
        body += struct.pack("<H", 5)  # active
        for value in (1050, -10, 5, 20, -20, 0, 0, 1000, 10):
            body += encode_varint(value)
        body += struct.pack("<f", 12345.0)  # amount
        for value in (400, 600, 0, 0):
            body += encode_varint(value)
        for index in range(3):
            body += encode_varint(index)  # bid 价差
            body += encode_varint(index + 1)  # ask 价差
            body += encode_varint(100 + index)  # bid 量
            body += encode_varint(200 + index)  # ask 量
        body += struct.pack("<H", 0)  # unknown
        body += encode_varint(1050)  # 首档绝对价位（分）
        body += encode_varint(500)
        body += encode_varint(300)
        body += encode_varint(200)
        return bytes(body)

    def test_parse_snapshot_and_profile(self):
        result = tdx_bridge.parse_volume_profile(self.build_body())
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["symbol"], "600519")
        self.assertAlmostEqual(result["close"], 10.5, places=2)
        self.assertAlmostEqual(result["preClose"], 10.4, places=2)
        self.assertAlmostEqual(result["open"], 10.55, places=2)
        self.assertAlmostEqual(result["high"], 10.7, places=2)
        self.assertAlmostEqual(result["low"], 10.3, places=2)
        self.assertEqual(result["volume"], 1000)
        self.assertEqual(result["inVolume"], 400)
        self.assertEqual(result["outVolume"], 600)
        self.assertEqual(len(result["bids"]), 3)
        self.assertEqual(result["bids"][0]["volume"], 100)
        self.assertEqual(result["asks"][2]["volume"], 202)
        self.assertAlmostEqual(result["profile"][0]["price"], 10.5, places=2)
        self.assertEqual(result["profile"][0]["volume"], 500)
        self.assertEqual(result["profile"][0]["buy"], 300)
        self.assertEqual(result["profile"][0]["sell"], 200)

    def test_negative_delta_normalized(self):
        # 价位差值为负时按 32 位补码归一化，不能把价位推到天上
        body = bytearray(self.build_body())
        # 重建一份 count=1 的报文，把最后一档的 delta 换成 -20
        head = struct.pack("<H", 1) + bytes([1]) + b"600519" + struct.pack("<H", 5)
        for value in (1050, -10, 5, 20, -20, 0, 0, 1000, 10):
            head += encode_varint(value)
        head += struct.pack("<f", 12345.0)
        for value in (400, 600, 0, 0):
            head += encode_varint(value)
        for index in range(3):
            for value in (index, index + 1, 100 + index, 200 + index):
                head += encode_varint(value)
        head += struct.pack("<H", 0)
        head += encode_varint(1050) + encode_varint(10) + encode_varint(5) + encode_varint(5)
        result = tdx_bridge.parse_volume_profile(bytes(head))
        self.assertAlmostEqual(result["profile"][0]["price"], 10.5, places=2)
        del body

    def test_truncated_rejected(self):
        with self.assertRaises(tdx_bridge.TdxError):
            tdx_bridge.parse_volume_profile(b"\x00\x00\x01")


if __name__ == "__main__":
    unittest.main()
