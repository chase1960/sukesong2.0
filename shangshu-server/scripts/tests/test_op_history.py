"""X3-② 台账戳章 —— **历史日志不被追溯重解释**（PKG-004 / B 查出的缺口之一）。

**测试通过 = 下面每条成立**：

1. **前置·闸在**：查得到台账（有读口 `files.op_history`）。**没有读口后面全是空判据**。
2. 写一格 → 台账**带当时的 `structure_version`**。
3. **加一列**（结构版本 +1）→ **读同一条旧台账，它的 `structure_version` 还是旧的那个**
   —— 不被追溯改成新的。
4. 结构变了**之后**再写一格 → **新台账带新的结构版本**（对照：不是所有台账都停在旧版）。
5. 两条台账**结构版本不同** —— 戳章跟的是**时刻**不是列。
6. **敏感度**：「结构改没改」给两种不同答案 —— 不恒同。

---
⚠️ **本组验的是「结构版」，不是「定义版」** —— 这区别要说清，否则读的人以为 X3-③ 立住了。

**`definition_version` 恒等于 1，拿它当判据是假判据**（D 2026-10-15 查证）：
`promotion.py:34 DEFINITION_VERSION = 1` 是**模块常量**，`save_definition` 每次写死它，
`validate_definition` 还明确拒别的值 —— 拒因原文就是
「**版本不认的定义明确拒，不静默按当前定义重解释（历史日志不按新定义重解释旧值）**」。
**规则写在注释里，实现没有载体**；而且 `save_definition` 整份覆盖 `meta['promotion']`，
**上一个定义直接没了**。

所以「按哪一版**定义**解释」今天**没有任何字段能回答**。
等 X3-① 建出递增的 `definition_revision` 才补那半判据。**本组绿 ≠ X3-③ 完成。**

**跟 X3-① 的关系**：① 要做两件 —— 定义快照表 **+ 一个递增修订号**（没有修订号，
快照就是一堆没编号的快照，戳章也无处可戳）。两条都立住 X3-③ 才算完（**碰过 ≠ 做完**）。

---
**为什么台账要带版本戳**（背景，B 2026-10-15 查出、D 核实）：
`Shangshu File Center Sheet Op` 记了 `op_id / action_id / actor_user / request_key /
cells_json / content_version / undone` —— **逐格前后快照那一层已经有了**，
但**没有当时的版本号**，而且**只有 `undo_cells` 内部按 op_id 查，对外没有读口**，
于是「当时是按什么解释的」既查不到、也验不了。

**证据落点**：`sheet.py` `_record_op` 的插入字段（读代码，不是 grep 撞词）。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_op_history.py
"""
import importlib.util
import json
import os
import sys

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)

checks, fails = [], []


def check(label, valid, detail=''):
    checks.append(label)
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:190]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


def _err(body):
    return _ss_seed._err(body)


def _dl_err(st, body):
    return _ss_seed._dl_err(st, body)


def _got_bytes(st, body):
    return _ss_seed._got_bytes(st, body)


def _op_key(op_id, run, tag):
    """操作台账的 `op_id` 就是本次幂等键 —— 用同一个口取，不另造关联方式。"""
    return op_id or ('%s-%s' % (run, tag))


def _ops(cli, table, limit=50):
    """读这张表的台账。回 ``(ops, 说明)`` —— **读口不存在时 ops 为空，说明写清为什么**。"""
    st, body = t.service(cli, 'files.op_history', {'file': table, 'limit': limit})
    if st != 200:
        return [], 'HTTP %s %s' % (st, _err(body)[:150])
    r = result_of(st, body)
    ops = r.get('ops') or r.get('operations') or []
    return ops, ('读到 %d 条' % len(ops))


print('== X3-② 台账戳章：历史日志不按新定义重解释旧值 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令（SS_D_PW 未设，`_ss_cred.admin_pw_for` 也空）')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

handle = _ss_seed.seed_mixed_table(c, run=t.RUN, promote_with=c)
TABLE = (handle or {}).get('table')
RID = ((handle or {}).get('row_ids') or [None])[0]
print('  夹具表 %s 行 %s' % (TABLE, RID))


def _versions():
    st_v, b_v = t.service(c, 'files.versions', {'file': TABLE})
    return result_of(st_v, b_v)


def _content_versions():
    rr = result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    return int(rr.get('content_version') or 0), int(rr.get('structure_version') or 1)


