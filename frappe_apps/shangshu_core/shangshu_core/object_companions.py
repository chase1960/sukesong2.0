"""One declared source object and one companion workbook; source records stay authoritative."""
import hashlib
import json
from contextlib import contextmanager

import frappe
from shangshu_core.domain_execution import domain_execution
from shangshu_core.identity import get_identity


class _NoCache:
    """没有缓存模块时（**替身环境**）⇒ 退化成「每次都真的读」（语义不变，只是不省）。"""

    @staticmethod
    def get(_key, loader):
        return loader()

    @staticmethod
    def clear(_prefix=None):
        return None


def _request_cache():
    """请求内缓存（**延迟取**）。

    为什么延迟：这个文件被若干判据**按文件路径**装载（那时 `shangshu_core`
    这个包还没进 `sys.modules`）⇒ 包级导入会当场 `ModuleNotFoundError`。
    延迟到调用时再取，装配已完成、包已就位；取不到就**退化成不缓存**
    （只是不省时间，**判定语义一字不变**）。
    """
    try:
        from shangshu_core import request_cache
        return request_cache
    except Exception:
        return _NoCache

DOCTYPE = 'Shangshu Object Companion'
MAX_INITIAL_ROWS = 10000
# ⚠️ **内核对「这条记录已回收」的原文**（`model_records._record`）——
#   只有这一种 ValidationError 才算「回收」；别的照旧抛出（不笼统吞）。
RECYCLED_MESSAGE = '记录已回收'


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def _spec(object_id, authorize=True):
    from shangshu_core import model_records, native_objects
    from shangshu_core.objects import get_object_definition
    managed=model_records.is_managed(object_id)
    if managed:
        if authorize:
            model, compiled, _ = model_records._load(object_id)
        else:
            model = frappe.get_doc(model_records.MODEL, object_id)
            compiled = json.loads(model.active_json or '{}')
        if compiled.get('kind') != 'record':
            _fail('明细对象不能单独绑定伴随表')
        fields = [f for f in compiled['fields'] if not f.get('deprecated')]
        columns = {f['id']: c['fieldname'] for f,c in zip(compiled['fields'], compiled['doctype']['fields'])}
        if any(f['type'] not in native_objects.SCALAR_TYPES for f in fields):
            _fail('含明细或关联复杂字段的对象尚未支持伴随投影')
        source = model.physical_doctype
        revision = str(model.active_revision)
        enterprise = model.enterprise_id
        enterprise_field = None
    else:
        declared = native_objects.declared(object_id)
        if not declared:
            _fail('对象未声明公共表格模型，不能创建伴随投影')
        _, item, block, _, _ = declared
        if authorize:
            native_objects.definition(object_id)
        fields = block['fields']
        columns = {f['id']: f['id'] for f in fields}
        source = item['doctype']
        revision = str(native_objects.revision(object_id))
        if not frappe.get_meta(source).has_field('enterprise_id'):
            _fail('原对象未声明可核验的企业范围，暂不能接入伴随表')
        enterprise = get_identity().enterprise_id
        enterprise_field = 'enterprise_id'
    fingerprint = hashlib.sha256(json.dumps({'source': source, 'fields': fields,
        'columns': columns, 'revision': revision}, sort_keys=True, default=str).encode()).hexdigest()
    return {'source_kind':'managed' if managed else 'native','source_doctype': source, 'fields': fields, 'columns': columns,
            'definition_revision': fingerprint, 'enterprise_id': enterprise, 'enterprise_field': enterprise_field}


def _public(doc):
    return {'object_id': doc.object_id, 'file_id': doc.file_id,
            'field_columns': json.loads(doc.field_columns_json),
            'definition_revision': doc.definition_revision, 'source_doctype': doc.source_doctype, 'enterprise_id': doc.enterprise_id}


def _find(field, value):
    if not frappe.db.exists('DocType', DOCTYPE):
        return None
    filters = {field: value}
    if field == 'object_id':
        filters['enterprise_id'] = get_identity().enterprise_id
    name = frappe.db.get_value(DOCTYPE, filters, 'name')
    return frappe.get_doc(DOCTYPE, name) if name else None


