"""Atomic original-object actions plus companion ordinary-cell writes and inverse packages."""
import hashlib
import math
from decimal import Decimal, InvalidOperation
from contextlib import contextmanager
import frappe
from shangshu_core import object_companions as companions
from shangshu_core.domain_execution import domain_execution


def _fail(message):
    frappe.throw(message,frappe.ValidationError)


def _scalar(typed, field):
    if not isinstance(typed,dict) or typed.get('type') not in ('text','number','boolean','date','empty'):
        _fail('原业务字段仅接受明确标量，不能把公式直接写进业务字段')
    kind=typed['type'];value=typed.get('value');target=field['type']
    if kind=='empty':
        return '' if target in ('text','long_text','choice') else None
    if target in ('text','long_text','choice'):
        if kind!='text' or not isinstance(value,str):_fail('原文本字段须使用文本值')
    elif target in ('integer','decimal'):
        if kind!='number' or isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):_fail('原数值字段须使用有限数字')
        if target=='integer' and int(value)!=value:_fail('原整数字段不能写入小数')
    elif target=='boolean':
        if kind=='number' and value in (0,1):return bool(value)
        if kind!='boolean' or not isinstance(value,bool):_fail('原布尔字段须使用布尔值')
    elif target=='date':
        if kind!='date' or not isinstance(value,str):_fail('原日期字段须使用日期值')
        return value[:10]
    return value


def _source_equal(actual,wanted,field):
    """Preserve null/empty/bool distinctions; normalize only the declared kind."""
    if actual is None or wanted is None:
        return actual is None and wanted is None
    kind=field['type']
    if kind in ('integer','decimal'):
        if isinstance(actual,bool) or isinstance(wanted,bool):return False
        try:
            a,b=Decimal(str(actual)),Decimal(str(wanted))
            return a.is_finite() and b.is_finite() and a==b
        except (InvalidOperation,ValueError):return False
    if kind=='boolean':
        return actual in (False,True,0,1) and wanted in (False,True,0,1) and bool(actual)==bool(wanted)
    if kind=='date':
        return str(actual)[:10]==str(wanted)[:10]
    return type(actual) is type(wanted) and actual==wanted


def _operation(binding,op_id,lock=False,replay=False):
    providers=frappe.get_hooks('shangshu_object_companion_operation',app_name='shangshu_files') or []
    if len(providers)!=1 or not providers[0].startswith('shangshu_files.'):
        _fail('伴随撤回快照服务未登记')
    with domain_execution('com.shangshu.files'), companions._projection_scope(binding):
        return frappe.get_attr(providers[0])(binding,op_id,lock=lock,replay=replay)


@contextmanager
def _atomic(context,binding):
    parent=getattr(frappe.flags,'shangshu_atomic_action_parent',None)
    deferred=getattr(frappe.flags,'shangshu_companion_deferred',None)
    frappe.flags.shangshu_atomic_action_parent=context['idempotency_key']
    frappe.flags.shangshu_companion_deferred={'object_id':binding['object_id'],'file_id':binding['file_id']}
    try:yield
    finally:
        frappe.flags.shangshu_atomic_action_parent=parent
        frappe.flags.shangshu_companion_deferred=deferred


def _managed_source_rows(spec,names,*,values=False):
    """按身份锁住源行；完整物理值仅供已授权包的内部伴随投影。"""
    fields=['name','modified']
    if values:
        fields+=list(dict.fromkeys(spec['columns'][f['id']] for f in spec['fields']))
    rows={}
    # 与既有源行锁相同的 name 顺序；先锁完所有源行，再锁登记和文件。
    for offset in range(0,len(names),500):
        chunk=names[offset:offset+500]
        for row in frappe.db.get_values(spec['source_doctype'],{'name':['in',chunk]},fields,
                as_dict=True,order_by='name asc',for_update=True):
            rows[str(row['name'])]=row
    if set(rows)!=set(names):
        frappe.throw('原记录不存在，请刷新后重新核对',frappe.DoesNotExistError)
    return rows


def _row_key(context,name):
    return 'companion-row-'+hashlib.sha256((context['idempotency_key']+'\0'+name).encode()).hexdigest()


def is_managed_package(payload):
    """Only managed companions opt in; native original Actions keep their contract."""
    binding = companions._find('object_id', payload.get('object_id'))
    return bool(binding and companions._current(binding).get('source_kind') == 'managed')


