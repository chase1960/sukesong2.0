"""Atomic, domain-defined per-unit review of one original managed proposal.

The core owns state/idempotency/audits; private domain hooks describe units and
prepare a payload for the existing registered action. No domain edits this table.

同一原提案的逐项确认；领域只描述目标，核心管理确认、幂等与审计。
"""
import hashlib
import json
import re

import frappe
from frappe.utils import now_datetime
from shangshu_core.domain_execution import resource_execution


# 合并说明：fast 那边整份重写了本模块（`_json`/`_canonical`/`_hook`/`_load`/`_revision`/
# `_view`/`get_action_proposal_review`/`accept_action_proposal_units`），与本分支的同名函数
# **一对一撞名**，不能并存。取本分支这一版（它是后继实现：多了逐项放弃、bind、
# legacy_edit、assert_no_pending_proposal_reviews、按 purpose/decision 分流的鉴权），
# 并把 fast 那版**独有**的三样补进来：
#   ① `_hook` 的**归属闸**：审核回调必须来自动作原域（owner_app. 前缀）；
#   ② `_load` 的 **reference_execution 授权**（提案绑着参考执行时先验授权）；
#   ③ 审核视图里的 **adopted_value / original_value**（前端 shangshu-web/js/proposal-review.js 要读）。
# fast 那版「审核项最多 100 个」的上限本分支不取（本分支允许 20000，Excel 批量写要），
# 但已把 platform-api-v1.json 的 limit 保留为 100 —— **两处口径不一致，待主控复核**。
def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)


def read_state(proposal):
    value = proposal.get('review_state_json')
    return json.loads(value) if value else {}


def staged_table(state):
    """这条提案的**暂存表**（`{unit_id: {...}}`；与 `accepted` / `rejected` 同形）。

    读不出字典就当空表（历史提案没有这个键）——**不猜、不编**。
    """
    staged = state.get('staged') if isinstance(state, dict) else None
    return staged if isinstance(staged, dict) else {}


def stage_action_proposal_units(proposal_id, op_id, expected_review_revision,
                                 units=None, edited_value=None):
    """**暂存**候选：只标记，**正式值一个字都不改**（实现在 `proposal_stage.py`）。

    这里只当**入口**（上层只认 `proposal_review` 一个门）⇒ 真实实现放在
    `proposal_stage.py`；那边反过来 import 本模块 ⇒ 两边都**延迟 import**（没有循环依赖）。
    """
    from shangshu_core.proposal_stage import stage_action_proposal_units as _stage
    return _stage(proposal_id, op_id, expected_review_revision, units, edited_value)


def unstage_action_proposal_units(proposal_id, op_id, expected_review_revision, units=None):
    """**取消暂存**：回到「待确认」（`pending`）；**正式值一个字都不动**。"""
    from shangshu_core.proposal_stage import unstage_action_proposal_units as _unstage
    return _unstage(proposal_id, op_id, expected_review_revision, units)


def operation_fingerprint(units, edits):
    return hashlib.sha256(canonical({'units': sorted(units) if isinstance(units, list) else units,
                                     'edited_value': edits or {}}).encode()).hexdigest()


def review_revision(proposal_id, state, version):
    return hashlib.sha256(canonical([proposal_id, state.get('sequence', 0), version]).encode()).hexdigest()


def select_units(units, accepted, requested, edits, rejected=None):
    """挑选本次要**写入**的审核项。已采用、已放弃的项都不再重复写。"""
    rejected = rejected or {}
    known = {u['unit_id'] for u in units}
    closed = set(accepted) | set(rejected)
    selected = [u['unit_id'] for u in units if u['unit_id'] not in closed] if requested is None else requested
    if (not isinstance(selected, list) or not selected or len(selected) > 20000
            or any(not isinstance(u, str) or u not in known or u in closed for u in selected)
            or len(set(selected)) != len(selected)):
        frappe.throw('审核项无效、重复或已经保存，请刷新候选后再操作', frappe.ValidationError)
    if not isinstance(edits, dict) or set(edits) - set(selected):
        frappe.throw('只能编辑本次确认的候选值，不能修改目标或其他审核项', frappe.ValidationError)
    return selected


def select_rejectable(units, accepted, rejected, requested):
    """挑选本次要**放弃**的审核项。放弃不写任何正式值，因此只认「还没处理过」的项。"""
    known = {u['unit_id'] for u in units}
    closed = set(accepted) | set(rejected)
    if (not isinstance(requested, list) or not requested or len(requested) > 20000
            or any(not isinstance(u, str) or u not in known or u in closed for u in requested)
            or len(set(requested)) != len(requested)):
        frappe.throw('审核项无效、重复或已经处理，请刷新候选后再操作', frappe.ValidationError)
    return requested


def check_initial_version(state, snapshot):
    if not state.get('sequence') and snapshot.get('initial_version_matches') is False:
        frappe.throw('提案对应的原始记录已更新，请重新核对并提议；本次未保存', frappe.TimestampMismatchError)


def check_baselines(state, units, selected):
    baseline = state.get('baselines', {})
    for unit in units:
        key = unit['unit_id']
        if key in selected and key in baseline and canonical(unit.get('comparison_value',unit.get('current_value'))) != canonical(baseline[key]):
            frappe.throw('待审位置已被其他操作修改，请重新提议；本次未保存', frappe.TimestampMismatchError)


