"""Stable-identity workbook permutations; no database schema mutations."""
from copy import copy
from openpyxl.utils import get_column_letter, column_index_from_string


def permute(ws, axis, order):
    """order maps each old 1-based coordinate to its new coordinate."""
    merges=[]
    for region in ws.merged_cells.ranges:
        lo,hi=(region.min_row,region.max_row) if axis=='row' else (region.min_col,region.max_col)
        mapped=sorted(order.get(i,i) for i in range(lo,hi+1))
        if mapped != list(range(mapped[0],mapped[-1]+1)):
            raise ValueError('移动会拆开合并单元格，请先取消该合并')
        bounds=[region.min_col,region.min_row,region.max_col,region.max_row]
        bounds[1 if axis=='row' else 0]=mapped[0]
        bounds[3 if axis=='row' else 2]=mapped[-1]
        merges.append(bounds)
    cells={}
    for (row,col),cell in list(ws._cells.items()):
        row=order.get(row,row) if axis=='row' else row
        col=order.get(col,col) if axis=='column' else col
        cell=copy(cell);cell.row=row;cell.column=col;cells[row,col]=cell
    ws._cells=cells
    dims=ws.row_dimensions if axis=='row' else ws.column_dimensions
    entries=list(dims.items())
    if axis=='column':
        expanded={}
        for index,dim in entries:
            start=dim.min or column_index_from_string(index);end=dim.max or start
            for col in range(start,end+1):expanded[get_column_letter(col)]=dim
        entries=list(expanded.items())
    dims.clear()
    for index,dim in entries:
        old=index if axis=='row' else column_index_from_string(index)
        new=order.get(old,old);key=new if axis=='row' else get_column_letter(new)
        dim=copy(dim);dim.index=key
        if axis=='column':dim.min=dim.max=new
        dims[key]=dim
    ws.merged_cells.ranges.clear()
    for c1,r1,c2,r2 in merges:
        ws.merge_cells(start_row=r1,start_column=c1,end_row=r2,end_column=c2)


def move_order(items, item, before=None):
    if item not in items or (before and before not in items):
        raise ValueError('移动目标不存在')
    result=list(items)
    if before==item:return result
    result.remove(item)
    result.insert(result.index(before) if before else len(result),item)
    return result


ACTIONS = {'files.sheet_'+name for name in ('row_insert','row_delete','row_restore','row_move',
    'column_insert','column_delete','column_move','row_append','column_append','header_rename')}


def workbook_fingerprint(content):
    """Compare all package payloads; exclude only serialization/save timestamps."""
    import hashlib, zipfile
    from io import BytesIO
    from xml.etree import ElementTree as ET
    digest=hashlib.sha256()
    with zipfile.ZipFile(BytesIO(content)) as package:
        for name in sorted(package.namelist()):
            data=package.read(name)
            if name=='docProps/core.xml':
                root=ET.fromstring(data)
                for child in list(root):
                    if child.tag=='{http://purl.org/dc/terms/}modified':root.remove(child)
                data=ET.tostring(root,encoding='utf-8')
            digest.update(name.encode());digest.update(b'\0');digest.update(data);digest.update(b'\0')
    return digest.hexdigest()


def _state(doc):
    import json
    return json.loads(doc.sheet_meta_json or '{}')


def execute(action, payload, context, handler):
    """Keep a private exact workbook inverse, committed with the existing file journal."""
    import base64, hashlib
    from shangshu_files import sheet
    doc=sheet._writable(payload.get('table'));sheet._require_structure(doc)
    if action in {'files.sheet_'+name for name in ('row_append','row_insert','row_delete','row_restore','column_append','column_insert')}:
        # 行的身份／显示逆操作无需留整簿副本、解压全部工作表或比较全局指纹。
        result=handler(payload,context)
        inverse=result.pop('_structure_inverse',None)
        if action in ('files.sheet_row_append','files.sheet_row_insert'):
            doc.reload();rows=_state(doc).get('rows') or [];targets=result.get('row_ids') or []
            if targets:
                first=rows.index(targets[0]);last=rows.index(targets[-1])
                inverse={'kind':'created_rows','row_ids':targets,
                         'previous':rows[first-1] if first else None,
                         'next':rows[last+1] if last+1<len(rows) else None}
        if not inverse:return result
        doc.reload()
        op_id=payload.get('op_id') or (context or {}).get('idempotency_key')
        sheet._record_op(doc,action,op_id,[{'structure_snapshot':True,'inverse':inverse,
            'definition_version':sheet._stamp_versions(doc)[0]}],result.get('content_version'),context)
        result['structure_undo_op_id']=op_id
        return result
    before=sheet._content(doc,for_write=True);meta=_state(doc)
    from shangshu_files.table_relations import structure_snapshot
    relations_before=structure_snapshot(doc.name,lock=True)
    result=handler(payload,context)
    doc.reload()
    after=sheet._content(doc,for_write=True)
    if before==after:return result
    op_id=payload.get('op_id') or (context or {}).get('idempotency_key')
    # A structural snapshot is never projected through public op_history.
    snapshot={'structure_snapshot':True,'before_base64':base64.b64encode(before).decode(),
              'before_meta':meta,'after_sha256':hashlib.sha256(after).hexdigest(),
              'after_fingerprint':workbook_fingerprint(after),'after_meta':_state(doc), 'definition_version':sheet._stamp_versions(doc)[0],
              'relations_before':relations_before,'relations_after':structure_snapshot(doc.name)}
    sheet._record_op(doc,action,op_id,[snapshot],result.get('content_version'),context)
    result['structure_undo_op_id']=op_id
    return result


