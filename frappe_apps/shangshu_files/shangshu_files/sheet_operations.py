"""普通工作簿的结构、排序和格式；沿原文件版本／Action事务，不建业务字段。"""
from copy import copy
import datetime
import frappe
from openpyxl.styles import Alignment, Border, Side
from openpyxl.utils import get_column_letter
from shangshu_files import sheet

FORMATS={'General','0','0.00','#,##0','#,##0.00','0%','0.00%','yyyy-mm-dd','yyyy-mm-dd hh:mm:ss'}


def _reject(message):frappe.throw(message,frappe.ValidationError)


def _structure_guard(wb,ws):
    # openpyxl不会替其他表/命名范围/公式迁移引用；宁可明确拒绝，不保存一个错位文件。
    if (ws.merged_cells.ranges or ws.data_validations.count or ws.conditional_formatting
            or ws.auto_filter.ref or wb.defined_names
            or any(w.tables or any(c.data_type=='f' for _,c in sheet._iter_real_cells(w)) for w in wb)):
        _reject('该文件含公式、合并或关联范围，暂不支持在此调整行列／排序；原文件未修改')
    if len(ws._cells)>500000:_reject('当前结构操作最多处理50万实际单元格，请缩小工作簿')


def _move(ws,row_map=None,col_map=None):
    """仅搬实际格，连同样式／批注／超链接；不展开XFD空矩形。None表示删除。"""
    moved={}
    for (row,col),old in list(ws._cells.items()):
        nr=row_map.get(row,row) if row_map is not None else row
        nc=col_map.get(col,col) if col_map is not None else col
        if nr is None or nc is None:continue
        if nr>1048576 or nc>16384:_reject('移动后超出Excel行列上限，原文件未修改')
        cell=copy(old);cell.row=nr;cell.column=nc
        if cell.hyperlink:cell._hyperlink=copy(cell.hyperlink);cell._hyperlink.ref=cell.coordinate
        moved[(nr,nc)]=cell
    ws._cells=moved
    if row_map is not None:
        original=list(ws.row_dimensions.items());ws.row_dimensions.clear()
        for index,dimension in original:
            target=row_map.get(index,index)
            if target is not None:
                item=copy(dimension);item.index=target;ws.row_dimensions[target]=item
    if col_map is not None:
        original=list(ws.column_dimensions.items());ws.column_dimensions.clear()
        from openpyxl.utils import column_index_from_string
        for key,dimension in original:
            index=dimension.min or column_index_from_string(key)
            if dimension.max and dimension.max!=index:_reject('分组列宽暂不支持结构调整，原文件未修改')
            target=col_map.get(index,index)
            if target is not None:
                item=copy(dimension);item.index=get_column_letter(target);item.min=target;item.max=target
                ws.column_dimensions[item.index]=item


def _finish(doc,wb,meta,ws,**result):
    # 规划完成后的稀疏快照是保存校验的目标；落盘后全簿逐值核验，仍生成原版本链。
    version=sheet._save_with_gates(doc,wb,ws,meta,before=sheet._snapshot(wb),
        expect={'headers':sheet._headers_of(ws)})
    return {'table':doc.name,'content_version':version,
            'structure_version':int(meta.get('structure_version') or 1),**result}


