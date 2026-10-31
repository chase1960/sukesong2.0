"""Real OOXML comments and VML relationships must survive import cleaning."""
import ast
import datetime
import importlib.util
import re
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from openpyxl import load_workbook
from openpyxl.utils import column_index_from_string

ROOT = Path(__file__).resolve().parents[2]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

fixture = module('cleaning_fixture', 'shangshu-server/scripts/tests/test_import_cleaning_live.py')
zipedit = module('comment_zipedit', 'frappe_apps/shangshu_files/shangshu_files/zipedit.py')
tree = ast.parse((ROOT / 'frappe_apps/shangshu_files/shangshu_files/sheet.py').read_text())
names = {'_comments_from_xml', '_xml_unescape', '_fmt_remark_value', '_is_external_formula'}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names or isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'RE_EXT_REF' for t in n.targets)]
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'production-comment-functions', 'exec'))

class CommentRelationships(unittest.TestCase):
    def test_vml_name_cannot_replace_comment_payload(self):
        raw = fixture.workbook_bytes()
        comments = _comments_from_xml(raw)
        self.assertEqual(len(comments), 5)
        self.assertEqual(comments[('主表', 1, 1)], '表头便签')
        self.assertEqual(comments[('附表', 2, 1)], '附表便签')
        cleaned, report = zipedit.clean_workbook(raw, comments, _is_external_formula, _fmt_remark_value)
        wb = load_workbook(BytesIO(cleaned))
        self.assertEqual(wb['主表']['C2'].value, '已有备注；表头便签；首格便签；金额便签')
        self.assertEqual(wb['主表']['C3'].value, '第二行；下一行便签')
        self.assertEqual(wb['附表']['C2'].value, '附表便签')
        self.assertEqual(wb['主表']['B2'].value, 42.5)
        self.assertEqual(wb['主表']['B2'].number_format, '0.00')
        self.assertEqual(wb['主表']['A2'].value, '00123')
        self.assertTrue(wb['主表']['A2'].font.bold)
        self.assertFalse(any('comments' in n.lower() for n in zipfile.ZipFile(BytesIO(cleaned)).namelist()))
        self.assertEqual(load_workbook(BytesIO(raw))['主表']['A2'].comment.text, '首格便签')

    def test_comment_target_need_not_contain_word_comments(self):
        raw = fixture.workbook_bytes(); output = BytesIO()
        with zipfile.ZipFile(BytesIO(raw)) as src, zipfile.ZipFile(output, 'w') as dst:
            for item in src.infolist():
                data = src.read(item.filename)
                if item.filename.endswith('.rels'):
                    data = data.replace(b'/xl/comments/comment1.xml', b'/xl/notes/note1.xml')
                name = 'xl/notes/note1.xml' if item.filename == 'xl/comments/comment1.xml' else item.filename
                dst.writestr(name, data)
        self.assertEqual(_comments_from_xml(output.getvalue())[('主表', 2, 1)], '首格便签')

if __name__ == '__main__':
    unittest.main()