def write(action_id,payload,context):
    from shangshu_core.objects import get_object_definition,get_object_record
    from shangshu_core.actions import execute_registered_action
    if not context.get('confirmed') or not getattr(frappe.flags,'shangshu_action_pin',None):
        frappe.throw('伴随包必须经公共动作确认',frappe.PermissionError)
    with domain_execution('com.shangshu.core'):
        binding_doc=companions._find('object_id',payload['object_id'])
        if not binding_doc or binding_doc.file_id!=payload['file_id']:_fail('原对象与伴随文件不匹配')
        spec=companions._current(binding_doc)
        binding=companions._public(binding_doc)
        if payload['definition_revision']!=binding['definition_revision']:_fail('伴随定义已变化，请刷新')
        definition=get_object_definition(binding['object_id'])
        if payload['expected_revision']!=definition['revision']:_fail('原对象定义已变化，请刷新')
        undo=action_id=='platform.object.companion_undo'
        operation=_operation(binding,payload['undo_of']) if undo else None
        if undo:
            cells=[{'row_id':c['row_id'],'header':c['header'],'value':c['before']} for c in operation['cells']]
            expected=operation['source_versions']
        else:
            cells=payload['cells'];expected=payload['expected_modified']
        if not isinstance(cells,list) or not cells or len(cells)>10000:_fail('伴随包须有1至10000个单元格')
        if not isinstance(expected,dict):_fail('缺少显示时的原记录版本')
        targets=[];seen=set()
        for cell in cells:
            if not isinstance(cell,dict) or not isinstance(cell.get('row_id'),str) or not isinstance(cell.get('header'),str):_fail('单元格身份无效')
            key=(cell['row_id'],cell['header'])
            if key in seen:_fail('同一包不能重复写同一格')
            seen.add(key);targets.append(cell['row_id'])
        names=sorted(set(targets))
        # Fixed source -> registry -> workbook order. File provider checks its
        # versions and authority before its single serialization; exceptions roll
        # all original Actions back in the outer executor.
        managed=spec.get('source_kind')=='managed'
        source_docs=(_managed_source_rows(spec,names) if managed else
            {name:frappe.get_doc(spec['source_doctype'],name,for_update=True) for name in names})
        binding_doc=frappe.get_doc(companions.DOCTYPE,binding_doc.name,for_update=True)
        companions._current(binding_doc)
        if undo:
            checked=_operation(binding,payload['undo_of'],lock=True)
            if checked['cells']!=operation['cells'] or checked['source_versions']!=operation['source_versions']:_fail('撤回快照已变化')
        companions.authorize_companion_cells(binding['file_id'],names,[],operation='write')
        columns={c['header']:c for c in binding['field_columns']}
        if managed:
            from shangshu_core import model_records
            fields=sorted({columns[c['header']]['field_id'] for c in cells if c['header'] in columns})
            # 复用正式记录读口的行/字段权限及回收态门槛，只读本包前值。
            current=model_records.get_records(binding['object_id'],names,fields=fields)
        else:
            current={name:get_object_record(binding['object_id'],name)['record'] for name in names}
        for name in names:
            if expected.get(name)!=str(source_docs[name].modified):_fail('原记录已修改，请刷新后重新核对')
            if managed and str(current[name].get('modified') or '')!=str(source_docs[name].modified):
                _fail('原记录已修改，请刷新后重新核对')
        grouped={};ordinary=[]
        raw_undo={(c['row_id'],c['header']):c for c in (operation['cells'] if undo else [])}
        for cell in cells:
            column=columns.get(cell['header'])
            if column:
                fid=column['field_id']
                if fid not in current[cell['row_id']]:frappe.throw('原字段不可读',frappe.PermissionError)
                stored=raw_undo.get((cell['row_id'],cell['header']),{})
                value=stored['source_raw_before'] if 'source_raw_before' in stored else _scalar(cell['value'],column)
                if not _source_equal(current[cell['row_id']][fid],value,column):
                    grouped.setdefault(cell['row_id'],{})[fid]=value
            else:ordinary.append(cell)
        if undo:
            for cell in operation['cells']:
                column=columns.get(cell['header'])
                if column:
                    actual=current[cell['row_id']][column['field_id']]
                    want=cell['source_raw_after'] if 'source_raw_after' in cell else _scalar(cell['after'],column)
                    if not _source_equal(actual,want,column):_fail('原字段已被其他操作更改，不能撤回覆盖')
        if grouped and not managed:
            from shangshu_core import native_objects
            _,_,_,writes,_=native_objects.declared(binding['object_id'])
            from shangshu_core.actions import _definition
            if _definition(writes['update_action']).effect!='write':_fail('含外部副作用的原动作不能加入原子伴随包')
        with _atomic(context,binding):
            if managed and grouped:
                records=[{'name':name,'values':values,'expected_modified':expected[name],
                    'idempotency_key':_row_key(context,name)} for name,values in sorted(grouped.items())]
                key='companion-batch-'+hashlib.sha256(context['idempotency_key'].encode()).hexdigest()
                receipt=execute_registered_action('platform.object.update_many',{
                    'object_id':binding['object_id'],'expected_revision':payload['expected_revision'],'records':records},
                    confirmed=True,idempotency_key=key,source=context.get('source','user'))
                result=receipt.get('result') if isinstance(receipt,dict) else None
                if (not isinstance(result,dict) or result.get('object_id')!=binding['object_id'] or
                        result.get('revision')!=payload['expected_revision'] or result.get('written')!=len(records) or
                        result.get('records')!=[r['name'] for r in records] or result.get('record_version_checked') is not True):
                    _fail('原记录批量写回执不完整，本包未保存')
            else:
                for name,values in sorted(grouped.items()):
                    execute_registered_action('platform.object.update',{'object_id':binding['object_id'],'name':name,
                        'values':values,'expected_modified':expected[name],'expected_revision':payload['expected_revision']},
                        confirmed=True,idempotency_key=_row_key(context,name),source=context.get('source','user'))
            if managed:
                # 投影须保留全部绑定列和规则派生值；不可改用用户可读列丢掉隐藏列。
                after=_managed_source_rows(spec,names,values=True)
                snapshots=[companions._snapshot(after[name],spec) for name in names]
            else:
                snapshots=[companions._snapshot(frappe.get_doc(spec['source_doctype'],name),spec) for name in names]
            event={'kind':'mixed_undo' if undo else 'mixed','ordinary_cells':ordinary,
                'expected_content_version':payload['expected_content_version'],
                'expected_structure_version':payload['expected_structure_version'],
                'op_id':payload['op_id'],'context':context,
                'source_targets':[{'row_id':c['row_id'],'header':c['header']} for c in cells if c['header'] in columns]}
            after_values={r['name']:r['values'] for r in snapshots}
            event['source_values']=[{'row_id':c['row_id'],'header':c['header'],
                'before':current[c['row_id']][columns[c['header']]['field_id']],
                'after':after_values[c['row_id']][columns[c['header']]['field_id']]} for c in cells if c['header'] in columns]
            if undo:event['undo_of']=payload['undo_of']
            result=companions._project(binding,snapshots,event)
        access=companions.authorize_companion_cells(binding['file_id'],names,list({c['field_id'] for c in binding['field_columns']}),operation='read')
        readable=set(access['readable_field_ids']);allowed=set(access['allowed_record_ids'])
        result['cells']=[c for c in result.get('cells',[]) if c['row_id'] in allowed and (c['header'] not in columns or columns[c['header']]['field_id'] in readable)]
        result['row_ids']=[n for n in names if n in allowed]
        result['source_versions']={n:v for n,v in result.get('source_versions',{}).items() if n in allowed}
        result['applied']=len(result['cells'])
        return {**result,'object_id':binding['object_id'],'definition_revision':binding['definition_revision']}