def supports_review(action_id):
    from shangshu_core.domains import raw_resource
    _, resource = raw_resource('actions', action_id)
    return bool((resource or {}).get('review_handler'))


# 动作声明里「这一组不许部分保存」的**两档**（内核契约 `contracts/review-center-v1.json` §save_policy）。
# ⚠️ 这两个值是**内核与域之间**的私有约定（域贡献里的私有键），**不进公开协议**（不投给浏览器）。
REVIEW_SAVE_POLICY_ALL_OR_NOTHING = 'all-or-nothing'
REVIEW_SAVE_POLICY_PARTIAL = 'partial'
REVIEW_SAVE_POLICIES = (REVIEW_SAVE_POLICY_ALL_OR_NOTHING, REVIEW_SAVE_POLICY_PARTIAL)


def normalize_review_save_policy(value, declared=True):
    """**纯函数**：把动作声明里写的保存方式认成合法档位。

    返回 `(生效档位, 声明原值 or None, 这个值认不认)`。

    · **没声明**（`declared=False`，即声明里**压根没有这个键**）⇒
      `('partial', None, True)` —— **老口径不许变**：没声明就是允许部分保存
      （邮件域／文件域都靠它）。
    · 声明了**认得**的值（`'all-or-nothing'`／`'partial'`）⇒ 原样。
    · 声明了**不认**的值（拼错／大小写不同／下划线／**空串**／`null`）⇒
      **按最严那档处理**（`'all-or-nothing'`）—— **fail-closed：宁肯多拦，不可少拦**。
      写错一个字母若照旧当「允许部分保存」放行，example「一份文件带动的修改不许
      部分保存」这条保证就**静默失效**（前端还照拦，后台绕过去就能只保存一半）。

    ⚠️ **「没声明」与「声明了但值是空的」是两回事**：
    前者是域**没提这件事**（⇒ 老口径，允许部分保存）；
    后者是域**提了、但没提对**（模板渲染出空值／写成 `null`）⇒ **按最严那档**。
    混成一样 ⇒ 空值那个洞就又漏回来了（后台放行、前端照拦 ⇒ 两边不一致）。

    先例：账号与权限契约「表级也未声明 ⇒ **拒绝**（fail-closed）」——
    同一方向的规矩：**读不懂就不许放行**。
    """
    if not declared:
        return REVIEW_SAVE_POLICY_PARTIAL, None, True
    if isinstance(value, str) and value in REVIEW_SAVE_POLICIES:
        return value, value, True
    # 声明了却不认 ⇒ 最严那档（**原值留着**，报错文案要说清域写的是什么）。
    return REVIEW_SAVE_POLICY_ALL_OR_NOTHING, value, False


def review_save_policy_state(action_id):
    """这条动作的保存方式：`(生效档位, 声明原值 or None, 值认不认)`（**一次读回**）。

    ⚠️ **「键在不在」要单独判**（`'review_save_policy' in resource`）——
    `.get()` 分不清「键不存在」与「键在但值是空的」⇒ 那个洞会漏回来。
    """
    from shangshu_core.domains import raw_resource
    _, resource = raw_resource('actions', action_id)
    resource = resource or {}
    declared = 'review_save_policy' in resource
    return normalize_review_save_policy(resource.get('review_save_policy'), declared=declared)


def review_save_policy(action_id):
    """这条动作的**生效保存方式**（域在动作声明里写的，PKG-033-T01）。

    · `'all-or-nothing'` ＝ **这一组不许部分保存**（example：一份官文带动的整组正式变化）；
    · `'partial'` ＝ 允许部分保存（只保存选中的那几个 unit）；
    · **没声明** ⇒ `'partial'`（老口径：邮件域／文件域都靠它）；
    · **声明了不认的值** ⇒ **按 `'all-or-nothing'` 处理（最严那档）** ——
      写错一个字母就静默放行 ⇒「不许部分保存」这条保证就没了 ⇒ **宁肯多拦，不可少拦**。

    ⇒ **只返回两档之一**（不认识的原值不往外露）。

    口径来自内核契约 `contracts/review-center-v1.json` §save_policy：
    **前后端共同执行** —— 前端拦一道，后端也拦一道，后台绕不过去。
    """
    effective, _, _ = review_save_policy_state(action_id)
    return effective


def validate_review_save_policy_declaration(domain_id, action_id, value):
    """**注册期**那道闸：域在动作上声明的保存方式不认 ⇒ **当场拒并点名**。

    为什么要有这道（运行时那道已经是 fail-closed，但**静默**降级没人看得见）：
    域把值写错 ⇒ 注册期就拒，当场说清**是哪个动作、写的什么值、合法值是哪两个**
    ⇒ 域当场改对；不许「声明说了不算、运行时悄悄按最严那档跑」。

    先例：内核契约 `contracts/review-center-v1.json` §5「域写产品没有的那一档 ⇒
    **注册当场拒**（不许『声明说了不算』）」；账号与权限契约「表级也未声明 ⇒ 拒绝
    （fail-closed），且**编译期就要报错**，不许拖到运行时」。
    """
    _, declared, known = normalize_review_save_policy(value)
    if known:
        return
    frappe.throw(
        '领域贡献里动作声明的 review_save_policy 值不合法：%s/%s 写的是 %r，'
        '合法值只有 %r 或 %r' % (domain_id, action_id, declared,
                                REVIEW_SAVE_POLICY_ALL_OR_NOTHING, REVIEW_SAVE_POLICY_PARTIAL),
        frappe.ValidationError)


