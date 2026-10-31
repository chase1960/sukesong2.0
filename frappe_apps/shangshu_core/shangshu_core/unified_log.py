"""统一日志库（内核契约 `contracts/unified-log-v1.json`）。

**一张主表**（`Shangshu Unified Log`）承载四类平台操作痕迹 ＋ 各域自己的过程记录：
动作执行审计／事件信封／AI 执行审计／域变更审计 —— 都变成同一种行（九个通用字段）。

规矩（来自契约，别在别处另写一套）：
- 日志记「**这次操作涉及了什么值**」（输入、变更前后值、结果摘要）；
  **不记「那条记录的当前值」**（当前值住在受管记录里，那是唯一事实）。
- 写下就锁住（不可改）。
- **域专属字段按域分表存**（`per_domain`）：每张扩展表的每一行都带主行的 `log_no`；
  **域被拔掉 ⇒ 它那张扩展表连同字段一起消失**，主表与别域不受影响。
- **分表存 ≠ 另开日志库**：主日志表只有一张、写入只有一处。
  以后加字段＝加在该域的扩展表里，**不许新开日志表**。

旧表（`Shangshu Action Execution Audit`／`Shangshu Event Envelope`／
`Shangshu AI Execution Audit`／`Shangshu Domain Change Audit`）保留表结构与历史行，
**不再新增**；读口把旧表的历史行与统一表的新行合并，**返回形状不变**。
"""
import json
import re
import hashlib
import secrets

import frappe
from frappe.utils import now_datetime


LOG_DOCTYPE = "Shangshu Unified Log"
LEGACY_AUDIT_DOCTYPE = "Shangshu Action Execution Audit"
LEGACY_EVENT_DOCTYPE = "Shangshu Event Envelope"
LEGACY_AI_DOCTYPE = "Shangshu AI Execution Audit"
LEGACY_DOMAIN_AUDIT_DOCTYPE = "Shangshu Domain Change Audit"

EXTENSION_PREFIX = "Shangshu Log Extension"

KINDS = ("action", "event", "tool", "domain_change", "process")
TRIGGER_SOURCES = ("user", "agent", "scheduled", "system", "unknown")
RESULTS = ("Succeeded", "Failed", "Delivering", "Rejected", "Unknown")

#: 九个通用字段（契约 `common_fields.required` 的落列；另加技术列与来源指针）。
COMMON_FIELDS = ("log_no", "occurred_at", "actor_user", "actor_identity", "trigger_source",
                 "domain_id", "what_kind", "what_id", "result", "business_object_id",
                 "business_name", "detail_json")

_SLUG = re.compile(r"[^A-Za-z0-9]+")

#: 旧表的状态标签 ↔ 统一表的 `result`（读口按旧标签筛，新行按 result 落）。
_STATUS_RESULTS = {
    "Succeeded": ("Succeeded",),
    "Failed": ("Failed",),
    "Published": ("Delivering",),
    "Delivered": ("Succeeded",),
    "Partial": ("Failed",),
}


# ---------- 小工具 ----------

def _json(raw, default=None):
    if raw in (None, ""):
        return default if default is not None else {}
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default if default is not None else {}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _slug(text):
    return _SLUG.sub("-", str(text or "")).strip("-").lower()


def normalize_trigger_source(source):
    """「怎么触发的」的口径：人点的／助手选的／定时跑的／系统跑的／不知道。

    旧表的 `executor_source` 存的是原样标签（user／scheduler／…）；
    统一表的 `trigger_source` 存**归一后的五档**（契约 `trigger_source` 的取值），
    旧标签原样留在 `detail_json` 的旧形状快照里 ⇒ 旧读口的形状不变。
    """
    value = str(source or "").strip().lower()
    if value in ("user", "human", "manual"):
        return "user"
    if value in ("agent", "ai", "assistant"):
        return "agent"
    if value in ("scheduled", "scheduler", "cron", "timer"):
        return "scheduled"
    if value in ("system", "background", "worker"):
        return "system"
    return "unknown"


def current_actor_identity():
    """当前执行身份（没有身份就留空 —— **写日志不许把正事搞失败**）。"""
    try:
        from shangshu_core.identity import get_identity
        return get_identity().name
    except Exception:
        return ""


def _result_filter(value):
    return _STATUS_RESULTS.get(str(value), (str(value),))


class LegacyRow(dict):
    """旧表形状的一行（dict ＋ 属性访问）—— 旧读口/旧调用点不用改写法。"""

    def __getattr__(self, item):
        try:
            return self[item]
        except KeyError:
            raise AttributeError(item)

    def as_dict(self):
        return dict(self)


# ---------- 写入 ----------

