"""协议常量、主站配置与交易时段规则：命令号、批量上限、缓存 TTL、
connect.cfg 解析、主站选择、交易日历换算、报价/快照/K 线的合并规则。"""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import time
import trading_calendar

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .base import (
    pythontdx_data_dir,
)


# ---------------------------------------------------------------- 常量

def limit_percent(code: str, name: str) -> int:
    """A 股涨跌幅限制：主板 10%、创业/科创 20%、北交 30%、主板 ST 5%。"""
    symbol = code[2:] if len(code) > 2 else code
    if code.lower().startswith("bj") or (symbol and symbol[0] in "489"):
        return 30
    if symbol.startswith(("300", "301", "302", "688", "689")):
        return 20
    if "ST" in name.upper():
        return 5
    return 10


# 通达信 Windows 客户端当前公开行情主站列表（2026-10 核对，rustdx/pytdx 同源）。
SERVER_HOSTS = [
    ("115.238.56.198", 7709),
    ("114.80.149.19", 7709),
    ("114.80.149.22", 7709),
    ("39.100.68.59", 7709),
    ("115.238.90.165", 7709),
    ("117.184.140.156", 7709),
    ("119.147.164.60", 7709),
    ("123.125.108.23", 7709),
    ("123.125.108.24", 7709),
    ("180.153.18.170", 7709),
    ("180.153.18.171", 7709),
    ("180.153.39.51", 7709),
    ("218.108.47.69", 7709),
    ("218.108.98.244", 7709),
    ("218.75.126.9", 7709),
    ("221.194.181.176", 7709),
    ("60.12.136.250", 7709),
    ("60.191.117.167", 7709),
    ("61.152.249.56", 7709),
    # 原 pythontdx 主站与资金流节点中仍可用的地址，保留作最新列表的补充。
    ("124.71.187.122", 7709),
    ("116.205.183.150", 7709),
    ("111.230.186.52", 7709),
    ("119.97.185.59", 7709),
    ("58.34.106.207", 7709),
    ("116.128.207.164", 7709),
    ("120.253.221.207", 7709),
    ("202.108.254.67", 7709),
]


ENDPOINTS = SERVER_HOSTS


# Windows 客户端安装/解包目录里的 connect.cfg 优先；以下路径按常见安装方式探测。
# 兼容 Linux 下用 Wine 解包 Windows 客户端的场景。
CONNECT_CFG_CANDIDATES = [
    Path.home() / ".local/share/tdxcfv/drive_c/tc/connect.cfg",
    Path.home() / ".wine/drive_c/tc/connect.cfg",
    Path.home() / ".local/share/tdxcfv/drive_c/new_tdx/connect.cfg",
    Path.home() / ".wine/drive_c/new_tdx/connect.cfg",
    Path("/mnt/c/new_tdx/connect.cfg"),
    Path("C:/new_tdx/connect.cfg"),
    Path("C:/tdx/connect.cfg"),
    # 工程内置快照：Nuitka onefile 的临时解包目录 / resources/tdx-bridge/connect.cfg。
    Path(__file__).resolve().parent / "connect.cfg",
    Path(sys.executable).resolve().parent / "connect.cfg",
]


def _connect_cfg_candidates() -> list[Path]:
    configured = os.environ.get("PYTHONTDX_CONNECT_CFG")
    candidates: list[Path] = [Path(configured).expanduser()] if configured else []
    candidates.extend(CONNECT_CFG_CANDIDATES)
    for pattern in (
        "~/.local/share/tdxcfv/drive_c/*/connect.cfg",
        "~/.wine/drive_c/*/connect.cfg",
    ):
        candidates.extend(Path(pattern).expanduser().parent.glob(Path(pattern).name))
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in candidates:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def parse_connect_cfg(path: Path) -> list[tuple[str, int]]:
    """解析通达信 connect.cfg 的 [HQHOST]；名称是 GBK/GB18030，失败不影响 IP。"""
    try:
        source = path.read_bytes().decode("gb18030", "replace")
    except OSError:
        return []
    section = ""
    primary = 0
    entries: dict[int, dict[str, str]] = {}
    for line in source.splitlines():
        text = line.strip()
        if not text or text.startswith(";") or text.startswith("#"):
            continue
        if text.startswith("[") and text.endswith("]"):
            section = text[1:-1].strip().upper()
            continue
        if section != "HQHOST" or "=" not in text:
            continue
        key, value = (part.strip() for part in text.split("=", 1))
        if key.upper() == "PRIMARYHOST":
            try:
                primary = int(value)
            except ValueError:
                primary = 0
            continue
        match = re.match(r"(IPAddress|Port|HostName)(\d+)$", key, re.IGNORECASE)
        if not match:
            continue
        kind, raw_index = match.groups()
        index = int(raw_index)
        entries.setdefault(index, {})[kind.lower()] = value
    hosts: list[tuple[str, int]] = []
    for index in sorted(entries):
        item = entries[index]
        host = item.get("ipaddress", "").strip()
        if not re.fullmatch(r"[0-9A-Za-z._:-]+", host):
            continue
        try:
            port = int(item.get("port", "7709"))
        except ValueError:
            port = 7709
        if 0 < port <= 65535:
            hosts.append((host, port))
    if hosts and 0 < primary <= len(hosts):
        hosts = hosts[primary - 1 :] + hosts[: primary - 1]
    return hosts