def replay_guard(payload,request=None):
    """Cached per-cell results remain private after current source rights change."""
    binding=companions.get_object_companion(payload['object_id'])
    if not binding or binding['file_id']!=payload['file_id']:_fail('伴随绑定已变化')
    _operation(binding,payload.get('undo_of') or payload['op_id'],replay=True)
    from shangshu_core.action_requests import peek_result
    cached=peek_result(request) or {}
    cells=cached.get('cells') or []
    columns={c['header']:c['field_id'] for c in binding['field_columns']}
    names=list({c['row_id'] for c in cells})
    fields=list({columns[c['header']] for c in cells if c['header'] in columns})
    companions.authorize_companion_cells(binding['file_id'],names,fields,operation='write')


def input_schema(undo=False):
    props={'object_id':{'type':'string'},'file_id':{'type':'string'},'op_id':{'type':'string'},
        'definition_revision':{'type':'string'},'expected_revision':{'type':['integer','string']},
        'expected_content_version':{'type':'integer'},'expected_structure_version':{'type':'integer'}}
    if undo:
        props['undo_of']={'type':'string'}
    else:
        props['expected_modified']={'type':'object','additionalProperties':{'type':'string'}}
        props['cells']={'type':'array','items':{'type':'object','additionalProperties':False,
            'required':['row_id','header','value'],'properties':{'row_id':{'type':'string'},
                'header':{'type':'string'},'value':{'type':'object'}}}}
    return {'type':'object','additionalProperties':False,'required':list(props),'properties':props}
