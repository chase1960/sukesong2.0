"""批量写/读回的性能契约：真实生产函数，只替换数据库与动作边界，不连站点。

**证明什么**（2026-10-27 Excel 写路径性能线）：
  · **批量写 200 行**：「取当前版本」的取值查询次数**不随行数线性增长**
    （原来每行一次 `db.get_value` ⇒ 200 次；现在整批一次）；
  · **批量读回 200 行**：受管记录的读取次数**不随行数线性增长**
    （原来每行一次 `get_record` ⇒ 200 次逐行装配；现在整批一次 `name IN (...)`）；
  · **权威写路径没有被削弱**：整包调用 `platform.object.update_many`，包内逐行校验
    （版本闸、字段权限、业务校验、动作审计的真实站点另验）；
  · **边界没动**：版本闸仍在（陈旧写当场被拒）、空值/0/False 分别保留、
    同一批重试命中同键（不重复写）、中途失败**不落半套**也不回退旧存储。

不证明什么：Frappe 权限引擎与真实事务的站点回归另外执行（见
`frappe_apps/shangshu_core/shangshu_core/tests/test_promotion_records.py`），
本文件**不以桩冒充站点事实**。
"""
import contextlib
import copy
import json
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from _f_module_seam import load_module_functions

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'frappe_apps/shangshu_core/shangshu_core/promotion_records.py'
RECORDS = ROOT / 'frappe_apps/shangshu_core/shangshu_core/model_records.py'
SCOPE = ROOT / 'frappe_apps/shangshu_core/shangshu_core/read_scope.py'

MODEL = 'Shangshu Object Model'
PHYSICAL = 'Managed Row'
OBJECT_ID = 'com.shangshu.app.x.object.y'
ROWS = 200


class ValidationError(Exception):
    pass


class PermissionError_(Exception):
    pass


class TimestampMismatchError(Exception):
    pass


class DoesNotExistError(Exception):
    pass


def throw(message, error=ValidationError):
    raise error(message)


class FakeFrappe(types.SimpleNamespace):
    """**假数据库**：把「查了几次」记下来，其余口径照真实函数走。"""

    def __init__(self, rows, owner='person', roles=('System Manager',), access=None, definition=None):
        super().__init__()
        self.rows = {name: dict(row) for name, row in rows.items()}
        self.owner = owner
        self.roles = list(roles)
        self.access = access
        self.get_all_calls = []
        self.get_value_calls = []
        self.set_value_calls = []
        self.get_doc_calls = []
        self.model = types.SimpleNamespace(name=OBJECT_ID, physical_doctype=PHYSICAL,
                                           active_revision=1, revision=1, enterprise_id='e1',
                                           application='app-1',
                                           active_json=json.dumps(definition or compiled()))
        self.throw = throw
        self.ValidationError = ValidationError
        self.PermissionError = PermissionError_
        self.TimestampMismatchError = TimestampMismatchError
        self.DoesNotExistError = DoesNotExistError
        self.session = types.SimpleNamespace(user=owner)
        self.get_roles = lambda *a, **kw: list(self.roles)
        self.get_doc = self.get_doc
        self.get_all = self.get_all
        self.db = types.SimpleNamespace(get_value=self.get_value, set_value=self.set_value)

    # ---- 记录行 ----
    def get_doc(self, doctype, name, **kwargs):
        self.get_doc_calls.append((doctype, name))
        if doctype == MODEL:
            return self.model
        if doctype == 'Shangshu Application Revision':
            return types.SimpleNamespace(definition_json='{"allowed_roles": ["Desk User"],'
                                                        ' "bindings": [{"resource_id": "%s",'
                                                        ' "version": "1"}]}' % OBJECT_ID)
        row = self.rows.get(name)
        if row is None:
            raise DoesNotExistError(doctype + ' ' + str(name))
        return types.SimpleNamespace(**row)

    def get_all(self, doctype, filters=None, fields=None, limit_page_length=0, **kwargs):
        self.get_all_calls.append({'doctype': doctype, 'filters': filters, 'fields': fields})
        names = (filters or {}).get('name')
        wanted = None
        if isinstance(names, (list, tuple)):
            # Frappe 的写法：`{"name": ["in", [名字…]]}`
            if len(names) == 2 and names[0] == 'in':
                wanted = [str(n) for n in (names[1] or [])]
            else:
                wanted = [str(n) for n in names]
        rows = list(self.rows.values()) if wanted is None else [
            self.rows[name] for name in wanted if name in self.rows]
        out = []
        for row in rows:
            item = {'name': row['name'], 'modified': row['modified'], 'creation': row['creation'],
                    'owner': row.get('owner', self.owner)}
            if 'ss_recycled' in row:
                item['ss_recycled'] = row['ss_recycled']
            for field in (fields or []):
                if field in item:
                    continue
                item[field] = row.get(field)
            out.append(item)
        return out

    def get_value(self, doctype, name, field):
        self.get_value_calls.append((doctype, name, field))
        row = self.rows.get(name)
        return None if row is None else row.get(field)

    def set_value(self, doctype, name, field, value, update_modified=True):
        self.set_value_calls.append((doctype, name, field, value))
        self.rows[name][field] = value