def write_log(kind, what_id, *, domain_id="com.shangshu.core", actor_user=None, actor_identity=None,
              trigger_source="unknown", result="Unknown", business_object_id="", business_name="",
              detail=None, reference_doctype=None, reference_name=None, idempotency_key=None,
              source_doctype=None, source_name=None, extension_values=None, occurred_at=None):
    """往统一日志表写一行（**整个平台只有这一个写入口**）。

    返回落好的那一行（`frappe.get_doc` 出来的文档，`log_no` 就是它的 `name`）。
    """
    _assert_log_write(kind, what_id, idempotency_key)
    if kind not in KINDS:
        frappe.throw("统一日志的类别不支持：%s" % kind, frappe.ValidationError)
    if result not in RESULTS:
        result = "Unknown"
    detail = dict(detail or {})
    entry = dict(kind=kind, what_id=what_id, domain_id=domain_id,
        actor_user=actor_user, actor_identity=actor_identity, trigger_source=trigger_source,
        result=result, business_object_id=business_object_id, business_name=business_name,
        detail=detail, reference_doctype=reference_doctype, reference_name=reference_name,
        idempotency_key=idempotency_key, source_doctype=source_doctype, source_name=source_name,
        occurred_at=occurred_at)
    existing = _locked_action_logs([idempotency_key] if kind == 'action' and idempotency_key else [])
    if idempotency_key and str(idempotency_key) in existing:
        doc = existing[str(idempotency_key)]
        _assert_action_log_replay(doc, entry)
        return doc
    log_no = _new_log_number(entry)
    doc = _log_document(entry, log_no)
    point = "log_target_" + frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    try:
        doc.insert(ignore_permissions=True)
        _write_package_targets([doc])
        _mark_action_logs([doc])
        if extension_values:
            write_extension(doc.log_no, doc.domain_id, extension_values)
    except Exception as error:
        from shangshu_core.transaction_failure import raise_if_transaction_failed
        raise_if_transaction_failed(error)
        frappe.db.rollback(save_point=point)
        raise
    return doc


def _log_document(entry, log_no):
    """单条和批量使用同一字段规范化；原生 DocType 校验在插入阶段运行。"""
    from shangshu_core.conversation_evidence import current_conversation_key
    return frappe.get_doc({
        "conversation_key": current_conversation_key(),
        "doctype": LOG_DOCTYPE,
        "log_no": log_no,
        "occurred_at": entry.get("occurred_at") or now_datetime(),
        "actor_user": entry.get("actor_user") or frappe.session.user,
        "actor_identity": entry.get("actor_identity") or "",
        "trigger_source": normalize_trigger_source(entry.get("trigger_source", "unknown")),
        "domain_id": str(entry.get("domain_id", "com.shangshu.core") or ""),
        "what_kind": entry["kind"],
        "what_id": str(entry.get("what_id") or ""),
        "result": entry.get("result") if entry.get("result") in RESULTS else "Unknown",
        "business_object_id": str(entry.get("business_object_id") or ""),
        "business_name": str(entry.get("business_name") or ""),
        "reference_doctype": str(entry.get("reference_doctype") or ""),
        "reference_name": str(entry.get("reference_name") or ""),
        "idempotency_key": str(entry.get("idempotency_key") or ""),
        "detail_json": _canonical(dict(entry.get("detail") or {})),
        "source_doctype": str(entry.get("source_doctype") or ""),
        "source_name": str(entry.get("source_name") or ""),
    })


def _action_digest(key):
    return hashlib.sha256(str(key).encode('utf-8')).hexdigest()


def _new_log_number(entry):
    key = entry.get('idempotency_key')
    return 'LOG-' + (_action_digest(key) if entry['kind'] == 'action' and key else secrets.token_hex(32))


def _locked_action_logs(keys):
    """按键互斥，绝不锁缺失日志的非唯一索引空隙。

    tabSeries 仅复用为小型原生协调行：0=本版尚未写日志，1=确定主键已写。
    marker 与日志同事务，断连/完整回滚同时恢复。升级须先排空旧版写者。
    """
    keys = sorted(set(str(key) for key in keys), key=_action_digest)
    for key in keys:
        frappe.db.sql('INSERT INTO `tabSeries` (`name`,`current`) VALUES (%s,0) '
                      'ON DUPLICATE KEY UPDATE `current`=`current`',
                      ('SS-LOG-KEY-' + _action_digest(key),))
    found = {}
    for key in keys:
        digest = _action_digest(key)
        # upsert 已有此主键；必须当前读，不能沿进入事务时的旧快照。
        state = frappe.db.sql('SELECT `current` FROM `tabSeries` WHERE `name`=%s FOR UPDATE',
                              ('SS-LOG-KEY-' + digest,))[0][0]
        if int(state) == 1:
            rows = frappe.db.sql('SELECT * FROM `tabShangshu Unified Log` WHERE name=%s FOR UPDATE',
                                 ('LOG-' + digest,), as_dict=True)
            if not rows or rows[0]['what_kind'] != 'action' or rows[0]['idempotency_key'] != key:
                frappe.throw('日志幂等索引不一致，不能自动重建', frappe.ValidationError)
        elif int(state) == 0:
            # 只读部署前已有、不可变的流水日志；不会把新hash行混入旧read-view。
            rows = frappe.db.sql('SELECT * FROM `tabShangshu Unified Log` '
                "WHERE what_kind='action' AND idempotency_key=%s AND name REGEXP '^LOG-[0-9]{4}-[0-9]{5,}$'",
                (key,), as_dict=True)
            if len(rows) > 1 or any(row['idempotency_key'] != key for row in rows):
                frappe.throw('历史日志幂等键不唯一或大小写不一致，请核验', frappe.ValidationError)
        else:
            frappe.throw('日志幂等索引状态无效', frappe.ValidationError)
        if rows:
            doc = frappe.get_doc({**dict(rows[0]), 'doctype': LOG_DOCTYPE})
            doc.set('__islocal', False)
            found[key] = doc
    return found


