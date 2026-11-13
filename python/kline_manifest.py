"""K 线缓存 manifest：给每个 Parquet 缓存补 rows/SHA256/周期元数据。"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from parquet_store import file_sha256

# A 股按北京时间归档；CI runner 多为 UTC，fetchedAt 不能写本地时区。
SHANGHAI = timezone(timedelta(hours=8))


def manifest_path(data_path: Path) -> Path:
    return data_path.with_name(f"{data_path.name}.manifest.json")


def _duckdb():
    try:
        import duckdb
    except ImportError as error:  # pragma: no cover
        raise ValueError("未安装 duckdb") from error
    return duckdb


def row_count(data_path: Path) -> int:
    duckdb = _duckdb()
    connection = duckdb.connect(":memory:")
    try:
        row = connection.execute(
            f"SELECT count(*) FROM read_parquet('{str(data_path.resolve()).replace(chr(39), chr(39) * 2)}')"
        ).fetchone()
    finally:
        connection.close()
    return int(row[0]) if row else 0


def date_range(data_path: Path) -> tuple[str | None, str | None]:
    duckdb = _duckdb()
    connection = duckdb.connect(":memory:")
    try:
        row = connection.execute(
            f"SELECT min(date), max(date) FROM read_parquet('{str(data_path.resolve()).replace(chr(39), chr(39) * 2)}')"
        ).fetchone()
    finally:
        connection.close()
    if not row:
        return None, None
    return (str(row[0]) if row[0] is not None else None, str(row[1]) if row[1] is not None else None)


def write_kline_manifest(data_path: Path, metadata: dict | None = None) -> dict:
    meta = dict(metadata or {})
    rows = row_count(data_path)
    first_date, last_date = date_range(data_path)
    meta.setdefault("firstDate", first_date)
    meta.setdefault("lastDate", last_date)
    payload = {
        "schema": "pythontdx.kline_cache.v1",
        "file": data_path.name,
        "rows": rows,
        "bytes": data_path.stat().st_size,
        "sha256": file_sha256(data_path),
        "fetchedAt": meta.get("fetchedAt")
        or datetime.now(SHANGHAI).isoformat(timespec="seconds"),
        **meta,
    }
    target = manifest_path(data_path)
    temporary = target.with_name(
        f".{target.name}.{os.getpid()}.{threading.get_ident()}.part"
    )
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, target)
    return payload


def backfill_kline_manifests(root: Path) -> dict:
    created = 0
    skipped = 0
    failed = 0
    for data_path in sorted(Path(root).glob("*.parquet")):
        if manifest_path(data_path).is_file():
            try:
                existing = json.loads(manifest_path(data_path).read_text("utf-8"))
                if (
                    existing.get("firstDate")
                    and existing.get("lastDate")
                    and existing.get("code")
                    and existing.get("period")
                ):
                    skipped += 1
                    continue
                parts = data_path.stem.split("_")
                inferred = {}
                if len(parts) >= 4:
                    inferred = {
                        "code": parts[0],
                        "period": parts[1],
                        "adjust": parts[3],
                    }
                    if parts[2] != "all":
                        inferred["count"] = int(parts[2])
                    else:
                        inferred["fullHistory"] = True
                write_kline_manifest(
                    data_path,
                    {
                        **inferred,
                        "source": existing.get("source") or "legacy-backfill",
                        "fetchedAt": existing.get("fetchedAt"),
                    },
                )
                created += 1
            except Exception:  # noqa: BLE001
                skipped += 1
            continue
        try:
            write_kline_manifest(data_path, {"source": "legacy-backfill"})
            created += 1
        except Exception:  # noqa: BLE001
            failed += 1
    return {"created": created, "skipped": skipped, "failed": failed}


def verify_kline_manifests(root: Path, limit: int = 500) -> dict:
    checked = 0
    failed = 0
    details: list[dict] = []
    for manifest in sorted(Path(root).glob("*.parquet.manifest.json"))[:limit]:
        checked += 1
        try:
            payload = json.loads(manifest.read_text("utf-8"))
            data_path = manifest.parent / str(payload.get("file") or "")
            if not data_path.is_file():
                raise ValueError("数据文件缺失")
            if file_sha256(data_path) != payload.get("sha256"):
                raise ValueError("SHA256 不匹配")
            if int(payload.get("rows", -1)) < 0:
                raise ValueError("rows 非法")
        except Exception as error:  # noqa: BLE001
            failed += 1
            details.append({"manifest": str(manifest), "error": str(error)})
    return {"checked": checked, "failed": failed, "details": details[:5]}
