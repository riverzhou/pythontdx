#!/usr/bin/env python3
"""
pythontdx 的通达信行情桥接进程（协议层门面）。

分层（2026-11-14 拆分）：
  · `tdxproto/`  常量、编解码、连接、请求体、解析、板块、代码索引，单向依赖；
  · 本文件      `Bridge` 编排（行情/逐笔/竞价/选股）、本地缓存、备份恢复、
                离线同步 worker 与 JSONL 调试入口。
  本文件把 `tdxproto` 的模块级名字全部再导出，老代码与测试继续 `import tdx_bridge`。

职责：
  · 持有 7709 TCP 连接，完成握手、请求、超时、重连、主站 failover；
  · 解析五档行情 / K 线 / 分时 / 历史分时 / 代码表 / 财务；
  · 支持 0x053e 旧版五档、0x054c 批量快照、0x0547 增量刷新（五档基线）。

数据通道：应用（桌面与 Web）走 `tdx_server.py` 的 HTTP/WS；这里的 stdio JSONL
只用于单命令调试与离线同步 worker（`--offline-worker`），不是产品数据通道。

为什么是 sidecar 而不是把协议写在 Node 里：
  · 用户希望通讯用 Python；
  · 这个文件只依赖标准库，Nuitka 可以编译成单文件，
    不需要在用户机器上安装 Python，也不需要 pytdx/eltdx。

协议要点（2026-10 实测）：
  · 握手只能发一条 0x000d；pytdx 的 setup1/2/3 三连包会让服务端进入旧版会话，
    之后 0x053e 只回 4 字节空包；
  · 0x053e 单次最多 80 只；0x052d 单页最多 800 根；
  · 0x052d 的 adjust=1 是服务端前复权；
  · 指数的五档字段是垃圾值，K 线记录还要多读 4 字节；
  · 7709 没有港股/美股。

手工调试：
  echo '{"id":1,"cmd":"ping"}' | python3 python/tdx_bridge.py
  echo '{"id":2,"cmd":"quotes","payload":{"codes":["sh600519"]}}' | python3 python/tdx_bridge.py
"""

from __future__ import annotations

import gzip
import csv
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import os
import re
import socket
import sqlite3
import struct
import sys
import threading
import time
import traceback
import zipfile
import zlib
from collections import Counter, deque
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

from duckdb_query import run_duckdb_query
from data_paths import data_dir
from formula import FormulaError, evaluate_formula, evaluate_series
from parquet_export import export_stats_parquet
from tdx_local import parse_day_bytes, read_local_file, write_day_file, write_min_file
from tdx_mac import (
    MacError,
    fetch_capital_flow,
    fetch_capital_flows,
    fetch_quotes as fetch_mac_quotes,
    fetch_transactions as fetch_mac_transactions,
    fetch_unusual,
    fetch_boards,
)
from local_import import import_local_file
from kline_export import write_kline_export
import trading_calendar
from parquet_store import ParquetStoreError, read_bars, write_bars
from auction_archive import (
    AuctionArchiveError,
    list_auction_archives,
    normalize_code as normalize_auction_code,
    normalize_date as normalize_auction_date,
    read_auction_archive,
    write_auction_archive,
)
from snapshot_archive import list_snapshot_archives, write_snapshot_archive
from f10_pit import list_f10_snapshots, read_f10_snapshot, write_f10_snapshot
from flow_archive import list_flow_archives, read_flow_archive, write_flow_archive
from data_coverage import collect_data_coverage
from data_integrity import verify_data_integrity
from patterns import build_smart_drawings, pattern_summary
from kline_manifest import write_kline_manifest
from server_catalog import list_server_catalogs, write_server_catalog
from protocol_archive import read_dataset_archive, list_dataset_archives, write_dataset_archive
from code_archive import (
    list_code_archives,
    read_code_archive,
    write_code_archive,
)
from delisted_archive import list_delisted_archives, write_delisted_archive
from adjust_factors import apply_factors, build_factors
from tick_archive import (
    TickArchiveError,
    latest_tick_archive,
    list_tick_archives,
    normalize_code as normalize_tick_code,
    normalize_date as normalize_tick_date,
    read_tick_archive,
    write_tick_archive,
)
from tdx_f10 import (
    fetch_announcements,
    fetch_business,
    fetch_channel_news,
    fetch_digest,
    fetch_detail,
    fetch_finance,
    fetch_fund_report,
    fetch_governance,
    fetch_hot_topics,
    fetch_market_news,
    fetch_market_report,
    fetch_news,
    fetch_northbound_holding,
    fetch_profile,
    fetch_profit_forecast,
    fetch_ranking_detail,
    fetch_reports,
    fetch_shareholders,
    fetch_statement,
    fetch_trading,
    fetch_valuation,
)

# ---------------------------------------------------------------- 门面再导出
# 协议层已拆到 tdxproto/；这里保留原有的模块级名字，
# 既方便 `import tdx_bridge` 的老代码与测试，也让本文件里的 Bridge 继续用裸名调用。
from tdxproto.base import (  # noqa: F401
    MARKET_IDS, MARKET_NAMES, TdxError, code_bytes, full_code, parse_code,
    pythontdx_data_dir,
)
from tdxproto.blocks import (  # noqa: F401
    BLOCKNEW_NAME, BLOCKNEW_RECORD, CAPITAL_CATEGORY_NAMES, CAPITAL_SHARE_CATEGORIES, SCREEN_FIELDS, SCREEN_SORT_FIELDS,
    TOP_BOARD_NAMES, _format_tick_time, _unusual_text, apply_screen, client_block_indices, client_roots,
    filter_quotes_by_codes, format_date, is_record_start, minute_label, parse_bars, parse_blocknew_cfg,
    parse_capital_changes, parse_client_block, parse_delisted_bars, parse_finance, parse_history_minute, parse_minute_aux,
    parse_recent_minute, parse_security_count, parse_security_list, parse_sparkline, parse_special_limits, parse_today_minute,
    parse_top_board, parse_unusual, parse_volume_profile, to_levels,
)
from tdxproto.business import (  # noqa: F401
    CodeIndex, _archive_key, _merge_archive_lists, _write_keyed_archive,
)
from tdxproto.cache import (  # noqa: F401
    AUCTION_LIMIT, AUCTION_RECORD, BREADTH_CLOSED_TTL, BREADTH_LUNCH_TTL, BREADTH_TRADING_TTL, CACHE_MAX_ENTRIES,
    F10_CONTENT_HEADER, F10_FILENAME_SIZE, F10_NAME_SIZE, F10_RECORD_SIZE, FILE_CHUNK, FILE_PATH_FIELD,
    FIVE_DAY_CACHE_TTL, KLINE_CACHE_TTL, KLINE_LIVE_FULL_REFRESH, KLINE_LIVE_MAX_ENTRIES, KLINE_LIVE_TAIL, MAX_FILE_BYTES,
    MAX_FILE_CHUNK, MINUTE_CACHE_TTL, MONEY_FLOW_CHANNEL, MONEY_FLOW_HEADER, MONEY_FLOW_RECORD, MONEY_FLOW_ROUTE,
    PERIOD_RAW, TRADE_PAGE, breadth_ttl, merge_kline_bars, shanghai_day,
)
from tdxproto.codec import (  # noqa: F401
    _f32, _u16, _u32, classify_security, decode_volume, encode_frame,
    is_index_code, normalize_name, price_divisor, read_varint,
)
from tdxproto.constants import (  # noqa: F401
    AUCTION_FALLBACK_LIMIT, CAPITAL_BATCH, CMD_AUCTION, CMD_BARS, CMD_BLOCK_META, CMD_CAPITAL_CHANGES,
    CMD_CATEGORY, CMD_DELISTED_BARS, CMD_F10_CATEGORY, CMD_F10_CONTENT, CMD_FILE_CONTENT, CMD_FINANCE,
    CMD_HANDSHAKE, CMD_HEARTBEAT, CMD_HISTORY_MINUTE, CMD_HISTORY_TICKS, CMD_MINUTE, CMD_MINUTE_AUX,
    CMD_MONEY_FLOW, CMD_QUOTES, CMD_RECENT_MINUTE, CMD_REFRESH, CMD_SECURITY_COUNT, CMD_SECURITY_LIST,
    CMD_SNAPSHOT, CMD_SPARKLINE, CMD_SPECIAL_LIMITS, CMD_TODAY_TICKS, CMD_TOP_BOARD, CMD_UNUSUAL,
    CMD_VOLUME_PROFILE, CODE_PAGE, CONNECT_CFG_CANDIDATES, CONNECT_TIMEOUT, ENDPOINTS, FINANCE_BATCH,
    FINANCE_TTL, HEARTBEAT_INTERVAL, MAX_FRAME_BYTES, MAX_FRAME_RATIO, MONEY_FLOW_HOSTS, OPENING_GRACE_UNTIL,
    QUOTE_BASELINE_INTERVAL, QUOTE_BATCH, QUOTE_LIST_PREFIX, REFRESH_BATCH, REQUEST_TIMEOUT, SERVER_HOSTS,
    SESSION_BOUNDARIES, SHANGHAI_TZ, _connect_cfg_candidates, _merge_auction_quotes, _merge_quotes, _merge_snapshot_prices,
    _normalize_codes, _ordered_endpoints, _preferred_host, _server_config_path, active_endpoints, limit_percent,
    ms_until_session_change, parse_connect_cfg, shanghai_clock, speed_test_hosts,
)
from tdxproto.parsers import (  # noqa: F401
    BLOCK_CODE_SIZE, BLOCK_FILES, BLOCK_HEADER_SIZE, BLOCK_MAX_CODES, BLOCK_NAME_SIZE, BLOCK_RECORD_SIZE,
    _build_quote, _int_or_none, _parse_category_record, _parse_refresh_record, _parse_snapshot_record, _read_k_prices,
    _run_readonly_query, _split_quote_records, _split_refresh_records, _stat_float, _stat_rows, _trade_side,
    export_stats_csv, export_tdx_stats, normalize_tdx_stats, parse_auctions, parse_block_dat, parse_block_meta,
    parse_category_quotes, parse_f10_catalog, parse_f10_content, parse_file_chunk, parse_incon_sections, parse_money_flow,
    parse_quotes, parse_refresh, parse_sector_indices, parse_snapshots, parse_tdx_stats, parse_tdxhy,
    parse_trades, run_local_query, run_stats_query, save_raw_file, write_stats_db,
)
from tdxproto.requests import (  # noqa: F401
    auction_data, bars_data, block_meta_data, capital_changes_data, category_data, count_data,
    delisted_bars_data, f10_catalog_data, f10_content_data, file_content_data, finance_data, history_minute_data,
    list_data, minute_aux_data, minute_data, money_flow_data, quote_data, recent_minute_data,
    refresh_data, sparkline_data, special_limits_data, top_board_data, trades_data, unusual_data,
    volume_profile_data,
)
from tdxproto.session import (  # noqa: F401
    TdxConnection, parse_handshake,
)

# ---------------------------------------------------------------- K 线本地缓存

def kline_cache_dir() -> Path:
    target = pythontdx_data_dir() / "cache" / "klines"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _dir_stats(target: Path) -> tuple[int, int]:
    files = 0
    total = 0
    if target.exists():
        for item in target.rglob("*"):
            if item.is_file():
                files += 1
                try:
                    total += item.stat().st_size
                except OSError:
                    pass
    return files, total


def data_inventory() -> dict:
    """离线数据目录清单：只读扫描，不做删除或迁移。"""
    root = pythontdx_data_dir()
    sections = {}
    for name, relative in {
        "raw": "raw",
        "cache": "cache",
        "lake": "lake",
        "exports": "exports",
        "normalized": "normalized",
        "local": "local",
    }.items():
        files, size = _dir_stats(root / relative)
        sections[name] = {"files": files, "bytes": size, "path": str(root / relative)}
    cache_dir = root / "cache" / "klines"
    cache_files = list(cache_dir.glob("*.parquet")) if cache_dir.exists() else []
    codes: set[str] = set()
    periods: set[str] = set()
    latest = 0
    for file in cache_files:
        parts = file.stem.split("_")
        if len(parts) >= 2:
            codes.add(parts[0])
            periods.add(parts[1])
        try:
            latest = max(latest, int(file.stat().st_mtime * 1000))
        except OSError:
            continue
    return {
        "root": str(root),
        **sections,
        "klineCache": {
            "files": len(cache_files),
            "codes": len(codes),
            "periods": sorted(periods),
            "latest": latest,
        },
    }


# ------------------------------------------------------------ 离线数据备份/恢复

BACKUP_FORMAT = 1
BACKUP_MANIFEST = "_pythontdx_backup.json"
# 1.1 之前生成的备份带旧清单名；读取时兼容，恢复时不要把清单当数据文件写回去。
LEGACY_BACKUP_MANIFEST = "_stocklens_backup.json"
BACKUP_CHUNK = 1024 * 1024
PROGRESS_PREFIX = "__PYTHONTDX_PROGRESS__ "


class _BackupProgressReporter:
    """把备份/恢复的真实字节进度通过 stderr 推给 Electron 主进程。

    为什么要节流：逐 1MB 发一行会让 5GB 数据产生 5000 行 stderr，既刷屏又浪费 IPC。
    这里保证首尾事件一定发出，中间最多约 6 行/秒；前端仍按真实字节数画进度条。
    """

    def __init__(self, operation: str, callback: Callable[[dict], None] | None) -> None:
        self.operation = operation
        self.callback = callback
        self.last_at = 0.0

    def report(
        self,
        phase: str,
        *,
        done_bytes: int = 0,
        total_bytes: int = 0,
        done_files: int = 0,
        total_files: int = 0,
        current: str = "",
        force: bool = False,
    ) -> None:
        if self.callback is None:
            return
        now = time.monotonic()
        if not force and now - self.last_at < 0.15:
            return
        self.last_at = now
        self.callback(
            {
                "operation": self.operation,
                "phase": phase,
                "doneBytes": done_bytes,
                "totalBytes": total_bytes,
                "doneFiles": done_files,
                "totalFiles": total_files,
                "current": current,
            }
        )


def _bridge_progress(event: dict) -> None:
    """sidecar 的结构化进度行；TdxBridge 会拦截它，不再当普通日志打印。"""
    print(
        PROGRESS_PREFIX + json.dumps(event, ensure_ascii=False, separators=(",", ":")),
        file=sys.stderr,
        flush=True,
    )


def _backup_root() -> Path:
    root = pythontdx_data_dir()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _backup_target(path: str, *, must_exist: bool) -> Path:
    text = str(path or "").strip().strip('"')
    if not text:
        raise TdxError("请先选择备份文件路径")
    target = Path(text).expanduser()
    if must_exist:
        if not target.is_file():
            raise TdxError(f"找不到备份文件：{target}")
    elif target.is_dir():
        raise TdxError(f"目标是目录，请指定一个 .zip 文件：{target}")
    return target


def _backup_files(root: Path) -> list[Path]:
    """备份要收的文件：数据目录下全部文件，跳过未写完的 .part。"""
    files = [
        item
        for item in root.rglob("*")
        if item.is_file() and not item.name.endswith(".part")
    ]
    files.sort(key=lambda item: item.relative_to(root).as_posix())
    return files


def _sha256_of(
    path: Path, progress: Callable[[int, int], None] | None = None
) -> str:
    total = path.stat().st_size
    done = 0
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(BACKUP_CHUNK), b""):
            digest.update(chunk)
            done += len(chunk)
            if progress is not None:
                progress(done, total)
    return digest.hexdigest()


def backup_create(
    path: str, progress: Callable[[dict], None] | None = None
) -> dict:
    """把整个离线数据目录打成单个 zip。

    行情数据本身已经是 Parquet/ZSTD 或 gzip，deflate 再压一遍几乎没有收益，
    所以用 STORED 只做「单文件封装」，几 GB 的目录也不会卡在压缩上。
    已存在的同名文件直接报错，不覆盖 —— 备份是用户自己指定的可移动介质，
    写坏了没有第二次机会。

    progress 按真实写入/哈希字节回报；前端据此画进度条，不靠计时假推进。
    """
    root = _backup_root()
    target = _backup_target(path, must_exist=False)
    if target.exists():
        raise TdxError(f"文件已存在，请换一个名字：{target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part")
    report = _BackupProgressReporter("backup", progress)
    report.report("scan", force=True)

    files = _backup_files(root)
    total = sum(file.stat().st_size for file in files)
    started = int(time.time() * 1000)
    report.report(
        "write",
        total_bytes=total,
        total_files=len(files),
        force=True,
    )
    written = 0
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
            for index, file in enumerate(files, start=1):
                relative = file.relative_to(root).as_posix()
                copied = 0
                with file.open("rb") as src, archive.open(
                    relative, "w", force_zip64=True
                ) as dst:
                    while True:
                        chunk = src.read(BACKUP_CHUNK)
                        if not chunk:
                            break
                        dst.write(chunk)
                        copied += len(chunk)
                        report.report(
                            "write",
                            done_bytes=written + copied,
                            total_bytes=total,
                            done_files=index - 1,
                            total_files=len(files),
                            current=relative,
                        )
                written += copied
                report.report(
                    "write",
                    done_bytes=written,
                    total_bytes=total,
                    done_files=index,
                    total_files=len(files),
                    current=relative,
                )
            archive.writestr(
                BACKUP_MANIFEST,
                json.dumps(
                    {
                        "format": BACKUP_FORMAT,
                        "app": "pythontdx",
                        "createdAt": started,
                        "dataRoot": str(root),
                        "fileCount": len(files),
                        "totalBytes": total,
                    },
                    ensure_ascii=False,
                ),
            )
        os.replace(temporary, target)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    archive_bytes = target.stat().st_size
    report.report(
        "hash",
        total_bytes=archive_bytes,
        done_files=len(files),
        total_files=len(files),
        current=target.name,
        force=True,
    )
    digest = _sha256_of(
        target,
        lambda done, total_bytes: report.report(
            "hash",
            done_bytes=done,
            total_bytes=total_bytes,
            done_files=len(files),
            total_files=len(files),
            current=target.name,
        ),
    )
    report.report(
        "done",
        done_bytes=total,
        total_bytes=total,
        done_files=len(files),
        total_files=len(files),
        force=True,
    )
    return {
        "path": str(target),
        "fileCount": len(files),
        "totalBytes": total,
        "archiveBytes": archive_bytes,
        "sha256": digest,
        "createdAt": started,
        "dataRoot": str(root),
    }


def backup_inspect(path: str) -> dict:
    """读备份的清单：文件数、原始字节数、打包时间，用于恢复前确认。"""
    source = _backup_target(path, must_exist=True)
    try:
        with zipfile.ZipFile(source) as archive:
            manifest: dict = {}
            names = archive.namelist()
            manifest_name = next(
                (name for name in (BACKUP_MANIFEST, LEGACY_BACKUP_MANIFEST) if name in names),
                BACKUP_MANIFEST,
            )
            if manifest_name in names:
                try:
                    manifest = json.loads(archive.read(manifest_name).decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    manifest = {}
            files = [
                item
                for item in archive.infolist()
                if not item.is_dir()
                and item.filename not in (BACKUP_MANIFEST, LEGACY_BACKUP_MANIFEST)
            ]
    except zipfile.BadZipFile as error:
        raise TdxError("不是合法的 ZIP 备份文件") from error
    return {
        "path": str(source),
        "archiveBytes": source.stat().st_size,
        "fileCount": int(manifest.get("fileCount") or len(files)),
        "totalBytes": int(manifest.get("totalBytes") or sum(item.file_size for item in files)),
        "createdAt": int(manifest.get("createdAt") or 0),
        "dataRoot": str(manifest.get("dataRoot") or ""),
        "format": int(manifest.get("format") or 0),
    }


def backup_restore(
    path: str, progress: Callable[[dict], None] | None = None
) -> dict:
    """把备份解回数据目录：同名文件全量覆盖，不再因本地已存在而跳过。

    2026-11-01 用户明确要求「恢复采用全量覆盖，不管本地现有数据」，
    这是对规则 12「已存在不覆盖」的例外。备份里没有的本地文件仍保留，
    不会删除本机多出来的数据。progress 按已写入字节回报真实进度。
    """
    source = _backup_target(path, must_exist=True)
    root = _backup_root()
    restored = 0
    overwritten = 0
    skipped = 0
    restored_bytes = 0
    try:
        archive = zipfile.ZipFile(source)
    except zipfile.BadZipFile as error:
        raise TdxError("不是合法的 ZIP 备份文件") from error

    report = _BackupProgressReporter("restore", progress)
    with archive:
        entries = [
            info
            for info in archive.infolist()
            if not info.is_dir()
            and info.filename not in (BACKUP_MANIFEST, LEGACY_BACKUP_MANIFEST)
        ]
        total_bytes = sum(info.file_size for info in entries)
        report.report(
            "write",
            total_bytes=total_bytes,
            total_files=len(entries),
            force=True,
        )
        done_bytes = 0
        for index, info in enumerate(entries, start=1):
            relative = Path(info.filename.replace("\\", "/"))
            if (
                relative.is_absolute()
                or ".." in relative.parts
                or not relative.parts
                or (relative.parts[0].endswith(":") if relative.parts else False)
            ):
                raise TdxError(f"备份文件包含非法路径：{info.filename}")
            destination = root.joinpath(*relative.parts)
            existed = destination.exists()
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + ".part")
            copied = 0
            try:
                with archive.open(info) as src, temporary.open("wb") as dst:
                    while True:
                        chunk = src.read(BACKUP_CHUNK)
                        if not chunk:
                            break
                        dst.write(chunk)
                        copied += len(chunk)
                        report.report(
                            "write",
                            done_bytes=done_bytes + copied,
                            total_bytes=total_bytes,
                            done_files=index - 1,
                            total_files=len(entries),
                            current=relative.as_posix(),
                        )
                _replace_atomic(temporary, destination)
            except Exception:
                temporary.unlink(missing_ok=True)
                raise
            if existed:
                overwritten += 1
            else:
                restored += 1
            restored_bytes += copied
            done_bytes += copied
            report.report(
                "write",
                done_bytes=done_bytes,
                total_bytes=total_bytes,
                done_files=index,
                total_files=len(entries),
                current=relative.as_posix(),
            )
        report.report(
            "done",
            done_bytes=done_bytes,
            total_bytes=total_bytes,
            done_files=len(entries),
            total_files=len(entries),
            force=True,
        )

    return {
        "path": str(source),
        "restored": restored,
        "overwritten": overwritten,
        "skipped": skipped,
        "bytes": restored_bytes,
        "dataRoot": str(root),
    }


def _replace_atomic(source: Path, target: Path, attempts: int = 6) -> None:
    """原子改名；Windows 上目标可能被杀软/搜索索引短暂占用，重试几次再放弃。"""
    for attempt in range(attempts):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.15 * (attempt + 1))