def _mark_action_logs(docs):
    for doc in docs:
        if doc.name != doc.log_no:
            frappe.throw('日志主键与日志编号不一致，本次日志未保存', frappe.ValidationError)
        if doc.what_kind == 'action' and doc.idempotency_key:
            frappe.db.sql('UPDATE `tabSeries` SET `current`=1 WHERE `name`=%s',
                          ('SS-LOG-KEY-' + _action_digest(doc.idempotency_key),))


def _assert_action_log_replay(doc, entry):
    """同键仅可复用同一事实；不能拿已有日志掩掉别人的/另一条记录的修改。"""
    expected = {
        "what_kind": entry["kind"],
        "idempotency_key": str(entry.get("idempotency_key") or ""),
        "what_id": str(entry.get("what_id") or ""),
        "domain_id": str(entry.get("domain_id", "com.shangshu.core") or ""),
        "actor_user": entry.get("actor_user") or frappe.session.user,
        "actor_identity": entry.get("actor_identity") or "",
        "business_object_id": str(entry.get("business_object_id") or ""),
        "business_name": str(entry.get("business_name") or ""),
        "reference_doctype": str(entry.get("reference_doctype") or ""),
        "reference_name": str(entry.get("reference_name") or ""),
    }
    before = _json(doc.detail_json, {}).get("record_changes")
    incoming = (entry.get("detail") or {}).get("record_changes")
    before_package = _json(doc.detail_json, {}).get("package")
    incoming_package = (entry.get("detail") or {}).get("package")
    if (any(str(doc.get(key) or "") != str(value) for key, value in expected.items())
            or before != incoming or before_package != incoming_package):
        frappe.throw("审计幂等键已用于不同记录或不同变更，本包未保存", frappe.ValidationError)


def _write_package_targets(documents):
    packaged = [doc for doc in documents if doc.what_kind == "action" and "package" in _json(doc.detail_json, {})]
    if packaged:
        from shangshu_core.log_targets import write_log_targets
        write_log_targets(packaged)


def _assert_log_write(kind, what_id, idempotency_key):
    from shangshu_core.action_packages import assert_log_write
    assert_log_write(kind, what_id, idempotency_key)


def _prepare_log_insert(doc):
    """Frappe v15 的插入前生命周期；只接本内核无子表、不可变日志。

    复用原生校验与 hooks，不以 bulk_insert 绕过 validate/links/mandatory。
    插入前阶段与插入后阶段分开，仅让中间的物理 INSERT 合批。
    """
    if doc.doctype != LOG_DOCTYPE or doc.meta.issingle or doc.meta.get_table_fields() or doc.get("amended_from"):
        frappe.throw("批量审计只支持无子表的统一日志", frappe.ValidationError)
    doc.flags.notifications_executed = []
    doc.flags.ignore_permissions = True  # 同原唯一内部写口；不改变记录动作的授权。
    doc.set("__islocal", True)
    doc._set_defaults()
    doc.set_user_and_timestamp()
    doc.set_docstatus()
    doc.check_permission("create")
    doc.check_if_latest()
    doc._validate_links()
    doc.run_method("before_insert")
    doc.set_new_name()
    doc.set_parent_in_children()
    doc.validate_higher_perm_levels()
    doc.flags.in_insert = True
    try:
        doc.run_before_save_methods()
        doc._validate()
        doc.set_docstatus()
    finally:
        doc.flags.in_insert = False
    if doc.name != doc.log_no:
        frappe.throw("统一日志编号与记录身份不一致", frappe.ValidationError)


