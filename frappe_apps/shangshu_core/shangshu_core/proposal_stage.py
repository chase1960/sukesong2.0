"""候选的**暂存**态：在审核中心先存着，**正式值一个字都不改**。

用户 2026-10-25 原话：
「审核中心那套候选在生成候选之后……那个要直接落到表格单元格，
**在单元格里单击等同于在审核中心暂存**。」

**三件事不许混**（本模块存在的全部理由）：

* **暂存** ＝ 在审核中心把这一项**标记成「我看过、先存着」** ⇒ **正式值不动**；
* **采用** ＝ 走 `/accept` ⇒ **那才写正式值**（写入只发生在那一步）；
* **整组保存** ＝ 域声明的 `all-or-nothing` ⇒ `/accept` 时照旧执行。

⚠️ **暂存不绕开整组规则**：暂存**只是标记** ⇒ 这里**不跑** `check_review_group`；
真正 `/accept` 时那条规则**照旧**跑（一个字都没放宽）——
暂存过的项**不算「已核对完」**，因为它一个字都还没提交。
（契约 `contracts/review-center-v1.json` §save_policy：整组规则是**提交**那一侧的闸。）

本模块与 `proposal_review.py` 共用同一份 `review_state_json`：
多一个 `staged` 字典（与 `accepted` / `rejected` **同形**：`{unit_id: {...}}`）。
"""
import re

import frappe
from frappe.utils import now_datetime


_OP_ID_RE = re.compile(r'[A-Za-z0-9_.:\-]{1,200}')
MAX_UNITS = 20000


def _check_op_id(op_id, label):
    if not isinstance(op_id, str) or not _OP_ID_RE.fullmatch(op_id):
        frappe.throw('%s必须提供稳定的 op_id' % label, frappe.ValidationError)


def _check_units(units):
    if (not isinstance(units, list) or not units or len(units) > MAX_UNITS
            or any(not isinstance(u, str) for u in units) or len(set(units)) != len(units)):
        frappe.throw('units 必须是没有重复的审核项 ID 列表', frappe.ValidationError)


def _next_state(state):
    """暂存/取消暂存用的下一份状态（**逐个键拷贝** ⇒ 不改到读进来的那份）。"""
    from shangshu_core.proposal_review import staged_table
    return {**state, 'sequence': int(state.get('sequence', 0)) + 1,
            'accepted': dict(state.get('accepted', {})),
            'rejected': dict(state.get('rejected', {})),
            'staged': dict(staged_table(state)),
            'operations': dict(state.get('operations', {})),
            'reject_operations': dict(state.get('reject_operations', {})),
            'stage_operations': dict(state.get('stage_operations', {})),
            'unstage_operations': dict(state.get('unstage_operations', {})),
            'baselines': dict(state.get('baselines', {}))}


