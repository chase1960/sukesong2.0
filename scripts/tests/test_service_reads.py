"""GET/POST read-service eligibility is declared by the registry; original dispatcher remains authoritative."""
import importlib.util, types, unittest
from pathlib import Path
from unittest.mock import Mock, patch
ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'frappe_apps/shangshu_core/shangshu_core/service_reads.py'
def fail(message,kind):raise kind(message)
class RegisteredReadService(unittest.TestCase):
 def setUp(self):
  self.resource=Mock(return_value=({'id':'domain'},{'id':'some.service','effect':'read'}))
  self.invoke=Mock(return_value={'items':[1]})
  self.patch=patch.dict('sys.modules',{'frappe':types.SimpleNamespace(throw=fail,ValidationError=ValueError,PermissionError=PermissionError,DoesNotExistError=LookupError),
   'shangshu_core.domains':types.SimpleNamespace(raw_resource=self.resource,invoke_domain_service=self.invoke)})
  self.patch.start();self.addCleanup(self.patch.stop)
  spec=importlib.util.spec_from_file_location('service_reads_under_test',SOURCE)
  self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
 def test_registered_read_uses_the_original_dispatcher_and_payload(self):
  payload={'row_ids':['r1'],'headers':['金额']}
  self.assertEqual(self.module.read_registered_service('some.service',payload),{'items':[1]})
  self.resource.assert_called_once_with('services','some.service')
  self.invoke.assert_called_once_with('some.service',payload)
 def test_client_read_flag_cannot_enable_write_or_undeclared_effect(self):
  for effect in ('write','external',None):
   self.resource.return_value=({'id':'domain'},{'effect':effect})
   with self.subTest(effect=effect),self.assertRaises((ValueError,PermissionError)):
    self.module.read_registered_service('some.service',{'effect':'read','readonly':True})
  self.invoke.assert_not_called()
 def test_unknown_service_is_not_guessed_or_reinterpreted(self):
  self.resource.return_value=(None,None)
  with self.assertRaises(LookupError):self.module.read_registered_service('missing')
  self.invoke.assert_not_called()
 def test_http_long_payload_still_rejects_write_service_before_dispatch(self):
  import ast,json
  path=ROOT/'frappe_apps/shangshu_core/shangshu_core/public_api/http.py'
  node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='service_read')
  ns={'frappe':types.SimpleNamespace(whitelist=lambda **kwargs:lambda fn:fn,parse_json=json.loads)}
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),ns)
  payload={'row_ids':['r%04d'%index for index in range(500)],'headers':['金额']}
  with patch.dict('sys.modules',{'shangshu_core.public_api':types.SimpleNamespace(read_registered_service=self.module.read_registered_service)}):
   self.assertEqual(ns['service_read']('some.service',json.dumps(payload)),{'items':[1]})
   self.invoke.assert_called_once_with('some.service',payload)
   self.invoke.reset_mock()
   self.resource.return_value=({'id':'domain'},{'effect':'write'})
   with self.assertRaises(PermissionError):ns['service_read']('some.service',json.dumps(payload))
   self.invoke.assert_not_called()
 def test_permission_schema_and_lifecycle_errors_are_not_retried_or_fallback(self):
  for error in (PermissionError('denied'),ValueError('schema'),LookupError('disabled')):
   self.invoke.reset_mock();self.invoke.side_effect=error
   with self.subTest(error=error),self.assertRaises(type(error)):
    self.module.read_registered_service('some.service',{})
   self.invoke.assert_called_once()

class ReadHttpAdapter(unittest.TestCase):
 def test_get_and_post_share_the_same_public_read_service(self):
  import ast,json
  path=ROOT/'frappe_apps/shangshu_core/shangshu_core/public_api/http.py'
  source=ast.parse(path.read_text());node=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='service_read')
  declared=[]
  def whitelist(**kwargs):
   declared.append(kwargs)
   return lambda function:function
  ns={'frappe':types.SimpleNamespace(whitelist=whitelist,parse_json=json.loads)}
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),ns)
  read=Mock(return_value={'rows':[]})
  with patch.dict('sys.modules',{'shangshu_core.public_api':types.SimpleNamespace(read_registered_service=read)}):
   self.assertEqual(ns['service_read']('example.rows','{"page":2}'),{'rows':[]})
  self.assertEqual(declared,[{'methods':['GET','POST']}])
  read.assert_called_once_with('example.rows',{'page':2})

if __name__=='__main__':unittest.main()
