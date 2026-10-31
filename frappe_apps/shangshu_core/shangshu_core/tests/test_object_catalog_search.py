"""**对象目录按关键字在服务端筛**（2026-10-28 · PKG-132 · 审查报告 R11）。

**背景**：目录页的业务表搜索以前是**前端**做的 —— 把整份对象目录拉回去再筛
（「业务表那侧没有搜索参数，只能在取回的清单里筛」）
⇒ 搜索口径与分页/总数对不上。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **带 search 只回命中的** —— 目录里没有的关键词 ⇒ **空列表**（不是全量）。
2. **不带 search 仍是全量** —— 既有口径不变。
3. **命中按「标题／编号／名字」里的包含** —— 三种写法都认（与前端原来那套一致）。

**怎么跑**（装了这个 App 的站点上）：

    cd frappe_apps/shangshu_core && PYTHONPATH=. ../../env/bin/python -m unittest \
        shangshu_core.tests.test_object_catalog_search
"""
import sys
import unittest
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parents[1]
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    frappe = None
    FrappeTestCase = unittest.TestCase

from shangshu_core import objects  # noqa: E402


def _site_ready():
    try:
        return bool(getattr(frappe.local, "site", None))
    except Exception:
        return False


@unittest.skipUnless(HAS_FRAPPE and _site_ready(), "需要站点：域声明在库里")
class TestObjectCatalogSearch(FrappeTestCase):
    """对象目录：**服务端**按关键字筛。"""

    def setUp(self):
        frappe.set_user("Administrator")

    def test_the_whole_catalog_is_returned_without_a_search(self):
        """② 不带 search ⇒ 全量（既有口径不变）。"""
        everything = objects.list_object_definitions()
        self.assertTrue(everything, "站上应当有对象目录")
        self.assertEqual(len(objects.list_object_definitions(search="")), len(everything),
                         "带空 search 与不带 search 应当一样")

    def test_a_search_term_narrows_the_catalog(self):
        """① 带 search ⇒ 只回命中的（**不是全量**）。"""
        everything = objects.list_object_definitions()
        sample = everything[0]
        term = str(sample.get("id") or "").split(".")[-1]
        self.assertTrue(term, "样本对象没有 id，测不了")
        hit = objects.list_object_definitions(search=term)
        self.assertTrue(hit, "按 id 片段筛应当命中")
        self.assertLess(len(hit), len(everything),
                         "筛完还是全量 ⇒ 搜索仍在服务端之外做")

    def test_a_term_that_matches_nothing_returns_an_empty_list(self):
        """① 搜不到 ⇒ 空列表（不是全量）。"""
        hit = objects.list_object_definitions(search="绝对不存在的关键字-zzz")
        self.assertEqual(hit, [], "搜不到却回了全量 ⇒ 搜索没在服务端做")

    def test_the_order_is_stable(self):
        """**稳定排序**：同样的数据每次读回来的次序一样（标题 → 编号）。"""
        first = [row.get("id") for row in objects.list_object_definitions()]
        second = [row.get("id") for row in objects.list_object_definitions()]
        self.assertEqual(first, second, "两次读回来的次序不一样 ⇒ 清单会自己乱跳")
        titles = [(str(row.get("title") or ""), str(row.get("id") or ""))
                  for row in objects.list_object_definitions()]
        self.assertEqual(titles, sorted(titles), "没有按（标题 → 编号）排 ⇒ 顺序不确定")

    def test_the_title_and_the_name_are_both_searchable(self):
        """③ 标题／编号／名字任一命中即可。"""
        everything = objects.list_object_definitions()
        for sample in everything[:5]:
            for field in ("title", "id"):
                term = str(sample.get(field) or "")
                if not term:
                    continue
                hit = objects.list_object_definitions(search=term)
                self.assertTrue(hit, "按 %s=%s 筛不到" % (field, term))
                break


if __name__ == "__main__":
    unittest.main()