def _finish_log_insert(doc):
    """物理写入成功后执行原生 after_insert/on_update/on_change 等钩子。"""
    from frappe.model.document import follow_document, relink_mismatched_files
    doc.set("__islocal", False)  # 与原生 db_insert 完成后的状态相同。
    doc.run_method("after_insert")
    doc.flags.in_insert = True
    try:
        relink_mismatched_files(doc)
        doc.run_post_save_methods()
    finally:
        doc.flags.in_insert = False
    for name in ("__islocal", "__unsaved"):
        if hasattr(doc, name):
            delattr(doc, name)
    if not (frappe.flags.in_migrate or frappe.local.flags.in_install or frappe.flags.in_setup_wizard):
        if frappe.get_cached_value("User", frappe.session.user, "follow_created_documents"):
            follow_document(doc.doctype, doc.name, frappe.session.user)


def _insert_log_documents(docs):
    for doc in docs:
        _prepare_log_insert(doc)
    # 与 db_insert 使用同一序列化；保留元数据和 NULL，不引入第二份字段白名单。
    rows = [doc.get_valid_dict(convert_dates_to_str=True, ignore_virtual=True) for doc in docs]
    columns = list(dict.fromkeys(key for row in rows for key in row))
    chunk, size = [], 0
    for row in rows:
        values = tuple(row.get(key) for key in columns)
        row_size = sum(len(str(value).encode("utf-8")) for value in values if value is not None)
        if chunk and (len(chunk) >= 500 or size + row_size > 1024 * 1024):
            frappe.db.bulk_insert(LOG_DOCTYPE, columns, chunk)
            chunk, size = [], 0
        chunk.append(values)
        size += row_size
    if chunk:
        frappe.db.bulk_insert(LOG_DOCTYPE, columns, chunk)
    for doc in docs:
        _finish_log_insert(doc)


def write_logs(entries):
    """同事务批量追加；按action幂等键互斥，不用全局编号锁。"""
    entries = [dict(entry) for entry in entries]
    if not entries:
        return []
    for entry in entries:
        _assert_log_write(entry.get('kind'), entry.get('what_id'), entry.get('idempotency_key'))
        if entry.get('kind') not in KINDS:
            frappe.throw('统一日志的类别不支持：%s' % entry.get('kind'), frappe.ValidationError)
    def action_key(entry):
        return str(entry.get('idempotency_key') or '') if entry['kind'] == 'action' else ''
    # 固定顺序一次取得本批全部key。读到成功日志后仍核内容，不能伪装成重放。
    existing = _locked_action_logs([action_key(e) for e in entries if action_key(e)])
    point = 'unified_log_' + frappe.generate_hash(length=12)
    frappe.db.savepoint(point)
    try:
        docs, outputs, created = [], [], []
        for entry in entries:
            key = action_key(entry)
            if key and key in existing:
                doc = existing[key]
                _assert_action_log_replay(doc, entry)
            else:
                doc = _log_document(entry, _new_log_number(entry))
                docs.append(doc)
                created.append((doc, entry))
                if key:
                    existing[key] = doc
            outputs.append(doc)
        if len(docs) == 1:
            docs[0].insert(ignore_permissions=True)
        elif docs:
            _insert_log_documents(docs)
        _write_package_targets(docs)
        _mark_action_logs(docs)
        for doc, entry in created:
            if entry.get('extension_values'):
                write_extension(doc.log_no, doc.domain_id, entry['extension_values'])
        return outputs
    except Exception as error:
        from shangshu_core.transaction_failure import raise_if_transaction_failed
        raise_if_transaction_failed(error)
        frappe.db.rollback(save_point=point)
        raise


# ---------- 域专属扩展字段（按域分表，可解耦） ----------

def extension_doctype(domain_id):
    """某个域的扩展表名（一个域一张表；域没了这张表也没了）。"""
    return "%s %s" % (EXTENSION_PREFIX, _slug(domain_id))


def declare_extension_fields(domain_id, fields):
    """声明某个域的专属字段（在该域自己的扩展表里加列，**不许新开日志表**）。

    扩展表的每一行都带主行的 `log_no`（唯一）⇒ 读口按 `log_no` 接到主行上。
    """
    name = extension_doctype(domain_id)
    declared = [
        {"fieldname": "log_no", "fieldtype": "Data", "label": "日志编号", "reqd": 1,
         "unique": 1, "in_list_view": 1, "description": "主日志表那一行的编号（外键级）。"},
    ]
    for field in fields or []:
        declared.append({
            "fieldname": field["name"],
            "fieldtype": field.get("type", "Data"),
            "label": field.get("label") or field["name"],
            "reqd": 1 if field.get("reqd") else 0,
            "in_list_view": 1,
            "options": field.get("options"),
        })
    if frappe.db.exists("DocType", name):
        doc = frappe.get_doc("DocType", name)
        doc.set("fields", declared)
        doc.save(ignore_permissions=True)
    else:
        frappe.get_doc({
            "doctype": "DocType", "name": name, "module": "Shangshu Core", "custom": 1,
            "autoname": "hash", "fields": declared, "naming_rule": "By \"Naming Series\" field",
            "permissions": [{"role": "System Manager", "read": 1, "create": 1}],
        }).insert(ignore_permissions=True)
    frappe.db.commit()
    frappe.db.updatedb(name)
    frappe.clear_cache(doctype=name)
    return name


