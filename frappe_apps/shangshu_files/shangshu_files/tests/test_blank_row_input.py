"""**写进「没有固定行身份的空白行」**（2026-10-29 用户口径）。

跑在**隔离站点**上（真表 ＋ 真 ZIP 手术）。

**为什么要有这一条**：网格里那一段空白（排序／筛选视图里**最后一行可见行**之下）
**没有固定行身份** —— 它不是表里的一行，是「还没建出来的一行」。
往那儿粘贴／输入以前一律被拒：「已有行缺少固定行身份，本次未保存」。

**测试通过 = 什么成立**：
- 往那一片空白处**粘贴**一格 ⇒ 不报「已有行缺少固定行身份」；
- **单格输入**写进同一片空白 ⇒ 同样不报；
- 两种写法都**多了一个新的固定行身份**（登记进 meta 的行表、不是被删的那一行）；
- 值**真的落在新行上**（读回来是新行的值）。
"""
import uuid
import unittest

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_files import sheet
from shangshu_files.tests import promotion_fixture as fixture


class TestBlankRowInput(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.key = 'blank-row-' + uuid.uuid4().hex
        self.table = fixture.upload_unique_table(self.key)
        frappe.db.commit()

    def tearDown(self):
        frappe.set_user('Administrator')
        frappe.db.rollback()
        super().tearDown()

    def doc(self):
        return frappe.get_doc(sheet.DOCTYPE, self.table)

    def meta(self):
        return sheet._load_meta(self.doc())

    def pin(self, **updates):
        doc = self.doc()
        meta = sheet._load_meta(doc)
        return {'table': self.table, 'op_id': self.key + ':' + uuid.uuid4().hex,
                'expected_content_version': sheet.content_revision(doc),
                'expected_structure_version': int(meta.get('structure_version') or 1),
                **updates}

    def blank_grid_row(self):
        """网格里**没有固定行身份**的那一格的位置（最后一行可见行之下）。

        ⚠️ **前提**：表里**软删过行** —— 可见的行比物理行少，
        网格空白处才会落在物理行的**中间**（那才是「没有固定行身份的空白行」）。
        表末尾之外的空白（可见行数 == 物理行数）本来就写得进去，不在本次口径里。
        """
        meta = self.meta()
        return len(meta['rows']) - len(meta.get('deleted_rows') or [])

    def soft_delete_the_last_row(self):
        meta = self.meta()
        sheet.row_delete(self.pin(row_id=meta['rows'][-1]))
        frappe.db.commit()

    def assert_written_into_a_new_row(self, before_rows, header, value):
        after = self.meta()
        fresh = [rid for rid in after['rows'] if rid not in before_rows]
        self.assertEqual(len(fresh), 1, '只该多一个固定行身份')
        self.assertNotIn(fresh[0], after.get('deleted_rows') or [],
                         '新建的行身份不能落在被删的那一行上')
        rows = {r['row_id']: r for r in
                sheet.read_payload('files.sheet_read', {'table': self.table}, None)['rows']}
        self.assertIn(fresh[0], rows, '新行要出现在读回来的行里')
        self.assertEqual(rows[fresh[0]]['values'][header].get('value'), value,
                         '值要真的落在新行上')

    def test_paste_into_a_row_without_fixed_identity_creates_one(self):
        self.soft_delete_the_last_row()
        before = self.meta()
        result = sheet.paste_apply(self.pin(start_row=self.blank_grid_row(), start_col=2,
                                            matrix=[['写进空白行']], matrix_types=[['text']],
                                            target_row_ids=[None]))
        frappe.db.commit()
        self.assertEqual(result.get('rows_added'), 1, '这一包应当报告新增了一行')
        self.assert_written_into_a_new_row(before['rows'], '名称', '写进空白行')

    def test_single_cell_input_into_a_row_without_fixed_identity_creates_one(self):
        self.soft_delete_the_last_row()
        before = self.meta()
        sheet.input_write(self.pin(start_row=self.blank_grid_row(), start_col=2,
                                   value={'type': 'text', 'value': '单格写进空白行'},
                                   target_row_ids=[None]))
        frappe.db.commit()
        self.assert_written_into_a_new_row(before['rows'], '名称', '单格写进空白行')

    def test_a_row_with_an_identity_is_still_written_in_place(self):
        """**护栏**：有固定行身份的行走老路 —— 值落在**那一行**上，不新建行。"""
        meta = self.meta()
        target = meta['rows'][0]
        sheet.write_cell(self.pin(row_id=target, header='名称',
                                  value={'type': 'text', 'value': '写在原行'}))
        frappe.db.commit()
        after = self.meta()
        self.assertEqual(len(after['rows']), len(meta['rows']), '有身份的行不许新建行')
        rows = {r['row_id']: r for r in
                sheet.read_payload('files.sheet_read', {'table': self.table}, None)['rows']}
        self.assertEqual(rows[target]['values']['名称'].get('value'), '写在原行')


if __name__ == '__main__':
    unittest.main()
