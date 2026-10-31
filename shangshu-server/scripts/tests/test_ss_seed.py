"""公共混合表夹具的**契约**（`_ss_seed.seed_mixed_table` / `seed_cleanup`）。

**测试通过 = 下面每条成立**：

1. `seed_mixed_table()` 造出一张表，读回表头是 **「项目名称 / 金额 / 备注」不多不少**
   —— 没被别的列污染（这正是 A 卡住的那件事：环境里那张表被测试加的 7 个列盖了原列名）。
2. 晋升定义读回来是 **是 / 是 / 否**（项目名称、金额晋升、备注没晋升），
   且两个晋升列**都绑着数据库字段**（不是空壳标记）。
3. 表里**有数据行**（≥1），不是只有表头的空壳。
4. `seed_cleanup()` 之后**回读确认**：这张表从**活跃表列表**（`scope=sheet`）里**消失**。
5. 它**真进了回收站** —— ⚠️ **产品没有硬删口**（只有 `files.recycle` 进回收站、本人仍可见），
   而且**回收站里的表格列不出来**（`files.file` 的 `scope=trash` 排除 xlsx，产品缺口）。
   所以这条**只能靠「写被拒且产品点名回收站」回读**，回执**也只能写到这一步、不许写「清空了」**。
6. 回执里 `active_left` 是**空列表**；`residual` 列出没清掉的（正常是空）。
7. **正对照**：造出来的表是**活的** —— 改一格普通列写得进去（不是一张废表/只读表）。

---
**为什么是公共件，不是「帮 A 建一张表」**（E 2026-10-15 派活原话）：
今天三个窗口都撞上「测试把环境搞脏了」（B6 归属残留、A 测试列覆盖、C 造一万封信）。
**C 是唯一收干净的**，因为它有 `seed_cleanup`。这个夹具给**所有**要测混合表的用例用，
不是给 A 一次用完就扔。造完清理、清完**回读确认**。

**边界**（照守）：
- **不动 `hkt3bcago8`** —— 那张表上有历史证据（RT 组 25 条、004C 前几轮），
  改库就说不清什么时间发生什么了。
- **不直接改数据库** —— 走产品自己的动作口。绕过产品能力，将来产品一改就废。
- **不碰 `column_delete` 的空想** —— 产品现在**没有删列能力**（全仓无 `column_delete`），
  所以「清干净」对**列**是做不到的；夹具**不往共享表上加列**，只造**自己的一次性表**。

用法：
  export SS_BASE=http://127.0.0.1:3840
  export SS_D_USER=Administrator SS_D_PW=…   # 口令见 Agent-D-测试账号.md，不写进代码
  python3 shangshu-server/scripts/tests/test_ss_seed.py
"""
import importlib.util
import json
import os
import sys
import urllib.parse

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')
spec = importlib.util.spec_from_file_location('t', ROOT + '/shangshu-server/scripts/test-n2-structure.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
spec_s = importlib.util.spec_from_file_location(
    '_ss_seed', ROOT + '/shangshu-server/scripts/tests/_ss_seed.py')
try:
    _ss_seed = importlib.util.module_from_spec(spec_s)
    spec_s.loader.exec_module(_ss_seed)
    SEED_IMPORT_ERR = ''
except Exception as _e:                      # 夹具还没写出来时先红在这一条，不空转
    _ss_seed = None
    SEED_IMPORT_ERR = '%s: %s' % (type(_e).__name__, _e)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW', '')

checks, fails, not_yet = [], [], []


def check(label, valid, detail=''):
    """`check(判据, 成没成, 详情)` —— 跟 `test_d_promotion_chain` 同一个形状（§13 只留一份）。

    ⚠️ **第一版写成了 `check(item, label, valid)` 又按 `check(label, valid, detail)` 调** ——
    参数对不上，`label` 收到 bool，直接 `TypeError: can only concatenate str (not "bool") to str`。
    **定义和调用要同一个形状**，别各写各的。
    """
    checks.append(label)
    line = '  %s %s%s' % ('✓' if valid else '✗', label,
                          ('　—　' + str(detail)[:180]) if detail else '')
    if valid is None:
        not_yet.append(label)
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:180]) if detail else ''))
    else:
        if not valid:
            fails.append(label)
        print(line)
    return bool(valid)


