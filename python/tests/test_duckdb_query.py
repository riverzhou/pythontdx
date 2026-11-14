"""DuckDB Parquet 查询测试；依赖 duckdb + pyarrow，默认环境跳过。"""

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

import duckdb_query
import parquet_export

try:
    import duckdb  # noqa: F401
    import pyarrow  # noqa: F401

    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False


@unittest.skipUnless(HAS_DEPS, "duckdb / pyarrow 未安装")
class TestDuckDbQuery(unittest.TestCase):
    def test_query_parquet_view(self):
        with tempfile.TemporaryDirectory() as directory:
            old = os.environ.get("PYTHONTDX_DATA_DIR")
            os.environ["PYTHONTDX_DATA_DIR"] = directory
            try:
                root = Path(directory) / "normalized" / "tdx" / "zhb_stats"
                root.mkdir(parents=True)
                database = sqlite3.connect(root / "stats.db")
                database.execute("CREATE TABLE tdxstat (stats_date TEXT, code TEXT, pe_ttm REAL)")
                database.execute("INSERT INTO tdxstat VALUES ('20261029','600519',20.79)")
                database.execute("CREATE TABLE tdxstat2 (stats_date TEXT, code TEXT, amount REAL)")
                database.execute("INSERT INTO tdxstat2 VALUES ('20261029','600519',1234.5)")
                database.commit()
                database.close()
                parquet_export.export_stats_parquet(database=root / "stats.db")

                result = duckdb_query.run_duckdb_query(
                    "SELECT code, pe_ttm FROM tdxstat ORDER BY code", 10
                )
                self.assertEqual(result["columns"], ["code", "pe_ttm"])
                self.assertEqual(result["rows"], [["600519", 20.79]])
                with self.assertRaises(duckdb_query.DuckDbUnavailable):
                    duckdb_query.run_duckdb_query("SELECT * FROM read_csv('/etc/passwd')")
            finally:
                if old is None:
                    os.environ.pop("PYTHONTDX_DATA_DIR", None)
                else:
                    os.environ["PYTHONTDX_DATA_DIR"] = old


if __name__ == "__main__":
    unittest.main()
