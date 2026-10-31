"""D 线写路径探针：快路径何时回落整簿重写（PKG-004-T02，差额 D-24 / D-25）。

**测试通过 = 下面每条成立**：

FP-① **文本值走手术快路径**：写一个 `type:'text'` 的格，回包 `timing.fast_path == 'surgery'`
     —— 说明这一笔没有整簿重写，只改了工作表 XML 里的那一格。

FP-② **日期值回落整簿重写**：写一个 `type:'date'` 的格，回包 `timing.fast_path == 'skip:value-type'`
     **且** `timing` 里出现 `snapshot_before` / `verify_reopen` 两段
     —— 这两段只有慢路径 `_save_with_gates` 才打（整簿快照 → 全量序列化 → 重开整簿验证）。
     **这条成立 = D-25 坐实**：日期写入每次都要整簿重写，而真实表里日期是主力。

FP-③ **三张表来回读会互相挤掉解析缓存**：建三张表 A/B/C，按 A→B→C→A→B→C 读六次，
     `diagnostics.parse_count` **累计增长 ≥3 次**（后三次本该命中却重新解析）。
     对照：单独对 A 连读三次，`parse_count` **只长 1 次**（第一次解析，后两次命中）。
     **这条成立 = D-24 坐实**：`_PARSE_CACHE_MAX = 2` 装不下三张表，冷解析反复发生。

FP-④ **反例（故意翻期望必须能红）**：把 FP-② 的期望改成「date 也要回 surgery」，
     在同一份回包上必须判 FAIL —— 否则判据恒真，等于没写。

---
**为什么单独写这个**：R1 那组「单格 399ms P95」的写值**清一色 `type:'text'`**（`test_r1_perf.py:236/291/326/447`），
而 text 恰在快路径白名单 `SURGICAL_TYPES=('text','number','empty','boolean')` 里（`sheet.py:1117`），
**`date` 不在**。所以那组数字量的是快路径，不覆盖日期等必回落类型 —— 与用户「改一格也要很久」对不上。
本探针只回答「**哪条路被走到**」，不做性能达标判定；性能数字等大表时段单独出。

**边界**：只读写 `files.*` 动作与 `files.sheet_read` 服务，不动内核、不动权限实现。
跑在 D 独立实例（默认 3840）；旧测试写死 3820，这里用 `SS_BASE` 显式指定，账号用 `SS_D_USER`/`SS_D_PW`。

用法：
  SS_BASE=http://127.0.0.1:3840 SS_D_USER=Administrator SS_D_PW=… \\
    python3 shangshu-server/scripts/tests/test_d_writepath_probe.py [--cases fp1,fp2,fp3,fp4]
"""
import argparse
import importlib.util
import os
import sys
import time

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')
spec = importlib.util.spec_from_file_location('t', ROOT + '/shangshu-server/scripts/test-n2-structure.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW', '')
if not PW:
    print('结果： FAIL 缺 SS_D_PW（D 账号口令见 开发/本地测试/Agent-D-测试账号.md，不写进代码）')
    sys.exit(2)

RUN = t.RUN
VALID = ('fp1', 'fp2', 'fp3', 'fp4')
parser = argparse.ArgumentParser(description='D 写路径探针：快路径回落与解析缓存挤换')
parser.add_argument('--cases', default=','.join(VALID))
cli = parser.parse_args()
raw = cli.cases.strip()
want = tuple(x.strip() for x in raw.split(',') if x.strip()) if raw else VALID
if not want:
    print('结果： FAIL --cases 给了空选择'); sys.exit(2)
bad = [x for x in want if x not in VALID]
if bad:
    print('结果： FAIL --cases 有未知用例：%s' % ','.join(bad)); sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

checks = 0
fails = []


def check(name, ok, detail):
    global checks
    checks += 1
    print(('  PASS ' if ok else '  FAIL ') + name + ' —— ' + str(detail))
    if not ok:
        fails.append(name)


def create_table(title):
    st, body = t.action(c, 'files.create', {'file_name': title}, 'create-%s-%s' % (title, RUN))
    if st != 200 or not body.get('ok'):
        raise SystemExit('建表失败 %s: HTTP %s %s' % (title, st, body))
    res = body.get('result') or body
    return res['file']


def versions(table):
    """取当前内容/结构版本 —— 版本闩要传真实值，不写死（写死会撞 417）。"""
    st, body = read_table(table)
    if st != 200 or not body.get('ok'):
        raise SystemExit('读表失败 %s: HTTP %s %s' % (table, st, body))
    res = body.get('result') or body
    return (int(res.get('content_version') or 0), int(res.get('structure_version') or 1))


def add_columns(table, headers):
    for h in headers:
        cv, sv = versions(table)
        st, body = t.action(c, 'files.sheet_column_append',
                            {'table': table, 'header': h,
                             'expected_content_version': cv,
                             'expected_structure_version': sv},
                            'col-%s-%s-%s' % (table, h, RUN))
        if st != 200 or not body.get('ok'):
            raise SystemExit('加列失败 %s/%s: HTTP %s %s' % (table, h, st, body))
    return True


def add_row(table):
    cv, sv = versions(table)
    st, body = t.action(c, 'files.sheet_row_append',
                        {'table': table, 'count': 1,
                         'expected_content_version': cv,
                         'expected_structure_version': sv},
                        'row-%s-%s' % (table, RUN))
    if st != 200 or not body.get('ok'):
        raise SystemExit('加行失败 %s: HTTP %s %s' % (table, st, body))
    return (body.get('result') or body)['row_ids'][0]


