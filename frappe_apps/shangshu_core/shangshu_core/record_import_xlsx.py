"""有界 XLSX 读取与类型转换；不连库、不建表、不保存文件、不执行公式。"""
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import BytesIO
import math
import re
from xml.parsers import expat
from zipfile import BadZipFile, ZipFile

MAX_BYTES = 10 * 1024 * 1024  # Base64 后仍低于既有 BFF 20MB JSON 上限，不扩大公共请求限制。
MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
MAX_MEMBERS = 1000
MAX_CELLS = 500000
MAX_ROWS = 500
MAX_COLUMNS = 100
MAX_HEADER_ROW = 100


class ImportError(ValueError):
    """可向用户展示的文件/单元格错误；业务约束仍由公共记录适配器校验。"""


def input_schema(execute=False):
    properties = {
        'object_id':{'type':'string'}, 'expected_revision':{'type':'integer','minimum':1},
        'filename':{'type':'string','minLength':1,'maxLength':255},
        'content_base64':{'type':'string','minLength':1,'maxLength':4*((MAX_BYTES+2)//3)},
        'sheet':{'type':'string','minLength':1},
        'header_row':{'type':'integer','minimum':1,'maximum':MAX_HEADER_ROW},
        'mapping':{'type':'object','additionalProperties':{'type':'integer','minimum':1,'maximum':MAX_COLUMNS}},
        'match_field':{'type':'string','minLength':1},
    }
    required = ['object_id','expected_revision','filename','content_base64']
    if execute:
        properties['preview_hash'] = {'type':'string','minLength':64,'maxLength':64}
        required += ['sheet','mapping','match_field','preview_hash']
    else:
        properties['inspect_only'] = {'type':'boolean'}
        required = ['filename','content_base64']  # 目标表检查仍由 handler 强制成对校验。
    return {'type':'object','additionalProperties':False,'properties':properties,'required':required}


def _archive(content):
    from openpyxl.utils.cell import coordinate_from_string, column_index_from_string
    if not isinstance(content, bytes) or not content or len(content) > MAX_BYTES:
        raise ImportError('请选择非空 XLSX 文件，文件上限 10MB')
    try:
        with ZipFile(BytesIO(content)) as archive:
            members = archive.infolist()
            names = [member.filename for member in members]
            if len(members) > MAX_MEMBERS or len(names) != len(set(names)):
                raise ImportError('文件压缩结构重复或条目过多，请另存为普通 XLSX')
            if sum(member.file_size for member in members) > MAX_UNCOMPRESSED_BYTES:
                raise ImportError('文件解压后超过 50MB，请拆分工作簿')
            if any(member.flag_bits & 1 for member in members):
                raise ImportError('不支持加密工作簿，请先解密并另存为 XLSX')
            if any('vbaproject' in name.lower() for name in names):
                raise ImportError('不支持宏工作簿，请另存为不含宏的 XLSX')
            if 'xl/workbook.xml' not in names:
                raise ImportError('文件不是有效的 XLSX 工作簿')
            sheets = {}; cell_count = 0
            for member in members:
                if not member.filename.endswith(('.xml', '.rels')):
                    continue
                info = {'max_row':0, 'max_column':0, 'merges':[]}
                parser = expat.ParserCreate(namespace_separator='}')
                def reject_dtd(*args):
                    raise ImportError('工作簿含不支持的 XML 实体声明，请另存为普通 XLSX')
                parser.StartDoctypeDeclHandler = reject_dtd
                parser.EntityDeclHandler = reject_dtd
                parser.ExternalEntityRefHandler = reject_dtd
                def start(name, attributes):
                    nonlocal cell_count
                    local = name.rsplit('}', 1)[-1]
                    if local == 'c' and 'r' in attributes:
                        cell_count += 1
                        if cell_count > MAX_CELLS:
                            raise ImportError('工作簿超过 50 万单元格，请拆分后导入')
                        letter, row = coordinate_from_string(attributes['r'])
                        info['max_row'] = max(info['max_row'], row)
                        info['max_column'] = max(info['max_column'], column_index_from_string(letter))
                    if local == 'mergeCell':
                        info['merges'].append(attributes.get('ref', 'A1'))
                parser.StartElementHandler = start
                with archive.open(member) as stream:
                    while block := stream.read(65536): parser.Parse(block, False)
                    parser.Parse(b'', True)
                if member.filename.startswith('xl/worksheets/'):
                    sheets[member.filename] = info
            return sheets
    except ImportError:
        raise
    except (BadZipFile, OSError, ValueError, KeyError, RuntimeError, expat.ExpatError) as error:
        raise ImportError('XLSX 文件损坏或结构不支持，请用原表另存后重试') from error


def _open(content):
    from openpyxl import load_workbook
    info = _archive(content)  # 必须先限制压缩包与 XML，再交给 Office 解析器。
    try:
        book = load_workbook(BytesIO(content), read_only=True, data_only=False, keep_links=False)
    except Exception as error:
        raise ImportError('无法读取 XLSX 工作簿，请检查文件是否完整') from error
    if len(book.sheetnames) > 50:
        book.close()
        raise ImportError('工作簿超过 50 张工作表，请拆分后导入')
    return book, info


def workbook_sheets(content):
    book, _ = _open(content)
    try: return list(book.sheetnames)
    finally: book.close()


def read_sheet(content, sheet_name, header_row=1):
    from openpyxl.utils.cell import coordinate_from_string, column_index_from_string, get_column_letter
    if type(header_row) is not int or not 1 <= header_row <= MAX_HEADER_ROW:
        raise ImportError('表头行须为 1–100 的整数')
    book, info = _open(content)
    try:
        if sheet_name not in book.sheetnames:
            raise ImportError('请选择文件中存在的工作表')
        sheet = book[sheet_name]
        dimensions = info.get(sheet._worksheet_path.lstrip('/'))
        if dimensions is None:
            raise ImportError('工作表结构不支持，请另存为普通 XLSX')
        last_row, last_column = dimensions['max_row'], dimensions['max_column']
        if last_row <= header_row or not last_column:
            raise ImportError('所选表头之后没有数据行')
        if last_row - header_row > MAX_ROWS or last_column > MAX_COLUMNS:
            raise ImportError('单次最多 500 行、100 列；请删除远端空白格式或拆分工作表')
        issues = []
        def issue(row, column, code, message, coordinate=None):
            issues.append({'sheet':sheet_name,'row':row,'column':column,
                           'coordinate':coordinate or f'{get_column_letter(column)}{row}',
                           'code':code,'message':message})
        for merged in dimensions['merges']:
            letter, row = coordinate_from_string(merged.split(':')[0])
            issue(row, column_index_from_string(letter), 'merged_cells', '含合并单元格，请取消合并并逐行补全内容', merged)
        columns = []; rows = []
        for number, cells in enumerate(sheet.iter_rows(min_row=header_row, max_row=last_row, max_col=last_column), header_row):
            values = []
            for index, cell in enumerate(cells, 1):
                if cell.data_type == 'f': issue(number,index,'formula','含公式，请人工核对后粘贴为值再导入')
                if cell.data_type == 'e': issue(number,index,'excel_error','含 Excel 错误值，请在原表修正后导入')
                values.append({'value':cell.value,'number_format':cell.number_format,'data_type':cell.data_type})
            if number == header_row:
                columns = [{'index':i,'letter':get_column_letter(i),
                            'label':str(cell['value']) if cell['value'] is not None else f'{get_column_letter(i)} 列（无表头）'}
                           for i,cell in enumerate(values,1)]
            elif any(cell['value'] is not None for cell in values):
                rows.append({'row':number,'cells':values})
        if not rows: raise ImportError('所选表头之后没有数据行')
        return {'sheets':list(book.sheetnames),'sheet':sheet_name,'header_row':header_row,'columns':columns,'rows':rows,'issues':issues}
    except ImportError:
        raise
    except Exception as error:
        raise ImportError('工作表读取失败，请另存为普通 XLSX 后重试') from error
    finally:
        book.close()


def cell_value(cell, kind):
    """仅做明确类型转换；必填、选项、长度和权限继续由原元数据校验。"""
    if kind not in {'text','long_text','integer','decimal','date','boolean','choice'}:
        raise ImportError('关联和明细列不能直接按文本导入，请使用对应记录表单')
    if cell.get('data_type') in {'f','e'}:
        raise ImportError('公式或 Excel 错误值必须在原表修正后导入')
    value = cell.get('value')
    if value is None or value == '': return None
    if kind in {'text','long_text','choice'}:
        if isinstance(value,str): return value  # 案号前导零、分号清单与空格均不擅自改写。
        if isinstance(value,bool): return 'TRUE' if value else 'FALSE'
        if isinstance(value,date): return value.isoformat()
        if type(value) in {int,float} and math.isfinite(value):
            if abs(value) >= 10**15:
                raise ImportError('长编号以数值保存，可能已丢精度；请在原表改为正确的文本再导入')
            mask = cell.get('number_format','General')
            if re.fullmatch('0+', mask) and float(value).is_integer():
                return ('-' if value < 0 else '') + str(abs(int(value))).zfill(len(mask))
            return str(value)
        raise ImportError('该值不能转换为文本，请检查原表')
    if kind == 'date':
        if isinstance(value,datetime):
            if value.time().isoformat() != '00:00:00' or value.tzinfo is not None:
                raise ImportError('日期列含时间或时区，请明确取舍后使用 YYYY-MM-DD')
            return value.date().isoformat()
        if isinstance(value,date): return value.isoformat()
        if isinstance(value,str):
            try:
                if date.fromisoformat(value).isoformat() == value: return value
            except ValueError: pass
        raise ImportError('日期需为有效的 YYYY-MM-DD 或 Excel 日期，不能猜测数字日期')
    if kind == 'boolean':
        if type(value) is bool: return value
        if type(value) is int and value in {0,1}: return bool(value)
        if isinstance(value,str) and value.upper() in {'TRUE','FALSE'}: return value.upper() == 'TRUE'
        raise ImportError('开关列请使用 TRUE/FALSE 或 0/1')
    if isinstance(value,bool) or not isinstance(value,(str,int,float)):
        raise ImportError('数字列请填写有效数字')
    try:
        text = str(value).strip()
        if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?',text): raise InvalidOperation()
        number = Decimal(text)
        if not number.is_finite() or not math.isfinite(float(number)) or (number and float(number) == 0): raise InvalidOperation()
        if kind == 'integer':
            if number != number.to_integral_value(): raise InvalidOperation()
            if not -2147483648 <= number <= 2147483647:
                raise ImportError('整数超出范围，请改为文本保存长编号')
            return int(number)
        return float(number)
    except (InvalidOperation, ValueError, OverflowError) as error:
        raise ImportError('整数列不能含小数，数字列不能含文字、千分位或无穷值') from error
