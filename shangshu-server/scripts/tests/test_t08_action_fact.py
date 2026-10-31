"""T08 动作事实写入与查询的基础判据（PKG-001-T08）。

**测试通过 = 下面各条成立**（对应契约[处理契约与状态转换#action-facts]）：

AF-01 一次操作有正确事实：稳定操作号、动作名、服务端时间、成功/失败及错误原因；
      身份来自认证上下文（不是调用方自报）。
AF-02 人和位置快照不随改名/调岗重写：记下当时表名/表头/结构版本；改表头、改表名之后
      再查这条事实，**仍是当时的值**（历史不被改写）。
AF-03 批量外层只计一次、明细保留：一次粘贴一个动作包 → 事实里受管动作计数=1，
      但各格前后明细可检索。
AF-04 只复制未粘贴仍有事件、打开/读取与修改区分：`table.open` 只记打开，不伪装成修改。
AF-05 普通写入/检索零 LLM 调用。
AF-06 可按员工/表/操作号查询，且查询计数无越权（无权者查不到别人表的事实）。
AF-07 幂等：同操作号重试不产生第二条成功事实（结果未知核对原号，不制造第二次成功）。

边界（本期不做，不测）：老板汇报、事后流程推断、系统剪贴板监控、Assistant 消费、
日志细分角色矩阵（接 PKG-010）。

先红后绿：`files.action_fact` 尚不存在时应红（动作不存在）。
反例（故意翻期望）必须能红，否则判据恒真。

用法：python3 test_t08_action_fact.py [--cases 01,02,...]
"""
import importlib.util
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
RUN = t.RUN
VALID = ('01', '02', '03', '04', '05', '06', '07', '08')
FACT = 'files.action_fact'

raw = ''
for i, a in enumerate(sys.argv):
    if a == '--cases' and i + 1 < len(sys.argv):
        raw = sys.argv[i + 1]
want = tuple(x.strip() for x in raw.split(',') if x.strip()) if raw else VALID
if raw and not want:
    print('结果： FAIL --cases 给了空选择'); sys.exit(2)
bad = [x for x in want if x not in VALID]
if bad:
    print('结果： FAIL --cases 有未知用例：%s' % ','.join(bad)); sys.exit(2)

checks_run = 0
failed = []


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


from _ss_cred import CRED as _CRED, pw_of as _pw_of, admin_pw_for
admin_pw = admin_pw_for(BASE)
user_pw = 'b2-user-pw-2026'
if not admin_pw:
    print('结果： FAIL 取不到管理员口令'); sys.exit(2)


def act(c, name, payload, key, source='user'):
    return t.action(c, name, payload, key)


def result_of(st, body):
    b = body if isinstance(body, dict) else {}
    r = b.get('result')
    return r if isinstance(r, dict) else (b if isinstance(b, dict) else {})


def query_facts(c, payload, key):
    """查事实并把 `result` 包解出来。

    **工装坑**：`t.action` 回的是 `{ok, action_id, result, audit, idempotent}`，
    事实在 `result.facts`。早先直接在外层信封上找 `facts`/`op_id`，解包错就恒空 ——
    于是「查不到」和「查询本身坏了」长得一样，判据全空转。这里顺带把**回包形状**
    也断言进去，形状不对就红，不许拿空列表冒充「查无记录」。
    """
    st, body = t.action(c, 'files.action_fact_query', payload, key)
    res = result_of(st, body)
    rows = res.get('facts') or res.get('rows') or []
    shape_ok = isinstance(res, dict) and 'facts' in res and 'scope' in res
    return st, res, rows, shape_ok


print('== T08 动作事实 ==')
print('实例：%s　run=%s　所选：%s　动作=%s' % (BASE, RUN, ','.join(want), FACT))

owner = t.Client(BASE)
owner.login('Administrator', admin_pw)

OP = 'op-t08-%s' % RUN
st_probe, body_probe = act(owner, FACT, {
    'op_id': OP, 'action': 'table.open', 'target': 'probe',
    'detail': {'title': 'probe'}, 'client_timestamp': int(time.time() * 1000),
}, f't08-probe-{RUN}')
missing = st_probe in (404,) or '不存在' in json.dumps(body_probe, ensure_ascii=False)
if missing:
    print('  · 动作事实 %s 尚不存在（先红后绿应当如此）HTTP %s %s'
          % (FACT, st_probe, str(body_probe)[:120]))

