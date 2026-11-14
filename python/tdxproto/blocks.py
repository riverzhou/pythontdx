"""板块与扩展数据解析：自定义板块、tdxhy、榜单、异动、成交分布。"""

from __future__ import annotations

import os

from datetime import datetime, timedelta, timezone
from pathlib import Path

from .base import (
    MARKET_NAMES, TdxError, full_code,
)
from .codec import (
    _f32, _u16, _u32, classify_security,
    decode_volume, normalize_name, price_divisor, read_varint,
)


# ------------------------------------------------ 通达信客户端自定义板块

BLOCKNEW_RECORD = 120


BLOCKNEW_NAME = 50


def parse_blocknew_cfg(data: bytes) -> list[dict]:
    """解析客户端 `T0002/blocknew/blocknew.cfg`。

    定长记录：前 50 字节板块名（GBK，\\0 填充）+ 后 70 字节 `.blk` 文件名。
    实测 `D:\\tdx` 的 29 个自定义板块全部按这个格式解析。
    """
    records: list[dict] = []
    for start in range(0, len(data) - BLOCKNEW_RECORD + 1, BLOCKNEW_RECORD):
        name = data[start : start + BLOCKNEW_NAME].split(b"\x00")[0].decode("gbk", "ignore").strip()
        file = (
            data[start + BLOCKNEW_NAME : start + BLOCKNEW_RECORD]
            .split(b"\x00")[0]
            .decode("gbk", "ignore")
            .strip()
        )
        if name and file:
            records.append({"name": name, "file": file})
    return records


def parse_client_block(text: str) -> list[str]:
    """解析 `*.blk`：每行是 7 位「市场位 + 6 位代码」（0 深 / 1 沪），返回 6 位代码。"""
    codes: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if len(line) == 7 and line[0] in "012" and line[1:].isdigit():
            codes.append(line[1:])
        elif len(line) == 6 and line.isdigit():
            codes.append(line)
    return codes


def client_roots(explicit: str = "") -> list[Path]:
    """候选客户端目录：显式参数 > PYTHONTDX_TDX_DIR > 常见安装位置。"""
    roots: list[Path] = []
    if explicit.strip():
        roots.append(Path(explicit.strip().strip('"')))
    env = os.environ.get("PYTHONTDX_TDX_DIR")
    if env:
        roots.append(Path(env))
    for base in ("D:/tdx", "C:/tdx", "D:/new_tdx", "C:/new_tdx", "E:/tdx"):
        roots.append(Path(base))
    return roots


def client_block_indices(explicit: str = "") -> dict[tuple[str, str], str]:
    """客户端 `hq_cache/infoharbor_block.dat` 里的板块 → 880xxx 映射。

    服务器 `tdxzs.cfg` 只有概念 233/269、风格 141/161 有 880 指数；
    客户端这份缓存实测概念 269/269、风格 158/161，能补齐服务器缺的部分。
    """
    for root in client_roots(explicit):
        path = root / "T0002" / "hq_cache" / "infoharbor_block.dat"
        if not path.is_file():
            continue
        try:
            text = path.read_text("gbk", "ignore")
        except OSError:
            continue
        mapping: dict[tuple[str, str], str] = {}
        for line in text.splitlines():
            if not line.startswith("#"):
                continue
            parts = line[1:].split(",")
            if len(parts) < 3 or "_" not in parts[0]:
                continue
            prefix, name = parts[0].split("_", 1)
            kind = {"GN": "gn", "FG": "fg", "ZS": "zs"}.get(prefix)
            code = parts[2].strip()
            if kind and name and code.startswith("88"):
                mapping[(kind, name)] = f"sh{code}"
        return mapping
    return {}


SCREEN_FIELDS = (
    "price",
    "changePct",
    "amount",
    "turnoverRate",
    "amplitude",
    "pb",
    "floatCap",
    "totalCap",
)


SCREEN_SORT_FIELDS = (
    "changePct",
    "amount",
    "turnoverRate",
    "amplitude",
    "pb",
    "floatCap",
    "totalCap",
)


def filter_quotes_by_codes(quotes: list[dict], codes: set[str]) -> list[dict]:
    """行业筛选：保留代码集合内的行情。"""
    return [quote for quote in quotes if quote.get("code") in codes]


