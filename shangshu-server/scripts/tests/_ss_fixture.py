"""测试夹具默认值 —— **这不是产品默认值**。

**产品那边没有「默认归属」这回事**：用户 2026-10-15 选修法一「上传必填归属」，
`files.upload` / `files.create` / `files.import_attachment` **新建时必须带 `attribution`，
不带当场拒**（`service.py:_require_attribution`，判据 ATT-⑨ 钉着）。
修法三「给默认归属」用户明确拒了，B 也排除：那等于又发明一个归属，**归属决定谁看得到，
猜错就是越权**。

**那这里为什么还有个默认？** 因为测**版本 / 权限 / 结构工具**的用例
（`test-files-domain.py`、`test_pkg008_structure_tools.py` 等 31 个文件、103 处调用）
**本来就不该各讲一个归属故事** —— §13「按层测试，不让每个判断都跑完整流程」。
它们把「建个表」当准备动作，不是在测归属。

**所以**：夹具默认只服务「我在测别的东西」的用例；**测归属/权限那几个必须自己显式传**，
不许吃这个默认 —— 否则「产品必填闸坏了」和「夹具补上了」**分不开**，
空过长得跟过一模一样。

⚠️ **「不覆盖已传的」挡不住「压根没传的」**（2026-10-15 实测踩到，B 查出）：
`fill()` 只在 `payload.get('attribution')` 为空时补 —— 所以**测「不传归属」这件事**的
用例会被静默补上，前提当场被改掉。B6 就是这么红的（它前提是「无归属旧表」）。
**要测「不传」的，必须自带绕口**（像 ATT-⑨ 的 `_act9`、G1-⑧ 的 `_act8_human`，
直接打动作口、**不走 `t.action`**），或者开局清掉。靠约定隔离是不够的。

**已知被这条坑过的**：`test_b6_compat.py`（B 已修 `8d41a4e1`，开局清归属）、
`test_t06_dept_attachment_authz.py` T06-F ④（对照是「不选归属也能建」，**假绿**，
产品现在拒）。**新加「不传归属」类用例前先看这一条。**

**ATT-⑨ 物理隔离**：那组判据自带调用口 `_act9`（`test_d_relations_migrate.py`），
**不走** `t.action` / 本模块，结构上够不着这个夹具。靠约定隔离是不够的。

**默认值的写法要显式可见**：不许 `payload.setdefault(...)` 藏在角落里。
调用点是 `fill(...)`，一行看得见；`FIXTURE_ATTRIBUTION` 是个具名常量，不是字面量。
"""

# 测试夹具归属 —— 落**本人**的个人表（`owner_user` 省略 = 落调用者本人，见
# `service._apply_attribution` 的 `level == 'personal'` 分支）。
# **不是产品默认值**，见本文件顶部。
FIXTURE_ATTRIBUTION = {'level': 'personal'}

# 需要 `attribution` 的三个建表动作（与 `service._require_attribution` 的适用面一致）。
# **追版本 / 已导入早退不要** —— 那两条路不新建记录、不碰归属，产品侧也自动豁免。
ATTRIBUTION_ACTIONS = frozenset({
    'files.upload', 'files.create', 'files.import_attachment',
})


def fill(action_id, payload):
    """给需要归属的建表动作补上**测试夹具**归属；别的动作原样返回。

    **显式可见**：只有调了本函数才有默认，不是在某个深处静默兜底。
    调用方已经传了 `attribution` 就**不覆盖** —— 测归属/权限的用例自己显式传，
    我们只在「没传」时补，绝不改写别人写好的值。
    """
    if action_id not in ATTRIBUTION_ACTIONS:
        return payload
    if payload.get('attribution'):
        return payload
    return {**payload, 'attribution': dict(FIXTURE_ATTRIBUTION)}
