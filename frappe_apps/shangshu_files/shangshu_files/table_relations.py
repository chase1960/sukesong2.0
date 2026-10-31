"""Stable row/column references. Stores keys only; never a second source of values."""
import hashlib
import json
import frappe
from shangshu_core.public_api import assert_relation_direction, public_resource_allows

DOCTYPE='Shangshu Table Relation'
FILE='Shangshu File Center File'


def has_relations(table):
    return bool(frappe.db.exists(DOCTYPE,{'source_table':table,'enabled':1}) or frappe.db.exists(DOCTYPE,{'target_table':table,'enabled':1}))


def definitions(table):
    return frappe.get_all(DOCTYPE,filters={'source_table':table,'enabled':1},fields=['name','source_table','source_header','target_table','target_header','links_json','revision'])


def _definition(table,header,lock=False):
    name=frappe.db.get_value(DOCTYPE,{'binding_key':hashlib.sha256((table+'\0'+header).encode()).hexdigest(),'enabled':1},'name')
    return frappe.get_doc(DOCTYPE,name,for_update=lock) if name else None


def _file(table,write=False,structure=False,lock=False):
    from shangshu_files import service
    doc=frappe.get_doc(FILE,table,for_update=lock)
    doc.check_permission('read')
    if doc.status!='Active':frappe.throw('关联表不可用',frappe.PermissionError)
    if write and not service._can_write(doc):frappe.throw('没有修改当前表的权限',frappe.PermissionError)
    if structure and not service._can_structure(doc):frappe.throw('没有配置当前表关联的结构权限',frappe.PermissionError)
    return doc


def _view(table,rows=None):
    from shangshu_files.sheet import read_payload
    old=getattr(frappe.flags,'shangshu_raw_relation_read',False)
    try:
        frappe.flags.shangshu_raw_relation_read=True
        return read_payload('files.sheet_read',{'table':table,**({'row_ids':rows} if rows else {}),'page_length':500})
    finally:frappe.flags.shangshu_raw_relation_read=old


def _header(doc,header,write=False):
    from shangshu_files import promotion,sheet
    content=sheet._content(doc);entry,_=sheet._parsed(doc,content)
    if header not in entry['headers']:frappe.throw('关联列已不存在，请重新配置',frappe.ValidationError)
    if header in promotion.unreadable_headers(doc):frappe.throw('关联字段当前不可读',frappe.PermissionError)
    if write:
        from shangshu_files import access_scope
        definition=promotion.load_definition(doc)
        col=next((c for c in definition.get('columns',[]) if c.get('header')==header),{})
        if col.get('promoted'):frappe.throw('关联显示列不能覆盖已晋升正式字段',frappe.ValidationError)
        # ⚠️ **PKG-117-T01**：判定改走**主体范围**（不再是旧的角色键 ——
        # 受管表链上已没有角色键，旧判定会走「未声明 = 不限」⇒ **闸形同虚设**）。
        # **普通列没有自己的声明**（普通列不进字段 ACL）⇒ 这一道只对**自带声明**的列生效。
        if col.get(promotion.ACCESS_KEY) and not access_scope.field_allows(
                {**col,'id':header},'write',table_access=definition.get('access')):
            frappe.throw('关联字段当前不可编辑',frappe.PermissionError)


def _row(table,row):
    view=_view(table,[row]);item=next((r for r in view.get('rows',[]) if r['row_id']==row),None)
    if not item:frappe.throw('关联记录不存在或不可读',frappe.PermissionError)
    return view,item


