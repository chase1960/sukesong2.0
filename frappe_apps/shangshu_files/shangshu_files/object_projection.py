"""Existing object companion workbook: projection values only, never a new business store."""
import copy
import datetime
import json
import frappe
from shangshu_files import sheet


def _scope(binding):
    scope=getattr(frappe.flags,'shangshu_companion_projection',None) or {}
    if scope.get('object_id')!=binding.get('object_id') or scope.get('file_id')!=binding.get('file_id'):
        frappe.throw('伴随投影仅允许核心已登记对象同步',frappe.PermissionError)


def apply_snapshot(ws,meta,binding,records,initial=False):
    """Pure workbook change. Rows are immutable source record names, never page positions."""
    columns=binding.get('field_columns') or []
    if not columns or len({c['header'] for c in columns})!=len(columns) or len({c['field_id'] for c in columns})!=len(columns):
        raise ValueError('伴随字段映射为空或重复')
    names=[str(row.get('name') or '') for row in records]
    if any(not name or len(name)>140 for name in names) or len(set(names))!=len(names):
        raise ValueError('原对象记录身份无效或重复')
    current=list(meta.get('rows') or [])
    old_headers=[str(cell.value or '') for cell in ws[1]]
    if initial and not meta.get('object_companion'):
        if any(cell.value not in (None,'',' ') for row in ws.iter_rows(min_row=2) for cell in row):
            raise ValueError('首次接入须使用空白伴随工作文件，不能猜测已有行对应哪条原记录')
        current=[]
        # Reuse the blank initial grid rather than expose an artificial empty column.
        if not any(cell.value not in (None,'',' ','列1') for cell in ws[1]):
            for index,col in enumerate(columns,1):ws.cell(1,index).value=col['header']
            old_headers=[str(cell.value or '') for cell in ws[1]]
    header_index={h:i+1 for i,h in enumerate(old_headers)}
    for col in columns:
        if col['header'] not in header_index:
            if not initial:raise ValueError('伴随绑定列已变化，须重新核对映射')
            index=len(header_index)+1;ws.cell(1,index).value=col['header'];header_index[col['header']]=index
    positions={name:i+2 for i,name in enumerate(current)}
    changed=[]
    for record in records:
        name=str(record['name'])
        if name not in positions:
            current.append(name);positions[name]=len(current)+1
        for col in columns:
            if col['field_id'] not in record.get('values',{}):raise ValueError('投影快照缺少声明字段')
            cell=ws.cell(positions[name],header_index[col['header']]);value=record['values'][col['field_id']]
            if isinstance(value,(dict,list,tuple)):raise ValueError('本期伴随列仅支持标量字段')
            if cell.value!=value:
                changed.append({'row_id':name,'header':col['header'],'before':sheet.cell_typed(cell),'value':value})
                old_format=cell.number_format
                cell.value=value
                # Strings originating from a business field are literals, even if they start '='.
                if isinstance(value,str):cell.data_type='s'
                # ⚠️ **2026-10-28 修的真实缺陷（隔离站实测撞出来的）**：
                #   **日期值必须带上日期格式**，不能照抄原格格式。
                #   改之前：原格格式是「常规」⇒ 日期被写成「一个光秃秃的序号数」
                #   （2026-10-03 存成 46298）⇒ ① 人看到的不是日期；
                #   ② 保存校验闸当场判「未改内容被改动（…!B2）」⇒ **整次绑定作废**。
                #   ⇒ 凡是带**日期列**的伴随表，第一次接入**必然失败**（不是偶发）。
                #   口径与普通单格写一致（`sheet._apply_value` 的 date 档：`yyyy-mm-dd`）。
                if isinstance(value,(datetime.datetime,datetime.date)):
                    cell.number_format='yyyy-mm-dd'
                else:
                    cell.number_format=old_format
    meta['rows']=current
    meta['object_companion']={'object_id':binding['object_id'],'field_columns':copy.deepcopy(columns),
                              'definition_revision':binding.get('definition_revision')}
    source_versions=dict(meta.get('companion_source_versions') or {})
    source_versions.update({str(row['name']):str(row.get('modified') or '') for row in records})
    meta['companion_source_versions']=source_versions
    return changed


