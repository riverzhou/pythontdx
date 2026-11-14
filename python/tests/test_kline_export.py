import json
import tempfile
import unittest
from pathlib import Path

from kline_export import write_kline_export


class TestKlineExport(unittest.TestCase):
    def test_writes_csv_jsonl_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            bars = [
                {"date": "2026-10-29", "open": 10.0, "high": 10.5, "low": 9.8, "close": 10.2, "volume": 100},
                {"date": "2026-10-30", "open": 10.2, "high": 10.6, "low": 10.1, "close": 10.5, "volume": 200},
            ]
            result = write_kline_export(
                Path(directory), {"sh600519": bars}, "day", "qfq", "2026-10-30T20:00:00+08:00"
            )
            self.assertEqual(result["rows"], 2)
            self.assertEqual(result["codes"], 1)
            manifest = json.loads((Path(directory) / "manifest.json").read_text("utf-8"))
            self.assertEqual(manifest["files"][0]["rows"], 2)
            self.assertTrue((Path(directory) / "sh600519-day.csv").exists())
            self.assertTrue((Path(directory) / "sh600519-day.jsonl.gz").exists())


if __name__ == "__main__":
    unittest.main()
