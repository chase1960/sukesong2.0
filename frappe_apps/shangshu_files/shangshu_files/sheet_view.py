"""Personal sheet projection. Never reorder workbook rows or write formal values."""
import hashlib
import json
import frappe
from shangshu_files import sheet, promotion

DOCTYPE = 'Shangshu Sheet View'

# 「值在这几个里」（operator='in'）的值上限 —— 超了直接拒，不静默截断。
# 条数 / 单条长度 / 总长三道闸都写在这儿，改动请连着判据一起改。
# （前端 personal-view.ts 里的同名常量必须一致。）
MAX_IN_VALUES = 500          # 一条条件最多带几个值
MAX_IN_VALUE_LENGTH = 32767  # 每个值最多多少字（xlsx 单格上限，正常值都装得下）
MAX_IN_TOTAL_LENGTH = 100000 # 一条条件的值清单总长上限
# 值清单服务一次最多返回多少个去重值（整列去重，不是当前页）。
MAX_COLUMN_VALUES = 2000
# 个人视图的**列序**最多能排多少列（xlsx 一张表最多 16384 列，这里留个够用又不离谱的上限）。
MAX_COLUMN_ORDER = 1000

def _key(table):
    return hashlib.sha256((str(frappe.session.user)+'\0'+str(table)).encode()).hexdigest()

def _source(table,lock=False):
    doc=frappe.get_doc(sheet.DOCTYPE,str(table or ''))
    doc.check_permission('read')
    if lock:
        current=frappe.db.sql('select * from `tabShangshu File Center File` where name=%s for update',(doc.name,),as_dict=True)
        if not current:frappe.throw('表格不存在',frappe.PermissionError)
        doc.update(current[0]);doc.check_permission('read')
    if doc.status=='Recycled': frappe.throw('表格已回收',frappe.PermissionError)
    content=sheet._content(doc)
    entry,_=sheet._parsed(doc,content)
    meta=sheet._ensure_meta_rows(doc,len(entry['rows_raw']),entry['sheet_title'],persist=False)
    return doc,entry,meta

def _default(): return {'filters':[],'freeze':{'rows':0,'columns':0}}

def validate_view(view,headers,hidden):
    if not isinstance(view,dict) or set(view)-{'filters','freeze','sort','columns'}: raise ValueError('个人视图格式无效')
    filters=view.get('filters');freeze=view.get('freeze')
    if not isinstance(filters,list) or len(filters)>20: raise ValueError('筛选条件最多20项')
    if not isinstance(freeze,dict) or set(freeze)!={'rows','columns'} or any(type(v) is not int or not 0<=v<=1000 for v in freeze.values()): raise ValueError('冻结范围无效')
    def column(name):
        if name not in headers: raise ValueError('视图引用的列不存在，请重新配置')
        if name in hidden: frappe.throw('无权使用该列配置个人视图',frappe.PermissionError)
    result={'filters':[],'freeze':dict(freeze)}
    for f in filters:
        if not isinstance(f,dict) or set(f)-{'column','operator','value'}: raise ValueError('筛选条件无效')
        operator=f.get('operator')
        if operator=='in':
            # 「值在这几个里」：value 是**字符串数组**（不是字符串）。
            # 存量视图（value 是字符串）走下面那条老路，不受这里影响。
            values=f.get('value')
            if not isinstance(values,list) or not values: raise ValueError('筛选条件的值清单无效')
            if len(values)>MAX_IN_VALUES: raise ValueError('筛选条件的值最多%d个'%MAX_IN_VALUES)
            total=0
            for v in values:
                if not isinstance(v,str): raise ValueError('筛选条件的值清单无效')
                if len(v)>MAX_IN_VALUE_LENGTH: raise ValueError('筛选条件的单个值最多%d字'%MAX_IN_VALUE_LENGTH)
                total+=len(v)
            if total>MAX_IN_TOTAL_LENGTH: raise ValueError('筛选条件的值清单总长最多%d字'%MAX_IN_TOTAL_LENGTH)
            column(f.get('column'));result['filters'].append({'column':f['column'],'operator':'in','value':list(values)});continue
        # 老的四个 operator：语义一个字不许改（value 仍是 ≤1000 字的字符串）。
        if operator not in ('contains','equals','empty','not_empty') or not isinstance(f.get('value',''),str) or len(f.get('value',''))>1000: raise ValueError('筛选条件无效')
        column(f.get('column'));result['filters'].append({'column':f['column'],'operator':operator,'value':f.get('value','')})
    if view.get('sort') is not None:
        s=view['sort']
        if not isinstance(s,dict) or set(s)!={'column','direction'} or s['direction'] not in ('asc','desc'): raise ValueError('排序配置无效')
        column(s['column']);result['sort']=dict(s)
    # **列序**（2026-10-29 用户口径）：按这个顺序显示。
    #   · 点名的列按那个顺序排在前面，没点名的列按表里的原顺序接在后面；
    #   · 表里没有的列名**当场拒**（不静默丢掉）；
    #   · 读不着的列**拒**（与筛选／排序同一道权限闸）；
    #   · **没给这个键的老视图原样保留**（不因为新字段被判死，也不给它硬塞一个空数组）。
    if 'columns' in view:
        order=view['columns']
        if not isinstance(order,list) or len(order)>MAX_COLUMN_ORDER: raise ValueError('视图列序无效')
        if any(not isinstance(name,str) for name in order): raise ValueError('视图列序无效')
        if len(set(order))!=len(order): raise ValueError('视图列序里有重复的列，请重新配置')
        for name in order: column(name)
        result['columns']=list(order)
    return result