def undo(payload, context=None):
    import base64, hashlib, json
    import frappe
    from shangshu_files import sheet
    doc=sheet._writable(payload.get('table'));sheet._require_structure(doc)
    current=sheet._content(doc,for_write=True);meta=_state(doc)
    sheet._check_versions(doc,meta,payload)
    names=frappe.get_all(sheet.OP_DOCTYPE,filters={'file':doc.name,'op_id':payload.get('undo_of')},pluck='name',limit_page_length=1)
    if not names:frappe.throw('原结构操作不存在',frappe.ValidationError)
    op=frappe.get_doc(sheet.OP_DOCTYPE,names[0],for_update=True)
    if op.actor_user!=frappe.session.user:frappe.throw('只能撤回本人结构操作',frappe.PermissionError)
    if op.undone:frappe.throw('该操作已经撤回',frappe.ValidationError)
    cells=json.loads(op.cells_json or '[]')
    if len(cells)!=1 or not cells[0].get('structure_snapshot'):
        frappe.throw('该日志不是可撤回结构操作',frappe.ValidationError)
    saved=cells[0]
    if sheet._stamp_versions(doc)[0] != saved.get('definition_version'):
        frappe.throw('字段定义已变更，不能撤回旧结构',frappe.ValidationError)
    inverse=saved.get('inverse')
    if not inverse and op.action_id in ('files.sheet_row_append','files.sheet_row_insert'):
        # 旧快照只取其中确定的新增身份，不把整簿 before_image 写回当前文件。
        before_rows=(saved.get('before_meta') or {}).get('rows') or []
        after_rows=(saved.get('after_meta') or {}).get('rows') or []
        old=set(before_rows);targets=[rid for rid in after_rows if rid not in old]
        if targets:
            first=after_rows.index(targets[0]);last=after_rows.index(targets[-1])
            inverse={'kind':'created_rows','row_ids':targets,
                     'previous':after_rows[first-1] if first else None,
                     'next':after_rows[last+1] if last+1<len(after_rows) else None}
    if inverse:
        result=_undo_row_inverse(doc,current,meta,inverse,payload,context)
        result.pop('_structure_inverse',None)
        frappe.db.set_value(sheet.OP_DOCTYPE,op.name,'undone',1,update_modified=False)
        sheet._record_op(doc,'files.sheet_structure_undo',payload.get('op_id') or (context or {}).get('idempotency_key'),
                         [{'undo_of':op.op_id,'structure':True,'row_ids':result.get('row_ids',[]),
                           'soft':inverse.get('kind')=='created_rows'}],result['content_version'],context)
        return {**result,'undo_of':op.op_id}
    def semantic(value):
        # Binding structure stamps advance on a rename inverse too; they are
        # derived versions, unlike field identity, ACL and all other metadata.
        result={k:v for k,v in value.items() if k not in ('structure_version','promotion_header_fields')}
        if isinstance(result.get('promotion'),dict):
            result['promotion']={k:v for k,v in result['promotion'].items() if k!='structure_version'}
        return result
    same_content = (workbook_fingerprint(current)==saved['after_fingerprint'] if saved.get('after_fingerprint') else hashlib.sha256(current).hexdigest()==saved['after_sha256'])
    if not same_content or semantic(meta)!=semantic(saved['after_meta']):
        frappe.throw('表格在该操作后已有变化，不能整表覆盖撤回',frappe.ValidationError)
    from shangshu_files.table_relations import restore_structure_relations
    restore_structure_relations(doc.name,saved.get('relations_before'),saved.get('relations_after'))
    restored=base64.b64decode(saved['before_base64']);restored_meta=saved['before_meta']
    restored_meta['structure_version']=int(meta.get('structure_version') or 1)+1
    if isinstance(restored_meta.get('promotion'),dict):
        restored_meta['promotion']['structure_version']=restored_meta['structure_version']
    aliases=restored_meta.setdefault('promotion_header_fields',{})
    for header,fields in (meta.get('promotion_header_fields') or {}).items():
        aliases[header]=sorted(set(aliases.get(header) or [])|set(fields))
    if not aliases:restored_meta.pop('promotion_header_fields',None)
    if meta.get('working_file_id'):restored_meta['working_file_id']=meta['working_file_id']
    # No schema rollback and no formal-value overwrite: only the exact workbook
    # layout/content whose after-image is still current may be restored.
    sheet._save_meta(doc,restored_meta)
    sheet._fault('file-write')
    version=sheet._save_current(doc,restored,note='structure-undo')
    sheet._invalidate_parse(doc.name)
    sheet._fault('post-save')
    frappe.db.set_value(sheet.OP_DOCTYPE,op.name,'undone',1,update_modified=False)
    sheet._record_op(doc,'files.sheet_structure_undo',payload.get('op_id') or (context or {}).get('idempotency_key'),
                     [{'undo_of':op.op_id,'structure':True}],version,context)
    return {'table':doc.name,'undo_of':op.op_id,'content_version':version,
            'structure_version':restored_meta['structure_version'],'has_formulas':bool(restored_meta.get('formula_results'))}


