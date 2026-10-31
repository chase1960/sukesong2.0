"""ZIP structure patches preserve untouched bytes, values, styles and identities."""
import importlib.util
import unittest
from io import BytesIO
from pathlib import Path
from openpyxl import Workbook, load_workbook

PATH = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/zipedit.py'
spec = importlib.util.spec_from_file_location('structure_zipedit', PATH)
zipedit = importlib.util.module_from_spec(spec); spec.loader.exec_module(zipedit)
PART = 'xl/worksheets/sheet1.xml'


class StructureZip(unittest.TestCase):
    def source(self):
        book=Workbook();ws=book.active
        ws.append(['编号','金额','备注']);ws.append(['00123',42.5,'old']);ws.append(['00456',0,'other'])
        ws.row_dimensions[2].height=31;ws['B2'].number_format='#,##0.00'
        book.create_sheet('Other')['A1']='unchanged'
        buf=BytesIO();book.save(buf);return buf.getvalue()

    def test_visibility_only_touches_requested_row_attribute(self):
        source=self.source();xml=zipedit.read_sheet(source,PART)
        hidden=zipedit.set_rows_hidden(source,PART,{2:True},source_xml=xml)
        ws=load_workbook(BytesIO(hidden)).active
        self.assertTrue(ws.row_dimensions[2].hidden);self.assertEqual(ws.row_dimensions[2].height,31)
        self.assertEqual(ws['A2'].value,'00123');self.assertEqual(ws['B2'].number_format,'#,##0.00')
        self.assertEqual(zipedit.local_bytes(source)[b'xl/worksheets/sheet2.xml'],
                         zipedit.local_bytes(hidden)[b'xl/worksheets/sheet2.xml'])
        restored=zipedit.set_rows_hidden(hidden,PART,{2:False})
        self.assertFalse(load_workbook(BytesIO(restored)).active.row_dimensions[2].hidden)
        for number in (0,1,1048577):
            with self.assertRaises(zipedit.SurgeryError):zipedit.set_rows_hidden(source,PART,{number:True})

    def test_insert_column_preserves_values_styles_dimensions_and_other_sheets(self):
        book=load_workbook(BytesIO(self.source()));ws=book.active
        ws.column_dimensions['B'].width=27;ws.column_dimensions.group('B','C',hidden=True)
        ws.merge_cells('D2:E2');ws['D2']='merged'
        out=BytesIO();book.save(out);source=out.getvalue()
        saved=zipedit.insert_column(source,PART,2,'新增列')
        actual=load_workbook(BytesIO(saved)).active
        self.assertEqual([actual.cell(1,c).value for c in range(1,5)],['编号','新增列','金额','备注'])
        self.assertEqual(actual['C2'].value,42.5);self.assertEqual(actual['C2'].number_format,'#,##0.00')
        self.assertEqual(actual.column_dimensions['C'].width,27);self.assertTrue(actual.column_dimensions['C'].hidden)
        self.assertEqual(str(next(iter(actual.merged_cells.ranges))),'E2:F2')
        self.assertEqual(zipedit.local_bytes(source)[b'xl/worksheets/sheet2.xml'],
                         zipedit.local_bytes(saved)[b'xl/worksheets/sheet2.xml'])
        restored=zipedit.remove_column(saved,PART,2)
        actual=load_workbook(BytesIO(restored)).active
        self.assertEqual(actual['B2'].value,42.5);self.assertEqual(actual.column_dimensions['B'].width,27)
        self.assertEqual(str(next(iter(actual.merged_cells.ranges))),'D2:E2')
        with self.assertRaises(zipedit.SurgeryError):zipedit.insert_column(source,PART,5,'split')


if __name__=='__main__':unittest.main()
