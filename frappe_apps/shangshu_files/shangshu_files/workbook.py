"""有界文件工作簿编解码。只生成字节，不建业务表、不写数据库、不执行公式。"""
import base64
import copy
import csv
from datetime import date, datetime
from io import BytesIO, StringIO
import math
import re
from xml.parsers import expat
from zipfile import ZipFile, BadZipFile

MAX_BYTES = 10 * 1024 * 1024
MAX_ROWS, MAX_COLUMNS, MAX_SHEETS, MAX_CELLS = 1000, 100, 10, 100000
REVISION = 1


def _fail(message):
    raise ValueError(message)


def blank():
    return {'revision': REVISION, 'editable': True, 'reason': '', 'sheets': [
        {'key': 's0', 'title': '工作表1', 'rows': 20, 'columns': 12, 'cells': [[None]*12 for _ in range(20)]}]}


def _archive(content):
    if not isinstance(content, bytes) or not content or len(content) > MAX_BYTES:
        _fail('请选择非空 XLSX 文件，在线表格上限10MB')
    reason = ''
    count = 0
    try:
        with ZipFile(BytesIO(content)) as archive:
            members = archive.infolist(); names = [item.filename for item in members]
            if len(members) > 1000 or len(names) != len(set(names)) or sum(item.file_size for item in members) > 50*1024*1024:
                _fail('压缩结构重复、条目过多或解压超过50MB，请拆分文件')
            if 'xl/workbook.xml' not in names or any(item.flag_bits & 1 for item in members):
                _fail('文件不是普通XLSX或已加密，请先另存')
            if any('vba' in name.lower() for name in names): _fail('不支持宏工作簿，请下载原件使用')
            for item in members:
                ordinary = re.fullmatch(r'(?:\[Content_Types\]\.xml|_rels/\.rels|docProps/(?:app|core)\.xml|xl/(?:workbook|styles|sharedStrings)\.xml|xl/_rels/workbook\.xml\.rels|xl/theme/theme\d+\.xml|xl/worksheets/sheet\d+\.xml)', item.filename)
                if not ordinary:
                    reason = '包含暂不支持的工作簿内容，保持只读以免丢失源文件特性'
                if item.filename.startswith(('xl/drawings/', 'xl/charts/', 'xl/pivot', 'xl/externalLinks/', 'xl/embeddings/', 'xl/tables/', 'customXml/', 'xl/media/')):
                    reason = '包含图表、透视表、外部关联或嵌入内容，当前保持只读以保留原件'
                if not item.filename.endswith(('.xml', '.rels')): continue
                parser = expat.ParserCreate(namespace_separator='}')
                def reject(*_): _fail('工作簿含XML实体或DTD，不能在线读取')
                parser.StartDoctypeDeclHandler = reject
                parser.EntityDeclHandler = reject
                parser.ExternalEntityRefHandler = reject
                def start(name, attrs):
                    nonlocal count, reason
                    tag = name.rsplit('}', 1)[-1]
                    if item.filename.startswith('xl/worksheets/') and tag == 'c':
                        count += 1
                        match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]*)', attrs.get('r', ''))
                        if not match: _fail('单元格坐标无效')
                        col = 0
                        for char in match[1]: col = col*26+ord(char)-64
                        if int(match[2]) > MAX_ROWS or col > MAX_COLUMNS or count > MAX_CELLS:
                            _fail('在线表格最多1000行、100列、10个工作表及10万单元格，请拆分文件')
                    protected = tag == 'sheetProtection' and attrs.get('sheet') in ('1','true') or tag == 'workbookProtection' and any(attrs.get(k) in ('1','true') for k in ('lockStructure','lockWindows','lockRevision'))
                    if protected or tag in ('f','mergeCell','conditionalFormatting','dataValidation','definedName','extLst','filterColumn','sortState'):
                        reason = '包含公式、合并、保护或高级规则，当前只读；原件与原格式不转换'
                    if item.filename.startswith('xl/worksheets/') and tag == 'row' and int(attrs.get('r', 0)) > MAX_ROWS:
                        _fail('行范围超过在线表格上限')
                    if item.filename.startswith('xl/worksheets/') and tag == 'col' and int(attrs.get('max', 0)) > MAX_COLUMNS:
                        _fail('列范围超过在线表格上限')
                    if tag == 'col' and (int(attrs.get('min',1)) != int(attrs.get('max',1)) or attrs.get('hidden') in ('1','true') or int(attrs.get('outlineLevel',0))):
                        reason = '包含分组或隐藏列，当前只读以保留显示结构'
                    if tag == 'row' and (attrs.get('hidden') in ('1','true') or int(attrs.get('outlineLevel',0))):
                        reason = '包含分组或隐藏行，当前只读以保留显示结构'
                    if tag == 'r' and (item.filename == 'xl/sharedStrings.xml' or item.filename.startswith('xl/worksheets/')):
                        reason = '包含单元格富文本，当前只读以免丢失文字格式'
                parser.StartElementHandler = start
                with archive.open(item) as stream:
                    while chunk := stream.read(65536): parser.Parse(chunk, False)
                    parser.Parse(b'', True)
            return reason
    except (BadZipFile, expat.ExpatError, KeyError, OverflowError) as error:
        raise ValueError('XLSX结构无效，请下载原件检查') from error


