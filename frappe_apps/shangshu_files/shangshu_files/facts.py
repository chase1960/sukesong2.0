"""T08 动作事实：写入与明确授权内查询（PKG-001-T08）。

契约[处理契约与状态转换#action-facts]：**复用既有动作、审计与回执存储，一份权威事实可被
多处引用，不建平行日志系统。** 所以这里不新建日志表 —— `files.action_fact` 自身就是一次
受管动作，它的**执行审计行就是那条事实**，载荷里带上业务字段（操作号/动作名/目标/明细）。

两条硬口径（moniter 2026-10-14 定）：
  · `op_id` 与 `idempotency_key` **分开** —— 前者管业务对账/审计/撤回，后者管技术去重。
    照 `sheet_cells_write` 现有约定，不在这儿另立一套。同一次操作重试 = 同 `op_id` +
    同 `idempotency_key`；新的一次操作 = 两个都是新的。
  · **查询本身不留痕**（查别人的账，查完再记一笔「谁查了谁」会无限递归）；
    但**越权查询要拒并可查**（拒了要有一条可核的拒绝事实）。

普通写入/检索/摘要**零 LLM 调用** —— 摘要由动作名与实际参数确定性拼接，不猜。
"""
import json
import time

import frappe

# 事实就是本动作自己的执行审计行（不建平行日志），查询侧按这个动作 ID 圈账。
FACT = 'files.action_fact'


def _summary_of(action, target, detail):
    """确定性摘要：按动作名 + 目标 + 明细条数拼，零 LLM。"""
    det = detail if isinstance(detail, dict) else {}
    parts = [str(action or '')]
    if target:
        parts.append(str(target))
    cells = det.get('cells')
    if isinstance(cells, list):
        parts.append('%d 格明细' % len(cells))
    elif det:
        parts.append('%d 项明细' % len(det))
    return ' · '.join(p for p in parts if p)


def action_fact(payload, _context=None):
    """files.action_fact：记一条动作事实上报（UI 观察到的事件）。

    **来源由服务端认证** —— 不接受调用方自报身份/部门；身份来自认证上下文，
    来源取信封的 `source`。服务端另记 `server_time`，客户端时间只作参考不作准。

    回包是服务端认定的事实（不是回声）：op_id / action / server_time / identity /
    action_count / detail / summary。同 `op_id` 重试不制造第二次成功。
    """
    op_id = str(payload.get('op_id') or '').strip()
    action = str(payload.get('action') or '').strip()
    if not op_id:
        frappe.throw('事实必须带稳定操作号 op_id', frappe.ValidationError)
    if not action:
        frappe.throw('事实必须带动作名 action', frappe.ValidationError)
    target = str(payload.get('target') or '').strip()
    detail = payload.get('detail')
    if detail is not None and not isinstance(detail, dict):
        frappe.throw('detail 须是对象', frappe.ValidationError)
    detail = detail or {}

    # 同 op_id 重试不制造第二次成功：已有成功事实就回同一条，不再落新的
    prior = _find_by_op(op_id)
    if prior:
        return {**prior, 'idempotent': True, 'action_count': 0}

    user = frappe.session.user
    roles = frappe.get_roles()
    # 合并说明：fast 那边用「协作分组」名当部门显示（存量兼容展示），
    # 本分支用**当前身份的任职快照**（current_actor_organization_snapshot）取部门标题 ——
    # 后者才是组织层的真实口径，前者只是旧协作分组的显示名。这里取本分支的口径。
    from shangshu_core.public_api import current_actor_organization_snapshot
    organization = current_actor_organization_snapshot()
    departments = organization['departments']
    dept = ' / '.join(row['title'] for row in departments)
    server_time = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())

    fact = {
        'op_id': op_id,
        'action': action,
        'target': target,
        'detail': detail,
        'server_time': server_time,
        'client_timestamp': payload.get('client_timestamp'),
        'identity': {'user': user, 'department': dept, 'departments': departments,
                     'roles': [r for r in roles if r != 'All'],
                     'source': str((_context or {}).get('source') or 'unknown')},
        'kind': _kind_of(action),
        'action_count': 1,
        'summary': _summary_of(action, target, detail),
        'llm_calls': 0,
    }
    # 事实本身随本动作的执行审计落盘（不建平行日志）——审计行即事实，载荷即业务字段
    return fact


def _kind_of(action):
    """打开/读取与修改区分（契约：只复制未粘贴仍有事件；返回数据只证明系统返回）。"""
    a = (action or '').lower()
    if a.startswith('table.open') or a.endswith('.open') or a.endswith('.read'):
        return 'open'
    if a.startswith('copy.'):
        return 'copy'
    if a.startswith('retry.'):
        return 'retry'
    return 'modify'