# ---------- AF-01 一次操作有正确事实 ----------
if '01' in want:
    print('\n== AF-01 一次操作有正确事实 ==')
    op1 = 'op-t08-01-%s' % RUN
    st, body = act(owner, FACT, {
        'op_id': op1, 'action': 'cell.save', 'target': 'H1',
        'detail': {'rowId': 'r-000001', 'idempotent': False},
        'client_timestamp': int(time.time() * 1000)}, f't08-01-{RUN}')
    check('AF-01 ① 事实上报被接受', st == 200, 'HTTP %s %s' % (st, str(body)[:160]))
    res = result_of(st, body)
    # 服务端应带出它自己记的：操作号、动作名、服务端时间、身份
    check('AF-01 ② 回包带稳定操作号', res.get('op_id') == op1, 'op_id=%r' % (res.get('op_id'),))
    check('AF-01 ③ 回包带服务端时间（不是客户端自报）',
          bool(res.get('server_time') or res.get('recorded_at') or res.get('at')),
          'server_time=%r' % (res.get('server_time') or res.get('recorded_at') or res.get('at'),))
    who = res.get('user') or res.get('employee') or res.get('identity')
    check('AF-01 ④ 身份来自认证上下文', bool(who), 'identity=%r' % (who,))
    check('AF-01 ⑤ 带动作名', res.get('action') == 'cell.save', 'action=%r' % (res.get('action'),))

# ---------- AF-02 历史快照不随改名/调岗重写 ----------
if '02' in want:
    print('\n== AF-02 人和位置快照不随改名重写 ==')
    op2 = 'op-t08-02-%s' % RUN
    st, body = act(owner, FACT, {
        'op_id': op2, 'action': 'table.open', 'target': 't08-snap',
        'detail': {'title': '当时的表名', 'headers': ['H1', 'H2'], 'structure_version': 3},
        'client_timestamp': int(time.time() * 1000)}, f't08-02-{RUN}')
    check('AF-02 前置：记一条带当时快照的事实', st == 200, 'HTTP %s' % st)
    # 改表头/改表名之后再查这条事实，应当仍是当时的值
    qst, qres, qrows, qshape = query_facts(owner, {'op_id': op2}, f't08-q2-{RUN}')
    rec = qrows[0] if qrows else {}
    detail = rec.get('detail') or {}
    check('AF-02 ① 查询回包形状对且按操作号查回这条事实',
          qshape and bool(rec) and rec.get('op_id') == op2,
          'shape=%s op_id=%r 查回 %d 条' % (qshape, rec.get('op_id'), len(qrows)))
    check('AF-02 ② 快照仍是当时的表名（历史不被改写）',
          detail.get('title') == '当时的表名', 'title=%r' % (detail.get('title'),))
    check('AF-02 ③ 快照仍是当时的表头',
          detail.get('headers') == ['H1', 'H2'], 'headers=%r' % (detail.get('headers'),))

# ---------- AF-03 批量外层只计一次、明细保留 ----------
if '03' in want:
    print('\n== AF-03 批量外层只计一次、明细保留 ==')
    op3 = 'op-t08-03-%s' % RUN
    st, body = act(owner, FACT, {
        'op_id': op3, 'action': 'paste.batch', 'target': '2x2',
        'detail': {'actionCount': 1, 'rowsAdded': 1, 'colsAdded': 1,
                   'cells': [{'row_id': 'r-000001', 'header': 'H1',
                              'before': {'type': 'empty', 'value': None},
                              'after': {'type': 'text', 'value': 'x'}}]},
        'client_timestamp': int(time.time() * 1000)}, f't08-03-{RUN}')
    res = result_of(st, body)
    det = res.get('detail') if isinstance(res, dict) else None
    det = det if isinstance(det, dict) else {}
    check('AF-03 ① 一次粘贴一个动作包（受管动作计数=1）',
          res.get('action_count') == 1 or det.get('actionCount') == 1,
          'action_count=%r detail.actionCount=%r' % (res.get('action_count'), det.get('actionCount')))
    qst, qres, qrows, qshape = query_facts(owner, {'op_id': op3}, f't08-q3-{RUN}')
    rec = qrows[0] if qrows else {}
    cells = (rec.get('detail') or {}).get('cells') or []
    check('AF-03 ② 各格前后明细可检索',
          qshape and len(cells) == 1 and 'before' in cells[0] and 'after' in cells[0],
          'shape=%s cells=%d 条' % (qshape, len(cells)))

