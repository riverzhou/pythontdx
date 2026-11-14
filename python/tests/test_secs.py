"""秒级逐笔与 F10 定长目录字段的回归测试。"""

from __future__ import annotations

import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tdx_bridge import active_endpoints, parse_connect_cfg, parse_f10_catalog
from tdx_mac import parse_transactions


class TestSecondsTransactions(unittest.TestCase):
    def test_parse_mac_transactions_has_seconds(self) -> None:
        body = bytearray(39)
        struct.pack_into("<I", body, 24, 20261030)
        struct.pack_into("<H", body, 29, 1)
        body.extend(struct.pack("<IfIIH", 9 * 3600 + 30 * 60 + 9, 12.34, 100, 2, 0))

        rows = parse_transactions(bytes(body))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["time"], "09:30:09")
        self.assertEqual(rows[0]["timeSeconds"], 34209)
        self.assertEqual(rows[0]["price"], 12.34)
        self.assertEqual(rows[0]["orderCount"], 2)


class TestF10CatalogNames(unittest.TestCase):
    def test_fixed_width_name_stops_at_nul(self) -> None:
        name = "公司大事".encode("gbk").ljust(64, b"\x00")
        filename = b"gpsz".ljust(80, b"\x00")
        record = name + filename + struct.pack("<II", 0, 10)
        body = struct.pack("<H", 1) + record

        sections = parse_f10_catalog(body)
        self.assertEqual(sections[0]["name"], "公司大事")
        self.assertNotIn("\x00", sections[0]["name"])
        self.assertEqual(sections[0]["filename"], "gpsz")


class TestConnectCfg(unittest.TestCase):
    def test_parse_hqhost_with_primary_rotation(self) -> None:
        content = (
            "[HQHOST]\r\n"
            "HostNum=2\r\n"
            "PrimaryHost=2\r\n"
            "HostName01=通达信主站一\r\n"
            "IPAddress01=1.1.1.1\r\n"
            "Port01=7709\r\n"
            "HostName02=通达信主站二\r\n"
            "IPAddress02=2.2.2.2\r\n"
            "Port02=7709\r\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "connect.cfg"
            path.write_bytes(content.encode("gb18030"))
            hosts = parse_connect_cfg(path)
        self.assertEqual(hosts, [("2.2.2.2", 7709), ("1.1.1.1", 7709)])

    def test_active_endpoints_uses_env_file(self) -> None:
        content = "[HQHOST]\nPrimaryHost=1\nIPAddress01=3.3.3.3\nPort01=7709\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "connect.cfg"
            path.write_bytes(content.encode("gb18030"))
            with mock.patch.dict("os.environ", {"PYTHONTDX_CONNECT_CFG": str(path)}):
                hosts, source = active_endpoints()
        self.assertEqual(hosts, [("3.3.3.3", 7709)])
        self.assertEqual(source, str(path))


if __name__ == "__main__":
    unittest.main()