def remove_domain_extension(domain_id):
    """**域被拔掉 ⇒ 它的扩展字段随之消失**（连那张扩展表一起删）。

    主日志表与别域的扩展表**不受影响**（这里只碰这个域自己那一张）。
    """
    name = extension_doctype(domain_id)
    if not frappe.db.exists("DocType", name):
        return False
    from shangshu_core.database import execute_ddl
    try:
        frappe.delete_doc("DocType", name, force=True, ignore_permissions=True)
    except Exception:
        pass
    # 兜底：**表一定不能留下**（域被拔掉 ⇒ 它的字段随之消失）。
    execute_ddl("DROP TABLE IF EXISTS `tab%s`" % name)
    if frappe.db.exists("DocType", name):
        frappe.db.delete("DocType", name)
    frappe.clear_cache(doctype=name)
    return True


def extension_table_exists(domain_id):
    """这个域的扩展表还在不在（域在 ⇒ 字段读得到；域被拔掉 ⇒ 表没了、字段读不到）。"""
    name = extension_doctype(domain_id)
    if not frappe.db.exists("DocType", name):
        return False
    return bool(frappe.db.table_exists(name, cached=False))


def write_extension(log_no, domain_id, values):
    """往某个域的扩展表写一行（必带主行的 `log_no`）。"""
    name = extension_doctype(domain_id)
    if not frappe.db.exists("DocType", name):
        frappe.throw("该域没有声明扩展字段：%s" % domain_id, frappe.ValidationError)
    row = {"doctype": name, "log_no": log_no}
    row.update({str(key): value for key, value in (values or {}).items()})
    return frappe.get_doc(row).insert(ignore_permissions=True)


def read_extension(log_no):
    """按主行的 `log_no` 取该域的专属字段（取不到 ⇒ `None`）。"""
    row = frappe.db.get_value(LOG_DOCTYPE, log_no, ["name", "domain_id"], as_dict=True)
    if not row:
        return None
    name = extension_doctype(row.domain_id)
    if not frappe.db.exists("DocType", name):
        return None
    rows = frappe.get_all(name, filters={"log_no": log_no}, pluck="name", limit=1)
    if not rows:
        return None
    doc = frappe.get_doc(name, rows[0])
    return {field.fieldname: doc.get(field.fieldname)
            for field in doc.meta.fields
            if field.fieldname not in ("name", "creation", "modified", "owner", "modified_by",
                                       "docstatus", "idx", "parent", "parentfield", "parenttype")}


def read_log(name):
    """取一行日志：九个通用字段 ＋ 详情 ＋ 该域的专属字段。"""
    doc = frappe.get_doc(LOG_DOCTYPE, name)
    data = {field: doc.get(field) for field in COMMON_FIELDS}
    data["detail"] = _json(doc.get("detail_json"), {})
    data["extension"] = read_extension(doc.log_no) or {}
    return data


# ---------- 读口：统一表的新行投影成旧表形状，与旧表历史行合并 ----------

def project_action_row(row):
    """统一表的一行 ⇒ 旧表（`Shangshu Action Execution Audit`）形状的一行。"""
    detail = _json(row.get("detail_json"), {})
    legacy = detail.get("legacy") if isinstance(detail.get("legacy"), dict) else {}
    out = dict(legacy)
    out["name"] = row.get("name")
    out["creation"] = row.get("creation")
    out["action_id"] = legacy.get("action_id") or row.get("what_id")
    out["actor_user"] = legacy.get("actor_user") or row.get("actor_user")
    out["actor_identity"] = legacy.get("actor_identity") or row.get("actor_identity")
    out["status"] = legacy.get("status") or row.get("result")
    out["idempotency_key"] = legacy.get("idempotency_key") or row.get("idempotency_key")
    out["executor_source"] = legacy.get("executor_source") or row.get("trigger_source")
    out["business_object_id"] = legacy.get("business_object_id") or row.get("business_object_id")
    out["business_name"] = legacy.get("business_name") or row.get("business_name")
    out["reference_doctype"] = legacy.get("reference_doctype") or row.get("reference_doctype")
    out["reference_name"] = legacy.get("reference_name") or row.get("reference_name")
    out["conversation_key"] = row.get("conversation_key")
    out["package"] = detail.get("package")
    return out


