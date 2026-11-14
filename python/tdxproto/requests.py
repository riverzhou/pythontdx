"""请求体构造：把命令参数编码成通达信二进制请求。"""

from __future__ import annotations

import struct

from datetime import datetime

from .base import (
    TdxError, code_bytes, full_code,
)
from .cache import (
    AUCTION_LIMIT, F10_FILENAME_SIZE, FILE_CHUNK, FILE_PATH_FIELD,
    MAX_FILE_CHUNK, TRADE_PAGE,
)
from .constants import (
    CAPITAL_BATCH, FINANCE_BATCH, QUOTE_BATCH, QUOTE_LIST_PREFIX,
    REFRESH_BATCH,
)


def quote_data(items: list[tuple[int, str]]) -> bytes:
    if not items:
        raise TdxError("行情请求不能为空")
    if len(items) > QUOTE_BATCH:
        raise TdxError("单次行情请求不能超过 80 只")

    payload = bytearray(QUOTE_LIST_PREFIX)
    payload += struct.pack("<H", len(items))
    for market, symbol in items:
        payload += struct.pack("<B", market) + code_bytes(symbol)
    return bytes(payload)


def refresh_data(
    items: list[tuple[int, str]], cursors: dict[str, int] | None = None
) -> bytes:
    """0x0547：每个代码 11 字节（市场 1 + 代码 6 + 游标 4），单次最多 100 只。"""
    if not items:
        raise TdxError("行情刷新请求不能为空")
    if len(items) > REFRESH_BATCH:
        raise TdxError("单次增量刷新不能超过 100 只")

    payload = bytearray(struct.pack("<H", len(items)))
    for market, symbol in items:
        code = full_code(market, symbol)
        cursor = int((cursors or {}).get(code, 0))
        payload += struct.pack("<B", market) + code_bytes(symbol)
        payload += struct.pack("<I", max(0, min(cursor, 0xFFFFFFFF)))
    return bytes(payload)


def category_data(
    category: int = 6,
    sort_type: int = 0,
    start: int = 0,
    count: int = 80,
    ascending: bool = False,
    filter_raw: int = 0,
) -> bytes:
    """0x054b：9 个 u16，服务端排序；category=6 是沪深 A 股。"""
    if category < 0 or category > 0xFFFF or sort_type < 0 or sort_type > 0xFFFF:
        raise TdxError("分类行情参数超出 u16 范围")
    if start < 0 or start > 0xFFFF or count < 1 or count > 80:
        raise TdxError("分类行情必须满足 0 <= start <= 65535、1 <= count <= 80")
    if filter_raw < 0 or filter_raw > 0xFFFF:
        raise TdxError("分类行情过滤值超出 u16 范围")

    values = [
        category,
        sort_type,
        start,
        count,
        2 if ascending else 1,
        5,
        filter_raw,
        1,
        0,
    ]
    return b"".join(struct.pack("<H", value) for value in values)


def trades_data(
    market: int,
    symbol: str,
    start: int = 0,
    count: int = TRADE_PAGE,
    trading_date: str | None = None,
) -> bytes:
    """0x0fc5 当日 / 0x0fc6 历史成交明细；单页上限 1800。"""
    if start < 0 or start > 0xFFFF:
        raise TdxError("成交明细起点超出 u16 范围")
    if count < 1 or count > TRADE_PAGE:
        raise TdxError("单页成交明细必须在 1~1800 条之间")

    if trading_date is None:
        return struct.pack(
            "<BB6sHH", market, 0, code_bytes(symbol), start, count
        )

    raw_date = trading_date.strip().replace("-", "")
    if len(raw_date) != 8 or not raw_date.isdigit():
        raise TdxError("历史成交日期必须是 YYYY-MM-DD 或 YYYYMMDD")
    return struct.pack(
        "<IH6sHH", int(raw_date), market, code_bytes(symbol), start, count
    )


