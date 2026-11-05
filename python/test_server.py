"""HTTP API 的路由与错误处理测试；用 FakeBridge，不连真实行情。"""

import base64
import hashlib
import http.client
import json
import os
import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from tdx_server import _quote_interval, create_server


class FakeBridge:
    def close(self) -> None:
        pass

    def quotes(self, codes):
        return [{"code": code} for code in codes]

    def live_quotes(self, codes):
        return [{"code": code} for code in codes]

    def code_list(self):
        return [{"code": "sh600519"}]

    def category_quotes(self, **kwargs):
        return [{"code": "sh600519", "sortType": kwargs["sort_type"]}]

    def trades(self, code, **kwargs):
        return [{"code": code, "start": kwargs["start"]}]

    def auctions(self, code, **kwargs):
        return [{"code": code}]

    def auction_archive_save(self, code, date=None):
        return {"code": code, "tradeDate": date or "2026-10-30", "rows": 1, "found": True}

    def auction_archive_read(self, code, date):
        return {"code": code, "tradeDate": date, "rows": 0, "found": False}

    def auction_archive_list(self, limit=50):
        return []

    def auction_archive_batch(self, codes, date=None):
        return {
            "tradeDate": date or "2026-10-30",
            "saved": [{"code": code} for code in codes],
            "failed": [],
            "savedCount": len(codes),
            "failedCount": 0,
        }

    def money_flow(self, code):
        return [{"code": code, "date": "2026-10-30"}]

    def f10_catalog(self, code):
        return [{"name": "公司概况", "filename": "x.txt", "start": 0, "length": 1}]

    def f10_content(self, code, filename, start, length):
        return f"{code}:{filename}:{start}:{length}"

    def f10_announcements(self, code):
        return [{"id": "1", "date": "2026-10-24", "title": "测试公告", "url": "http://example.test"}]

    def f10_profile(self, code):
        return {"columns": ["股票类别"], "rows": [["A股"]]}

    def f10_valuation(self, code):
        return {"columns": ["日期"], "rows": [["20261029"]]}

    def f10_finance(self, code):
        return {"columns": ["报告期"], "rows": [["2026-09-30"]]}

    def f10_business(self, code):
        return {"columns": ["分类"], "rows": [["按地区"]]}

    def f10_shareholders(self, code):
        return {"columns": ["股东名称"], "rows": [["平安人寿"]]}

    def f10_reports(self, code):
        return {"columns": ["标题"], "rows": [["点评标题"]]}

    def f10_news(self, code):
        return [{"id": "1", "title": "新闻"}]

    def f10_industry(self, code, section="summary"):
        return {"section": section, "columns": ["家数", "行业"], "rows": [[48, "证券"]], "count": 1}

    def mac_boards(self, board_type=255):
        return []

    def mac_unusual(self, count=600):
        return []

    def mac_money_flow(self, code):
        return {"mainNet": 1.0}

    def mac_money_flow_batch(self, codes, workers=12):
        return [{"code": code, "mainNet": 1.0, "workers": workers} for code in codes]

    def mac_quotes(self, codes):
        return []

    def mac_quotes_finance(self, codes):
        return []

    def lake_archives(self, limit=20):
        return []

    def archive_snapshot(self):
        return {"dir": "/tmp", "rows": 0, "sha256": "", "generatedAt": "", "tradeDate": ""}

    def export_klines(self, codes, period="day", count=240, adjust="qfq"):
        return {"dir": "/tmp", "files": [], "rows": 0, "codes": len(codes), "generatedAt": "", "failed": []}

    def cache_klines(self, codes, period="day", count=800, adjust="qfq", skip_existing=False):
        return {
            "codes": len(codes),
            "period": period,
            "count": count,
            "adjust": adjust,
            "skipExisting": skip_existing,
        }

    def local_min_write(self, path, bars):
        return {"path": path, "count": len(bars)}

    def local_day_write(self, path, bars):
        return {"path": path, "count": len(bars)}

    def run_local_query(self, sql, limit=200):
        return {"columns": ["code"], "rows": [["sh600519"]], "rowCount": 1, "limited": False}

    def local_import(self, path):
        return {"code": "sh600519", "rows": 1, "totalRows": 1, "sha256": "x"}

    def local_day_read(self, path, limit=0):
        return {"path": path, "count": 1, "firstDate": "2026-01-01", "lastDate": "2026-01-01", "bars": []}

    def market_breadth(self):
        return {"up": 1, "down": 2, "flat": 3, "total": 6, "updatedAt": 0}

    def market_breadth_page(self, start=0, pages=8):
        return {
            "up": 1,
            "down": 2,
            "flat": 3,
            "limitUp": 1,
            "limitDown": 0,
            "nextStart": None,
            "updatedAt": 0,
        }

    def f10_change_plans(self, code):
        return {"columns": [], "rows": [], "count": 0}

    def f10_controller(self, code):
        return {"columns": [], "rows": [], "count": 0}

    def f10_institutions(self, code):
        return {"columns": [], "rows": [], "count": 0}

    def f10_shareholder_changes(self, code):
        return {"columns": [], "rows": [], "count": 0}

    def f10_circulating_shareholders(self, code):
        return {"columns": [], "rows": [], "count": 0}

    def f10_capital(self, code, section="structure"):
        return {"section": section, "columns": [], "rows": [], "count": 0}

    def f10_shareholder_count(self, code):
        return {"columns": [], "rows": [], "count": 0}

    def f10_dividend(self, code):
        return {"columns": [], "rows": [], "count": 0}

    def f10_market(self, section="basic"):
        return {"section": section, "count": 0, "columns": [], "rows": []}

    def f10_lhb_market(self):
        return {"section": "dragon_market", "count": 0, "columns": [], "rows": []}

    def f10_trading(self, code, section="margin"):
        return {"section": section, "columns": ["交易日"], "rows": [["20261029"]], "count": 1}

    def f10_statement(self, code, kind, full=False):
        return {"columns": ["报告期"], "rows": [["2026-09-30"]], "full": full}

    def tdx_stats(self):
        return {"statCount": 8100, "statSamples": []}

    def tdx_stats_export(self):
        return {"statCount": 8100, "database": "/tmp/stats.db"}

    def stats_query(self, sql, limit):
        return {"columns": ["code"], "rows": [["600519"]], "rowCount": 1}

    def stats_csv(self):
        return {"statCsv": "/tmp/tdxstat.csv", "stat2Csv": "/tmp/tdxstat2.csv"}

    def stats_parquet(self):
        return {"rowCount": 2, "target": "/tmp/parquet"}

    def stats_duck_query(self, sql, limit):
        return {"columns": ["code"], "rows": [["600519"]], "rowCount": 1}

    def formula_backtest(self, expression, scope, offset=0, batch_size=100):
        return {
            "scanned": 1,
            "total": 1,
            "nextOffset": 1,
            "done": True,
            "trades": 1,
            "stocks": 1,
            "daily": [{"date": "2026-01-01", "sum": 0, "count": 1}],
        }

    def formula_screen(self, expression, scope, limit, offset=0, batch_size=100):
        return {
            "scanned": 3,
            "total": 3,
            "nextOffset": 3,
            "done": True,
            "matched": 1,
            "quotes": [{"code": "sh600519"}],
        }

    def select_server(self, host):
        return {"preferred": host or "auto"}

    def blocks(self, kind):
        return {"kind": kind, "blockCount": 1, "blocks": [{"name": "测试板块"}]}

    def industries(self):
        return {"kind": "industry", "blockCount": 1, "blocks": [{"name": "银行"}]}

    def screen(self, filters):
        return {
            "scanned": 10,
            "matched": filters.get("minChangePct", 0),
            "quotes": [{"code": "sh600519"}],
        }


