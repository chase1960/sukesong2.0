"""Receipt authorization keeps source-before-lease locks and rechecks the locked row."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

SOURCE=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_core/shangshu_core/reference_work.py'
class Denied(Exception): pass
class ReceiptLocks(unittest.TestCase):
 def run_case(self,change=None):
  events=[];values=dict(actor_user='worker',enterprise_id='enterprise',object_id='object',reference_name='record')
  def doc(dt,name,**kw):
   events.append(('lease',kw.get('for_update',False)))
   return SimpleNamespace(**(values|((change or {}) if kw.get('for_update') else {})))
  def reference(obj,name,**kw):events.append(('source',kw.get('lock')));self.assertEqual((obj,name),('object','record'))
  def throw(message,kind):raise kind(message)
  env=dict(get_identity=lambda:SimpleNamespace(enterprise_id='enterprise'),EXECUTION='Lease',_reference=reference,frappe=SimpleNamespace(get_doc=doc,session=SimpleNamespace(user='worker'),throw=throw,PermissionError=Denied))
  tree=ast.parse(SOURCE.read_text());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='authorize_execution_receipt')
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(SOURCE),'exec'),env)
  return lambda:env['authorize_execution_receipt']('lease-1'),events
 def test_source_lock_precedes_lease_lock(self):
  run,events=self.run_case();self.assertEqual(run().actor_user,'worker');self.assertEqual(events,[('lease',False),('source',True),('lease',True)])
 def test_locked_identity_and_reference_changes_reject(self):
  for key,value in [('actor_user','other'),('enterprise_id','other'),('object_id','other'),('reference_name','other')]:
   with self.subTest(key=key):
    run,events=self.run_case({key:value})
    with self.assertRaises(Denied):run()
    self.assertEqual(events,[('lease',False),('source',True),('lease',True)])
if __name__=='__main__':unittest.main()
