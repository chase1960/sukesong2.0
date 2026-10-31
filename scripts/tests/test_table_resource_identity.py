"""旧表链接只按完整ID定位；权限错误不能被解释成换另一存储重试。"""
from contextlib import contextmanager
from types import SimpleNamespace
import unittest
import ast
from pathlib import Path
from unittest.mock import Mock, patch
from _f_module_seam import install_real_environment
install_real_environment('shangshu_core', 'shangshu_files')
from shangshu_core import table_resources, model_records, objects, domains, business_access
from shangshu_files import table_identity


def fail(message, error=ValueError): raise error(message)


class TableResourceIdentity(unittest.TestCase):
    def setUp(self):
        self.providers = {}
        fake = SimpleNamespace(throw=fail, ValidationError=ValueError,
            PermissionError=PermissionError, DoesNotExistError=LookupError,
            get_hooks=lambda name: list(self.providers), get_attr=lambda path: self.providers[path])
        for owner, key, value in (
            (table_resources, 'frappe', fake),
            (business_access, 'require_identity', Mock()),
            (model_records, 'is_managed', Mock(return_value=False)),
            (domains, 'raw_resource', Mock(return_value=(None, None))),
            (objects, 'get_object_definition', Mock(return_value={'id': 'T'})),
            (objects, 'list_object_definitions', Mock(side_effect=AssertionError('禁止读取全目录'))),
            (model_records, 'list_definitions', Mock(side_effect=AssertionError('禁止读取全部模型'))),
        ):
            scoped = patch.object(owner, key, value); scoped.start(); self.addCleanup(scoped.stop)

    def test_registered_database_resource_is_authorized_by_exact_id(self):
        domains.raw_resource.return_value = ({'id': 'domain'}, {'id': 'T'})
        result = table_resources.resolve_table_resource('T')
        self.assertEqual(result, {'table': 'T', 'source': 'db'})
        objects.get_object_definition.assert_called_once_with('T')
        domains.raw_resource.assert_called_once_with('objects', 'T')

    def test_managed_resource_does_not_scan_registry(self):
        model_records.is_managed.return_value = True
        self.assertEqual(table_resources.resolve_table_resource('T')['source'], 'db')
        domains.raw_resource.assert_not_called()

    def test_provider_exact_hit_and_missing_are_distinct(self):
        provider = Mock(side_effect=lambda key: {'table': key, 'source': 'xlsx'} if key == 'T' else None)
        self.providers['app.resolve'] = provider
        self.assertEqual(table_resources.resolve_table_resource('T'), {'table': 'T', 'source': 'xlsx'})
        with self.assertRaises(LookupError): table_resources.resolve_table_resource('missing')
        self.assertEqual([c.args for c in provider.call_args_list], [('T',), ('missing',)])

    def test_database_permission_failure_is_not_provider_fallback(self):
        model_records.is_managed.return_value = True
        objects.get_object_definition.side_effect = PermissionError('denied')
        provider = Mock(return_value={'table': 'T', 'source': 'xlsx'})
        self.providers['app.resolve'] = provider
        with self.assertRaisesRegex(PermissionError, 'denied'):
            table_resources.resolve_table_resource('T')
        provider.assert_not_called()

    def test_provider_permission_or_corruption_failure_propagates(self):
        second = Mock(return_value={'table': 'T', 'source': 'xlsx'})
        self.providers['app.second'] = second
        for error in (PermissionError('denied'), ValueError('broken'), RuntimeError('offline')):
            self.providers = {'app.first': Mock(side_effect=error), 'app.second': second}
            with self.subTest(error=error), self.assertRaises(type(error)):
                table_resources.resolve_table_resource('T')
        second.assert_not_called()

    def test_database_and_file_collision_is_explicit_ambiguity(self):
        model_records.is_managed.return_value = True
        self.providers['app.resolve'] = Mock(return_value={'table': 'T', 'source': 'xlsx'})
        with self.assertRaisesRegex(ValueError, '多种|歧义'):
            table_resources.resolve_table_resource('T')

    def test_wrong_provider_identity_and_invalid_input_never_redirect(self):
        self.providers['app.resolve'] = Mock(return_value={'table': 'other', 'source': 'xlsx'})
        with self.assertRaises(ValueError): table_resources.resolve_table_resource('T')
        for key in ('', ' T', None, ['T']):
            with self.subTest(key=key), self.assertRaises(ValueError):
                table_resources.resolve_table_resource(key)


class FileTableIdentity(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.doc = SimpleNamespace(name='T', file_name='费用.XLSX', status='Active',
                                   check_permission=Mock())
        self.fake = SimpleNamespace(db=SimpleNamespace(exists=Mock(return_value=True)),
            get_doc=Mock(return_value=self.doc), throw=fail, ValidationError=ValueError)
        self.scope = None
        @contextmanager
        def scope(domain):
            self.events.append(('enter', domain))
            try: yield
            finally: self.events.append(('exit', domain))
        self.scope = scope
        scoped = patch.object(table_identity, 'frappe', self.fake)
        scoped.start(); self.addCleanup(scoped.stop)
        public = SimpleNamespace(domain_execution=scope)
        scoped = patch.dict('sys.modules', {'shangshu_core.public_api': public})
        scoped.start(); self.addCleanup(scoped.stop)

    def test_hit_reads_one_file_inside_declared_boundary_and_no_values(self):
        self.assertEqual(table_identity.resolve_table_resource('T'), {'table': 'T', 'source': 'xlsx'})
        self.fake.db.exists.assert_called_once_with('Shangshu File Center File', 'T')
        self.fake.get_doc.assert_called_once_with('Shangshu File Center File', 'T')
        self.doc.check_permission.assert_called_once_with('read')
        self.assertEqual(self.events, [('enter', 'com.shangshu.files'), ('exit', 'com.shangshu.files')])

    def test_absence_does_not_load_a_document_or_enter_domain(self):
        self.fake.db.exists.return_value = False
        self.assertIsNone(table_identity.resolve_table_resource('T'))
        self.fake.get_doc.assert_not_called()
        self.assertEqual(self.events, [])

    def test_permission_recycle_and_wrong_type_are_not_xlsx_success(self):
        self.doc.check_permission.side_effect = PermissionError('no read')
        with self.assertRaises(PermissionError): table_identity.resolve_table_resource('T')
        self.doc.check_permission.side_effect = None
        self.doc.status = 'Recycled'
        with self.assertRaises(ValueError): table_identity.resolve_table_resource('T')
        self.doc.status, self.doc.file_name = 'Active', 'image.png'
        self.assertIsNone(table_identity.resolve_table_resource('T'))

    def test_file_provider_is_registered_in_installed_app_hooks(self):
        path = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/hooks.py'
        hook = next(node.value for node in ast.parse(path.read_text()).body if
                    isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and
                    t.id == 'shangshu_table_resource_resolvers' for t in node.targets))
        self.assertEqual(ast.literal_eval(hook), ['shangshu_files.table_identity.resolve_table_resource'])


if __name__ == '__main__': unittest.main()