def _column_order(view,headers):
    """按个人视图的列序排出**实际的显示顺序**。

    列序里点名的列按那个顺序排在前面；没点名的列按表里的原顺序接在后面
    （后来新加的列不会因为老视图没登记就消失 —— 个人视图是「我自己的摆法」，不是硬约束）。
    """
    order=list(view.get('columns') or [])
    listed=set(order)
    return order+[header for header in headers if header not in listed]

def _formal_projection(doc, row_ids, headers):
    """Filter/sort dependencies: only selected columns and visible fixed row identities."""
    selected = set(headers)
    if not selected:
        return {}, {}
    promoted = {col['header']: col['field'] for col in
                promotion.promoted_columns(promotion.load_definition(doc)) if col['header'] in selected}
    if not promoted:
        return {}, {}
    state = promotion.formal_state_for_rows(doc, list(row_ids), fields=list(dict.fromkeys(promoted.values())))
    values, versions = state.get('values') or {}, state.get('versions') or {}
    for rid in row_ids:
        if versions.get(rid) and any(field not in values.get(rid, {}) for field in promoted.values()):
            frappe.throw('无权读取视图依赖的正式字段', frappe.PermissionError)
    return values, promoted

def _value_reader(entry,ids,meta=None,hidden=(),formal=None,promoted=None):
    """某一格在**视图口径**下的值。

    筛选和值清单**必须用同一个口径** —— 两边算出来的文本不一样，
    用户勾了值却一条都命不中，就是「看着筛了、其实没筛」。
    """
    headers=entry['headers'];raw=entry['rows_raw'];positions={h:i for i,h in enumerate(headers)}
    def val(i,h):
        if h in (promoted or {}):
            return (formal or {}).get(ids[i], {}).get(promoted[h])
        result=((meta or {}).get('formula_results') or {}).get(ids[i]+'\0'+h) if i<len(ids) else None
        if result:
            from shangshu_files.formulas import decorate_values
            return decorate_values({h:{'type':'formula','formula':result['formula']}},ids[i],meta or {},0,set(hidden))[h].get('value')
        col=positions[h];return sheet.value_typed(raw[i][col] if i<len(raw) and col<len(raw[i]) else None).get('value')
    return val

def project_rows(entry,ids,view,meta=None,hidden=(),*,allowed_ids=None,formal=None,promoted=None):
    val=_value_reader(entry,ids,meta,hidden,formal,promoted)
    # 条件已由 validate_view 限定类型/数量；每次请求准备一次，不对每行重扫选值清单。
    filters=[(f,set(f.get('value') or []) if f['operator']=='in' else None) for f in view['filters']]
    def matches(i,f,choices):
        value=val(i,f['column']);empty=value in (None,'');text='' if empty else str(value)
        if f['operator']=='in':
            # 「值在这几个里」：按**显示文本**精确匹配；空白格的文本是 ''，
            # 值清单里那一项也是 ''（界面上显示成「(空白)」）。
            return text in choices
        return {'contains':lambda:f['value'].casefold() in text.casefold(),'equals':lambda:text==f['value'],'empty':lambda:empty,'not_empty':lambda:not empty}[f['operator']]()
    rows=[{'row_id':rid,'row_index':i+2} for i,rid in enumerate(ids)
          if (allowed_ids is None or rid in allowed_ids) and all(matches(i,f,choices) for f,choices in filters)]
    if view.get('sort'):
        spec=view['sort'];nonempty=[];empty=[]
        for row in rows:
            v=val(row['row_index']-2,spec['column'])
            (empty if v in (None,'') else nonempty).append(row)
        def key(row):
            v=val(row['row_index']-2,spec['column']);return (0,float(v)) if type(v) in (int,float) else (1,str(v))
        rows=sorted(nonempty,key=key,reverse=spec['direction']=='desc')+empty
    return rows

