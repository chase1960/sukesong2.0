"""公共记录提醒与原Harness租约；不承载业务任务或第二助手队列。"""
from contextlib import contextmanager
from hashlib import sha256
import frappe
from frappe.utils import now_datetime,get_datetime,add_to_date
from shangshu_core import domains
from shangshu_core.domain_execution import domain_execution
from shangshu_core.identity import get_identity

EXECUTION='Shangshu Reference Execution'
NOTIFICATION='Shangshu Reference Notification'


@contextmanager
def _writing():
    prior=getattr(frappe.flags,'shangshu_reference_work_write',False)
    frappe.flags.shangshu_reference_work_write=True
    try:yield
    finally:frappe.flags.shangshu_reference_work_write=prior


def _names(doctype,filters):
    # Frappe get_all不支持for_update；直接用数据库当前读，权限由来源统一检查。
    return [row.name for row in frappe.db.get_values(doctype,filters,'name',as_dict=True,for_update=True)]


def _reference(object_id,name,permission='read',user=None,lock=False):
    domain,item=domains.raw_resource('objects',object_id)
    if not domain or not item or not item.get('doctype'):
        frappe.throw('来源必须是已注册的原生业务对象',frappe.ValidationError)
    with domain_execution(domain['id']):
        doc=frappe.get_doc(item['doctype'],name,for_update=lock)
        if not doc.has_permission(permission,user=user):frappe.throw('当前不能读取或办理来源记录',frappe.PermissionError)
        return domain,item,doc


def _actor(item,doc,user):
    field=item.get('execution_actor_field')
    if not field or field not in doc.meta.get_valid_columns():frappe.throw('该对象没有声明记录级助手负责人',frappe.PermissionError)
    if doc.get(field)!=user:frappe.throw('当前已不是来源事项负责人，请停止旧助手',frappe.PermissionError)
    guard=item.get('execution_guard')
    if guard:
        domain=domains.raw_resource('objects',item['id'])[0]
        owner=domain.get('owner_app') or (domain.get('contribution') or {}).get('owner_app')
        if not owner or not str(guard).startswith(owner+'.'):frappe.throw('执行守卫必须属于对象原域',frappe.PermissionError)
        if not frappe.get_attr(guard)(doc,user):frappe.throw('当前办理窗口已失效，请重新核对',frappe.PermissionError)


def authorize_execution(execution_id,confirmation=False):
    identity=get_identity()
    initial=frappe.get_doc(EXECUTION,execution_id)
    if initial.actor_user!=frappe.session.user:frappe.throw('不能使用他人的助手执行租约',frappe.PermissionError)
    _,item,doc=_reference(initial.object_id,initial.reference_name,lock=True)
    lease=frappe.get_doc(EXECUTION,execution_id,for_update=True)
    if lease.enterprise_id!=identity.enterprise_id:
        frappe.throw('来源执行不属于当前企业',frappe.PermissionError)
    if lease.status not in ({'Active','Completed'} if confirmation else {'Active'}) or get_datetime(lease.expires_at)<=now_datetime():
        frappe.throw('助手执行已结束、撤销或过期，请重新核对来源事项',frappe.PermissionError)
    _actor(item,doc,lease.actor_user)
    return lease


def authorize_execution_receipt(execution_id):
    """Read a completed action receipt without reactivating its former lease.

    Current source read, domain, actor and enterprise authorization still apply.
    Lease liveness is only authority for new execution, not a durable receipt.
    """
    identity = get_identity()
    initial = frappe.get_doc(EXECUTION, execution_id)
    if initial.actor_user != frappe.session.user or initial.enterprise_id != identity.enterprise_id:
        frappe.throw('不能读取其他身份或企业的助手执行回执', frappe.PermissionError)
    # Match authorize_execution: source row first, then lease. Never acquire
    # these two locks in reverse order during a concurrent handover/retry.
    _reference(initial.object_id, initial.reference_name, lock=True)
    lease = frappe.get_doc(EXECUTION, execution_id, for_update=True)
    if (lease.actor_user != frappe.session.user or lease.enterprise_id != identity.enterprise_id
            or lease.object_id != initial.object_id or lease.reference_name != initial.reference_name):
        frappe.throw('助手执行来源或身份已变化，请重新核对回执', frappe.PermissionError)
    return lease


