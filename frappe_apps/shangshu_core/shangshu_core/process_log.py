"""**域写自己的过程记录** —— 统一日志库的**公开写口**（§8 第 11 项）。

为什么单开一个模块（而不是直接暴露 `unified_log.write_log`）：

- **域只许依赖 `shangshu_core.public_api`** —— 公开口必须**窄**：
  域能写的只有「自己域的过程记录」，不是日志库的全部能力。
- **写口只有一处**（契约 `contracts/unified-log-v1.json` 的 `hard_rules`）：
  这里转手调 `unified_log.write_log`，**不另写一份写入逻辑**。

2026-10-23：这一笔把「域想记过程记录却没有路」这件事补上 ——
契约早就写着「新域要往日志库里记过程 ⇒ 走同一张表 ＋ 自己的扩展字段，不另开日志表」，
但写口一直是**内核内部**的 `unified_log.write_log`，域按规矩够不着。
"""
import frappe

from shangshu_core import unified_log


def write_process_record(what_id, *, domain_id, business_object_id="", business_name="",
                         result="Succeeded", trigger_source="unknown", detail=None,
                         extension_values=None, actor_user=None, actor_identity=None,
                         occurred_at=None):
    """**域写自己的过程记录**（`what_kind='process'`）—— **域只许走这个公开口**。

    写进去的是**过程痕迹**，不是正式值（正式值住在受管记录里）——
    日志只记「做了什么、跟哪条业务记录有关、结果如何」，**不抄业务值**。

    - `domain_id`：说清是哪个域的（**必填**）—— 域专属字段落在**那个域自己的扩展表**里。
    - `business_object_id` / `business_name`：跟哪条受管记录有关（只记编号，不抄值）。
    - `extension_values`：该域自己的专属字段（例：`{"case_ref": "CASE-001"}`）。
    - `actor_identity`：**不填就自动取当前身份** —— 日志读口的授权靠它缩小范围
      （「按业务标识缩小范围不放宽权限」）⇒ 不填身份 ⇒ **那几行谁都看不见**
      ⇒ 写进去等于没写。
    """
    if not domain_id:
        frappe.throw("写过程记录必须说清是哪个域的", frappe.ValidationError)
    return unified_log.write_log(
        "process", what_id,
        domain_id=domain_id,
        actor_user=actor_user,
        actor_identity=actor_identity if actor_identity is not None
        else unified_log.current_actor_identity(),
        trigger_source=trigger_source,
        result=result,
        business_object_id=business_object_id,
        business_name=business_name,
        detail=detail,
        extension_values=extension_values,
        occurred_at=occurred_at,
    )


def query_process_records(object_id, business_name=None, page=1, page_length=50):
    """**按受管记录取过程记录**（域写进来的那些 `what_kind='process'` 的行）。

    为什么要有这个读口（§8 第 11 项的另一半）：**写进去还得读得回来** ——
    否则那几行只是躺在表里，谁也看不见（等于没写）。

    授权：**与按受管记录取日志同一套独立日志授权**（`audit_query_filters`）——
    按业务标识缩小范围**不放宽权限**：看不到的员工的记录，照样看不到。

    返回：每条带 `log_no`（可点回原始记录）、`domain_id`、通用字段、
    `detail`（详情），以及**该域自己的专属字段**（`domain_fields`，
    从那域的扩展表接上来）。
    """
    import json

    from shangshu_core.audit_access import audit_query_filters

    object_id = str(object_id or "").strip()
    if not object_id:
        frappe.throw("请指定受管对象 ID", frappe.ValidationError)
    if business_name is not None:
        business_name = str(business_name).strip()
        if not business_name:
            frappe.throw("受管记录名无效", frappe.ValidationError)
    try:
        p, size = int(page), int(page_length)
    except (TypeError, ValueError):
        frappe.throw("日志分页参数无效", frappe.ValidationError)
    if isinstance(page, bool) or isinstance(page_length, bool) or p < 1 or size < 1 or size > 200:
        frappe.throw("日志页码须大于0，每页1至200条", frappe.ValidationError)

    # 独立日志授权必须在数据库读之前完成，业务记录只缩小范围，不授予日志权。
    scoped = audit_query_filters({}, "managed")
    raw = scoped.get("actor_identity")
    allowed = set()
    if (isinstance(raw, (list, tuple)) and len(raw) == 2 and raw[0] == "in"
            and isinstance(raw[1], (list, tuple, set))):
        allowed = {item for item in raw[1] if isinstance(item, str) and item}

    rows = []
    if allowed:
        # 仅内核固定日志表/列；所有业务编号、身份、页边界均绑定参数，不能拼成 SQL。
        # 用实际发生时间（旧行缺失时取 creation）排序，name 唯一补序保证同时间跨页稳定。
        where = ["what_kind = %s", "business_object_id = %s",
                 "actor_identity IN (" + ", ".join(["%s"] * len(allowed)) + ")"]
        values = ["process", object_id, *sorted(allowed)]
        if business_name:
            where.append("business_name = %s")
            values.append(business_name)
        rows = frappe.db.sql(
            "SELECT name, log_no, occurred_at, creation, actor_identity, actor_user, "
            "what_kind, domain_id, what_id, result, trigger_source, "
            "business_object_id, business_name, detail_json "
            "FROM `tabShangshu Unified Log` WHERE " + " AND ".join(where)
            + " ORDER BY COALESCE(occurred_at, creation) DESC, name DESC LIMIT %s OFFSET %s",
            [*values, size, (p - 1) * size], as_dict=True,
        )
    items = []
    for row in rows:
        # **fail-closed**：授权名单是空的 ⇒ 一条都不给（不是「全给」）。
        if row.get("actor_identity") not in allowed:
            continue
        try:
            detail = json.loads(row.get("detail_json") or "{}")
        except (TypeError, ValueError):
            detail = {}
        items.append({
            "kind": "process",
            "what_kind": row.get("what_kind"),
            "log_no": row.get("log_no"),
            "source_id": row.get("log_no"),
            "domain_id": row.get("domain_id"),
            "what_id": row.get("what_id"),
            "actor": {"user": row.get("actor_user")},
            "time": str(row.get("occurred_at") or row.get("creation") or ""),
            "status": row.get("result"),
            "source": row.get("trigger_source") or "unknown",
            "business_object_id": str(row.get("business_object_id") or ""),
            "business_name": str(row.get("business_name") or ""),
            "detail": detail,
            "domain_fields": unified_log.read_extension(row.get("log_no")) or {},
        })
    return {"items": items, "page": p, "page_length": size,
            "object_id": object_id,
            "business_name": str(business_name or ""),
            "scope": "managed", "llm_calls": 0}


def declare_process_log_fields(domain_id, fields):
    """**域声明自己的专属字段**（落在**它自己那张扩展表**里；域被拔掉 ⇒ 字段随之拔掉）。

    契约 `extension_fields.storage` ＝ `per_domain`（**按域分表**）——
    「以后加字段＝加在该域的扩展表里，**不许新开日志表**」。
    """
    if not domain_id:
        frappe.throw("声明专属字段必须说清是哪个域的", frappe.ValidationError)
    return unified_log.declare_extension_fields(domain_id, fields)
