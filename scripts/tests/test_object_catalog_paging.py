"""目录先授权/筛选/计数分页，仅当前页装配完整定义；不连站点。"""
from contextlib import nullcontext
from types import SimpleNamespace
import unittest
import json
import copy
from unittest.mock import Mock, patch
from _f_module_seam import install_real_environment
install_real_environment('shangshu_core')
from shangshu_core import objects, model_records, domains, business_access, native_objects


class ObjectCatalogPaging(unittest.TestCase):
    def setUp(self):
        self.rows = [{'id': 'obj.%03d' % i, 'name': '业务%03d' % i, 'title': '业务%03d' % i,
                      'owner': 'app', 'source': 'managed', 'modified': 'today'} for i in range(317)]
        self.defined = []
        def definition(object_id):
            self.defined.append(object_id)
            return {**next(row for row in self.rows if row['id'] == object_id),
                    'fields': ['heavy'], 'input_schema': {'heavy': True}, 'operations': ['read'],
                    'export': {'available': False}}
        def fail(message, error=ValueError): raise error(message)
        self.fake = SimpleNamespace(throw=fail, ValidationError=ValueError,
            PermissionError=PermissionError, DoesNotExistError=LookupError,
            get_roles=lambda: [], logger=lambda *a: SimpleNamespace(info=lambda *a: None))
        for obj, key, value in (
            (objects, 'frappe', self.fake),
            (domains, 'list_domains', Mock(return_value=[])),
            (model_records, 'catalog_candidates', Mock(side_effect=lambda **kw: list(self.rows))),
            (model_records, 'definition', Mock(side_effect=definition)),
            (model_records, 'batch_state', nullcontext),
            (objects, '_with_metadata', Mock(side_effect=lambda row: {**row,
                'attribution': self.attribution(row['id']), 'can_edit': False, 'can_download': False})),
            (objects, '_object_attribution', Mock(side_effect=lambda oid, row: self.attribution(oid))),
        ):
            context = patch.object(obj, key, value, create=True)
            context.start(); self.addCleanup(context.stop)

    @staticmethod
    def attribution(object_id):
        return {'level': 'department' if int(object_id.split('.')[-1]) % 2 else 'personal'}

    def test_page_20_expands_only_20_of_317_authorized_candidates(self):
        result = objects.list_object_definitions(page=2, page_length=20, summary=True)
        self.assertEqual(result['total'], 317)
        self.assertEqual([row['id'] for row in result['list']], ['obj.%03d' % i for i in range(20, 40)])
        self.assertEqual(self.defined, [row['id'] for row in result['list']])
        self.assertTrue(all('input_schema' not in row and 'fields' not in row for row in result['list']))
        self.assertTrue(all(row['can_edit'] is False and row['can_download'] is False for row in result['list']))
        objects._object_attribution.assert_not_called()

    def test_search_and_attribution_filter_before_total_and_page(self):
        result = objects.list_object_definitions(search='业务01', page=1, page_length=3,
                                                summary=True, attribution_level='department')
        self.assertEqual(result['total'], 5)
        self.assertEqual([row['id'] for row in result['list']], ['obj.011', 'obj.013', 'obj.015'])
        self.assertEqual(len(self.defined), 3)

    def test_native_and_registered_denials_are_removed_before_total(self):
        domains.list_domains.return_value = [{'id': 'domain', 'name': '域', 'contribution': {'objects': [
            {'id': 'native.denied', 'name': '不可读', 'native_table': {'title': '不可读'}},
            {'id': 'registered.denied', 'name': '不可读', 'doctype': 'Private Record'}]}}]
        with patch.object(native_objects, '_require', return_value=({}, {}, {}, {}, {})), \
                patch.object(native_objects, '_gate_read', side_effect=PermissionError('denied')), \
                patch.object(native_objects, 'definition', side_effect=AssertionError('不能展开不可读定义')), \
                patch.object(business_access, 'require_identity'), \
                patch.object(business_access, 'is_open', return_value=False), \
                patch.object(self.fake, 'has_permission', return_value=False, create=True):
            result = objects.list_object_definitions(page=1, page_length=20, summary=True)
        self.assertEqual(result['total'], 317)
        self.assertEqual(len(result['list']), 20)
        self.assertFalse(any(row['id'].endswith('denied') for row in result['list']))

    def test_same_title_stably_orders_by_id(self):
        for row in self.rows: row['title'] = row['name'] = '同名'
        self.rows.reverse()
        result = objects.list_object_definitions(page=2, page_length=2, summary=True)
        self.assertEqual([row['id'] for row in result['list']], ['obj.002', 'obj.003'])

    def test_out_of_range_page_expands_nothing(self):
        result = objects.list_object_definitions(page=99, page_length=20, summary=True)
        self.assertEqual(result['total'], 317)
        self.assertEqual(result['list'], [])
        self.assertEqual(self.defined, [])

    def test_invalid_pagination_or_attribution_rejected(self):
        for kw in ({'page': 0}, {'page': 1, 'page_length': 0},
                   {'page': 1, 'attribution_level': 'invented'}):
            with self.subTest(kw=kw), self.assertRaises(ValueError):
                objects.list_object_definitions(summary=True, **kw)