def reference_execution(operation,execution_id=None,object_id=None,name=None):
    """内部编排begin/check/end；身份来自会话，未声明对象不生成假授权。"""
    identity=get_identity()
    if operation=='begin':
        if execution_id or not object_id or not name:frappe.throw('请选择明确来源记录',frappe.ValidationError)
        identity=frappe.get_doc('Shangshu Identity',identity.name,for_update=True)
        if identity.status!='Active':frappe.throw('平台身份已停用',frappe.PermissionError)
        domain,item,doc=_reference(object_id,name,lock=True)
        _actor(item,doc,frappe.session.user)
        if len(_names(EXECUTION,{'actor_user':frappe.session.user,'status':'Active','expires_at':['>',now_datetime()]}))>=8:
            frappe.throw('同时运行的记录助手过多，请先结束旧会话',frappe.ValidationError)
        with _writing():
            lease=frappe.get_doc({'doctype':EXECUTION,'actor_user':frappe.session.user,
                'enterprise_id':identity.enterprise_id,'object_id':object_id,'reference_name':name,
                'domain_id':domain['id'],'status':'Active','expires_at':add_to_date(now_datetime(),minutes=30)}).insert(ignore_permissions=True)
    elif operation=='check':
        if object_id or name or not execution_id:frappe.throw('请使用原执行编号核对',frappe.ValidationError)
        lease=authorize_execution(execution_id)
    elif operation=='end':
        if object_id or name or not execution_id:frappe.throw('请使用原执行编号结束',frappe.ValidationError)
        lease=frappe.get_doc(EXECUTION,execution_id,for_update=True)
        if lease.actor_user!=frappe.session.user or lease.enterprise_id!=identity.enterprise_id:frappe.throw('不能结束其他身份或企业的执行',frappe.PermissionError)
        if lease.status=='Active':
            lease.status='Completed'
            with _writing():lease.save(ignore_permissions=True)
    else:frappe.throw('执行操作未声明',frappe.ValidationError)
    return {'id':lease.name,'status':lease.status,'object_id':lease.object_id,
        'name':lease.reference_name,'expires_at':str(lease.expires_at)}


