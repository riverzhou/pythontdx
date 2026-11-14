#!/usr/bin/env python3
"""把 0x0547 探针 JSONL 汇总成可复核的结论。

只分析 scripts/probe_0547.py 生成的证据，不重新请求行情：
  · 游标 zero/one/max/timestamp 的记录数和稳定哈希是否一致；
  · 一次请求后静默观察是否收到未请求数据；
  · 输出 JSON 报告，供 09:40 复盘和 PLAN/CHANGELOG 回写。
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def data_root() -> Path:
    import os

    configured = os.environ.get("PYTHONTDX_DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".local" / "share" / "pythontdx" / "data"


def latest_probe(directory: Path) -> Path:
    files = sorted(directory.glob("0x0547-*.jsonl"), key=lambda item: item.stat().st_mtime)
    if not files:
        raise FileNotFoundError(f"没有找到 0x0547 探针日志：{directory}")
    return files[-1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", default="")
    parser.add_argument("--out", default="")
    args = parser.parse_args()
    directory = data_root() / "lake" / "probes"
    path = Path(args.path) if args.path else latest_probe(directory)
    records: list[dict] = []
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                records.append(item)

    by_mode: dict[str, list[dict]] = defaultdict(list)
    errors: list[dict] = []
    for record in records:
        by_mode[str(record.get("mode") or "unknown")].append(record)
        if record.get("error"):
            errors.append(record)

    cursor_modes = ["zero", "one", "max", "timestamp"]
    summary: dict[str, dict] = {}
    for mode in cursor_modes + ["silent", "loop-incremental", "loop-zero"]:
        rows = by_mode.get(mode, [])
        valid = [row for row in rows if not row.get("error")]
        summary[mode] = {
            "records": len(rows),
            "valid": len(valid),
            "counts": sorted({int(row.get("count", -1)) for row in valid}),
            "hashes": sorted({str(row.get("hash", "")) for row in valid}),
        }

    silent = by_mode.get("silent", [])
    unsolicited_bytes = sum(int(row.get("unsolicitedBytes") or 0) for row in silent)
    cursor_hashes = {
        mode: summary[mode]["hashes"][0]
        for mode in cursor_modes
        if summary[mode]["hashes"]
    }
    cursor_counts = {
        mode: summary[mode]["counts"][0]
        for mode in cursor_modes
        if summary[mode]["counts"]
    }
    zero_valid = summary["zero"]["valid"] > 0
    one_valid = summary["one"]["valid"] > 0

    if errors:
        verdict = "INCONCLUSIVE_ERRORS"
        reason = f"{len(errors)} 条请求失败"
    elif unsolicited_bytes > 0 or any(
        row.get("unsolicitedBytes", 0) > 0 for row in silent
    ):
        verdict = "UNSOLICITED_DATA"
        reason = f"静默期收到 {unsolicited_bytes} 字节未请求数据"
    elif not zero_valid or not one_valid:
        verdict = "INCOMPLETE"
        reason = "缺少 zero 或 update 游标有效响应"
    elif (
        1 in summary["zero"]["counts"]
        and 0 in summary["one"]["counts"]
    ):
        verdict = "INCREMENTAL_CURSOR_CONFIRMED"
        reason = (
            "cursor=0 返回当前记录；用返回的 updateTime 作游标再请求返回 0 条，"
            "证明服务端按游标过滤，客户端必须缓存上一帧并推进 cursor"
        )
    elif all(count == 1 for count in cursor_counts.values()):
        verdict = "SNAPSHOT_CANDIDATE"
        reason = (
            "zero/update/max/timestamp 均返回 1 条，未观察到游标过滤；"
            "静默期无额外数据"
        )
    elif len(set(cursor_hashes.values())) == 1:
        verdict = "SNAPSHOT_CANDIDATE"
        reason = "各游标返回相同条数和稳定哈希，静默期无额外数据"
    else:
        verdict = "CURSOR_HASH_DIFF"
        reason = "条数/哈希差异无法由单一规则解释，需结合原始报文复核"

    report = {
        "probe": str(path),
        "analyzedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "records": len(records),
        "verdict": verdict,
        "reason": reason,
        "unsolicitedBytes": unsolicited_bytes,
        "summary": summary,
        "errors": errors[:10],
        "boundary": "探针只记录请求/响应；“服务端主动推送”只在 silent 记录中出现才算证据。",
    }
    output = Path(args.out) if args.out else directory / (
        f"0x0547-analysis-{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')}.json"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(output), **report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
