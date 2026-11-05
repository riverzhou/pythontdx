"""通达信桥接进程的解析测试。

fixture 是 2026-10-29 收盘后从 7709 主站抓的真实响应（hex）。
运行：python3 -m unittest discover -s python -p 'test_*.py'
"""

import gzip
import io
import json
import os
import sqlite3
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

import tdx_bridge as tdx

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> bytes:
    return bytes.fromhex((FIXTURES / f"{name}.hex").read_text(encoding="utf-8").strip())


SECURITIES = {
    "sh600519": {
        "code": "sh600519",
        "market": "SH",
        "symbol": "600519",
        "name": "贵州茅台",
        "decimal": 2,
        "kind": "GP-A",
    }
}


class TestCodec(unittest.TestCase):
    def test_varint_positive_and_negative(self):
        self.assertEqual(tdx.read_varint(b"\x05", 0), (5, 1))
        self.assertEqual(tdx.read_varint(b"\x45", 0), (-5, 1))
        self.assertEqual(tdx.read_varint(b"\x85\x01", 0), (69, 2))
        self.assertEqual(tdx.read_varint(b"\xc5\x01", 0), (-69, 2))

    def test_varint_truncated(self):
        with self.assertRaises(tdx.TdxError):
            tdx.read_varint(b"\x85", 0)

    def test_volume(self):
        self.assertEqual(tdx.decode_volume(0), 0.0)
        self.assertAlmostEqual(tdx.decode_volume(0x40000000), 2.0)
        self.assertAlmostEqual(tdx.decode_volume(0x3F800000), 1.0)

    def test_frame(self):
        frame = tdx.encode_frame(9, 0x053E, b"abc")
        self.assertEqual(len(frame), 15)
        self.assertEqual(frame[0], 0x0C)
        self.assertEqual(frame[5], 0x01)
        self.assertEqual(int.from_bytes(frame[6:8], "little"), 5)
        self.assertEqual(int.from_bytes(frame[10:12], "little"), 0x053E)

    def test_unmatched_push_frame_is_queued(self):
        def response(msg_id, msg_type, payload):
            header = bytearray(16)
            header[:4] = b"\xb1\xcbt\x00"
            header[5:9] = msg_id.to_bytes(4, "little")
            header[10:12] = msg_type.to_bytes(2, "little")
            header[12:14] = len(payload).to_bytes(2, "little")
            header[14:16] = len(payload).to_bytes(2, "little")
            return bytes(header) + payload

        class FakeSocket:
            def __init__(self, data):
                self.data = data
                self.sent = b""

            def sendall(self, data):
                self.sent += data

            def recv(self, size):
                chunk, self.data = self.data[:size], self.data[size:]
                return chunk

        push = response(0xFFFFFFFF, tdx.CMD_REFRESH, b"\x93\x93")
        matched = response(1, tdx.CMD_REFRESH, b"\x93\x93")
        conn = tdx.TdxConnection([])
        conn.sock = FakeSocket(push + matched)
        self.assertEqual(conn._transact(tdx.CMD_REFRESH, b""), b"\x93\x93")
        self.assertEqual(
            list(conn.push_frames),
            [(0xFFFFFFFF, tdx.CMD_REFRESH, b"\x93\x93")],
        )

    def test_market_code(self):
        self.assertEqual(tdx.parse_code("sh600519"), (1, "600519"))
        self.assertEqual(tdx.parse_code("SZ000858"), (0, "000858"))
        with self.assertRaises(tdx.TdxError):
            tdx.parse_code("hk00700")

    def test_normalize_name(self):
        self.assertEqual(tdx.normalize_name("五 粮 液"), "五粮液")
        self.assertEqual(tdx.normalize_name("INTL  GENIUS"), "INTL GENIUS")


class TestQuotes(unittest.TestCase):
    def test_single_quote(self):
        quotes = tdx.parse_quotes(fixture("quote1"), 1_700_000_000_000, SECURITIES)
        self.assertEqual(len(quotes), 1)
        quote = quotes[0]
        self.assertEqual(quote["code"], "sh600519")
        self.assertEqual(quote["name"], "贵州茅台")
        self.assertAlmostEqual(quote["price"], 1354.0, places=2)
        self.assertAlmostEqual(quote["prevClose"], 1330.75, places=2)
        self.assertAlmostEqual(quote["open"], 1349.99, places=2)
        self.assertAlmostEqual(quote["high"], 1356.0, places=2)
        self.assertAlmostEqual(quote["low"], 1330.01, places=2)
        self.assertEqual(quote["volume"], 42992)
        self.assertAlmostEqual(quote["amount"], 5_797_980_160, delta=100_000)
        self.assertEqual(quote["bids"][0], {"price": 1353.77, "volume": 1})
        self.assertEqual(quote["asks"][0], {"price": 1354.0, "volume": 27})
        self.assertEqual(quote["time"], 1_700_000_000_000)

    def test_five_quotes_and_tail(self):
        quotes = tdx.parse_quotes(fixture("quote5"), 1, {})
        self.assertEqual(
            [quote["code"] for quote in quotes],
            ["sh600519", "sz000858", "sh600036", "sz300750", "sh600000"],
        )
        self.assertAlmostEqual(quotes[1]["price"], 72.28, places=2)
        self.assertAlmostEqual(quotes[2]["price"], 42.94, places=2)
        self.assertAlmostEqual(quotes[3]["price"], 229.07, places=2)

    def test_index_has_no_order_book(self):
        quotes = tdx.parse_quotes(fixture("quote-index"), 1, {})
        self.assertEqual(len(quotes), 1)
        self.assertEqual(quotes[0]["code"], "sh000001")
        self.assertAlmostEqual(quotes[0]["price"], 3651.43, places=2)
        # 指数报价成交量从「股」归一成「手」，与 K 线同单位。
        self.assertAlmostEqual(quotes[0]["volume"], 4435641.44, places=2)
        self.assertEqual(quotes[0]["bids"], [])
        self.assertEqual(quotes[0]["asks"], [])


