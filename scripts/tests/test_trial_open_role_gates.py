"""试用开放口径下「角色档位不再阻断业务」的定向测试。

覆盖今晚（PKG-132）实测发现的真实阻断点：
· `shangshu_core.native_objects`：原生表读/写角色闸、可读字段集、导出/导入门；
· `shangshu_core.objects`：建模对象详情的 Frappe 角色读闸；
· `shangshu_core.application_pages`：已发布应用的角色档位闸；
· `shangshu_core.business_access.authorized_get_list`：清单读的 Frappe DocPerm 过滤。

口径：**只放开「谁可以用」这一层**；登录、平台身份、声明字段范围、数据规则、
版本、事务、审计一律照旧执行。关闭 `OPEN_BUSINESS_ACCESS` 必须恢复原角色判定。

不连接客户站、不写库、不改账号与角色。
"""
import ast
import importlib.util
import json
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'frappe_apps' / 'shangshu_core' / 'shangshu_core'


def throw(message, error=ValueError):
    raise error(message)


def funcs(path, names, ns):
    """按 AST 抽出指定顶层函数执行（避免 import 整个模块的副作用）。"""
    tree = ast.parse(path.read_text())
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), ns)
    return ns


class TrialOpenRoleGateTests(unittest.TestCase):
    def setUp(self):
        self.frappe = types.SimpleNamespace(
            session=types.SimpleNamespace(user='staff@test'),
            local=types.SimpleNamespace(),
            PermissionError=PermissionError, ValidationError=ValueError,
            throw=throw, get_roles=Mock(return_value=['Desk User']))
        self.identity = Mock(return_value=types.SimpleNamespace(enterprise_id='e1', identity_id='i1'))
        self.core = types.SimpleNamespace()
        self.patch = patch.dict('sys.modules', {
            'frappe': self.frappe,
            'shangshu_core': self.core,
            'shangshu_core.identity': types.SimpleNamespace(get_identity=self.identity),
        })
        self.patch.start()
        self.addCleanup(self.patch.stop)
        # ⚠️ 必须先装好假的 frappe/shangshu_core 再加载策略模块（模块级 import frappe）
        spec = importlib.util.spec_from_file_location('tested_business_access', CORE / 'business_access.py')
        self.policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.policy)
        self.core.business_access = self.policy

    # ---------- native_objects（原生表） ----------

    def native(self, names):
        ns = funcs(CORE / 'native_objects.py', names | {'_roles'},
                   {'frappe': self.frappe, 'business_access': self.policy})
        return ns

    def test_native_read_gate_opens_but_keeps_role_gate_when_switch_off(self):
        ns = self.native({'_gate_read'})
        block = {'read_roles': ['Warehouse Manager']}
        # 试用开放：普通已登录账号不再因角色档位被拒
        ns['_gate_read'](block)
        # 关闭开关 ⇒ 恢复原角色判定
        self.policy.OPEN_BUSINESS_ACCESS = False
        with self.assertRaises(PermissionError):
            ns['_gate_read'](block)

    def test_native_write_gate_opens_but_keeps_role_gate_when_switch_off(self):
        ns = self.native({'_writable'})
        block = {'write_roles': ['Sheet Structure Editor']}
        self.assertTrue(ns['_writable'](block))
        self.policy.OPEN_BUSINESS_ACCESS = False
        self.assertFalse(ns['_writable'](block))

    def test_native_export_gate_opens_but_keeps_admin_gate_when_switch_off(self):
        ns = self.native({'require_export_permission'})
        ns['require_export_permission']()
        self.policy.OPEN_BUSINESS_ACCESS = False
        with self.assertRaises(PermissionError):
            ns['require_export_permission']()

    def test_native_readable_fields_follow_declared_columns_when_open(self):
        ns = self.native({'_readable_fields'})
        permitted = {'a', 'b'}
        with patch.dict('sys.modules', {'frappe.model': types.SimpleNamespace(
                get_permitted_fields=lambda *a, **k: sorted(permitted))}):
            # 开放口径：可读字段＝对象自己声明的字段（不是 Frappe 角色可读集）
            self.assertEqual(ns['_readable_fields']('D', {'x', 'y', 'name'}), {'x', 'y', 'name'})
            # 关闭开关 ⇒ 回到 Frappe 的角色可读集
            self.policy.OPEN_BUSINESS_ACCESS = False
            self.assertEqual(ns['_readable_fields']('D', {'x', 'y', 'name'}), permitted)

    # ---------- business_access.authorized_get_list ----------

    def test_authorized_get_list_drops_role_filter_only_under_open_policy(self):
        class Query:
            def __init__(self, doctype):
                self.doctype = doctype

            def build_conditions(self):
                self.permission_conditions = []

            def execute(self, **kwargs):
                self.build_conditions()
                return {'doctype': self.doctype, 'kwargs': kwargs, 'scope': self.permission_conditions}

        with patch.dict('sys.modules', {'frappe.model.db_query': types.SimpleNamespace(DatabaseQuery=Query)}):
            result = self.policy.authorized_get_list('Doc', fields=['name'], limit_page_length=5)
            self.assertEqual(result['kwargs'], {'ignore_permissions': True, 'fields': ['name'],
                                               'limit_page_length': 5})
            self.assertEqual(result['scope'], ['(1=1)'])
            # 关闭开关 ⇒ 走 Frappe 原生 get_list（角色 DocPerm 照旧生效）
            self.policy.OPEN_BUSINESS_ACCESS = False
            self.frappe.get_list = Mock(return_value=[{'name': 'x'}])
            self.assertEqual(self.policy.authorized_get_list('Doc', fields=['name']),
                             [{'name': 'x'}])
            self.frappe.get_list.assert_called_once_with('Doc', fields=['name'])

    # ---------- objects（建模对象详情） ----------

    def test_object_detail_opens_role_gate_but_keeps_declared_fields(self):
        item = {'doctype': 'D', 'operations': ['read'], 'fields': [{'id': 'a'}, {'id': 'b'}]}

        class Doc:
            doctype = 'D'
            name = 'n1'
            modified = '2026-10-27 00:00:00'

            def __init__(self):
                self.checked = []

            def get(self, key, default=None):
                return {'a': 'va', 'b': 'vb'}.get(key, default)

            def check_permission(self, *a):
                self.checked.append(a)
                raise PermissionError('Frappe 角色读闸')

        doc = Doc()
        checked = doc.checked
        self.frappe.get_doc = Mock(return_value=doc)
        self.frappe.get_all = Mock(return_value=[])
        self.frappe.get_roles = Mock(return_value=['Desk User'])
        with patch.dict('sys.modules', {
                'shangshu_core.runtime': types.SimpleNamespace(get_instance_replay=lambda p: {'instance': {}}),
                'shangshu_core.actions': types.SimpleNamespace(list_registered_actions=lambda: []),
                'frappe.model': types.SimpleNamespace(get_permitted_fields=lambda *a, **k: ['a']),
        }):
            ns = funcs(CORE / 'objects.py', {'get_object_record'}, {
            'frappe': self.frappe, 'business_access': self.policy, 'json': json,
            'copy': __import__('copy'),
            'model_records': types.SimpleNamespace(is_managed=lambda _id: False),
            '_definition': lambda _id: ({'id': 'd1', 'name': 'D1'}, item),
            '_public': lambda item, domain: dict(item),
            '_native': lambda _id: False,
                'resource_execution': lambda *a, **k: (lambda f: f),
            })
            result = ns['get_object_record']('obj', 'n1')
            # 开放口径：不再调用 Frappe 的角色读闸
            self.assertEqual(checked, [])
            # 可读字段仍＝对象声明的字段，不放宽
            self.assertEqual([f['id'] for f in result['object']['fields']], ['a', 'b'])
        # 关闭开关 ⇒ 角色闸照旧执行
        self.policy.OPEN_BUSINESS_ACCESS = False
        with self.assertRaises(PermissionError):
            ns['get_object_record']('obj', 'n1')

    # ---------- application_pages（已发布应用的角色档位） ----------

    def test_published_application_role_gate_opens_but_state_guards_stay(self):
        app = types.SimpleNamespace(status='Published', published_revision='rev', name='app')
        revision = types.SimpleNamespace(revision_number=1, definition_json=json.dumps(
            {'allowed_roles': ['System Manager'], 'workflows': [{'id': 'flow-1'}],
             'bindings': [{'resource_id': 'o', 'version': '1'}]}))
        ns = funcs(CORE / 'application_pages.py', {'assert_launch'}, {
            'frappe': self.frappe, 'json': json,
            'business_access': self.policy,
            'get_identity': self.identity,
            'require_application': lambda *a, **k: app,
            'process_id': lambda *a: 'flow-1',
        })
        with patch.dict('sys.modules', {
                'shangshu_core.applications': types.SimpleNamespace(
                    _resolve_dependencies=lambda *a, **k: ({}, []),
                    _dependency_domains=lambda history: {}),
                'shangshu_core.domains': types.SimpleNamespace(list_domains=lambda **k: []),
        }):
            self.frappe.get_doc = Mock(return_value=revision)
            graph = {'application_ref': {'id': 'app', 'revision': 1}, 'definition_id': 'flow-1'}
            # 开放口径：角色档位不再阻断已发布应用
            ns['assert_launch'](graph)
            # 应用状态判据照旧执行（业务状态，不是权限）
            app.status = 'Draft'
            with self.assertRaises(PermissionError):
                ns['assert_launch'](graph)
            app.status = 'Published'
            # 关闭开关 ⇒ 角色闸恢复
            self.policy.OPEN_BUSINESS_ACCESS = False
            with self.assertRaises(PermissionError):
                ns['assert_launch'](graph)


if __name__ == '__main__':
    unittest.main()
