"""文件域 · **必填列空着 ⇒ 不拦保存，只提醒**（2026-10-30 用户口径 · PKG-133）。

**用户原话**（2026-10-30 08:0x）：

> 「有必填列的表的空行，在**行写入保存**的时候要 check 必填列是否为空，
>  如果空了就**把必填列给框起来用红色**，并且在 **toast 提醒**，
>  但是**不强制不能保存**（因为**我一行要一个格子一个格子输入**），
>  然后**每一次刷新都自检一下**必填列有没有被填入，
>  没有被填入就**用红色继续框和提醒**。」

**测试通过 = 什么成立**（一句话）：

「一条**必填列空着**的行 ⇒
　① **写得进去**（**不拦保存**）—— 一格一格输入的路走得通；
　② 但**缺项仍要算得出来**（`row_readiness` 报 `draft` ＋ `missing_fields`）
　　⇒ 前端据此**框红** ＋ **toast 提醒**（前端那侧另有一条判据）；
　③ 而**类型错**（不是空、是不认的写法）**照旧拒**（那不是「没填」，是「填错了」）；
　④ 「**能不能留空**」（harness-values 的 `nullable` 语义）**一个字没改**
　　（它读的是**模型字段**的 required，不是文件域这条规则闸）。」

⚠️ **为什么改这里**（不改会怎样）：
　`promotion._check_rules` 原来把「必填列写空」**当场拒**
　（真站实测：「案号方向：不能为空（你打了 ''）。本次没写进数据库、也没清空格子」）
　⇒ 而用户是**一行一格一格输入**的 ⇒ 第一格还没填到必填列 ⇒ **整行都存不进去**
　⇒ 人根本没法把一行填完。⇒ **必填从「拦路」改成「提醒」**。

⚠️ **为什么这条判据跑在站上**（`FrappeTestCase`）：
　`promotion` 的导入链会拉到 `model_records` ⇒ `pypika`（离线装不上）
　⇒ 离线判据**照不到它** ⇒ 这条只能跑在站上（与 `test_promotion_managed.py` 同一路子）。

⚠️ **为什么 `nullable`（能不能留空）一个字没动**：
　`input_constraints.py` 读的是**模型字段**的 `required`（内核那条），
　**不是**文件域这条规则闸 ⇒ 改 `_check_rules` **碰不到**它
　⇒ harness-values 那三项输入约束的语义**不受影响**。
"""
import unittest

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_files import promotion


class TestRequiredIsAReminderNotAWall(FrappeTestCase):
    """必填列空着 ⇒ 不拦保存（但要算得出缺项，好让前端框红＋提醒）。"""

    def _col(self, **rules):
        base = {"header": "案号方向", "type": "text", "rules": {"required": True}}
        base["rules"].update(rules)
        return base

    # ---------- ① 必填列写空 ⇒ 不拒（能存进去）----------

    def test_必填列写空_不拒(self):
        """① **必填列空着照样写得进去**（一格一格输入的路走得通）。"""
        col = self._col()
        self.promotion_check(col, "")
        self.promotion_check(col, None)

    def test_必填列写空白_不拒(self):
        """只有空格的写法**也当空**（不拦）。"""
        self.promotion_check(self._col(), "   ")

    def test_类型错_照旧拒(self):
        """③ **填错了**（不是空、是不认的写法）⇒ **照旧拒**。"""
        col = {"header": "金额", "type": "number", "rules": {"required": True}}
        with self.assertRaises(frappe.ValidationError):
            promotion._check_rules(col, "甲")
        col = {"header": "开关", "type": "boolean", "rules": {"required": True}}
        with self.assertRaises(frappe.ValidationError):
            promotion._check_rules(col, "是")

    def test_范围错_照旧拒(self):
        """范围不对（min/max）**照旧拒**（那是「填错了」，不是「没填」）。"""
        col = {"header": "金额", "type": "number", "rules": {"required": True, "min": 0}}
        with self.assertRaises(frappe.ValidationError):
            promotion._check_rules(col, -7)

    # ---------- ② 缺项仍要算得出来（前端据此框红＋提醒）----------

    def test_行就绪状态_报出缺哪些必填列(self):
        """② 那一行**缺哪些必填列**要算得出来 ⇒ 前端据此**框红** ＋ **toast**。"""
        definition = {"columns": [
            {"header": "案号方向", "field": "case_direction", "type": "text",
             "promoted": True, "rules": {"required": True}},
            {"header": "申请途径", "field": "case_route", "type": "text",
             "promoted": True, "rules": {"required": True}},
            {"header": "专利名称", "field": "title", "type": "text",
             "promoted": True, "rules": {}},
        ]}
        row = {"case_direction": "", "case_route": "", "title": "一个案子"}
        state = promotion.row_readiness(definition, row)
        self.assertEqual(state["status"], "draft",
                         "必填列空着 ⇒ 这一行还没齐（前端要据此提醒）")
        self.assertEqual(sorted(state["missing_fields"]), ["case_direction", "case_route"],
                         "要说清**缺哪两列**（前端据此框红）")

    def test_行齐了_就是就绪(self):
        """必填列都填上了 ⇒ 这一行**就绪**（不再提醒）。"""
        definition = {"columns": [
            {"header": "案号方向", "field": "case_direction", "type": "text",
             "promoted": True, "rules": {"required": True}},
        ]}
        state = promotion.row_readiness(definition, {"case_direction": "DD"})
        self.assertEqual(state["status"], "ready", "填齐了就不该再提醒")
        self.assertEqual(state["missing_fields"], [])

    # —— 工具 ——

    @staticmethod
    def promotion_check(col, value):
        """不抛异常 ＝ 不拦保存（直接调被测的那道闸）。"""
        promotion._check_rules(col, value)


if __name__ == "__main__":
    unittest.main()