def compiled(access=None):
    return {
        'kind': 'record', 'title': '受管表',
        'fields': [{'id': 'amount', 'label': '金额', 'type': 'decimal', 'deprecated': False},
                   {'id': 'note', 'label': '备注', 'type': 'text', 'deprecated': False},
                   {'id': 'flag', 'label': '确认', 'type': 'boolean', 'deprecated': False},
                   {'id': 'empty', 'label': '空值', 'type': 'text', 'deprecated': False}],
        'doctype': {'name': PHYSICAL, 'fields': [{'fieldname': 'amount'}, {'fieldname': 'note'},
                                                 {'fieldname': 'flag'}, {'fieldname': 'empty'}]},
        'access': access or {'read_roles': ['Desk User'], 'write_roles': ['Desk User'],
                             'record_scope': 'own'},
    }


def kernel_modules(access=None):
    """内核那几个依赖的桩（授权判定仍由真实函数走）。"""
    subject_access = types.SimpleNamespace(
        is_subject_access=lambda access: False,
        resolve_op_scope=lambda *a, **kw: ({'scope': 'global'}, None),
        subject_allows=lambda *a, **kw: True,
        field_allows_subject=lambda *a, **kw: True)
    business_access = types.SimpleNamespace(is_open=lambda: False)
    identity = types.SimpleNamespace(get_identity=lambda: types.SimpleNamespace(enterprise_id='e1'))
    design = types.SimpleNamespace(require_application=lambda *a, **kw: types.SimpleNamespace(
        status='Published', published_revision='rev-1', enterprise_id='e1'),
        require_designer=lambda *a, **kw: None)
    field_access = types.SimpleNamespace(
        assert_well_declared=lambda fields: None,
        field_allows_roles=lambda field, roles, op: True,
        open_by_default=lambda fields: [])
    org_admin = types.SimpleNamespace(
        subject_context=lambda user: {'user': user, 'member_of': [], 'head_departments': [],
                                      'is_admin': False})
    lifecycle = types.SimpleNamespace(
        available=lambda doctype: True,
        require_access=lambda *a, **kw: None,
        metadata=lambda doc: {'state': 'active'})
    analysis = types.SimpleNamespace(
        AGGREGATE_OPS=[], MAX_AGGREGATE_FILTERS=0, MAX_AGGREGATE_METRICS=0,
        MAX_AGGREGATE_GROUPS=0, MAX_SET_MEMBERS=0, MAX_AGGREGATE_ROWS=0,
        NUMERIC_FIELD_TYPES=[], DATE_FIELD_TYPES=[], DISTINCT_FIELD_TYPES=[],
        GROUPABLE_FIELD_TYPES=[], SUMMABLE_FIELD_TYPES=[])
    return {
        'shangshu_core.identity': identity,
        'shangshu_core.design_support': design,
        'shangshu_core.field_access': field_access,
        'shangshu_core.record_lifecycle': lifecycle,
        'shangshu_core.org_admin': org_admin,
        'shangshu_core.subject_access': subject_access,
        'shangshu_core.business_access': business_access,
        'shangshu_core.analysis': analysis,
        'shangshu_core.query_receipt': types.SimpleNamespace(),
        'shangshu_core.model_schema': types.SimpleNamespace(record_schema=lambda *a, **kw: {}),
        'shangshu_core.schema_validation': types.SimpleNamespace(_validate_schema=lambda *a, **kw: None),
    }