class TestHttpApi(unittest.TestCase):
    def setUp(self):
        self.server = create_server("127.0.0.1", 0, FakeBridge())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers = {}
        raw = None
        if body is not None:
            raw = json.dumps(body)
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=raw, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read())
        headers = dict(response.getheaders())
        connection.close()
        return response.status, payload, headers

    def test_select_server_get_and_post(self):
        status, payload, _ = self.request("GET", "/api/select_server?host=1.2.3.4")
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["preferred"], "1.2.3.4")
        status, payload, _ = self.request(
            "POST", "/api/select_server", {"host": "5.6.7.8"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["preferred"], "5.6.7.8")

    def test_cross_origin_write_rejected(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(
            "POST",
            "/api/local_write",
            body=json.dumps({"path": "x.day", "bars": []}),
            headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
        )
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        self.assertEqual(response.status, 403)
        self.assertFalse(payload["ok"])

    def test_ping_and_cors(self):
        status, payload, headers = self.request("GET", "/api/ping")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True, "result": "pong"})
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")

    def test_quotes_post(self):
        status, payload, _ = self.request(
            "POST", "/api/quotes", {"codes": ["sh600519", "sz000858"]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            [item["code"] for item in payload["result"]], ["sh600519", "sz000858"]
        )

    def test_cache_klines_passes_skip_existing(self):
        status, payload, _ = self.request(
            "POST",
            "/api/cache_klines",
            {
                "codes": ["sh600519"],
                "period": "5s",
                "count": 800,
                "adjust": "none",
                "skipExisting": True,
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["result"]["skipExisting"])
        status, payload, _ = self.request(
            "POST", "/api/cache_klines", {"codes": ["sh600519"]}
        )
        self.assertEqual(status, 200)
        self.assertFalse(payload["result"]["skipExisting"])

    def test_f10_industry(self):
        status, payload, _ = self.request(
            "POST", "/api/f10_industry", {"code": "sh600519", "section": "news"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["section"], "news")
        self.assertEqual(payload["result"]["count"], 1)

    def test_market_breadth_pages_aggregate(self):
        class PagedBridge(FakeBridge):
            def __init__(self):
                self.calls = []

            def market_breadth_page(self, start=0, pages=8):
                self.calls.append((start, pages))
                if start == 0:
                    return {
                        "up": 1,
                        "down": 2,
                        "flat": 3,
                        "limitUp": 1,
                        "limitDown": 0,
                        "nextStart": 640,
                        "updatedAt": 1,
                    }
                return {
                    "up": 4,
                    "down": 5,
                    "flat": 6,
                    "limitUp": 0,
                    "limitDown": 1,
                    "nextStart": None,
                    "updatedAt": 2,
                }

        bridge = PagedBridge()
        self.server.bridge = bridge
        status, payload, _ = self.request("POST", "/api/market_breadth", {})
        self.assertEqual(status, 200)
        self.assertEqual(
            payload["result"],
            {
                "up": 5,
                "down": 7,
                "flat": 9,
                "limitUp": 1,
                "limitDown": 1,
                "total": 21,
                "updatedAt": 2,
            },
        )
        self.assertEqual([call[0] for call in bridge.calls], [0, 640])

    def test_f10_statement_full_flag(self):
        status, payload, _ = self.request(
            "POST",
            "/api/f10_statement",
            {"code": "sh600519", "kind": "zcfzb", "full": True},
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["result"]["full"])
        status, payload, _ = self.request(
            "POST", "/api/f10_statement", {"code": "sh600519", "kind": "zcfzb"}
        )
        self.assertEqual(status, 200)
        self.assertFalse(payload["result"]["full"])

    def test_category_and_trades(self):
        status, payload, _ = self.request(
            "POST", "/api/category", {"category": 6, "sortType": 14}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"][0]["sortType"], 14)
        status, payload, _ = self.request(
            "POST", "/api/trades", {"code": "sh600519", "start": 60}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"][0]["start"], 60)
        status, payload, _ = self.request("POST", "/api/stats_summary", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["statCount"], 8100)
        status, payload, _ = self.request("POST", "/api/stats_export", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["database"], "/tmp/stats.db")
        status, payload, _ = self.request(
            "POST", "/api/stats_query", {"sql": "SELECT code FROM tdxstat", "limit": 10}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["600519"]])
        status, payload, _ = self.request("POST", "/api/formula_screen", {"expression": "CLOSE", "scope": 3})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["matched"], 1)
        status, payload, _ = self.request(
            "POST", "/api/formula_backtest", {"expression": "CLOSE", "scope": 3}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["stocks"], 1)
        status, payload, _ = self.request("POST", "/api/stats_csv", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["statCsv"], "/tmp/tdxstat.csv")
        status, payload, _ = self.request("POST", "/api/stats_parquet", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rowCount"], 2)
        status, payload, _ = self.request("POST", "/api/duck_query", {"sql": "SELECT code FROM tdxstat"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["600519"]])
        status, payload, _ = self.request("POST", "/api/blocks", {"kind": "gn"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["blocks"][0]["name"], "测试板块")
        status, payload, _ = self.request("POST", "/api/industries", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["blocks"][0]["name"], "银行")
        status, payload, _ = self.request("POST", "/api/screen", {"minChangePct": 5})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["matched"], 5)
        status, payload, _ = self.request("POST", "/api/f10_announcements", {"code": "sz000001"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"][0]["title"], "测试公告")
        status, payload, _ = self.request("POST", "/api/f10_profile", {"code": "sz000001"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["A股"]])
        status, payload, _ = self.request("POST", "/api/f10_valuation", {"code": "sz000001"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["20261029"]])
        status, payload, _ = self.request("POST", "/api/f10_finance", {"code": "sz000001"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["2026-09-30"]])
        status, payload, _ = self.request("POST", "/api/f10_business", {"code": "sz000001"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["按地区"]])
        status, payload, _ = self.request("POST", "/api/f10_shareholders", {"code": "sz000001"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["平安人寿"]])
        status, payload, _ = self.request("POST", "/api/f10_reports", {"code": "sz000001"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["点评标题"]])
        status, payload, _ = self.request("POST", "/api/f10_news", {"code": "sz000001"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"][0]["title"], "新闻")
        status, payload, _ = self.request(
            "POST", "/api/f10_trading", {"code": "sz000001", "section": "margin"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["count"], 1)
        status, payload, _ = self.request("POST", "/api/market_breadth", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["total"], 6)
        status, payload, _ = self.request("POST", "/api/local_day", {"path": "/tmp/a.day"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["count"], 1)
        status, payload, _ = self.request("POST", "/api/local_import", {"path": "/tmp/a.day"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["totalRows"], 1)
        status, payload, _ = self.request(
            "POST", "/api/local_query", {"sql": "SELECT code FROM bars", "limit": 1}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rowCount"], 1)
        status, payload, _ = self.request(
            "POST", "/api/local_write", {"path": "/tmp/a.day", "bars": [{"date": "2026-01-01"}]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["count"], 1)
        status, payload, _ = self.request(
            "POST", "/api/local_write_min", {"path": "/tmp/a.lc1", "bars": [{"date": "2026-01-01 09:30"}]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["count"], 1)
        status, payload, _ = self.request("POST", "/api/export_klines", {"codes": ["sh600519"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["codes"], 1)
        status, payload, _ = self.request("POST", "/api/archive_snapshot", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], 0)
        status, payload, _ = self.request("POST", "/api/lake_archives", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"], [])
        status, payload, _ = self.request(
            "POST", "/api/auction_archive_save", {"code": "sh600519"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], 1)
        status, payload, _ = self.request(
            "POST",
            "/api/auction_archive_read",
            {"code": "sh600519", "date": "2026-10-30"},
        )
        self.assertEqual(status, 200)
        self.assertFalse(payload["result"]["found"])
        status, payload, _ = self.request("POST", "/api/auction_archive_list", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"], [])
        status, payload, _ = self.request(
            "POST", "/api/auction_archive_batch", {"codes": ["sh600519"]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["savedCount"], 1)
        status, payload, _ = self.request("POST", "/api/mac_quotes", {"codes": ["sh600519"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"], [])
        status, payload, _ = self.request(
            "POST", "/api/mac_quotes_finance", {"codes": ["sh600519"]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"], [])
        status, payload, _ = self.request("POST", "/api/mac_money_flow", {"code": "sh600519"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["mainNet"], 1.0)
        status, payload, _ = self.request(
            "POST",
            "/api/mac_money_flow_batch",
            {"codes": ["sh600519", "sz000001"], "workers": 2},
        )
        self.assertEqual(status, 200)
        self.assertEqual([row["code"] for row in payload["result"]], ["sh600519", "sz000001"])
        self.assertEqual(payload["result"][0]["workers"], 2)
        status, payload, _ = self.request("POST", "/api/mac_unusual", {"count": 10})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"], [])
        status, payload, _ = self.request("POST", "/api/mac_boards", {"boardType": 255})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"], [])
        status, payload, _ = self.request("POST", "/api/f10_statement", {"code": "sz000001", "kind": "zcfzb"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["rows"], [["2026-09-30"]])

    def test_bad_json(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("POST", "/api/quotes", body="{", headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        self.assertEqual(response.status, 400)
        self.assertFalse(payload["ok"])

    def test_unknown_path(self):
        status, payload, _ = self.request("GET", "/api/nope")
        self.assertEqual(status, 404)
        self.assertFalse(payload["ok"])

    def test_sse_stream(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("GET", "/api/stream?codes=sh600519&interval=1000")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type", ""))
        line = response.readline().decode("utf-8")
        self.assertTrue(line.startswith("data: "), line)
        payload = json.loads(line[len("data: ") :])
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["result"]["quotes"][0]["code"], "sh600519")
        connection.close()


class TestQuoteInterval(unittest.TestCase):
    def test_trading_and_pre_open_keep_requested_interval(self):
        for clock in (("10:00:00", "trading"), ("09:20:00", "pre-open")):
            with patch("tdx_server.shanghai_clock", return_value=clock):
                self.assertEqual(_quote_interval(1.0), 1.0)

    def test_closed_scales_ten_times_with_thirty_second_floor(self):
        with patch("tdx_server.shanghai_clock", return_value=("20:00:00", "closed")):
            self.assertEqual(_quote_interval(1.0), 30.0)
            self.assertEqual(_quote_interval(5.0), 50.0)

    def test_lunch_break_also_scales(self):
        with patch("tdx_server.shanghai_clock", return_value=("12:00:00", "lunch-break")):
            self.assertEqual(_quote_interval(1.0), 30.0)


class TestStaticWeb(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        (root / "assets").mkdir()
        (root / "index.html").write_text("<h1>pythontdx Web</h1>", encoding="utf-8")
        (root / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
        self.server = create_server("127.0.0.1", 0, FakeBridge(), root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def get(self, path, method="GET"):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=3
        )
        connection.request(method, path)
        response = connection.getresponse()
        body = response.read()
        content_type = response.getheader("Content-Type", "")
        connection.close()
        return response.status, body, content_type

    def test_static_and_spa_fallback(self):
        status, body, content_type = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("pythontdx Web", body.decode())
        self.assertIn("text/html", content_type)
        status, body, content_type = self.get("/assets/app.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", content_type)
        self.assertEqual(body, b"console.log(1)")
        status, body, _ = self.get("/assets/app.js", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        status, body, _ = self.get("/some/spa/route")
        self.assertEqual(status, 200)
        self.assertIn("pythontdx Web", body.decode())
        status, _, _ = self.get("/%2e%2e/%2e%2e/etc/passwd")
        self.assertEqual(status, 403)

class TestWebSocket(unittest.TestCase):
    def setUp(self):
        self.server = create_server("127.0.0.1", 0, FakeBridge())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def recv_frame(self, sock):
        header = sock.recv(2)
        self.assertEqual(len(header), 2)
        opcode = header[0] & 0x0F
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", sock.recv(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", sock.recv(8))[0]
        payload = b""
        while len(payload) < length:
            payload += sock.recv(length - len(payload))
        return opcode, payload

    def send_text(self, sock, text):
        payload = text.encode()
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        sock.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + masked)

    def test_ws_quote(self):
        sock = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(
            (
                "GET /ws HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{self.server.server_port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        response = b""
        while b"\r\n\r\n" not in response:
            response += sock.recv(4096)
        self.assertIn(b"101 Switching Protocols", response)
        expected = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()
        ).decode()
        self.assertIn(f"Sec-WebSocket-Accept: {expected}".encode(), response)

        self.send_text(
            sock,
            json.dumps({"type": "subscribe", "codes": ["sh600519"], "intervalMs": 1000}),
        )
        quote = None
        for _ in range(4):
            opcode, payload = self.recv_frame(sock)
            message = json.loads(payload)
            if message.get("type") == "quote":
                quote = message
                break
        self.assertIsNotNone(quote)
        self.assertEqual(quote["quotes"][0]["code"], "sh600519")
        sock.close()


if __name__ == "__main__":
    unittest.main()
