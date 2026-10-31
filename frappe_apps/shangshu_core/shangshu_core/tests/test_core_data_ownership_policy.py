"""内核「数据归属」两条口径的判据（**纯函数，裸跑就够，不需要 frappe 站点**）。

跑法：

    cd frappe_apps/shangshu_core && python3 -m unittest shangshu_core.tests.test_core_data_ownership_policy -v

**测试通过 = 什么成立**（一句话）：

「① **新建业务表不许再自建 DocType** —— 域的声明里**新出现**一个带 `doctype` 的对象，
内核当场点名拒（口径：**走晋升那条路**：表文件 → 全列晋升 → 受管对象 ＋ 受管记录）；
**存量的自建表不拦**（逐域重走晋升，拦了会挡住迁移），**域第一次登记也不拦**（那不是新增）；
② **域名下还有「没人接手的数据」**时，停用这个域会被点名拦住
（受管记录在内核的物理表里、DocType 行在 Frappe 里 ⇒ **域拆了数据不会跟着走**，
不点名就会静悄悄地变成孤儿数据）；**没有数据的域不被这条拦**。」

⚠️ 这两条是**内核**的口径（`shangshu_core`）⇒ 改动标 CORE-CANDIDATE。
"""

import unittest


class TestCoreDataOwnershipPolicy(unittest.TestCase):
    """内核两条口径的纯函数判据。"""

    def test_new_native_doctype_object_is_named_and_refused(self):
        """新建业务表 ⇒ 自建 DocType 被点名拒；存量不拦；首次登记不拦。"""
        from shangshu_core.data_ownership import new_native_table_violations

        old = {"objects": [{"id": "finance.invoice", "doctype": "Shangshu Finance Invoice"}]}
        new = {"objects": [{"id": "finance.invoice", "doctype": "Shangshu Finance Invoice"},
                           {"id": "finance.payable", "doctype": "Shangshu Finance Payable"}]}
        violations = new_native_table_violations(old, new)
        self.assertEqual(violations, ["finance.payable"],
                         "新出现的自建表没被点名（存量那一条不该算新增）")
        self.assertIn("finance.payable", str(violations))

        # **存量不拦**：老的那一条原样留着，不算违反。
        self.assertEqual(new_native_table_violations(old, old), [],
                         "存量自建表被算成新增了（会挡住逐域迁移）")

        # **首次登记不拦**：域刚装上时全部声明都是新的，那不是新增。
        self.assertEqual(new_native_table_violations(None, new), [],
                         "首次登记被当成新增了（域会装不上）")

        # **声明里没有 doctype 的对象**（受管对象那条路）**永远不算违反**。
        managed_only = {"objects": [{"id": "ip.email_template", "managed_title": "example 邮件模板"}]}
        self.assertEqual(new_native_table_violations(old, managed_only), [],
                         "受管对象那条路被算成自建表了")

    def test_orphan_data_is_named_before_a_domain_can_be_stopped(self):
        """名下还有数据 ⇒ 点名拦住；没有数据 ⇒ 不拦。"""
        from shangshu_core.data_ownership import orphan_data_blockers

        blockers = orphan_data_blockers("example", [("example 官文审核", 137),
                                                 ("example 邮件模板", 0)])
        self.assertEqual(len(blockers), 1, "只该有一条（没数据的那张表不该算）")
        self.assertIn("example 官文审核", blockers[0])
        self.assertIn("137", blockers[0])
        self.assertIn("没人接手", blockers[0])

        # **没有数据 ⇒ 不拦**（域停得掉）。
        self.assertEqual(orphan_data_blockers("example", [("example 邮件模板", 0)]), [],
                         "没数据的域被拦了")
        self.assertEqual(orphan_data_blockers("example", []), [], "没数据被拦了")


if __name__ == "__main__":
    unittest.main()