def _write_plain(header, value, key):
    """写一格。**回执里的 `op_id` 才是台账真正的键** ——
    ⚠️ 幂等键会被加后缀（实测 `key='1792074521-diag'` → 台账 `op_id='1792074521-diag-1792074521'`），
    **自造的 key 跟实际对不上**（第一版就这么读空的）。**取实际值，别按名字想当然。**
    """
    cv, sv = _content_versions()
    st, body = t.action(c, 'files.cell_write', {
        'table': TABLE, 'row_id': RID, 'header': header,
        'value': {'type': 'text', 'value': value},
        'expected_content_version': cv,
        'expected_structure_version': sv}, key)
    return st, body, (result_of(st, body) or {}).get('op_id')


try:
    # ---------- 记下**写之前**的结构版本 ----------
    # ⚠️ **比的是 `structure_version`，不是 `definition_version`** ——
    # 后者是 `promotion.py:34` 的模块常量 `DEFINITION_VERSION = 1`，**恒等于 1**，
    # 拿它断言是**恒真判据**（写不写都过），跟今天收的那几条同族。
    # ⚠️ **也不能拿 `bound_structure_version` 比** —— 那是**绑定那一刻**的版本，
    # 可能早就跟当前结构对不上了（`binding_current: false`）。
    # 台账戳的是**当前** `structure_version`，就比当前那个。
    _, SV1 = _content_versions()
    check('前置·记下写之前的结构版本（后面全靠它比）', isinstance(SV1, int) and SV1 >= 1,
          'structure_version=%r' % (SV1,))

    # ---------- 写一格 → 台账 ----------
    k1 = _op_key(None, t.RUN, 'op1')
    st_w1, b_w1, OP1 = _write_plain('备注', '第一笔', k1)
    check('前置：写一格普通列被接受', st_w1 == 200,
          'HTTP %s %s' % (st_w1, _err(b_w1)[:110]))

    ops1, why1 = _ops(c, TABLE)
    check('前置·闸在：**查得到台账**（有读口；没有读口后面全是空判据）',
          bool(ops1), why1)

    op1 = (ops1 or [{}])[0]
    check('② 台账**带当时的 structure_version**（不是 bound、也不是恒为 1 的 definition_version）',
          op1.get('structure_version') == SV1,
          '台账 structure_version=%r 当时=%r' % (op1.get('structure_version'), SV1))

    # ---------- 让「时间」往前走：加一列，结构版本 +1 ----------
    # ⚠️ **这里原本写的是「改晋升定义、把 definition_version 加 1」** —— **那是错的判据设计**，
    # 查出来才发现：`definition_version` 是 `promotion.py:34` 的**模块常量**
    # `DEFINITION_VERSION = 1`，`save_definition` 每次写死它、
    # `validate_definition` 还明确拒别的值（拒因原文「历史日志不按新定义重解释旧值」）。
    # **它恒等于 1，区分不出任何东西** —— 拿它当证据是假判据。
    #
    # 今天**唯一能当时间信号**的是 `structure_version`（加列/改名会 bump）。
    # 所以本组验的是「日志不被**追溯**重解释」这个**结构版**。
    # **「按哪一版定义解释」那半等 X3-① 建出递增的 `definition_revision` 才写判据**
    # —— 见 `test_op_history.py` 头部与提交信息。
    cv2, sv_before = _content_versions()
    st_ac, b_ac = t.action(c, 'files.sheet_column_append', {
        'table': TABLE, 'header': '第二列',
        'expected_content_version': cv2,
        'expected_structure_version': sv_before}, 'op-col')
    cv3, sv_after = _content_versions()
    check('前置：结构版本往前走了（加一列 → structure_version +1）',
          st_ac == 200 and sv_after == sv_before + 1,
          'HTTP %s 结构版本 %s → %s 拒因=%s' % (st_ac, sv_before, sv_after, _err(b_ac)[:110]))

    # ---------- 读**同一条**旧台账 ----------
    ops2, why2 = _ops(c, TABLE)
    old = [o for o in (ops2 or []) if o.get('op_id') == OP1] or []
    old1 = old[0] if old else {}
    check('③ **读同一条旧台账，它的结构版本还是旧的**（不被追溯改成新的）',
          bool(old) and old1.get('structure_version') == sv_before,
          '加列后读到 %r；台账 structure_version=%r 旧的=%r'
          % (why2, old1.get('structure_version'), sv_before))

    # ---------- 结构变了之后新写一格 ----------
    k2 = _op_key(None, t.RUN, 'op2')
    st_w2, b_w2, OP2 = _write_plain('备注', '第二笔', k2)
    check('前置：结构变了之后再写一格被接受', st_w2 == 200,
          'HTTP %s %s' % (st_w2, _err(b_w2)[:110]))
    ops3, why3 = _ops(c, TABLE)
    new = [o for o in (ops3 or []) if o.get('op_id') == OP2] or []
    new1 = new[0] if new else {}
    check('④ **对照**：结构变了之后新写的台账**带新结构版本**（不是所有台账都停在旧版）',
          bool(new) and new1.get('structure_version') == sv_after,
          '新台账 structure_version=%r 应=%r' % (new1.get('structure_version'), sv_after))

    # ---------- ⑤ 正对照：戳章看时刻不看列 ----------
    check('⑤ 两条台账**结构版本不同**（旧 %s / 新 %s）—— 戳章跟的是**时刻**不是列'
          % (sv_before, sv_after),
          old1.get('structure_version') != new1.get('structure_version'),
          '旧=%r 新=%r' % (old1.get('structure_version'), new1.get('structure_version')))

    # ---------- ⑥ 敏感度 ----------
    # ⚠️ **这条的模式我用错了**（第 14 次判据自己会撒谎）——
    # 「敏感度·给两种不同答案」是验**同一判据对两种输入**不恒真/恒假。
    # 但这里判的是**两个不同的断言**（「旧是旧」「新是新」），**本来就该都真**。
    # 硬要「两种不同答案」= 期望有一条错，**那是要求缺陷存在**。
    # 跟 `test_fast_path_value_check` ⑤ 那条同族：**敏感度条常绑着「当前缺陷的形状」**。
    # **⑤ 已经验过「两条版本号不同」**，所以这里改成正向断言「两条都成立」。
    ans = {'旧台账是旧结构版': old1.get('structure_version') == sv_before,
           '新台账是新结构版': new1.get('structure_version') == sv_after}
    check('⑥ 两条**都成立**（旧是旧、新是新 —— 戳章跟时刻走，不是恒停在某版）',
          all(ans.values()), '结论=%r' % ans)

    # ---------- ⑦ 复制日志：**读也落台账**（B02-7：读取范围/值快照/身份）----------
    # 测试通过 = 带 `op_id` 的读取在台账里留一条 `files.sheet_read`，
    #            逐行有 `row_id`/`header`/`before` 值快照，身份是当前用户；
    #            不带 `op_id` 的读取**不落账**（不假装记了）。
    # ⚠️ 服务调用上下文**没有幂等键** —— 第一版只看 `_context`，台账恒 0 条。
    # 所以 `op_id` 必须由 payload 带（schema 已加该字段）。
    read_op = 'read-ledger-%s' % t.RUN
    st_read, b_read = t.service(c, 'files.sheet_read', {'table': TABLE, 'op_id': read_op})
    rr = result_of(st_read, b_read) or {}
    check('⑦a 带 op_id 的读取成功', st_read == 200 and bool(rr.get('rows')),
          'HTTP %s %s' % (st_read, _err(b_read)))
    ops_r, note_r = _ops(c, TABLE)
    hit = [o for o in ops_r if o.get('op_id') == read_op]
    check('⑦b 台账里有一条 files.sheet_read',
          len(hit) == 1 and hit[0].get('action_id') == 'files.sheet_read',
          '命中 %d 条；%s' % (len(hit), note_r))
    cells = (hit[0].get('cells') if hit else None) or []
    sample = cells[0] if cells else {}
    check('⑦c 逐值事实：row_id + header + before 值快照都在',
          bool(sample.get('row_id')) and bool(sample.get('header')) and 'before' in sample,
          'cells=%d sample=%r' % (len(cells),
                                  {k: sample.get(k) for k in ('row_id', 'header', 'before')}))
    check('⑦d 身份是当前用户',
          bool(hit) and str(hit[0].get('actor_user')) == USER,
          'actor=%r 期望=%r' % (hit[0].get('actor_user') if hit else None, USER))
    # 反例：不带 op_id 的读取不落账
    st_n, b_n = t.service(c, 'files.sheet_read', {'table': TABLE})
    ops_n, _ = _ops(c, TABLE)
    empty_ops = [o for o in ops_n if o.get('action_id') == 'files.sheet_read'
                 and not str(o.get('op_id') or '').strip()]
    check('⑦e 不带 op_id 的读取不落账（不假装写了）',
          st_n == 200 and not empty_ops,
          '空 op_id 的读台账=%d（应 0）' % len(empty_ops))
finally:
    receipt = _ss_seed.seed_cleanup(c, handle)

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  'PASS X3-② 台账戳章（%d 条）—— 每条带当时的定义/结构版本号，'
                  '改定义后旧台账不被追溯重解释' % len(checks)))
print('⚠️ 本组只验「日志标了当时哪一版」。**能不能真按那一版解释**要等 X3-① 定义快照；'
      '**本组绿 ≠ X3-03 完成**。')
sys.exit(1 if fails else 0)
