"""受管记录导入：只读预检 + 原动作组合，不维护导入数据副本或第二套 CRUD。"""
import base64
import binascii
import hashlib
import json

import frappe

from shangshu_core.model_records import _load, _fields, _values, _apply, _write_restriction
from shangshu_core.model_schema import field_schema
from shangshu_core.schema_validation import _validate_schema
from shangshu_core import record_import_xlsx as xlsx

MAX_MATCH_ROWS = 5000


def _digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),default=str).encode()).hexdigest()


def _prepare(payload, write=False):
    from shangshu_core import business_access
    business_access.require_identity()
    if not business_access.is_open() and 'System Manager' not in frappe.get_roles():
        frappe.throw('数据导入暂仅开放给系统管理员',frappe.PermissionError)
    if not payload.get('object_id') or 'expected_revision' not in payload:
        frappe.throw('请选择目标数据表和字段版本',frappe.ValidationError)
    model, compiled, roles = _load(payload['object_id'],write=write)
    if model.active_revision != payload['expected_revision']:
        frappe.throw('字段定义已变化，请重新核对导入列',frappe.TimestampMismatchError)
    if reason := _write_restriction(model.name): frappe.throw(reason,frappe.ValidationError)
    fields = _fields(compiled,roles,True)
    if any(field['type'] in {'reference','detail'} for field in fields):
        frappe.throw('当前导入不支持关联或明细列，请使用记录表单维护，未忽略任何列',frappe.ValidationError)
    content,sheets,selected = _source(payload)
    return model,compiled,roles,fields,content,sheets,selected