def validate_review_save_policy_declarations(domain_id, actions):
    """域贡献里**每个动作**的保存方式声明（注册期那道闸；没声明的放过）。"""
    for item in actions or []:
        if not isinstance(item, dict) or 'review_save_policy' not in item:
            continue
        validate_review_save_policy_declaration(domain_id, str(item.get('id') or '').strip(),
                                                item.get('review_save_policy'))


def _as_text(value):
    """候选值/正式值的统一读法（`{type, value}` 取出 value；空 ⇒ 空串）。"""
    if isinstance(value, dict) and 'value' in value:
        value = value.get('value')
    if value is None:
        return ''
    if isinstance(value, str):
        return value
    return canonical(value)


def unit_has_difference(unit):
    """这一项**是不是有差异**。

    ⚠️ **未知/失败不能当成相同**（契约 §interaction.no_diff_hidden）：
    连正式值这一栏都没有 ⇒ 读不到 ⇒ 算有差异（必须一起提交，不许悄悄跳过）。
    """
    if 'comparison_value' in unit:
        current = unit.get('comparison_value')
    elif 'current_value' in unit:
        current = unit.get('current_value')
    else:
        return True
    return _as_text(current) != _as_text(unit.get('value'))


def check_review_group(policy, units, accepted, rejected, selected, note=''):
    """**整组保存**的后端闸。

    只交了一部分 ⇒ **拒**（前端也拦，但**后台不能绕过**）。
    相同项不属于待写变化 ⇒ 不算「没核对完」；已放弃（rejected）的项也不算。

    ⚠️ **fail-closed**：这里**只认两个已知值**（`'all-or-nothing'`／`'partial'`）；
    **不认的值按最严那档（`'all-or-nothing'`）处理** ——
    写错一个字母就放行的话，「不许部分保存」这条保证会**静默失效**。

    · `policy` = **生效档位**（调用方已认过值：没声明那档由
      `review_save_policy_state` 分辨「键在不在」后给出来）；
    · `note` = 认值时顺带说明（可选）—— 域把值写错时，报错要说清**它写的是什么**。
    """
    effective, declared, known = normalize_review_save_policy(policy, declared=True)
    if effective != REVIEW_SAVE_POLICY_ALL_OR_NOTHING:
        return
    closed = set(accepted) | set(rejected)
    selected_set = set(selected)
    missing = [u for u in units
               if u['unit_id'] not in closed
               and u['unit_id'] not in selected_set
               and unit_has_difference(u)]
    if missing:
        if not known:
            note = note or ('（动作声明的 review_save_policy 值 %r 不认，'
                            '按最严那档 %r 处理）'
                            % (declared, REVIEW_SAVE_POLICY_ALL_OR_NOTHING))
        frappe.throw('这一组必须整组一起提交：还有 %d 项没核对完，本次未保存%s'
                     % (len(missing), note),
                     frappe.ValidationError)


@resource_execution('actions', 'action_id')
def _hook(action_id, payload, state, request, actor_user):
    from shangshu_core.domains import raw_resource
    domain, resource = raw_resource('actions', action_id)
    handler = (resource or {}).get('review_handler')
    if not handler:
        frappe.throw('该动作暂不支持逐项审核，请使用原确认入口', frappe.ValidationError)
    # 合并说明（来自 fast 那版）：**归属闸** —— 逐项审核回调必须来自动作原域的实现路径，
    # 不许别的域把自己的 review_handler 挂到别人的动作上。与 domains.py 对 handler 的同一道闸同口径。
    owner = frappe.db.get_value('Shangshu Domain', domain['id'], 'owner_app') if domain else ''
    if not owner or not str(handler).startswith(str(owner) + '.'):
        frappe.throw('该动作未声明本域逐项审核能力', frappe.ValidationError)
    return frappe.get_attr(handler)(action_id, payload, state, request, actor_user)