def apply_screen(quotes: list[dict], filters: dict) -> list[dict]:
    """在本地对一页/全市场分类行情做条件过滤与排序。"""
    result = []
    for quote in quotes:
        ok = True
        for field in SCREEN_FIELDS:
            minimum = filters.get(f"min{field[0].upper()}{field[1:]}")
            maximum = filters.get(f"max{field[0].upper()}{field[1:]}")
            if minimum is None and maximum is None:
                continue
            value = quote.get(field)
            if value is None or not isinstance(value, (int, float)):
                ok = False
                break
            if minimum is not None and value < float(minimum):
                ok = False
                break
            if maximum is not None and value > float(maximum):
                ok = False
                break
        if ok:
            result.append(quote)

    sort_by = filters.get("sortBy") or "changePct"
    if sort_by not in SCREEN_SORT_FIELDS:
        sort_by = "changePct"
    ascending = bool(filters.get("ascending", False))
    with_value = [
        quote
        for quote in result
        if isinstance(quote.get(sort_by), (int, float))
    ]
    missing_value = [
        quote
        for quote in result
        if not isinstance(quote.get(sort_by), (int, float))
    ]
    with_value.sort(key=lambda quote: float(quote[sort_by]), reverse=not ascending)
    result = with_value + missing_value
    limit = max(1, min(200, int(filters.get("limit", 80))))
    return result[:limit]


def is_record_start(buf: bytes, pos: int) -> bool:
    if pos + 7 > len(buf):
        return False
    if buf[pos] > 2:
        return False
    return all(0x30 <= byte <= 0x39 for byte in buf[pos + 1 : pos + 7])


def to_levels(levels: list[tuple[int, int]], scale: int) -> list[dict]:
    result = []
    for raw_price, volume in levels:
        price = raw_price / scale
        if price > 0:
            result.append({"price": price, "volume": volume})
    return result


def parse_bars(body: bytes, kind: str, period_raw: int = 4) -> list[dict]:
    count = _u16(body, 0)
    if len(body) < 2 + count * 16:
        raise TdxError("K 线报文不完整")

    pos = 2
    base = 0
    bars: list[dict] = []

    for _ in range(count):
        if period_raw == 13:
            seconds = _u32(body, pos)
            moment = datetime(2003, 12, 31, tzinfo=timezone(timedelta(hours=8))) + timedelta(
                seconds=seconds
            )
            date_text = moment.strftime("%Y-%m-%d %H:%M:%S")
            pos += 4
        elif period_raw in {0, 1, 2, 3, 7, 8}:
            packed_date = _u16(body, pos)
            minute_of_day = _u16(body, pos + 2)
            year = (packed_date >> 11) + 2004
            month = (packed_date % 2048) // 100
            day = (packed_date % 2048) % 100
            hour, minute = minute_of_day // 60, minute_of_day % 60
            date_text = f"{year:04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}"
            pos += 4
        else:
            date_raw = _u32(body, pos)
            date_text = format_date(date_raw)
            pos += 4

        open_diff, pos = read_varint(body, pos)
        close_diff, pos = read_varint(body, pos)
        high_diff, pos = read_varint(body, pos)
        low_diff, pos = read_varint(body, pos)

        open_raw = base + open_diff
        close_raw = open_raw + close_diff
        volume_raw = _u32(body, pos)
        amount_raw = _u32(body, pos + 4)
        pos += 8
        up_count = None
        down_count = None
        if kind == "index":
            up_count = _u16(body, pos)
            down_count = _u16(body, pos + 2)
            pos += 4

        volume = decode_volume(volume_raw)
        amount = decode_volume(amount_raw)
        bar = {
            "date": date_text,
            "open": open_raw / 1000,
            "close": close_raw / 1000,
            "high": (open_raw + high_diff) / 1000,
            "low": (open_raw + low_diff) / 1000,
            "volume": volume / 100,
            "amount": amount,
            # 原始千分位/原始量额：不丢精度，便于复算与审计。
            "openMilli": open_raw,
            "closeMilli": close_raw,
            "highMilli": open_raw + high_diff,
            "lowMilli": open_raw + low_diff,
            "lastCloseMilli": base,
            "volumeRaw": volume_raw,
            "amountRaw": amount_raw,
        }
        if kind == "index":
            bar["upCount"] = up_count
            bar["downCount"] = down_count
        bars.append(bar)
        base = close_raw

    return bars


