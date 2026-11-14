"""响应解析：把通达信二进制报文变成结构化数据（行情/K 线/分时/F10）。"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import os
import re
import sqlite3
import struct
import zipfile

from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .base import (
    MARKET_NAMES, TdxError, code_bytes, full_code,
    pythontdx_data_dir,
)
from .blocks import (
    is_record_start, to_levels,
)
from .cache import (
    AUCTION_RECORD, F10_CONTENT_HEADER, F10_FILENAME_SIZE, F10_NAME_SIZE,
    F10_RECORD_SIZE, MONEY_FLOW_HEADER, MONEY_FLOW_RECORD,
)
from .codec import (
    _f32, _u16, _u32, decode_volume,
    is_index_code, price_divisor, read_varint,
)


def parse_quotes(
    body: bytes, received_at: int, securities: dict[str, dict]
) -> list[dict]:
    count = _u16(body, 2)
    if count == 0:
        return []
    if len(body) < 4 + count * 52:
        raise TdxError("行情报文不完整")

    pos = 4
    quotes: list[dict] = []

    for index in range(count):
        if pos + 9 > len(body):
            raise TdxError("行情报文不完整")

        market_id = body[pos]
        market = MARKET_NAMES.get(market_id)
        if market is None:
            raise TdxError("行情报文包含未知市场")

        symbol = body[pos + 1 : pos + 7].decode("ascii", errors="strict").rstrip("\x00")
        if len(symbol) != 6 or not symbol.isdigit():
            raise TdxError("行情报文包含非法代码")
        pos += 9

        def read() -> int:
            nonlocal pos
            value, pos = read_varint(body, pos)
            return value

        close_raw = read()
        last_close_diff = read()
        open_diff = read()
        high_diff = read()
        low_diff = read()
        read()  # 行情时间原始值：语义未确认，先按接收时间展示
        read()  # 时间后的未知字段
        total_hand = read()
        read()  # 现手
        amount_raw = _u32(body, pos)
        pos += 4
        inner_volume = read()  # 内盘
        outer_volume = read()  # 外盘
        read()  # 外盘后的未知字段
        read()  # 开盘金额

        bid_levels: list[tuple[int, int]] = []
        ask_levels: list[tuple[int, int]] = []
        for _ in range(5):
            bid_delta = read()
            ask_delta = read()
            bid_volume = read()
            ask_volume = read()
            bid_levels.append((close_raw + bid_delta, bid_volume))
            ask_levels.append((close_raw + ask_delta, ask_volume))

        _u16(body, pos)  # trading status
        pos += 2
        for _ in range(4):
            read()

        if index == count - 1:
            if len(body) - pos == 4:
                pos += 4
            elif len(body) != pos:
                raise TdxError("行情报文尾部长度异常")
        elif not is_record_start(body, pos):
            if pos + 4 > len(body):
                raise TdxError("行情报文不完整")
            pos += 4

        key = full_code(market_id, symbol)
        security = securities.get(key, {})
        divisor = price_divisor(security.get("decimal"))
        scale = 100 * divisor
        index_code = is_index_code(market_id, symbol)

        prev_close = (close_raw + last_close_diff) / scale
        price = close_raw / scale
        if price <= 0:
            price = prev_close

        open_price = (close_raw + open_diff) / scale
        high = (close_raw + high_diff) / scale
        low = (close_raw + low_diff) / scale
        amount = decode_volume(amount_raw)
        change = price - prev_close if prev_close > 0 else 0.0

        quote: dict = {
            "code": key,
            "symbol": symbol,
            "name": security.get("name") or symbol,
            "market": market,
            "price": price,
            "prevClose": prev_close,
            "open": open_price,
            "high": high,
            "low": low,
            "change": change,
            "changePct": (change / prev_close * 100) if prev_close > 0 else 0.0,
            # 指数 0x053e/054c/054b 的 totalHand 是「股」，个股是「手」；
            # 统一成手，与 K 线 volume 同单位。
            "volume": total_hand / 100 if index_code else total_hand,
            "innerVolume": inner_volume,
            "outerVolume": outer_volume,
            "amount": amount,
            "currency": "CNY",
            "time": received_at,
            "receivedAt": received_at,
            "bids": [] if index_code else to_levels(bid_levels, scale),
            "asks": [] if index_code else to_levels(ask_levels, scale),
        }

        if prev_close > 0:
            quote["amplitude"] = (high - low) / prev_close * 100
        if not index_code and total_hand > 0 and amount > 0:
            quote["avgPrice"] = amount / (total_hand * 100)

        quotes.append(quote)

    return quotes


def _split_quote_records(
    data: bytes, items: list[tuple[int, str]]
) -> list[tuple[int, str, bytes]]:
    """按「市场 + 6 位代码」标记切记录，并回读记录头里的真实代码。

    为什么不能按请求顺序 zip：服务器对不可用代码可能返回「另一只证券的合法
    记录」，按顺序配对会把 A 的数据标成 B。这里以记录头为准返回
    `(market, symbol, record)`；单条请求也要校验头部，避免同样的错标。
    """
    if not items:
        return []
    if len(items) == 1:
        market, symbol = items[0]
        if len(data) >= 7:
            head_market = data[0]
            head_symbol = data[1:7].decode("ascii", errors="replace").rstrip("\x00")
            if head_symbol.isdigit() and len(head_symbol) == 6:
                if head_market != market or head_symbol != symbol:
                    return [(head_market, head_symbol, data)]
        return [(market, symbol, data)]

    starts: list[tuple[int, int, str]] = []
    for market, symbol in items:
        marker = struct.pack("<B", market) + code_bytes(symbol)
        position = data.find(marker)
        if position < 0:
            raise TdxError("行情记录缺少代码标记")
        starts.append((position, market, symbol))
    starts.sort()
    records: list[tuple[int, str, bytes]] = []
    for index, (position, market, symbol) in enumerate(starts):
        end = starts[index + 1][0] if index + 1 < len(starts) else len(data)
        records.append((market, symbol, data[position:end]))
    return records


def _read_k_prices(record: bytes, pos: int) -> tuple[tuple[int, int, int, int, int], int]:
    """五个差分价格，统一换成 milli（1/1000 元）。"""
    current_delta, pos = read_varint(record, pos)
    last_close_delta, pos = read_varint(record, pos)
    open_delta, pos = read_varint(record, pos)
    high_delta, pos = read_varint(record, pos)
    low_delta, pos = read_varint(record, pos)
    current_milli = current_delta * 10
    return (
        (
            current_milli,
            (current_delta + last_close_delta) * 10,
            (current_delta + open_delta) * 10,
            (current_delta + high_delta) * 10,
            (current_delta + low_delta) * 10,
        ),
        pos,
    )


def _build_quote(
    market_id: int,
    symbol: str,
    received_at: int,
    securities: dict[str, dict],
    prices: tuple[int, int, int, int, int],
    total_hand: int,
    amount_raw: int,
    bid_levels: list[tuple[int, int]],
    ask_levels: list[tuple[int, int]],
) -> dict:
    current_milli, prev_milli, open_milli, high_milli, low_milli = prices
    market = MARKET_NAMES[market_id]
    key = full_code(market_id, symbol)
    security = securities.get(key, {})
    divisor = price_divisor(security.get("decimal"))
    scale = 1000 * divisor
    index_code = is_index_code(market_id, symbol)

    prev_close = prev_milli / scale
    price = current_milli / scale
    if price <= 0:
        price = prev_close
    open_price = open_milli / scale
    high = high_milli / scale
    low = low_milli / scale
    amount = decode_volume(amount_raw)
    change = price - prev_close if prev_close > 0 else 0.0

    def levels(raw_levels: list[tuple[int, int]]) -> list[dict]:
        if index_code:
            return []
        return [
            {"price": raw_price / scale, "volume": volume}
            for raw_price, volume in raw_levels
            if raw_price > 0
        ]

    quote: dict = {
        "code": key,
        "symbol": symbol,
        "name": security.get("name") or symbol,
        "market": market,
        "price": price,
        "prevClose": prev_close,
        "open": open_price,
        "high": high,
        "low": low,
        "change": change,
        "changePct": (change / prev_close * 100) if prev_close > 0 else 0.0,
        # 指数 totalHand 是「股」，统一成手，与 K 线 volume 同单位。
        "volume": total_hand / 100 if index_code else total_hand,
        "amount": amount,
        "currency": "CNY",
        "time": received_at,
        "receivedAt": received_at,
        "bids": levels(bid_levels),
        "asks": levels(ask_levels),
    }
    if prev_close > 0:
        quote["amplitude"] = (high - low) / prev_close * 100
    if not index_code and total_hand > 0 and amount > 0:
        quote["avgPrice"] = amount / (total_hand * 100)
    return quote


def _parse_snapshot_record(
    record: bytes,
    market_id: int,
    symbol: str,
    received_at: int,
    securities: dict[str, dict],
) -> dict:
    if len(record) < 9:
        raise TdxError("0x054c 记录不完整")
    prices, pos = _read_k_prices(record, 9)
    time_raw, pos = read_varint(record, pos)
    unknown_time, pos = read_varint(record, pos)
    total_hand, pos = read_varint(record, pos)
    current_hand, pos = read_varint(record, pos)
    amount_raw = _u32(record, pos)
    pos += 4
    inside, pos = read_varint(record, pos)
    outside, pos = read_varint(record, pos)
    unknown_outer, pos = read_varint(record, pos)
    open_amount, pos = read_varint(record, pos)
    bid_delta, pos = read_varint(record, pos)
    ask_delta, pos = read_varint(record, pos)
    bid_volume, pos = read_varint(record, pos)
    ask_volume, pos = read_varint(record, pos)

    current_milli = prices[0]
    bid_milli = current_milli + bid_delta * 10
    ask_milli = current_milli + ask_delta * 10
    quote = _build_quote(
        market_id,
        symbol,
        received_at,
        securities,
        prices,
        total_hand,
        amount_raw,
        [(bid_milli, bid_volume)],
        [(ask_milli, ask_volume)],
    )
    quote.update(
        {
            "timeRaw": time_raw,
            "unknownTime": unknown_time,
            "currentHand": current_hand,
            "unknownOuter": unknown_outer,
            "openAmount": open_amount,
            "recordHex": record.hex(),
        }
    )
    return quote


def parse_snapshots(
    body: bytes,
    items: list[tuple[int, str]],
    received_at: int,
    securities: dict[str, dict],
) -> list[dict]:
    """0x054c：批量快照，盘口只稳定返回买一/卖一。"""
    if len(body) < 4:
        raise TdxError("0x054c 报文不完整")
    count = _u16(body, 2)
    if count == 0:
        return []
    if count > len(items):
        raise TdxError("0x054c 返回数量超过请求数量")

    requested = {full_code(market, symbol) for market, symbol in items}
    records = _split_quote_records(body[4:], items[:count])
    quotes: list[dict] = []
    for market, symbol, record in records:
        quote = _parse_snapshot_record(
            record, market, symbol, received_at, securities
        )
        # 记录头可能是服务器返回的另一只证券：保留真实代码，并显式标出
        # 「这条不是请求的那只」，调用方不能把它当成请求代码的数据。
        quote["requested"] = quote["code"] in requested
        quotes.append(quote)
    return quotes


def _parse_refresh_record(
    record: bytes,
    market_id: int,
    symbol: str,
    received_at: int,
    securities: dict[str, dict],
) -> dict:
    if len(record) < 9:
        raise TdxError("0x0547 记录不完整")
    prices, pos = _read_k_prices(record, 9)
    _update_time = _u32(record, pos)
    pos += 4
    status, pos = read_varint(record, pos)
    total_hand, pos = read_varint(record, pos)
    current_hand, pos = read_varint(record, pos)
    amount_raw = _u32(record, pos)
    pos += 4
    inside, pos = read_varint(record, pos)
    outside, pos = read_varint(record, pos)
    unknown_outer, pos = read_varint(record, pos)
    open_amount, pos = read_varint(record, pos)

    current_milli = prices[0]
    bid_levels: list[tuple[int, int]] = []
    ask_levels: list[tuple[int, int]] = []
    for _ in range(5):
        bid_delta, pos = read_varint(record, pos)
        ask_delta, pos = read_varint(record, pos)
        bid_volume, pos = read_varint(record, pos)
        ask_volume, pos = read_varint(record, pos)
        bid_levels.append((current_milli + bid_delta * 10, bid_volume))
        ask_levels.append((current_milli + ask_delta * 10, ask_volume))

    quote = _build_quote(
        market_id,
        symbol,
        received_at,
        securities,
        prices,
        total_hand,
        amount_raw,
        bid_levels,
        ask_levels,
    )
    quote["innerVolume"] = inside
    quote["outerVolume"] = outside
    quote["updateTime"] = _update_time
    quote.update(
        {
            "status": status,
            "currentHand": current_hand,
            "unknownOuter": unknown_outer,
            "openAmount": open_amount,
            "recordHex": record.hex(),
        }
    )
    return quote


def _split_refresh_records(
    data: bytes, items: list[tuple[int, str]], count: int
) -> list[tuple[tuple[int, str], bytes]]:
    """按实际返回的记录头切 0x0547，不能按请求顺序硬配。

    增量刷新只返回有变化的代码，条数可能少于请求数；若按 ``items[:count]``
    顺序解析，会把“只更新了 sz000001”的帧误标成 sh600519。
    """
    starts: list[tuple[int, tuple[int, str]]] = []
    for market, symbol in items:
        marker = struct.pack("<B", market) + code_bytes(symbol)
        search_from = 0
        while True:
            position = data.find(marker, search_from)
            if position < 0:
                break
            starts.append((position, (market, symbol)))
            search_from = position + len(marker)
    starts.sort(key=lambda item: item[0])
    if not starts or starts[0][0] != 0:
        raise TdxError("0x0547 记录缺少代码标记")
    if len(starts) < count:
        raise TdxError("0x0547 记录数量与报文不符")

    chosen = starts[:count]
    records: list[tuple[tuple[int, str], bytes]] = []
    for index, (start, identity) in enumerate(chosen):
        end = chosen[index + 1][0] if index + 1 < count else len(data)
        if end <= start:
            raise TdxError("0x0547 记录边界异常")
        records.append((identity, data[start:end]))
    return records


def parse_refresh(
    body: bytes,
    items: list[tuple[int, str]],
    received_at: int,
    securities: dict[str, dict],
) -> list[dict]:
    """0x0547：增量刷新页，payload 每字节 XOR 0x93，首次游标 0 给出五档基线。"""
    decoded = bytes(byte ^ 0x93 for byte in body)
    if len(decoded) < 2:
        raise TdxError("0x0547 报文不完整")
    count = _u16(decoded, 0)
    if count == 0:
        return []
    if count > len(items):
        raise TdxError("0x0547 返回数量超过请求数量")

    quotes: list[dict] = []
    for (market, symbol), record in _split_refresh_records(
        decoded[2:], items, count
    ):
        quotes.append(
            _parse_refresh_record(record, market, symbol, received_at, securities)
        )
    return quotes


def _parse_category_record(
    body: bytes,
    offset: int,
    received_at: int,
    securities: dict[str, dict],
) -> tuple[dict, int]:
    if offset + 9 > len(body):
        raise TdxError("0x054b 记录头不完整")
    market_id = body[offset]
    market = MARKET_NAMES.get(market_id)
    if market is None:
        raise TdxError("0x054b 包含未知市场")
    symbol = body[offset + 1 : offset + 7].decode("ascii", errors="strict")
    if len(symbol) != 6 or not symbol.isdigit():
        raise TdxError("0x054b 包含非法代码")
    pos = offset + 9
    prices, pos = _read_k_prices(body, pos)

    _server_time, pos = read_varint(body, pos)
    _neg_price, pos = read_varint(body, pos)
    total_hand, pos = read_varint(body, pos)
    _current_hand, pos = read_varint(body, pos)
    amount_raw = _u32(body, pos)
    pos += 4
    _inside, pos = read_varint(body, pos)
    _outside, pos = read_varint(body, pos)
    _after_outer, pos = read_varint(body, pos)
    _open_amount, pos = read_varint(body, pos)
    bid_delta, pos = read_varint(body, pos)
    ask_delta, pos = read_varint(body, pos)
    bid_volume, pos = read_varint(body, pos)
    ask_volume, pos = read_varint(body, pos)

    tail_start = pos
    if tail_start + 56 > len(body):
        raise TdxError("0x054b 记录尾部不完整")
    status_raw = struct.unpack_from("<H", body, tail_start)[0]
    rise_speed_raw = struct.unpack_from("<h", body, tail_start + 2)[0]
    short_turnover_raw = struct.unpack_from("<h", body, tail_start + 4)[0]
    min2_amount = _f32(body, tail_start + 6)
    opening_rush_raw = struct.unpack_from("<h", body, tail_start + 10)[0]
    vol_rise_speed = _f32(body, tail_start + 22)
    depth = _f32(body, tail_start + 26)
    active2 = struct.unpack_from("<H", body, tail_start + 54)[0]
    pos = tail_start + 56

    current_milli = prices[0]
    bid_milli = current_milli + bid_delta * 10
    ask_milli = current_milli + ask_delta * 10
    quote = _build_quote(
        market_id,
        symbol,
        received_at,
        securities,
        prices,
        total_hand,
        amount_raw,
        [(bid_milli, bid_volume)],
        [(ask_milli, ask_volume)],
    )
    quote["active2"] = active2
    quote["statusRaw"] = status_raw
    quote["riseSpeed"] = rise_speed_raw / 100
    quote["shortTurnover"] = short_turnover_raw / 100
    quote["min2Amount"] = min2_amount
    quote["openingRush"] = opening_rush_raw / 100
    quote["volRiseSpeed"] = vol_rise_speed
    quote["depth"] = depth
    if quote["bids"]:
        quote["lockedAmount"] = quote["bids"][0]["price"] * bid_volume * 100
    return quote, pos


def parse_category_quotes(
    body: bytes, received_at: int, securities: dict[str, dict]
) -> list[dict]:
    """0x054b：服务端排序的一页分类行情（A 股 category=6）。"""
    if len(body) < 4:
        raise TdxError("0x054b 报文不完整")
    count = _u16(body, 2)
    if count == 0:
        return []
    if len(body) < 4 + count * 86:
        raise TdxError("0x054b 记录数量与报文长度不符")

    quotes: list[dict] = []
    offset = 4
    for _ in range(count):
        quote, offset = _parse_category_record(
            body, offset, received_at, securities
        )
        quotes.append(quote)
    return quotes


def _trade_side(status: int) -> str:
    return {0: "buy", 1: "sell", 2: "neutral"}.get(status, f"status_{status}")


def parse_trades(
    body: bytes,
    market: int,
    symbol: str,
    start: int,
    securities: dict[str, dict],
    trading_date: str | None = None,
) -> list[dict]:
    """0x0fc5（当日）/ 0x0fc6（历史）成交明细。

    价格是差分累计值；A 股 /100，可转债 /1000。status=8 是竞价快照，不是成交。
    """
    if len(body) < 2:
        raise TdxError("成交明细报文不完整")
    count = _u16(body, 0)
    pos = 2
    price_base: float | None = None
    if trading_date is not None:
        if len(body) < 6:
            raise TdxError("历史成交明细缺少价格基数")
        price_base = round(_f32(body, 2), 6)
        pos = 6  # 价格基数只做保留，价格仍按差分累计
    if count == 0:
        return []
    if count > (len(body) - pos) // 7:
        raise TdxError("成交明细数量与报文长度不符")

    security = securities.get(full_code(market, symbol), {})
    convertible = security.get("kind") == "ZQ" or symbol.startswith(("11", "12"))
    price_scale = 1000.0 if convertible else 100.0
    price_acc = 0
    ticks: list[dict] = []

    for index in range(count):
        time_minutes = _u16(body, pos)
        pos += 2
        price_delta, pos = read_varint(body, pos)
        volume, pos = read_varint(body, pos)
        order_count, pos = read_varint(body, pos)
        status, pos = read_varint(body, pos)
        tail, pos = read_varint(body, pos)

        price_acc += price_delta
        price = price_acc / price_scale
        event_kind = (
            "auction_snapshot"
            if status == 8
            else "opening_match"
            if time_minutes == 9 * 60 + 25
            else "trade"
        )
        tick: dict = {
            "index": start + index,
            "priceBase": price_base,
            "timeMinutes": time_minutes,
            "time": f"{time_minutes // 60:02d}:{time_minutes % 60:02d}",
            "price": price,
            "volume": volume,
            "orderCount": order_count,
            "status": status,
            "side": _trade_side(status),
            "eventKind": event_kind,
            "tailRaw": tail,
        }
        if event_kind != "auction_snapshot" and price > 0 and volume > 0:
            tick["tradeAmount"] = price * volume * 100
        ticks.append(tick)

    return ticks


def parse_auctions(body: bytes) -> list[dict]:
    """0x056a 集合竞价过程：count u16 + 16 字节定长记录。"""
    if len(body) < 2:
        raise TdxError("竞价报文不完整")
    count = _u16(body, 0)
    if len(body) != 2 + count * AUCTION_RECORD:
        raise TdxError("竞价记录数量与报文长度不符")

    points: list[dict] = []
    pos = 2
    for index in range(count):
        minute = _u16(body, pos)
        price = _f32(body, pos + 2)
        matched = _u32(body, pos + 6)
        unmatched = struct.unpack_from("<i", body, pos + 10)[0]
        second = body[pos + 15]
        points.append(
            {
                "index": index,
                "timeMinutes": minute,
                "second": second,
                "time": f"{minute // 60:02d}:{minute % 60:02d}:{second:02d}",
                "timeSeconds": minute * 60 + second,
                "price": price,
                "priceMilli": round(price * 1000),
                "matchedVolume": matched,
                "unmatchedVolume": abs(unmatched),
                "unmatchedDirection": 1 if unmatched >= 0 else -1,
            }
        )
        pos += AUCTION_RECORD
    return points


def parse_block_meta(body: bytes) -> dict:
    """0x02c5：u32 size + 保留字节 + 32 字节 ASCII MD5。"""
    if len(body) < 38:
        raise TdxError("板块文件元数据不完整")
    md5 = body[5:37].split(b"\x00", 1)[0].decode("ascii", errors="replace").strip()
    return {"size": _u32(body, 0), "md5": md5}


def parse_file_chunk(
    body: bytes, path: str, offset: int, request_size: int
) -> dict:
    """0x06b9 单块文件读取：u32 实际长度 + 内容。"""
    if len(body) < 4:
        raise TdxError("服务器文件块不完整")
    chunk_len = _u32(body, 0)
    if chunk_len > request_size:
        raise TdxError("服务器返回文件块超过请求长度")
    if len(body) < 4 + chunk_len:
        raise TdxError("服务器文件块内容不完整")
    content = body[4 : 4 + chunk_len]
    return {
        "path": path,
        "offset": offset,
        "requestSize": request_size,
        "chunkLen": chunk_len,
        "isLast": chunk_len < request_size,
        "contentHex": content.hex(),
        "trailingBytes": len(body) - 4 - chunk_len,
    }


def parse_money_flow(body: bytes) -> list[dict]:
    """0x0ffc：0x28 头 + 0x58 记录；通常每只证券最近 5 个交易日。"""
    if len(body) < MONEY_FLOW_HEADER:
        raise TdxError("资金流报文不完整")
    records: list[dict] = []
    offset = 0
    while offset < len(body):
        header_end = offset + MONEY_FLOW_HEADER
        if header_end > len(body):
            raise TdxError("资金流证券头不完整")
        header = body[offset:header_end]
        market_id = header[0]
        market = MARKET_NAMES.get(market_id)
        if market is None:
            raise TdxError("资金流包含未知市场")
        symbol = header[2:8].decode("ascii", errors="strict")
        if len(symbol) != 6 or not symbol.isdigit():
            raise TdxError("资金流包含非法代码")
        reported = _u16(header, 0x26)
        available = (len(body) - header_end) // MONEY_FLOW_RECORD
        count = available if reported == 0 else reported
        if header_end + count * MONEY_FLOW_RECORD > len(body):
            raise TdxError("资金流记录不完整")

        for index in range(count):
            start = header_end + index * MONEY_FLOW_RECORD
            record = body[start : start + MONEY_FLOW_RECORD]
            date_raw = _u32(record, 0)
            total_amount = _f32(record, 8)
            raw = [_u32(record, 4 + i * 4) for i in range(21)]
            buckets: list[int] = []
            for packed_index in range(8):
                packed = raw[10 + packed_index]
                buckets.extend([packed & 0xFFFF, packed >> 16])

            bucket_main = buckets[0] - buckets[1] + buckets[4] - buckets[5]
            bucket_buy = (
                buckets[2]
                - buckets[3]
                + buckets[6]
                - buckets[7]
                + buckets[10]
                - buckets[11]
                + buckets[14]
                - buckets[15]
            )
            scale = total_amount / 50000.0
            date_text = str(date_raw)
            date = (
                f"{date_text[:4]}-{date_text[4:6]}-{date_text[6:8]}"
                if len(date_text) == 8
                else date_text
            )
            records.append(
                {
                    "code": full_code(market_id, symbol),
                    "market": market,
                    "symbol": symbol,
                    "date": date,
                    "totalAmount": total_amount,
                    "buckets": buckets,
                    "mainNet": bucket_main / 50000.0 * total_amount,
                    "mainRatio": bucket_main / 500.0,
                    "mainBuyNet": bucket_buy / 50000.0 * total_amount,
                    "mainBuyRatio": bucket_buy / 500.0,
                    "mainSuperLargeNet": (buckets[0] - buckets[1]) * scale,
                    "mainLargeNet": (buckets[4] - buckets[5]) * scale,
                    "mainMediumNet": (buckets[8] - buckets[9]) * scale,
                    "mainSmallNet": (buckets[12] - buckets[13]) * scale,
                    "mainBuySuperLargeNet": (buckets[2] - buckets[3]) * scale,
                    "mainBuyLargeNet": (buckets[6] - buckets[7]) * scale,
                    "mainBuyMediumNet": (buckets[10] - buckets[11]) * scale,
                    "mainBuySmallNet": (buckets[14] - buckets[15]) * scale,
                }
            )
        offset = header_end + count * MONEY_FLOW_RECORD
    return records


def parse_f10_catalog(body: bytes) -> list[dict]:
    """0x02cf：count u16 + 152 字节目录项（64 名称 + 80 文件名 + 4 偏移 + 4 长度）。"""
    if len(body) < 2:
        raise TdxError("F10 目录不完整")
    count = _u16(body, 0)
    expected = 2 + count * F10_RECORD_SIZE
    if len(body) < expected:
        raise TdxError("F10 目录条目不完整")
    sections: list[dict] = []
    for index in range(count):
        record = body[2 + index * F10_RECORD_SIZE : 2 + (index + 1) * F10_RECORD_SIZE]
        # 目录项是定长字段，名称后填充 NUL；必须先按 NUL 截断再解码，
        # 否则末尾的替换字符会让导航出现「方框 + 一长串空白」。
        name = (
            record[:F10_NAME_SIZE]
            .split(b"\x00", 1)[0]
            .decode("gbk", "replace")
            .strip()
        )
        filename = (
            record[F10_NAME_SIZE : F10_NAME_SIZE + F10_FILENAME_SIZE]
            .split(b"\x00", 1)[0]
            .decode("gbk", "replace")
            .strip()
        )
        start, length = struct.unpack_from("<II", record, F10_NAME_SIZE + F10_FILENAME_SIZE)
        sections.append(
            {"name": name, "filename": filename, "start": start, "length": length}
        )
    return sections


def parse_f10_content(body: bytes) -> str:
    """0x02d0：12 字节头 + GBK 正文；正文长度在头 [10:12]。"""
    if len(body) < F10_CONTENT_HEADER:
        raise TdxError("F10 正文不完整")
    length = _u16(body, 10)
    if len(body) < F10_CONTENT_HEADER + length:
        raise TdxError("F10 正文长度不足")
    return body[
        F10_CONTENT_HEADER : F10_CONTENT_HEADER + length
    ].decode("gbk", "replace")


def save_raw_file(name: str, data: bytes) -> dict:
    safe_name = Path(name).name
    if not safe_name:
        raise TdxError("服务器文件名为空")
    target_dir = pythontdx_data_dir() / "raw" / "tdx"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe_name
    temporary = target.with_name(f"{target.name}.part")
    temporary.write_bytes(data)
    os.replace(temporary, target)
    return {
        "savedTo": str(target),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _stat_float(value: str) -> float | None:
    text = value.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _stat_rows(text: str, minimum_columns: int) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split("|")
        if len(fields) >= minimum_columns:
            rows.append(fields)
    return rows


def parse_tdx_stats(zip_bytes: bytes) -> dict:
    """解析 zhb.zip 里的 tdxstat.cfg / tdxstat2.cfg，返回摘要与前 3 行样本。"""
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as error:
        raise TdxError("zhb.zip 不是合法 ZIP") from error

    names = set(archive.namelist())
    for required in ("tdxstat.cfg", "tdxstat2.cfg"):
        if required not in names:
            raise TdxError(f"zhb.zip 缺少 {required}")
        info = archive.getinfo(required)
        if info.flag_bits & 0x1:
            raise TdxError(f"{required} 是加密条目，不处理")

    stat_rows = _stat_rows(archive.read("tdxstat.cfg").decode("gbk", "replace"), 35)
    stat2_rows = _stat_rows(archive.read("tdxstat2.cfg").decode("gbk", "replace"), 21)
    if not stat_rows or not stat2_rows:
        raise TdxError("tdxstat.cfg / tdxstat2.cfg 没有有效行")

    dates = [row[4].strip() for row in stat_rows if row[4].strip()]
    date_counts = Counter(dates)
    stats_date = date_counts.most_common(1)[0][0] if date_counts else None

    def stat_sample(row: list[str]) -> dict:
        return {
            "market": int(row[0]) if row[0].isdigit() else None,
            "code": row[1],
            "beta60": _stat_float(row[2]),
            "peTtm": _stat_float(row[3]),
            "statsDate": row[4],
            "freeFloatShares10k": _stat_float(row[11]),
            "yearLimitUpDays": int(row[26]) if row[26].strip().isdigit() else None,
            "limitUpStreakDays": int(row[33]) if row[33].strip().isdigit() else None,
        }

    def stat2_sample(row: list[str]) -> dict:
        return {
            "market": int(row[0]) if row[0].isdigit() else None,
            "code": row[1],
            "statsDate": row[2],
            "amount10k": _stat_float(row[3]),
            "sealAmount10k": _stat_float(row[4]),
            "openAmount10k": _stat_float(row[14]),
        }

    return {
        "zipBytes": len(zip_bytes),
        "zipEntries": len(names),
        "statCount": len(stat_rows),
        "stat2Count": len(stat2_rows),
        "statsDate": stats_date,
        "statsDateTop": date_counts.most_common(3),
        "statSamples": [stat_sample(row) for row in stat_rows[:3]],
        "stat2Samples": [stat2_sample(row) for row in stat2_rows[:3]],
    }


def _int_or_none(value: str) -> int | None:
    text = value.strip()
    return int(text) if text.isdigit() else None


def normalize_tdx_stats(
    zip_bytes: bytes,
) -> tuple[dict[str, list[dict]], dict[str, list[dict]], dict[str, int]]:
    """把 zhb.zip 的两份 CFG 规范化成按 statsDate 分组的行。"""
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as error:
        raise TdxError("zhb.zip 不是合法 ZIP") from error

    for required in ("tdxstat.cfg", "tdxstat2.cfg"):
        if required not in archive.namelist():
            raise TdxError(f"zhb.zip 缺少 {required}")
        info = archive.getinfo(required)
        if info.flag_bits & 0x1:
            raise TdxError(f"{required} 是加密条目，不处理")

    stat_rows = _stat_rows(archive.read("tdxstat.cfg").decode("gbk", "replace"), 35)
    stat2_rows = _stat_rows(archive.read("tdxstat2.cfg").decode("gbk", "replace"), 21)
    stat_by_date: dict[str, list[dict]] = {}
    stat2_by_date: dict[str, list[dict]] = {}
    stat_skipped = 0
    stat2_skipped = 0

    for row in stat_rows:
        date = row[4].strip()
        if not date:
            stat_skipped += 1
            continue
        stat_by_date.setdefault(date, []).append(
            {
                "market": _int_or_none(row[0]),
                "code": row[1],
                "beta60": _stat_float(row[2]),
                "peTtm": _stat_float(row[3]),
                "statsDate": date,
                "freeFloatShares10k": _stat_float(row[11]),
                "yearLimitUpDays": _int_or_none(row[26]),
                "limitStatDays": _int_or_none(row[31]),
                "limitUpCount": _int_or_none(row[32]),
                "limitUpStreakDays": _int_or_none(row[33]),
            }
        )

    for row in stat2_rows:
        date = row[2].strip()
        if not date:
            stat2_skipped += 1
            continue
        stat2_by_date.setdefault(date, []).append(
            {
                "market": _int_or_none(row[0]),
                "code": row[1],
                "statsDate": date,
                "amount10k": _stat_float(row[3]),
                "sealAmount10k": _stat_float(row[4]),
                "prevAmount10k": _stat_float(row[5]),
                "prevSealAmount10k": _stat_float(row[6]),
                "prev2Amount10k": _stat_float(row[7]),
                "prev2SealAmount10k": _stat_float(row[8]),
                "openVolumeHand": _int_or_none(row[9]),
                "prevOpenVolumeHand": _int_or_none(row[10]),
                "openAmount10k": _stat_float(row[14]),
                "prevOpenAmount10k": _stat_float(row[15]),
            }
        )
    return stat_by_date, stat2_by_date, {
        "statSkipped": stat_skipped,
        "stat2Skipped": stat2_skipped,
    }


def _run_readonly_query(
    database: Path, sql: str, limit: int, attachments: list[tuple[str, Path]] | None = None
) -> dict:
    text = sql.strip().rstrip(";").strip()
    if not text:
        raise TdxError("SQL 不能为空")
    if not re.match(r"(?is)^(select|with)\b", text):
        raise TdxError("只允许 SELECT / WITH 查询")
    if ";" in text:
        raise TdxError("只允许一条 SQL")
    safe_limit = max(1, min(500, int(limit)))
    if not database.exists():
        raise TdxError(f"{database.name} 不存在，请先执行导入/导出")
    connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
    try:
        for name, path in attachments or []:
            if not path.exists():
                continue
            connection.execute(f"ATTACH DATABASE ? AS {name}", (f"{path.as_uri()}?mode=ro",))
        cursor = connection.execute(f"SELECT * FROM ({text}) LIMIT {safe_limit}")
        columns = [column[0] for column in cursor.description or []]
        rows = [list(row) for row in cursor.fetchall()]
        return {
            "columns": columns,
            "rows": rows,
            "rowCount": len(rows),
            "limited": len(rows) >= safe_limit,
        }
    except sqlite3.Error as error:
        raise TdxError(f"SQL 执行失败：{error}") from error
    finally:
        connection.close()


def run_stats_query(sql: str, limit: int = 200) -> dict:
    """在 stats.db 上执行只读 SELECT/WITH，最多返回 500 行。"""
    database = pythontdx_data_dir() / "normalized" / "tdx" / "zhb_stats" / "stats.db"
    return _run_readonly_query(database, sql, limit)


def run_local_query(sql: str, limit: int = 200) -> dict:
    """在 local_bars.db 上查询；stats.db 存在时以 stats.* 附加为只读库。"""
    database = pythontdx_data_dir() / "local" / "normalized" / "local" / "local_bars.db"
    stats = pythontdx_data_dir() / "normalized" / "tdx" / "zhb_stats" / "stats.db"
    return _run_readonly_query(database, sql, limit, [("stats", stats)])


def export_stats_csv() -> dict:
    """把 stats.db 的 tdxstat / tdxstat2 全量导出为 UTF-8 BOM CSV。"""
    database = pythontdx_data_dir() / "normalized" / "tdx" / "zhb_stats" / "stats.db"
    if not database.exists():
        raise TdxError("stats.db 不存在，请先在数据工具里执行「规范化导出」")
    target = database.parent / "csv"
    target.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
    counts: dict[str, int] = {}
    paths: dict[str, str] = {}
    try:
        for table, filename in (
            ("tdxstat", "tdxstat.csv"),
            ("tdxstat2", "tdxstat2.csv"),
        ):
            cursor = connection.execute(f"SELECT * FROM {table}")
            columns = [column[0] for column in cursor.description or []]
            path = target / filename
            temporary = path.with_name(path.name + ".part")
            with temporary.open("w", encoding="utf-8-sig", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow(columns)
                count = 0
                for row in cursor:
                    writer.writerow(row)
                    count += 1
            os.replace(temporary, path)
            counts[table] = count
            paths[table] = str(path)
    finally:
        connection.close()
    return {
        "statCsv": paths["tdxstat"],
        "stat2Csv": paths["tdxstat2"],
        "statCount": counts["tdxstat"],
        "stat2Count": counts["tdxstat2"],
    }


def write_stats_db(
    root: Path,
    stat_by_date: dict[str, list[dict]],
    stat2_by_date: dict[str, list[dict]],
    source_sha256: str,
    generated_at: str,
) -> Path:
    """把规范化行写入 SQLite 查询层（标准库，不引入 pyarrow/duckdb）。"""
    database = root / "stats.db"
    temporary = database.with_name(database.name + ".part")
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(
            """
            CREATE TABLE tdxstat (
                stats_date TEXT NOT NULL,
                market INTEGER,
                code TEXT NOT NULL,
                beta60 REAL,
                pe_ttm REAL,
                free_float_shares_10k REAL,
                year_limit_up_days INTEGER,
                limit_stat_days INTEGER,
                limit_up_count INTEGER,
                limit_up_streak_days INTEGER,
                PRIMARY KEY (stats_date, market, code)
            );
            CREATE TABLE tdxstat2 (
                stats_date TEXT NOT NULL,
                market INTEGER,
                code TEXT NOT NULL,
                amount_10k REAL,
                seal_amount_10k REAL,
                prev_amount_10k REAL,
                prev_seal_amount_10k REAL,
                prev2_amount_10k REAL,
                prev2_seal_amount_10k REAL,
                open_volume_hand INTEGER,
                prev_open_volume_hand INTEGER,
                open_amount_10k REAL,
                prev_open_amount_10k REAL,
                PRIMARY KEY (stats_date, market, code)
            );
            CREATE INDEX idx_tdxstat_code ON tdxstat(code);
            CREATE INDEX idx_tdxstat2_code ON tdxstat2(code);
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
            """
        )
        stat_rows = [
            (
                row["statsDate"],
                row["market"],
                row["code"],
                row["beta60"],
                row["peTtm"],
                row["freeFloatShares10k"],
                row["yearLimitUpDays"],
                row["limitStatDays"],
                row["limitUpCount"],
                row["limitUpStreakDays"],
            )
            for rows in stat_by_date.values()
            for row in rows
        ]
        stat2_rows = [
            (
                row["statsDate"],
                row["market"],
                row["code"],
                row["amount10k"],
                row["sealAmount10k"],
                row["prevAmount10k"],
                row["prevSealAmount10k"],
                row["prev2Amount10k"],
                row["prev2SealAmount10k"],
                row["openVolumeHand"],
                row["prevOpenVolumeHand"],
                row["openAmount10k"],
                row["prevOpenAmount10k"],
            )
            for rows in stat2_by_date.values()
            for row in rows
        ]
        connection.executemany(
            "INSERT INTO tdxstat VALUES (?,?,?,?,?,?,?,?,?,?)", stat_rows
        )
        connection.executemany(
            "INSERT INTO tdxstat2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", stat2_rows
        )
        connection.executemany(
            "INSERT INTO meta(key, value) VALUES (?, ?)",
            [
                ("schema_version", "1"),
                ("parser", "tdxstat-v1"),
                ("source", "zhb.zip"),
                ("source_sha256", source_sha256),
                ("generated_at", generated_at),
                ("stat_count", str(len(stat_rows))),
                ("stat2_count", str(len(stat2_rows))),
            ],
        )
        connection.commit()
    finally:
        connection.close()
    os.replace(temporary, database)
    return database


def export_tdx_stats(zip_bytes: bytes, source_sha256: str = "") -> dict:
    """把 tdxstat/tdxstat2 写成按 trade_date 分区的 JSONL.gz + manifest。"""
    stat_by_date, stat2_by_date, skipped = normalize_tdx_stats(zip_bytes)
    dates = sorted(set(stat_by_date) | set(stat2_by_date))
    if not dates:
        raise TdxError("tdxstat 没有有效日期")

    root = pythontdx_data_dir() / "normalized" / "tdx" / "zhb_stats"
    root.mkdir(parents=True, exist_ok=True)
    sha = source_sha256 or hashlib.sha256(zip_bytes).hexdigest()
    generated_at = datetime.now(timezone.utc).isoformat()
    partitions: list[dict] = []

    def write_lines(path: Path, rows: list[dict]) -> None:
        temporary = path.with_name(path.name + ".part")
        with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as stream:
            for row in rows:
                stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
                stream.write("\n")
        os.replace(temporary, path)

    for date in dates:
        directory = root / f"trade_date={date}"
        directory.mkdir(parents=True, exist_ok=True)
        stat_path = directory / "tdxstat.jsonl.gz"
        stat2_path = directory / "tdxstat2.jsonl.gz"
        if stat_by_date.get(date):
            write_lines(stat_path, stat_by_date[date])
        if stat2_by_date.get(date):
            write_lines(stat2_path, stat2_by_date[date])
        partitions.append(
            {
                "tradeDate": date,
                "statCount": len(stat_by_date.get(date, [])),
                "stat2Count": len(stat2_by_date.get(date, [])),
                "path": str(directory),
            }
        )

    manifest = {
        "schemaVersion": 1,
        "parser": "tdxstat-v1",
        "source": "zhb.zip",
        "sourceSha256": sha,
        "generatedAt": generated_at,
        "partitions": partitions,
        "skipped": skipped,
    }
    database = write_stats_db(
        root, stat_by_date, stat2_by_date, sha, generated_at
    )
    manifest["database"] = database.name
    manifest_path = root / "manifest.json"
    temporary = manifest_path.with_name(manifest_path.name + ".part")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, manifest_path)
    return {
        "normalizedTo": str(root),
        "manifest": str(manifest_path),
        "database": str(database),
        "sha256": sha,
        "generatedAt": generated_at,
        "partitions": partitions,
        "statCount": sum(len(rows) for rows in stat_by_date.values()),
        "stat2Count": sum(len(rows) for rows in stat2_by_date.values()),
        **skipped,
    }


BLOCK_HEADER_SIZE = 384


BLOCK_RECORD_SIZE = 2813


BLOCK_NAME_SIZE = 9


BLOCK_CODE_SIZE = 7


BLOCK_MAX_CODES = 400


BLOCK_FILES = {
    "gn": ("block_gn.dat", "概念板块"),
    "fg": ("block_fg.dat", "风格板块"),
    "zs": ("block_zs.dat", "指数板块"),
    "general": ("block.dat", "一般板块"),
}


def parse_block_dat(data: bytes, kind: str) -> list[dict]:
    """解析 384 字节头 + 2813 字节/条的板块 .dat。

    记录布局：9s 名称 + u16 股票数 + u16 类型 + 2800s 代码区（每只 7 字节）。
    这是 0x06b9 下载的 `block_gn.dat` / `block_fg.dat` / `block_zs.dat` 格式，
    与本地 `T0002/hq_cache` 的旧格式一致。
    """
    if len(data) < BLOCK_HEADER_SIZE + 2:
        raise TdxError("板块文件头不完整")
    count = _u16(data, BLOCK_HEADER_SIZE)
    pos = BLOCK_HEADER_SIZE + 2
    blocks: list[dict] = []
    for index in range(count):
        if pos + BLOCK_RECORD_SIZE > len(data):
            raise TdxError(
                f"板块记录被截断：第 {index + 1}/{count} 条，剩余 {len(data) - pos} 字节"
            )
        name = data[pos : pos + BLOCK_NAME_SIZE].decode("gbk", "replace").strip("\x00").strip()
        stock_count = _u16(data, pos + 9)
        codes: list[str] = []
        codes_start = pos + 13
        for code_index in range(min(stock_count, BLOCK_MAX_CODES)):
            start = codes_start + code_index * BLOCK_CODE_SIZE
            code = (
                data[start : start + BLOCK_CODE_SIZE]
                .decode("ascii", "replace")
                .rstrip("\x00")
                .strip()
            )
            if code:
                codes.append(code)
        blocks.append(
            {
                "id": f"{kind}-{index}",
                "name": name,
                "kind": kind,
                "count": stock_count,
                "codes": codes,
            }
        )
        pos += BLOCK_RECORD_SIZE
    return blocks


def parse_incon_sections(text: str) -> dict[str, list[tuple[str, str]]]:
    """解析 incon.dat 的 `#SECTION` + `code|name` 段。"""
    sections: dict[str, list[tuple[str, str]]] = {}
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("######"):
            current = None
            continue
        if line.startswith("#"):
            current = line[1:].strip()
            sections.setdefault(current, [])
            continue
        if current and "|" in line:
            code, name = line.split("|", 1)
            if code.strip() and name.strip():
                sections[current].append((code.strip(), name.strip()))
    return sections


def parse_tdxhy(text: str) -> list[dict]:
    """解析 tdxhy.cfg：market|symbol|TDX行业|…|TDXRSHY。"""
    rows: list[dict] = []
    for raw in text.splitlines():
        parts = raw.strip().split("|")
        if len(parts) < 3:
            continue
        market, symbol, tdx_code = parts[0].strip(), parts[1].strip(), parts[2].strip()
        if not symbol or not tdx_code:
            continue
        rows.append(
            {
                "market": market,
                "symbol": symbol,
                "tdxCode": tdx_code,
                "rsCode": parts[5].strip() if len(parts) > 5 else "",
            }
        )
    return rows


def parse_sector_indices(text: str) -> list[dict]:
    """解析 tdxzs.cfg：板块名 | 880xxx | … | T行业代码。"""
    rows: list[dict] = []
    for raw in text.splitlines():
        parts = raw.strip().split("|")
        if len(parts) < 2:
            continue
        name, code = parts[0].strip(), parts[1].strip()
        if not name or not code.startswith("88"):
            continue
        rows.append(
            {
                "name": name,
                "symbol": code,
                "code": f"sh{code}",
                "tdxCode": parts[5].strip() if len(parts) > 5 else "",
            }
        )
    return rows
