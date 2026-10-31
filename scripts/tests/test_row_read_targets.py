"""files.row_read 定行/定列行为：真实生产函数，仅替换持久化与工作簿边界。

不证明 Frappe 权限引擎本身；证明已有授权/回收异常不被吞掉、不退到全表或 xlsx。
"""
import copy
import types
import unittest
from unittest.mock import Mock, patch

from test_targeted_promotion_read import CORE, FILES, ROOT, WORKING, functions, throw, read_scope


class RowReadTargets(unittest.TestCase):
    def setUp(self):
        self.doc = types.SimpleNamespace(name='file', status='Active', content_revision=7,
                                         version_count=1, check_permission=Mock())
        self.meta = {'rows': ['r1', 'r2'], 'headers': ['金额', '案件', '备注'],
                     'sheet_name': 'Sheet1', 'structure_version': 3}
        self.definition = {'promoted': True, 'binding_current': True, 'columns': [
            {'header': '金额', 'field': 'amount', 'type': 'number', 'promoted': True, 'rules': {}},
            {'header': '案件', 'field': 'case', 'type': 'text', 'promoted': True, 'rules': {'required': True}},
            {'header': '备注', 'promoted': False},
        ]}
        self.binding = {'object_id': 'object', 'revision': 1, 'records': {'r1': 'n1', 'r2': 'n2'}}
        self.records = {
            'n1': {'name': 'n1', 'amount': 12, 'case': None, 'modified': 'v1'},
            'n2': {'name': 'n2', 'amount': 99, 'case': '另一行', 'modified': 'v2'},
        }
        self.caps = {'amount': {'read': True}, 'case': {'read': True}}
        self.model = types.SimpleNamespace(get_record=Mock(side_effect=self.get_record),
                                           get_records=Mock(side_effect=self.get_records),
                                           query_records=Mock(side_effect=self.query_records))
        self.sheet = types.SimpleNamespace(read_payload=Mock(side_effect=self.read_sheet))
        core = functions(CORE, {'read_promoted_values'}, {'_fail': throw})
        self.public_read = Mock(side_effect=core['read_promoted_values'])
        merge_path = ROOT / 'frappe_apps/shangshu_files/shangshu_files/read_merge.py'
        merge = types.SimpleNamespace(**functions(merge_path,
            {'promoted_by_header', 'is_hidden', 'merge_row_values'}, {}))
        revision = functions(WORKING, {'content_revision'}, {})['content_revision']
        self.ns = functions(FILES, {'row_read', 'formal_state', '_load_formal', '_managed_state',
                                   '_managed_values', 'column_by_header', 'row_readiness', 'declared_fields'}, {
            'FILE': 'Shangshu File Center File',
            'frappe': types.SimpleNamespace(throw=throw, ValidationError=ValueError,
                DoesNotExistError=LookupError, PermissionError=PermissionError,
                db=types.SimpleNamespace(exists=lambda doctype, name: name == 'file'),
                get_doc=lambda doctype, name: self.doc),
            'load_definition': lambda doc: copy.deepcopy(self.definition),
            '_load_meta': lambda doc: copy.deepcopy(self.meta),
            '_managed_binding': lambda doc: copy.deepcopy(self.binding),
            '_managed_object_alive': lambda binding: True,
            '_require_pending_managed_row': Mock(side_effect=ValueError('缺少受管行映射')),
            '_field_caps': lambda doc, **kwargs: (self.caps, {}),
            'promoted_columns': lambda definition: [c for c in definition['columns'] if c.get('promoted')],
            '_check_rules': lambda column, value: None,
        })
        self.modules = patch.dict('sys.modules', {
            'shangshu_core': types.SimpleNamespace(model_records=self.model),
            'shangshu_core.public_api': types.SimpleNamespace(read_promoted_values=self.public_read),
            'shangshu_files': types.SimpleNamespace(read_merge=merge),
            'shangshu_files.sheet': self.sheet,
            'shangshu_files.working_file': types.SimpleNamespace(content_revision=revision),
        })
        self.modules.start()
        self.addCleanup(self.modules.stop)
        scope_patch = patch.object(read_scope, 'frappe', types.SimpleNamespace(throw=throw, ValidationError=ValueError))
        scope_patch.start()
        self.addCleanup(scope_patch.stop)

    def get_record(self, object_id, name):
        self.assertEqual(object_id, 'object')
        if name not in self.records:
            raise LookupError('记录不存在或已回收')
        return {'record': copy.deepcopy(self.records[name])}

    def get_records(self, object_id, names, **kwargs):
        """**一次批量取回**若干条（与 `get_record` 同一口径：缺一条就当场拒）。"""
        self.assertEqual(object_id, 'object')
        out = {}
        for name in names:
            if name not in self.records:
                raise LookupError('记录不存在或已回收')
            out[name] = copy.deepcopy(self.records[name])
        return out

    def query_records(self, object_id, filters, page, page_length):
        rows = list(self.records.values())
        return {'rows': copy.deepcopy(rows[(page - 1) * page_length:page * page_length]), 'total': len(rows)}

    def read_sheet(self, service, payload, context):
        self.assertEqual(service, 'files.sheet_read')
        return {'table': 'file', 'sheet': 'Sheet1', 'sheet_title': 'Sheet1',
                'content_version': 7, 'structure_version': 3, 'headers': self.meta['headers'],
                'rows': [{'row_id': rid, 'values': {
                    '金额': {'type': 'number', 'value': -999},
                    '案件': {'type': 'text', 'value': '过期的表内值'},
                    '备注': {'type': 'text', 'value': '原备注'},
                }} for rid in payload['row_ids'] if rid in self.meta['rows']]}

    def read(self, **payload):
        return self.ns['row_read']('files.row_read', {'table': 'file', 'row_id': 'r1', **payload}, None)

    def assert_targeted(self):
        self.public_read.assert_called_once()
        self.assertEqual(self.public_read.call_args.kwargs.get('row_ids'), ['r1'],
                         '必须把固定目标行传入内核，不能省略成全表读取')
        # ⚠️ **现在走批量读口**（`model_records.get_records`）：目标行**一次**取回
        #   ⇒ 取数次数**不随行数线性增长**（原来逐行 `get_record`）。
        self.model.get_records.assert_called_once_with('object', ['n1'], fields=['amount', 'case'])
        self.model.get_record.assert_not_called()
        self.model.query_records.assert_not_called()

    def test_one_managed_column_reads_one_record_without_opening_workbook(self):
        result = self.read(headers=['金额'])
        self.assert_targeted()
        self.sheet.read_payload.assert_not_called()
        self.doc.check_permission.assert_called_with('read')
        self.assertEqual(result['cells'], {'金额': {'type': 'number', 'value': 12}})
        self.assertEqual(result['source'], {'金额': 'database'})
        self.assertEqual(result['record_version'], 'v1')
        self.assertEqual(result['row_status'], 'draft', '未请求的必填案件为空，不能因只读金额就冒充就绪')
        self.assertEqual((result['content_version'], result['structure_version'], result['sheet']), (7, 3, 'Sheet1'))

    def test_unknown_duplicate_empty_or_non_array_headers_are_rejected(self):
        for headers in (['不存在'], ['金额', '金额'], [], [''], ['  '], '金额', None, [123]):
            with self.subTest(headers=headers), self.assertRaises((ValueError, LookupError)):
                self.read(headers=headers)
        self.sheet.read_payload.assert_called_once()
        self.assertEqual(self.sheet.read_payload.call_args.args[1]['row_ids'], ['r1'],
                         '未知表头可用工作簿该行核证；不能整表扫')
        self.model.query_records.assert_not_called()
        self.model.get_records.assert_called_once_with('object', ['n1'], fields=['amount', 'case'])

    def test_denied_managed_column_never_leaks_formal_or_old_workbook_value(self):
        self.caps['amount']['read'] = False
        result = self.read(headers=['金额'])
        self.assertEqual(result['cells'], {'金额': {'type': 'hidden', 'value': None, 'hidden': True}})
        self.assertEqual(result['source'], {'金额': 'denied'})
        self.sheet.read_payload.assert_not_called()
        self.model.query_records.assert_not_called()

    def test_unknown_fixed_row_or_missing_record_mapping_is_rejected(self):
        with self.assertRaises((ValueError, LookupError)):
            self.read(row_id='unknown', headers=['金额'])
        self.model.get_records.assert_not_called()
        self.model.get_record.assert_not_called()
        self.sheet.read_payload.assert_not_called()
        del self.binding['records']['r1']
        with self.assertRaisesRegex(ValueError, '映射'):
            self.read(headers=['金额'])
        self.model.query_records.assert_not_called()
        self.sheet.read_payload.assert_not_called()

    def test_omitted_headers_preserve_all_columns_but_formal_read_is_targeted(self):
        result = self.read()
        self.assert_targeted()
        self.assertEqual(set(result['cells']), {'金额', '案件', '备注'})
        self.assertEqual(result['cells']['金额']['value'], 12)
        self.assertIsNone(result['cells']['案件']['value'])
        self.assertEqual(result['cells']['备注']['value'], '原备注')
        self.assertEqual(self.sheet.read_payload.call_args.args[1]['row_ids'], ['r1'])

    def test_ordinary_and_mixed_requested_columns_preserve_their_sources(self):
        for headers in (['备注'], ['备注', '金额']):
            with self.subTest(headers=headers):
                result = self.read(headers=headers)
                self.assertEqual(list(result['cells']), headers)
                self.assertEqual(result['cells']['备注']['value'], '原备注')
                self.assertEqual(result['source']['备注'], 'sheet')
                if '金额' in headers:
                    self.assertEqual(result['cells']['金额']['value'], 12)
                    self.assertEqual(result['source']['金额'], 'database')
                self.assertEqual(self.sheet.read_payload.call_args.args[1]['row_ids'], ['r1'])
        # ⚠️ **批量读口**：两次读 ⇒ **两次** `get_records`（每次一条目标行）
        #   ⇒ 读的是**目标行**，不是整表。
        self.assertEqual(self.model.get_records.call_count, 2)
        self.model.get_record.assert_not_called()
        self.model.query_records.assert_not_called()

    def test_file_read_denial_and_recycled_file_do_not_open_workbook(self):
        self.doc.check_permission.side_effect = PermissionError('file denied')
        with self.assertRaisesRegex(PermissionError, 'file denied'):
            self.read(headers=['金额'])
        self.doc.check_permission.side_effect = None
        self.doc.status = 'Recycled'
        with self.assertRaises((PermissionError, ValueError)):
            self.read(headers=['金额'])
        self.model.get_record.assert_not_called()
        self.sheet.read_payload.assert_not_called()

    def test_record_denial_or_missing_record_never_falls_back_to_workbook(self):
        for error in (PermissionError('record denied'), LookupError('记录不存在或已回收')):
            with self.subTest(error=error):
                # ⚠️ **现在走批量读口**（`get_records`）—— 判据跟着真正在跑的那条路走。
                self.model.get_records.side_effect = error
                with self.assertRaises(type(error)):
                    self.read(headers=['金额'])
        self.model.query_records.assert_not_called()
        self.sheet.read_payload.assert_not_called()

    def test_legitimate_pending_row_is_empty_database_fact_not_old_xlsx_value(self):
        del self.binding['records']['r1']
        pending = self.ns['_require_pending_managed_row']
        pending.side_effect = None
        result = self.read(headers=['金额'])
        self.assertEqual(result['cells']['金额']['value'], None)
        self.assertEqual(result['source'], {'金额': 'database'})
        self.assertEqual(result['row_status'], 'draft')
        self.assertNotIn('record_version', result)
        pending.assert_called_once()
        self.public_read.assert_not_called()
        self.sheet.read_payload.assert_not_called()

    def test_core_field_projection_remains_denied_not_empty_or_workbook_fallback(self):
        # 批量读口只回**这个人读得到的字段** ⇒ 读不到的那一列**整列不在**（不是空值冒充）。
        self.model.get_records.side_effect = None
        self.model.get_records.return_value = {
            'n1': {'name': 'n1', 'modified': 'v1', 'case': None}}
        result = self.read(headers=['金额'])
        self.assertEqual(result['cells']['金额'], {'type': 'hidden', 'value': None, 'hidden': True})
        self.assertEqual(result['source'], {'金额': 'denied'})
        self.sheet.read_payload.assert_not_called()
        self.model.query_records.assert_not_called()


if __name__ == '__main__':
    unittest.main()
