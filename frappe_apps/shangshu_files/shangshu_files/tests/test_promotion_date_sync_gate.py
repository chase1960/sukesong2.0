"""**日期型受管列**的同步闸：xlsx 里的日期（datetime）与受管正式值（ISO 串）**必须认作同一个值**。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_files.tests.test_promotion_date_sync_gate --skip-test-records

**测试通过 = 什么成立**（一句话）：
「写**日期型**受管列时，那道『正式值与表格副本尚未一致』的闸**不误报** ——
xlsx 里的日期是 `datetime`（2025-07-10 00:00:00），受管正式值是 ISO 串（`'2025-07-10'`），
**两者是同一个日期** ⇒ 闸不该把它们当成「不一致」；
而**真不一致**（正式值是 2025-07-10、xlsx 是 2025-07-11）**照样被挡**。」

**为什么有这一条**（2026-10-28 站上实测撞出来的）：
Host 来件进站 ⇒ 归案提案要把「发案日期」写进案件正式值 ⇒ 被文件域的同步闸当场拒：
「**正式值与表格副本尚未一致，请先恢复同步，本包未保存**」。
查出来是**闸在拿两种形状比同一个日期**：
xlsx 里日期列是 `datetime` 对象，受管正式值里是 ISO 字符串 ⇒ `datetime != str` ⇒ **恒不相等**
⇒ **日期型受管列根本写不进去**（不只是这一份文件，是所有日期列）。

⇒ 闸比值前**按列的类型归一**（日期两边都取日期的 ISO 串再比）。
"""
import unittest

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点：bench --site <test-site> run-tests --module shangshu_files.tests.test_promotion_date_sync_gate")
class TestPromotionDateSyncGate(FrappeTestCase):
    """日期型受管列的同步闸。"""

    def test_a_datetime_and_the_same_iso_string_are_one_value(self):
        """xlsx 里的 datetime 与受管正式值里的 ISO 串 ⇒ **同一个值**。"""
        from shangshu_files import promotion

        same = promotion.same_formal_value(
            "2025-07-10", {"type": "date", "value": __import__("datetime").datetime(2025, 7, 10)})
        self.assertTrue(same, "同一个日期被当成两个值 ⇒ 日期型受管列写不进去")

    def test_the_gate_order_is_the_one_the_gate_uses(self):
        """**顺序是闸里那个**：正式值在前、表格副本在后（不许把比法搞成「两边都试」——
        那会把**真差异**也放行，闸就白设了）。"""
        from shangshu_files import promotion

        # 正式值在前、表格副本在后 ⇒ 同一个日期 ⇒ 认作一致
        self.assertTrue(promotion.same_formal_value(
            "2025-07-10", {"type": "date", "value": __import__("datetime").datetime(2025, 7, 10)}))
        # **反过来**（表格副本在前）不是闸的用法 ⇒ 不许因为它就放宽比法
        self.assertFalse(promotion.same_formal_value(
            {"type": "date", "value": __import__("datetime").datetime(2025, 7, 10)}, "2025-07-10"),
            "反过来也放行 ⇒ 比法被放宽成「两边都试」⇒ 真差异会被放过去")

    def test_the_iso_form_with_zero_time_is_the_same_day(self):
        """**ISO 带时刻、时刻是零点** ⇒ 同一个日期（xlsx 日期列解析出来就是这个形状）。"""
        from shangshu_files import promotion

        self.assertTrue(promotion.same_formal_value(
            "2025-07-10", {"type": "date", "value": "2025-07-10T00:00:00"}),
            "同一个日期（一个是纯日期、一个是零点带时刻）被判成两个 ⇒ 日期型受管列写不进去")

    def test_the_iso_form_with_a_real_time_is_not_the_same_day_value(self):
        """**ISO 带真时刻** ⇒ 不是同一个值（时刻不许被吞掉）。"""
        from shangshu_files import promotion

        self.assertFalse(promotion.same_formal_value(
            "2025-07-10", {"type": "date", "value": "2025-07-10T13:30:00"}),
            "带真时刻的日期被当成纯日期 ⇒ 时刻被吞了")

    def test_a_datetime_with_a_time_is_not_the_same_day_value(self):
        """**带时刻的日期**与纯日期**不是同一个值**（不许悄悄抹掉时刻）。"""
        import datetime

        from shangshu_files import promotion

        self.assertFalse(promotion.same_formal_value(
            "2025-07-10", {"type": "date", "value": datetime.datetime(2025, 7, 10, 13, 30)}),
            "带时刻的日期被当成纯日期 ⇒ 时刻被吞了")

    def test_really_different_values_are_still_different(self):
        """**真不一致**照样是不同（不许把闸放宽成永远放行）。"""
        import datetime

        from shangshu_files import promotion

        self.assertFalse(promotion.same_formal_value(
            "2025-07-10", {"type": "date", "value": datetime.datetime(2025, 7, 11)}),
            "两个不同的日期被当成同一个")

    def test_text_values_keep_their_old_behaviour(self):
        """文字列**照旧按原样比**（不许因为改了日期就把文字的比法也改了）。"""
        from shangshu_files import promotion

        self.assertTrue(promotion.same_formal_value("实审", {"type": "text", "value": "实审"}))
        self.assertFalse(promotion.same_formal_value("实审", {"type": "text", "value": "受理"}))
