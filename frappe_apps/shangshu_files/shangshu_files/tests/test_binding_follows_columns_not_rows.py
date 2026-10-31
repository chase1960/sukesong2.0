"""文件域 · **绑定要绑「列」，不是绑「行」**（2026-10-30 用户口径 · PKG-133）。

**用户原话**（2026-10-30 09:2x）：

> 「另外，**我司案号的自动化又没了**。」

**站上实测的根因**（不是猜的）：

* 那张表 `7mjs3ppe4u` 的 **结构版本已经是 116**，而晋升定义**绑在结构版本 78** ⇒
  `binding_current = False` ⇒ 候选读被拒：
  「**晋升定义与当前表结构不一致，请先核对绑定**」（417）
  ⇒ **案号候选算不出来 ⇒ 自动化死了**。
* **为什么会漂**：`structure_version` **行操作也在顶**（插行／删行／排序）⇒
  人只是加了几行、删了几行 ⇒ **列结构根本没变** ⇒
  绑定却被判成「对不上当前结构」⇒ **自动化说没就没**。

**测试通过 = 什么成立**（一句话）：

> 「① **行操作把结构版本顶上去**（表头一个字没动）⇒ **绑定仍然有效**
>    （定义绑的是**列**，不是行）；
>   ② **列结构真的变了**（受管列**少一个／改了一个名**）⇒ **绑定失效**
>    （该拦还是要拦 —— 正式值是按列名绑的，列没了就该让人来核对）；
>   ③ **列的先后变了／普通列插在中间** ⇒ 绑定**仍然有效**
>    （正式值按**列名**认列 ⇒ 先后不相关）；
>   ④ 结构版本**没变** ⇒ 有效（老口径一个字没改）。」

⚠️ **为什么这条判据跑在站上**（`FrappeTestCase`）：
`promotion` 的导入链会拉到 `model_records` ⇒ `pypika`（离线装不上）
⇒ 离线判据**照不到它** ⇒ 这条只能跑在站上（与 `test_required_is_reminder.py` 同一路子）。

⚠️ **为什么判定用「表头还在不在」而不是「版本号有没有变」**：
定义里的每一列都是**按表头名**绑的（正式值按 `行 ＋ 字段` 存，表头是那张表的列名）
⇒ **表头都还在 ⇒ 定义还对得上这张表**；表头少一个 ⇒ 定义指向了一根不存在的列
⇒ 该让人来核对。**行有几行、有没有排序，跟定义绑不绑得上没有关系。**
"""
import unittest

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_files import promotion


class TestBindingFollowsColumnsNotRows(FrappeTestCase):
    """绑定跟**列**走（行操作不该把绑定顶掉）。"""

    HEADERS = ["我司案号", "申请号", "案号方向", "申请途径"]

    def _meta(self, *, structure_version, headers=None, bound_version=78, columns=None):
        """造一份**表 meta**（就是 `sheet_meta_json` 里那份）。"""
        return {
            "structure_version": structure_version,
            "headers": list(self.HEADERS if headers is None else headers),
            "promotion": {
                "definition_version": "1",
                # 绑定那一刻的结构版本（老口径的锚）
                "structure_version": bound_version,
                "columns": columns if columns is not None else [
                    {"header": "我司案号", "field": "our_case_no", "promoted": True},
                    {"header": "申请号", "field": "application_no", "promoted": True},
                    {"header": "案号方向", "field": "case_direction", "promoted": True},
                    {"header": "申请途径", "field": "application_route", "promoted": True},
                ],
            },
        }

    def _binding_current(self, meta):
        definition = promotion._definition_from_meta(meta, "T-BIND-1")
        return definition.get("binding_current")

    # ---------- ① 行操作顶了版本号 ⇒ 绑定仍然有效 ----------

    def test_行操作顶了结构版本_绑定仍然有效(self):
        """① **插行/删行/排序**把结构版本顶上去（表头没动）⇒ **绑定仍然有效**。"""
        meta = self._meta(structure_version=116, bound_version=78)
        self.assertIs(
            self._binding_current(meta), True,
            "行操作不该把绑定顶掉（绑定绑的是列）—— 顶掉了案号自动化就死了",
        )

    def test_版本差很多_绑定仍然有效(self):
        """①b 版本差得再多也**不改变**判定（只要列还在）。"""
        meta = self._meta(structure_version=9999, bound_version=1)
        self.assertIs(self._binding_current(meta), True, "版本差多少都不该改判定（列还在就还对得上）")

    # ---------- ② 列结构真变了 ⇒ 绑定失效（该拦还是要拦） ----------

    def test_表头少了一个_绑定失效(self):
        """② 定义里那个表头**没了** ⇒ 绑定失效（要人来核对）。"""
        meta = self._meta(structure_version=78, headers=["我司案号", "申请号", "案号方向"], bound_version=78)
        self.assertIs(self._binding_current(meta), False, "表头少了一个还说绑定有效 ⇒ 会读到不存在的列")

    def test_表头改了一个_绑定失效(self):
        """②b 定义里那个表头**改名了** ⇒ 绑定失效。"""
        meta = self._meta(structure_version=78, headers=["我司案号", "申请号", "案号方向", "申请途径2"], bound_version=78)
        self.assertIs(self._binding_current(meta), False, "表头改名了还说绑定有效 ⇒ 正式值会绑到别的列上")

    def test_受管列挪了位置_绑定仍然有效(self):
        """②c 受管列**被挪了位置** ⇒ 绑定**仍然有效**
        （正式值按**列名**认列 ⇒ 列的先后跟绑定没关系
        —— 2026-10-30 实测：那张表的列顺序与定义里记的不一样，
        用先后去判 ⇒ 白白把绑定判死 ⇒ 自动化说没就没）。"""
        meta = self._meta(structure_version=79, headers=["申请号", "我司案号", "案号方向", "申请途径"], bound_version=78)
        self.assertIs(self._binding_current(meta), True,
            "受管列挪了位置就把绑定顶掉了 ⇒ 人挪一列，案号自动化就没了")

    def test_普通列插在中间_绑定仍然有效(self):
        """②d **普通列**插在受管列中间 ⇒ 绑定**仍然有效**
        （那些列不是这份定义管的 ⇒ 不该由它们把绑定顶掉）。"""
        meta = self._meta(structure_version=79,
                          headers=["我司案号", "专利名称", "申请号", "案号方向", "申请途径"],
                          bound_version=78)
        self.assertIs(self._binding_current(meta), True,
            "普通列插在中间就把绑定顶掉了 ⇒ 人加一列，案号自动化就没了")

    # ---------- ③ 老口径没变 ----------

    def test_版本没变_绑定有效(self):
        """③ 结构版本没动 ⇒ 绑定有效（老口径一个字没改）。"""
        meta = self._meta(structure_version=78, bound_version=78)
        self.assertIs(self._binding_current(meta), True, "版本没变却说绑定无效")

    def test_没有定义_没有绑定(self):
        """③b 根本没立过定义 ⇒ 没有绑定（`None`，不是 True 也不是 False）。"""
        meta = {"structure_version": 10, "headers": list(self.HEADERS)}
        definition = promotion._definition_from_meta(meta, "T-BIND-1")
        self.assertIsNone(definition.get("binding_current"), "没定义却报了一个绑定状态")
        self.assertFalse(definition.get("promoted"), "没定义却说是晋升表")


if __name__ == "__main__":
    unittest.main()
