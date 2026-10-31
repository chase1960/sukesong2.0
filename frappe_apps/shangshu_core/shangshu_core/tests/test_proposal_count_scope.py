"""**提案计数按 status 收窄、不逐条装配**（2026-10-28 · PKG-132 · 审查报告 R17）。

**背景**：`count_action_proposals(status=None)` 以前
「**不管传没传 status，三档（Proposed/Confirmed/Rejected）都数一遍**」
而且「**每条提案都 `frappe.get_doc` 一遍**」（`limit_page_length=0` ⇒ 不限量）
⇒ 提案一多，摘要口就在**装配全部历史提案**。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **传了 status 就只数那一档** —— 返回里**只有**那一档的计数（不再三档都数）。
2. **计数不逐条装配提案** —— 一次查询把需要的字段取回就算，
   **不**对每条提案调一次 `frappe.get_doc`。
3. **可见性口径一字不变** —— 仍走**同一份** `_proposal_visible`（表主／本人发起／管理员
   ＋ 目标当前读权）。

**怎么跑**（装了这个 App 的站点上）：

    cd frappe_apps/shangshu_core && PYTHONPATH=. ../../env/bin/python -m unittest \
        shangshu_core.tests.test_proposal_count_scope
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

from shangshu_core import actions  # noqa: E402


def _site_ready():
    """**连上站点了吗** —— 没有站点就跳过（别在离线环境里报错）。"""
    try:
        # `frappe.local.site` 只有 `frappe.init(site=…)` 之后才有值 ⇒
        # 没连站点就是 False ⇒ 这条判据**跳过**（而不是在离线环境里报错）。
        return bool(getattr(frappe.local, "site", None))
    except Exception:
        return False


@unittest.skipUnless(HAS_FRAPPE and _site_ready(), "需要站点：这条判据只在装了站点的环境里跑")
class TestProposalCountScope(FrappeTestCase):
    """提案摘要：**按 status 收窄** ＋ **不逐条装配**。"""

    def setUp(self):
        frappe.set_user("Administrator")

    def test_a_given_status_counts_only_that_status(self):
        """① 传了 status ⇒ **只数那一档**。"""
        counts = actions.count_action_proposals(status="Proposed")
        self.assertEqual(sorted(counts), ["Proposed"],
                         "传了 status 还在数三档 ⇒ 白数了两档历史提案")

    def test_without_a_status_all_three_statuses_are_counted(self):
        """①′ 不传 status ⇒ 三档都数（既有口径不变）。"""
        counts = actions.count_action_proposals()
        self.assertEqual(sorted(counts), ["Confirmed", "Proposed", "Rejected"])

    def test_the_count_does_not_load_every_proposal_one_by_one(self):
        """② 计数**不逐条** `frappe.get_doc` 装配提案。"""
        loaded = []
        original = frappe.get_doc

        def counting_get_doc(*args, **kwargs):
            if args and args[0] == "Shangshu Action Proposal":
                loaded.append(args[1] if len(args) > 1 else None)
            return original(*args, **kwargs)

        with mock.patch.object(frappe, "get_doc", side_effect=counting_get_doc):
            actions.count_action_proposals()
        self.assertEqual(loaded, [],
                         "计数逐条装配了 %d 个提案 ⇒ 摘要口在装配全部历史提案" % len(loaded))


if __name__ == "__main__":
    unittest.main()