class TestSnapshotAndRefresh(unittest.TestCase):
    ITEMS = [(1, "600519"), (0, "000858")]

    def test_snapshot_request(self):
        data = tdx.quote_data(self.ITEMS)
        self.assertEqual(data[:8], tdx.QUOTE_LIST_PREFIX)
        self.assertEqual(int.from_bytes(data[8:10], "little"), 2)
        self.assertEqual(len(data), 10 + 7 * 2)

    def test_refresh_request_with_cursor(self):
        data = tdx.refresh_data(self.ITEMS, {"sh600519": 7})
        self.assertEqual(len(data), 2 + 11 * 2)
        self.assertEqual(int.from_bytes(data[:2], "little"), 2)
        self.assertEqual(data[2], 1)
        self.assertEqual(data[3:9], b"600519")
        self.assertEqual(int.from_bytes(data[9:13], "little"), 7)
        self.assertEqual(data[13], 0)
        self.assertEqual(data[14:20], b"000858")

    def test_snapshot_parser(self):
        quotes = tdx.parse_snapshots(
            fixture("snapshot2"), self.ITEMS, 1_700_000_000_000, SECURITIES
        )
        self.assertEqual([q["code"] for q in quotes], ["sh600519", "sz000858"])
        maotai = quotes[0]
        self.assertAlmostEqual(maotai["price"], 1372.0, places=2)
        self.assertAlmostEqual(maotai["prevClose"], 1354.0, places=2)
        self.assertAlmostEqual(maotai["open"], 1363.0, places=2)
        self.assertEqual(maotai["volume"], 15182)
        self.assertEqual(len(maotai["bids"]), 1)
        self.assertEqual(maotai["bids"][0], {"price": 1371.18, "volume": 1})
        self.assertEqual(maotai["asks"][0], {"price": 1372.27, "volume": 58})
        self.assertAlmostEqual(quotes[1]["price"], 73.91, places=2)

    def test_refresh_parser_five_levels(self):
        quotes = tdx.parse_refresh(
            fixture("refresh2"), self.ITEMS, 1_700_000_000_000, SECURITIES
        )
        self.assertEqual([q["code"] for q in quotes], ["sh600519", "sz000858"])
        maotai = quotes[0]
        self.assertAlmostEqual(maotai["price"], 1372.0, places=2)
        self.assertEqual(len(maotai["bids"]), 5)
        self.assertEqual(len(maotai["asks"]), 5)
        self.assertEqual(maotai["bids"][0], {"price": 1371.18, "volume": 1})
        self.assertEqual(maotai["bids"][4], {"price": 1370.3, "volume": 1})
        self.assertEqual(maotai["asks"][0], {"price": 1372.27, "volume": 58})
        self.assertIsInstance(maotai["updateTime"], int)
        self.assertGreater(maotai["updateTime"], 0)

    def test_refresh_parser_maps_partial_response_by_code(self):
        decoded = bytes(byte ^ 0x93 for byte in fixture("refresh2"))
        # 只保留第二只 sz000858 的记录，模拟增量刷新只返回有变化的代码。
        second = decoded[130:]
        body = bytes(byte ^ 0x93 for byte in b"\x01\x00" + second)
        quotes = tdx.parse_refresh(body, self.ITEMS, 1, SECURITIES)
        self.assertEqual([quote["code"] for quote in quotes], ["sz000858"])
        self.assertAlmostEqual(quotes[0]["price"], 73.91, places=2)

    def test_bridge_refresh_uses_cursor_and_reuses_cache(self):
        class FakeConn:
            def __init__(self):
                self.calls = []

            def request(self, _msg_type, data):
                self.calls.append(data)
                return fixture("refresh2") if len(self.calls) == 1 else b"\x93\x93"

            def close(self):
                pass

        bridge = tdx.Bridge()
        fake = FakeConn()
        bridge.conn = fake
        bridge.index.by_code = SECURITIES
        bridge._prepare_items = lambda codes: (
            list(codes),
            [(1, "600519"), (0, "000858")],
        )
        bridge._attach_finance = lambda _quotes: None
        try:
            first = bridge._refresh_quotes_7709(["sh600519", "sz000858"])
            self.assertEqual([q["code"] for q in first], ["sh600519", "sz000858"])
            self.assertGreater(bridge.quote_cursors["sh600519"], 0)
            second = bridge._refresh_quotes_7709(["sh600519", "sz000858"])
            self.assertEqual([q["code"] for q in second], ["sh600519", "sz000858"])
            self.assertEqual(
                [q["price"] for q in second], [q["price"] for q in first]
            )
        finally:
            bridge.close()

    def test_bridge_drains_unmatched_push_frames(self):
        from collections import deque

        class FakeConn:
            def __init__(self):
                self.push_frames = deque(
                    [(0xFFFFFFFF, tdx.CMD_REFRESH, fixture("refresh2"))]
                )

            def close(self):
                pass

        bridge = tdx.Bridge()
        bridge.conn = FakeConn()
        bridge.index.by_code = SECURITIES
        bridge.quote_watch = {"sh600519", "sz000858"}
        bridge._attach_finance = lambda _quotes: None
        bridge._drain_quote_pushes()
        self.assertEqual(set(bridge.quote_cache), {"sh600519", "sz000858"})
        self.assertGreater(bridge.quote_cursors["sh600519"], 0)


class TestCategoryQuotes(unittest.TestCase):
    def test_category_request(self):
        data = tdx.category_data(6, 0x000E, 0, 5, ascending=False, filter_raw=0)
        self.assertEqual(len(data), 18)
        values = [int.from_bytes(data[i : i + 2], "little") for i in range(0, 18, 2)]
        self.assertEqual(values, [6, 0x000E, 0, 5, 1, 5, 0, 1, 0])

    def test_category_parser(self):
        quotes = tdx.parse_category_quotes(
            fixture("category5"), 1_700_000_000_000, {}
        )
        self.assertEqual(len(quotes), 5)
        first = quotes[0]
        self.assertEqual(first["code"], "sh688066")
        self.assertAlmostEqual(first["price"], 5.57, places=2)
        self.assertAlmostEqual(first["prevClose"], 4.64, places=2)
        self.assertAlmostEqual(first["changePct"], 20.04, places=2)
        self.assertEqual(first["bids"][0]["price"], 5.57)
        self.assertEqual(first["asks"], [])
        self.assertGreater(first["lockedAmount"], 0)
        last = quotes[4]
        self.assertEqual(last["code"], "sz301079")
        self.assertEqual(last["asks"][0], {"price": 39.81, "volume": 61})


