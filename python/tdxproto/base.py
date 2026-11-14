"""协议层最底层的共享件：异常、数据目录、股票代码归一化与市场常量。
其他模块都依赖它，它不依赖任何本包模块（避免环）。"""

from __future__ import annotations

from data_paths import data_dir
from pathlib import Path


MARKET_NAMES = {0: "SZ", 1: "SH", 2: "BJ"}


MARKET_IDS = {"sz": 0, "sh": 1, "bj": 2}


class TdxError(Exception):
    """message 直接是能展示给用户的中文"""


def code_bytes(symbol: str) -> bytes:
    if len(symbol) != 6 or not symbol.isdigit():
        raise TdxError(f"证券代码不是 6 位数字：{symbol}")
    return symbol.encode("ascii")


def parse_code(code: str) -> tuple[int, str]:
    """'sh600519' → (1, '600519')；港股/美股/非法代码直接抛错。"""
    text = code.strip().lower()
    if len(text) < 3:
        raise TdxError("证券代码格式不正确")
    prefix = text[:2]
    symbol = text[2:]
    market = MARKET_IDS.get(prefix)
    if market is None or len(symbol) != 6 or not symbol.isdigit():
        raise TdxError("当前数据源暂不支持港股/美股")
    return market, symbol


def full_code(market: int, symbol: str) -> str:
    return f"{MARKET_NAMES[market].lower()}{symbol}"


def pythontdx_data_dir() -> Path:
    """原始数据目录；开发/测试可用 PYTHONTDX_DATA_DIR 覆盖（兼容旧 STOCKLENS_DATA_DIR）。"""
    return data_dir()
