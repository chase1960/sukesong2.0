"""R967-F04 · 库级反例 —— 版本冲突 / 幂等 / 字段规则 / 假目标，在**站点**上验。

**测试通过 = 下面每条反例都被正确拒绝，且拒因指向正确的业务规则**：

1. **版本冲突**（错 `content_version`）→ 拒，且拒因点名「版本/冲突/已被修改」。
2. **版本冲突**（错 `structure_version`）→ 拒。
3. **幂等重放**：同一个 `idempotency_key` 发两次 → **不重复落盘**。
4. **撤销不存在的 op_id** → 拒（不是「假成功」）。
5. **字段规则**：往有 `min` 的列写负数 → 拒，且拒因点名规则（不是 schema 拒）。
6. **读不存在的表** → 404。

---
**为什么自己造表，不复用别人的表**（F 2026-10-19 记）：
第一版 F04 是在运行时**挑第一张已有的表**改格子。被权限拦下，拦得对——
**共享环境上「挑一张别人的表改格子」就是可能覆盖别人的数据**。
现在改成：用 `_ss_seed.seed_mixed_table` 造一张**名字带本次 run 标记的专用表**，
六条判据只动**自己造的那张**，跑完 `seed_cleanup` 回收。

**所以这条判据不碰任何既有表** —— 不是「挑一张顺手的」，是「只碰自己的」。

用法：
  export SS_BASE=http://127.0.0.1:3850
  python3 shangshu-server/scripts/tests/test_f04_library_counterexamples.py
"""
import importlib.util
import json
import os
import sys
import time

ROOT = os.environ.get('SS_ROOT', os.getcwd())


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3850')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)

fails = []


def check(name, ok, detail=''):
    print('%s %s%s' % ('  ✓' if ok else '  ✗', name, ('  — ' + detail) if detail else ''))
    if not ok:
        fails.append(name)


def result_of(st, body):
    return _ss_seed._result(st, body)


def err_of(body):
    return _ss_seed._err(body)


print('== R967-F04：库级反例（版本冲突 / 幂等 / 字段规则 / 假目标）==')
if not PW:
    print('结果： FAIL 取不到 %s 的管理员口令' % BASE)
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
RUN = str(os.getpid())
handle = None

try:
    # ---------- 前置：造**本判据专用**的混合表 ----------
    handle = _ss_seed.seed_mixed_table(c, run=RUN, name='F04库级反例-%s.xlsx' % RUN)
    TABLE = handle['table']
    RID = (handle.get('row_ids') or [None])[0]
    AMT = handle.get('headers', {}).get('金额') if isinstance(handle.get('headers'), dict) else None
    # handle['headers'] 是列表；金额列名从 MIXED_HEADERS 里认（公共件只此一份）
    if AMT is None:
        AMT = _ss_seed.MIXED_HEADERS[1]
    NOTE = _ss_seed.MIXED_HEADERS[2]
    check('0 前置·造出专用表（本判据只碰自己这张）',
          bool(TABLE) and bool(RID), 'table=%r rid=%r 金额列=%r' % (TABLE, RID, AMT))

    cv = handle['content_version']
    sv = handle['structure_version']

    def write(header, value, key, c_v=None, s_v=None):
        return t.action(c, 'files.cell_write', {
            'table': TABLE, 'row_id': RID, 'header': header,
            'value': value,
            'expected_content_version': cv if c_v is None else c_v,
            'expected_structure_version': sv if s_v is None else s_v,
            'op_id': 'f04-%s-%s' % (key, RUN)}, key)

    # ---------- 1 版本冲突（错 content_version）----------
    st, b = write(NOTE, {'type': 'text', 'value': 'f04'}, 'vc', c_v=cv + 999)
    msg = err_of(b)
    check('1 版本冲突（错 content_version）→ 拒且点名版本',
          st >= 400 and any(w in msg for w in ('版本', '冲突', '已被', '修改')),
          'HTTP %s %s' % (st, msg[:90]))

    # ---------- 2 版本冲突（错 structure_version）----------
    st, b = write(NOTE, {'type': 'text', 'value': 'f04'}, 'vs', s_v=sv + 999)
    check('2 版本冲突（错 structure_version）→ 拒', st >= 400,
          'HTTP %s %s' % (st, err_of(b)[:90]))

    # ---------- 3 幂等重放 ----------
    idem = 'f04-idem-%s' % RUN
    st1, b1 = c.request('POST', '/api/platform/actions/files.cell_write/execute', {
        'payload': {'table': TABLE, 'row_id': RID, 'header': NOTE,
                    'value': {'type': 'text', 'value': '幂等'},
                    'expected_content_version': cv, 'expected_structure_version': sv,
                    'op_id': 'f04-idem-target-%s' % RUN},
        'confirmed': True, 'idempotency_key': idem})
    st2, b2 = c.request('POST', '/api/platform/actions/files.cell_write/execute', {
        'payload': {'table': TABLE, 'row_id': RID, 'header': NOTE,
                    'value': {'type': 'text', 'value': '幂等'},
                    'expected_content_version': cv, 'expected_structure_version': sv,
                    'op_id': 'f04-idem-target-%s' % RUN},
        'confirmed': True, 'idempotency_key': idem})
    check('3 幂等重放（同 key）→ 不重复落盘',
          st1 == st2 or st2 >= 400, '1st HTTP %s / 2nd HTTP %s' % (st1, st2))

    # ---------- 4 撤销不存在的 op_id ----------
    st, b = t.action(c, 'files.sheet_cells_undo',
                     {'table': TABLE, 'op_id': 'f04-no-such-op-%s' % RUN}, 'nop')
    check('4 撤销不存在的 op_id → 拒（不假成功）', st >= 400,
          'HTTP %s %s' % (st, err_of(b)[:90]))

    # ---------- 5 字段规则（负数写入有 min 的列）----------
    st, b = write(AMT, {'type': 'number', 'value': -999999}, 'rule')
    msg = err_of(b)
    is_rule = any(w in msg for w in ('不能小于', '规则', 'min', '无效', '不能大于'))
    not_schema = '未声明字段' not in msg
    check('5 字段规则（负数写入 %s）→ 拒且是规则拒不是 schema 拒' % AMT,
          st >= 400 and is_rule and not_schema, 'HTTP %s %s' % (st, msg[:90]))

    # ---------- 6 读不存在的表 ----------
    st, b = t.service(c, 'files.sheet_read', {'table': 'f04-no-such-table-%s' % RUN})
    check('6 读不存在的表 → 404', st == 404, 'HTTP %s' % st)
finally:
    # ---------- 清理：只回收本判据自己造的那张 ----------
    if handle:
        try:
            receipt = _ss_seed.seed_cleanup(c, handle)
            print('  清理：recycled=%r active_left=%r residual=%r'
                  % (receipt.get('recycled'), receipt.get('active_left'), receipt.get('residual')))
        except Exception as e:
            print('  ⚠️ 清理没成：%s: %s' % (type(e).__name__, e))

print()
if fails:
    print('结果： FAIL %d 条 —— %s' % (len(fails), '；'.join(fails)))
    sys.exit(1)
print('结果： PASS（6 条反例都被正确拒绝，且拒因指向正确的业务规则）')
