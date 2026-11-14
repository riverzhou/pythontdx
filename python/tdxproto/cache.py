"""进程内缓存规则：TTL、容量、缓存键与跨请求复用的数据结构。"""

from __future__ import annotations

from datetime import datetime

from .constants import (
    SHANGHAI_TZ, shanghai_clock,
)


# ---------------------------------------------------------------- 数据缓存
#
# 这些缓存属于「服务端数据逻辑」：桌面 IPC、Web HTTP、SSE/WS 必须命中
# 同一份规则，否则桌面 10 秒缓存、Web 每次重拉会直接造成两端不一致。
MINUTE_CACHE_TTL = 10.0


FIVE_DAY_CACHE_TTL = 60.0


KLINE_CACHE_TTL = 60.0


KLINE_LIVE_TAIL = 20


KLINE_LIVE_FULL_REFRESH = 60.0


# 长时间运行看全市场时，缓存键会随代码数量增长；保留最近 N 个即可，
# 过期数据本来就没有复用价值。这是上限而不是 TTL 的替代。
CACHE_MAX_ENTRIES = 256


KLINE_LIVE_MAX_ENTRIES = 128


BREADTH_TRADING_TTL = 15.0


BREADTH_LUNCH_TTL = 120.0


BREADTH_CLOSED_TTL = 300.0


def breadth_ttl(now: datetime | None = None) -> float:
    """涨跌家数缓存时长：交易 15s、午休 120s、收盘 300s。"""
    _time, session = shanghai_clock(now)
    if session in {"trading", "pre-open"}:
        return BREADTH_TRADING_TTL
    if session == "lunch-break":
        return BREADTH_LUNCH_TTL
    return BREADTH_CLOSED_TTL


def shanghai_day(now: datetime | None = None) -> str:
    """北京时间日期；涨跌家数缓存跨日必须失效。"""
    moment = datetime.now(SHANGHAI_TZ) if now is None else now
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=SHANGHAI_TZ)
    else:
        moment = moment.astimezone(SHANGHAI_TZ)
    return moment.strftime("%Y-%m-%d")


def merge_kline_bars(
    base: list[dict], incoming: list[dict]
) -> list[dict]:
    """按 date 覆盖合并 K 线；tail 只有最近 20 根，不能覆盖掉本地历史。"""
    by_date = {bar.get("date"): bar for bar in base if bar.get("date")}
    for bar in incoming:
        if bar.get("date"):
            by_date[bar["date"]] = bar
    return [by_date[key] for key in sorted(by_date)]


TRADE_PAGE = 1800


AUCTION_RECORD = 16


AUCTION_LIMIT = 500


FILE_PATH_FIELD = 300


FILE_CHUNK = 30000


MAX_FILE_CHUNK = 60000


MAX_FILE_BYTES = 128 * 1024 * 1024


MONEY_FLOW_CHANNEL = 0x2D


MONEY_FLOW_ROUTE = 0x7E


MONEY_FLOW_HEADER = 0x28


MONEY_FLOW_RECORD = 0x58


F10_NAME_SIZE = 64


F10_FILENAME_SIZE = 80


F10_RECORD_SIZE = 152


F10_CONTENT_HEADER = 12


PERIOD_RAW = {
    "5s": 13,
    "15s": 13,
    "1m": 7,
    "5m": 0,
    "10m": 8,
    "15m": 1,
    "20m": 8,
    "30m": 2,
    "60m": 3,
    "2m": 8,
    "3m": 8,
    "4m": 8,
    "6m": 8,
    "8m": 8,
    "12m": 8,
    "18m": 8,
    "24m": 8,
    "36m": 8,
    "48m": 8,
    "day": 4,
    "week": 5,
    "month": 6,
    "2d": 9,
    "3d": 9,
    "4d": 9,
    "6d": 9,
    "9d": 9,
    "12d": 9,
    "18d": 9,
    "24d": 9,
    "45d": 9,
    "quarter": 10,
    "year": 11,
}