def result_of(st, body):
    """**只此一份**在 `_ss_seed._result`（§13）—— 这里转发，不另写一份。

    ⚠️ 第一版在本文件又写了一份，且是**坏的**（`body.get('result') or {}`）——
    服务口回包**没有 `result` 信封**时直接回空，`sheet_read` 的表头被读成 `[]`，
    夹具当场报「表头对不上」。**同一件事两个家，必有一个是错的。**
    """
    return _ss_seed._result(st, body)


print('== 公共混合表夹具 seed_mixed_table / seed_cleanup ==')

check('前置：夹具模块 `_ss_seed.py` 装得进',
      not SEED_IMPORT_ERR, SEED_IMPORT_ERR or 'ok')

if SEED_IMPORT_ERR:
    print('\n结果： FAIL 夹具模块装不进，后面全是空转（先写夹具）')
    sys.exit(1)

if not PW:
    print('\n结果： FAIL 缺 SS_D_PW（口令见 Agent-D-测试账号.md，取进环境变量，不写进代码）')
    sys.exit(2)

admin = t.Client(BASE)
admin.login(USER, PW)

# ---------- 造 ----------
handle = _ss_seed.seed_mixed_table(admin, run=t.RUN)
check('① seed_mixed_table 造得出来（回了表 id）',
      bool(handle) and bool(handle.get('table')),
      'handle=%s' % json.dumps({k: v for k, v in (handle or {}).items()
                                if k in ('table', 'file_name', 'headers')},
                               ensure_ascii=False)[:160])

TABLE = (handle or {}).get('table')
HEADERS = (handle or {}).get('headers') or []

# **读回表头认认定的事实，不认夹具自己说的** —— 从 `files.sheet_read`（服务口）现读。
# ⚠️ **第一版写成 `files.sheet_range_read` 却走 `t.service`** —— 那是**动作**口
# （`HANDLERS` 里的 `_range_read`），走 service 门打不着，回空。**门口要对。**
st_r, b_r = t.service(admin, 'files.sheet_read', {'table': TABLE})
rr = result_of(st_r, b_r)
got_headers = rr.get('headers') or []
check('① 读回表头是「项目名称/金额/备注」**不多不少**（没被污染）',
      got_headers == ['项目名称', '金额', '备注'],
      '读回=%r 夹具自报=%r' % (got_headers, HEADERS))

# **晋升定义从产品读回**，不看夹具返回值。
st_pd, b_pd = t.service(admin, 'files.promotion_definition', {'table': TABLE})
pd = result_of(st_pd, b_pd)
cols = pd.get('columns') or []
flags = [(c.get('header'), bool(c.get('promoted'))) for c in cols]
fields = {c.get('header'): c.get('field') for c in cols if c.get('promoted')}
check('② 晋升定义读回是 **是/是/否**（项目名称、金额晋升，备注没晋升）',
      flags == [('项目名称', True), ('金额', True), ('备注', False)],
      '读回=%r' % (flags,))
check('② 两个晋升列**都绑着数据库字段**（不是空壳标记）',
      bool(fields.get('项目名称')) and bool(fields.get('金额')),
      'field=%r' % fields)

check('③ 表里**有数据行**（≥1，不是只有表头的空壳）',
      len(_ss_seed.row_ids_of(rr)) >= 1,
      'row_ids=%r（回包里是 `rows[].row_id`，**没有 `row_ids` 这个键**）'
      % (_ss_seed.row_ids_of(rr)[:4],))

