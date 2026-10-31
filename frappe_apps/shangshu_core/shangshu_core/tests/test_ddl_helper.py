"""内核：**DDL 的独立事务**（2026-08-22 收进内核的那个口）。

**为什么要有这个**：MariaDB 的 DDL（`CREATE`/`DROP`/`ALTER`/`TRUNCATE`）会**隐式提交** ⇒
Frappe 拒绝「在有写事务里做 DDL」（报 *This statement can cause implicit commit*）。
⇒ 于是每个域、每个脚本都得自己记「**先 commit 再 DDL**」——**这规矩该在内核**。

**测试通过 = 什么成立**（一句话）：
「① `execute_ddl` 能安全地建表/删表（**不**再被隐式提交拦）；② DDL 之前的事务**已经提交**
（不会被 DDL 顺手带进隐式提交里）；③ DDL **失败**时事务干净（不会把别处的写留在半路）。」

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_ddl_helper --skip-test-records
"""
import unittest

try:  # 没有 frappe 站点时跳过（别把环境缺失误报成判据失败）
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_core.tests.test_ddl_helper")
class TestDdlHelper(FrappeTestCase):
    TABLE = "tab_shangshu_ddl_probe"

    def tearDown(self):
        try:
            from shangshu_core.database import execute_ddl

            execute_ddl("DROP TABLE IF EXISTS `%s`" % self.TABLE)
        except Exception:
            pass
        super().tearDown()

    def test_ddl_can_create_and_drop_a_table(self):
        """① 建表 ＋ 删表都能成（不再被「有写事务里做 DDL」拦）。"""
        from shangshu_core.database import execute_ddl

        execute_ddl("DROP TABLE IF EXISTS `%s`" % self.TABLE)
        execute_ddl("CREATE TABLE `%s` (id INT PRIMARY KEY, note VARCHAR(32))" % self.TABLE)
        self.assertTrue(frappe.db.sql("SHOW TABLES LIKE %s", (self.TABLE,)), "表没建起来")
        execute_ddl("DROP TABLE IF EXISTS `%s`" % self.TABLE)
        self.assertFalse(frappe.db.sql("SHOW TABLES LIKE %s", (self.TABLE,)), "表没删掉")

    def test_writes_before_ddl_are_committed_not_implicitly_rolled_back(self):
        """② DDL 之前的写**已经提交** ⇒ DDL 的隐式提交不会把别处的写搞乱。"""
        from shangshu_core.database import execute_ddl

        marker = "ddl-probe-%s" % frappe.generate_hash(length=8)
        frappe.db.sql("CREATE TABLE IF NOT EXISTS `tab_shangshu_ddl_marker` (note VARCHAR(64))")
        frappe.db.sql("INSERT INTO `tab_shangshu_ddl_marker` (note) VALUES (%s)", (marker,))
        execute_ddl("DROP TABLE IF EXISTS `%s`" % self.TABLE)
        found = frappe.db.sql("SELECT note FROM `tab_shangshu_ddl_marker` WHERE note = %s", (marker,))
        self.assertTrue(found, "DDL 之前的写没保住（隐式提交把事务搞乱了）")
        frappe.db.sql("DROP TABLE IF EXISTS `tab_shangshu_ddl_marker`")

    def test_a_failed_ddl_leaves_the_transaction_usable(self):
        """③ DDL **失败** ⇒ 事务干净（还能继续用），不留半截状态。"""
        from shangshu_core.database import execute_ddl

        with self.assertRaises(Exception):
            execute_ddl("THIS IS NOT SQL")
        # 失败之后连接还能正常查东西（没被留在坏状态）。
        self.assertEqual(frappe.db.sql("SELECT 1")[0][0], 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
