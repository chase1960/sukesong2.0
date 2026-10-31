"""受管普通记录回收；原行保留，权限/确认/幂等/审计由既有公共链执行。"""
import json
from zoneinfo import ZoneInfo
import frappe
from frappe.utils import now_datetime, get_datetime, get_system_timezone
from pypika.functions import Coalesce

from shangshu_core import subject_access


FIELDS = [
    {'fieldname':'ss_recycled','label':'已回收','fieldtype':'Check','default':'0','search_index':1,'hidden':1,'read_only':1},
    {'fieldname':'ss_recycled_at','label':'回收时间','fieldtype':'Datetime','hidden':1,'read_only':1},
    {'fieldname':'ss_recycled_by','label':'回收人','fieldtype':'Link','options':'User','hidden':1,'read_only':1},
]


def physical_definition(compiled):
    physical = compiled['doctype']
    return {**physical,'fields':[*physical['fields'], *([] if compiled['kind']=='detail' else FIELDS)]}


def migrate_record_lifecycle():
    """仅由独立升级调用；不改生效业务定义、记录内容/归属/modified。"""
    if frappe.db.transaction_writes or getattr(frappe.flags,'shangshu_domain_execution_depth',0):
        frappe.throw('回收字段迁移必须在独立升级事务执行',frappe.ValidationError)
    report={'migrated':[], 'skipped':[]}
    for model in frappe.get_all('Shangshu Object Model',filters={'active_revision':['>',0]},fields=['name','application','physical_doctype','active_json']):
        # 历史清理可能只撤了父应用及 DocType，留下模型/物理数据。仅以权威
        # Application Definition 的实际缺失证明孤儿；不重建、不改孤儿数据。
        application=str(model.application or '').strip()
        if not application:
            frappe.throw('受管模型缺少归属应用，停止迁移：'+model.name,frappe.ValidationError)
        if not frappe.db.exists('Shangshu Application Definition',application):
            evidence={'model':model.name,'application':application,
                      'physical_doctype':model.physical_doctype,'reason':'missing_parent_application'}
            report['skipped'].append(evidence)
            warning='record_lifecycle.orphan_skip '+json.dumps(evidence,ensure_ascii=False)
            frappe.logger('shangshu_core').warning(warning)
            print('WARNING: '+warning)
            continue
        compiled=json.loads(model.active_json)
        if compiled['kind']!='record':continue
        doc=frappe.get_doc('DocType',model.physical_doctype)
        if not doc.custom or doc.module!='Shangshu Core':
            frappe.throw('物理表不属于受管对象，停止迁移',frappe.ValidationError)
        existing={field.fieldname:field for field in doc.fields}
        for field in FIELDS:
            if field['fieldname'] in existing:
                if existing[field['fieldname']].fieldtype!=field['fieldtype']:
                    frappe.throw('回收字段与原定义冲突，停止迁移',frappe.ValidationError)
            else:doc.append('fields',field)
        if not all(field['fieldname'] in existing for field in FIELDS):
            doc.save(ignore_permissions=True)
        frappe.db.updatedb(doc.name)  # 可恢复 DDL 中断；不删除已有业务列。
        frappe.clear_cache(doctype=doc.name)
        frappe.db.commit()
        report['migrated'].append(model.name)
    return report


def available(doctype):
    return all(frappe.get_meta(doctype).has_field(f['fieldname']) for f in FIELDS)


def allowed(compiled,roles,subject=None):
    """这个人**能不能回收/恢复**这条受管记录。

    ★ **两条链，两个形状（2026-10-26 原收敛条目 02）**：
      · **受管表链**（`access` 是**主体范围**形状：五操作 × 全局/部门/个人/无人）
        ⇒ 走 `subject_access` 那**同一份有效定义**（列 → 列的读 → 表 → 表的读）
        ⇒ **不再拿旧三键判一次**。
        （改之前这里只认 `read_roles`/`write_roles`/`recycle_roles` ⇒ 在新形状里
        取到空列表 ⇒ **非管理员一律被拒** ⇒ 部门成员即使写档是「部门」、
        本人就在那个部门，也回收不了。）
      · **建模对象链**（`access` 是**旧三键**形状）⇒ 照旧按旧三键判
        （`read_roles`/`write_roles`/`recycle_roles` **三者都要命中**）⇒ 行为不变。

    **回收/恢复这个动作落在「写」档上**（改记录就是写）⇒ 与其它入口同一份定义。

    `subject` 是**主体上下文**（`org_admin.subject_context` 的返回）。
    ⚠️ **不传就现取**（与 `model_records._subject` 同一口径：**不缓存** ⇒
    撤权/调岗后下一包立刻是新结论）。
    """
    from shangshu_core import business_access
    business_access.require_identity()
    if business_access.is_open():
        return True
    access=compiled.get('access',{})
    if not subject_access.is_subject_access(access):
        # **建模对象链**（旧三键）：照旧判，行为一个字不变
        return 'System Manager' in roles or all(roles.intersection(access.get(rule,[])) for rule in ('read_roles','write_roles','recycle_roles'))
    # **受管表链**（主体范围）：走内核那份有效定义
    if 'System Manager' in roles:
        return True
    from shangshu_core.org_admin import subject_context
    if subject is None:
        subject=subject_context(frappe.session.user)
    # 列级写档更严时以列级为准（继承链 = 列 → 列的读 → 表 → 表的读）
    field_access={}
    for field in compiled.get('fields') or []:
        if field.get('type')=='detail':
            continue
        field_access=field.get('access') or {}
        break
    try:
        scope=subject_access.resolve_op_scope(field_access,access,'write')
    except ValueError:
        # 声明坏了/缺操作 ⇒ **拒**（fail-closed，不猜不放行）
        return False
    return bool(subject_access.subject_allows(scope,subject))


