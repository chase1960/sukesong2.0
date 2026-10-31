"""Execute production read serialization/capability statements with adversarial values.
Real HTTP regression remains test_companion_download_live.py; this isolates red boundary.
"""
import ast,types,unittest
from pathlib import Path
P=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_files/shangshu_files/sheet.py'
fn=next(n for n in ast.parse(P.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='read_payload')
mask=next(n for n in ast.walk(fn) if isinstance(n,ast.For) and isinstance(n.target,ast.Name) and n.target.id=='header' and isinstance(n.iter,ast.Name) and n.iter.id=='hidden_headers')
guard=next(n for n in fn.body if isinstance(n,ast.If) and isinstance(n.test,ast.Name) and n.test.id=='_can_dl')
def run(node,env):exec(compile(ast.Module(body=[node],type_ignores=[]),str(P),'exec'),env)
class Denied(Exception):pass
class Invalid(Exception):pass
class Tests(unittest.TestCase):
 def test_hidden_scalar_cannot_survive_serialization_but_note_can(self):
  values={'Title':{'type':'text','value':'secret'},'Note':{'type':'text','value':'ordinary'}}
  run(mask,{'hidden_headers':{'Title'},'item':{'values':values}})
  self.assertEqual(values['Title'],{'type':'hidden','hidden':True,'value':None});self.assertEqual(values['Note']['value'],'ordinary')
 def test_hidden_formula_loses_expression_as_well_as_cached_value(self):
  values={'Title':{'type':'formula','formula':'=SECRET()','value':'secret','bindings':{'secret':'id'}}}
  run(mask,{'hidden_headers':{'Title'},'item':{'values':values}})
  self.assertNotIn('secret',repr(values));self.assertNotIn('formula',values['Title'])
 def test_capability_intersects_export_read_and_pending_rejection(self):
  for error in (Denied('source read'),Denied('source export'),Invalid('pending'),None):
   def gate(doc):
    if error:raise error
   env={'_can_dl':True,'doc':object(),'_read_promotion':types.SimpleNamespace(_require_all_columns_exportable=gate),'frappe':types.SimpleNamespace(PermissionError=Denied,ValidationError=Invalid)}
   run(guard,env);self.assertEqual(env['_can_dl'],error is None)
 def test_resource_export_denial_cannot_be_granted_by_fields(self):
  def gate(doc):raise AssertionError('must not query or grant denied resource')
  env={'_can_dl':False,'doc':object(),'_read_promotion':types.SimpleNamespace(_require_all_columns_exportable=gate)}
  run(guard,env);self.assertFalse(env['_can_dl'])
if __name__=='__main__':unittest.main()
