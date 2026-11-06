"""离线数据全量同步：多进程 + 多线程 + 多服务器并行。

为什么需要独立引擎
------------------
界面上的「批量下载」是一批一批串行请求：一只股票一个连接、失败靠用户重点，
既慢又容易漏。通达信允许**同一账号/同一 IP 同时开多条 TCP 7709 连接**，官方
主站有几十个；把「代码 × 数据集」拆成任务，分发到多个进程、每个进程多条线程、
每条线程钉在不同服务器上，总吞吐才能接近网络/服务端上限。

三条硬约束
----------
1. **08:45–15:45 不下载**（交易日）：官方要把带宽留给实时行情。窗口内启动
   直接返回 blocked；跑到一半进入窗口会暂停（paused），15:45 后可续跑。
2. **不遗漏**：每个任务都写 manifest/SHA256；按代码分片的数据集（分时、逐笔、
   买卖力道、小走势）一只一份，不再出现「同一天只存了第一只」的旧缺陷。
3. **不覆盖**：已有且校验通过的同名归档跳过（规则 12），断点续跑安全。

进程/线程模型
-------------
父进程（tdx_bridge）负责：探活服务器、拉代码表、生成任务、切片、起子进程、
汇总进度、合并「整包」数据集、写 job manifest。
子进程（worker）负责：N 条线程，每条线程一个 `Bridge`（独立 TCP 连接），
从自己的分片里取任务执行，按线程写 results/parts，按进程写 progress。

不用 `multiprocessing`：Nuitka onefile 下 spawn 会重新解包，行为也不可控；
这里直接用 `subprocess` 起「自己」的 worker 模式，开发/打包两条路径都能跑。
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from data_paths import data_dir
from protocol_archive import write_dataset_archive
import trading_calendar

SHANGHAI = timezone(timedelta(hours=8))
WINDOW_START = dtime(8, 45)
WINDOW_END = dtime(15, 45)
JOB_SCHEMA = "pythontdx.offline_sync.v1"
PROGRESS_SCHEMA = "pythontdx.offline_sync.progress.v1"
DEFAULT_PROCESSES = 8
DEFAULT_THREADS = 4
MAX_PROCESSES = 48
MAX_THREADS = 4
MAX_TASKS_REPORTED_FAILURES = 500

# 数据集总表：UI/HTTP 用它生成选择项，planning/worker 用它决定落盘方式。
# mode:
#   per_code —— 每只代码独立文件，worker 直接调 archive 方法写盘；
#   bulk     —— 行数据回传父进程，按交易日合并成一份 dataset 归档。
DATASETS: dict[str, dict[str, Any]] = {
    "kline": {
        "label": "全历史 K 线",
        "group": "行情",
        "mode": "per_code",
        "weight": 6,
        "description": "日K优先 0x06b9 官方 .day 文件（全历史），失败回退 0x052d 分页；写 cache/klines/*.parquet",
    },
    "kline_1m": {
        "label": "1 分钟 K（最近 100 交易日）",
        "group": "行情",
        "mode": "per_code",
        "weight": 4,
        "description": "0x052d 从最新往前翻页，最近 100 个交易日（服务端当前约保留 92 日），写 lake/kline_1m",
    },
    "today_minute": {
        "label": "当日分时",
        "group": "行情",
        "mode": "per_code",
        "weight": 2,
        "description": "0x0537 当日分时，按代码写 lake/today_minute",
    },
    "minute_aux": {
        "label": "分时买卖力道",
        "group": "行情",
        "mode": "per_code",
        "weight": 2,
        "description": "0x051b 买卖力道/成交对比，按代码写 lake/minute_aux",
    },
    "sparkline": {
        "label": "小走势图",
        "group": "行情",
        "mode": "per_code",
        "weight": 1,
        "description": "0x0fd1 20 日价格序列，按代码写 lake/sparkline",
    },
    "auction": {
        "label": "集合竞价",
        "group": "行情",
        "mode": "per_code",
        "weight": 2,
        "description": "0x056a 竞价明细，按代码 + 交易日写 lake/auction",
    },
    "ticks": {
        "label": "逐笔成交（最近 20 交易日）",
        "group": "行情",
        "mode": "per_code",
        "weight": 20,
        "description": "0x0fc5/0x0fc6 最近 20 个交易日全部逐笔，按代码 + 交易日写 lake/ticks（体量最大）",
    },
    "history_minute": {
        "label": "历史分时",
        "group": "行情",
        "mode": "per_code",
        "weight": 2,
        "description": "0x0fb4 指定交易日分时，按代码 + 交易日写 lake/history_minute",
    },
    "money_flow": {
        "label": "资金流日数据",
        "group": "资金",
        "mode": "per_code",
        "weight": 1,
        "description": "0x0ffc 近 5 日资金流，按代码写 lake/money_flow",
    },
    "volume_profile": {
        "label": "成交分布（筹码）",
        "group": "行情",
        "mode": "per_code",
        "weight": 3,
        "description": "0x051a 价位分布 + 三档盘口 + 内外盘；免费主站实测超时，仅手动选择",
    },
    "limit_ladder": {
        "label": "涨跌停梯子",
        "group": "行情",
        "mode": "per_code",
        "weight": 2,
        "description": "7615 cfg_fx_lbtt，按交易日归档涨停/炸板/跌停与汇总",
    },
    "top_board": {
        "label": "九榜排行",
        "group": "行情",
        "mode": "per_code",
        "weight": 1,
        "description": "0x053f 一次拿涨幅/跌幅/振幅/涨速/跌速/量比/正负委比/换手，写 lake/top_board",
    },
    "unusual": {
        "label": "主力监控",
        "group": "行情",
        "mode": "bulk",
        "weight": 2,
        "description": "7709 0x0563 异动事件（19 类文案），按交易日写 lake/unusual",
    },
    "finance": {
        "label": "财务快照",
        "group": "财务",
        "mode": "bulk",
        "weight": 1,
        "description": "0x0010 136B 全字段，按交易日合并写 lake/finance",
    },
    "capital": {
        "label": "股本变迁/复权",
        "group": "财务",
        "mode": "bulk",
        "weight": 1,
        "description": "0x000f 股本变迁/权息，按交易日合并写 lake/corporate",
    },
    "f10": {
        "label": "F10 资料",
        "group": "资料",
        "mode": "per_code",
        "weight": 8,
        "description": "7709 F10 + 7615 在线资料，按代码写 lake/f10_pit（point-in-time）",
    },
    "delisted": {
        "label": "退市日线",
        "group": "行情",
        "mode": "per_code",
        "weight": 2,
        "description": "0x052b 不复权日线，按代码写 lake/delisted（需显式提供退市代码）",
    },
    "category": {
        "label": "分类行情",
        "group": "行情",
        "mode": "bulk",
        "weight": 2,
        "description": "0x054b 分类全量快照，按交易日合并写 lake/category_quotes",
    },
    "block_meta": {
        "label": "板块文件元数据",
        "group": "板块",
        "mode": "bulk",
        "weight": 1,
        "description": "0x02c5 板块 .dat 大小/MD5，按交易日合并写 lake/server_meta",
    },
    "special_limits": {
        "label": "特殊涨跌停表",
        "group": "行情",
        "mode": "bulk",
        "weight": 3,
        "description": "0x0452 全表扫描，写 lake/special_limits",
    },
    "gbbq": {
        "label": "本地股本变迁（GBBQ）",
        "group": "财务",
        "mode": "per_code",
        "weight": 2,
        "description": "读取本机 T0002/hq_cache/gbbq，解密后写 lake/gbbq/trade_date=all",
    },
    "finance_history": {
        "label": "历史专业财务（gpcw）",
        "group": "财务",
        "mode": "per_code",
        "weight": 4,
        "description": "计算服务器 0x06b9 下载 gpcw<报告期>.zip，解析 658 字段原始财报",
    },
    "blocks": {
        "label": "板块与行业",
        "group": "板块",
        "mode": "bulk",
        "weight": 2,
        "description": "block_gn/fg/zs/general + tdxhy/incon 行业 + tdxzs 指数映射，写 lake/blocks",
    },
    "server_files": {
        "label": "服务器文件",
        "group": "服务器",
        "mode": "bulk",
        "weight": 2,
        "description": "zhb.zip 下载 + 47 文件目录/SHA256，写 raw/tdx 与 lake/server_files",
    },
}

DATASET_ORDER = list(DATASETS)

A_SHARE_PREFIX = {
    "SH": ("600", "601", "603", "605", "688", "689"),
    "SZ": ("000", "001", "002", "003", "300", "301", "302"),
    "BJ": ("4", "8", "9"),
}

BLOCK_META_FILES = (
    "block_gn.dat",
    "block_fg.dat",
    "block_zs.dat",
    "block.dat",
    "tdxhy.cfg",
    "tdxzs.cfg",
    "incon.dat",
    "tdxbb.dat",
)

CATEGORY_PAIRS = ((6, 0), (7, 0), (8, 0))

F10_CORE_SECTIONS = (
    "profile",
    "valuation",
    "finance",
    "business",
    "shareholders",
    "reports",
    "news",
    "dividend",
    "shareholder_count",
    "statement_zcfzb",
    "statement_lyb",
    "statement_xjllb",
)

F10_FULL_SECTIONS = F10_CORE_SECTIONS + (
    "announcements",
    "circulating_shareholders",
    "shareholder_changes",
    "institutions",
    "controller",
    "change_plans",
    "capital_structure",
    "industry",
    "trading_margin",
    "ranking_detail",
    "northbound_holding",
    "profit_forecast",
    "governance",
    "hot_topics",
    "digest_tips",
    "digest_finance",
    "digest_holder",
    "digest_operate",
    "digest_risk",
)


# ---------------------------------------------------------------- 时间窗口


def _shanghai_now() -> datetime:
    return datetime.now(SHANGHAI)


def _holiday_file(root: Path | None = None) -> Path:
    return (Path(root) if root else data_dir()) / "trading_holidays.json"


def _configure_calendar(root: Path | None = None) -> None:
    trading_calendar.configure(
        (Path(root) if root else data_dir()) / "cache" / "trading_calendar.json"
    )


def load_holidays(root: Path | None = None) -> set[str]:
    """读取可选节假日表：{"holidays": ["2026-01-01", ...]}。

    没有这个文件时只按周末判断。宁可把节假日当成交易日（窗口内不下载），
    也不要把交易日误判成节假日——前者的代价只是晚几小时，后者会违反官方的
    交易时段保护要求。
    """
    path = _holiday_file(root)
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return set()
    values = payload.get("holidays") if isinstance(payload, dict) else payload
    if not isinstance(values, list):
        return set()
    days: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            days.add(text)
    return days


def recent_trading_days(count: int = 20, root: Path | None = None) -> list[str]:
    """最近 N 个交易日（含今天；15:00 前不含今天），按升序返回。"""
    _configure_calendar(root)
    holidays = load_holidays(root)
    current = _shanghai_now()
    day = current.date()
    if current.time().replace(tzinfo=None) < dtime(15, 0):
        day -= timedelta(days=1)
    days: list[str] = []
    while len(days) < max(1, int(count)):
        if is_trading_day(day, holidays):
            days.append(day.isoformat())
        day -= timedelta(days=1)
    return sorted(days)


def is_trading_day(day: date, holidays: set[str] | None = None) -> bool:
    """周末 + 通达信交易日历 + 用户追加休市日。"""
    return trading_calendar.is_trading_day(
        day, holidays if holidays is not None else load_holidays()
    )


def _next_trading_day(day: date, holidays: set[str]) -> date:
    candidate = day + timedelta(days=1)
    for _ in range(40):
        if is_trading_day(candidate, holidays):
            return candidate
        candidate += timedelta(days=1)
    return day + timedelta(days=1)


def offline_window(
    now: datetime | None = None, root: Path | None = None
) -> dict[str, Any]:
    """返回离线数据下载窗口状态；`open=False` 时禁止发起离线下载。"""
    current = now or _shanghai_now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=SHANGHAI)
    current = current.astimezone(SHANGHAI)
    _configure_calendar(root)
    holidays = load_holidays(root)
    trading = is_trading_day(current.date(), holidays)
    clock = current.time().replace(tzinfo=None)
    closed = trading and WINDOW_START <= clock < WINDOW_END
    start_at = datetime.combine(current.date(), WINDOW_START, tzinfo=SHANGHAI)
    end_at = datetime.combine(current.date(), WINDOW_END, tzinfo=SHANGHAI)

    # 正在跑的任务应该在下一个 08:45 之前暂停；窗口内启动则本来就是 closed。
    if closed:
        pause_at: datetime | None = None
    elif trading and clock < WINDOW_START:
        pause_at = start_at
    elif trading:
        pause_at = datetime.combine(
            _next_trading_day(current.date(), holidays), WINDOW_START, tzinfo=SHANGHAI
        )
    else:
        pause_at = datetime.combine(
            _next_trading_day(current.date(), holidays), WINDOW_START, tzinfo=SHANGHAI
        )

    return {
        "open": not closed,
        "now": current.isoformat(timespec="seconds"),
        "tradingDay": trading,
        "windowStart": "08:45",
        "windowEnd": "15:45",
        "reason": (
            "交易时段保护：08:45–15:45 官方集中发行情数据，暂停离线数据下载"
            if closed
            else "当前可下载离线数据"
        ),
        # 已经被关在窗口内时，15:45 之后才能下；否则现在就能下。
        "nextOpenAt": end_at.isoformat(timespec="seconds") if closed else None,
        # 下一个「窗口开始」时间：正在跑的任务应在这个时间点前暂停。
        "pauseAt": pause_at.isoformat(timespec="seconds") if pause_at else None,
        "holidaysLoaded": len(holidays),
    }


def summarize_job_dir(job_dir: Path) -> dict[str, Any] | None:
    """把最近一次任务压成窗口里可长期保留的摘要。

    正常完成读 manifest；进程被杀/崩溃没有 manifest 时，从 plan 和 worker
    progress 估算完成量，标成 incomplete——这比“窗口里什么都没有”有用。
    """
    job_dir = Path(job_dir)
    if not (job_dir / "plan.json").is_file() and not (job_dir / "manifest.json").is_file():
        return None
    plan: dict[str, Any] = {}
    manifest: dict[str, Any] = {}
    job: dict[str, Any] = {}
    for name, target in (("plan.json", plan), ("manifest.json", manifest), ("job.json", job)):
        try:
            if (job_dir / name).is_file():
                target.update(json.loads((job_dir / name).read_text("utf-8")))
        except (OSError, ValueError):
            pass

    totals = manifest.get("totals")
    state = str(manifest.get("state") or "")
    error = str(manifest.get("error") or "")
    datasets = manifest.get("datasets")
    if not isinstance(totals, dict):
        totals = {"total": 0, "done": 0, "skipped": 0, "failed": 0, "rows": 0}
        for path in sorted((job_dir / "progress").glob("worker-[0-9][0-9][0-9].json")):
            try:
                payload = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            for key in totals:
                totals[key] += int(payload.get(key) or 0)
        if not state:
            state = "incomplete"
            error = "任务未生成 manifest（进程中断或应用被关闭）"
    if not isinstance(datasets, dict):
        datasets = plan.get("datasets") if isinstance(plan.get("datasets"), dict) else {}
    # manifest 的 datasets 是每数据集 {done,skipped,failed,rows}；摘要只显示完成数。
    normalized_datasets: dict[str, int] = {}
    for name, value in datasets.items():
        if isinstance(value, dict):
            normalized_datasets[str(name)] = int(
                value.get("done") if "done" in value else value.get("rows") or 0
            )
        else:
            try:
                normalized_datasets[str(name)] = int(value or 0)
            except (TypeError, ValueError):
                normalized_datasets[str(name)] = 0

    # 旧 manifest 的 datasets.done 可能因历史 worker 映射 bug 全是 0；
    # 有 progress 文件时用真实 done 回填，避免摘要显示一排 0/—。
    if normalized_datasets and not any(normalized_datasets.values()):
        recovered: dict[str, int] = {}
        for path in (job_dir / "progress").glob("worker-[0-9][0-9][0-9].json"):
            try:
                payload = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            for name, bucket in (payload.get("datasets") or {}).items():
                if isinstance(bucket, dict):
                    recovered[str(name)] = recovered.get(str(name), 0) + int(
                        bucket.get("done") or 0
                    )
        if recovered and any(recovered.values()):
            normalized_datasets = recovered
        elif isinstance(plan.get("datasets"), dict):
            normalized_datasets = {
                str(name): int(value or 0)
                for name, value in plan["datasets"].items()
                if not isinstance(value, dict)
            }

    started = manifest.get("startedAt") or plan.get("plannedAt")
    finished = manifest.get("finishedAt")
    if not finished:
        try:
            finished = datetime.fromtimestamp(job_dir.stat().st_mtime, SHANGHAI).isoformat(
                timespec="seconds"
            )
        except OSError:
            finished = None
    planned = manifest.get("planned")
    if planned is None:
        planned = plan.get("tasks")
    elapsed = None
    if started and finished:
        try:
            elapsed = max(
                0.0,
                (datetime.fromisoformat(str(finished)) - datetime.fromisoformat(str(started))).total_seconds(),
            )
        except ValueError:
            elapsed = None
    return {
        "jobId": manifest.get("jobId") or job_dir.name,
        "dir": str(job_dir),
        "state": state or "unknown",
        "error": error,
        "planned": int(planned or 0),
        "totals": {key: int(totals.get(key) or 0) for key in totals},
        "datasets": normalized_datasets,
        "elapsedSeconds": round(elapsed, 1) if elapsed is not None else None,
        "options": manifest.get("options") or job.get("options") or {},
        "codes": int(plan.get("codes") or 0),
        "startedAt": started,
        "finishedAt": finished,
    }


def latest_job_summary(root: Path | None = None) -> dict[str, Any] | None:
    base = Path(root) if root else data_dir() / "lake" / "offline_sync"
    try:
        candidates = sorted(
            (path for path in base.iterdir() if path.is_dir()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return None
    for path in candidates[:5]:
        summary = summarize_job_dir(path)
        if summary is not None:
            return summary
    return None


# ---------------------------------------------------------------- 数据集元信息


def dataset_catalog() -> list[dict[str, Any]]:
    return [
        {"key": key, **{k: v for k, v in spec.items() if k != "weight"}, "weight": spec["weight"]}
        for key, spec in DATASETS.items()
    ]


def default_options() -> dict[str, Any]:
    return {
        "datasets": [
            "kline",
            "finance",
            "capital",
            "category",
            "block_meta",
            "special_limits",
            "finance_history",
            "server_files",
        ],
        "scope": "all",
        "codes": [],
        "periods": ["day"],
        "adjust": "none",
        "source": "auto",
        "dates": [],
        "f10Sections": "core",
        "minuteAuxKinds": ["buy_sell_strength", "volume_comparison"],
        "processes": DEFAULT_PROCESSES,
        "threads": DEFAULT_THREADS,
        "retries": 1,
        "enforceWindow": True,
        "allowInsideWindow": False,
        "skipExisting": True,
        "financeHistoryCount": 1,
        "delistedCodes": [],
        "includeIndexes": False,
        "maxCodes": 0,
    }


PRESETS: dict[str, dict[str, Any]] = {
    "daily": {
        "label": "收盘日常（全市场，推荐）",
        "datasets": [
            "kline",
            "finance",
            "finance_history",
            "capital",
            "category",
            "block_meta",
            "blocks",
            "special_limits",
            "server_files",
            "top_board",
            "unusual",
            "limit_ladder",
        ],
        "scope": "all",
        "periods": ["day"],
        "f10Sections": "core",
    },
    "watchlist": {
        "label": "自选深度（含分时/逐笔/竞价）",
        "datasets": [
            "kline",
            "kline_1m",
            "today_minute",
            "minute_aux",
            "sparkline",
            "auction",
            "ticks",
            "history_minute",
            "money_flow",
            "top_board",
            "unusual",
            "limit_ladder",
        ],
        "scope": "watchlist",
        "periods": ["day"],
        "f10Sections": "full",
    },
    "full": {
        "label": "全量归档（全市场，耗时/占用最大）",
        # volume_profile（0x051a）在免费主站全超时，只保留为手动数据集，不进预设。
        "datasets": [key for key in DATASETS if key != "volume_profile"],
        "scope": "all",
        "periods": ["day"],
        "f10Sections": "full",
    },
}


def _clamp_int(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def _as_list(value: Any) -> list[Any]:
    """把 CLI 传入的 "a,b" 字符串与 JSON 数组统一成列表。"""
    if value is None:
        return []
    if isinstance(value, str):
        return [item for item in re.split(r"[,\s]+", value) if item]
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def normalize_options(raw: dict[str, Any] | None) -> dict[str, Any]:
    """合并默认值并做边界校验；非法数据集/周期直接报错，避免静默漏数据。"""
    options = {**default_options(), **(raw or {})}
    preset = str(options.get("preset") or "").strip().lower()
    if preset:
        if preset not in PRESETS:
            raise ValueError(f"未知预设：{preset}")
        options = {**options, **PRESETS[preset], "preset": preset}

    datasets = options.get("datasets")
    if isinstance(datasets, str):
        datasets = [item for item in re.split(r"[,\s]+", datasets) if item]
    if not datasets:
        datasets = list(default_options()["datasets"])
    unknown = [str(item) for item in datasets if str(item) not in DATASETS]
    if unknown:
        raise ValueError(f"未知数据集：{', '.join(unknown)}")
    # 按 DATASET_ORDER 去重排序，进度/报告顺序稳定
    options["datasets"] = [key for key in DATASET_ORDER if key in set(map(str, datasets))]

    periods = options.get("periods")
    if isinstance(periods, str):
        periods = [item for item in re.split(r"[,\s]+", periods) if item]
    options["periods"] = [str(item) for item in (periods or ["day"])][:8]
    options["adjust"] = str(options.get("adjust") or "none")
    if options["adjust"] not in {"none", "qfq", "hfq"}:
        raise ValueError("adjust 只支持 none/qfq/hfq")
    options["source"] = str(options.get("source") or "auto").lower()
    if options["source"] not in {"auto", "mac", "7709"}:
        raise ValueError("source 只支持 auto/mac/7709")

    dates = options.get("dates")
    if isinstance(dates, str):
        dates = [item for item in re.split(r"[,\s]+", dates) if item]
    options["dates"] = [str(item) for item in (dates or [])][:40]
    for item in options["dates"]:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item):
            raise ValueError(f"日期必须是 YYYY-MM-DD：{item}")

    options["codes"] = [
        str(item).strip().lower()
        for item in _as_list(options.get("codes"))
        if str(item).strip()
    ]
    options["delistedCodes"] = [
        str(item).strip().lower()
        for item in _as_list(options.get("delistedCodes"))
        if str(item).strip()
    ]
    options["scope"] = str(options.get("scope") or "all").lower()
    if options["scope"] not in {"all", "watchlist", "codes"}:
        raise ValueError("scope 只支持 all/watchlist/codes")
    options["f10Sections"] = str(options.get("f10Sections") or "core").lower()
    if options["f10Sections"] not in {"core", "full"}:
        raise ValueError("f10Sections 只支持 core/full")
    kinds = options.get("minuteAuxKinds")
    if isinstance(kinds, str):
        kinds = [item for item in re.split(r"[,\s]+", kinds) if item]
    options["minuteAuxKinds"] = [str(item) for item in (kinds or ["buy_sell_strength"])][:2]
    options["processes"] = _clamp_int(options.get("processes"), 1, MAX_PROCESSES, DEFAULT_PROCESSES)
    options["threads"] = _clamp_int(options.get("threads"), 1, MAX_THREADS, DEFAULT_THREADS)
    options["retries"] = _clamp_int(options.get("retries"), 0, 3, 1)
    options["maxCodes"] = _clamp_int(options.get("maxCodes"), 0, 100_000, 0)
    options["financeHistoryCount"] = _clamp_int(
        options.get("financeHistoryCount"), 1, 200, 1
    )
    options["enforceWindow"] = bool(options.get("enforceWindow", True))
    options["allowInsideWindow"] = bool(options.get("allowInsideWindow", False))
    if options["allowInsideWindow"]:
        # 显式绕过只用于本地测试/冒烟；worker 也要跟着关掉，否则一启动就暂停。
        options["enforceWindow"] = False
    options["skipExisting"] = bool(options.get("skipExisting", True))
    options["includeIndexes"] = bool(options.get("includeIndexes", False))
    return options


# ---------------------------------------------------------------- 代码与任务


def is_a_share(item: dict) -> bool:
    if str(item.get("kind") or "") != "GP-A":
        return False
    market = str(item.get("market") or "").upper()
    symbol = str(item.get("symbol") or "")
    prefixes = A_SHARE_PREFIX.get(market)
    if not prefixes:
        return False
    return symbol.startswith(prefixes)


def resolve_codes(bridge: Any, options: dict[str, Any]) -> list[str]:
    """按 scope 解析代码清单；all 只用 0x044d 代码表里的 A 股。"""
    if options["scope"] == "codes":
        codes = [code for code in options["codes"] if re.fullmatch(r"(sh|sz|bj)\d{6}", code)]
        if not codes:
            raise ValueError("scope=codes 但没有合法的 codes")
        return sorted(set(codes))
    catalog = bridge.code_list()
    selected = [
        str(item["code"])
        for item in catalog
        if is_a_share(item)
        or (options.get("includeIndexes") and str(item.get("kind")) == "ZS")
    ]
    if options["scope"] == "watchlist":
        watch = {code for code in options["codes"] if re.fullmatch(r"(sh|sz|bj)\d{6}", code)}
        if not watch:
            raise ValueError("scope=watchlist 但没有自选代码")
        selected = [code for code in selected if code in watch] or sorted(watch)
    if options["maxCodes"]:
        selected = selected[: options["maxCodes"]]
    return sorted(set(selected))


def _today() -> str:
    return _shanghai_now().strftime("%Y-%m-%d")


def _task_key(task: dict[str, Any]) -> str:
    dataset = task["dataset"]
    parts = [dataset, str(task.get("code") or "")]
    for field in (
        "period",
        "adjust",
        "date",
        "kind",
        "category",
        "sortType",
        "filename",
        "size",
        "count",
        "days",
    ):
        if task.get(field) is not None:
            parts.append(f"{field}={task[field]}")
    if task.get("codes"):
        parts.append("codes=" + ",".join(task["codes"]))
    return "|".join(parts)


def _path_exists(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _manifest_for(data_path: Path) -> Path:
    name = data_path.name
    for suffix in (".jsonl.gz", ".parquet"):
        if name.endswith(suffix):
            return data_path.with_name(name[: -len(suffix)] + ".manifest.json")
    return data_path.with_name(name + ".manifest.json")


def _dataset_archive_valid(directory: Path) -> bool:
    """校验 trade_date 分区的 manifest + 文件 + SHA，避免半写副本被 skip。"""
    import hashlib

    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return False
    try:
        payload = json.loads(manifest_path.read_text("utf-8"))
        files = [directory / str(name) for name in payload.get("files") or []]
        jsonl = next((path for path in files if path.name.endswith(".jsonl.gz")), None)
        if not files or jsonl is None or not all(path.is_file() for path in files):
            return False
        if int(payload.get("rows") or 0) <= 0:
            return False
        digest = hashlib.sha256(jsonl.read_bytes()).hexdigest()
        return digest == payload.get("sha256")
    except (OSError, ValueError):
        return False


def _data_and_manifest(path: Path) -> bool:
    """按代码分片：规划阶段只做 manifest + 文件大小校验。

    深度 SHA 由 data_integrity 负责；如果规划时对 11 万份 tick 逐个读全文件
    算 SHA，「生成下载计划」会从几秒变成 40+ 秒。
    """
    manifest_path = _manifest_for(path)
    if not _path_exists(path) or not manifest_path.is_file():
        return False
    try:
        payload = json.loads(manifest_path.read_text("utf-8"))
        if int(payload.get("rows") or 0) <= 0:
            return False
        expected = int(payload.get("bytes") or 0)
        if expected > 0 and expected != path.stat().st_size:
            return False
        listed = [path.parent / str(name) for name in payload.get("files") or []]
        if listed and not all(item.is_file() for item in listed):
            return False
        return True
    except (OSError, ValueError):
        return False


NODATA_HINTS = (
    "没有可归档",
    "未返回 1 分钟",
    "未返回 K 线",
    "归档数据为空",
)


def _nodata_marker(root: Path, task: dict[str, Any]) -> Path | None:
    dataset = str(task.get("dataset") or "")
    code = str(task.get("code") or "")
    day = str(task.get("date") or _today())
    if not code:
        return None
    if dataset in {"auction", "ticks", "kline_1m", "history_minute"}:
        return root / "lake" / dataset / f"trade_date={day}" / f"{code}.nodata.json"
    if dataset == "kline":
        period = str(task.get("period") or "day")
        adjust = str(task.get("adjust") or "none")
        return root / "cache" / "klines" / f"{code}_{period}_all_{adjust}.nodata.json"
    if dataset == "minute_aux":
        return (
            root
            / "lake"
            / "minute_aux"
            / f"trade_date={day}"
            / f"{code}_{task.get('kind', '')}.nodata.json"
        )
    return None


def _has_nodata_marker(root: Path, task: dict[str, Any]) -> bool:
    marker = _nodata_marker(root, task)
    return bool(marker and marker.is_file())


def _write_nodata_markers(job_dir: Path, root: Path) -> None:
    """把“服务器明确没有数据”的失败记成当天标记，后续运行不再重复请求。

    只标记 no-data，不标记超时/连接失败；第二天日期变了会重新尝试。
    """
    for path in (job_dir / "failures").glob("*.jsonl"):
        try:
            lines = path.read_text("utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                failure = json.loads(line)
            except ValueError:
                continue
            error = str(failure.get("error") or "")
            task = failure.get("task") or {}
            task_dataset = str(task.get("dataset") or "")
            if not any(hint in error for hint in NODATA_HINTS) and not (
                error.startswith("CodeArchiveError") and task_dataset in {"minute_aux", "history_minute"}
            ):
                continue
            marker = _nodata_marker(root, task)
            if marker is None:
                continue
            try:
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text(
                    json.dumps(
                        {
                            "dataset": task.get("dataset"),
                            "code": task.get("code"),
                            "date": task.get("date"),
                            "error": error[:300],
                            "at": _shanghai_now().isoformat(timespec="seconds"),
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
            except OSError:
                pass


def _already_archived(task: dict[str, Any], root: Path) -> bool:
    """任务级断点续跑：已有有效文件就跳过。只做本地 stat，不联网。"""
    from tdx_bridge import _full_kline_cache_path

    dataset = task["dataset"]
    code = str(task.get("code") or "")
    day = str(task.get("date") or _today())
    if _has_nodata_marker(root, task):
        return True
    if dataset == "kline":
        from kline_manifest import manifest_path

        target = _full_kline_cache_path(code, task["period"], task["adjust"])
        if not _path_exists(target):
            return False
        # 只有「complete 不为 false」的缓存才算完成；MAC 分页遇到重复页会写
        # complete=false，若不重试会永远冻结在残缺版本。
        meta = manifest_path(target)
        if not meta.is_file():
            return False
        try:
            payload = json.loads(meta.read_text("utf-8"))
            if payload.get("complete") is False:
                return False
            if int(payload.get("rows") or 0) <= 0:
                return False
        except (OSError, ValueError):
            return False
        # 日线缓存要跟到最近交易日；否则每日同步会因旧缓存整批 skipped。
        if task.get("period") == "day" and task.get("adjust") == "none":
            latest = recent_trading_days(1, root)[0]
            if str(payload.get("lastDate") or "")[:10] < latest:
                # 当天已经重试过，但官方 .day 仍是旧日期（北交所/停牌/退市）。
                # 同一天不要无限重下；第二天 fetchedAt 不再是今天，会再试一次。
                fetched = str(payload.get("fetchedAt") or "")[:10]
                if fetched == _today():
                    return True
                return False
        return target.stat().st_size > 32
    if dataset == "kline_1m":
        from kline_manifest import manifest_path

        target = root / "lake" / "kline_1m" / f"trade_date={day}" / f"{code}.parquet"
        meta = manifest_path(target)
        if not target.is_file():
            return False
        if not meta.is_file():
            # 旧版本/中断可能已原子写完 parquet 但没来得及写 manifest。
            # 读回校验并补 manifest，避免每次把整只 100 日重新抓一遍。
            try:
                from parquet_store import read_bars
                from kline_manifest import write_kline_manifest

                bars = read_bars(target).get("bars") or []
                if not bars:
                    return False
                write_kline_manifest(
                    target,
                    {
                        "code": code,
                        "period": "1m",
                        "adjust": "none",
                        "source": "repaired manifest from parquet",
                        "rows": len(bars),
                        "firstDate": bars[0].get("date"),
                        "lastDate": bars[-1].get("date"),
                        "complete": True,
                        "scope": "recent",
                    },
                )
                return True
            except Exception:
                return False
        try:
            payload = json.loads(meta.read_text("utf-8"))
            # 1m 是滚动窗口：文件+manifest+rows 有效就跳过。旧版本把
            # “不足 100 日/服务端只有 92 日”写成 complete=false，导致每次重下。
            return int(payload.get("rows") or 0) > 0
        except (OSError, ValueError):
            return False
    if dataset == "auction":
        # 规划阶段不能对 5,600 个 gz 逐个解压校验，否则「生成下载计划」要几分钟。
        # manifest + 文件存在 + rows/code/date 一致就跳过；深度 SHA 交给完整性审计。
        directory = root / "lake" / "auction" / f"trade_date={day}"
        data = directory / f"{code}.jsonl.gz"
        meta = directory / f"{code}.manifest.json"
        if not data.is_file() or data.stat().st_size <= 0 or not meta.is_file():
            return False
        try:
            payload = json.loads(meta.read_text("utf-8"))
            return (
                int(payload.get("rows") or 0) > 0
                and payload.get("code") == code
                and payload.get("tradeDate") == day
            )
        except (OSError, ValueError):
            return False
    if dataset == "money_flow":
        # 旧 flow manifest 没有 rows，但 bytes/sha 是 parquet 文件的。
        # 只做 stat + manifest 元数据，避免 5,600 次 DuckDB 打开。
        directory = root / "lake" / "money_flow" / f"trade_date={day}"
        data = directory / f"{code}.parquet"
        meta = directory / f"{code}.manifest.json"
        if not data.is_file() or data.stat().st_size <= 0 or not meta.is_file():
            return False
        try:
            payload = json.loads(meta.read_text("utf-8"))
            expected = int(payload.get("bytes") or 0)
            return (
                payload.get("code") == code
                and str(payload.get("tradeDate") or "")[:10] == day
                and (expected <= 0 or expected == data.stat().st_size)
            )
        except (OSError, ValueError):
            return False
    if dataset == "today_minute":
        return _data_and_manifest(root / "lake" / "today_minute" / f"trade_date={day}" / f"{code}.jsonl.gz")
    if dataset == "minute_aux":
        return _data_and_manifest(
            root / "lake" / "minute_aux" / f"trade_date={day}" / f"{code}_{task['kind']}.jsonl.gz"
        )
    if dataset == "sparkline":
        return _data_and_manifest(root / "lake" / "sparkline" / f"trade_date={day}" / f"{code}_s{task['selector']}.jsonl.gz")
    if dataset == "volume_profile":
        return _data_and_manifest(root / "lake" / "volume_profile" / f"trade_date={day}" / f"{code}.jsonl.gz")
    if dataset == "top_board":
        return _data_and_manifest(
            root
            / "lake"
            / "top_board"
            / f"trade_date={day}"
            / f"c{task['category']}_s{task.get('size', 20)}.jsonl.gz"
        )
    if dataset == "auction":
        return _data_and_manifest(
            root / "lake" / "auction" / f"trade_date={day}" / f"{code}.jsonl.gz"
        )
    if dataset == "ticks":
        return _data_and_manifest(
            root / "lake" / "ticks" / f"trade_date={day}" / f"{code}.parquet"
        )
    if dataset == "history_minute":
        return _data_and_manifest(
            root / "lake" / "history_minute" / f"trade_date={day}" / f"{code}.jsonl.gz"
        )
    if dataset == "money_flow":
        return _data_and_manifest(
            root / "lake" / "money_flow" / f"trade_date={day}" / f"{code}.parquet"
        )
    if dataset == "delisted":
        return _data_and_manifest(root / "lake" / "delisted" / f"{code}.parquet")
    if dataset == "f10":
        # 只有整只代码的所选分区全部成功才写完成标记；缺分区就下次重试，
        # 避免「3 个核心表存在 → 整只跳过 → 永远缺其他分区」。
        marker = (
            root
            / "lake"
            / "f10_pit"
            / f"snapshot_date={day}"
            / "_complete"
            / f"{code}.json"
        )
        return _path_exists(marker)
    if dataset == "gbbq":
        return _dataset_archive_valid(root / "lake" / "gbbq" / "trade_date=all")
    if dataset == "limit_ladder":
        return _dataset_archive_valid(
            root / "lake" / "limit_ladder" / f"trade_date={day}"
        )
    if dataset == "finance_history":
        # count 期内每一期都必须是有效归档；只查最新一期会让 count>1 的历史
        # 回补永远跳过，也会掩盖首轮中途失败的旧季缺口。
        today = _shanghai_now().date()
        wanted = max(1, int(task.get("count") or 1))
        quarters: list[str] = []
        for year in range(today.year, today.year - 80, -1):
            for month, day in ((12, 31), (9, 30), (6, 30), (3, 31)):
                text = f"{year:04d}-{month:02d}-{day:02d}"
                if text <= today.isoformat():
                    quarters.append(text)
                if len(quarters) >= wanted:
                    break
            if len(quarters) >= wanted:
                break
        if not quarters:
            return False
        return all(
            _dataset_archive_valid(
                root / "lake" / "finance_history" / f"trade_date={quarter}"
            )
            for quarter in quarters
        )
    if dataset in {"finance", "capital", "category", "block_meta", "special_limits", "unusual", "blocks"}:
        return _dataset_archive_valid(
            root / "lake" / _bulk_root(dataset) / f"trade_date={day}"
        )
    # server_files 没有按日 manifest，靠任务结果/文件判断
    if dataset == "server_files":
        return _path_exists(root / "raw" / "tdx" / "zhb.zip")
    return False


def _bulk_root(dataset: str) -> str:
    return {
        "finance": "finance",
        "capital": "corporate",
        "category": "category_quotes",
        "block_meta": "server_meta",
        "special_limits": "special_limits",
    }.get(dataset, dataset)


def build_plan(
    options: dict[str, Any],
    codes: list[str],
    root: Path,
    now: datetime | None = None,
) -> dict[str, Any]:
    """把「数据集 × 代码 × 周期/日期」展开成可分发任务。"""
    current = now or _shanghai_now()
    today = current.strftime("%Y-%m-%d")
    dates = options["dates"] or [today]
    selected = set(options["datasets"])
    tasks: list[dict[str, Any]] = []
    skipped = 0

    def add(task: dict[str, Any]) -> None:
        nonlocal skipped
        if options["skipExisting"] and _already_archived(task, root):
            skipped += 1
            return
        tasks.append(task)

    if "kline" in selected:
        # 日 K 走全历史；1 分钟 K 独立成 kline_1m（只取最近 20 交易日）。
        for period in [item for item in options["periods"] if item == "day"] or ["day"]:
            for code in codes:
                add(
                    {
                        "dataset": "kline",
                        "code": code,
                        "period": period,
                        "adjust": options["adjust"],
                        "source": options["source"],
                    }
                )
    if "kline_1m" in selected:
        for code in codes:
            add(
                {
                    "dataset": "kline_1m",
                    "code": code,
                    "days": 100,
                    "adjust": options["adjust"],
                }
            )
    for dataset in ("today_minute", "money_flow"):
        if dataset in selected:
            for code in codes:
                add(
                    {
                        "dataset": dataset,
                        "code": code,
                        "source": options["source"],
                    }
                )
    if "minute_aux" in selected:
        for code in codes:
            for kind in options["minuteAuxKinds"]:
                add({"dataset": "minute_aux", "code": code, "kind": kind})
    if "sparkline" in selected:
        for code in codes:
            add({"dataset": "sparkline", "code": code, "selector": 1})
    if "volume_profile" in selected:
        for code in codes:
            add({"dataset": "volume_profile", "code": code})
    if "limit_ladder" in selected:
        add({"dataset": "limit_ladder"})
    if "top_board" in selected:
        for category, _sort in CATEGORY_PAIRS:
            add({"dataset": "top_board", "category": category, "size": 20})
    for dataset in ("auction", "history_minute"):
        if dataset in selected:
            for day in dates:
                for code in codes:
                    add({"dataset": dataset, "code": code, "date": day})
    if "ticks" in selected:
        # 逐笔默认最近 20 个交易日；显式 --dates 时尊重用户日期。
        tick_dates = dates if options["dates"] else recent_trading_days(20, root)
        # 逐笔是 20×N 个任务；逐个读 manifest 会让计划阶段扫十几万次 JSON。
        # 规划只按“当天目录下已有 parquet”预加载，深度校验交给完整性审计。
        tick_existing: set[tuple[str, str]] = set()
        if options["skipExisting"]:
            for day in tick_dates:
                directory = root / "lake" / "ticks" / f"trade_date={day}"
                if not directory.is_dir():
                    continue
                for path in directory.glob("*.parquet"):
                    try:
                        if path.stat().st_size > 0:
                            tick_existing.add((day, path.stem))
                    except OSError:
                        continue
        for day in tick_dates:
            for code in codes:
                if options["skipExisting"] and (
                    (day, code) in tick_existing
                    or _has_nodata_marker(
                        root, {"dataset": "ticks", "code": code, "date": day}
                    )
                ):
                    skipped += 1
                    continue
                tasks.append({"dataset": "ticks", "code": code, "date": day})
    if "f10" in selected:
        for code in codes:
            add({"dataset": "f10", "code": code, "sections": options["f10Sections"]})
    if "delisted" in selected:
        for code in options["delistedCodes"]:
            add({"dataset": "delisted", "code": code})

    if "finance" in selected:
        for start in range(0, len(codes), 80):
            add({"dataset": "finance", "codes": codes[start : start + 80]})
    if "capital" in selected:
        for start in range(0, len(codes), 75):
            add({"dataset": "capital", "codes": codes[start : start + 75]})
    if "category" in selected:
        for category, sort_type in CATEGORY_PAIRS:
            add({"dataset": "category", "category": category, "sortType": sort_type})
    if "block_meta" in selected:
        for filename in BLOCK_META_FILES:
            add({"dataset": "block_meta", "filename": filename})
    if "special_limits" in selected:
        add({"dataset": "special_limits"})
    if "blocks" in selected:
        add({"dataset": "blocks"})
    if "gbbq" in selected:
        add({"dataset": "gbbq"})
    if "finance_history" in selected:
        add(
            {
                "dataset": "finance_history",
                "count": options.get("financeHistoryCount", 1),
            }
        )
    if "unusual" in selected:
        add({"dataset": "unusual"})
    if "server_files" in selected:
        add({"dataset": "server_files"})

    for task in tasks:
        task["key"] = _task_key(task)
    return {
        "tasks": tasks,
        "skipped": skipped,
        "codes": len(codes),
        "dates": dates,
        "plannedAt": current.isoformat(timespec="seconds"),
    }


def shard_tasks(tasks: list[dict[str, Any]], shards: int) -> list[list[dict[str, Any]]]:
    """按权重贪心分片：F10/逐笔这类重任务分散到不同进程，避免长尾。"""
    count = max(1, int(shards))
    buckets: list[list[dict[str, Any]]] = [[] for _ in range(count)]
    loads = [0] * count
    ordered = sorted(
        tasks,
        key=lambda task: DATASETS.get(task["dataset"], {}).get("weight", 1),
        reverse=True,
    )
    for task in ordered:
        target = min(range(count), key=lambda index: loads[index])
        buckets[target].append(task)
        loads[target] += int(DATASETS.get(task["dataset"], {}).get("weight", 1))
    return buckets


# ---------------------------------------------------------------- 任务执行


def _rows_of(value: Any) -> list[dict]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        for field in ("rows", "records", "blocks", "points", "tables"):
            nested = value.get(field)
            if isinstance(nested, list):
                return [row for row in nested if isinstance(row, dict)]
    return []


def run_task(bridge: Any, task: dict[str, Any]) -> dict[str, Any]:
    """执行一个任务。返回 {rows, files, complete?, bulk?}。

    `bulk` 里的行由 worker 落 parts，父进程在任务结束后合并成数据集归档。
    """
    dataset = task["dataset"]
    if dataset == "kline":
        source = str(task.get("source") or "auto")
        period = str(task.get("period") or "day")
        adjust = str(task.get("adjust") or "none")
        if source in ("auto", "file") and period == "day" and adjust == "none":
            try:
                file_result = bridge.day_file_archive_save(task["code"])
                return {
                    "rows": int(file_result.get("rows") or 0),
                    "files": 1,
                    "complete": True,
                    "pages": 0,
                    "source": "0x06b9-file",
                    "chunks": file_result.get("chunks", 0),
                }
            except Exception:
                if source == "file":
                    raise
                # 文件服务不可用时回退到原 MAC/7709 分页路径
        result = None
        if source in ("mac", "auto"):
            try:
                result = bridge.mac_full_kline(
                    task["code"], task["period"], task["adjust"]
                )
            except Exception:
                if source == "mac":
                    raise
        if result is None:
            result = bridge.full_kline(task["code"], task["period"], task["adjust"])
        return {
            "rows": len(result.get("bars") or []),
            "files": 1,
            "complete": bool(result.get("complete")),
            "pages": result.get("pages", 0),
            "source": result.get("source", "7709"),
        }
    if dataset == "kline_1m":
        result = bridge.kline_1m_archive_save(
            task["code"], int(task.get("days") or 20), task.get("adjust", "none")
        )
        return {
            "rows": int(result.get("rows") or 0),
            "files": 1,
            "complete": bool(result.get("complete")),
            "days": result.get("daysAvailable", 0),
        }
    if dataset == "today_minute":
        source = str(task.get("source") or "auto")
        if source in ("mac", "auto"):
            try:
                result = bridge.mac_minute_archive_save(task["code"])
                return {
                    "rows": int(result.get("rows") or 0),
                    "files": 1,
                    "source": "mac",
                }
            except Exception:
                if source == "mac":
                    raise
        result = bridge.minute_archive_save(task["code"])
        return {"rows": int(result.get("rows") or 0), "files": 1, "source": "7709"}
    if dataset == "minute_aux":
        result = bridge.minute_aux_archive_save(task["code"], task["kind"])
        return {"rows": len(result.get("points") or []), "files": 1}
    if dataset == "sparkline":
        result = bridge.sparkline_archive_save(task["code"], int(task.get("selector", 1)))
        return {"rows": len(result.get("prices") or []), "files": 1}
    if dataset == "volume_profile":
        result = bridge.volume_profile_archive_save(task["code"])
        return {"rows": int(result.get("rows") or 0), "files": 1}
    if dataset == "top_board":
        result = bridge.top_board_archive_save(
            int(task["category"]), int(task.get("size", 20))
        )
        return {"rows": int(result.get("rows") or 0), "files": 1}
    if dataset == "unusual":
        rows = bridge.unusual(600)
        return {"rows": len(rows), "files": 0, "bulk": rows}
    if dataset == "auction":
        result = bridge.auction_archive_save(task["code"], task["date"])
        return {"rows": int(result.get("rows") or 0), "files": 1}
    if dataset == "ticks":
        result = bridge.tick_archive_save(task["code"], task["date"])
        return {"rows": int(result.get("rows") or 0), "files": 1}
    if dataset == "history_minute":
        result = bridge.history_minute_archive_save(task["code"], task["date"])
        return {"rows": len(result.get("points") or []), "files": 1}
    if dataset == "money_flow":
        # 0x0ffc 走资金流专用节点，能拿到 5 个交易日的分档，成功即自动写
        # lake/money_flow；节点不给金额时退回 MAC 0x1218。
        try:
            records = bridge.money_flow(task["code"])
            return {"rows": len(records or []), "files": 1}
        except Exception:  # noqa: BLE001 - 让 MAC 通道兜底
            result = bridge.mac_money_flow(task["code"])
            return {
                "rows": len(result.get("days") or result.get("records") or []),
                "files": 1,
                "fallback": "mac",
            }
    if dataset == "f10":
        result = _run_f10(bridge, task["code"], task.get("sections", "core"))
        if result.get("partial"):
            raise RuntimeError(
                "F10 分区未全部成功：" + "；".join(result.get("failures") or [])[:400]
            )
        marker = (
            data_dir()
            / "lake"
            / "f10_pit"
            / f"snapshot_date={_today()}"
            / "_complete"
            / f"{task['code']}.json"
        )
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(
            json.dumps(
                {
                    "code": task["code"],
                    "sections": task.get("sections", "core"),
                    "requests": result.get("requests", 0),
                    "finishedAt": _shanghai_now().isoformat(timespec="seconds"),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return result
    if dataset == "delisted":
        result = bridge.delisted_archive_save(task["code"])
        archive = result.get("archive") or {}
        return {"rows": int(result.get("count") or archive.get("rows") or 0), "files": 1}
    if dataset == "finance":
        rows = bridge.finance_snapshot(list(task["codes"]))
        return {"rows": len(rows), "files": 0, "bulk": rows}
    if dataset == "capital":
        result = bridge.capital_changes(list(task["codes"]))
        rows = result.get("records") or []
        return {"rows": len(rows), "files": 0, "bulk": rows}
    if dataset == "category":
        rows = bridge.category_snapshot(int(task["category"]), int(task["sortType"]))
        for row in rows:
            row.setdefault("category", task["category"])
            row.setdefault("sortType", task["sortType"])
        return {"rows": len(rows), "files": 0, "bulk": rows}
    if dataset == "block_meta":
        meta = bridge.block_meta(task["filename"])
        return {"rows": 1, "files": 0, "bulk": [meta]}
    if dataset == "special_limits":
        scan = bridge.scan_special_limits(10000)
        rows = scan.get("records") or []
        return {"rows": len(rows), "files": 0, "bulk": rows}
    if dataset == "limit_ladder":
        result = bridge.f10_limit_board_archive_save()
        return {"rows": int(result.get("rows") or 0), "files": 1}
    if dataset == "gbbq":
        result = bridge.gbbq_archive_save()
        return {"rows": int(result.get("rows") or 0), "files": 1}
    if dataset == "finance_history":
        entries = bridge.finance_history_catalog()
        today_key = _today().replace("-", "")
        usable = []
        for entry in entries:
            digits = re.findall(r"(\d{8})", str(entry.get("filename") or ""))
            if not digits or digits[0] > today_key:
                continue  # 未来报告期只有占位空包
            if int(entry.get("size") or 0) < 1024:
                continue  # 200 字节左右的空表
            usable.append(entry)
        wanted = max(1, int(task.get("count", 1)))
        rows = 0
        files = 0
        dates: list[str] = []
        for entry in usable[:wanted]:
            result = bridge.finance_history_archive_save(entry["filename"])
            rows += int(result.get("rows") or 0)
            files += 1
            dates.append(str(result.get("reportDate") or ""))
        return {"rows": rows, "files": files, "reportDates": dates}
    if dataset == "blocks":
        rows: list[dict] = []
        for kind in ("gn", "fg", "zs", "general"):
            data = bridge.blocks(kind)
            for board in data.get("blocks") or []:
                for code in board.get("codes") or []:
                    rows.append(
                        {
                            "kind": kind,
                            "boardId": board.get("id"),
                            "board": board.get("name"),
                            "indexCode": board.get("indexCode", ""),
                            "code": code,
                            "name": (board.get("names") or {}).get(code, ""),
                        }
                    )
        industries = bridge.industries()
        for kind, blocks in (
            ("tdx_industry", industries.get("blocks") or []),
            ("rs_industry", industries.get("rsBlocks") or []),
        ):
            for board in blocks:
                for code in board.get("codes") or []:
                    rows.append(
                        {
                            "kind": kind,
                            "boardId": board.get("id"),
                            "board": board.get("name"),
                            "indexCode": board.get("indexCode", ""),
                            "code": code,
                            "name": (board.get("names") or {}).get(code, ""),
                        }
                    )
        for item in (industries.get("sectorIndices") or []):
            rows.append(
                {
                    "kind": "sector_index",
                    "boardId": "",
                    "board": item.get("name", ""),
                    "indexCode": item.get("tdxCode", ""),
                    "code": item.get("code", ""),
                    "name": item.get("name", ""),
                }
            )
        return {"rows": len(rows), "files": 0, "bulk": rows}
    if dataset == "server_files":
        result = bridge.server_catalog()
        return {"rows": int(result.get("count") or 0), "files": 1}
    raise ValueError(f"未知数据集：{dataset}")


def _run_f10(bridge: Any, code: str, sections: str) -> dict[str, Any]:
    selected = F10_FULL_SECTIONS if sections == "full" else F10_CORE_SECTIONS
    requests = 0
    failures: list[str] = []
    for name in selected:
        try:
            if name == "statement_zcfzb":
                bridge.f10_statement(code, "zcfzb", True)
            elif name == "statement_lyb":
                bridge.f10_statement(code, "lyb", True)
            elif name == "statement_xjllb":
                bridge.f10_statement(code, "xjllb", True)
            elif name == "trading_margin":
                bridge.f10_trading(code, "margin")
            elif name == "capital_structure":
                bridge.f10_capital(code, "structure")
            elif name.startswith("digest_"):
                bridge.f10_digest(code, name.split("_", 1)[1])
            elif name == "announcements":
                bridge.f10_announcements(code)
            else:
                method = getattr(bridge, f"f10_{name}")
                method(code)
            requests += 1
        except Exception as error:  # noqa: BLE001 - 单分区失败不影响其它分区
            failures.append(f"{name}: {error}")
    if requests == 0 and failures:
        raise RuntimeError("；".join(failures[:3]))
    return {
        "rows": 0,
        "files": requests,
        "requests": requests,
        "failures": failures,
        # F10 各分区独立落盘，部分失败仍算完成，但要把失败原因带回父进程
        "partial": bool(failures),
    }


# ---------------------------------------------------------------- worker


class WorkerError(RuntimeError):
    pass


def _worker_servers(servers: list[str]) -> list[str]:
    return [str(item) for item in servers if str(item).strip()] or [""]


def _pid_alive(pid: int) -> bool:
    """worker 看父 sidecar 是否还活着；父进程被杀时 worker 不能变孤儿。

    注意：Windows 上绝不能写 `os.kill(pid, 0)`。Python 把 0 当成
    CTRL_C_EVENT，会向整个进程组发 Ctrl+C，父 sidecar 和所有 worker
    会一起 KeyboardInterrupt——18:27 的任务就是这么被瞬间打断的。
    """
    if pid <= 0:
        return True
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.OpenProcess(0x00100000, False, int(pid))  # SYNCHRONIZE
        if not handle:
            # ERROR_ACCESS_DENIED 说明进程还在；其余按已退出处理。
            return kernel32.GetLastError() == 5
        try:
            return kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _append_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def _append_part(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "at", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def run_worker(spec_path: str | Path) -> dict[str, Any]:
    """worker 入口：读任务分片、开线程、写进度，最后写 summary。"""
    from tdx_bridge import Bridge

    path = Path(spec_path).resolve()
    spec = json.loads(path.read_text("utf-8"))
    job_dir = Path(spec["jobDir"]).resolve()
    index = int(spec.get("index", 0))
    threads = max(1, int(spec.get("threads", 1)))
    parent_pid = int(spec.get("parentPid") or 0)
    tasks: list[dict[str, Any]] = list(spec.get("tasks") or [])
    servers = _worker_servers(list(spec.get("servers") or []))
    codes_file = Path(spec["codesFile"]).resolve() if spec.get("codesFile") else None
    index_items: list[dict] = []
    if codes_file and codes_file.is_file():
        try:
            index_items = json.loads(codes_file.read_text("utf-8"))
        except (OSError, ValueError):
            index_items = []

    task_queue: queue.Queue[dict[str, Any]] = queue.Queue()
    for task in tasks:
        task_queue.put(task)
    lock = threading.Lock()
    progress = {
        "schema": PROGRESS_SCHEMA,
        "index": index,
        "pid": os.getpid(),
        "state": "running",
        "total": len(tasks),
        "done": 0,
        "skipped": 0,
        "failed": 0,
        "rows": 0,
        "current": "",
        "datasets": {},
        "servers": servers,
        "updatedAt": _shanghai_now().isoformat(timespec="seconds"),
    }
    paused = threading.Event()
    cancelled = threading.Event()
    progress_path = job_dir / "progress" / f"worker-{index:03d}.json"
    cancel_file = job_dir / "cancel.flag"
    pause_file = job_dir / "pause.flag"

    def bump(task: dict[str, Any] | None, status: str, rows: int = 0) -> None:
        with lock:
            if status == "ok":
                progress["done"] += 1
            elif status == "skipped":
                progress["skipped"] += 1
            elif status == "failed":
                progress["failed"] += 1
            if rows:
                progress["rows"] += int(rows)
            if task is not None:
                bucket = progress["datasets"].setdefault(
                    task["dataset"], {"done": 0, "skipped": 0, "failed": 0, "rows": 0}
                )
                bucket_key = "done" if status == "ok" else status
                bucket[bucket_key] = int(bucket.get(bucket_key, 0)) + 1
                bucket["rows"] = int(bucket.get("rows", 0)) + int(rows or 0)
            progress["updatedAt"] = _shanghai_now().isoformat(timespec="seconds")

    def flush() -> None:
        with lock:
            _write_json_atomic(progress_path, dict(progress))

    def loop(thread_index: int) -> None:
        result_path = job_dir / "results" / f"worker-{index:03d}-{thread_index:02d}.jsonl"
        bridge = None
        host = servers[thread_index % len(servers)]
        try:
            while not cancelled.is_set() and not paused.is_set():
                if parent_pid and not _pid_alive(parent_pid):
                    # 父 sidecar 被杀/应用直接退出时，不能留下 48 个下载器
                    # 继续吃 CPU；下次启动时它们也不会再被父进程回收。
                    cancelled.set()
                    break
                if cancel_file.exists():
                    cancelled.set()
                    break
                if pause_file.exists():
                    paused.set()
                    break
                if spec.get("enforceWindow") and _window_closed_now():
                    paused.set()
                    break
                try:
                    task = task_queue.get_nowait()
                except queue.Empty:
                    break
                with lock:
                    progress["current"] = str(task.get("key") or task.get("dataset"))
                started = time.time()
                outcome: dict[str, Any] = {"task": task, "status": "ok", "rows": 0}
                try:
                    if bridge is None:
                        bridge = Bridge(host=host, index_items=index_items)
                    result = _execute_with_retry(bridge, task, int(spec.get("retries", 1)))
                    outcome.update(result)
                    outcome["status"] = "ok"
                except Exception as error:  # noqa: BLE001 - 逐任务记录失败，不中断分片
                    outcome = {
                        "task": task,
                        "status": "failed",
                        "rows": 0,
                        "error": f"{type(error).__name__}: {error}"[:500],
                    }
                    if bridge is not None:
                        try:
                            bridge.close()
                        except Exception:
                            pass
                        bridge = None
                outcome["seconds"] = round(time.time() - started, 3)
                # bulk 行只写 parts，不能同时塞进 results（category/涨跌停表会重复占盘）。
                bulk = outcome.pop("bulk", None)
                _append_jsonl(result_path, outcome)
                if outcome.get("status") == "failed":
                    _append_jsonl(
                        job_dir / "failures" / f"worker-{index:03d}.jsonl", outcome
                    )
                if bulk:
                    _append_part(
                        job_dir / "parts" / task["dataset"] / f"worker-{index:03d}-{thread_index:02d}.jsonl.gz",
                        {"key": task.get("key"), "rows": bulk},
                    )
                bump(task, str(outcome.get("status") or "ok"), int(outcome.get("rows") or 0))
                task_queue.task_done()
        except Exception as error:  # noqa: BLE001
            with lock:
                progress["state"] = "error"
                progress["error"] = f"{type(error).__name__}: {error}"[:500]
            _append_jsonl(job_dir / "failures" / f"worker-{index:03d}.jsonl", {"error": str(error)})
        finally:
            if bridge is not None:
                try:
                    bridge.close()
                except Exception:
                    pass

    workers = [
        threading.Thread(target=loop, args=(item,), name=f"offline-{index}-{item}", daemon=True)
        for item in range(threads)
    ]
    for worker in workers:
        worker.start()
    last_flush = 0.0
    while any(worker.is_alive() for worker in workers):
        time.sleep(0.5)
        if time.time() - last_flush >= 1.5:
            flush()
            last_flush = time.time()
    for worker in workers:
        worker.join(timeout=2)
    with lock:
        progress["state"] = "paused" if paused.is_set() else ("cancelled" if cancelled.is_set() else "finished")
        progress["current"] = ""
        progress["updatedAt"] = _shanghai_now().isoformat(timespec="seconds")
        snapshot = dict(progress)
    _write_json_atomic(progress_path, snapshot)
    _write_json_atomic(
        job_dir / "progress" / f"worker-{index:03d}-summary.json",
        {
            "index": index,
            "pid": os.getpid(),
            "state": snapshot["state"],
            "total": snapshot["total"],
            "done": snapshot["done"],
            "skipped": snapshot["skipped"],
            "failed": snapshot["failed"],
            "rows": snapshot["rows"],
            "datasets": snapshot["datasets"],
        },
    )
    return snapshot


_WINDOW_CACHE: dict[str, Any] = {"at": 0.0, "open": True}


def _window_closed_now() -> bool:
    """worker 内的时间窗口判断；30 秒缓存，节假日表也生效。

    只按周末判断会让节假日「manager 允许启动、worker 立刻暂停」；这里直接复用
    `offline_window`（含 trading_holidays.json），缓存 30 秒避免每个任务读文件。
    """
    now = time.monotonic()
    if now - float(_WINDOW_CACHE.get("at") or 0) > 30:
        state = offline_window(root=data_dir())
        _WINDOW_CACHE["at"] = now
        _WINDOW_CACHE["open"] = bool(state.get("open"))
    return not bool(_WINDOW_CACHE["open"])


def _execute_with_retry(bridge: Any, task: dict[str, Any], retries: int) -> dict[str, Any]:
    attempts = max(0, int(retries)) + 1
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            return run_task(bridge, task)
        except Exception as error:  # noqa: BLE001 - 重试后仍失败才上抛
            last = error
            if attempt + 1 >= attempts:
                break
            # 断线/超时后重建连接，避免同一条坏连接连续失败
            try:
                bridge.close()
            except Exception:
                pass
            time.sleep(0.2 * (attempt + 1))
    raise last if last is not None else RuntimeError("任务执行失败")


# ---------------------------------------------------------------- 父进程调度


def probe_servers(
    endpoints: list[tuple[str, int]] | None = None, timeout: float = 0.9
) -> list[dict[str, Any]]:
    """并发 TCP 拨号，返回按延迟排序的可达服务器。"""
    from tdx_bridge import active_endpoints

    hosts = endpoints or active_endpoints()[0]

    def probe(item: tuple[str, int]) -> dict[str, Any]:
        host, port = item
        started = time.perf_counter()
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return {
                    "host": host,
                    "port": port,
                    "address": f"{host}:{port}",
                    "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                    "ok": True,
                }
        except Exception as error:  # noqa: BLE001
            return {
                "host": host,
                "port": port,
                "address": f"{host}:{port}",
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                "ok": False,
                "error": str(error)[:200],
            }

    with ThreadPoolExecutor(max_workers=min(32, max(1, len(hosts)))) as pool:
        results = list(pool.map(probe, hosts))
    results.sort(key=lambda item: (not item["ok"], item["latencyMs"]))
    return results


def _worker_executable() -> str:
    """打包/便携/开发都可能改变 sys.executable；优先选真实存在的路径。"""
    candidates = [sys.executable, sys.argv[0] if sys.argv else ""]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    return sys.executable


def _worker_command(spec_path: Path) -> list[str]:
    """worker 启动命令：开发态用 Python 脚本，打包态复用 sidecar 可执行文件。"""
    executable = _worker_executable()
    if is_frozen():
        return [executable, "--offline-worker", str(spec_path)]
    return [executable, str(Path(__file__).resolve()), "--worker", str(spec_path)]


def is_frozen() -> bool:
    if getattr(sys, "frozen", False):
        return True
    if "__compiled__" in globals():
        return True
    name = Path(sys.executable).name.lower()
    return name.startswith(("tdx-bridge", "tdx_bridge"))


class OfflineSyncManager:
    """运行在 sidecar 内的同步任务管理器；同一时刻只允许一个任务。"""

    def __init__(
        self,
        root: Path | None = None,
        bridge_factory: Callable[[], Any] | None = None,
        popen_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.root = Path(root) if root else data_dir() / "lake" / "offline_sync"
        self.root.mkdir(parents=True, exist_ok=True)
        self._bridge_factory = bridge_factory
        self._popen_factory = popen_factory or subprocess.Popen
        self._lock = threading.Lock()
        self._job: dict[str, Any] | None = None
        self._thread: threading.Thread | None = None
        self._processes: list[Any] = []
        self._cancel = threading.Event()

    # -- public --------------------------------------------------------

    def window(self) -> dict[str, Any]:
        return offline_window(root=data_dir())

    def start(self, raw_options: dict[str, Any] | None = None) -> dict[str, Any]:
        options = normalize_options(raw_options or {})
        job_id = str((raw_options or {}).get("jobId") or "").strip()
        if job_id and (
            job_id in {".", ".."}
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", job_id)
        ):
            raise ValueError("jobId 只允许字母/数字/._-，长度 1~64，且不能是 . 或 ..")
        if not job_id:
            job_id = "sync-" + _shanghai_now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
        job_dir = (self.root / job_id).resolve()
        if job_dir.parent != self.root.resolve():
            raise ValueError("jobId 解析后必须位于离线同步根目录下")
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise RuntimeError("已有离线同步任务在运行")
            window = self.window()
            if (
                options["enforceWindow"]
                and not window["open"]
                and not options["allowInsideWindow"]
            ):
                return {
                    "state": "blocked",
                    "reason": window["reason"],
                    "window": window,
                    "options": options,
                }
            job_dir.mkdir(parents=True, exist_ok=True)
            self._cancel.clear()
            self._job = {
                "jobId": job_id,
                "dir": job_dir,
                "options": options,
                "state": "planning",
                "startedAt": _shanghai_now().isoformat(timespec="seconds"),
                "window": window,
                "error": "",
                "manifest": None,
            }
            _write_json_atomic(
                job_dir / "job.json",
                {
                    "schema": JOB_SCHEMA,
                    "jobId": job_id,
                    "options": options,
                    "createdAt": self._job["startedAt"],
                    "window": window,
                    "dataDir": str(data_dir().resolve()),
                },
            )
            self._thread = threading.Thread(
                target=self._run, args=(self._job,), name=f"offline-sync-{job_id}", daemon=True
            )
            self._thread.start()
        return self.status()

    def status(self) -> dict[str, Any]:
        window = self.window()
        with self._lock:
            job = self._job
        if job is None:
            return {
                "state": "idle",
                "window": window,
                "datasets": dataset_catalog(),
                "presets": PRESETS,
                "lastSummary": latest_job_summary(self.root),
            }
        job_dir: Path = job["dir"]
        state = job["state"]
        summary: dict[str, Any] = {}
        manifest_path = job_dir / "manifest.json"
        if manifest_path.is_file():
            try:
                summary = json.loads(manifest_path.read_text("utf-8"))
            except (OSError, ValueError):
                summary = {}
        progress_files = sorted((job_dir / "progress").glob("worker-*-summary.json"))
        live = sorted((job_dir / "progress").glob("worker-[0-9][0-9][0-9].json"))
        totals = {"total": 0, "done": 0, "skipped": 0, "failed": 0, "rows": 0}
        datasets: dict[str, dict[str, int]] = {}
        workers: list[dict[str, Any]] = []
        for path in live:
            try:
                payload = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            for key in totals:
                totals[key] += int(payload.get(key) or 0)
            for name, bucket in (payload.get("datasets") or {}).items():
                target = datasets.setdefault(name, {"done": 0, "skipped": 0, "failed": 0, "rows": 0})
                for key in target:
                    target[key] += int(bucket.get(key) or 0)
            workers.append(
                {
                    "index": payload.get("index"),
                    "pid": payload.get("pid"),
                    "state": payload.get("state"),
                    "total": payload.get("total"),
                    "done": payload.get("done"),
                    "failed": payload.get("failed"),
                    "current": payload.get("current"),
                    "updatedAt": payload.get("updatedAt"),
                }
            )
        failures: list[dict] = []
        for path in sorted((job_dir / "failures").glob("*.jsonl")):
            try:
                for line in path.read_text("utf-8").splitlines():
                    if line.strip():
                        failures.append(json.loads(line))
            except (OSError, ValueError):
                continue
        elapsed = 0.0
        if job.get("startedAt"):
            try:
                started = datetime.fromisoformat(str(job["startedAt"]))
                finished = job.get("finishedAt")
                end = datetime.fromisoformat(str(finished)) if finished else _shanghai_now()
                elapsed = max(0.0, (end - started).total_seconds())
            except ValueError:
                elapsed = 0.0
        throughput = (totals["done"] + totals["skipped"]) / elapsed if elapsed > 0 else 0.0
        remaining = max(0, totals["total"] - totals["done"] - totals["skipped"] - totals["failed"])
        return {
            "jobId": job["jobId"],
            "dir": str(job_dir),
            "state": state,
            "error": job.get("error") or "",
            "window": window,
            "options": job["options"],
            "startedAt": job.get("startedAt"),
            "finishedAt": job.get("finishedAt"),
            "elapsedSeconds": round(elapsed, 1),
            "totals": totals,
            "datasets": datasets,
            "workers": workers,
            "failures": failures[-MAX_TASKS_REPORTED_FAILURES:],
            "throughputPerSecond": round(throughput, 2),
            "etaSeconds": round(remaining / throughput, 1) if throughput > 0.01 else None,
            "summary": summary or None,
            "lastSummary": summarize_job_dir(job_dir) if summary else None,
            "catalog": dataset_catalog(),
            "presets": PRESETS,
        }

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            job = self._job
        if job is None:
            return {"state": "idle"}
        try:
            (Path(job["dir"]) / "cancel.flag").write_text("1", "utf-8")
        except OSError:
            pass
        self._cancel.set()
        for process in list(self._processes):
            try:
                if process.poll() is None:
                    process.terminate()
            except Exception:  # noqa: BLE001
                pass
        return self.status()

    def wait(self, timeout: float | None = None) -> dict[str, Any]:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
        return self.status()

    # -- internals -----------------------------------------------------

    def _bridge(self) -> Any:
        if self._bridge_factory is not None:
            return self._bridge_factory()
        from tdx_bridge import Bridge

        return Bridge()

    def _run(self, job: dict[str, Any]) -> None:
        job_dir: Path = job["dir"]
        options = job["options"]
        try:
            job["state"] = "probing"
            from tdx_bridge import active_endpoints

            endpoints = active_endpoints()[0]
            probes = probe_servers(endpoints)
            servers = [item["host"] for item in probes if item["ok"]]
            if not servers:
                raise RuntimeError("所有行情主站都不可达，无法开始离线同步")
            # 至少留出 processes*threads 个槽位；服务器不够就循环复用
            job["servers"] = servers
            job["probes"] = probes
            _write_json_atomic(
                job_dir / "servers.json",
                {"endpoints": len(endpoints), "reachable": len(servers), "probes": probes},
            )

            job["state"] = "planning"
            bridge = self._bridge()
            try:
                catalog = bridge.code_list()
            finally:
                try:
                    bridge.close()
                except Exception:
                    pass
            codes = resolve_codes(_CodeListProxy(catalog), options)
            if not codes:
                raise RuntimeError("没有解析到任何 A 股代码")
            (job_dir / "codes.json").write_text(
                json.dumps(catalog, ensure_ascii=False), encoding="utf-8"
            )
            plan = build_plan(options, codes, data_dir())
            tasks = plan["tasks"]
            if not tasks:
                job["state"] = "completed"
                job["finishedAt"] = _shanghai_now().isoformat(timespec="seconds")
                manifest = {
                    "schema": JOB_SCHEMA,
                    "jobId": job["jobId"],
                    "state": "completed",
                    "options": options,
                    "codes": len(codes),
                    "planned": 0,
                    "skippedExisting": plan["skipped"],
                    "totals": {"total": 0, "done": 0, "skipped": 0, "failed": 0, "rows": 0},
                    "datasets": {},
                    "servers": servers,
                    "note": "全部任务在计划阶段就判定为已归档（skipExisting）",
                    "finishedAt": job["finishedAt"],
                }
                _write_json_atomic(job_dir / "manifest.json", manifest)
                job["manifest"] = manifest
                return

            shards = shard_tasks(tasks, options["processes"])
            (job_dir / "shards").mkdir(parents=True, exist_ok=True)
            for index, shard in enumerate(shards):
                _write_json_atomic(
                    job_dir / "shards" / f"shard-{index:03d}.json",
                    {"index": index, "tasks": shard},
                )
            dataset_counts: dict[str, int] = {}
            for task in tasks:
                dataset_counts[task["dataset"]] = dataset_counts.get(task["dataset"], 0) + 1
            _write_json_atomic(
                job_dir / "plan.json",
                {
                    "plannedAt": plan["plannedAt"],
                    "tradeDate": _today(),
                    "codes": len(codes),
                    "dates": plan["dates"],
                    "tasks": len(tasks),
                    "skippedExisting": plan["skipped"],
                    "datasets": dataset_counts,
                    "processes": len(shards),
                    "threads": options["threads"],
                    "servers": servers,
                },
            )

            job["state"] = "running"
            specs: list[Path] = []
            log_dir = job_dir / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            for index, shard in enumerate(shards):
                if not shard:
                    continue
                spec_path = job_dir / "shards" / f"worker-{index:03d}.json"
                _write_json_atomic(
                    spec_path,
                    {
                        "jobId": job["jobId"],
                        "jobDir": str(job_dir),
                        "index": index,
                        "threads": options["threads"],
                        "tasks": shard,
                        # 一个进程钉一台服务器：线程共享该连接池，避免所有进程
                        # 都挤在前几台主机上。
                        "servers": [servers[index % len(servers)]],
                        "codesFile": str(job_dir / "codes.json"),
                        "retries": options["retries"],
                        "enforceWindow": options["enforceWindow"],
                        "parentPid": os.getpid(),
                    },
                )
                specs.append(spec_path)
            for spec_path in specs:
                index = int(json.loads(spec_path.read_text("utf-8"))["index"])
                log_path = log_dir / f"worker-{index:03d}.log"
                log_handle = log_path.open("w", encoding="utf-8")
                try:
                    process = self._popen_factory(
                        _worker_command(spec_path),
                        # cwd 必须是确定存在的目录；Nuitka onefile 下 __file__
                        # 可能指向构建机路径，不能拿来当 cwd。
                        cwd=str(job_dir),
                        stdout=log_handle,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                    )
                except Exception as error:  # noqa: BLE001
                    log_handle.write(f"[spawn] {error}\n")
                    log_handle.close()
                    raise
                process._dsh_log_handle = log_handle  # type: ignore[attr-defined]
                self._processes.append(process)

            paused = False
            while True:
                if self._cancel.is_set() or (job_dir / "cancel.flag").exists():
                    break
                running = [process for process in self._processes if process.poll() is None]
                if not running:
                    break
                if options["enforceWindow"] and _window_closed_now():
                    paused = True
                    (job_dir / "pause.flag").write_text("1", "utf-8")
                    break
                time.sleep(0.5)
            if paused:
                deadline = time.time() + 30
                while time.time() < deadline and any(
                    process.poll() is None for process in self._processes
                ):
                    time.sleep(0.3)
                for process in self._processes:
                    if process.poll() is None:
                        try:
                            process.terminate()
                        except Exception:  # noqa: BLE001
                            pass
            returncodes: list[int | None] = []
            for process in self._processes:
                try:
                    process.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    try:
                        process.kill()
                    except Exception:
                        pass
                returncodes.append(process.returncode)
                handle = getattr(process, "_dsh_log_handle", None)
                if handle is not None:
                    try:
                        handle.close()
                    except Exception:
                        pass
            self._processes = []

            cancelled = self._cancel.is_set() or (job_dir / "cancel.flag").exists()
            state = "paused" if paused else ("cancelled" if cancelled else "completed")
            bulk_summary = self._finalize_bulk(
                job_dir, options, allow=(state == "completed")
            )
            summary = self._aggregate(job_dir)
            failures = summary["failed"]
            worker_error = False
            for path in (job_dir / "progress").glob("worker-*-summary.json"):
                try:
                    if json.loads(path.read_text("utf-8")).get("state") == "error":
                        worker_error = True
                        break
                except (OSError, ValueError):
                    continue
            if state == "completed":
                if worker_error:
                    state = "failed"
                    job["error"] = "至少一个 worker 异常退出，详见 logs/"
                elif failures and summary["done"] + summary["skipped"] == 0:
                    state = "failed"
                elif (
                    summary["done"] + summary["skipped"] == 0
                    and returncodes
                    and all(code not in (0, None) for code in returncodes)
                ):
                    state = "failed"
                    job["error"] = "worker 进程全部异常退出，详见 logs/"
            job["state"] = state
            job["finishedAt"] = _shanghai_now().isoformat(timespec="seconds")
            manifest = {
                "schema": JOB_SCHEMA,
                "jobId": job["jobId"],
                "state": state,
                "options": options,
                "codes": len(codes),
                "planned": len(tasks),
                "skippedExisting": plan["skipped"],
                "totals": {
                    "total": summary["total"],
                    "done": summary["done"],
                    "skipped": summary["skipped"],
                    "failed": summary["failed"],
                    "rows": summary["rows"],
                },
                "datasets": summary["datasets"],
                "bulk": bulk_summary,
                "servers": servers,
                "probes": probes,
                "window": self.window(),
                "startedAt": job.get("startedAt"),
                "finishedAt": job["finishedAt"],
                "failures": summary["failures"][:MAX_TASKS_REPORTED_FAILURES],
            }
            _write_json_atomic(job_dir / "manifest.json", manifest)
            job["manifest"] = manifest
        except Exception as error:  # noqa: BLE001 - 失败要落盘并回给 UI
            job["state"] = "failed"
            job["error"] = f"{type(error).__name__}: {error}"
            job["finishedAt"] = _shanghai_now().isoformat(timespec="seconds")
            _write_json_atomic(
                job_dir / "manifest.json",
                {
                    "schema": JOB_SCHEMA,
                    "jobId": job["jobId"],
                    "state": "failed",
                    "error": job["error"],
                    "options": options,
                    "finishedAt": job["finishedAt"],
                    "traceback": traceback.format_exc()[-4000:],
                },
            )
        finally:
            try:
                _write_nodata_markers(job_dir, data_dir())
            except Exception:
                pass
            for process in self._processes:
                try:
                    if process.poll() is None:
                        process.terminate()
                except Exception:  # noqa: BLE001
                    pass
            self._processes = []

    def _finalize_bulk(
        self, job_dir: Path, options: dict[str, Any], allow: bool = True
    ) -> dict[str, Any]:
        """把 worker 回传的行按 dataset 合并成一份归档（同一天保留第一版）。

        bulk 数据集只有「整组成功」才写最终归档：只要有一个任务失败，就保留
        parts 不写 manifest——否则第二天再跑会因 manifest 已存在整组跳过，
        失败的那部分当天就永远补不回来。
        """
        parts_dir = job_dir / "parts"
        if not parts_dir.is_dir():
            return {}
        # 计划日期：跨零点/次日暂停时不能用「合并时刻」当 trade_date。
        planned_counts: dict[str, int] = {}
        trade_date = _today()
        plan_path = job_dir / "plan.json"
        if plan_path.is_file():
            try:
                plan_payload = json.loads(plan_path.read_text("utf-8"))
                planned_counts = {
                    str(key): int(value)
                    for key, value in (plan_payload.get("datasets") or {}).items()
                }
                trade_date = str(plan_payload.get("tradeDate") or trade_date)
            except (OSError, ValueError):
                planned_counts = {}
        # 暂停/取消/worker 崩溃时只保留 parts：进行中的任务不会写 failures，
        # 若仍合并会写出「合法但缺数」的 manifest，之后整组跳过永久补不回。
        done_counts: dict[str, int] = {}
        if allow and planned_counts:
            for result_path in sorted((job_dir / "results").glob("*.jsonl")):
                try:
                    for line in result_path.read_text("utf-8").splitlines():
                        if not line.strip():
                            continue
                        payload = json.loads(line)
                        task = payload.get("task") or {}
                        dataset = str(task.get("dataset") or "")
                        if not dataset:
                            continue
                        done_counts[dataset] = done_counts.get(dataset, 0) + 1
                except (OSError, ValueError):
                    continue
        today = trade_date
        failed_datasets: set[str] = set()
        for failure_path in sorted((job_dir / "failures").glob("*.jsonl")):
            try:
                for line in failure_path.read_text("utf-8").splitlines():
                    if not line.strip():
                        continue
                    payload = json.loads(line)
                    dataset = str((payload.get("task") or {}).get("dataset") or "")
                    if dataset:
                        failed_datasets.add(dataset)
            except (OSError, ValueError):
                continue
        sources = {
            "finance": "TDX 7709 0x0010 136B",
            "capital": "TDX 7709 0x000f 股本变迁",
            "category": "TDX 7709 0x054b 分类行情",
            "block_meta": "TDX 7709 0x02c5 板块文件元数据",
            "special_limits": "TDX 7709 0x0452 特殊涨跌停",
            "unusual": "TDX 7709 0x0563 主力监控",
            "blocks": "TDX 0x06b9 block_*.dat + tdxhy.cfg/incon.dat/tdxzs.cfg",
        }
        fields = {
            "finance": [
                "code",
                "floatShares",
                "totalShares",
                "stateShares",
                "sponsorShares",
                "legalPersonShares",
                "bShares",
                "hShares",
                "eps",
                "totalAssets",
                "currentAssets",
                "fixedAssets",
                "intangibleAssets",
                "shareholders",
                "currentLiabilities",
                "longTermLiabilities",
                "capitalReserve",
                "netAssets",
                "revenue",
                "mainProfit",
                "receivables",
                "operatingProfit",
                "investmentIncome",
                "operatingCashFlow",
                "totalCashFlow",
                "inventory",
                "comprehensiveProfit",
                "afterTaxProfit",
                "netProfit",
                "retainedProfit",
                "netAssetsPerShare",
                "updatedDate",
                "ipoDate",
                "totalAssetsYuan",
                "revenueYuan",
                "netProfitYuan",
            ],
            "capital": [
                "code",
                "date",
                "category",
                "categoryName",
                "c1",
                "c2",
                "c3",
                "c4",
                "c1Float",
                "c2Float",
                "c3Float",
                "c4Float",
                "reserved",
            ],
            "block_meta": ["filename", "size", "md5"],
            "special_limits": ["market", "marketId", "code", "symbol", "limitUp", "limitDown"],
            "blocks": ["kind", "boardId", "board", "indexCode", "code", "name"],
            "unusual": [
                "code",
                "name",
                "market",
                "index",
                "event",
                "desc",
                "value",
                "time",
                "raw",
            ],
        }
        result: dict[str, Any] = {}
        for dataset_dir in sorted(parts_dir.iterdir()):
            if not dataset_dir.is_dir():
                continue
            dataset = dataset_dir.name
            rows: list[dict] = []
            for part in sorted(dataset_dir.glob("*.jsonl.gz")):
                try:
                    with gzip.open(part, "rt", encoding="utf-8") as handle:
                        for line in handle:
                            if line.strip():
                                payload = json.loads(line)
                                rows.extend(payload.get("rows") or [])
                except (OSError, ValueError):
                    continue
            if not rows:
                result[dataset] = {"rows": 0, "skipped": True, "note": "没有回传行"}
                continue
            planned = planned_counts.get(dataset)
            if not allow or planned is None or done_counts.get(dataset, 0) < planned:
                result[dataset] = {
                    "rows": len(rows),
                    "skipped": True,
                    "reason": (
                        "任务未全部完成（暂停/取消/worker 异常），保留 parts 待续跑"
                        if not allow
                        else f"完成数 {done_counts.get(dataset, 0)}/{planned}，保留 parts 待续跑"
                    ),
                    "parts": str(dataset_dir.resolve()),
                }
                continue
            if dataset in failed_datasets:
                result[dataset] = {
                    "rows": len(rows),
                    "skipped": True,
                    "reason": "有任务失败，保留 parts 待续跑（不写 manifest，避免次日整组跳过）",
                    "parts": str(dataset_dir.resolve()),
                }
                continue
            archive = write_dataset_archive(
                data_dir() / "lake" / _bulk_root(dataset),
                dataset,
                rows,
                source=sources.get(dataset, f"pythontdx offline_sync {dataset}"),
                trade_date=today,
                fields=fields.get(dataset),
            )
            result[dataset] = {**archive, "partFiles": len(list(dataset_dir.glob("*.jsonl.gz")))}
        return result

    def _aggregate(self, job_dir: Path) -> dict[str, Any]:
        totals = {"total": 0, "done": 0, "skipped": 0, "failed": 0, "rows": 0}
        datasets: dict[str, dict[str, int]] = {}
        failures: list[dict] = []
        for path in sorted((job_dir / "progress").glob("worker-[0-9][0-9][0-9].json")):
            try:
                payload = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            for key in totals:
                totals[key] += int(payload.get(key) or 0)
            for name, bucket in (payload.get("datasets") or {}).items():
                target = datasets.setdefault(name, {"done": 0, "skipped": 0, "failed": 0, "rows": 0})
                for key in target:
                    target[key] += int(bucket.get(key) or 0)
        for path in sorted((job_dir / "failures").glob("*.jsonl")):
            try:
                for line in path.read_text("utf-8").splitlines():
                    if line.strip():
                        failures.append(json.loads(line))
            except (OSError, ValueError):
                continue
        return {**totals, "datasets": datasets, "failures": failures}


class _CodeListProxy:
    """让 resolve_codes 既接受 Bridge 也接受已拉好的代码表。"""

    def __init__(self, catalog: list[dict]) -> None:
        self._catalog = catalog

    def code_list(self) -> list[dict]:
        return self._catalog


# 单例：tdx_bridge 的 dispatch 通过它启停任务
_MANAGER: OfflineSyncManager | None = None
_MANAGER_LOCK = threading.Lock()


def manager() -> OfflineSyncManager:
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None:
            _MANAGER = OfflineSyncManager()
        return _MANAGER


# ---------------------------------------------------------------- CLI


def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="pythontdx 离线数据并行同步")
    parser.add_argument("--worker", help="内部使用：worker 任务分片 JSON")
    parser.add_argument("--datasets", default="", help="逗号分隔的数据集 key")
    parser.add_argument("--preset", default="", help="daily/watchlist/full")
    parser.add_argument("--scope", default="all", help="all/watchlist/codes")
    parser.add_argument("--codes", default="", help="逗号分隔代码（scope=codes/watchlist）")
    parser.add_argument("--dates", default="", help="逗号分隔交易日 YYYY-MM-DD")
    parser.add_argument("--periods", default="day", help="K 线周期，逗号分隔")
    parser.add_argument("--adjust", default="none", help="none/qfq/hfq")
    parser.add_argument("--source", default="auto", help="auto/mac/7709")
    parser.add_argument("--processes", type=int, default=DEFAULT_PROCESSES)
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    parser.add_argument("--allow-inside-window", action="store_true")
    parser.add_argument("--force", action="store_true", help="忽略已有归档，强制重下")
    parser.add_argument("--max-codes", type=int, default=0)
    parser.add_argument("--json", action="store_true", help="只输出一个 JSON 结果")
    args = parser.parse_args(argv)

    if args.worker:
        run_worker(args.worker)
        return 0

    raw = {
        "datasets": args.datasets,
        "preset": args.preset,
        "scope": args.scope,
        "codes": args.codes,
        "dates": args.dates,
        "periods": args.periods,
        "adjust": args.adjust,
        "source": args.source,
        "processes": args.processes,
        "threads": args.threads,
        "allowInsideWindow": args.allow_inside_window,
        "skipExisting": not args.force,
        "maxCodes": args.max_codes,
    }
    sync = manager()
    started = sync.start(raw)
    if started.get("state") == "blocked":
        print(json.dumps(started, ensure_ascii=False, indent=2))
        return 2
    while True:
        status = sync.status()
        if status.get("state") not in {"planning", "probing", "running"}:
            break
        time.sleep(2)
    if args.json:
        print(json.dumps(status, ensure_ascii=False, indent=2))
    else:
        totals = status.get("totals") or {}
        print(
            f"[offline-sync] {status.get('state')} "
            f"done={totals.get('done', 0)} skipped={totals.get('skipped', 0)} "
            f"failed={totals.get('failed', 0)} rows={totals.get('rows', 0)}"
        )
        if status.get("failures"):
            for item in status["failures"][:10]:
                task = item.get("task") or {}
                print(f"  ! {task.get('dataset')} {task.get('code') or task.get('codes')}: {item.get('error')}")
    return 0 if status.get("state") in {"completed", "paused"} else 1


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
