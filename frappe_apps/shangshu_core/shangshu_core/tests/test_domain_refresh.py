"""example / 内核：**动作与工具登记的刷新**（2026-08-22 收进内核的那个口）。

**为什么要有这个**：以前域的动作登记只在**装域**时跑 ⇒ 改了动作／工具清单后，
`bench migrate` **不刷新** ⇒ 现场出现「动作未注册或已停用」⇒ 逼着人手工去跑
`ensure_foundation` / `install.setup`（**规矩不该靠人记得**）。
⇒ 规矩收进内核：域在贡献里声明 `refresh`，**migrate 时内核代各域刷新**。

**测试通过 = 什么成立**（一句话）：
「① 域的贡献里**声明了 refresh** 就能被内核刷新；② 故意把一个域动作从登记表里删掉，
刷新一次它**自己回来**（不用人工跑 install.setup）；③ `refresh` 入口的形状不对 ⇒ **当场拒**，
不许悄悄跳过（域刷不成功却看着像成功，是最坏的失败方式）。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_domain_refresh --skip-test-records
"""
import unittest

try:  # 没有 frappe 站点时跳过（别把环境缺失误报成判据失败）
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_core.tests.test_domain_refresh")
class TestDomainRefresh(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")

    def _declared(self):
        """声明了 refresh 的域贡献（**不写死哪个域**：谁声明了就算谁）。"""
        from shangshu_core import domains

        return [c for c in domains._providers() if str(c.get("refresh") or "").strip()]

    def test_a_domain_can_declare_its_own_refresh_entry(self):
        """① 域在贡献里声明 `refresh`（形状是「模块路径.函数名」）⇒ 内核能代它刷新。"""
        declared = self._declared()
        self.assertTrue(declared, "没有任何域声明 refresh ⇒ 内核根本无从代刷新")
        for contribution in declared:
            path = str(contribution["refresh"])
            module_name, _, attribute = path.rpartition(".")
            self.assertTrue(module_name and attribute, "refresh 入口形状不对：%s" % path)
            import importlib

            module = importlib.import_module(module_name)
            self.assertTrue(callable(getattr(module, attribute, None)),
                            "refresh 入口不可调用：%s" % path)

    def test_refreshing_puts_a_deleted_domain_action_back(self):
        """② 故意删掉一个域动作的登记 ⇒ 刷新一次它**自己回来**。"""
        from shangshu_core import domains
        from shangshu_core.actions import list_registered_actions

        declared = self._declared()
        if not declared:
            self.skipTest("本机没装任何声明 refresh 的域")
        domain_id = str(declared[0].get("id"))
        before = [str(a.get("id")) for a in list_registered_actions(tools_only=0)]
        domain_actions = [a for a in before if a.startswith(domain_id.split(".")[-1] + ".") or a.startswith("ip.")]
        if not domain_actions:
            self.skipTest("这个域没有可删的动作")
        victim = domain_actions[0]
        frappe.db.sql("DELETE FROM `tabShangshu Action Definition` WHERE action_id = %s", (victim,))
        frappe.db.commit()
        self.assertNotIn(victim, [str(a.get("id")) for a in list_registered_actions(tools_only=0)],
                         "删了却还在（探针失效）")
        domains.refresh_domain_contributions()
        frappe.db.commit()
        after = [str(a.get("id")) for a in list_registered_actions(tools_only=0)]
        self.assertIn(victim, after, "刷新之后 %s 没有回到登记表 ⇒ 域的刷新入口没起作用" % victim)

    def test_a_bad_refresh_entry_is_refused(self):
        """③ `refresh` 入口形状不对 ⇒ **当场拒**（不许悄悄跳过）。"""
        from shangshu_core import domains

        bad = {"id": "com.shangshu.core", "name": "坏入口", "version": "1.0.0",
               "platform_api": "1.x", "owner_app": "shangshu_core",
               "refresh": "这不是模块路径", "actions": [], "tools": []}
        with self.assertRaises(frappe.ValidationError):
            domains._validate_contributions([bad])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