def _undo_row_inverse(doc, content, meta, inverse, payload, context):
    """只验证本次目标；新增行撤回沿既有软删，身份和正式记录始终保留。"""
    import json,re
    import frappe
    from shangshu_files import sheet,zipedit,promotion,table_relations
    ctx=sheet._fast_ctx(doc,content,payload,sheet._Seg(),companion_cells=True)
    rows=ctx['meta'].get('rows') or [];positions={rid:index for index,rid in enumerate(rows)}
    deleted=set(ctx['meta'].get('deleted_rows') or [])
    kind=inverse.get('kind')
    if kind=='created_column':
        return _undo_created_column(doc,content,inverse,payload,context,ctx)
    if kind=='created_rows':
        targets=inverse.get('row_ids') or []
        if not targets or len(set(targets))!=len(targets) or any(rid not in positions or rid in deleted for rid in targets):
            frappe.throw('新增行身份或显示状态已变化，本次未撤回',frappe.ValidationError)
        indexes=[positions[rid] for rid in targets]
        prior=inverse.get('previous');following=inverse.get('next')
        if indexes!=sorted(indexes) or (prior and (prior not in positions or positions[prior]>=indexes[0])) or (following and (following not in positions or positions[following]<=indexes[-1])):
            frappe.throw('新增行已被移动，本次未撤回',frappe.ValidationError)
        fragments=zipedit._row_fragments(ctx['sheet_xml'],[index+2 for index in indexes])
        for rid,index in zip(targets,indexes):
            values=ctx['entry']['rows_raw'][index] if index<len(ctx['entry']['rows_raw']) else ()
            if any(value not in (None,'') and not (column==0 and value==' ') for column,value in enumerate(values)):
                frappe.throw('新增行仍有内容，请先撤回该行的后续输入',frappe.ValidationError)
            fragment=fragments.get(index+2,b'')
            if not fragment:
                frappe.throw('新增行的物理位置缺失，本次未撤回',frappe.ValidationError)
            tag=fragment.split(b'>',1)[0]
            attrs=re.sub(rb'\s+r="\d+"',b'',tag.removeprefix(b'<row')).strip().rstrip(b'/')
            if attrs or any(style!=b'0' for style in re.findall(rb'\bs="([^"]+)"',fragment)):
                frappe.throw('新增行的格式或显示状态已被修改，本次未撤回',frappe.ValidationError)
            if any(zipedit.parse_coord(a.decode())[1]<=index+2<=zipedit.parse_coord(b.decode())[1]
                   for a,b in zipedit._merged_ranges(ctx['sheet_xml'])):
                frappe.throw('新增行已有合并区域，本次未撤回',frappe.ValidationError)
        formal=promotion._load_formal(doc,row_ids=targets,fields=promotion.declared_fields(doc))
        if any(value not in (None,'') for values in formal.values() for key,value in values.items()
               if key not in ('creation','_display')):
            frappe.throw('新增行仍有正式值，请先撤回该行的后续输入',frappe.ValidationError)
        wanted=set(targets)
        for relation in table_relations.structure_snapshot(doc.name,lock=True):
            links=json.loads(relation.get('links_json') or '{}')
            if (relation.get('source_table')==doc.name and wanted.intersection(links)) or (relation.get('target_table')==doc.name and wanted.intersection(links.values())):
                frappe.throw('新增行已有后续关联，请先处理该关联再撤回',frappe.ValidationError)
        changes=[{'row_id':rid,'deleted':True} for rid in targets]
    elif kind=='row_visibility':
        items=inverse.get('rows') or [];targets=[item.get('row_id') for item in items]
        if not targets or any(rid not in positions for rid in targets):
            frappe.throw('原行身份已变化，本次未撤回',frappe.ValidationError)
        current=zipedit.rows_hidden(ctx['sheet_xml'],[positions[rid]+2 for rid in targets])
        for item in items:
            rid=item['row_id']
            if (rid in deleted)!=item['after_deleted'] or current[positions[rid]+2]!=item['after_hidden']:
                frappe.throw('该行显示状态已被后续修改，本次未撤回',frappe.ValidationError)
        changes=[{'row_id':item['row_id'],'deleted':item['before_deleted'],'hidden':item['before_hidden']} for item in items]
    else:
        frappe.throw('不支持该结构逆操作',frappe.ValidationError)
    result=sheet._fast_row_visibility(doc,content,payload,context,changes,prepared=ctx)
    return {**result,'row_ids':targets,'soft':kind=='created_rows'}