def parse_special_limits(body: bytes) -> list[dict]:
    """0x0452：count u16 + 13 字节记录（市场/代码/u32 涨停 f32/跌停 f32）。"""
    count = _u16(body, 0)
    if len(body) != 2 + count * 13:
        raise TdxError("特殊涨跌停报文长度异常")
    records: list[dict] = []
    for index in range(count):
        offset = 2 + index * 13
        market_id = body[offset]
        code_num = _u32(body, offset + 1)
        market = MARKET_NAMES.get(market_id)
        if market is None:
            continue
        code = f"{code_num:06d}"
        records.append(
            {
                "market": market,
                "marketId": market_id,
                "code": f"{market.lower()}{code}",
                "symbol": code,
                "limitUp": round(_f32(body, offset + 5), 4),
                "limitDown": round(_f32(body, offset + 9), 4),
            }
        )
    return records


def parse_delisted_bars(body: bytes) -> list[dict]:
    """0x052b：退市日线（不复权）；记录为日期 + 4 个价格 delta + 量/额。"""
    count = _u16(body, 0)
    if len(body) < 2 + count * 17:
        raise TdxError("退市 K 线报文不完整")
    pos = 2
    base = 0
    bars: list[dict] = []
    for _ in range(count):
        date_raw = _u32(body, pos)
        pos += 4
        open_diff, pos = read_varint(body, pos)
        close_diff, pos = read_varint(body, pos)
        high_diff, pos = read_varint(body, pos)
        low_diff, pos = read_varint(body, pos)
        volume_raw, pos = read_varint(body, pos)
        if volume_raw < 0 or volume_raw > 0xFFFFFFFF:
            raise TdxError("退市 K 线成交量不合法")
        amount_raw = _u32(body, pos)
        pos += 4
        pos += 4  # unknown suffix
        open_raw = base + open_diff
        close_raw = open_raw + close_diff
        bars.append(
            {
                "date": format_date(date_raw),
                "open": open_raw / 1000,
                "close": close_raw / 1000,
                "high": (open_raw + high_diff) / 1000,
                "low": (open_raw + low_diff) / 1000,
                "volume": volume_raw / 100,
                "amount": decode_volume(amount_raw),
            }
        )
        base = close_raw
    return bars


def format_date(raw: int) -> str:
    year, month, day = raw // 10000, raw % 10000 // 100, raw % 100
    if year < 1990 or year > 2100 or month < 1 or month > 12 or day < 1 or day > 31:
        raise TdxError("K 线日期不合法")
    return f"{year:04d}-{month:02d}-{day:02d}"


def minute_label(index: int) -> str:
    total = 571 + index if index < 120 else 661 + index
    return f"{total // 60:02d}:{total % 60:02d}"


def parse_today_minute(
    body: bytes, code: str, name: str, date: str, prev_close: float, decimal: int | None
) -> dict:
    count = _u16(body, 0)
    if len(body) < 4 + count * 3:
        raise TdxError("分时报文不完整")

    divisor = price_divisor(decimal)
    points: list[dict] = []
    pos = 4
    first_price = 0
    first_avg = 0

    for index in range(count):
        price_field, pos = read_varint(body, pos)
        avg_field, pos = read_varint(body, pos)
        volume, pos = read_varint(body, pos)

        if index == 0:
            first_price = price_field
            first_avg = avg_field

        price_raw = price_field if index == 0 else first_price + price_field
        avg_raw = avg_field if index == 0 else first_avg + avg_field
        price = price_raw / (100 * divisor)
        if price <= 0:
            continue

        points.append(
            {
                "time": minute_label(index),
                "price": price,
                "avg": avg_raw / (10000 * divisor),
                "volume": volume,
            }
        )

    return {
        "code": code,
        "name": name,
        "date": date,
        "prevClose": prev_close,
        "points": points,
    }


