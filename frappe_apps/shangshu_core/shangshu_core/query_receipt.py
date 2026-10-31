"""查询回执：把「这次查到了什么」做成**版本化结构**，随查询结果一起返回。

为什么要有（PKG-018-T01）：查询只回一页明细时，模型收到的是几行 JSON ——
**没有回执，它会把这一页当成全部，或者自己逐行心算**。回执让「匹配总数／实际返回数／
明细是否完整／实际口径／授权范围／查询时间／异常」这些事实**随结果一起**进到模型
实际收到的工具消息里（**不加一次 LLM 摘要**）。

口径（不猜、不夸大）：
· 数量来自**同一次授权范围、同一次筛选**下的计数（与明细同一读取边界）；
· 算不出来的数量写 **null**，**不推算成 0**；查询失败就是**抛错**，不是「0 条」；
· 只登记**实际用到的**字段与条件（不登记无权字段）；
· **明细完整性**与**聚合完整性**分开表达（有没有聚合是另一回事）；
· 旧消费者继续可用：`rows/total/page/page_length` 一字不改，回执是**新增字段**。
"""
import json

from frappe.utils import now as _now

# 回执结构版本（改动结构就进位；旧消费者只读 rows/total，不受影响）。
RECEIPT_VERSION = 1


def _query_id(object_id, criteria, queried_at):
    """查询编号：**只用于追溯**（PKG-018-T04：不宣称是固定结果集的快照）。

    ⚠️ 必须**每次唯一**：同秒内用「条件＋时间」哈希会撞号 ⇒ 追问就分不清是哪一次算的。
    """
    import uuid
    return uuid.uuid4().hex[:12]


def build_receipt(*, object_id, object_name=None, domain_id=None,
                  matched_total=None, returned_rows=0, page=1, page_length=None,
                  filters=None, search=None, sort=None, direction=None,
                  scope=None, counting="row", exact=True,
                  details_complete=None, aggregate_complete=None,
                  exceptions=None, queried_at=None):
    """造一份查询回执。

    参数口径：
    · `matched_total` —— 完整匹配行数；**算不出来就传 None**（不写 0）。
    · `exact` —— 计数是否精确（与明细同一读取边界才是 True）。
    · `details_complete` —— 明细是否完整返回（`returned_rows == matched_total`）。
    · `aggregate_complete` —— 聚合是否覆盖完整授权匹配范围；**没有聚合就 None**。
    · `exceptions` —— 结构化异常（不支持的字段类型／无效值／限额／超时／未执行）。
    """
    queried_at = queried_at or _now()
    criteria = {
        "filters": dict(filters or {}),
        "search": str(search or ""),
        "sort": str(sort or ""),
        "direction": str(direction or ""),
        "counting": str(counting or "row"),
        "page": int(page or 1),
        "page_length": int(page_length) if page_length is not None else None,
    }
    receipt = {
        "version": RECEIPT_VERSION,
        "query_id": _query_id(object_id, criteria, queried_at),
        "target": {"object_id": str(object_id or ""),
                   "name": str(object_name or ""),
                   "domain_id": str(domain_id or "")},
        "counts": {"matched_total": matched_total,
                   "returned_rows": int(returned_rows or 0),
                   "exact": bool(exact)},
        "completeness": {"details_complete": details_complete,
                          "detail_rows": int(returned_rows or 0),
                          "matched_rows": matched_total,
                          "aggregate_complete": aggregate_complete},
        "criteria": criteria,
        "scope": {"authorized": True, "record_scope": str(scope or "active")},
        "time": {"queried_at": str(queried_at)},
        "exceptions": list(exceptions or []),
    }
    return receipt