def real_batch_read(frappe):
    """真的 `model_records.get_records`（批量读口）—— 只换数据库边界。"""
    stubs = {'frappe': frappe,
             'pypika': types.SimpleNamespace(Criterion=object, Order=object),
             'pypika.functions': types.SimpleNamespace(Count=object, Coalesce=object)}
    ctx = load_module_functions(RECORDS, {'get_records'}, stubs=stubs)
    return ctx['get_records']


def real_promotion(frappe, core):
    """真的 `promotion_records.read/write_promoted_values`。"""
    stubs = {'frappe': frappe, 'shangshu_core': core,
             'shangshu_core.design_support': core.design_support,
             'shangshu_core.subject_access': core.subject_access,
             'shangshu_core.business_access': core.business_access}
    ctx = load_module_functions(CORE, {'read_promoted_values', 'write_promoted_values'},
                                stubs=stubs)
    return ctx


class _Batch:
    """`managed_changes.batch` 的桩（批末一次通知这件事本身不在本次范围内）。"""

    def __enter__(self):
        self.result = {'handlers': 0, 'results': []}
        return self

    def __exit__(self, *exc):
        return False


class FakeActions:
    """`execute_registered_action` 的桩：**照权威写路径的口径**演一遍。

    · 版本闸（`expected_modified` 对不上 ⇒ 当场拒）；
    · 幂等键命中 ⇒ 重放（**不重复写**）；
    · 值落进受管记录（空值/0/False 分别保留）。
    """

    def __init__(self, frappe, fail_at=None):
        self.frappe = frappe
        self.fail_at = fail_at
        self.calls = []
        self.requests = {}
        self.writes = 0
        self.attempted = 0

    def execute_registered_action(self, action_id, payload=None, confirmed=False,
                                  idempotency_key=None, source='user', **kwargs):
        payload = payload or {}
        self.calls.append({'action_id': action_id, 'payload': dict(payload),
                            'idempotency_key': idempotency_key})
        if action_id != 'platform.object.update_many':
            raise AssertionError('晋升批写必须走已注册的批动作')
        if idempotency_key in self.requests:
            return self.requests[idempotency_key]
        before = copy.deepcopy(self.frappe.rows)
        written_before = self.writes
        try:
            results = []
            for item in payload['records']:
                self.attempted += 1
                if self.fail_at is not None and self.attempted == self.fail_at:
                    raise TimestampMismatchError('这一行写失败了')
                row = self.frappe.rows[item['name']]
                if str(item.get('expected_modified') or '') != str(row['modified']):
                    raise TimestampMismatchError('记录已被修改，请刷新后重试')
                row.update(item.get('values') or {})
                row['modified'] += '.1'
                self.writes += 1
                results.append({'name': item['name'], 'modified': row['modified']})
        except Exception:
            self.frappe.rows = before
            self.writes = written_before
            raise
        result = {'result': {'records': results}}
        self.requests[idempotency_key] = result
        return result



def seed(count=ROWS):
    rows = {}
    for index in range(1, count + 1):
        name = 'rec-%04d' % index
        rows[name] = {'name': name, 'modified': '2026-10-27 00:00:00.000000',
                      'creation': '2026-10-26 00:00:00.000000', 'owner': 'person',
                      'amount': float(index), 'note': '原备注', 'flag': 0, 'empty': None}
    return rows