def auction_data(
    market: int,
    symbol: str,
    trading_date: str | None = None,
    selector: int = 0,
    start: int = 0,
    limit: int = AUCTION_LIMIT,
) -> bytes:
    """0x056a：集合竞价过程快照，28 字节请求。"""
    if selector < 0 or selector > 0xFFFFFFFF:
        raise TdxError("竞价 selector 超出 u32 范围")
    if start < 0 or start > 0xFFFFFFFF or limit < 1 or limit > 0xFFFFFFFF:
        raise TdxError("竞价起点/数量超出 u32 范围")

    date_raw = 0
    if trading_date:
        raw_date = trading_date.strip().replace("-", "")
        if len(raw_date) != 8 or not raw_date.isdigit():
            raise TdxError("竞价日期必须是 YYYY-MM-DD 或 YYYYMMDD")
        date_raw = int(raw_date)
    return struct.pack(
        "<BB6sIIIII",
        market,
        0,
        code_bytes(symbol),
        date_raw,
        selector,
        0,
        start,
        limit,
    )


def file_content_data(path: str, offset: int = 0, size: int = FILE_CHUNK) -> bytes:
    """0x06b9：u32 offset + u32 size + 300 字节 NUL 填充路径。"""
    text = path.strip().replace("\\", "/")
    if not text or len(text.encode("ascii", errors="ignore")) != len(text):
        raise TdxError("服务器文件路径必须是非空 ASCII")
    if len(text.encode("ascii")) > FILE_PATH_FIELD or "\x00" in text:
        raise TdxError("服务器文件路径过长或包含 NUL")
    if offset < 0 or offset > 0xFFFFFFFF:
        raise TdxError("文件偏移超出 u32 范围")
    if size < 1 or size > MAX_FILE_CHUNK:
        raise TdxError("单块文件读取必须在 1~60000 字节之间")

    return (
        struct.pack("<II", offset, size)
        + text.encode("ascii").ljust(FILE_PATH_FIELD, b"\x00")
    )


def block_meta_data(filename: str) -> bytes:
    """0x02c5：40 字节 ASCII 文件名，NUL 填充。"""
    text = str(filename or "").strip()
    if not text or "\x00" in text:
        raise TdxError("板块文件名不能为空或包含 NUL")
    try:
        raw = text.encode("ascii")
    except UnicodeEncodeError as error:
        raise TdxError("板块文件名必须是 ASCII") from error
    if len(raw) > 40:
        raise TdxError("板块文件名不能超过 40 字节")
    return raw.ljust(40, b"\x00")


def money_flow_data(market: int, symbol: str) -> bytes:
    """0x0ffc：市场 + 0 + 代码，补零到 38 字节；msg_id 另带 channel/route。"""
    data = struct.pack("<BB6s", market, 0, code_bytes(symbol))
    return data.ljust(38, b"\x00")


def f10_catalog_data(market: int, symbol: str) -> bytes:
    """0x02cf：u16 市场 + 6 代码 + 4 字节 0。"""
    return struct.pack("<H6s4s", market, code_bytes(symbol), b"\x00\x00\x00\x00")


def f10_content_data(
    market: int,
    symbol: str,
    filename: str,
    offset: int,
    length: int,
) -> bytes:
    """0x02d0：市场/代码/80 字节文件名/偏移/长度/4 字节 0。"""
    if not filename.strip():
        raise TdxError("F10 文件名不能为空")
    raw_filename = filename.strip().encode("gbk")
    if len(raw_filename) > F10_FILENAME_SIZE:
        raise TdxError("F10 文件名超过 80 字节")
    if offset < 0 or offset > 0xFFFFFFFF or length < 1 or length > 0xFFFFFFFF:
        raise TdxError("F10 偏移/长度超出 u32 范围")
    return (
        struct.pack("<H6sH", market, code_bytes(symbol), 0)
        + raw_filename.ljust(F10_FILENAME_SIZE, b"\x00")
        + struct.pack("<III", offset, length, 0)
    )


def bars_data(
    market: int,
    symbol: str,
    period: int,
    count: int,
    adjust: int,
    start: int = 0,
    period_param: int = 1,
    anchor_date: int = 0,
) -> bytes:
    if count < 1 or count > 800:
        raise TdxError("单次 K 线请求必须在 1~800 根之间")

    return struct.pack(
        "<H6sHHHHHI20s",
        market,
        code_bytes(symbol),
        period,
        period_param,
        start,
        count,
        adjust,
        anchor_date,
        b"",
    )


def special_limits_data(start_index: int = 0) -> bytes:
    """0x0452：起始行号 u16 + 12 字节零。"""
    return struct.pack("<H12s", max(0, min(int(start_index), 0xFFFF)), b"")