def require_access(model,compiled,roles,subject=None):
    if not allowed(compiled,roles,subject=subject):
        frappe.throw('没有回收和恢复记录的权限',frappe.PermissionError)
    if not available(model.physical_doctype):
        frappe.throw('该表尚未完成回收字段升级',frappe.ValidationError)


def metadata(doc):
    return {'state':'trash' if doc.get('ss_recycled') else 'active',
            'recycled_at':get_datetime(doc.ss_recycled_at).replace(tzinfo=ZoneInfo(get_system_timezone())).isoformat() if doc.get('ss_recycled_at') else None,
            'recycled_by':(frappe.db.get_value('User',doc.ss_recycled_by,'full_name') or doc.ss_recycled_by) if doc.get('ss_recycled_by') else None}


def assert_no_incoming(model,name):
    """只检查受管应用内显式 Link，包含已弃用列/明细；不暴露引用人或内容。"""
    from shangshu_core.model_records import MODEL
    models=frappe.qb.DocType(MODEL)
    # 锁应用前可能已有一致性读快照；这里必须当前读，不能漏掉刚提交的模型/引用。
    candidates=frappe.qb.from_(models).select(models.physical_doctype,models.active_json).where((models.application==model.application)&(models.active_revision>0)).for_update().run(as_dict=True)
    for other in candidates:
        schema=json.loads(other.active_json)
        if schema['kind']!='record':continue
        table=frappe.qb.DocType(other.physical_doctype)
        for column in frappe.get_meta(other.physical_doctype).fields:
            if column.fieldtype=='Link' and column.options==model.physical_doctype:
                query=frappe.qb.from_(table).select(table.name).where(table[column.fieldname]==name)
            elif column.fieldtype=='Table':
                child=frappe.qb.DocType(column.options)
                links=[f.fieldname for f in frappe.get_meta(column.options).fields if f.fieldtype=='Link' and f.options==model.physical_doctype]
                if not links:continue
                from pypika import Criterion
                query=frappe.qb.from_(table).join(child).on((child.parent==table.name)&(child.parenttype==other.physical_doctype)&(child.parentfield==column.fieldname)).select(table.name).where(Criterion.any([child[f]==name for f in links]))
            else:continue
            if frappe.get_meta(other.physical_doctype).has_field('ss_recycled'):
                query=query.where(Coalesce(table.ss_recycled,0)==0)
            if other.physical_doctype==model.physical_doctype:query=query.where(table.name!=name)
            if query.limit(1).for_update().run():
                frappe.throw('记录仍被在用记录引用，请先处理关联后再回收',frappe.ValidationError)


def assert_targets_active(doc):
    # 校验所有存储的 Link（含弃用列），避免恢复后带回失效关联；不要求额外读取目标内容权限。
    for field in frappe.get_meta(doc.doctype).fields:
        value=doc.get(field.fieldname)
        if field.fieldtype=='Link' and field.options and field.options.startswith('SSM ') and value:
            if field.options==doc.doctype and value==doc.name:continue
            target=frappe.db.get_value(field.options,value,'ss_recycled',for_update=True) if frappe.get_meta(field.options).has_field('ss_recycled') else None
            if target or not frappe.db.exists(field.options,value):
                frappe.throw('关联目标已回收或不存在，请先恢复关联目标',frappe.ValidationError)
        elif field.fieldtype=='Table':
            for row in value or []:assert_targets_active(row)


def change_state(action_id,payload,context):
    from shangshu_core.model_records import _load,_record,_writing,_apply
    if not context.get('confirmed') or not getattr(frappe.flags,'shangshu_action_pin',None):
        frappe.throw('回收恢复必须经过公共动作确认',frappe.PermissionError)
    model,compiled,roles=_load(payload['object_id'],write=True)
    from shangshu_core.model_records import _subject
    require_access(model,compiled,roles,subject=_subject(compiled,roles))
    if payload['expected_revision']!=model.active_revision:
        frappe.throw('字段定义已变化，请刷新后重试',frappe.TimestampMismatchError)
    doc=_record(model,compiled,roles,payload['name'],include_recycled=True,for_update=True)
    if str(doc.modified)!=payload['expected_modified']:
        frappe.throw('记录已被修改，请刷新后重试',frappe.TimestampMismatchError)
    recycle=action_id=='platform.object.recycle'
    if action_id not in ('platform.object.recycle','platform.object.restore') or bool(doc.get('ss_recycled'))==recycle:
        frappe.throw('记录状态已变化，请刷新后重试',frappe.ValidationError)
    if recycle:assert_no_incoming(model,doc.name)
    else:
        assert_targets_active(doc)
        _apply(doc,compiled,roles,{})  # 当前必填/类型/明细约束，恢复不能绕过新规则。
        from shangshu_core.model_records import assert_unique
        assert_unique(doc,compiled,{f['id']:c['fieldname'] for f,c in zip(compiled['fields'],compiled['doctype']['fields'])})
    doc.ss_recycled=int(recycle)
    doc.ss_recycled_at=now_datetime() if recycle else None
    doc.ss_recycled_by=frappe.session.user if recycle else None
    from shangshu_core.managed_nulls import preserve_nulls
    with _writing(), preserve_nulls(doc, compiled):
        doc.save(ignore_permissions=True)
    context['record_change']={'doctype':doc.doctype,'name':doc.name,
        'data':{'version':1,'object_id':model.name,'revision':model.active_revision,'changes':[]}}
    return {'object_id':model.name,'name':doc.name,'modified':str(doc.modified),'revision':model.active_revision,
            'state':'trash' if recycle else 'active'}
