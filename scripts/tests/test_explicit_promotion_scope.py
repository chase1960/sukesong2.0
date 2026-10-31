"""Bounded file-domain formal reads; executes real helpers without a live site."""
import ast, types, unittest
from pathlib import Path
from unittest.mock import Mock, patch
P=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_files/shangshu_files/promotion.py'

def load(names, ns):
 tree=ast.parse(P.read_text()); nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
 exec(compile(ast.Module(body=nodes,type_ignores=[]),str(P),'exec'),ns);return ns

def fail(message, error=ValueError):raise error(message)

class ExplicitPromotionScope(unittest.TestCase):
 def setUp(self):
  self.binding={'object_id':'o','records':{'r1':'n1','r2':'n2'},'revision':1}
  self.doc=types.SimpleNamespace(name='file')
  self.read=Mock(return_value={'values':{'r1':{'amount':4}},'versions':{'r1':'v1'}})
  self.ns=load({'_managed_state','_managed_values','_load_formal','formal_state','formal_state_for_rows','formal_state_full','declared_fields'},
   {'frappe':types.SimpleNamespace(throw=fail,ValidationError=ValueError),
    '_managed_binding':lambda doc:self.binding,'_require_pending_managed_row':Mock(side_effect=ValueError('unknown row')),
    'load_definition':lambda doc:{'columns':[{'promoted':True,'field':'amount'},{'promoted':True,'field':'note'}]},
    'promoted_columns':lambda d:d['columns'], '_managed_object_alive':lambda b:True})
  self.modules=patch.dict('sys.modules',{'shangshu_core.public_api':types.SimpleNamespace(read_promoted_values=self.read)})
  self.modules.start();self.addCleanup(self.modules.stop)
 def test_implicit_all_rows_rejected_before_core(self):
  with self.assertRaises((ValueError,TypeError)):self.ns['formal_state'](self.doc)
  self.read.assert_not_called()
 def test_missing_field_scope_rejected(self):
  with self.assertRaises((ValueError,TypeError)):self.ns['formal_state'](self.doc,row_ids=['r1'])
  self.read.assert_not_called()
 def test_one_row_one_field_reaches_core(self):
  out=self.ns['formal_state'](self.doc,row_ids=['r1'],fields=['amount'])
  self.assertEqual(out['values'],{'r1':{'amount':4}})
  self.assertEqual(self.read.call_args.kwargs['row_ids'],['r1'])
  self.assertEqual(self.read.call_args.kwargs['fields'],['amount'])
 def test_unknown_binding_never_falls_back_to_all(self):
  with self.assertRaises(ValueError):self.ns['formal_state_for_rows'](self.doc,['missing'],fields=['amount'])
  self.read.assert_not_called()
 def test_full_requires_engineering_purpose(self):
  with self.assertRaises((ValueError,TypeError)):self.ns['formal_state_full'](self.doc,purpose='interactive')
  self.read.assert_not_called()
 def test_explicit_migration_uses_declared_binding_scope(self):
  self.ns['formal_state_full'](self.doc,purpose='migration')
  self.assertEqual(self.read.call_args.kwargs['read_scope'],{'mode':'all','purpose':'migration'})
  self.assertNotIn('row_ids',self.read.call_args.kwargs)
  self.assertEqual(self.read.call_args.kwargs['fields'],['amount','note'])


class ExistingCompanionProjection(unittest.TestCase):
 def setUp(self):
  import copy
  self.path=P.with_name('object_projection.py')
  self.meta={'rows':['r1','r2'],'structure_version':1,'companion_source_versions':{'r1':'v1','r2':'v2'}}
  self.doc=types.SimpleNamespace(name='book')
  self.ctx={'meta':copy.deepcopy(self.meta),'entry':{'headers':['金额','备注'],'rows_raw':[(10,'keep'),(20,'other')]}}
  def typed(v):return {'type':'empty' if v is None else 'number' if type(v) in (int,float) else 'text','value':v}
  def plan(*a,**kw):
   cells=a[2]['cells']
   return {'meta':self.ctx['meta'],'cells':cells,'cells_out':[{'row_id':c['row_id'],'header':c['header'],
    'before':typed(self.ctx['entry']['rows_raw'][self.meta['rows'].index(c['row_id'])][self.ctx['entry']['headers'].index(c['header'])]),
    'after':c['value']} for c in cells]}
  self.plan=Mock(side_effect=plan)
  self.commit=Mock(return_value={'content_version':8,'applied':1})
  self.save=Mock()
  sheet=types.SimpleNamespace(_content=lambda *a,**kw:b'zip',_Seg=lambda:object(),
   _fast_ctx=lambda *a,**kw:self.ctx,_fast_plan_cells=self.plan,_commit_cell_plan=self.commit,
   _typed_equal=lambda a,b:a==b,value_typed=typed,content_revision=lambda d:7,_save_meta=self.save,_fault=lambda p:None)
  tree=ast.parse(self.path.read_text());self.ns={'sheet':sheet,'frappe':types.SimpleNamespace(throw=fail,ValidationError=ValueError)}
  exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_project_existing_values'],type_ignores=[]),str(self.path),'exec'),self.ns)
  self.binding={'field_columns':[{'field_id':'amount','header':'金额'}]}
 def run_projection(self, value=12, **kwargs):
  return self.ns['_project_existing_values'](self.doc,self.meta,self.binding,[{'name':'r1','modified':'v3','values':{'amount':value},**kwargs}],{'kind':'update'})
 def test_update_reuses_zip_plan_only_for_changed_cell(self):
  result=self.run_projection()
  self.assertEqual(self.plan.call_args.args[2]['cells'],[{'row_id':'r1','header':'金额','value':{'type':'number','value':12}}])
  self.assertTrue(self.commit.call_args.kwargs['projection_only'])
  self.assertEqual(self.ctx['meta']['companion_source_versions'],{'r1':'v3','r2':'v2'})
  self.assertEqual(self.ctx['entry']['rows_raw'][0][1],'keep')
  self.assertEqual(result['content_version'],8)
  self.assertEqual(result['row_ids'],['r1'])
  self.assertEqual(result['source_versions'],{'r1':'v3'})
 def test_version_only_does_not_write_xlsx(self):
  self.run_projection(value=10)
  self.plan.assert_not_called();self.commit.assert_not_called();self.save.assert_called_once()
 def test_unknown_record_or_missing_source_version_never_falls_back(self):
  for overrides in ({'name':'unknown'},{'modified':''},{'values':{}}):
   with self.subTest(overrides=overrides),self.assertRaises(ValueError):self.run_projection(**overrides)
  self.commit.assert_not_called()

