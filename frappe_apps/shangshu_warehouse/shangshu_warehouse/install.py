import frappe
from shangshu_core.public_api import (
    ensure_registered_domains, ensure_immutable_triggers, register_action,
    register_domain_process_definition, publish_portal_definition,
)
from shangshu_warehouse.domain import ACTIONS, OUTPUT, DOMAIN, ACTION_INPUT, ROLES


def after_install():
    setup(False)


def after_migrate():
    setup(True)


def setup(triggers=True):
    if not frappe.db.exists("Role", "Warehouse Manager"):
        frappe.get_doc({"doctype": "Role", "role_name": "Warehouse Manager"}).insert(ignore_permissions=True)
    ensure_registered_domains()
    for action_id, title, schema in ACTIONS:
        register_action(action_id, "1.0.0", title, "write", "required", ROLES, schema, OUTPUT)
    definition_id = DOMAIN + ".receive"
    graph = {"schema_version": 2, "definition_id": definition_id, "business_object": "warehouse.stock",
        "form": {"input_schema": ACTION_INPUT, "field_order": ["sku", "quantity", "source", "note"]}, "nodes": [
            {"id": DOMAIN + ".node.receive", "type": "action", "title": "确认入库", "start": True,
             "terminal": True, "action_id": "warehouse.receive", "allowed_roles": ROLES}],
        "edges": []}
    created = register_domain_process_definition(definition_id, "登记入库", "warehouse.stock", graph)
    if created["created"]:
        publish_portal_definition(definition_id, created["draft_revision"])
    if triggers:
        ensure_immutable_triggers("Shangshu Stock Movement", "shangshu_stock_movement")