def structure(payload,context=None):
    doc,wb,meta,ws=sheet._structure_open(payload)
    _structure_guard(wb,ws)
    operation=payload['operation'];rows=list(meta['rows']);headers=sheet._headers_of(ws)
    if operation=='row_insert':
        before=payload.get('before_row_id')
        if before not in rows:_reject('请选择当前文件中的插入位置')
        index=rows.index(before);physical=index+2
        new=sheet._allocate_row_ids(meta,1)[0]
        _move(ws,row_map={r:r+1 for r in set(row for row,_ in ws._cells) if r>=physical})
        ws.cell(physical,1).value=' ';rows.insert(index,new)
    elif operation=='row_delete':
        selected=payload.get('row_ids') or []
        if not selected or len(set(selected))!=len(selected) or any(r not in rows for r in selected):
            _reject('删除行无效，请重新选择当前文件中的行')
        sheet._allocate_row_ids(meta,0)  # 先记住被删最大编号，后续追加不得复用历史身份。
        positions={rows.index(r)+2 for r in selected}
        _move(ws,row_map={r:None if r in positions else r-sum(p<r for p in positions)
                         for r in set(row for row,_ in ws._cells) if r>=2})
        rows=[r for r in rows if r not in set(selected)]
    elif operation=='column_insert':
        before=payload.get('before_header');header=str(payload.get('header') or '').strip()
        if before not in headers or not header or header in headers:_reject('新列名不能为空、不能重复，插入位置须存在')
        index=headers.index(before)+1
        _move(ws,col_map={c:c+1 for c in set(col for _,col in ws._cells) if c>=index})
        ws.cell(1,index).value=header
    elif operation=='column_delete':
        selected=payload.get('headers') or []
        if (not selected or len(set(selected))!=len(selected) or len(selected)>=len(headers)
                or any(h not in headers for h in selected)):_reject('删除列无效；至少保留一列')
        positions={headers.index(h)+1 for h in selected}
        _move(ws,col_map={c:None if c in positions else c-sum(p<c for p in positions)
                         for c in set(col for _,col in ws._cells)})
    else:_reject('不支持的结构操作')
    meta['rows']=rows;sheet._bump_structure(meta)
    return _finish(doc,wb,meta,ws,operation=operation,row_ids=rows,headers=sheet._headers_of(ws))


def sort_rows(payload,context=None):
    doc,wb,meta,ws=sheet._structure_open(payload)
    _structure_guard(wb,ws)
    headers=sheet._headers_of(ws);header=payload['header'];direction=payload['direction']
    if header not in headers or direction not in ('asc','desc'):_reject('排序列或方向无效')
    column=headers.index(header)+1;rows=list(meta['rows'])
    def key(index):
        value=ws.cell(index+2,column).value
        if value is None or value=='':return (3,'')
        if isinstance(value,(int,float,bool)):return (0,float(value))
        if isinstance(value,(datetime.date,datetime.datetime)):return (1,value.isoformat())
        return (2,str(value).casefold())
    ordered=sorted(range(len(rows)),key=key,reverse=direction=='desc')
    _move(ws,row_map={old+2:new+2 for new,old in enumerate(ordered)})
    meta['rows']=[rows[i] for i in ordered];sheet._bump_structure(meta)
    return _finish(doc,wb,meta,ws,applied=len(rows),row_ids=meta['rows'])


def style_cells(payload,context=None):
    doc,wb,meta,ws=sheet._structure_open(payload)
    patch=payload['style'];targets=payload['cells']
    if not patch or set(patch)-{'number_format','bold','wrap_text','border'}:_reject('请选择已支持的格式')
    if 'number_format' in patch and patch['number_format'] not in FORMATS:_reject('暂不支持该数字格式')
    if 'border' in patch and patch['border'] not in ('none','all'):_reject('边框设置无效')
    if any(k in patch and type(patch[k]) is not bool for k in ('bold','wrap_text')):_reject('格式开关无效')
    seen=set();cells=[]
    for target in targets:
        key=(target['row_id'],target['header'])
        if key in seen:_reject('选区重复，请重新选择')
        seen.add(key)
        row,col=sheet._sheet_row_col(ws,meta,*key);sheet._check_merged(ws,row,col)
        cells.append(ws.cell(row,col))
    before=sheet._snapshot(wb)
    for cell in cells:
        if 'number_format' in patch:cell.number_format=patch['number_format']
        if 'bold' in patch:
            font=copy(cell.font);font.bold=patch['bold'];cell.font=font
        if 'wrap_text' in patch:
            alignment=copy(cell.alignment);alignment.wrap_text=patch['wrap_text'];cell.alignment=alignment
        if 'border' in patch:
            edge=Side(style='thin',color='FFD1D5DB') if patch['border']=='all' else Side()
            cell.border=Border(top=edge,bottom=edge,left=edge,right=edge)
    version=sheet._save_with_gates(doc,wb,ws,meta,before=before)
    return {'table':doc.name,'content_version':version,'structure_version':meta['structure_version'],'applied':len(cells)}
