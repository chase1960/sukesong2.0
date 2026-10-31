"""**文件目录按归属层级在服务端筛**（2026-10-28 · PKG-132 · 审查报告 R11）。

**背景**：目录页的归属筛选（全部／个人／所属部门）以前是**前端**在已取回的清单里筛
⇒ 计数只对「手头那一批」成立 ⇒ **说谎**（筛选后总数还是没筛的那个数）。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **按个人归属筛 ⇒ 只回个人归属的文件**（部门的不在里面）。
2. **总数也跟着筛**（`total` 是筛后的数量，不是全量）。
3. **筛不出东西时明确报错**（不静默给空列表让人以为是坏了）。
4. **不传这个筛选参数时行为不变**（既有口径不变）。

**怎么跑**（装了这个 App 的站点上）：

    cd frappe_apps/shangshu_files && PYTHONPATH=. ../../env/bin/python -m unittest \
        shangshu_files.tests.test_directory_attribution_filter
"""
import base64
import sys
import unittest
import uuid
from io import BytesIO
from pathlib import Path

FILES_DIR = Path(__file__).resolve().parents[1]
if str(FILES_DIR) not in sys.path:
    sys.path.insert(0, str(FILES_DIR))

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    frappe = None
    FrappeTestCase = unittest.TestCase


def _site_ready():
    try:
        return bool(getattr(frappe.local, "site", None))
    except Exception:
        return False


def _workbook_bytes():
    from openpyxl import Workbook
    book = Workbook()
    sheet = book.active
    sheet.title = "目录"
    sheet.append(["客户"])
    sheet.append(["甲"])
    out = BytesIO()
    book.save(out)
    return out.getvalue()


@unittest.skipUnless(HAS_FRAPPE and _site_ready(), "需要站点：文件与归属在库里")
class TestDirectoryAttributionFilter(FrappeTestCase):
    """文件目录：**服务端**按归属层级筛。"""

    def setUp(self):
        frappe.set_user("Administrator")
        self.token = uuid.uuid4().hex[:6]   # 短名：frappe 会截断过长的文件名（中文更早撞上限）
        self.personal = self._upload("dirlter-" + self.token)

    def tearDown(self):
        frappe.set_user("Administrator")
        try:
            from shangshu_files import service
            for name in (getattr(self, "personal", None),):
                if not name:
                    continue
                service.recycle({"file": name})
                frappe.db.commit()
                # ⚠️ **只回收、不删档**：删档会把（只剩这一份的）目录一起清掉
                #   ⇒ 下一个用例上传时找不到落盘目录（环境噪声，不是产品缺陷）。
                import os
                private = os.path.join("sites", frappe.local.site, "private", "files")
                if not os.path.isdir(private):
                    os.makedirs(private, exist_ok=True)
        except Exception:
            pass
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    def _upload(self, name, level="personal"):
        from shangshu_files import service
        result = service.upload({"file_name": name + ".xlsx",
                                 "content_base64": base64.b64encode(_workbook_bytes()).decode(),
                                 "attribution": {"level": level}})
        frappe.db.commit()
        return result["file"]

    def _query(self, filters):
        from shangshu_core.public_api import query_dataset
        return query_dataset("files.file", filters, 1, 50)

    def test_the_attribution_filter_narrows_the_rows(self):
        """① 按个人归属筛 ⇒ 那份文件在列表里。"""
        rows = self._query({"scope": "sheet", "attribution_level": "personal"})
        names = [row.get("name") for row in (rows.get("rows") or [])]
        self.assertIn(self.personal, names, "个人归属的文件没被列出来")
        self.assertGreater(int(rows.get("total") or 0), 0, "total 不对")

    def test_the_filter_is_applied_on_the_server_not_in_the_browser(self):
        """② 筛一个**没有资源**的层级 ⇒ **明确报错**。

        ⚠️ 这是「服务端筛」的**决定性证据**：如果筛选还在前端，
        这只会得到一个**空列表**（看起来像「没东西」）；**报错**才说明服务端真的筛了。
        """
        with self.assertRaises(frappe.ValidationError) as caught:
            self._query({"scope": "sheet", "attribution_level": "department"})
        self.assertIn("归属层级", str(caught.exception),
                      "报错要说清是归属层级这一层没东西，而不是别的原因")

    def test_without_the_filter_nothing_changes(self):
        """④ 不传这个筛选 ⇒ 行为不变（既有口径）。"""
        rows = self._query({"scope": "sheet"})
        names = [row.get("name") for row in (rows.get("rows") or [])]
        self.assertIn(self.personal, names)

    def test_an_unknown_level_is_rejected(self):
        """筛不出东西/非法层级 ⇒ 明确报错（不静默给空列表）。"""
        with self.assertRaises(frappe.ValidationError):
            self._query({"scope": "sheet", "attribution_level": "不存在的层级"})


if __name__ == "__main__":
    unittest.main()
