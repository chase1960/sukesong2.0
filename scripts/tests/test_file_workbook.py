"""文件工作簿纯编码逻辑回归；不连接用户站点、不创建业务记录。"""
import copy
import importlib.util
from io import BytesIO
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('file_workbook', ROOT / 'frappe_apps/shangshu_files/shangshu_files/workbook.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(body='<c r="A1" t="inlineStr"><is><t>客户</t></is></c><c r="B1"><v>150</v></c>', extra=''):
    # 小型 OOXML 测试夹具，仅在内存中；不是业务工作簿生成器。
    out = BytesIO()
    with ZipFile(out, 'w', ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="采购" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">'+body+'</row></sheetData>'+extra+'</worksheet>')
    return out.getvalue()


class WorkbookTests(unittest.TestCase):
    def test_new_workbook_roundtrip_keeps_types_and_multiple_sheets(self):
        draft = module.blank()
        draft['sheets'][0]['cells'][0][:3] = [{'t':'s','v':'00123'}, {'t':'n','v':150}, {'t':'s','v':'=1+1'}]
        second = copy.deepcopy(draft['sheets'][0]); second.update(key='new2', title='交付')
        draft['sheets'].append(second)
        data = module.encode(draft)
        parsed = module.decode(data)
        self.assertTrue(parsed['editable'])
        self.assertEqual([s['title'] for s in parsed['sheets']], ['工作表1','交付'])
        self.assertEqual(parsed['sheets'][0]['cells'][0][:3], draft['sheets'][0]['cells'][0][:3])

    def test_existing_values_and_insert_delete_do_not_become_business_fields(self):
        source = fixture(); draft = module.decode(source)
        sheet = draft['sheets'][0]
        sheet['cells'].insert(0, [None]*sheet['columns']); sheet['rows'] += 1
        for row in sheet['cells']: row.insert(1, None)
        sheet['columns'] += 1
        ops = [{'kind':'insert_row','key':'s0','index':1}, {'kind':'insert_column','key':'s0','index':2}]
        parsed = module.decode(module.encode(draft, source, ops))
        self.assertEqual(parsed['sheets'][0]['cells'][1][0], {'t':'s','v':'客户'})
        self.assertEqual(parsed['sheets'][0]['cells'][1][2], {'t':'n','v':150})

    def test_advanced_formula_and_merge_read_only_cannot_be_encoded_as_original(self):
        for source in [fixture('<c r="A1"><f>1+1</f><v>2</v></c>'), fixture(extra='<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>')]:
            draft = module.decode(source)
            self.assertFalse(draft['editable'])
            with self.assertRaises(ValueError): module.encode(draft, source)

    def test_duplicate_names_invalid_types_and_infinite_values_rejected(self):
        for mutate in [lambda d: d['sheets'].append(copy.deepcopy(d['sheets'][0])),
                       lambda d: d['sheets'][0]['cells'][0].__setitem__(0, {'t':'n','v':float('inf')}),
                       lambda d: d['sheets'][0]['cells'][0].__setitem__(0, {'t':'f','v':'=1+1'})]:
            draft=module.blank(); mutate(draft)
            with self.assertRaises(ValueError): module.encode(draft)

    def test_missing_original_sheet_or_unlogged_structure_rejected(self):
        source=fixture(); draft=module.decode(source)
        draft['sheets'][0]['key']='other'
        with self.assertRaises(ValueError): module.encode(draft, source)
        draft=module.decode(source); draft['sheets'][0]['title']='偷偷改名'
        with self.assertRaises(ValueError): module.encode(draft, source)

    def test_archive_xml_entities_outside_coordinates_and_zip_bomb_rejected(self):
        for source in [fixture('<c r="XFD1048576"><v>1</v></c>'), b'not zip']:
            with self.assertRaises(ValueError): module.decode(source)
        out=BytesIO()
        with ZipFile(out,'w') as z:
            z.writestr('xl/workbook.xml','<!DOCTYPE x [<!ENTITY x "bad">]><x>&x;</x>')
        with self.assertRaises(ValueError): module.decode(out.getvalue())

    def test_csv_quotes_newlines_and_leading_zero_preserved(self):
        draft=module.read_csv('编号,说明\r\n00123,"含,逗号\n第二行"\r\n'.encode())
        self.assertEqual(draft['sheets'][0]['cells'][1][0], {'t':'s','v':'00123'})
        self.assertEqual(draft['sheets'][0]['cells'][1][1]['v'], '含,逗号\n第二行')
        self.assertEqual(module.decode(module.encode(draft))['sheets'][0]['cells'][1][0]['v'], '00123')

    def test_registered_service_checks_original_permissions_before_reading(self):
        frappe=types.ModuleType('frappe');frappe.get_doc=Mock();frappe.ValidationError=ValueError
        api=types.ModuleType('shangshu_core.public_api');api.get_record_attachments=Mock(side_effect=PermissionError('无权'))
        domain=types.ModuleType('shangshu_files.domain');domain.versions=Mock(return_value={'file':{'file_name':'采购.xlsx'},'versions':[{'version_no':1,'frappe_file':'fixed1'}]})
        with patch.dict(sys.modules,{'frappe':frappe,'shangshu_core.public_api':api,'shangshu_files.domain':domain}):
            with self.assertRaises(PermissionError):module.invoke('files.workbook',{'operation':'open','file':'f1','version':1},{'user_name':'staff'})
            frappe.get_doc.assert_not_called();domain.versions.assert_called_once_with('files.versions',{'file':'f1'},{'user_name':'staff'})
            api.get_record_attachments.side_effect=None;frappe.get_doc.return_value.get_content.return_value=fixture()
            self.assertTrue(module.invoke('files.workbook',{'operation':'open','file':'f1','version':1},{})['editable'])

    def test_unknown_parts_and_grouped_columns_are_read_only_not_silently_dropped(self):
        source=fixture(extra='<cols><col min="1" max="3" width="22" customWidth="1"/></cols>')
        self.assertFalse(module.decode(source)['editable'])
        out=BytesIO()
        with ZipFile(BytesIO(fixture())) as z, ZipFile(out,'w') as target:
            for item in z.infolist():target.writestr(item,z.read(item))
            target.writestr('xl/special-feature.xml','<feature/>')
        self.assertFalse(module.decode(out.getvalue())['editable'])

    def test_simple_styles_and_column_width_survive_value_and_structure_edit(self):
        from openpyxl import load_workbook
        from openpyxl.styles import Font, PatternFill
        source=fixture();book=load_workbook(BytesIO(source));book.active['B1'].font=Font(bold=True,color='008000');book.active['B1'].fill=PatternFill('solid',fgColor='EEEEEE');book.active['B1'].number_format='0.00';book.active.column_dimensions['B'].width=22;book.active.freeze_panes='B2';out=BytesIO();book.save(out);source=out.getvalue()
        draft=module.decode(source);draft['sheets'][0]['cells'].insert(0,[None]*draft['sheets'][0]['columns']);draft['sheets'][0]['rows']+=1;draft['sheets'][0]['cells'][1][1]['v']=180
        encoded=module.encode(draft,source,[{'kind':'insert_row','key':'s0','index':1}]);saved=load_workbook(BytesIO(encoded))
        self.assertEqual(saved.active['B2'].value,180);self.assertTrue(saved.active['B2'].font.bold);self.assertEqual(saved.active['B2'].number_format,'0.00');self.assertEqual(saved.active.column_dimensions['B'].width,22);self.assertEqual(saved.active.freeze_panes,'B3')


if __name__ == '__main__': unittest.main()