def _load(proposal_id, purpose, lock=False, decision=None):
    from shangshu_core.actions import _definition, _assert_action_role, _assert_proposal_target, _json, _proposal_eligible
    from shangshu_core.identity import get_identity
    proposal = frappe.get_doc('Shangshu Action Proposal', proposal_id, for_update=lock)
    if proposal.enterprise_id != get_identity().enterprise_id:
        frappe.throw('当前用户无权查看或处理该提案', frappe.PermissionError)
    if not _proposal_eligible(proposal, frappe.get_roles()):
        frappe.throw('当前用户无权查看或处理该提案', frappe.PermissionError)
    _assert_action_role(_definition(proposal.action_id, proposal.action_version))
    # 合并说明（来自 fast 那版）：提案绑着**参考执行**时，先验该参考执行的授权 ——
    # 租约被撤销/过期后，发起人自己也不能再拿这条提案去确认。
    # ⚠️ 只对**发起人本人**加这道闸：fast 那版的审核人只有发起人本人，
    # 而本分支还允许「指定审核人（表主）」处理别人发起的提案 ——
    # 让表主去校验别人的助手执行租约会误伤（且会在只读路径上抢行锁）。
    if proposal.reference_execution and str(proposal.actor_user or '').lower() == str(frappe.session.user or '').lower():
        from shangshu_core.reference_work import authorize_execution
        authorize_execution(proposal.reference_execution)
    payload = _json(proposal.payload_json, {})
    state = read_state(proposal)
    if decision == 'rejected':
        # Discard authorization is domain-defined; an invalid original target
        # must not prevent its author from dropping an otherwise authorized
        # suggestion. No opt-in receipt means the original guard still applies.
        authorization = _hook(proposal.action_id, payload, state,
                      {'operation':'authorize', 'purpose':purpose, 'decision':'rejected'}, proposal.actor_user)
        if not isinstance(authorization,dict) or authorization.get('rejection_authorized') is not True:
            _assert_proposal_target(proposal.action_id, payload, purpose, proposal.actor_user, state)
    else:
        _assert_proposal_target(proposal.action_id, payload, purpose, proposal.actor_user, state)
        _hook(proposal.action_id, payload, state, {'operation':'authorize', 'purpose':purpose}, proposal.actor_user)
    return proposal, payload, state


def authorize_bound_review(proposal, purpose='read'):
    """Additional current-resource check for generic listings after first binding."""
    if supports_review(proposal.action_id):
        _hook(proposal.action_id, json.loads(proposal.payload_json), read_state(proposal),
              {'operation':'authorize','purpose':purpose}, proposal.actor_user)


def locate_proposal_target(action_id, payload, state=None, actor_user=None):
    """这条提案**落在哪张表/哪一行**？（列表定位用；**只读**，不写任何正式值）

    载荷里已经带了 `table` 的提案**不用问域**（调用方自己判）⇒ 列表不会平白多出 N 次域调用。
    **问不出来**（域没声明逐项审核／域不认这个操作／读不到）⇒ 回 `None`，调用方照旧。

    ⚠️ **不缓存**：example 那条的目标是「官文挂在哪张表的哪一行」——
    绑定关系会变（官文改挂别的案件行），缓存下来的目标会**把人指到错的行**。
    代价：列表里**定位不到**的那些提案各多一次域调用（与列表已有的
    `authorize_bound_review` 域调用同一量级）。
    """
    from shangshu_core.domains import raw_resource
    _, resource = raw_resource('actions', action_id)
    if not (resource or {}).get('review_handler'):
        return None
    try:
        target = _hook(action_id, payload, state or {},
                       {'operation':'target','purpose':'read'}, actor_user)
    except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
        return None
    return target if isinstance(target, dict) and target else None


def _snapshot(proposal, payload, state, purpose='read'):
    return _hook(proposal.action_id, payload, state,
                 {'operation':'describe','purpose':purpose}, proposal.actor_user)


def _public(proposal, state, snapshot, **extra):
    from shangshu_core.action_provenance import project_action_provenance
    visible_ids = {u['unit_id'] for u in snapshot['units']}
    accepted = {k:v for k,v in state.get('accepted', {}).items() if k in visible_ids}
    # 逐项放弃的项也算「处理过」：不算剩余，也不再被当成可采用的候选。
    rejected = {k:v for k,v in state.get('rejected', {}).items() if k in visible_ids}
    # **暂存**（PKG-118-T01）：「在审核中心存着」——**既没采用、也没放弃**。
    # 已经采用/放弃的项**不再**算暂存（状态不许说两遍）。
    staged = {k:v for k,v in staged_table(state).items()
              if k in visible_ids and k not in accepted and k not in rejected}
    terminal = proposal.status != 'Proposed'
    if snapshot.get('review_scope'):
        extra = {**extra, 'result':None}
        if 'accepted_units' in extra:
            extra['accepted_units'] = [u for u in extra['accepted_units'] if u in visible_ids]
        if 'rejected_units' in extra:
            extra['rejected_units'] = [u for u in extra['rejected_units'] if u in visible_ids]
        if 'staged_units' in extra:
            extra['staged_units'] = [u for u in extra['staged_units'] if u in visible_ids]
        if 'unstaged_units' in extra:
            extra['unstaged_units'] = [u for u in extra['unstaged_units'] if u in visible_ids]
    units = [{**{k:v for k,v in unit.items() if k != 'comparison_value'},
              'status': ('accepted' if unit['unit_id'] in accepted or (proposal.status == 'Confirmed' and unit['unit_id'] not in rejected)
                         else 'rejected' if unit['unit_id'] in rejected or terminal
                         # **暂存 ≠ 采用 ≠ 保存**：单独一个状态值，不许混进 accepted。
                         else 'staged' if unit['unit_id'] in staged
                         else 'pending'),
              # 合并说明（来自 fast 那版）：已采用的项要带**采用值**与**原值** ——
              # 前端 shangshu-web/js/proposal-review.js 读 unit.adopted_value / unit.original_value。
              # 没采用的项不加这两个键，前端会回落到 unit.value / unit.current_value。
              **({'adopted_value':accepted[unit['unit_id']].get('value'),
                  'original_value':accepted[unit['unit_id']].get('before')}
                 if unit['unit_id'] in accepted else {}),
              # **暂存值**：暂存时人改过的那个候选（没改过就等于 `unit.value`）。
              # 少了它，前端会把**暂存的那一格**显示成没改过的候选 ⇒ 人看到的是假值。
              **({'staged_value':staged[unit['unit_id']].get('value')}
                 if unit['unit_id'] in staged else {})}
             for unit in snapshot['units']]
    return {'id':proposal.name, 'capability':proposal.action_id, 'status':proposal.status.lower(),
            'created_via':proposal.created_via, 'action_version':proposal.action_version,
            'source_provenance':project_action_provenance(proposal.get('source_snapshot_json')),
            'review_revision':review_revision(proposal.name,state,snapshot.get('version')),
            'target':snapshot.get('target',{}), 'units':units,
            # **暂存项不再算「还要核对」**（前端按 pending 数核对剩余数 ⇒ 两边要对得上）。
            'remaining':0 if terminal else len(units)-len(accepted)-len(rejected)-len(staged),
            'accepted_count':len(accepted) if rejected else (len(units) if proposal.status == 'Confirmed' else len(accepted)),
            'rejected_count':len(rejected),
            'staged_count':len(staged),
            # Domain results can contain values for now-hidden accepted units.
            # A field-projected descriptor does not expose the old raw receipt.
            'result':None if snapshot.get('review_scope') else state.get('result'),
            'review_scope':snapshot.get('review_scope','all'), 'audit':proposal.execution_audit,
            **extra}


