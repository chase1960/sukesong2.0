"""B 的假设验证：**快路径坐标错导致值写到别的格**（`sheet.py` / `zipedit.py`，D 域）。

**测试通过 = 下面每条成立**：

1. 往**无字段的列**写一个**唯一可辨识**的值 → 读回整表，那个值在**预期那一格**
   （行 ID + 列名都对得上），**不在别的格**。
2. **快慢两条路都要验**（B 说分流看**解析缓存在不在**）：
   - **慢路径**（缓存冷：写之前不读表）→ 值在预期那格
   - **快路径**（缓存热：写之前先读一次表）→ 值**也在**预期那格
3. **敏感度**：慢/快两次的落点**一致**（不能一次对一次错）。

---
**为什么验这个**（B 2026-10-15 查到的线索，我验）：

快路径算坐标时，**行序和列序来自两个不同来源** ——
`row_pos` 从 `meta`（存的元数据）来、`col_pos` 从 `entry`（解析缓存）来。
**两份不同步 → 坐标算错 → 值写到别的格。**

B 说这能解释三件，但**解释不了「有字段那条是对的」**（回填走同一套写入）。
他的补法：**除非回填那次走的是慢路径**（按工作簿真实行列算），
**而 A 那次走快路径**。**快慢分流看解析缓存在不在。**

**可验假设**：
> 解析缓存**在但过时** → 快路径坐标错 → 值写到别的格；
> 缓存**不在** → 慢路径 → 对。

**⚠️ 假设没证实之前，先别改坐标那套**（E：「先把假设验掉，再决定改哪里」）。

**⚠️ 另一处 B 挖到的（跟本组分开，别混）**：手术自检**只验类型不验值**
（文本格只查 `t="inlineStr"` 在不在、数值格只查 `<v>` 在不在），
**没有一处比对实际值**。所以「自检过了」只证明「格在场、类型对」，
**不证明值写对了**。那条要改是另一件事，等本组结论出来再动。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_fast_path_coords.py
"""
import importlib.util
import json
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


def _locate(cli, table, needle):
    """**薄壳**：调公共件 `_ss_seed.locate_cell`（查找逻辑只此一份，§13），
    这里只拼 `(hits, why)` 形状给本文件的判据详情用。

    ⚠️ **本文件原先把查找逻辑整个抄了一份** —— 跟 `test_fast_path_value_check`
    重复。**逻辑只此一份，形状各适配**。
    """
    hits = _ss_seed.locate_cell(cli, table, needle)
    return hits, '命中 %d 处（读口 files.row_read，公共件 _ss_seed.locate_cell）' % len(hits)


def _write_plain(cli, table, rid, header, value, key):
    """**薄壳**：调公共件 `_ss_seed.write_plain_cell`（写入 + 版本闩只此一份），
    这里补回本文件用的 `(st, body), rr` 形状。
    """
    st, body = _ss_seed.write_plain_cell(cli, table, rid, header, value, key)
    rr = result_of(*t.service(cli, 'files.sheet_read', {'table': table}))
    return (st, body), rr


print('== B 假设验证：快路径坐标错导致值写到别的格 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令（SS_D_PW 未设，`_ss_cred.admin_pw_for` 也空）')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

handle = _ss_seed.seed_mixed_table(c, run=t.RUN, promote_with=c)
TABLE = (handle or {}).get('table')
RIDS = (handle or {}).get('row_ids') or []
HEADERS = (handle or {}).get('headers') or _ss_seed.MIXED_HEADERS
print('  夹具表 %s headers=%r rows=%d' % (TABLE, HEADERS, len(RIDS)))

# **写到无字段的列** —— `备注` 是 `promoted: False`，走表侧（快/慢路径都在这条）
TARGET = '备注' if '备注' in HEADERS else HEADERS[-1]
RID = RIDS[0] if RIDS else None