def project_event_row(row):
    """统一表的一行 ⇒ 旧表（`Shangshu Event Envelope`）形状的一行。"""
    detail = _json(row.get("detail_json"), {})
    legacy = detail.get("legacy") if isinstance(detail.get("legacy"), dict) else {}
    out = dict(legacy)
    out["name"] = row.get("name")
    out["published_at"] = legacy.get("published_at") or row.get("occurred_at") or row.get("creation")
    out["event_id"] = legacy.get("event_id") or row.get("what_id")
    out["actor_user"] = legacy.get("actor_user") or row.get("actor_user")
    out["actor_identity"] = legacy.get("actor_identity") or row.get("actor_identity")
    out["business_object_id"] = legacy.get("business_object_id") or row.get("business_object_id")
    out["business_name"] = legacy.get("business_name") or row.get("business_name")
    return out


_FIELD_MAP = {
    "conversation_key": "conversation_key",
    "action_id": "what_id",
    "actor_user": "actor_user",
    "actor_identity": "actor_identity",
    "idempotency_key": "idempotency_key",
    "reference_doctype": "reference_doctype",
    "reference_name": "reference_name",
    "business_object_id": "business_object_id",
    "business_name": "business_name",
    "name": "name",
    "creation": "creation",
}
_UNIFIED_READ_FIELDS = [
    "name", "log_no", "creation", "occurred_at", "actor_user", "actor_identity",
    "trigger_source", "domain_id", "what_kind", "what_id", "result",
    "business_object_id", "business_name", "reference_doctype", "reference_name",
    "idempotency_key", "detail_json", "source_doctype", "source_name", "conversation_key",
]


def _log_comparison(expression, value, params, prefix):
    """只接受已知条件操作符；字段来自白名单，值始终参数化。"""
    operator, operand = "=", value
    if isinstance(value, (list, tuple)):
        if len(value) != 2:
            frappe.throw("日志筛选条件格式无效", frappe.ValidationError)
        operator, operand = str(value[0]).lower().strip(), value[1]
    if operator not in ("=", "!=", "<>", ">", ">=", "<", "<=", "in", "not in",
                        "like", "not like", "between", "is"):
        frappe.throw("不支持的日志筛选操作符：%s" % operator, frappe.ValidationError)
    if operator == "is":
        if operand not in ("set", "not set"):
            frappe.throw("日志 is 条件仅支持 set / not set", frappe.ValidationError)
        return "COALESCE(%s, '') %s ''" % (expression, "!=" if operand == "set" else "=")
    if operator in ("in", "not in", "between"):
        if not isinstance(operand, (list, tuple)) or (operator == "between" and len(operand) != 2):
            frappe.throw("日志筛选集合格式无效", frappe.ValidationError)
        if not operand:
            return "1 = 0" if operator == "in" else "1 = 1"
        slots = []
        for i, item in enumerate(operand):
            if isinstance(item, (dict, list, tuple)):
                frappe.throw("日志筛选值必须是标量", frappe.ValidationError)
            key = "%s_%s" % (prefix, i)
            params[key] = item
            slots.append("%%(%s)s" % key)
        if operator == "between":
            return "%s BETWEEN %s AND %s" % (expression, slots[0], slots[1])
        return "%s %s (%s)" % (expression, operator.upper(), ", ".join(slots))
    if isinstance(operand, (dict, list, tuple)):
        frappe.throw("日志筛选值必须是标量", frappe.ValidationError)
    if operand is None and operator in ("=", "!=", "<>"):
        return "%s IS %sNULL" % (expression, "" if operator == "=" else "NOT ")
    params[prefix] = operand
    return "%s %s %%(%s)s" % (expression, operator, prefix)


def _source_predicate(value, params, prefix, projector):
    """读显式迁移创建的事实投影；缺列立即报错，绝不在查询中 DDL/退回 JSON 扫描。"""
    if not isinstance(value, str):
        frappe.throw("executor_source 必须是字符串", frappe.ValidationError)
    if projector is project_action_row:
        source = "action"
    elif projector is project_event_row:
        source = "event"
    else:
        frappe.throw("自定义日志投影不支持来源筛选", frappe.ValidationError)
    # 短键没有截断：超过 191 字节的事实生成 NULL，长请求精确比较完整二进制列。
    suffix = "key" if len(value.encode("utf-8")) <= 191 else "source"
    params[prefix] = value
    params[prefix + "_normalized"] = normalize_trigger_source(value)
    return "(`ssq_%s_%s_v1` = BINARY %%(%s)s OR `ssq_legacy_key_v1` = BINARY %%(%s_normalized)s)" % (
        source, suffix, prefix, prefix)


def _source_index_hint(filters):
    # MariaDB 会误选只含 kind/identity 的索引并逐行回表读大日志；短来源的完整
    # OR 两支、授权列和页键均在这一版本覆盖索引中。长值仍走完整投影列。
    source = (filters or {}).get("executor_source")
    return (" FORCE INDEX (`ssq_source_scope_v1`)" if isinstance(source, str)
            and len(source.encode("utf-8")) <= 191
            and not (set(filters or {}) - {"executor_source", "actor_identity", "creation"}) else "")