def _rows_for(filters, scope):
    """从既有审计里取事实行（action_id = files.action_fact 的那些）。

    **不许把「查询失败」伪装成「查无记录」** —— 早先这里 `except: return []`，
    只要字段名对不上就永远返回空列表，和「真没记录」长得一模一样，于是查询侧
    判据会全绿全空。现在失败原样抛出去，空列表只可能是真没有。

    字段注意：审计表**没有 `payload_json`**（那是 `Shangshu Action Proposal` 的列）。
    业务字段在 `input_summary_json` —— 公共入口落的是 `_summary(载荷)`，只脱敏
    敏感键、截断超长串，op_id/action/target/detail 原样在。

    **读侧作用域服务端强制（F12）**：这里用 `frappe.get_all`（不走行级 ACL），
    **不是** `get_list` —— 审计表的读权限只给了 System Manager，而产品口径是
    「本人查得到本人的事实」。原先这道边界只活在**注释里对调用方的口头约定**
    （「调用方必须已经把 actor_user 圈进 filters」），**注释不是强制**：调用方
    忘一圈，整张审计表就漏出去。现在改成**必须显式传 `scope`**，由
    `field_access.enforced_row_scope` 强制圈定 —— `self` 就是本人（覆盖调用方
    塞的任何值），`all` 只对管理员开。判据 FA-11。
    """
    # 合并说明：fast 那边用 `query_domain_action_audits`（要求调用发生在**本域动作上下文**里，
    # 且只回 name/idempotency_key/input_summary_json/actor_user/creation/status/action_id）。
    # 本分支用 `query_action_fact_audits`（独立日志授权口径，scope 由服务端强制），
    # 且**多回 result_summary_json 与 executor_source** —— 下面取事实行要用这两列
    # （identity 与 source），换过去会恒为空/'unknown'。所以这里取本分支的入口；
    # fast 那个入口已在 public_api 里导出，别处要用仍可取。
    from shangshu_core.public_api import query_action_fact_audits
    rows = query_action_fact_audits(FACT, filters, scope)
    out = []
    for r in rows or []:
        try:
            p = json.loads(r.get('input_summary_json') or '{}')
        except Exception:
            p = {}
        if not isinstance(p, dict):
            p = {}
        try:
            saved = json.loads(r.get('result_summary_json') or '{}')
        except (ValueError, TypeError):
            saved = {}
        identity = saved.get('identity') if isinstance(saved, dict) else None
        out.append({'identity': identity if isinstance(identity, dict) else None, 'audit': r.get('name'), 'op_id': p.get('op_id'), 'action': p.get('action'),
                    'target': p.get('target'), 'detail': p.get('detail') or {},
                    'server_time': str(r.get('creation') or ''), 'user': r.get('actor_user'),
                    'status': r.get('status'), 'idempotency_key': r.get('idempotency_key'),
                    'source': r.get('executor_source') or 'unknown'})
    return out


def _facts(rows):
    """按操作号归并成「事实」。

    契约：同 `op_id` = 同一次操作。客户端重试可能换幂等键，于是审计里会留下多行
    —— 那是**多次尝试**，不是多次成功。事实只有一条（取最早那条成功行）；尝试
    次数照实带出来（`attempt_count` / `success_count`），**不藏**。
    """
    groups, order = {}, []
    for r in rows:
        op = r.get('op_id') or ''
        if not op:
            continue
        if op not in groups:
            groups[op] = {'tries': []}
            order.append(op)
        groups[op]['tries'].append(r)
    out = []
    for op in order:
        tries = groups[op]['tries']
        ok = [x for x in tries if x.get('status') == 'Succeeded']
        head = ok[0] if ok else tries[0]
        out.append({**head, 'attempt_count': len(tries), 'success_count': len(ok)})
    return out


def _find_by_op(op_id):
    """本人账里找同一操作号的既有事实（幂等：重试不制造第二次成功）。

    `_rows_for` 已经按 `action_id = files.action_fact` 圈好了，这里只认操作号 ——
    早先传 `only_action='files.action_fact'` 去比**业务动作名**（cell.save 之类），
    永远不相等，幂等分支恒空转。
    """
    for f in _facts(_rows_for({}, 'self')):
        if f.get('op_id') == op_id:
            return f
    return None


def action_fact_query(payload, _context=None):
    """files.action_fact_query：按员工/部门/表/操作号查事实（明确授权内）。

    **查询本身不留痕**；**越权查询拒并留一条可核的拒绝事实**（契约要求「拒了要有一条可核的
    拒绝事实」，但那条不留进被查的账里 —— 记进本动作自己的执行审计）。

    授权口径（T08 本期「明确授权内查询」）：
      · 本人记录的事实 —— 可查
      · 老板 —— 当前企业；部门负责人 —— 管理部门及下属部门
      · 普通员工 —— 仅本人；运维范围不跨当前企业
    本入口不增加普通员工全局审计页面；对话依据另走可信来源引用。
    """
    op_id = str(payload.get('op_id') or '').strip()
    want_user = str(payload.get('user') or '').strip()
    action = str(payload.get('action') or '').strip()
    target = str(payload.get('target') or '').strip()
    limit = int(payload.get('page_length') or 50)

    # Independent audit scope is enforced by the public service, using current
    # company-owner/head appointments. Resource reads do not confer log access.
    filters = {'actor_user': want_user} if want_user else {}
    rows = _facts(_rows_for(filters, 'managed'))
    if op_id:
        rows = [r for r in rows if r.get('op_id') == op_id]
    if action:
        rows = [r for r in rows if r.get('action') == action]
    if target:
        rows = [r for r in rows if r.get('target') == target]
    rows = rows[:max(1, min(limit, 200))]

    return {'facts': rows, 'total': len(rows),
            'scope': 'managed',
            'query_traced': False,     # 查询本身不留痕
            'llm_calls': 0}
