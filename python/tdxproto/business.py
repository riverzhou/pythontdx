"""索引与选股：全市场代码索引（CodeIndex）与筛选执行。"""

from __future__ import annotations

import re
import time

from code_archive import list_code_archives, write_code_archive
from datetime import datetime
from pathlib import Path
from protocol_archive import list_dataset_archives

from .blocks import (
    parse_security_count, parse_security_list,
)
from .constants import (
    CMD_SECURITY_COUNT, CMD_SECURITY_LIST, CODE_PAGE,
)
from .requests import (
    count_data, list_data,
)
from .session import (
    TdxConnection,
)


# ---------------------------------------------------------------- 业务


def _archive_key(text: str) -> str:
    """把任意业务 key 压成 code_archive 允许的字符集（小写字母/数字/._-）。

    额外压掉 `..` 与连续下划线：key 会直接变成文件名，不能留任何路径语义。
    """
    cleaned = re.sub(r"[^a-z0-9._-]+", "_", str(text or "").strip().lower())
    cleaned = re.sub(r"\.{2,}", "_", cleaned)
    cleaned = re.sub(r"_{2,}", "_", cleaned).strip("._-")
    return (cleaned or "unknown")[:64]


def _write_keyed_archive(
    root: Path,
    dataset: str,
    key: str,
    rows: list[dict],
    *,
    source: str,
    trade_date: str,
    fields: list[str] | None = None,
) -> dict:
    """按业务 key 分片写归档；空结果返回 skipped，不生成空文件。"""
    materialized = [dict(row) for row in rows]
    if not materialized:
        return {
            "dataset": dataset,
            "key": _archive_key(key),
            "tradeDate": trade_date,
            "dir": str(Path(root).resolve()),
            "rows": 0,
            "sha256": "",
            "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "skipped": True,
            "empty": True,
        }
    return write_code_archive(
        root,
        dataset,
        _archive_key(key),
        materialized,
        source=source,
        trade_date=trade_date,
        fields=fields,
    )


def _merge_archive_lists(root: Path, limit: int) -> list[dict]:
    """合并「整包一份」的旧归档与「每代码一份」的新归档，统一按日期倒序。

    旧布局：trade_date=.../<dataset>.jsonl.gz + manifest.json
    新布局：trade_date=.../<code>.jsonl.gz + <code>.manifest.json
    两种都要能列出，否则升级前的历史归档在 UI 里会突然消失。
    """
    legacy = list_dataset_archives(root, limit)
    partitioned = list_code_archives(root, limit)
    merged = legacy + partitioned
    merged.sort(
        key=lambda item: (
            str(item.get("tradeDate") or ""),
            str(item.get("generatedAt") or ""),
        ),
        reverse=True,
    )
    return merged[: max(1, min(1000, int(limit)))]


class CodeIndex:
    def __init__(self) -> None:
        self.all: list[dict] = []
        self.by_code: dict[str, dict] = {}
        self.loaded = False

    def ensure(self, conn: TdxConnection) -> None:
        if self.loaded:
            return

        all_items: list[dict] = []
        client_date = int(time.strftime("%Y%m%d"))

        for market in (0, 1, 2):
            count_body = conn.request(CMD_SECURITY_COUNT, count_data(market, client_date))
            count = parse_security_count(count_body)

            start = 0
            while start < count:
                body = conn.request(CMD_SECURITY_LIST, list_data(market, start, CODE_PAGE))
                all_items.extend(parse_security_list(body, market))
                start += CODE_PAGE

        self.all = all_items
        self.by_code = {item["code"]: item for item in all_items}
        self.loaded = True