def _current(doc, authorize=True):
    if authorize and doc.enterprise_id != get_identity().enterprise_id:
        frappe.throw('伴随表不在当前企业',frappe.PermissionError)
    spec = _spec(doc.object_id, authorize)
    if doc.definition_revision != spec['definition_revision'] or doc.source_doctype != spec['source_doctype']:
        _fail('原对象定义已变化，伴随绑定须由FDE重新核验')
    return spec


def get_object_companion(object_id):
    with domain_execution('com.shangshu.core'):
        doc = _find('object_id', object_id)
        if not doc:
            return None
        _current(doc)
        return _public(doc)


def get_file_companion(file_id):
    with domain_execution('com.shangshu.core'):
        doc = _find('file_id', file_id)
        if not doc:
            return None
        _current(doc)
        return _public(doc)



# 日常授权的**每批行数**（2026-10-28 · PKG-132 · R24/R09 内核侧）：
# 一次取一批，批内**一次**取回；行数不再有硬上限（只有批大小）。
AUTHORIZE_BATCH = 500


def _chunks(items, size):
    """把一份清单切成**一批一批**（顺序不变）。"""
    size = max(1, int(size or 1))
    items = list(items)
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _identity_records(object_id, names, source_kind='managed'):
    """Source authorization reads identity/version only, never business values or detail panels."""
    if source_kind == 'native':
        from shangshu_core import native_objects
        result = {}
        # The native query retains its permission/enterprise predicates and page cap.
        for chunk in _chunks(names, 100):
            page = native_objects.query_records(object_id, {'name': ['in', chunk]},
                page=1, page_length=100, object_projection=True, fields=[], include_definition=False)
            result.update({str(row['name']): row for row in page['rows']})
        return result
    from shangshu_core import model_records
    return model_records.get_records(object_id, list(names), fields=[])


def _read_authorized_batch(object_id, names, source_kind='managed'):
    """Batch first; failures are rechecked individually with the same identity-only reader."""
    try:
        return _identity_records(object_id, names, source_kind)
    except (frappe.PermissionError, frappe.DoesNotExistError, frappe.ValidationError):
        return None


