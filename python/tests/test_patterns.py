import unittest

from patterns import ALGORITHM_VERSION, build_smart_drawings, channel_offset_at, pattern_summary


def bar(date, close):
    return {
        "date": date,
        "open": close,
        "high": close + 1,
        "low": close - 1,
        "close": close,
        "volume": 1000,
    }


def zigzag():
    values = [
        30, 31, 32, 35, 38, 42, 45, 50, 55, 60, 58, 54, 50, 46, 42, 38, 34, 30,
        28, 26, 24, 22, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 58, 54,
        50, 46, 42, 38, 34, 30, 32, 34, 36, 38,
    ]
    return [bar(f"2026-01-{index + 1:02d}", value) for index, value in enumerate(values)]


class TestPatterns(unittest.TestCase):
    def test_smart_combo(self):
        plans = build_smart_drawings(zigzag())
        self.assertEqual([plan["type"] for plan in plans], ["fib", "measure", "channel", "horizontal", "arrow"])
        self.assertTrue(all(plan["algorithm"] == ALGORITHM_VERSION for plan in plans))
        channel = next(plan for plan in plans if plan["type"] == "channel")
        self.assertNotEqual(channel["offset"], 0)
        self.assertTrue(all("score" in plan for plan in plans))

    def test_insufficient_or_flat(self):
        self.assertEqual(build_smart_drawings([]), [])
        self.assertEqual(build_smart_drawings([bar("2026-01-01", 10)]), [])
        self.assertEqual(
            build_smart_drawings([bar(f"2026-02-{index + 1:02d}", 10) for index in range(40)]),
            [],
        )

    def test_channel_offset_at(self):
        self.assertAlmostEqual(channel_offset_at(0, 10, 10, 20, 5, 5), -10)
        self.assertIsNone(channel_offset_at(5, 10, 5, 20, 5, 15))

    def test_summary(self):
        summary = pattern_summary(build_smart_drawings(zigzag()))
        self.assertEqual(summary["algorithm"], ALGORITHM_VERSION)
        self.assertEqual(summary["count"], 5)


if __name__ == "__main__":
    unittest.main()