def parse_minute_aux(body: bytes, selector: int = 0) -> dict:
    """0x051b 分时副图：selector 0 买卖力道（varint 对），0x0b 成交对比（f32 对）。"""
    count = _u16(body, 0)
    pos = 2
    points: list[dict] = []
    if selector == 0x0B:
        expected = 2 + count * 8
        if len(body) != expected:
            raise TdxError("分时副图成交对比报文长度异常")
        for index in range(count):
            previous = _f32(body, pos)
            current = _f32(body, pos + 4)
            pos += 8
            points.append(
                {
                    "index": index,
                    "time": minute_label(index),
                    "previousDayCumulativeVolume": previous,
                    "currentDayCumulativeVolume": current,
                }
            )
    else:
        for index in range(count):
            series_a, pos = read_varint(body, pos)
            series_b, pos = read_varint(body, pos)
            points.append(
                {
                    "index": index,
                    "time": minute_label(index),
                    "seriesA": series_a,
                    "seriesB": series_b,
                    "buyCommission": series_a,
                    "sellCommission": series_b,
                }
            )
        if pos != len(body):
            raise TdxError("分时副图买卖力道报文尾部有多余字节")
    return {"selector": selector, "count": len(points), "points": points}


def parse_sparkline(body: bytes) -> dict:
    """0x0fd1 小走势：42B 头 + f32 价格序列。"""
    if len(body) < 42:
        raise TdxError("小走势报文不完整")
    market_id = body[0]
    code = body[2:8].decode("ascii", errors="replace")
    selector = body[24]
    reserved = _u32(body, 26)
    max_count = _u16(body, 34)
    base = _f32(body, 36)
    count = _u16(body, 40)
    if len(body) != 42 + count * 4:
        raise TdxError("小走势价格序列长度异常")
    prices = [_f32(body, 42 + index * 4) for index in range(count)]
    return {
        "marketId": market_id,
        "code": code,
        "selectorEcho": selector,
        "reservedParam": reserved,
        "maxCount": max_count,
        "basePrice": base,
        "count": count,
        "prices": prices,
    }


def parse_unusual(body: bytes) -> list[dict]:
    """0x0563 主力监控：2B 条数 + 每条 32B 定长事件。

    字段布局见 gotdx `proto/get_unusual.go:103-133`：
    市场(2) 代码(6) 未知(1) 类型(1) 未知(1) 序号(2) 未知(2) 负载(13) 小时(1) 分秒(2)。
    事件文案按 19 个类型码映射；未知类型保留原始负载，不丢报文。
    """
    if len(body) < 2:
        raise TdxError("主力监控报文不完整")
    count = _u16(body, 0)
    if len(body) < 2 + count * 32:
        raise TdxError("主力监控记录长度不足")
    rows: list[dict] = []
    for index in range(count):
        base = 2 + index * 32
        market = _u16(body, base)
        symbol = body[base + 2 : base + 8].decode("ascii", errors="replace").rstrip("\x00")
        event_type = body[base + 9]
        seq = _u16(body, base + 11)
        payload = body[base + 15 : base + 28]
        hour = body[base + 29]
        minute_sec = _u16(body, base + 30)
        second = minute_sec % 100
        minute = minute_sec // 100
        desc, value = _unusual_text(event_type, payload)
        rows.append(
            {
                "code": full_code(market, symbol) if len(symbol) == 6 else symbol,
                "market": MARKET_NAMES.get(market, str(market)),
                "symbol": symbol,
                "index": seq,
                "event": event_type,
                "desc": desc,
                "value": value,
                "time": f"{hour:02d}:{minute:02d}:{second:02d}",
                "raw": payload.hex(),
            }
        )
    return rows