def define(_action,payload,context):
    table=str(payload['table']);header=str(payload['header']);target=str(payload['target_table']);target_header=str(payload['target_header'])
    # Same deterministic lock order for two-table configurations.
    docs={t:_file(t,lock=True) for t in sorted(set([table,target]))}
    source=_file(table,write=True,structure=True);_header(source,header,True);_header(docs[target],target_header)
    assert_relation_direction(table,target)
    from shangshu_files import sheet
    from shangshu_files.promotion import _load_meta
    meta=_load_meta(source)
    if int(payload['expected_structure_version'])!=int(meta.get('structure_version') or 1):
        frappe.throw('表结构已变化，请刷新后配置关联',frappe.TimestampMismatchError)
    old=_definition(table,header,True)
    if not old:
        entry,_=sheet._parsed(source,sheet._content(source));position=entry['headers'].index(header)
        if any(position<len(row) and row[position] not in (None,'') for row in entry['rows_raw']):
            frappe.throw('请使用空白列配置关联，不能覆盖已有值',frappe.ValidationError)
    if old and int(payload.get('expected_revision') or 0)!=int(old.revision):
        frappe.throw('关联定义已变化',frappe.TimestampMismatchError)
    # Cycles are rejected by identity, never by labels or spreadsheet positions.
    cursor=(target,target_header);seen={(table,header)}
    for _ in range(32):
        if cursor in seen:frappe.throw('关联不能形成循环',frappe.ValidationError)
        seen.add(cursor);child=_definition(*cursor)
        if not child:break
        cursor=(child.target_table,child.target_header)
    else:frappe.throw('关联链过深',frappe.ValidationError)
    if old and (old.target_table!=target or old.target_header!=target_header) and json.loads(old.links_json or '{}'):
        frappe.throw('已有行关联，须先清除具体关联再改变目标定义',frappe.ValidationError)
    doc=old or frappe.get_doc({'doctype':DOCTYPE,'binding_key':hashlib.sha256((table+'\0'+header).encode()).hexdigest(),'links_json':'{}'})
    doc.update({'source_table':table,'source_header':header,'target_table':target,'target_header':target_header,'revision':int(doc.get('revision') or 0)+1})
    doc.save(ignore_permissions=True)
    context['record_change']={'doctype':DOCTYPE,'name':doc.name,'data':{'source_table':table,'source_header':header,'target_table':target,'target_header':target_header,'revision':doc.revision}}
    return {'table':table,'header':header,'target_table':target,'target_header':target_header,'revision':doc.revision}


def set_link(_action,payload,context):
    table=payload['table'];header=payload['header'];row=payload['row_id'];target_row=payload.get('target_row_id')
    source=_file(table,write=True,lock=True);_header(source,header,True);_row(table,row)
    doc=_definition(table,header,True)
    if not doc:frappe.throw('请先配置关联列',frappe.ValidationError)
    if int(payload['expected_revision'])!=int(doc.revision):frappe.throw('关联已变化，请刷新',frappe.TimestampMismatchError)
    if target_row:
        target=_file(doc.target_table);_header(target,doc.target_header)
        assert_relation_direction(table,doc.target_table);_row(doc.target_table,target_row)
    links=json.loads(doc.links_json or '{}');before=links.get(row)
    if target_row:links[row]=target_row
    else:links.pop(row,None)
    doc.links_json=json.dumps(links,ensure_ascii=False);doc.revision=int(doc.revision)+1;doc.save(ignore_permissions=True)
    context['record_change']={'doctype':DOCTYPE,'name':doc.name,'data':{'table':table,'header':header,'row_id':row,'before':before,'after':target_row,'revision':doc.revision}}
    return {'table':table,'header':header,'row_id':row,'target_row_id':target_row,'revision':doc.revision}


def resolve(table,row,header,seen=None):
    seen=set(seen or ())
    key=(table,row,header)
    if key in seen or len(seen)>32:frappe.throw('关联循环或过深',frappe.ValidationError)
    seen.add(key);source=_file(table);_header(source,header);view,item=_row(table,row)
    config=_definition(table,header)
    if not config:return {'value':item['values'][header],'source_version':view.get('content_version'),'target':{'table':table,'row_id':row,'header':header}}
    rid=json.loads(config.links_json or '{}').get(row)
    if not rid:return {'value':{'type':'blank','value':None},'status':'empty','relation_revision':config.revision}
    assert_relation_direction(table,config.target_table)
    resolved=resolve(config.target_table,rid,config.target_header,seen)
    return {**resolved,'status':'linked','direct_target':{'table':config.target_table,'row_id':rid,'header':config.target_header},'relation_revision':config.revision}


