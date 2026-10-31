"""仓库仅写本域；幂等、确认和审计复用公共 Action。"""
import hashlib
import frappe
from frappe.utils import nowdate
from shangshu_core.public_api import require_roles, assert_domain_enabled, get_request_context


def _id(enterprise, value):
    return hashlib.sha256((enterprise + ":" + value).encode()).hexdigest()


def execute(action_id, payload, context):
    require_roles("Warehouse Manager", "System Manager")
    assert_domain_enabled("com.shangshu.warehouse")
    if not context.get("confirmed"):
        frappe.throw("库存变动必须确认", frappe.PermissionError)
    if action_id not in ("warehouse.receive", "warehouse.issue", "warehouse.reverse"):
        frappe.throw("未知库存动作", frappe.ValidationError)
    previous = getattr(frappe.flags, "warehouse_write", False)
    frappe.flags.warehouse_write = True
    try:
        return _execute(action_id, payload)
    finally:
        frappe.flags.warehouse_write = previous


def _execute(action_id, payload):
    enterprise = get_request_context()["enterprise_id"]
    reversal = None
    if action_id == "warehouse.reverse":
        reversal = frappe.get_doc("Shangshu Stock Movement", payload["movement"])
        if reversal.enterprise_id != enterprise:
            frappe.throw("无权读取该库存流水", frappe.PermissionError)
        if reversal.reversal_of:
            frappe.throw("反向流水不可再次冲销", frappe.ValidationError)
        sku, quantity = reversal.sku, -int(reversal.quantity)
        source = "reverse:" + reversal.name
    else:
        sku = payload["sku"].strip()
        if not sku:
            frappe.throw("请填写商品编码", frappe.ValidationError)
        quantity = int(payload["quantity"]) * (1 if action_id == "warehouse.receive" else -1)
        source = payload["source"].strip()
        if not source:
            frappe.throw("请填写来源单号", frappe.ValidationError)
    item_id = _id(enterprise, sku)
    # 同一 SKU 串行化。首次余额由唯一名称建立，重复初建由数据库唯一键拒绝，
    # 调用者可用原幂等键重试，不能产生双余额。
    if not frappe.db.exists("Shangshu Stock Item", item_id):
        if quantity < 0:
            frappe.throw("库存不足", frappe.ValidationError)
        item = frappe.get_doc({"doctype": "Shangshu Stock Item", "name": item_id,
                              "enterprise_id": enterprise, "sku": sku, "quantity": 0})
        item.insert(ignore_permissions=True)
    # 加锁和读取必须是同一当前读，不能锁后再用 REPEATABLE READ 旧快照取余额。
    item = frappe.get_doc("Shangshu Stock Item", item_id, for_update=True)
    movement_id = _id(enterprise, source)
    if frappe.db.exists("Shangshu Stock Movement", movement_id):
        old = frappe.get_doc("Shangshu Stock Movement", movement_id)
        if (old.sku != sku or old.quantity != quantity
                or (old.reversal_of or "") != (reversal.name if reversal else "")
                or (old.note or "") != payload.get("note", "")):
            frappe.throw("来源单号已用于不同库存变动", frappe.DuplicateEntryError)
        return {"movement": old.name, "sku": sku, "quantity": quantity}
    if int(item.quantity) + quantity < 0:
        frappe.throw("库存不足，未扣减；请补货后使用原请求重试", frappe.ValidationError)
    movement = frappe.get_doc({"doctype": "Shangshu Stock Movement", "name": movement_id,
        "enterprise_id": enterprise, "sku": sku, "quantity": quantity, "source": source,
        "business_date": nowdate(), "note": payload.get("note", ""),
        "reversal_of": reversal.name if reversal else None})
    movement.insert(ignore_permissions=True)
    item.quantity = int(item.quantity) + quantity
    item.save(ignore_permissions=True)
    return {"movement": movement.name, "sku": sku, "quantity": quantity}
