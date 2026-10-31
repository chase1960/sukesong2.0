"""内核 · **失败过的幂等键不会被旧版本永久钉死**（2026-10-30 · PKG-133 · W2）。

**测试通过 = 什么成立**（一句话）：

「一把**失败过**的幂等键，它钉的那个动作版本**已经被重新登记掉**（版本进位）
　⇒ 重新执行时**改绑到当前版本**继续（**不**报「动作未注册或已停用」——
　那句话说的是**动作**没了，其实是**版本**没了 ⇒ 误导，且解不开）；
　而一把**成功过**的键 ⇒ 版本**仍然钉死**（重放不许悄悄换语义）。」

⚠️ **为什么要有这一条**（站上实测撞出来的）：
　example 域那个「把值域挂到晋升定义上」的动作，用的是一把**固定**的幂等键
　（表 ＋ 定义版本）⇒ 第一次失败后，这把键就**永久**钉在当时的动作版本上
　⇒ 那个版本后来进位了（`files.promotion_define` 1.0.0 → 1.3.0）
　⇒ 这把键再也执行不了 ⇒ 人看到的却是「动作未注册或已停用」。
　⇒ 失败过的那次（副作用**整体回滚**了）**允许改绑**到当前版本。
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


class _Identity:
    name = "identity-1"
    enterprise_id = "default"


class _Request:
    def __init__(self, status, action_version, request_hash="hash-1"):
        self.actor_identity = "identity-1"
        self.enterprise_id = "default"
        self.action_id = "files.promotion_define"
        self.action_version = action_version
        self.request_hash = request_hash
        self.status = status


class TestFailedRequestVersionRebind(unittest.TestCase):
    """失败过的那次幂等请求：版本被重新登记掉时允许改绑。"""

    def setUp(self):
        stub = _public_frappe_stub()
        if stub is None:
            self.skipTest("工具区不在（站上布局）⇒ 这条判据离线跑")
        self.installed = stub.install_minimal_frappe()
        self.addCleanup(stub.uninstall_minimal_frappe, self.installed)
        import importlib
        from shangshu_core import action_requests
        self.action_requests = importlib.reload(action_requests)

    def test_a_failed_request_may_rebind_to_the_current_version(self):
        """**失败过**的那次 ⇒ 允许改绑到当前版本（副作用已回滚 ⇒ 重跑是干净的）。"""
        request = _Request("Failed", "1.0.0",
                           request_hash=self.action_requests.fingerprint({}, ()))
        self.action_requests.assert_binding(
            request, _Identity(), "files.promotion_define", "1.3.0", {},
            allow_version_drift=True)
        self.assertEqual(request.action_version, "1.3.0",
                         "失败过的那次没有改绑到当前版本 ⇒ 这把键会被旧版本永久钉死")

    def test_a_succeeded_request_stays_pinned_to_its_first_version(self):
        """**成功过**的那次 ⇒ 版本**仍然钉死**（重放不许悄悄换语义）。"""
        request = _Request("Succeeded", "1.0.0",
                           request_hash=self.action_requests.fingerprint({}, ()))
        with self.assertRaises(self.action_requests.frappe.DuplicateEntryError):
            self.action_requests.assert_binding(
                request, _Identity(), "files.promotion_define", "1.3.0", {})
        self.assertEqual(request.action_version, "1.0.0",
                         "成功过的请求被悄悄换了版本 ⇒ 重放语义变了")

    def test_the_other_binding_checks_still_apply_to_failed_requests(self):
        """**改绑版本**不放宽别的检查（身份/企业/动作号/载荷指纹照旧恒判）。"""
        request = _Request("Failed", "1.0.0",
                           request_hash=self.action_requests.fingerprint({}, ()))
        request.actor_identity = "别人的身份"
        with self.assertRaises(self.action_requests.frappe.DuplicateEntryError):
            self.action_requests.assert_binding(
                request, _Identity(), "files.promotion_define", "1.3.0", {},
                allow_version_drift=True)

    def test_the_payload_fingerprint_still_binds_a_failed_request(self):
        """**载荷变了**照样拒（改绑版本不等于放行别的内容）。"""
        request = _Request("Failed", "1.0.0",
                           request_hash="另一个载荷的指纹")
        with self.assertRaises(self.action_requests.frappe.DuplicateEntryError):
            self.action_requests.assert_binding(
                request, _Identity(), "files.promotion_define", "1.3.0", {},
                allow_version_drift=True)


if __name__ == "__main__":
    unittest.main()
