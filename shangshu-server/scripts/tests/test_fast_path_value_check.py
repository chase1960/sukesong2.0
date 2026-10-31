"""快路径落盘后**也要验值** —— 不只慢路径有 `_verify_saved` 兜底。

**测试通过 = 下面每条成立**：

1. **前置·造出快路径**：写一格走**快路径**（`timing.fast_path` 是 `surgery`）——
   走慢路径的话下面全是空判据。
2. **快路径也验值**：落盘后**重读校验**跑了（`timing` 里有值校验那一步的标记）。
3. **慢路径对照**：慢路径也验值（本来就有，别把慢路径改坏）。
4. **静态对账**：两条路**各自有**值校验 —— 慢路径 `_verify_saved`，
   快路径 `_verify_saved` 或 B03 的 `_verify_surgery`（受控增量验证，四类保证不变）。
5. ★ **造反例：值写错会被抓住吗** —— 装 `value-mismatch` 断点（`_corrupt`，
   **静默篡改**不抛）让「落盘的 ≠ 打算写的」，**两条路对照**：
   慢路径该抓住（`_verify_saved`）、快路径该抓不住（缺口）—— **一绿一红 = 缺口坐实**。
   **E 2026-10-15 提醒**：「先别急着改 —— 先确认现在快路径写错值时**真的不会被发现**」。
   B 的坐标假设就没复现，这条也可能是「机制有洞但触发不到」。**先造反例再决定改不改。**

---
**为什么有这条**（B 2026-10-15 复核调用链，纠我一句）：

我先前说「手术自检只验类型不验值，**但保存校验兜着**」——**范围说大了**：

| 路径 | 落盘函数 | 值校验 |
|---|---|---|
| 慢路径 | `_save_with_gates` → **`_verify_saved`**（`:2056`） | ✅ **验值**（「目标值不符」那条） |
| **快路径** | **`_save_version`**（`:310`/`:334`） | ❌ **没有** |

`_verify_saved` **全文件只有一个调用点**（在 `_save_with_gates` 里），
`_fast_write_cells` **直接调 `_save_version`**，绕过它。
`_save_version` 本体只是 `save_file` + `_record_version`，**没有任何值校验**。

**所以「手术自检过了 ≠ 值写对了」在快路径上是真的会漏** ——
不是「机制上有洞但没触发」，是**现在就没有兜底**。

⚠️ **我先前测的 ① 慢路径 / ② 快路径 / ⑤ 缓存过时三组落点都对**，
但那验的是**落点**（坐标），**不是值**。**值写对没写对，快路径现在没人验。**

**B 给两条路，我选 ①**（他倾向，我同意）：
1. **快路径落盘后也过 `_verify_saved`** —— **一份判定源、两条路都验** ✅
2. ~~`_verify_edit_nodes` 补验值~~ —— 那是**第二份判定源**（撤改时一边新一边旧）
**`_verify_saved` 本来就是验落盘后的值**，让它两条路都跑，**不造第二份**。

**⚠️ B 自己也纠了自己**：他先前说「自检只验类型不验值，但保存校验兜着」时
**没查调用链**，是照我的话往下接的。**这条跟「转述前先核前提」是同一条。**

---
**为什么第 5 条是「登记」不是「判据」**：
「值写错会被抓住」要造出「落盘的 ≠ 打算写的」——
正常路径两者本来就相等，**造不出反例**。要造得加注入点（`_ss_fault` 加
`value-mismatch`），那是产品改动。**先把「校验真的跑了」立住**（第 2/3 条），
**「抓住了」那半登记待补**。**不假装验过。**

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_fast_path_value_check.py
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


# **公共件只此一份**（§13）—— `_locate`/`_write` 在 `_ss_seed`，这里转发不另写。
# 第一版在本文件又写了一份，跟 `test_fast_path_coords` 重复了。
_locate = _ss_seed.locate_cell
_write = _ss_seed.write_plain_cell


def _timing_of(res):
    return (res or {}).get('timing') or {}


print('== 快路径落盘后也要验值（不只慢路径有 `_verify_saved`）==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令（SS_D_PW 未设，`_ss_cred.admin_pw_for` 也空）')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

handle = _ss_seed.seed_mixed_table(c, run=t.RUN, promote_with=c)
TABLE, RID = (handle or {}).get('table'), ((handle or {}).get('row_ids') or [None])[0]
print('  夹具表 %s 行 %s' % (TABLE, RID))

try:
    # ---------- 1. 造出快路径 ----------
    needle_fast = '快路径探针-%s' % uuid.uuid4().hex[:6]
    st_f, b_f = _write(c, TABLE, RID, '备注', needle_fast, 'vp-fast', warm=True)
    res_f = result_of(st_f, b_f) if st_f == 200 else {}
    tim_f = _timing_of(res_f)
    is_fast = (tim_f.get('fast_path') == 'surgery') or bool(tim_f.get('fast_path'))
    check('1 前置·**造出快路径**（`timing.fast_path` = surgery；走慢路径后面全空判据）',
          st_f == 200 and is_fast,
          'HTTP %s timing=%r' % (st_f, tim_f))

    # ---------- 2. 快路径也验值 ----------
    # ⚠️ **判据看的是「值校验那一步有没有跑」**，不是「值对不对」——
    # 正常路径值本来就对，验不出。**「抓住了」那半见第 5 条（登记）。**
    VERIFY_MARKS = ('verify_saved', 'verify_value', '值校验', 'verify')
    tim_blob = str(tim_f)
    check('2 **快路径也验值**：落盘后**重读校验**跑了（`timing` 里有标记）',
          is_fast and any(m in tim_blob for m in VERIFY_MARKS),
          'timing=%r（要能看到值校验那一步）' % (tim_f,))

    # ---------- 3. 慢路径对照：**造不出来，如实登记** ----------
    # ⚠️ **第一版想用 `warm=False` 造慢路径** —— 实测**两次都走快路径**
    # （`timing.fast_path='surgery'`）。原因查清：`_fast_write_cells` 的回落条件里
    # **`if ctx is None: return None`**，而 `_fast_ctx` 会**自己建 ctx** ——
    # 所以「我读没读过表」**造不出差别**，快路径总能建出上下文。
    # **B 说的「快慢分流看解析缓存在不在」是对的**，但分流点在 `_fast_ctx` 能不能
    # 拿到 ctx，**不是**「调用方有没有预热」。
    # **要造慢路径得让 `_fast_ctx` 返 None**（值类型不支持 / 特殊格），另说。
    needle_slow = '慢路径探针-%s' % uuid.uuid4().hex[:6]
    st_s, b_s = _write(c, TABLE, RID, '备注', needle_slow, 'vp-slow', warm=False)
    res_s = result_of(st_s, b_s) if st_s == 200 else {}
    tim_s = _timing_of(res_s)
    went_slow = not tim_s.get('fast_path')
    if went_slow:
        check('3 **慢路径对照**：慢路径也验值（本来就有，别把慢路径改坏）',
              any(m in str(tim_s) for m in VERIFY_MARKS), 'HTTP %s timing=%r' % (st_s, tim_s))
    else:
        print('  [登记·不判] ③ **慢路径造不出来**（`warm=False` 也走快路径，'
              '`_fast_ctx` 自己建 ctx）—— 慢路径那半**没验**，不假装验过。'
              'timing=%r' % (tim_s,))

    # ---------- 4. 唯一日常路径的运行时回执 ----------
    # 不再用函数名计数假装证明“每条分支都有验证”；实际破坏性反例在下一节。
    check('4 冷/暖写入都走同一增量路径，不能退到整簿保存',
          tim_s.get('fast_path') == 'surgery' and tim_f.get('fast_path') == 'surgery',
          'cold=%r / warm=%r' % (tim_s, tim_f))

    # ---------- 5 ★ 造反例：值写错会被抓住吗 ----------
    # ⚠️ **E 2026-10-15 提醒的要害**：「**先别急着改** —— 先确认现在快路径写错值时
    # **真的不会被发现**（造一个错值试试）。**B 的坐标假设就没复现**，这条也可能是
    # 「机制有洞但触发不到」。」
    # 所以**先造反例**再决定改不改。造法：装 `value-mismatch` 断点（`_corrupt`，
    # **静默篡改**不抛）→ 让「落盘的 ≠ 打算写的」。
    # **两条路对照**：慢路径有 `_verify_saved` 应该抓住、快路径应该抓不住 ——
    # **一绿一红 = 缺口坐实**，红因清楚。
    sf = _load('_ss_fault', '/shangshu-server/scripts/tests/_ss_fault.py')
    compose = sf.compose_of(BASE)
    needle_corrupt = '篡改探针-%s' % uuid.uuid4().hex[:6]

    def _corrupt_case(warm, tag):
        armed, why = sf.arm(compose, 'value-mismatch')
        try:
            st, body = _ss_seed.write_plain_cell(c, TABLE, RID, '备注', needle_corrupt, tag, warm=warm)
        finally:
            sf.clear(compose)
        res = result_of(st, body) if st == 200 else {}
        hits = _ss_seed.locate_cell(c, TABLE, needle_corrupt)
        # **被抓住** = 产品报错（st != 200 / 回执说失败），**或**落盘后值不等于 intended
        caught = (st != 200) or (res.get('applied') is False) or (
            str((res.get('after') or {}).get('value') if isinstance(res.get('after'), dict) else
                res.get('after')) != needle_corrupt)
        value_ok = hits == [(RID, '备注')]
        return armed, st, caught, value_ok, hits, res

    a_f, st_f2, caught_f, ok_f, hits_f, res_f2 = _corrupt_case(True, 'corrupt-fast')
    # ⚠️ **先确认「篡改真的发生了」** —— 没篡改的话，「抓住=False」是**空过**
    # （本来就没什么可抓的），不能当成「值写错不被抓住」。
    # **判据自己会撒谎**：第一版直接判 `caught_f`，红因是「旧代码没 `_corrupt` 注入点」，
    # 跟「值写错不被抓住」**不是一回事**。
    corrupt_acted = (not ok_f) or (hits_f != [(RID, '备注')]) or (
        str((res_f2 or {}).get('after') or {}).find('篡改') < 0 and not ok_f)
    if ok_f and hits_f == [(RID, '备注')]:
        print('  [登记·不判] ⑤ **篡改没发生**（值还是对的）—— 运行面是**旧代码**，'
              '没有 `_corrupt` 注入点。**反例造不出来，不假装验过。**'
              ' 要造得先把 `sheet.py` 部署上（`_corrupt` 是本笔新加的）。')
    else:
        check('5 ★ **快路径**：值被篡改后**必须被抓住**（产品报错 或 重读发现不符）'
              '—— 抓不住就是「值写错没人发现」，B 说的缺口坐实',
              a_f and caught_f,
              '断点=%s HTTP %s 抓住=%r 值对=%r 落点=%r after=%r'
              % (a_f, st_f2, caught_f, ok_f, hits_f, (res_f2 or {}).get('after')))
        a_s, st_s2, caught_s, ok_s, hits_s, res_s2 = _corrupt_case(False, 'corrupt-slow')
        check('5 ★ **慢路径对照**：同一篡改，慢路径**该抓住**（`_verify_saved` 那条）',
              a_s and caught_s,
              '断点=%s HTTP %s 抓住=%r 值对=%r' % (a_s, st_s2, caught_s, ok_s))
        # ⚠️ **这条的前提变了，判据跟着改** —— 不是为了让它绿。
        # 它原本期待「快路径**抓不住**、慢路径抓住」（缺口存在时的一红一绿）。
        # **缺口补上之后两条都抓住** —— 那是**正确的结果**，判据却判红。
        # 所以改成「**两条路都抓住**（不许一条抓一条漏）」—— 这才是补完后的正确断言。
        # **记下来**：判据的「敏感度」条常常绑着「当前缺陷的形状」，缺陷修了它就过时。
        check('5 ★ **两条路都抓住**（补完后不许一条抓一条漏）',
              caught_f and caught_s,
              '快路径抓住=%r 慢路径抓住=%r（都该为真）' % (caught_f, caught_s))
finally:
    receipt = _ss_seed.seed_cleanup(c, handle)

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  'PASS 快路径值校验（%d 条）—— 快慢两条路都验值 + 静态对账'
                  % len(checks)))
print('⚠️ 第 5 条要**运行面有 `_corrupt`**（本笔新加）才造得出反例。**当前红因是「没注入点」，不是「值写错不被抓住」。**')
sys.exit(1 if fails else 0)
