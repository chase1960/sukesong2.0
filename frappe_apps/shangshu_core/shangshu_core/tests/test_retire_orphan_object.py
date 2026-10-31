"""内核：**退役口能退「孤儿受管对象」**（应用已经没了的那种）。

**测试通过 = 什么成立**（一句话）
「一个受管对象，它**所属的应用已经不在**（孤儿）
　⇒ **照样能退役**：下线 ＋ DROP 物理表 ＋ 删 DocType ＋ 留退役记录
　⇒ **不再**因为「应用找不到」而当场拒（那会让它**永远退不掉**、物理表一直占库）。」

⚠️ **为什么要有这一份**（2026-10-30 真站实测撞出来的）：
　清理判据残留时发现：47 个残留对象里 **45 个已退成**，剩 **2 个退不掉** ——
　它们的**应用已经被删了**（判据跑完、文件回收后有人清了应用），
　而内核退役口的第一步 `write_zone_schema.lock_model` 里有一句
　`frappe.get_doc(APPLICATION, hint.application, for_update=True)`
　⇒ **应用不在 ⇒ 当场拒** ⇒ 这 2 个对象**永远退不掉**、物理表一直占库。
　⇒ 这不是「按设计拒绝」，是**退役口少了一条路**。

⚠️ **不许放宽成「引用检查也跳过」**：
　· 「还被别的对象引用着」⇒ **照旧拒**（那是有在用的）；
　· 「应用不在」⇒ **只跳这一步**（应用本来就没了，没什么可解绑的）；
　· 退役记录**照样写**（`application` 字段照旧记下那个 id，审计要留）。

⚠️ **物理表与 DocType 的清理一个字不许少** —— 那才是占库的元凶。
"""
import os
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))


def _core_file(name):
    """**模块文件就在判据的上一层**（`tests/` 的上一级）⇒ 本地与容器同一套相对路径。"""
    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.join(here, "..", name)
    if os.path.exists(candidate):
        return os.path.abspath(candidate)
    raise FileNotFoundError(name)
LIFECYCLE = os.path.join(REPO, "frappe_apps", "shangshu_core", "shangshu_core", "model_lifecycle.py")
WRITE_ZONE = os.path.join(REPO, "frappe_apps", "shangshu_core", "shangshu_core", "write_zone_schema.py")


class TestRetireOrphanManagedObject(unittest.TestCase):
    """**孤儿受管对象**（应用已经没了）也要能退役。"""

    @staticmethod
    def _lifecycle():
        with open(_core_file("model_lifecycle.py"), encoding="utf-8") as handle:
            return handle.read()

    @staticmethod
    def _write_zone():
        with open(_core_file("write_zone_schema.py"), encoding="utf-8") as handle:
            return handle.read()

    def test_锁模型那一步不许因为应用不在就炸(self):
        """`lock_model` 里读应用那一步 ⇒ **应用不在时不能抛**。"""
        source = self._write_zone()
        self.assertIn("def lock_model", source, "找不到 lock_model")
        start = source.index("def lock_model")
        body = source[start:start + 1600]
        # —— **读应用那一步要「不在时也返回」**（不许直接 get_doc 炸掉）——
        #    代码里用的是**常量** `APPLICATION`（不是字面量表名）⇒ 认常量。
        self.assertIn("APPLICATION", body, "lock_model 里没有读应用那一步（实现变了？）")
        self.assertTrue(
            "exists" in body,
            "lock_model 里读应用那一步**没有容错**（没先判存在）⇒ 应用一没就当场拒"
            " ⇒ 孤儿受管对象**永远退不掉**（物理表一直占库）")

    def test_退役口那条路_应用不在也要把物理表清掉(self):
        """**占库的是物理表** ⇒ 孤儿也必须 DROP 掉。"""
        source = self._lifecycle()
        start = source.index("def retire_managed_object")
        body = source[start:start + 3200]
        self.assertIn("DROP TABLE IF EXISTS", body, "退役口没有 DROP 物理表")
        self.assertIn("delete_doc('DocType'", body, "退役口没有删 DocType")
        # —— **退役记录照旧要写**（审计要留）——
        self.assertIn("RETIREMENT", body, "退役口没有写退役记录")

    def test_还在被引用的_照旧拒(self):
        """⚠️ **不许把引用检查也一起放宽** —— 有在用的对象照旧要拒。"""
        source = self._lifecycle()
        start = source.index("def retire_managed_object")
        body = source[start:start + 3200]
        self.assertIn("_referencing_objects", body,
            "退役口没有引用检查 ⇒ 会把**还在用**的对象也退掉")
        self.assertIn("先解除引用再退役", body,
            "退役口没有「还被引用就拒」那道闸")


if __name__ == "__main__":
    unittest.main()