def _open(content):
    from openpyxl import load_workbook
    reason = _archive(content)
    try: workbook = load_workbook(BytesIO(content), keep_links=False)
    except Exception as error: raise ValueError('无法读取该XLSX，请先另存为普通工作簿') from error
    if not 1 <= len(workbook.worksheets) <= MAX_SHEETS: _fail('最多10个工作表')
    return workbook, reason


def _dimensions(sheet):
    rows = max(20, sheet.max_row, max(sheet.row_dimensions, default=1))
    columns = max(12, sheet.max_column, max((value.max or value.min or 1 for value in sheet.column_dimensions.values()), default=1))
    if rows > MAX_ROWS or columns > MAX_COLUMNS: _fail('工作表行列超过上限')
    return rows, columns


def decode(content):
    workbook, reason = _open(content)
    sheets = []; total = 0
    for index, sheet in enumerate(workbook.worksheets):
        rows, columns = _dimensions(sheet); total += rows*columns
        if total > MAX_CELLS: _fail('展开后的工作簿超过10万单元格，请拆分文件')
        cells = []
        for row in sheet.iter_rows(min_row=1, max_row=rows, max_col=columns):
            values = []
            for cell in row:
                value = cell.value
                if value is None: values.append(None); continue
                kind = 'f' if cell.data_type == 'f' else 'b' if isinstance(value, bool) else 'd' if isinstance(value, (date, datetime)) else 'n' if isinstance(value, (int, float)) else 's'
                if kind == 'd': value = value.isoformat()
                if kind == 'n' and (not math.isfinite(value) or abs(value) > 9007199254740991):
                    reason = '含超精度数值，保持只读以避免改变原值'
                    value = str(value); kind = 's'
                if cell.data_type == 'e': reason = '含Excel错误值，保持只读以免隐藏错误'
                values.append({'t': kind, 'v': value})
            cells.append(values)
        if sheet.sheet_state != 'visible': reason = '含隐藏工作表，保持只读以保留原显示结构'
        sheets.append({'key': 's'+str(index), 'title': sheet.title, 'rows': rows, 'columns': columns, 'cells': cells})
    return {'revision': REVISION, 'editable': not reason, 'reason': reason, 'sheets': sheets}


def read_csv(content):
    if not isinstance(content, bytes) or len(content) > MAX_BYTES: _fail('CSV上限10MB')
    try: text = content.decode('utf-8-sig')
    except UnicodeDecodeError: _fail('CSV须使用UTF-8编码，请先另存')
    if '\0' in text: _fail('CSV包含非文本内容')
    try: dialect = csv.Sniffer().sniff(text[:16384], delimiters=',;\t')
    except csv.Error: dialect = csv.excel
    rows = []
    try:
        for row in csv.reader(StringIO(text, newline=''), dialect=dialect, strict=True):
            if len(rows) >= MAX_ROWS or len(row) > MAX_COLUMNS or any(len(value) > 32767 for value in row): _fail('CSV超过行列或单元格长度上限')
            rows.append([{'t':'s','v': value} if value else None for value in row])
    except csv.Error as error: raise ValueError('CSV引号结构无效') from error
    columns = max(12, max(map(len, rows), default=1)); count = max(20,len(rows))
    if count*columns > MAX_CELLS: _fail('CSV超过单元格上限')
    padded = [row+[None]*(columns-len(row)) for row in rows]+[[None]*columns for _ in range(count-len(rows))]
    return {'revision': REVISION, 'editable': True, 'reason': '', 'sheets': [{'key':'s0','title':'工作表1','rows':count,'columns':columns,'cells':padded}]}


