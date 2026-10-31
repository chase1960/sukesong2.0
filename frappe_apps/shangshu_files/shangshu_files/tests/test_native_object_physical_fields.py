"""文件中心那个原生对象：**声明的字段必须是这张表的物理列**。

**测试通过 =**（一句话）

「`files.file` 这个对象**声明的字段**（和**可筛选的字段**）
  **全是 `Shangshu File Center File` 这张表的物理列**
  ⇒ 内核的通用读（照声明去 SELECT）**不会撞「Unknown column」**。」

⚠️ **站上实测过的坑**（2026-10-28 · PKG-132 收尾的必登记缺陷）：
  通用读 `files.file` ⇒ `OperationalError (1054, "Unknown column 'tags' in 'SELECT'")`
  —— 因为声明里把 `tags`（物理列叫 `tags_json`）、
  `upload_version`／`working_copy`（**算出来的**）当成了物理列。

⚠️ **口径**：内核的口径是「**表格读取沿声明字段**」⇒ **声明 = 物理列**；
  **人话那一层／算出来的那几格由域自己的读口给**（`files.list`／`files.versions`）。
"""
import json
import unittest
from pathlib import Path

from shangshu_files.tests import offline_env

# —— **不是物理列的**那些（布局块／子表／按钮……）——
LAYOUT_FIELDTYPES = {
    'Column Break', 'Section Break', 'Tab Break', 'HTML', 'Button',
    'Table', 'Table MultiSelect', 'Heading', 'Fold', 'Attach', 'Attach Image', 'Code',
}


class NativeObjectPhysicalFieldsTest(unittest.TestCase):
    """**声明的字段 = 物理列**（通用读照声明去 SELECT ⇒ 声明错了当场炸）。"""

    @classmethod
    def setUpClass(cls):
        # —— **框架替身用公共那一份**（仓库约定：替身只许有一份）——
        cls.env = offline_env.OfflineEnv()
        cls.env.__enter__()
        cls.domain = cls.env.import_domain('domain')['domain']

    @classmethod
    def tearDownClass(cls):
        cls.env.__exit__(None, None, None)

    def _object(self):
        """域声明的那个**原生对象**（`files.file`）。"""
        objects = self.domain.get_contribution().get('objects') or []
        for item in objects:
            if item.get('id') == 'files.file':
                return item
        raise AssertionError('文件域没有声明 `files.file` 这个对象')

    def _physical_columns(self):
        domain = self.domain
        path = Path(domain.__file__).parent / ('shangshu_files/doctype/shangshu_file_center_file/'
                                              'shangshu_file_center_file.json')
        doctype = json.loads(path.read_text(encoding='utf-8'))
        columns = {field['fieldname'] for field in doctype.get('fields', [])
                   if field.get('fieldtype') not in LAYOUT_FIELDTYPES}
        # Frappe 自带的那几列（每个表都有）。
        columns |= {'name', 'creation', 'modified', 'modified_by', 'owner', 'docstatus', 'idx'}
        return columns

    def test_declared_fields_are_physical_columns(self):
        obj = self._object()
        physical = self._physical_columns()
        declared = {field['id'] for field in obj.get('fields') or []}
        missing = sorted(declared - physical)
        self.assertEqual(missing, [],
                         '对象声明了**不是物理列**的字段（内核通用读照声明去 SELECT ⇒ 当场炸）：'
                         + '、'.join(missing))

    def test_filter_fields_are_physical_columns(self):
        obj = self._object()
        physical = self._physical_columns()
        missing = sorted(set(obj.get('filter_fields') or []) - physical)
        self.assertEqual(missing, [],
                         '对象把**不是物理列**的字段列进了可筛选（筛的时候同样炸）：'
                         + '、'.join(missing))

    def test_the_derived_fields_are_still_given_by_the_domain_read(self):
        """**派生那几格不许从对象声明里消失**（域自己的读口照旧给它们）。"""
        # 声明里**不该**有它们（通用读 SELECT 不到）……
        obj = self._object()
        declared = {field['id'] for field in obj.get('fields') or []}
        for field in ('tags', 'attribution_label', 'capability', 'upload_version', 'working_copy'):
            self.assertNotIn(field, declared,
                             '「%s」不是物理列，不该进对象声明' % field)
        # ……但**域自己的读口**照旧给（`files.list` 那条把 tags_json 变成人话）。
        self.assertIn('tags_json', self._physical_columns(),
                      '物理列 tags_json 没了（域自己的读口靠它出人话）')


if __name__ == '__main__':
    unittest.main()
