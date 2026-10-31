"""同一声明驱动注册、列表与动作表单；不复制通用页面。"""
from shangshu_core.public_api import query_object_records

DOMAIN = "com.shangshu.warehouse"
ROLES = ["Warehouse Manager"]
OUTPUT = {"type": "object", "additionalProperties": False, "required": ["movement", "sku", "quantity"],
          "properties": {"movement": {"type": "string"}, "sku": {"type": "string"}, "quantity": {"type": "integer"}}}
ACTION_INPUT = {
    "type": "object", "additionalProperties": False, "required": ["sku", "quantity", "source"],
    "properties": {
        "sku": {"type": "string", "title": "商品编码", "minLength": 1, "maxLength": 80},
        "quantity": {"type": "integer", "title": "数量", "minimum": 1, "maximum": 1000000000},
        "source": {"type": "string", "title": "来源单号", "minLength": 1, "maxLength": 140},
        "note": {"type": "string", "title": "备注", "maxLength": 500},
    },
}
REVERSE_INPUT = {"type": "object", "additionalProperties": False, "required": ["movement", "note"],
    "properties": {"movement": {"type": "string", "title": "原流水编号"},
                   "note": {"type": "string", "title": "更正原因", "minLength": 1, "maxLength": 500}}}
ACTIONS = [("warehouse.receive", "登记入库", ACTION_INPUT),
           ("warehouse.issue", "确认出库", ACTION_INPUT),
           ("warehouse.reverse", "冲销库存流水", REVERSE_INPUT)]
OBJECTS = [
    {"id": "warehouse.stock", "name": "现存库存", "doctype": "Shangshu Stock Item",
     "fields": [{"id": "name", "label": "编号", "type": "string"},
                {"id": "sku", "label": "商品编码", "type": "string"},
                {"id": "quantity", "label": "现存数量", "type": "integer"}],
     "record_actions": [{"action_id": "warehouse.receive", "bindings": {"sku": "sku"}},
                        {"action_id": "warehouse.issue", "bindings": {"sku": "sku"}}]},
    {"id": "warehouse.movement", "name": "出入库流水", "doctype": "Shangshu Stock Movement",
     "fields": [{"id": "name", "label": "流水编号", "type": "string"},
                {"id": "sku", "label": "商品编码", "type": "string"},
                {"id": "quantity", "label": "变动数量", "type": "integer"},
                {"id": "source", "label": "来源单号", "type": "string"},
                {"id": "business_date", "label": "业务日期", "type": "date"},
                {"id": "note", "label": "备注", "type": "string"},
                {"id": "reversal_of", "label": "冲销原流水", "type": "string"}],
     "record_actions": [{"action_id": "warehouse.reverse", "bindings": {"movement": "name"}}]},
]


def get_contribution():
    objects = [{**obj, "version": "1.0.0", "schema_version": 1, "operations": ["read"],
                "filter_fields": ["sku"]} for obj in OBJECTS]
    return {"id": DOMAIN, "name": "仓库", "owner_app": "shangshu_warehouse", "version": "0.1.0",
            "platform_api": ">=1.0 <2.0", "default_enabled": True,
            "applications": [{"id": DOMAIN + ".management", "title": "仓库管理", "icon": "库",
                "roles": ROLES, "home": "generated.overview", "processes_ids": []}],
            "objects": objects,
            "datasets": [{"id": obj["id"], "object_id": obj["id"], "name": obj["name"],
                "query": "shangshu_warehouse.domain.query", "roles": ROLES,
                "collection_actions": ["warehouse.receive"] if obj["id"] == "warehouse.stock" else [],
                "columns": [{"field": f["id"], "label": f["label"]} for f in obj["fields"] if f["id"] != "name"],
                "filters": [{"field": "sku", "label": "商品编码", "type": "text"}]} for obj in objects],
            "actions": [{"id": action[0], "handler": "shangshu_warehouse.service.execute"} for action in ACTIONS],
            "tools": [{"id": action[0]} for action in ACTIONS],
            "processes": [{"id": DOMAIN + ".receive", "title": "登记入库", "roles": ROLES}],
            "roles": [{"role": "Warehouse Manager", "label": "仓管", "capabilities": []}],
            "services": [], "events": [], "subscriptions": [], "navigation": [], "pages": [], "workbench": []}


def query(dataset_id, filters=None, page=1, page_length=30):
    result = query_object_records(dataset_id, filters, page, page_length)
    return {**result, "list": result["rows"]}
