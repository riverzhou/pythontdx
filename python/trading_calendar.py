"""A 股交易日历：使用通达信自己的节假日文件 + 服务端交易日。

数据来源：

1. **TDX 官方节假日文件**：`Except<year>.zip` 里的
   `neednote_RecentHSHoliday.txt`（`RecentHSHoliday=20260101,...`）。
   仓库内置 2025/2026 快照 `python/fixtures/tdx_holidays.json`，
   来源与更新方式登记在 `docs/08`。
2. **MAC 0x120F 服务端信息**：`today` 与 `lastTradingDay`。
   `today != lastTradingDay` 表示今天临时休市（官方文件之外的情况）。
3. **用户可选追加**：`<数据目录>/trading_holidays.json`。

没有网络、也没有本地缓存时退回「周一至周五 + 官方节假日文件」。宁可按交易日
处理，也不把真实交易日误判为休市；节假日最多多拉几帧，不会漏掉行情。

服务端状态落盘到 `<数据目录>/cache/trading_calendar.json`，下次启动可离线使用。
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

SCHEMA = "pythontdx.trading_calendar.v1"
SHANGHAI_TZ = timezone(timedelta(hours=8))
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True)
class CalendarState:
    today: str
    last_trading_day: str
    source: str
    fetched_at: float
    error: str = ""


_state: CalendarState | None = None
_path: Path | None = None
_loaded_path: Path | None = None


def _valid_days(values: Iterable[object]) -> set[str]:
    days: set[str] = set()
    for value in values:
        text = str(value or "").strip()[:10]
        if _DATE_RE.fullmatch(text):
            days.add(text)
    return days


def _load_bundled() -> tuple[frozenset[str], str]:
    """读取 TDX 官方节假日快照（开发态 fixtures / 打包后 sidecar 同目录）。"""
    for candidate in (
        Path(__file__).resolve().with_name("tdx_holidays.json"),
        Path(__file__).resolve().parent / "fixtures" / "tdx_holidays.json",
    ):
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        values = payload.get("holidays")
        if isinstance(values, list):
            return frozenset(_valid_days(values)), str(payload.get("updated") or "")
    return frozenset(), ""


_BUNDLED_HOLIDAYS, _BUNDLED_UPDATED = _load_bundled()


def _read(path: Path) -> CalendarState | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("schema") != SCHEMA:
        return None
    today = str(payload.get("today") or "")[:10]
    last = str(payload.get("lastTradingDay") or "")[:10]
    if not _DATE_RE.fullmatch(today) or not _DATE_RE.fullmatch(last):
        return None
    return CalendarState(
        today=today,
        last_trading_day=last,
        source=str(payload.get("source") or "cache"),
        fetched_at=float(payload.get("fetchedAt") or 0.0),
        error=str(payload.get("error") or ""),
    )


def _write(state: CalendarState, path: Path) -> None:
    payload = {
        "schema": SCHEMA,
        "today": state.today,
        "lastTradingDay": state.last_trading_day,
        "source": state.source,
        "fetchedAt": state.fetched_at,
        "error": state.error,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def configure(path: str | Path | None) -> None:
    """绑定本地服务端状态缓存；重复 configure 同一路径不会重复读盘。"""
    global _state, _path, _loaded_path
    target = Path(path).expanduser() if path else None
    if target == _loaded_path:
        return
    _path = target
    _loaded_path = target
    _state = _read(target) if target is not None else None


def snapshot() -> CalendarState | None:
    return _state


def update(
    today: str,
    last_trading_day: str,
    source: str,
    *,
    path: str | Path | None = None,
    error: str = "",
) -> CalendarState:
    """用一次 TDX 0x120F 查询结果更新服务端状态并落盘。"""
    global _state, _path, _loaded_path
    today = str(today or "").strip()[:10]
    last = str(last_trading_day or "").strip()[:10]
    if not _DATE_RE.fullmatch(today) or not _DATE_RE.fullmatch(last):
        raise ValueError("交易日历日期不合法")
    state = CalendarState(
        today=today,
        last_trading_day=last,
        source=source,
        fetched_at=datetime.now(tz=SHANGHAI_TZ).timestamp(),
        error=error,
    )
    target = Path(path) if path is not None else _path
    if target is not None:
        _path = target
        _loaded_path = target
        _write(state, target)
    _state = state
    return state


def record_error(message: str) -> CalendarState | None:
    """刷新失败只记录，不破坏上一份可用状态。"""
    global _state
    if _state is None:
        return None
    _state = CalendarState(
        today=_state.today,
        last_trading_day=_state.last_trading_day,
        source=_state.source,
        fetched_at=_state.fetched_at,
        error=str(message),
    )
    return _state


def _parse_day(value: str | date) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


def is_trading_day(day: date | str, extra_holidays: Iterable[object] = ()) -> bool:
    """判断某天是否交易日。

    官方节假日文件 + 用户追加休市日优先；再用 TDX 服务端的
    `today` / `lastTradingDay` 识别文件之外的临时休市：

    - 今天是最近交易日 → 今天开盘；
    - 今天晚于最近交易日 → 今天休市；
    - 最近交易日与今天之间的工作日 → 休市（长休市中没有日线记录的日子）。
    """
    moment = _parse_day(day)
    iso = moment.isoformat()
    if moment.weekday() >= 5:
        return False
    if iso in _BUNDLED_HOLIDAYS or iso in _valid_days(extra_holidays):
        return False
    state = _state
    if state is None:
        return True
    if iso == state.today:
        return state.today == state.last_trading_day
    if state.last_trading_day < iso < state.today:
        return False
    return True


def status(
    now: datetime | None = None, extra_holidays: Iterable[object] = ()
) -> dict:
    """给前端/HTTP 的日历状态；session 由调用方叠加。"""
    moment = now or datetime.now(tz=SHANGHAI_TZ)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=SHANGHAI_TZ)
    else:
        moment = moment.astimezone(SHANGHAI_TZ)
    local_today = moment.date().isoformat()
    state = _state
    calendar_today = state.today if state is not None else local_today
    return {
        "schema": SCHEMA,
        "today": calendar_today,
        "lastTradingDay": state.last_trading_day if state is not None else "",
        "isTradingDay": is_trading_day(calendar_today, extra_holidays),
        "holidays": sorted(_BUNDLED_HOLIDAYS | _valid_days(extra_holidays)),
        "holidaySource": f"TDX Except2025/2026 ({_BUNDLED_UPDATED})"
        if _BUNDLED_HOLIDAYS
        else "none",
        "source": state.source if state is not None else "fallback-weekday",
        "fetchedAt": state.fetched_at if state is not None else 0,
        "stale": state is None or state.today != local_today,
        "error": state.error if state is not None else "",
    }
