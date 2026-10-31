"""普通列写入**失败回执**：给明确拒绝回执（不是 500）、不谎报、`retryable` 如实。

**测试通过 = 下面每条成立**：

1. **前置·能造出失败**：装 `file-write` 断点后写一格 → **真的没落盘**
   （`version_count` 不变、值读不回）。**造不出失败，后面全是空判据。**
2. **失败给明确拒绝回执**：HTTP **200** + 人话（说清「**值没写进去**」），
   **不是** 500「平台请求失败 / RuntimeError」。
   —— **口径取自晋升列那支**：`_writeback` 失败时**不抛**，回
   「正式值已写进数据库，但回写 Excel 那步失败了…请重试保存」。普通列**要同一个水准**。
3. **`applied` 如实**：失败时**显式 `False`**（现在是硬编码 `True`；**`None` 不算过** ——
   那是回执整个没了，空过长得跟过一模一样）。
4. **`after` 不谎报**：失败时**不许声称值已写上**。
5. **`retryable` 如实**：落盘失败是**瞬时故障** → **`True`**（原样重发**可能成**）；
   「人该做什么」由 `message` 说清「**请重新保存**」。**两个键分工，别混**
   （`retryable` 答机器能不能重试，`message` 答人该做什么）。
6. **对照·成功时一致**：正常写（断点卸掉）→ `after` **与落盘后实测值一致**（读回比对）。
7. **对照·两条支一个水准**：晋升列失败时说的话，普通列失败时**也得说清**。

---
**为什么有这条**（B 2026-10-15 线索 → D 验出来的）：

B 问「回执说谎」还是「前端误判」。**都不是** —— 实测是**第三种**：

```
HTTP 500
{'ok': False, 'error': '平台请求失败', 'code': 'PLATFORM_ERROR',
 'detail': 'RuntimeError', 'retryable': True}
applied = None   after = None     version_count 3→3     值落点 []
```

**拒得对**（没假成功），**但说不清** —— 用户看到「平台请求失败 / RuntimeError」，
不知道**值没写进去**、不知道该重试还是找人。**`retryable: True` 还是误导**
（断点在、原因没除，重试照样 500）。

**⚠️ 同一个用户动作，两条支的失败文案天差地别**：
· **晋升列**（`_writeback` 失败）→「正式值**已写进数据库**，但回写 Excel 那步失败了。
  本次**没改到 Excel 文件**，导出暂不可用…已标「待恢复」：请重试保存」
· **普通列**（快路径落盘失败）→「**平台请求失败** / **RuntimeError**」

**这是「要区分晋升和写入」那条口径只做了前一半** —— 区分了权限和路由，
**没区分失败怎么说**（用户原话：「**要区分的是：晋升字段这个动作和写入这个动作**」）。

---
**⚠️ 顺带钉住「回执说谎」的机制**（本组第 3/4/6 条）：

| 路径 | `after` 来源 | 值校验 | `applied` |
|---|---|---|---|
| 慢路径 | `cell_typed(ws.cell(...))` **内存值（回声）** | `_save_with_gates` **落盘后重读验值** ✅ | 硬编码 `True` |
| **快路径** | `value_typed(raw_after)` **打算写的值（回声）** | **只有 `_verify_edit_nodes` 验类型** ❌ | 硬编码 `True` |

**`applied` 两条路都硬编码**、**`after` 两条路都是回声** ——
所以「快路径写错值也看不出来」**机制上成立**。本组先把「失败时别谎报」立住，
**「写错值也看不出来」那半**（落盘后重读）等第 6 条的对照铺开。

**判据里有一条硬的**：**`version_count` 不是回声**（回执可以是回声，版本数不会）。
造失败时用它当「真没落盘」的证据。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_write_failure_receipt.py
"""
import importlib.util
import os
import sys
import uuid

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_fault = _load('_ss_fault', '/shangshu-server/scripts/tests/_ss_fault.py')
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
                         ('　—　' + str(detail)[:200]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


def _err(body):
    return _ss_seed._err(body)


def _version_count(cli, table):
    """`files.versions` 的**版本条数** —— 「真没落盘」的硬证据（不是回声）。"""
    r = result_of(*t.service(cli, 'files.versions', {'file': table}))
    r = r if isinstance(r, list) else (r.get('versions') or [])
    return len(r)


def _locate(cli, table, needle):
    st, body = t.service(cli, 'files.sheet_read', {'table': table})
    rr = result_of(st, body)
    rids = [x.get('row_id') for x in (rr.get('rows') or []) if x.get('row_id')]
    hits = []
    for rid in rids:
        cells = (result_of(*t.service(cli, 'files.row_read',
                                      {'table': table, 'row_id': rid})) or {}).get('cells') or {}
        for header, cell in cells.items():
            v = (cell or {}).get('value') if isinstance(cell, dict) else cell
            if str(v or '') == str(needle):
                hits.append((rid, header))
    return hits


print('== 普通列写入失败回执：说人话 · 不谎报 · retryable 如实 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令（SS_D_PW 未设，`_ss_cred.admin_pw_for` 也空）')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
compose = _ss_fault.compose_of(BASE)

handle = _ss_seed.seed_mixed_table(c, run=t.RUN, promote_with=c)
TABLE, RID = (handle or {}).get('table'), ((handle or {}).get('row_ids') or [None])[0]
print('  夹具表 %s 行 %s' % (TABLE, RID))


def _write(needle, key):
    rr = result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    return t.action(c, 'files.cell_write', {
        'table': TABLE, 'row_id': RID, 'header': '备注',
        'value': {'type': 'text', 'value': needle},
        'expected_content_version': rr.get('content_version'),
        'expected_structure_version': rr.get('structure_version')}, key)


try:
    # ---------- 1. 造失败 ----------
    n_before = _version_count(c, TABLE)
    needle_fail = '失败探针-%s' % uuid.uuid4().hex[:6]
    armed, why_arm = _ss_fault.arm(compose, 'file-write')
    st_f, b_f = None, None
    try:
        st_f, b_f = _write(needle_fail, 'fail-receipt')
    finally:
        _ss_fault.clear(compose)
    res_f = result_of(st_f, b_f) if st_f == 200 else {}
    n_after = _version_count(c, TABLE)
    landed = _locate(c, TABLE, needle_fail)
    check('1 前置·**造出失败**：断点下写一格，真的没落盘（版本数不变 + 值读不回）',
          armed and n_after == n_before and not landed,
          'HTTP %s 版本 %d→%d 落点=%r %s' % (st_f, n_before, n_after, landed, why_arm))

    # 全部错误文案（500 时 body 里是 `error`/`detail`，200 时是回执字段）
    blob = str(b_f or {})
    res_blob = str(res_f or {})

    # ---------- 2～5 失败时该是「明确拒绝回执」，不是 500 ----------
    # ⚠️ **口径取自晋升列那支**（今天刚做的）：`_writeback` 失败时**不抛**，
    # 回 **HTTP 200 + `sheet_written: False` + 人话**（「如实说两半各成没成」）。
    # 普通列**要同一个水准**。
    # ⚠️ **第一版判「`applied` 不是 True」** —— 500 时回执整个没了，`res_f` 是 `{}`，
    # 这条**恒真**（空过）。真正要验的是「**失败也给一个诚实的回执**」。
    NOT_HUMAN = ('平台请求失败', 'PLATFORM_ERROR', 'RuntimeError', 'Traceback')
    blob_all = res_blob + blob
    said_human = any(w in blob_all for w in
                     ('没写', '未写', '未落盘', '没改到', '本次未生效', '没保存', '未保存'))
    check('2 失败时**给明确拒绝回执**（HTTP 200，像晋升列那支「如实说两半」）—— '
          '**不是 500「平台请求失败」**',
          st_f == 200 and said_human and not any(w in blob_all for w in NOT_HUMAN),
          'HTTP %s 文案=%r' % (st_f, blob_all[:200]))
    check('3 **`applied` 如实**：失败时是 `False`（不是硬编码 `True`、也不是回执整个没了）',
          res_f.get('applied') is False,
          'applied=%r（要显式 False，None 不算 —— None 是回执根本没回）'
          % (res_f.get('applied'),))
    after_f = res_f.get('after')
    after_says_written = bool(after_f) and (
        after_f.get('value') == needle_fail if isinstance(after_f, dict) else False)
    check('4 **`after` 不谎报**：失败时**不许声称值已写上**',
          not after_says_written,
          'after=%r 期望值=%r' % (after_f, needle_fail))
    retryable = res_f.get('retryable')
    # ⚠️ **`retryable` 的语义我先前定错了，B 2026-10-15 纠对**：
    # 通行意思是「**原样重发会不会成**」，**不是**「要不要人重新发起」。
    # **两个键分工**（别混）：
    #   · `retryable` 答「**机器**能不能重试」
    #   · `message` 答「**人**该做什么」
    # **落盘失败**（磁盘满/超时这类）是**瞬时故障** → 原样重发**可能成** → `retryable: True`
    # **版本冲突/校验失败** → 原样重发**必败** → `retryable: False`
    # （那走异常路径，不进本回执）
    # **别新造 `action_required`** —— 跟 `retryable: False` 语义重叠，
    # 将来会有人问「这两个谁说了算」。**抽象等第二个需求。**
    check('5 **`retryable` 如实反映「原样重发会不会成」**：落盘失败是**瞬时故障** → `True`；'
          '「人该做什么」由 `message` 说清「请重新保存」',
          retryable is True and any(w in blob_all for w in ('重新保存', '重试保存', '再存', '重新写')),
          'retryable=%r 文案=%r' % (retryable, blob_all[:160]))

    # ---------- 6. 对照·成功时 after 与实测一致 ----------
    needle_ok = '成功探针-%s' % uuid.uuid4().hex[:6]
    st_ok, b_ok = _write(needle_ok, 'ok-receipt')
    res_ok = result_of(st_ok, b_ok) if st_ok == 200 else {}
    hits_ok = _locate(c, TABLE, needle_ok)
    after_ok = (res_ok.get('after') or {}).get('value') if isinstance(res_ok.get('after'), dict) else None
    check('6 对照·**成功时 `after` 与落盘实测一致**（读回比对，不是回声）',
          st_ok == 200 and after_ok == needle_ok and hits_ok == [(RID, '备注')],
          'after=%r 实测落点=%r 期望=%r' % (after_ok, hits_ok, [(RID, '备注')]))

    # ---------- 7. 两条支一个水准 ----------
    # 晋升列失败的文案是人话（今天刚做的那条），普通列失败**也得说清**。
    check('7 对照·**两条支的失败文案一个水准**（不许一个是人话、一个是「平台请求失败」）',
          said_human,
          '普通列失败文案=%r（晋升列那支的人话见 RT-④③ ②）'
          % ((res_blob + blob)[:160],))

    # ---------- 8～9 ★ 两支**成功**回执字段对齐（B 2026-10-15 提出）----------
    # **A 查到的前端版本冲突根因**：写晋升列后前端拿不到 `content_version`，
    # 带旧号去写下一次 → 版本闩拒。
    # ⚠️ **准确说法是「没回」不是「回了旧值」**（B 特意点了）——
    # 前端拿到 `undefined` 自己兜成旧值。**那是「丢字段」，不是「回声」**，
    # 两回事：回声是「回了打算写的值」，这个是「压根没这个键」。
    #
    # ⚠️ **不是嵌在 `result.sheet.content_version` 里**（B 原话这么说，实测**不对**）——
    # 源头 `sheet.write_cells` 的 return **有** `content_version`/`structure_version`，
    # 但 `_writeback` **丢了**（只取 written/cells/timing/op_id），
    # 晋升支回执也没补。**两层都丢**，前端两处找都是 undefined。
    # **判据要钉「顶层就有、两支同名」**，别让消费方替生产方做兼容
    # （A 现在写的就是 `result.sheet?.content_version ?? result.content_version`）。
    needle_prom = '晋升回执探针-%s' % uuid.uuid4().hex[:6]
    st_p, b_p = None, None
    try:
        st_p, b_p = t.action(c, 'files.formal_value_write', {
            'table': TABLE, 'row_id': RID, 'values': {'amount': 42.5}},
            'promoted-receipt')
    except Exception as _e:
        st_p, b_p = 0, {'error': str(_e)}
    res_p = result_of(st_p, b_p) if st_p == 200 else {}
    # 晋升列那支要看 `formal_value_write`；普通列那支看上面第 6 条的 `res_ok`
    check('8 ★ **晋升列回执顶层有 `content_version`**（不是嵌在 `result.sheet` 里）',
          st_p == 200 and isinstance(res_p.get('content_version'), int),
          'HTTP %s 顶层 content_version=%r（result.sheet 里=%r）'
          % (st_p, res_p.get('content_version'),
             (res_p.get('sheet') or {}).get('content_version')))
    check('8 ★ **晋升列回执顶层有 `structure_version`**（同上，两支同名）',
          st_p == 200 and isinstance(res_p.get('structure_version'), int),
          'HTTP %s 顶层 structure_version=%r' % (st_p, res_p.get('structure_version')))
    # **是真值不是回声**：跟 `files.versions` 的实际版本比（B 的判据：版本数不会是回声）
    real_v = result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    check('8 ★ **是真值不是回声**：回执的 `content_version` == 落盘后的实际版本',
          res_p.get('content_version') == real_v.get('content_version'),
          '回执=%r 实际=%r' % (res_p.get('content_version'), real_v.get('content_version')))
    # **两支同名**：普通列那支（第 6 条的 res_ok）也要有顶层这两个键
    check('9 ★ **两支同名同位**：普通列那支也有顶层 `content_version`/`structure_version`'
          '（前端不用 `result.sheet?.x ?? result.x` 两处找）',
          isinstance((res_ok or {}).get('content_version'), int)
          and isinstance((res_ok or {}).get('structure_version'), int),
          '普通列顶层 content_version=%r structure_version=%r'
          % ((res_ok or {}).get('content_version'), (res_ok or {}).get('structure_version')))
finally:
    _ss_fault.clear(compose)
    receipt = _ss_seed.seed_cleanup(c, handle)

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  'PASS 普通列失败回执（%d 条）—— 说人话、不谎报、retryable 如实、'
                  '成功时 after 与实测一致' % len(checks)))
sys.exit(1 if fails else 0)