def authorize_companion_cells(file_id, record_ids, field_ids=None, operation='read'):
    """The file domain still checks file permissions; this is the source-side intersection.

    ⚠️ **日常授权不再被「一万行」硬拒**（2026-10-28 · PKG-132 · 审查报告 R24）：
      以前这里把**首次迁移**的容量上限（`MAX_INITIAL_ROWS` = 10000）也用在了**日常授权**上
      ⇒ 一张超过一万行的伴随表，**整页授权直接失败**（"原记录身份列表无效"）。
      ⇒ **首次接入**仍按一万行分阶段（见 `bind_object_companion` 的取行上限）；
        **日常授权**改成**分批**（每批一次取行），行数不再被硬拒。
    ⚠️ **授权走批量取行**（R09 内核侧）：以前是**逐行** `get_object_record`
      ⇒ 行数一多就线性变慢；现在**一次取一批**（与逐条读**同一套闸**）。
      那一批里若有人无权／已回收／不存在 ⇒ **退回逐条判定**（说清是哪一条，不吞错）。
    """
    from shangshu_core.objects import get_object_definition
    if operation not in ('read','write','structure','download'):
        _fail('伴随访问类型无效')
    # ⚠️ **形状闸只管形状，不管数量**（数量改由分批解决 —— 见上）。
    if not isinstance(record_ids,list) or any(not isinstance(n,str) or not n or len(n)>140 for n in record_ids):
        _fail('原记录身份列表无效')
    if field_ids is not None and (not isinstance(field_ids,list) or any(not isinstance(f,str) for f in field_ids)):
        _fail('原字段列表无效')
    with domain_execution('com.shangshu.core'):
        binding = _find('file_id',file_id)
        if not binding:
            return None
        source_spec=_current(binding)
        if operation == 'structure' and 'System Manager' not in frappe.get_roles():
            frappe.throw('当前不能更改原对象伴随表结构',frappe.PermissionError)
        definition = get_object_definition(binding.object_id)
        # Field capability is metadata, independent of the identity-only row result.
        readable = {f['id'] for f in definition.get('fields',[]) if f.get('id')}
        readable &= {f['id'] for f in source_spec['fields']}
        source_kind = source_spec.get('source_kind', 'managed')
        if source_kind == 'native':
            from shangshu_core import native_objects
            readable &= native_objects._readable_fields(source_spec['source_doctype'], readable | {'name', 'modified'})
        allowed=[]
        # ⚠️ **分批 + 批量取行**（2026-10-28 · PKG-132 · R24 与 R09 内核侧）：
        #   逐行 `get_object_record` ⇒ 行数一多就线性变慢；一次一万行更是直接被硬拒。
        #   ⇒ 现在**一批一批**来，每批**一次取回**（与逐条读**同一套闸**）。
        #   那一批里若有人无权／已回收／不存在 ⇒ **退回逐条判定**（说清是哪一条，不吞错）。
        wanted = list(dict.fromkeys(record_ids))
        for chunk in _chunks(wanted, AUTHORIZE_BATCH):
            batch = _read_authorized_batch(binding.object_id, chunk, source_kind)
            for name in chunk:
                if batch is not None:
                    record = batch.get(name)
                    if record is None:
                        if operation != 'read':
                            frappe.throw('目标原记录不在当前访问范围',frappe.PermissionError)
                        continue
                else:
                    # 这一批里有读不到的（无权／已回收／不存在）⇒ **逐条**说清是哪一条。
                    try:
                        record = _identity_records(binding.object_id, [name], source_kind).get(name)
                        if record is None:
                            if operation != 'read':
                                frappe.throw('目标原记录不在当前访问范围',frappe.PermissionError)
                            continue
                    except (frappe.PermissionError,frappe.DoesNotExistError):
                        if operation != 'read':
                            frappe.throw('目标原记录不在当前访问范围',frappe.PermissionError)
                        continue
                    except frappe.ValidationError as error:
                        # ⚠️ **被回收的记录**：**逐条跳过**，不打断整页授权
                        #   （2026-10-27 夜 · PKG-132 · 审查报告 R04：
                        #    一行被回收 ⇒ 那一行不可读，其余行照常；以前是**整页报错**）。
                        #   ⚠️ **只跳过「回收」这一种** —— 别的数据错误照旧抛出
                        #   （笼统吞 ValidationError 会把真错误说成「没权限」）。
                        if RECYCLED_MESSAGE not in str(error):
                            raise
                        continue
                allowed.append(name)
        requested = set(field_ids) if field_ids is not None else readable
        # field_ids refer only to source fields. New ordinary column headers are
        # governed by the file domain and must never be passed as business fields.
        if operation != 'read' and not requested.issubset(readable):
            frappe.throw('目标原字段不在当前访问范围',frappe.PermissionError)
        result={'allowed_record_ids':allowed,'readable_field_ids':sorted(readable & requested)}
        if operation=='download':
            from shangshu_core.field_access import field_allows_roles
            roles=frappe.get_roles()
            # Native bulk export is currently explicitly administrator-only.
            # A companion file must not create an alternate export capability.
            if source_spec.get('source_kind')=='native':
                from shangshu_core.native_objects import require_export_permission
                require_export_permission()
            fields={field['id']:field for field in source_spec['fields']}
            if any(fid not in fields or not field_allows_roles(fields[fid],roles,'download') for fid in requested):
                frappe.throw('原对象字段没有导出权限',frappe.PermissionError)
            result['downloadable_field_ids']=sorted(requested)
        return result


@contextmanager
def _projection_scope(binding):
    previous = getattr(frappe.flags,'shangshu_companion_projection',None)
    frappe.flags.shangshu_companion_projection = {'object_id':binding['object_id'],'file_id':binding['file_id']}
    try:
        yield
    finally:
        frappe.flags.shangshu_companion_projection = previous


