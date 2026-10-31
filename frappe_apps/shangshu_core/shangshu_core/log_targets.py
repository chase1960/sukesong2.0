"""包日志的无值目标索引。事实只在主日志，索引与事实同事务写入。"""
import hashlib
import json

import frappe

DOCTYPE = "Shangshu Log Target"
FIELDS = ("log_no", "reference_doctype", "reference_name", "business_object_id", "business_name")
INDEXES = {
    "sslt_business_v1": ("business_object_id", "business_name", "log_no"),
    "sslt_reference_v1": ("reference_doctype", "reference_name", "log_no"),
    "sslt_log_v1": ("log_no",),
}


def package_targets(log_no, package):
    """一包同一目标只索引一次；记录多次变化仍完整保留在 package.steps 内。"""
    if not isinstance(package, dict) or package.get("version") != 1 or not isinstance(package.get("steps"), list):
        frappe.throw("包日志结构不支持", frappe.ValidationError)
    targets = set()
    for step in package["steps"]:
        if not isinstance(step, dict) or not isinstance(step.get("record_changes", []), list):
            frappe.throw("包日志步骤无效", frappe.ValidationError)
        for change in step.get("record_changes", []):
            if not isinstance(change, dict) or not isinstance(change.get("data"), dict):
                frappe.throw("包日志记录变更无效", frappe.ValidationError)
            doctype, name = change.get("doctype"), change.get("name")
            object_id = change["data"].get("object_id") or ""
            if (not isinstance(doctype, str) or not doctype or not isinstance(name, str) or not name
                    or not isinstance(object_id, str) or any(len(value) > 140 for value in (doctype, name, object_id))):
                frappe.throw("包日志目标身份无效", frappe.ValidationError)
            targets.add((str(log_no), doctype, name, object_id, name if object_id else ""))
    return sorted(targets)


def write_log_targets(documents):
    """只能由统一日志写口调用；一次批量写无值关系，不提交或异步补写。"""
    rows = []
    for doc in documents:
        detail = json.loads(doc.detail_json or "{}")
        if "package" not in detail:
            continue
        for target in package_targets(doc.log_no, detail["package"]):
            name = hashlib.sha256(json.dumps(target, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            rows.append((name, *target))
    if rows:
        frappe.db.bulk_insert(DOCTYPE, ("name", *FIELDS), rows, chunk_size=500)


def target_changes(package, *, doctype, name, object_id):
    """已授权且已分页的一个包中，只提取当前目标；不回传其他步骤/记录。"""
    if not isinstance(package, dict) or package.get("version") != 1:
        return []
    result = []
    for step in package.get("steps", []):
        for change in step.get("record_changes", []):
            data = change.get("data") or {}
            if (change.get("doctype") == doctype and change.get("name") == name
                    and data.get("object_id") == object_id):
                result.append((step, data))
    return result


def ensure_log_target_indexes():
    """Frappe 先同步 DocType，migrate 再显式验证/补齐索引，读口不运行 DDL。"""
    current = frappe.db.sql("SHOW INDEX FROM `tabShangshu Log Target`", as_dict=True)
    grouped = {}
    for row in current:
        grouped.setdefault(row["Key_name"], []).append(row)
    clauses = []
    for name, columns in INDEXES.items():
        actual = sorted(grouped.get(name, []), key=lambda row: row["Seq_in_index"])
        if actual:
            if (tuple(row["Column_name"] for row in actual) != columns or any(
                    row.get("Sub_part") is not None or row.get("Non_unique") != 1
                    or row.get("Index_type") != "BTREE" for row in actual)):
                raise RuntimeError("日志目标索引 %s 定义漂移，停止迁移" % name)
        else:
            clauses.append("ADD INDEX `%s` (%s)" % (name, ",".join("`%s`" % col for col in columns)))
    if clauses:
        frappe.db.sql_ddl("ALTER TABLE `tabShangshu Log Target` " + ",".join(clauses))
    return {"version": 1, "added": len(clauses)}
