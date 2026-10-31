"""订单最小声明；列表、详情及办理复用平台组件。"""
from shangshu_core.public_api import query_object_records, get_object_record
import frappe

DOMAIN = 'com.shangshu.orders'
ROLES = ['Desk User', 'Warehouse Manager']


def text(title, maximum=140):
    return {'type':'string','title':title,'minLength':1,'maxLength':maximum}


FIELDS = {'title':text('订单事项'),'customer':text('客户'),'sku':text('商品编码',80),
    'quantity':{'type':'integer','title':'数量','minimum':1,'maximum':1000000000},
    'branch':{'type':'string','title':'采购类型','enum':['Stock','External'],'enumNames':['库存出库','外部采购']},
    'payee':text('外采收款单位'),'amount_cents':{'type':'integer','title':'外采金额（分）','minimum':1,'maximum':1000000000}}
REQUIRED = ['title','customer','sku','quantity','branch']
REF = {'order':text('订单编号'),'revision':{'type':'integer','title':'修订','minimum':1}}


def schema(properties, required):
    return {'type':'object','properties':properties,'required':required,'additionalProperties':False}


ACTIONS = [
    ('orders.create','新建订单',['Desk User'],schema(FIELDS,REQUIRED)),
    # 2026-10-13 R2：edit=部分更新（表格单格保存只送改动字段+主键版本）。原先必填整单字段，
    # 单格改一个标题就会被「缺必填」拒。记录级必填仍由 DocType 保存校验与下面的分支规则守。
    ('orders.edit','修改订单',['Desk User'],schema({**REF,**FIELDS},list(REF))),
    ('orders.submit','提交办理',['Desk User'],schema(REF,list(REF))),
    ('orders.decide','仓管处理',['Warehouse Manager'],schema({**REF,
        'decision':{'type':'string','title':'处理结果','enum':['approve','return'],'enumNames':['确认出库','退回修改']},
        'note':text('处理意见',500)},list(REF)+['decision','note'])),
]
STATUS = {'Draft':'草稿','Returned':'仓管退回','PendingWarehouse':'待仓管处理','Issued':'已出库','PendingFinance':'已转财务'}
FUNDING_STATUS = {'Pending':'待财务审核','Returned':'财务退回','Approved':'待拨款','Paid':'已拨款'}
OBJECT_FIELDS = [('name','订单编号','string'),('title','订单事项','string'),('customer','客户','string'),
    ('sku','商品编码','string'),('quantity','数量','integer'),('branch','采购类型','enum'),
    ('payee','外采收款单位','string'),('amount_cents','申请金额（分）','integer'),('status','办理状态','enum'),
    ('note','仓管意见','string'),('movement','出库流水','string'),('funding_request','财务申请','string'),('revision','修订','integer')]


