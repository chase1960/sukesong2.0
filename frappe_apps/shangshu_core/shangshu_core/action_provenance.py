"""Trusted runtime provenance; caller labels never create execution evidence."""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import hmac
import json
import frappe
from frappe.utils import now_datetime

_node = ContextVar('shangshu_process_action_source', default=None)
_request = ContextVar('shangshu_action_origin', default=None)


def _decode(value):
    try:
        result=json.loads(value) if isinstance(value,str) else value
        return result if isinstance(result,dict) else {}
    except (ValueError,TypeError):
        return {}


def _copy(value):
    return json.loads(json.dumps(value,ensure_ascii=False,default=str)) if value is not None else None


@contextmanager
def action_origin_scope(action_id, request_id, actor_user, source):
    # This is an actual handler invocation. The label remains unverified; Node
    # must independently match its immutable journal before claiming Assistant.
    origin={'action_id':action_id,'request_id':request_id,'actor_user':actor_user,
            'label':str(source or 'user')[:80]}
    proposal_id=getattr(frappe.flags,'shangshu_resolving_proposal',None)
    if proposal_id:
        proposal=frappe.get_doc('Shangshu Action Proposal',proposal_id)
        if proposal.action_id==action_id:
            origin['actor_user']=proposal.actor_user
            origin['proposal_id']=proposal.name
            origin['request_id']=proposal.idempotency_key
    token=_request.set(origin)
    try:yield
    finally:_request.reset(token)


def current_action_origin():
    return _copy(_request.get())


@contextmanager
def process_node_provenance(execution_name, token):
    """Python driver scope, not an HTTP parameter or a new execution capability.

    Requires the existing current-node token and current enterprise. Actions
    inside the scope are still checked by their original role/schema/confirmation.
    """
    from shangshu_core.runtime import _node_for_instance, _action_for_instance
    from shangshu_core.identity import get_identity
    execution=frappe.get_doc('Shangshu Node Execution',execution_name)
    instance=frappe.get_doc('Shangshu Process Instance',execution.process_instance)
    # Match complete_node_execution capability semantics. A human approver may
    # legitimately advance into an automatic node that has no human role list.
    if get_identity().enterprise_id!=instance.enterprise_id:
        frappe.throw('无权处理来源流程节点',frappe.PermissionError)
    if not token or not hmac.compare_digest(execution.execution_token_hash or '',hashlib.sha256(str(token).encode()).hexdigest()):
        frappe.throw('执行令牌无效',frappe.PermissionError)
    if execution.token_expires_at and execution.token_expires_at<now_datetime():
        frappe.throw('执行令牌已过期',frappe.PermissionError)
    if instance.status!='Running' or instance.current_node!=execution.node_id or execution.status not in ('Running','Waiting Human'):
        frappe.throw('来源节点已变化',frappe.ValidationError)
    graph,node=_node_for_instance(instance,execution.node_id)
    if execution.node_type!=node['type']:
        frappe.throw('来源执行与节点类型不匹配',frappe.ValidationError)
    if node.get('action_id') and (execution.action_id!=node['action_id'] or execution.action_version!=_action_for_instance(instance,node['action_id']).action_version):
        frappe.throw('来源执行与流程动作版本不匹配',frappe.ValidationError)
    if node['type'] not in ('action','human_task','ai_select'):
        frappe.throw('该节点不执行动作',frappe.ValidationError)
    # Completed AI selection nodes are participation facts, not a claim that
    # their text produced this payload, nor permission for an AI node to write.
    participants=frappe.get_all('Shangshu Node Execution',filters={
        'process_instance':instance.name,'node_type':'ai_select','status':'Completed'},
        fields=['name','node_id','selected_tool'],order_by='creation asc',limit_page_length=21)
    snapshot={'version':1,'kind':'process','process_instance':instance.name,
        'definition_id':instance.definition_id,'definition_version':instance.definition_version,
        'graph_hash':instance.graph_hash,'node_execution':execution.name,
        'node_id':execution.node_id,'node_type':node['type'],
        'executor_kind':'llm' if node['type']=='ai_select' else ('code' if node['type']=='action' else 'human_task'),
        'llm_participants':[{'node_execution':r['name'],'node_id':r['node_id'],'selected_tool':r.get('selected_tool')} for r in participants[:20]],
        'participants_truncated':len(participants)>20,
        'initiator':_decode(instance.get('origin_snapshot_json')) or None}
    scoped={'snapshot':snapshot,'instance':instance,'action_id':node.get('action_id'),
            'candidates':node.get('candidates') or [],'node_type':node['type']}
    previous=_node.set(scoped)
    try:yield
    finally:_node.reset(previous)