def _log_predicate(kind, filters, params, prefix, *, unified, projector=None, record_action_ids=None, record_object_id=None, target_plan=None):
    projector = projector or project_action_row
    if kind not in KINDS:
        frappe.throw("不支持的日志类型：%s" % kind, frappe.ValidationError)
    if filters is not None and not isinstance(filters, dict):
        frappe.throw("日志筛选必须是对象", frappe.ValidationError)
    clauses = []
    target_direct, target_links = [], []
    if unified:
        params[prefix + "_kind"] = kind
        clauses.append("`what_kind` = %%(%s_kind)s" % prefix)
    for i, (key, value) in enumerate((filters or {}).items()):
        if key not in _FIELD_MAP and key not in ("status", "executor_source"):
            frappe.throw("不支持的日志筛选字段：%s" % key, frappe.ValidationError)
        if key == "conversation_key" and not unified:
            clauses.append("1 = 0")
            continue
        param = "%s_%s" % (prefix, i)
        if key == "executor_source" and unified:
            clauses.append(_source_predicate(value, params, param, projector))
            continue
        if key == "executor_source" and kind == "event":
            # 旧 Event Envelope 没有 executor_source/trigger_source；旧 Python
            # _keep 对任何字符串来源都不匹配，不能查询一个不存在的旧表列。
            clauses.append("1 = 0")
            continue
        if key == "status" and unified:
            if not isinstance(value, str):
                frappe.throw("status 必须是字符串", frappe.ValidationError)
            expression, value = "`result`", ["in", list(_result_filter(value))]
        else:
            field = _FIELD_MAP.get(key, key) if unified else key
            expression = "`%s`" % field
        if unified and key in ("reference_doctype", "reference_name", "business_object_id", "business_name"):
            target_direct.append(_log_comparison(expression, value, params, param))
            target_links.append(_log_comparison("log_target.`%s`" % field, value, params, param))
            continue
        clauses.append(_log_comparison(expression, value, params, param))
    if record_action_ids is not None:
        action = _log_comparison("`what_id`" if unified else "`action_id`",
                                 ["in", record_action_ids], params, prefix + "_history_actions")
        if unified:
            if not target_direct:
                frappe.throw("记录历史必须指定目标", frappe.ValidationError)
            target_direct.append(action)
        else:
            clauses.append(action)
    if record_object_id is not None:
        object_match = _log_comparison("`business_object_id`", record_object_id, params, prefix + "_history_object")
        # 旧单条未保存对象号仍走原 reference 兼容路；已知对象号不能跨对象。
        compatible = "(COALESCE(`business_object_id`, '') = '' OR %s)" % object_match
        if unified:
            target_direct.append(compatible)
            target_links.append(_log_comparison("log_target.`business_object_id`", record_object_id,
                                                 params, prefix + "_history_object"))
        else:
            clauses.append(compatible)
    if target_links:
        if target_plan is not None:
            target_plan.update(direct=" AND ".join(target_direct), links=" AND ".join(target_links))
        else:
            clauses.append("((%s) OR EXISTS (SELECT 1 FROM `tabShangshu Log Target` log_target "
                           "WHERE log_target.log_no = `tabShangshu Unified Log`.`name` AND %s))" % (
                               " AND ".join(target_direct), " AND ".join(target_links)))
    return " AND ".join(clauses) or "1 = 1"


def _log_order(order_by):
    """现有读口只按 creation/name 排序；补足同一时刻的稳定主键次序。"""
    parts = []
    for term in str(order_by or "creation desc, name desc").split(","):
        match = re.fullmatch(r"\s*(creation|name)(?:\s+(asc|desc))?\s*", term, re.I)
        if not match or match.group(1).lower() in [field for field, _ in parts]:
            frappe.throw("不支持的日志排序", frappe.ValidationError)
        parts.append((match.group(1).lower(), (match.group(2) or "asc").upper()))
    if "name" not in [field for field, _ in parts]:
        parts.append(("name", parts[0][1]))
    return ", ".join("`%s` %s" % part for part in parts)


def _log_limit(length, start, params):
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in (length, start)):
        frappe.throw("日志分页必须是非负整数", frappe.ValidationError)
    if not length and not start:
        return ""
    params["page_length"] = length or 9223372036854775807
    params["page_start"] = start
    return " LIMIT %(page_length)s OFFSET %(page_start)s"


def unified_rows(kind, filters=None, order_by="creation desc, name desc",
                 limit_page_length=0, limit_start=0):
    """统一日志内部读口；调用方先决定独立日志权限，所有条件在分页前生效。"""
    params = {}
    where = _log_predicate(kind, filters, params, "new", unified=True)
    order = _log_order(order_by)
    limit = _log_limit(limit_page_length, limit_start, params)
    return frappe.db.sql("SELECT %s FROM `tab%s`%s WHERE %s ORDER BY %s%s" % (
        ", ".join("`%s`" % field for field in _UNIFIED_READ_FIELDS), LOG_DOCTYPE, _source_index_hint(filters), where, order, limit),
        params, as_dict=True)