def _write_dataset_jsonl(target: Path, rows: list[dict]) -> dict:
    """把一份数据集写成 jsonl.gz（原子写入；已存在则跳过，规则 12）。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return {"file": str(target), "rows": 0, "skipped": True}
    temporary = target.with_name(target.name + ".part")
    with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    _replace_atomic(temporary, target)
    return {
        "file": str(target),
        "rows": len(rows),
        "bytes": target.stat().st_size,
        "sha256": _sha256_of(target),
        "skipped": False,
    }


def _kline_cache_path(code: str, period: str, count: int, adjust: str) -> Path:
    safe = f"{code.lower()}_{period}_{int(count)}_{adjust}.parquet"
    return kline_cache_dir() / safe


def _full_kline_cache_path(code: str, period: str, adjust: str) -> Path:
    return kline_cache_dir() / f"{code.lower()}_{period}_all_{adjust}.parquet"


def _write_kline_cache(
    code: str, period: str, count: int, adjust: str, bars: list[dict], source: str
) -> Path:
    target = _kline_cache_path(code, period, count, adjust)
    write_bars(target, code, bars)
    write_kline_manifest(
        target,
        {
            "code": code,
            "period": period,
            "count": int(count),
            "adjust": adjust,
            "source": source,
            "fetchedAt": int(time.time() * 1000),
        },
    )
    return target


def _write_full_kline_cache(
    code: str,
    period: str,
    adjust: str,
    bars: list[dict],
    pages: int,
    complete: bool,
    source: str = "network",
) -> Path:
    target = _full_kline_cache_path(code, period, adjust)
    write_bars(target, code, bars)
    write_kline_manifest(
        target,
        {
            "code": code,
            "period": period,
            "count": len(bars),
            "adjust": adjust,
            "source": source,
            "fetchedAt": int(time.time() * 1000),
            "pages": pages,
            "complete": complete,
            "fullHistory": True,
        },
    )
    return target


def _read_kline_cache(code: str, period: str, count: int, adjust: str) -> dict | None:
    target = _kline_cache_path(code, period, count, adjust)
    if not target.is_file():
        return None
    try:
        result = read_bars(target)
    except ParquetStoreError:
        return None
    return {
        "code": code,
        "period": period,
        "count": int(count),
        "adjust": adjust,
        "bars": result["bars"],
        "source": "cache",
        "cachePath": str(target),
    }


def prefer_tick_archive(now: datetime, trade_date: str) -> bool:
    """实时明细是否应该直接读本地归档。

    只覆盖「实时接口拿不到更新的数据」的时段：周末，或当天收盘后且归档就是今天。
    盘中（含午休）仍走实时，避免把上一交易日的逐笔当成今天的。
    """
    if now.weekday() >= 5:
        return True
    return trade_date == now.strftime("%Y-%m-%d") and (
        now.hour * 60 + now.minute >= 15 * 60 + 5
    )


class Bridge:
    def __init__(
        self, host: str | None = None, index_items: list[dict] | None = None
    ) -> None:
        # host 用于离线同步的多线程分片：每条线程钉在不同主站，故障时
        # TdxConnection 仍会按 endpoints 列表继续换站。
        self.preferred_host = host or _preferred_host()
        self.conn = TdxConnection(_ordered_endpoints(self.preferred_host))
        trading_calendar.configure(pythontdx_data_dir() / "cache" / "trading_calendar.json")
        self.money_conn: TdxConnection | None = None
        self.index = CodeIndex()
        if index_items:
            # 父进程已拉过代码表，worker 直接复用，避免每个线程重复 0x044d 分页。
            self.index.all = [dict(item) for item in index_items]
            self.index.by_code = {
                str(item.get("code")): item for item in self.index.all if item.get("code")
            }
            self.index.loaded = True
        self.finance_cache: dict[str, tuple[float, dict]] = {}
        self.block_cache: dict[str, tuple[float, dict]] = {}
        self.industry_cache: tuple[float, dict] | None = None
        self.zhb_cache: tuple[float, bytes, dict, int] | None = None
        self.screen_cache: tuple[float, list[dict]] | None = None
        # 分时接口每次都要先查两日日线拿 date/prevClose；1 秒一推时这段是
        # 纯重复请求。30 秒缓存足够覆盖一个交易日内的基准，跨日会自然过期。
        self.minute_daily_cache: dict[str, tuple[float, list[dict]]] = {}
        # 竞价阶段左侧栏兜底：没有 0x0547/0x054c 报价的代码，用 0x056a
        # 最后一笔虚拟撮合价补上，避免自选行显示「—」。
        self.auction_quote_cache: dict[str, tuple[float, dict]] = {}
        # 0x0547 增量刷新：每只代码的下一游标，以及最后一次完整报价。
        # 服务端对“没有新成交”的代码返回 0 条；调用方仍需拿到上一帧。
        self.quote_cursors: dict[str, int] = {}
        self.quote_cache: dict[str, dict] = {}
        self.quote_watch: set[str] = set()
        self.quote_day = ""
        self.quote_baseline_at = 0.0
        # 服务端数据缓存：桌面与 Web 共用同一份 TTL / 合并规则。
        self._cache_lock = threading.Lock()
        self._minute_cache: dict[str, tuple[float, dict]] = {}
        self._five_day_cache: dict[str, tuple[float, dict]] = {}
        self._kline_cache: dict[str, tuple[float, dict]] = {}
        # 实时 K 线增量：key -> (完整 series, 上次全量时间 monotonic)
        self._kline_live_cache: dict[str, tuple[dict, float]] = {}
        self._kline_live_lock = threading.Lock()
        # 涨跌家数：单飞行扫描状态 + 按时段 TTL 的最终结果。
        self._breadth_lock = threading.Lock()
        self._breadth_cache: dict | None = None
        self._breadth_at = 0.0
        self._breadth_day = ""
        self._breadth_scan: dict | None = None
        self._breadth_scan_id = 0
        # MAC 长连接按需建立；与 7709 连接分开，MAC 失败不影响主链路。
        self._mac_session = None

    def close(self) -> None:
        self.conn.close()
        if self._mac_session is not None:
            try:
                self._mac_session.close()
            except Exception:
                pass
            self._mac_session = None
        if getattr(self, "_finance_history_conn", None) is not None:
            try:
                self._finance_history_conn.close()
            except Exception:
                pass
            self._finance_history_conn = None
        if self.money_conn is not None:
            self.money_conn.close()

    def server_speed_test(self) -> dict:
        return speed_test_hosts()

    def select_server(self, host: str) -> dict:
        selected = str(host or "").strip()
        hosts, _source = active_endpoints()
        if not any(item[0] == selected for item in hosts):
            raise TdxError("未知行情主站")
        target = _server_config_path()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".part")
        temporary.write_text(
            json.dumps({"preferredHost": selected}, ensure_ascii=False) + "\n", "utf-8"
        )
        os.replace(temporary, target)
        self.conn.close()
        self.preferred_host = selected
        self.conn = TdxConnection(_ordered_endpoints(selected))
        self.quote_cursors.clear()
        self.quote_cache.clear()
        self.quote_watch.clear()
        self.quote_day = ""
        self.quote_baseline_at = 0.0
        self.invalidate_caches()
        return {"preferred": selected}

    # -- 代码表 ---------------------------------------------------------

    def code_list(self) -> list[dict]:
        self.index.ensure(self.conn)
        return self.index.all

    def _name(self, code: str, symbol: str) -> str:
        return self.index.by_code.get(code, {}).get("name") or symbol

    def _decimal(self, code: str) -> int | None:
        return self.index.by_code.get(code, {}).get("decimal")

    # -- 行情 -----------------------------------------------------------

    def _quotes_7709(self, codes: list[str]) -> list[dict]:
        received_at = int(time.time() * 1000)
        unique: list[str] = []
        items: list[tuple[int, str]] = []

        for raw in codes:
            code = str(raw).strip().lower()
            if not code or code in unique:
                continue
            unique.append(code)
            try:
                market, symbol = parse_code(code)
            except TdxError:
                continue
            items.append((market, symbol))

        if not items:
            raise TdxError("当前数据源暂不支持港股/美股")

        try:
            self.index.ensure(self.conn)
        except Exception as error:  # noqa: BLE001 - 代码表失败不该拖垮行情
            print(f"[tdx] 代码表加载失败：{error}", file=sys.stderr)

        quotes: list[dict] = []
        for start in range(0, len(items), QUOTE_BATCH):
            batch = items[start : start + QUOTE_BATCH]
            body = self.conn.request(CMD_QUOTES, quote_data(batch))
            quotes.extend(parse_quotes(body, received_at, self.index.by_code))

        self._attach_finance(quotes)

        by_code = {quote["code"]: quote for quote in quotes}
        return [by_code[code] for code in unique if code in by_code]

    def _mac_fallback(self, codes: list[str], error: Exception) -> list[dict]:
        print(f"[tdx] 7709 行情失败，尝试 MAC：{error}", file=sys.stderr)
        try:
            quotes = fetch_mac_quotes(codes)
        except Exception as mac_error:  # noqa: BLE001 - 两路都失败时给出组合原因
            raise TdxError(f"7709 与 MAC 行情均失败：{error} / {mac_error}") from error
        if not quotes:
            raise TdxError(f"MAC 未返回行情：{error}")
        return quotes

    def mac_quotes(self, codes: list[str]) -> list[dict]:
        """显式走 MAC 0x122B；用于探测与手动切换。"""
        return fetch_mac_quotes(codes)

    def mac_quotes_finance(self, codes: list[str]) -> list[dict]:
        """MAC 0x122B 报价 + 0x0010 财务（流通市值/总市值/换手/市净率）。

        全市场市值排行用：MAC 报价本身不带股本，必须补财务；财务失败时保留
        行情并返回缺字段，界面不把缺失市值当 0 参与排名。
        """
        quotes = fetch_mac_quotes(codes)
        if quotes:
            self._attach_finance(quotes)
        return quotes

    def mac_money_flow(self, code: str) -> dict:
        """MAC 0x1218 今日/5 日资金流；成功结果自动按交易日归档。"""
        result = fetch_capital_flow(code)
        try:
            write_flow_archive(pythontdx_data_dir() / "lake" / "money_flow", code, result)
        except Exception as error:  # noqa: BLE001 - 归档失败不影响查询
            print(f"[tdx] 资金流归档失败：{error}", file=sys.stderr)
        return result

    def mac_money_flow_batch(self, codes: list[str], workers: int = 12) -> list[dict]:
        """批量 MAC 0x1218；全市场资金流排行的数据通道。"""
        return fetch_capital_flows(codes, workers=workers)

    def mac_boards(self, board_type: int = 255) -> list[dict]:
        """MAC 0x1231 板块列表（含领涨股）。"""
        return fetch_boards(board_type)

    def mac_unusual(self, count: int = 600) -> list[dict]:
        """MAC 0x1237 沪深异动；两个市场合并后按时间倒序。"""
        items: list[dict] = []
        seen: set[tuple[str, str, str]] = set()
        for market in (0, 1):
            for item in fetch_unusual(market, count):
                key = (item["code"], item["time"], item["desc"])
                if key in seen:
                    continue
                seen.add(key)
                items.append(item)
        items.sort(key=lambda item: (item["time"], item["index"]), reverse=True)
        return items

    # -- MAC 0x12xx 扩展（0x120F/0x122A/0x122D/0x122E/0x123D/0x123E）------

    def _mac(self):
        from tdx_mac_ext import open_session

        if getattr(self, "_mac_session", None) is None:
            self._mac_session = open_session()
        return self._mac_session

    def _mac_request(self, command: int, payload: bytes) -> bytes:
        """MAC 请求带一次重连：长连接空闲被服务端断开后不至于永久失败。"""
        last: Exception | None = None
        for attempt in range(2):
            try:
                return self._mac().request(command, payload)
            except (OSError, MacError) as error:
                last = error
                if self._mac_session is not None:
                    try:
                        self._mac_session.close()
                    except Exception:
                        pass
                    self._mac_session = None
                if attempt == 0:
                    continue
        raise MacError(f"MAC 请求失败：{last}") from last

    def server_info(self) -> dict:
        """7709 握手信息（服务器日期/两段交易时段/服务器名/产品标识）。"""
        if self.conn.sock is None:
            self.conn._connect()
        return dict(getattr(self.conn, "handshake", {"available": False}))

    def mac_server_info(self) -> dict:
        from tdx_mac_ext import parse_server_info, DEFAULT_SERVER_INFO_PAYLOAD

        body = self._mac_request(0x120F, bytes(DEFAULT_SERVER_INFO_PAYLOAD))
        return parse_server_info(body)

    def market_status(self, force: bool = False) -> dict:
        """TDX 交易日历状态：官方节假日文件 + MAC 0x120F。

        每个自然日只请求一次 0x120F（首次/跨日/force）；同一天内复用落盘
        状态。网络失败时保留上一份，错误挂在状态里，前端仍可按工作日兜底。
        """
        now = datetime.now(SHANGHAI_TZ)
        state = trading_calendar.snapshot()
        today = now.date().isoformat()
        need_refresh = force or state is None or state.today != today
        if need_refresh:
            try:
                info = self.mac_server_info()
                server_today = str(info.get("today") or today)[:10]
                last = str(info.get("lastTradingDay") or server_today)[:10]
                trading_calendar.update(
                    server_today,
                    last,
                    "TDX MAC 0x120F + Except<year>.zip holidays",
                )
            except Exception as error:  # noqa: BLE001 - 日历失败不能阻断行情
                trading_calendar.record_error(str(error))
        result = trading_calendar.status(now, self._user_holidays())
        _time, session = shanghai_clock(now)
        result.update({"time": _time, "date": today, "session": session})
        return result

    @staticmethod
    def _user_holidays() -> set[str]:
        """可选的本机追加休市日；与离线同步共用同一个文件。"""
        path = pythontdx_data_dir() / "trading_holidays.json"
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return set()
        values = payload.get("holidays") if isinstance(payload, dict) else payload
        if not isinstance(values, list):
            return set()
        return {
            str(value).strip()[:10]
            for value in values
            if isinstance(value, str) and len(str(value).strip()) >= 10
        }

    def mac_symbol_info(self, code: str) -> dict:
        from tdx_mac_ext import _symbol_info_request, parse_symbol_info

        market, symbol = parse_code(code)
        body = self._mac_request(0x122A, _symbol_info_request(market, symbol))
        return parse_symbol_info(body)

    def mac_quote_detail(self, code: str, date: int = 0) -> dict:
        from tdx_mac_ext import _quote_detail_request, parse_quote_detail

        market, symbol = parse_code(code)
        body = self._mac_request(0x122D, _quote_detail_request(market, symbol, date))
        return parse_quote_detail(body)

    def mac_kline(
        self,
        code: str,
        period: str = "day",
        start: int = 0,
        count: int = 800,
        adjust: str = "none",
        keep_first: bool = False,
        pre_close_hint: float | None = None,
    ) -> dict:
        from tdx_mac_ext import MAC_PERIODS, _bars_request, parse_symbol_bars

        if period not in MAC_PERIODS:
            raise TdxError(f"MAC 不支持周期：{period}")
        market, symbol = parse_code(code)
        adjust_raw = {"none": 0, "qfq": 1, "hfq": 2}.get(adjust, 0)
        body = self._mac_request(
            0x122E,
            _bars_request(market, symbol, MAC_PERIODS[period], start, count, adjust_raw, 1),
        )
        result = parse_symbol_bars(body, keep_first, pre_close_hint)
        result["source"] = "mac"
        return result

    def mac_full_kline(
        self, code: str, period: str = "day", adjust: str = "none"
    ) -> dict:
        """MAC 0x122E 分页拉全历史，写与 7709 相同的 `*_all_*.parquet`。"""
        market, symbol = parse_code(code)
        page_size = 800
        # MAC 的 start 是 u32（7709 的 0x052d 才是 u16）；5 秒线全历史需要更大空间。
        max_pages = 400
        start = 0
        pages = 0
        by_date: dict[str, dict] = {}
        complete = False
        last_close: float | None = None
        while start <= 0xFFFFFFFF and pages < max_pages:
            page = self.mac_kline(
                code,
                period,
                start,
                page_size,
                adjust,
                keep_first=True,
                pre_close_hint=last_close,
            )["bars"]
            if not page:
                complete = True
                break
            pages += 1
            fresh = 0
            for bar in page:
                if bar["date"] not in by_date:
                    fresh += 1
                by_date[bar["date"]] = bar
            if fresh == 0:
                break
            if page:
                last_close = float(page[-1].get("close") or 0.0)
            start += len(page)
        bars = sorted(by_date.values(), key=lambda bar: bar["date"])
        if not bars:
            cached = _read_kline_cache(code, period, 800, adjust)
            if cached is not None:
                return cached
            raise TdxError("MAC 未返回 K 线数据")
        target = _write_full_kline_cache(
            code, period, adjust, bars, pages, complete, source="mac"
        )
        return {
            "code": code,
            "period": period,
            "adjust": adjust,
            "bars": bars,
            "source": "mac",
            "pages": pages,
            "complete": complete,
            "cachePath": str(target),
            "fetchedAt": int(time.time() * 1000),
        }

    def mac_board_members(
        self, board: str, start: int = 0, page_size: int = 80
    ) -> dict:
        from tdx_mac_ext import fetch_board_members

        return fetch_board_members(self._mac(), board, start, page_size)

    def mac_file_meta(self, filename: str) -> dict:
        from tdx_mac_ext import fetch_file_meta

        return fetch_file_meta(self._mac(), filename)

    def mac_file_chunk(
        self, filename: str, index: int = 1, offset: int = 0, size: int = 30000
    ) -> dict:
        from tdx_mac_ext import fetch_file_chunk

        result = fetch_file_chunk(self._mac(), filename, index, offset, size)
        result["dataHex"] = result.pop("data").hex()
        return result

    def mac_kline_offset(self, offset: int = 0, count: int = 128000) -> dict:
        from tdx_mac_ext import fetch_kline_offset

        return fetch_kline_offset(self._mac(), offset, count)

    def mac_auctions(self, code: str, start: int = 0, count: int = 500) -> dict:
        from tdx_mac_ext import _auction_request, parse_auctions

        market, symbol = parse_code(code)
        body = self._mac_request(0x123D, _auction_request(market, symbol, start, count))
        return parse_auctions(body)

    def mac_tick_charts(self, code: str, date: int = 0, days: int = 5) -> dict:
        from tdx_mac_ext import _tick_charts_request, parse_tick_charts

        market, symbol = parse_code(code)
        body = self._mac_request(0x123E, _tick_charts_request(market, symbol, date, days))
        return parse_tick_charts(body, days)

    def mac_minute_archive_save(self, code: str) -> dict:
        """MAC 0x123E 当日分时写与 0x0537 相同的按代码分片归档。"""
        result = self.mac_tick_charts(code, 0, 1)
        if not result.get("days"):
            raise TdxError("MAC 未返回分时数据")
        # 只用最新的一天，并确认它确实是今天；否则会把旧日分时写成 today_minute。
        day = result["days"][-1]
        today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
        if day.get("date") != today:
            raise TdxError(f"MAC 分时最新日期 {day.get('date')} 不是今天 {today}")
        rows = [
            {
                "code": result["code"],
                "date": day["date"],
                "time": point["time"],
                "price": point["price"],
                "avg": point["avg"],
                "volume": point["volume"],
            }
            for point in day["points"]
        ]
        if not rows:
            raise TdxError("MAC 分时数据为空")
        return {
            "code": result["code"],
            "date": day["date"],
            "rows": len(rows),
            "archive": write_code_archive(
                pythontdx_data_dir() / "lake" / "today_minute",
                "today_minute",
                result["code"],
                rows,
                source="TDX MAC 0x123e",
                trade_date=day["date"],
                fields=["code", "date", "time", "price", "avg", "volume"],
            ),
        }

    # -- 0x0563 / 0x053f / 0x051a（docs/16 L2/L3/M5）----------------------

    def unusual(self, count: int = 600, market: int | None = None) -> list[dict]:
        """7709 0x0563 主力监控；默认沪深合并，按时间倒序。"""
        try:
            self.index.ensure(self.conn)
        except Exception as error:  # noqa: BLE001 - 名称缺失不影响事件本身
            print(f"[tdx] 主力监控代码表加载失败：{error}", file=sys.stderr)
        markets = [market] if market in (0, 1, 2) else [0, 1]
        search_start = 0
        rows: list[dict] = []
        for item in markets:
            body = self.conn.request(
                CMD_UNUSUAL, unusual_data(int(item), start=search_start, count=count)
            )
            for row in parse_unusual(body):
                row["name"] = self._name(row["code"], row["symbol"])
                rows.append(row)
        rows.sort(key=lambda row: (row["time"], row["index"]), reverse=True)
        return rows

    def top_board(self, category: int = 0, size: int = 20) -> dict:
        """0x053f 排行榜：一次请求拿 9 个榜单。"""
        try:
            self.index.ensure(self.conn)
        except Exception as error:  # noqa: BLE001
            print(f"[tdx] 排行榜代码表加载失败：{error}", file=sys.stderr)
        body = self.conn.request(CMD_TOP_BOARD, top_board_data(category, size))
        result = parse_top_board(body)
        for rows in result["boards"].values():
            for row in rows:
                row["name"] = self._name(row["code"], row["symbol"]) if row.get("symbol") else row["code"]
        return {"category": category, "requestedSize": size, **result}

    def volume_profile(self, code: str) -> dict:
        """0x051a 成交分布（筹码分布）+ 三档盘口 + 内外盘。"""
        market, symbol = parse_code(code)
        body = self.conn.request(
            CMD_VOLUME_PROFILE, volume_profile_data(market, symbol)
        )
        result = parse_volume_profile(body)
        result.update(
            {
                "code": full_code(market, symbol),
                "market": MARKET_NAMES.get(market, ""),
                "name": self._name(code, symbol),
            }
        )
        return result

    def unusual_archive_save(self, count: int = 600) -> dict:
        rows = self.unusual(count)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return {
            "rows": len(rows),
            "archive": write_dataset_archive(
                pythontdx_data_dir() / "lake" / "unusual",
                "unusual",
                rows,
                source="TDX 7709 0x0563 主力监控",
                trade_date=trade_date,
                fields=[
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
            ),
        }

    def unusual_archive_list(self, limit: int = 50) -> list[dict]:
        return list_dataset_archives(pythontdx_data_dir() / "lake" / "unusual", limit)

    def top_board_archive_save(self, category: int = 0, size: int = 20) -> dict:
        result = self.top_board(category, size)
        rows = [
            {
                "board": name,
                "category": category,
                "code": row.get("code"),
                "name": row.get("name"),
                "price": row.get("price"),
                "value": row.get("value"),
            }
            for name, items in result["boards"].items()
            for row in items
        ]
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return {
            "category": category,
            "size": result["size"],
            "rows": len(rows),
            "archive": write_code_archive(
                pythontdx_data_dir() / "lake" / "top_board",
                "top_board",
                f"c{category}_s{size}",
                rows,
                source=f"TDX 7709 0x053f category={category}",
                trade_date=trade_date,
                fields=["board", "category", "code", "name", "price", "value"],
            ),
        }

    def top_board_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "top_board", limit
        )

    def volume_profile_archive_save(self, code: str) -> dict:
        result = self.volume_profile(code)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        rows = [
            {
                "code": result["code"],
                "name": result["name"],
                "price": point["price"],
                "volume": point["volume"],
                "buy": point["buy"],
                "sell": point["sell"],
            }
            for point in result["profile"]
        ]
        if not rows:
            raise TdxError("成交分布为空，不能归档")
        return {
            "code": result["code"],
            "count": result["count"],
            "rows": len(rows),
            "archive": write_code_archive(
                pythontdx_data_dir() / "lake" / "volume_profile",
                "volume_profile",
                result["code"],
                rows,
                source="TDX 7709 0x051a 成交分布",
                trade_date=trade_date,
                fields=["code", "name", "price", "volume", "buy", "sell"],
            ),
        }

    def volume_profile_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "volume_profile", limit
        )

    def quotes(self, codes: list[str]) -> list[dict]:
        try:
            return self._quotes_7709(codes)
        except Exception as error:  # noqa: BLE001 - 只在主通道失败时兜底
            return self._mac_fallback(codes, error)

    def snapshots(self, codes: list[str]) -> list[dict]:
        try:
            return self._snapshots_7709(codes)
        except Exception as error:  # noqa: BLE001
            return self._mac_fallback(codes, error)

    def refresh_quotes(
        self, codes: list[str], cursors: dict[str, int] | None = None
    ) -> list[dict]:
        try:
            return self._refresh_quotes_7709(codes, cursors)
        except Exception as error:  # noqa: BLE001
            return self._mac_fallback(codes, error)

    def live_quotes(self, codes: list[str]) -> list[dict]:
        """实时行情编排：Electron IPC、HTTP、SSE/WebSocket 共用这一份实现。

        主链路 0x0547：首次游标 0 建基线，后续按 updateTime 推进；没有新成交时
        服务端返回 0 条，Python 复用上一帧。0x054c 快照负责价格新鲜度（约 1 秒），
        盘中用它覆盖价格/量/额，保留 0x0547 的五档深度。集合竞价（09:15–09:30）
        和开盘首 10 秒以快照为准，并用 0x056a 虚拟撮合价兜底。

        编排放在 bridge 内而不是各自的调用方，避免 Electron 与 Web 两套逻辑漂移；
        游标状态本来也在这里，不需要跨进程往返搬运中间结果。
        """
        unique = _normalize_codes(codes)
        if not unique:
            return []

        now, session = shanghai_clock()
        pre_open = session == "pre-open"
        opening_window = pre_open or (
            session == "trading" and now <= OPENING_GRACE_UNTIL
        )

        try:
            snapshots = self.snapshots(unique)
        except Exception:  # noqa: BLE001 - 快照失败仍可走 0x0547
            snapshots = []

        refreshed: list[dict] = []
        if not opening_window or len(snapshots) < len(unique):
            try:
                refreshed = self.refresh_quotes(unique)
            except Exception:  # noqa: BLE001 - 保持已有快照，走 MAC 兜底
                refreshed = []

        quotes = (
            # 竞价/开盘首秒快照优先：0x0547 的缓存帧可能是昨收或更早的竞价值
            _merge_quotes(refreshed, snapshots)
            if opening_window
            else _merge_snapshot_prices(snapshots, refreshed)
        )

        if pre_open:
            by_code = {quote.get("code"): quote for quote in quotes if quote.get("code")}
            missing = [
                code
                for code in unique
                if not float((by_code.get(code) or {}).get("price") or 0) > 0
            ]
            # 自选 <=80 只时全部取一次；超过只补缺失的，避免把主站打爆
            targets = unique if len(unique) <= AUCTION_FALLBACK_LIMIT else missing
            if targets:
                try:
                    quotes = _merge_auction_quotes(quotes, self.auction_quotes(targets))
                except Exception:  # noqa: BLE001 - 竞价兜底失败不改变已有报价
                    pass

        if not quotes:
            # 7709 刷新暂时不可用时先退到 MAC 报价，界面不至于全空
            try:
                quotes = self.mac_quotes(unique)
            except Exception:  # noqa: BLE001
                quotes = []
        if not quotes:
            # MAC 也空时再给 7709 一次重启后的机会；失败向上抛，由调用方展示
            quotes = self.refresh_quotes(unique)

        by_code = {quote.get("code"): quote for quote in quotes if quote.get("code")}
        return [by_code[code] for code in unique if code in by_code]

    def _prepare_items(self, codes: list[str]) -> tuple[list[str], list[tuple[int, str]]]:
        unique: list[str] = []
        items: list[tuple[int, str]] = []
        for raw in codes:
            code = str(raw).strip().lower()
            if not code or code in unique:
                continue
            unique.append(code)
            try:
                market, symbol = parse_code(code)
            except TdxError:
                continue
            items.append((market, symbol))
        if not items:
            raise TdxError("当前数据源暂不支持港股/美股")
        try:
            self.index.ensure(self.conn)
        except Exception as error:  # noqa: BLE001 - 代码表失败不该拖垮行情
            print(f"[tdx] 代码表加载失败：{error}", file=sys.stderr)
        return unique, items

    def _snapshots_7709(self, codes: list[str]) -> list[dict]:
        """0x054c 批量快照：现价 + 买一/卖一，适合初始化一批代码。"""
        received_at = int(time.time() * 1000)
        unique, items = self._prepare_items(codes)
        quotes: list[dict] = []
        for start in range(0, len(items), QUOTE_BATCH):
            batch = items[start : start + QUOTE_BATCH]
            body = self.conn.request(CMD_SNAPSHOT, quote_data(batch))
            quotes.extend(
                parse_snapshots(body, batch, received_at, self.index.by_code)
            )
        self._attach_finance(quotes)
        by_code = {quote["code"]: quote for quote in quotes}
        return [by_code[code] for code in unique if code in by_code]

    def _drain_quote_pushes(self) -> None:
        """读取 0x0547 未配对帧；主站不推送时这里是空操作。"""
        frames = getattr(self.conn, "push_frames", None)
        if not frames:
            return
        items: list[tuple[int, str]] = []
        for code in self.quote_watch:
            try:
                items.append(parse_code(code))
            except TdxError:
                continue
        if not items:
            return
        received_at = int(time.time() * 1000)
        while frames:
            _msg_id, msg_type, body = frames.popleft()
            if msg_type != CMD_REFRESH:
                continue
            try:
                page = parse_refresh(body, items, received_at, self.index.by_code)
            except TdxError:
                continue
            for quote in page:
                updated = quote.get("updateTime")
                if isinstance(updated, int) and updated > 0:
                    self.quote_cursors[quote["code"]] = updated
                self.quote_cache[quote["code"]] = quote

    def _refresh_quotes_7709(
        self, codes: list[str], cursors: dict[str, int] | None = None
    ) -> list[dict]:
        """0x0547 增量刷新：首次游标 0 返回五档基线；单次最多 100 只。

        服务端只为“有更新的代码”返回记录，未变化的代码返回 0 条。这里保留
        每只代码的 updateTime 作为下一次游标，并用上一帧补齐空响应；否则
        增量刷新会被误判为行情失败，UI 会退回 MAC 或清空。
        """
        today = time.strftime("%Y-%m-%d")
        if self.quote_day != today:
            self.quote_cursors.clear()
            self.quote_cache.clear()
            self.quote_watch.clear()
            self.quote_day = today
            self.quote_baseline_at = 0.0

        received_at = int(time.time() * 1000)
        unique, items = self._prepare_items(codes)
        self.quote_watch.update(unique)
        self._drain_quote_pushes()
        explicit = {
            str(code).strip().lower(): int(cursor)
            for code, cursor in (cursors or {}).items()
        }
        force_baseline = not explicit and (
            time.monotonic() - self.quote_baseline_at >= QUOTE_BASELINE_INTERVAL
        )
        by_code: dict[str, dict] = {}

        def fetch(batch: list[tuple[int, str]], cursor_for: dict[str, int]) -> None:
            body = self.conn.request(CMD_REFRESH, refresh_data(batch, cursor_for))
            for quote in parse_refresh(
                body, batch, received_at, self.index.by_code
            ):
                code = quote["code"]
                updated = quote.get("updateTime")
                if isinstance(updated, int) and updated > 0:
                    self.quote_cursors[code] = updated
                by_code[code] = quote

        for start in range(0, len(items), REFRESH_BATCH):
            batch = items[start : start + REFRESH_BATCH]
            cursor_for = {
                full_code(market, symbol): 0
                if force_baseline
                else explicit.get(
                    full_code(market, symbol),
                    self.quote_cursors.get(full_code(market, symbol), 0),
                )
                for market, symbol in batch
            }
            fetch(batch, cursor_for)
        if force_baseline:
            self.quote_baseline_at = time.monotonic()

        # 没有任何缓存的代码（首次请求/新加自选）必须补一次游标 0 基线。
        retry = [
            code for code in unique if code not in by_code and code not in self.quote_cache
        ]
        if retry:
            _, retry_items = self._prepare_items(retry)
            for start in range(0, len(retry_items), REFRESH_BATCH):
                batch = retry_items[start : start + REFRESH_BATCH]
                fetch(batch, {full_code(market, symbol): 0 for market, symbol in batch})

        result: list[dict] = []
        for code in unique:
            quote = by_code.get(code) or self.quote_cache.get(code)
            if quote is not None:
                result.append(quote)
        self._attach_finance(result)
        for quote in result:
            self.quote_cache[quote["code"]] = quote
        self._drain_quote_pushes()
        return result

    def category_quotes(
        self,
        category: int = 6,
        sort_type: int = 0,
        start: int = 0,
        count: int = 80,
        ascending: bool = False,
        filter_raw: int = 0,
        with_finance: bool = True,
    ) -> list[dict]:
        """0x054b 分类行情：服务端排序，一页最多 80 条；category=6 沪深 A 股。

        `with_finance=False` 跳过市盈率等财务附加，只给涨跌家数这类纯统计用：
        财务要额外 0x0010 往返，5000+ 只会让整轮扫描慢一倍。
        """
        received_at = int(time.time() * 1000)
        try:
            self.index.ensure(self.conn)
        except Exception as error:  # noqa: BLE001 - 代码表失败不该拖垮行情
            print(f"[tdx] 代码表加载失败：{error}", file=sys.stderr)
        body = self.conn.request(
            CMD_CATEGORY,
            category_data(
                category=category,
                sort_type=sort_type,
                start=start,
                count=count,
                ascending=ascending,
                filter_raw=filter_raw,
            ),
        )
        quotes = parse_category_quotes(body, received_at, self.index.by_code)
        if with_finance:
            self._attach_finance(quotes)
        return quotes

    def category_snapshot(
        self,
        category: int = 6,
        sort_type: int = 0,
        max_pages: int = 100,
    ) -> list[dict]:
        """0x054b 全量分类行情；按空页/短页停止，按代码去重。"""
        limit = max(1, min(int(max_pages), 200))
        by_code: dict[str, dict] = {}
        for page_index in range(limit):
            page = self.category_quotes(
                category=category,
                sort_type=sort_type,
                start=page_index * 80,
                count=80,
            )
            for quote in page:
                by_code[quote["code"]] = quote
            if len(page) < 80:
                break
        return list(by_code.values())

    def category_archive_save(
        self, category: int = 6, sort_type: int = 0
    ) -> dict:
        rows = self.category_snapshot(category, sort_type)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return {
            "category": category,
            "sortType": sort_type,
            "rows": len(rows),
            # 不同 category/sort 是不同快照，必须按 key 分片；旧布局同一天
            # 只会留下第一个 category，其余直接 skipped。
            "archive": _write_keyed_archive(
                pythontdx_data_dir() / "lake" / "category_quotes",
                "category_quotes",
                f"c{int(category)}_s{int(sort_type)}",
                rows,
                source=f"TDX 7709 0x054b category={category} sort={sort_type}",
                trade_date=trade_date,
            ),
        }

    def category_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "category_quotes", limit
        )

    def _all_category_quotes(self, with_finance: bool = True) -> list[dict]:
        if self.screen_cache and self.screen_cache[0] > time.time():
            return self.screen_cache[1]
        quotes: list[dict] = []
        start = 0
        while start < 6400:
            page = self.category_quotes(
                category=6,
                sort_type=0x000E,
                start=start,
                count=80,
                with_finance=with_finance,
            )
            quotes.extend(page)
            if len(page) < 80:
                break
            start += 80
        self.screen_cache = (time.time() + 60, quotes)
        return quotes

    def screen(self, filters: dict) -> dict:
        """全市场条件选股：价格/涨幅/成交额/换手/振幅/PE/PB/量比/行业。"""
        quotes = self._all_category_quotes()
        industry = str(filters.get("industry") or "").strip()
        if industry:
            data = self.industries()
            group = next((item for item in data["blocks"] if item["name"] == industry), None)
            if group is None:
                raise TdxError(f"未知行业：{industry}")
            codes = set(group["codes"])
            quotes = filter_quotes_by_codes(quotes, codes)
        matched = apply_screen(quotes, filters)
        return {
            "scanned": len(quotes),
            "matched": len(matched),
            "quotes": matched,
            "industry": industry or None,
            "sortBy": filters.get("sortBy") or "changePct",
            "generatedAt": int(time.time() * 1000),
        }

    def local_day_read(self, path: str, limit: int = 0) -> dict:
        """读取本地通达信 .day 日线文件（只读）。"""
        return read_local_file(path, limit)

    def local_day_write(self, path: str, bars: list[dict]) -> dict:
        """写本地 .day（原子替换）。"""
        return write_day_file(path, bars)

    def local_min_write(self, path: str, bars: list[dict]) -> dict:
        """写本地 .lc1/.lc5/.5（原子替换）。"""
        return write_min_file(path, bars)

    def lake_archives(self, limit: int = 20) -> list[dict]:
        return list_snapshot_archives(pythontdx_data_dir() / "lake" / "quotes", limit)

    def dataset_archive_read(self, dataset: str, trade_date: str) -> dict:
        return read_dataset_archive(
            pythontdx_data_dir() / "lake" / str(dataset),
            str(dataset),
            str(trade_date),
        )

    def archive_snapshot(self) -> dict:
        """把全市场 A 股快照归档到数据湖 lake/quotes/trade_date=/。"""
        now = datetime.now().astimezone()
        trade_date = now.strftime("%Y-%m-%d")
        target = pythontdx_data_dir() / "lake" / "quotes" / f"trade_date={trade_date}"
        manifest_path = target / "manifest.json"
        if manifest_path.is_file():
            try:
                manifest = json.loads(manifest_path.read_text("utf-8"))
                return {
                    "dir": str(target.resolve()),
                    "rows": int(manifest.get("rows") or 0),
                    "sha256": str(manifest.get("sha256") or ""),
                    "generatedAt": str(manifest.get("generatedAt") or ""),
                    "tradeDate": str(manifest.get("tradeDate") or trade_date),
                    "skipped": True,
                }
            except (OSError, ValueError):
                pass
        codes = []
        for item in self.code_list():
            symbol = str(item.get("symbol") or "")
            market = str(item.get("market") or "")
            if item.get("kind") != "GP-A":
                continue
            if market == "SH" and not re.match(r"^(600|601|603|605|688|689)", symbol):
                continue
            if market == "SZ" and not re.match(r"^(000|001|002|003|300|301|302)", symbol):
                continue
            if market == "BJ" and not re.match(r"^[489]", symbol):
                continue
            if market not in ("SH", "SZ", "BJ"):
                continue
            codes.append(str(item.get("code") or ""))
        quotes: list[dict] = []
        for start in range(0, len(codes), 400):
            quotes.extend(fetch_mac_quotes(codes[start : start + 400]))
        result = write_snapshot_archive(
            target,
            quotes,
            trade_date,
            now.isoformat(timespec="seconds"),
        )
        result["quotes"] = len(quotes)
        return result

    def export_klines(
        self, codes: list[str], period: str = "day", count: int = 240, adjust: str = "qfq"
    ) -> dict:
        """批量导出 K 线到数据目录 exports/klines/<时间戳>/（CSV + JSONL.gz + manifest）。"""
        unique = []
        for raw in codes:
            code = str(raw).strip().lower()
            if code and code not in unique:
                unique.append(code)
        unique = unique[:50]
        if not unique:
            raise TdxError("没有可导出的代码")
        safe_count = max(1, min(800, int(count)))
        bars_by_code: dict[str, list[dict]] = {}
        failed: list[dict] = []
        for code in unique:
            try:
                result = self.kline(code, period, safe_count, adjust)
                bars_by_code[code] = result["bars"]
            except Exception as error:  # noqa: BLE001 - 单只失败不拖垮整批
                failed.append({"code": code, "error": str(error)})
        if not bars_by_code:
            raise TdxError("全部代码导出失败")
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
        generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
        result = write_kline_export(
            pythontdx_data_dir() / "exports" / "klines" / stamp,
            bars_by_code,
            period,
            adjust,
            generated_at,
        )
        result["failed"] = failed
        return result

    def local_import(self, path: str) -> dict:
        """把本地行情文件导入数据湖（原始 + JSONL.gz + SQLite + manifest）。"""
        return import_local_file(path, pythontdx_data_dir() / "local")

    def _breadth_limits(self, quotes: list[dict]) -> tuple[int, int]:
        up = down = 0
        for quote in quotes:
            prev = quote.get("prevClose")
            price = quote.get("price")
            high = quote.get("high")
            low = quote.get("low")
            if not all(isinstance(value, (int, float)) for value in (prev, price, high, low)):
                continue
            if prev <= 0 or price <= 0:
                continue
            pct = limit_percent(str(quote.get("code") or ""), str(quote.get("name") or ""))
            up_limit = round(prev * (1 + pct / 100), 2)
            down_limit = round(prev * (1 - pct / 100), 2)
            if high >= up_limit - 0.005 and price >= up_limit - 0.005:
                up += 1
            if low <= down_limit + 0.005:
                down += 1
        return up, down

    def _breadth_counts(self, quotes: list[dict]) -> dict:
        up = down = flat = 0
        for quote in quotes:
            value = quote.get("changePct")
            if not isinstance(value, (int, float)):
                continue
            if value > 0:
                up += 1
            elif value < 0:
                down += 1
            else:
                flat += 1
        limit_up, limit_down = self._breadth_limits(quotes)
        return {
            "up": up,
            "down": down,
            "flat": flat,
            "limitUp": limit_up,
            "limitDown": limit_down,
            "total": up + down + flat,
        }

    def breadth_begin(self) -> dict:
        """开始/复用一轮涨跌家数扫描。

        缓存仍有效时直接返回最终结果；否则返回 scanId，由调用方分步调用
        `breadth_step`。桌面主进程靠「一条命令一步」在页间插入图表请求，
        Web 服务端则在每步之间释放行情锁。
        """
        with self._breadth_lock:
            now = time.monotonic()
            day = shanghai_day()
            if (
                self._breadth_cache is not None
                and self._breadth_day == day
                and now - self._breadth_at < breadth_ttl()
            ):
                return {"done": True, "result": self._breadth_cache}
            # 客户端中途放弃（超时/关标签页）会留下半轮扫描；超过 60 秒就作废，
            # 避免把几分钟前的页计数和现在的页拼在一起。
            stale = (
                self._breadth_scan is not None
                and now - float(self._breadth_scan.get("at", now)) > 60.0
            )
            if self._breadth_scan is None or stale:
                self._breadth_scan_id += 1
                self._breadth_scan = {
                    "id": self._breadth_scan_id,
                    "start": 0,
                    "at": now,
                    "up": 0,
                    "down": 0,
                    "flat": 0,
                    "limitUp": 0,
                    "limitDown": 0,
                }
            return {"done": False, "scanId": self._breadth_scan["id"]}

    def breadth_step(self, scan_id: int, pages: int = 8) -> dict:
        """扫描最多 pages 页（默认 8 页=640 只），返回累计结果或下一步游标。"""
        pages = max(1, min(20, int(pages)))
        with self._breadth_lock:
            scan = self._breadth_scan
            if scan is None or scan["id"] != int(scan_id):
                raise TdxError("涨跌家数扫描已失效，请重新开始")
            start = int(scan["start"])
            up = int(scan["up"])
            down = int(scan["down"])
            flat = int(scan["flat"])
            limit_up = int(scan["limitUp"])
            limit_down = int(scan["limitDown"])
            done = False
            for _ in range(pages):
                if start >= 6400:
                    done = True
                    break
                page = self.category_quotes(
                    category=6,
                    sort_type=0x000E,
                    start=start,
                    count=80,
                    with_finance=False,
                )
                if not page:
                    done = True
                    break
                counts = self._breadth_counts(page)
                up += counts["up"]
                down += counts["down"]
                flat += counts["flat"]
                limit_up += counts["limitUp"]
                limit_down += counts["limitDown"]
                start += len(page)
                if len(page) < 80:
                    done = True
                    break
            if done:
                result = {
                    "up": up,
                    "down": down,
                    "flat": flat,
                    "limitUp": limit_up,
                    "limitDown": limit_down,
                    "total": up + down + flat,
                    "updatedAt": int(time.time() * 1000),
                }
                self._breadth_cache = result
                self._breadth_at = time.monotonic()
                self._breadth_day = shanghai_day()
                self._breadth_scan = None
                return {"done": True, "result": result}
            scan.update(
                {
                    "start": start,
                    "up": up,
                    "down": down,
                    "flat": flat,
                    "limitUp": limit_up,
                    "limitDown": limit_down,
                }
            )
            return {"done": False, "nextStart": start}

    def formula_backtest(
        self,
        expression: str,
        scope: int = 100,
        offset: int = 0,
        batch_size: int = 100,
        fee_rate: float = 0.0003,
    ) -> dict:
        """按公式做全市场/前 N 的等权组合回测（分块）。"""
        quotes = self._all_category_quotes()
        ranked = sorted(
            (quote for quote in quotes if isinstance(quote.get("amount"), (int, float))),
            key=lambda quote: float(quote.get("amount") or 0),
            reverse=True,
        )
        universe = ranked if scope <= 0 else ranked[: max(1, min(2000, int(scope)))]
        total = len(universe)
        start = max(0, min(total, int(offset)))
        end = min(total, start + max(1, min(500, int(batch_size))))
        daily: dict[str, list[float]] = {}
        trades = 0
        stocks = 0
        for quote in universe[start:end]:
            try:
                series = self.kline(quote["code"], "day", 120)
                bars = series["bars"]
                values = evaluate_series(expression, bars)
            except (TdxError, FormulaError):
                continue
            if len(bars) < 2:
                continue
            stocks += 1
            previous = False
            for index in range(1, len(bars)):
                position = values[index - 1] > 0
                day_return = (
                    bars[index]["close"] / bars[index - 1]["close"] - 1
                    if position and bars[index - 1]["close"] > 0
                    else 0.0
                )
                if position != previous:
                    day_return -= fee_rate
                    trades += 1
                    previous = position
                bucket = daily.setdefault(bars[index]["date"], [0.0, 0.0])
                bucket[0] += day_return
                bucket[1] += 1
        return {
            "scanned": end - start,
            "total": total,
            "nextOffset": end,
            "done": end >= total,
            "trades": trades,
            "stocks": stocks,
            "daily": [
                {"date": date, "sum": round(values[0], 8), "count": int(values[1])}
                for date, values in sorted(daily.items())
            ],
            "expression": expression,
            "generatedAt": int(time.time() * 1000),
        }

    def formula_screen(
        self,
        expression: str,
        scope: int = 100,
        limit: int = 100,
        offset: int = 0,
        batch_size: int = 100,
    ) -> dict:
        """公式选股：按成交额取前 scope 只；offset/batch_size 支持分块扫描。"""
        quotes = self._all_category_quotes()
        ranked = sorted(
            (quote for quote in quotes if isinstance(quote.get("amount"), (int, float))),
            key=lambda quote: float(quote.get("amount") or 0),
            reverse=True,
        )
        universe = ranked if scope <= 0 else ranked[: max(1, min(2000, int(scope)))]
        total = len(universe)
        start = max(0, min(total, int(offset)))
        end = min(total, start + max(1, min(500, int(batch_size))))
        matches = []
        for quote in universe[start:end]:
            try:
                series = self.kline(quote["code"], "day", 120)
                latest = evaluate_formula(expression, series["bars"])
            except (TdxError, FormulaError):
                continue
            if latest > 0:
                matches.append({**quote, "formulaValue": latest})
        matched = matches[: max(1, min(200, int(limit)))]
        return {
            "scanned": end - start,
            "total": total,
            "nextOffset": end,
            "done": end >= total,
            "matched": len(matches),
            "quotes": matched,
            "expression": expression,
            "generatedAt": int(time.time() * 1000),
        }

    def trades(
        self,
        code: str,
        start: int = 0,
        count: int = TRADE_PAGE,
        trading_date: str | None = None,
    ) -> list[dict]:
        """成交明细：历史日期优先读本地归档，其次 MAC 0x122F，最后 0x0fc5/0x0fc6。"""
        if trading_date:
            try:
                archive = read_tick_archive(
                    pythontdx_data_dir() / "lake" / "ticks",
                    code,
                    trading_date,
                )
                return archive["ticks"][start : start + count]
            except FileNotFoundError:
                pass
            except TickArchiveError as error:
                # 归档损坏不应阻断网络兜底；下次归档时允许替换损坏副本。
                print(f"[tdx] 逐笔归档损坏，回退网络：{error}", file=sys.stderr)
        else:
            # 周末/收盘后实时接口只能重复返回上一交易日；直接读归档，首屏不用等网络。
            try:
                latest = latest_tick_archive(
                    pythontdx_data_dir() / "lake" / "ticks", code
                )
                if prefer_tick_archive(datetime.now(), latest["tradeDate"]):
                    return latest["ticks"][start : start + count]
            except FileNotFoundError:
                pass
            except TickArchiveError as error:
                print(f"[tdx] 逐笔归档损坏，回退实时：{error}", file=sys.stderr)
        try:
            rows: list[dict] = []
            offset = start
            remaining = count
            while remaining > 0:
                page = fetch_mac_transactions(
                    code,
                    trading_date,
                    start=offset,
                    count=min(1000, remaining),
                )
                if not page:
                    break
                rows.extend(page)
                offset += len(page)
                remaining -= len(page)
                if len(page) < min(1000, remaining + len(page)):
                    break
            if rows:
                rows.sort(
                    key=lambda item: item.get(
                        "timeSeconds", int(item.get("timeMinutes", 0)) * 60
                    )
                )
                return rows
        except Exception as error:  # noqa: BLE001 - MAC 失败时保留 7709 兜底
            print(f"[tdx] MAC 秒级明细失败，回退 7709：{error}", file=sys.stderr)

        market, symbol = parse_code(code)
        try:
            self.index.ensure(self.conn)
        except Exception as error:  # noqa: BLE001 - 代码表失败不该拖垮明细
            print(f"[tdx] 代码表加载失败：{error}", file=sys.stderr)
        command = CMD_HISTORY_TICKS if trading_date else CMD_TODAY_TICKS
        body = self.conn.request(
            command,
            trades_data(market, symbol, start, count, trading_date),
        )
        return parse_trades(
            body, market, symbol, start, self.index.by_code, trading_date
        )

    def tick_archive_save(self, code: str, trading_date: str) -> dict:
        """把一只股票某交易日的全部逐笔归档到 lake/ticks；已有有效归档不覆盖。"""
        try:
            normalized_code = normalize_tick_code(code)
            target_date = normalize_tick_date(trading_date)
        except TickArchiveError as error:
            raise TdxError(str(error)) from error
        root = pythontdx_data_dir() / "lake" / "ticks"
        try:
            existing = read_tick_archive(root, normalized_code, target_date)
            return {
                "code": existing["code"],
                "tradeDate": existing["tradeDate"],
                "rows": existing["rows"],
                "dir": existing["dir"],
                "sha256": existing["sha256"],
                "generatedAt": existing["generatedAt"],
                "source": "archive",
                "found": True,
                "skipped": True,
            }
        except FileNotFoundError:
            pass
        except TickArchiveError:
            # 损坏副本允许被完整重抓覆盖；正常归档在 write 里会再次校验。
            pass

        rows: list[dict] = []
        seen: set[int] = set()
        offset = 0
        for _ in range(400):
            page = self.trades(
                normalized_code,
                start=offset,
                count=TRADE_PAGE,
                trading_date=target_date,
            )
            if not page:
                break
            fresh = [item for item in page if int(item.get("index", -1)) not in seen]
            if not fresh:
                break
            for item in fresh:
                seen.add(int(item.get("index", -1)))
            rows.extend(fresh)
            offset += len(page)
            if len(page) < TRADE_PAGE:
                break
        if not rows:
            raise TdxError(f"{normalized_code} {target_date} 没有可归档的逐笔数据")
        rows.sort(
            key=lambda item: (
                int(item.get("timeSeconds", int(item.get("timeMinutes", 0)) * 60)),
                int(item.get("index", 0)),
            )
        )
        return write_tick_archive(root, normalized_code, target_date, rows)

    def tick_archive_dates(
        self,
        code: str,
        start_date: str | None = None,
        end_date: str | None = None,
        days: int = 20,
    ) -> list[str]:
        """用 1 分钟 K 的交易日做逐笔索引；默认只保留最近 20 个交易日。"""
        cached = _full_kline_cache_path(code, "1m", "none")
        if cached.is_file():
            try:
                bars = read_bars(cached)["bars"]
            except ParquetStoreError:
                bars = []
        else:
            result = self.full_kline(code, "1m", "none")
            bars = result.get("bars") or []
        dates = sorted(
            {
                str(bar.get("date") or "")[:10]
                for bar in bars
                if str(bar.get("date") or "")[:10]
            }
        )
        if start_date:
            dates = [value for value in dates if value >= start_date]
        if end_date:
            dates = [value for value in dates if value <= end_date]
        if days > 0:
            dates = dates[-max(1, int(days)) :]
        return dates

    def tick_archive_read(
        self, code: str, trading_date: str, start: int = 0, count: int = 1800
    ) -> dict:
        try:
            archive = read_tick_archive(
                pythontdx_data_dir() / "lake" / "ticks", code, trading_date
            )
        except FileNotFoundError as error:
            raise TdxError(str(error)) from error
        except TickArchiveError as error:
            raise TdxError(str(error)) from error
        start = max(0, int(start))
        count = max(1, min(1800, int(count)))
        return {
            **archive,
            "ticks": archive["ticks"][start : start + count],
        }

    def tick_archive_list(self, limit: int = 20) -> list[dict]:
        return list_tick_archives(pythontdx_data_dir() / "lake" / "ticks", limit)

    def tick_archive_batch(self, codes: list[str], trading_date: str) -> dict:
        """批量归档；单只失败不阻断其他股票，返回 saved/failed。"""
        try:
            target_date = normalize_tick_date(trading_date)
        except TickArchiveError as error:
            raise TdxError(str(error)) from error
        saved: list[dict] = []
        failed: list[dict] = []
        seen: set[str] = set()
        for raw in codes:
            try:
                code = normalize_tick_code(raw)
            except TickArchiveError as error:
                failed.append({"code": str(raw), "error": str(error)})
                continue
            if code in seen:
                continue
            seen.add(code)
            try:
                saved.append(self.tick_archive_save(code, target_date))
            except Exception as error:  # noqa: BLE001 - 单只失败继续
                failed.append({"code": code, "error": str(error)})
        return {
            "tradeDate": target_date,
            "saved": saved,
            "failed": failed,
            "savedCount": len(saved),
            "failedCount": len(failed),
        }

    def auctions(
        self,
        code: str,
        trading_date: str | None = None,
        selector: int = 0,
        start: int = 0,
        limit: int = AUCTION_LIMIT,
    ) -> list[dict]:
        """集合竞价过程快照：不传日期为当日，传日期为历史。"""
        market, symbol = parse_code(code)
        body = self.conn.request(
            CMD_AUCTION,
            auction_data(market, symbol, trading_date, selector, start, limit),
        )
        points = parse_auctions(body)
        if selector == 0 and points:
            target_date = trading_date or datetime.now().astimezone().strftime("%Y-%m-%d")
            try:
                write_auction_archive(
                    pythontdx_data_dir() / "lake" / "auction",
                    code,
                    target_date,
                    points,
                )
            except Exception as error:  # noqa: BLE001 - 归档失败不影响查询
                print(f"[tdx] 竞价自动归档失败：{error}", file=sys.stderr)
        if selector == 0 and not points and trading_date:
            # 服务器只保留近期竞价；历史查询为空时回退到永久本地归档。
            try:
                archived = self.auction_archive_read(code, trading_date)
                if archived.get("found") and archived.get("points"):
                    return archived["points"]
            except TdxError:
                pass
        return points

    def auction_quotes(self, codes: list[str]) -> list[dict]:
        """竞价阶段给自选/行情头兜底：返回每只票最后一个虚拟撮合点。

        0x0547/0x054c 在 09:15–09:25 对部分代码（科创板尤其明显）可能没有
        记录或价格为 0；这里直接用 0x056a 的最后一根补一个最小 Quote。
        prevClose/open/high/low 优先复用当天已有的 quote_cache，没有就只给价格。
        2 秒缓存：竞价快照本身约 3 秒一个点，1 秒轮询不必每次都打服务器。
        """
        now = time.time()
        received_at = int(now * 1000)
        results: list[dict] = []
        for raw in codes:
            code = str(raw).strip().lower()
            if not code:
                continue
            cached = self.auction_quote_cache.get(code)
            if cached and cached[0] > now:
                results.append(cached[1])
                continue
            try:
                market, symbol = parse_code(code)
                body = self.conn.request(
                    CMD_AUCTION,
                    auction_data(market, symbol, None, 0, 0, AUCTION_LIMIT),
                )
                points = parse_auctions(body)
            except Exception:  # noqa: BLE001 - 单只失败不拖垮整批
                continue
            if not points:
                continue
            last = points[-1]
            price = float(last.get("price") or 0)
            if price <= 0:
                continue
            base = self.quote_cache.get(code, {})
            prev_close = float(base.get("prevClose") or 0)
            open_price = float(base.get("open") or 0) or price
            high = max(float(base.get("high") or 0), price)
            low = min(float(base.get("low") or price), price)
            seconds = int(last.get("timeSeconds") or 0)
            hour, minute, second = seconds // 3600, seconds % 3600 // 60, seconds % 60
            quote = {
                "code": code,
                "symbol": symbol,
                "name": self._name(code, symbol),
                "market": MARKET_NAMES[market],
                "price": price,
                "prevClose": prev_close,
                "open": open_price,
                "high": high,
                "low": low,
                "change": price - prev_close if prev_close > 0 else 0.0,
                "changePct": (price - prev_close) / prev_close * 100
                if prev_close > 0
                else 0.0,
                "volume": int(base.get("volume") or 0),
                "amount": float(base.get("amount") or 0),
                "currency": "CNY",
                "time": received_at,
                "receivedAt": received_at,
                "updateTime": hour * 10000 + minute * 100 + second,
                "auction": True,
                "auctionTime": str(last.get("time") or ""),
                "bids": [],
                "asks": [],
            }
            self.auction_quote_cache[code] = (now + 2, quote)
            results.append(quote)
        return results

    def auction_archive_save(
        self, code: str, trading_date: str | None = None
    ) -> dict:
        """把一只股票的竞价点写入本地数据湖；不传日期时从分时推断交易日。"""
        points = self.auctions(
            code, trading_date=trading_date, selector=0, limit=AUCTION_LIMIT
        )
        if not points:
            raise TdxError("该日期没有可归档的竞价数据（服务器只保留最近交易日）")
        target_date = trading_date
        if not target_date:
            try:
                target_date = self.minute(code).get("date") or ""
            except Exception:  # noqa: BLE001 - 推断失败时再退回本地日期
                target_date = ""
        if not target_date:
            target_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        try:
            result = write_auction_archive(
                pythontdx_data_dir() / "lake" / "auction",
                code,
                target_date,
                points,
            )
        except AuctionArchiveError as error:
            raise TdxError(str(error)) from error
        return {**result, "points": points, "found": True}

    def auction_archive_read(self, code: str, trading_date: str) -> dict:
        """读取本地竞价归档；不存在时返回 found=false，而不是让 UI 报错。"""
        try:
            normalized_date = normalize_auction_date(trading_date)
            normalized_code = normalize_auction_code(code)
        except AuctionArchiveError as error:
            raise TdxError(str(error)) from error
        try:
            return read_auction_archive(
                pythontdx_data_dir() / "lake" / "auction",
                normalized_code,
                normalized_date,
            )
        except FileNotFoundError:
            return {
                "code": normalized_code,
                "tradeDate": normalized_date,
                "points": [],
                "rows": 0,
                "source": "archive",
                "found": False,
            }
        except AuctionArchiveError as error:
            raise TdxError(str(error)) from error

    def auction_archive_list(self, limit: int = 50) -> list[dict]:
        return list_auction_archives(
            pythontdx_data_dir() / "lake" / "auction", limit
        )

    def auction_archive_batch(
        self, codes: list[str], trading_date: str | None = None
    ) -> dict:
        """批量归档自选竞价；单只失败只记入 failed，不掩盖其他成功项。"""
        unique: list[str] = []
        failed: list[dict] = []
        seen: set[str] = set()
        for raw in codes:
            try:
                code = normalize_auction_code(raw)
            except AuctionArchiveError as error:
                failed.append({"code": str(raw), "error": str(error)})
                continue
            if code in seen:
                continue
            seen.add(code)
            unique.append(code)
        if not unique:
            return {
                "tradeDate": "",
                "saved": [],
                "failed": failed,
                "savedCount": 0,
                "failedCount": len(failed),
            }
        if trading_date:
            try:
                target_date = normalize_auction_date(trading_date)
            except AuctionArchiveError as error:
                raise TdxError(str(error)) from error
        else:
            try:
                target_date = normalize_auction_date(
                    self.minute(unique[0]).get("date") or ""
                )
            except Exception as error:  # noqa: BLE001 - 推断失败时不写错日期
                raise TdxError(f"无法确定交易日，未归档：{error}") from error
        saved: list[dict] = []
        for code in unique:
            try:
                result = self.auction_archive_save(code, target_date)
            except Exception as error:  # noqa: BLE001 - 单只失败继续
                failed.append({"code": code, "error": str(error)})
                continue
            saved.append(
                {
                    "code": code,
                    "tradeDate": result["tradeDate"],
                    "rows": result["rows"],
                    "dir": result.get("dir"),
                    "sha256": result.get("sha256"),
                }
            )
        return {
            "tradeDate": target_date,
            "saved": saved,
            "failed": failed,
            "savedCount": len(saved),
            "failedCount": len(failed),
        }

    def file_read(
        self, path: str, offset: int = 0, size: int = FILE_CHUNK
    ) -> dict:
        """服务器文件单块读取；完整下载由上层循环 offset 完成。"""
        normalized = path.strip().replace("\\", "/")
        body = self.conn.request(
            CMD_FILE_CONTENT, file_content_data(normalized, offset, size)
        )
        return parse_file_chunk(body, normalized, offset, size)

    def block_meta(self, filename: str) -> dict:
        """0x02c5 板块文件元数据（大小 + MD5）。"""
        name = str(filename or "").strip()
        body = self.conn.request(CMD_BLOCK_META, block_meta_data(name))
        return {"filename": name, **parse_block_meta(body)}

    def block_meta_archive_save(self, filename: str) -> dict:
        meta = self.block_meta(filename)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return _write_keyed_archive(
            pythontdx_data_dir() / "lake" / "server_meta",
            "block_meta",
            f"file_{meta['filename']}",
            [meta],
            source="TDX 7709 0x02c5",
            trade_date=trade_date,
            fields=["filename", "size", "md5"],
        )

    def block_meta_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "server_meta", limit
        )

    def money_flow(self, code: str) -> list[dict]:
        """0x0ffc 资金流向日数据；必须走资金流专用节点。

        成功后按交易日写 `lake/money_flow`（与 MAC 0x1218 共用目录但 payload
        带 `source` 区分）。0x0ffc 是唯一带「5 日分档」的权威源，之前只解析
        不落盘，文档却宣称已归档——这里补齐。
        """
        market, symbol = parse_code(code)
        if self.money_conn is None:
            self.money_conn = TdxConnection(MONEY_FLOW_HOSTS)
        wire_prefix = (MONEY_FLOW_CHANNEL << 8) | (MONEY_FLOW_ROUTE << 16)
        body = self.money_conn.request(
            CMD_MONEY_FLOW,
            money_flow_data(market, symbol),
            wire_prefix=wire_prefix,
        )
        records = parse_money_flow(body)
        if records and all(
            record["totalAmount"] == 0 and record["mainNet"] == 0
            for record in records
        ):
            raise TdxError("资金流节点返回空金额，请换资金流主站")
        if records:
            try:
                write_flow_archive(
                    pythontdx_data_dir() / "lake" / "money_flow",
                    full_code(market, symbol),
                    {
                        "code": full_code(market, symbol),
                        "source": "7709 0x0ffc",
                        "records": records,
                        "receivedAt": int(time.time() * 1000),
                    },
                )
            except Exception as error:  # noqa: BLE001 - 归档失败不影响查询
                print(f"[tdx] 0x0ffc 资金流归档失败：{error}", file=sys.stderr)
        return records

    def f10_catalog(self, code: str) -> list[dict]:
        """0x02cf F10 段落目录。"""
        market, symbol = parse_code(code)
        body = self.conn.request(
            CMD_F10_CATEGORY, f10_catalog_data(market, symbol)
        )
        result = parse_f10_catalog(body)
        try:
            write_f10_snapshot(
                pythontdx_data_dir() / "lake" / "f10_pit", code, "f10_catalog", result
            )
        except Exception as error:  # noqa: BLE001 - 快照失败不影响查询
            print(f"[tdx] F10 目录快照失败：{error}", file=sys.stderr)
        return result

    def f10_content(
        self, code: str, filename: str, offset: int, length: int
    ) -> str:
        """0x02d0 F10 段落正文。"""
        market, symbol = parse_code(code)
        body = self.conn.request(
            CMD_F10_CONTENT,
            f10_content_data(market, symbol, filename, offset, length),
        )
        text = parse_f10_content(body)
        try:
            write_f10_snapshot(
                pythontdx_data_dir() / "lake" / "f10_pit",
                code,
                f"f10_content_{filename}",
                text,
            )
        except Exception as error:  # noqa: BLE001 - 快照失败不影响查询
            print(f"[tdx] F10 正文快照失败：{error}", file=sys.stderr)
        return text

    def f10_announcements(self, code: str) -> list[dict]:
        """7615 TQLEX 在线公告列表（免费资料，不碰研报正文）。"""
        return fetch_announcements(code)

    def f10_profile(self, code: str) -> dict:
        """7615 TQLEX 在线公司概况。"""
        return fetch_profile(code)

    def f10_valuation(self, code: str) -> dict:
        """7615 TQLEX 在线估值。"""
        return fetch_valuation(code)

    def f10_finance(self, code: str) -> dict:
        """7615 TQLEX 财务主要指标。"""
        return fetch_finance(code)

    def f10_business(self, code: str) -> dict:
        """7615 TQLEX 主营构成。"""
        return fetch_business(code)

    def f10_shareholders(self, code: str) -> dict:
        """7615 TQLEX 十大股东。"""
        return fetch_shareholders(code)

    def f10_reports(self, code: str) -> dict:
        """7615 TQLEX 公司研报列表。"""
        return fetch_reports(code)

    def f10_news(self, code: str) -> list[dict]:
        """7615 TQLEX 公司新闻列表。"""
        return fetch_news(code)

    def f10_stock_info(self, code: str) -> dict:
        from tdx_f10 import fetch_stock_info

        return fetch_stock_info(code)

    def f10_topic_ids(self, code: str) -> dict:
        from tdx_f10 import fetch_topic_ids

        return fetch_topic_ids(code)

    def f10_finance_diagnosis(self, code: str, section: str = "zzyj") -> dict:
        from tdx_f10 import fetch_finance_diagnosis

        return fetch_finance_diagnosis(code, section)

    def f10_stock_score(self, code: str, section: str = "pf", arg: str = "") -> dict:
        from tdx_f10 import fetch_stock_score

        return fetch_stock_score(code, section, arg)

    def f10_topic_compare(
        self, code: str, topic_id: str, section: str = "gndbzfsj", sort_by: str = "zdf"
    ) -> dict:
        from tdx_f10 import fetch_topic_compare

        return fetch_topic_compare(code, topic_id, section, sort_by)

    def f10_allotment_dates(self, code: str) -> dict:
        from tdx_f10 import fetch_allotment_dates

        return fetch_allotment_dates(code)

    def f10_allotment_details(self, code: str, date: str) -> dict:
        from tdx_f10 import fetch_allotment_details

        return fetch_allotment_details(code, date)

    def f10_hq_nlp(
        self, code: str, req_id: str, days: int | None = None, page_size: int = 10
    ) -> dict:
        from tdx_f10 import fetch_hq_nlp

        return fetch_hq_nlp(code, req_id, days=days, page_size=page_size)

    def f10_industry_page(self, hy: str, section: str = "hqtj") -> dict:
        from tdx_f10 import fetch_industry_page

        return fetch_industry_page(hy, section)

    def f10_board_member_quotes(
        self, board_code: str, board_market: int = 1
    ) -> dict:
        from tdx_f10 import fetch_board_member_quotes

        return fetch_board_member_quotes(board_code, board_market)

    def f10_limit_board_ladder(
        self,
        start_date: str | None = None,
        end_date: str | None = None,
        include_summary: bool = False,
    ) -> dict:
        from tdx_f10 import fetch_limit_board_ladder

        return fetch_limit_board_ladder(start_date, end_date, include_summary)

    def f10_limit_board_archive_save(
        self, start_date: str | None = None, end_date: str | None = None
    ) -> dict:
        """涨跌停梯子按结束日期归档；表多，行里带 table 序号。"""
        from tdx_f10 import fetch_limit_board_ladder

        result = fetch_limit_board_ladder(start_date, end_date, include_summary=True)
        rows: list[dict] = []
        for name in ("detail", "summary"):
            block = result.get(name) or {}
            for index, table in enumerate(block.get("tables") or []):
                for row in table.get("rows") or []:
                    rows.append(
                        {
                            "table": f"{name}-{index}",
                            "columns": table.get("columns") or [],
                            "row": row,
                        }
                    )
        if not rows:
            raise TdxError("涨跌停梯子为空")
        raw = str(result["endDate"])
        trade_date = f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
        archive = write_dataset_archive(
            pythontdx_data_dir() / "lake" / "limit_ladder",
            "limit_ladder",
            rows,
            source="TDX 7615 CWServ.cfg_fx_lbtt",
            trade_date=trade_date,
        )
        return {"tradeDate": trade_date, "rows": len(rows), "archive": archive}

    def f10_finance_weights(self, code: str, section: str = "zcfzb") -> dict:
        from tdx_f10 import fetch_finance_weights

        return fetch_finance_weights(code, section)

    def f10_digest(self, code: str, section: str = "tips") -> dict:
        """7615 最新提示 8 分区。"""
        return fetch_digest(code, section)

    def f10_market_news(
        self, tab: int = 3, page: int = 1, page_size: int = 50
    ) -> list[dict]:
        """7615 全市场资讯首页。"""
        return fetch_market_news(tab, page, page_size)

    def f10_channel_news(
        self,
        channel: int = 201,
        page: int = 1,
        page_size: int = 50,
        keyword: str = "",
    ) -> list[dict]:
        """7615 频道资讯。"""
        return fetch_channel_news(channel, page, page_size, "1", keyword)

    def f10_channel_news_archive_save(
        self,
        channel: int = 201,
        page: int = 1,
        page_size: int = 50,
        keyword: str = "",
    ) -> dict:
        rows = self.f10_channel_news(channel, page, page_size, keyword)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        keyword_key = f"_k{hashlib.sha1(keyword.encode()).hexdigest()[:8]}" if keyword else ""
        return {
            "channel": channel,
            "rows": len(rows),
            "archive": _write_keyed_archive(
                pythontdx_data_dir() / "lake" / "channel_news",
                "channel_news",
                f"ch{int(channel)}_p{int(page)}{keyword_key}",
                rows,
                source=f"TDX 7615 CWServ.tdxi_zxxwnews channel={channel}",
                trade_date=trade_date,
                fields=["id", "title", "date", "summary", "source", "url"],
            ),
        }

    def f10_channel_news_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "channel_news", limit
        )

    def f10_market_news_archive_save(
        self, tab: int = 3, page: int = 1, page_size: int = 50
    ) -> dict:
        rows = self.f10_market_news(tab, page, page_size)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return {
            "rows": len(rows),
            "archive": _write_keyed_archive(
                pythontdx_data_dir() / "lake" / "market_news",
                "market_news",
                f"tab{int(tab)}_p{int(page)}",
                rows,
                source=f"TDX 7615 CWServ.tdxi_zxxwsy tab={tab}",
                trade_date=trade_date,
                fields=["id", "title", "date", "summary", "source", "url"],
            ),
        }

    def f10_market_news_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "market_news", limit
        )

    def f10_market_report(
        self,
        code: str = "",
        section: str = "board_info",
        arg: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> dict:
        return fetch_market_report(code, section, arg, page, page_size)

    def f10_market_report_archive_save(
        self,
        code: str = "",
        section: str = "board_info",
        arg: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> dict:
        result = self.f10_market_report(code, section, arg, page, page_size)
        rows: list[dict] = []
        for table_index, table in enumerate(result.get("tables") or []):
            columns = table.get("columns") or []
            for row_index, row in enumerate(table.get("rows") or []):
                rows.append(
                    {
                        "code": code,
                        "section": section,
                        "tableIndex": table_index,
                        "rowIndex": row_index,
                        **{str(columns[i]): value for i, value in enumerate(row) if i < len(columns)},
                    }
                )
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        arg_key = f"_a{hashlib.sha1(arg.encode()).hexdigest()[:8]}" if arg else ""
        return {
            **result,
            "archive": _write_keyed_archive(
                pythontdx_data_dir() / "lake" / "f10_market",
                "f10_market",
                f"{code or 'market'}_{section}_p{int(page)}{arg_key}",
                rows,
                source=f"TDX 7615 skef10 section={section}",
                trade_date=trade_date,
            ),
        }

    def f10_market_report_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "f10_market", limit
        )

    def f10_profit_forecast(self, code: str, section: str = "ylyctj") -> dict:
        return fetch_profit_forecast(code, section)

    def f10_governance(self, code: str, section: str = "gljy") -> dict:
        return fetch_governance(code, section)

    def f10_hot_topics(self, code: str, section: str = "zttzbkz") -> dict:
        return fetch_hot_topics(code, section)

    def f10_fund_report(
        self,
        code: str,
        section: str = "basic",
        arg: str = "",
        date: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> dict:
        return fetch_fund_report(code, section, arg, date, page, page_size)

    def f10_detail(self, detail_type: str, record_id: str) -> dict:
        return fetch_detail(detail_type, record_id)

    def f10_detail_archive_save(self, detail_type: str, record_id: str) -> dict:
        result = self.f10_detail(detail_type, record_id)
        columns = result.get("columns") or []
        source_rows = result.get("rows") or []
        rows = [
            {
                "detailType": str(detail_type),
                "recordId": str(record_id),
                "rowIndex": index,
                **{str(columns[i]): value for i, value in enumerate(row) if i < len(columns)},
            }
            for index, row in enumerate(source_rows)
        ]
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return {
            **result,
            "archive": _write_keyed_archive(
                pythontdx_data_dir() / "lake" / "f10_detail",
                "f10_detail",
                f"{detail_type}_{record_id}",
                rows,
                source=f"TDX 7615 CWServ.tdxf10_gg_idreq type={detail_type}",
                trade_date=trade_date,
            ),
        }

    def f10_detail_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "f10_detail", limit
        )

    def f10_ranking_detail(self, code: str, section: str = "scpmdela") -> dict:
        return fetch_ranking_detail(code, section)

    def f10_northbound_holding(
        self, code: str, section: str = "bszj", page: int = 1, page_size: int = 20
    ) -> dict:
        return fetch_northbound_holding(code, section, "", page, page_size)

    def f10_industry(self, code: str, section: str = "summary") -> dict:
        """7615 TQLEX 行业汇总/新闻/研报。"""
        from tdx_f10 import fetch_industry

        return fetch_industry(code, section)

    def f10_change_plans(self, code: str) -> dict:
        from tdx_f10 import fetch_change_plans

        return fetch_change_plans(code)

    def f10_controller(self, code: str) -> dict:
        from tdx_f10 import fetch_controller

        return fetch_controller(code)

    def f10_institutions(self, code: str) -> dict:
        from tdx_f10 import fetch_institutions

        return fetch_institutions(code)

    def f10_shareholder_changes(self, code: str) -> dict:
        from tdx_f10 import fetch_shareholder_changes

        return fetch_shareholder_changes(code)

    def f10_circulating_shareholders(self, code: str) -> dict:
        from tdx_f10 import fetch_circulating_shareholders

        return fetch_circulating_shareholders(code)

    def f10_capital(self, code: str, section: str) -> dict:
        from tdx_f10 import fetch_capital_structure

        return fetch_capital_structure(code, section)

    def f10_shareholder_count(self, code: str) -> dict:
        from tdx_f10 import fetch_shareholder_count

        return fetch_shareholder_count(code)

    def f10_dividend(self, code: str) -> dict:
        from tdx_f10 import fetch_dividend

        # 指数没有分红送转。7615 的 F10 只按 6 位 symbol 查，sh000001 会被当成
        # sz000001（平安银行）返回真实分红数据，于是上证指数的 K 线上会画出
        # 和平安银行一样的除权线（2026-11-01 实测）。指数一律返回空表。
        market = MARKET_IDS.get(code[:2].lower(), -1)
        if is_index_code(market, code[2:]):
            return {"columns": [], "rows": [], "count": 0}
        return fetch_dividend(code)

    def f10_market(self, section: str) -> dict:
        from tdx_f10 import fetch_market

        return fetch_market(section)

    def f10_lhb_market(self) -> dict:
        from tdx_f10 import fetch_lhb_market

        return fetch_lhb_market()

    def f10_trading(self, code: str, section: str = "margin") -> dict:
        """7615 TQLEX 两融/大宗/龙虎榜/沪深股通。"""
        return fetch_trading(code, section)

    def f10_statement(self, code: str, kind: str = "zcfzb", full: bool = False) -> dict:
        """7615 TQLEX 财务报表；full=true 返回全部原始列。"""
        return fetch_statement(code, kind, full)

    def _download_bytes(
        self,
        path: str,
        chunk_size: int = FILE_CHUNK,
        max_bytes: int = MAX_FILE_BYTES,
        conn: TdxConnection | None = None,
    ) -> tuple[bytes, int]:
        if chunk_size < 1 or chunk_size > MAX_FILE_CHUNK:
            raise TdxError("下载块大小必须在 1~60000 字节之间")
        if max_bytes < 1:
            raise TdxError("下载上限必须大于 0")

        normalized = path.strip().replace("\\", "/")
        data = bytearray()
        offset = 0
        chunks = 0
        while True:
            body = (conn or self.conn).request(
                CMD_FILE_CONTENT, file_content_data(normalized, offset, chunk_size)
            )
            chunk = parse_file_chunk(body, normalized, offset, chunk_size)
            size = chunk["chunkLen"]
            if len(data) + size > max_bytes:
                raise TdxError("服务器文件超过下载上限")
            data.extend(bytes.fromhex(chunk["contentHex"]))
            chunks += 1
            if size < chunk_size:
                break
            offset += size
        return bytes(data), chunks

    # -- 历史专业财务 gpcw（计算服务器，0x06b9）-------------------------

    FINANCE_HISTORY_HOSTS = (("120.76.152.87", 7709),)

    def _finance_conn(self) -> TdxConnection:
        if getattr(self, "_finance_history_conn", None) is None:
            self._finance_history_conn = TdxConnection(
                list(self.FINANCE_HISTORY_HOSTS)
            )
        return self._finance_history_conn

    def gbbq_read(
        self, path: str | None = None, limit: int = 5000, offset: int = 0
    ) -> dict:
        """读取本地 GBBQ；默认分页返回，避免一次把 20 万行塞进 JSON 管道。"""
        from gbbq import find_gbbq_path, read_gbbq

        target = Path(path).expanduser() if path else find_gbbq_path()
        if target is None:
            raise TdxError("未找到 gbbq 文件；请传 path 或设置 PYTHONTDX_GBBQ_PATH")
        rows = read_gbbq(target, strict=False)
        raw = target.read_bytes()
        declared = struct.unpack_from("<I", raw, 0)[0] if len(raw) >= 4 else 0
        expected_bytes = 4 + declared * 29
        start = max(0, int(offset))
        size = int(limit)
        page = rows[start:] if size <= 0 else rows[start : start + size]
        return {
            "path": str(target),
            "count": len(rows),
            "declared": declared,
            "truncated": len(raw) != expected_bytes,
            "skipped": max(0, declared - len(rows)),
            "offset": start,
            "limit": size,
            "rows": page,
            "bytes": len(raw),
        }

    def gbbq_archive_save(self, path: str | None = None) -> dict:
        """把完整 GBBQ 规范化为 lake/gbbq/trade_date=all 归档。"""
        from gbbq import find_gbbq_path, read_gbbq

        target = Path(path).expanduser() if path else find_gbbq_path()
        if target is None:
            raise TdxError("未找到 gbbq 文件；请传 path 或设置 PYTHONTDX_GBBQ_PATH")
        rows = read_gbbq(target)
        raw = target.read_bytes()
        declared = struct.unpack_from("<I", raw, 0)[0] if len(raw) >= 4 else 0
        archive = write_dataset_archive(
            pythontdx_data_dir() / "lake" / "gbbq",
            "gbbq",
            rows,
            source=f"local gbbq {target}",
            trade_date="all",
        )
        return {
            "path": str(target),
            "rows": len(rows),
            "declared": declared,
            "truncated": len(raw) != 4 + declared * 29,
            "archive": archive,
        }

    def finance_history_catalog(self) -> list[dict]:
        """gpcw.txt 清单；计算服务器不提供时返回空数组而不是伪造条目。"""
        from finance_history import parse_file_list

        data, _chunks = self._download_bytes(
            "tdxfin/gpcw.txt", max_bytes=8 * 1024 * 1024, conn=self._finance_conn()
        )
        if not data:
            raise TdxError("计算服务器未返回 tdxfin/gpcw.txt（免费节点可能不开放）")
        entries = parse_file_list(data)
        save_raw_file("gpcw.txt", data)
        return entries

    def finance_history_archive_save(self, filename: str) -> dict:
        """下载一个 gpcw zip → 解析 → 按报告期写 lake/finance_history。"""
        from finance_history import parse_zip

        normalized = str(filename or "").strip().replace("\\", "/")
        if not normalized.startswith("tdxfin/"):
            normalized = "tdxfin/" + normalized.lstrip("/")
        if not normalized.lower().endswith(".zip"):
            raise TdxError("历史财务文件必须是 gpcw*.zip")
        data, chunks = self._download_bytes(
            normalized, max_bytes=64 * 1024 * 1024, conn=self._finance_conn()
        )
        if not data:
            raise TdxError(f"计算服务器未返回 {normalized}")
        save_raw_file(Path(normalized).name, data)
        rows = parse_zip(data)
        if not rows:
            raise TdxError(f"{normalized} 没有解析出财务记录")
        report_date = rows[0]["reportDate"] or datetime.now().astimezone().strftime("%Y-%m-%d")
        archive = write_dataset_archive(
            pythontdx_data_dir() / "lake" / "finance_history",
            "finance_history",
            rows,
            source=f"TDX 0x06b9 {normalized}",
            trade_date=report_date,
        )
        return {
            "filename": normalized,
            "bytes": len(data),
            "chunks": chunks,
            "reportDate": report_date,
            "rows": len(rows),
            "fieldCount": rows[0]["fieldCount"],
            "archive": archive,
        }

    def finance_history_archive_list(self, limit: int = 50) -> list[dict]:
        return list_dataset_archives(
            pythontdx_data_dir() / "lake" / "finance_history", limit
        )

    def _zhb_bytes(self) -> tuple[bytes, dict, int]:
        """zhb.zip 的短期缓存；板块/行业/统计都要读它。"""
        if self.zhb_cache and self.zhb_cache[0] > time.time():
            _, data, saved, chunks = self.zhb_cache
            return data, saved, chunks
        data, chunks = self._download_bytes("zhb.zip")
        saved = save_raw_file("zhb.zip", data)
        self.zhb_cache = (time.time() + 600, data, saved, chunks)
        return data, saved, chunks

    def file_download(
        self,
        path: str,
        chunk_size: int = FILE_CHUNK,
        max_bytes: int = MAX_FILE_BYTES,
    ) -> dict:
        """完整下载服务器文件并写入原始数据目录。"""
        data, chunks = self._download_bytes(path, chunk_size, max_bytes)
        saved = save_raw_file(Path(path).name, data)
        return {
            "path": path,
            "bytes": len(data),
            "chunks": chunks,
            "sha256": saved["sha256"],
            "savedTo": saved["savedTo"],
        }

    def server_catalog(self) -> dict:
        """zhb.zip 已知服务器文件清单 + 与上一版差分；不是完整目录枚举。"""
        data, saved, chunks = self._zhb_bytes()
        result = write_server_catalog(
            pythontdx_data_dir() / "lake" / "server_files",
            data,
            str(saved.get("sha256") or ""),
            str(saved.get("savedTo") or ""),
        )
        result["chunks"] = chunks
        return result

    def server_catalog_list(self, limit: int = 20) -> list[dict]:
        return list_server_catalogs(pythontdx_data_dir() / "lake" / "server_files", limit)

    def tdx_stats(self) -> dict:
        """下载 zhb.zip，保存原始 ZIP，并解析两份 tdxstat CFG 摘要。"""
        data, chunks = self._download_bytes("zhb.zip")
        saved = save_raw_file("zhb.zip", data)
        summary = parse_tdx_stats(data)
        summary.update(
            {
                "chunks": chunks,
                "sha256": saved["sha256"],
                "savedTo": saved["savedTo"],
            }
        )
        return summary

    def tdx_stats_export(self) -> dict:
        """下载 zhb.zip，写原始 ZIP + 按 trade_date 分区的 JSONL.gz。"""
        data, chunks = self._download_bytes("zhb.zip")
        saved = save_raw_file("zhb.zip", data)
        result = export_tdx_stats(data, saved["sha256"])
        result.update(
            {
                "chunks": chunks,
                "rawSavedTo": saved["savedTo"],
                "rawBytes": saved["bytes"],
            }
        )
        return result

    def stats_query(self, sql: str, limit: int = 200) -> dict:
        return run_stats_query(sql, limit)

    def stats_csv(self) -> dict:
        return export_stats_csv()

    def stats_parquet(self) -> dict:
        return export_stats_parquet()

    def stats_duck_query(self, sql: str, limit: int = 200) -> dict:
        return run_duckdb_query(sql, limit)

    def blocks(self, kind: str = "gn") -> dict:
        """下载并解析板块 .dat，返回板块名与成分代码（含市场前缀）。"""
        if kind not in BLOCK_FILES:
            raise TdxError(f"未知板块类型：{kind}")
        cached = self.block_cache.get(kind)
        if cached and cached[0] > time.time():
            return cached[1]

        filename, label = BLOCK_FILES[kind]
        data, chunks = self._download_bytes(filename)
        saved = save_raw_file(filename, data)
        raw_blocks = parse_block_dat(data, kind)

        # 代码表通常已经加载；这里用它把 6 位代码补成 sh/sz/bj，
        # 指数板块优先匹配 ZS，其余优先匹配 GP-A，避免 000001 串到指数/股票。
        self.index.ensure(self.conn)
        by_symbol: dict[str, list[dict]] = {}
        for item in self.index.all:
            by_symbol.setdefault(item["symbol"], []).append(item)

        # tdxzs.cfg 把板块名/行业代码映射到 880xxx 板块指数；报价可用 sh880xxx。
        zhb_bytes, _, _ = self._zhb_bytes()
        sector_by_name: dict[str, str] = {}
        try:
            archive = zipfile.ZipFile(io.BytesIO(zhb_bytes))
            if "tdxzs.cfg" in archive.namelist():
                for row in parse_sector_indices(
                    archive.read("tdxzs.cfg").decode("gbk", "replace")
                ):
                    sector_by_name.setdefault(row["name"], row["code"])
        except zipfile.BadZipFile:
            pass

        def resolve(symbol: str, prefer: str) -> tuple[str, str]:
            candidates = by_symbol.get(symbol, [])
            chosen = next(
                (item for item in candidates if item.get("kind") == prefer),
                candidates[0] if candidates else None,
            )
            if chosen:
                return chosen["code"], chosen.get("name") or symbol
            if symbol.startswith("6"):
                return f"sh{symbol}", symbol
            if symbol.startswith(("0", "3")):
                return f"sz{symbol}", symbol
            if symbol.startswith(("4", "8", "9")):
                return f"bj{symbol}", symbol
            return symbol, symbol

        # 服务器 tdxzs.cfg 缺的板块指数，用本机客户端 infoharbor_block.dat 补齐
        # （实测概念 233→269、风格 141→158）。
        client_index = client_block_indices() if kind in ("gn", "fg") else {}

        blocks: list[dict] = []
        code_count = 0
        for block in raw_blocks:
            # “精选指数”这类块装的是指数；沪深300 等块装的是成分股，
            # 000001 在两种块里分别指上证指数 / 平安银行，不能一律按 ZS 解析。
            prefer = "ZS" if kind == "zs" and "指数" in block["name"] else "GP-A"
            codes: list[str] = []
            names: dict[str, str] = {}
            for symbol in block["codes"]:
                code, name = resolve(symbol, prefer)
                if not code or code in codes:
                    continue
                codes.append(code)
                names[code] = name
            code_count += len(codes)
            blocks.append(
                {
                    "id": block["id"],
                    "name": block["name"],
                    "kind": kind,
                    "count": block["count"],
                    "codes": codes,
                    "names": names,
                    "indexCode": sector_by_name.get(block["name"], "")
                    or client_index.get((kind, block["name"]), "")
                }
            )

        result = {
            "kind": kind,
            "label": label,
            "file": filename,
            "bytes": len(data),
            "chunks": chunks,
            "sha256": saved["sha256"],
            "savedTo": saved["savedTo"],
            "blockCount": len(blocks),
            "codeCount": code_count,
            "blocks": blocks,
        }
        self.block_cache[kind] = (time.time() + 600, result)
        return result

    def client_blocks(self, directory: str = "") -> dict:
        """读通达信客户端本地自定义板块：`T0002/blocknew/blocknew.cfg` + `*.blk`。"""
        root: Path | None = None
        for candidate in client_roots(directory):
            if (candidate / "T0002" / "blocknew" / "blocknew.cfg").is_file():
                root = candidate
                break
        if root is None:
            raise TdxError(
                "找不到通达信客户端的 T0002/blocknew/blocknew.cfg；"
                "请把客户端目录放到 D:/tdx，或设置 PYTHONTDX_TDX_DIR"
            )
        base = root / "T0002" / "blocknew"
        cfg_file = base / "blocknew.cfg"
        records = parse_blocknew_cfg(cfg_file.read_bytes())

        by_symbol: dict[str, list[dict]] = {}
        try:
            self.index.ensure(self.conn)
            for item in self.index.all:
                by_symbol.setdefault(item["symbol"], []).append(item)
        except Exception:  # noqa: BLE001 - 离线时用前缀兜底，不影响读本地板块
            by_symbol = {}

        def resolve(symbol: str) -> tuple[str, str]:
            candidates = by_symbol.get(symbol, [])
            chosen = next(
                (item for item in candidates if item.get("kind") in ("GP-A", "ZS")),
                candidates[0] if candidates else None,
            )
            if chosen:
                return chosen["code"], chosen.get("name") or symbol
            if symbol.startswith("880"):
                return f"sh{symbol}", symbol
            if symbol.startswith("6"):
                return f"sh{symbol}", symbol
            if symbol.startswith(("0", "3")):
                return f"sz{symbol}", symbol
            if symbol.startswith(("4", "8", "9")):
                return f"bj{symbol}", symbol
            return "", symbol

        boards: list[dict] = []
        missing: list[str] = []
        for record in records:
            block_file = base / f"{record['file']}.blk"
            if not block_file.is_file():
                missing.append(record["file"])
                continue
            codes: list[str] = []
            names: dict[str, str] = {}
            for symbol in parse_client_block(block_file.read_text("ascii", "ignore")):
                code, name = resolve(symbol)
                if not code or code in names:
                    continue
                codes.append(code)
                names[code] = name
            boards.append(
                {
                    "id": f"client-{record['file']}",
                    "name": record["name"],
                    "kind": "custom",
                    "count": len(codes),
                    "codes": codes,
                    "names": names,
                    "indexCode": "",
                }
            )

        return {
            "dir": str(root),
            "file": str(cfg_file),
            "blockCount": len(boards),
            "codeCount": sum(len(board["codes"]) for board in boards),
            "missing": missing,
            "boards": boards,
        }

    def archive_datasets(self, codes: list[str]) -> dict:
        """板块 / 财务 / 龙虎榜全量落盘到数据湖（jsonl.gz + manifest）。

        规则 12：同一天重复执行只补缺的文件，已有文件不覆盖。
        """
        from tdx_f10 import fetch_dividend, fetch_finance, fetch_lhb_market

        store = (
            pythontdx_data_dir() / "lake" / "datasets" / f"snapshot_date={time.strftime('%Y-%m-%d')}"
        )
        files: list[dict] = []
        sector_rows = 0

        for kind in ("gn", "fg", "zs", "general"):
            data = self.blocks(kind)
            rows = [
                {
                    "kind": kind,
                    "boardId": block["id"],
                    "board": block["name"],
                    "indexCode": block.get("indexCode", ""),
                    "code": code,
                    "name": block["names"].get(code, ""),
                }
                for block in data["blocks"]
                for code in block["codes"]
            ]
            sector_rows += len(rows)
            files.append(_write_dataset_jsonl(store / "sectors" / f"{kind}.jsonl.gz", rows))

        industries = self.industries()
        for name, blocks in (
            ("tdx_industry", industries["blocks"]),
            ("rs_industry", industries.get("rsBlocks") or []),
        ):
            rows = [
                {
                    "kind": name,
                    "boardId": block["id"],
                    "board": block["name"],
                    "indexCode": block.get("indexCode", ""),
                    "code": code,
                    "name": block["names"].get(code, ""),
                }
                for block in blocks
                for code in block["codes"]
            ]
            sector_rows += len(rows)
            files.append(_write_dataset_jsonl(store / "sectors" / f"{name}.jsonl.gz", rows))

        mappings: list[dict] = []
        try:
            archive = zipfile.ZipFile(io.BytesIO(self._zhb_bytes()[0]))
            if "tdxzs.cfg" in archive.namelist():
                mappings = [
                    {"name": row["name"], "code": row["code"], "tdxCode": row["tdxCode"]}
                    for row in parse_sector_indices(
                        archive.read("tdxzs.cfg").decode("gbk", "replace")
                    )
                ]
        except zipfile.BadZipFile:
            mappings = []
        files.append(_write_dataset_jsonl(store / "sector_indices.jsonl.gz", mappings))

        lhb_rows = 0
        try:
            lhb = fetch_lhb_market()
            rows = [dict(zip(lhb["columns"], row)) for row in lhb["rows"]]
            lhb_rows = len(rows)
            files.append(_write_dataset_jsonl(store / "lhb" / "lhb.jsonl.gz", rows))
        except Exception as error:  # noqa: BLE001 - 龙虎榜失败不阻断其它数据集
            files.append({"file": "lhb", "error": str(error)})

        def archive_finance_code(code: str) -> tuple[list[dict], int, bool]:
            """单只股票的财务落盘：主要指标 + 分红 + 三大报表全字段。

            返回（文件记录, 报表行数, 是否成功）；已有文件跳过，不覆盖（规则 12）。
            """
            result_files: list[dict] = []
            rows_written = 0
            ok = False
            finance_path = store / "finance" / f"{code}.jsonl.gz"
            if finance_path.exists():
                result_files.append({"file": str(finance_path), "rows": 0, "skipped": True})
                ok = True
            else:
                entry: dict = {"code": code}
                try:
                    entry["finance"] = fetch_finance(code)
                    ok = True
                except Exception as error:  # noqa: BLE001
                    entry["financeError"] = str(error)
                try:
                    entry["dividend"] = fetch_dividend(code)
                except Exception as error:  # noqa: BLE001
                    entry["dividendError"] = str(error)
                result_files.append(_write_dataset_jsonl(finance_path, [entry]))

            for kind in ("zcfzb", "lyb", "xjllb"):
                path = store / "statements" / kind / f"{code}.jsonl.gz"
                if path.exists():
                    result_files.append({"file": str(path), "rows": 0, "skipped": True})
                    continue
                try:
                    statement = fetch_statement(code, kind, True)
                except Exception as error:  # noqa: BLE001 - 单张报表失败不阻断其它数据
                    result_files.append({"file": str(path), "error": str(error)})
                    continue
                columns = [str(name) for name in statement.get("columns") or []]
                rows = []
                for values in statement.get("rows") or []:
                    row = {
                        "code": code,
                        "kind": kind,
                        "template": statement.get("template", 0),
                    }
                    row.update({name: value for name, value in zip(columns, values)})
                    if "rq" in row:
                        row["period"] = row["rq"]
                    rows.append(row)
                rows_written += len(rows)
                result_files.append(_write_dataset_jsonl(path, rows))
                ok = True
            return result_files, rows_written, ok

        def archive_finance_code_safe(code: str) -> tuple[list[dict], int, bool]:
            """单只失败（含磁盘写入被占用）只记错误，不能拖垮整批归档。"""
            try:
                return archive_finance_code(code)
            except Exception as error:  # noqa: BLE001
                return [{"file": code, "error": str(error)}], 0, False

        finance_codes = 0
        statement_rows = 0
        finance_failed: list[str] = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(archive_finance_code_safe, codes))
        for code, (code_files, rows, ok) in zip(codes, results):
            files.extend(code_files)
            statement_rows += rows
            if ok:
                finance_codes += 1
            else:
                finance_failed.append(code)

        manifest = {
            "format": 1,
            "createdAt": int(time.time() * 1000),
            "dataRoot": str(store),
            "sectorRows": sector_rows,
            "lhbRows": lhb_rows,
            "financeCodes": finance_codes,
            "statementRows": statement_rows,
            "financeFailed": finance_failed,
            "files": files,
        }
        manifest_path = store / "manifest.json"
        if not manifest_path.exists():
            store.mkdir(parents=True, exist_ok=True)
            temporary = manifest_path.with_name(manifest_path.name + ".part")
            temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
            os.replace(temporary, manifest_path)
        return {
            "dir": str(store),
            "sectorRows": sector_rows,
            "lhbRows": lhb_rows,
            "financeCodes": finance_codes,
            "statementRows": statement_rows,
            "financeFailed": finance_failed,
            "manifest": str(manifest_path),
            "files": files,
        }

    def industries(self) -> dict:
        """用 tdxhy.cfg + incon.dat 生成通达信行业分类与成分股。"""
        if self.industry_cache and self.industry_cache[0] > time.time():
            return self.industry_cache[1]

        cfg_bytes, chunks = self._download_bytes("tdxhy.cfg")
        cfg_saved = save_raw_file("tdxhy.cfg", cfg_bytes)
        zhb_bytes, zhb_saved, zhb_chunks = self._zhb_bytes()
        try:
            archive = zipfile.ZipFile(io.BytesIO(zhb_bytes))
            if "incon.dat" not in archive.namelist():
                raise TdxError("zhb.zip 缺少 incon.dat")
            incon = archive.read("incon.dat").decode("gbk", "replace")
            tdxzs = (
                archive.read("tdxzs.cfg").decode("gbk", "replace")
                if "tdxzs.cfg" in archive.namelist()
                else ""
            )
        except zipfile.BadZipFile as error:
            raise TdxError("zhb.zip 不是合法 ZIP") from error

        names = dict(parse_incon_sections(incon).get("TDXNHY", []))
        rs_names = dict(parse_incon_sections(incon).get("TDXRSHY", []))
        sector_rows = parse_sector_indices(tdxzs)
        sector_by_tdx = {
            row["tdxCode"]: row["code"] for row in sector_rows if row["tdxCode"]
        }
        sector_by_name = {
            row["name"]: row["code"] for row in sector_rows if row["name"]
        }
        self.index.ensure(self.conn)
        by_symbol: dict[str, list[dict]] = {}
        for item in self.index.all:
            by_symbol.setdefault(item["symbol"], []).append(item)

        groups: dict[str, dict] = {}
        resolved_rows: list[tuple[dict, str, str]] = []
        for row in parse_tdxhy(cfg_bytes.decode("gbk", "replace")):
            symbol = row["symbol"]
            candidates = by_symbol.get(symbol, [])
            chosen = next(
                (item for item in candidates if item.get("kind") == "GP-A"),
                candidates[0] if candidates else None,
            )
            if chosen:
                code, name = chosen["code"], chosen.get("name") or symbol
            elif symbol.startswith("6"):
                code, name = f"sh{symbol}", symbol
            elif symbol.startswith(("0", "3")):
                code, name = f"sz{symbol}", symbol
            else:
                code, name = f"bj{symbol}", symbol
            group = groups.setdefault(
                row["tdxCode"],
                {
                    "id": f"industry-{row['tdxCode']}",
                    "name": names.get(row["tdxCode"], row["tdxCode"]),
                    "kind": "industry",
                    "count": 0,
                    "codes": [],
                    "names": {},
                    "indexCode": sector_by_tdx.get(row["tdxCode"], "")
                },
            )
            if code not in group["codes"]:
                group["codes"].append(code)
                group["names"][code] = name
                group["count"] = len(group["codes"])
            resolved_rows.append((row, code, name))

        # TDXRSHY（通达信研发行业）是树：X10 → X1001 → X100101。
        # 个股只挂在叶子行业上，所以一级/二级行业要把子孙行业的成分并上来；
        # MAC 0x1231 的「一级行业」= TDXRSHY 第二层、「二级行业」= 第三层。
        rs_groups: dict[str, dict] = {}
        for row, code, name in resolved_rows:
            rs_code = row.get("rsCode") or ""
            if not rs_code:
                continue
            for length in range(len(rs_code), 2, -1):
                prefix = rs_code[:length]
                if prefix not in rs_names:
                    continue
                rs_group = rs_groups.get(prefix)
                if rs_group is None:
                    rs_name = rs_names[prefix]
                    rs_group = {
                        "id": f"rs-{prefix}",
                        "name": rs_name,
                        "kind": "industry",
                        "count": 0,
                        "codes": [],
                        "names": {},
                        "indexCode": sector_by_name.get(rs_name, ""),
                    }
                    rs_groups[prefix] = rs_group
                if code not in rs_group["names"]:
                    rs_group["codes"].append(code)
                    rs_group["names"][code] = name
                    rs_group["count"] = len(rs_group["codes"])

        blocks = list(groups.values())
        rs_blocks = list(rs_groups.values())
        result = {
            "kind": "industry",
            "label": "行业",
            "file": "tdxhy.cfg",
            "bytes": len(cfg_bytes),
            "chunks": chunks,
            "sha256": cfg_saved["sha256"],
            "savedTo": cfg_saved["savedTo"],
            "inconFrom": zhb_saved["savedTo"],
            "zhbChunks": zhb_chunks,
            "blockCount": len(blocks),
            "codeCount": sum(len(group["codes"]) for group in blocks),
            "blocks": blocks,
            "rsLabel": "通达信研发行业",
            "rsBlockCount": len(rs_blocks),
            "rsCodeCount": sum(len(group["codes"]) for group in rs_blocks),
            "rsBlocks": rs_blocks,
            "sectorIndices": sector_rows,
        }
        self.industry_cache = (time.time() + 600, result)
        return result

    def _attach_finance(self, quotes: list[dict]) -> None:
        if not quotes:
            return

        now = time.time()
        missing = [
            quote["code"]
            for quote in quotes
            if not is_index_code(MARKET_IDS.get(quote["code"][:2], -1), quote["symbol"])
            and (
                quote["code"] not in self.finance_cache
                or self.finance_cache[quote["code"]][0] < now
            )
        ]

        if missing:
            self._load_finance(missing)

        for quote in quotes:
            cached = self.finance_cache.get(quote["code"])
            if cached and cached[0] >= now:
                self._apply_finance(quote, cached[1])

    def _load_finance(self, codes: list[str]) -> None:
        items: list[tuple[int, str]] = []
        for code in codes:
            try:
                market, symbol = parse_code(code)
            except TdxError:
                continue
            items.append((market, symbol))

        try:
            for start in range(0, len(items), FINANCE_BATCH):
                batch = items[start : start + FINANCE_BATCH]
                body = self.conn.request(CMD_FINANCE, finance_data(batch))
                for finance in parse_finance(body):
                    self.finance_cache[finance["code"]] = (time.time() + FINANCE_TTL, finance)
        except Exception as error:  # noqa: BLE001 - 财务失败不影响行情
            print(f"[tdx] 财务数据拉取失败：{error}", file=sys.stderr)

    @staticmethod
    def _apply_finance(quote: dict, finance: dict) -> None:
        float_shares = finance["floatShares"] * 10000
        total_shares = finance["totalShares"] * 10000

        if float_shares > 0:
            quote["turnoverRate"] = quote["volume"] * 100 / float_shares * 100
            quote["floatCap"] = quote["price"] * float_shares / 1e8
        if total_shares > 0:
            quote["totalCap"] = quote["price"] * total_shares / 1e8
        if finance["netAssetsPerShare"] > 0:
            quote["pb"] = quote["price"] / finance["netAssetsPerShare"]

    # -- 财务快照 / 特殊涨跌停 / 退市 K 线 ------------------------------

    def finance_snapshot(self, codes: list[str]) -> list[dict]:
        """批量拉 0x0010 全字段，供归档/选股/ML 使用（不写 quote）。"""
        items: list[tuple[int, str]] = []
        for code in codes:
            try:
                items.append(parse_code(str(code)))
            except TdxError:
                continue
        rows: list[dict] = []
        for start in range(0, len(items), FINANCE_BATCH):
            batch = items[start : start + FINANCE_BATCH]
            if not batch:
                continue
            body = self.conn.request(CMD_FINANCE, finance_data(batch))
            rows.extend(parse_finance(body))
        return rows

    def finance_archive_save(self, codes: list[str]) -> dict:
        """把 0x0010 全字段财务快照写 lake/finance（同交易日保留第一份）。"""
        rows = self.finance_snapshot(codes)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return write_dataset_archive(
            pythontdx_data_dir() / "lake" / "finance",
            "finance",
            rows,
            source="TDX 7709 0x0010",
            trade_date=trade_date,
            fields=[
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
        )

    def finance_archive_list(self, limit: int = 50) -> list[dict]:
        return list_dataset_archives(pythontdx_data_dir() / "lake" / "finance", limit)

    # -- 股本变迁 0x000f ---------------------------------------------------

    def capital_changes(self, codes: list[str]) -> dict:
        """0x000f 股本变迁/权息；返回股票块与扁平事件列表。"""
        items: list[tuple[int, str]] = []
        for code in codes:
            try:
                items.append(parse_code(str(code)))
            except TdxError:
                continue
        blocks: list[dict] = []
        for start in range(0, len(items), CAPITAL_BATCH):
            batch = items[start : start + CAPITAL_BATCH]
            if not batch:
                continue
            body = self.conn.request(CMD_CAPITAL_CHANGES, capital_changes_data(batch))
            blocks.extend(parse_capital_changes(body))
        records = [record for block in blocks for record in block["records"]]
        return {"count": len(blocks), "blocks": blocks, "records": records}

    def capital_archive_save(self, codes: list[str]) -> dict:
        result = self.capital_changes(codes)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return {
            **result,
            "archive": write_dataset_archive(
                pythontdx_data_dir() / "lake" / "corporate",
                "capital_changes",
                result["records"],
                source="TDX 7709 0x000f",
                trade_date=trade_date,
                fields=[
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
            ),
        }

    def capital_archive_list(self, limit: int = 50) -> list[dict]:
        return list_dataset_archives(
            pythontdx_data_dir() / "lake" / "corporate", limit
        )

    def adjustment_factors(
        self,
        code: str,
        anchor_date: str | None = None,
        start_date: str | None = None,
    ) -> dict:
        """0x000f 标签 1 事件 → 本地 qfq/hfq 仿射系数。"""
        result = self.capital_changes([code])
        factors = build_factors(
            result["records"], anchor_date=anchor_date, start_date=start_date
        )
        return {
            "code": code,
            "anchorDate": anchor_date,
            "startDate": start_date,
            "count": len(factors),
            "factors": factors,
        }

    def local_adjust_kline(
        self,
        code: str,
        period: str = "day",
        adjust: str = "qfq",
        count: int = 800,
    ) -> dict:
        """不复权 K 线 + 本地权息系数，得到可审计的复权结果。"""
        if adjust not in {"qfq", "hfq"}:
            raise TdxError("本地复权只支持 qfq / hfq")
        raw = self.kline(code, period, count, "none")
        bars = raw.get("bars") or []
        if not bars:
            return {**raw, "bars": [], "adjust": adjust, "factors": []}
        start_date = str(bars[0]["date"])[:10]
        anchor_date = str(bars[-1]["date"])[:10]
        factors = build_factors(
            self.capital_changes([code])["records"],
            anchor_date=anchor_date,
            start_date=start_date,
        )
        return {
            **raw,
            "bars": apply_factors(bars, factors, adjust),
            "adjust": adjust,
            "factors": factors,
        }

    # -- 特殊涨跌停 / 退市 K 线 -------------------------------------------

    def special_limits(self, start_index: int = 0) -> dict:
        """0x0452 特殊品种涨跌停表，按表内行号分页。"""
        start = max(0, min(int(start_index), 0xFFFF))
        body = self.conn.request(CMD_SPECIAL_LIMITS, special_limits_data(start))
        records = parse_special_limits(body)
        return {"startIndex": start, "count": len(records), "records": records}

    def scan_special_limits(self, max_rows: int = 10000) -> dict:
        """连续翻页扫描特殊涨跌停表，供本地索引/归档。"""
        limit = max(1, min(int(max_rows), 50000))
        start = 0
        records: list[dict] = []
        pages = 0
        while len(records) < limit and pages < 200:
            page = self.special_limits(start)
            rows = page["records"]
            if not rows:
                break
            records.extend(rows)
            start += int(page["count"])
            pages += 1
            if int(page["count"]) < 1:
                break
        return {"startIndex": 0, "count": len(records[:limit]), "records": records[:limit]}

    @staticmethod
    def _delisted_code(code: str) -> tuple[int, str]:
        """退市代码支持 T000038 / sz000038 / 000038；只允许 A 股市场。"""
        raw = str(code or "").strip().lower()
        if raw.startswith("t") and len(raw) == 7:
            raw = raw[1:]
        if raw[:2] in {"sh", "sz", "bj"}:
            return parse_code(raw)
        if len(raw) != 6 or not raw.isdigit():
            raise TdxError("退市 K 线代码格式不正确")
        # 与 inferMarket 的 A 股规则保持一致
        if raw.startswith(("60", "68", "90", "11", "50", "51", "52", "56", "58")):
            return 1, raw
        if raw.startswith(("43", "83", "87", "88", "92")):
            return 2, raw
        return 0, raw

    def delisted_kline(self, code: str, start: int = 0, count: int = 800) -> dict:
        """0x052b 退市日线（仅日线、不复权）。"""
        market, symbol = self._delisted_code(code)
        body = self.conn.request(
            CMD_DELISTED_BARS, delisted_bars_data(market, symbol, start, count)
        )
        bars = parse_delisted_bars(body)
        return {"code": full_code(market, symbol), "bars": bars, "source": "network"}

    def delisted_history(
        self, code: str, page_size: int = 800, max_pages: int = 200
    ) -> dict:
        """自动翻页到空页为止，按日期去重升序。

        短页不再当作结束：服务端一次少给几百根并不代表历史取完（eltdx 文档
        明确「只有空页才停」）。如果服务端对同一 start 反复返回相同内容
        （new == 0），停止但把 complete 标成 False，不谎报完整。
        """
        market, symbol = self._delisted_code(code)
        page_size = max(1, min(int(page_size), 800))
        max_pages = max(1, min(int(max_pages), 500))
        start = 0
        pages = 0
        by_date: dict[str, dict] = {}
        complete = False
        while pages < max_pages:
            body = self.conn.request(
                CMD_DELISTED_BARS,
                delisted_bars_data(market, symbol, start, page_size),
            )
            page = parse_delisted_bars(body)
            if not page:
                complete = True
                break
            pages += 1
            fresh = 0
            for bar in page:
                if bar["date"] not in by_date:
                    fresh += 1
                by_date[bar["date"]] = bar
            if fresh == 0:
                break
            start += len(page)
        bars = sorted(by_date.values(), key=lambda bar: bar["date"])
        return {
            "code": full_code(market, symbol),
            "bars": bars,
            "pages": pages,
            "complete": complete or pages < max_pages,
            "source": "7709",
        }

    def special_limits_archive_save(self, max_rows: int = 10000) -> dict:
        """扫描 0x0452 并落盘；同一交易日已有快照时保留第一份。"""
        scan = self.scan_special_limits(max_rows)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return write_dataset_archive(
            pythontdx_data_dir() / "lake" / "special_limits",
            "special_limits",
            scan["records"],
            source="TDX 7709 0x0452",
            trade_date=trade_date,
            fields=["market", "marketId", "code", "symbol", "limitUp", "limitDown"],
        )

    def special_limits_archive_list(self, limit: int = 50) -> list[dict]:
        return list_dataset_archives(
            pythontdx_data_dir() / "lake" / "special_limits", limit
        )

    def delisted_archive_save(
        self, code: str, page_size: int = 800, max_pages: int = 200
    ) -> dict:
        """拉全 0x052b 退市日线并写 Parquet；已有有效归档不覆盖。"""
        result = self.delisted_history(code, page_size, max_pages)
        archived = write_delisted_archive(
            pythontdx_data_dir() / "lake" / "delisted",
            result["code"],
            result["bars"],
        )
        return {**result, "archive": archived}

    def delisted_archive_list(self, limit: int = 100) -> list[dict]:
        return list_delisted_archives(
            pythontdx_data_dir() / "lake" / "delisted", limit
        )

    # -- K 线 / 分时 -----------------------------------------------------

    def kline(
        self,
        code: str,
        period: str,
        count: int,
        adjust: str = 'qfq',
        cache_only: bool = False,
        anchor_date: str | None = None,
        start: int = 0,
        persist: bool = True,
    ) -> dict:
        market, symbol = parse_code(code)
        if period not in PERIOD_RAW:
            raise TdxError("K 线周期只支持 day / week / month")

        safe_count = max(1, min(800, int(count)))
        safe_start = max(0, int(start))
        requested_adjust = str(adjust or "qfq")
        fixed = requested_adjust in {"fixed_qfq", "fixed_hfq"}
        if fixed and not anchor_date:
            raise TdxError("定点复权必须提供 anchorDate")
        anchor_raw = 0
        if fixed:
            text = str(anchor_date).replace("-", "")
            if len(text) != 8 or not text.isdigit():
                raise TdxError("anchorDate 必须是 YYYY-MM-DD 或 YYYYMMDD")
            anchor_raw = int(text)
        safe_adjust = requested_adjust if requested_adjust in {"none", "qfq", "hfq", "fixed_qfq", "fixed_hfq"} else "qfq"
        cache_adjust = f"{safe_adjust}@{anchor_raw}" if fixed else safe_adjust
        kind = "index" if is_index_code(market, symbol) else "stock"
        if cache_only:
            if safe_start:
                raise TdxError("cache_only 只支持 start=0（分页请求不落缓存）")
            cached = _read_kline_cache(code, period, safe_count, cache_adjust)
            if cached is not None:
                return cached
            full_path = _full_kline_cache_path(code, period, cache_adjust)
            if full_path.is_file():
                try:
                    full = read_bars(full_path)
                except ParquetStoreError as error:
                    raise TdxError(f"本地全历史 K 线缓存损坏：{error}") from error
                return {
                    "code": code,
                    "period": period,
                    "bars": full["bars"][-safe_count:],
                    "source": "cache",
                    "cachePath": str(full_path),
                }
            # 首屏「只读缓存」是正常探测：没缓存不是错误，不能把 IPC 变成
            # rejected promise（Electron 会把每次 miss 都打成 handler 异常）。
            return {
                "code": code,
                "period": period,
                "bars": [],
                "source": "cache",
                "miss": True,
            }
        try:
            body = self.conn.request(
                CMD_BARS,
                bars_data(
                    market,
                    symbol,
                    PERIOD_RAW[period],
                    safe_count,
                    {'none': 0, 'qfq': 1, 'hfq': 2, 'fixed_qfq': 3, 'fixed_hfq': 4}.get(safe_adjust, 1),
                    safe_start,
                    {'5s': 5, '15s': 15, '2m': 2, '3m': 3, '4m': 4, '6m': 6, '8m': 8, '10m': 10, '12m': 12, '18m': 18, '20m': 20, '24m': 24, '36m': 36, '48m': 48, '2d': 2, '3d': 3, '4d': 4, '6d': 6, '9d': 9, '12d': 12, '18d': 18, '24d': 24, '45d': 45}.get(period, 1),
                    anchor_raw,
                ),
            )
            bars = parse_bars(body, kind, PERIOD_RAW[period])
            # 实时 tail 每秒拉一次，不落盘；否则每只自选每秒重写一个 20 根
            # parquet，既磨损磁盘又和 sidecar 队列抢 IO。首屏/60 秒全量仍落盘。
            if not safe_start and persist:
                _write_kline_cache(code, period, safe_count, cache_adjust, bars, "network")
            return {
                "code": code,
                "period": period,
                "bars": bars,
                "start": safe_start,
                "source": "7709",
                "adjust": safe_adjust,
                "anchorDate": anchor_date if fixed else None,
            }
        except Exception:
            if safe_start:
                raise
            cached = _read_kline_cache(code, period, safe_count, cache_adjust)
            if cached is not None:
                return cached
            raise

    def _ttl_get(self, store: dict[str, tuple[float, dict]], key: str, ttl: float) -> dict | None:
        with self._cache_lock:
            item = store.get(key)
            if item is not None and time.monotonic() - item[0] < ttl:
                return item[1]
        return None

    def _ttl_put(self, store: dict[str, tuple[float, dict]], key: str, value: dict) -> dict:
        with self._cache_lock:
            if key not in store and len(store) >= CACHE_MAX_ENTRIES:
                # 简单 FIFO 淘汰：保留最近写入的 N 个键，避免看全市场后缓存无限增长。
                store.pop(next(iter(store)))
            store[key] = (time.monotonic(), value)
        return value

    def kline_cached(
        self,
        code: str,
        period: str,
        count: int,
        adjust: str = "qfq",
        cache_only: bool = False,
        anchor_date: str | None = None,
        fresh: bool = False,
        start: int = 0,
    ) -> dict:
        """K 线 UI 缓存：桌面 IPC 与 Web HTTP 共用 60 秒 TTL。

        `fresh` 用于推送/手动刷新，`cache_only` 用于首屏本地缓存，两者都绕过
        TTL；分页请求（start>0）不写缓存，直接读网络。
        """
        safe_count = max(1, min(800, int(count)))
        safe_start = max(0, int(start))
        if cache_only or fresh or safe_start:
            return self.kline(
                code,
                period,
                safe_count,
                adjust,
                cache_only=cache_only,
                anchor_date=anchor_date,
                start=safe_start,
            )
        key = f"{code}:{period}:{safe_count}:{adjust}:{anchor_date or ''}"
        cached = self._ttl_get(self._kline_cache, key, KLINE_CACHE_TTL)
        if cached is not None:
            return cached
        return self._ttl_put(
            self._kline_cache,
            key,
            self.kline(code, period, safe_count, adjust, anchor_date=anchor_date),
        )

    def _put_kline_live(self, key: str, series: dict) -> None:
        if key not in self._kline_live_cache and len(self._kline_live_cache) >= KLINE_LIVE_MAX_ENTRIES:
            self._kline_live_cache.pop(next(iter(self._kline_live_cache)))
        self._kline_live_cache[key] = (series, time.monotonic())

    def kline_live(
        self,
        code: str,
        period: str,
        count: int = 800,
        adjust: str = "qfq",
        first: bool = False,
    ) -> dict:
        """实时 K 线：首帧全量，之后每 60 秒内只取最近 20 根并合并。

        缓存放在 Python 而不是 Electron 主进程 / 浏览器标签页：
        同一份自选在桌面、Web、多窗口之间只维护一条 800 根基线；否则
        每个消费者各存一份，补全/断层规则迟早漂移。
        """
        safe_count = max(1, min(800, int(count)))
        key = f"{code}:{period}:{safe_count}:{adjust}"
        with self._kline_live_lock:
            cached = self._kline_live_cache.get(key)
            now = time.monotonic()
            if first or cached is None or now - cached[1] >= KLINE_LIVE_FULL_REFRESH:
                series = self.kline(code, period, safe_count, adjust)
                self._put_kline_live(key, series)
                return series

            tail_count = min(KLINE_LIVE_TAIL, safe_count)
            tail = self.kline(code, period, tail_count, adjust, persist=False)
            bars = list(tail.get("bars") or [])
            base_bars = list(cached[0].get("bars") or [])
            # tail 窗口装满，且第一根比本地最后一根还新：说明中间已经断层，
            # 再合并会出现空洞，直接重取全量。
            if bars and base_bars and len(bars) >= tail_count and bars[0]["date"] > base_bars[-1]["date"]:
                series = self.kline(code, period, safe_count, adjust)
                self._put_kline_live(key, series)
                return series

            merged = {**cached[0], "bars": merge_kline_bars(base_bars, bars)}
            self._kline_live_cache[key] = (merged, cached[1])
            return {**tail, "tail": True}

    def minute_cached(self, code: str, fresh: bool = False) -> dict:
        """分时 UI 缓存 10 秒；推送/手动刷新传 fresh=True 绕过。"""
        if fresh:
            return self.minute(code)
        cached = self._ttl_get(self._minute_cache, code, MINUTE_CACHE_TTL)
        if cached is not None:
            return cached
        return self._ttl_put(self._minute_cache, code, self.minute(code))

    def five_day_cached(self, code: str, fresh: bool = False) -> dict:
        """五日分时 UI 缓存 60 秒；推送/手动刷新传 fresh=True 绕过。"""
        if fresh:
            return self.five_day(code)
        cached = self._ttl_get(self._five_day_cache, code, FIVE_DAY_CACHE_TTL)
        if cached is not None:
            return cached
        return self._ttl_put(self._five_day_cache, code, self.five_day(code))

    def invalidate_caches(self) -> dict:
        """切换主站/手动刷新时清空所有 UI 数据缓存。"""
        with self._cache_lock:
            self._minute_cache.clear()
            self._five_day_cache.clear()
            self._kline_cache.clear()
        with self._kline_live_lock:
            self._kline_live_cache.clear()
        with self._breadth_lock:
            self._breadth_cache = None
            self._breadth_at = 0.0
            self._breadth_day = ""
            self._breadth_scan = None
        return {"ok": True}

    def day_file_archive_save(self, code: str) -> dict:
        """用 0x06b9 下载官方 vipdoc 日线文件，避免 0x052d 逐页翻全历史。

        `vipdoc/sh/lday/sh600519.day` 实测可直接下载（7 个 30KB 块，
        比 0x052d 的 800 根/页少很多 RTT），内容就是官方客户端的 .day。
        """
        market, symbol = parse_code(code)
        prefix = code[:2].lower()
        path = f"vipdoc/{prefix}/lday/{code}.day"
        data, chunks = self._download_bytes(path, max_bytes=16 * 1024 * 1024)
        if not data:
            raise TdxError(f"服务器没有 {path}（0x06b9 返回空）")
        parsed = parse_day_bytes(data, f"{code}.day")
        bars = parsed["bars"]
        target = _full_kline_cache_path(code, "day", "none")
        write_bars(target, code, bars)
        write_kline_manifest(
            target,
            {
                "code": code,
                "period": "day",
                "adjust": "none",
                "source": f"0x06b9 {path}",
                "firstDate": parsed["firstDate"],
                "lastDate": parsed["lastDate"],
                "rows": len(bars),
                "chunks": chunks,
                "bytes": len(data),
                "complete": True,
            },
        )
        return {
            "code": code,
            "period": "day",
            "bars": bars,
            "rows": len(bars),
            "chunks": chunks,
            "bytes": len(data),
            "firstDate": parsed["firstDate"],
            "lastDate": parsed["lastDate"],
            "source": "0x06b9-file",
            "cachePath": str(target),
        }

    def full_kline(
        self, code: str, period: str = "day", adjust: str = "none"
    ) -> dict:
        """按 800 根分页自动探测该代码全部可用历史，写 *_all_*.json。"""
        market, symbol = parse_code(code)
        if period not in PERIOD_RAW:
            raise TdxError("不支持的 K 线周期")
        safe_adjust = adjust if adjust in {"none", "qfq", "hfq"} else "none"
        kind = "index" if is_index_code(market, symbol) else "stock"
        period_param = {
            '5s': 5, '15s': 15, '2m': 2, '3m': 3, '4m': 4, '6m': 6, '8m': 8,
            '10m': 10, '12m': 12, '18m': 18, '20m': 20, '24m': 24, '36m': 36,
            '48m': 48, '2d': 2, '3d': 3, '4d': 4, '6d': 6, '9d': 9, '12d': 12,
            '18d': 18, '24d': 24, '45d': 45
        }.get(period, 1)
        page_size = 800
        max_pages = 200
        start = 0
        pages = 0
        bars_by_date: dict[str, dict] = {}
        complete = False
        while start <= 0xFFFF and pages < max_pages:
            body = self.conn.request(
                CMD_BARS,
                bars_data(
                    market,
                    symbol,
                    PERIOD_RAW[period],
                    page_size,
                    {'none': 0, 'qfq': 1, 'hfq': 2}.get(safe_adjust, 0),
                    start,
                    period_param,
                ),
            )
            page = parse_bars(body, kind, PERIOD_RAW[period])
            if not page:
                complete = True
                break
            pages += 1
            fresh = 0
            for bar in page:
                if bar["date"] not in bars_by_date:
                    fresh += 1
                bars_by_date[bar["date"]] = bar
            # 短页不再当作结束（服务端一次少给并不代表历史取完）；只有空页才停。
            # 若服务端对同一 start 反复返回相同数据，停止但 complete=False。
            if fresh == 0:
                break
            start += len(page)
        bars = sorted(bars_by_date.values(), key=lambda bar: bar["date"])
        if not bars:
            cached = _read_kline_cache(code, period, 800, safe_adjust)
            if cached is not None:
                return cached
            raise TdxError("服务端未返回 K 线数据")
        target = _write_full_kline_cache(
            code, period, safe_adjust, bars, pages, complete
        )
        return {
            "code": code,
            "period": period,
            "adjust": safe_adjust,
            "bars": bars,
            "source": "7709",
            "pages": pages,
            "complete": complete,
            "cachePath": str(target),
            "fetchedAt": int(time.time() * 1000),
        }

    def kline_1m_archive_save(
        self, code: str, days: int = 100, adjust: str = "none"
    ) -> dict:
        """1 分钟 K 只取最近 N 个交易日，写 lake/kline_1m/trade_date=<末日>。

        0x052d 的 start 是从最新往前翻的偏移；每页 800 根。服务端目前只保留
        约 92 个交易日（22,080 根），请求 100 日会返回全部可用历史；不要调用
        full_kline，避免重复写全历史缓存。
        """
        market, symbol = parse_code(code)
        want_days = max(1, min(120, int(days)))
        safe_adjust = adjust if adjust in {"none", "qfq", "hfq"} else "none"
        kind = "index" if is_index_code(market, symbol) else "stock"
        adjust_raw = {"none": 0, "qfq": 1, "hfq": 2}.get(safe_adjust, 0)
        page_size = 800
        by_date: dict[str, dict] = {}
        day_keys: set[str] = set()
        cache_last = ""
        cached_path = _full_kline_cache_path(code, "1m", "none")
        if cached_path.is_file():
            try:
                for bar in read_bars(cached_path).get("bars") or []:
                    date = str(bar.get("date") or "")
                    if date:
                        by_date[date] = bar
                        day_keys.add(date[:10])
                        cache_last = max(cache_last, date)
            except (OSError, ValueError, ParquetStoreError):
                by_date.clear()
                day_keys.clear()
                cache_last = ""
        # 已有 1m 全历史缓存时只补最近几页；没有缓存才从头翻 100 天。
        # 这样 5,600 只全市场不会重复拉 28 页/只。
        max_pages = 8 if by_date else min(200, want_days * 2 + 4)
        start = 0
        pages = 0
        complete = False
        # 即使缓存已有 100 日也要至少抓最新一页：否则旧缓存永远不会更新。
        while start <= 0xFFFF and pages < max_pages:
            body = self.conn.request(
                CMD_BARS,
                bars_data(market, symbol, 7, page_size, adjust_raw, start, 1),
            )
            page = parse_bars(body, kind, 7)
            if not page:
                complete = True
                break
            pages += 1
            fresh = 0
            page_dates: list[str] = []
            for bar in page:
                date = str(bar.get("date") or "")
                if not date:
                    continue
                page_dates.append(date)
                if date not in by_date:
                    fresh += 1
                by_date[date] = bar
                day_keys.add(date[:10])
            if fresh == 0:
                break
            # 缓存已经覆盖的旧区间到了就停；只补最新缺口。
            if cache_last and page_dates and min(page_dates) <= cache_last:
                break
            if not cache_last and len(day_keys) >= want_days:
                break
            start += len(page)
        dates = sorted(by_date)
        if not dates:
            raise TdxError("MAC/7709 未返回 1 分钟 K 数据")
        keep_days = sorted(day_keys)[-want_days:]
        keep = [date for date in dates if str(date)[:10] >= keep_days[0]]
        bars = [by_date[date] for date in keep]
        last_date = keep_days[-1]
        target = (
            pythontdx_data_dir()
            / "lake"
            / "kline_1m"
            / f"trade_date={last_date}"
            / f"{code}.parquet"
        )
        write_bars(target, code, bars)
        write_kline_manifest(
            target,
            {
                "code": code,
                "period": "1m",
                "adjust": safe_adjust,
                "source": (
                    "cache+7709 0x052d recent"
                    if cached_path.is_file()
                    else "7709 0x052d recent"
                ),
                "days": want_days,
                "daysAvailable": len(day_keys),
                "firstDate": bars[0]["date"],
                "lastDate": bars[-1]["date"],
                "pages": pages,
                "complete": True,
                "scope": "recent",
            },
        )
        return {
            "code": code,
            "period": "1m",
            "adjust": safe_adjust,
            "days": want_days,
            "daysAvailable": len(day_keys),
            "rows": len(bars),
            "firstDate": bars[0]["date"],
            "lastDate": bars[-1]["date"],
            "complete": True,
            "cachePath": str(target),
        }

    def chart_patterns(
        self,
        code: str,
        period: str = "day",
        adjust: str = "qfq",
        lookback: int = 160,
    ) -> dict:
        """智能画线：优先本地 800 根 K，缺失时再走网络。"""
        try:
            result = self.kline(code, period, 800, adjust, cache_only=True)
        except Exception:
            result = self.kline(code, period, 800, adjust)
        plans = build_smart_drawings(list(result.get("bars") or []), lookback)
        return {
            "code": code,
            "period": period,
            "adjust": adjust,
            "source": result.get("source", "network"),
            "summary": pattern_summary(plans),
            "plans": plans,
        }

    def limit_review(self, date: str) -> dict:
        """扫描本地全部日 K 缓存，复盘指定交易日的涨停/跌停/炸板。"""
        try:
            self.index.ensure(self.conn)
        except Exception:  # noqa: BLE001 - 离线时仍允许按代码扫描本地缓存
            pass
        by_code = self.index.by_code
        rows: list[dict] = []
        scanned = 0
        for file in kline_cache_dir().glob("*_day_all_none.parquet"):
            symbol_code = file.name.split("_", 1)[0]
            if not re.match(r"^(sh6|sz0|sz3|bj[489])", symbol_code):
                continue
            try:
                bars = read_bars(file)["bars"]
            except (OSError, ParquetStoreError):
                continue
            scanned += 1
            position = next((i for i, bar in enumerate(bars) if bar.get("date") == date), -1)
            if position <= 0:
                continue
            bar = bars[position]
            previous = bars[position - 1]
            close = float(bar.get("close") or 0)
            previous_close = float(previous.get("close") or 0)
            if close <= 0 or previous_close <= 0:
                continue
            market = symbol_code[:2].upper()
            name = str(by_code.get(symbol_code, {}).get("name") or symbol_code.upper())
            symbol = symbol_code[2:]
            if "ST" in name.upper():
                limit_pct = 5.0
            elif market == "BJ":
                limit_pct = 30.0
            elif symbol.startswith(("300", "301", "688", "689")):
                limit_pct = 20.0
            else:
                limit_pct = 10.0
            upper = round(previous_close * (1 + limit_pct / 100), 2)
            lower = round(previous_close * (1 - limit_pct / 100), 2)
            high = float(bar.get("high") or 0)
            low = float(bar.get("low") or 0)
            if close >= upper - 0.001:
                kind = "up"
            elif low <= lower + 0.001:
                kind = "down"
            elif high >= upper - 0.001:
                kind = "broken"
            else:
                continue
            rows.append(
                {
                    "code": symbol_code,
                    "name": name,
                    "date": date,
                    "close": close,
                    "prevClose": previous_close,
                    "changePct": (close - previous_close) / previous_close * 100,
                    "high": high,
                    "low": low,
                    "limitPrice": upper if kind == "up" else lower,
                    "kind": kind,
                }
            )
        rows.sort(key=lambda row: row["changePct"], reverse=True)
        return {"date": date, "rows": rows, "scanned": scanned}

    def cache_klines(
        self,
        codes: list[str],
        period: str = "day",
        count: int = 800,
        adjust: str = "qfq",
        skip_existing: bool = False,
    ) -> dict:
        """批量预热 K 线缓存；skip_existing 用于断点续跑。"""
        cached = 0
        skipped = 0
        failed: list[dict] = []
        safe_count = max(1, min(800, int(count)))
        for code in codes:
            try:
                if skip_existing and _kline_cache_path(
                    code, period, safe_count, adjust
                ).exists():
                    skipped += 1
                    continue
                self.kline(code, period, count, adjust)
                cached += 1
            except Exception as error:  # noqa: BLE001 - 需要把每只的失败原因返回给 UI
                failed.append({"code": code, "error": str(error)})
        return {
            "cached": cached,
            "skipped": skipped,
            "failed": failed,
            "period": period,
            "count": safe_count,
            "dir": str(kline_cache_dir()),
        }

    def _raw_daily(self, code: str, count: int, market: int, symbol: str) -> list[dict]:
        kind = "index" if is_index_code(market, symbol) else "stock"
        body = self.conn.request(
            CMD_BARS, bars_data(market, symbol, PERIOD_RAW["day"], count, 0)
        )
        return parse_bars(body, kind, PERIOD_RAW["day"])

    def minute(self, code: str, now: datetime | None = None) -> dict:
        market, symbol = parse_code(code)
        moment = now or datetime.now(SHANGHAI_TZ)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=SHANGHAI_TZ)
        else:
            moment = moment.astimezone(SHANGHAI_TZ)
        today = moment.strftime("%Y-%m-%d")
        clock, session = shanghai_clock(moment)
        cached = self.minute_daily_cache.get(code)
        if cached and cached[0] > time.time() and cached[1] == today:
            daily = cached[2]
        else:
            daily = self._raw_daily(code, 2, market, symbol)
            self.minute_daily_cache[code] = (time.time() + 30, today, daily)
        last = daily[-1] if daily else None
        previous = daily[-2] if len(daily) >= 2 else None

        # 分时数据属于哪个交易日：开盘后是今天；周末/节假日/凌晨是日线最后一根。
        # 后者的 0x0537 返回上一交易日的分时，昨收要取再往前一根，不能取 last.close，
        # 否则整张分时图的 0% 基准和涨跌幅都会错（2026-11-14 周六实测）。
        today_session = session in {"pre-open", "trading", "lunch-break"} or (
            session == "closed" and clock >= "15:00:00"
        )
        if today_session:
            trade_date = today
            if last and last["date"] == today:
                prev_close = previous["close"] if previous else last["close"]
            else:
                # 09:30 第一秒时今天的日线可能还没生成：daily 最后一根是昨天。
                prev_close = last["close"] if last else 0.0
        else:
            trade_date = str(last["date"]) if last else today
            prev_close = (
                previous["close"] if previous else (last["close"] if last else 0.0)
            )

        body = self.conn.request(CMD_MINUTE, minute_data(market, symbol))
        return parse_today_minute(
            body,
            code=code,
            name=self._name(code, symbol),
            date=trade_date,
            prev_close=prev_close,
            decimal=self._decimal(code),
        )

    def minute_archive_save(self, code: str) -> dict:
        market, symbol = parse_code(code)
        # 0x0537 响应没有日期；用日线最后一根确认真实交易日，周末/节假日
        # 不能把上一交易日的分时写成今天。
        daily = self._raw_daily(code, 2, market, symbol)
        if not daily:
            raise TdxError("无法确认分时对应的交易日")
        trade_date = str(daily[-1]["date"])
        result = self.minute(code)
        result["date"] = trade_date
        rows = [
            {
                "code": code,
                "date": result["date"],
                "time": point["time"],
                "price": point["price"],
                "avg": point["avg"],
                "volume": point["volume"],
            }
            for point in result["points"]
        ]
        return {
            "code": code,
            "date": result["date"],
            "rows": len(rows),
            # 分时是「每只一份」的当日快照，必须按代码分片；
            # 早期版本写同一个 dataset 文件，第二只起会被 skipped 丢掉。
            "archive": write_code_archive(
                pythontdx_data_dir() / "lake" / "today_minute",
                "today_minute",
                code,
                rows,
                source="TDX 7709 0x0537",
                trade_date=result["date"],
                fields=["code", "date", "time", "price", "avg", "volume"],
            ),
        }

    def minute_archive_list(self, limit: int = 50) -> list[dict]:
        root = pythontdx_data_dir() / "lake" / "today_minute"
        return _merge_archive_lists(root, limit)

    def minute_aux(self, code: str, kind: str = "buy_sell_strength") -> dict:
        market, symbol = parse_code(code)
        key = str(kind or "").strip().lower()
        selector = 0x0B if key in {"volume_comparison", "volume_compare", "0x0b", "11"} else 0
        body = self.conn.request(
            CMD_MINUTE_AUX, minute_aux_data(market, symbol, selector)
        )
        result = parse_minute_aux(body, selector)
        return {"code": code, "kind": "volume_comparison" if selector == 0x0B else "buy_sell_strength", **result}

    def minute_aux_archive_save(self, code: str, kind: str = "buy_sell_strength") -> dict:
        result = self.minute_aux(code, kind)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return {
            **result,
            "archive": write_code_archive(
                pythontdx_data_dir() / "lake" / "minute_aux",
                "minute_aux",
                f"{code}_{result['kind']}",
                [{"code": code, "kind": result["kind"], "time": point["time"], **point} for point in result["points"]],
                source=f"TDX 7709 0x051b selector={result['selector']}",
                trade_date=trade_date,
                fields=["code", "kind", "time", "seriesA", "seriesB", "buyCommission", "sellCommission", "previousDayCumulativeVolume", "currentDayCumulativeVolume"],
            ),
        }

    def sparkline(self, code: str, selector: int = 1, window: int = 20) -> dict:
        market, symbol = parse_code(code)
        body = self.conn.request(
            CMD_SPARKLINE, sparkline_data(market, symbol, selector, window)
        )
        return {"code": code, "selector": selector, **parse_sparkline(body)}

    def sparkline_archive_save(self, code: str, selector: int = 1, window: int = 20) -> dict:
        result = self.sparkline(code, selector, window)
        trade_date = datetime.now().astimezone().strftime("%Y-%m-%d")
        return {
            **result,
            "archive": write_code_archive(
                pythontdx_data_dir() / "lake" / "sparkline",
                "sparkline",
                f"{code}_s{selector}",
                [{"code": code, "selector": selector, "index": index, "price": price} for index, price in enumerate(result["prices"])],
                source=f"TDX 7709 0x0fd1 selector={selector}",
                trade_date=trade_date,
                fields=["code", "selector", "index", "price"],
            ),
        }

    def minute_aux_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "minute_aux", limit
        )

    def sparkline_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "sparkline", limit
        )

    def recent_minute(self, code: str, date: str | None = None) -> dict:
        market, symbol = parse_code(code)
        date_text = str(date or datetime.now().astimezone().strftime("%Y-%m-%d"))
        body = self.conn.request(CMD_RECENT_MINUTE, recent_minute_data(market, symbol, date_text))
        return parse_recent_minute(
            body, code, self._name(code, symbol), date_text, self._decimal(code)
        )

    def recent_minute_archive_save(self, code: str, date: str | None = None) -> dict:
        result = self.recent_minute(code, date)
        return {
            **result,
            "archive": write_code_archive(
                pythontdx_data_dir() / "lake" / "recent_minute",
                "recent_minute",
                code,
                [
                    {"code": code, "date": result["date"], **point}
                    for point in result["points"]
                ],
                source="TDX 7709 0x0feb",
                trade_date=result["date"],
                fields=["code", "date", "time", "price", "avg", "volume"],
            ),
        }

    def recent_minute_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "recent_minute", limit
        )

    def history_minute(self, code: str, date: str) -> dict:
        market, symbol = parse_code(code)
        try:
            day = datetime.strptime(str(date), "%Y-%m-%d").date()
        except ValueError as error:
            raise TdxError("历史分时日期必须是 YYYY-MM-DD") from error
        body = self.conn.request(
            CMD_HISTORY_MINUTE,
            history_minute_data(market, symbol, int(day.strftime("%Y%m%d"))),
        )
        return parse_history_minute(
            body,
            code=code,
            name=self._name(code, symbol),
            date=day.isoformat(),
            prev_close=0.0,
            decimal=self._decimal(code),
        )

    def history_minute_archive_save(self, code: str, date: str) -> dict:
        result = self.history_minute(code, date)
        return {
            **result,
            "archive": write_code_archive(
                pythontdx_data_dir() / "lake" / "history_minute",
                "history_minute",
                code,
                [
                    {"code": code, "date": result["date"], **point}
                    for point in result["points"]
                ],
                source="TDX 7709 0x0fb4",
                trade_date=result["date"],
                fields=["code", "date", "time", "price", "avg", "volume"],
            ),
        }

    def history_minute_archive_list(self, limit: int = 50) -> list[dict]:
        return _merge_archive_lists(
            pythontdx_data_dir() / "lake" / "history_minute", limit
        )

    def five_day(self, code: str) -> dict:
        market, symbol = parse_code(code)
        daily = self._raw_daily(code, 6, market, symbol)
        recent = daily[-5:]
        days: list[dict] = []

        for index, bar in enumerate(recent):
            previous_close = recent[index - 1]["close"] if index > 0 else bar["open"]
            date = int(bar["date"].replace("-", ""))
            body = self.conn.request(
                CMD_HISTORY_MINUTE, history_minute_data(market, symbol, date)
            )
            days.append(
                parse_history_minute(
                    body,
                    code=code,
                    name=self._name(code, symbol),
                    date=bar["date"],
                    prev_close=previous_close,
                    decimal=self._decimal(code),
                )
            )

        return {"code": code, "name": self._name(code, symbol), "days": days}


# ---------------------------------------------------------------- JSON Lines


OFFLINE_BULK_COMMANDS = {
    "cache_klines",
    "export_klines",
    "archive_datasets",
    "archive_snapshot",
    "tick_archive_save",
    "tick_archive_batch",
    "auction_archive_save",
    "auction_archive_batch",
    "minute_archive_save",
    "minute_aux_archive_save",
    "sparkline_archive_save",
    "recent_minute_archive_save",
    "history_minute_archive_save",
    "special_limits_archive_save",
    "delisted_archive_save",
    "category_archive_save",
    "finance_archive_save",
    "capital_archive_save",
    "block_meta_archive_save",
    "top_board_archive_save",
    "volume_profile_archive_save",
    "unusual_archive_save",
    "finance_history_archive_save",
    "f10_channel_news_archive_save",
    "f10_market_news_archive_save",
    "f10_market_report_archive_save",
    "f10_detail_archive_save",
    "gbbq_archive_save",
    "f10_limit_board_archive_save",
}


def dispatch(bridge: Bridge, cmd: str, payload: dict) -> object:
    if cmd in OFFLINE_BULK_COMMANDS:
        from offline_sync import offline_window

        window = offline_window(root=pythontdx_data_dir())
        if not window["open"]:
            raise TdxError(
                f"{window['reason']}；{window['nextOpenAt']} 后再下载"
                "（或使用数据工具的「并行离线同步」，它自带窗口保护与断点续跑）"
            )
    if cmd == "ping":
        return "pong"
    if cmd == "server_speed_test":
        return bridge.server_speed_test()
    if cmd == "market_status":
        return bridge.market_status(bool(payload.get("force")))
    if cmd == "select_server":
        return bridge.select_server(str(payload.get("host") or ""))
    if cmd == "code_list":
        return bridge.code_list()
    if cmd == "quotes":
        return bridge.quotes(payload.get("codes") or [])
    if cmd == "snapshots":
        return bridge.snapshots(payload.get("codes") or [])
    if cmd == "mac_quotes":
        return bridge.mac_quotes(payload.get("codes") or [])
    if cmd == "mac_quotes_finance":
        return bridge.mac_quotes_finance(payload.get("codes") or [])
    if cmd == "mac_money_flow":
        return bridge.mac_money_flow(str(payload.get("code") or ""))
    if cmd == "mac_money_flow_batch":
        return bridge.mac_money_flow_batch(
            payload.get("codes") or [], int(payload.get("workers", 12))
        )
    if cmd == "mac_unusual":
        return bridge.mac_unusual(int(payload.get("count", 600)))
    if cmd == "gbbq_read":
        return bridge.gbbq_read(
            payload.get("path"),
            int(payload.get("limit", 5000)),
            int(payload.get("offset") or 0),
        )
    if cmd == "gbbq_archive_save":
        return bridge.gbbq_archive_save(payload.get("path"))
    if cmd == "finance_history_catalog":
        return bridge.finance_history_catalog()
    if cmd == "finance_history_archive_save":
        return bridge.finance_history_archive_save(str(payload.get("filename") or ""))
    if cmd == "finance_history_archive_list":
        return bridge.finance_history_archive_list(int(payload.get("limit", 50)))
    if cmd == "server_info":
        return bridge.server_info()
    if cmd == "mac_server_info":
        return bridge.mac_server_info()
    if cmd == "mac_symbol_info":
        return bridge.mac_symbol_info(str(payload.get("code") or ""))
    if cmd == "mac_quote_detail":
        return bridge.mac_quote_detail(
            str(payload.get("code") or ""), int(payload.get("date") or 0)
        )
    if cmd == "mac_kline":
        return bridge.mac_kline(
            str(payload.get("code") or ""),
            str(payload.get("period") or "day"),
            int(payload.get("start") or 0),
            int(payload.get("count") or 800),
            str(payload.get("adjust") or "none"),
        )
    if cmd == "mac_full_kline":
        return bridge.mac_full_kline(
            str(payload.get("code") or ""),
            str(payload.get("period") or "day"),
            str(payload.get("adjust") or "none"),
        )
    if cmd == "mac_board_members":
        return bridge.mac_board_members(
            str(payload.get("board") or ""),
            int(payload.get("start") or 0),
            int(payload.get("pageSize") or 80),
        )
    if cmd == "mac_file_meta":
        return bridge.mac_file_meta(str(payload.get("filename") or ""))
    if cmd == "mac_file_chunk":
        return bridge.mac_file_chunk(
            str(payload.get("filename") or ""),
            int(payload.get("index") or 1),
            int(payload.get("offset") or 0),
            int(payload.get("size") or 30000),
        )
    if cmd == "mac_kline_offset":
        return bridge.mac_kline_offset(
            int(payload.get("offset") or 0), int(payload.get("count") or 128000)
        )
    if cmd == "mac_auctions":
        return bridge.mac_auctions(
            str(payload.get("code") or ""),
            int(payload.get("start") or 0),
            int(payload.get("count") or 500),
        )
    if cmd == "mac_tick_charts":
        return bridge.mac_tick_charts(
            str(payload.get("code") or ""),
            int(payload.get("date") or 0),
            int(payload.get("days") or 5),
        )
    if cmd == "unusual":
        return bridge.unusual(
            int(payload.get("count", 600)),
            payload.get("market") if payload.get("market") is not None else None,
        )
    if cmd == "unusual_archive_save":
        return bridge.unusual_archive_save(int(payload.get("count", 600)))
    if cmd == "unusual_archive_list":
        return bridge.unusual_archive_list(int(payload.get("limit", 50)))
    if cmd == "top_board":
        return bridge.top_board(
            int(payload.get("category", 0)), int(payload.get("size", 20))
        )
    if cmd == "top_board_archive_save":
        return bridge.top_board_archive_save(
            int(payload.get("category", 0)), int(payload.get("size", 20))
        )
    if cmd == "top_board_archive_list":
        return bridge.top_board_archive_list(int(payload.get("limit", 50)))
    if cmd == "volume_profile":
        return bridge.volume_profile(str(payload.get("code") or ""))
    if cmd == "volume_profile_archive_save":
        return bridge.volume_profile_archive_save(str(payload.get("code") or ""))
    if cmd == "volume_profile_archive_list":
        return bridge.volume_profile_archive_list(int(payload.get("limit", 50)))
    if cmd == "mac_boards":
        return bridge.mac_boards(int(payload.get("boardType", 255)))
    if cmd == "refresh":
        return bridge.refresh_quotes(
            payload.get("codes") or [], payload.get("cursors") or {}
        )
    if cmd == "live_quotes":
        return bridge.live_quotes(payload.get("codes") or [])
    if cmd == "category":
        return bridge.category_quotes(
            category=int(payload.get("category", 6)),
            sort_type=int(payload.get("sortType", payload.get("sort_type", 0))),
            start=int(payload.get("start", 0)),
            count=int(payload.get("count", 80)),
            ascending=bool(payload.get("ascending", False)),
            filter_raw=int(payload.get("filterRaw", payload.get("filter_raw", 0))),
        )
    if cmd == "category_snapshot":
        return bridge.category_snapshot(
            int(payload.get("category", 6)),
            int(payload.get("sortType", 0)),
            int(payload.get("maxPages", 100)),
        )
    if cmd == "category_archive_save":
        return bridge.category_archive_save(
            int(payload.get("category", 6)), int(payload.get("sortType", 0))
        )
    if cmd == "category_archive_list":
        return bridge.category_archive_list(int(payload.get("limit", 50)))
    if cmd == "trades":
        return bridge.trades(
            payload.get("code", ""),
            start=int(payload.get("start", 0)),
            count=int(payload.get("count", TRADE_PAGE)),
            trading_date=payload.get("date") or None,
        )
    if cmd == "auctions":
        return bridge.auctions(
            payload.get("code", ""),
            trading_date=payload.get("date") or None,
            selector=int(payload.get("selector", 0)),
            start=int(payload.get("start", 0)),
            limit=int(payload.get("limit", AUCTION_LIMIT)),
        )
    if cmd == "auction_quotes":
        return bridge.auction_quotes(payload.get("codes") or [])
    if cmd == "auction_archive_save":
        return bridge.auction_archive_save(
            str(payload.get("code") or ""), payload.get("date") or None
        )
    if cmd == "auction_archive_read":
        return bridge.auction_archive_read(
            str(payload.get("code") or ""), str(payload.get("date") or "")
        )
    if cmd == "auction_archive_list":
        return bridge.auction_archive_list(int(payload.get("limit", 50)))
    if cmd == "auction_archive_batch":
        return bridge.auction_archive_batch(
            payload.get("codes") or [], payload.get("date") or None
        )
    if cmd == "tick_archive_save":
        return bridge.tick_archive_save(
            str(payload.get("code") or ""), str(payload.get("date") or "")
        )
    if cmd == "tick_archive_read":
        return bridge.tick_archive_read(
            str(payload.get("code") or ""),
            str(payload.get("date") or ""),
            int(payload.get("start", 0)),
            int(payload.get("count", TRADE_PAGE)),
        )
    if cmd == "tick_archive_dates":
        return bridge.tick_archive_dates(
            str(payload.get("code") or ""),
            str(payload.get("start") or "") or None,
            str(payload.get("end") or "") or None,
            int(payload.get("days", 20)),
        )
    if cmd == "tick_archive_list":
        return bridge.tick_archive_list(int(payload.get("limit", 20)))
    if cmd == "tick_archive_batch":
        return bridge.tick_archive_batch(
            payload.get("codes") or [], str(payload.get("date") or "")
        )
    if cmd == "server_catalog":
        return bridge.server_catalog()
    if cmd == "flow_archive_list":
        return list_flow_archives(
            pythontdx_data_dir() / "lake" / "money_flow", int(payload.get("limit", 50))
        )
    if cmd == "flow_archive_read":
        return read_flow_archive(
            pythontdx_data_dir() / "lake" / "money_flow",
            str(payload.get("code") or ""),
            str(payload.get("date") or ""),
        )
    if cmd == "server_catalog_list":
        return bridge.server_catalog_list(int(payload.get("limit", 20)))
    if cmd == "file_read":
        return bridge.file_read(
            payload.get("path", ""),
            offset=int(payload.get("offset", 0)),
            size=int(payload.get("size", FILE_CHUNK)),
        )
    if cmd == "block_meta":
        return bridge.block_meta(str(payload.get("filename") or ""))
    if cmd == "block_meta_archive_save":
        return bridge.block_meta_archive_save(str(payload.get("filename") or ""))
    if cmd == "block_meta_archive_list":
        return bridge.block_meta_archive_list(int(payload.get("limit", 50)))
    if cmd == "file_download":
        return bridge.file_download(
            payload.get("path", ""),
            chunk_size=int(payload.get("chunkSize", FILE_CHUNK)),
            max_bytes=int(payload.get("maxBytes", MAX_FILE_BYTES)),
        )
    if cmd == "tdx_stats":
        return bridge.tdx_stats()
    if cmd == "tdx_stats_export":
        return bridge.tdx_stats_export()
    if cmd == "blocks":
        return bridge.blocks(str(payload.get("kind") or "gn"))
    if cmd == "industries":
        return bridge.industries()
    if cmd == "archive_datasets":
        return bridge.archive_datasets([str(code) for code in payload.get("codes") or []])
    if cmd == "screen":
        return bridge.screen(payload.get("filters") or {})
    if cmd == "local_day_read":
        return bridge.local_day_read(str(payload.get("path") or ""), int(payload.get("limit", 0)))
    if cmd == "local_import":
        return bridge.local_import(str(payload.get("path") or ""))
    if cmd == "archive_snapshot":
        return bridge.archive_snapshot()
    if cmd == "lake_archives":
        return bridge.lake_archives(int(payload.get("limit", 20)))
    if cmd == "dataset_archive_read":
        return bridge.dataset_archive_read(
            str(payload.get("dataset") or ""), str(payload.get("date") or "")
        )
    if cmd == "code_archive_read":
        from code_archive import read_code_archive

        dataset = str(payload.get("dataset") or "").strip()
        roots = {
            "today_minute": "today_minute",
            "minute_aux": "minute_aux",
            "sparkline": "sparkline",
            "recent_minute": "recent_minute",
            "history_minute": "history_minute",
            "volume_profile": "volume_profile",
            "top_board": "top_board",
            "block_meta": "server_meta",
            "category_quotes": "category_quotes",
            "market_news": "market_news",
            "channel_news": "channel_news",
            "f10_market": "f10_market",
            "f10_detail": "f10_detail",
        }
        if dataset not in roots:
            raise TdxError(f"不支持的分片归档 dataset：{dataset}")
        return read_code_archive(
            pythontdx_data_dir() / "lake" / roots[dataset],
            str(payload.get("key") or ""),
            str(payload.get("date") or ""),
            dataset=dataset,
        )
    if cmd == "export_klines":
        return bridge.export_klines(
            payload.get("codes") or [],
            str(payload.get("period") or "day"),
            int(payload.get("count", 240)),
            str(payload.get("adjust") or "qfq"),
        )
    if cmd == "local_day_write":
        bars = payload.get("bars") or []
        if not isinstance(bars, list):
            raise TdxError("bars 必须是数组")
        return bridge.local_day_write(str(payload.get("path") or ""), bars)
    if cmd == "local_min_write":
        bars = payload.get("bars") or []
        if not isinstance(bars, list):
            raise TdxError("bars 必须是数组")
        return bridge.local_min_write(str(payload.get("path") or ""), bars)
    if cmd == "breadth_begin":
        return bridge.breadth_begin()
    if cmd == "breadth_step":
        return bridge.breadth_step(
            int(payload.get("scanId", 0)),
            int(payload.get("pages", 8)),
        )
    if cmd == "invalidate_caches":
        return bridge.invalidate_caches()
    if cmd == "formula_backtest":
        return bridge.formula_backtest(
            str(payload.get("expression") or ""),
            int(payload.get("scope", 100)),
            int(payload.get("offset", 0)),
            int(payload.get("batchSize", 100)),
        )
    if cmd == "formula_screen":
        return bridge.formula_screen(
            str(payload.get("expression") or ""),
            int(payload.get("scope", 100)),
            int(payload.get("limit", 100)),
            int(payload.get("offset", 0)),
            int(payload.get("batchSize", 100)),
        )
    if cmd == "local_query":
        return run_local_query(str(payload.get("sql") or ""), int(payload.get("limit", 200)))
    if cmd == "stats_query":
        return bridge.stats_query(
            str(payload.get("sql") or ""),
            int(payload.get("limit", 200)),
        )
    if cmd == "stats_csv":
        return bridge.stats_csv()
    if cmd == "stats_parquet":
        return bridge.stats_parquet()
    if cmd == "stats_duck_query":
        return bridge.stats_duck_query(
            str(payload.get("sql") or ""),
            int(payload.get("limit", 200)),
        )
    if cmd == "money_flow":
        return bridge.money_flow(payload.get("code", ""))
    if cmd == "f10_catalog":
        return bridge.f10_catalog(payload.get("code", ""))
    if cmd == "f10_content":
        return bridge.f10_content(
            payload.get("code", ""),
            payload.get("filename", ""),
            int(payload.get("start", 0)),
            int(payload.get("length", 0)),
        )
    if cmd == "f10_announcements":
        return bridge.f10_announcements(payload.get("code", ""))
    if cmd == "f10_profile":
        return bridge.f10_profile(payload.get("code", ""))
    if cmd == "f10_pit_list":
        return list_f10_snapshots(
            pythontdx_data_dir() / "lake" / "f10_pit", int(payload.get("limit", 50))
        )
    if cmd == "f10_pit_read":
        return read_f10_snapshot(
            pythontdx_data_dir() / "lake" / "f10_pit",
            str(payload.get("code") or ""),
            str(payload.get("table") or ""),
            str(payload.get("date") or ""),
        )
    if cmd == "f10_valuation":
        return bridge.f10_valuation(payload.get("code", ""))
    if cmd == "f10_finance":
        return bridge.f10_finance(payload.get("code", ""))
    if cmd == "f10_business":
        return bridge.f10_business(payload.get("code", ""))
    if cmd == "f10_shareholders":
        return bridge.f10_shareholders(payload.get("code", ""))
    if cmd == "f10_reports":
        return bridge.f10_reports(payload.get("code", ""))
    if cmd == "f10_news":
        return bridge.f10_news(payload.get("code", ""))
    if cmd == "news_channels":
        from tdx_f10 import NEWS_CHANNEL_GROUPS, NEWS_CHANNELS

        return {"channels": NEWS_CHANNELS, "groups": NEWS_CHANNEL_GROUPS}
    if cmd == "f10_stock_info":
        return bridge.f10_stock_info(payload.get("code", ""))
    if cmd == "f10_topic_ids":
        return bridge.f10_topic_ids(payload.get("code", ""))
    if cmd == "f10_finance_diagnosis":
        return bridge.f10_finance_diagnosis(
            payload.get("code", ""), str(payload.get("section") or "zzyj")
        )
    if cmd == "f10_stock_score":
        return bridge.f10_stock_score(
            payload.get("code", ""),
            str(payload.get("section") or "pf"),
            str(payload.get("arg") or ""),
        )
    if cmd == "f10_topic_compare":
        return bridge.f10_topic_compare(
            payload.get("code", ""),
            str(payload.get("topicId") or ""),
            str(payload.get("section") or "gndbzfsj"),
            str(payload.get("sortBy") or "zdf"),
        )
    if cmd == "f10_allotment_dates":
        return bridge.f10_allotment_dates(payload.get("code", ""))
    if cmd == "f10_allotment_details":
        return bridge.f10_allotment_details(
            payload.get("code", ""), str(payload.get("date") or "")
        )
    if cmd == "f10_hq_nlp":
        raw_days = payload.get("days")
        return bridge.f10_hq_nlp(
            str(payload.get("code") or ""),
            str(payload.get("reqId") or ""),
            int(raw_days) if raw_days not in (None, "") else None,
            int(payload.get("pageSize") or 10),
        )
    if cmd == "f10_industry_page":
        return bridge.f10_industry_page(
            str(payload.get("hy") or ""), str(payload.get("section") or "hqtj")
        )
    if cmd == "f10_board_member_quotes":
        return bridge.f10_board_member_quotes(
            str(payload.get("boardCode") or ""), int(payload.get("boardMarket") or 1)
        )
    if cmd == "f10_limit_board_archive_save":
        return bridge.f10_limit_board_archive_save(
            payload.get("startDate"), payload.get("endDate")
        )
    if cmd == "f10_limit_board_ladder":
        return bridge.f10_limit_board_ladder(
            payload.get("startDate"),
            payload.get("endDate"),
            bool(payload.get("includeSummary")),
        )
    if cmd == "f10_finance_weights":
        return bridge.f10_finance_weights(
            str(payload.get("code") or ""), str(payload.get("section") or "zcfzb")
        )
    if cmd == "f10_digest":
        return bridge.f10_digest(
            str(payload.get("code") or ""), str(payload.get("section") or "tips")
        )
    if cmd == "f10_market_news":
        return bridge.f10_market_news(
            int(payload.get("tab", 3)),
            int(payload.get("page", 1)),
            int(payload.get("pageSize", 50)),
        )
    if cmd == "f10_channel_news":
        return bridge.f10_channel_news(
            int(payload.get("channel", 201)),
            int(payload.get("page", 1)),
            int(payload.get("pageSize", 50)),
            str(payload.get("keyword") or ""),
        )
    if cmd == "f10_channel_news_archive_save":
        return bridge.f10_channel_news_archive_save(
            int(payload.get("channel", 201)),
            int(payload.get("page", 1)),
            int(payload.get("pageSize", 50)),
            str(payload.get("keyword") or ""),
        )
    if cmd == "f10_channel_news_archive_list":
        return bridge.f10_channel_news_archive_list(int(payload.get("limit", 50)))
    if cmd == "f10_market_news_archive_save":
        return bridge.f10_market_news_archive_save(
            int(payload.get("tab", 3)),
            int(payload.get("page", 1)),
            int(payload.get("pageSize", 50)),
        )
    if cmd == "f10_market_news_archive_list":
        return bridge.f10_market_news_archive_list(int(payload.get("limit", 50)))
    if cmd == "f10_market_report":
        return bridge.f10_market_report(
            str(payload.get("code") or ""),
            str(payload.get("section") or "board_info"),
            str(payload.get("arg") or ""),
            int(payload.get("page", 1)),
            int(payload.get("pageSize", 20)),
        )
    if cmd == "f10_market_report_archive_save":
        return bridge.f10_market_report_archive_save(
            str(payload.get("code") or ""),
            str(payload.get("section") or "board_info"),
            str(payload.get("arg") or ""),
            int(payload.get("page", 1)),
            int(payload.get("pageSize", 20)),
        )
    if cmd == "f10_market_report_archive_list":
        return bridge.f10_market_report_archive_list(int(payload.get("limit", 50)))
    if cmd == "f10_profit_forecast":
        return bridge.f10_profit_forecast(
            str(payload.get("code") or ""), str(payload.get("section") or "ylyctj")
        )
    if cmd == "f10_governance":
        return bridge.f10_governance(
            str(payload.get("code") or ""), str(payload.get("section") or "gljy")
        )
    if cmd == "f10_hot_topics":
        return bridge.f10_hot_topics(
            str(payload.get("code") or ""), str(payload.get("section") or "zttzbkz")
        )
    if cmd == "f10_fund_report":
        return bridge.f10_fund_report(
            str(payload.get("code") or ""),
            str(payload.get("section") or "basic"),
            str(payload.get("arg") or ""),
            str(payload.get("date") or ""),
            int(payload.get("page", 1)),
            int(payload.get("pageSize", 20)),
        )
    if cmd == "f10_detail":
        return bridge.f10_detail(
            str(payload.get("detailType") or ""), str(payload.get("recordId") or "")
        )
    if cmd == "f10_detail_archive_save":
        return bridge.f10_detail_archive_save(
            str(payload.get("detailType") or ""), str(payload.get("recordId") or "")
        )
    if cmd == "f10_detail_archive_list":
        return bridge.f10_detail_archive_list(int(payload.get("limit", 50)))
    if cmd == "f10_ranking_detail":
        return bridge.f10_ranking_detail(
            str(payload.get("code") or ""), str(payload.get("section") or "scpmdela")
        )
    if cmd == "f10_northbound_holding":
        return bridge.f10_northbound_holding(
            str(payload.get("code") or ""),
            str(payload.get("section") or "bszj"),
            int(payload.get("page", 1)),
            int(payload.get("pageSize", 20)),
        )
    if cmd == "f10_industry":
        return bridge.f10_industry(
            str(payload.get("code") or ""), str(payload.get("section") or "summary")
        )
    if cmd == "f10_lhb_market":
        return bridge.f10_lhb_market()
    if cmd == "f10_change_plans":
        return bridge.f10_change_plans(str(payload.get("code") or ""))
    if cmd == "f10_controller":
        return bridge.f10_controller(str(payload.get("code") or ""))
    if cmd == "f10_institutions":
        return bridge.f10_institutions(str(payload.get("code") or ""))
    if cmd == "f10_shareholder_changes":
        return bridge.f10_shareholder_changes(str(payload.get("code") or ""))
    if cmd == "f10_circulating_shareholders":
        return bridge.f10_circulating_shareholders(str(payload.get("code") or ""))
    if cmd == "f10_capital":
        return bridge.f10_capital(str(payload.get("code") or ""), str(payload.get("section") or "structure"))
    if cmd == "f10_shareholder_count":
        return bridge.f10_shareholder_count(str(payload.get("code") or ""))
    if cmd == "f10_dividend":
        return bridge.f10_dividend(str(payload.get("code") or ""))
    if cmd == "f10_market":
        return bridge.f10_market(str(payload.get("section") or "basic"))
    if cmd == "f10_trading":
        return bridge.f10_trading(payload.get("code", ""), str(payload.get("section", "margin")))
    if cmd == "f10_statement":
        return bridge.f10_statement(
            payload.get("code", ""),
            str(payload.get("kind", "zcfzb")),
            bool(payload.get("full", False)),
        )
    if cmd == "finance_snapshot":
        return bridge.finance_snapshot(list(payload.get("codes") or []))
    if cmd == "finance_archive_save":
        return bridge.finance_archive_save(list(payload.get("codes") or []))
    if cmd == "finance_archive_list":
        return bridge.finance_archive_list(int(payload.get("limit", 50)))
    if cmd == "capital_changes":
        return bridge.capital_changes(list(payload.get("codes") or []))
    if cmd == "capital_archive_save":
        return bridge.capital_archive_save(list(payload.get("codes") or []))
    if cmd == "capital_archive_list":
        return bridge.capital_archive_list(int(payload.get("limit", 50)))
    if cmd == "adjustment_factors":
        return bridge.adjustment_factors(
            str(payload.get("code") or ""),
            payload.get("anchorDate") or None,
            payload.get("startDate") or None,
        )
    if cmd == "local_adjust_kline":
        return bridge.local_adjust_kline(
            str(payload.get("code") or ""),
            str(payload.get("period") or "day"),
            str(payload.get("adjust") or "qfq"),
            int(payload.get("count", 800)),
        )
    if cmd == "special_limits":
        return bridge.special_limits(int(payload.get("startIndex", 0)))
    if cmd == "scan_special_limits":
        return bridge.scan_special_limits(int(payload.get("maxRows", 10000)))
    if cmd == "delisted_kline":
        return bridge.delisted_kline(
            str(payload.get("code") or ""),
            int(payload.get("start", 0)),
            int(payload.get("count", 800)),
        )
    if cmd == "delisted_history":
        return bridge.delisted_history(
            str(payload.get("code") or ""),
            int(payload.get("pageSize", 800)),
            int(payload.get("maxPages", 200)),
        )
    if cmd == "special_limits_archive_save":
        return bridge.special_limits_archive_save(int(payload.get("maxRows", 10000)))
    if cmd == "special_limits_archive_list":
        return bridge.special_limits_archive_list(int(payload.get("limit", 50)))
    if cmd == "delisted_archive_save":
        return bridge.delisted_archive_save(
            str(payload.get("code") or ""),
            int(payload.get("pageSize", 800)),
            int(payload.get("maxPages", 200)),
        )
    if cmd == "delisted_archive_list":
        return bridge.delisted_archive_list(int(payload.get("limit", 100)))
    if cmd == "kline":
        return bridge.kline(
            payload.get("code", ""),
            payload.get("period", "day"),
            payload.get("count", 200),
            str(payload.get("adjust", "qfq")),
            bool(payload.get("cacheOnly")),
            payload.get("anchorDate") or None,
            int(payload.get("start", 0)),
        )
    if cmd == "kline_cached":
        return bridge.kline_cached(
            str(payload.get("code") or ""),
            str(payload.get("period") or "day"),
            int(payload.get("count", 200)),
            str(payload.get("adjust") or "qfq"),
            bool(payload.get("cacheOnly")),
            payload.get("anchorDate") or None,
            bool(payload.get("fresh")),
            int(payload.get("start", 0)),
        )
    if cmd == "kline_live":
        return bridge.kline_live(
            str(payload.get("code") or ""),
            str(payload.get("period") or "day"),
            int(payload.get("count", 800)),
            str(payload.get("adjust") or "qfq"),
            bool(payload.get("first")),
        )
    if cmd == "data_integrity":
        return verify_data_integrity(pythontdx_data_dir())
    if cmd == "offline_sync_window":
        from offline_sync import offline_window

        return offline_window(root=pythontdx_data_dir())
    if cmd == "offline_sync_catalog":
        from offline_sync import PRESETS, dataset_catalog, offline_window

        return {
            "datasets": dataset_catalog(),
            "presets": PRESETS,
            "window": offline_window(root=pythontdx_data_dir()),
        }
    if cmd == "offline_sync_start":
        from offline_sync import manager as offline_manager

        return offline_manager().start(payload)
    if cmd == "offline_sync_status":
        from offline_sync import manager as offline_manager

        return offline_manager().status()
    if cmd == "offline_sync_cancel":
        from offline_sync import manager as offline_manager

        return offline_manager().cancel()
    if cmd == "data_coverage":
        return collect_data_coverage(pythontdx_data_dir())
    if cmd == "data_inventory":
        return data_inventory()
    if cmd == "backup_create":
        return backup_create(str(payload.get("path") or ""), progress=_bridge_progress)
    if cmd == "backup_inspect":
        return backup_inspect(str(payload.get("path") or ""))
    if cmd == "backup_restore":
        return backup_restore(str(payload.get("path") or ""), progress=_bridge_progress)
    if cmd == "cache_klines":
        return bridge.cache_klines(
            list(payload.get("codes") or []),
            str(payload.get("period", "day")),
            int(payload.get("count", 800)),
            str(payload.get("adjust", "qfq")),
            bool(payload.get("skipExisting")),
        )
    if cmd == "chart_patterns":
        return bridge.chart_patterns(
            str(payload.get("code") or ""),
            str(payload.get("period", "day")),
            str(payload.get("adjust", "qfq")),
            int(payload.get("lookback", 160)),
        )
    if cmd == "limit_review":
        return bridge.limit_review(str(payload.get("date") or ""))
    if cmd == "minute":
        return bridge.minute(payload.get("code", ""))
    if cmd == "minute_cached":
        return bridge.minute_cached(
            str(payload.get("code") or ""), bool(payload.get("fresh"))
        )
    if cmd == "minute_archive_save":
        return bridge.minute_archive_save(str(payload.get("code") or ""))
    if cmd == "minute_archive_list":
        return bridge.minute_archive_list(int(payload.get("limit", 50)))
    if cmd == "minute_aux":
        return bridge.minute_aux(
            str(payload.get("code") or ""), str(payload.get("kind") or "buy_sell_strength")
        )
    if cmd == "minute_aux_archive_save":
        return bridge.minute_aux_archive_save(
            str(payload.get("code") or ""), str(payload.get("kind") or "buy_sell_strength")
        )
    if cmd == "minute_aux_archive_list":
        return bridge.minute_aux_archive_list(int(payload.get("limit", 50)))
    if cmd == "sparkline":
        return bridge.sparkline(
            str(payload.get("code") or ""),
            int(payload.get("selector", 1)),
            int(payload.get("window", 20)),
        )
    if cmd == "sparkline_archive_save":
        return bridge.sparkline_archive_save(
            str(payload.get("code") or ""),
            int(payload.get("selector", 1)),
            int(payload.get("window", 20)),
        )
    if cmd == "sparkline_archive_list":
        return bridge.sparkline_archive_list(int(payload.get("limit", 50)))
    if cmd == "recent_minute":
        return bridge.recent_minute(
            str(payload.get("code") or ""), payload.get("date") or None
        )
    if cmd == "recent_minute_archive_save":
        return bridge.recent_minute_archive_save(
            str(payload.get("code") or ""), payload.get("date") or None
        )
    if cmd == "recent_minute_archive_list":
        return bridge.recent_minute_archive_list(int(payload.get("limit", 50)))
    if cmd == "history_minute":
        return bridge.history_minute(
            str(payload.get("code") or ""), str(payload.get("date") or "")
        )
    if cmd == "history_minute_archive_save":
        return bridge.history_minute_archive_save(
            str(payload.get("code") or ""), str(payload.get("date") or "")
        )
    if cmd == "history_minute_archive_list":
        return bridge.history_minute_archive_list(int(payload.get("limit", 50)))
    if cmd == "five_day":
        return bridge.five_day(payload.get("code", ""))
    if cmd == "five_day_cached":
        return bridge.five_day_cached(
            str(payload.get("code") or ""), bool(payload.get("fresh"))
        )
    raise TdxError(f"未知命令：{cmd}")


def main() -> None:
    # 打包后的 sidecar 也是离线同步 worker 的宿主：Nuitka onefile 下不能再靠
    # `python offline_sync.py`，父进程会用同一个可执行文件带 --offline-worker 起子进程。
    if "--offline-worker" in sys.argv:
        from offline_sync import run_worker

        index = sys.argv.index("--offline-worker")
        if index + 1 >= len(sys.argv):
            raise SystemExit("--offline-worker 缺少分片路径")
        run_worker(sys.argv[index + 1])
        return

    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    bridge = Bridge()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("id")
            command = message.get("cmd", "")
            if command == "shutdown":
                response = {"id": request_id, "ok": True, "result": "bye"}
                print(json.dumps(response, ensure_ascii=False), flush=True)
                break

            result = dispatch(bridge, command, message.get("payload") or {})
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as error:  # noqa: BLE001 - 任何错误都要回一行，不能静默
            traceback.print_exc(file=sys.stderr)
            response = {"id": request_id, "ok": False, "error": str(error)}

        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)

    # 退出前先收掉离线同步的 worker 子进程，避免孤儿进程继续占用主站连接。
    try:
        from offline_sync import manager as offline_manager

        offline_manager().cancel()
    except Exception as error:  # noqa: BLE001 - 关闭阶段不因清理失败而崩溃
        print(f"[tdx] 离线同步清理失败：{error}", file=sys.stderr)
    bridge.close()


if __name__ == "__main__":
    main()
