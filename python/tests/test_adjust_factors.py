"""本地复权系数公式测试；不联网。"""

import unittest

from adjust_factors import apply_factors, build_factors, coefficient_for_bar


class TestAdjustFactors(unittest.TestCase):
    def setUp(self):
        self.records = [
            {
                "date": "2001-02-19",
                "category": 1,
                "c1": 0,
                "c2": 25,
                "c3": 0,
                "c4": 2,
            }
        ]

    def test_single_rights_event(self):
        rows = build_factors(self.records)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertAlmostEqual(row["qfqScale"], 1 / 1.2)
        self.assertAlmostEqual(row["qfqOffset"], 5 / 1.2)
        self.assertAlmostEqual(row["hfqScale"], 1.2)
        self.assertAlmostEqual(row["hfqOffset"], -5.0)

    def test_apply_before_and_after(self):
        rows = build_factors(self.records)
        self.assertEqual(coefficient_for_bar(rows, "2001-02-18", "qfq")[0], 1 / 1.2)
        self.assertEqual(coefficient_for_bar(rows, "2001-02-19", "hfq")[0], 1.2)
        bars = [{"date": "2001-02-18", "open": 12, "high": 12, "low": 12, "close": 12}]
        adjusted = apply_factors(bars, rows, "qfq")
        self.assertAlmostEqual(adjusted[0]["close"], 14.17)

    def test_ignores_non_dividend_category(self):
        rows = build_factors([{**self.records[0], "category": 5}])
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
