"""Public expansion must preserve numeric/date-misformatted cells byte-for-byte."""
import copy
import unittest
import zipfile
from io import BytesIO
from openpyxl import Workbook
import test_incremental_daily_write as daily


class Expansion(unittest.TestCase):
    def setUp(self):
        self.case=daily.DailyEntries();self.case.setUp();self.addCleanup(self.case.doCleanups)
        book=Workbook();ws=book.active;ws.append(['编号','日期']);ws.append(['00123',123456789]);ws['B2'].number_format='yyyy-mm-dd'
        out=BytesIO();book.save(out);self.raw=out.getvalue();self.case.content=self.raw
        self.case.meta['rows']=['r-1']
        self.original_meta=copy.deepcopy(self.case.meta)
        self.case.h['_PARSE_CACHE'][self.case.h['_parse_cache_key'](self.case.doc,1)]={
            'headers':['编号','日期'],'rows_raw':[('00123',123456789)],'column_types':['text',None],
            'sheet_title':'Sheet','readonly':None}
        # Expansion response remains a separate read contract; this suite tests the write itself.
        self.case.h['read_payload']=lambda *a,**kw:{'table':'table'}
    def run_input(self, **updates):
        payload=self.case.payload(start_row=0,start_col=2,value={'type':'text','value':'新值'}) | updates
        return self.case.h['input_write'](payload)
    def test_new_column_preserves_raw_number_styles_and_other_parts(self):
        result=self.run_input();self.assertEqual(result['cols_added'],1)
        with zipfile.ZipFile(BytesIO(self.raw)) as old,zipfile.ZipFile(BytesIO(self.case.content)) as new:
            for name in old.namelist():
                if name!=daily.PART:self.assertEqual(old.read(name),new.read(name),name)
            for coord in ('A2','B2'):
                self.assertEqual(daily.zipedit.cell_node(old.read(daily.PART),coord),daily.zipedit.cell_node(new.read(daily.PART),coord))
            self.assertIn(b'A1:C2',new.read(daily.PART))
        self.assertEqual(self.original_meta['structure_version'],1);self.assertEqual(len(self.case.logs),1)
    def test_new_row_and_intermediate_rows_receive_unique_ids(self):
        result=self.run_input(start_row=3,start_col=0)
        self.assertEqual(result['rows_added'],3);self.assertEqual(len(set(self.case.meta['rows'])),4)
        self.assertIn(b'r="A5"',daily.zipedit.read_sheet(self.case.content,daily.PART))
    def test_structure_permission_failure_is_zero_write(self):
        self.case.h['_require_structure']=lambda *_:(_ for _ in ()).throw(ValueError('denied'))
        with self.assertRaises(ValueError):self.run_input()
        self.assertEqual(self.case.saves,[]);self.assertEqual(self.case.meta,self.original_meta)
    def test_invalid_number_and_type_conflict_never_save(self):
        with self.assertRaises(ValueError):self.run_input(value={'type':'number','value':float('nan')})
        with self.assertRaises(ValueError):self.run_input(start_col=0,value={'type':'number','value':1})
        self.assertEqual(self.case.saves,[]);self.assertEqual(self.case.content,self.raw)
    def test_post_save_failure_propagates_to_transaction_owner(self):
        def fault(point):
            if point=='post-save':raise RuntimeError('rollback')
        self.case.h['_fault']=fault
        with self.assertRaises(RuntimeError):self.run_input()

if __name__=='__main__':unittest.main()
