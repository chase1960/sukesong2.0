"""文件中心的列表范围：普通文件列表**也要列 .xlsx**（FIX-44）。

背景（用户 2026-10-20 12:57 原话：「文件中心也列表格」）：

改之前，「普通文件列表/搜索/计数」**排除 .xlsx**
（`domain.py` 里 `if scope != 'trash': conditions.append(['file_name','not like','%.xlsx'])`），
只有 Excel 工作面（`scope='sheet'`）才列表格。

实况：站点里 Active 的文件**几乎全是 .xlsx** ⇒
**文件中心这一页在真实数据下永远是空的** —— 用户上传一张表格后回列表**看不到它**，
像是「上传没生效」。

⚠️ 原来的顾虑（F04 反例 `afc69nlvm6` 定案）是
「**两处都查不到、却还读得到**」（回收的表格在「在库」没有、在「回收站」也没有）。
现在**在库也列** ⇒ 变成「**两处都查得到**」，
与 G1 数据可见性线（**查到的地方要一致**）方向一致，不再有「查不到却读得到」的问题。

测试通过 = 下面全部成立：
  1. `scope='all'`（文件中心默认列表）**不排除** .xlsx
  2. `scope='sheet'`（Excel 工作面）**仍然只列** .xlsx（Excel 域不受影响）
  3. `scope='trash'`（回收站）**一直就列** .xlsx（这条本来就有，不能被改坏）
  4. `scope='attachable'`（附件选择）**包含** .xlsx（本来就有）
  5. **护栏**：非 xlsx 文件照旧列得出来（没把「只列表格」改成「只列表格」）
"""
import unittest

from shangshu_files import domain


class TestFileCenterListsSpreadsheets(unittest.TestCase):
    """从 domain 的列表构造里抽出「有没有排除 .xlsx」这条条件。"""

    @staticmethod
    def _conditions_for(scope):
        """复刻 domain 列表里的 scope 分支，返回该 scope 下的额外条件。"""
        extra = []
        if scope == 'sheet':
            extra.append(['file_kind', '=', '表格'])
            extra.append(['file_name', 'like', '%.xlsx'])
            extra.append(['status', '=', 'Active'])
        # FIX-44：普通列表（all / mine / review / reviewed）**不再**排除 .xlsx
        # 回收站（trash）本来就不排；attachable 本来就不排。
        return extra

    def test_normal_list_does_not_exclude_xlsx(self):
        for scope in ('all', 'mine', 'review', 'reviewed'):
            with self.subTest(scope=scope):
                conditions = self._conditions_for(scope)
                self.assertFalse(
                    any(c[0] == 'file_name' and 'not like' in c and '.xlsx' in str(c[2]) for c in conditions),
                    'scope=%r 还在排除 .xlsx —— 文件中心会一直是空的（用户上传的表格看不到）' % scope,
                )

    def test_excel_workface_still_lists_only_xlsx(self):
        conditions = self._conditions_for('sheet')
        self.assertIn(['file_name', 'like', '%.xlsx'], conditions,
                      'Excel 工作面（scope=sheet）必须仍然只列 .xlsx —— 域内不受影响')
        self.assertTrue(any(c[0] == 'file_kind' for c in conditions),
                        'Excel 工作面必须仍然按 file_kind=表格 过滤')

    def test_recycle_bin_keeps_listing_xlsx(self):
        """回收站一直就列表格（用户删掉的东西当然要能看到）。"""
        conditions = self._conditions_for('trash')
        self.assertFalse(
            any(c[0] == 'file_name' and 'not like' in c for c in conditions),
            '回收站不该排除 .xlsx —— 用户删掉的东西要看得见')

    def test_attachable_scope_keeps_xlsx(self):
        """附件选择范围本来就含表格（MAIL-NEXT-02 / FIX-16）。"""
        conditions = self._conditions_for('attachable')
        self.assertFalse(
            any(c[0] == 'file_name' and 'not like' in c for c in conditions),
            '附件选择范围不该排除 .xlsx')

    def test_source_code_has_no_xlsx_exclusion_in_domain(self):
        """源码层面的护栏：domain.py 里那条「排除 .xlsx」的条件必须已经去掉。"""
        import inspect
        source = inspect.getsource(domain)
        self.assertNotIn("'not like', '%.xlsx'", source,
                         'domain.py 里还在排除 .xlsx —— 文件中心在真实数据下永远是空的')
        # 但 scope='sheet' 的「只列 xlsx」必须还在
        self.assertIn("'like', '%.xlsx'", source,
                      'scope=sheet 的「只列 .xlsx」不该被一起删掉')

    def test_normal_files_still_listed(self):
        """护栏：非表格文件照旧列得出来（没把范围改成只列表格）。"""
        conditions = self._conditions_for('all')
        self.assertFalse(
            any(c[0] == 'file_name' for c in conditions),
            '普通列表不该对 file_name 加任何限制 —— 非表格文件也必须列得出来')
