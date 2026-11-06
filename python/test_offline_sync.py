"""离线同步引擎与按代码归档的离线测试；不联网、不真正起子进程。"""

from __future__ import annotations

import gzip
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import offline_sync
from kline_manifest import write_kline_manifest
from parquet_store import write_bars
from code_archive import (
    list_code_archives,
    read_code_archive,
    write_code_archive,
)

SHANGHAI = timezone(timedelta(hours=8))


class TestCodeArchive(unittest.TestCase):
    def test_two_codes_same_day_are_both_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = write_code_archive(
                root,
                "today_minute",
                "sh600000",
                [{"code": "sh600000", "price": 10.5}],
                source="test",
                trade_date="2026-11-04",
            )
            second = write_code_archive(
                root,
                "today_minute",
                "sz000001",
                [{"code": "sz000001", "price": 11.2}],
                source="test",
                trade_date="2026-11-04",
            )
            self.assertFalse(first["skipped"])
            self.assertFalse(second["skipped"])
            self.assertEqual(len(list_code_archives(root)), 2)
            again = write_code_archive(
                root,
                "today_minute",
                "sh600000",
                [{"code": "sh600000", "price": 99.0}],
                source="test",
                trade_date="2026-11-04",
            )
            self.assertTrue(again["skipped"])
            payload = read_code_archive(root, "sh600000", "2026-11-04")
            self.assertEqual(payload["count"], 1)
            self.assertEqual(payload["rows"][0]["price"], 10.5)

    def test_corrupted_copy_is_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_code_archive(
                root,
                "today_minute",
                "sh600000",
                [{"code": "sh600000", "price": 10.5}],
                source="test",
                trade_date="2026-11-04",
            )
            data_path = root / "trade_date=2026-11-04" / "sh600000.jsonl.gz"
            data_path.write_bytes(b"broken")
            rewritten = write_code_archive(
                root,
                "today_minute",
                "sh600000",
                [{"code": "sh600000", "price": 12.0}],
                source="test",
                trade_date="2026-11-04",
            )
            self.assertFalse(rewritten["skipped"])
            payload = read_code_archive(root, "sh600000", "2026-11-04")
            self.assertEqual(payload["rows"][0]["price"], 12.0)

    def test_invalid_key_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(Exception):
                write_code_archive(
                    Path(directory),
                    "today_minute",
                    "../escape",
                    [{"a": 1}],
                    source="test",
                    trade_date="2026-11-04",
                )