def _unusual_text(event_type: int, data: bytes) -> tuple[str, str]:
    """19 类异动文案；照 gotdx 的判定顺序实现，不猜未公开类型。"""
    if len(data) < 13:
        return "", ""
    v1 = data[0]
    v2 = _f32(data, 1)
    v3 = _f32(data, 5)
    v4 = _f32(data, 9)
    if event_type == 0x03:
        return ("主力买入" if v1 == 0 else "主力卖出"), f"{v2:.2f}/{v3:.2f}"
    if event_type == 0x04:
        return "加速拉升", f"{v2 * 100:.2f}%"
    if event_type == 0x05:
        return "加速下跌", ""
    if event_type == 0x06:
        return "低位反弹", f"{v2 * 100:.2f}%"
    if event_type == 0x07:
        return "高位回落", f"{v2 * 100:.2f}%"
    if event_type == 0x08:
        return "撑杆跳高", f"{v2 * 100:.2f}%"
    if event_type == 0x09:
        return "平台跳水", f"{v2 * 100:.2f}%"
    if event_type == 0x0A:
        return ("单笔冲跌" if v2 < 0 else "单笔冲涨"), f"{v2 * 100:.2f}%"
    if event_type == 0x0B:
        if v3 == 0:
            return "区间放量平", f"{v2:.1f}倍"
        kind = "区间放量跌" if v3 < 0 else "区间放量涨"
        return kind, f"{v2:.1f}倍{v3 * 100:.2f}%"
    if event_type == 0x0C:
        return "区间缩量", ""
    if event_type == 0x10:
        return "大单托盘", f"{v4:.2f}/{v3:.2f}"
    if event_type == 0x11:
        return "大单压盘", f"{v2:.2f}/{v3:.2f}"
    if event_type == 0x12:
        return "大单锁盘", ""
    if event_type == 0x13:
        return "竞价试买", f"{v2:.2f}/{v3:.2f}"
    if event_type == 0x14:
        if len(data) < 10:
            return "", ""
        sub_type = data[1]
        uv2 = _f32(data, 2)
        uv3 = _f32(data, 6)
        direction = "跌" if v1 != 0 else "涨"
        desc = {
            0x01: f"逼近{direction}停",
            0x02: f"封{direction}停板",
            0x04: f"封{direction}大减",
            0x05: f"打开{direction}停",
        }.get(sub_type, "")
        return desc, f"{uv2:.2f}/{uv3:.2f}"
    if event_type == 0x15:
        desc = {0x00: "尾盘异动", 0x01: "尾盘对倒", 0x02: "尾盘拉升"}.get(v1, "尾盘打压")
        return desc, f"{v2 * 100:.2f}%/{v3:.2f}"
    if event_type == 0x16:
        return ("盘中弱势" if v2 < 0 else "盘中强势"), f"{v2 * 100:.2f}%"
    if event_type == 0x1D:
        return "急速拉升", f"{v2 * 100:.2f}%"
    if event_type == 0x1E:
        return "急速下跌", f"{v2 * 100:.2f}%"
    return "", ""


TOP_BOARD_NAMES = (
    "increase",
    "decrease",
    "amplitude",
    "riseSpeed",
    "fallSpeed",
    "volRatio",
    "posCommissionRatio",
    "negCommissionRatio",
    "turnover",
)


def parse_top_board(body: bytes) -> dict:
    """0x053f 排行榜：1B 每榜条数 + 9 个榜单 × size × 15B。"""
    if not body:
        raise TdxError("排行榜报文为空")
    size = body[0]
    if size <= 0:
        return {"size": 0, "boards": {}}
    need = 1 + 9 * size * 15
    if len(body) < need:
        raise TdxError("排行榜报文长度不足")
    boards: dict[str, list[dict]] = {}
    pos = 1
    for name in TOP_BOARD_NAMES:
        rows: list[dict] = []
        for _ in range(size):
            market = body[pos]
            symbol = body[pos + 1 : pos + 7].decode("ascii", errors="replace").rstrip("\x00")
            price = _f32(body, pos + 7)
            value = _f32(body, pos + 11)
            rows.append(
                {
                    "code": full_code(market, symbol) if len(symbol) == 6 else symbol,
                    "market": MARKET_NAMES.get(market, str(market)),
                    "symbol": symbol,
                    "price": round(float(price), 4),
                    "value": round(float(value), 4),
                }
            )
            pos += 15
        boards[name] = rows
    return {"size": size, "boards": boards}


