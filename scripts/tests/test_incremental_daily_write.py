"""Real XML surgery regressions; daily entry tests are added alongside the consolidation."""
import importlib.util
import re
import unittest
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[2]
FILES = ROOT / 'frappe_apps/shangshu_files/shangshu_files'
spec = importlib.util.spec_from_file_location('daily_zipedit', FILES / 'zipedit.py')
zipedit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zipedit)
PART = 'xl/worksheets/sheet1.xml'


class InsertRows(unittest.TestCase):
    def source(self):
        book = Workbook()
        book.active.append(['编号', '金额'])
        for index in range(5):
            book.active.append(['0012%d' % index, index + 0.25])
        book.active['B4'].number_format = '#,##0.00'
        out = BytesIO()
        book.save(out)
        return out.getvalue()

    def test_one_and_ten_rows_preserve_values_styles_and_unique_coordinates(self):
        source = self.source()
        for count in (1, 10):
            with self.subTest(count=count):
                saved = zipedit.insert_rows(source, PART, 4, count)
                sheet = load_workbook(BytesIO(saved)).active
                self.assertEqual(sheet['A3'].value, '00121')
                self.assertEqual(sheet.cell(4 + count, 1).value, '00122')
                self.assertEqual(sheet.cell(4 + count, 2).number_format, '#,##0.00')
                self.assertEqual(sheet.max_row, 6 + count)
                xml = zipedit.read_sheet(saved, PART)
                rows = re.findall(rb'<row\b[^>]*\br="(\d+)"', xml)
                self.assertEqual(len(rows), len(set(rows)))

    def test_insert_at_end_updates_dimension_and_single_cell_source(self):
        for source, position in ((self.source(),7),):
            saved=zipedit.insert_rows(source,PART,position,10)
            book=load_workbook(BytesIO(saved),read_only=True)
            self.assertEqual(book.active.max_row,position+9)
        book=Workbook();book.active['A1']='表头';out=BytesIO();book.save(out)
        saved=zipedit.insert_rows(out.getvalue(),PART,2,10)
        self.assertEqual(load_workbook(BytesIO(saved),read_only=True).active.max_row,11)

    def test_intact_merge_moves_but_split_merge_is_rejected(self):
        book=load_workbook(BytesIO(self.source()));book.active.merge_cells('A4:B5')
        out=BytesIO();book.save(out);source=out.getvalue()
        saved=zipedit.insert_rows(source,PART,3,10)
        self.assertEqual(str(next(iter(load_workbook(BytesIO(saved)).active.merged_cells.ranges))),'A14:B15')
        with self.assertRaises(zipedit.SurgeryError):zipedit.insert_rows(source,PART,5,1)



# The production public functions below are exercised with real XLSX bytes. Only
# the database/permission boundary is substituted; no ZIP, plan, validation or
# public entry point is replaced. Live transaction rollback remains a site test.
import copy
import json
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, load_module_functions
install_real_environment()


