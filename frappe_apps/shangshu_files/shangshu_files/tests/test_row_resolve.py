"""**按行 ID 解析成受管记录**（`files.row_resolve` ＋ 内核编排口 `platform.business_identity.resolve_row`）。

**为什么要有这个口**（用户 2026-10-22 第四段）：
「为了让『日志』这一块能**按案件看**，内核还需补两个口——让动作审计与事件能正式挂到
受管记录上（与流程那个 `business_object_id` 同款思路），以及让域能按业务标识取到这些记录；
**在这之前，前端的日志块最多只能看全局流水，看不到某一个案子**。」

⇒ 挂到受管记录上要两样东西：**受管对象 id** ＋ **受管记录名**。
而业务域手里只有「**表 ＋ 工作簿行 ID**」（案件行就是这么被引用的）。
**行 ID → 受管记录名**的映射在**文件域**手里（晋升绑定）⇒ 别的域拿不到、也不该自己造一份。

**两个口**：
· **文件域** `files.row_resolve`：表 ＋ 行 ID ⇒ 受管对象 id ＋ 受管记录名（**映射在这里**）；
· **内核** `platform.business_identity.resolve_row`：编排上面那个，
  **任何域都能调**（example 与 UC02 关联费用用**同一个办法**）。

**测试通过 = 什么成立**（10 行、名称列已晋升成受管列的工作簿）：
① 给一个**存在的工作簿行 ID** ⇒ 解析出**受管对象 id ＋ 受管记录名**，
   而且那个受管记录**读回来就是那一行**（换算要对，不能张冠李戴）；
② 给一个**不存在的行 ID** ⇒ **解析不出来**，且说清为什么；
③ 内核编排口走的是**文件域那一份**（不另造映射）；
④ 权限照旧：**没这张表的读权限 ⇒ 拿不到**（不因为有口就能看别人的表）。
"""
import base64
import unittest
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase


# 名称列升成受管列（业务编号就长这样：文本、唯一、回填得进去）。
# ⚠️ **PKG-117-T01**：受管列必须带**主体范围**（这里＝全局，与改造前效果一致）。
LABEL_COLUMN = {"header": "名称", "promoted": True, "field": "label", "type": "text",
                 "access": {"read": {"scope": "global"},
                            "write": {"scope": "global"},
                            "download": {"scope": "global"}}}


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_files.tests.test_row_resolve")
class TestRowResolve(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.key = "row-resolve-%s" % uuid.uuid4().hex[:8]
        self.table = None

    def _upload_and_promote(self):
        from shangshu_files import promotion, service
        from shangshu_files.tests import promotion_fixture as fixture

        result = service.upload({"file_name": "行解析-%s.xlsx" % self.key,
                                 "content_base64": base64.b64encode(fixture.workbook_bytes()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        self.table = result["file"]
        promotion.define({"table": self.table, "definition": fixture.definition([LABEL_COLUMN])})
        frappe.db.commit()
        return self.table

    def _first_row_id(self):
        """先按受管列的值找到那一行的工作簿行 ID（**用已有那个口**，不另造映射）。"""
        from shangshu_core.public_api import invoke_domain_service

        found = invoke_domain_service("files.row_find_by_value",
                                      {"table": self.table, "field": "label", "value": "名称3"})
        return (found.get("rows") or [{}])[0].get("row_id")

    def _resolve_in_files(self, row_id):
        from shangshu_core.public_api import invoke_domain_service

        return invoke_domain_service("files.row_resolve",
                                      {"table": self.table, "row_id": row_id})

    def _resolve_in_core(self, row_id):
        from shangshu_core.public_api import invoke_domain_service

        return invoke_domain_service("platform.business_identity.resolve_row",
                                      {"table": self.table, "row_id": row_id})

    # ---------- ① 存在的行 ID ⇒ 解析出受管对象 ＋ 受管记录 ----------
    def test_an_existing_row_resolves_to_its_managed_record(self):
        self._upload_and_promote()
        row_id = self._first_row_id()
        self.assertTrue(row_id, "夹具没给出行 ID")

        resolved = self._resolve_in_files(row_id)
        self.assertTrue(resolved.get("found"), "存在的行没解析出来：%s" % resolved)
        self.assertTrue(resolved.get("object_id"), "没解析出受管对象 id")
        self.assertTrue(resolved.get("record"), "没解析出受管记录名")
        self.assertEqual(resolved.get("row_id"), row_id)

        # 换算要对：那个受管记录读回来，名称就是这一行的编号。
        from shangshu_core.public_api import query_object_records

        rows = query_object_records(resolved["object_id"], {}, 1, 50).get("rows") or []
        hit = [row for row in rows if row.get("name") == resolved["record"]]
        self.assertEqual(len(hit), 1, "解析出的受管记录在受管对象里找不到")
        self.assertEqual(hit[0].get("label"), "名称3", "张冠李戴：这条受管记录不是那一行")

    # ---------- ② 不存在的行 ID ⇒ 解析不出来，说清为什么 ----------
    def test_an_unknown_row_resolves_to_nothing_and_says_so(self):
        self._upload_and_promote()
        resolved = self._resolve_in_files("根本不存在的行 ID")
        self.assertFalse(resolved.get("found"), "解析不存在的行却说有")
        self.assertTrue(resolved.get("hint"), "解析不出来要说清为什么")

    # ---------- ③ 内核编排口走的是文件域那一份 ----------
    def test_the_core_port_resolves_the_same_way(self):
        self._upload_and_promote()
        row_id = self._first_row_id()
        from_files = self._resolve_in_files(row_id)
        from_core = self._resolve_in_core(row_id)
        self.assertEqual(from_core.get("object_id"), from_files.get("object_id"),
                         "内核口与文件域口解析出的受管对象不是一个")
        self.assertEqual(from_core.get("record"), from_files.get("record"),
                         "内核口与文件域口解析出的受管记录不是一个")

    # ---------- ④ 没读权限 ⇒ 拿不到 ----------
    def test_someone_without_read_permission_cannot_resolve_the_row(self):
        self._upload_and_promote()
        row_id = self._first_row_id()
        # 身份要挂在**真实存在的用户**上（身份表是 Link 到 User）。
        user = "no-read-%s@example.invalid" % self.key
        frappe.get_doc({"doctype": "User", "name": user, "email": user,
                        "first_name": "无读权限", "enabled": 1}).insert(ignore_permissions=True)
        from shangshu_core.public_api import ensure_identity_for_user

        ensure_identity_for_user(user)
        frappe.set_user(user)
        try:
            with self.assertRaises(Exception):
                self._resolve_in_files(row_id)
        finally:
            frappe.set_user("Administrator")


if __name__ == "__main__":
    unittest.main()