def active_endpoints() -> tuple[list[tuple[str, int]], str]:
    """优先返回客户端 connect.cfg 的主站；找不到才用公开回退列表。"""
    for path in _connect_cfg_candidates():
        if not path.is_file():
            continue
        hosts = parse_connect_cfg(path)
        if hosts:
            return hosts, str(path)
    return list(SERVER_HOSTS), "builtin-public-list"


def _server_config_path() -> Path:
    return pythontdx_data_dir() / "server.json"


def _preferred_host() -> str | None:
    try:
        payload = json.loads(_server_config_path().read_text("utf-8"))
    except (OSError, ValueError):
        return None
    host = str(payload.get("preferredHost") or "").strip()
    hosts, _source = active_endpoints()
    return host if any(item[0] == host for item in hosts) else None


def _ordered_endpoints(preferred: str | None = None) -> list[tuple[str, int]]:
    hosts, _source = active_endpoints()
    selected = preferred or _preferred_host()
    if not selected:
        return hosts
    found = [item for item in hosts if item[0] == selected]
    return found + [item for item in hosts if item[0] != selected]


def speed_test_hosts(timeout: float = 0.9) -> dict:
    """并发测试行情主站 TCP 建连时延；只做只读连接，不发隐私数据。"""
    hosts, source = active_endpoints()
    preferred = _preferred_host()
    if preferred is None and hosts:
        # 没有保存选择时，Bridge 实际会按列表第一台（PrimaryHost）建连。
        preferred = hosts[0][0]

    def probe(host: str, port: int) -> dict:
        started = time.perf_counter()
        status = "ok"
        error = ""
        try:
            with socket.create_connection((host, port), timeout=timeout):
                pass
        except Exception as cause:  # noqa: BLE001 - 测速失败要逐站展示
            status = "error"
            error = str(cause)
        return {
            "host": host,
            "port": port,
            "latencyMs": round((time.perf_counter() - started) * 1000, 1),
            "status": status,
            "error": error,
            "preferred": host == preferred,
        }

    with ThreadPoolExecutor(max_workers=max(1, len(hosts))) as pool:
        results = list(pool.map(lambda item: probe(*item), hosts))
    results.sort(key=lambda item: (item["status"] != "ok", item["latencyMs"]))
    return {"hosts": results, "preferred": preferred, "source": source}


# 0x0ffc 在普通行情节点上可能只返回日期、金额全 0；这些节点实测有完整分档。
MONEY_FLOW_HOSTS = [
    ("180.153.18.170", 7709),
    ("58.34.106.207", 7709),
    ("116.128.207.164", 7709),
    ("120.253.221.207", 7709),
    ("202.108.254.67", 7709),
    ("60.191.117.167", 7709),
    ("115.238.56.198", 7709),
    ("218.75.126.9", 7709),
]


CONNECT_TIMEOUT = 5.0


REQUEST_TIMEOUT = 8.0


HEARTBEAT_INTERVAL = 30.0


# 单帧声明长度与解压放大上限（对齐 gotdx client.go 的约束，避免畸形帧打爆内存）
MAX_FRAME_BYTES = 65535


MAX_FRAME_RATIO = 8


QUOTE_BASELINE_INTERVAL = 60.0


QUOTE_BATCH = 80


FINANCE_BATCH = 80


CAPITAL_BATCH = 75


CODE_PAGE = 1600


FINANCE_TTL = 6 * 60 * 60


CMD_HANDSHAKE = 0x000D


CMD_HEARTBEAT = 0x0004


CMD_QUOTES = 0x053E


CMD_SNAPSHOT = 0x054C


CMD_REFRESH = 0x0547


CMD_CATEGORY = 0x054B


CMD_TODAY_TICKS = 0x0FC5


CMD_HISTORY_TICKS = 0x0FC6


CMD_AUCTION = 0x056A


CMD_FILE_CONTENT = 0x06B9


CMD_MONEY_FLOW = 0x0FFC


CMD_F10_CATEGORY = 0x02CF


CMD_F10_CONTENT = 0x02D0


CMD_BLOCK_META = 0x02C5