def get_action_proposal_review(proposal_id):
    proposal, payload, state = _load(proposal_id, 'read')
    snapshot = _snapshot(proposal,payload,state)
    can_accept = False
    can_reject = False
    reject_reason = '该建议已结束'
    if proposal.status == 'Proposed':
        try:
            _load(proposal_id, 'resolve', decision='rejected')
            can_reject = True
            reject_reason = ''
        except (frappe.PermissionError, frappe.ValidationError):
            reject_reason = '你没有放弃此建议的权限'
    reason = '该建议已结束，请重新提出建议'
    if proposal.status == 'Proposed':
        try:
            # Read access is not write authority. These checks never execute an
            # action, lock a record, or change the proposal.
            _load(proposal_id, 'resolve')
            from shangshu_core.actions import _assert_proposal_definition
            _assert_proposal_definition(proposal, lock=False)
            writable = _snapshot(proposal,payload,state,'resolve')
            selected = [u['unit_id'] for u in writable['units']
                        if u['unit_id'] not in state.get('accepted', {})
                        and u['unit_id'] not in state.get('rejected', {})]
            check_initial_version(state,writable)
            check_baselines(state,writable['units'],selected)
            can_accept = bool(selected) and writable.get('writable', True) is not False
            reason = '' if can_accept else '当前内容不可修改，请重新提出建议'
        except frappe.PermissionError:
            reason = '你没有修改此内容的权限'
        except frappe.TimestampMismatchError:
            reason = '原内容已更新，请重新提出建议'
        except frappe.ValidationError:
            reason = '当前建议不可执行，请重新提出建议'
    return _public(proposal,state,snapshot,can_accept=can_accept,accept_unavailable_reason=reason,
                   can_reject=can_reject,reject_unavailable_reason=reject_reason)


def _action_key(proposal, op_id):
    return 'proposal-review:' + hashlib.sha256((proposal.name+'\0'+op_id).encode()).hexdigest()


def _execute(proposal, payload, key, unit_ids):
    from shangshu_core.actions import execute_registered_action
    previous = getattr(frappe.flags,'shangshu_resolving_proposal',None)
    context = getattr(frappe.flags,'shangshu_review_context',None)
    conversation_prior = getattr(frappe.flags, 'shangshu_resolving_conversation_key', None)
    frappe.flags.shangshu_resolving_conversation_key = proposal.get('conversation_key') or ''
    frappe.flags.shangshu_resolving_proposal = proposal.name
    frappe.flags.shangshu_review_context = {'proposal_id':proposal.name,'units':unit_ids}
    try:
        return execute_registered_action(proposal.action_id,payload,confirmed=True,
                   idempotency_key=key,source=proposal.created_via or 'ai',
                   action_version=proposal.action_version,execution_id=proposal.reference_execution)
    finally:
        frappe.flags.shangshu_resolving_conversation_key = conversation_prior
        frappe.flags.shangshu_resolving_proposal = previous
        frappe.flags.shangshu_review_context = context