def read(_service,payload,_context=None):
    table=payload['table'];_file(table)
    configs=definitions(table);headers=payload.get('headers') or [d.source_header for d in configs]
    row_ids=payload['row_ids'] if 'row_ids' in payload else [r['row_id'] for r in _view(table).get('rows',[])]
    if len(row_ids)>500 or len(headers)>100 or len(row_ids)*len(headers)>2000:frappe.throw('关联读取范围过大',frappe.ValidationError)
    values=[]
    for row in row_ids:
        for header in headers:
            try:values.append({'row_id':row,'header':header,**resolve(table,row,header)})
            except (frappe.PermissionError,frappe.DoesNotExistError):
                # No target ID, label or cached value in denied output.
                values.append({'row_id':row,'header':header,'status':'unavailable'})
    visible=[]
    for d in configs:
        try:
            _header(_file(d.target_table),d.target_header)
            visible.append({'header':d.source_header,'target_table':d.target_table,'target_header':d.target_header,'revision':int(d.revision)})
        except (frappe.PermissionError,frappe.DoesNotExistError):
            visible.append({'header':d.source_header,'revision':int(d.revision),'status':'unavailable'})
    return {'table':table,'values':values,'definitions':visible}


def validate_public(resource):
    from shangshu_files import promotion
    if not frappe.db.exists(FILE,resource):return False
    doc=_file(resource)
    from shangshu_files.service import _source_read_allows
    if doc.get('related_mail') or _source_read_allows(frappe.session.user,doc) is not None:
        frappe.throw('有私有来源约束的资料不能直接公开',frappe.PermissionError)
    meta=promotion._load_meta(doc)
    if meta.get('object_companion'):
        frappe.throw('原业务对象须先确认全企业记录权限，不能借伴随文件公开',frappe.PermissionError)
    definition=promotion.load_definition(doc)
    for col in definition.get('columns',[]):
        if _declares_narrower_read(col,definition):frappe.throw('公开表与字段保密规则冲突，请先调整定义',frappe.ValidationError)
    if definitions(resource):frappe.throw('含关联资料需逐项确认公开范围，不允许批量公开依赖',frappe.ValidationError)
    return True


def guard_cell_write(table,cells):
    linked={d.source_header for d in definitions(table)}
    if any(c.get('header') in linked for c in cells):
        frappe.throw('关联列只允许选择或清除目标记录，不能改写主资料值',frappe.PermissionError)


def decorate_response(result,resolver=None):
    if getattr(frappe.flags,'shangshu_raw_relation_read',False):return result
    configs=definitions(result['table'])
    if not configs:return result
    rows=result.get('rows',[]);headers=[c.source_header for c in configs]
    if resolver is None:
        data=read(None,{'table':result['table'],'row_ids':[r['row_id'] for r in rows],'headers':headers}) if rows else {'values':[]}
    else:
        data={'values':[]}
        for row in rows:
            for header in headers:
                try:value=resolver.resolve(result['table'],row['row_id'],header)
                except (frappe.PermissionError,frappe.DoesNotExistError):value={'status':'unavailable'}
                data['values'].append({'row_id':row['row_id'],'header':header,**value})
    lookup={(v['row_id'],v['header']):v for v in data['values']}
    for row in rows:
        for header in headers:
            item=lookup.get((row['row_id'],header),{})
            row['values'][header]={**item.get('value',{'type':'blank','value':None}),'relation_status':item.get('status','unavailable'),
                **({'relation_target':item['direct_target']} if item.get('direct_target') else {}),'readonly':True}
    result['readonly_columns']=list(set(result.get('readonly_columns',[]))|set(headers))
    result['relations']=[{'header':c.source_header,'revision':int(c.revision)} for c in configs]
    return _formula_overlay(result,configs,resolver=resolver) if resolver is not None else _formula_overlay(result,configs)


