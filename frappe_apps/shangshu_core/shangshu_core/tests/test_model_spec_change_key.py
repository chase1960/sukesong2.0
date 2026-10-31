"""内核 · **模型规格变了**（编译器行为变了）时，同一把声明键**不该**撞（2026-10-30 · PKG-133 · W2）。

**测试通过 = 什么成立**（一句话）：

「同一张表、**同一份声明**（列清单、权限都没动），
　但**模型规格变了**（内核编译器产出的物理列规格变了 —— 比如
　「从现在起必填」的字段从「物理列也必填」改成「物理列不标 reqd」）
　⇒ 那**是另一件事**（要另起一次模型变更、要另跑一次迁移）
　⇒ **不该**被当成「同一把键配了不同载荷」而拒
　（人看到的话是「幂等键已用于不同对象变更」——**说的是键，说的是变更，人完全看不懂**）。」

⚠️ **为什么要有这一条**（2026-10-30 站上实测撞出来的）：
　`files.promotion_define` 提交同一份声明时，会走
　`_unchanged_promotion_definition` → 比**编译后**的模型与已生效的模型
　⇒ 编译器行为一改 ⇒ 编译结果就变了 ⇒ 进「另起一次模型变更」那条路
　⇒ 而那把变更键**只带声明指纹**（`promotion-access:{表}:{声明指纹前16位}`）
　　⇒ **声明没变 ⇒ 键没变** ⇒ 撞上**上一次**那条变更
　⇒ 内核判「这把键配了不同内容」⇒ 拒（`幂等键已用于不同对象变更`）
　⇒ **后果**：内核改一行编译器行为 ⇒ 那张表**再也晋升不上去**（人完全无从下手）。
　⇒ 修法：变更键**要带上编译后模型的指纹**（模型规格变了 ⇒ 就是另一件事 ⇒ 另一把键）。

⚠️ **为什么判据只碰纯模块**：
　`promotion_records` 依赖 frappe 站点（`frappe.get_doc` 那些）
　⇒ 离线判据测不了 ⇒ 被测的那段逻辑（**键怎么算**）抽成**纯函数**
　（`promotion_records.change_key_for`）⇒ 判据直接测它。
"""
import sys
import unittest
from pathlib import Path

CORE_ROOT = Path(__file__).resolve().parents[2]      # frappe_apps/shangshu_core
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))


def _public_frappe_stub():
    """**公共那一份**拟真替身（仓里只许有那一份造 frappe 替身）。"""
    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / "scripts" / "shangshu_testkit"
        if candidate.is_dir():
            if str(candidate.parent) not in sys.path:
                sys.path.insert(0, str(candidate.parent))
            from shangshu_testkit import frappe_stub
            return frappe_stub
    return None


class TestModelSpecChangeGetsItsOwnKey(unittest.TestCase):
    """模型规格变了 ⇒ 变更键要变（否则「同一把键配了不同内容」⇒ 晋升再也做不成）。"""

    def setUp(self):
        stub = _public_frappe_stub()
        if stub is None:
            self.skipTest("工具区不在（站上布局）⇒ 这条判据离线跑")
        self.installed = stub.install_minimal_frappe()
        self.addCleanup(stub.uninstall_minimal_frappe, self.installed)
        import importlib
        from shangshu_core import promotion_records
        self.promotion_records = importlib.reload(promotion_records)

    def test_同一份声明_同一份模型规格_键相同(self):
        """同一件事 ⇒ 同一把键（幂等仍成立）。"""
        compiled = {"fields": [{"id": "a", "required": True}], "title": "表"}
        one = self.promotion_records.change_key_for(
            "app-1", "identity-1", "promotion-access:表:abc", compiled)
        two = self.promotion_records.change_key_for(
            "app-1", "identity-1", "promotion-access:表:abc", compiled)
        self.assertEqual(one, two)

    def test_模型规格变了_键要变(self):
        """① **模型规格变了** ⇒ 键要变（那是另一件事 ⇒ 不撞上一次那条变更）。"""
        before = {"fields": [{"id": "a", "required": True, "reqd": 1}], "title": "表"}
        after = {"fields": [{"id": "a", "required": True, "reqd": 0}], "title": "表"}
        key_before = self.promotion_records.change_key_for(
            "app-1", "identity-1", "promotion-access:表:abc", before)
        key_after = self.promotion_records.change_key_for(
            "app-1", "identity-1", "promotion-access:表:abc", after)
        self.assertNotEqual(key_before, key_after,
                            "模型规格变了 ⇒ 变更键必须变（否则撞上一次那条变更 ⇒ 晋升再也做不成）")

    def test_声明指纹变了_键也要变(self):
        """② **声明指纹**变了（入参那个键）⇒ 键也变（老口径照旧）。"""
        compiled = {"fields": [{"id": "a", "required": True}], "title": "表"}
        key_a = self.promotion_records.change_key_for(
            "app-1", "identity-1", "promotion-access:表:abc", compiled)
        key_b = self.promotion_records.change_key_for(
            "app-1", "identity-1", "promotion-access:表:xyz", compiled)
        self.assertNotEqual(key_a, key_b)

    def test_应用或身份不同_键不同(self):
        """③ 不同应用／不同身份 ⇒ 键不同（不能串）。"""
        compiled = {"fields": [{"id": "a"}], "title": "表"}
        keys = {
            self.promotion_records.change_key_for("app-1", "id-1", "k", compiled),
            self.promotion_records.change_key_for("app-2", "id-1", "k", compiled),
            self.promotion_records.change_key_for("app-1", "id-2", "k", compiled),
        }
        self.assertEqual(len(keys), 3)


if __name__ == "__main__":
    unittest.main()
