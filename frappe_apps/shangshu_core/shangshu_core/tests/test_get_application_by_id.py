"""**按 ID 取一个应用，不许重建整份目录**（2026-10-28 · PKG-132 · 审查报告 R13）。

**背景**：以前 `get_application(application_id)` 是
「**先把整份应用目录装配出来**（每个域的资源、每个已发布应用的依赖解析与数据集可见性都算一遍），
**再按 ID 找那一项**」⇒ 读**一个**应用＝装配**全部**应用。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **取一个应用不再走整份目录** —— `application_catalog` 被调用就是失败（当场抛错）。
2. **按 ID 定位后装配出来的内容与目录里那一条一字不差**（同一份装配代码，不两写）。
3. **已发布应用那一路按 ID 过滤** —— 不把**全部**已发布应用装配出来才挑一个。
4. **取不到就明确拒**（不静默返回一个空壳）。

**怎么跑**（装了这个 App 的站点上）：

    cd frappe_apps/shangshu_core && PYTHONPATH=. ../../env/bin/python -m unittest \
        shangshu_core.tests.test_get_application_by_id
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

CORE_DIR = Path(__file__).resolve().parents[1]
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    HAS_FRAPPE = True
except ImportError:  # pragma: no cover - 没有 frappe 就退化成替身
    HAS_FRAPPE = False
    frappe = None
    FrappeTestCase = unittest.TestCase

from shangshu_core import domains  # noqa: E402


def _site_ready():
    """**连上站点了吗** —— 没有站点就跳过（别在离线环境里报错）。"""
    try:
        # `frappe.local.site` 只有 `frappe.init(site=…)` 之后才有值 ⇒
        # 没连站点就是 False ⇒ 这条判据**跳过**（而不是在离线环境里报错）。
        return bool(getattr(frappe.local, "site", None))
    except Exception:
        return False


@unittest.skipUnless(HAS_FRAPPE and _site_ready(), "需要站点：这条判据只在装了站点的环境里跑")
class TestGetApplicationById(FrappeTestCase):
    """按 ID 取一个应用 ⇒ 不装配整份目录。"""

    def setUp(self):
        frappe.set_user("Administrator")

    def test_one_application_is_fetched_without_building_the_whole_catalog(self):
        """① 取一个应用**不走整份目录**；② 内容与目录里那一条一致。"""
        catalog = domains.application_catalog()
        # 域贡献的那一个（`source` 为空 ⇒ 来自域贡献，不是已发布应用）
        target = next((item for item in catalog if item.get("source") is None), None)
        self.assertTrue(target, "站上应有至少一个域贡献的应用")
        with mock.patch.object(domains, "application_catalog",
                               side_effect=AssertionError("不许重建整份目录")):
            fetched = domains.get_application(target["id"])
        self.assertEqual(fetched.get("id"), target["id"])
        self.assertEqual(sorted(fetched.get("resource_counts") or {}),
                         sorted(target.get("resource_counts") or {}),
                         "按 ID 取出来的内容与目录里那一条不一致")

    def test_a_published_application_is_fetched_by_id_too(self):
        """已发布应用那一个：**按 ID** 取，不装配全部已发布应用。"""
        catalog = domains.application_catalog()
        target = next((item for item in catalog if item.get("source") == "managed"), None)
        self.assertTrue(target, "站上应有至少一个已发布应用")
        with mock.patch.object(domains, "application_catalog",
                               side_effect=AssertionError("不许重建整份目录")):
            fetched = domains.get_application(target["id"])
        self.assertEqual(fetched.get("id"), target["id"])

    def test_the_published_path_is_narrowed_by_id(self):
        """③ 已发布应用那一路**按 ID 过滤**（不是装配全部再挑一个）。"""
        import shangshu_core.applications as applications
        captured = {}

        def fake_published(include_resources=False, application_id=None):
            captured["application_id"] = application_id
            return []

        with mock.patch.object(applications, "published_application_catalog", side_effect=fake_published):
            with self.assertRaises(frappe.DoesNotExistError):
                domains.get_application("不存在-的应用-id")
        self.assertEqual(captured.get("application_id"), "不存在-的应用-id",
                         "已发布那一路没有按 ID 过滤 ⇒ 仍在装配全部已发布应用")

    def test_an_unknown_id_is_rejected(self):
        """④ 取不到就明确拒，不给空壳。"""
        with self.assertRaises(frappe.DoesNotExistError):
            domains.get_application("绝对不存在的应用-id")


if __name__ == "__main__":
    unittest.main()
