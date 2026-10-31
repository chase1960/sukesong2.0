"""**银聆尚书 —— 判据公用件**（跨域、跨层共用那些「造出来的东西」只许有一份）。

**为什么有这个包**（仓库约定 §13「公共工具只留一份」）：
判据要「在没有站点的机器上把 `frappe` 装上」这件事，**以前每个域各造各的** ——
example 域一份、device_client 域一份（PKG-109 为修那 10 条红加的）、工具区还有一份**通用自动桩**
（那是「让 import 过」的机制，**不是拟真桩**，见 `scripts/tests/_f_module_seam.py`）
⇒ **拟真桩两份** ⇒ 改一处就可能让另一个域变样。

⇒ **这一份**（`shangshu_testkit.frappe_stub`）是**拟真替身的唯一实现**。

**它在哪儿 ⇒ 各域怎么够着它**（2026-10-25 实测撞出来的，PKG-110）：
公共件在**仓库 tools 区**（`scripts/`）⇒
· **离线（仓库布局）**：域判据那层**往上找两级的 `scripts/`** ⇒ 够得着 ⇒ 替身装得上；
· **站上（bench 形状）**：**没有 tools 区**（`ops/docker/scripts/sync-apps.sh` 只搬 `frappe_apps/<app>`）
  ⇒ 够不着 ⇒ **两域各走各的那条路**：
  —— **example 域**：站上有**真 frappe** ⇒ 替身用不着 ⇒ 转发件降级成「什么都不装」；
  —— **device_client 域**：那一层**要的是「自己那份」frappe**（`get_app_path` 得指到临时目录）⇒
     **站上跑不了** ⇒ **明说跳过**，**不假装跑过**。

**它故意不做的事**（这一条最要紧，别顺手加）：
**不提供 `frappe.tests.*`** —— 站上判据那套写法是
「`try: import frappe; from frappe.tests.utils import FrappeTestCase` ⇒ `HAS_FRAPPE = True`」
⇒ 替身**一旦提供了** `frappe.tests.utils`，那 **141 条「站上才跑」的判据就会假装能跑**；
而替身给的 `FrappeTestCase` 是个**桩类**（不是 `unittest.TestCase` 子类）
⇒ 挂在它下面的**整个测试类不被 unittest 收集** ⇒ **141 条凭空消失**（报告上看着更绿）
⇒ **假绿**。⇒ 判据：`scripts/tests/check-frappe-stub-single-source.test.mjs` 第 ④ 条钉死这一条。
"""