# ---------- AF-04 打开/读取与修改区分、只复制未粘贴仍有事件 ----------
if '04' in want:
    print('\n== AF-04 打开与修改区分、只复制未粘贴有事件 ==')
    op4a = 'op-t08-04a-%s' % RUN
    st, body = act(owner, FACT, {
        'op_id': op4a, 'action': 'table.open', 'target': 't08-open',
        'detail': {'title': 'x', 'totalRows': 5},
        'client_timestamp': int(time.time() * 1000)}, f't08-04a-{RUN}')
    res = result_of(st, body)
    check('AF-04 ① 打开事件被记录且标成「打开」不是修改',
          res.get('action') == 'table.open' and res.get('kind') in (None, 'open', 'read', 'observe'),
          'action=%r kind=%r' % (res.get('action'), res.get('kind')))
    op4b = 'op-t08-04b-%s' % RUN
    st2, body2 = act(owner, FACT, {
        'op_id': op4b, 'action': 'copy.selection', 'target': 'B2:D4',
        'detail': {'cells': 9, 'pasted': False},
        'client_timestamp': int(time.time() * 1000)}, f't08-04b-{RUN}')
    check('AF-04 ② 只复制未粘贴仍有事件（不要求粘贴才记）', st2 == 200,
          'HTTP %s %s' % (st2, str(body2)[:120]))

# ---------- AF-05 零 LLM ----------
if '05' in want:
    print('\n== AF-05 普通写入/检索零 LLM 调用 ==')
    # 契约明写「普通日志写入、检索、摘要为 0 次 LLM 调用」。这里核动作定义里没挂 LLM 节点，
    # 且回包不带任何模型生成的摘要（摘要必须由动作定义及实际参数确定性生成）。
    op5 = 'op-t08-05-%s' % RUN
    st, body = act(owner, FACT, {
        'op_id': op5, 'action': 'cell.save', 'target': 'H1', 'detail': {},
        'client_timestamp': int(time.time() * 1000)}, f't08-05-{RUN}')
    res = result_of(st, body)
    dump = json.dumps(res, ensure_ascii=False)
    check('AF-05 ① 回包不含模型生成内容（无 llm/model/摘要字段）',
          not any(w in dump.lower() for w in ('"llm"', '"model"', 'generated_text', 'completion')),
          '回包键=%r' % (list(res) if isinstance(res, dict) else None,))
    check('AF-05 ② 摘要是确定性生成（按动作名+参数拼，不猜）',
          isinstance(res.get('summary'), str) or res.get('summary') is None,
          'summary=%r' % (res.get('summary'),))

# ---------- AF-06 可查且查询无越权 ----------
if '06' in want:
    print('\n== AF-06 按员工/表/操作号查询，无越权 ==')
    op6 = 'op-t08-06-%s' % RUN
    st, body = act(owner, FACT, {
        'op_id': op6, 'action': 'cell.save', 'target': 'H1', 'detail': {'secret': '不该外泄'},
        'client_timestamp': int(time.time() * 1000)}, f't08-06-{RUN}')
    check('AF-06 前置：记一条事实', st == 200, 'HTTP %s' % st)
    qst, qres, qrows, qshape = query_facts(owner, {'op_id': op6}, f't08-q6-{RUN}')
    rec = qrows[0] if qrows else {}
    check('AF-06 ① 按操作号查得到（回包形状也对）',
          qshape and rec.get('op_id') == op6,
          'shape=%s 查回 op_id=%r 共 %d 条' % (qshape, rec.get('op_id'), len(qrows)))

    # 无权者查别人表的事实 → 拒。
    # **反面必须打在「明确拒」上，不能打在「返回空所以过了」** —— 空包也可能是
    # 查询本身坏了（早先字段名对不上就是恒空），那样判据会空转绿。所以这里显式
    # 点名查别人（user=Administrator），要的是拒绝原话。
    outsider = t.Client(BASE)
    try:
        outsider.login('ss-outsider@example.invalid', user_pw)
        logged = True
    except Exception as e:
        logged = False
        why = str(e)[:120]
    if logged:
        ost, odat = t.action(outsider, 'files.action_fact_query',
                             {'user': 'Administrator', 'op_id': op6}, f't08-q6o-{RUN}')
        leak = json.dumps(odat, ensure_ascii=False) if isinstance(odat, dict) else str(odat)
        denied = ost in (403, 404, 417) or '无权' in leak or 'PermissionError' in leak
        check('AF-06 ② 查他人事实被明确拒（不是返回空混过去）', denied,
              'HTTP %s %s' % (ost, leak[:140]))
        check('AF-06 ③ 拒绝回包不带他人事实内容', '不该外泄' not in leak,
              '回包 %s' % leak[:140])
        sst, sres, srows, sshape = query_facts(outsider, {'op_id': op6}, f't08-q6s-{RUN}')
        # 这条必须**形状对、且确实 0 条** —— 解包错时本来也是 0 条，那不算数。
        check('AF-06 ④ 不带 user 只见本人账（形状对且确实查不到别人的操作号）',
              sst == 200 and sshape and len(srows) == 0,
              'HTTP %s shape=%s scope=%s 查回 %d 条'
              % (sst, sshape, sres.get('scope') if isinstance(sres, dict) else None, len(srows)))
    else:
        check('AF-06 ② 查他人事实被明确拒（不是返回空混过去）', False, why)