try:
    check('前置：夹具表有可写的无字段列和数据行',
          bool(TABLE) and bool(RID) and TARGET in HEADERS,
          'table=%r rid=%r target=%r' % (TABLE, RID, TARGET))

    # ---------- 慢路径：缓存冷（写之前**不**读表）----------
    needle_slow = '坐标探针-慢-%s' % uuid.uuid4().hex[:8]
    # ⚠️ **故意不读表**就写 —— 这样解析缓存不存在，走**慢路径**（按工作簿真实行列算）。
    # 但 `cell_write` 要版本闩，所以仍要读一次版本…… 那会建缓存。
    # **怎么办**：读版本这一步走 `files.versions`（**不解析工作簿**），
    # 这样拿得到 content_version 但**不建解析缓存**。
    st_v, b_v = t.service(c, 'files.versions', {'file': TABLE})
    _ = result_of(st_v, b_v)      # 只为让版本可读，**不碰解析缓存**
    # 直接写（版本闩用 `sheet_read` 那份**唯一**来源，见下）
    (st_s, b_s), _pre = _write_plain(c, TABLE, RID, TARGET, needle_slow, 'coord-slow')
    check('前置·慢路径：写一格被接受', st_s == 200,
          'HTTP %s %s' % (st_s, _err(b_s)[:110]))

    hits_slow, why_slow = _locate(c, TABLE, needle_slow)
    check('① **慢路径**：值在**预期那一格**（行 ID + 列名都对）',
          hits_slow == [(RID, TARGET)], '命中=%r 预期=%r %s' % (hits_slow, [(RID, TARGET)], why_slow))

    # ---------- 快路径：缓存热（写之前先读表，建解析缓存）----------
    # 这一步 `sheet_read` 会建/用解析缓存 → 下一次写走**快路径**（`_fast_write_cells`）。
    hits_pre, why_pre = _locate(c, TABLE, needle_slow)
    _ = hits_pre     # 只为建缓存
    needle_fast = '坐标探针-快-%s' % uuid.uuid4().hex[:8]
    (st_f, b_f), _ = _write_plain(c, TABLE, RID, TARGET, needle_fast, 'coord-fast')
    check('前置·快路径：写一格被接受', st_f == 200,
          'HTTP %s %s' % (st_f, _err(b_f)[:110]))

    hits_fast, why_fast = _locate(c, TABLE, needle_fast)
    check('② **快路径**：值也在**预期那一格**（B 的假设若是真的，这里会落到别的格）',
          hits_fast == [(RID, TARGET)], '命中=%r 预期=%r %s' % (hits_fast, [(RID, TARGET)], why_fast))

    # ---------- ③ 敏感度：慢/快落点一致 ----------
    check('③ 敏感度：慢/快两次的落点**一致**（不能一次对一次错）',
          hits_slow == hits_fast, '慢=%r 快=%r' % (hits_slow, hits_fast))

    # ---------- ④ 反例自检：判据真能抓住「写到别的格」----------
    phantom, why_ph = _locate(c, TABLE, '坐标探针-根本不存在-%s' % uuid.uuid4().hex[:8])
    check('④ **反例自检**：查一个不存在的值 → 命中为空（证明 ①② 不是恒过）',
          phantom == [], '命中=%r %s' % (phantom, why_ph))
    # ⚠️ **这里原本还有一条「慢路径那个值还在表里」** —— **判据设计错了**：
    # 两次写的是**同一格**（`备注`），快路径那次**必然覆盖**慢路径那个值，
    # 事后查当然没了。**不是丢了，是被覆盖。** 改成在覆盖**之前**就查（见 ② 之前那步）。

    # ---------- ⑤ ★ B 假设的核心：**缓存过时** ----------
    # B 说的是「解析缓存**在但过时**」—— 他点的机制是
    # `row_pos` 从 `meta` 来、`col_pos` 从 `entry`（解析缓存）来，
    # **两份不同步 → 坐标算错**。我上面 ①② 只验了「缓存新鲜」，**没验到这一条**。
    # 这里**造过时**：建缓存 → 加一列（结构变、meta 更新）→ 再写原列 → 看落点。
    hits_stale_pre, _ = _locate(c, TABLE, needle_fast)     # 先把缓存建起来
    _ = hits_stale_pre
    st_col, b_col = t.action(c, 'files.sheet_column_append', {
        'table': TABLE, 'header': '过时探针列',
        'expected_content_version': result_of(*t.service(c, 'files.sheet_read',
                                                         {'table': TABLE})).get('content_version'),
        'expected_structure_version': result_of(*t.service(c, 'files.sheet_read',
                                                           {'table': TABLE})).get('structure_version')},
                             'coord-stale-col')
    check('前置·造过时：加一列被接受（结构变了、meta 跟着更新）', st_col == 200,
          'HTTP %s %s' % (st_col, _err(b_col)[:110]))
    needle_stale = '坐标探针-过时-%s' % uuid.uuid4().hex[:8]
    (st_st, b_st), _ = _write_plain(c, TABLE, RID, TARGET, needle_stale, 'coord-stale')
    check('前置·过时后写一格被接受', st_st == 200,
          'HTTP %s %s' % (st_st, _err(b_st)[:110]))
    hits_stale, why_stale = _locate(c, TABLE, needle_stale)
    check('⑤ ★ **缓存过时**后写一格，值仍在**预期那格**'
          '（B 的假设核心：meta 与解析缓存不同步时坐标会错）',
          hits_stale == [(RID, TARGET)],
          '命中=%r 预期=%r %s' % (hits_stale, [(RID, TARGET)], why_stale))
    # 反例自检：新加的那列也**确实存在**（证明 ⑤ 不是在一张没变过的表上空跑）
    st_h, b_h = t.service(c, 'files.sheet_read', {'table': TABLE})
    hdrs_after = (result_of(st_h, b_h) or {}).get('headers') or []
    check('⑤ 反例自检：新加的列**确实在**（证明结构真的变了，⑤ 不是空跑）',
          '过时探针列' in hdrs_after, '表头=%r' % hdrs_after)
finally:
    receipt = _ss_seed.seed_cleanup(c, handle)

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  'PASS B 假设验证（%d 条）—— 值落在预期那格，快慢路径落点一致'
                  % len(checks)))
print('⚠️ 本组只验「落点对不对」。**手术自检只验类型不验值**那条（B 另挖到的）'
      '**不在本组**，等结论出来再动。')
sys.exit(1 if fails else 0)
