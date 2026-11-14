"""0x0547 盘中语义探针：记录不同游标/连续请求的响应差异。

只在交易时段运行；结果写到 PYTHONTDX_DATA_DIR/lake/probes/。
不判断“有没有推送”，只记录可复核的 JSONL 证据。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import select
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

import tdx_bridge as tdx  # noqa: E402


def _stable(value: object) -> object:
    """去掉每次接收都会变化的字段，便于比较游标响应本身。"""
    if isinstance(value, dict):
        return {
            key: _stable(item)
            for key, item in value.items()
            if key not in {"time", "receivedAt"}
        }
    if isinstance(value, list):
        return [_stable(item) for item in value]
    return value


def digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            _stable(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", default="sh600519")
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--silent-seconds", type=float, default=5.0)
    args = parser.parse_args()
    code = args.code
    bridge = tdx.Bridge()
    bridge.index.ensure(bridge.conn)
    item = tdx.parse_code(code)

    def request(cursor: int) -> tuple[list[dict], float, int | None]:
        """直接走 0x0547，返回解析结果、接收时刻和记录内 update 游标。"""
        received = time.time()
        body = bridge.conn.request(
            tdx.CMD_REFRESH,
            tdx.refresh_data([item], {code: cursor}),
        )
        decoded = bytes(byte ^ 0x93 for byte in body)
        count = int.from_bytes(decoded[0:2], "little")
        update_time = None
        if count > 0:
            record = decoded[2:]
            _, position = tdx._read_k_prices(record, 9)
            update_time = tdx._u32(record, position)
        result = tdx.parse_refresh(
            body,
            [item],
            int(received * 1000),
            bridge.index.by_code,
        )
        return result, received, update_time

    target = tdx.pythontdx_data_dir() / "lake" / "probes"
    target.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    path = target / f"0x0547-{stamp}.jsonl"
    started = time.time()
    records = 0
    try:
        with path.open("w", encoding="utf-8") as stream:
            last_update: int | None = None
            for mode in ("zero", "one", "max", "timestamp"):
                for round_index in range(3):
                    cursor = (
                        0
                        if mode == "zero"
                        else (
                            last_update
                            if mode == "one" and last_update is not None
                            else 1
                            if mode == "one"
                            else 0xFFFFFFFF
                            if mode == "max"
                            else int(time.time() * 1000) & 0xFFFFFFFF
                        )
                    )
                    received = time.time()
                    try:
                        result, received, update_time = request(cursor)
                        if update_time is not None:
                            last_update = update_time
                        record = {
                            "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                            "elapsed": round(received - started, 3),
                            "mode": mode,
                            "cursor": cursor,
                            "round": round_index,
                            "count": len(result),
                            "hash": digest(result),
                            "updateTime": update_time,
                            "sample": result[0] if result else None,
                        }
                    except Exception as error:  # noqa: BLE001
                        record = {
                            "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                            "mode": mode,
                            "cursor": cursor,
                            "round": round_index,
                            "error": str(error),
                        }
                    stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                    stream.flush()
                    records += 1
                    time.sleep(0.25)
            # 一次请求后静默观察，检查服务器是否主动下发未请求的帧。
            silent_started = time.time()
            silent_cursor = last_update or 0
            try:
                result, received, update_time = request(silent_cursor)
                sock = bridge.conn.sock
                chunks: list[bytes] = []
                if sock is not None:
                    deadline = time.time() + max(0.0, args.silent_seconds)
                    while True:
                        remaining = deadline - time.time()
                        if remaining <= 0:
                            break
                        ready, _, _ = select.select([sock], [], [], remaining)
                        if not ready:
                            break
                        chunk = sock.recv(65536)
                        if not chunk:
                            break
                        chunks.append(chunk)
                payload = b"".join(chunks)
                queued = list(getattr(bridge.conn, "push_frames", ()))
                record = {
                    "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "elapsed": round(received - started, 3),
                    "mode": "silent",
                    "cursor": silent_cursor,
                    "silentSeconds": args.silent_seconds,
                    "count": len(result),
                    "hash": digest(result),
                    "updateTime": update_time,
                    "sample": result[0] if result else None,
                    "unsolicitedBytes": len(payload),
                    "unsolicitedHex": payload[:512].hex(),
                    "queuedPushFrames": len(queued),
                }
            except Exception as error:  # noqa: BLE001
                record = {
                    "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "mode": "silent",
                    "cursor": silent_cursor,
                    "silentSeconds": args.silent_seconds,
                    "error": str(error),
                }
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            stream.flush()
            records += 1
            while time.time() - started < args.seconds:
                received = time.time()
                cursor = last_update or 0
                try:
                    result, received, update_time = request(cursor)
                    if update_time is not None:
                        last_update = update_time
                    record = {
                        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                        "elapsed": round(received - started, 3),
                        "mode": "loop-incremental",
                        "cursor": cursor,
                        "count": len(result),
                        "hash": digest(result),
                        "updateTime": update_time,
                        "sample": result[0] if result else None,
                    }
                except Exception as error:  # noqa: BLE001
                    record = {
                        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
                        "mode": "loop-incremental",
                        "cursor": cursor,
                        "error": str(error),
                    }
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                stream.flush()
                records += 1
                time.sleep(max(0.2, args.interval))
    finally:
        bridge.close()
    print(json.dumps({"path": str(path), "records": records}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