def _project_existing_values(doc, meta, binding, records, event):
    """Bound source rows use one value-only ZIP plan and the existing operation ledger."""
    content = sheet._content(doc, for_write=True)
    seg = sheet._Seg()
    ctx = sheet._fast_ctx(doc, content, {}, seg, companion_cells=True)
    headers = ctx['entry']['headers']
    positions = {rid: i for i, rid in enumerate(ctx['meta'].get('rows') or [])}
    columns = binding.get('field_columns') or []
    if (not columns or len({c['header'] for c in columns}) != len(columns)
            or len({c['field_id'] for c in columns}) != len(columns)):
        frappe.throw('伴随字段映射为空或重复', frappe.ValidationError)
    if any(headers.count(col['header']) != 1 for col in columns):
        frappe.throw('伴随绑定列已变化，须重新核对映射', frappe.ValidationError)
    names = [str(row.get('name') or '') for row in records]
    if len(set(names)) != len(names) or any(name not in positions for name in names):
        frappe.throw('投影目标行身份不存在或重复', frappe.ValidationError)
    mixed = event.get('kind') in ('mixed', 'mixed_undo')
    bound = {col['header'] for col in columns}
    requested = {(item['row_id'], item['header']) for item in event.get('source_targets') or []}
    if any(rid not in names or header not in bound for rid, header in requested):
        frappe.throw('源字段目标已变化', frappe.ValidationError)
    cells = []
    for record in records:
        rid = str(record['name'])
        if not record.get('modified'):
            frappe.throw('投影快照缺少源记录版本', frappe.ValidationError)
        source = record.get('values') or {}
        raw = ctx['entry']['rows_raw'][positions[rid]]
        for column in columns:
            field, header = column['field_id'], column['header']
            if field not in source:
                frappe.throw('投影快照缺少声明字段', frappe.ValidationError)
            value = source[field]
            if isinstance(value, (dict, list, tuple)):
                frappe.throw('本期伴随列仅支持标量字段', frappe.ValidationError)
            typed = {'type': 'text', 'value': value} if isinstance(value, str) else sheet.value_typed(value)
            ci = headers.index(header)
            before = sheet.value_typed(raw[ci] if ci < len(raw) else None)
            if not sheet._typed_equal(before, typed) or (mixed and (rid, header) in requested):
                cells.append({'row_id': rid, 'header': header, 'value': typed})
    if mixed:
        ordinary = event.get('ordinary_cells') or []
        if not isinstance(ordinary, list) or len(ordinary) > 20000:
            frappe.throw('普通格范围无效', frappe.ValidationError)
        if any(not isinstance(item, dict) for item in ordinary):
            frappe.throw('目标格无效', frappe.ValidationError)
        if any(item.get('header') in bound for item in ordinary):
            frappe.throw('原字段不能经普通格通道写入', frappe.PermissionError)
        cells.extend(ordinary)
    source_versions = dict(ctx['meta'].get('companion_source_versions') or {})
    source_versions.update({str(row['name']): str(row['modified']) for row in records})
    context = event.get('context') or {}
    action = 'platform.object.companion_undo' if event.get('kind') == 'mixed_undo' else 'platform.object.companion_write'
    audit = []
    plan = None
    if cells:
        payload = {'table': doc.name, 'cells': cells,
                   'expected_content_version': sheet.content_revision(doc),
                   'expected_structure_version': int(ctx['meta'].get('structure_version') or 1)}
        if mixed:
            payload['op_id'] = event['op_id']
        plan = sheet._fast_plan_cells(doc, content, payload, context, seg,
            prepared=ctx, action_id=action if mixed else None)
        plan['meta']['companion_source_versions'] = source_versions
        if mixed:
            raw_source = {(item['row_id'], item['header']): item for item in event.get('source_values') or []}
            audit = copy.deepcopy(plan['cells_out'])
            for item in audit:
                key = item['row_id'], item['header']
                item['input_target'] = item['header'] not in bound or key in requested
                if key in raw_source:
                    item['source_raw_before'] = raw_source[key]['before']
                    item['source_raw_after'] = raw_source[key]['after']
                item['source_modified'] = source_versions.get(item['row_id'])
            # Physical edits discard no-op cells, but undo must retain every input
            # target and its source snapshot, including normalized equal values.
            plan['audit_cells'] = audit
    changed = plan is not None and any(not sheet._typed_equal(item['before'], item['after'])
                                      for item in plan['cells_out'])
    sheet._fault('companion-before-save')
    if changed:
        result = sheet._commit_cell_plan(doc, plan, context, seg, projection_only=True)
    else:
        if plan is not None or source_versions != ctx['meta'].get('companion_source_versions') or mixed:
            ctx['meta']['companion_source_versions'] = source_versions
            sheet._save_meta(doc, ctx['meta'])
        version = sheet.content_revision(doc)
        if mixed:
            sheet._record_op(doc, action, event['op_id'], audit, version, context)
        result = {'table': doc.name, 'content_version': version, 'applied': 0,
                  'structure_version': int(ctx['meta'].get('structure_version') or 1), 'cells': audit}
    if event.get('kind') == 'mixed_undo':
        original = frappe.db.get_value(sheet.OP_DOCTYPE, {'file': doc.name, 'op_id': event.get('undo_of')}, 'name')
        if not original:
            frappe.throw('原混合包操作不存在', frappe.ValidationError)
        frappe.db.set_value(sheet.OP_DOCTYPE, original, 'undone', 1, update_modified=False)
    return {**result, 'file_id': doc.name, 'row_ids': names, 'op_id': event.get('op_id'),
            'source_versions': {name: source_versions[name] for name in names}}