def parse_volume_profile(body: bytes) -> dict:
    """0x051a 成交分布（筹码分布）：11B 头 + 变长快照 + 三档盘口 + 价位分布。"""
    if len(body) < 11:
        raise TdxError("成交分布报文不完整")
    count = _u16(body, 0)
    market = body[2]
    symbol = body[3:9].decode("ascii", errors="replace").rstrip("\x00")
    active = _u16(body, 9)
    pos = 11

    def price() -> int:
        nonlocal pos
        value, pos = read_varint(body, pos)
        return value

    base = price()
    pre_close_diff = price()
    open_diff = price()
    high_diff = price()
    low_diff = price()
    server_time_raw = price()
    neg_price_raw = price()
    volume = price()
    current_volume = price()
    amount = _f32(body, pos)
    pos += 4
    in_volume = price()
    out_volume = price()
    sell_amount = price()
    open_amount = price()

    bids: list[dict] = []
    asks: list[dict] = []
    for _ in range(3):
        bid = price() + base
        ask = price() + base
        bid_volume = price()
        ask_volume = price()
        bids.append({"price": round(bid / 100, 2), "volume": bid_volume})
        asks.append({"price": round(ask / 100, 2), "volume": ask_volume})

    if pos + 2 <= len(body):
        pos += 2  # 未知 u16

    profile: list[dict] = []
    current = 0
    for _ in range(count):
        delta = price()
        if delta >= 1 << 31:
            delta = delta - (1 << 32)
        delta_volume = price()
        buy = price()
        sell = price()
        current += delta
        profile.append(
            {
                "price": round(current / 100, 2),
                "volume": delta_volume,
                "buy": buy,
                "sell": sell,
            }
        )

    return {
        "marketId": market,
        "symbol": symbol,
        "active": active,
        "serverTimeRaw": server_time_raw,
        "time": _format_tick_time(server_time_raw),
        "close": round(base / 100, 2),
        "preClose": round((base + pre_close_diff) / 100, 2),
        "open": round((base + open_diff) / 100, 2),
        "high": round((base + high_diff) / 100, 2),
        "low": round((base + low_diff) / 100, 2),
        "negPrice": round(neg_price_raw / 100, 2),
        "volume": volume,
        "currentVolume": current_volume,
        "amount": round(float(amount), 2),
        "inVolume": in_volume,
        "outVolume": out_volume,
        "sellAmount": sell_amount,
        "openAmount": open_amount,
        "bids": bids,
        "asks": asks,
        "count": len(profile),
        "profile": profile,
    }


