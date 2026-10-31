"""受管对象**退役后同一张表再晋升**：内核要能**复活**那个对象，而不是撞主键。

**测试通过 =** 什么成立（下面每一条都成立）：
- **首次晋升**一张表 ⇒ 建出受管对象 + 受管记录（基线，行为一个字没变）；
- 把这个受管对象**退役**（下线、清物理表、留退役记录）⇒ **模型行还在**（当退役记录用）；
- **同一张表再晋升**（同一个表 id ⇒ 同一个对象 id）
  ⇒ **不报 DuplicateEntryError**（改之前就是在这儿炸的）；
- 复活后：那个**同一个 object_id** 又活过来了（`active_revision > 0`），
  受管记录按新的列重新灌进去，**行数对得上**；
- **物理表重新建起来**（退役时删过 ⇒ 复活要有表）；
- ⚠️ **物理表里真的有一行一行**（不是只有「行 id → 记录 id」的映射）：
  第二世若沿用第一世的行级幂等键 ⇒ 动作通道**重放上一世的旧结果**（不建行）
  ⇒ **表是空的而代码说成功** ⇒ 静默丢数据（最难查的一种）；
- ⚠️ **两世的行级幂等键不一样**（「第几世」进了键里）；
- **退役记录留着**（审计痕迹不许被复活吃掉）。

⚠️ **为什么要有这条**（2026-10-25 站上实测撞出来的第三个内核缺口）：
  对象 id 是**从幂等键推导**的（`application_id + ".object." + hash(表 id)`）
  ⇒ **同一张表永远是同一个 object_id**
  ⇒ 而退役**故意保留模型行**（当退役记录用）
  ⇒ **同一张表晋升过一次并退役后，再晋升必然撞主键** ⇒ 那张表**再也升不上去**。
  ⇒ 真总表就是这么卡住的（批次 1 的对象已退役 ⇒ 重跑撞 DuplicateEntryError）。

**修法**：内核在准备对象变更时，发现**同 id 的模型行已退役**（`active_revision=0`）
⇒ **复活它**（把它当新对象重新上线）⇒ 而不是插一行新的撞主键；
⇒ **幂等键带「第几世」**（变更键、行级键都带）⇒ 不同世互不撞，同一世内重试仍幂等。
⇒ **退役记录照旧留着**（审计痕迹不许被复活吃掉）。
"""
import hashlib
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import model_lifecycle
from shangshu_core import model_records
from shangshu_core.promotion_records import provision_promoted_records

COLUMNS = [
    {"header": "金额", "promoted": True, "field": "amount", "type": "number", "rules": {"min": 0}},
    {"header": "日期", "promoted": True, "field": "day", "type": "date"},
]

# 受管表链的**表级主体范围声明**（PKG-117-T01）：表级是**独立声明**的，
# 不再由各列并集推导 ⇒ 晋升入口**必填**。
TABLE_ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"},
                "download": {"scope": "global"}, "record_scope": "all"}


def rows_for(count=3):
    return [
        {"row_id": "r-%06d" % index,
         "values": {"amount": index * 10.5, "day": "2026-10-%02d" % index}}
        for index in range(1, count + 1)
    ]


