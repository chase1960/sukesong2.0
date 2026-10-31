"""整份工作簿的下载权限：当前版与历史版。

**这条判据守什么**：受管表（晋升上来的表）这条链上，「整份下载」要求**每个晋升列
都读得到、且「下载」那一维有声明** —— 少一维 ⇒ **整份拒**；当前版与历史版**都**拒
（历史版不能成为旁路）。

⚠️ **2026-10-26 搬到新模型**（PKG-117-T01）：受管表链的列/表权限不再用旧的三个角色键
（`read_roles` / `write_roles` / `download_roles`），改成**「五个操作 × 主体三档」**
（读／写／筛／下载／助手 × 全局／部门／个人），声明挂在 `access` 键里。
所以本判据的夹具**换成新形状**，判定**用真的**：
域侧适配层 `shangshu_files.access_scope`（真模块）＋ 内核纯规则
`shangshu_core.subject_access`（真模块）—— 继承链与 fail-closed 都在内核那份里。

**为什么用真模块而不是抠函数**（2026-10-26 踩过）：旧的下载闸走
`_field_caps` → `access_scope.capabilities` → 内核 `field_subject_allows`，
**跨模块、还要 frappe 桩** ⇒ 把函数抠出来单独跑，必然缺依赖（`NameError`）。
所以这里**真装 app 路径、真导入 `shangshu_files.promotion`**，只对**模块级依赖**
（`load_definition` / `_load_meta` / `require_no_pending_writeback` /
`require_complete_row` / `_definition_fingerprint`）打桩。

**继承链（内核说了算）**：列的该操作 → 列的「读」（**只对筛/助手**）→ 表的该操作 →
表的「读」（**只对筛/助手**）→ 都没有 ⇒ **抛错 ⇒ 按拒算**。
⇒ **「下载」这一维没有「跟读走」**：列没声明、表也没声明 ⇒ 下载被拒（下面第 ② 条守的就是它）。

**测试通过 = 下面七条都成立**（一条都不许削弱）：
1. 没晋升列的工作簿 ⇒ 闸放行，回 `version_label == 'v3'`。
2. 读得到、但**下载没声明** ⇒ 整份下载被拒（当前版与历史版都拒）。
3. 显式给了下载、但**读被拒** ⇒ 还是拒（下载权盖不住读权）。
4. 显式给了下载 ⇒ 当前版过（`v3`）、历史版过（`v2`）。
5. 当前版有待写回 ⇒ 拒（`ValueError`）；历史版仍可用（`v2`）。
6. 「就绪」那个动作**不要求**导出权；但整份下载仍被拒。
7. 伴随对象：只要源的**读**，不因源不能下载而卡住；但整份下载仍会走到 download 并被拒
   （调用次序 `['read']` → `['read','read','download']`）。
"""
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/tests'))

from _f_module_seam import install_app_paths, install_stub_package  # noqa: E402 —— 路径要先装好

# 真 app 包进 `sys.path` ⇒ `import shangshu_files.promotion` 拿得到**真模块**。
install_app_paths('shangshu_files', 'shangshu_core')

from shangshu_core.subject_access import (  # noqa: E402 —— 内核纯规则层（**不碰 frappe**）
    field_allows_subject,
    normalize_access,
    normalize_scope,
)
from shangshu_core.subject_access import subject_allows as _pure_subject_allows  # noqa: E402


class Denied(Exception):
    """权限被拒（替 `frappe.PermissionError`）。"""


#: 「全局」主体范围（全员）。
GLOBAL = {'scope': 'global'}
#: 另一个人的个人档 —— 用来造「读被拒」（alice 不在里面）。
OTHER_USER = {'scope': 'personal', 'users': ['bob@example.com']}

#: 被下载的文件（`content_gate` / `row_require_ready` 都拿它当 doc）。
DOC = types.SimpleNamespace(status='Active', name='table', current_file='current',
                             version_count=4, check_permission=lambda need: None)