def _source(payload):
    filename = payload['filename']
    if not filename.lower().endswith('.xlsx') or any(c in filename for c in '/\\\x00'):
        frappe.throw('请选择不含路径的 .xlsx 文件',frappe.ValidationError)
    encoded = payload['content_base64']
    if len(encoded) > 4*((xlsx.MAX_BYTES+2)//3): frappe.throw('文件超过 10MB',frappe.ValidationError)
    try: content = base64.b64decode(encoded,validate=True)
    except (ValueError,binascii.Error): frappe.throw('文件内容不完整，请重新选择文件',frappe.ValidationError)
    try:
        selected = xlsx.read_sheet(content,payload['sheet'],payload.get('header_row',1)) if payload.get('sheet') else None
        sheets = selected['sheets'] if selected else xlsx.workbook_sheets(content)
    except xlsx.ImportError as error: frappe.throw(str(error),frappe.ValidationError)
    return content,sheets,selected


def _plan(payload, write=False):
    model,compiled,roles,fields,content,sheets,selected = _prepare(payload,write)
    response = {'sheets':sheets,'fields':fields,'revision':model.active_revision}
    if selected is None: return response
    response.update(columns=selected['columns'],errors=list(selected['issues']),
                    sample=[{'row':row['row'],'values':[str(c['value']) if c['value'] is not None else '' for c in row['cells']]} for row in selected['rows'][:10]])
    mapping = payload.get('mapping')
    if not mapping: return response
    available = {field['id']:field for field in fields}
    if set(mapping)-available.keys() or len(set(mapping.values())) != len(mapping):
        frappe.throw('列映射无效，不能映射未授权字段或重复使用同一列',frappe.ValidationError)
    if any(type(index) is not int or not 1 <= index <= len(selected['columns']) for index in mapping.values()):
        frappe.throw('映射列不在当前工作表中',frappe.ValidationError)
    match = payload.get('match_field')
    if match not in mapping or available[match]['type'] not in {'text','integer','date','choice'}:
        frappe.throw('请选择已映射的文本、整数、日期或选项列作为匹配依据',frappe.ValidationError)
    columns = {f['id']:c['fieldname'] for f,c in zip(compiled['fields'],compiled['doctype']['fields'])}
    table = frappe.qb.DocType(model.physical_doctype)
    query = frappe.qb.from_(table).select(table.name,table[columns[match]].as_('match_value')).limit(MAX_MATCH_ROWS+1)
    if write: query = query.for_update()  # 应用写锁之后读取当前值，不能复用事务开始时旧快照。
    existing = query.run(as_dict=True)
    if len(existing) > MAX_MATCH_ROWS:
        frappe.throw('目标表超过当前 5000 行导入保护范围，请缩小表后再处理；未截断匹配范围',frappe.ValidationError)
    lookup = {}
    for record in existing: lookup.setdefault(record.match_value,[]).append(record.name)
    errors = response['errors']; rows = []; keys = {}
    def issue(row,field,message):
        column = mapping.get(field,0)
        errors.append({'sheet':selected['sheet'],'row':row,'column':column or available[field]['label'],
                       'field':field,'label':available[field]['label'],'message':message})
    for source in selected['rows']:
        values = {}; start_errors = len(errors)
        for field,index in mapping.items():
            try:
                value = xlsx.cell_value(source['cells'][index-1],available[field]['type'])
                if value is None and available[field]['required']:
                    raise xlsx.ImportError('必填列不能为空，请补全原表后重试')
                if value is not None: _validate_schema(value,field_schema(available[field]),available[field]['label'])
                values[field] = value
            except (xlsx.ImportError,frappe.ValidationError) as error: issue(source['row'],field,str(error))
        key = values.get(match)
        if key is None or key == '':
            if not any(e.get('field')==match and e['row']==source['row'] for e in errors):
                issue(source['row'],match,'匹配依据不能为空')
        elif key in keys:
            issue(source['row'],match,f'与第 {keys[key]} 行重复，请明确取舍，不能任意覆盖')
        else: keys[key] = source['row']
        if len(errors) != start_errors: continue
        matches = lookup.get(key,[])
        if len(matches) > 1:
            issue(source['row'],match,'目标表中匹配值不唯一，请先在原表处理重复记录'); continue
        doc = frappe.get_doc(model.physical_doctype,matches[0],for_update=write) if matches else frappe.new_doc(model.physical_doctype)
        if doc.get('ss_recycled'):
            issue(source['row'],match,'匹配记录已在回收站，请先恢复或明确更换匹配值'); continue
        before = _values(doc,compiled,roles) if matches else {}
        # 缺失必填列只在新增时错误，更新未映射的列必须保留原值。
        missing = [field for field in fields if field['required'] and field['id'] not in values and not before.get(field['id']) and before.get(field['id']) not in (0,False)]
        if missing:
            for field in missing: issue(source['row'],field['id'],'新增记录缺少必填列映射，请补选对应列')
            continue
        try: _apply(doc,compiled,roles,values)
        except (frappe.ValidationError,frappe.PermissionError) as error:
            issue(source['row'],match,str(error)); continue
        after = _values(doc,compiled,roles)
        changes = [{'field':field,'label':available[field]['label'],'type':available[field]['type'],'before':before.get(field),'after':after.get(field)}
                   for field in values if before.get(field) != after.get(field)]
        rows.append({'row':source['row'],'operation':'create' if not matches else 'update' if changes else 'unchanged',
                     'name':doc.name if matches else None,'modified':str(doc.modified) if matches else None,
                     'values':values,'changes':changes})
    response.update(rows=rows,summary={operation:sum(r['operation']==operation for r in rows) for operation in ('create','update','unchanged')})
    response['summary']['errors'] = len(errors)
    response['preview_hash'] = _digest({'object_id':model.name,'revision':model.active_revision,'file':hashlib.sha256(content).hexdigest(),
        'sheet':selected['sheet'],'header_row':selected['header_row'],'mapping':mapping,'match_field':match,'rows':rows,'errors':errors})
    return response


def preview_import(service_id,payload,context):
    if payload.get('inspect_only'):
        if 'System Manager' not in frappe.get_roles():
            frappe.throw('建表前检查仅开放给系统管理员',frappe.PermissionError)
        if set(payload)-{'inspect_only','filename','content_base64','sheet','header_row'}:
            frappe.throw('建表前检查不能携带目标对象或写入映射',frappe.ValidationError)
        _,sheets,selected = _source(payload)
        result = {'sheets':sheets}
        if selected:
            result.update(columns=selected['columns'],errors=selected['issues'],
                sample=[{'row':row['row'],'values':[str(c['value']) if c['value'] is not None else '' for c in row['cells']]} for row in selected['rows'][:10]])
        return result
    from shangshu_core.model_records import is_managed
    if payload.get('object_id') and not is_managed(payload['object_id']):
        from shangshu_core import native_objects
        return native_objects.import_plan(payload)
    return _plan(payload)


def import_records(action_id,payload,context):
    from shangshu_core.model_records import is_managed
    if payload.get('object_id') and not is_managed(payload['object_id']):
        from shangshu_core import native_objects
        return native_objects.import_records(payload, context)
    pin = getattr(frappe.flags,'shangshu_action_pin',None)
    if not context.get('confirmed') or not pin or pin.get('action_id') != 'platform.object.import':
        frappe.throw('导入必须经过公共动作确认',frappe.PermissionError)
    plan = _plan(payload,write=True)
    if plan.get('errors') or not plan.get('rows'):
        frappe.throw('导入仍有错误，请修正后重新核对；本次没有写入任何记录',frappe.ValidationError)
    if payload['preview_hash'] != plan['preview_hash']:
        frappe.throw('预览后数据或字段已变化，请重新检查新增/更新范围；本次未写入',frappe.TimestampMismatchError)
    from shangshu_core.actions import execute_registered_action
    previous = getattr(frappe.flags,'shangshu_record_import',None)
    try:
        for row in plan['rows']:
            if row['operation']=='unchanged': continue
            values = {'object_id':payload['object_id'],'expected_revision':payload['expected_revision'],'values':row['values']}
            if row['operation']=='update': values.update(name=row['name'],expected_modified=row['modified'])
            frappe.flags.shangshu_record_import = {'object_id':payload['object_id'],'filename':payload['filename'],
                                                  'sheet':payload['sheet'],'row':row['row']}
            key = 'import-'+_digest([context['idempotency_key'],row['row']])
            execute_registered_action('platform.object.'+row['operation'],values,True,key)
    finally: frappe.flags.shangshu_record_import = previous
    # 外层原执行器的 savepoint 覆盖全部子动作/子审计；不自行提交、不开第二事务。
    return {'object_id':payload['object_id'],'revision':payload['expected_revision'],**plan['summary']}