class TestReviveRetiredPromotedObject(FrappeTestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.table = "revive-table-" + uuid.uuid4().hex[:8]
        self.key = "revive:" + self.table
        self.object_id = None

    def tearDown(self):
        frappe.set_user("Administrator")
        self._cleanup()
        super().tearDown()

    def _cleanup(self):
        """**只清这一条判据自己留下的东西**（不留残受管对象给站上）。"""
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
        # 变更单、退役记录、动作审计：这一条判据自己建的，一并清掉。
        try:
            for row in frappe.get_all("Shangshu Schema Change", filters={"object_model": self.object_id},
                                      fields=["name"]):
                frappe.delete_doc("Shangshu Schema Change", row["name"], force=True, ignore_permissions=True)
            for row in frappe.get_all("Shangshu Object Model Retirement", filters={"object_id": self.object_id},
                                      fields=["name"]):
                frappe.delete_doc("Shangshu Object Model Retirement", row["name"], force=True, ignore_permissions=True)
            frappe.db.sql("delete from `tabShangshu Unified Log` where idempotency_key like %s",
                          ("promotion-row:" + self.key + "%",))
            frappe.db.commit()
        except Exception:
            frappe.db.rollback()
        self.object_id = None

    def _promote(self):
        result = provision_promoted_records(
            table=self.table, title=self.table,
            columns=COLUMNS, rows=rows_for(), access=TABLE_ACCESS,
            idempotency_key=self.key)
        self.object_id = result["object_id"]
        return result

    def test_退役后同一张表再晋升_复活那个对象_不撞主键(self):
        # ① 首次晋升
        first = self._promote()
        self.assertTrue(first["object_id"], "首次晋升没有建出受管对象")
        self.assertEqual(len(first["records"]), 3, "首次晋升的受管记录条数不对")

        # ② 退役（内核的退役口：下线 ＋ 清物理表 ＋ 留退役记录）
        receipt = model_lifecycle.retire_managed_object(
            first["object_id"], reason="判据：测退役后同表再晋升")
        self.assertTrue(receipt.get("retired"), "退役没有成功")

        # ③ **模型行还在**（退役记录用）—— 这是「同表再晋升撞主键」的病根
        still_there = frappe.db.exists(model_records.MODEL, first["object_id"])
        self.assertTrue(still_there, "退役把模型行删了 —— 那就不是「撞主键」这条路了")

        # ④ **同一张表再晋升** ⇒ 改之前：DuplicateEntryError（对象 id 从表 id 推导 ⇒ 必然撞）
        again = self._promote()

        # ⑤ 复活的还是**同一个对象**
        self.assertEqual(again["object_id"], first["object_id"],
                         "复活后换了一个对象 id（不是复活，是另建了一个）")

        # ⑥ 它真的活过来了（active_revision > 0）＋ 物理表重新建起来
        model = frappe.get_doc(model_records.MODEL, again["object_id"])
        self.assertGreater(int(model.get("active_revision") or 0), 0,
                           "复活后对象还是下线的（active_revision=0）")
        self.assertTrue(model.get("physical_doctype"), "复活后没有物理表")
        self.assertTrue(frappe.db.exists("DocType", model.physical_doctype),
                        "复活后物理表没建起来")

        # ⑦ 受管记录重新灌进去了
        self.assertEqual(len(again["records"]), 3, "复活后受管记录条数不对")

        # ⑧ ⚠️ **物理表里真的有行** —— 只看「行 id → 记录 id」的映射不够：
        #    第二世若沿用第一世的行级幂等键 ⇒ 动作通道**重放旧结果**（不建行）
        #    ⇒ 映射有 3 条、表却是空的（静默丢数据）。
        rows_in_table = frappe.db.count(model.physical_doctype)
        self.assertEqual(rows_in_table, 3,
                         "复活后的物理表里只有 %d 行（映射有 3 条）—— 行级幂等键重放了上一世的旧结果"
                         % rows_in_table)

        # ⑨ ⚠️ **两世的行级幂等键不一样**（「第几世」进了键里）
        #    （动作审计落在**统一日志**表 —— 新动作都写那儿）
        used = frappe.get_all("Shangshu Unified Log",
                               filters={"idempotency_key": ["like", "promotion-row:" + self.key + "%"]},
                               fields=["idempotency_key"])
        self.assertEqual(len(used), 6,
                         "两世用下来的行级幂等键只有 %d 条（应为 3＋3）—— 第二世沿用了第一世的键"
                         % len(used))

        # ⑩ **退役记录留着**（审计痕迹不许被复活吃掉）
        retired_rows = frappe.get_all("Shangshu Object Model Retirement",
                                      filters={"object_id": first["object_id"]},
                                      fields=["name"])
        self.assertTrue(retired_rows, "复活把退役记录吃掉了 —— 审计痕迹没了")