def before_save(doc,ws,meta,renames=None):
    """No write path can turn a reference into an unvalidated scalar override."""
    from shangshu_files.sheet import _headers_of
    headers=_headers_of(ws);renames=renames or {}
    configs=frappe.get_all(DOCTYPE,filters={'enabled':1},or_filters={'source_table':doc.name,'target_table':doc.name},fields=['name'])
    for entry in configs:
        relation=frappe.get_doc(DOCTYPE,entry.name,for_update=True);changed=False
        for table_key,header_key in [('source_table','source_header'),('target_table','target_header')]:
            if relation.get(table_key)!=doc.name:continue
            old=relation.get(header_key);new=renames.get(old,old)
            if new not in headers:frappe.throw('此列被关联使用，请先解除关联再删除',frappe.ValidationError)
            if old!=new:relation.set(header_key,new);changed=True
        if relation.source_table==doc.name:
            column=headers.index(relation.source_header)+1
            if any(ws.cell(i,column).value not in (None,'') for i in range(2,ws.max_row+1)):
                frappe.throw('关联列只能设置目标记录，不能直接粘贴或修改引用值',frappe.PermissionError)
        if changed:
            relation.binding_key=hashlib.sha256((relation.source_table+'\0'+relation.source_header).encode()).hexdigest()
            relation.revision=int(relation.revision)+1;relation.save(ignore_permissions=True)


def guard_public_definition(doc,definition):
    if not public_resource_allows(frappe.session.user,doc.name):return
    # ⚠️ **PKG-117-T01**：字段保密规则现在是**主体范围**（全局／部门／个人），
    # 不再是旧的角色键。**公共表**要求「全员可读」⇒ 表级与每一列的「读」
    # 都**不许窄于全局**（没声明的按表级算，表级没声明就没有列级限制）。
    for col in definition.get('columns',[]):
        if _declares_narrower_read(col,definition):frappe.throw('公共表不能增加与全员可读冲突的字段保密规则，请先撤出公共空间',frappe.ValidationError)


def remove(_action,payload,context):
    doc=_file(payload['table'],write=True,structure=True,lock=True)
    relation=_definition(doc.name,payload['header'],True)
    if not relation:frappe.throw('关联定义不存在',frappe.ValidationError)
    if int(payload['expected_revision'])!=int(relation.revision):frappe.throw('关联已变化，请刷新',frappe.TimestampMismatchError)
    before={k:relation.get(k) for k in ('source_table','source_header','target_table','target_header','links_json','revision')}
    relation.enabled=0
    relation.binding_key='removed:'+relation.name
    relation.save(ignore_permissions=True)
    context['record_change']={'doctype':DOCTYPE,'name':relation.name,'data':{'before':before,'after':None}}
    return {'table':doc.name,'header':payload['header'],'removed':True}


def _declares_narrower_read(col, definition=None):
    """这一列（或这张表）的「读」声明**窄于全员**吗？（**公开表**的冲突检查）

    ★ **PKG-117-T01**：字段保密规则现在是**主体范围**（全局／部门／个人），
    不再是旧的角色键。**没声明 ⇒ 继承表级**；表级也没声明 ⇒ 没有列级限制（不冲突）。
    ⚠️ **只看「声明了没有 ＋ 是不是全局」** —— **不做用户级判定**
    （用户级判定在内核 `field_subject_allows`，域**不写第二套**）。

    ⚠️ **这里「什么都没声明 ⇒ 不算窄」是故意**（只读审查员 2026-10-26 提过这一点）：
    本函数答的是「**会不会与公开可见冲突**」，**不是**「这个人能不能读」
    —— 后者由内核 `resolve_op_scope` 判，那里是 **fail-closed**（表级也没声明 ⇒ 拒）。
    两条链的题不一样，这儿按冲突题答。
    且**受管表链里表级声明是必填的**（`validate_definition` 强制）⇒ 「什么都没声明」
    在那条链上**到不了**；**建模对象链**（根本没有主体范围）⇒ 本来就没有列级限制。
    """
    table_access = (definition or {}).get('access') or {}
    column_access = col.get('access') or {}
    declared = column_access.get('read') or table_access.get('read')
    if not declared:
        return False
    return str(declared.get('scope') or '') != 'global'