def _subject_context(user):
    """主体判定上下文的**不查库替身**。

    真实现（`org_admin.subject_context`）要查组织表 ⇒ 这条判据不查库。
    **全局**这一档不需要部门信息 ⇒ 够用；部门档/个人档照样按「 alice 不在名单里」判。
    """
    return {'user': str(user or ''), 'member_of': [], 'head_departments': []}


# ── 内核公开面：一半真、一半替身 ──
# · `normalize_access` / `normalize_scope`：**真的**（内核纯规则那份）。
# · `subject_allows` / `field_subject_allows`：**真规则 + 不查库的上下文**
#   （规则本体在 `shangshu_core.subject_access`；这里只把「查库拿组织事实」那步换掉）。
# · `subject_context`：**替身**（见上）。
# ⚠️ `field_subject_allows` 必须是**真规则**：第 ② 条「下载没声明 ⇒ 拒」靠的正是
# 「继承链走到底 ⇒ 抛错 ⇒ 域按拒算」—— 换成「不抛错的假实现」这条就假绿了。
public_api = types.SimpleNamespace(
    normalize_access=normalize_access,
    normalize_scope=normalize_scope,
    subject_context=_subject_context,
    subject_allows=lambda user, scope, ctx=None: _pure_subject_allows(
        scope, ctx or _subject_context(user)),
    field_subject_allows=lambda user, field, op, table_access=None, ctx=None:
        field_allows_subject(field, ctx or _subject_context(user), op, table_access),
)
sys.modules['shangshu_core.public_api'] = public_api

# ── 框架桩：frappe ──
# ⚠️ **不给 `get_roles`**：新模型按**主体**（人）判，不按角色 ⇒ 桩里也不该有角色口，
# 有的话说明还有人在走旧链。
install_stub_package('frappe', ValidationError=ValueError, PermissionError=Denied)
frappe = sys.modules['frappe']
frappe.session = types.SimpleNamespace(user='alice')
frappe.db = types.SimpleNamespace(get_value=lambda *a, **kw: 2)  # 历史版版本号 ⇒ v2
frappe.get_doc = lambda *a, **kw: DOC

# 真模块：`promotion.py` 顶层就 `from shangshu_files import access_scope` ⇒
# 域侧适配层与内核公开面都必须是**真的**（桩装好了才 import）。
from shangshu_files import promotion  # noqa: E402 —— 桩装好之后才 import

# 伴随对象的投影口：桩（真那个要连 `shangshu_files.sheet` 与真库，跑不动也测不到）。
# 只记**调用次序** —— 第 ⑦ 条守的就是「就绪只问读、整份下载才走到 download」。
sys.modules['shangshu_files.object_projection'] = types.SimpleNamespace(
    require_read=lambda doc: None, require_download=lambda doc: None)
# `row_require_ready` 要内容版本号；真模块要内核的 `WorkingFileTransaction` ⇒ 这里用桩。
sys.modules['shangshu_files.working_file'] = types.SimpleNamespace(
    content_revision=lambda doc: 4)