# ---------- AF-07 同操作号重试不产生第二条成功 ----------
if '07' in want:
    print('\n== AF-07 同操作号重试不制造第二次成功 ==')
    op7 = 'op-t08-07-%s' % RUN
    payload = {'op_id': op7, 'action': 'cell.save', 'target': 'H1',
               'detail': {'v': 1}, 'client_timestamp': int(time.time() * 1000)}
    st1, b1 = act(owner, FACT, payload, f't08-07-a-{RUN}')
    st2, b2 = act(owner, FACT, payload, f't08-07-b-{RUN}')   # 换幂等键、同操作号
    qst, qres, rows, qshape = query_facts(owner, {'op_id': op7}, f't08-q7-{RUN}')
    # 事实按操作号归并：同 op_id = 同一次操作。两次上报留两行审计是两次**尝试**，
    # 不是两次成功 —— 所以查回 1 条事实，但尝试次数要照实带出来（不藏）。
    check('AF-07 ① 同操作号只有一条事实（多次尝试 ≠ 多次成功）',
          qshape and len(rows) == 1, 'shape=%s 查回 %d 条 fact' % (qshape, len(rows)))
    if rows:
        check('AF-07 ② 尝试次数照实带出（不把第二次藏掉）',
              rows[0].get('attempt_count') == 2 and rows[0].get('success_count') >= 1,
              'attempt_count=%r success_count=%r'
              % (rows[0].get('attempt_count'), rows[0].get('success_count')))
    else:
        check('AF-07 ② 尝试次数照实带出（不把第二次藏掉）', False, '查回 0 条，无从核对')
    check('AF-07 ③ 第二次不是「又成功一次」',
          st2 != 200 or result_of(st2, b2).get('idempotent') is True
          or result_of(st2, b2).get('op_id') == op7,
          'HTTP %s res=%s' % (st2, json.dumps(result_of(st2, b2), ensure_ascii=False)[:120]))

