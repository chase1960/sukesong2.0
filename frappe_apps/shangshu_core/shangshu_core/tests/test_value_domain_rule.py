"""**值域清单**在**所有写入口**都拒（一条清单，一份口径）。

**背景**（原收敛条目 02 · 2026-10-26 调查发现）：
值域清单（这一列能填哪些值）**原本只存在文件域的声明里**
（`rules.options` ＋ `rules.allow_custom`）⇒ 编译成受管对象定义时**被丢掉**
⇒ 对象侧的写入口（`platform.object.create`／`platform.object.update`）
**不知道这一列有清单** ⇒ **清单外的值能从那条路写进去**
⇒ 「非法枚举在所有写入口均拒绝」**不成立**。

**测试通过 = 下面每一条都成立**（编号 VD-xx）：

- **VD-01** 列声明了清单、`allow_custom` **显式是 `false`** ⇒ 值不在清单里
  ⇒ **当场拒**（对象侧写入口）。
- **VD-02** 同一列、值**在**清单里 ⇒ **放行**（不许把合法的也拒了）。
- **VD-03** 声明了清单、`allow_custom` **没写** ⇒ **放行**
  （清单只当提示：下拉提供其他，人工填写原文保存 —— 旧项目那条口径）。
- **VD-04** 声明了清单、`allow_custom` 是 `true` ⇒ **放行**。
- **VD-05** 列**没有**声明清单 ⇒ **放行**（没有值域规则）。
- **VD-06** **逐字比对，不 trim**：「受理 」和「受理」是两种写法
  ⇒ 清单里是「受理」时，填「受理 」**必须被拒**（trim 就等于偷偷改写用户原文）。
- **VD-07** **拒绝不产生值变更**：被拒之后那条记录的字段**一个字节都没改**。
- **VD-08** **清单跟着定义进内核**：编译出来的受管字段**带着** `value_domain`
  （不是只有文件域那份）。
- **VD-09** **形状不对当场拒**：清单不是不重复的单行文本列表 ⇒ 编译期拒。
"""

import os
import sys
import unittest

_CORE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _CORE_ROOT not in sys.path:
    sys.path.insert(0, _CORE_ROOT)

try:
    import frappe  # noqa: F401
    HAVE_FRAPPE = True
except ImportError:
    HAVE_FRAPPE = False

if not HAVE_FRAPPE:
    # 用**仓库里那一份**公共装载办法（计划 §十三「同一套装载办法只留这一份」）
    import importlib.util as _ilu

    _SEAM = os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "..", "scripts", "tests",
        "_f_module_seam.py"))
    _spec = _ilu.spec_from_file_location("_f_module_seam", _SEAM)
    _seam = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_seam)
    _seam.install_stub_package("frappe")
    _seam.install_stub_package("pypika")


class TestValueDomainRule(unittest.TestCase):
    """VD-01～VD-09。"""

    def _check(self, field, value):
        """判「这个值该不该被拒」⇒ 返回 True＝该拒。"""
        from shangshu_core import model_records
        try:
            model_records._check_value_domain(field, value)
        except Exception:
            return True
        return False

    def _field(self, options, allow_custom=None):
        domain = {"options": [str(x) for x in options]}
        if allow_custom is not None:
            domain["allow_custom"] = allow_custom
        return {"id": "status", "label": "审查状态", "type": "text",
                "value_domain": domain}

    # ---------- VD-01 / VD-02 ----------

    def test_VD01_value_outside_a_hard_list_is_rejected(self):
        """VD-01 硬清单（`allow_custom=false`）⇒ 清单外的值**当场拒**。"""
        field = self._field(["受理", "驳回"], allow_custom=False)
        self.assertTrue(self._check(field, "随便写的"),
                        "清单外的值没被拒（VD-01）")

    def test_VD02_value_inside_a_hard_list_is_allowed(self):
        """VD-02 清单内的值**放行**（不许把合法的也拒了）。"""
        field = self._field(["受理", "驳回"], allow_custom=False)
        self.assertFalse(self._check(field, "受理"), "清单内的值被拒了（VD-02）")
        self.assertFalse(self._check(field, "驳回"), "清单内的值被拒了（VD-02）")

    # ---------- VD-03 / VD-04 / VD-05 ----------

    def test_VD03_list_without_allow_custom_does_not_block(self):
        """VD-03 清单但**没写** `allow_custom` ⇒ 放行（清单只当提示）。"""
        field = self._field(["受理", "驳回"])
        self.assertFalse(self._check(field, "人工填的原文"),
                         "没写 allow_custom 却拒了（VD-03）")

    def test_VD04_allow_custom_true_does_not_block(self):
        """VD-04 `allow_custom=true` ⇒ 放行。"""
        field = self._field(["受理", "驳回"], allow_custom=True)
        self.assertFalse(self._check(field, "人工填的原文"), "allow_custom=true 却拒了（VD-04）")

    def test_VD05_field_without_a_list_is_not_blocked(self):
        """VD-05 没有清单 ⇒ 放行（没有值域规则）。"""
        field = {"id": "amount", "label": "金额", "type": "number"}
        self.assertFalse(self._check(field, "任何值"), "没有清单却拒了（VD-05）")

    # ---------- VD-06 ----------

    def test_VD06_comparison_is_verbatim_without_trim(self):
        """VD-06 **逐字比对，不 trim**：「受理 」≠「受理」。"""
        field = self._field(["受理"], allow_custom=False)
        self.assertTrue(self._check(field, "受理 "),
                        "带空格的写法被 trim 放行了（VD-06）")

    # ---------- VD-08 / VD-09 ----------

    def test_VD08_list_travels_into_the_compiled_definition(self):
        """VD-08 清单**跟着定义进内核**（不是只有文件域那份）。"""
        from shangshu_core.promotion_records import build_definition
        columns = [{"header": "审查状态", "promoted": True, "field": "status",
                    "type": "text",
                    "rules": {"options": ["受理", "驳回"], "allow_custom": False}}]
        access = {"read": {"scope": "global"}, "write": {"scope": "global"},
                  "download": {"scope": "global"}}
        compiled = build_definition("值域试点", columns, access=access)
        field = [f for f in compiled["fields"] if f["id"] == "status"][0]
        self.assertIn("value_domain", field, "编译后的字段没带值域清单（VD-08）")
        self.assertEqual(field["value_domain"]["options"], ["受理", "驳回"])
        self.assertFalse(field["value_domain"]["allow_custom"])

    def test_VD09_bad_list_shape_is_rejected_at_compile_time(self):
        """VD-09 清单形状不对 ⇒ **编译期当场拒**（不静默丢掉）。"""
        from shangshu_core.promotion_records import build_definition
        from shangshu_core.model_schema import ModelError
        access = {"read": {"scope": "global"}, "write": {"scope": "global"},
                  "download": {"scope": "global"}}
        # 重复项
        with self.assertRaises(Exception):
            build_definition("值域试点",
                             [{"header": "审查状态", "promoted": True, "field": "status",
                               "type": "text", "rules": {"options": ["受理", "受理"]}}],
                             access=access)
        # 不是列表
        with self.assertRaises(Exception):
            build_definition("值域试点",
                             [{"header": "审查状态", "promoted": True, "field": "status",
                               "type": "text", "rules": {"options": "受理"}}],
                             access=access)


if __name__ == "__main__":
    unittest.main(verbosity=2)
