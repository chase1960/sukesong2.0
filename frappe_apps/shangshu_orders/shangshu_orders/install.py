from shangshu_core.public_api import ensure_registered_domains, register_action, register_domain_process_definition, publish_portal_definition
from shangshu_orders.domain import ACTIONS, DOMAIN


def setup():
    ensure_registered_domains()
    # 动作定义变更必须升版本（注册器拒同 key 改定义）：
    # 2026-10-13 R2 orders.edit 必填从「整单字段」放宽为「主键+版本」（表格单格保存=部分更新）。
    versions = {'orders.edit': '1.1.0'}
    for action,title,roles,schema in ACTIONS:
        register_action(action, versions.get(action, '1.0.0'), title, 'write', 'required', roles, schema, {})
    definition=DOMAIN+'.create'
    graph={'schema_version':2,'definition_id':definition,'business_object':'orders.order',
        'form':{'input_schema':ACTIONS[0][3],'field_order':['title','customer','sku','quantity','branch','payee','amount_cents']},
        'nodes':[{'id':DOMAIN+'.node.create','type':'action','title':'确认新建订单','start':True,'terminal':True,
                  'action_id':'orders.create','allowed_roles':['Desk User']}], 'edges':[]}
    created=register_domain_process_definition(definition,'新建订单','orders.order',graph)
    if created['created']:
        publish_portal_definition(definition,created['draft_revision'])


def create_workspace(idempotency_key='orders-workspace-v1'):
    """管理员显式配置组合应用；安装不自动替用户建立/覆盖工作面。"""
    from shangshu_core.public_api import create_application_definition, save_application_draft, publish_application_definition, list_domains
    app=create_application_definition('订单履约',idempotency_key)
    if app['published_revision']:
        return app
    if app['draft'].get('bindings'):
        return app  # 已编辑草稿属于用户，不用模板覆盖。
    domains={d['id']:d for d in list_domains()}
    resources={DOMAIN:{'datasets':['orders.order'],'actions':['orders.create']},
        'com.shangshu.warehouse':{'datasets':['warehouse.stock','warehouse.movement']},
        'com.shangshu.finance':{'datasets':['finance.funding_request','finance.funding_transfer']}}
    bindings=[{'kind':kind,'resource_id':resource,'owner_domain':domain,'version':domains[domain]['version']}
        for domain,kinds in resources.items() for kind,ids in kinds.items() for resource in ids]
    app=save_application_draft(app['id'],{**app['draft'],'allowed_roles':['Desk User','Warehouse Manager','Finance Approver','Cashier'],
        'bindings':bindings},app['draft_revision'])
    publish_application_definition(app['id'],app['draft_revision'])
    return app
