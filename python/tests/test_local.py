import struct
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tdx_local import LocalDayError, read_day_file, read_local_file, write_day_file, write_min_file


class TestLocalDay(unittest.TestCase):
    def test_read_day(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sh600519.day"
            with path.open("wb") as handle:
                handle.write(struct.pack("<IIIIIfII", 20261029, 1000, 1100, 900, 1050, 1234.5, 10000, 0))
                handle.write(struct.pack("<IIIIIfII", 20261030, 1050, 1200, 1000, 1100, 2234.5, 20000, 0))
            result = read_day_file(str(path))
            self.assertEqual(result["count"], 2)
            self.assertEqual(result["bars"][0]["close"], 10.5)
            self.assertEqual(result["bars"][1]["volume"], 200)

    def test_read_lc1(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sh600519.lc1"
            date = (2026 - 2004) * 2048 + 1030
            with path.open("wb") as handle:
                handle.write(struct.pack("<HHfffffII", date, 570, 10.0, 10.5, 9.8, 10.2, 12345.0, 10000, 0))
            result = read_local_file(str(path))
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["firstDate"], "2026-10-30 09:30")
            self.assertEqual(result["bars"][0]["volume"], 100)

    def test_write_day_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.day"
            bars = [
                {"date": "2026-10-29", "open": 10.0, "high": 10.5, "low": 9.8, "close": 10.2, "amount": 1000.0, "volume": 100},
                {"date": "2026-10-30", "open": 10.2, "high": 10.6, "low": 10.1, "close": 10.5, "amount": 2000.0, "volume": 200},
            ]
            result = write_day_file(str(path), bars)
            self.assertEqual(result["count"], 2)
            loaded = read_day_file(str(path))
            self.assertEqual(loaded["count"], 2)
            self.assertEqual(loaded["bars"][1]["close"], 10.5)
            self.assertEqual(loaded["bars"][1]["volume"], 200)

    def test_write_lc1_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.lc1"
            bars = [
                {"date": "2026-10-30 09:30", "open": 10.0, "high": 10.5, "low": 9.8, "close": 10.2, "amount": 1000.0, "volume": 100},
                {"date": "2026-10-30 09:31", "open": 10.2, "high": 10.6, "low": 10.1, "close": 10.5, "amount": 2000.0, "volume": 200},
            ]
            self.assertEqual(write_min_file(str(path), bars)["count"], 2)
            loaded = read_local_file(str(path))
            self.assertEqual(loaded["count"], 2)
            self.assertEqual(loaded["bars"][1]["close"], 10.5)
            self.assertEqual(loaded["bars"][1]["volume"], 200)

    def test_bad_length(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.day"
            path.write_bytes(b"\x00" * 10)
            with self.assertRaises(LocalDayError):
                read_day_file(str(path))

    def test_etf_coefficients(self):
        """沪 ETF 是千分之一元；之前一律 /100 会把 3.500 读成 35.00。"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sh510300.day"
            with path.open("wb") as handle:
                handle.write(
                    struct.pack("<IIIIIfII", 20261030, 3500, 3550, 3480, 3520, 1000.0, 12345, 0)
                )
            result = read_day_file(str(path))
            self.assertEqual(result["securityType"], "SH_FUND")
            self.assertAlmostEqual(result["bars"][0]["close"], 3.52, places=4)
            self.assertEqual(result["bars"][0]["volume"], 12345)

    def test_index_volume_not_divided(self):
        """指数量纲是「手」本身，不能再除 100。"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sh000001.day"
            with path.open("wb") as handle:
                handle.write(
                    struct.pack("<IIIIIfII", 20261030, 320000, 321000, 319000, 320500, 1.0, 12345, 0)
                )
            result = read_day_file(str(path))
            self.assertEqual(result["securityType"], "SH_INDEX")
            self.assertAlmostEqual(result["bars"][0]["close"], 3205.0, places=4)
            self.assertEqual(result["bars"][0]["volume"], 12345)

    def test_trailing_byte_tolerated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sh600000.day"
            with path.open("wb") as handle:
                handle.write(
                    struct.pack("<IIIIIfII", 20261030, 1000, 1050, 990, 1020, 1.0, 100, 0)
                )
                handle.write(b"\x00")  # 截断残尾
            result = read_day_file(str(path))
            self.assertEqual(result["count"], 1)

    def test_etf_write_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sh510300.day"
            bars = [
                {"date": "2026-10-30", "open": 3.5, "high": 3.55, "low": 3.48, "close": 3.52, "amount": 1000.0, "volume": 12345},
            ]
            write_day_file(str(path), bars)
            loaded = read_day_file(str(path))
            self.assertAlmostEqual(loaded["bars"][0]["close"], 3.52, places=4)
            self.assertEqual(loaded["bars"][0]["volume"], 12345)


if __name__ == "__main__":
    unittest.main()