class DailyEntries(unittest.TestCase):
    def setUp(self):
        self.meta = {'rows': ['r-000001', 'r-000002'], 'primary_sheet': 'S-1',
                     'sheet_name': 'Sheet', 'ss_clean': True, 'structure_version': 1}
        self.doc = SimpleNamespace(name='table', status='Active', revision=1)
        book = Workbook(); ws = book.active
        ws.append(['编号', '金额', '备注', '日期', '确认'])
        ws.append(['00123', 800, 'old', None, False])
        ws.append(['00456', 900, 'other', None, True])
        ws['B2'].number_format = '#,##0.00'
        buf = BytesIO(); book.save(buf); self.content = buf.getvalue()
        self.saves = []; self.logs = []; self.formal = {'r-000001': {'amount': 800}, 'r-000002': {'amount': 900}}
        self.enabled = False; self.denied = False
        self.definition = {'columns': [{'header':'金额','field':'amount','promoted':True,'type':'number','rules':{'min':0}}]}
        def reject(message, kind=ValueError): raise kind(message)
        self.frappe = SimpleNamespace(throw=reject, ValidationError=ValueError,
            PermissionError=PermissionError, TimestampMismatchError=ValueError,
            session=SimpleNamespace(user='person'), db=SimpleNamespace(set_value=self.mark_undone),
            get_all=lambda *a, **kw:[self.record])
        self.h = load_module_functions(FILES/'sheet.py',
            {'write_cell','write_cells','paste_apply','input_write','undo_cells','row_insert','row_append','column_append','header_rename'},
            stubs={'frappe':self.frappe})
        self.h.update(_writable=lambda *_:self.doc,
            _content=lambda *a,**kw:self.content,
            _load_meta=lambda *_:copy.deepcopy(self.meta),
            _save_meta=lambda d,m:setattr(self,'meta',copy.deepcopy(m)),
            content_revision=lambda *_:self.doc.revision,
            _save_current=self.save, _record_op=self.record_op, _require_structure=lambda *_:None,
            _fault=lambda *_:None, _corrupt=lambda point,value:value,
            _parse_key_lock=lambda *_:__import__('threading').RLock(),
            safe_open=lambda *a,**kw:self.fail('daily path invoked safe_open'),
            _save_with_gates=lambda *a,**kw:self.fail('daily path serialized workbook'))
        self.index()
        promo=ModuleType('shangshu_files.promotion')
        promo.load_definition=lambda *_:self.definition if self.enabled else {'columns':[]}
        promo.column_by_header=lambda d,h:next((c for c in d['columns'] if c['header']==h),None)
        promo.require_package_rules_ok=lambda d,items,**kw:[self.rule(d,i['header'],i.get('value')) for i in items if i.get('check_rules',True)]
        promo.require_field_rules_ok=self.rule
        promo.require_fields_ok_for_targets=lambda d,ts,**kw:[self.rule(d,h,v) for h,v in ts]
        promo.require_fields_writable=lambda *a,**kw:self.rule(None,None,None)
        promo.plan_atomic_values=self.formal_plan
        promo.commit_atomic_values=self.formal_commit
        promo.declared_fields=lambda d:['amount']
        promo._load_formal=lambda d,row_ids=None,fields=None:{r:copy.deepcopy(v) for r,v in self.formal.items() if row_ids is None or r in row_ids}
        self.promo=promo
        projection=ModuleType('shangshu_files.object_projection')
        projection.authorize_ordinary_cells=lambda *a:None
        projection.binding_for=lambda *a:None
        projection.reject_bound_targets=lambda *a:None
        relations=ModuleType('shangshu_files.table_relations')
        relations.guard_cell_write=lambda *a:None
        relations.has_relations=lambda *a:False
        import shangshu_files
        self.patches=[patch.dict(sys.modules,{'shangshu_files.promotion':promo,'shangshu_files.object_projection':projection,'shangshu_files.table_relations':relations}),
                      patch.object(shangshu_files,'promotion',promo,create=True),
                      patch.object(shangshu_files,'object_projection',projection,create=True),
                      patch.object(shangshu_files,'table_relations',relations,create=True)]
        for item in self.patches:item.start();self.addCleanup(item.stop)

    def index(self):
        ws=load_workbook(BytesIO(self.content)).active
        entry={'headers':[c.value or '' for c in ws[1]],
               'rows_raw':[tuple(c.value for c in row) for row in list(ws.rows)[1:]],
               'column_types':[None]*ws.max_column, 'sheet_title':ws.title, 'readonly':None}
        self.h['_PARSE_CACHE'][self.h['_parse_cache_key'](self.doc,self.doc.revision)]=entry
    def save(self,doc,data,**kw):
        self.content=data;self.doc.revision+=1;self.saves.append(data);return self.doc.revision
    def record_op(self,doc,action,key,cells,version,context):
        item=SimpleNamespace(name='log'+str(len(self.logs)),action_id=action,op_id=key,
             cells_json=json.dumps(cells),actor_user='person',undone=0)
        self.logs.append(item);self.record=item
    def mark_undone(self,*args,**kw):self.record.undone=1
    def rule(self,doc,header,value,**kw):
        if self.denied:raise PermissionError('denied')
        if self.enabled and header=='金额' and value is not None and value<0:raise ValueError('min')
    def formal_plan(self,doc,meta,cells,*,row_ids=None):
        if not self.enabled:return None
        self.assertEqual(set(row_ids),{c['row_id'] for c in cells})
        result={r:copy.deepcopy(self.formal.get(r,{})) for r in row_ids}
        for item in cells:
            if item['header']!='金额':continue
            rid=item['row_id'];before=result[rid].get('amount')
            self.rule(doc,'金额',item['after']['value'])
            if before is not None and before!=item['before']['value']:raise ValueError('formal changed')
            item.update(formal_field='amount',formal_before_present=before is not None,formal_before=before,formal_after=item['after']['value'])
            result[rid]['amount']=item['after']['value']
        return result
    def formal_commit(self,doc,formal,*args,**kw):
        for rid,value in formal.items():self.formal[rid]=value
    def payload(self,**kw):
        return {'table':'table','op_id':'op'+str(len(self.logs)), 'expected_content_version':self.doc.revision,
                'expected_structure_version':self.meta['structure_version'],**kw}
    def sheet(self):return load_workbook(BytesIO(self.content)).active

    def test_plain_single_and_mixed_batch_only_zip(self):
        self.h['write_cell'](self.payload(row_id='r-000001',header='备注',value={'type':'text','value':'new'}))
        self.enabled=True
        result=self.h['write_cells'](self.payload(cells=[
            {'row_id':'r-000001','header':'金额','value':{'type':'number','value':810}},
            {'row_id':'r-000001','header':'备注','value':{'type':'text','value':'mixed'}}]))
        self.assertEqual((self.sheet()['B2'].value,self.formal['r-000001']['amount']),(810,810))
        self.assertEqual(self.sheet()['B2'].number_format,'#,##0.00')
        self.assertEqual(len(self.saves),2);self.assertEqual(result['applied'],2)
        self.assertEqual(self.sheet()['A2'].value,'00123')

    def test_mixed_range_paste_one_save_and_literal_false(self):
        self.enabled=True
        result=self.h['paste_apply'](self.payload(start_row=0,start_col=1,
            matrix=[[820,'pasted','2026-10-27','false']],matrix_types=[['number','text','date','boolean']]))
        self.assertEqual(len(self.saves),1)
        self.assertEqual(self.sheet()['E2'].value,False)
        self.assertEqual(str(self.sheet()['D2'].value)[:10],'2026-10-27')
        self.assertEqual(self.formal['r-000001']['amount'],820)
        self.assertEqual(result['rows_added'],0)

    def test_illegal_package_duplicate_precision_and_formula_are_zero_write(self):
        self.enabled=True
        for cells in ([{'row_id':'r-000001','header':'金额','value':{'type':'number','value':-1}}],
          [{'row_id':'r-000001','header':'金额','value':{'type':'number','value':10**16}}],
          [{'row_id':'r-000001','header':'金额','value':{'type':'formula','formula':'=1+1'}}],
          [{'row_id':'r-000001','header':'备注','value':{'type':'text','value':'x'}}]*2):
            with self.assertRaises(ValueError):self.h['write_cells'](self.payload(cells=cells))
            self.assertEqual(self.saves,[])
        self.assertEqual(self.formal['r-000001']['amount'],800)

    def test_append_then_edit_and_ten_row_insert_keep_ids(self):
        self.meta['promotion_binding']={'object_id':'o','records':{'r-000001':'n1','r-000002':'n2'}}
        result=self.h['row_append'](self.payload(count=1))
        rid=result['row_ids'][0]
        self.assertEqual(self.meta['promotion_pending_rows'][rid]['object_id'],'o')
        self.h['write_cell'](self.payload(row_id=rid,header='备注',value={'type':'text','value':'draft'}))
        before=list(self.meta['rows'])
        result=self.h['row_insert'](self.payload(before_row_id=before[1],count=10))
        self.assertEqual(self.meta['rows'],before[:1]+result['row_ids']+before[1:])
        self.assertEqual(self.sheet()['A13'].value,'00456')
        self.assertEqual(self.sheet()['C14'].value,'draft')

    def test_range_expansion_allocates_once_and_saves_once(self):
        result=self.h['paste_apply'](self.payload(start_row=2,start_col=2,matrix=[['new'],['later']]))
        self.assertEqual(result['rows_added'],2);self.assertEqual(len(self.saves),1)
        self.assertEqual(self.sheet()['C4'].value,'new');self.assertEqual(self.sheet()['C5'].value,'later')
        self.assertEqual(len(set(self.meta['rows'])),4)

    def test_mixed_undo_restores_values_and_rejects_conflicts(self):
        self.enabled=True
        written=self.h['write_cells'](self.payload(cells=[{'row_id':'r-000001','header':'金额','value':{'type':'number','value':820}},
            {'row_id':'r-000001','header':'备注','value':{'type':'text','value':'mixed'}}]))
        result=self.h['undo_cells'](self.payload(op_id=written['op_id']))
        self.assertEqual(self.sheet()['B2'].value,800);self.assertEqual(self.formal['r-000001']['amount'],800)
        self.assertEqual(self.sheet()['C2'].value,'old');self.assertEqual(result['cells'][0]['before']['value'],800)

    def test_no_change_no_save_or_version_and_failed_save_does_not_poison_old_cache(self):
        self.h['write_cell'](self.payload(row_id='r-000001',header='备注',value={'type':'text','value':'old'}))
        self.assertEqual(self.saves,[]);self.assertEqual(self.doc.revision,1)
        old=self.h['_PARSE_CACHE'][self.h['_parse_cache_key'](self.doc,1)]
        self.h['_save_current']=lambda *a,**kw:(_ for _ in ()).throw(RuntimeError('file fault'))
        with self.assertRaises(RuntimeError):self.h['write_cell'](self.payload(row_id='r-000001',header='备注',value={'type':'text','value':'oops'}))
        self.assertEqual(old['rows_raw'][0][2],'old');self.assertEqual(self.sheet()['C2'].value,'old')

    def test_cold_cache_uses_read_index_and_same_zip_entry(self):
        self.h['_PARSE_CACHE'].clear()
        result=self.h['write_cell'](self.payload(row_id='r-000001',header='备注',value={'type':'text','value':'cold'}))
        self.assertTrue(result['applied']);self.assertEqual(self.sheet()['C2'].value,'cold')
        self.assertEqual(len(self.saves),1)

    def test_target_xml_is_decompressed_once_before_edit_and_once_for_verification(self):
        import zipfile
        from collections import Counter
        counts=Counter();original=zipfile.ZipFile.read
        def measured(archive,name,*args,**kw):
            label=name.filename if isinstance(name,zipfile.ZipInfo) else name
            counts[label]+=1
            return original(archive,name,*args,**kw)
        with patch.object(zipfile.ZipFile,'read',measured):
            self.h['write_cell'](self.payload(row_id='r-000001',header='备注',value={'type':'text','value':'once'}))
        self.assertEqual(counts[PART],2,counts)
        self.assertEqual(len(self.saves),1)

    def test_formula_free_proof_survives_successful_value_edits_but_not_unknown_version(self):
        import zipfile
        from collections import Counter
        book=load_workbook(BytesIO(self.content))
        book.create_sheet('Other')['A1']='untouched'
        buf=BytesIO();book.save(buf);self.content=buf.getvalue();self.index()
        counts=Counter();original=zipfile.ZipFile.read
        def measured(archive,name,*args,**kw):
            label=name.filename if isinstance(name,zipfile.ZipInfo) else name
            counts[label]+=1
            return original(archive,name,*args,**kw)
        with patch.object(zipfile.ZipFile,'read',measured):
            for value in ('first','second'):
                self.h['write_cell'](self.payload(row_id='r-000001',header='备注',value={'type':'text','value':value}))
        self.assertEqual(counts[PART],4,counts)
        self.assertEqual(counts['xl/worksheets/sheet2.xml'],1,counts)
        # An external/new content version has no proof: a formula on another
        # worksheet must still reject the ordinary single-cell write.
        book=load_workbook(BytesIO(self.content));book['Other']['A1']='=1+1'
        buf=BytesIO();book.save(buf);self.content=buf.getvalue();self.doc.revision+=1;self.index()
        before=self.content
        with self.assertRaisesRegex(ValueError,'显式迁移'):
            self.h['write_cell'](self.payload(row_id='r-000001',header='备注',value={'type':'text','value':'third'}))
        self.assertEqual(self.content,before);self.assertEqual(len(self.saves),2)

    def test_small_numeric_change_and_same_day_time_change_are_not_discarded(self):
        self.h['write_cell'](self.payload(row_id='r-000001',header='金额',value={'type':'number','value':800.0000000001}))
        self.assertEqual(self.sheet()['B2'].value,800.0000000001)
        for value in ('2026-10-27T10:00:00','2026-10-27T11:00:00'):
            self.h['write_cell'](self.payload(row_id='r-000001',header='日期',value={'type':'date','value':value}))
        self.assertEqual(self.sheet()['D2'].value.hour,11)
        self.assertEqual(len(self.saves),3)

    def test_formula_workbook_refuses_without_replacing_original(self):
        book=load_workbook(BytesIO(self.content));book.active['C2']='=1+1'
        buf=BytesIO();book.save(buf);self.content=buf.getvalue();self.index();before=self.content
        with self.assertRaisesRegex(ValueError,'显式迁移'):
            self.h['write_cell'](self.payload(row_id='r-000001',header='备注',value={'type':'text','value':'new'}))
        self.assertEqual(self.content,before);self.assertEqual(self.saves,[])

if __name__ == '__main__':
    unittest.main()