def project(binding,records,event):
    """Core invokes the registered provider in its transaction; no arbitrary caller payload."""
    _scope(binding)
    doc=frappe.get_doc(sheet.DOCTYPE,binding['file_id'],for_update=True)
    mixed=event.get('kind') in ('mixed','mixed_undo')
    if event.get('kind')=='initial' or mixed:
        from shangshu_files.service import _can_write
        doc.check_permission('read')
        if not _can_write(doc):frappe.throw('首次接入需拥有伴随工作文件写权',frappe.PermissionError)
    if doc.status!='Active':frappe.throw('伴随工作文件不可用，原对象同步未完成',frappe.ValidationError)
    meta=sheet._load_meta(doc)
    prior_binding=meta.get('object_companion')
    if mixed:
        sheet._check_versions(doc,meta,event)
        if not event.get('op_id'):frappe.throw('混合包缺少操作身份',frappe.ValidationError)
        if frappe.db.exists(sheet.OP_DOCTYPE,{'file':doc.name,'op_id':event['op_id']}):frappe.throw('混合包操作身份已使用，请使用原请求重试',frappe.ValidationError)
        authorize_rows(doc,[c.get('row_id') for c in event.get('ordinary_cells') or [] if isinstance(c,dict)])
    if (meta.get('promotion') or meta.get('promotion_binding')
            or (doc.formal_values_json and doc.formal_values_json not in ('{}','null'))):
        frappe.throw('既有对象不能绑定另一个正式字段库',frappe.ValidationError)
    if mixed and (not prior_binding or any(str(record.get('name') or '') not in (meta.get('rows') or []) for record in records)):
        frappe.throw('混合包目标行绑定已变化，本次未保存', frappe.ValidationError)
    # Existing-value updates are distinct from initial binding/new source-row structure work.
    if (event.get('kind') in ('update', 'mixed', 'mixed_undo') and prior_binding
            and all(str(record.get('name') or '') in (meta.get('rows') or []) for record in records)):
        return _project_existing_values(doc, meta, binding, records, event)
    content=sheet._content(doc,for_write=True);wb=sheet.safe_open(content,for_write=True);ws=wb.active
    meta.setdefault('primary_sheet','S-1');meta.setdefault('sheet_name',ws.title);meta.setdefault('sheet_title',ws.title)
    prior_rows=list(meta.get('rows') or []);prior_headers=[c.value for c in ws[1]]
    try:changes=apply_snapshot(ws,meta,binding,records,initial=event.get('kind')=='initial')
    except ValueError as error:frappe.throw(str(error),frappe.ValidationError)
    if prior_binding and not changes and meta.get('companion_source_versions')==sheet._load_meta(doc).get('companion_source_versions'):
        return {'file_id':doc.name,'content_version':sheet.content_revision(doc),'row_ids':meta.get('rows',[]),'applied':0}
    if prior_rows!=meta.get('rows') or prior_headers!=[c.value for c in ws[1]]:
        meta['structure_version']=int(meta.get('structure_version') or 1)+1
    # The existing serializer, formula recalculation and working-file rollback journal
    # are the sole persistence path. The narrowly-scoped provider capability supplies
    # write authorization even when the business actor does not own the file.
    sheet._fault('companion-before-save')
    version=sheet._save_with_gates(doc,wb,ws,meta,batch_note='原对象伴随投影')
    return {'file_id':doc.name,'table':doc.name,'content_version':version,'structure_version':int(meta.get('structure_version') or 1),'row_ids':meta.get('rows',[]),'applied':len(changes),'cells':changes,'op_id':event.get('op_id'),'source_versions':meta.get('companion_source_versions') or {}}


def system_projection_allows(doc):
    scope=getattr(frappe.flags,'shangshu_companion_projection',None) or {}
    return bool(scope.get('object_id') and scope.get('file_id')==doc.name)


def binding_for(doc):
    if not sheet._load_meta(doc).get('object_companion'):
        return None
    from shangshu_core.public_api import get_file_companion
    binding=get_file_companion(doc.name)
    if not binding:frappe.throw('原对象伴随登记已失效，请由FDE核对',frappe.ValidationError)
    return binding