def _undo_created_column(doc,content,inverse,payload,context,ctx):
    """只移除仍为空的本次新增普通列，其他列的后改值及格式跟随原身份。"""
    import frappe
    from shangshu_files import sheet,zipedit,promotion,object_projection
    meta,entry,part=ctx['meta'],ctx['entry'],ctx['part']
    headers=list(entry['headers']);header=inverse.get('header')
    if not header or headers.count(header)!=1 or len(headers)<=1:
        frappe.throw('新增列身份已变化，本次未撤回',frappe.ValidationError)
    col=headers.index(header);prior=inverse.get('previous');following=inverse.get('next')
    if inverse.get('append_only') and col!=len(headers)-1:
        frappe.throw('新增列后还有后续加列，请先撤回后续结构操作',frappe.ValidationError)
    if (prior and (prior not in headers or headers.index(prior)>=col)) or (following and (following not in headers or headers.index(following)<=col)):
        frappe.throw('新增列已经移动，本次未撤回',frappe.ValidationError)
    declared=promotion.column_by_header(promotion.load_definition(doc),header)
    if declared and declared.get('promoted'):
        frappe.throw('新增列已经晋升，不能按普通列撤回',frappe.ValidationError)
    object_projection.reject_bound_targets(doc,[header])
    if any(col<len(row) and row[col] not in (None,'') for row in entry['rows_raw']):
        frappe.throw('新增列仍有内容，请先撤回该列的后续输入',frappe.ValidationError)
    if not inverse.get('format_signature') or zipedit.column_format_signature(ctx['sheet_xml'],col+1)!=inverse['format_signature']:
        frappe.throw('新增列格式已经变化，本次未撤回',frappe.ValidationError)
    headers.pop(col);entry['headers']=headers;meta['headers']=headers
    entry['rows_raw']=[row[:col]+row[col+1:] for row in entry['rows_raw']]
    entry['column_types']=list(entry.get('column_types') or [])
    if col<len(entry['column_types']):entry['column_types'].pop(col)
    sheet._structure_relation_checks(doc,entry,meta)
    try:
        if inverse.get('append_only'):
            # 末尾加列最初仅填写表头，逆操作也只清表头，保留原件已有空白格格式。
            saved=zipedit.edit_cells(content,part,[(sheet.coord_of(col+1,1),{'type':'empty','value':None})],
                                     verify=False,source_xml=ctx['sheet_xml'])
        else:
            saved=zipedit.remove_column(content,part,col+1,source_xml=ctx['sheet_xml'])
            sheet._shift_layout_cache(entry,'column',col+1,-1)
    except zipedit.SurgeryError as error:frappe.throw(str(error),frappe.ValidationError)
    sheet._verify_surgery(saved,content,part,[],{})
    sheet._bump_structure(meta);sheet._fault('file-write');sheet._save_meta(doc,meta)
    version=sheet._save_current(doc,saved,note='structure-undo·新增列')
    sheet._rekey_parse(doc,entry,version);sheet._fault('post-save')
    return {'table':doc.name,'header':header,'deleted':True,'content_version':version,
            'structure_version':meta['structure_version'],'has_formulas':False,'soft':False}


def insert_axis(ws,axis,index,count=1):
    maximum=ws.max_row if axis=='row' else ws.max_column
    permute(ws,axis,{i:i+count for i in range(index,maximum+1)})


def delete_column(ws,index):
    if ws.max_column<=1:raise ValueError('至少保留一列')
    for region in ws.merged_cells.ranges:
        if region.min_col<=index<=region.max_col:
            raise ValueError('待删除列与合并单元格相交，请先取消该合并')
    ws._cells={key:cell for key,cell in ws._cells.items() if key[1]!=index}
    ws.column_dimensions.pop(get_column_letter(index),None)
    permute(ws,'column',{i:i-1 for i in range(index+1,ws.max_column+2)})
