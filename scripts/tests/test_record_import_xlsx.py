"""XLSX 输入边界回归；不连接数据库或写入业务记录。"""
import importlib.util
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZIP_DEFLATED

from openpyxl import Workbook

path = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core/record_import_xlsx.py'
spec = importlib.util.spec_from_file_location('record_import_xlsx', path)
xlsx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xlsx)


def workbook(rows, configure=None):
    book = Workbook(); sheet = book.active; sheet.title = '采购'
    for row in rows: sheet.append(row)
    if configure: configure(book, sheet)
    stream = BytesIO(); book.save(stream); book.close()
    return stream.getvalue()


def replace_member(content, name, value):
    output = BytesIO()
    with ZipFile(BytesIO(content)) as source, ZipFile(output, 'w', ZIP_DEFLATED) as target:
        for member in source.namelist(): target.writestr(member, value if member == name else source.read(member))
    return output.getvalue()


class ImportXlsxTests(unittest.TestCase):
    def read(self, rows, configure=None, **kwargs):
        return xlsx.read_sheet(workbook(rows, configure), '采购', **kwargs)

    def test_select_sheet_and_header_without_guessing(self):
        content = workbook([['说明'], ['案号', '数量'], ['00123', 12.5]], lambda b,s:b.create_sheet('另表'))
        self.assertEqual(xlsx.workbook_sheets(content), ['采购', '另表'])
        result = xlsx.read_sheet(content, '采购', 2)
        self.assertEqual(result['columns'], [{'index':1,'letter':'A','label':'案号'}, {'index':2,'letter':'B','label':'数量'}])
        self.assertEqual(result['rows'][0]['row'], 3)
        self.assertEqual(result['rows'][0]['cells'][0]['value'], '00123')
        with self.assertRaisesRegex(xlsx.ImportError, '工作表'): xlsx.read_sheet(content, '不存在')
        for header in (0, -1, True, 1.5, 99999):
            with self.subTest(header=header), self.assertRaises(xlsx.ImportError): xlsx.read_sheet(content, '采购', header)

    def test_duplicate_headers_use_column_indexes_not_silent_overwrite(self):
        result = self.read([['名称','名称'],['甲','乙']])
        self.assertEqual([c['index'] for c in result['columns']], [1,2])
        self.assertEqual([c['value'] for c in result['rows'][0]['cells']], ['甲','乙'])

    def test_blank_header_gets_column_label(self):
        result = self.read([['名称',None],['甲','乙']])
        self.assertEqual(result['columns'][1]['label'], 'B 列（无表头）')

    def test_empty_rows_keep_excel_row_numbers(self):
        result = self.read([['名称'],['甲'],[None],['乙']])
        self.assertEqual([r['row'] for r in result['rows']], [2,4])
        with self.assertRaisesRegex(xlsx.ImportError, '数据行'): self.read([['名称']])

    def test_formulas_errors_and_merges_are_located(self):
        result = self.read([['名称','数量'],['=1+1',2],['甲','#DIV/0!']], lambda b,s:s.merge_cells('A4:B4'))
        self.assertEqual({i['code'] for i in result['issues']}, {'formula','excel_error','merged_cells'})
        self.assertTrue(all(i['sheet']=='采购' and i['row'] and i['column'] and i['message'] for i in result['issues']))
        self.assertEqual(next(i['coordinate'] for i in result['issues'] if i['code']=='formula'),'A2')

    def test_literal_formula_text_is_not_a_formula(self):
        result = self.read([['名称'],['=1+1']], lambda b,s:setattr(s['A2'], 'data_type', 's'))
        self.assertEqual(result['issues'], [])
        self.assertEqual(xlsx.cell_value(result['rows'][0]['cells'][0], 'text'), '=1+1')

    def test_unselected_formula_sheet_does_not_block_selected_sheet(self):
        result = self.read([['名称'],['甲']], lambda b,s:b.create_sheet('公式').append(['=1+1']))
        self.assertEqual(result['issues'], [])

    def test_text_keeps_zeroes_long_ids_and_multivalue(self):
        for value in ('00123','123456789012345678901234','甲；乙','  原文  '):
            self.assertEqual(xlsx.cell_value({'value':value},'text'),value)
        self.assertEqual(xlsx.cell_value({'value':123,'number_format':'00000'},'text'),'00123')
        self.assertEqual(xlsx.cell_value({'value':123},'text'),'123')
        with self.assertRaisesRegex(xlsx.ImportError,'文本'): xlsx.cell_value({'value':1234567890123456},'text')

    def test_numeric_dates_are_not_silently_coerced(self):
        cases = [('12.50','decimal',12.5),('12','integer',12),(0,'integer',0),('', 'date',None),
                 ('2026-09-21','date','2026-09-21'),(date(2026,9,21),'date','2026-09-21'),
                 (datetime(2026,9,21),'date','2026-09-21'),(True,'boolean',True)]
        for value,kind,expected in cases:
            with self.subTest(value=value,kind=kind): self.assertEqual(xlsx.cell_value({'value':value},kind),expected)
        for value,kind in [('abc','decimal'),('12.5','integer'),(True,'integer'),('NaN','decimal'),
                           ('1,234','decimal'),('2026-02-30','date'),(45000,'date'),
                           (datetime(2026,9,21,12),'date'),('yes','boolean'),('123','reference'),([], 'detail')]:
            with self.subTest(value=value,kind=kind),self.assertRaises(xlsx.ImportError): xlsx.cell_value({'value':value},kind)

    def test_bad_archives_and_macros_rejected(self):
        for value in (b'',b'not zip',b'PK\x03\x04broken'):
            with self.subTest(value=value),self.assertRaises(xlsx.ImportError):xlsx.workbook_sheets(value)
        output=BytesIO()
        with ZipFile(output,'w') as target:target.writestr('xl/vbaProject.bin',b'code')
        with self.assertRaises(xlsx.ImportError):xlsx.workbook_sheets(output.getvalue())

    def test_zip_and_cell_limits_are_checked_before_loading(self):
        content=workbook([['名称'],['甲']])
        for key in ('MAX_BYTES','MAX_UNCOMPRESSED_BYTES','MAX_MEMBERS','MAX_CELLS'):
            with self.subTest(key=key),patch.object(xlsx,key,1),self.assertRaises(xlsx.ImportError):xlsx.workbook_sheets(content)
        with patch.object(xlsx,'MAX_ROWS',1),self.assertRaises(xlsx.ImportError):self.read([['名称'],['甲'],['乙']])
        with patch.object(xlsx,'MAX_COLUMNS',1),self.assertRaises(xlsx.ImportError):self.read([['名称','数量'],['甲',1]])

    def test_xml_entities_and_sparse_dimensions_rejected(self):
        content=workbook([['名称'],['甲']])
        for xml in (b'<!DOCTYPE x [<!ENTITY a "boom">]><worksheet>&a;</worksheet>',
                    '<!DOCTYPE x [<!ENTITY a "boom">]><worksheet>&a;</worksheet>'.encode('utf-16')):
            with self.assertRaises(xlsx.ImportError):xlsx.workbook_sheets(replace_member(content,'xl/worksheets/sheet1.xml',xml))
        with self.assertRaises(xlsx.ImportError):self.read([['名称'],['甲']],lambda b,s:setattr(s['XFD1048576'],'value','远端格'))


if __name__ == '__main__': unittest.main()