def _project(binding, records, kind):
    from shangshu_core.domains import assert_domain_enabled
    assert_domain_enabled('com.shangshu.files')
    providers = frappe.get_hooks('shangshu_object_companion_project',app_name='shangshu_files') or []
    if len(providers)!=1 or not isinstance(providers[0],str) or not providers[0].startswith('shangshu_files.'):
        _fail('伴随文件投影服务未正确登记')
    with domain_execution('com.shangshu.files'), _projection_scope(binding):
        return frappe.get_attr(providers[0])(binding,records,kind if isinstance(kind,dict) else {'kind':kind})


def _snapshot(doc,spec):
    # Frappe Check stores 0/1; project the declared boolean value, just as the
    # public source reader does. Ordinary numeric zero and nullable values stay intact.
    values = {}
    for field in spec['fields']:
        value = doc.get(spec['columns'][field['id']])
        if field.get('type') == 'boolean' and value is not None:
            value = bool(value)
        values[field['id']] = value
    return {'name':doc.name,'modified':str(doc.modified or ''),'values':values}


def bind_object_companion(object_id,file_id,field_columns):
    # 绑定要变了 ⇒ 本次请求里**别再拿旧绑定**（2026-10-27 夜 · PKG-132 性能线）。
    _request_cache().clear("companion")
    if 'System Manager' not in frappe.get_roles():
        frappe.throw('仅FDE管理员可登记原对象伴随表',frappe.PermissionError)
    with domain_execution('com.shangshu.core'):
        from shangshu_core.model_records import is_managed
        if is_managed(object_id):
            from shangshu_core.write_zone_schema import revoke_certification
            revoke_certification(object_id)
        spec = _spec(object_id)
        expected = {f['id']:f for f in spec['fields']}
        if not isinstance(field_columns,list) or any(not isinstance(c,dict) for c in field_columns):
            _fail('字段映射无效')
        if {c.get('field_id') for c in field_columns} != set(expected) or len(field_columns)!=len(expected):
            _fail('须完整映射原对象声明字段，不可重复或遗漏')
        headers=[c.get('header') for c in field_columns]
        if any(not isinstance(h,str) or not h.strip() or len(h)>200 for h in headers) or len(set(headers))!=len(headers):
            _fail('伴随列名称无效或重复')
        columns=[{'field_id':c['field_id'],'header':c['header'],'type':expected[c['field_id']]['type']} for c in field_columns]
        prior=_find('object_id',object_id)
        if prior:
            if prior.file_id!=file_id or json.loads(prior.field_columns_json)!=columns:
                _fail('该原对象已经绑定另一份伴随表或字段映射')
            _current(prior)
            return _public(prior)
        if _find('file_id',file_id):
            _fail('该工作文件已经绑定其他原对象')
        owner_enterprise = _file_enterprise(file_id)
        if owner_enterprise != get_identity().enterprise_id:
            frappe.throw('伴随文件归属不在当前企业',frappe.PermissionError)
        table=spec['source_doctype'].replace('`','``')
        where=' WHERE enterprise_id=%s' if spec['enterprise_field'] else ''
        params=(spec['enterprise_id'],) if spec['enterprise_field'] else ()
        # ⚠️ **首次接入不把已回收的行纳进来**（2026-10-27 夜 · PKG-132 · 审查报告 R04）：
        #   回收的行**不该**被投影进伴随表（它是回收态，不是可用数据）。
        recycled_filter=''
        try:
            if frappe.get_meta(spec['source_doctype']).has_field('ss_recycled'):
                recycled_filter=(' AND ' if where else ' WHERE ')+'COALESCE(`ss_recycled`,0)=0'
        except Exception:
            recycled_filter=''
        names=[row[0] for row in frappe.db.sql('SELECT name FROM `tab'+table+'`'+where+recycled_filter+' ORDER BY name LIMIT '+str(MAX_INITIAL_ROWS+1)+' FOR UPDATE',params)]
        if len(names)>MAX_INITIAL_ROWS:
            _fail('首次接入超过一万行，需分阶段迁移，不能截断投影')
        records=[frappe.get_doc(spec['source_doctype'],name,for_update=True) for name in names]
        doc=frappe.get_doc({'doctype':DOCTYPE,'object_id':object_id,'file_id':file_id,
            'enterprise_id':spec['enterprise_id'],'binding_key':hashlib.sha256((str(spec['enterprise_id'])+'\0'+object_id).encode()).hexdigest(),
            'source_doctype':spec['source_doctype'],'definition_revision':spec['definition_revision'],
            'field_columns_json':json.dumps(columns,ensure_ascii=False)}).insert(ignore_permissions=True)
        result=_public(doc)
        _project(result,[_snapshot(record,spec) for record in records],'initial')
        return result