def read_access(doc,record_ids):
    binding=binding_for(doc)
    if not binding:return None
    from shangshu_core.public_api import authorize_companion_cells
    if not isinstance(record_ids,(list,tuple)):
        frappe.throw('伴随读取必须明确目标记录范围',frappe.ValidationError)
    requested = list(dict.fromkeys(record_ids))
    # A selected formula may read a different row: authorize only those actual
    # dependencies as well, without classifying unrelated formula rows as denied.
    selected = set(requested)
    dependencies = [d.get('row_id')
        for key, result in (sheet._load_meta(doc).get('formula_results') or {}).items()
        if key.split('\0', 1)[0] in selected
        for d in result.get('dependencies', result.get('bindings', {}).values()) if d.get('row_id')]
    checked = list(dict.fromkeys(requested + dependencies))
    access = authorize_companion_cells(doc.name, checked,
        [c['field_id'] for c in binding['field_columns']], operation='read')
    return {**access, 'scope_record_ids': requested}



def hidden_headers(doc,access=None):
    """当前用户**读不到的**伴随列（`set[str]`）。

    ⚠️ **`access` 是「已经算好的那一份授权」**（R09）：调用方（读路径）**已经**
    算过一次行级＋列级授权 ⇒ 这里**直接复用**，**不许再算一遍**。
    改之前这里自己调 `read_access(doc)` —— 而那个口**不传 record_ids**
    ⇒ 又按全表算一次 ⇒ **一次读跑两轮全表授权**。
    ★ 不传 `access`（老调用方）⇒ 仍走自己算那条路（**不静默改变别的调用方的行为**）。
    """
    binding=binding_for(doc)
    if not binding:return set()
    if access is None:
        dependencies = list(dict.fromkeys(d.get('row_id') for result in (sheet._load_meta(doc).get('formula_results') or {}).values()
            for d in result.get('dependencies', result.get('bindings', {}).values()) if d.get('row_id')))
        access=read_access(doc, dependencies)
        if access is not None:
            access = dict(access)
            access.pop('scope_record_ids', None)  # This call explicitly covers every formula dependency.
    if access is None:return set()
    readable=set(access['readable_field_ids'])
    hidden={c['header'] for c in binding['field_columns'] if c['field_id'] not in readable}
    allowed=set(access['allowed_record_ids'])
    scoped = set(access['scope_record_ids']) if 'scope_record_ids' in access else None
    for key,result in (sheet._load_meta(doc).get('formula_results') or {}).items():
        if scoped is not None and key.split('\0',1)[0] not in scoped:
            continue
        if any(d.get('row_id') not in allowed for d in result.get('dependencies',result.get('bindings',{}).values())):
            hidden.add(key.split('\0',1)[1])
    return hidden


def require_read(doc):
    binding=binding_for(doc)
    if not binding:return
    rows=set(sheet._load_meta(doc).get('rows') or [])
    access=read_access(doc,list(rows))
    fields={c['field_id'] for c in binding['field_columns']}
    if rows-set(access['allowed_record_ids']) or fields-set(access['readable_field_ids']):
        frappe.throw('当前不能读取伴随表的全部原对象记录或字段',frappe.PermissionError)


def require_download(doc):
    binding=binding_for(doc)
    if not binding:return
    from shangshu_core.public_api import authorize_companion_cells
    rows=set(sheet._load_meta(doc).get('rows') or [])
    fields={c['field_id'] for c in binding['field_columns']}
    access=authorize_companion_cells(doc.name,list(rows),sorted(fields),operation='download')
    if rows-set(access['allowed_record_ids']) or fields-set(access['readable_field_ids']) or fields-set(access.get('downloadable_field_ids',[])):
        frappe.throw('无权导出伴随表的全部原对象记录或字段',frappe.PermissionError)


def reject_bound_targets(doc,headers):
    if system_projection_allows(doc):return
    binding=binding_for(doc)
    if binding and set(headers)&{c['header'] for c in binding['field_columns']}:
        frappe.throw('原业务字段须通过原对象受管动作修改，不能直接改工作文件投影',frappe.PermissionError)