class Tests(unittest.TestCase):
    def setUp(self):
        self.cols = []
        self.table_access = {}
        self.meta = {}
        self.pending = False
        self.calls = []

        # 模块级依赖打桩（真模块上打桩，不是抠函数）：
        # · `load_definition` 回那份晋升定义（表级 `access` + 列清单）
        # · `_load_meta` 回文件元数据（第 ⑦ 条要它带 `object_companion`）
        # · `require_no_pending_writeback` 回「有没有待写回」
        # · `require_complete_row` / `_definition_fingerprint`：与本判据无关 ⇒ 固定回值
        patchers = [
            mock.patch.object(promotion, 'load_definition',
                              lambda doc: {'access': self.table_access, 'columns': self.cols}),
            mock.patch.object(promotion, '_load_meta', lambda doc: self.meta),
            mock.patch.object(promotion, 'require_no_pending_writeback', self._pending_gate),
            mock.patch.object(promotion, 'require_complete_row', lambda doc, row_id: {}),
            mock.patch.object(promotion, '_definition_fingerprint', lambda meta: 'definition'),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        # 伴随对象的两个口：真那个跑不动 ⇒ 用桩记次序（**每次重装**，别串到别的用例）。
        projection = types.SimpleNamespace(require_read=self._record_read,
                                           require_download=self._record_download)
        sys.modules['shangshu_files.object_projection'] = projection

    # ── 桩的实现 ──

    def _pending_gate(self, doc):
        if self.pending:
            raise ValueError('pending')

    def _record_read(self, doc):
        self.calls.append('read')

    def _record_download(self, doc):
        self.calls.append('download')
        raise Denied('source download denied')

    # ── 夹具：声明都是**新形状**（`access` 键） ──

    def _column(self, **access):
        """一个已晋升的列（`access` 键 = 五个操作各自的主体范围）。"""
        return {'promoted': True, 'field': 'f', 'access': access}

    def gate(self, file='current'):
        return promotion.content_gate('File', 'table', file)

    # ── 七条行为 ──

    def test_unpromoted_workbook_preserves_resource_policy(self):
        # 没晋升列 ⇒ 不进字段 ACL ⇒ 闸只判「有没有待写回」⇒ 放行，回 v3。
        self.assertEqual(self.gate()['version_label'], 'v3')

    def test_readable_promoted_column_without_download_declaration_denied(self):
        # 读得到、**下载没声明** ⇒ 下载这一维继承链走到底（列没有、表也没有）
        # ⇒ 内核抛错 ⇒ 域按拒算 ⇒ 整份拒。
        self.cols = [self._column(read=GLOBAL)]
        self.table_access = {'read': GLOBAL}
        for file in ('current', 'historical'):
            with self.assertRaises(Denied):
                self.gate(file)

    def test_explicit_download_right_does_not_override_hidden_read(self):
        # 列**显式**给了下载（全局），但读继承表级、而表级把 alice 排除在外
        # ⇒ 读被拒 ⇒ 整份拒（下载权盖不住读权）。
        self.cols = [self._column(download=GLOBAL)]
        self.table_access = {'read': OTHER_USER}
        with self.assertRaises(Denied):
            self.gate()

    def test_explicit_grant_passes_current_and_history(self):
        # 下载显式给了 ⇒ 当前版过（v3）、历史版过（v2）。
        self.cols = [self._column(read=GLOBAL, download=GLOBAL)]
        self.table_access = {'read': GLOBAL}
        self.assertEqual(self.gate()['version_label'], 'v3')
        self.assertEqual(self.gate('historical')['version_label'], 'v2')

    def test_pending_current_rejected_but_authorized_history_retained(self):
        # 当前版有待写回 ⇒ 拒；历史版是它自己那一版 ⇒ 仍可用。
        self.cols = [self._column(read=GLOBAL, download=GLOBAL)]
        self.table_access = {'read': GLOBAL}
        self.pending = True
        with self.assertRaises(ValueError):
            self.gate()
        self.assertEqual(self.gate('historical')['version_label'], 'v2')

    def test_ready_action_does_not_require_export_right(self):
        # 「就绪」这个动作只要求**读**得到（不要求下载权）⇒ 过；整份下载仍被拒。
        self.cols = [self._column(read=GLOBAL)]
        self.table_access = {'read': GLOBAL}
        self.assertTrue(promotion.row_require_ready(
            None, {'table': 'table', 'row_id': 'row'}, None)['ready'])
        with self.assertRaises(Denied):
            self.gate()

    def test_companion_ready_requires_source_read_but_not_source_download(self):
        # 伴随对象：就绪只问源的**读**；整份下载会一路走到 **download** 才被拒。
        self.meta = {'object_companion': {'object_id': 'source'}}
        self.assertTrue(promotion.row_require_ready(
            None, {'table': 'table', 'row_id': 'r'}, None)['ready'])
        self.assertEqual(self.calls, ['read'])
        with self.assertRaises(Denied):
            self.gate()
        self.assertEqual(self.calls, ['read', 'read', 'download'])


if __name__ == '__main__':
    unittest.main()