class FormulaDependencies(unittest.TestCase):
 def setUp(self):
  import importlib.util
  from openpyxl import Workbook
  path=P.with_name('formulas.py')
  spec=importlib.util.spec_from_file_location('scope_formulas',path)
  self.formulas=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.formulas)
  self.wb=Workbook();self.ws=self.wb.active
  self.ws.append(['金额','备注','结果']);self.ws.append([10,'a',None]);self.ws.append([20,'b',None])
  self.read=Mock(return_value={})
  self.ns=load({'formula_formal_values'},{'load_definition':lambda d:{'columns':[{'header':'金额','field':'amount'}]},
    'promoted_columns':lambda d:d['columns'],'_load_formal':self.read})
  self.modules=patch.dict('sys.modules',{'shangshu_files':types.SimpleNamespace(formulas=self.formulas)})
  self.modules.start();self.addCleanup(self.modules.stop)
 def test_formula_reads_only_its_referenced_promoted_row_and_field(self):
  self.ws['C2']='=A3'
  self.ns['formula_formal_values'](None,self.ws,{'rows':['r1','r2']})
  self.read.assert_called_once_with(None,row_ids=['r2'],fields=['amount'])
 def test_existing_stable_binding_survives_display_coordinate_changes(self):
  self.ws['C2']='=A3'
  meta={'rows':['r1','r2'],'formula_results':{'r1\0结果':{'formula':'=A3','bindings':{'A3':{'row_id':'r1','header':'金额'}}}}}
  self.ns['formula_formal_values'](None,self.ws,meta)
  self.read.assert_called_once_with(None,row_ids=['r1'],fields=['amount'])
 def test_no_formula_uses_explicit_empty_scope(self):
  self.ns['formula_formal_values'](None,self.ws,{'rows':['r1','r2']})
  self.read.assert_called_once_with(None,row_ids=[],fields=[])


class CompanionReadScope(unittest.TestCase):
 def setUp(self):
  path=P.with_name('object_projection.py')
  self.meta={'formula_results':{
    'r1\0计算':{'dependencies':[{'row_id':'r2','header':'金额'}]},
    'r3\0计算':{'dependencies':[{'row_id':'r4','header':'金额'}]}}}
  self.binding={'field_columns':[{'field_id':'amount','header':'金额'}]}
  self.auth=Mock(side_effect=lambda file, rows, fields, operation: {'allowed_record_ids':rows,'readable_field_ids':fields})
  self.ns={'binding_for':lambda d:self.binding,'sheet':types.SimpleNamespace(_load_meta=lambda d:self.meta),
    'frappe':types.SimpleNamespace(throw=fail,ValidationError=ValueError)}
  tree=ast.parse(path.read_text());exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('read_access','hidden_headers')],type_ignores=[]),str(path),'exec'),self.ns)
  self.mods=patch.dict('sys.modules',{'shangshu_core.public_api':types.SimpleNamespace(authorize_companion_cells=self.auth)})
  self.mods.start();self.addCleanup(self.mods.stop);self.doc=types.SimpleNamespace(name='file')
 def test_selected_formula_authorizes_only_actual_dependencies(self):
  access=self.ns['read_access'](self.doc,['r1'])
  self.auth.assert_called_once_with('file',['r1','r2'],['amount'],operation='read')
  self.assertEqual(self.ns['hidden_headers'](self.doc,access),set())
 def test_denied_actual_dependency_hides_formula_but_unrelated_rows_do_not(self):
  access={'allowed_record_ids':['r1'],'readable_field_ids':['amount'],'scope_record_ids':['r1']}
  self.assertEqual(self.ns['hidden_headers'](self.doc,access),{'计算'})
 def test_unbounded_authorization_is_not_an_implicit_all_read(self):
  with self.assertRaises(ValueError):self.ns['read_access'](self.doc,None)
  self.auth.assert_not_called()

if __name__=='__main__':unittest.main()
