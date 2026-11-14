"""连接层：单个 7709 会话的握手、请求-响应配对、心跳与错误处理。"""

from __future__ import annotations

import socket
import struct
import time
import zlib

from collections import deque

from .base import (
    TdxError,
)
from .codec import (
    _u16, _u32, encode_frame,
)
from .constants import (
    CMD_HANDSHAKE, CMD_HEARTBEAT, CONNECT_TIMEOUT, ENDPOINTS,
    HEARTBEAT_INTERVAL, MAX_FRAME_BYTES, REQUEST_TIMEOUT,
)


# ---------------------------------------------------------------- 连接


def parse_handshake(body: bytes) -> dict:
    """0x000d 握手回包（eltdx session.rs：189B）。"""
    if len(body) < 189:
        return {"available": False, "bytes": len(body)}
    year = _u16(body, 1)
    month, day = body[4], body[3]
    minutes_1 = struct.unpack_from("<8H", body, 9)
    minutes_2 = struct.unpack_from("<8H", body, 25)
    date_1 = _u32(body, 42)
    date_2 = _u32(body, 50)
    return {
        "available": True,
        "bytes": len(body),
        "serverDate": f"{year:04d}-{month:02d}-{day:02d}",
        "sessions1": [f"{value // 60:02d}:{value % 60:02d}" for value in minutes_1],
        "sessions2": [f"{value // 60:02d}:{value % 60:02d}" for value in minutes_2],
        "date1": str(date_1),
        "date2": str(date_2),
        "serverName": body[68:152].decode("gb18030", "replace").strip("\u0000"),
        "productTag": body[160:189].decode("gb18030", "replace").strip("\u0000"),
        "rawHex": body.hex(),
    }


class TdxConnection:
    def __init__(self, endpoints: list[tuple[str, int]] | None = None):
        self.endpoints = list(endpoints or ENDPOINTS)
        self.sock: socket.socket | None = None
        self.msg_id = 0
        self.cursor = 0
        self.last_activity = time.monotonic()
        # 0x0547 的主站主动推送：不匹配当前请求 msg_id 的帧先入队，
        # 由 Bridge 在下一轮刷新时按代码合并。
        self.push_frames: deque[tuple[int, int, bytes]] = deque(maxlen=1024)
        self.handshake: dict = {"available": False}

    def close(self) -> None:
        # 断线后旧连接的未配对推送帧必须清掉：重连后它们属于上一代 socket，
        # 再被 `_drain_quote_pushes` 当成新帧会把过期行情合并进当前快照。
        self.push_frames.clear()
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def _connect(self, deadline: float | None = None) -> None:
        last_error: Exception | None = None

        def remaining(budget: float) -> float:
            if deadline is None:
                return budget
            return max(0.5, min(budget, deadline - time.monotonic()))

        for attempt in range(len(self.endpoints)):
            index = (self.cursor + attempt) % len(self.endpoints)
            host, port = self.endpoints[index]
            sock: socket.socket | None = None
            try:
                sock = socket.create_connection(
                    (host, port), timeout=remaining(CONNECT_TIMEOUT)
                )
                sock.settimeout(remaining(REQUEST_TIMEOUT))
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.sock = sock
                # 只发 0x000d；不要 setup2/setup3；回包含服务器时间/时段/名称。
                self.handshake = parse_handshake(
                    self._transact(CMD_HANDSHAKE, b"\x01")
                )
                self.cursor = index
                self.last_activity = time.monotonic()
                return
            except Exception as error:  # noqa: BLE001 - 主站失败要继续试下一个
                last_error = error
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
                self.sock = None

        raise TdxError("行情服务器连接失败，请检查网络") from last_error

    def _recv_exact(self, size: int) -> bytes:
        if self.sock is None:
            raise TdxError("行情服务器未连接")

        chunks: list[bytes] = []
        remaining = size
        while remaining > 0:
            data = self.sock.recv(remaining)
            if not data:
                raise TdxError("行情服务器连接已断开")
            chunks.append(data)
            remaining -= len(data)
        return b"".join(chunks)

    def _read_frame(self) -> tuple[int, int, bytes]:
        header = self._recv_exact(16)
        if header[:4] != b"\xb1\xcbt\x00":
            raise TdxError("行情报文头不合法")

        # 响应头：4 前缀 + 1 control + u32 msg_id + 1 reserved + u16 msg_type
        #        + u16 zip_length + u16 length。
        msg_id = struct.unpack_from("<I", header, 5)[0]
        msg_type = struct.unpack_from("<H", header, 10)[0]
        zip_length, length = struct.unpack_from("<HH", header, 12)
        # 对标 gotdx client.go 的帧长约束：声明长度必须有上限，压缩报文要限制
        # 解压放大倍数，避免畸形/恶意帧把内存打爆。0x053f 最大 9 榜 × 255 条
        # 也只有约 34 KB，64 KB 足够；文件分块另走 60 KB 上限。
        if zip_length > MAX_FRAME_BYTES or length > MAX_FRAME_BYTES:
            raise TdxError(f"行情报文长度异常：{zip_length}/{length}")
        raw = self._recv_exact(zip_length) if zip_length > 0 else b""
        if zip_length == length:
            return msg_id, msg_type, raw

        if zip_length == 0 or length == 0:
            return msg_id, msg_type, b""
        try:
            decompressor = zlib.decompressobj()
            # max_length=length：解压输出不可能超过声明长度，畸形帧最多占 64KB。
            data = decompressor.decompress(raw, length)
            if len(data) != length or decompressor.unconsumed_tail:
                raise TdxError("行情报文解压长度不符")
            return msg_id, msg_type, data
        except zlib.error as error:
            raise TdxError("行情报文解压失败") from error

    def _transact(
        self, msg_type: int, data: bytes, wire_prefix: int | None = None
    ) -> bytes:
        if self.sock is None:
            raise TdxError("行情服务器未连接")

        self.msg_id = (self.msg_id + 1) & 0xFFFFFFFF
        if self.msg_id == 0:
            self.msg_id = 1

        wire_msg_id = (
            self.msg_id
            if wire_prefix is None
            else ((self.msg_id & 0xFF) | wire_prefix)
        )
        self.sock.sendall(encode_frame(wire_msg_id, msg_type, data))
        while True:
            received_id, received_type, body = self._read_frame()
            self.last_activity = time.monotonic()
            if received_id == wire_msg_id:
                return body
            self.push_frames.append((received_id, received_type, body))

    def request(
        self,
        msg_type: int,
        data: bytes,
        retry: bool = True,
        wire_prefix: int | None = None,
    ) -> bytes:
        # 单请求 deadline：连接 + 心跳 + 响应共用一个预算，避免「连接 5s、
        # 发送 8s、重试再 5s」把一次调用拖到几十秒（eltdx deadline 语义）。
        deadline = time.monotonic() + REQUEST_TIMEOUT
        try:
            if self.sock is None:
                self._connect(deadline)
            if time.monotonic() - self.last_activity >= HEARTBEAT_INTERVAL:
                # 空闲长连接保活；不匹配的推送帧会在 _transact 里入队。
                self._transact(CMD_HEARTBEAT, b"")
            return self._transact(msg_type, data, wire_prefix)
        except (OSError, TdxError) as error:
            self.close()
            if not retry:
                raise
            # 断线重连一次；行情请求都是只读的，重试不会产生副作用
            self._connect(time.monotonic() + REQUEST_TIMEOUT)
            return self._transact(msg_type, data, wire_prefix)