def write_cell(table, row_id, header, value):
    cv, sv = versions(table)
    t0 = time.perf_counter()
    st, body = t.action(c, 'files.sheet_cell_write',
                        {'table': table, 'row_id': row_id, 'header': header, 'value': value,
                         'expected_content_version': cv, 'expected_structure_version': sv},
                        'w-%s-%s-%s' % (table, header, RUN))
    wall = (time.perf_counter() - t0) * 1000
    return st, body, wall


def read_table(table):
    st, body = t.service(c, 'files.sheet_read', {'table': table})
    return st, body


# ---------- 准备：一张双列表，两行 ----------

if set(want) & {'fp1', 'fp2'}:
    tbl = create_table('D探针-写路径-%s' % RUN)
    add_columns(tbl, ['文本列', '日期列'])
    rid = add_row(tbl)
    print('准备：表 %s 行 %s' % (tbl, rid))

# ---------- FP-① 文本值走快路径 ----------

if 'fp1' in want:
    print('\n== FP-① 文本值走手术快路径 ==')
    st, body, wall = write_cell(tbl, rid, '文本列', {'type': 'text', 'value': 'D探针文本-%s' % RUN})
    ok_http = st == 200 and body.get('ok')
    timing = (body.get('result') or body).get('timing') or {}
    check('FP-① 文本写入成功', ok_http, 'HTTP %s %s' % (st, {k: v for k, v in body.items() if k != 'result'}))
    check("FP-① timing.fast_path == 'surgery'（走快路径，未整簿重写）",
          timing.get('fast_path') == 'surgery',
          'fast_path=%r timing=%s 墙钟=%.1fms' % (timing.get('fast_path'), timing, wall))

# ---------- FP-② 日期值回落整簿重写 ----------

if 'fp2' in want:
    print('\n== FP-② 日期值回落整簿重写 ==')
    st, body, wall = write_cell(tbl, rid, '日期列', {'type': 'date', 'value': '2026-10-14'})
    ok_http = st == 200 and body.get('ok')
    timing = (body.get('result') or body).get('timing') or {}
    check('FP-② 日期写入成功', ok_http, 'HTTP %s %s' % (st, {k: v for k, v in body.items() if k != 'result'}))
    check("FP-② timing.fast_path == 'skip:value-type'（date 不在快路径白名单，回落）",
          timing.get('fast_path') == 'skip:value-type',
          'fast_path=%r' % timing.get('fast_path'))
    check('FP-② timing 出现 snapshot_before（慢路径整簿快照）',
          'snapshot_before' in timing, 'timing=%s' % timing)
    check('FP-② timing 出现 verify_reopen（慢路径重开整簿验证）',
          'verify_reopen' in timing, 'timing=%s' % timing)

    # FP-④ 反例：在同一份回包上故意翻期望，必须能红
    print('\n== FP-④ 反例（故意翻期望，必须判 FAIL）==')
    wrong = timing.get('fast_path') == 'surgery'
    check('FP-④ 反例自检：把期望翻成「date 也要走快路径」应当判不成立',
          not wrong, '若这条 FAIL，说明 FP-② 的判据恒真，等于没写')

# ---------- FP-③ 三表来回读挤掉解析缓存 ----------

if 'fp3' in want:
    print('\n== FP-③ 解析缓存容量挤换（_PARSE_CACHE_MAX = 2）==')
    tabs = []
    for i in range(3):
        tb = create_table('D探针-缓存%d-%s' % (i, RUN))
        add_columns(tb, ['值列'])
        tabs.append(tb)

    def parse_count(tb):
        st, body = read_table(tb)
        if st != 200 or not body.get('ok'):
            raise SystemExit('读表失败 %s: HTTP %s %s' % (tb, st, body))
        res = body.get('result') or body
        diag = res.get('diagnostics') or {}
        return diag.get('parse_count'), diag.get('cache'), res

    # 对照组：单表连读三次
    p0, cache0, _ = parse_count(tabs[0])
    p1, cache1, _ = parse_count(tabs[0])
    p2, cache2, _ = parse_count(tabs[0])
    print('  单表连读：parse_count %s → %s → %s（cache %s/%s/%s）' % (p0, p1, p2, cache0, cache1, cache2))
    single_growth = (p2 or 0) - (p0 or 0)
    # 对照的本意是「单表连读不重复解析」——三次都命中时增长 0；只有首读恰好冷才 +1。
    # 判据取「至多 1」：既容冷首读，又挡住「每次都在重解析」。
    check('FP-③ 对照：单表连读 parse_count 增长 ≤1（重复读命中缓存，不重复解析）',
          single_growth <= 1, '增长=%s（p0=%s p2=%s）' % (single_growth, p0, p2))

    # 实验组：三表 A→B→C→A→B→C
    before = {}
    for tb in tabs:
        pc, _, _ = parse_count(tb)
        before[tb] = pc
    for tb in tabs + tabs:   # A B C A B C
        parse_count(tb)
    after = {}
    for tb in tabs:
        pc, _, _ = parse_count(tb)
        after[tb] = pc
    growth = {tb: (after[tb] or 0) - (before[tb] or 0) for tb in tabs}
    total = sum(growth.values())
    print('  三表来回：各表 parse_count 增量 %s，合计 %s' % (growth, total))
    check('FP-③ 三表来回读解析次数累计增长 ≥3（容量 2 装不下，互相挤掉）',
          total >= 3, '合计增长=%s（%s）' % (total, growth))

# ---------- 收口 ----------

print()
if checks == 0:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
print('结果： ' + ('FAIL ' + ','.join(fails) if fails else
                  'PASS 写路径探针全部成立（FP-①快路径 / FP-②日期回落整簿重写 / FP-③缓存挤换）'))
sys.exit(1 if fails else 0)
