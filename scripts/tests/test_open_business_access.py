"""开放试用策略的执行测试；不连接客户站，不修改账号和角色。"""
import ast
import importlib.util
import json
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'frappe_apps/shangshu_core/shangshu_core'
FILES = ROOT / 'frappe_apps/shangshu_files/shangshu_files'

def throw(message, error=ValueError):
    raise error(message)

def funcs(path, names, ns):
    tree = ast.parse(path.read_text())
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), ns)
    return ns

class _EmptyBatchState:
    """`model_records` 的批量装配状态（ContextVar）—— **不进批**的桩。

    只在 AST 抽函数的夹具里用：生产代码自己建这个 ContextVar，夹具里没有 ⇒ 补一个
    「永远不进批、装配缓存恒为空」的实现（逐次装配 ⇒ 与这条判据原本的语义一致）。
    """

    def get(self):
        return None

    def set(self, value):
        raise AssertionError('这条判据不该进批量装配')

    def reset(self, token):
        raise AssertionError('这条判据不该进批量装配')

class OpenAccessTests(unittest.TestCase):
    def setUp(self):
        self.frappe = types.SimpleNamespace(session=types.SimpleNamespace(user='staff@test'),
            local=types.SimpleNamespace(), PermissionError=PermissionError, ValidationError=ValueError,
            throw=throw, get_roles=Mock(return_value=['Desk User']))
        self.identity = Mock(return_value=types.SimpleNamespace(enterprise_id='e1', identity_id='i1'))
        self.patch = patch.dict('sys.modules', {'frappe':self.frappe,
            'shangshu_core.identity':types.SimpleNamespace(get_identity=self.identity)})
        self.patch.start(); self.addCleanup(self.patch.stop)
        spec=importlib.util.spec_from_file_location('tested_business_access',CORE/'business_access.py')
        self.policy=importlib.util.module_from_spec(spec); spec.loader.exec_module(self.policy)

    def test_default_open_preserves_real_identity_and_roles(self):
        self.assertTrue(self.policy.is_open())
        self.assertEqual(self.frappe.session.user,'staff@test')
        self.assertEqual(self.frappe.get_roles(),['Desk User'])
        self.assertTrue(self.policy.same_enterprise('e1'))
        self.assertFalse(self.policy.same_enterprise('e2'))
        self.assertFalse(self.policy.same_enterprise(None))

    def test_guest_never_opens_even_with_explicit_other_user(self):
        self.frappe.session.user='Guest'
        self.assertFalse(self.policy.is_open())
        self.assertFalse(self.policy.is_open('staff@test'))
        with self.assertRaises(PermissionError): self.policy.require_identity()
        self.identity.assert_not_called()

    def test_disabled_identity_never_opens(self):
        self.identity.side_effect=PermissionError('disabled')
        self.assertFalse(self.policy.is_open())

    def test_cache_is_only_current_request_and_actor(self):
        self.assertTrue(self.policy.is_open()); self.assertTrue(self.policy.is_open())
        self.assertEqual(self.identity.call_count,1)
        self.frappe.local=types.SimpleNamespace()
        self.identity.side_effect=PermissionError('revoked')
        self.assertFalse(self.policy.is_open())

    def test_switch_off_restores_existing_role_gate(self):
        self.policy.OPEN_BUSINESS_ACCESS=False
        action=types.SimpleNamespace(action_id='files.cell_write',allowed_roles_json='["System Manager"]')
        ns=funcs(CORE/'actions.py',{'_assert_action_role'},
            {'frappe':self.frappe,'business_access':self.policy,'_json':lambda v,d:json.loads(v)})
        with self.assertRaises(PermissionError): ns['_assert_action_role'](action)

    def test_action_gate_opens_without_inventing_admin_role(self):
        action=types.SimpleNamespace(action_id='files.cell_write',allowed_roles_json='["System Manager"]')
        ns=funcs(CORE/'actions.py',{'_assert_action_role'},
            {'frappe':self.frappe,'business_access':self.policy,'_json':lambda v,d:json.loads(v)})
        self.assertEqual(ns['_assert_action_role'](action),{'Desk User'})
        self.frappe.session.user='Guest'
        with self.assertRaises(PermissionError): ns['_assert_action_role'](action)

    def test_system_identity_role_gate_remains_closed(self):
        action=types.SimpleNamespace(action_id='platform.identity.password',allowed_roles_json='["System Manager"]')
        ns=funcs(CORE/'actions.py',{'_assert_action_role'},
            {'frappe':self.frappe,'business_access':self.policy,'_json':lambda v,d:json.loads(v)})
        with self.assertRaises(PermissionError):ns['_assert_action_role'](action)
        self.assertTrue(self.policy.resource_is_open('files.sheet_cell_write'))
        self.assertFalse(self.policy.resource_is_open('mail.account.configure'))

    def test_field_projection_and_own_scope_follow_same_policy(self):
        fields=[{'id':'secret','deprecated':False,'access':{'read':{'scope':'none'}}},
                {'id':'old','deprecated':True}]
        ns=funcs(CORE/'model_records.py',{'_fields_for_op','_own'},
            {'frappe':self.frappe,'business_access':self.policy})
        compiled={'fields':fields,'access':{'record_scope':'own'}}
        for op in ['read','write','download']:
            self.assertEqual(ns['_fields_for_op'](compiled,{'Desk User'},op),fields[:1])
        self.assertFalse(ns['_own'](compiled,{'Desk User'}))
        self.policy.OPEN_BUSINESS_ACCESS=False
        self.assertTrue(ns['_own'](compiled,{'Desk User'}))

    def test_file_sql_filters_tenant_before_paging(self):
        import sqlite3
        db=sqlite3.connect(':memory:')
        db.executescript("""
        CREATE TABLE `tabShangshu File Center File` (name TEXT, owner TEXT);
        CREATE TABLE `tabShangshu Identity` (user TEXT, enterprise_id TEXT);
        CREATE TABLE `tabShangshu Org Attribution` (resource TEXT, level TEXT, owner_user TEXT, department TEXT);
        CREATE TABLE `tabShangshu Department` (name TEXT, enterprise_id TEXT);
        INSERT INTO `tabShangshu Identity` VALUES ('alice','e1'),('bob','e2');
        INSERT INTO `tabShangshu Department` VALUES ('d1','e1'),('d2','e2');
        INSERT INTO `tabShangshu File Center File` VALUES ('legacy1','alice'),('legacy2','bob'),
          ('personal1','bob'),('personal2','alice'),('dept1','missing-owner'),('dept2','alice'),
          ('bad-attribution','alice'),('unknown','unknown');
        INSERT INTO `tabShangshu Org Attribution` VALUES ('personal1','personal','alice',NULL),
          ('personal2','personal','bob',NULL),('dept1','department',NULL,'d1'),
          ('dept2','department',NULL,'d2'),('bad-attribution','department',NULL,'missing');
        """)
        self.frappe.db=types.SimpleNamespace(escape=lambda v:"'"+v.replace("'","''")+"'")
        condition=self.policy.file_query_condition('Shangshu File Center File')
        rows=db.execute('SELECT name FROM `tabShangshu File Center File` WHERE '+condition+' ORDER BY name').fetchall()
        self.assertEqual(rows,[('dept1',),('legacy1',),('personal1',)])
        self.frappe.session.user='Guest'
        self.assertEqual(self.policy.file_query_condition('Shangshu File Center File'),'1=0')
        with self.assertRaises(ValueError):self.policy.file_query_condition('User')

    def file_module(self):
        package=types.SimpleNamespace(business_access=self.policy)
        with patch.dict('sys.modules',{'shangshu_core.public_api':package}):
            spec=importlib.util.spec_from_file_location('tested_file_permissions',FILES/'business_permissions.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module

    def test_native_read_adapter_opens_read_only(self):
        module=self.file_module()
        self.policy.resource_decision=Mock(return_value=True)
        native=Mock()
        class Document:
            def check_permission(self,*args):return native(*args)
        class File(module.BusinessReadMixin,Document):
            doctype=module.FILE;name='f1';owner='other'
        doc=File();self.assertIsNone(doc.check_permission('read'))
        native.assert_not_called()
        doc.check_permission('write');native.assert_called_once_with('write',None)
        self.policy.resource_decision.return_value=False
        with self.assertRaises(PermissionError):doc.check_permission('read')
        self.frappe.session.user='Guest'
        with self.assertRaises(PermissionError):doc.check_permission('read')

    def test_native_list_adapter_keeps_pagination_and_tenant_scope(self):
        module=self.file_module();self.policy.file_query_condition=Mock(return_value='tenant_scope')
        class Query:
            def __init__(self,doctype):self.doctype=doctype
            def build_conditions(self):self.permission_conditions=[]
            def execute(self,**kwargs):
                self.build_conditions()
                return {'doctype':self.doctype,'kwargs':kwargs,'scope':self.permission_conditions}
        with patch.dict('sys.modules',{'frappe.model.db_query':types.SimpleNamespace(DatabaseQuery=Query)}):
            result=module.get_list(module.FILE,fields=['name'],start=50,page_length=25,filters={'status':'Active'})
            self.assertEqual(result['kwargs'],{'ignore_permissions':True,'fields':['name'],'start':50,'page_length':25,'filters':{'status':'Active'}})
            self.assertEqual(result['scope'],['(tenant_scope)'])
            with self.assertRaises(PermissionError):module.get_list('User')
            self.frappe.session.user='Guest'
            with self.assertRaises(PermissionError):module.get_list(module.FILE)

    def test_model_load_keeps_publish_and_tenant_guards(self):
        compiled={'kind':'record','fields':[],'access':{'read_roles':[],'write_roles':[]}}
        model=types.SimpleNamespace(application='app',enterprise_id='e1',active_revision=1,active_json=json.dumps(compiled))
        app=types.SimpleNamespace(status='Published',published_revision='rev')
        revision=types.SimpleNamespace(definition_json=json.dumps({'allowed_roles':['System Manager'],
            'bindings':[{'resource_id':'object','version':'1'}]}))
        self.frappe.get_doc=lambda dtype,name,**k:revision if dtype=='Shangshu Application Revision' else model
        # ⚠️ `model_records` 现在有一条**批量装配**的批状态（`_BATCH_STATE`，ContextVar）
        #   —— AST 只抽函数时它不在上下文里 ⇒ 补一个**空状态**的桩（不进批 ⇒ 逐次装配，
        #   与这条判据原本的语义一致）。
        ns=funcs(CORE/'model_records.py',{'_load'},{'frappe':self.frappe,'business_access':self.policy,
            'get_identity':self.identity,'MODEL':'model','require_application':lambda *a,**k:app,
            'check_references':lambda c:None,'_write_restriction':lambda o:None,'json':json,
            '_BATCH_STATE':_EmptyBatchState()})
        with patch.dict('sys.modules',{'shangshu_core.field_access':types.SimpleNamespace(assert_well_declared=lambda f:None)}):
            self.assertEqual(ns['_load']('object')[2],{'Desk User'})
            app.status='Draft'
            with self.assertRaises(PermissionError):ns['_load']('object')
            app.status='Published';model.enterprise_id='e2'
            with self.assertRaises(PermissionError):ns['_load']('object')
            model.enterprise_id='e1';ns['_write_restriction']=lambda o:'migration pending'
            with self.assertRaises(ValueError):ns['_load']('object',write=True)

    def test_directory_listing_does_not_require_employee_acl_picker(self):
        people=Mock(side_effect=AssertionError('开放试用非员工不应调用员工ACL候选'))
        self.frappe.db=types.SimpleNamespace(get_value=lambda *a:'Website User')
        ns=funcs(FILES/'directories.py',{'listing'},{'frappe':self.frappe,
            'business_access':self.policy,'DOCTYPE':'Shangshu File Directory',
            'business_get_list':lambda *a,**k:[]})
        with patch.dict('sys.modules',{
                'shangshu_core.public_api':types.SimpleNamespace(list_collaboration_people=people),
                'shangshu_files.access':types.SimpleNamespace(_values=lambda raw:json.loads(raw or '[]'))}):
            result=ns['listing'](None,{},None)
        self.assertTrue(result['can_manage'])
        self.assertEqual(result['access_options']['people'],[])
        people.assert_not_called()

if __name__=='__main__': unittest.main()
