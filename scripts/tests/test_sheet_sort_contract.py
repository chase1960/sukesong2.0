"""Sort action regression: current revision, stable IDs, field ACL and dispatch."""
import ast
from pathlib import Path
from types import SimpleNamespace, ModuleType
from unittest.mock import patch
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
FILES = ROOT / 'frappe_apps/shangshu_files/shangshu_files'
class Rejected(Exception): pass

def function(path, name, context):
    nodes = [n for n in ast.parse(path.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == name]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), context)
    return context[name]

class SortContract(unittest.TestCase):
    def setUp(self):
        self.hidden = set()
        self.doc = SimpleNamespace(status='Active', version_count=1, check_permission=lambda _: None)
        self.entry = dict(headers=['amount','private'], rows_raw=[[20,'secret-a'],[10,'secret-b'],[None,'secret-c']], sheet_title='Sheet1')
        self.meta = dict(rows=['stable-a','stable-b','stable-c'], structure_version=2)
        def reject(message, *_): raise Rejected(message)
        frappe = SimpleNamespace(get_doc=lambda *_:self.doc,throw=reject,ValidationError=Rejected,PermissionError=Rejected)
        context = dict(frappe=frappe,DOCTYPE='File',_content=lambda _:b'x',_parsed=lambda *_:(self.entry,{}),
            _ensure_meta_rows=lambda *a,**kw:self.meta,content_revision=lambda _:7,
            _Seg=lambda:SimpleNamespace(mark=lambda _:None,out=lambda:{}),
            value_typed=lambda v:dict(type='empty' if v is None else 'number' if isinstance(v,int) else 'text',value=v))
        self.sort = function(FILES/'sheet.py','sheet_sort',context)
        self.package = ModuleType('shangshu_files')
        self.package.promotion = SimpleNamespace(unreadable_headers=lambda _:self.hidden)
        self.modules = patch.dict(sys.modules,{'shangshu_files':self.package,'shangshu_files.object_projection':SimpleNamespace(read_access=lambda *a:None),'shangshu_files.sheet_structure':SimpleNamespace(ACTIONS=set(),execute=lambda *a: (_ for _ in ()).throw(AssertionError('sort must not dispatch as structure'))) })
        self.modules.start();self.addCleanup(self.modules.stop)
        self.payload=dict(table='one',column='amount',direction='asc',expected_content_version=7,expected_structure_version=2)
    def test_companion_row_scope_applies_before_sort_output(self):
        sys.modules['shangshu_files.object_projection'].read_access=lambda *args:{'allowed_record_ids':['stable-b']}
        rows=self.sort(self.payload)['rows']
        self.assertEqual([r['row_id'] for r in rows],['stable-b'])
    def test_current_revision_and_stable_order(self):
        r=self.sort(self.payload)
        self.assertEqual([x['row_id'] for x in r['rows']],['stable-b','stable-a','stable-c'])
        self.assertEqual(r['content_version'],7)
        self.assertEqual(self.meta['rows'],['stable-a','stable-b','stable-c'])
    def test_identity_only_preserves_order_without_values(self):
        rows=self.sort(dict(self.payload,identity_only=True))['rows']
        self.assertEqual([x['row_id'] for x in rows],['stable-b','stable-a','stable-c'])
        self.assertTrue(all(set(row)=={'row_id','row_index'} for row in rows))
    def test_desc_empty_last(self):
        self.assertEqual([x['row_id'] for x in self.sort(dict(self.payload,direction='desc'))['rows']],['stable-a','stable-b','stable-c'])
    def test_stale_version_rejected(self):
        for field in ['expected_content_version','expected_structure_version']:
            with self.assertRaises(Rejected):self.sort(dict(self.payload,**{field:0}))
    def test_hidden_sort_rejected_and_hidden_values_omitted(self):
        self.hidden.add('private')
        with self.assertRaises(Rejected):self.sort(dict(self.payload,column='private'))
        for row in self.sort(self.payload)['rows']:self.assertNotIn('private',row['values'])
    def test_recycled_rejected(self):
        self.doc.status='Recycled'
        with self.assertRaises(Rejected):self.sort(self.payload)
    def test_action_dispatch_calls_actual_signature(self):
        source=ast.parse((FILES/'service.py').read_text())
        mapping=next(ast.literal_eval(n.value) for n in source.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SHEET_ACTIONS' for t in n.targets))
        self.package.sheet=SimpleNamespace(sheet_sort=self.sort)
        ctx=dict(SHEET_ACTIONS=mapping,directories=SimpleNamespace(lock_tree=lambda **_:None),_guard_user_batch_no_field=lambda *_:None,
            frappe=SimpleNamespace(UniqueValidationError=type('Unique',(Exception,),{})))
        execute=function(FILES/'service.py','execute',ctx)
        self.assertEqual(execute('files.sheet_sort',self.payload,{})['total_rows'],3)
if __name__=='__main__':unittest.main()