def _response(doc,entry,meta,stored):
    view=_default();invalid=None
    from shangshu_files.object_projection import read_access
    ids=meta.get('rows') or []
    access=read_access(doc,ids)
    hidden=promotion.unreadable_headers(doc,companion_access=access)
    visible=set(access['allowed_record_ids']) if access is not None else set(ids)
    visible-=set(meta.get('deleted_rows') or [])
    if stored:
        # 插入无关行列或软删不改变已引用列的含义。每次按当前字段/权限复核，
        # 不因结构计数前进就丢弃仍有效的个人配置，也不在读取时重写他人的视图。
        try:view=validate_view(json.loads(stored.view_json),entry['headers'],hidden)
        except (ValueError,frappe.PermissionError): invalid='个人视图引用的字段已删除、改名或不可访问，请重新设置；原配置仍保留'
    needed = [item['column'] for item in view['filters']]
    if view.get('sort'): needed.append(view['sort']['column'])
    formal, promoted = _formal_projection(doc, [rid for rid in ids if rid in visible], needed)
    rows=project_rows(entry,ids,view,meta,hidden,allowed_ids=visible,formal=formal,promoted=promoted)
    return {'revision':int(stored.revision) if stored else 0,'view':view,
            # **列序**：读回来时按它排（点名的列在前，没点名的按表里的原顺序接在后面）。
            'columns':_column_order(view,entry['headers']),
            'rows':rows,'total_rows':len(rows),'source_total_rows':len(visible),'content_version':sheet.content_revision(doc),'structure_version':int(meta.get('structure_version') or 1),**({'invalid_reason':invalid} if invalid else {})}

def read_view(_service,payload,_context=None):
    doc,entry,meta=_source(payload.get('table'));key=_key(doc.name)
    stored=frappe.get_doc(DOCTYPE,key) if frappe.db.exists(DOCTYPE,key) else None
    return _response(doc,entry,meta,stored)

def column_values(_service,payload,_context=None):
    """某一列**整列**的去重值清单（只读，不写库、不改行序）。

    为什么要有这个：列头筛选面板上的「值清单」要列**整列**的值，
    不是当前这一页的 100 行 —— 只给当前页，用户勾了一个值、
    翻页后那个值没了，看着像筛选坏了。

    权限两道（和筛选条件同一条口径）：
      ① 表要可读（`_source` 里的 `check_permission('read')`）；
      ② **该列不可读就不给**（被升列成受字段 ACL 保护的正式字段）——
         与 `promotion.unreadable_headers` 那道闸一致。
    值只取**当前用户能看到的行**（行级 ACL + 已删行），不泄露看不见的行里的值。

    空值单独归为「(空白)」：它在清单里是空字符串 `''`，
    与筛选口径（`text` 为空时也是 `''`）**完全对得上**。
    """
    doc,entry,meta=_source(payload.get('table'))
    column=payload.get('column')
    if not isinstance(column,str) or column not in entry['headers']: raise ValueError('列不存在')
    ids=meta.get('rows') or []
    from shangshu_files.object_projection import read_access
    access=read_access(doc,ids)
    hidden=promotion.unreadable_headers(doc,companion_access=access)
    if column in hidden: frappe.throw('无权读取该列的值清单',frappe.PermissionError)
    visible=set(access['allowed_record_ids']) if access is not None else set(ids)
    visible-=set(meta.get('deleted_rows') or [])
    formal, promoted = _formal_projection(doc, [rid for rid in ids if rid in visible], [column])
    val=_value_reader(entry,ids,meta,hidden,formal,promoted)
    found=set();blank=False
    for i,rid in enumerate(ids):
        if rid not in visible: continue
        value=val(i,column)
        if value in (None,''): blank=True
        else: found.add(str(value))
    total=len(found)
    # 排序稳定：先按大小写无关的文本排，同一文本再按原样排 —— 同一份数据两次取清单，顺序一样。
    ordered=sorted(found,key=lambda s:(s.casefold(),s))
    truncated=total>MAX_COLUMN_VALUES
    if truncated: ordered=ordered[:MAX_COLUMN_VALUES]
    return {'column':column,'values':ordered+([''] if blank else []),'has_blank':blank,'total':total,'truncated':truncated}

def save_view(payload,_context=None):
    doc,entry,meta=_source(payload.get('table'),lock=True)
    key=_key(doc.name)
    current=frappe.db.sql('select * from `tabShangshu Sheet View` where name=%s for update',(key,),as_dict=True)
    stored=frappe.get_doc(dict(current[0],doctype=DOCTYPE)) if current else None
    if payload.get('expected_revision')!=(int(stored.revision) if stored else 0): frappe.throw('个人视图已在另一窗口修改，请重新打开',frappe.ValidationError)
    if payload.get('expected_structure_version')!=int(meta.get('structure_version') or 1): frappe.throw('表结构已变化，请重新打开后设置视图',frappe.ValidationError)
    try:view=validate_view(payload.get('view'),entry['headers'],promotion.unreadable_headers(doc))
    except ValueError as error: frappe.throw(str(error),frappe.ValidationError)
    is_new = stored is None
    if is_new:stored=frappe.get_doc({'doctype':DOCTYPE,'name':key,'user':frappe.session.user,'resource':doc.name,'revision':0})
    stored.view_json=json.dumps(view,ensure_ascii=False);stored.structure_version=int(meta.get('structure_version') or 1);stored.revision=int(stored.revision or 0)+1
    # A document with an explicit deterministic name is not automatically new.
    # insert avoids save trying to load a nonexistent prior row; no public ACL is widened.
    if is_new: stored.insert(ignore_permissions=True)
    else: stored.save(ignore_permissions=True)
    return _response(doc,entry,meta,stored)