CMD_BARS = 0x052D


CMD_MINUTE = 0x0537


CMD_HISTORY_MINUTE = 0x0FB4


CMD_MINUTE_AUX = 0x051B


CMD_SPARKLINE = 0x0FD1


CMD_RECENT_MINUTE = 0x0FEB


CMD_SECURITY_COUNT = 0x044E


CMD_SECURITY_LIST = 0x044D


CMD_FINANCE = 0x0010


CMD_CAPITAL_CHANGES = 0x000F


CMD_SPECIAL_LIMITS = 0x0452


CMD_DELISTED_BARS = 0x052B


# gotdx 源码里 7709 原生、我们此前只走 MAC 的三条查询（docs/16 L2/L3/M5）
CMD_UNUSUAL = 0x0563


CMD_TOP_BOARD = 0x053F


CMD_VOLUME_PROFILE = 0x051A


# 0x054c / 0x053e 共用的请求前缀；0x0547 是另一套「代码 + 游标」布局
QUOTE_LIST_PREFIX = b"\x05\x00\x00\x00\x00\x00\x00\x00"


REFRESH_BATCH = 100


# 交易所时区固定 +08:00（与 src/shared/market.ts 一致，不跟随运行机器的时区）
SHANGHAI_TZ = timezone(timedelta(hours=8))


# 09:30:00–09:30:10 也走快照：开盘第一秒 0x0547 可能还没有可用的增量记录
OPENING_GRACE_UNTIL = "09:30:10"


# 竞价 0x056a 兜底：自选 <=80 只时全取，超过只补缺失/价格为 0 的
AUCTION_FALLBACK_LIMIT = 80


def shanghai_clock(now: datetime | None = None) -> tuple[str, str]:
    """返回 (北京时间 HH:MM:SS, 交易时段)，时段划分与前端 shanghaiClock 一致。

    只判断工作日/盘中时段，不含法定节假日；工作日的节假日仍会显示交易时段
    （与前端 shanghaiClock 一致，属于已知边界）。
    """
    moment = datetime.now(SHANGHAI_TZ) if now is None else now
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=SHANGHAI_TZ)
    else:
        moment = moment.astimezone(SHANGHAI_TZ)
    hm = moment.hour * 60 + moment.minute
    if moment.weekday() >= 5:
        session = "weekend"
    elif not trading_calendar.is_trading_day(moment.date()):
        session = "holiday"
    elif 9 * 60 + 15 <= hm < 9 * 60 + 30:
        session = "pre-open"
    elif 9 * 60 + 30 <= hm < 11 * 60 + 30:
        session = "trading"
    elif 11 * 60 + 30 <= hm < 13 * 60:
        session = "lunch-break"
    elif 13 * 60 <= hm <= 15 * 60:
        session = "trading"
    else:
        session = "closed"
    return moment.strftime("%H:%M:%S"), session


# 与前端 src/shared/market.ts 的 SESSION_BOUNDARIES 保持一致。
SESSION_BOUNDARIES = ((9, 15), (9, 30), (11, 30), (13, 0), (15, 0))


def ms_until_session_change(now: datetime | None = None) -> float:
    """距离下一次交易时段切换还有多少毫秒。

    使用通达信交易日历跳过周末与节假日；未来日期若尚未从 TDX 拿到状态，
    仍按工作日边界唤醒一次，等下一次 market_status 刷新后再修正。

    订阅线程在午休/收盘会降到 30 秒以上；若低频等待恰好跨过 13:00 或
    09:30，开盘第一帧会被拖后。轮询等待用这个值封顶，在边界后 250ms 内
    恢复。与前端 `msUntilSessionChange` 使用同一套边界。
    """
    moment = datetime.now(SHANGHAI_TZ) if now is None else now
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=SHANGHAI_TZ)
    else:
        moment = moment.astimezone(SHANGHAI_TZ)
    best = float("inf")
    for offset in range(40):
        day = (moment + timedelta(days=offset)).date()
        if not trading_calendar.is_trading_day(day):
            continue
        for hour, minute in SESSION_BOUNDARIES:
            at = datetime(
                day.year, day.month, day.day, hour, minute, tzinfo=SHANGHAI_TZ
            )
            delta = (at - moment).total_seconds() * 1000
            # 0~500ms 的临近边界不能跳过：低频轮询可能正好在 12:59:59.6
            # 醒来，跳过它会让 13:00 的第一帧再等一个完整周期。
            if 0 <= delta < best:
                best = delta
    return best if best != float("inf") else 24 * 60 * 60 * 1000


def _normalize_codes(codes: list[str]) -> list[str]:
    return [
        code
        for code in dict.fromkeys(str(raw).strip().lower() for raw in codes or [])
        if code
    ]


