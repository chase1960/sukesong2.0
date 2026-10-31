"""Bounded object lookup must reuse target authorization, never expand the catalog."""
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from _f_module_seam import install_real_environment

install_real_environment('shangshu_core')
from shangshu_core import model_records, objects


class ExactManagedLookup(unittest.TestCase):
    def lookup(self, rows, title='官文审核', namespace=None, definition=None):
        def fail(message, error=None):
            raise (error or ValueError)(message)
        fake = SimpleNamespace(db=SimpleNamespace(sql=Mock(return_value=rows)),
                               throw=fail, ValidationError=ValueError,
                               PermissionError=PermissionError)
        current = SimpleNamespace(enterprise_id='enterprise-current')
        target = definition or {'id': 'object-one', 'source': 'managed'}
        with patch.object(model_records, 'frappe', fake), \
                patch.object(model_records, 'get_identity', return_value=current), \
                patch.object(objects, 'get_object_definition', return_value=target) as get, \
                patch.object(objects, 'list_object_definitions', side_effect=AssertionError('catalog expansion')):
            result = objects.find_managed_object_definition(title, namespace=namespace)
        return result, fake.db.sql, get

    def test_one_target_reuses_current_definition_authorization(self):
        result, sql, get = self.lookup([{'name': 'object-one', 'status': 'Published'}])
        self.assertEqual(result['id'], 'object-one')
        get.assert_called_once_with('object-one')
        query, values = sql.call_args.args
        self.assertIn('LIMIT 2', query)
        self.assertIn('m.enterprise_id = %(enterprise_id)s', query)
        self.assertEqual(values['enterprise_id'], 'enterprise-current')
        self.assertEqual(values['title'], '官文审核')

    def test_absent_does_not_expand_or_authorize_catalog(self):
        result, _, get = self.lookup([])
        self.assertIsNone(result)
        get.assert_not_called()

    def test_ambiguous_title_is_rejected_before_exposing_any_definition(self):
        with self.assertRaisesRegex(ValueError, '多份'):
            self.lookup([{'name': 'one'}, {'name': 'two'}])

    def test_namespace_and_title_are_bound_parameters(self):
        _, sql, _ = self.lookup([], title="x' OR 1=1 --", namespace='app-exact')
        query, values = sql.call_args.args
        self.assertNotIn("x' OR 1=1 --", query)
        self.assertIn('a.namespace = %(namespace)s', query)
        self.assertEqual(values['namespace'], 'app-exact')

    def test_disabled_match_is_not_absence_or_a_new_creation_opportunity(self):
        with self.assertRaisesRegex(PermissionError, '停用'):
            self.lookup([{'name': 'one', 'status': 'Disabled'}])

    def test_empty_title_never_means_full_catalog(self):
        with self.assertRaisesRegex(ValueError, '标题'):
            self.lookup([], title='')

    def test_unreadable_object_is_not_swallowed(self):
        with patch.object(model_records, 'resolve_object_id', return_value='hidden'), \
                patch.object(objects, 'get_object_definition', side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(PermissionError, 'denied'):
                objects.find_managed_object_definition('隐藏对象')

    def test_repeated_calls_recheck_instead_of_using_process_cache(self):
        with patch.object(model_records, 'resolve_object_id', return_value='object') as resolve, \
                patch.object(objects, 'get_object_definition', side_effect=[{'revision': 1}, {'revision': 2}]):
            self.assertEqual(objects.find_managed_object_definition('one')['revision'], 1)
            self.assertEqual(objects.find_managed_object_definition('one')['revision'], 2)
        self.assertEqual(resolve.call_count, 2)


if __name__ == '__main__':
    unittest.main()