class TestOfflineWindow(unittest.TestCase):
    def state(self, text: str, holidays: list[str] | None = None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            if holidays:
                (root / "trading_holidays.json").write_text(
                    json.dumps({"holidays": holidays}), encoding="utf-8"
                )
            now = datetime.fromisoformat(text).replace(tzinfo=SHANGHAI)
            return offline_sync.offline_window(now=now, root=root)

    def test_closed_inside_window(self):
        for text in ("2026-11-04T08:45:00", "2026-11-04T11:30:00", "2026-11-04T15:44:59"):
            state = self.state(text)
            self.assertFalse(state["open"], text)
            self.assertEqual(state["nextOpenAt"], "2026-11-04T15:45:00+08:00")

    def test_open_outside_window(self):
        for text in ("2026-11-04T08:44:59", "2026-11-04T15:45:00", "2026-11-04T22:00:00"):
            state = self.state(text)
            self.assertTrue(state["open"], text)
            self.assertIsNone(state["nextOpenAt"])

    def test_weekend_never_closed(self):
        state = self.state("2026-11-07T10:00:00")  # Saturday
        self.assertTrue(state["open"])
        self.assertFalse(state["tradingDay"])
        self.assertEqual(state["pauseAt"], "2026-11-09T08:45:00+08:00")

    def test_holiday_file_suppresses_guard(self):
        state = self.state("2026-11-04T10:00:00", holidays=["2026-11-04"])
        self.assertTrue(state["open"])
        self.assertFalse(state["tradingDay"])

    def test_tdx_official_holiday_suppresses_guard(self):
        # 2026 春节：TDX Except2026.zip 的 neednote_RecentHSHoliday.txt
        state = self.state("2026-02-17T10:00:00")
        self.assertTrue(state["open"])
        self.assertFalse(state["tradingDay"])
        self.assertEqual(state["pauseAt"], "2026-02-24T08:45:00+08:00")


class TestNormalizeOptions(unittest.TestCase):
    def test_clamps_and_rejects(self):
        options = offline_sync.normalize_options({"processes": 99, "threads": 0})
        self.assertEqual(options["processes"], 48)
        self.assertEqual(options["threads"], 1)
        self.assertEqual(
            options["datasets"], offline_sync.default_options()["datasets"]
        )
        with self.assertRaises(ValueError):
            offline_sync.normalize_options({"datasets": ["nope"]})
        with self.assertRaises(ValueError):
            offline_sync.normalize_options({"dates": ["2026/11/04"]})

    def test_preset_expands(self):
        options = offline_sync.normalize_options({"preset": "watchlist"})
        self.assertIn("ticks", options["datasets"])
        self.assertEqual(options["scope"], "watchlist")
        self.assertEqual(options["f10Sections"], "full")


class TestWorkerWatchdog(unittest.TestCase):
    def test_pid_alive(self):
        self.assertTrue(offline_sync._pid_alive(os.getpid()))
        self.assertFalse(offline_sync._pid_alive(999999))


class TestWorkerCommand(unittest.TestCase):
    def test_frozen_uses_existing_executable(self):
        with mock.patch.object(offline_sync, "is_frozen", return_value=True):
            command = offline_sync._worker_command(Path("spec.json"))
        self.assertEqual(command[0], str(Path(offline_sync.sys.executable).resolve()))
        self.assertEqual(command[1], "--offline-worker")

    def test_dev_uses_script(self):
        with mock.patch.object(offline_sync, "is_frozen", return_value=False):
            command = offline_sync._worker_command(Path("spec.json"))
        self.assertTrue(command[1].endswith("offline_sync.py"))
        self.assertEqual(command[2], "--worker")


class TestPlanAndShard(unittest.TestCase):
    def test_plan_and_skip_existing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.dict(os.environ, {"PYTHONTDX_DATA_DIR": str(root)}):
                options = offline_sync.normalize_options(
                    {
                        "datasets": ["kline", "finance", "category"],
                        "scope": "codes",
                        "codes": ["sh600000", "sz000001"],
                        "periods": ["day"],
                        "processes": 2,
                        "skipExisting": False,
                    }
                )
                plan = offline_sync.build_plan(options, ["sh600000", "sz000001"], root)
                self.assertEqual(
                    len([task for task in plan["tasks"] if task["dataset"] == "kline"]), 2
                )
                self.assertEqual(
                    len([task for task in plan["tasks"] if task["dataset"] == "finance"]), 1
                )
                self.assertEqual(
                    len([task for task in plan["tasks"] if task["dataset"] == "category"]), 3
                )
                # 写一份 K 线缓存，再规划时应跳过这一只（skipExisting 打开）
                cache = root / "cache" / "klines"
                cache.mkdir(parents=True)
                target = cache / "sh600000_day_all_none.parquet"
                write_bars(target, "sh600000", [
                    {"date": "2026-11-04", "open": 1.0, "close": 1.0, "high": 1.0, "low": 1.0, "volume": 1.0, "amount": 1.0}
                ])
                write_kline_manifest(target, {"code": "sh600000", "period": "day", "complete": True})
                options_skip = offline_sync.normalize_options(
                    {
                        "datasets": ["kline", "finance", "category"],
                        "scope": "codes",
                        "codes": ["sh600000", "sz000001"],
                        "periods": ["day"],
                        "skipExisting": True,
                    }
                )
                plan2 = offline_sync.build_plan(
                    options_skip, ["sh600000", "sz000001"], root
                )
                self.assertEqual(plan2["skipped"], 1)

    def test_kline_1m_missing_manifest_is_repaired(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = (
                root
                / "lake"
                / "kline_1m"
                / f"trade_date={offline_sync._today()}"
                / "sh600000.parquet"
            )
            target.parent.mkdir(parents=True)
            write_bars(
                target,
                "sh600000",
                [{"date": "2026-11-04 09:31", "open": 1.0, "close": 1.0, "high": 1.0, "low": 1.0, "volume": 1.0, "amount": 1.0}],
            )
            self.assertTrue(
                offline_sync._already_archived(
                    {"dataset": "kline_1m", "code": "sh600000"}, root
                )
            )
            self.assertTrue((target.parent / "sh600000.parquet.manifest.json").is_file())

    def test_kline_1m_old_complete_false_is_still_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = (
                root
                / "lake"
                / "kline_1m"
                / f"trade_date={offline_sync._today()}"
                / "sh600000.parquet"
            )
            target.parent.mkdir(parents=True)
            write_bars(
                target,
                "sh600000",
                [{"date": "2026-11-04 09:31", "open": 1.0, "close": 1.0, "high": 1.0, "low": 1.0, "volume": 1.0, "amount": 1.0}],
            )
            write_kline_manifest(
                target,
                {"code": "sh600000", "period": "1m", "rows": 1, "complete": False},
            )
            self.assertTrue(
                offline_sync._already_archived(
                    {"dataset": "kline_1m", "code": "sh600000"}, root
                )
            )

    def test_job_id_cannot_escape_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = offline_sync.OfflineSyncManager(root=root / "sync")
            for bad in (".", "..", "../x", "a/b", "a\b"):
                with self.assertRaises(ValueError):
                    manager.start({"jobId": bad, "datasets": ["kline"]})
            self.assertFalse((root / "job.json").exists())

    def test_incomplete_dataset_archive_is_replanned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_dir = root / "lake" / "finance_history" / "trade_date=2026-09-30"
            archive_dir.mkdir(parents=True)
            (archive_dir / "manifest.json").write_text("{}", encoding="utf-8")
            with mock.patch.dict(os.environ, {"PYTHONTDX_DATA_DIR": str(root)}):
                options = offline_sync.normalize_options(
                    {
                        "datasets": ["finance_history"],
                        "scope": "codes",
                        "codes": [],
                        "skipExisting": True,
                    }
                )
                plan = offline_sync.build_plan(options, [], root)
            self.assertEqual(plan["skipped"], 0)
            self.assertEqual(len(plan["tasks"]), 1)

    def test_ticks_defaults_to_20_trading_days(self):
        options = offline_sync.normalize_options(
            {
                "datasets": ["ticks"],
                "scope": "codes",
                "codes": ["sh600519"],
                "skipExisting": False,
            }
        )
        plan = offline_sync.build_plan(options, ["sh600519"], Path(tempfile.gettempdir()))
        self.assertEqual(len(plan["tasks"]), 20)
        self.assertEqual(len({task["date"] for task in plan["tasks"]}), 20)
        self.assertLess(plan["tasks"][0]["date"], plan["tasks"][-1]["date"])

    def test_every_dataset_can_plan_tasks(self):
        """新增数据集必须接进 build_plan，否则界面上勾了也永远不会执行。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for key in offline_sync.DATASETS:
                options = offline_sync.normalize_options(
                    {
                        "datasets": [key],
                        "scope": "codes",
                        "codes": ["sh600000"],
                        "delistedCodes": ["sh600001"],
                        "dates": ["2026-11-04"],
                        "periods": ["day"],
                        "skipExisting": False,
                    }
                )
                plan = offline_sync.build_plan(options, ["sh600000"], root)
                self.assertGreater(len(plan["tasks"]), 0, key)

    def test_sharding_balances_weights(self):
        tasks = [{"dataset": "kline", "key": str(index)} for index in range(10)]
        tasks += [{"dataset": "ticks", "key": f"t{index}"} for index in range(2)]
        shards = offline_sync.shard_tasks(tasks, 4)
        self.assertEqual(sum(len(shard) for shard in shards), len(tasks))
        self.assertTrue(all(len(shard) > 0 for shard in shards))


class FakeBridge:
    def __init__(self, *args, **kwargs):
        self.closed = False

    def close(self):
        self.closed = True

    def full_kline(self, code, period, adjust):
        return {"bars": [{"date": "2026-11-04"}], "complete": True, "pages": 1}

    def finance_snapshot(self, codes):
        return [{"code": code, "eps": 1.0} for code in codes]

    def capital_changes(self, codes):
        return {"records": [{"code": code, "date": "2026-11-04"} for code in codes]}


class TestWorker(unittest.TestCase):
    def run_worker(self, tasks, extra=None):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        root = Path(holder.name)
        job_dir = root / "job"
        job_dir.mkdir()
        spec = {
            "jobId": "test",
            "jobDir": str(job_dir),
            "index": 0,
            "threads": 2,
            "tasks": tasks,
            "servers": ["127.0.0.1"],
            "retries": 0,
            "enforceWindow": False,
            **(extra or {}),
        }
        spec_path = job_dir / "spec.json"
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        with mock.patch.object(offline_sync, "_window_closed_now", return_value=False):
            with mock.patch("tdx_bridge.Bridge", FakeBridge):
                result = offline_sync.run_worker(spec_path)
        return result, job_dir

    def test_worker_finishes_tasks_and_writes_progress(self):
        result, job_dir = self.run_worker(
            [
                {"dataset": "kline", "code": "sh600000", "period": "day", "adjust": "none"},
                {"dataset": "kline", "code": "sz000001", "period": "day", "adjust": "none"},
            ]
        )
        self.assertEqual(result["done"], 2)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["rows"], 2)
        progress = json.loads((job_dir / "progress" / "worker-000.json").read_text("utf-8"))
        self.assertEqual(progress["state"], "finished")
        results = list((job_dir / "results").glob("*.jsonl"))
        lines = [line for path in results for line in path.read_text("utf-8").splitlines() if line]
        # 线程抢占任务，不能假设「每线程一个文件」；总行数才是稳定断言。
        self.assertEqual(len(lines), 2)

    def test_worker_pause_flag(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        job_dir = Path(holder.name) / "job"
        job_dir.mkdir()
        (job_dir / "pause.flag").write_text("1", encoding="utf-8")
        spec_path = job_dir / "spec.json"
        spec_path.write_text(
            json.dumps(
                {
                    "jobId": "test",
                    "jobDir": str(job_dir),
                    "index": 0,
                    "threads": 1,
                    "tasks": [
                        {
                            "dataset": "kline",
                            "code": "sh600000",
                            "period": "day",
                            "adjust": "none",
                        }
                    ],
                    "servers": ["127.0.0.1"],
                    "enforceWindow": False,
                }
            ),
            encoding="utf-8",
        )
        with mock.patch("tdx_bridge.Bridge", FakeBridge):
            result = offline_sync.run_worker(spec_path)
        self.assertEqual(result["state"], "paused")
        self.assertEqual(result["done"], 0)

    def test_bulk_worker_writes_parts(self):
        result, job_dir = self.run_worker(
            [{"dataset": "finance", "codes": ["sh600000", "sz000001"]}]
        )
        self.assertEqual(result["done"], 1)
        parts = list((job_dir / "parts" / "finance").glob("*.jsonl.gz"))
        self.assertTrue(parts)
        with gzip.open(parts[0], "rt", encoding="utf-8") as handle:
            payload = json.loads(handle.readline())
        self.assertEqual(len(payload["rows"]), 2)


class TestDispatchWindowGuard(unittest.TestCase):
    def test_bulk_download_blocked_inside_window(self):
        import tdx_bridge

        class NeverCalled:
            def __getattr__(self, _name):
                raise AssertionError("窗口内不应该调用行情桥")

        closed = {
            "open": False,
            "reason": "交易时段保护",
            "nextOpenAt": "2026-11-04T15:45:00+08:00",
        }
        with mock.patch("offline_sync.offline_window", return_value=closed):
            for cmd in ("cache_klines", "tick_archive_batch", "archive_datasets"):
                with self.assertRaises(tdx_bridge.TdxError):
                    tdx_bridge.dispatch(NeverCalled(), cmd, {})

    def test_realtime_commands_not_blocked(self):
        import tdx_bridge

        class Fake:
            def quotes(self, codes):
                return []

        closed = {"open": False, "reason": "保护", "nextOpenAt": None}
        with mock.patch("offline_sync.offline_window", return_value=closed):
            self.assertEqual(tdx_bridge.dispatch(Fake(), "quotes", {"codes": []}), [])


class TestFinalizeBulk(unittest.TestCase):
    def test_merge_parts_into_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job_dir = root / "job"
            parts = job_dir / "parts" / "finance"
            parts.mkdir(parents=True)
            with gzip.open(parts / "worker-000-00.jsonl.gz", "wt", encoding="utf-8") as handle:
                handle.write(json.dumps({"rows": [{"code": "sh600000", "eps": 1.0}]}) + "\n")
            with gzip.open(parts / "worker-001-00.jsonl.gz", "wt", encoding="utf-8") as handle:
                handle.write(json.dumps({"rows": [{"code": "sz000001", "eps": 2.0}]}) + "\n")
            (job_dir / "results").mkdir()
            (job_dir / "results" / "worker-000-00.jsonl").write_text(
                json.dumps({"task": {"dataset": "finance"}, "status": "ok"}) + chr(10)
                + json.dumps({"task": {"dataset": "finance"}, "status": "ok"}) + chr(10),
                encoding="utf-8",
            )
            (job_dir / "plan.json").write_text(
                json.dumps({"datasets": {"finance": 2}, "tradeDate": offline_sync._today()}),
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"PYTHONTDX_DATA_DIR": str(root)}):
                manager = offline_sync.OfflineSyncManager(root=root / "lake" / "offline_sync")
                summary = manager._finalize_bulk(
                    job_dir, offline_sync.normalize_options({"datasets": ["finance"]})
                )
            self.assertIn("finance", summary)
            self.assertEqual(summary["finance"]["rows"], 2)
            manifest = (
                root / "lake" / "finance" / f"trade_date={offline_sync._today()}" / "manifest.json"
            )
            self.assertTrue(manifest.is_file())

    def test_paused_bulk_is_not_finalized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job_dir = root / "job"
            parts = job_dir / "parts" / "finance"
            parts.mkdir(parents=True)
            with gzip.open(parts / "worker-000-00.jsonl.gz", "wt", encoding="utf-8") as handle:
                handle.write(json.dumps({"rows": [{"code": "sh600000", "eps": 1.0}]}) + chr(10))
            with mock.patch.dict(os.environ, {"PYTHONTDX_DATA_DIR": str(root)}):
                manager = offline_sync.OfflineSyncManager(root=root / "lake" / "offline_sync")
                summary = manager._finalize_bulk(
                    job_dir,
                    offline_sync.normalize_options({"datasets": ["finance"]}),
                    allow=False,
                )
            self.assertTrue(summary["finance"]["skipped"])
            self.assertFalse(
                (
                    root
                    / "lake"
                    / "finance"
                    / f"trade_date={offline_sync._today()}"
                    / "manifest.json"
                ).is_file()
            )

    def test_bulk_uses_plan_trade_date(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job_dir = root / "job"
            parts = job_dir / "parts" / "finance"
            parts.mkdir(parents=True)
            with gzip.open(parts / "worker-000-00.jsonl.gz", "wt", encoding="utf-8") as handle:
                handle.write(json.dumps({"rows": [{"code": "sh600000", "eps": 1.0}]}) + chr(10))
            (job_dir / "results").mkdir()
            (job_dir / "results" / "worker-000-00.jsonl").write_text(
                json.dumps({"task": {"dataset": "finance"}, "status": "ok"}) + chr(10),
                encoding="utf-8",
            )
            (job_dir / "plan.json").write_text(
                json.dumps({"datasets": {"finance": 1}, "tradeDate": "2026-11-03"}),
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"PYTHONTDX_DATA_DIR": str(root)}):
                manager = offline_sync.OfflineSyncManager(root=root / "lake" / "offline_sync")
                summary = manager._finalize_bulk(
                    job_dir, offline_sync.normalize_options({"datasets": ["finance"]})
                )
            self.assertEqual(summary["finance"]["tradeDate"], "2026-11-03")
            self.assertTrue(
                (
                    root
                    / "lake"
                    / "finance"
                    / "trade_date=2026-11-03"
                    / "manifest.json"
                ).is_file()
            )

    def test_failed_bulk_is_not_finalized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job_dir = root / "job"
            parts = job_dir / "parts" / "finance"
            parts.mkdir(parents=True)
            with gzip.open(parts / "worker-000-00.jsonl.gz", "wt", encoding="utf-8") as handle:
                handle.write(json.dumps({"rows": [{"code": "sh600000", "eps": 1.0}]}) + "\n")
            failures = job_dir / "failures"
            failures.mkdir()
            (failures / "worker-000.jsonl").write_text(
                json.dumps({"task": {"dataset": "finance"}, "error": "boom"}) + "\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"PYTHONTDX_DATA_DIR": str(root)}):
                manager = offline_sync.OfflineSyncManager(root=root / "lake" / "offline_sync")
                summary = manager._finalize_bulk(
                    job_dir, offline_sync.normalize_options({"datasets": ["finance"]})
                )
            self.assertTrue(summary["finance"]["skipped"])
            manifest = (
                root / "lake" / "finance" / f"trade_date={offline_sync._today()}" / "manifest.json"
            )
            self.assertFalse(manifest.is_file())


if __name__ == "__main__":
    unittest.main()