def _merge_quotes(base: list[dict], incoming: list[dict]) -> list[dict]:
    """后者整条覆盖前者（竞价/开盘首秒以 0x054c 快照为准）。"""
    by_code = {quote.get("code"): quote for quote in base if quote.get("code")}
    for quote in incoming:
        if quote.get("code"):
            by_code[quote["code"]] = quote
    return list(by_code.values())


def _merge_auction_quotes(base: list[dict], auctions: list[dict]) -> list[dict]:
    """竞价兜底：0x056a 虚拟撮合价覆盖价格，尽量保留快照里的昨收/五档。"""
    by_code = {quote.get("code"): quote for quote in base if quote.get("code")}
    for auction in auctions:
        code = auction.get("code")
        existing = by_code.get(code)
        if existing is None:
            by_code[code] = auction
            continue
        prev_close = float(auction.get("prevClose") or 0) or float(existing.get("prevClose") or 0)
        price = float(auction.get("price") or 0) or float(existing.get("price") or 0)
        change = price - prev_close if prev_close > 0 else float(existing.get("change") or 0)
        existing_high = float(existing.get("high") or 0) or price
        existing_low = float(existing.get("low") or 0) or price
        auction_high = float(auction.get("high") or 0) or price
        auction_low = float(auction.get("low") or 0) or price
        high = max(existing_high, auction_high)
        low = min(existing_low, auction_low)
        by_code[code] = {
            **existing,
            **auction,
            "price": price,
            "prevClose": prev_close,
            "open": float(existing.get("open") or 0) or float(auction.get("open") or 0),
            "high": high,
            "low": low,
            "change": change,
            "changePct": (change / prev_close * 100)
            if prev_close > 0
            else existing.get("changePct"),
            "volume": existing.get("volume")
            if float(existing.get("volume") or 0) > 0
            else auction.get("volume"),
            "amount": existing.get("amount")
            if float(existing.get("amount") or 0) > 0
            else auction.get("amount"),
            "bids": existing.get("bids") or auction.get("bids") or [],
            "asks": existing.get("asks") or auction.get("asks") or [],
            "auction": True,
            "auctionTime": auction.get("auctionTime"),
        }
    return list(by_code.values())


def _merge_snapshot_prices(snapshots: list[dict], refreshed: list[dict]) -> list[dict]:
    """盘中：0x054c 快照负责价格新鲜度，0x0547 保留五档深度与其它字段。

    实测免费主站的 0x0547 增量约 3 秒才推一次新价，0x054c 约 1 秒；
    用快照覆盖价格/量/额，并删除快照没有的 updateTime，让界面显示接收时间。
    """
    if not snapshots:
        return list(refreshed)
    if not refreshed:
        return list(snapshots)
    by_code = {quote.get("code"): quote for quote in refreshed if quote.get("code")}
    for snapshot in snapshots:
        code = snapshot.get("code")
        base = by_code.get(code)
        if base is None:
            by_code[code] = snapshot
            continue
        prev_close = float(snapshot.get("prevClose") or 0) or float(base.get("prevClose") or 0)
        price = float(snapshot.get("price") or 0) or float(base.get("price") or 0)
        change = price - prev_close if prev_close > 0 else float(base.get("change") or 0)
        base_low = float(base.get("low") or 0)
        high = max(
            float(snapshot.get("high") or 0) or price,
            float(base.get("high") or 0),
        )
        low = min(
            float(snapshot.get("low") or 0) or price,
            base_low if base_low > 0 else price,
        )
        volume = max(float(snapshot.get("volume") or 0), float(base.get("volume") or 0))
        amount = max(float(snapshot.get("amount") or 0), float(base.get("amount") or 0))
        merged = {
            **base,
            "price": price,
            "prevClose": prev_close,
            "open": float(snapshot.get("open") or 0) or float(base.get("open") or 0),
            "high": high,
            "low": low,
            "change": change,
            "changePct": (change / prev_close * 100)
            if prev_close > 0
            else base.get("changePct"),
            "volume": volume,
            "amount": amount,
            "avgPrice": (amount / (volume * 100))
            if volume > 0 and amount > 0
            else base.get("avgPrice"),
            "amplitude": ((high - low) / prev_close * 100)
            if prev_close > 0
            else base.get("amplitude"),
            "time": snapshot.get("time"),
            "receivedAt": snapshot.get("receivedAt"),
        }
        # 快照没有交易所 updateTime。必须把旧字段删掉而不是置 None：
        # JSON null 到 TS 侧仍是 null，`!== undefined` 的判断会把它当成
        # 有效时间显示成「—」；旧实现用 undefined 表示「没有」。
        merged.pop("updateTime", None)
        by_code[code] = merged
    return list(by_code.values())
