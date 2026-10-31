"""从唯一动作审计投影受管记录历史；当前权限优先于历史字段。"""
import json
from zoneinfo import ZoneInfo
import frappe
from frappe.utils import get_datetime, get_system_timezone
from shangshu_core.model_records import _load, _record, _fields, _references, _values
from shangshu_core import unified_log


def _visible_value(field, value, compiled, roles):
    if value is None:
        return None
    if field["type"] == "reference" and value:
        try:
            model, schema, target_roles = _load(field["target"])
            record = _record(model,schema,target_roles,value)
            label = next((f for f in _fields(schema,target_roles) if f['type']=='text'),None)
            return _values(record,schema,target_roles).get(label['id']) if label else "关联记录"
        except (frappe.PermissionError,frappe.ValidationError,frappe.DoesNotExistError):
            return "关联记录不可访问"
    if field["type"] == "detail":
        child = _references(compiled)[field['target']]
        return [[{'label':f['label'],'value':_visible_value(f,row.get(f['id']),child,roles)} for f in _fields(child,roles) if f['id'] in row]
                for row in value if isinstance(row,dict)]
    return value


def record_history(service_id, payload, context):
    model, compiled, roles = _load(payload['object_id'])
    _record(model,compiled,roles,payload['name'],include_recycled=True)  # 回收历史仍须当前回收与归属权限。
    page = max(1,int(payload.get('page',1))); length = min(50,max(1,int(payload.get('page_length',20))))
    record_actions = ['platform.object.create','platform.object.update','platform.object.update_many',
                      'platform.object.recycle','platform.object.restore']
    filters = {'reference_doctype':model.physical_doctype,'reference_name':payload['name'], 'status':'Succeeded'}
    # **统一日志库**（PKG-020-T01）：旧表的历史行 ＋ 统一表的新行 ⇒ 形状不变。
    audits = unified_log.merged_legacy_rows('Shangshu Action Execution Audit','action',filters=filters,
        fields=['name','creation','actor_user','action_id','idempotency_key','executor_source','record_changes_json','package'],
        order_by='creation desc, name desc',limit_start=(page-1)*length,limit_page_length=length,record_action_ids=record_actions,record_object_id=model.name)
    visible = {field['id']:field for field in _fields(compiled,roles)}
    items = []
    for audit in audits:
        from shangshu_core.log_targets import target_changes
        package = audit.get('package')
        if package:
            scoped = target_changes(package, doctype=model.physical_doctype,
                                    name=payload['name'], object_id=model.name)
        else:
            try:
                data = json.loads(audit.record_changes_json or '{}')
            except (TypeError, ValueError):
                data = {}
            scoped = [({}, data)] if isinstance(data, dict) and data.get('version') == 1 and data.get('object_id') == model.name else []
        if not scoped:
            continue
        changes = []
        for step, data in scoped:
            for change in data.get('changes', []):
                field = visible.get(change.get('field'))
                if not field or field['type'] != change.get('type'):
                    continue
                # 按步骤原序保留同一目标的多次变化；隐藏字段与不可访问引用不泄露。
                changes.append({'field':field['id'],'label':change.get('label') or field['label'],
                    'type':field['type'],
                    'before':_visible_value(field,change.get('before'),compiled,roles),
                    'after':_visible_value(field,change.get('after'),compiled,roles)})
        data = scoped[-1][1]
        actor = frappe.db.get_value('User',audit.actor_user,'full_name') or audit.actor_user
        timestamp = get_datetime(audit.creation).replace(tzinfo=ZoneInfo(get_system_timezone())).isoformat()
        items.append({'id':audit.name,'op_id':audit.idempotency_key,
                      'idempotency_key':audit.idempotency_key,
                      'time':timestamp,'actor':actor,
                      'operation':audit.action_id.rsplit('.',1)[-1],'changes':changes,
                      'object_id':data.get('object_id') or model.name,
                      'object_title':data.get('object_title') or compiled['title'],
                      'revision':data.get('revision'),
                      'source':('import' if data.get('source')=='import'
                                else audit.executor_source or 'record')})
    return {'items':items,'total':unified_log.merged_legacy_count('Shangshu Action Execution Audit','action',filters,record_action_ids=record_actions,record_object_id=model.name),
            'page':page,'page_length':length,'notice':'仅展示字段历史接入后的记录动作；更早的前后值未保存，不能还原。',
            'order':'newest_first'}