def bind_action(action_id,payload,context=None):
    return bind_object_companion(payload['object_id'],payload['file_id'],payload['field_columns'])


def sync_source_document(doc,method=None):
    """受管记录保存后，把投影同步到伴随的普通列。

    ⚠️ **同一请求内复用**（2026-10-27 夜 · PKG-132 性能线）：
    这段以前每次保存都问两遍「伴随表 DocType 在不在」「哪些行绑着这份对象」
    ⇒ 批量写 500 行就是上千条**每次都一样的**查询。
    ⇒ 改成**同一请求内读一次**（`request_cache`）。

    ⚠️ **绑定/解绑之后必须清缓存**：`bind_object_companion` 会
    `request_cache.clear("companion")` ⇒ 这次请求里不会拿旧绑定。
    """
    if not _companion_doctype_exists():
        return
    names=_companion_binding_names(doc)
    if not names:
        return
    with domain_execution('com.shangshu.core'):
        for name in names:
            binding=frappe.get_doc(DOCTYPE,name,for_update=True)
            spec=_current(binding,authorize=False)
            if spec['enterprise_field'] and doc.get(spec['enterprise_field']) != binding.enterprise_id:
                continue
            deferred=getattr(frappe.flags,'shangshu_companion_deferred',None) or {}
            if deferred.get('object_id')==binding.object_id and deferred.get('file_id')==binding.file_id:
                continue
            _project(_public(binding),[_snapshot(doc,spec)],'update')


def _companion_doctype_exists():
    """伴随表这个 DocType 在不在 —— **同一请求内读一次**。"""
    return _request_cache().get(
        "companion:doctype_exists",
        lambda: bool(frappe.db.exists('DocType', DOCTYPE)),
    )


def _companion_binding_names(doc):
    """这份对象绑着哪些伴随行 —— **同一请求内读一次**（按筛选条件分键）。"""
    filters=_source_binding_filters(doc)
    key=("companion:bindings", json.dumps(filters, sort_keys=True, default=str))
    return _request_cache().get(
        key,
        lambda: frappe.get_all(DOCTYPE,filters=filters,pluck='name'),
    )


def guard_source_delete(doc,method=None):
    if frappe.db.exists('DocType',DOCTYPE) and frappe.db.exists(DOCTYPE,_source_binding_filters(doc)):
        _fail('该对象已绑定伴随表，删除处置尚未配置，不能丢失普通列关联')


def list_object_companion_files():
    """Internal catalog exclusion IDs only; not a content or access capability."""
    if not frappe.db.exists('DocType',DOCTYPE):
        return []
    return frappe.get_all(DOCTYPE,pluck='file_id',limit_page_length=0)


def _source_binding_filters(doc):
    filters = {'source_doctype':doc.doctype}
    # Native records carry enterprise scope. Managed physical tables are already
    # unique to their model/enterprise; they have no enterprise_id column.
    if frappe.get_meta(doc.doctype).has_field('enterprise_id'):
        filters['enterprise_id'] = doc.get('enterprise_id') or ''
    return filters


def _file_enterprise(file_id):
    from shangshu_core.org_admin import resource_attribution
    att = resource_attribution(file_id)
    if not att:
        _fail('伴随工作文件须先明确组织归属')
    if att.get('level') == 'department' and att.get('department'):
        enterprise = frappe.db.get_value('Shangshu Department',att['department'],'enterprise_id')
    elif att.get('level') == 'personal' and att.get('owner_user'):
        enterprise = frappe.db.get_value('Shangshu Identity',{'user':att['owner_user']},'enterprise_id')
    else:
        _fail('伴随工作文件归属须为明确的个人或部门，不能猜测企业级归属')
    if not enterprise:
        _fail('伴随工作文件归属无法解析到有效企业')
    return enterprise