def _validate(draft):
    if not isinstance(draft, dict) or draft.get('revision') != REVISION: _fail('工作簿编辑协议不匹配')
    sheets = draft.get('sheets')
    if not isinstance(sheets, list) or not 1 <= len(sheets) <= MAX_SHEETS: _fail('须保留1–10个工作表')
    names = set(); keys = set(); total = 0
    for sheet in sheets:
        if not isinstance(sheet, dict): _fail('工作表结构无效')
        key, title, rows, columns, cells = (sheet.get(k) for k in ('key','title','rows','columns','cells'))
        if not isinstance(key,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,50}',key) or key in keys: _fail('工作表身份重复或无效')
        if not isinstance(title,str) or not title.strip() or len(title)>31 or re.search(r'[\\/*?:\[\]\x00-\x1f]',title) or title.lower() in names: _fail('工作表名称无效或重名（最多31字）')
        keys.add(key); names.add(title.lower())
        if type(rows) is not int or type(columns) is not int or not 1 <= rows <= MAX_ROWS or not 1 <= columns <= MAX_COLUMNS: _fail('工作表行列超过上限')
        total += rows*columns
        if total > MAX_CELLS or not isinstance(cells,list) or len(cells) != rows: _fail('单元格矩阵无效或超过10万格')
        for row in cells:
            if not isinstance(row,list) or len(row) != columns: _fail('单元格矩阵列数不一致')
            for cell in row:
                if cell is None: continue
                if not isinstance(cell,dict) or set(cell) != {'t','v'}: _fail('单元格格式无效')
                kind, value = cell['t'], cell['v']
                if kind == 's':
                    if not isinstance(value,str) or len(value)>32767 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]',value): _fail('单元格文字过长或含非法字符')
                elif kind == 'n':
                    if type(value) not in (int,float) or not math.isfinite(value) or abs(value)>9007199254740991: _fail('数值无效或超过安全精度')
                elif kind == 'b':
                    if type(value) is not bool: _fail('是/否单元格格式无效')
                elif kind == 'd':
                    try: parsed = datetime.fromisoformat(value)
                    except (ValueError,TypeError): _fail('日期格式无效，使用YYYY-MM-DD')
                    if parsed.tzinfo: _fail('Excel日期不能包含时区')
                else: _fail('当前不支持新建公式，文字不会自动当公式执行')
    return sheets


def _structure(workbook, operations):
    from openpyxl.utils import get_column_letter, column_index_from_string, coordinate_to_tuple, range_boundaries
    targets = {'s'+str(i): sheet for i,sheet in enumerate(workbook.worksheets)}
    if not isinstance(operations,list) or len(operations)>200: _fail('结构修改超过200次，请先保存')
    for op in operations:
        if not isinstance(op,dict): _fail('结构修改无效')
        kind, key = op.get('kind'), op.get('key')
        if kind == 'add_sheet':
            if key in targets or len(targets)>=MAX_SHEETS: _fail('工作表身份重复或数量超限')
            targets[key] = workbook.create_sheet(op.get('title')); continue
        if key not in targets: _fail('原工作表不存在，请重新载入')
        sheet = targets[key]
        if kind == 'rename_sheet': sheet.title = op.get('title'); continue
        if kind == 'delete_sheet':
            if len(targets)<=1: _fail('至少保留一个工作表')
            workbook.remove(sheet); del targets[key]; continue
        if kind not in ('insert_row','delete_row','insert_column','delete_column'): _fail('未知结构操作')
        index, count = op.get('index'), op.get('count',1)
        row_axis = kind.endswith('row'); upper = MAX_ROWS if row_axis else MAX_COLUMNS
        if type(index) is not int or type(count) is not int or not 1<=index<=upper or not 1<=count<=upper: _fail('插入/删除位置无效')
        insertion=kind.startswith('insert'); rows,columns=_dimensions(sheet)
        extent=rows if row_axis else columns
        if insertion and index<=extent and extent+count>upper: _fail('插入后行列超限')
        if index>extent+1 or not insertion and index+count-1>extent: _fail('结构操作超出工作表范围')
        def shift(position):
            return position+count if insertion and position>=index else max(index,position-count) if not insertion and position>=index else position
        if sheet.freeze_panes:
            r,c=coordinate_to_tuple(sheet.freeze_panes)
            sheet.freeze_panes=get_column_letter(c if row_axis else shift(c))+str(shift(r) if row_axis else r)
        if sheet.auto_filter.ref:
            left,top,right,bottom=range_boundaries(sheet.auto_filter.ref)
            if row_axis:top,bottom=shift(top),shift(bottom)
            else:
                left,right=shift(left),shift(right)
                # 筛选条件的列索引是相对范围；删除/插入列时不保留可能指向错误列的旧条件。
                sheet.auto_filter.filterColumn=[];sheet.auto_filter.sortState=None
            sheet.auto_filter.ref=f'{get_column_letter(left)}{top}:{get_column_letter(right)}{bottom}'
        # openpyxl移动单元格样式；行高/列宽显式跟随，不丢员工已有格式。
        dimensions = sheet.row_dimensions if row_axis else sheet.column_dimensions
        prior = [(i if row_axis else column_index_from_string(i),copy.copy(d)) for i,d in dimensions.items()]
        dimensions.clear()
        for position, value in prior:
            if not insertion and index<=position<index+count: continue
            new = position+count if insertion and position>=index else position-count if not insertion and position>=index+count else position
            if new>upper: _fail('插入后行列超限')
            label = new if row_axis else get_column_letter(new)
            value.index=label
            if not row_axis: value.min=value.max=new
            dimensions[label]=value
        method = ('insert_rows' if insertion else 'delete_rows') if row_axis else ('insert_cols' if insertion else 'delete_cols')
        getattr(sheet,method)(index,count)
    return targets