class TestTrades(unittest.TestCase):
    def test_today_request(self):
        data = tdx.trades_data(1, "600519", 0, 20)
        self.assertEqual(len(data), 12)
        self.assertEqual(data[:2], b"\x01\x00")
        self.assertEqual(data[2:8], b"600519")
        self.assertEqual(int.from_bytes(data[8:10], "little"), 0)
        self.assertEqual(int.from_bytes(data[10:12], "little"), 20)

    def test_history_request(self):
        data = tdx.trades_data(1, "600519", 0, 5, "2026-10-28")
        self.assertEqual(len(data), 16)
        self.assertEqual(int.from_bytes(data[:4], "little"), 20261028)
        self.assertEqual(int.from_bytes(data[4:6], "little"), 1)
        self.assertEqual(data[6:12], b"600519")

    def test_today_ticks(self):
        ticks = tdx.parse_trades(
            fixture("trades-today"), 1, "600519", 0, {}
        )
        self.assertEqual(len(ticks), 20)
        first = ticks[0]
        self.assertEqual(first["time"], "10:11")
        self.assertAlmostEqual(first["price"], 1370.68, places=2)
        self.assertEqual(first["volume"], 13)
        self.assertEqual(first["side"], "sell")
        self.assertEqual(first["eventKind"], "trade")

    def test_history_ticks(self):
        ticks = tdx.parse_trades(
            fixture("trades-history"), 1, "600519", 0, {}, "2026-10-28"
        )
        self.assertEqual(len(ticks), 5)
        first = ticks[0]
        self.assertEqual(first["time"], "15:06")
        self.assertAlmostEqual(first["price"], 1330.75, places=2)
        self.assertEqual(first["side"], "status_5")
        self.assertEqual(first["status"], 5)
        self.assertEqual(first["tradeAmount"], 133075.0)


class TestAuctions(unittest.TestCase):
    def test_auction_request(self):
        data = tdx.auction_data(1, "600519", None, 0, 0, 50)
        self.assertEqual(len(data), 28)
        self.assertEqual(data[:2], b"\x01\x00")
        self.assertEqual(data[2:8], b"600519")
        self.assertEqual(int.from_bytes(data[8:12], "little"), 0)
        self.assertEqual(int.from_bytes(data[12:16], "little"), 0)
        history = tdx.auction_data(1, "600519", "2026-10-28", 0, 0, 50)
        self.assertEqual(int.from_bytes(history[8:12], "little"), 20261028)
        self.assertEqual(tdx.auction_data(1, "600519")[12:16], b"\x00\x00\x00\x00")

    def test_auction_parser(self):
        points = tdx.parse_auctions(fixture("auction-today"))
        self.assertEqual(len(points), 50)
        first = points[0]
        self.assertEqual(first["time"], "09:15:02")
        self.assertEqual(first["timeSeconds"], 33302)
        self.assertAlmostEqual(first["price"], 1353.77, places=2)
        self.assertEqual(first["priceMilli"], 1353770)
        self.assertEqual(first["matchedVolume"], 16)
        self.assertEqual(first["unmatchedVolume"], 1)
        self.assertEqual(first["unmatchedDirection"], -1)
        self.assertEqual(points[-1]["time"], "09:20:01")

    def test_empty_auction(self):
        self.assertEqual(tdx.parse_auctions(b"\x00\x00"), [])

    def test_auction_quotes_fallback_uses_last_point_and_cache(self):
        class FakeConnection:
            def __init__(self):
                self.calls = 0

            def request(self, _cmd, _data):
                self.calls += 1
                return fixture("auction-today")

            def close(self):
                pass

        bridge = tdx.Bridge()
        fake = FakeConnection()
        bridge.conn = fake
        bridge.quote_cache["sh600519"] = {
            "prevClose": 1350.0,
            "open": 1351.0,
            "high": 1352.0,
            "low": 1349.0,
            "volume": 100,
            "amount": 135100.0,
        }
        try:
            quotes = bridge.auction_quotes(["sh600519"])
            self.assertEqual(len(quotes), 1)
            quote = quotes[0]
            self.assertTrue(quote["auction"])
            self.assertEqual(quote["code"], "sh600519")
            self.assertAlmostEqual(quote["price"], 1355.0, places=2)
            self.assertEqual(quote["auctionTime"], "09:20:01")
            self.assertEqual(quote["updateTime"], 92001)
            self.assertGreater(quote["price"], 0)
            # 2 秒缓存：同一批再取一次不应再打服务器
            bridge.auction_quotes(["sh600519"])
            self.assertEqual(fake.calls, 1)
        finally:
            bridge.close()


class TestFileRead(unittest.TestCase):
    def test_file_request(self):
        data = tdx.file_content_data("zhb.zip", 0, 64)
        self.assertEqual(len(data), 308)
        self.assertEqual(int.from_bytes(data[:4], "little"), 0)
        self.assertEqual(int.from_bytes(data[4:8], "little"), 64)
        self.assertEqual(data[8:15], b"zhb.zip")
        self.assertEqual(data[8 + tdx.FILE_PATH_FIELD - 1], 0)

    def test_file_path_normalization(self):
        data = tdx.file_content_data(r"tdx\zhb.zip", 0, 64)
        self.assertEqual(data[8:16], b"tdx/zhb.")
        with self.assertRaises(tdx.TdxError):
            tdx.file_content_data("中文.zip", 0, 64)
        with self.assertRaises(tdx.TdxError):
            tdx.file_content_data("zhb.zip", 0, 0)

    def test_file_chunk(self):
        chunk = tdx.parse_file_chunk(
            fixture("file-zhb-head"), "zhb.zip", 0, 64
        )
        self.assertEqual(chunk["chunkLen"], 64)
        self.assertTrue(chunk["contentHex"].startswith("504b0304"))
        self.assertFalse(chunk["isLast"])
        self.assertEqual(chunk["trailingBytes"], 0)

    def test_empty_file_chunk_is_last(self):
        chunk = tdx.parse_file_chunk(b"\x00\x00\x00\x00", "zhb.zip", 0, 64)
        self.assertEqual(chunk["chunkLen"], 0)
        self.assertTrue(chunk["isLast"])


