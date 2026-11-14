"""服务器文件目录/差分的离线测试。"""
from __future__ import annotations

import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from server_catalog import list_server_catalogs, write_server_catalog


def make_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("tdxzs.cfg", "板块")
        archive.writestr("incon.dat", "行业")
    return buffer.getvalue()


class TestServerCatalog(unittest.TestCase):
    def test_catalog_and_diff(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = write_server_catalog(root, make_zip(), "abc")
            self.assertEqual(first["count"], 2)
            self.assertEqual(len(first["diff"]["added"]), 2)
            second = write_server_catalog(root, make_zip(), "abc")
            self.assertEqual(second["diff"]["changed"], [])
            self.assertEqual(len(list_server_catalogs(root)), 1)

    def test_bad_zip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(Exception):
                write_server_catalog(Path(directory), b"not zip", "x")


if __name__ == "__main__":
    unittest.main()