def accept_action_proposal_units(proposal_id, op_id, expected_review_revision, units=None, edited_value=None):
    if not isinstance(op_id,str) or not re.fullmatch(r'[A-Za-z0-9_.:\-]{1,200}',op_id):
        frappe.throw('逐项审核必须提供稳定的 op_id',frappe.ValidationError)
    if units is not None and (not isinstance(units,list) or not units or len(units)>20000
            or any(not isinstance(u,str) for u in units) or len(set(units))!=len(units)):
        frappe.throw('units 必须是没有重复的审核项 ID 列表',frappe.ValidationError)
    edits = edited_value if edited_value is not None else {}
    if not isinstance(edits,dict):
        frappe.throw('edited_value 必须是审核项 ID 到候选值的映射',frappe.ValidationError)
    proposal,payload,state = _load(proposal_id,'resolve',lock=True)
    fingerprint = operation_fingerprint(units,edits)
    previous = state.get('operations',{}).get(op_id)
    if previous:
        if previous['fingerprint'] != fingerprint:
            frappe.throw('同一个审核 op_id 不能换选中项或候选值',frappe.ValidationError)
        # The original action replay guard revalidates present access to the bound
        # result as well. Return its first receipt; never run a fresh write.
        receipt = _execute(proposal,previous['payload'],previous['key'],previous['units'])
        return _public(proposal,state,_snapshot(proposal,payload,state),
                       accepted_units=previous['units'],result=receipt.get('result'),
                       audit=receipt.get('audit'),idempotent=True)
    if proposal.status != 'Proposed':
        frappe.throw('该提案已结束，不能再保存候选值',frappe.ValidationError)
    from shangshu_core.actions import _assert_proposal_definition
    _assert_proposal_definition(proposal)
    snapshot = _snapshot(proposal,payload,state,'resolve')
    if not isinstance(expected_review_revision,str) or expected_review_revision != review_revision(proposal.name,state,snapshot.get('version')):
        frappe.throw('审核或正式记录已更新，请刷新候选后再确认；本次未保存',frappe.TimestampMismatchError)
    selected = select_units(snapshot['units'],state.get('accepted',{}),units,edits,state.get('rejected',{}))
    # **暂存时人改过的值，跟着采用走**（PKG-118-T01）：暂存不是丢字的地方 ——
    # 暂存时把候选改过，采用时就按那个值写；这一次又改了 ⇒ 以这次的为准。
    # ⚠️ 幂等指纹仍按**本次请求的** `edited_value` 算（不掺暂存值）——
    #    否则「暂存过」会把同一个 op_id 的重放判成「换了候选值」。
    staged_edits = {uid: entry.get('edited_value') for uid, entry in staged_table(state).items()
                    if uid in selected and entry.get('edited_value')}
    effective_edits = {**staged_edits, **edits}
    # **整组保存的后端闸**（PKG-033-T01）：域声明了「这一组不许部分保存」⇒
    # 只交一部分 ⇒ 拒（前后端共同执行，后台绕不过去）。放在写之前 ⇒ 拒了就是零写入。
    # ⚠️ **暂存过的项不算「已核对完」**（它一个字都还没提交）⇒ 这道闸**没被暂存放宽**。
    # ⚠️ 传的是**声明原值**（可能拼错）⇒ 闸里自己认值（不认 ⇒ 按最严那档），
    #    报错文案里说得清「写错的值按最严那档处理」。
    effective_policy, declared_policy, policy_known = review_save_policy_state(proposal.action_id)
    # 域把值写错 ⇒ 报错要说清**它写的是什么**（而不是只说「不认」）。
    policy_note = '' if policy_known else (
        '（动作声明的 review_save_policy 值 %r 不认，按最严那档 %r 处理）'
        % (declared_policy, REVIEW_SAVE_POLICY_ALL_OR_NOTHING))
    check_review_group(effective_policy, snapshot['units'],
                       state.get('accepted', {}), state.get('rejected', {}), selected,
                       note=policy_note)
    check_initial_version(state,snapshot)
    check_baselines(state,snapshot['units'],selected)
    key = _action_key(proposal,op_id)
    plan = _hook(proposal.action_id,payload,state,
                 {'operation':'prepare','purpose':'resolve','units':selected,'edited_value':effective_edits,
                  'op_id':key,'snapshot':snapshot},proposal.actor_user)
    # Nothing is persisted before the registered action succeeds. Its exception
    # path can rollback the whole transaction, so do not save stale state after it.
    receipt = _execute(proposal,plan['payload'],key,selected)
    next_state = {**state, 'sequence':int(state.get('sequence',0))+1,
                  'accepted':dict(state.get('accepted',{})),
                  'rejected':dict(state.get('rejected',{})),
                  'staged':dict(staged_table(state)),
                  'operations':dict(state.get('operations',{})),
                  'reject_operations':dict(state.get('reject_operations',{})),
                  'stage_operations':dict(state.get('stage_operations',{})),
                  'unstage_operations':dict(state.get('unstage_operations',{})),
                  'baselines':dict(state.get('baselines',{}))}
    next_state['bound_target'] = _hook(proposal.action_id,payload,state,
               {'operation':'bind','purpose':'resolve','result':receipt.get('result'),
                'plan':plan},proposal.actor_user)
    after = _snapshot(proposal,payload,next_state,'resolve')
    # Capture the formal values of still-pending units AFTER the first commit
    # (e.g. newly-created empty draft defaults), never the unaccepted candidates.
    # 合并说明（来自 fast 那版）：写前快照的正式值一并留下 —— 它就是这一项的**原值**。
    before_values = {u['unit_id']: u.get('current_value') for u in snapshot.get('units', [])}
    for unit in after['units']:
        uid = unit['unit_id']
        if uid not in next_state['baselines']:
            next_state['baselines'][uid] = unit.get('comparison_value',unit.get('current_value'))
        if uid in selected:
            next_state['accepted'][uid] = {'by':frappe.session.user,'at':str(now_datetime()),
                                           'audit':receipt.get('audit'),
                                           # 采用值 = 写后快照里的正式值；原值 = 写前快照里的正式值。
                                           # 审核视图（_public）把它们回给前端。
                                           'value': unit.get('current_value'),
                                           'before': before_values.get(uid),
                                           'edited': uid in effective_edits}
            # 这一项已经落进正式值了 ⇒ **不再算「暂存」**（状态不许说两遍）。
            next_state['staged'].pop(uid,None)
    next_state['result'] = receipt.get('result')
    next_state['operations'][op_id] = {'fingerprint':fingerprint,'payload':plan['payload'],
                                      'key':key,'units':selected,'audit':receipt.get('audit')}
    if all(uid in next_state['accepted'] or uid in next_state.get('rejected',{})
           for uid in after.get('all_unit_ids', [u['unit_id'] for u in after['units']])):
        proposal.status = 'Confirmed'
    proposal.execution_audit = receipt.get('audit')
    proposal.decision_by = frappe.session.user
    proposal.decision_at = now_datetime()
    proposal.error_message = ''
    proposal.review_state_json = canonical(next_state)
    proposal.save(ignore_permissions=True)
    return _public(proposal,next_state,after,accepted_units=selected,
                   result=receipt.get('result'),audit=receipt.get('audit'),idempotent=False)