def process_action_version(action_id):
    scoped=_node.get()
    if not scoped:return None
    if scoped['node_type']=='ai_select':
        if action_id not in scoped['candidates']:
            frappe.throw('动作与来源节点不匹配',frappe.PermissionError)
    elif scoped['action_id']!=action_id:
        frappe.throw('动作与来源节点不匹配',frappe.PermissionError)
    from shangshu_core.runtime import _action_for_instance
    return _action_for_instance(scoped['instance'],action_id).action_version


def current_action_provenance(action_id, action_version=None):
    scoped=_node.get()
    if scoped:
        pinned=process_action_version(action_id)
        if action_version is not None and action_version!=pinned:
            frappe.throw('动作版本与来源流程不匹配',frappe.ValidationError)
        if scoped['node_type']=='ai_select':
            from shangshu_core.actions import _definition
            if action_id not in scoped['candidates'] or _definition(action_id,pinned).effect not in ('read','external/read','extract'):
                frappe.throw('AI节点仍只允许已声明的只读或提取动作',frappe.PermissionError)
        elif scoped['action_id']!=action_id:
            frappe.throw('动作与来源节点不匹配',frappe.PermissionError)
        return {**_copy(scoped['snapshot']),'action_id':action_id,'action_version':pinned}
    # Confirmation may occur after the original runtime scope has gone away.
    # Use only the stored proposal bound by the existing resolve implementation.
    proposal_id=getattr(frappe.flags,'shangshu_resolving_proposal',None)
    if proposal_id:
        proposal=frappe.get_doc('Shangshu Action Proposal',proposal_id)
        if proposal.action_id==action_id:
            snapshot=_decode(proposal.get('source_snapshot_json'))
            if snapshot and action_version is not None and snapshot.get('action_version')!=action_version:
                frappe.throw('动作版本与原提案来源不匹配',frappe.ValidationError)
            return snapshot or None
    return None


def project_action_provenance(raw):
    """No payloads, tokens or conversation text; recheck current process access."""
    snapshot=_decode(raw)
    if not snapshot:return {'status':'not_linked','trusted':False}
    try:
        from shangshu_core.runtime import _instance_access, _node_for_instance, _action_for_instance
        instance=frappe.get_doc('Shangshu Process Instance',snapshot.get('process_instance'))
        if not _instance_access(instance):return {'status':'unavailable','trusted':False}
        execution=frappe.get_doc('Shangshu Node Execution',snapshot.get('node_execution'))
        if (execution.process_instance!=instance.name or execution.node_id!=snapshot.get('node_id') or
            instance.definition_version!=snapshot.get('definition_version') or instance.graph_hash!=snapshot.get('graph_hash')):
            return {'status':'unavailable','trusted':False}
        _,node=_node_for_instance(instance,execution.node_id)
        action_id=snapshot.get('action_id')
        allowed=(node.get('candidates') or []) if node['type']=='ai_select' else [node.get('action_id')]
        if action_id not in allowed or _action_for_instance(instance,action_id).action_version!=snapshot.get('action_version'):
            return {'status':'unavailable','trusted':False}
        # Whitelist the persisted shape; caller fields and raw snapshots are not
        # accepted through public APIs. Old labels never become trusted evidence.
        keys=('version','kind','process_instance','definition_id','definition_version','graph_hash',
              'node_execution','node_id','node_type','action_id','action_version','executor_kind','llm_participants','participants_truncated')
        result={key:_copy(snapshot[key]) if isinstance(snapshot.get(key),(dict,list)) else snapshot.get(key) for key in keys}
        origin=snapshot.get('initiator')
        if isinstance(origin,dict):
            result['initiator']={key:origin[key] for key in ('action_id','request_id','actor_user','proposal_id','label') if key in origin}
            result['initiator'].update({'kind':'action','trusted':False})
        return {'status':'linked','trusted':True,**result}
    except (frappe.PermissionError,frappe.DoesNotExistError,frappe.ValidationError):
        return {'status':'unavailable','trusted':False}