class TestTdxStats(unittest.TestCase):
    def make_zip(self) -> bytes:
        stat = [""] * 35
        stat[0], stat[1] = "0", "000001"
        stat[2], stat[3], stat[4] = "1.23", "5.6", "20261029"
        stat[11], stat[26], stat[33] = "1000", "3", "2"
        stat2 = [""] * 21
        stat2[0], stat2[1], stat2[2] = "0", "000001", "20261029"
        stat2[3], stat2[4], stat2[14] = "1234.5", "10", "20"
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("tdxstat.cfg", "|".join(stat) + "\n")
            archive.writestr("tdxstat2.cfg", "|".join(stat2) + "\n")
        return buffer.getvalue()

    def test_parse_stats(self):
        result = tdx.parse_tdx_stats(self.make_zip())
        self.assertEqual(result["statCount"], 1)
        self.assertEqual(result["stat2Count"], 1)
        self.assertEqual(result["statsDate"], "20261029")
        self.assertEqual(result["statSamples"][0]["code"], "000001")
        self.assertAlmostEqual(result["statSamples"][0]["beta60"], 1.23)
        self.assertEqual(result["stat2Samples"][0]["sealAmount10k"], 10.0)

    def test_save_raw_file(self):
        with tempfile.TemporaryDirectory() as directory:
            old = os.environ.get("PYTHONTDX_DATA_DIR")
            os.environ["PYTHONTDX_DATA_DIR"] = directory
            try:
                saved = tdx.save_raw_file("x.bin", b"abc")
            finally:
                if old is None:
                    os.environ.pop("PYTHONTDX_DATA_DIR", None)
                else:
                    os.environ["PYTHONTDX_DATA_DIR"] = old
            self.assertEqual(saved["bytes"], 3)
            # savedTo 是本地路径，Windows 用 `\`、Linux/macOS 用 `/`，断言不能写死分隔符
            self.assertEqual(Path(saved["savedTo"]).parts[-3:], ("raw", "tdx", "x.bin"))
            self.assertTrue(Path(saved["savedTo"]).exists())

    def test_export_stats_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            old = os.environ.get("PYTHONTDX_DATA_DIR")
            os.environ["PYTHONTDX_DATA_DIR"] = directory
            try:
                result = tdx.export_tdx_stats(self.make_zip())
            finally:
                if old is None:
                    os.environ.pop("PYTHONTDX_DATA_DIR", None)
                else:
                    os.environ["PYTHONTDX_DATA_DIR"] = old
            self.assertEqual(result["statCount"], 1)
            self.assertEqual(result["statSkipped"], 0)
            self.assertEqual(result["partitions"][0]["tradeDate"], "20261029")
            partition = Path(result["partitions"][0]["path"])
            self.assertTrue(Path(result["manifest"]).exists())
            with gzip.open(
                partition / "tdxstat.jsonl.gz", "rt", encoding="utf-8"
            ) as stream:
                lines = stream.read().splitlines()
            self.assertEqual(len(lines), 1)
            row = json.loads(lines[0])
            self.assertEqual(row["code"], "000001")
            self.assertAlmostEqual(row["beta60"], 1.23)
            database = sqlite3.connect(result["database"])
            try:
                count, beta = database.execute(
                    "SELECT COUNT(*), MAX(beta60) FROM tdxstat"
                ).fetchone()
                self.assertEqual(count, 1)
                self.assertAlmostEqual(beta, 1.23)
            finally:
                database.close()


class TestDataBackup(unittest.TestCase):
    """离线数据备份/恢复：单文件 zip、恢复全量覆盖同名文件。"""

    def test_backup_inspect_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            (data / "cache" / "klines").mkdir(parents=True)
            (data / "lake").mkdir()
            (data / "cache" / "klines" / "sh600519_day_all_qfq.parquet").write_bytes(b"parquet")
            (data / "lake" / "sh600519.manifest.json").write_text("{}", encoding="utf-8")

            old = os.environ.get("PYTHONTDX_DATA_DIR")
            os.environ["PYTHONTDX_DATA_DIR"] = str(data)
            try:
                archive = Path(directory) / "backup.zip"
                backup_events: list[dict] = []
                created = tdx.backup_create(str(archive), backup_events.append)
                self.assertEqual(created["fileCount"], 2)
                self.assertGreater(created["archiveBytes"], 0)
                self.assertEqual(len(created["sha256"]), 64)
                self.assertEqual(backup_events[0]["phase"], "scan")
                self.assertEqual(backup_events[-1]["phase"], "done")
                self.assertEqual(backup_events[-1]["operation"], "backup")
                self.assertEqual(backup_events[-1]["doneBytes"], created["totalBytes"])
                self.assertEqual(
                    {event["phase"] for event in backup_events},
                    {"scan", "write", "hash", "done"},
                )

                inspected = tdx.backup_inspect(str(archive))
                self.assertEqual(inspected["fileCount"], 2)
                self.assertEqual(inspected["format"], tdx.BACKUP_FORMAT)

                # 删掉一份、改一份：恢复补回缺失，并把已存在的同名文件覆盖掉
                (data / "lake" / "sh600519.manifest.json").unlink()
                existing = data / "cache" / "klines" / "sh600519_day_all_qfq.parquet"
                existing.write_bytes(b"newer")
                restore_events: list[dict] = []
                result = tdx.backup_restore(str(archive), restore_events.append)
                self.assertEqual(result["restored"], 1)
                self.assertEqual(result["overwritten"], 1)
                self.assertEqual(result["skipped"], 0)
                self.assertEqual(
                    (data / "lake" / "sh600519.manifest.json").read_text(encoding="utf-8"),
                    "{}",
                )
                self.assertEqual(existing.read_bytes(), b"parquet")
                self.assertEqual(restore_events[0]["phase"], "write")
                self.assertEqual(restore_events[-1]["phase"], "done")
                self.assertEqual(restore_events[-1]["operation"], "restore")
                self.assertEqual(restore_events[-1]["doneFiles"], 2)
                self.assertEqual(restore_events[-1]["doneBytes"], result["bytes"])

                # 同名备份不覆盖
                with self.assertRaises(tdx.TdxError):
                    tdx.backup_create(str(archive))
            finally:
                if old is None:
                    os.environ.pop("PYTHONTDX_DATA_DIR", None)
                else:
                    os.environ["PYTHONTDX_DATA_DIR"] = old

    def test_backup_inspect_accepts_legacy_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "legacy.zip"
            manifest = {
                "format": tdx.BACKUP_FORMAT,
                "app": "StockLens",
                "fileCount": 1,
                "totalBytes": 3,
            }
            with zipfile.ZipFile(archive, "w") as writer:
                writer.writestr(tdx.LEGACY_BACKUP_MANIFEST, json.dumps(manifest))
                writer.writestr("data/x.txt", "abc")
            result = tdx.backup_inspect(str(archive))
            self.assertEqual(result["fileCount"], 1)
            self.assertEqual(result["totalBytes"], 3)
            self.assertEqual(result["format"], tdx.BACKUP_FORMAT)

    def test_restore_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            data.mkdir()
            archive = Path(directory) / "evil.zip"
            with zipfile.ZipFile(archive, "w") as writer:
                writer.writestr("../escape.txt", b"x")
            old = os.environ.get("PYTHONTDX_DATA_DIR")
            os.environ["PYTHONTDX_DATA_DIR"] = str(data)
            try:
                with self.assertRaises(tdx.TdxError):
                    tdx.backup_restore(str(archive))
                self.assertFalse((Path(directory) / "escape.txt").exists())
            finally:
                if old is None:
                    os.environ.pop("PYTHONTDX_DATA_DIR", None)
                else:
                    os.environ["PYTHONTDX_DATA_DIR"] = old