def _require_target_download(table,row,header,seen=None):
    from shangshu_files import service,promotion
    seen=set(seen or ());key=(table,row,header)
    if key in seen:frappe.throw('关联循环',frappe.ValidationError)
    seen.add(key);doc=_file(table);_header(doc,header);_row(table,row)
    if not service._can_download(doc):frappe.throw('引用目标没有导出权限',frappe.PermissionError)
    definition=promotion.load_definition(doc)
    col=next((c for c in definition.get('columns',[]) if c.get('header')==header),{})
    if col.get('promoted'):
        # ⚠️ **PKG-117-T01**：受管列按**列声明的「下载」主体范围**判（表级兜底）。
        from shangshu_files import access_scope
        if not access_scope.field_allows({**col,'id':header},'download',
                                         table_access=definition.get('access')):
            frappe.throw('引用目标字段没有导出权限',frappe.PermissionError)
    elif col:
        # **普通列不进字段 ACL** —— 零声明即拒（与改造前一致，**不静默放宽下载闸**）。
        frappe.throw('引用目标字段没有导出权限',frappe.PermissionError)
    relation=_definition(table,header)
    if relation:
        rid=json.loads(relation.links_json or '{}').get(row)
        if rid:
            assert_relation_direction(table,relation.target_table)
            _require_target_download(relation.target_table,rid,relation.target_header,seen)


def export(_service,payload,_context=None):
    """Generate a transient current-value snapshot; original resource is not rewritten."""
    import base64,io
    import openpyxl
    from shangshu_files import service,promotion,sheet
    doc=_file(payload['table'])
    if not service._can_download(doc):frappe.throw('当前没有此表导出权限',frappe.PermissionError)
    promotion._require_all_columns_exportable(doc)
    promotion.require_no_pending_writeback(doc)
    wb=openpyxl.load_workbook(io.BytesIO(sheet._content(doc)))
    meta=promotion._load_meta(doc);ws=wb[meta.get('sheet_name') or wb.sheetnames[0]];headers=sheet._headers_of(ws)
    positions={rid:i+2 for i,rid in enumerate(meta.get('rows') or [])}
    provenance=[]
    for relation in definitions(doc.name):
        if relation.source_header not in headers:frappe.throw('关联列已改变',frappe.ValidationError)
        col=headers.index(relation.source_header)+1
        for rid,target in json.loads(relation.links_json or '{}').items():
            if rid not in positions or rid in (meta.get('deleted_rows') or []):continue
            _require_target_download(relation.target_table,target,relation.target_header)
            value=resolve(doc.name,rid,relation.source_header)
            cell=ws.cell(positions[rid],col);raw=value['value'].get('value')
            cell.value=raw
            if isinstance(raw,str):cell.data_type='s'  # literal, never execute target text as a formula
            provenance.append({'row_id':rid,'header':relation.source_header,'source_version':value.get('source_version')})
    from shangshu_files import formulas
    try:cached=formulas.recalculate(ws,meta,promotion.formula_formal_values(doc, ws, meta),promotion.load_definition(doc))
    except formulas.FormulaError as error:frappe.throw(str(error),frappe.ValidationError)
    out=io.BytesIO();wb.save(out)
    data=formulas.write_cached_values(out.getvalue(),ws.title,cached)
    return {'table':doc.name,'file_name':doc.file_name,'content_base64':base64.b64encode(data).decode(),
            'content_type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','snapshot':True,'references':provenance}


