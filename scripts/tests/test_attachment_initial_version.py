"""Exercise actual version writer with controlled persistence; no permission widening."""
import ast,json,sys,types,unittest
from pathlib import Path
from unittest.mock import patch
class Denied(Exception):pass
class Tests(unittest.TestCase):
 def setUp(self):
  self.exists=False;self.writes=[]
  self.doc=types.SimpleNamespace(name='new',owner='member',current_file=None,version_count=1,sheet_meta_json='{}',status='Active',save=lambda **kw:None)
  def throw(message,kind):raise kind(message)
  def get(data):
   self.writes.append(data);return types.SimpleNamespace(insert=lambda **kw:None)
  tree=ast.parse((Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_files/shangshu_files/service.py').read_text())
  ns={'json':json,'_can_write':lambda doc:False,'frappe':types.SimpleNamespace(session=types.SimpleNamespace(user='member'),db=types.SimpleNamespace(exists=lambda *a:self.exists),get_doc=get,throw=throw,PermissionError=Denied,ValidationError=Denied)}
  exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_record_version'],type_ignores=[]),'service.py','exec'),ns);self.write=ns['_record_version']
 def run_write(self,initial=True,source='source'):
  module=types.ModuleType('shangshu_files.working_file');module.content_revision=lambda d:0
  with patch.dict(sys.modules,{'shangshu_files.working_file':module}):return self.write(self.doc,types.SimpleNamespace(name='bound'),'digest',4,'',source,initial_creation=initial)
 def test_first_import_initializes_once_without_grant(self):
  self.assertEqual(self.run_write(),1)
  with self.assertRaises(Denied):self.run_write()
  self.assertEqual(len(self.writes),1)
 def test_no_internal_flag_cannot_override_acl(self):
  with self.assertRaises(Denied):self.run_write(False)
 def test_other_owner_rejected(self):
  self.doc.owner='other'
  with self.assertRaises(Denied):self.run_write()
 def test_existing_version_rejected_even_empty_pointer(self):
  self.exists=True
  with self.assertRaises(Denied):self.run_write()
 def test_source_required(self):
  with self.assertRaises(Denied):self.run_write(source=None)
 def test_recycled_rejected(self):
  self.doc.status='Recycled'
  with self.assertRaises(Denied):self.run_write()
if __name__=='__main__':unittest.main()
