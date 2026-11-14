"""帧编解码：16 字节头 + zlib body、varint、u16/u32/f32、量纲换算。"""

from __future__ import annotations

import re
import struct


from .base import (
    TdxError,
)


# ---------------------------------------------------------------- 编解码


def encode_frame(msg_id: int, msg_type: int, data: bytes) -> bytes:
    length = len(data) + 2

    if length > 0xFFFF:
        raise TdxError("行情请求过大")

    return struct.pack("<BIBHHH", 0x0C, msg_id, 0x01, length, length, msg_type) + data


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    if pos < 0 or pos >= len(buf):
        raise TdxError("行情报文不完整")

    byte = buf[pos]
    value = byte & 0x3F
    negative = bool(byte & 0x40)
    shift = 6
    cursor = pos + 1

    while byte & 0x80:
        if cursor >= len(buf):
            raise TdxError("行情报文不完整")
        byte = buf[cursor]
        value += (byte & 0x7F) << shift
        shift += 7
        cursor += 1
        if shift > 49:
            raise TdxError("行情报文数值溢出")

    return (-value if negative else value), cursor


def decode_volume(raw: int) -> float:
    """通达信的压缩浮点：最高字节是指数，低 3 字节是尾数。"""
    if raw == 0:
        return 0.0

    signed = raw - 0x100000000 if raw >= 0x80000000 else raw
    logpoint = signed >> 24
    hleax = (signed >> 16) & 0xFF
    lheax = (signed >> 8) & 0xFF
    lleax = signed & 0xFF

    base = 2.0 ** (logpoint * 2 - 0x7F)
    high = base * (64 + (hleax & 0x7F)) / 64 if hleax > 0x80 else base * hleax / 128
    scale = 2.0 if hleax & 0x80 else 1.0
    middle = base * lheax / 32768 * scale
    low = base * lleax / 8388608 * scale

    return base + high + middle + low


def _u16(buf: bytes, pos: int) -> int:
    if pos + 2 > len(buf):
        raise TdxError("行情报文不完整")
    return struct.unpack_from("<H", buf, pos)[0]


def _u32(buf: bytes, pos: int) -> int:
    if pos + 4 > len(buf):
        raise TdxError("行情报文不完整")
    return struct.unpack_from("<I", buf, pos)[0]


def _f32(buf: bytes, pos: int) -> float:
    if pos + 4 > len(buf):
        raise TdxError("行情报文不完整")
    return struct.unpack_from("<f", buf, pos)[0]


def price_divisor(decimal: int | None) -> int:
    if decimal is None or decimal <= 2:
        return 1
    if decimal == 3:
        return 10
    return 10 ** (decimal - 2)


def is_index_code(market: int, symbol: str) -> bool:
    if market == 1:
        return symbol.startswith(("000", "999", "880", "881"))
    if market == 0:
        return symbol.startswith("399")
    return symbol.startswith("899")


def normalize_name(name: str) -> str:
    """腾讯/通达信都会用空格做视觉对齐：'五 粮 液' → '五粮液'。

    但英文名里的空格有意义（如 'INTL GENIUS'），只压成一个空格。
    """
    text = name.strip()
    if not text:
        return ""
    if re.search(r"[A-Za-z]", text):
        return re.sub(r"\s+", " ", text)
    return re.sub(r"\s+", "", text)


def classify_security(market: int, symbol: str) -> str:
    if is_index_code(market, symbol):
        return "ZS"
    if symbol.startswith(("11", "12")):
        return "ZQ"
    if symbol.startswith(("15", "16", "18", "50", "51", "52", "56", "58")):
        return "JJ"
    if symbol.startswith(("200", "900")):
        return "GP-B"
    return "GP-A"
