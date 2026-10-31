"""Production cold parser with real XLSX fixtures; no server/customer-data writes."""
import ast
from collections import OrderedDict
import datetime
import io
from pathlib import Path
import re
import sys
import threading
import types
import unittest
import warnings
import zipfile
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import (  # noqa: E402 —— 路径要先装好
    install_real_environment,
    install_stub_package,
    load_module_functions,
)

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/sheet.py'

install_real_environment()
# 桩 frappe 的 `ValidationError` 得是**能抛的异常类**（`frappe.throw(消息, frappe.ValidationError)`
# 要真抛出去；桩属性默认不是异常类 ⇒ 抛的时候 TypeError）。
install_stub_package('frappe', ValidationError=ValueError)

# 真模块装载：sheet.py 的顶层 import 按真包解析（`shangshu_files.zipedit` / `openpyxl` /
# `frappe` 桩），模块级常量随模块一起进来（`_PARSE_CACHE` / `META_FIELD` / …）——
# 不再手抄一份 exec 上下文。
_ALL_NAMES = [node.name for node in ast.parse(SOURCE.read_text()).body
              if isinstance(node, (ast.FunctionDef, ast.ClassDef))]
env = load_module_functions(SOURCE, _ALL_NAMES, overrides={'content_revision': lambda doc: 1})
# 本支自己控制的几处（与原手抄环境一致）：内容版本固定为 1、缓存/统计各自一份干净的、
# 锁用可重入的、写入禁用部件这份支不参与。
env.update({'content_revision': lambda doc: 1,
            '_PARSE_CACHE': OrderedDict(), '_PARSE_STATS': {}, '_PARSE_CACHE_MAX': 2,
            '_PARSE_LOCK': threading.RLock(), 'MAX_FILE_BYTES': 20 * 1024 * 1024,
            'MAX_ZIP_UNCOMPRESSED': 200 * 1024 * 1024, 'META_FIELD': 'sheet_meta_json',
            'WRITE_DENY_PARTS': ()})


def encode(book, rewrite=None):
    out = io.BytesIO(); book.save(out)
    if rewrite is None:
        return out.getvalue()
    rewritten = io.BytesIO()
    with zipfile.ZipFile(out) as src, zipfile.ZipFile(rewritten, 'w', zipfile.ZIP_DEFLATED) as dest:
        for info in src.infolist():
            data = src.read(info.filename)
            dest.writestr(info, rewrite(data) if info.filename == 'xl/worksheets/sheet1.xml' else data)
    return rewritten.getvalue()


