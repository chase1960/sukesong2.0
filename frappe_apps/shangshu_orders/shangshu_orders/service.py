import frappe
from shangshu_core.public_api import get_request_context, require_roles, execute_registered_action
from shangshu_orders.domain import ACTIONS, FIELDS


def execute(action_id, payload, context):
    require_roles(*next(a[2] for a in ACTIONS if a[0]==action_id),'System Manager')
    if not context.get('confirmed'):
        frappe.throw('订单写入必须确认',frappe.PermissionError)
    if any(isinstance(v,str) and not v.strip() for v in payload.values()):
        frappe.throw('必填项不能只填写空格',frappe.ValidationError)
    previous = getattr(frappe.flags,'orders_write',False)
    frappe.flags.orders_write = True
    try:
        return _execute(action_id,payload)
    finally:
        frappe.flags.orders_write = previous


def _execute(action_id,payload):
    ctx = get_request_context()
    if action_id == 'orders.create':
        values = {k:payload.get(k) for k in FIELDS}
        if values['branch']=='External' and (not values.get('payee') or not values.get('amount_cents')):
            frappe.throw('外采必须填写收款单位和金额',frappe.ValidationError)
        if values['branch']=='Stock':
            values.update(payee='',amount_cents=0)
        doc = frappe.get_doc({'doctype':'Shangshu Order',**values,'enterprise_id':ctx['enterprise_id'],
            'applicant':ctx['user_name'],'status':'Draft','revision':1}).insert(ignore_permissions=True)
    else:
        doc = frappe.get_doc('Shangshu Order',payload['order'],for_update=True)
        if doc.enterprise_id != ctx['enterprise_id']:
            frappe.throw('无权处理该订单',frappe.PermissionError)
        if action_id!='orders.decide' and doc.applicant!=ctx['user_name']:
            frappe.throw('仅申请人可以修改或提交',frappe.PermissionError)
        if doc.revision != payload['revision']:
            frappe.throw('订单已更新，请刷新',frappe.ValidationError)
        if action_id in ('orders.edit','orders.submit') and doc.status not in ('Draft','Returned'):
            frappe.throw('只有草稿或仓管退回单可以修改提交',frappe.ValidationError)
        if action_id=='orders.edit':
            # 2026-10-13 R2：表格单格保存只送改动字段——只应用送来的键，没送的字段一字不动；
            # 分支规则按「合并后的结果」判（外采缺额/库存清空照旧），业务校验没关。
            values = {k:payload[k] for k in FIELDS if k in payload}
            branch = values.get('branch', doc.branch)
            if branch=='External' and (not values.get('payee', doc.payee) or not values.get('amount_cents', doc.amount_cents)):
                frappe.throw('外采必须填写收款单位和金额',frappe.ValidationError)
            if branch=='Stock':
                values.update(payee='',amount_cents=0)
            doc.update(values)
            doc.status='Draft'
        elif action_id=='orders.submit':
            if doc.branch=='Stock':
                doc.status='PendingWarehouse'
            else:
                funding = execute_registered_action('finance.funding.request',
                    {'source':doc.name,'purpose':doc.title,'payee':doc.payee,'amount_cents':doc.amount_cents},
                    confirmed=True,idempotency_key='orders-funding:'+doc.name)['result']
                doc.funding_request=funding['request']
                doc.status='PendingFinance'
        elif action_id=='orders.decide':
            if doc.status!='PendingWarehouse' or doc.branch!='Stock':
                frappe.throw('订单不在待仓管状态',frappe.ValidationError)
            doc.note=payload['note']
            if payload['decision']=='return':
                doc.status='Returned'
            else:
                stock = execute_registered_action('warehouse.issue',{'sku':doc.sku,'quantity':doc.quantity,
                    'source':'orders:'+doc.name,'note':payload['note']},confirmed=True,
                    idempotency_key='orders-issue:'+doc.name)['result']
                doc.movement=stock['movement']
                doc.status='Issued'
        doc.revision+=1
        doc.save(ignore_permissions=True)
    return {'order':doc.name,'status':doc.status,'revision':doc.revision,'funding_request':doc.funding_request or '',
            'movement':doc.movement or ''}


def permission_query(user=None):
    ctx=get_request_context()
    condition='enterprise_id='+frappe.db.escape(ctx['enterprise_id'])
    if 'System Manager' not in ctx['roles']:
        visible='applicant='+frappe.db.escape(ctx['user_name'])
        if 'Warehouse Manager' in ctx['roles']:
            visible+=" or (branch='Stock' and status in ('PendingWarehouse','Returned','Issued'))"
        condition+=' and ('+visible+')'
    return condition


def permission(doc,user=None,permission_type=None):
    if permission_type not in (None,'read','select','write','update'):
        return False
    if doc is None:
        return True
    ctx=get_request_context()
    if permission_type in ('write','update'):
        # 2026-10-13 R2：表格单格保存桥要过 doc.check_permission('write')，写权判定放行到
        # 「申请人（或超管）」——与 orders.edit 的「仅申请人可以修改」同一范围，不扩大。
        # 真正的写入闸没松：DocType validate 非动作标记即拒（orders_write），直接保存进不来。
        return doc.enterprise_id==ctx['enterprise_id'] and (
            'System Manager' in ctx['roles'] or doc.applicant==ctx['user_name'])
    return doc.enterprise_id==ctx['enterprise_id'] and ('System Manager' in ctx['roles'] or
        doc.applicant==ctx['user_name'] or ('Warehouse Manager' in ctx['roles'] and doc.branch=='Stock'
        and doc.status in ('PendingWarehouse','Returned','Issued')))