def update_reference_work(object_id,name,previous_user=None,recipient_user=None,event_key=None,title='',reason=''):
    """仅原域受权动作/后台上下文可组合；调用方原Action审计和事务保留全部效果。"""
    caller=getattr(frappe.flags,'shangshu_call_domain',None)
    domain,_=domains.raw_resource('objects',object_id)
    if not domain or caller!=domain['id']:frappe.throw('只有来源原域的受权执行可以更新工作提醒',frappe.PermissionError)
    pin=getattr(frappe.flags,'shangshu_action_pin',None) or {}
    action_domain,action=domains.raw_resource('actions',pin.get('action_id')) if pin.get('action_id') else (None,None)
    if not action_domain or action_domain['id']!=caller or not action or action.get('effect') in ('read','external/read','extract'):
        frappe.throw('工作提醒必须由原域审计写动作维护，不能通过只读服务更新',frappe.PermissionError)
    identity=get_identity()
    if not str(reason).strip() or len(reason)>2000:frappe.throw('请填写简短办理依据',frappe.ValidationError)
    point='reference_work_'+frappe.generate_hash(length=12);frappe.db.savepoint(point)
    try:
        # 转交者未必是旧负责人；只有原域明确声明的受权动作守卫可补此准入。
        _,item,doc=_reference(object_id,name,lock=True)
        if not doc.has_permission('write'):
            guard=item.get('work_update_guard')
            owner=domain.get('owner_app') or (domain.get('contribution') or {}).get('owner_app')
            if not guard or not owner or not str(guard).startswith(owner+'.') or not frappe.get_attr(guard)(doc,frappe.session.user,pin):
                frappe.throw('当前不能更新来源记录的工作提醒',frappe.PermissionError)
        revoked=closed=0;notification=None
        with _writing():
            if previous_user:
                for row in _names(EXECUTION,{'object_id':object_id,'reference_name':name,'enterprise_id':identity.enterprise_id,'actor_user':previous_user,'status':['in',['Active','Completed']]}):
                    lease=frappe.get_doc(EXECUTION,row,for_update=True)
                    if lease.status not in ('Active','Completed'):continue
                    lease.status='Cancelled';lease.reason=reason;lease.save(ignore_permissions=True);revoked+=1
                    for proposal in _names('Shangshu Action Proposal',{'reference_execution':row,'status':'Proposed'}):
                        if proposal==getattr(frappe.flags,'shangshu_resolving_proposal',None):continue
                        old=frappe.get_doc('Shangshu Action Proposal',proposal,for_update=True)
                        if old.status!='Proposed':continue
                        old.status='Rejected';old.decision_by=frappe.session.user;old.decision_at=now_datetime();old.error_message=reason
                        old.save(ignore_permissions=True)
                for row in _names(NOTIFICATION,{'object_id':object_id,'reference_name':name,'enterprise_id':identity.enterprise_id,'recipient_user':previous_user,'status':'Pending'}):
                    old=frappe.get_doc(NOTIFICATION,row,for_update=True);old.status='Closed';old.close_reason=reason;old.save(ignore_permissions=True);closed+=1
            if recipient_user:
                if not event_key or not title.strip() or len(title)>140 or len(str(event_key))>250:
                    frappe.throw('提醒须有明确去重键与简短标题',frappe.ValidationError)
                if not frappe.db.get_value('User',recipient_user,'enabled') or not doc.has_permission('read',user=recipient_user):
                    frappe.throw('接收人已停用或不能读取来源记录',frappe.PermissionError)
                if not frappe.db.exists('Shangshu Identity',{'user':recipient_user,'enterprise_id':identity.enterprise_id,'status':'Active'}):
                    frappe.throw('接收人不属于当前企业的启用平台身份',frappe.PermissionError)
                key=sha256('\0'.join((identity.enterprise_id,domain['id'],object_id,name,recipient_user,str(event_key))).encode()).hexdigest()
                notification=frappe.db.get_value(NOTIFICATION,{'event_key':key},'name',for_update=True)
                if notification:
                    old=frappe.get_doc(NOTIFICATION,notification,for_update=True)
                    if old.title!=title or old.body!=reason:frappe.throw('同一提醒键的内容不同，请重新核对来源',frappe.TimestampMismatchError)
                else:
                    notification=frappe.get_doc({'doctype':NOTIFICATION,'event_key':key,'domain_id':domain['id'],'enterprise_id':identity.enterprise_id,
                        'object_id':object_id,'reference_name':name,'recipient_user':recipient_user,
                        'title':title,'body':reason,'status':'Pending'}).insert(ignore_permissions=True).name
        return {'revoked':revoked,'closed':closed,'notification':notification}
    except Exception:
        frappe.db.rollback(save_point=point);raise


def reference_notifications(page=1,page_length=30):
    identity=get_identity()
    page=max(1,int(page));length=min(100,max(1,int(page_length)))
    rows=frappe.get_all(NOTIFICATION,filters={'recipient_user':frappe.session.user,'enterprise_id':identity.enterprise_id,'status':'Pending'},
        fields=['name','object_id','reference_name','title','body','creation'],order_by='creation desc',limit_page_length=1001)
    if len(rows)>1000:frappe.throw('未处理提醒过多，请先关闭已办事项后重新查询',frappe.ValidationError)
    visible=[]
    for row in rows:
        try:_reference(row.object_id,row.reference_name)
        except (frappe.PermissionError,frappe.DoesNotExistError):continue
        visible.append(row)
    return {'rows':visible[(page-1)*length:page*length],'total':len(visible),'page':page,'page_length':length}