class ColdReadTests(unittest.TestCase):
    def setUp(self):
        env['_PARSE_CACHE'].clear();env['_PARSE_STATS'].clear()

    def test_fast_read_reuses_one_sheet_xml_for_values_styles_widths_and_heights(self):
        from collections import Counter
        from unittest.mock import patch
        book=Workbook();ws=book.active;ws.append(['编号','费用']);ws.append(['00123',42.5])
        ws['B2'].font=Font(bold=True);ws.row_dimensions[2].height=31;ws.column_dimensions['B'].width=27
        content=encode(book);counts=Counter();original=zipfile.ZipFile.open
        def measured(archive,name,*args,**kwargs):
            counts[name.filename if isinstance(name,zipfile.ZipInfo) else name]+=1
            return original(archive,name,*args,**kwargs)
        with patch.object(zipfile.ZipFile,'open',measured):
            result=env['_entry_fast'](content,None)
        self.assertEqual(counts['xl/worksheets/sheet1.xml'],1,counts)
        self.assertEqual(result['manual_row_heights'],{'2':31.0})
        self.assertEqual(result['widths']['2'],27)
        self.assertTrue(result['font_styles'][result['style_ids'][(2,2)]]['bold'])

    def test_short_rows_match_full_parser_with_literal_formula_date_and_font(self):
        book = Workbook();ws = book.active;ws.append(['编号', '费用', '日期', '备注'])
        ws.append(['00123', 800, datetime.date(2026, 10, 15), '=SUM(B2)'])
        ws['D3']='=literal';ws['D3'].data_type='s';ws['A2'].font=Font(bold=True,color='112233')
        content=encode(book);timing={};stream=env['_entry_streaming'](content,None,timing)
        full=env['_entry_from_wb'](load_workbook(io.BytesIO(content)),None,content)
        for key in ('headers','rows_raw','column_types','style_ids','font_styles'):
            self.assertEqual(stream[key],full[key],key)
        self.assertEqual(stream['rows_raw'][0][0],'00123')
        self.assertIsInstance(stream['rows_raw'][1][3],env['_literal_text'])
        self.assertIn('iterate_rows_ms',timing)

    def test_55_columns_and_underdeclared_dimensions_keep_tail_values(self):
        book=Workbook();ws=book.active;ws.append(['列'+str(i) for i in range(55)])
        ws.cell(201,55,'tail')
        content=encode(book,lambda xml:re.sub(rb'<dimension[^>]*/>',b'<dimension ref="A1"/>',xml))
        entry=env['_entry_streaming'](content,None)
        self.assertEqual(len(entry['headers']),55);self.assertEqual(len(entry['rows_raw']),200)
        self.assertEqual(entry['rows_raw'][199][54],'tail')

    def test_styled_tail_row_and_far_style_do_not_expand_data_extent(self):
        book=Workbook();ws=book.active;ws.append(['编号']);ws.append(['00123'])
        ws.cell(1000,1).font=Font(bold=True);ws.cell(3,16384).font=Font(bold=True)
        content=encode(book);entry=env['_entry_streaming'](content,None)
        self.assertEqual(entry['headers'],['编号']);self.assertEqual(entry['rows_raw'],[('00123',)])
        self.assertIn((1000,1),entry['style_ids'])

    def test_conditional_format_objects_are_not_built_but_values_fonts_and_write_xml_survive(self):
        book=Workbook();ws=book.active;ws.append(['编号','费用']);ws.append(['00123',800]);ws.append(['00124',900])
        ws.conditional_formatting.add('B2:B3',CellIsRule(operator='greaterThan',formula=['850'],
            fill=PatternFill('solid',fgColor='FFFF0000')))
        ws.conditional_formatting.add('A2:A3',ColorScaleRule(start_type='min',start_color='00FF00',
            end_type='max',end_color='FF0000'))
        content=encode(book)
        full_book=load_workbook(io.BytesIO(content))
        full=env['_entry_from_wb'](full_book,None,content)
        # 原类不被全局替换；流式局部子类不调用原条件格式对象构建。
        from openpyxl.worksheet._reader import WorkSheetParser
        from unittest.mock import patch
        with patch.object(WorkSheetParser,'parse_formatting',side_effect=AssertionError('unused objects built')):
            stream=env['_entry_streaming'](content,None)
        self.assertEqual(stream,full)
        saved,changes,index=env['_style_surgery'](content,'xl/worksheets/sheet1.xml',['A2'],{'bold':True})
        with zipfile.ZipFile(io.BytesIO(content)) as original, zipfile.ZipFile(io.BytesIO(saved)) as updated:
            for name,pattern in [('xl/worksheets/sheet1.xml',rb'<conditionalFormatting\b.*?</conditionalFormatting>'),
                                 ('xl/styles.xml',rb'<dxfs\b.*?</dxfs>')]:
                self.assertEqual(re.findall(pattern,original.read(name),re.S),re.findall(pattern,updated.read(name),re.S))
        reopened=load_workbook(io.BytesIO(saved))
        self.assertEqual(len(reopened.active.conditional_formatting),2)
        self.assertTrue(reopened.active['A2'].font.bold)
        self.assertEqual(reopened.active['A2'].value,'00123')

    def test_true_wide_value_falls_back_without_losing_tail(self):
        # 夹具：**600 列都是不重复的非空表头**（真·宽表），第 600 列上带一个值。
        # 为什么补齐表头：2026-10-21 起三条读路径都过同一道表头闸
        # （`_assert_table_headers`：空白/重复表头明确拒绝，见 sheet.py `_entry_fast` 的合并说明），
        # 只写 1 个表头 + 599 个空表头的工作簿会被**表头闸**先拒掉 ⇒ 测不到「整簿回落」这一段。
        # 断言一个字没改，测的还是同一件事：极宽表 ⇒ 回落整簿路径 ⇒ 尾部值不丢。
        book=Workbook();ws=book.active
        for column in range(1,601):ws.cell(1,column,'列%d'%column)
        ws.cell(2,600,'wide-tail');content=encode(book)
        self.assertIsNone(env['_entry_streaming'](content,None))
        doc=types.SimpleNamespace(name='wide',sheet_meta_json='{}')
        entry,diag=env['_parsed'](doc,content)
        self.assertEqual(diag['parse_path'],'full-fallback');self.assertEqual(diag['fallback_reason'],'wide-sheet')
        self.assertEqual(entry['rows_raw'][0][599],'wide-tail')

    def test_stream_error_reports_class_and_preserves_full_fallback(self):
        book=Workbook();book.active.append(['编号']);book.active.append(['00123']);content=encode(book)
        original=env['_entry_streaming']
        try:
            def fail(*args, **kwargs):raise RuntimeError('private customer text')
            env['_entry_streaming']=fail
            entry,diag=env['_parsed'](types.SimpleNamespace(name='fallback',sheet_meta_json='{}'),content)
            self.assertEqual(diag['fallback_reason'],'RuntimeError');self.assertEqual(entry['rows_raw'][0][0],'00123')
            self.assertNotIn('private customer text',str(diag))
        finally:env['_entry_streaming']=original

if __name__ == '__main__':unittest.main()
