"""MAC 扩展协议解析与请求打包的离线测试。"""

from __future__ import annotations

import struct
import unittest

import tdx_mac_ext as mac


class TestRequests(unittest.TestCase):
    def test_bars_request_shape(self):
        body = mac._bars_request(1, "600519", 4, 10, 100, 0)
        self.assertEqual(len(body), 46)
        market, code, period, times, start, count = struct.unpack_from("<H22sHHIH", body, 0)
        self.assertEqual((market, period, times, start, count), (1, 4, 1, 10, 101))
        self.assertEqual(code.rstrip(b"\x00"), b"600519")

    def test_quote_detail_request_shape(self):
        body = mac._quote_detail_request(1, "600519", 20261104)
        self.assertEqual(len(body), 38)

    def test_tick_charts_request_shape(self):
        body = mac._tick_charts_request(0, "000001", 20261104, 5)
        self.assertEqual(len(body), 38)


class FakeSession:
    def __init__(self, body: bytes):
        self.body = body
        self.requests: list[tuple[int, bytes]] = []

    def request(self, command: int, payload: bytes) -> bytes:
        self.requests.append((command, payload))
        return self.body


class TestMoreCommands(unittest.TestCase):
    def test_file_name_and_meta(self):
        field = mac._file_name_field("tdxfin/gpcw.txt")
        self.assertEqual(len(field), 100)
        body = struct.pack("<IIb", 0, 8541, 1) + b"be5c" + bytes(28)
        session = FakeSession(body)
        info = mac.fetch_file_meta(session, "tdxfin/gpcw.txt")
        self.assertEqual(info["size"], 8541)
        self.assertEqual(info["hash"], "be5c")
        self.assertEqual(session.requests[0][0], 0x1215)
        self.assertEqual(len(session.requests[0][1]), 104)

    def test_file_chunk_request(self):
        session = FakeSession(struct.pack("<II", 1, 4) + b"data")
        chunk = mac.fetch_file_chunk(session, "a.txt", 1, 0, 4)
        self.assertEqual(chunk["size"], 4)
        self.assertEqual(chunk["data"], b"data")
        self.assertEqual(session.requests[0][0], 0x1217)
        self.assertEqual(len(session.requests[0][1]), 112)

    def test_kline_offset(self):
        session = FakeSession(struct.pack(">I", 1234) + struct.pack("<I", 56))
        info = mac.fetch_kline_offset(session)
        self.assertEqual(info, {"total": 1234, "returned": 56})

    def test_board_members(self):
        bitmap = bytearray(20)
        for bit in (0, 4):
            bitmap[bit // 8] |= 1 << (bit % 8)
        header = bytes(bitmap) + struct.pack("<IH", 1, 1)
        row = bytearray(68)
        struct.pack_into("<H", row, 0, 1)
        row[2:14] = b"600519".ljust(12, b"\x00")
        row[24:68] = "贵州茅台".encode("gbk").ljust(44, b"\x00")
        values = struct.pack("<ff", 1000.0, 1010.0)
        session = FakeSession(header + bytes(row) + values)
        result = mac.fetch_board_members(session, "881001", page_size=10)
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["quotes"][0]["code"], "sh600519")
        self.assertAlmostEqual(result["quotes"][0]["price"], 1010.0, places=2)


class TestParsers(unittest.TestCase):
    def test_symbol_bars_drops_first_record(self):
        header = bytearray(33)
        struct.pack_into("<H", header, 0, 1)
        header[2:14] = b"600519".ljust(12, b"\x00")
        header[24] = 4
        struct.pack_into("<H", header, 27, 2)
        struct.pack_into("<I", header, 29, 0)

        def record(ymd: int, close: float) -> bytes:
            return struct.pack(
                "<II7f", ymd, 0, close, close + 1, close - 1, close, 1000.0, 100.0, 125008.0
            )

        body = bytes(header) + record(20261103, 10.0) + record(20261104, 11.0)
        result = mac.parse_symbol_bars(body)
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["bars"][0]["date"], "2026-11-04")
        self.assertAlmostEqual(result["bars"][0]["preClose"], 10.0, places=4)

    def test_symbol_bars_keep_first(self):
        header = bytearray(33)
        struct.pack_into("<H", header, 0, 1)
        header[2:14] = b"600519".ljust(12, b"\x00")
        header[24] = 4
        struct.pack_into("<H", header, 27, 1)
        record = struct.pack(
            "<II7f", 20261103, 0, 10.0, 11.0, 9.0, 10.5, 1000.0, 100.0, 125008.0
        )
        result = mac.parse_symbol_bars(bytes(header) + record, keep_first=True)
        self.assertEqual(result["count"], 1)
        self.assertTrue(result["bars"][0]["preCloseMissing"])

    def test_auctions(self):
        header = bytearray(36)
        struct.pack_into("<H", header, 0, 1)
        header[2:24] = b"600519".ljust(22, b"\x00")
        struct.pack_into("<I", header, 24, 2)
        row1 = struct.pack("<IfIi", 9 * 3600 + 15 * 60, 10.5, 100, -20)
        row2 = struct.pack("<IfIi", 9 * 3600 + 16 * 60, 10.6, 120, 30)
        result = mac.parse_auctions(bytes(header) + row1 + row2)
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["rows"][0]["time"], "09:15:00")
        self.assertEqual(result["rows"][0]["direction"], -1)
        self.assertEqual(result["rows"][0]["unmatched"], 20)
        self.assertEqual(result["rows"][1]["direction"], 1)

    def test_quote_detail(self):
        header = bytearray(35)
        struct.pack_into("<H", header, 0, 1)
        header[2:24] = b"600519".ljust(22, b"\x00")
        struct.pack_into("<I", header, 24, 20261104)
        struct.pack_into("<f", header, 29, 10.5)
        struct.pack_into("<H", header, 33, 1)
        point = struct.pack("<H4f", 9 * 60 + 30, 10.5, 10.4, 100, 0.0)
        summary = bytearray(120)
        summary[0:44] = "贵州茅台".encode("gbk").ljust(44, b"\x00")
        summary[44] = 2
        struct.pack_into("<f", summary, 64, 10.0)
        struct.pack_into("<f", summary, 80, 10.5)
        struct.pack_into("<I", summary, 88, 1000)
        result = mac.parse_quote_detail(bytes(header) + point + bytes(summary))
        self.assertEqual(result["name"], "贵州茅台")
        self.assertAlmostEqual(result["close"], 10.5, places=3)
        self.assertEqual(result["volume"], 1000)
        self.assertEqual(len(result["chart"]), 1)

    def test_server_info(self):
        body = bytearray(87)
        struct.pack_into("<H", body, 0, 1)
        body[10:13] = b"T1\x00"
        struct.pack_into("<I", body, 22, 20261104)
        struct.pack_into("<HHHH", body, 30, 570, 690, 780, 900)
        result = mac.parse_server_info(bytes(body))
        self.assertEqual(result["today"], "2026-11-04")
        self.assertEqual(result["sessions1"][0]["open"], "9:30")
        self.assertEqual(result["sessions1"][1]["close"], "15:00")

    def test_truncated_rejected(self):
        with self.assertRaises(mac.MacError):
            mac.parse_symbol_bars(b"\x00\x01")
        with self.assertRaises(mac.MacError):
            mac.parse_auctions(b"\x00")
        with self.assertRaises(mac.MacError):
            mac.parse_quote_detail(b"\x00")


if __name__ == "__main__":
    unittest.main()
