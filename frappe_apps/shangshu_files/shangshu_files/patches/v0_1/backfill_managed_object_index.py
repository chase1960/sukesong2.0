"""把**存量**绑定的受管对象 id 补进 `managed_object_id` 那个带索引的字段。

⚠️ **为什么需要这一补**（原收敛条目 05 · 2026-10-27）：
`managed_object_id` 是那天**新加**的字段（受管记录变了要回填 ⇒ 反查要 O(1)）。
而**绑定是老数据就有的** ⇒ 那些文件的这个字段是**空的** ⇒ 反查查不到 ⇒
**核心公共动作**写进那些表的正式值**不会回填** ⇒ 文件与正式值**分叉**。
⇒ 补一次（**幂等**：只补该补的，不动已有的）。

⚠️ **不改绑定本身**：绑定（`meta['promotion_binding']`）是权威那份，
这个字段只是**索引**（同一件事的第二份查询入口）⇒ 补错了也不影响判定。
"""
import json

import frappe

FILE = "Shangshu File Center File"


def execute():
    if not frappe.db.has_column(FILE, "managed_object_id"):
        return
    rows = frappe.db.sql(
        "SELECT name, sheet_meta_json FROM `tab%s` "
        "WHERE IFNULL(managed_object_id, '') = ''" % FILE,
        as_dict=True)
    filled = 0
    for row in rows:
        try:
            meta = json.loads(row.get("sheet_meta_json") or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(meta, dict):
            continue
        object_id = str(((meta.get("promotion_binding") or {}).get("object_id")) or "").strip()
        if not object_id:
            continue
        frappe.db.set_value(FILE, row["name"], "managed_object_id", object_id,
                            update_modified=False)
        filled += 1
    if filled:
        frappe.db.commit()
