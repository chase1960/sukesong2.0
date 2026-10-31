"""外采预付款：申请/审核与实际拨款登记分开，不冒充费用过账。"""
import hashlib
import frappe
from frappe.utils import nowdate
from shangshu_core.public_api import get_request_context, require_roles, query_object_records, register_action, ensure_immutable_triggers


def schema(properties, required=None):
    return {"type": "object", "properties": properties, "required": required or list(properties), "additionalProperties": False}


def text(title):
    return {"type": "string", "title": title, "minLength": 1, "maxLength": 140}


FIELDS = {"source": text("来源单号"), "purpose": text("采购用途"), "payee": text("收款单位"),
          "amount_cents": {"type": "integer", "title": "拨款金额（分）", "minimum": 1, "maximum": 1000000000}}
REFERENCE = {"request": text("拨款申请编号"), "revision": {"type": "integer", "title": "修订", "minimum": 1}}
ACTIONS = [
    ("finance.funding.request", "提交外采拨款申请", ["Desk User"], schema(FIELDS)),
    ("finance.funding.resubmit", "修改并重新提交", ["Desk User"], schema({**REFERENCE, **{k:v for k,v in FIELDS.items() if k != "source"}})),
    ("finance.funding.review", "审核拨款申请", ["Finance Approver"], schema({**REFERENCE,
        "decision": {"type": "string", "title": "审核结果", "enum": ["approve", "return"], "enumNames": ["通过", "退回"]},
        "note": text("审核意见")})),
    ("finance.funding.pay", "登记实际拨款", ["Cashier"], schema({**REFERENCE, "account": text("付款账户"), "receipt": text("付款凭据号")})),
]


def execute(action_id, payload, context):
    roles = next(item[2] for item in ACTIONS if item[0] == action_id)
    require_roles(*roles, "System Manager")
    if not context.get("confirmed"):
        frappe.throw("资金操作必须确认", frappe.PermissionError)
    old = getattr(frappe.flags, "finance_funding_write", False)
    frappe.flags.finance_funding_write = True
    try:
        return _execute(action_id, payload)
    finally:
        frappe.flags.finance_funding_write = old


def _execute(action_id, payload):
    ctx = get_request_context()
    if any(isinstance(v, str) and not v.strip() for v in payload.values()):
        frappe.throw("必填项不能只填写空格", frappe.ValidationError)
    if action_id == "finance.funding.request":
        name = hashlib.sha256((ctx["enterprise_id"] + ":" + ctx["identity_id"] + ":" + payload["source"]).encode()).hexdigest()
        if frappe.db.exists("Shangshu Funding Request", name):
            doc = frappe.get_doc("Shangshu Funding Request", name)
            if any(doc.get(k) != v for k,v in payload.items()):
                frappe.throw("来源单号已用于不同拨款申请", frappe.DuplicateEntryError)
        else:
            doc = frappe.get_doc({"doctype": "Shangshu Funding Request", "name": name, **payload,
                "enterprise_id": ctx["enterprise_id"], "applicant": ctx["user_name"], "status": "Pending", "revision": 1})
            doc.insert(ignore_permissions=True)
    else:
        doc = frappe.get_doc("Shangshu Funding Request", payload["request"], for_update=True)
        if doc.enterprise_id != ctx["enterprise_id"]:
            frappe.throw("无权办理该拨款申请", frappe.PermissionError)
        if doc.revision != payload["revision"]:
            frappe.throw("申请已更新，请刷新后办理", frappe.ValidationError)
        if action_id == "finance.funding.resubmit":
            if doc.applicant != ctx["user_name"]:
                frappe.throw("仅申请人可以修改重提", frappe.PermissionError)
            if doc.status != "Returned":
                frappe.throw("仅退回申请可以修改重提", frappe.ValidationError)
            doc.update({k:payload[k] for k in ("purpose", "payee", "amount_cents")})
            doc.status = "Pending"
        elif action_id == "finance.funding.review":
            if doc.status != "Pending":
                frappe.throw("申请不在待审核状态", frappe.ValidationError)
            if doc.applicant == ctx["user_name"]:
                frappe.throw("不能审核自己的拨款申请", frappe.PermissionError)
            doc.status = "Approved" if payload["decision"] == "approve" else "Returned"
            doc.review_note = payload["note"]
        elif action_id == "finance.funding.pay":
            if doc.status != "Approved":
                frappe.throw("必须先经财务审核，且不能重复拨款", frappe.ValidationError)
            if doc.applicant == ctx["user_name"]:
                frappe.throw("不能登记自己的拨款申请", frappe.PermissionError)
            transfer = frappe.get_doc({"doctype": "Shangshu Funding Transfer", "request": doc.name,
                "enterprise_id": doc.enterprise_id, "applicant": doc.applicant, "source": doc.source,
                "payee": doc.payee, "amount_cents": doc.amount_cents, "account": payload["account"],
                "receipt": payload["receipt"], "business_date": nowdate()}).insert(ignore_permissions=True)
            doc.transfer = transfer.name
            doc.status = "Paid"
        doc.revision += 1
        doc.save(ignore_permissions=True)
    return {"request": doc.name, "status": doc.status, "revision": doc.revision, "transfer": doc.transfer or ""}


def permission_query(user=None):
    ctx = get_request_context()
    condition = "enterprise_id=" + frappe.db.escape(ctx["enterprise_id"])
    if not {"System Manager", "Finance Approver", "Cashier"}.intersection(ctx["roles"]):
        condition += " and applicant=" + frappe.db.escape(ctx["user_name"])
    return condition