class BatchWritePerf(unittest.TestCase):
    def setUp(self):
        self.frappe = FakeFrappe(seed())
        self.access = compiled()['access']
        kernel = kernel_modules(self.access)
        kernel['shangshu_core.read_scope'] = types.SimpleNamespace(**load_module_functions(
            SCOPE, {'normalize_read_scope'}, stubs={'frappe': self.frappe}))
        # ⚠️ 这些模块桩**在整场测试里都活着**（真实函数是**调用时**才 import 它们）。
        patcher = patch.dict('sys.modules', dict(kernel))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.get_records = real_batch_read(self.frappe)
        self.actions = FakeActions(self.frappe)
        self.model_records = types.SimpleNamespace(MODEL=MODEL,
                                                    batch_state=contextlib.nullcontext,
                                                    get_records=self.get_records)
        core = types.SimpleNamespace(
            model_records=self.model_records,
            managed_changes=types.SimpleNamespace(batch=lambda **kw: _Batch()),
            subject_access=kernel['shangshu_core.subject_access'],
            business_access=kernel['shangshu_core.business_access'],
            design_support=kernel['shangshu_core.design_support'])
        patcher2 = patch.dict('sys.modules', {
            'shangshu_core': core,
            'shangshu_core.model_records': self.model_records,
            'shangshu_core.actions': types.SimpleNamespace(
                execute_registered_action=self.actions.execute_registered_action)})
        patcher2.start()
        self.addCleanup(patcher2.stop)
        self.promotion = real_promotion(self.frappe, core)
        self.records = {('r-%04d' % index): 'rec-%04d' % index for index in range(1, ROWS + 1)}

    # ---------- ① 批量写：取当前版本的查询次数不随行数线性增长 ----------
    def test_two_hundred_rows_need_one_version_query_not_two_hundred(self):
        values = {row_id: {'amount': index + 0.5}
                  for index, row_id in enumerate(sorted(self.records))}
        result = self.promotion['write_promoted_values'](
            object_id=OBJECT_ID, records=self.records, values_by_row=values,
            idempotency_key='batch-1')
        self.assertEqual(result['written'], ROWS)
        # 同一已注册批动作只调一次；200 行都有明确行级值及版本，没丢到不受管旁路。
        self.assertEqual(len(self.actions.calls), 1)
        self.assertEqual({call['action_id'] for call in self.actions.calls},
                         {'platform.object.update_many'})
        items = self.actions.calls[0]['payload']['records']
        self.assertEqual(len(items), ROWS)
        self.assertEqual({item['name'] for item in items}, set(self.records.values()))
        self.assertTrue(all(item['expected_modified'] and item['idempotency_key'] for item in items))
        # ⚠️ **取当前版本的查询次数不随行数线性增长**：整批一次取值查询。
        self.assertLessEqual(len(self.frappe.get_all_calls), 5,
                             '取当前版本必须整批一次：%d 次' % len(self.frappe.get_all_calls))
        self.assertEqual(len(self.frappe.get_value_calls), 0,
                         '不许再逐行 db.get_value 取版本：%d 次' % len(self.frappe.get_value_calls))
        self.assertEqual(self.frappe.rows['rec-0001']['amount'], 0.5)

    # ---------- ② 批量读回：受管记录读取次数不随行数线性增长 ----------
    def test_two_hundred_rows_are_read_in_one_batch_not_row_by_row(self):
        state = self.promotion['read_promoted_values'](
            object_id=OBJECT_ID, records=self.records, row_ids=sorted(self.records))
        self.assertEqual(len(state['values']), ROWS)
        self.assertEqual(len(state['versions']), ROWS)
        self.assertLessEqual(len(self.frappe.get_all_calls), 5,
                             '受管记录必须整批取回：%d 次' % len(self.frappe.get_all_calls))
        row_reads = [call for call in self.frappe.get_doc_calls if call[0] == PHYSICAL]
        self.assertEqual(row_reads, [],
                         '不许再逐行 get_doc 取记录：%d 次' % len(row_reads))
        self.assertEqual(state['values']['r-0001']['amount'], 1.0)
        self.assertEqual(state['versions']['r-0001'], '2026-10-27 00:00:00.000000')

    # ---------- ③ 版本闸仍在：客户端带旧版本 ⇒ 当场被拒 ----------
    def test_stale_client_version_is_rejected_and_nothing_is_written(self):
        stale = {'r-0001': '2020-01-01 00:00:00.000000'}
        with self.assertRaises(TimestampMismatchError):
            self.promotion['write_promoted_values'](
                object_id=OBJECT_ID, records=self.records,
                values_by_row={'r-0001': {'amount': 9.5}}, idempotency_key='stale-1',
                expected_modified_by_row=stale)
        self.assertEqual(self.frappe.rows['rec-0001']['amount'], 1.0, '陈旧写没有落进去')

    # ---------- ④ 空值 / 0 / False 分别保留 ----------
    def test_null_zero_and_false_stay_three_different_facts(self):
        self.promotion['write_promoted_values'](
            object_id=OBJECT_ID, records=self.records,
            values_by_row={'r-0001': {'amount': 0, 'flag': False, 'empty': None}},
            idempotency_key='facts-1')
        state = self.promotion['read_promoted_values'](
            object_id=OBJECT_ID, records=self.records, row_ids=['r-0001'])
        values = state['values']['r-0001']
        self.assertEqual(values['amount'], 0)
        self.assertIs(values['flag'], False)
        self.assertIsNone(values['empty'])
        self.assertNotEqual(values['amount'], values['empty'])

    # ---------- ⑤ 幂等：同一批重试命中同键 ⇒ 不重复写 ----------
    def test_same_batch_retried_hits_the_same_key_and_does_not_write_twice(self):
        values = {'r-0001': {'amount': 7.5}}
        versions = {'r-0001': '2026-10-27 00:00:00.000000'}
        self.promotion['write_promoted_values'](
            object_id=OBJECT_ID, records=self.records, values_by_row=values,
            idempotency_key='idem-1', expected_modified_by_row=versions)
        first_keys = [call['idempotency_key'] for call in self.actions.calls]
        self.promotion['write_promoted_values'](
            object_id=OBJECT_ID, records=self.records, values_by_row=values,
            idempotency_key='idem-1', expected_modified_by_row=versions)
        second_keys = [call['idempotency_key'] for call in self.actions.calls[len(first_keys):]]
        self.assertEqual(first_keys, second_keys, '同一批重试必须命中同一把幂等键')
        self.assertEqual(self.actions.writes, 1, '同一把键只写一次')
        self.assertEqual(self.frappe.rows['rec-0001']['amount'], 7.5)
        self.assertEqual(len(self.frappe.rows), ROWS, '没有多写第二条记录')

    # ---------- ⑥ 中途失败：不落半套，也不回退旧存储 ----------
    def test_failure_in_the_middle_leaves_no_half_written_state_and_no_old_value_restore(self):
        self.actions.fail_at = 3
        with self.assertRaises(TimestampMismatchError):
            self.promotion['write_promoted_values'](
                object_id=OBJECT_ID, records=self.records,
                values_by_row={row_id: {'amount': 3.5} for row_id in sorted(self.records)},
                idempotency_key='fail-1')
        # ⚠️ **不许 catch 异常后写回旧值**（失败不得回退旧存储）：
        #   代码里一次 `set_value`（补写旧值）都不许有。
        self.assertEqual(self.frappe.set_value_calls, [])
        # ⚠️ **半套状态**：失败那笔不许当成成功（回执拿不到就是拿不到）。
        self.assertEqual(len(self.actions.calls), 1, '整包仍只有一次公共动作调用')
        self.assertEqual(self.actions.attempted, 3, '失败就停在那一行')
        self.assertEqual(self.actions.writes, 0, '失败整包不留部分成功')
        self.assertEqual(self.frappe.rows, seed(), '动作边界失败恢复整个包，不写旧存储回退')


class BatchReadGuards(unittest.TestCase):
    """批量读口**没有**放宽任何一条读边界。"""

    def setUp(self):
        self.rows = seed(3)
        self.frappe = FakeFrappe(self.rows)
        kernel = kernel_modules(compiled()['access'])
        kernel['shangshu_core.read_scope'] = types.SimpleNamespace(**load_module_functions(
            SCOPE, {'normalize_read_scope'}, stubs={'frappe': self.frappe}))
        patcher = patch.dict('sys.modules', dict(kernel))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.get_records = real_batch_read(self.frappe)

    def test_recycled_record_is_still_rejected(self):
        self.frappe.rows['rec-0002']['ss_recycled'] = 1
        with self.assertRaises(ValidationError):
            self.get_records(OBJECT_ID, ['rec-0002'])

    def test_record_of_another_person_is_still_rejected(self):
        self.frappe.rows['rec-0002']['owner'] = '别人'
        self.frappe.roles = ['Desk User']
        with self.assertRaises(PermissionError_):
            self.get_records(OBJECT_ID, ['rec-0002'])

    def test_missing_record_is_still_rejected(self):
        with self.assertRaises(DoesNotExistError):
            self.get_records(OBJECT_ID, ['不存在的记录'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