def _keep(row, requested):
    """旧投影来源筛选的兼容判据；生产查询已将同一条件下推到 SQL。"""
    for key, value in (requested or {}).items():
        if key == "executor_source":
            if row.get("executor_source") != value and row.get("trigger_source") != normalize_trigger_source(value):
                return False
    return True


def _merged_predicates(legacy_doctype, kind, filters, projector, record_action_ids=None, record_object_id=None):
    legacy_tables = {"action": LEGACY_AUDIT_DOCTYPE, "event": LEGACY_EVENT_DOCTYPE,
                     "tool": LEGACY_AI_DOCTYPE, "domain_change": LEGACY_DOMAIN_AUDIT_DOCTYPE}
    if legacy_tables.get(kind) != legacy_doctype:
        frappe.throw("不支持的旧日志表与日志类型组合", frappe.ValidationError)
    params = {}
    target_plan = {}
    old = _log_predicate(kind, filters, params, "old", unified=False, projector=projector, record_action_ids=record_action_ids, record_object_id=record_object_id)
    new = _log_predicate(kind, filters, params, "new", unified=True, projector=projector, record_action_ids=record_action_ids, record_object_id=record_object_id, target_plan=target_plan)
    return old, new, params, target_plan


def _unified_target_source(target_plan, filters):
    if not target_plan:
        return "`tabShangshu Unified Log`" + _source_index_hint(filters)
    # 两路都只取精确目标键；UNION 去重后按主键连事实，不能让一个包因多目标重复计数。
    # 权限/状态仍在同一 SQL 的 WHERE 中，在 COUNT/ORDER/LIMIT 之前生效。
    return ("(SELECT name AS log_target_key FROM `tabShangshu Unified Log` "
            "WHERE `what_kind` = %(new_kind)s AND " + target_plan["direct"]
            + " UNION SELECT log_no AS log_target_key FROM `tabShangshu Log Target` log_target WHERE "
            + target_plan["links"] + ") log_target_keys JOIN `tabShangshu Unified Log` "
            "ON `tabShangshu Unified Log`.name = log_target_keys.log_target_key")


def merged_legacy_rows(legacy_doctype, kind, filters=None, fields=None,
                       order_by="creation desc, name desc", limit_page_length=0, limit_start=0,
                       projector=None, record_action_ids=None, record_object_id=None):
    """先合并有权限的页键，再装配当前页旧形状详情；深页不读取此前所有 detail_json。"""
    projector = projector or project_action_row
    old, new, params, target_plan = _merged_predicates(legacy_doctype, kind, filters, projector, record_action_ids, record_object_id)
    order = _log_order(order_by)
    limit = _log_limit(limit_page_length, limit_start, params)
    keys = frappe.db.sql(
        "SELECT origin, name, creation FROM ("
        "SELECT 0 AS origin, name, creation FROM `tab%s` WHERE %s UNION ALL "
        "SELECT 1 AS origin, name, creation FROM %s WHERE %s"
        ") AS matched ORDER BY %s, origin ASC%s" % (legacy_doctype, old, _unified_target_source(target_plan, filters), new, order, limit),
        params, as_dict=True)
    # 不按 name 跨表去重：两个表中的同名记录仍是两条独立历史事实。
    old_names = [row["name"] for row in keys if not row["origin"]]
    new_names = [row["name"] for row in keys if row["origin"]]
    payloads = {}
    if old_names:
        for row in frappe.get_all(legacy_doctype, filters={"name": ["in", old_names]},
                                  fields=["*"], limit_page_length=0):
            payloads[(0, row["name"])] = row
    if new_names:
        for row in frappe.get_all(LOG_DOCTYPE, filters={"name": ["in", new_names]},
                                  fields=_UNIFIED_READ_FIELDS, limit_page_length=0):
            payloads[(1, row["name"])] = projector(row)
    merged = [frappe._dict(payloads[(row["origin"], row["name"])]) for row in keys]
    if fields:
        merged = [frappe._dict({field: row.get(field) for field in fields}) for row in merged]
    return merged


def merged_legacy_count(legacy_doctype, kind, filters=None, projector=None, record_action_ids=None, record_object_id=None):
    """与列表共用条件，数据库直接返回旧表与统一表总数；不读取任何详情行。"""
    old, new, params, target_plan = _merged_predicates(legacy_doctype, kind, filters, projector or project_action_row, record_action_ids, record_object_id)
    rows = frappe.db.sql(
        "SELECT (SELECT COUNT(*) FROM `tab%s` WHERE %s) + "
        "(SELECT COUNT(*) FROM %s WHERE %s) AS total" % (legacy_doctype, old, _unified_target_source(target_plan, filters), new),
        params, as_dict=True)
    return int(rows[0]["total"])