def stage_action_proposal_units(proposal_id, op_id, expected_review_revision,
                                 units=None, edited_value=None):
    """把选中的审核项**暂存**起来：只标记，**不写任何正式值**。

    回执形状照 `/accept`：`staged_units` ＝ 本次暂存了哪几项，
    `idempotent` ＝ 是不是同一个 `op_id` 的重放。

    * **幂等**：同一个 `op_id` 再来一次 ⇒ 回同一份回执，**不产生第二次效果**
      （换选中项或换值 ⇒ 拒，不许借重放改内容）。
    * **乐观锁**：`expected_review_revision` 对不上 ⇒ **明确拒**，**不落任何状态**。
    * **不绕开整组规则**：这里**不跑** `check_review_group`（暂存只是标记）；
      `/accept` 时那条规则照旧跑。
    """
    from shangshu_core.proposal_review import (
        _load, _public, _snapshot, canonical, operation_fingerprint, review_revision,
        select_units)
    _check_op_id(op_id, '暂存')
    if units is not None:
        _check_units(units)
    edits = edited_value if edited_value is not None else {}
    if not isinstance(edits, dict):
        frappe.throw('edited_value 必须是审核项 ID 到候选值的映射', frappe.ValidationError)
    proposal, payload, state = _load(proposal_id, 'resolve', lock=True)
    fingerprint = operation_fingerprint(units, edits)
    previous = (state.get('stage_operations') or {}).get(op_id)
    if previous:
        # 幂等重放：**先认旧回执**再挑新项（不然会被当成「已处理」而误判）。
        if previous.get('fingerprint') != fingerprint:
            frappe.throw('同一个暂存 op_id 不能换选中项或候选值', frappe.ValidationError)
        return _public(proposal, state, _snapshot(proposal, payload, state),
                       staged_units=previous.get('units') or [], idempotent=True)
    if proposal.status != 'Proposed':
        frappe.throw('该提案已结束，不能再暂存候选', frappe.ValidationError)
    from shangshu_core.actions import _assert_proposal_definition
    _assert_proposal_definition(proposal)
    snapshot = _snapshot(proposal, payload, state, 'resolve')
    if (not isinstance(expected_review_revision, str)
            or expected_review_revision != review_revision(proposal.name, state, snapshot.get('version'))):
        frappe.throw('审核或正式记录已更新，请刷新候选后再暂存；本次未保存',
                     frappe.TimestampMismatchError)
    try:
        selected = select_units(snapshot['units'], state.get('accepted', {}), units, edits,
                                state.get('rejected', {}))
    except frappe.ValidationError as error:
        frappe.throw('不能暂存：%s' % error, frappe.ValidationError)
    # ⚠️ **这里刻意不跑 `check_review_group`** —— 暂存**只是标记**，
    #    整组规则是**提交**那一侧的闸（`/accept` 时照旧跑，没放宽）。
    next_state = _next_state(state)
    after = _snapshot(proposal, payload, next_state, 'resolve')
    by_unit = {unit['unit_id']: unit for unit in after.get('units') or []}
    at = str(now_datetime())
    for uid in selected:
        unit = by_unit.get(uid) or {}
        next_state['staged'][uid] = {
            'by': frappe.session.user, 'at': at,
            # 暂存的是**候选值**（人改过就是改后的那个）；正式值另记在 `before`。
            'value': edits.get(uid, unit.get('value')),
            'before': unit.get('current_value'),
            **({'edited_value': edits[uid]} if uid in edits else {})}
    next_state['stage_operations'][op_id] = {'fingerprint': fingerprint, 'units': list(selected)}
    proposal.review_state_json = canonical(next_state)
    proposal.save(ignore_permissions=True)
    return _public(proposal, next_state, after, staged_units=selected, idempotent=False)


def unstage_action_proposal_units(proposal_id, op_id, expected_review_revision, units=None):
    """取消暂存：这一项回到「待确认」（`pending`），**正式值一个字都不动**。

    回执形状照 `/accept`：`unstaged_units` ＝ 这次取消了几项。
    """
    from shangshu_core.proposal_review import (
        _load, _public, _snapshot, canonical, review_revision)
    _check_op_id(op_id, '取消暂存')
    _check_units(units)
    proposal, payload, state = _load(proposal_id, 'resolve', lock=True)
    previous = (state.get('unstage_operations') or {}).get(op_id)
    if previous:
        if sorted(previous.get('units') or []) != sorted(units):
            frappe.throw('同一个取消暂存 op_id 不能换选中项', frappe.ValidationError)
        return _public(proposal, state, _snapshot(proposal, payload, state),
                       unstaged_units=previous.get('units') or [], idempotent=True)
    if proposal.status != 'Proposed':
        frappe.throw('该提案已结束，不能再取消暂存', frappe.ValidationError)
    from shangshu_core.actions import _assert_proposal_definition
    _assert_proposal_definition(proposal)
    snapshot = _snapshot(proposal, payload, state, 'resolve')
    if (not isinstance(expected_review_revision, str)
            or expected_review_revision != review_revision(proposal.name, state, snapshot.get('version'))):
        frappe.throw('审核或正式记录已更新，请刷新候选后再取消暂存；本次未保存',
                     frappe.TimestampMismatchError)
    known = {unit['unit_id'] for unit in snapshot.get('units') or []}
    closed = set(state.get('accepted', {})) | set(state.get('rejected', {}))
    if any(uid not in known for uid in units):
        frappe.throw('审核项无效，请刷新候选后再操作', frappe.ValidationError)
    if any(uid in closed for uid in units):
        frappe.throw('这一项已经保存或已放弃，不能取消暂存', frappe.ValidationError)
    next_state = _next_state(state)
    removed = [uid for uid in units if uid in next_state['staged']]
    for uid in removed:
        next_state['staged'].pop(uid, None)
    next_state['unstage_operations'][op_id] = {'units': list(units)}
    proposal.review_state_json = canonical(next_state)
    proposal.save(ignore_permissions=True)
    return _public(proposal, next_state, snapshot, unstaged_units=removed, idempotent=False)
