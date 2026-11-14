"""Parquet 可选导出测试；未安装 pyarrow 时跳过，不伪装成通过。"""

import sqlite3
import tempfile
import unittest
from pathlib import Path

import parquet_export

try:
    import pyarrow  # noqa: F401

    HAS_PYARROW = True
except ImportError:
    HAS_PYARROW = False


@unittest.skipUnless(HAS_PYARROW, "pyarrow 未安装")
class TestParquetExport(unittest.TestCase):
    def test_partitioned_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "stats.db"
            connection = sqlite3.connect(database)
            connection.execute("CREATE TABLE tdxstat (stats_date TEXT, code TEXT, pe_ttm REAL)")
            connection.execute("INSERT INTO tdxstat VALUES ('20261029','600519',20.79)")
            connection.execute(
                "CREATE TABLE tdxstat2 (stats_date TEXT, code TEXT, amount_10k REAL)"
            )
            connection.execute("INSERT INTO tdxstat2 VALUES ('20261029','600519',1234.5)")
            connection.commit()
            connection.close()

            result = parquet_export.export_stats_parquet(database, root / "parquet")
            self.assertEqual(result["rowCount"], 2)
            import pyarrow.parquet as pq

            table = pq.read_table(
                root / "parquet" / "tdxstat" / "trade_date=20261029" / "part-00000.parquet"
            )
            self.assertEqual(table.num_rows, 1)
            self.assertEqual(table.column("code").to_pylist(), ["600519"])

@unittest.skipIf(HAS_PYARROW, "pyarrow 已安装，走导出用例")
class TestParquetUnavailable(unittest.TestCase):
    def test_clear_error(self):
        with self.assertRaises(parquet_export.ParquetUnavailable):
            parquet_export.export_stats_parquet()


if __name__ == "__main__":
    unittest.main()