class TestBlocks(unittest.TestCase):
    def test_parse_block_dat(self):
        data = fixture("block-gn-head")
        blocks = tdx.parse_block_dat(data, "gn")
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["name"], "通达信88")
        self.assertEqual(blocks[0]["count"], 88)
        self.assertEqual(len(blocks[0]["codes"]), 88)
        self.assertEqual(blocks[0]["codes"][0], "000408")


class TestIndustry(unittest.TestCase):
    def test_parse_incon_sections(self):
        text = "#TDXNHY\nT01|能源\nT0101|煤炭\n######\n#SWHY\n110000|农业\n######\n"
        sections = tdx.parse_incon_sections(text)
        self.assertEqual(sections["TDXNHY"][0], ("T01", "能源"))
        self.assertEqual(sections["TDXNHY"][1], ("T0101", "煤炭"))
        self.assertEqual(sections["SWHY"][0], ("110000", "农业"))

    def test_parse_tdxhy(self):
        rows = tdx.parse_tdxhy(
            "0|000001|T1001|||X500102\n1|600519|T020301|||X3201\n#comment\n"
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["symbol"], "000001")
        self.assertEqual(rows[0]["tdxCode"], "T1001")
        self.assertEqual(rows[0]["rsCode"], "X500102")
        self.assertEqual(rows[1]["tdxCode"], "T020301")

    def test_parse_sector_indices(self):
        rows = tdx.parse_sector_indices(
            "银行|880471|2|1|1|T1001\n黑龙江|880201|3|1|0|1\nbadline\n"
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["code"], "sh880471")
        self.assertEqual(rows[0]["tdxCode"], "T1001")
        self.assertEqual(rows[1]["name"], "黑龙江")

    def test_sector_index_code(self):
        self.assertTrue(tdx.is_index_code(1, "880471"))
        self.assertTrue(tdx.is_index_code(1, "881001"))
        self.assertFalse(tdx.is_index_code(1, "600519"))