def reject_action_proposal_units(proposal_id, op_id, expected_review_revision=None, units=None):
    """逐项放弃：只把选中的审核项标成「不采用」，**不写任何正式值**。

    用户 2026-10-19 A17：助手建议改两个格子，要能「部分采用、部分拒绝」。
    放弃是**丢弃**而不是写入，所以不查内容版本 —— 与整笔放弃同一口径：
    否则「先采用一格、表内容版本 +1」会把「再放弃另一格」顶掉，
    这正是用户报的「前项确认导致后项版本过期」。
    真正的安全网是：只能放弃**还没处理过**的项（已采用/已放弃都不给）。
    """
    if not isinstance(op_id,str) or not re.fullmatch(r'[A-Za-z0-9_.:\-]{1,200}',op_id):
        frappe.throw('逐项放弃必须提供稳定的 op_id',frappe.ValidationError)
    if (not isinstance(units,list) or not units or len(units)>20000
            or any(not isinstance(u,str) for u in units) or len(set(units))!=len(units)):
        frappe.throw('units 必须是没有重复的审核项 ID 列表',frappe.ValidationError)
    proposal,payload,state = _load(proposal_id,'resolve',lock=True,decision='rejected')
    if proposal.status != 'Proposed':
        frappe.throw('该提案已结束，不能再放弃候选',frappe.ValidationError)
    from shangshu_core.actions import _assert_proposal_definition
    _assert_proposal_definition(proposal)
    snapshot = _snapshot(proposal,payload,state,'resolve')
    previous = state.get('reject_operations',{}).get(op_id)
    if previous:
        if sorted(previous['units'])!=sorted(units or []):
            frappe.throw('同一个放弃 op_id 不能换选中项',frappe.ValidationError)
        return _public(proposal,state,_snapshot(proposal,payload,state),
                       rejected_units=previous['units'],idempotent=True)
    # 幂等重放要先判：同一 op_id 再来一次时这一项已经「放弃过」，
    # 按新请求去挑会误判成「已处理」，所以先认旧回执再挑新项。
    selected = select_rejectable(snapshot['units'],state.get('accepted',{}),state.get('rejected',{}),units)
    next_state = {**state, 'sequence':int(state.get('sequence',0))+1,
                  'accepted':dict(state.get('accepted',{})),
                  'rejected':dict(state.get('rejected',{})),
                  'staged':dict(staged_table(state)),
                  'operations':dict(state.get('operations',{})),
                  'reject_operations':dict(state.get('reject_operations',{})),
                  'stage_operations':dict(state.get('stage_operations',{})),
                  'unstage_operations':dict(state.get('unstage_operations',{})),
                  'baselines':dict(state.get('baselines',{}))}
    for uid in selected:
        next_state['rejected'][uid] = {'by':frappe.session.user,'at':str(now_datetime())}
        # 这一项已经不采用 ⇒ **不再算「暂存」**。
        next_state['staged'].pop(uid,None)
    next_state['reject_operations'][op_id] = {'units':list(selected)}
    all_ids = snapshot.get('all_unit_ids') or [u['unit_id'] for u in snapshot['units']]
    closed = set(next_state['accepted'])|set(next_state['rejected'])
    if all(uid in closed for uid in all_ids):
        proposal.status = 'Confirmed' if next_state['accepted'] else 'Rejected'
    proposal.decision_by = frappe.session.user
    proposal.decision_at = now_datetime()
    proposal.review_state_json = canonical(next_state)
    proposal.save(ignore_permissions=True)
    return _public(proposal,next_state,snapshot,rejected_units=selected,idempotent=False)


