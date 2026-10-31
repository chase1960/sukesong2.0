"""目录搜索在装配定义前收窄候选，命中项仍走当前授权。"""
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from _f_module_seam import install_real_environment

install_real_environment('shangshu_core')
from shangshu_core import domains, model_records, native_objects, objects


class CatalogSearchScope(unittest.TestCase):
    def test_managed_search_filters_in_database_before_definition(self):
        fake = SimpleNamespace(db=SimpleNamespace(sql=Mock(return_value=[
            SimpleNamespace(name='obj.hit', application='app.one', modified='now')])),
            get_all=Mock(side_effect=AssertionError('搜索不能再读取全部受管模型')),
            PermissionError=PermissionError, ValidationError=ValueError)
        with patch.object(model_records, 'frappe', fake), \
                patch.object(model_records, 'get_identity', return_value=SimpleNamespace(enterprise_id='current')), \
                patch.object(model_records, 'definition', return_value={'id': 'obj.hit', 'title': '费用'}) as define:
            rows = model_records.list_definitions(search="费用%_'")
        self.assertEqual([r['id'] for r in rows], ['obj.hit'])
        define.assert_called_once_with('obj.hit')
        sql, values = fake.db.sql.call_args.args
        self.assertIn('m.enterprise_id = %(enterprise_id)s', sql)
        self.assertIn('LOCATE', sql)
        self.assertIn('Disabled', sql)
        self.assertEqual(values, {'enterprise_id': 'current', 'search': "费用%_'"})
        self.assertNotIn("费用%_'", sql)

    def test_search_hits_still_recheck_definition_permission(self):
        fake = SimpleNamespace(db=SimpleNamespace(sql=Mock(return_value=[
            SimpleNamespace(name='hidden', application='app.one', modified='now')])),
            PermissionError=PermissionError, ValidationError=ValueError)
        with patch.object(model_records, 'frappe', fake), \
                patch.object(model_records, 'get_identity', return_value=SimpleNamespace(enterprise_id='current')), \
                patch.object(model_records, 'definition', side_effect=PermissionError('denied')):
            self.assertEqual(model_records.list_definitions(search='费用'), [])

    def test_catalog_does_not_expand_unmatched_native_or_registered_objects(self):
        domain = {'id': 'domain.one', 'name': '一', 'contribution': {'objects': [
            {'id': 'native.skip', 'name': '不匹配', 'native_table': {'title': '无关'}},
            {'id': 'native.hit', 'name': '旧标题', 'native_table': {'title': '费用台账'}},
            {'id': 'registered.skip', 'name': '无关'},
            {'id': 'registered.hit', 'name': '费用清单'}]}}
        with patch.object(domains, 'list_domains', return_value=[domain]), \
                patch.object(native_objects, '_public_definition', return_value={
                    'id': 'native.hit', 'name': '费用台账', 'title': '费用台账'}) as native, \
                patch.object(model_records, 'list_definitions', return_value=[]) as managed, \
                patch.object(objects, '_with_metadata', side_effect=lambda row: row) as metadata:
            rows = objects.list_object_definitions(search='费用')
        native.assert_called_once_with('native.hit')
        managed.assert_called_once_with(search='费用')
        self.assertEqual(metadata.call_count, 2)
        self.assertEqual({r['id'] for r in rows}, {'native.hit', 'registered.hit'})

    def test_search_keeps_literal_case_insensitive_cross_label_semantics(self):
        rows = [{'title': 'A%', 'name': 'B_', 'id': 'ID'}]
        self.assertEqual(objects._filter_object_definitions(rows, 'a% b_'), rows)
        self.assertEqual(objects._filter_object_definitions(rows, 'a_'), [])


if __name__ == '__main__':
    unittest.main()
