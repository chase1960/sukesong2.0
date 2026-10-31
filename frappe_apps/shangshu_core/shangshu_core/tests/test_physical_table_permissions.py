"""受管对象的**物理表要有权限**（对象声明的 `access` 要落成 DocPerm）。

⚠️ **2026-10-25 起口径变了**（PKG-117-T01；契约 `账号与权限.md` 233–293 行）：

- **受管表链**（晋升上来的表）走**主体范围**新形状
  （五操作 × 全局/部门/个人）⇒ 物理表落**宽底座角色**（读＋写）。
  理由：Frappe 的 DocPerm **只能写角色** ⇒ 主体范围写不进去
  ⇒ 宽底座角色只让 `doc.check_permission` 过，**细判在域层/内核层**（按主体判）。
- **建模对象链**（用户用建模器建的普通对象）**照旧**用角色键
  ⇒ `read_roles` 能读、`write_roles` 才能写（只在 read 里的 ⇒ 只读）。
- **「表级＝各列并集」那条路已删**（`_access_from_columns`）⇒
  **改一列不再连带改变表级**（下面第三条钉的就是这个）。

**测试通过 =** 下面每一条都成立：
- 受管表声明主体范围 ⇒ 物理表**真的有**宽底座角色的 DocPerm 行，且**能读能写**；
- **改一列 ⇒ 表级不变**（物理表的权限行不动）；
- 建模对象链（角色键）⇒ 物理表按角色落（只读的角色**没有** write）。
"""
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_records
from shangshu_core.promotion_records import provision_promoted_records

COLUMNS = [
    {"header": "金额", "promoted": True, "field": "amount", "type": "number", "rules": {"min": 0}},
    {"header": "日期", "promoted": True, "field": "day", "type": "date"},
]

# 受管表链的**表级主体范围声明**：表级是**独立声明**的（不再由各列并集推导）。
GLOBAL_ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"},
                  "download": {"scope": "global"}, "record_scope": "all"}
DEPARTMENT_ACCESS = {"read": {"scope": "department", "departments": ["财务"]},
                     "write": {"scope": "department", "departments": ["财务"]},
                     "download": {"scope": "department", "departments": ["财务"]},
                     "record_scope": "all"}


def rows_for(count=2):
    return [{"row_id": "r-%06d" % index,
             "values": {"amount": index * 10, "day": "2026-10-%02d" % index}}
            for index in range(1, count + 1)]


class TestPhysicalTablePermissions(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.table = "perm-table-" + uuid.uuid4().hex[:8]
        self.key = "perm:" + self.table
        self.object_id = None

    def tearDown(self):
        frappe.set_user("Administrator")
        self._cleanup()
        super().tearDown()

    def _cleanup(self):
        if not self.object_id:
            return
        try:
            model = frappe.get_doc(model_records.MODEL, self.object_id)
            frappe.db.commit()
            if model.get("physical_doctype"):
                frappe.db.sql("DROP TABLE IF EXISTS `%s`" % model.physical_doctype)
                try:
                    frappe.delete_doc("DocType", model.physical_doctype, force=True, ignore_permissions=True)
                except Exception:
                    pass
            frappe.delete_doc(model_records.MODEL, self.object_id, force=True, ignore_permissions=True)
            frappe.db.commit()
        except Exception:
            frappe.db.rollback()
        self.object_id = None

    def _promote(self, access, columns=None):
        result = provision_promoted_records(
            table=self.table, title=self.table, columns=columns or COLUMNS, rows=rows_for(),
            idempotency_key=self.key + uuid.uuid4().hex[:6], access=access)
        self.object_id = result["object_id"]
        return result

    def _perms(self):
        model = frappe.get_doc(model_records.MODEL, self.object_id)
        rows = frappe.get_all("DocPerm", filters={"parent": model.physical_doctype},
                              fields=["role", "read", "write"])
        return {(row["role"], int(row["read"] or 0), int(row["write"] or 0)) for row in rows}

    def test_主体范围形状落宽底座角色(self):
        """受管表声明主体范围 ⇒ 物理表落**宽底座角色**（读＋写）。

        为什么是宽底座：Frappe 的 DocPerm 只能写角色 ⇒「全局/部门/个人」
        写不进去 ⇒ 宽底座只让 `doc.check_permission` 过，细判在域层/内核层。
        """
        self._promote(GLOBAL_ACCESS)
        perms = self._perms()
        self.assertTrue(perms, "物理表**一条 DocPerm 都没有** —— 除了管理员谁都读不到行"
                                "（对象声明的 access 没落成权限）")
        self.assertIn(("Desk User", 1, 1), perms,
                      "物理表的权限行 = %s —— 没有宽底座角色的「可读可写」" % sorted(perms))

    def test_部门级表也落宽底座角色(self):
        """部门级表**照样**落宽底座 —— 部门那一层是**细判**，不是 DocPerm 能表达的东西。"""
        self._promote(DEPARTMENT_ACCESS)
        perms = self._perms()
        self.assertIn(("Desk User", 1, 1), perms,
                      "物理表的权限行 = %s —— 部门级表也应落宽底座" % sorted(perms))

    def test_改一列不动表级(self):
        """**并集联动取消**：改一列的声明 ⇒ 物理表的表级权限**不动**。

        ⚠️ 旧实现里表级＝各列并集 ⇒ 改一列会连带把整张表的表级收窄。
        """
        self._promote(GLOBAL_ACCESS)
        before = self._perms()
        narrowed = [dict(COLUMNS[0],
                         access={"read": {"scope": "department", "departments": ["财务"]},
                                 "write": {"scope": "department", "departments": ["财务"]},
                                 "download": {"scope": "department", "departments": ["财务"]}})]
        from shangshu_core.promotion_records import extend_promoted_records
        model = frappe.get_doc(model_records.MODEL, self.object_id)
        extend_promoted_records(object_id=self.object_id, application_id=model.application,
                                title=self.table, columns=narrowed + [dict(COLUMNS[1])],
                                rows=[], records={}, access=GLOBAL_ACCESS,
                                idempotency_key=self.key + ":narrow")
        self.assertEqual(before, self._perms(),
                         "改一列竟然动了表级的物理权限（并集联动没取消？）")
