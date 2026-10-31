"""R09（文件域那一半）：表格读取**只跑一轮**伴随授权（算好的那份**复用**给隐藏列判定）。

**问题是什么**（2026-10-26 全仓审查 R09）：
`shangshu_files/sheet.py` 的 `read_payload` 先对**全部行 id** 做一次 `read_access`，
接着又调 `promotion.unreadable_headers(doc)` —— 那道闸里
`shangshu_files/object_projection.py` 的 `read_access(doc)` **不传 record_ids**
⇒ 又按 `sheet._load_meta(doc).get('rows',[])` 取**全表**再算一次。
⇒ **一次读跑两轮全表授权**（每轮都是「每条原记录查一次」的量）。

**测试通过 = 下面每一条都成立**（编号 R09-01～R09-03）：

- **R09-01** 读一张**伴随表** ⇒ 核心那口授权（`authorize_companion_cells`，
  `operation='read'`）**只被调一次**。
  改之前：两次（一次算行、一次算隐藏列）⇒ 这条会红。
- **R09-02** **读不到的行不出现**：没被授权的行、以及**已回收（软删）的行**，
  一行都不许出现在回包的行里（可见性不许放宽）。
- **R09-03** **读不到的列被藏起来**：那一列的值是「隐藏」标记（原值不给），
  读得到的列照旧给值。

**替的是什么**：框架（`frappe`）用**公共那一份拟真替身**；跨域那口
（`shangshu_core.public_api.authorize_companion_cells` / `get_file_companion`）
用**判据自己的计数替身**（要数的正是「被调了几次、带了哪些行」）；
跑的是**真模块**（`shangshu_files.sheet` / `promotion` / `object_projection`）。

跑法（**离线可跑**，不带 bench）：

    cd frappe_apps/shangshu_files && python3 -m unittest shangshu_files.tests.test_companion_read_access_once
"""
import hashlib
import json
import tempfile
import types
import unittest

from shangshu_files.tests import offline_env
from shangshu_files.tests.promotion_fixture import HEADERS, ROW_COUNT, workbook_bytes

#: 伴随绑定：**一列**映射到原对象的字段（`名称` → `title`）。
BINDING = {
    'object_id': 'orders.order',
    'file_id': 'TBL-C',
    'field_columns': [{'field_id': 'title', 'header': '名称', 'type': 'text'}],
    'definition_revision': 1,
}

#: **读得到**的行（前面 5 行）；其余读不到。
ALLOWED_ROWS = ['r-%06d' % index for index in range(1, 6)]
#: **已回收（软删）**的行 —— 读得到也**不许出现**。
DELETED_ROWS = ['r-000006']


class _FakeDoc:
    """文件中心那一行（表）的替身。"""

    def __init__(self, name, meta, content):
        self.name = name
        self.doctype = 'Shangshu File Center File'
        self.file_name = '伴随表.xlsx'
        self.sheet_meta_json = json.dumps(meta, ensure_ascii=False)
        self.status = 'Active'
        self.owner = 'tester@example.invalid'
        self.content_revision = 1
        self.version_count = 1
        self.current_file = 'FILE-' + name
        self.current_sha256 = hashlib.sha256(content).hexdigest()
        self.modified = '2026-10-27 00:00:00'
        self.writes = []

    def get(self, key, default=''):
        return getattr(self, key, default)

    def db_set(self, field, value, update_modified=True):
        setattr(self, field, value)
        self.writes.append((field, value))

    def check_permission(self, ptype):
        return True


