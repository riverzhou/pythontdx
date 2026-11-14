import os
import sqlite3
import struct
import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_import import import_local_file


class TestLocalImport(unittest.TestCase):
    def test_import_deduplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sh600519.day"
            with source.open("wb") as handle:
                handle.write(struct.pack("<IIIIIfII", 20261029, 1000, 1100, 900, 1050, 1234.5, 10000, 0))
                handle.write(struct.pack("<IIIIIfII", 20261030, 1050, 1200, 1000, 1100, 2234.5, 20000, 0))
            root = Path(directory) / "data"
            first = import_local_file(str(source), root)
            second = import_local_file(str(source), root)
            self.assertEqual(first["code"], "sh600519")
            self.assertEqual(first["rows"], 2)
            self.assertEqual(second["totalRows"], 2)
            self.assertTrue(Path(second["jsonlPath"]).exists())
            self.assertTrue(Path(second["database"]).exists())


class TestLocalQuery(unittest.TestCase):
    def test_readonly_query(self):
        import tdx_bridge

        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "local" / "normalized" / "local" / "local_bars.db"
            database.parent.mkdir(parents=True)
            connection = sqlite3.connect(database)
            connection.execute("CREATE TABLE bars(code TEXT, date TEXT, close REAL)")
            connection.execute("INSERT INTO bars VALUES('sh600519','2026-10-30',1392.05)")
            connection.commit()
            connection.close()
            stats = Path(directory) / "normalized" / "tdx" / "zhb_stats" / "stats.db"
            stats.parent.mkdir(parents=True)
            side = sqlite3.connect(stats)
            side.execute("CREATE TABLE tdxstat(code TEXT, pe_ttm REAL)")
            side.execute("INSERT INTO tdxstat VALUES('sh600519', 20.1)")
            side.commit()
            side.close()
            with patch.dict(os.environ, {"PYTHONTDX_DATA_DIR": directory}):
                result = tdx_bridge.run_local_query("SELECT code, close FROM bars")
                self.assertEqual(result["rowCount"], 1)
                joined = tdx_bridge.run_local_query(
                    "SELECT b.code, s.pe_ttm FROM bars b JOIN stats.tdxstat s ON s.code = b.code"
                )
                self.assertEqual(joined["rows"], [["sh600519", 20.1]])
                with self.assertRaises(tdx_bridge.TdxError):
                    tdx_bridge.run_local_query("UPDATE bars SET close = 0")


if __name__ == "__main__":
    unittest.main()