def before_save(doc,ws,meta):
    if system_projection_allows(doc):return
    binding=binding_for(doc)
    if not binding:return
    from shangshu_core.public_api import authorize_companion_cells
    old_meta=sheet._load_meta(doc);rows=meta.get('rows') or [];old_rows=old_meta.get('rows') or []
    if set(rows)!=set(old_rows) or len(rows)!=len(old_rows):
        frappe.throw('原对象行须经原对象动作新增或处置，不能在伴随文件另建记录',frappe.ValidationError)
    old_wb=sheet.safe_open(sheet._content(doc,for_write=True));old_ws=old_wb.active
    old_headers=[str(c.value or '') for c in old_ws[1]];headers=[str(c.value or '') for c in ws[1]]
    bound={c['header'] for c in binding['field_columns']}
    if not bound.issubset(headers):frappe.throw('不能删除或改名原对象绑定列',frappe.ValidationError)
    structural=old_headers!=headers or old_rows!=rows
    if structural:authorize_companion_cells(doc.name,[],[],operation='structure')
    before_pos={r:i+2 for i,r in enumerate(old_rows)};changed=[]
    for i,rid in enumerate(rows,2):
        touched=False
        for col,header in enumerate(headers,1):
            old_cell=old_ws.cell(before_pos[rid],old_headers.index(header)+1) if header in old_headers else None
            before=sheet.cell_typed(old_cell) if old_cell is not None else {'type':'empty','value':None}
            after=sheet.cell_typed(ws.cell(i,col))
            if sheet._typed_equal(before,after):continue
            if header in bound:frappe.throw('不能修改原业务字段的工作文件投影',frappe.PermissionError)
            touched=True
        if touched:changed.append(rid)
    if changed:authorize_companion_cells(doc.name,changed,[],operation='write')


def authorize_rows(doc,row_ids):
    if not binding_for(doc):return
    from shangshu_core.public_api import authorize_companion_cells
    authorize_companion_cells(doc.name,list(dict.fromkeys(row_ids)),[],operation='write')


def authorize_ordinary_cells(doc,cells):
    # Only the core-installed provider capability may write source projection cells.
    if system_projection_allows(doc):return
    binding=binding_for(doc)
    if not binding:return
    bound={c['header'] for c in binding['field_columns']}
    if any(item.get('header') in bound for item in cells if isinstance(item,dict)):
        frappe.throw('原业务字段须通过原对象受管动作修改，不能直接改工作文件投影',frappe.PermissionError)
    from shangshu_core.public_api import authorize_companion_cells
    authorize_companion_cells(doc.name,list(dict.fromkeys(item.get('row_id') for item in cells if isinstance(item,dict))),[],operation='write')


def get_operation(binding,op_id,lock=True,replay=False):
    _scope(binding)
    doc=frappe.get_doc(sheet.DOCTYPE,binding['file_id'],for_update=lock)
    doc.check_permission('read')
    from shangshu_files.service import _can_write
    if not _can_write(doc) or doc.status!='Active':frappe.throw('当前不能撤回伴随表操作',frappe.PermissionError)
    name=frappe.db.get_value(sheet.OP_DOCTYPE,{'file':doc.name,'op_id':op_id},'name')
    if not name:frappe.throw('混合包操作不存在',frappe.ValidationError)
    record=frappe.get_doc(sheet.OP_DOCTYPE,name,for_update=lock)
    if record.action_id!='platform.object.companion_write' or (record.undone and not replay):frappe.throw('该混合包不可重复撤回',frappe.ValidationError)
    if str(record.actor_user).lower()!=str(frappe.session.user).lower():frappe.throw('只能撤回本人操作',frappe.PermissionError)
    cells=[c for c in json.loads(record.cells_json or '[]') if c.get('input_target',True)];authorize_rows(doc,[c['row_id'] for c in cells])
    meta=sheet._load_meta(doc)
    if replay:
        return {'cells':cells,'source_versions':{c['row_id']:c.get('source_modified') for c in cells},'content_version':sheet.content_revision(doc),'structure_version':int(meta.get('structure_version') or 1)}
    ctx=sheet._fast_ctx(doc,sheet._content(doc,for_write=lock),{},companion_cells=True)
    headers=ctx['entry']['headers'];raw=ctx['entry']['rows_raw']
    positions={rid:i for i,rid in enumerate(ctx['meta'].get('rows') or [])}
    for item in cells:
        if item['row_id'] not in positions or headers.count(item['header'])!=1:frappe.throw('混合包目标已变化，未撤回',frappe.ValidationError)
        row,col=positions[item['row_id']],headers.index(item['header'])
        current=sheet.value_typed(raw[row][col] if row<len(raw) and col<len(raw[row]) else None)
        if not sheet._typed_equal(current,item['after']):frappe.throw('混合包有单元格被后续修改，整包未撤回',frappe.ValidationError)
    return {'cells':cells,'source_versions':{c['row_id']:c.get('source_modified') for c in cells},'content_version':sheet.content_revision(doc),'structure_version':int(meta.get('structure_version') or 1)}