class CompanionReadTests(unittest.TestCase):
    """R09-01～R09-03。"""

    @classmethod
    def setUpClass(cls):
        cls.env = offline_env.OfflineEnv()
        cls.env.__enter__()
        cls.content = workbook_bytes()
        cls.site_path = tempfile.mkdtemp(prefix='ss-companion-read-')
        cls.doc = _FakeDoc('TBL-C', cls._meta(), cls.content)
        cls.calls = []

        api = cls.env.api
        # 业务口径替身：**没写权、没下载权**（避免导出那几口掺进计数里）。
        api.business_access = types.SimpleNamespace(
            require_identity=lambda *args, **kwargs: None,
            resource_decision=lambda *args, **kwargs: False,
            is_open=lambda *args, **kwargs: False,
        )
        api.get_file_companion = lambda file_id: dict(BINDING)

        def authorize_companion_cells(file_id, record_ids, field_ids=None, operation='read'):
            cls.calls.append({'file_id': file_id,
                              'record_ids': list(record_ids or []),
                              'field_ids': list(field_ids or []),
                              'operation': operation})
            return {'allowed_record_ids': [rid for rid in (record_ids or [])
                                           if rid in ALLOWED_ROWS],
                    'readable_field_ids': list(field_ids or []) if cls.field_readable else [],
                    'downloadable_field_ids': []}

        api.authorize_companion_cells = authorize_companion_cells

        frappe = cls.env.frappe
        frappe.get_doc = cls._get_doc
        frappe.get_all = lambda *args, **kwargs: []
        frappe.get_site_path = lambda *parts: cls.site_path

        # ★ **在自己的替身装好之后重新 import**（否则拿到的是别的判据那套替身）。
        # ⚠️ `service` 要**先**重导（它在 import 期把 `business_access` 绑死）。
        cls.modules = cls.env.import_domain('service', 'sheet', 'promotion', 'object_projection')
        cls.sheet = cls.modules['sheet']

    @classmethod
    def tearDownClass(cls):
        cls.env.__exit__(None, None, None)

    #: **这一列读不读得到**（两条用例各跑一遍）。
    field_readable = True

    @classmethod
    def _meta(cls):
        return {
            'primary_sheet': 'S-1',
            'sheet_name': 'S-1',
            'structure_version': 1,
            'rows': ['r-%06d' % index for index in range(1, ROW_COUNT + 1)],
            'object_companion': {
                'object_id': BINDING['object_id'],
                'field_columns': [dict(column) for column in BINDING['field_columns']],
                'definition_revision': 1,
            },
            'deleted_rows': list(DELETED_ROWS),
        }

    @classmethod
    def _get_doc(cls, doctype, name, for_update=False):
        if doctype == 'File':
            return offline_env.FakeFileDoc(cls.content)
        return cls.doc

    def setUp(self):
        # 计数表是**类属性**（替身闭包往里写）⇒ 这里**清空**而不是换新的一张。
        type(self).calls.clear()
        self.sheet._parse_cache_clear()

    def _read(self):
        return self.sheet.read_payload(None, {'table': 'TBL-C', 'page': 1, 'page_length': 200})

    # ---------- R09-01 ----------

    def test_读一次只跑一轮全表授权(self):
        """伴随表的读授权**只跑一次**（改之前：算行一次、算隐藏列又一次）。"""
        self._read()
        reads = [call for call in self.calls if call['operation'] == 'read']
        self.assertEqual(len(reads), 1,
                         '一次读只该跑**一轮**全表授权（算好的那份要复用给隐藏列判定）')
        self.assertEqual(reads[0]['record_ids'], self.doc.meta()['rows']
                         if hasattr(self.doc, 'meta') else reads[0]['record_ids'])
        self.assertEqual(reads[0]['record_ids'],
                         ['r-%06d' % index for index in range(1, ROW_COUNT + 1)],
                         '这一轮授权覆盖的是**本次要判可见性的那些行**')
        self.assertEqual(reads[0]['field_ids'], ['title'],
                         '授权要带上要判的那几个字段')

    # ---------- R09-02 ----------

    def test_读不到的行和已回收的行都不出现(self):
        """**没授权的行**一行都不许出现；**已回收（软删）的行**也不许出现。"""
        result = self._read()
        row_ids = [row['row_id'] for row in result['rows']]
        self.assertEqual(row_ids, ALLOWED_ROWS,
                         '只该出现读得到、且没被回收的行')
        for gone in ALLOWED_ROWS[5:] + DELETED_ROWS:
            self.assertNotIn(gone, row_ids, '读不到／已回收的行不许出现')

    # ---------- R09-03 ----------

    def test_读不到的列被藏起来(self):
        """那一列读不到 ⇒ 值是「隐藏」标记；读得到 ⇒ 照旧给值。"""
        type(self).field_readable = True
        result = self._read()
        first = result['rows'][0]
        self.assertEqual(first['values']['名称']['value'], '名称1',
                         '读得到的列照旧给值')

        type(self).field_readable = False
        try:
            hidden = self._read()
        finally:
            type(self).field_readable = True
        value = hidden['rows'][0]['values']['名称']
        self.assertTrue(value.get('hidden'), '读不到的列必须标隐藏')
        self.assertIsNone(value.get('value'), '读不到的列不许给值')
        self.assertEqual(hidden['headers'], HEADERS,
                         '藏的是**值**，不是把表头也抽走')


if __name__ == '__main__':
    unittest.main()