class ManagedCatalogCandidates(unittest.TestCase):
    def test_batch_preload_uses_same_model_authorization_before_count(self):
        class Row(dict):
            __getattr__ = dict.get
        identity = Row(enterprise_id='E1')
        template = {'title': '业务', 'kind': 'record', 'access': {
            'read_roles': ['Desk User'], 'write_roles': ['Desk User'], 'record_scope': 'all'},
            'fields': [{'id': 'value', 'type': 'text', 'deprecated': False}]}
        rows = []
        def add(name, *, app='APP', enterprise='E1', revision=1, **change):
            schema = {**copy.deepcopy(template), **change}
            rows.append(Row(name=name, application=app, enterprise_id=enterprise,
                active_revision=revision, physical_doctype='Row ' + name, modified='now',
                active_json=json.dumps(schema)))
        add('ok')
        add('denied', access={'read_roles': ['Other'], 'write_roles': ['Other']})
        add('detail', kind='detail')
        add('foreign', enterprise='E2')
        add('stale', reference_revisions={'child': 2})
        add('unbound')
        add('disabled', app='DISABLED')
        add('draft', app='DRAFT')
        add('bad-field', fields=[{'id': 'value', 'type': 'text', 'read_roles': ['Desk User']}])
        apps = [Row(name='APP', enterprise_id='E1', status='Published', published_revision='REV'),
                Row(name='DISABLED', enterprise_id='E1', status='Disabled', published_revision='REV'),
                Row(name='DRAFT', enterprise_id='E1', status='Draft', published_revision=None)]
        revision = Row(name='REV', definition_json=json.dumps({'allowed_roles': ['Desk User'],
            'bindings': [{'resource_id': row.name, 'version': '1'} for row in rows if row.name != 'unbound']}))
        queries = []
        def get_all(doctype, **kwargs):
            queries.append(doctype)
            if doctype == 'Shangshu Application Definition': return apps
            if doctype == 'Shangshu Application Revision': return [revision]
            if doctype == model_records.MODEL: return [Row(name='child', active_revision=3)]
            raise AssertionError(doctype)
        def fail(message, error=ValueError): raise error(message)
        fake = SimpleNamespace(db=SimpleNamespace(sql=Mock(return_value=rows)),
            get_all=get_all, get_doc=Mock(side_effect=AssertionError('候选不能逐对象get_doc')),
            get_roles=lambda: ['Desk User'], session=SimpleNamespace(user='person'),
            throw=fail, PermissionError=PermissionError, ValidationError=ValueError, DoesNotExistError=LookupError)
        with patch.object(model_records, 'frappe', fake), \
                patch.object(model_records, 'get_identity', return_value=identity), \
                patch.object(business_access, 'is_open', return_value=False), \
                model_records.batch_state():
            stats = {}
            result = model_records.catalog_candidates(stats=stats)
            self.assertEqual([row['id'] for row in result], ['ok'])
            self.assertEqual(stats['scanned'], 9)
            # 本页后续完整定义可复用刚通过同一 _load 的上下文，未通过的不能进cache。
            self.assertEqual(set(model_records._BATCH_STATE.get()['loads']), {('ok', False)})
        self.assertEqual(len(queries), 3, '应用、发布绑定和引用版本均按批取')
        self.assertEqual(fake.db.sql.call_args.args[1], {'enterprise_id': 'E1'})
        self.assertIn('a.status !=', fake.db.sql.call_args.args[0])

    def test_prefetch_is_forbidden_in_write_path(self):
        def fail(message, error=ValueError): raise error(message)
        with patch.object(model_records, 'frappe', SimpleNamespace(throw=fail, ValidationError=ValueError)), \
                self.assertRaisesRegex(ValueError, '写入不能'):
            model_records._load('object', write=True, _prefetched={})


if __name__ == '__main__': unittest.main()