def get_contribution():
    actions = []
    for state in ['Draft','Returned']:
        for branch in ['Stock','External']:
            fields=REQUIRED if branch=='Stock' else FIELDS
            actions.append({'action_id':'orders.edit','hidden':['order','revision'],'bindings':{'order':'name','revision':'revision',**{k:k for k in fields}},
                            'when':{'status':state,'branch':branch}})
        actions.append({'action_id':'orders.submit','hidden':['order','revision'],'bindings':{'order':'name','revision':'revision'},'when':{'status':state}})
    actions.append({'action_id':'orders.decide','hidden':['order','revision'],'bindings':{'order':'name','revision':'revision'},'when':{'status':'PendingWarehouse'}})
    obj = {'id':'orders.order','name':'订单','doctype':'Shangshu Order','version':'1.0.0','schema_version':1,
        'operations':['read'],'filter_fields':['name','title','customer','status'],
        'fields':[{'id':key,'label':label,'type':type_,**({'value_labels':STATUS} if key=='status' else
            {'value_labels':{'Stock':'库存出库','External':'外部采购'}} if key=='branch' else {})} for key,label,type_ in OBJECT_FIELDS],
        # 2026-10-13 R2：表格单格保存的桥。单元格编辑经本域写动作 orders.edit（确认/幂等/审计
        # 语义一致），业务校验与「仅申请人可改」都在动作里；version_field=revision 走动作的
        # expected_version 栈。可写列=orders.edit 接受的业务字段（name/status/revision 等不进表格写）。
        'native_table': {
            'doctype': 'Shangshu Order',
            'fields': [
                {'id': 'title', 'type': 'text', 'required': True},
                {'id': 'customer', 'type': 'text', 'required': True},
                {'id': 'sku', 'type': 'text', 'required': True},
                {'id': 'quantity', 'type': 'integer', 'required': True},
                {'id': 'branch', 'type': 'choice', 'options': ['Stock', 'External'], 'required': True},
                {'id': 'payee', 'type': 'text'},
                {'id': 'amount_cents', 'type': 'integer'},
            ],
            'version_field': 'revision',
            'search_fields': ['title', 'customer', 'sku'],
            'read_roles': ['Desk User', 'Warehouse Manager'],
            'write_roles': ['Desk User'],
            'write': {
                'update_action': 'orders.edit',
                'name_param': 'order',
                'version_param': 'revision',
            },
        },
        'record_actions':actions}
    columns = [{'field':key,'label':label} for key,label,_ in OBJECT_FIELDS if key in ('name','title','customer','sku','quantity','branch','status')]
    for column in columns:
        if column['field']=='branch':
            column['value_labels']={'Stock':'库存出库','External':'外部采购'}
        if column['field']=='status':
            column['value_labels']=STATUS
    columns.append({'field':'funding_status','label':'财务进度','value_labels':FUNDING_STATUS})
    return {'id':DOMAIN,'name':'订单','owner_app':'shangshu_orders','version':'0.1.0',
        'platform_api':'>=1.0 <2.0','default_enabled':True,
        'applications':[{'id':DOMAIN+'.management','title':'订单管理','icon':'单','roles':ROLES,'home':'generated.overview','processes_ids':[]}],
        'objects':[obj], 'datasets':[{'id':'orders.order','object_id':'orders.order','name':'订单',
            'query':'shangshu_orders.domain.query','roles':ROLES,'columns':columns,'collection_actions':['orders.create'],
            'filters':[{'field':'title','label':'订单事项','type':'text'},{'field':'customer','label':'客户','type':'text'}]}],
        'actions':[{'id':a[0],'handler':'shangshu_orders.service.execute'} for a in ACTIONS],
        'tools':[{'id':a[0]} for a in ACTIONS],
        'processes':[{'id':DOMAIN+'.create','title':'新建订单','roles':['Desk User']}],
        'lifecycle_service':'orders.lifecycle',
        'roles':[], 'services':[{'id':'orders.lifecycle','handler':'shangshu_orders.domain.lifecycle','roles':['System Manager'],
            'input_schema':{'type':'object','additionalProperties':False},
            'output_schema':{'type':'object','required':['blockers'],'properties':{'blockers':{'type':'array','items':{'type':'string'}}}}},
            {'id':'orders.work','handler':'shangshu_orders.domain.work_items','roles':ROLES,'purpose':'work_items','effect':'read',
             'input_schema':{'type':'object','additionalProperties':False},'output_schema':{'type':'object','required':['items'],'properties':{'items':{'type':'array'}}}}],
        'events':[], 'subscriptions':[], 'navigation':[], 'pages':[], 'workbench':[]}


def lifecycle(_service, _payload, _context):
    blockers = []
    # 仅 System Manager 生命周期服务；锁定读避免停用等待后漏掉新提交订单。
    for row in frappe.db.get_values('Shangshu Order', {'status':['in',['PendingWarehouse','PendingFinance']]},
                                   ['name','status','funding_request'], as_dict=True, for_update=True):
        if row.status == 'PendingWarehouse' or get_object_record('finance.funding_request',row.funding_request)['record']['status'] != 'Paid':
            blockers.append('订单尚在办理：' + row.name)
    return {'blockers': blockers}


def work_items(_service, _payload, context):
    manager = bool({'System Manager','Warehouse Manager'}.intersection(context['roles']))
    def read(filters):
        return frappe.get_list('Shangshu Order', filters=filters,
                               fields=['name','title','status','applicant'], order_by='modified desc', limit_page_length=100)
    rows = (read({'status':'PendingWarehouse'}) if manager else []) + read({'status':'Returned','applicant':context['user_name']})
    return {'items':[{'dataset':'orders.order','name':row.name,'title':row.title,'step':STATUS[row.status]}
                     for row in rows[:100]]}


def query(dataset_id, filters=None, page=1, page_length=30):
    result = query_object_records(dataset_id,filters,page,page_length)
    # 只读财务公共对象，继承其企业/申请人权限；不缓存、不复制拨款状态。
    for row in result['rows']:
        row['funding_status'] = ''
        if row.get('funding_request'):
            row['funding_status'] = get_object_record('finance.funding_request',row['funding_request'])['record']['status']
    return result
