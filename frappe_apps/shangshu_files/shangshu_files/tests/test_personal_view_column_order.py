"""个人视图的**列序**（2026-10-29 用户口径：视图里能定「按这个顺序显示」）。

跑在**隔离站点**上（真表 ＋ 真个人视图文档）。

**测试通过 = 什么成立**：
- 列序**存进去、读回来还在**，顺序一字不变；
- **读回来时按它排**：点名的列按那个顺序排在前面，没点名的列按表里的原顺序接在后面；
- 表里没有的列名**当场拒**（不静默丢掉）；
- 老视图（没有列序这个键）**照旧合法** —— 不因为新字段被判死；
- 动作的**入参 schema** 认这个**可选**字段，且**动作版本进位**
  （定义变了不升版本 ⇒ 内核登记闸当场拒，`bench migrate` 直接失败）。
"""
import ast
import uuid
import unittest

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_files import domain, sheet, sheet_view
from shangshu_files.tests import promotion_fixture as fixture

VIEW = {'filters': [], 'freeze': {'rows': 0, 'columns': 0}, 'columns': ['名称', '金额']}
HEADERS = fixture.HEADERS


def _view_schema():
    """`files.sheet_view_save` 的入参 schema（真注册的那一份）。"""
    for entry in domain.ACTIONS:
        if entry[0] == 'files.sheet_view_save':
            return entry[3]
    raise AssertionError('文件域没有登记 files.sheet_view_save')


def _registered_version(action):
    """从 install.py 的版本表里读某个动作的版本号。"""
    import pathlib
    path = pathlib.Path(domain.__file__).with_name('install.py')
    tree = ast.parse(path.read_text(encoding='utf-8'))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values):
            if (isinstance(key, ast.Constant) and key.value == action
                    and isinstance(value, ast.Constant) and isinstance(value.value, str)):
                return value.value
    return None


class TestPersonalViewColumnOrder(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.key = 'view-order-' + uuid.uuid4().hex
        self.table = fixture.upload_unique_table(self.key)
        frappe.db.commit()

    def tearDown(self):
        frappe.set_user('Administrator')
        frappe.db.rollback()
        frappe.db.delete(sheet_view.DOCTYPE, {'resource': self.table})
        super().tearDown()

    def doc(self):
        return frappe.get_doc(sheet.DOCTYPE, self.table)

    def version(self):
        return int(sheet._load_meta(self.doc())['structure_version'])

    def test_saved_column_order_is_read_back_in_that_order(self):
        saved = sheet_view.save_view({'table': self.table, 'expected_revision': 0,
                                      'expected_structure_version': self.version(),
                                      'view': VIEW})
        frappe.db.commit()
        self.assertEqual(saved['view']['columns'], ['名称', '金额'],
                         '存进去的列序要原样存下来')
        read = sheet_view.read_view('files.sheet_view_read', {'table': self.table})
        self.assertEqual(read['view']['columns'], ['名称', '金额'], '读回来列序还在')
        self.assertEqual(read['columns'], ['名称', '金额'] + [h for h in HEADERS
                                                              if h not in ('名称', '金额')],
                         '读回来要按它排：点名的列按那个顺序在前，没点名的按表里的原顺序接在后面')

    def test_column_order_does_not_change_which_rows_are_shown(self):
        """列序只管**列的摆法**，不管**行**（行还是那一批固定行身份）。"""
        sheet_view.save_view({'table': self.table, 'expected_revision': 0,
                              'expected_structure_version': self.version(),
                              'view': VIEW})
        frappe.db.commit()
        read = sheet_view.read_view('files.sheet_view_read', {'table': self.table})
        plain = sheet.read_payload('files.sheet_read', {'table': self.table}, None)
        self.assertEqual([row['row_id'] for row in read['rows']],
                         [row['row_id'] for row in plain['rows']],
                         '列序不许改变看得见的行')

    def test_unknown_column_in_the_order_is_rejected(self):
        with self.assertRaises(frappe.ValidationError):
            sheet_view.save_view({'table': self.table, 'expected_revision': 0,
                                  'expected_structure_version': self.version(),
                                  'view': {**VIEW, 'columns': ['名称', '没有这一列']}})
        frappe.db.rollback()

    def test_old_view_without_column_order_still_reads(self):
        """老视图（没有列序这个键）**照旧合法** —— 不因为新字段被判死。"""
        saved = sheet_view.save_view({'table': self.table, 'expected_revision': 0,
                                      'expected_structure_version': self.version(),
                                      'view': {'filters': [], 'freeze': {'rows': 1, 'columns': 0}}})
        frappe.db.commit()
        self.assertNotIn('columns', saved['view'], '老视图原样保留（不硬塞一个空数组）')
        self.assertEqual(saved['columns'], HEADERS, '没给列序 ⇒ 读回来就是表里的原顺序')

    def test_action_input_schema_takes_the_optional_column_order(self):
        schema = _view_schema()
        view = schema['properties']['view']
        self.assertIn('columns', view['properties'], '入参 schema 要认这个可选字段')
        self.assertNotIn('columns', view['required'], '它是可选的 ⇒ 老载荷照旧合法')
        self.assertFalse(view['additionalProperties'], '不许塞别的键')

    def test_action_version_moved_forward(self):
        """定义变了 ⇒ **版本必须进位**（同号会被内核登记闸当场拒，迁移直接失败）。"""
        version = _registered_version('files.sheet_view_save')
        self.assertEqual(version, '1.2.0', '1.1.0 是加了列序之前那个定义 ⇒ 必须进位')


if __name__ == '__main__':
    unittest.main()
