"""7615 TQLEX 在线 F10（公告）。

和 7709 的 0x02cf/0x02d0 文本 F10 是两条独立通路；这里只调用免费 HTTP 网关，
不碰付费研报/交易数据。
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

TQLEX_URL = "http://static.tdx.com.cn:7615/TQLEX"
# 7615 有三个免费网关：主站、热点主机、page2。不同 Entry 在不同主机上可用性不同，
# 逐个尝试（超时/连接失败才换），比硬编码单主机稳。
TQLEX_HOSTS = (
    "http://static.tdx.com.cn:7615/TQLEX",
    "http://hot.icfqs.com:7615/TQLEX",
    "http://page2.tdx.com.cn:7615/TQLEX",
)

# 7615 是和 7709 一样的直达行情通道，不能交给 HTTP 代理。
#
# 2026-11-02 macOS 实机验收发现：urllib 默认会读取系统代理（这台机器配了
# 局域网 HTTP 代理），代理不转发 7615 时公告/估值/财务/新闻全部 12 秒超时；
# 同一地址 curl 直连 0.2 秒返回。7709 是裸 TCP、本来就不经过代理，所以只有
# F10 这批 HTTP 接口坏掉，症状还很像「服务器慢」。显式传一个空的 ProxyHandler，
# 保证三个平台行为一致，也避免把行情请求悄悄塞进与本项目无关的代理。
_OPENER = build_opener(ProxyHandler({}))
# 7615 正常响应 0.05~0.2 秒；主站故障时会「连上但很慢」（实测 4~5 秒），
# 12 秒超时会把整个 HTTP API 队列拖住。2 秒只留 10 倍余量，失败就换站。
TQLEX_TIMEOUT = 2.0
# 失败网关冷却：主站挂掉后不再每个请求都白等一轮。
TQLEX_COOLDOWN = 60.0
_tqlex_lock = threading.Lock()
_tqlex_cooldown: dict[str, float] = {}
_tqlex_latency: dict[str, float] = {}
_tqlex_last_good: str | None = None


def _tqlex_bases() -> list[str]:
    """按健康度排序网关：冷却中的排最后，其余按最近成功耗时升序。

    主站可能「不超时但很慢」（实测 4~5 秒），只记 last_good 会永远优先选它；
    按延迟排序能让 page2 这类 0.05 秒的网关自然顶上来。
    """
    with _tqlex_lock:
        now = time.monotonic()
        bases = [TQLEX_URL] + [host for host in TQLEX_HOSTS if host != TQLEX_URL]
        healthy = [base for base in bases if _tqlex_cooldown.get(base, 0.0) <= now]
        cooling = [base for base in bases if _tqlex_cooldown.get(base, 0.0) > now]
        healthy.sort(key=lambda base: _tqlex_latency.get(base, 1.0))
        return healthy + cooling


def _mark_tqlex(base: str, ok: bool, seconds: float = 0.0) -> None:
    """记录网关状态；失败耗时同样计入排序，冷却后不会排在健康站点前面。"""
    global _tqlex_last_good
    with _tqlex_lock:
        _tqlex_latency[base] = seconds
        if ok:
            _tqlex_last_good = base
            _tqlex_cooldown.pop(base, None)
        else:
            _tqlex_cooldown[base] = time.monotonic() + TQLEX_COOLDOWN
ENTRY = "CWSearch.tzx_rcache"
PROFILE_ENTRY = "CWServ.tdxf10_gg_gsgk"
VALUATION_ENTRY = "HQServ.hq_nlp_gpsj"
FINANCE_ENTRY = "CWServ.tdxf10_gg_cwfx"
BUSINESS_ENTRY = "CWServ.tdxf10_gg_jyfx"
BUSINESS_PERIOD_ENTRY = "CWServ.tdxf10_gg_comreq"
SHAREHOLDER_ENTRY = "CWServ.tdxf10_gg_gdyj"
REPORT_ENTRY = "CWServ.tdxf10_gg_gszx"
STATEMENT_ENTRY = "CWServ.tdxf10_gg_cwfx"

FINANCE_LABELS = {
    "T002": "报告期",
    "mgsy": "每股收益",
    "kfjlr": "扣非净利润",
    "mgxjll": "每股经营现金流",
    "lrze": "利润总额",
    "jyr": "净利润",
    "jzzsyl": "净资产收益率",
    "xsmll": "毛利率",
    "jlrtbzzl": "净利润同比",
    "yysrtb": "营收同比",
    "yyzsrhb": "营收环比",
    "jlrhb": "净利润环比",
    "pjjzcsyl": "平均净资产收益率",
    "kfjlrhb": "扣非净利润环比",
}

STATEMENT_METRICS = {
    "zcfzb": {
        0: [("rq", "报告期"), ("T039", "资产总计"), ("T062", "负债合计"), ("T071", "所有者权益合计"), ("T007", "货币资金"), ("T016", "存货"), ("T010", "应收账款"), ("T040", "短期借款")],
        1: [("rq", "报告期"), ("T048", "资产总计"), ("T083", "负债合计"), ("T093", "所有者权益合计"), ("T010", "现金及存放央行"), ("T028", "发放贷款及垫款"), ("T057", "吸收存款")],
    },
    "lyb": {
        0: [("rq", "报告期"), ("T035", "营业总收入"), ("T064", "营业总成本"), ("T020", "营业利润"), ("T026", "利润总额"), ("T029", "净利润"), ("T030", "归母净利润")],
        1: [("rq", "报告期"), ("T008", "营业收入"), ("T028", "营业支出"), ("T042", "营业利润"), ("T047", "利润总额"), ("T050", "净利润"), ("T051", "归母净利润")],
    },
    "xjllb": {
        0: [("rq", "报告期"), ("T017", "经营活动净额"), ("T029", "投资活动净额"), ("T038", "筹资活动净额"), ("T041", "现金净增加")],
        1: [("rq", "报告期"), ("T033", "经营活动净额"), ("T044", "投资活动净额"), ("T055", "筹资活动净额"), ("T058", "现金净增加")],
    },
}

REPORT_LABELS = {
    "T004": "评级",
    "T009": "分析师",
    "T012": "日期",
    "T039": "标题",
    "T011": "记录ID",
}

SHAREHOLDER_LABELS = {
    "gd": "股东名称",
    "rq": "报告期",
    "cgs": "持股数",
    "bl": "持股比例%",
    "lb": "股东类型",
    "xz": "股本性质",
}

BUSINESS_LABELS = {
    "N000": "分类",
    "N002": "项目",
    "N003": "营业收入",
    "N004": "收入占比%",
    "N005": "营业利润",
    "N006": "利润占比%",
    "N007": "营业成本",
    "N008": "成本占比%",
    "N009": "毛利率%",
}

VALUATION_LABELS = {
    "DATE": "日期",
    "PETTM": "PE(TTM)",
    "PEBFW": "PE 分位",
    "PBMRQ": "PB(MRQ)",
    "PBBFW": "PB 分位",
    "PCFOCFTTM": "PCF(经营现金流 TTM)",
    "PCFBFW": "PCF 分位",
    "PSTTM": "PS(TTM)",
    "PSBFW": "PS 分位",
    "PEG": "PEG",
    "AVGMVM": "平均市值",
    "ALIQMV": "流通市值",
}

PROFILE_LABELS = {
    "T035": "股票类别",
    "T031": "上市日期",
    "T051": "发行方式",
    "fxzd": "发行制度",
    "mgmz": "每股面值",
    "T042": "发行价格",
    "T044": "总发行数量",
    "T056": "实际募资总额",
    "T057": "实际募资净额",
    "T059": "首日开盘价",
    "T060": "首日收盘价",
    "zcxs": "主承销商",
    "bjr": "上市保荐人",
    "T049": "上市板块",
    "ssbk": "上市板块",
}


class F10Error(Exception):
    pass


def _market_of(code: str) -> tuple[int, str]:
    text = code.strip().lower()
    if len(text) != 8 or text[:2] not in {"sh", "sz", "bj"}:
        raise F10Error(f"代码格式不合法：{code}")
    symbol = text[2:]
    if not symbol.isdigit():
        raise F10Error(f"代码格式不合法：{code}")
    market = 1 if text.startswith("sh") else 0 if text.startswith("sz") else 2
    return market, symbol


def parse_announcements_payload(payload: dict) -> list[dict]:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if not result_sets:
        return []
    table = result_sets[0]
    columns = table.get("ColName") or []
    content = table.get("Content") or []
    rows: list[dict] = []
    for values in content:
        row = dict(zip(columns, values))
        rows.append(
            {
                "id": str(row.get("rec_id") or ""),
                "date": str(row.get("issue_date") or "")[:10],
                "title": str(row.get("title") or ""),
                "type": str(row.get("typename") or ""),
                "source": str(row.get("source") or ""),
                "url": str(row.get("url") or ""),
            }
        )
    return rows


def parse_profile_payload(payload: dict) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if not result_sets:
        return {"columns": [], "rows": []}
    table = result_sets[0]
    raw_columns = table.get("ColName") or []
    columns = [PROFILE_LABELS.get(str(name), str(name)) for name in raw_columns]
    rows = [list(values) for values in table.get("Content") or []]
    return {"columns": columns, "rows": rows}


def parse_valuation_payload(payload: dict) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if len(result_sets) < 2:
        return {"columns": [], "rows": []}
    table = result_sets[1]
    raw_columns = table.get("ColName") or [
        str(des.get("Name") or "") for des in (table.get("ColDes") or [])
    ]
    columns = [VALUATION_LABELS.get(str(name), str(name)) for name in raw_columns]
    rows = [list(values) for values in table.get("Content") or []]
    return {"columns": columns, "rows": rows}


def parse_finance_payload(payload: dict) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if not result_sets:
        return {"columns": [], "rows": []}
    table = result_sets[0]
    raw_columns = table.get("ColName") or []
    columns = [FINANCE_LABELS.get(str(name), str(name)) for name in raw_columns]
    rows = [list(values) for values in table.get("Content") or []][:20]
    return {"columns": columns, "rows": rows}


def parse_business_payload(payload: dict) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if not result_sets:
        return {"columns": [], "rows": []}
    table = result_sets[0]
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    indexes = [index for index, name in enumerate(raw_columns) if name in BUSINESS_LABELS]
    columns = [BUSINESS_LABELS[raw_columns[index]] for index in indexes]
    rows = [
        [values[index] for index in indexes]
        for values in (table.get("Content") or [])
    ]
    return {"columns": columns, "rows": rows}


def _tqlex_post(entry: str, data: bytes) -> dict:
    """多网关 POST：按健康度依次尝试，成功/失败都记入网关状态。"""
    last_error: Exception | None = None
    for base in _tqlex_bases():
        request = Request(
            f"{base}?Entry={entry}",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "pythontdx/1.0",
            },
            method="POST",
        )
        started = time.monotonic()
        try:
            with _OPENER.open(request, timeout=TQLEX_TIMEOUT) as response:
                raw = response.read()
        except (HTTPError, URLError, TimeoutError) as error:
            _mark_tqlex(base, False, time.monotonic() - started)
            last_error = error
            continue
        elapsed = time.monotonic() - started
        try:
            parsed = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            _mark_tqlex(base, False, elapsed)
            last_error = error
            continue
        if not isinstance(parsed, dict):
            _mark_tqlex(base, False, elapsed)
            last_error = F10Error("7615 返回结构异常")
            continue
        _mark_tqlex(base, True, elapsed)
        return parsed
    raise F10Error(f"7615 请求失败：{last_error}")


def _post_tqlex(entry: str, body: dict) -> dict:
    payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
    return _tqlex_post(entry, payload)


def _post_tqlex_data(entry: str, data: bytes) -> dict:
    """已编码 JSON 的多主机 POST（供自定义 body 的旧函数复用 failover）。"""
    return _tqlex_post(entry, data)


def parse_shareholder_payload(payload: dict) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if not result_sets:
        return {"columns": [], "rows": []}
    table = result_sets[0]
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    indexes = [index for index, name in enumerate(raw_columns) if name in SHAREHOLDER_LABELS]
    columns = [SHAREHOLDER_LABELS[raw_columns[index]] for index in indexes]
    rows = [
        [values[index] for index in indexes]
        for values in (table.get("Content") or [])
    ][:20]
    return {"columns": columns, "rows": rows}


def parse_report_payload(payload: dict) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if not result_sets:
        return {"columns": [], "rows": []}
    table = result_sets[0]
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    indexes = [index for index, name in enumerate(raw_columns) if name in REPORT_LABELS]
    columns = [REPORT_LABELS[raw_columns[index]] for index in indexes]
    rows = [
        [values[index] for index in indexes]
        for values in (table.get("Content") or [])
    ][:20]
    return {"columns": columns, "rows": rows}


def parse_statement_payload(payload: dict, kind: str, full: bool = False) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if not result_sets:
        return {"columns": [], "rows": []}
    table = result_sets[0]
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    template = 0
    if len(result_sets) > 1:
        meta = result_sets[1]
        meta_columns = [str(name) for name in (meta.get("ColName") or [])]
        if "nhytype" in meta_columns and meta.get("Content"):
            try:
                template = int(meta["Content"][0][meta_columns.index("nhytype")] or 0)
            except (ValueError, IndexError, TypeError):
                template = 0
    metrics = STATEMENT_METRICS.get(kind, {}).get(template)
    if metrics and not full:
        indexes = [(raw_columns.index(key), label) for key, label in metrics if key in raw_columns]
        columns = [label for _, label in indexes]
        rows = [
            [values[index] for index, _ in indexes]
            for values in (table.get("Content") or [])[:4]
        ]
    else:
        columns = raw_columns
        rows = [list(values) for values in (table.get("Content") or [])[:4]]
    return {
        "columns": columns,
        "rows": rows,
        "template": template,
        "kind": kind,
        "full": full,
    }


def fetch_statement(code: str, kind: str = "zcfzb", full: bool = False) -> dict:
    _market, symbol = _market_of(code)
    if kind not in {"zcfzb", "lyb", "xjllb"}:
        raise F10Error(f"未知报表类型：{kind}")
    payload = _post_tqlex(STATEMENT_ENTRY, {"Params": [symbol, kind, ""]})
    return parse_statement_payload(payload, kind, full)


def fetch_reports(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        REPORT_ENTRY,
        {"Params": [symbol, "gsyj", "", "0", "1", "20"]},
    )
    return parse_report_payload(payload)


DIVIDEND_LABELS = {
    "rq": "分红年度",
    "T003": "董事会日期",
    "T004": "分红方案",
    "T006": "每股收益",
    "T026": "加权净资产收益率%",
    "T021": "股权登记日",
    "T023": "除权派息日",
    "T036": "方案进度",
    "glzfl": "股利支付率%",
    "jdcode": "派发对象",
}


CAPITAL_SECTIONS = {
    "structure": ("gbjg", "股本结构"),
    "changes": ("gbbd", "股本变动"),
    "buyback": ("gphg", "股票回购"),
    "restricted": ("xslt", "限售流通"),
}

CAPITAL_LABELS = {
    "structure": {
        "T002": "截止日期",
        "T003": "总股本",
        "T004": "已流通股份",
        "T005": "未流通/待流通",
        "T010": "流通A股",
        "T011": "无限售条件流通股",
        "T019": "流通股份合计",
        "N010": "其它统计口径",
    },
    "changes": {
        "T002": "变动日期",
        "T003": "变动后总股本",
        "T004": "变动前总股本",
        "T006": "变动数量",
        "T007": "变动比例%",
        "T008": "变动原因码",
    },
    "buyback": {
        "N001": "公告日",
        "N002": "进度",
        "N004": "首次公告日",
        "N005": "已回购数量",
        "N006": "已回购占比%",
        "N007": "回购均价",
        "N008": "拟回购金额上限",
        "N009": "回购起始日",
        "N010": "回购截止日",
        "N021": "回购用途",
        "closep": "最新收盘价",
    },
    "restricted": {
        "T003": "解禁日",
        "T004": "解禁市值",
        "T006": "股份来源",
        "T010": "解禁数量",
        "T012": "状态",
        "T014": "解禁数量(万股)",
    },
}


def fetch_capital_structure(code: str, section: str = "structure") -> dict:
    if section not in CAPITAL_SECTIONS:
        raise F10Error(f"不支持的股本分区：{section}")
    raw, _label = CAPITAL_SECTIONS[section]
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_gbjg",
        {"Params": [symbol, raw]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 股本结构返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"section": section, "columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    return {
        "section": section,
        "columns": [CAPITAL_LABELS.get(section, {}).get(name, name) for name in raw_columns],
        "rows": table.get("Content") or [],
        "count": len(table.get("Content") or []),
    }


CHANGE_PLAN_LABELS = {
    "N001": "公告日",
    "N002": "计划类型",
    "N003": "股东名称",
    "N004": "股东身份",
    "N005": "价格下限",
    "N006": "价格上限",
    "N007": "金额下限",
    "N008": "金额上限",
    "N009": "开始日期",
    "N010": "结束日期",
    "N011": "进度",
    "N012": "已增持数量",
}

CHANGE_PLAN_COLUMNS = (
    "N001",
    "N002",
    "N003",
    "N004",
    "N007",
    "N008",
    "N009",
    "N010",
    "N011",
    "N012",
)


def fetch_change_plans(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_gdyj",
        {"Params": [symbol, "gdzjcjh", "", "", "1", "1", "20"]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 增减持计划返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw = [str(name) for name in (table.get("ColName") or [])]
    wanted = [name for name in CHANGE_PLAN_COLUMNS if name in raw]
    indexes = [raw.index(name) for name in wanted]
    rows = table.get("Content") or []
    return {
        "columns": [CHANGE_PLAN_LABELS.get(name, name) for name in wanted],
        "rows": [[row[index] for index in indexes] for row in rows],
        "count": len(rows),
    }


CONTROLLER_LABELS = {
    "T001": "报告期",
    "kggd": "控股股东",
    "sjkzr": "实际控制人",
    "T004": "控股股东持股比例%",
    "T006": "合计持股比例%",
    "T009": "控制关系",
    "N006": "公司全称",
}


def fetch_controller(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_gdyj",
        {"Params": [symbol, "kggd", "", "", "1", "1", "20"]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 控股股东返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw = [str(name) for name in (table.get("ColName") or [])]
    wanted = [name for name in ("T001", "kggd", "sjkzr", "T004", "T006", "T009", "N006") if name in raw]
    indexes = [raw.index(name) for name in wanted]
    rows = table.get("Content") or []
    return {
        "columns": [CONTROLLER_LABELS.get(name, name) for name in wanted],
        "rows": [[row[index] for index in indexes] for row in rows],
        "count": len(rows),
    }


INSTITUTION_LABELS = {
    "T002": "报告期",
    "T003": "机构家数",
    "T004": "家数变动",
    "T005": "持股总数",
    "T006": "变动股数",
    "T007": "持股市值",
    "T008": "持股占比%",
    "T010": "市值占比%",
    "T014": "户均持股",
}


def fetch_institutions(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_gdyj",
        {"Params": [symbol, "jgcg", "", "", "1", "1", "20"]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 机构持仓返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw = [str(name) for name in (table.get("ColName") or [])]
    return {
        "columns": [INSTITUTION_LABELS.get(name, name) for name in raw],
        "rows": table.get("Content") or [],
        "count": len(table.get("Content") or []),
    }


SHAREHOLDER_CHANGE_LABELS = {
    "qs": "变动起始日",
    "jz": "变动截止日",
    "T003": "公告日",
    "T005": "股东名称",
    "T006": "成交均价",
    "T007": "变动数量",
    "T008": "变动后持股数",
    "T009": "变动方式",
    "T011": "身份",
}

SHAREHOLDER_CHANGE_COLUMNS = ("qs", "jz", "T005", "T006", "T007", "T008", "T009", "T011")


def fetch_shareholder_changes(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_gdyj",
        {"Params": [symbol, "cgbd", "", "", "1", "1", "20"]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 股东增减持返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw = [str(name) for name in (table.get("ColName") or [])]
    wanted = [name for name in SHAREHOLDER_CHANGE_COLUMNS if name in raw]
    indexes = [raw.index(name) for name in wanted]
    rows = table.get("Content") or []
    return {
        "columns": [SHAREHOLDER_CHANGE_LABELS.get(name, name) for name in wanted],
        "rows": [[row[index] for index in indexes] for row in rows],
        "count": len(rows),
    }


CIRCULATING_SHAREHOLDER_LABELS = {
    "rq": "报告期",
    "gd": "股东名称",
    "cgs": "持股数",
    "xz": "股份性质",
    "lb": "股东类别",
    "pos": "排名",
}


def fetch_circulating_shareholders(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_gdyj",
        {"Params": [symbol, "ltgd", "", "", "1", "1", "20"]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 十大流通股东返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if len(tables) < 2:
        return {"columns": [], "rows": [], "count": 0}
    table = tables[1]
    raw = [str(name) for name in (table.get("ColName") or [])]
    wanted = [name for name in ("rq", "gd", "cgs", "lb", "pos", "xz") if name in raw]
    indexes = [raw.index(name) for name in wanted]
    rows = [row for row in (table.get("Content") or [])]
    return {
        "columns": [CIRCULATING_SHAREHOLDER_LABELS.get(name, name) for name in wanted],
        "rows": [[row[index] for index in indexes] for row in rows],
        "count": len(rows),
    }


SHAREHOLDER_COUNT_LABELS = {
    "T002": "报告期",
    "T003": "股东人数",
    "T004": "户均持股数",
    "T005": "股东人数环比%",
    "T006": "户均持股数环比%",
    "T007": "户均持股市值(万元)",
    "T012": "股东人数变动",
}


def fetch_shareholder_count(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_gdyj",
        {"Params": [symbol, "gdrs", "", "", "1", "1", "30"]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 股东人数返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw = [str(name) for name in (table.get("ColName") or [])]
    return {
        "columns": [SHAREHOLDER_COUNT_LABELS.get(name, name) for name in raw],
        "rows": table.get("Content") or [],
        "count": len(table.get("Content") or []),
    }


def fetch_dividend(code: str, section: str = "fh") -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_fhrz",
        {"Params": [symbol, section]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 分红融资返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw = [str(name) for name in (table.get("ColName") or [])]
    return {
        "columns": [DIVIDEND_LABELS.get(name, name) for name in raw],
        "rows": table.get("Content") or [],
        "count": len(table.get("Content") or []),
    }


def fetch_shareholders(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        SHAREHOLDER_ENTRY,
        {"Params": [symbol, "sdgdbgq", "", "", "1", "1", "20"]},
    )
    return parse_shareholder_payload(payload)


def fetch_business(code: str) -> dict:
    _market, symbol = _market_of(code)
    periods = _post_tqlex(BUSINESS_PERIOD_ENTRY, {"Params": ["zygcfx", symbol]})
    tables = periods.get("ResultSets") or []
    if not tables or not tables[0].get("Content"):
        return {"columns": [], "rows": []}
    report_date = str(tables[0]["Content"][0][0])
    payload = _post_tqlex(
        BUSINESS_ENTRY,
        {"Params": [symbol, "zygc", report_date]},
    )
    result = parse_business_payload(payload)
    result["reportDate"] = report_date
    return result


def fetch_finance(code: str) -> dict:
    _market, symbol = _market_of(code)
    parsed = _post_tqlex_data(
        FINANCE_ENTRY,
        json.dumps({"Params": [symbol, "zyzb", ""]}, separators=(",", ":")).encode("utf-8"),
    )
    return parse_finance_payload(parsed)


def fetch_valuation(code: str) -> dict:
    market, symbol = _market_of(code)
    payload = {
        "ReqId": "200191",
        "Code": f"{symbol}|{market}",
        "BeginDate": "0",
        "EndDate": "0",
        "Page": "0",
        "PageSize": "20",
        "modname": "mod_gpsj.dll",
    }
    parsed = _post_tqlex_data(
        VALUATION_ENTRY,
        json.dumps([payload], separators=(",", ":")).encode("utf-8"),
    )
    return parse_valuation_payload(parsed)


def fetch_profile(code: str) -> dict:
    _market, symbol = _market_of(code)
    payload = _post_tqlex_data(
        PROFILE_ENTRY,
        json.dumps({"Params": ["8", symbol, ""]}, separators=(",", ":")).encode("utf-8"),
    )
    return parse_profile_payload(payload)


# ---------------------------------------------------------------- 缺失 Entry（2026-11-04 补齐）
#
# 这些入口此前只做了 19 个页签，但通达信前端还有股票基础信息、题材 ID、财务诊断、
# 个股总评、题材内对比、增发获配日期/明细。统一用 Params 调用，返回 tables 数组；
# 需要 dict 行时用 `parse_table_rows`。


def _fetch_params(entry: str, params: list[str], limit: int = 200) -> dict:
    payload = _post_tqlex(entry, {"Params": [str(item) for item in params]})
    tables = _parse_all_tables(payload, limit)
    return {
        "entry": entry,
        "params": [str(item) for item in params],
        "tables": tables,
        "rowCount": sum(int(table.get("count") or 0) for table in tables),
    }


def fetch_stock_info(code: str) -> dict:
    """comreq:gpquery 股票基础信息。"""
    _market, symbol = _market_of(code)
    return _fetch_params("CWServ.tdxf10_gg_comreq", ["gpquery", symbol])


def fetch_topic_ids(code: str) -> dict:
    """comreq:rdtcgn 关联题材 ID 列表。"""
    _market, symbol = _market_of(code)
    return _fetch_params("CWServ.tdxf10_gg_comreq", ["rdtcgn", symbol])


def fetch_finance_diagnosis(code: str, section: str = "zzyj") -> dict:
    """cwzd 财务诊断（服务端仅 zzyj 有数据，其余 section 可能为空）。"""
    _market, symbol = _market_of(code)
    return _fetch_params("CWServ.tdxf10_gg_cwzd", [section, symbol, ""])


def fetch_stock_score(code: str, section: str = "pf", arg: str = "") -> dict:
    """ggzp 个股总评（section=pf 综合评分）。"""
    _market, symbol = _market_of(code)
    return _fetch_params("CWServ.tdxf10_gg_ggzp", [section, symbol, arg, ""])


def fetch_topic_compare(
    code: str, topic_id: str, section: str = "gndbzfsj", sort_by: str = "zdf"
) -> dict:
    """rdtc_gndb 题材内对比排名。"""
    _market, symbol = _market_of(code)
    return _fetch_params(
        "CWServ.tdxf10_gg_rdtc_gndb", [section, symbol, str(topic_id), sort_by]
    )


def fetch_allotment_dates(code: str) -> dict:
    """fhrz_zfhpmx:zfpg_bgq 增发获配可选日期。"""
    _market, symbol = _market_of(code)
    return _fetch_params("CWServ.tdxf10_gg_fhrz_zfhpmx", ["zfpg_bgq", symbol, ""])


def fetch_allotment_details(code: str, date: str) -> dict:
    """fhrz_zfhpmx:zfpg 指定增发日期的获配机构明细。"""
    _market, symbol = _market_of(code)
    return _fetch_params("CWServ.tdxf10_gg_fhrz_zfhpmx", ["zfpg", symbol, str(date)])


HQ_NLP_TCIHQ = "HQServ.hq_nlp_tcihq"
HQ_NLP_GPSJ = "HQServ.hq_nlp_gpsj"


def fetch_hq_nlp(
    code: str,
    req_id: str | int,
    *,
    days: int | None = None,
    page: int = -1,
    page_size: int = 10,
    entry: str = HQ_NLP_TCIHQ,
    extra: dict | None = None,
) -> dict:
    """HQServ 题材/资金/排名/估值类页面（ReqId 决定语义）。"""
    market, symbol = _market_of(code)
    payload: dict = {
        "ReqId": str(req_id),
        "setcode": str(market),
        "code": symbol,
        "Page": page,
        "PageSize": str(page_size),
        "modname": "mod_tcihq.dll" if entry == HQ_NLP_TCIHQ else "mod_gpsj.dll",
    }
    if days is not None:
        payload["zq_num"] = str(days)
    if extra:
        payload.update(extra)
    parsed = _post_tqlex(entry, [payload])
    tables = _parse_all_tables(parsed, 500)
    return {
        "entry": entry,
        "reqId": str(req_id),
        "tables": tables,
        "rowCount": sum(len(table.get("rows") or []) for table in tables),
    }


def fetch_stock_stage_gain(code: str, days: int = 60) -> dict:
    return fetch_hq_nlp(code, 200740, days=days)


def fetch_stock_main_funds(code: str, days: int = 30) -> dict:
    return fetch_hq_nlp(code, 200742, days=days)


def fetch_stock_industry_rank(code: str, days: int = 30) -> dict:
    return fetch_hq_nlp(code, 200745, days=days)


def fetch_stock_industry_pct_rank(code: str, days: int = 30) -> dict:
    return fetch_hq_nlp(code, 200747, days=days)


def fetch_hq_valuation(
    code: str,
    req_id: str | int,
    *,
    page: int = 0,
    page_size: int = 20,
    extra: dict | None = None,
) -> dict:
    """HQServ.hq_nlp_gpsj 的估值类请求（Code/BeginDate/EndDate 口径）。"""
    market, symbol = _market_of(code)
    payload = {
        "ReqId": str(req_id),
        "Code": f"{symbol}|{market}",
        "BeginDate": "0",
        "EndDate": "0",
        "Page": str(page),
        "PageSize": str(page_size),
        "modname": "mod_gpsj.dll",
    }
    if extra:
        payload.update(extra)
    parsed = _post_tqlex(HQ_NLP_GPSJ, [payload])
    tables = _parse_all_tables(parsed, 500)
    return {
        "entry": HQ_NLP_GPSJ,
        "reqId": str(req_id),
        "tables": tables,
        "rowCount": sum(len(table.get("rows") or []) for table in tables),
    }


def fetch_stock_valuation_percentile(code: str, kind: str = "0") -> dict:
    return fetch_hq_valuation(code, 200192, page_size=5, extra={"Type": kind})


def fetch_stock_pepb_percentile(
    code: str, indicator: str = "0", window: str = "1Y", period: str = "0"
) -> dict:
    return fetch_hq_valuation(
        code,
        200124,
        page=1,
        page_size=300,
        extra={"sjfw": window, "zb": indicator, "hqzq": period},
    )


def fetch_stock_history_trend(code: str) -> dict:
    return fetch_hq_valuation(code, 200135, page=0, page_size=20)


def fetch_board_member_quotes(
    board_code: str, board_market: int = 1, page: int = -1, page_size: int = -1
) -> dict:
    """HQServ 200744：板块成分股行情（板块代码如 881319）。"""
    payload = {
        "ReqId": "200744",
        "setcode": str(board_market),
        "code": str(board_code).strip(),
        "Page": page,
        "PageSize": str(page_size),
        "modname": "mod_tcihq.dll",
    }
    parsed = _post_tqlex(HQ_NLP_TCIHQ, [payload])
    tables = _parse_all_tables(parsed, 500)
    return {
        "entry": HQ_NLP_TCIHQ,
        "reqId": "200744",
        "tables": tables,
        "rowCount": sum(len(table.get("rows") or []) for table in tables),
    }


def fetch_limit_board_ladder(
    start_date: str | None = None,
    end_date: str | None = None,
    include_summary: bool = False,
) -> dict:
    """涨跌停/炸板梯子（CWServ.cfg_fx_lbtt，Params=["1", start, end]）。"""
    start = _normalize_date(start_date)
    end = _normalize_date(end_date)
    if start is None and end is None:
        start = end = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d")
    if start is None:
        start = end
    if end is None:
        end = start
    if start > end:
        raise F10Error("start_date 不能晚于 end_date")
    detail = _fetch_params("CWServ.cfg_fx_lbtt", ["1", start, end], 500)
    result = {"startDate": start, "endDate": end, "detail": detail}
    if include_summary:
        result["summary"] = _fetch_params(
            "CWServ.cfg_fx_lbtt", ["2", start, end], 500
        )
    return result


def _normalize_date(value: str | int | None) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip().replace("-", "").replace("/", "")
    if len(text) != 8 or not text.isdigit():
        raise F10Error(f"日期不合法：{value}")
    return text


def fetch_finance_weights(code: str, section: str = "zcfzb") -> dict:
    """最新提示：财务指标权重（section 由 digest 的财务概况列表给出）。"""
    _market, symbol = _market_of(code)
    return _fetch_params("CWServ.tdxf10_gg_zxtscwbq", [symbol, section])


INDUSTRY_PAGES = {
    "hqtj": ("CWServ.skef10_hy_hqtj", lambda hy: [hy]),
    "hyzq": ("CWServ.skef10_hy_hyzq", lambda hy: [hy]),
    "hygy": ("CWServ.skef10_hy_hygy", lambda hy: [hy]),
    "zszfb": ("CWServ.skef10_hy_zszfb", lambda hy: [hy]),
    "stage_rise": ("CWServ.skef10_hy_jdzf", lambda hy: [hy, "e"]),
    "profile": ("CWServ.skef10_hy_hyzl_hyjs", lambda hy: [hy]),
    "commentary": ("CWServ.skef10_hy_hyzl_hyplk", lambda hy: ["001", hy]),
    "news": ("CWServ.skef10_hy_zxdt", lambda hy: ["hydt", hy]),
    "cwzkpm": ("CWServ.skef10_hy_hydw_cwzkpm", lambda hy: ["002", hy, "", "e", ""]),
    "gsgmpm": ("CWServ.skef10_hy_hydw_gsgmpm", lambda hy: [hy]),
    "gzsppm": ("CWServ.skef10_hy_hydw_gzsppm", lambda hy: ["01", hy, "o"]),
    "scbxpm": ("CWServ.skef10_hy_hydw_scbxpm", lambda hy: ["scpm", "", hy]),
    "zysrpm": ("CWServ.skef10_hy_hydw_zysrpm", lambda hy: ["001", hy, ""]),
    "capital_stats": ("CWServ.skef10_hy_hysj_bxzjtj", lambda hy: ["001", hy, "n"]),
    "fund_holdings": ("CWServ.skef10_hy_hysj_jjzb", lambda hy: ["1", hy, ""]),
    "capital_flow": ("CWServ.skef10_hy_hysj_zjlx", lambda hy: ["001", hy]),
    "analyst_index": ("CWServ.skef10_hy_hyyj_fxszs", lambda hy: ["001", hy, "", ""]),
    "major_holders": ("CWServ.skef10_hy_hyyj_hymzgd", lambda hy: [hy]),
    "rating_summary": ("CWServ.skef10_hy_hyyj_hypjhz", lambda hy: ["001", hy, ""]),
    "index": ("CWServ.skef10_hy_idsy", lambda hy: ["002", hy]),
}


def fetch_industry_page(hy: str, section: str = "hqtj") -> dict:
    """行业 hyf10 家族（20 个子页）；hy 为 6 位行业代码（如 881319）。"""
    text = str(hy or "").strip()
    if len(text) != 6 or not text.isdigit():
        raise F10Error("行业代码必须是 6 位数字")
    if section not in INDUSTRY_PAGES:
        raise F10Error(f"未知行业页：{section}")
    entry, builder = INDUSTRY_PAGES[section]
    return _fetch_params(entry, builder(text), 500)


def parse_table_rows(table: dict) -> list[dict]:
    """把列名/数组行转成 dict 行；重复列名加 `__2` 后缀，避免静默覆盖。"""
    columns: list[str] = []
    seen: dict[str, int] = {}
    for raw in table.get("columns") or []:
        name = str(raw) or "col"
        count = seen.get(name, 0) + 1
        seen[name] = count
        columns.append(name if count == 1 else f"{name}__{count}")
    return [dict(zip(columns, values)) for values in table.get("rows") or []]


def parse_news_payload(payload: dict) -> list[dict]:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    result_sets = payload.get("ResultSets") or []
    if not result_sets:
        return []
    table = result_sets[0]
    columns = table.get("ColName") or []
    rows: list[dict] = []
    for values in table.get("Content") or []:
        row = dict(zip(columns, values))
        rows.append(
            {
                "id": str(row.get("rec_id") or ""),
                "date": str(row.get("issue_date") or "")[:16],
                "title": str(row.get("title") or ""),
                "source": str(row.get("source") or ""),
            }
        )
    return rows


TRADING_SECTIONS = {
    "margin": ("rzrq", ""),
    "block": ("dzjy", ""),
    "dragon": ("lgt", "2"),
    "north": ("islgt", ""),
    "reports": ("yxsbxx", ""),
    "kcb": ("checkkcb", ""),
    "limit_up": ("ztfx", ""),
    "limit_down": ("dtfx", ""),
    "bonds": ("zrq", ""),
    "main_force": ("zlpskcj", ""),
    "margin_history": ("rzrq_sj", ""),
}

TRADING_LABELS = {
    "margin": {"T001": "交易日", "T003": "融资余额", "T004": "融资买入额", "T005": "融券余额", "ClosePrice": "收盘价"},
    "block": {"yjl": "溢价率"},
    "dragon": {"rq": "日期", "T006": "买入额", "T007": "卖出额"},
    "north": {"T001": "持股"},
    "reports": {},
    "kcb": {"sc": "科创板标记"},
    "margin_history": {
        "id": "序号",
        "N001": "日期",
        "N002": "代码",
        "N003": "名称",
        "N004": "融资余额",
        "N008": "融券金额",
        "N009": "占流通市值%",
        "N013": "上市日期",
    },
    "limit_up": {
        "currq": "当日",
        "lx": "类型",
        "sT002": "日期",
        "T011": "时间",
        "fdje": "封单额",
        "zt": "主题",
        "yy": "原因",
        "N005": "成交额",
    },
    "limit_down": {
        "currq": "当日",
        "lx": "类型",
        "sT002": "日期",
        "T011": "时间",
        "fdje": "封单额",
        "zt": "主题",
        "yy": "原因",
        "N005": "成交额",
    },
}


def parse_trading_payload(payload: dict, section: str) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    labels = TRADING_LABELS.get(section, {})
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"section": section, "rawColumns": [], "columns": [], "rows": [], "count": 0}
    # 分区主表固定是 table0；空表就是“无记录”，不能拿调整因子/收盘价表凑数。
    table = tables[0]
    content = table.get("Content") or []
    if not content:
        return {"section": section, "rawColumns": [], "columns": [], "rows": [], "count": 0}
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    columns = [labels.get(name, name) for name in raw_columns]
    return {
        "section": section,
        "rawColumns": raw_columns,
        "columns": columns,
        "rows": content,
        "count": len(content),
    }


LHB_LABELS = {
    "N001": "日期",
    "N002": "代码",
    "sc": "市场",
    "N003": "名称",
    "N004": "收盘",
    "N005": "涨跌幅",
    "N006": "板块代码",
    "N007": "行业代码",
    "N008": "上榜原因",
    "N009": "营业部",
    "N010": "买入额",
    "N011": "卖出额",
    "N012": "方向",
    "N013": "排名",
}


def parse_lhb_market_payload(payload: dict) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 龙虎榜返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"section": "dragon_market", "rawColumns": [], "columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    return {
        "section": "dragon_market",
        "rawColumns": raw_columns,
        "columns": [LHB_LABELS.get(name, name) for name in raw_columns],
        "rows": table.get("Content") or [],
        "count": len(table.get("Content") or []),
    }


MARKET_SECTIONS = {
    "basic": ("CWServ.skef10_dpzx_jbxx", ["002", "000001"]),
    "margin": ("CWServ.skef10_dpzx_rzrq", ["001", "000001"]),
    "new": ("CWServ.skef10_dpzx_xgfx", ["002"]),
    "capital": ("CWServ.skef10_dpzx_scgl", ["004"]),
}

MARKET_LABELS = {
    "basic": {
        "N001": "指数名称",
        "N002": "简称",
        "N003": "类型",
        "N004": "发布日期",
        "N005": "代码",
        "N006": "成立日期",
        "N007": "样本数",
        "N009": "简介",
    },
    "margin": {
        "N001": "日期",
        "N002": "代码",
        "sc": "市场",
        "N003": "名称",
        "N004": "融资余额",
        "N005": "融券余额",
        "N006": "占流通市值%",
        "N008": "附加金额1",
        "N009": "附加金额2",
    },
    "new": {
        "N001": "日期",
        "N002": "代码",
        "sc": "市场",
        "N003": "名称",
        "N004": "发行价",
        "N005": "发行市盈率",
        "N007": "中签率",
        "N008": "募资额",
    },
    "capital": {"N001": "代码", "N002": "名称", "N003": "内容", "N004": "状态"},
}


def parse_market_payload(payload: dict, section: str) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 大盘资料返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"section": section, "rawColumns": [], "columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    labels = MARKET_LABELS.get(section, {})
    return {
        "section": section,
        "rawColumns": raw_columns,
        "columns": [labels.get(name, name) for name in raw_columns],
        "rows": table.get("Content") or [],
        "count": len(table.get("Content") or []),
    }


def fetch_market(section: str = "basic") -> dict:
    if section not in MARKET_SECTIONS:
        raise F10Error(f"不支持的大盘资料分区：{section}")
    entry, params = MARKET_SECTIONS[section]
    return parse_market_payload(_post_tqlex(entry, {"Params": params}), section)


def fetch_lhb_market() -> dict:
    """沪深龙虎榜（7615 大盘 F10，table0 含营业部买卖明细）。"""
    payload = _post_tqlex(
        "CWServ.skef10_dpzx_lhb",
        {"Params": ["001", "1", "20"]},
    )
    return parse_lhb_market_payload(payload)


def fetch_trading(code: str, section: str = "margin") -> dict:
    if section not in TRADING_SECTIONS:
        raise F10Error(f"不支持的交易数据分区：{section}")
    raw_section, arg = TRADING_SECTIONS[section]
    market, symbol = _market_of(code)
    if section == "margin_history":
        payload = _post_tqlex(
            "CWServ.tdxf10_gg_sj",
            {"Params": ["rzrq_sj", symbol, "0", symbol]},
        )
    else:
        payload = _post_tqlex(
            "CWServ.tdxf10_gg_jyds",
            {"Params": [symbol, raw_section, arg]},
        )
    table = parse_trading_payload(payload, section)
    if section == "dragon" and table["count"] == 0:
        # 个股 lgt 常返回空表；用大盘龙虎榜的同一批营业部明细按代码过滤补齐。
        market, symbol = _market_of(code)
        market_table = fetch_lhb_market()
        columns = market_table["columns"]
        code_index = columns.index("代码") if "代码" in columns else -1
        market_index = columns.index("市场") if "市场" in columns else -1
        rows = [
            row
            for row in market_table["rows"]
            if code_index >= 0
            and str(row[code_index]) == symbol
            and (market_index < 0 or int(row[market_index] or 0) == market)
        ]
        if rows:
            return {**table, "columns": columns, "rows": rows, "count": len(rows)}
    return table


def fetch_news(code: str) -> list[dict]:
    market, symbol = _market_of(code)
    body = {
        "action": "get",
        "key": f"xw:{market}_{symbol}",
        "bin": "1",
        "qsid": "tdx",
    }
    parsed = _post_tqlex_data(
        "CWSearch.tzx_rcache",
        json.dumps(body, separators=(",", ":")).encode("utf-8"),
    )
    return parse_news_payload(parsed)


def fetch_announcements(code: str) -> list[dict]:
    market, symbol = _market_of(code)
    body = {
        "action": "get",
        "key": f"gg:{market}_{symbol}",
        "bin": "1",
        "qsid": "tdx",
    }
    payload = _post_tqlex_data(
        ENTRY,
        json.dumps(body, separators=(",", ":")).encode("utf-8"),
    )
    return parse_announcements_payload(payload)


INDUSTRY_ENTRY = "CWServ.tdxf10_gg_hyfx"
INDUSTRY_SECTIONS = {
    "summary": ("tot", ""),
    "news": ("hyxw", ""),
    "reports": ("hyyb", ""),
}

INDUSTRY_LABELS = {
    "cnt": "家数",
    "bkname": "行业",
    "jzrq": "日期",
    "issue": "日期",
    "Title": "标题",
    "rec_id": "记录ID",
    "nflag": "标记",
    "ybdz": "原文地址",
}


def fetch_industry(code: str, section: str = "summary") -> dict:
    """7615 行业分析：行业汇总 / 行业新闻 / 行业研报。"""
    if section not in INDUSTRY_SECTIONS:
        raise F10Error(f"不支持的行业分区：{section}")
    _market, symbol = _market_of(code)
    raw_section, arg = INDUSTRY_SECTIONS[section]
    payload = _post_tqlex(
        INDUSTRY_ENTRY,
        {"Params": [raw_section, symbol, arg]},
    )
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 行业数据返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"section": section, "rawColumns": [], "columns": [], "rows": [], "count": 0}
    table = tables[0]
    raw_columns = [str(name) for name in (table.get("ColName") or [])]
    columns = [INDUSTRY_LABELS.get(name, name) for name in raw_columns]
    rows = table.get("Content") or []
    return {
        "section": section,
        "rawColumns": raw_columns,
        "columns": columns,
        "rows": rows,
        "count": len(rows),
    }


# ---------------------------------------------------------------- 7615 补充分区

DIGEST_SECTIONS = {
    "tips": "zxts",
    "profile": "gsgy",
    "events": "gsds",
    "news": "gsxw",
    "announcements": "gsgg",
    "reports": "gsyj",
    "roadshows": "lyhd",
}


def _parse_result_table(payload: dict, limit: int = 200) -> dict:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if not tables:
        return {"columns": [], "rows": [], "count": 0}
    table = tables[0]
    columns = [str(name) for name in (table.get("ColName") or [])]
    rows = [list(values) for values in (table.get("Content") or [])][: max(1, limit)]
    return {"columns": columns, "rows": rows, "count": len(rows)}


def fetch_digest(
    code: str, section: str = "tips", page_size: int = 20
) -> dict:
    """7615 最新提示 8 分区；interaction 走独立 Entry。"""
    _market, symbol = _market_of(code)
    if section == "interaction":
        payload = _post_tqlex(
            "CWServ.tdxf10_gg_zxtstzzhd",
            {"Params": [symbol, "1", "1", str(max(1, min(page_size, 100)))]},
        )
    elif section in DIGEST_SECTIONS:
        payload = _post_tqlex(
            "CWServ.tdxf10_gg_zxts",
            {"Params": [symbol, DIGEST_SECTIONS[section], ""]},
        )
    else:
        raise F10Error(f"不支持的 F10 提示分区：{section}")
    result = _parse_result_table(payload)
    return {"section": section, **result}


def parse_market_news_payload(payload: dict, limit: int = 50) -> list[dict]:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 资讯返回错误码 {payload.get('ErrorCode')}")
    tables = payload.get("ResultSets") or []
    if len(tables) < 2:
        return []
    table = tables[1]
    columns = [str(name) for name in (table.get("ColName") or [])]
    rows: list[dict] = []
    for values in (table.get("Content") or [])[: max(1, limit)]:
        row = dict(zip(columns, values))
        rows.append(
            {
                "id": str(row.get("rec_id") or ""),
                "title": str(row.get("Title") or ""),
                "date": str(row.get("Issue_date") or "")[:19],
                "summary": str(row.get("Summary") or ""),
                "source": str(row.get("Info_Src") or ""),
                "url": str(row.get("Url") or ""),
            }
        )
    return rows


def fetch_market_news(tab: int = 3, page: int = 1, page_size: int = 50) -> list[dict]:
    """7615 全市场资讯首页：1 滚动/2 今日焦点/3 要闻速递/4 正面/5 负面/6 精华/7 最新/9 机构。"""
    payload = _post_tqlex(
        "CWServ.tdxi_zxxwsy",
        {"Params": [str(tab), str(max(1, page)), str(max(1, min(page_size, 100)))]},
    )
    return parse_market_news_payload(payload, page_size)


NEWS_CHANNELS = {
    # 频道号与中文名来自通达信前端栏目枚举（84 个），按 firstNav 分组。
    200: "财经最新",
    201: "财经要闻",
    202: "国内财经",
    203: "国际财经",
    204: "证券市场",
    205: "金融货币",
    206: "宏观经济",
    207: "产经动态",
    211: "数字财经",
    212: "财经人物",
    213: "时政要闻",
    300: "股票最新",
    301: "股票要闻",
    302: "大盘分析",
    303: "板块聚焦",
    304: "三板动态",
    305: "B股资讯",
    306: "公司新闻",
    307: "公司公告",
    309: "海外股市",
    310: "海外公司",
    318: "科创板",
    500: "新股最新",
    501: "新股要闻",
    502: "新股公告",
    503: "沪深新股",
    504: "港股新股",
    505: "美股新股",
    507: "新股评论",
    600: "港股最新",
    601: "港股要闻",
    602: "港股市场",
    603: "港股公司",
    604: "港股公告",
    605: "投行评级",
    606: "涡轮资讯",
    607: "香港经济",
    700: "美股最新",
    701: "美股要闻",
    702: "美股市场",
    703: "美股新闻",
    704: "中概股",
    705: "美股评论",
    706: "海外经济",
    800: "基金最新",
    801: "基金要闻",
    802: "公募基金",
    803: "私募基金",
    804: "社保基金",
    805: "信托基金",
    808: "机构持仓",
    809: "基金公告",
    900: "期货最新",
    901: "期货要闻",
    902: "市场评述",
    903: "金融期货",
    904: "能源化工",
    905: "金属期货",
    906: "农产品",
    907: "持仓交割",
    908: "现货报价",
    909: "库存数据",
    910: "生产供求",
    1000: "理财最新",
    1001: "理财要闻",
    1002: "银行理财",
    1006: "贵金属",
    1008: "综合理财",
    1011: "互联网金融",
    1100: "外汇最新",
    1101: "外汇要闻",
    1102: "货币专栏",
    1103: "央行专栏",
    1111: "汇市评论",
    1200: "债券最新",
    1201: "债券要闻",
    1202: "国内债市",
    1203: "国际债市",
    1204: "债券新闻",
    1205: "债券公告",
    1801: "期权最新",
    1802: "期权要闻",
    1803: "指数期权",
    1804: "商品期权",
}

# 分组用于 UI/批量归档：只做 A 股相关（财经/股票/新股/基金/债券），
# 港股/美股/期货/外汇/期权保留枚举但不主动批量抓取。
NEWS_CHANNEL_GROUPS = {
    "财经": [200, 201, 202, 203, 204, 205, 206, 207, 211, 212, 213],
    "股票": [300, 301, 302, 303, 306, 318, 304, 309, 310, 307, 305],
    "新股": [500, 501, 502, 507, 503, 504, 505],
    "基金": [800, 801, 808, 802, 803, 804, 805, 809],
    "债券": [1200, 1201, 1202, 1203, 1204, 1205],
    "港股": [600, 601, 602, 603, 605, 606, 604, 607],
    "美股": [700, 701, 702, 703, 704, 705, 706],
    "期货": [900, 901, 902, 903, 904, 905, 906, 907, 908, 910, 909],
    "理财": [1000, 1001, 1002, 1008, 1006, 1011],
    "外汇": [1100, 1101, 1111, 1102, 1103],
    "期权": [1801, 1802, 1803, 1804],
}



def fetch_channel_news(
    channel: int = 201,
    page: int = 1,
    page_size: int = 50,
    query1: str = "1",
    keyword: str = "",
) -> list[dict]:
    """7615 资讯频道：频道号见 NEWS_CHANNELS。"""
    payload = _post_tqlex(
        "CWServ.tdxi_zxxwnews",
        {
            "Params": [
                str(query1 or "1"),
                str(int(channel)),
                str(max(1, page)),
                str(max(1, min(page_size, 100))),
                str(keyword or ""),
            ]
        },
    )
    return parse_market_news_payload(payload, page_size)


PROFIT_FORECAST_SECTIONS = {"ylyctj", "ylycmx", "yzyq", "tzpjtj", "ycpjyjbg"}
GOVERNANCE_SECTIONS = {"wgcl", "dbmxbgq", "gljy", "gqzr", "gqzy", "sgjb", "zdsx", "zjly", "dbmx", "gqtz", "xmtz"}
RANKING_SECTIONS = {"scpmdela", "scpmdelat", "hypmdela", "hypmdelat", "scpmzxt", "hypmzxt", "ztxqzxts"}


def _parse_all_tables(payload: dict, limit: int = 50) -> list[dict]:
    if int(payload.get("ErrorCode") or 0) != 0:
        raise F10Error(f"7615 返回错误码 {payload.get('ErrorCode')}")
    tables: list[dict] = []
    for table in payload.get("ResultSets") or []:
        # 部分 HQServ 结果集只给 ColDes/列描述，不填 ColName；不能因此丢列名。
        raw_columns = table.get("ColName") or table.get("ColDes") or []
        columns = []
        for item in raw_columns:
            if isinstance(item, dict):
                columns.append(str(item.get("Name") or item.get("ColName") or ""))
            else:
                columns.append(str(item))
        columns = [name for name in columns if name]
        rows = [list(values) for values in (table.get("Content") or [])][: max(1, limit)]
        # 重复列名加 __2 后缀，避免下游 dict(zip(...)) 静默覆盖。
        renamed: list[str] = []
        seen: dict[str, int] = {}
        for name in columns:
            key = name or f"col{len(renamed)}"
            count = seen.get(key, 0) + 1
            seen[key] = count
            renamed.append(key if count == 1 else f"{key}__{count}")
        tables.append({"columns": renamed, "rows": rows, "count": len(rows)})
    return tables


def fetch_profit_forecast(code: str, section: str = "ylyctj") -> dict:
    """7615 盈利预测：5 个分区，返回全部 ResultSet。"""
    _market, symbol = _market_of(code)
    if section not in PROFIT_FORECAST_SECTIONS:
        raise F10Error(f"不支持的盈利预测分区：{section}")
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_ybpj", {"Params": [symbol, section]}
    )
    return {"section": section, "tables": _parse_all_tables(payload)}


def fetch_governance(code: str, section: str = "gljy") -> dict:
    """7615 资本运作治理：违规/担保/关联交易/股权/诉讼/重大事项/资金运用。"""
    _market, symbol = _market_of(code)
    if section not in GOVERNANCE_SECTIONS:
        raise F10Error(f"不支持的治理分区：{section}")
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_zbyz", {"Params": [section, symbol, ""]}
    )
    return {"section": section, **_parse_result_table(payload)}


def fetch_ranking_detail(code: str, section: str = "scpmdela") -> dict:
    """7615 市场/行业排名明细。"""
    _market, symbol = _market_of(code)
    if section not in RANKING_SECTIONS:
        raise F10Error(f"不支持的排位分区：{section}")
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_zxts_rqpm", {"Params": [symbol, section]}
    )
    return {"section": section, **_parse_result_table(payload)}


def fetch_northbound_holding(
    code: str, section: str = "bszj", filter_value: str = "", page: int = 1, page_size: int = 20
) -> dict:
    """7615 沪深股通持股变化。"""
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_zlcc",
        {
            "Params": [
                symbol,
                section,
                filter_value,
                str(max(1, page)),
                str(max(1, page)),
                str(max(1, min(page_size, 100))),
            ]
        },
    )
    return {"section": section, **_parse_result_table(payload)}


def fetch_hot_topics(code: str, section: str = "zttzbkz") -> dict:
    """7615 个股热点题材。"""
    _market, symbol = _market_of(code)
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_rdtc", {"Params": [symbol, section]}
    )
    return {"section": section, **_parse_result_table(payload)}


def fetch_detail(detail_type: str, record_id: str | int) -> dict:
    """7615 按记录 ID 读取公告/新闻/研报正文。"""
    kind = str(detail_type or "").strip()
    if not kind:
        raise F10Error("详情类型不能为空")
    payload = _post_tqlex(
        "CWServ.tdxf10_gg_idreq", {"Params": [kind, str(record_id)]}
    )
    return {"detailType": kind, "recordId": str(record_id), **_parse_result_table(payload)}


FUND_REPORT_SECTIONS = {
    "name", "managers", "company", "basic", "seats", "scale", "scale_history",
    "nav", "nav_period", "nav_rank", "dividends", "asset_allocation",
    "industry_allocation", "holdings_compare", "holdings_rank", "holding_summary",
    "bond_allocation", "futures_allocation", "holdings", "holdings_detail",
    "holdings_changes", "fund_of_funds", "finance", "sales_info",
    "sales_announcements", "sales_news", "etf", "margin", "ratings", "categories",
}


def fetch_fund_report(
    code: str,
    section: str = "basic",
    arg: str = "",
    date: str = "",
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """7615 ETF/基金 F10：30 个 section，返回全部 ResultSet。"""
    if section not in FUND_REPORT_SECTIONS:
        raise F10Error(f"不支持的基金分区：{section}")
    symbol = _code6(code)
    page_text, size_text = str(max(1, page)), str(max(1, min(page_size, 100)))
    date_text = str(date or "")
    jj = "CWServ.skef10_jj_"
    jjzl, gmfe, jzhb = f"{jj}jjzl", f"{jj}gmfe", f"{jj}jzhb"
    tzzh, cgqk, xsxx, etfzj = f"{jj}tzzh", f"{jj}cgqk", f"{jj}xsxx", f"{jj}etfzj"
    table = {
        "name": (f"{jj}idreq", ["name", symbol]),
        "managers": (jjzl, ["1", symbol, "", page_text, page_text, size_text]),
        "company": (jjzl, ["2", symbol, "", page_text, page_text, size_text]),
        "basic": (jjzl, ["4", symbol, "", page_text, page_text, size_text]),
        "seats": (jjzl, ["5", symbol, arg, page_text, page_text, size_text]),
        "scale": (gmfe, ["0", symbol, "", ""]),
        "scale_history": (gmfe, [arg or "0", symbol, "", date_text]),
        "nav": (jzhb, ["0", symbol, "0", ""]),
        "nav_period": (jzhb, ["1", symbol, "0", ""]),
        "nav_rank": (jzhb, ["3", symbol, "0", ""]),
        "dividends": (jzhb, ["5", symbol, "0", ""]),
        "asset_allocation": (tzzh, ["zcpz", symbol, ""]),
        "industry_allocation": (tzzh, ["hyfb", symbol, date_text]),
        "holdings_compare": (tzzh, ["cgjzd", symbol, ""]),
        "holdings_rank": (tzzh, ["zjpz", symbol, ""]),
        "holding_summary": (tzzh, ["jjxtzzh", symbol, ""]),
        "bond_allocation": (tzzh, ["zczq", symbol, date_text]),
        "futures_allocation": (tzzh, ["ccqhmx", symbol, date_text]),
        "holdings": (cgqk, ["cgqkbgq", symbol, "", "", "1", "1", "1"]),
        "holdings_detail": (cgqk, ["cgmxbgq", symbol, "", "", "1", "1", "1"]),
        "holdings_changes": (cgqk, ["cyjjmxbgq", symbol, "", "", "1", "1", "1"]),
        "fund_of_funds": (cgqk, ["sxjjzcbgq", symbol, "", "", "1", "1", "1"]),
        "finance": (f"{jj}cwzk", [arg or "zcfzb", symbol]),
        "sales_info": (xsxx, ["0", symbol]),
        "sales_announcements": (xsxx, ["4", symbol]),
        "sales_news": (xsxx, ["5", symbol]),
        "etf": (etfzj, ["etfzjlx", symbol, date_text or "3M"]),
        "margin": (etfzj, ["etfrzrq", symbol, date_text or "3M"]),
        "ratings": (f"{jj}jjpj", [arg or "001", symbol]),
        "categories": (f"{jj}fxsy", [arg or "bgqzf", symbol, ""]),
    }
    entry, params = table[section]
    payload = _post_tqlex(entry, {"Params": params})
    return {"section": section, "tables": _parse_all_tables(payload, 200)}


# ---------------------------------------------------------------- 板块 / 指数 / 大盘

MARKET_REPORT_SECTIONS = {
    "board_info": ("CWServ.skef10_bk_getinfo", False),
    "board_basics": ("CWServ.skef10_bk_cpbd_jczl", False),
    "board_description": ("CWServ.skef10_bk_cpbd_jczl", False),
    "board_trading": ("CWServ.skef10_bk_cpbd_jczl", False),
    "board_flow": ("CWServ.skef10_bk_zjlx", False),
    "board_members": ("CWServ.skef10_bk_scgl", False),
    "board_analysis": ("CWServ.skef10_bk_sdfx", False),
    "board_finance_compare": ("CWServ.skef10_bk_ggdb_cwdb", False),
    "board_candidates": ("CWServ.skef10_bk_cfgsj", False),
    "board_trend": ("CWServ.skef10_bk_ydfx", False),
    "index_info": ("CWServ.skef10_zs_getinfo", False),
    "index_profile": ("CWServ.skef10_zs_jbxx_zsgk", False),
    "index_valuation": ("CWServ.skef10_zs_jbxx_gzxx", False),
    "index_tracking": ("CWServ.skef10_zs_jbxx_gzbd", False),
    "index_flow": ("CWServ.skef10_zs_zjdx", False),
    "index_flow_members": ("CWServ.skef10_zs_cfgsj_cfgjcsj", False),
    "index_notices": ("CWServ.skef10_zs_jrts", False),
    "market_basic": ("CWServ.skef10_dpzx_jbxx", False),
    "market_margin": ("CWServ.skef10_dpzx_rzrq", False),
    "market_margin_summary": ("CWServ.skef10_dpzx_rzrq", False),
    "market_margin_investors": ("CWServ.skef10_dpzx_rzrq", True),
    "market_new_shares": ("CWServ.skef10_dpzx_xgfx", True),
    "market_capital": ("CWServ.skef10_dpzx_scgl", True),
}


def _code6(code: str) -> str:
    text = str(code or "").strip().lower()
    if len(text) == 8 and text[:2] in {"sh", "sz", "bj"}:
        text = text[2:]
    if len(text) != 6 or not text.isdigit():
        raise F10Error(f"代码格式不合法：{code}")
    return text


def fetch_market_report(
    code: str = "",
    section: str = "board_info",
    arg: str = "",
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """7615 板块/指数/大盘 F10：23 个常用 section。

    兼容 eltdx 语义别名：index_members→index_flow_members（成份股清单）、
    index_etfs→index_tracking（跟踪产品）、ipo_calendar→market_new_shares。
    """
    section = {
        "index_members": "index_flow_members",
        "index_etfs": "index_tracking",
        "ipo_calendar": "market_new_shares",
    }.get(section, section)
    if section not in MARKET_REPORT_SECTIONS:
        raise F10Error(f"不支持的市场资料分区：{section}")
    entry, code_less = MARKET_REPORT_SECTIONS[section]
    symbol = "" if code_less else _code6(code)
    page_text, size_text = str(max(1, page)), str(max(1, min(page_size, 100)))
    if section == "board_info":
        params = [symbol]
    elif section in {"board_basics", "board_description", "board_trading"}:
        params = [{"board_basics": "001", "board_description": "002", "board_trading": "004"}[section], symbol, ""]
    elif section == "board_flow":
        params = [arg or "001_1", symbol, ""]
    elif section == "board_members":
        params = [arg or "001", symbol, page_text, size_text]
    elif section == "board_analysis":
        params = ["001", symbol, ""]
    elif section in {"board_finance_compare", "board_trend"}:
        params = [symbol]
    elif section == "board_candidates":
        params = [arg or "001", symbol]
    elif section == "index_info":
        params = [symbol]
    elif section in {"index_profile", "index_valuation"}:
        params = [symbol] if section == "index_profile" else ["001", symbol, "", ""]
    elif section == "index_tracking":
        params = [symbol, page_text, size_text]
    elif section == "index_flow":
        params = [arg or "004_1", symbol, "", "", page_text, size_text]
    elif section == "index_flow_members":
        params = [arg or "001", symbol, page_text, size_text]
    elif section == "index_notices":
        params = [arg or "001", symbol, page_text, size_text]
    elif section == "market_basic":
        params = ["002", symbol]
    elif section == "market_margin":
        params = ["001", symbol]
    elif section == "market_margin_summary":
        params = ["002", symbol]
    elif section == "market_margin_investors":
        params = ["003", arg or "1m"]
    elif section == "market_new_shares":
        params = ["002"]
    else:
        params = [arg or "004"]
    payload = _post_tqlex(entry, {"Params": params})
    return {"section": section, "tables": _parse_all_tables(payload, 200)}


# ---------------------------------------------------------------- PIT 自动快照
#
# 所有公开 F10 fetch 统一包一层：成功返回后按 snapshot_date + code + table 写
# point-in-time。放在 fetch 层而不是 Electron/HTTP 路由，保证桌面、Web、脚本
# 三条调用路径都会留下同一份快照；失败只告警，不阻断资料查询。

_F10_PIT_TABLES = (
    "allotment_dates",
    "allotment_details",
    "announcements",
    "business",
    "capital_structure",
    "change_plans",
    "circulating_shareholders",
    "controller",
    "digest",
    "dividend",
    "finance",
    "finance_diagnosis",
    "fund_report",
    "governance",
    "hot_topics",
    "industry",
    "institutions",
    "news",
    "northbound_holding",
    "profile",
    "profit_forecast",
    "ranking_detail",
    "reports",
    "shareholder_changes",
    "shareholder_count",
    "shareholders",
    "statement",
    "stock_info",
    "stock_score",
    "stock_stage_gain",
    "stock_main_funds",
    "stock_industry_rank",
    "stock_industry_pct_rank",
    "stock_history_trend",
    "stock_valuation_percentile",
    "stock_pepb_percentile",
    "finance_weights",
    "topic_compare",
    "topic_ids",
    "trading",
    "valuation",
)


def _wrap_f10_pit(name: str, function):
    from functools import wraps

    @wraps(function)
    def wrapped(code: str, *args, **kwargs):
        result = function(code, *args, **kwargs)
        try:
            from f10_pit import default_root, write_f10_snapshot

            section = kwargs.get("section")
            if section is None and args:
                section = args[0]
            table = f"f10_{name}"
            if section:
                table = f"{table}_{section}"
            write_f10_snapshot(default_root(), code, table, result)
        except Exception as error:  # noqa: BLE001 - 快照不能影响在线查询
            import sys

            print(f"[f10] point-in-time 快照失败：{error}", file=sys.stderr)
        return result

    return wrapped


for _pit_name in _F10_PIT_TABLES:
    _pit_function = globals().get(f"fetch_{_pit_name}")
    if callable(_pit_function):
        globals()[f"fetch_{_pit_name}"] = _wrap_f10_pit(_pit_name, _pit_function)