# ---------- 正对照：造出来的表是活的 ----------
rid0 = (_ss_seed.row_ids_of(rr) or [None])[0]
st_w, b_w = t.action(admin, 'files.sheet_cell_write', {
    'table': TABLE, 'row_id': rid0, 'header': '备注',
    'value': {'type': 'text', 'value': '夹具烟测'},
    'expected_content_version': rr.get('content_version'),
    'expected_structure_version': rr.get('structure_version')}, 'seed-smoke')
check('⑦ 正对照：普通列**写得进去**（不是废表/只读表）',
      st_w == 200, 'HTTP %s %s' % (st_w, str(b_w)[:110]))

# ---------- 清 ----------
receipt = _ss_seed.seed_cleanup(admin, handle)
check('⑥ 回执有 `active_left` 字段且回**列表**（不是一句话）',
      isinstance((receipt or {}).get('active_left'), list),
      'receipt=%s' % json.dumps(receipt, ensure_ascii=False)[:200])

# **回读确认** —— 不认回执自报，从产品列表现查。
active = _ss_seed.names_in(admin, 'sheet')
# ⚠️ **不查 `scope=trash`** —— 那条排除 xlsx，回收站里的表格列不出来（产品缺口）。
# 「真进回收站」靠**写被拒**回读（`seed_cleanup` 的 `recycle_evidence`）。
check('④ 回读确认：活跃表列表（scope=sheet）里**没有它了**',
      TABLE not in active and (handle or {}).get('file_name') not in active,
      '活跃里=%s' % [n for n in active if n == TABLE or n == (handle or {}).get('file_name')][:3])
# ⚠️ **回收站没法从列表回读** —— `files.file` 的 `scope=trash` **排除 xlsx**，
# 所以回收站里的表格**列不出来**（产品缺口，登记待补）。只能用**写被拒**回读，
# 依据是产品自己回的原话（「回收站中的文件先恢复再改表」）。
ev = (receipt or {}).get('recycle_evidence') or {}
check('⑤ 回读确认：它**真进了回收站**（写被拒且产品点名「回收站」—— 列表查不到，只能这么核）',
      (receipt or {}).get('recycled') and ev,
      'recycled=%r 依据=%s' % ((receipt or {}).get('recycled'),
                               json.dumps(ev, ensure_ascii=False)[:150]))
check('⑥ 回执 `active_left` 是**空列表**（清完了）',
      (receipt or {}).get('active_left') == [],
      'active_left=%r' % ((receipt or {}).get('active_left'),))
check('⑥ 回执 `residual` 是**空列表**（没有清不掉的）',
      (receipt or {}).get('residual') == [],
      'residual=%r' % ((receipt or {}).get('residual'),))

# ⚠️ **判据不许查「某个词有没有」**（第一版就这么写，**自己会撒谎**）：
# `CLEANUP_NOTE` 里写着「**不是**「删了」也**不是**「清空了」」—— 诚实的免责声明
# 被子串匹配撞上「清空」二字，当场判成违规。**要查的是「免责声明在不在」**，
# 不是「某个字眼有没有出现」。**判据自己会撒谎，要专门防。**
note = (receipt or {}).get('note') or ''
check('⑤ 回执**说清做到了哪一步**：点名「回收站」，且**明确说自己不是**删了/清空了',
      ('回收站' in note) and ('不是' in note) and (('删' in note) or ('清空' in note)),
      'note=%s' % note[:170])
blob = json.dumps(receipt or {}, ensure_ascii=False)
check('⑤ 回执**没有结构化字段自称删掉了**（没有 deleted/removed 这类键）',
      all(k not in blob for k in ('"deleted"', '"removed"', '"purged"')),
      '回执键=%s' % sorted((receipt or {}).keys()))

print()
if checks == 0:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet and not fails:
    print('未测 %d 条（不算过）：' % len(not_yet))
    for _n in not_yet:
        print('  · ' + _n)
print('结果： ' + ('FAIL ' + ','.join(fails) if fails else
                  'PASS 公共夹具契约（%d 条）—— seed_mixed_table 造出干净混合表、'
                  'seed_cleanup 清完回读确认（到回收站为止）' % len(checks)))
sys.exit(1 if fails else 0)
