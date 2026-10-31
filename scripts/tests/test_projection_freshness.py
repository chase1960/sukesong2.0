"""Production writeback must reject superseded values/definitions before sheet I/O."""
import ast, copy, types, unittest
from pathlib import Path
from unittest.mock import patch
SOURCE=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_files/shangshu_files/promotion.py'
class Freshness(unittest.TestCase):
 def setUp(self):
  self.definition={'columns':[{'field':'amount','header':'金额'}]}
  self.row={'amount':222,'note':'newer unrelated value'}; self.calls=[]
  self.doc=types.SimpleNamespace(name='f',content_revision=9,version_count=1)
  def get_doc(dt,name,**kw):
   self.assertTrue(kw.get('for_update'));self.calls.append('lock');return self.doc
  def throw(message,error):raise error(message)
  self.sheet=types.SimpleNamespace(read_payload=lambda *a: {'content_version':9,'structure_version':2},write_cells=self.write)
  self.ns={'FILE':'File','frappe':types.SimpleNamespace(get_doc=get_doc,throw=throw,TimestampMismatchError=ValueError),'load_definition':lambda d:copy.deepcopy(self.definition),'_load_meta':lambda d:{'structure_version':2},'_load_formal':lambda d,row_ids=None,fields=None:{'r':copy.deepcopy(self.row)},'promoted_columns':lambda d:d['columns'],'_typed_for':lambda c,v:{'type':'number','value':v}}
  tree=ast.parse(SOURCE.read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_writeback')
  exec(compile(ast.Module(body=[fn],type_ignores=[]),str(SOURCE),'exec'),self.ns)
 def write(self,payload,context,**kw):
  self.calls.append(payload);self.assertTrue(kw['projection_only']);return {'cells':payload['cells'],'content_version':10,'structure_version':2}
 def run_write(self,values,definition=None):
  with patch.dict('sys.modules',{'shangshu_files':types.SimpleNamespace(sheet=self.sheet),'shangshu_files.working_file':types.SimpleNamespace(content_revision=lambda doc:doc.content_revision)}):
   return self.ns['_writeback'](self.doc,definition or copy.deepcopy(self.definition),'r',values)
 def test_old_value_rejected_without_sheet_io(self):
  with self.assertRaisesRegex(ValueError,'正式值'):self.run_write({'amount':111})
  self.assertEqual(self.calls,['lock']);self.assertEqual(self.row['amount'],222)
 def test_old_binding_rejected_even_if_value_matches(self):
  old=copy.deepcopy(self.definition);old['columns'][0]['header']='旧金额'
  with self.assertRaises(ValueError):self.run_write({'amount':222},old)
  self.assertEqual(self.calls,['lock'])
 def test_current_value_projects_using_current_file_revision(self):
  self.run_write({'amount':222});p=self.calls[-1]
  self.assertEqual(p['expected_content_version'],9);self.assertEqual(p['cells'][0]['value']['value'],222)
  self.assertEqual(self.row['note'],'newer unrelated value')
 def test_both_formal_writers_lock_before_reading_definition(self):
  tree=ast.parse(SOURCE.read_text())
  for name in ('formal_write','cell_write'):
   fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
   get=next(n for n in ast.walk(fn) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='get_doc')
   self.assertTrue(any(k.arg=='for_update' and isinstance(k.value,ast.Constant) and k.value.value is True for k in get.keywords))
class PendingFields(unittest.TestCase):
 def setUp(self):
  self.meta={};self.doc=object()
  self.ns={'PENDING_KEY':'writeback_pending','_load_meta':lambda d:copy.deepcopy(self.meta),'_save_meta':lambda d,m:self.meta.update(copy.deepcopy(m)),'frappe':types.SimpleNamespace(utils=types.SimpleNamespace(now=lambda:'now'))}
  tree=ast.parse(SOURCE.read_text());names={'mark_writeback_pending','clear_writeback_pending','writeback_pending'}
  exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),str(SOURCE),'exec'),self.ns)
 def test_success_on_other_field_keeps_failed_field_and_export_block(self):
  self.ns['mark_writeback_pending'](self.doc,'r',{'a':111},'failed')
  self.ns['clear_writeback_pending'](self.doc,'r',fields=['b'])
  self.assertEqual(self.ns['writeback_pending'](self.doc)['r']['values'],{'a':111})
 def test_two_failed_fields_recover_independently(self):
  self.ns['mark_writeback_pending'](self.doc,'r',{'a':111},'failed')
  self.ns['mark_writeback_pending'](self.doc,'r',{'b':222},'failed')
  self.ns['clear_writeback_pending'](self.doc,'r',fields=['a'])
  self.assertEqual(self.ns['writeback_pending'](self.doc)['r']['values'],{'b':222})
  self.ns['clear_writeback_pending'](self.doc,'r',fields=['b'])
  self.assertEqual(self.ns['writeback_pending'](self.doc),{})
if __name__=='__main__':unittest.main()