def delisted_bars_data(
    market: int, symbol: str, start: int = 0, count: int = 800
) -> bytes:
    """0x052b：市场 u16 + 6 位代码 + start/count。"""
    if count < 1 or count > 800:
        raise TdxError("退市 K 线单页必须在 1~800 根之间")
    return struct.pack(
        "<H6sHH",
        market,
        code_bytes(symbol),
        max(0, min(int(start), 0xFFFF)),
        count,
    )


def unusual_data(market: int, start: int = 0, count: int = 600) -> bytes:
    """0x0563：市场 u16 + start u32 + count u32（0 由调用方补 600）。"""
    safe_count = max(1, min(int(count or 600), 600))
    return struct.pack(
        "<HII", market, max(0, min(int(start), 0xFFFFFFFF)), safe_count
    )


def top_board_data(category: int = 0, size: int = 20) -> bytes:
    """0x053f：category u8 + mode u8(5) + 7 字节保留 + size u8。"""
    safe_size = max(1, min(int(size or 20), 255))
    return struct.pack(
        "<BB7sB",
        max(0, min(int(category), 0xFF)),
        5,
        b"\x00\x00\x00\x00\x01\x00\x00",
        safe_size,
    )


def volume_profile_data(market: int, symbol: str) -> bytes:
    """0x051a：市场 u16 + 6 位代码 + 2 字节保留（共 10 字节）。"""
    return struct.pack("<H6s2s", market, code_bytes(symbol), b"")


def minute_data(market: int, symbol: str) -> bytes:
    return struct.pack("<H6s4s", market, code_bytes(symbol), b"\x00\x00\x00\x93")


def history_minute_data(market: int, symbol: str, date: int) -> bytes:
    return struct.pack("<IB6s", date, market, code_bytes(symbol))


def minute_aux_data(market: int, symbol: str, selector: int = 0) -> bytes:
    """0x051b：市场 u16 + 代码 + 19 零 + selector。"""
    return struct.pack(
        "<H6s19sB",
        market,
        code_bytes(symbol),
        b"",
        max(0, min(int(selector), 0xFF)),
    )


def sparkline_data(
    market: int, symbol: str, selector: int = 1, window: int = 20
) -> bytes:
    """0x0fd1：市场 u8 + 保留 u8 + 代码 + 16 零 + selector/保留 + window + fixed + 5 零。"""
    return struct.pack(
        "<BB6s16sBBHI5s",
        market,
        0,
        code_bytes(symbol),
        b"",
        max(0, min(int(selector), 0xFF)),
        0,
        max(1, min(int(window), 0xFFFF)),
        0x01000000,
        b"",
    )


def recent_minute_data(market: int, symbol: str, date_text: str) -> bytes:
    """0x0feb：日期 selector = 0xfed62304 - Python date ordinal。"""
    try:
        day = datetime.strptime(str(date_text), "%Y-%m-%d").date()
    except ValueError as error:
        raise TdxError("近期分时日期必须是 YYYY-MM-DD") from error
    selector = 0xFED62304 - day.toordinal()
    if selector < 0:
        raise TdxError("近期分时日期超出协议范围")
    return struct.pack("<IB6s", selector, market, code_bytes(symbol))


def count_data(market: int, client_date: int) -> bytes:
    return struct.pack("<HI", market, client_date)


def list_data(market: int, start: int, limit: int) -> bytes:
    return struct.pack("<HII4s", market, start, limit, b"")


def finance_data(items: list[tuple[int, str]]) -> bytes:
    if not items:
        raise TdxError("财务请求不能为空")
    if len(items) > FINANCE_BATCH:
        raise TdxError("单次财务请求不能超过 80 只")

    payload = bytearray(struct.pack("<H", len(items)))
    for market, symbol in items:
        payload += struct.pack("<B", market) + code_bytes(symbol)
    return bytes(payload)


def capital_changes_data(items: list[tuple[int, str]]) -> bytes:
    """0x000f 股本变迁：count + 每只市场/代码。"""
    if not items:
        raise TdxError("股本变迁请求不能为空")
    if len(items) > CAPITAL_BATCH:
        raise TdxError(f"单次股本变迁请求不能超过 {CAPITAL_BATCH} 只")
    payload = bytearray(struct.pack("<H", len(items)))
    for market, symbol in items:
        payload += struct.pack("<B", market) + code_bytes(symbol)
    return bytes(payload)