def permission(doc, user=None, permission_type=None):
    if permission_type not in (None, "read", "select"):
        return False
    if doc is None:
        return True
    ctx = get_request_context()
    return doc.enterprise_id == ctx["enterprise_id"] and (doc.applicant == ctx["user_name"] or bool(
        {"System Manager", "Finance Approver", "Cashier"}.intersection(ctx["roles"])))


def contributions():
    request_fields = [("name", "申请编号", "string"), ("source", "来源单号", "string"), ("purpose", "采购用途", "string"),
        ("payee", "收款单位", "string"), ("amount_cents", "金额（分）", "integer"), ("status", "状态", "enum"),
        ("review_note", "审核意见", "string"), ("revision", "修订", "integer"), ("transfer", "拨款流水", "string")]
    transfer_fields = [("name", "流水编号", "string"), ("source", "来源单号", "string"), ("payee", "收款单位", "string"),
        ("amount_cents", "金额（分）", "integer"), ("account", "付款账户", "string"), ("receipt", "付款凭据号", "string"), ("business_date", "付款日期", "date")]
    objects = [{"id": id_, "name": title, "doctype": dt, "version": "1.0.0", "schema_version": 1,
        "operations": ["read"], "filter_fields": ["source"],
        "fields": [{"id": k, "label": label, "type": t} for k,label,t in fields]}
        for id_,title,dt,fields in [("finance.funding_request", "外采拨款", "Shangshu Funding Request", request_fields),
                                   ("finance.funding_transfer", "拨款流水", "Shangshu Funding Transfer", transfer_fields)]]
    for field in objects[0]["fields"]:
        if field["id"] == "status":
            field["value_labels"] = {"Pending":"待财务审核", "Returned":"已退回", "Approved":"待拨款", "Paid":"已拨款"}
    objects[0]["record_actions"] = [{"action_id": action, "hidden": ["request", "revision"],
        "bindings": {"request": "name", "revision": "revision"}, "when": {"status": state},
        "when_actor": {"field": "applicant", "relation": relation}}
        for action,state,relation in [("finance.funding.resubmit", "Returned", "self"),
                                      ("finance.funding.review", "Pending", "other"),
                                      ("finance.funding.pay", "Approved", "other")]]
    return {"applications": [{"id": "com.shangshu.finance.funding", "title": "外采拨款", "icon": "款", "roles": ["Desk User", "Finance Approver", "Cashier"],
            "home": "generated.overview", "datasets_ids": [o["id"] for o in objects], "objects_ids": [o["id"] for o in objects], "processes_ids": [],
            "actions_ids": [a[0] for a in ACTIONS], "tools_ids": [a[0] for a in ACTIONS], "services_ids": [], "pages_ids": []}],
        "objects": objects, "datasets": [{"id": o["id"], "object_id": o["id"], "name": o["name"], "query": "shangshu_finance.funding.query",
            "collection_actions": ["finance.funding.request"] if o["id"] == "finance.funding_request" else [],
            "roles": ["Desk User", "Finance Approver", "Cashier"],
            "columns": [{"field": f["id"], "label": f["label"], **({"value_labels": {"Pending":"待财务审核", "Returned":"已退回", "Approved":"待拨款", "Paid":"已拨款"}} if f["id"] == "status" else {})}
                        for f in o["fields"] if f["id"] not in ("name", "revision", "transfer")],
            "filters": [{"field": "source", "label": "来源单号", "type": "text"}]} for o in objects],
        "actions": [{"id": a[0], "handler": "shangshu_finance.funding.execute"} for a in ACTIONS],
        "tools": [{"id": a[0]} for a in ACTIONS],
        "services": [{"id":"finance.funding.lifecycle", "handler":"shangshu_finance.funding.lifecycle", "roles":["System Manager"],
            "input_schema":{"type":"object","additionalProperties":False},
            "output_schema":{"type":"object","required":["blockers"],"properties":{"blockers":{"type":"array","items":{"type":"string"}}}}},
            {"id":"finance.funding.work","handler":"shangshu_finance.funding.work_items","roles":["Desk User","Finance Approver","Cashier"],"purpose":"work_items","effect":"read",
             "input_schema":{"type":"object","additionalProperties":False},"output_schema":{"type":"object","required":["items"],"properties":{"items":{"type":"array"}}}}]}


def lifecycle(_service, _payload, _context):
    # 仅 System Manager 生命周期服务；使用最新状态，不沿用停用等待前快照。
    rows = frappe.db.get_values('Shangshu Funding Request', {'status':['!=','Paid']}, ['name'], as_dict=True, for_update=True)
    return {'blockers': ['拨款申请尚未完成：' + row.name for row in rows]}


def work_items(_service, _payload, context):
    roles=set(context['roles'])
    def read(filters):
        return frappe.get_list('Shangshu Funding Request',filters=filters,
                               fields=['name','purpose','status','applicant'],order_by='modified desc',limit_page_length=100)
    rows=read({'status':'Returned','applicant':context['user_name']})
    if roles&{'Cashier','System Manager'}:
        rows+=read({'status':'Approved','applicant':['!=',context['user_name']]})
    if roles&{'Finance Approver','System Manager'}:
        rows+=read({'status':'Pending','applicant':['!=',context['user_name']]})
    labels={'Pending':'待财务审核','Returned':'退回补充','Approved':'待登记拨款'}
    return {'items':[{'dataset':'finance.funding_request','name':row.name,'title':row.purpose,'step':labels[row.status]} for row in rows[:100]]}


def query(dataset_id, filters=None, page=1, page_length=30):
    return query_object_records(dataset_id, filters, page, page_length)


def install(triggers=True):
    for action_id,title,roles,input_schema in ACTIONS:
        register_action(action_id, "1.0.0", title, "write", "required", roles, input_schema, {})
    if triggers:
        ensure_immutable_triggers("Shangshu Funding Transfer", "shangshu_funding_transfer")
