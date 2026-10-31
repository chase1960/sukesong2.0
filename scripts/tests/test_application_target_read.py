"""按 ID 打开应用只装配目标；开放资格不绕过发布、企业和依赖校验。"""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from _f_module_seam import install_real_environment

install_real_environment('shangshu_core')
from shangshu_core import applications, business_access, domains


def fail(message, error=ValueError):
    raise error(message)


def domain_row(enabled=1, applications_value=None):
    contribution = {'id': 'com.shangshu.finance', 'applications': applications_value or [
        {'id': 'com.shangshu.finance.expense_management', 'title': '费用管理'}]}
    return SimpleNamespace(domain_id=contribution['id'], display_name='财务',
        owner_app='shangshu_finance', domain_version='1.0.0', enabled=enabled,
        execution_stopped=0, health_status='healthy', health_message='',
        disabled_at=None, disabled_by=None, disabled_reason='',
        contribution_json=json.dumps(contribution))


class ApplicationTargetRead(unittest.TestCase):
    def setUp(self):
        self.frappe = SimpleNamespace(get_roles=Mock(return_value=['Desk User']),
            throw=fail, ValidationError=ValueError, PermissionError=PermissionError,
            DoesNotExistError=LookupError, DuplicateEntryError=ValueError,
            db=SimpleNamespace(sql=Mock(return_value=[])),
            get_all=Mock(return_value=[]), get_doc=Mock(),
            has_permission=Mock(return_value=False))
        for module in (domains, applications):
            p = patch.object(module, 'frappe', self.frappe)
            p.start()
            self.addCleanup(p.stop)

    def test_code_application_never_expands_all_domains(self):
        self.frappe.db.sql.return_value = [domain_row()]
        with patch.object(domains, 'list_domains', side_effect=AssertionError('全域展开')), \
                patch.object(domains, '_dataset_doctypes', return_value={}), \
                patch.object(domains, '_visible_to_roles', return_value=True):
            result = domains.get_application('com.shangshu.finance.expense_management')
        self.assertEqual(result['title'], '费用管理')
        query, values = self.frappe.db.sql.call_args.args
        self.assertIn('LIMIT 2', query)
        self.assertEqual(json.loads(values['application_id_json']), result['id'])
        self.assertNotIn(result['id'], query)

    def test_duplicate_registered_application_is_not_first_match_wins(self):
        self.frappe.db.sql.return_value = [domain_row(), domain_row()]
        with self.assertRaisesRegex(ValueError, '重复'):
            domains._domain_application_by_id('com.shangshu.finance.expense_management')

    def test_disabled_code_application_stays_unavailable(self):
        self.frappe.db.sql.return_value = [domain_row(enabled=0)]
        self.assertIsNone(domains._domain_application_by_id('com.shangshu.finance.expense_management'))

    def test_unavailable_target_never_substitutes_other_application(self):
        with patch.object(domains, 'list_domains', side_effect=AssertionError('全域展开')), \
                patch.object(applications, 'published_application_catalog', return_value=[]) as published:
            with self.assertRaises(LookupError):
                domains.get_application('missing.exact.id')
        published.assert_called_once_with(include_resources=False, application_id='missing.exact.id')

    def test_empty_id_does_not_become_catalog_read(self):
        with self.assertRaisesRegex(ValueError, '不能为空'):
            domains.get_application('')
        self.frappe.db.sql.assert_not_called()

    def test_domain_subset_query_empty_does_not_read_catalog(self):
        self.assertEqual(domains.list_domains(domain_ids=[]), [])
        self.frappe.get_all.assert_not_called()

    def test_domain_subset_query_has_database_filter(self):
        domains.list_domains(include_disabled=True, domain_ids=['com.shangshu.finance'])
        self.assertEqual(self.frappe.get_all.call_args.kwargs['filters'],
                         {'domain_id': ['in', ['com.shangshu.finance']]})

    def setup_managed(self):
        app_id = 'com.shangshu.app.current'
        spec = {'title': '当前应用', 'description': '', 'allowed_roles': ['Finance Manager'], 'bindings': []}
        history = SimpleNamespace(application=app_id, revision_number=1,
            definition_json=json.dumps(spec), dependencies_json='[]')
        self.frappe.get_all.return_value = [SimpleNamespace(name=app_id, published_revision='r1')]
        self.frappe.get_doc.return_value = history
        return app_id, history

    def test_open_managed_application_uses_only_its_dependencies(self):
        app_id, history = self.setup_managed()
        history.dependencies_json = json.dumps([{'owner_domain': 'com.shangshu.finance'}, {'owner_domain': app_id}])
        resources = {kind: [] for kind in applications.KINDS}
        with patch.object(applications, 'get_identity', return_value=SimpleNamespace(enterprise_id='enterprise-current')), \
                patch.object(applications, 'list_domains', return_value=[]) as listing, \
                patch.object(applications, '_resolve_dependencies', return_value=(resources, [])), \
                patch.object(business_access, 'resource_is_open', return_value=True):
            result = applications.published_application_catalog(application_id=app_id)
        self.assertEqual(len(result), 1, '开放资格不能被旧角色清单挡住')
        self.assertEqual(listing.call_args.kwargs['domain_ids'], ['com.shangshu.finance'])
        self.assertEqual(self.frappe.get_all.call_args.kwargs['filters'], {
            'enterprise_id': 'enterprise-current', 'status': 'Published', 'name': app_id})

    def test_closed_policy_still_hides_ungranted_application(self):
        app_id, _ = self.setup_managed()
        with patch.object(applications, 'get_identity', return_value=SimpleNamespace(enterprise_id='e1')), \
                patch.object(applications, 'list_domains', return_value=[]), \
                patch.object(business_access, 'resource_is_open', return_value=False):
            self.assertEqual(applications.published_application_catalog(application_id=app_id), [])

    def test_open_policy_does_not_hide_broken_dependencies(self):
        app_id, _ = self.setup_managed()
        with patch.object(applications, 'get_identity', return_value=SimpleNamespace(enterprise_id='e1')), \
                patch.object(applications, 'list_domains', return_value=[]), \
                patch.object(applications, '_resolve_dependencies', return_value=({}, [{'code': 'domain_disabled'}])), \
                patch.object(business_access, 'resource_is_open', return_value=True):
            self.assertEqual(applications.published_application_catalog(application_id=app_id), [])

    def test_revision_from_another_application_is_rejected(self):
        app_id, history = self.setup_managed()
        history.application = 'another-application'
        with patch.object(applications, 'get_identity', return_value=SimpleNamespace(enterprise_id='e1')):
            with self.assertRaisesRegex(ValueError, '归属异常'):
                applications.published_application_catalog(application_id=app_id)

    def test_open_native_dataset_not_hidden_by_old_doctype_role(self):
        item = {'id': 'finance.expenses', 'object_id': 'finance.expense'}
        with patch.object(domains, '_visible_to_roles', return_value=True), \
                patch.object(business_access, 'is_open', return_value=True), \
                patch.object(business_access, 'resource_is_open', return_value=True):
            self.assertTrue(domains._readable_dataset(item, {'finance.expense': 'Finance Expense'}))
        self.frappe.has_permission.assert_not_called()


    def test_code_summary_does_not_build_resource_definitions(self):
        raw = domain_row()
        row = domains._domain_snapshot(raw)
        row['contribution']['applications'][0]['home'] = 'finance'
        with patch.object(domains, 'list_domains', return_value=[row]), \
                patch.object(domains, '_visible_to_roles', return_value=True), \
                patch.object(domains, '_dataset_doctypes', side_effect=AssertionError('摘要不需表定义')), \
                patch.object(domains, '_application_resources', side_effect=AssertionError('摘要不展开资源')), \
                patch.object(applications, 'published_application_catalog', return_value=[]):
            result = domains.application_catalog(summary=True)
        self.assertEqual(result[0]['title'], '费用管理')
        self.assertEqual(result[0]['home'], 'finance')
        self.assertNotIn('datasets', result[0])
        self.assertNotIn('resources', result[0])

    def test_code_summary_keeps_authorized_dataset_names_without_fields(self):
        row = domains._domain_snapshot(domain_row())
        row['contribution']['datasets'] = [
            {'id': 'orders', 'name': '订单', 'columns': [{'field': 'big-definition'}]},
            {'id': 'hidden', 'name': '隐藏表'},
            {'id': 'unbound', 'name': '无关表'}]
        row['contribution']['applications'][0]['datasets_ids'] = ['orders', 'hidden']
        with patch.object(domains, 'list_domains', return_value=[row]), \
                patch.object(domains, '_visible_to_roles', return_value=True), \
                patch.object(domains, '_dataset_doctypes', return_value={}), \
                patch.object(domains, '_readable_dataset', side_effect=lambda item, _: item['id'] != 'hidden'), \
                patch.object(domains, '_application_resources', side_effect=AssertionError('摘要不展开资源')), \
                patch.object(applications, 'published_application_catalog', return_value=[]):
            result = domains.application_catalog(summary=True)
        self.assertEqual(result[0]['description'], '订单')
        self.assertNotIn('datasets', result[0])


    def test_managed_summary_checks_dependencies_but_does_not_expand_dataset(self):
        app_id, _ = self.setup_managed()
        resources = {kind: [] for kind in applications.KINDS}
        resources['datasets'] = [{'id': 'object-a', 'source': 'managed'}]
        from shangshu_core import model_records
        with patch.object(applications, 'get_identity', return_value=SimpleNamespace(enterprise_id='e1')), \
                patch.object(applications, 'list_domains', return_value=[]), \
                patch.object(applications, '_resolve_dependencies', return_value=(resources, [])) as dependency, \
                patch.object(business_access, 'resource_is_open', return_value=True), \
                patch.object(model_records, 'dataset', side_effect=AssertionError('摘要不展开字段')):
            result = applications.published_application_catalog(summary=True)
        dependency.assert_called_once()
        self.assertEqual(result[0]['id'], app_id)
        self.assertNotIn('datasets', result[0])
        self.assertNotIn('resource_counts', result[0], '没有按资源权限核验的计数不能显示')

    def test_summary_keeps_broken_dependencies_hidden(self):
        self.setup_managed()
        with patch.object(applications, 'get_identity', return_value=SimpleNamespace(enterprise_id='e1')), \
                patch.object(applications, 'list_domains', return_value=[]), \
                patch.object(applications, '_resolve_dependencies', return_value=({}, [{'code': 'domain_disabled'}])), \
                patch.object(business_access, 'resource_is_open', return_value=True):
            self.assertEqual(applications.published_application_catalog(summary=True), [])


if __name__ == '__main__':
    unittest.main()