def _formula_overlay(result,configs,resolver=None):
    """Ephemeral calculation from current authorized references; no stale cache truth."""
    import io
    import openpyxl
    from shangshu_files import sheet,promotion,formulas
    if resolver is not None and result['table'] in resolver.formula_snapshots:
        cached=resolver.formula_snapshots[result['table']]
        if cached is None:return result
        meta,revision,hidden=cached
        for row in result['rows']:formulas.decorate_values(row['values'],row['row_id'],meta,revision,hidden)
        return result
    doc=_file(result['table']);meta=promotion._load_meta(doc)
    wb=openpyxl.load_workbook(io.BytesIO(sheet._content(doc)));ws=wb[meta.get('sheet_name') or wb.sheetnames[0]]
    if not any(formulas.formula_cells(ws)):
        if resolver is not None:resolver.formula_snapshots[result['table']]=None
        return result
    headers=sheet._headers_of(ws);positions={rid:i+2 for i,rid in enumerate(meta.get('rows') or [])}
    hidden=set(promotion.unreadable_headers(doc));versions=[]
    for config in configs:
        linked_ids=list(json.loads(config.links_json or '{}'))
        for offset in range(0,len(linked_ids),500):
            batch=linked_ids[offset:offset+500]
            if resolver is not None:resolver.prime(doc.name,batch,[config.source_header])
            for rid in batch:
                if rid not in positions or rid in (meta.get('deleted_rows') or []):continue
                try:
                    linked=(resolver.resolve if resolver is not None else resolve)(doc.name,rid,config.source_header)
                    cell=ws.cell(positions[rid],headers.index(config.source_header)+1)
                    cell.value=linked['value'].get('value')
                    if isinstance(cell.value,str):cell.data_type='s'
                    versions.append([config.name,int(config.revision),rid,linked.get('source_version')])
                except (frappe.PermissionError,frappe.DoesNotExistError):hidden.add(config.source_header)
    try:formulas.recalculate(ws,meta,promotion.formula_formal_values(doc, ws, meta),promotion.load_definition(doc))
    except formulas.FormulaError:
        for row in result['rows']:
            for header,typed in row['values'].items():
                if typed.get('type')=='formula':row['values'][header]={**typed,'value':None,'calculation_pending':True}
        return result
    revision=hashlib.sha256(json.dumps([result.get('content_version'),versions],sort_keys=True).encode()).hexdigest()
    if resolver is not None:resolver.formula_snapshots[result['table']]=(meta,revision,hidden)
    for row in result['rows']:formulas.decorate_values(row['values'],row['row_id'],meta,revision,hidden)
    return result


def structure_snapshot(table,lock=False):
    """Relation identities affected by this workbook's structural operation."""
    rows=frappe.get_all(DOCTYPE,filters={'enabled':1},or_filters={'source_table':table,'target_table':table},fields=['name'],order_by='name asc')
    fields=('name','source_table','source_header','target_table','target_header','revision','links_json')
    result=[]
    for row in rows:
        doc=frappe.get_doc(DOCTYPE,row.name,for_update=lock)
        result.append({key:doc.get(key) for key in fields})
    return result


def restore_structure_relations(table,before,after):
    """Undo only the exact relation rename, never a later definition/link change."""
    current=structure_snapshot(table,lock=True)
    if before is None or after is None:
        if current:frappe.throw('旧结构快照没有关联版本，请手动调整列名',frappe.ValidationError)
        return
    if current!=after:frappe.throw('关联定义或行绑定已变化，不能撤回旧结构',frappe.TimestampMismatchError)
    originals={row['name']:row for row in before}
    if set(originals)!={row['name'] for row in after}:
        frappe.throw('结构操作改变了关联集合，不能直接撤回',frappe.ValidationError)
    for row in after:
        prior=originals[row['name']]
        if any(prior[key]!=row[key] for key in ('source_table','target_table','links_json')):
            frappe.throw('结构操作包含非列名关联变更，不能直接撤回',frappe.ValidationError)
        if prior['source_header']==row['source_header'] and prior['target_header']==row['target_header']:continue
        doc=frappe.get_doc(DOCTYPE,row['name'],for_update=True)
        doc.source_header=prior['source_header'];doc.target_header=prior['target_header']
        doc.binding_key=hashlib.sha256((doc.source_table+'\0'+doc.source_header).encode()).hexdigest()
        doc.revision=int(doc.revision)+1
        doc.save(ignore_permissions=True)