def _format_tick_time(raw: int) -> str:
    """0x051a 的 serverTime 是「时 + 分 + 秒的小数」压缩整数。

    照 gotdx `formatServerTime` 还原：分钟位 (`raw/10000%100`) < 60 时按
    `时=raw/1000000`、`秒=(raw%10000)*60/10000` 拆；否则按整段分钟重拆。
    返回 HH:MM:SS.mmm；0/100 视为无效。
    """
    if raw <= 0 or raw == 100:
        return ""
    minutes_field = (raw // 10000) % 100
    if minutes_field < 60:
        hours = raw // 1_000_000
        minutes = minutes_field
        seconds_millis = (raw % 10000) * 60 / 10000.0
    else:
        total = (raw % 1_000_000) * 60 / 1_000_000.0
        hours = raw // 1_000_000
        minutes = int(total // 60)
        seconds_millis = total - minutes * 60
        hours += minutes // 60
        minutes %= 60
    seconds = int(seconds_millis)
    millis = int(round((seconds_millis - seconds) * 1000))
    if hours > 23 or millis >= 1000:
        return ""
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def parse_recent_minute(
    body: bytes, code: str, name: str, date: str, decimal: int | None
) -> dict:
    """0x0feb 近期历史分时：10B 头 + 每点 price/avg/volume varint。"""
    count = _u16(body, 0)
    prev_close = _f32(body, 2)
    open_price = _f32(body, 6)
    if len(body) < 10:
        raise TdxError("近期分时报文不完整")
    divisor = price_divisor(decimal)
    points: list[dict] = []
    pos = 10
    price_acc = 0
    avg_acc = 0
    for index in range(count):
        price_delta, pos = read_varint(body, pos)
        avg_delta, pos = read_varint(body, pos)
        volume, pos = read_varint(body, pos)
        if index == 0:
            price_acc = price_delta
            avg_acc = avg_delta
        else:
            price_acc += price_delta
            avg_acc += avg_delta
        points.append(
            {
                "time": minute_label(index),
                "price": price_acc / (100 * divisor),
                "avg": avg_acc / (10000 * divisor),
                "volume": volume,
            }
        )
    if pos != len(body):
        raise TdxError("近期分时报文尾部有多余字节")
    return {
        "code": code,
        "name": name,
        "date": date,
        "prevClose": prev_close,
        "open": open_price,
        "points": points,
    }


def parse_history_minute(
    body: bytes, code: str, name: str, date: str, prev_close: float, decimal: int | None
) -> dict:
    count = _u16(body, 0)
    prev_close_raw = _f32(body, 2)
    if len(body) < 6 + count * 3:
        raise TdxError("历史分时报文不完整")

    divisor = price_divisor(decimal)
    points: list[dict] = []
    pos = 6
    price_acc = 0
    cumulative_volume = 0
    cumulative_amount = 0.0

    for index in range(count):
        price_delta, pos = read_varint(body, pos)
        _, pos = read_varint(body, pos)  # 均价增量：历史接口不提供，忽略
        volume, pos = read_varint(body, pos)

        price_acc += price_delta
        price = price_acc / (100 * divisor)
        if price <= 0:
            continue

        cumulative_volume += volume
        cumulative_amount += price * volume
        points.append(
            {
                "time": minute_label(index),
                "price": price,
                "avg": cumulative_amount / cumulative_volume if cumulative_volume > 0 else price,
                "volume": volume,
            }
        )

    return {
        "code": code,
        "name": name,
        "date": date,
        "prevClose": prev_close_raw if prev_close_raw > 0 else prev_close,
        "points": points,
    }


def parse_security_count(body: bytes) -> int:
    return _u16(body, 0)


def parse_security_list(body: bytes, market: int) -> list[dict]:
    count = _u16(body, 0)
    if len(body) < 2 + count * 37:
        raise TdxError("代码表报文不完整")

    items: list[dict] = []
    for index in range(count):
        base = 2 + index * 37
        symbol = body[base : base + 6].decode("ascii", errors="replace").rstrip("\x00")
        if len(symbol) != 6 or not symbol.isdigit():
            continue

        name = normalize_name(
            body[base + 8 : base + 24].decode("gbk", errors="replace").rstrip("\x00")
        )
        decimal = body[base + 28]
        items.append(
            {
                "code": full_code(market, symbol),
                "market": MARKET_NAMES[market],
                "symbol": symbol,
                "name": name or symbol,
                "decimal": decimal,
                "multiple": _u16(body, base + 6),
                "volumeRatioBase": round(_f32(body, base + 24), 6),
                "prevClose": round(_f32(body, base + 29), 4),
                "tailHex": body[base + 33 : base + 37].hex(),
                "kind": classify_security(market, symbol),
            }
        )

    return items


CAPITAL_CATEGORY_NAMES = {
    1: "除权除息",
    2: "送配股上市",
    3: "非流通股上市",
    4: "未知股本变动",
    5: "股本变化",
    6: "增发新股",
    7: "股份回购",
    8: "增发新股上市",
    9: "转配股上市",
    10: "可转债上市",
    11: "扩缩股",
    12: "非流通股缩股",
    13: "送认购权证",
    14: "送认沽权证",
    15: "重整调整",
}


CAPITAL_SHARE_CATEGORIES = {2, 3, 5, 7, 8, 9, 10}


def parse_capital_changes(body: bytes) -> list[dict]:
    """0x000f 股本变迁：block header (9B) + 29B 记录。"""
    block_count = _u16(body, 0)
    pos = 2
    blocks: list[dict] = []
    for _ in range(block_count):
        if pos + 9 > len(body):
            raise TdxError("股本变迁块头不完整")
        market_id = body[pos]
        symbol = body[pos + 1 : pos + 7].decode("ascii", errors="replace").rstrip("\x00")
        record_count = _u16(body, pos + 7)
        pos += 9
        if len(symbol) != 6 or not symbol.isdigit():
            raise TdxError("股本变迁代码不合法")
        market = MARKET_NAMES.get(market_id)
        if market is None:
            raise TdxError("股本变迁市场不合法")
        records: list[dict] = []
        for _ in range(record_count):
            if pos + 29 > len(body):
                raise TdxError("股本变迁记录不完整")
            record_market = body[pos]
            record_symbol = body[pos + 1 : pos + 7].decode("ascii", errors="replace").rstrip("\x00")
            date_raw = _u32(body, pos + 8)
            category = body[pos + 12]
            floats = [_f32(body, pos + 13 + index * 4) for index in range(4)]
            if category in CAPITAL_SHARE_CATEGORIES:
                values = [round(value * 10000, 4) for value in floats]
            elif category == 6:
                values = [floats[0], floats[1], round(floats[2] * 10000, 4), floats[3]]
            else:
                values = floats
            records.append(
                {
                    "market": MARKET_NAMES.get(record_market, market),
                    "code": full_code(record_market, record_symbol),
                    "date": format_date(date_raw),
                    "category": category,
                    "categoryName": CAPITAL_CATEGORY_NAMES.get(category, f"类别{category}"),
                    "c1": values[0],
                    "c2": values[1],
                    "c3": values[2],
                    "c4": values[3],
                    "c1Float": floats[0],
                    "c2Float": floats[1],
                    "c3Float": floats[2],
                    "c4Float": floats[3],
                    "reserved": body[pos + 7],
                }
            )
            pos += 29
        blocks.append(
            {
                "code": full_code(market_id, symbol),
                "market": market,
                "count": len(records),
                "records": records,
            }
        )
    if pos != len(body):
        raise TdxError("股本变迁报文尾部有多余字节")
    return blocks


def parse_finance(body: bytes) -> list[dict]:
    """0x0010 财务批量：保留全部 136B info 字段，不只取 4 个摘要值。

    原始浮点单位：股本为万股，资产/收入/利润为千元；同时给出换算后的
    股数/元字段，避免调用方反复记单位。字段顺序来自 0x0010 记录布局。
    """
    count = _u16(body, 0)
    if len(body) != 2 + count * 143:
        raise TdxError("财务报文长度异常")

    offsets = {
        "floatShares": 0,
        "totalShares": 16,
        # 16..40 的 6 个股本字段：总股本 + 国家股/发起人法人股/法人股/B 股/H 股
        "stateShares": 20,
        "sponsorShares": 24,
        "legalPersonShares": 28,
        "bShares": 32,
        "hShares": 36,
        "eps": 40,
        "totalAssets": 44,
        "currentAssets": 48,
        "fixedAssets": 52,
        "intangibleAssets": 56,
        "shareholders": 60,
        "currentLiabilities": 64,
        "longTermLiabilities": 68,
        "capitalReserve": 72,
        "netAssets": 76,
        "revenue": 80,
        "mainProfit": 84,
        "receivables": 88,
        "operatingProfit": 92,
        "investmentIncome": 96,
        "operatingCashFlow": 100,
        "totalCashFlow": 104,
        "inventory": 108,
        "comprehensiveProfit": 112,
        "afterTaxProfit": 116,
        "netProfit": 120,
        "retainedProfit": 124,
        "netAssetsPerShare": 128,
        "reserved2": 132,
    }
    items: list[dict] = []
    for index in range(count):
        base = 2 + index * 143
        market_id = body[base]
        market = MARKET_NAMES.get(market_id)
        if market is None:
            continue

        symbol = body[base + 1 : base + 7].decode("ascii", errors="replace").rstrip("\x00")
        if len(symbol) != 6 or not symbol.isdigit():
            continue

        info = base + 7
        values = {name: _f32(body, info + offset) for name, offset in offsets.items()}
        values.update(
            {
                "provinceId": _u16(body, info + 4),
                "industryId": _u16(body, info + 6),
                "updatedDate": _u32(body, info + 8),
                "ipoDate": _u32(body, info + 12),
            }
        )
        values["floatSharesRaw"] = values["floatShares"]
        values["totalSharesRaw"] = values["totalShares"]
        values["floatSharesShares"] = values["floatShares"] * 10000
        values["totalSharesShares"] = values["totalShares"] * 10000
        # 旧字段名保留一版，避免已有 CSV/Parquet 消费者立刻断掉；语义是「股」。
        values["floatSharesYuan"] = values["floatSharesShares"]
        values["totalSharesYuan"] = values["totalSharesShares"]
        values["totalAssetsYuan"] = values["totalAssets"] * 1000
        values["revenueYuan"] = values["revenue"] * 1000
        values["netProfitYuan"] = values["netProfit"] * 1000
        values["recordHex"] = body[base : base + 143].hex()
        items.append({"code": full_code(market_id, symbol), **values})

    return items