class TestClientBlocks(unittest.TestCase):
    """通达信客户端本地自定义板块：blocknew.cfg 定长记录 + *.blk 成分。"""

    def test_parse_blocknew_cfg(self):
        def record(name: str, file: str) -> bytes:
            return name.encode("gbk").ljust(50, b"\x00") + file.encode("ascii").ljust(70, b"\x00")

        data = record("持仓股票", "CCGP") + record("0太空光伏", "0TKGF") + b"\x00" * 120
        rows = tdx.parse_blocknew_cfg(data)
        self.assertEqual(rows, [{"name": "持仓股票", "file": "CCGP"}, {"name": "0太空光伏", "file": "0TKGF"}])

    def test_parse_client_block(self):
        text = "0000636\r\n1605376\r\n1880588\r\n\r\n000285\r\n"
        self.assertEqual(tdx.parse_client_block(text), ["000636", "605376", "880588", "000285"])

    def test_client_roots_priority(self):
        roots = tdx.client_roots("X:/custom_tdx")
        # Path 的分隔符由当前平台决定：Windows 的 str() 是反斜杠，Linux 保留正斜杠。
        # 断言 Path 本身，才能同时验证「显式目录排第一」而不绑定某个平台的分隔符。
        self.assertEqual(roots[0], Path("X:/custom_tdx"))
        self.assertTrue(any(item.name == "tdx" for item in roots))

    def test_client_block_indices(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "T0002" / "hq_cache"
            cache.mkdir(parents=True)
            (cache / "infoharbor_block.dat").write_text(
                "#GN_示例板块,10,880999,20200101,20200102,,\r\n"
                "#FG_风格示例,20,880998,20200101,20200102,,\r\n"
                "#ZS_无指数,0,,20200101,,,\r\n",
                encoding="gbk",
            )
            mapping = tdx.client_block_indices(directory)
            self.assertEqual(mapping[("gn", "示例板块")], "sh880999")
            self.assertEqual(mapping[("fg", "风格示例")], "sh880998")
            self.assertNotIn(("zs", "无指数"), mapping)


class TestScreenIndustry(unittest.TestCase):
    def test_filter_codes(self):
        quotes = [{"code": "sh600519"}, {"code": "sz000001"}]
        self.assertEqual(
            tdx.filter_quotes_by_codes(quotes, {"sh600519"}),
            [{"code": "sh600519"}],
        )


class TestStatsQuery(unittest.TestCase):
    def test_readonly_query(self):
        with tempfile.TemporaryDirectory() as directory:
            old = os.environ.get("PYTHONTDX_DATA_DIR")
            os.environ["PYTHONTDX_DATA_DIR"] = directory
            try:
                folder = Path(directory) / "normalized" / "tdx" / "zhb_stats"
                folder.mkdir(parents=True)
                database = sqlite3.connect(folder / "stats.db")
                database.execute("CREATE TABLE tdxstat (code TEXT, pe_ttm REAL)")
                database.execute("INSERT INTO tdxstat VALUES ('600519', 20.79)")
                database.execute("CREATE TABLE tdxstat2 (code TEXT, amount_10k REAL)")
                database.execute("INSERT INTO tdxstat2 VALUES ('600519', 1234.5)")
                database.commit()
                database.close()

                result = tdx.run_stats_query("SELECT code, pe_ttm FROM tdxstat", 10)
                self.assertEqual(result["columns"], ["code", "pe_ttm"])
                self.assertEqual(result["rows"], [["600519", 20.79]])
                exported = tdx.export_stats_csv()
                self.assertEqual(exported["statCount"], 1)
                self.assertEqual(exported["stat2Count"], 1)
                with open(exported["statCsv"], encoding="utf-8-sig") as stream:
                    lines = stream.read().splitlines()
                self.assertEqual(lines[0], "code,pe_ttm")
                self.assertEqual(lines[1], "600519,20.79")
                with self.assertRaises(tdx.TdxError):
                    tdx.run_stats_query("DELETE FROM tdxstat")
                with self.assertRaises(tdx.TdxError):
                    tdx.run_stats_query("SELECT 1; SELECT 2")
            finally:
                if old is None:
                    os.environ.pop("PYTHONTDX_DATA_DIR", None)
                else:
                    os.environ["PYTHONTDX_DATA_DIR"] = old


class TestScreener(unittest.TestCase):
    QUOTES = [
        {"code": "sh600519", "price": 1367.85, "changePct": 1.2, "amount": 3e9, "turnoverRate": 0.5, "amplitude": 2, "pb": 8.0, "floatCap": 20_000, "totalCap": 21_000},
        {"code": "sz300750", "price": 232.0, "changePct": 5.5, "amount": 8e9, "turnoverRate": 3.2, "amplitude": 6, "pb": 5.0, "floatCap": 8_000, "totalCap": 9_000},
        {"code": "sz000001", "price": 11.5, "changePct": -2.0, "amount": 1e8, "turnoverRate": 1.1, "amplitude": 3, "pb": 0.7, "floatCap": 2_000, "totalCap": 2_100},
        {"code": "sh688001", "price": 50.0, "changePct": 8.0, "amount": 2e8},
    ]

    def test_filter_and_sort(self):
        result = tdx.apply_screen(
            self.QUOTES,
            {"minChangePct": 3, "minAmount": 1e8, "sortBy": "changePct", "limit": 10},
        )
        self.assertEqual([row["code"] for row in result], ["sh688001", "sz300750"])

    def test_fundamental_filters(self):
        result = tdx.apply_screen(
            self.QUOTES,
            {"maxPb": 2, "maxFloatCap": 3_000, "maxTotalCap": 3_000, "sortBy": "amount"},
        )
        self.assertEqual([row["code"] for row in result], ["sz000001"])

    def test_missing_metric_excluded(self):
        result = tdx.apply_screen(
            self.QUOTES, {"minTurnoverRate": 1.0, "sortBy": "amount"}
        )
        self.assertEqual([row["code"] for row in result], ["sz300750", "sz000001"])

    def test_sort_by_pb_ascending_missing_last(self):
        result = tdx.apply_screen(self.QUOTES, {"sortBy": "pb", "ascending": True})
        self.assertEqual(
            [row["code"] for row in result],
            ["sz000001", "sz300750", "sh600519", "sh688001"],
        )

    def test_sort_by_total_cap_descending_missing_last(self):
        result = tdx.apply_screen(self.QUOTES, {"sortBy": "totalCap"})
        self.assertEqual(
            [row["code"] for row in result],
            ["sh600519", "sz300750", "sz000001", "sh688001"],
        )


class TestMoneyFlow(unittest.TestCase):
    def test_money_flow_request(self):
        data = tdx.money_flow_data(1, "600519")
        self.assertEqual(len(data), 38)
        self.assertEqual(data[:2], b"\x01\x00")
        self.assertEqual(data[2:8], b"600519")

    def test_money_flow_parser(self):
        records = tdx.parse_money_flow(fixture("money-flow-5"))
        self.assertEqual(len(records), 5)
        first = records[0]
        self.assertEqual(first["code"], "sh600519")
        self.assertEqual(first["date"], "2026-10-30")
        self.assertAlmostEqual(first["totalAmount"], 2_817_544_192.0, delta=1)
        self.assertAlmostEqual(first["mainNet"], 143_356_648.49, places=2)
        self.assertAlmostEqual(first["mainRatio"], 5.088, places=3)
        self.assertEqual(len(first["buckets"]), 16)
        self.assertEqual(first["buckets"][:4], [17301, 15350, 12329, 6470])


class TestF10(unittest.TestCase):
    def test_f10_requests(self):
        catalog = tdx.f10_catalog_data(1, "600519")
        self.assertEqual(len(catalog), 12)
        self.assertEqual(catalog[:2], b"\x01\x00")
        self.assertEqual(catalog[2:8], b"600519")
        content = tdx.f10_content_data(1, "600519", "600519.txt", 0, 200)
        self.assertEqual(len(content), 102)
        self.assertEqual(content[10:20], b"600519.txt")
        self.assertEqual(int.from_bytes(content[90:94], "little"), 0)
        self.assertEqual(int.from_bytes(content[94:98], "little"), 200)

    def test_f10_catalog(self):
        sections = tdx.parse_f10_catalog(fixture("f10-cat2"))
        self.assertEqual(len(sections), 2)
        self.assertEqual(sections[0]["name"], "最新提示")
        self.assertEqual(sections[0]["filename"], "600519.txt")
        self.assertEqual(sections[0]["start"], 0)
        self.assertEqual(sections[0]["length"], 15488)
        self.assertEqual(sections[1]["name"], "公司概况")

    def test_f10_content(self):
        text = tdx.parse_f10_content(fixture("f10-content200"))
        self.assertTrue(text.startswith("最新提示☆"))
        self.assertIn("贵州茅台", text)

    def test_index_has_no_dividend(self):
        """指数不能拿到分红数据：曾因按 symbol 查把 sh000001 当成平安银行。"""
        bridge = tdx.Bridge()
        self.addCleanup(bridge.close)
        for code in ("sh000001", "sz399001", "sh880471"):
            result = bridge.f10_dividend(code)
            self.assertEqual(result["rows"], [], code)
            self.assertEqual(result["count"], 0, code)


class TestHandshake(unittest.TestCase):
    def test_parse_handshake(self):
        import struct

        body = bytearray(189)
        struct.pack_into("<H", body, 1, 2026)
        body[3], body[4] = 4, 11
        struct.pack_into("<8H", body, 9, 570, 690, 780, 900, 0, 0, 0, 0)
        struct.pack_into("<8H", body, 25, 570, 690, 780, 900, 0, 0, 0, 0)
        body[68:152] = "上海双线主站3".encode("gb18030").ljust(84, b"\x00")
        body[160:189] = "通达信".encode("gb18030").ljust(29, b"\x00")
        info = tdx.parse_handshake(bytes(body))
        self.assertTrue(info["available"])
        self.assertEqual(info["serverDate"], "2026-11-04")
        self.assertEqual(info["sessions1"][:4], ["09:30", "11:30", "13:00", "15:00"])
        self.assertIn("上海", info["serverName"])
        self.assertEqual(info["productTag"], "通达信")


class TestBars(unittest.TestCase):
    def test_day_bars(self):
        bars = tdx.parse_bars(fixture("bars-day5"), "stock")
        self.assertEqual(len(bars), 5)
        self.assertEqual(bars[0]["date"], "2026-10-23")
        self.assertAlmostEqual(bars[0]["close"], 1335.0, places=2)
        self.assertIsInstance(bars[0]["closeMilli"], int)
        self.assertEqual(bars[0]["closeMilli"], round(bars[0]["close"] * 1000))
        self.assertGreaterEqual(bars[0]["volumeRaw"], 0)
        self.assertGreaterEqual(bars[0]["amountRaw"], 0)
        self.assertAlmostEqual(bars[4]["open"], 1349.99, places=2)
        self.assertAlmostEqual(bars[4]["close"], 1354.0, places=2)
        self.assertAlmostEqual(bars[4]["volume"], 42992.0, delta=0.5)
        self.assertGreater(bars[4]["amount"], 0)
        self.assertAlmostEqual(
            bars[4]["amount"] / (bars[4]["close"] * bars[4]["volume"] * 100), 1.0, delta=0.05
        )

    def test_week_bars(self):
        bars = tdx.parse_bars(fixture("bars-week3"), "stock")
        self.assertEqual([bar["date"] for bar in bars], ["2026-10-16", "2026-10-23", "2026-10-29"])
        self.assertAlmostEqual(bars[2]["close"], 1354.0, places=2)

    def test_index_bars_skip_extra_bytes(self):
        bars = tdx.parse_bars(fixture("bars-index3"), "index")
        self.assertEqual(len(bars), 3)
        self.assertEqual(
            [bar["date"] for bar in bars],
            ["2026-10-27", "2026-10-28", "2026-10-29"],
        )
        self.assertAlmostEqual(bars[2]["close"], 3651.43, places=2)
        self.assertIn("upCount", bars[0])
        self.assertIn("downCount", bars[0])
        self.assertGreaterEqual(bars[0]["upCount"], 0)
        self.assertGreaterEqual(bars[0]["downCount"], 0)
        self.assertGreater(bars[0]["amount"], 0)


class TestMinutes(unittest.TestCase):
    def test_today_minute(self):
        trend = tdx.parse_today_minute(
            fixture("minute"),
            code="sh600519",
            name="贵州茅台",
            date="2026-10-29",
            prev_close=1330.75,
            decimal=2,
        )
        self.assertEqual(len(trend["points"]), 240)
        self.assertEqual(trend["points"][0]["time"], "09:31")
        self.assertAlmostEqual(trend["points"][0]["price"], 1334.65, places=2)
        self.assertAlmostEqual(trend["points"][0]["avg"], 1343.672, places=3)
        self.assertEqual(trend["points"][0]["volume"], 2416)
        self.assertEqual(trend["points"][-1]["time"], "15:00")
        self.assertAlmostEqual(trend["points"][-1]["price"], 1354.0, places=2)

    def test_history_minute(self):
        trend = tdx.parse_history_minute(
            fixture("minute-history"),
            code="sh600519",
            name="贵州茅台",
            date="2026-10-29",
            prev_close=0,
            decimal=2,
        )
        self.assertEqual(len(trend["points"]), 240)
        self.assertAlmostEqual(trend["prevClose"], 1330.75, places=2)
        self.assertAlmostEqual(trend["points"][0]["price"], 1334.65, places=2)
        self.assertAlmostEqual(trend["points"][-1]["price"], 1354.0, places=2)

    def test_minute_label(self):
        self.assertEqual(tdx.minute_label(0), "09:31")
        self.assertEqual(tdx.minute_label(119), "11:30")
        self.assertEqual(tdx.minute_label(120), "13:01")
        self.assertEqual(tdx.minute_label(239), "15:00")


class TestSecurityAndFinance(unittest.TestCase):
    def test_security_list(self):
        items = tdx.parse_security_list(fixture("list3"), 1)
        self.assertEqual(len(items), 3)
        self.assertEqual(items[0]["code"], "sh589610")
        self.assertEqual(items[0]["name"], "芯片指数")
        self.assertEqual(items[0]["market"], "SH")
        self.assertEqual(items[0]["decimal"], 3)
        self.assertEqual(items[0]["kind"], "JJ")
        self.assertIsInstance(items[0]["multiple"], int)
        self.assertIsInstance(items[0]["prevClose"], float)
        self.assertEqual(len(items[0]["tailHex"]), 8)

    def test_finance(self):
        items = tdx.parse_finance(fixture("finance2"))
        self.assertEqual(len(items), 2)
        maotai = next(item for item in items if item["code"] == "sh600519")
        self.assertAlmostEqual(maotai["floatShares"], 125008, delta=1)
        self.assertAlmostEqual(maotai["totalShares"], 125008, delta=1)
        self.assertAlmostEqual(maotai["eps"], 35.57, places=2)
        self.assertAlmostEqual(maotai["netAssetsPerShare"], 200.99, places=2)
        self.assertAlmostEqual(maotai["totalAssets"], 309050784, delta=1000)
        self.assertAlmostEqual(maotai["netProfit"], 44516880, delta=1000)
        self.assertEqual(maotai["updatedDate"], 20260815)
        self.assertEqual(maotai["ipoDate"], 20010827)
        self.assertAlmostEqual(maotai["totalAssetsYuan"], 309050784000, delta=1_000_000)
        # 0x0010 info 的 6 个股本字段必须全部解析（此前只取了首尾两个）
        for field in (
            "stateShares",
            "sponsorShares",
            "legalPersonShares",
            "bShares",
            "hShares",
        ):
            self.assertIn(field, maotai)
            self.assertIsInstance(maotai[field], float)
        self.assertAlmostEqual(
            maotai["floatSharesShares"], maotai["floatShares"] * 10000, delta=1
        )
        self.assertEqual(len(maotai["recordHex"]), 143 * 2)



class TestLimitPercent(unittest.TestCase):
    def test_board_limits(self):
        from tdx_bridge import limit_percent

        self.assertEqual(limit_percent("sh600000", "浦发银行"), 10)
        self.assertEqual(limit_percent("sz300001", "特锐德"), 20)
        self.assertEqual(limit_percent("sh688001", "华兴源创"), 20)
        self.assertEqual(limit_percent("bj920001", "北交所"), 30)
        self.assertEqual(limit_percent("sh600001", "ST测试"), 5)


class TestStatementPayload(unittest.TestCase):
    """7615 三大报表：离线归档要保留全部原始列与报告期，不能只取展示用子集。"""

    def _payload(self):
        return {
            "ErrorCode": 0,
            "ResultSets": [
                {
                    "ColName": ["rq", "T007", "T039", "T999"],
                    "Content": [
                        ["2026-09-30", 49926813769.81, 318304891882.72, None],
                        ["2026-06-30", 1.5, 2.5, 3.5],
                    ],
                },
                {"ColName": ["nhytype"], "Content": [[0]]},
            ],
        }

    def test_full_mode_keeps_every_column(self):
        from tdx_f10 import parse_statement_payload

        result = parse_statement_payload(self._payload(), "zcfzb", True)
        self.assertEqual(result["columns"], ["rq", "T007", "T039", "T999"])
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual(result["template"], 0)
        self.assertTrue(result["full"])

    def test_summary_mode_uses_known_labels(self):
        from tdx_f10 import parse_statement_payload

        result = parse_statement_payload(self._payload(), "zcfzb", False)
        self.assertEqual(result["columns"], ["报告期", "资产总计", "货币资金"])
        self.assertEqual(result["rows"][0][0], "2026-09-30")


class TestTqlexProxyBypass(unittest.TestCase):
    """7615 和 7709 一样是直达行情通道，不能被系统/环境代理接管。

    起源（2026-11-02 macOS 实机验收）：这台机器的系统代理是局域网 HTTP 代理，
    urllib 会读它，而 7709 是裸 TCP 不受影响；
    结果 F10 公告/估值/财务/新闻全部在 12 秒后超时，数据自检也只跑到
    「公告」就中断。curl 直连同一地址 0.2 秒返回，说明代理不转发 7615。
    """

    def test_ignores_http_proxy(self):
        import http.server
        import threading
        from unittest import mock

        import tdx_f10

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler 的命名约定
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                body = b'{"ErrorCode":0,"ResultSets":[]}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/TQLEX"
            # 指向必然拒绝连接的代理：只要请求还经过代理，就会直接失败
            with mock.patch.dict(
                os.environ,
                {
                    "http_proxy": "http://127.0.0.1:1",
                    "HTTP_PROXY": "http://127.0.0.1:1",
                    "no_proxy": "",
                    "NO_PROXY": "",
                },
            ):
                with mock.patch.object(tdx_f10, "TQLEX_URL", url):
                    payload = tdx_f10._post_tqlex("Test", {"Params": []})
            self.assertEqual(payload.get("ErrorCode"), 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


class TestTqlexFailover(unittest.TestCase):
    """7615 网关健康记忆：失败站点冷却，下次请求优先上次成功的网关。"""

    class FakeResponse:
        def __init__(self, body: bytes):
            self.body = body

        def read(self) -> bytes:
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class FakeOpener:
        def __init__(self, fail_hosts: set[str]):
            self.fail_hosts = fail_hosts
            self.calls: list[str] = []

        def open(self, request, timeout):
            self.calls.append(request.full_url)
            if any(host in request.full_url for host in self.fail_hosts):
                raise TimeoutError("timeout")
            return TestTqlexFailover.FakeResponse(b'{"ErrorCode":0}')

    def setUp(self):
        import tdx_f10

        self.f10 = tdx_f10
        self.saved_cooldown = dict(tdx_f10._tqlex_cooldown)
        self.saved_latency = dict(tdx_f10._tqlex_latency)
        self.saved_good = tdx_f10._tqlex_last_good
        tdx_f10._tqlex_cooldown.clear()
        tdx_f10._tqlex_latency.clear()
        tdx_f10._tqlex_last_good = None

    def tearDown(self):
        self.f10._tqlex_cooldown.clear()
        self.f10._tqlex_cooldown.update(self.saved_cooldown)
        self.f10._tqlex_latency.clear()
        self.f10._tqlex_latency.update(self.saved_latency)
        self.f10._tqlex_last_good = self.saved_good

    def test_fastest_host_is_tried_first(self):
        hosts = self.f10._tqlex_bases()
        slow, fast = hosts[0], hosts[1]
        self.f10._mark_tqlex(slow, True, 5.0)
        self.f10._mark_tqlex(fast, True, 0.05)
        self.assertEqual(self.f10._tqlex_bases()[0], fast)

    def test_failed_host_moves_to_back(self):
        hosts = self.f10._tqlex_bases()
        self.f10._mark_tqlex(hosts[0], False)
        self.assertEqual(self.f10._tqlex_bases()[-1], hosts[0])

    def test_cooled_host_is_skipped_on_next_request(self):
        from unittest import mock

        hosts = self.f10._tqlex_bases()
        bad = hosts[0]
        opener = self.FakeOpener({bad})
        with mock.patch.object(self.f10, "_OPENER", opener):
            self.assertEqual(self.f10._tqlex_post("Test", b"{}"), {"ErrorCode": 0})
            self.assertEqual(opener.calls[0], f"{bad}?Entry=Test")
            opener.calls.clear()
            self.assertEqual(self.f10._tqlex_post("Test", b"{}"), {"ErrorCode": 0})
        self.assertEqual(len(opener.calls), 1)
        self.assertNotIn(bad, opener.calls[0])


class TestDatasetWriter(unittest.TestCase):
    """Windows 上杀软/索引会短暂占用目标文件，原子改名必须重试。"""

    def test_replace_retries_on_permission_error(self):
        from unittest import mock

        attempts = []

        def flaky_replace(source, target):
            attempts.append(source)
            if len(attempts) < 3:
                raise PermissionError("file is locked")
            Path(target).write_text("ok", encoding="utf-8")

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "x.jsonl.gz.part"
            target = Path(directory) / "x.jsonl.gz"
            source.write_text("pending", encoding="utf-8")
            with mock.patch.object(tdx.os, "replace", side_effect=flaky_replace):
                tdx._replace_atomic(source, target)
            self.assertEqual(len(attempts), 3)
            self.assertEqual(target.read_text(encoding="utf-8"), "ok")


if __name__ == "__main__":
    unittest.main()


class TestMarketBreadthPage(unittest.TestCase):
    """涨跌家数分页：整包扫描要拆成多次请求，图表 priority 才能在页间插队。"""

    @staticmethod
    def quote(code: str, change_pct: float) -> dict:
        return {
            "code": code,
            "name": "测试",
            "changePct": change_pct,
            "prevClose": 10.0,
            "price": 11.0,
            "high": 11.0,
            "low": 9.0,
        }

    def test_page_skips_finance_attachment(self) -> None:
        bridge = tdx.Bridge()
        calls: list[dict] = []
        bridge.category_quotes = lambda **kwargs: calls.append(kwargs) or []
        bridge.market_breadth_page(start=0, pages=1)
        self.assertEqual(len(calls), 1)
        self.assertFalse(calls[0]["with_finance"])

    def test_page_reports_next_start_and_counts(self) -> None:
        bridge = tdx.Bridge()
        pages = {
            0: [self.quote("600000", 1.0)] * 80,
            80: [self.quote("000001", -1.0)] * 2,
        }
        bridge.category_quotes = lambda **kwargs: pages.get(kwargs["start"], [])

        first = bridge.market_breadth_page(start=0, pages=1)
        self.assertEqual(first["nextStart"], 80)
        self.assertEqual(first["total"], 80)
        self.assertEqual(first["up"], 80)

        final = bridge.market_breadth_page(start=0, pages=8)
        self.assertIsNone(final["nextStart"])
        self.assertEqual(final["total"], 82)
        self.assertEqual(final["up"], 80)
        self.assertEqual(final["down"], 2)