def resolve_review_proposal(proposal_id, decision, edited_value=None):
    """Compatibility confirmation means remaining units, never the old full payload."""
    proposal,payload,state = _load(proposal_id,'resolve',lock=True,decision=decision)
    if decision == 'rejected':
        was_rejected = proposal.status == 'Rejected'
        if edited_value is not None:
            frappe.throw('拒绝不能修改候选值',frappe.ValidationError)
        if proposal.status == 'Proposed':
            proposal.status='Rejected'; proposal.decision_by=frappe.session.user
            proposal.decision_at=now_datetime(); proposal.save(ignore_permissions=True)
        try:
            snapshot=_snapshot(proposal,payload,state)
        except (frappe.ValidationError,frappe.TimestampMismatchError,frappe.DoesNotExistError):
            # Discarding remaining suggestions must not require their old row or
            # column to survive. Current target WRITE permission was checked by
            # _load; do not invent a formal value when its position is gone.
            target=_hook(proposal.action_id,payload,state,
                         {'operation':'target','purpose':'resolve'},proposal.actor_user)
            snapshot={'units':[],'target':target or {},'version':None}
            return _public(proposal,state,snapshot,idempotent=was_rejected,current_values_unavailable=True,
                           accepted_count=len(state.get('accepted',{})))
        return _public(proposal,state,snapshot,idempotent=was_rejected)
    if proposal.status == 'Confirmed':
        if edited_value is not None:
            frappe.throw('已确认的提案不能在重试时修改建议',frappe.ValidationError)
        operations=list(state.get('operations',{}).values())
        if not operations:
            frappe.throw('没有可核实的逐项审核回执',frappe.ValidationError)
        op=operations[-1];receipt=_execute(proposal,op['payload'],op['key'],op['units'])
        return _public(proposal,state,_snapshot(proposal,payload,state),result=receipt.get('result'),idempotent=True)
    snapshot=_snapshot(proposal,payload,state,'resolve')
    edits={}
    if edited_value is not None:
        # 合并说明（2026-10-21，合并 fast 之后的语义修复）：
        # **整单确认的人工改值，先过内核这一道闸**（`_apply_edited_value`）——
        #   · `proposal_editable_fields` 是**授权闸**：域声明了哪些字段许人工改写
        #     （邮件域＝主题/正文；编号、版本、收件人、附件、权限范围不许跟着换）；
        #   · **两种载荷形状都认**：fast ＝ `{'type':'fields','value':{字段名:值}}`，
        #     我们 ＝ `{字段名:{'type':..,'value':..}}`（单值改写 `{'type','value'}` 也认）；
        #   · 并**留痕**：改前的**完整**原载荷 + 谁改的 + 改成什么（不许把人的改动
        #     冒领成「助手的稿被采用了」）。
        # ⚠️ 合并前这条路就是走内核 `_apply_edited_value`（P-⑩ 判据：改值后
        # `edited` 为真、`edited_by`/`edited_at` 可归因、`original_payload` 是改前完整原值）；
        # 合并后整单确认被分流到逐项审核口，**这一步被漏掉了** ⇒ 改值不再留痕。
        from shangshu_core.actions import _apply_edited_value, _json
        _apply_edited_value(proposal, edited_value)
        payload=_json(proposal.payload_json, {})   # 用**改后**的载荷往下走
        # 域这一道闸：它认得自己动作的候选字段形状（逐项审核的单位键），
        # 也能拒绝不该改的字段；返回的改值交回逐项审核口落进正式记录。
        edits=_hook(proposal.action_id,payload,state,
                    {'operation':'legacy_edit','purpose':'resolve','edited_value':edited_value},proposal.actor_user)
    return accept_action_proposal_units(proposal_id,
               'remaining-'+str(state.get('sequence',0))+'-'+hashlib.sha256(canonical(edits).encode()).hexdigest()[:20],
               review_revision(proposal.name,state,snapshot.get('version')),edited_value=edits)


def assert_no_pending_proposal_reviews(target):
    """Domain send gates call this with their real resource identity, never a candidate."""
    from shangshu_core.actions import _json
    from shangshu_core.identity import get_identity
    # This is a server gate, not a public discovery API: no proposal payloads or
    # identifiers are returned to the caller. Ignore unrelated review providers.
    rows=frappe.get_all('Shangshu Action Proposal',
           filters={'enterprise_id':get_identity().enterprise_id,'status':'Proposed'},
           fields=['name','action_id','payload_json','review_state_json','actor_user'])
    current=getattr(frappe.flags,'shangshu_resolving_proposal',None)
    for row in rows:
        from shangshu_core.domains import raw_resource
        domain, _ = raw_resource('actions',row.action_id)
        caller = getattr(frappe.flags,'shangshu_call_domain',None)
        if caller and caller != 'com.shangshu.core' and (not domain or domain['id'] != caller):
            continue
        if row.name == current or not supports_review(row.action_id):
            continue
        candidate=_hook(row.action_id,_json(row.payload_json,{}),read_state(row),
                        {'operation':'target','purpose':'read'},row.actor_user)
        if candidate and candidate == target:
            frappe.throw('这封草稿还有未确认的候选内容，请先逐项确认或拒绝剩余建议',frappe.ValidationError)