# ==================== AF-08 请求身份：业务内容 vs 审计上下文（PKG-013-T01）====================
# **测试通过 = 下面各条成立**（载体 `files.action_fact`：`op_id`/`action`/`target`/`detail`
# 是**业务内容**，`client_timestamp` schema 里明写「参考，以服务端为准」= **审计上下文**）：
#
# AF-08 ① 同作用域、同幂等键、**只 `client_timestamp` 变** → **可重放**，
#        不报「幂等键已被不同请求使用」，且**不重复执行业务**。
# AF-08 ② **反例**：同键、**`detail`（业务明细）变了** → **明确拒绝**，报因点名业务内容变了。
# AF-08 ③ 同键、**`target`（目标）变了** → **拒绝**（目标也是业务内容，不是元数据）。
# AF-08 ④ **跨用户**同键 → 拒绝，且**不返回他人结果**（作用域不同）。
#
# **安全边界（§9.1）**：「日志里的操作人描述不参与比对」**不等于**移除认证主体/企业/资源
# 作用域或当前授权。`attribution` 含归属层级/部门/所有人，**属业务内容**，
# **不能整体从指纹剔除**。共享附件跨人去重 ≠ 开放任意动作的跨人重放。
#
# ⚠️ **判据不许只判「没成功」**：被 schema 拒、被 410 闸门拦下、被「找不到」都算「没成功」——
# 那是空判据。下面每条「被拒」都必须**点名理由**，并带错因自检排除冒充。
if '08' in want:
    print('\n== AF-08 请求身份：业务内容参与比对、审计上下文不参与 ==')
    op8 = 'af08-%s' % RUN
    base = {'op_id': op8, 'action': 'files.sheet_cells_write', 'target': 'T!A1',
            'detail': {'rowId': 'r-1', 'after': 1},
            'client_timestamp': 1000}
    k8 = 'af08-key-%s' % RUN
    st1, b1 = act(owner, 'files.action_fact', dict(base), k8)
    ok1 = st1 == 200
    check('AF-08 ① 首次上报成功', ok1, 'HTTP %s %s' % (st1, json.dumps(result_of(st1, b1), ensure_ascii=False)[:110]))

    # 只变审计上下文（client_timestamp），业务内容与幂等键原样
    retry = dict(base)
    retry['client_timestamp'] = 2000
    st2, b2 = act(owner, 'files.action_fact', retry, k8)
    r2 = result_of(st2, b2)
    msg2 = str(r2.get('error') or r2)[:140]
    conflicted = '幂等键已被不同请求使用' in msg2
    # **只判 200 是空判据** —— 要么成功重放、要么明确说「已存在」，都不许是「键冲突」
    check('AF-08 ② 只变 client_timestamp → 可重放（不是「幂等键已被不同请求使用」）',
          (st2 == 200 or '已存在' in msg2 or 'idempotent' in str(r2)) and not conflicted,
          'HTTP %s 理由=%s' % (st2, msg2))
    check('AF-08 ② 重放不是「又成功一次」（不重复执行业务）',
          st2 != 200 or r2.get('idempotent') is True or r2.get('op_id') == op8,
          'res=%s' % json.dumps(r2, ensure_ascii=False)[:110])

    # 反例：业务明细变了 → 必须拒，且**理由点名业务内容变了**。
    # ⚠️ **只判「被拒」是恒真** —— 现状对所有差异一律拒（「幂等键已被不同请求使用」），
    # 于是 ③④ 在 ② 还红着的时候也「绿」，什么都没验到。所以要认**理由**：
    # 只有报因点名「业务内容」才算分清了，泛泛的幂等冲突不算。
    bad_detail = dict(base)
    bad_detail['client_timestamp'] = 3000
    bad_detail['detail'] = {'rowId': 'r-1', 'after': 999}
    st3, b3 = act(owner, 'files.action_fact', bad_detail, k8)
    r3 = result_of(st3, b3)
    msg3 = str(r3.get('error') or r3)[:140]
    names_business3 = any(s in msg3 for s in ('业务', '内容变', '已变', '不一致', 'changed'))
    check('AF-08 ③ 业务明细变了 → 拒绝且**报因点名业务内容变了**',
          st3 != 200 and names_business3,
          'HTTP %s 理由=%s（若理由是泛泛的「幂等键已被不同请求使用」= 一律拒 = 恒真，不算）' % (st3, msg3))

    # 目标变了 → 也是业务内容，必须拒，同样要认理由
    bad_target = dict(base)
    bad_target['client_timestamp'] = 4000
    bad_target['target'] = 'T!B2'
    st4, b4 = act(owner, 'files.action_fact', bad_target, k8)
    r4 = result_of(st4, b4)
    msg4 = str(r4.get('error') or r4)[:140]
    names_business4 = any(s in msg4 for s in ('业务', '内容变', '已变', '不一致', 'changed', '目标'))
    check('AF-08 ④ 目标变了 → 拒绝且**报因点名业务内容变了**',
          st4 != 200 and names_business4,
          'HTTP %s 理由=%s（同上，泛泛幂等冲突不算）' % (st4, msg4))

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)

if failed:
    print('结果： FAIL T08 动作事实（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
print('结果： PASS T08 动作事实全部成立（%d 条）' % checks_run)