def encode(draft, source=None, operations=None):
    from openpyxl import Workbook
    from openpyxl.utils import get_column_letter
    sheets = _validate(draft)
    if source:
        workbook, reason = _open(source)
        if reason or not decode(source)['editable']: _fail(reason or '原文件只能只读，不能转换后覆盖')
        targets = _structure(workbook,operations or [])
        if [s['key'] for s in sheets] != list(targets): _fail('工作表增删须有明确结构操作，不允许丢失原表')
    else:
        workbook=Workbook(); workbook.remove(workbook.active)
        targets={s['key']:workbook.create_sheet(s['title']) for s in sheets}
    for model in sheets:
        sheet=targets[model['key']]
        if sheet.title != model['title']: _fail('工作表名称修改须有明确操作')
        for row in sheet.iter_rows():
            for cell in row:
                if cell.value is not None and (cell.row>model['rows'] or cell.column>model['columns']): _fail('原内容超出新范围，请先明确删除对应行列')
        # 保存全部自由值，保持原样式；字符串强制为文字以免执行公式。
        for r,row in enumerate(model['cells'],1):
            for c,value in enumerate(row,1):
                cell=sheet.cell(r,c)
                cell.value=None if value is None else datetime.fromisoformat(value['v']) if value['t']=='d' else value['v']
                if value and value['t']=='s': cell.data_type='s'
        sheet.row_dimensions[model['rows']].height = sheet.row_dimensions[model['rows']].height or 20
        last=sheet.column_dimensions[get_column_letter(model['columns'])]
        last.width=last.width or 16
    output=BytesIO(); workbook.save(output); data=output.getvalue()
    if len(data)>MAX_BYTES: _fail('保存结果超过10MB，请拆分工作簿')
    return data


def invoke(_service, payload, _context):
    """经文件域已注册只读服务调用，当前身份/域准入由公共executor复核。"""
    import frappe
    from shangshu_core.public_api import get_record_attachments
    from shangshu_files.domain import versions
    operation=payload.get('operation'); source=None
    try:
        if operation == 'blank': return blank()
        if payload.get('file') or payload.get('version'):
            if not payload.get('file') or type(payload.get('version')) is not int: _fail('请选择固定文件版本')
            history=versions('files.versions', {'file':payload['file']}, _context)
            if not str(history.get('file',{}).get('file_name','')).lower().endswith('.xlsx'):
                _fail('只能在线编辑XLSX原件；CSV请导入为新文件，不覆盖源文件')
            selected=next((v for v in history['versions'] if v['version_no']==payload['version']),None)
            if not selected: _fail('所选固定版本不存在或超出历史范围')
            # 引用绑定与当前来源权限先确认，再读本域固定附件；不猜下载路径。
            get_record_attachments('Shangshu File Center File',payload['file'],[selected['frappe_file']])
            source=frappe.get_doc('File',selected['frappe_file']).get_content()
            if not isinstance(source,bytes): source=source.encode()
        if operation=='open':
            if source is None: _fail('请选择原文件')
            return decode(source)
        if operation=='import':
            try: data=base64.b64decode(payload.get('content_base64',''),validate=True)
            except Exception: _fail('导入内容不是有效Base64')
            name=payload.get('filename','').lower()
            if name.endswith('.csv'): return read_csv(data)
            if not name.endswith('.xlsx'): _fail('请选择XLSX或UTF-8 CSV文件')
            return decode(data)
        if operation=='encode':
            data=encode(payload.get('workbook'),source,payload.get('operations'))
            return {'revision':REVISION,'content_base64':base64.b64encode(data).decode(),'mime_type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','size':len(data)}
        _fail('未知工作簿操作')
    except ValueError as error: frappe.throw(str(error),frappe.ValidationError)
