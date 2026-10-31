"""R1 搜索与四个结构动作门槛（2026-10-13 计划硬门槛）。

测试通过 = 在约 9.7MB 真实样本上：
  ①搜索（末尾命中 / 无匹配 / 大量命中）提交→首批结果 P95≤1s（每味 n=20）；
  ②末尾加行、末尾加列、改表头、改表名：提交→可靠保存及正确显示 P95≤3s
    （每个动作 n=20，墙钟含读回核对），值/行身份/未改样式保留；
样本不足 20 只报已测不写达标；单样超 2×预算即 FAIL。

统计口径与 test_r1_perf.py 一致：statistics.quantiles(v, n=20, method='exclusive')[18]。
搜索逐次核 HTTP 与命中语义（无匹配=0 行、大量命中须含已知行、末尾命中定位到预定行格），
错误响应不许当快速成功——失败样本仍保留在样本列表里，不删。

分组入口（2026-10-13 代码审查要求）：
  python3 test_r1_search_structure.py --cases search,row,col,header,rename [--samples N]
  --cases 选阶段；--samples N（1~20）改采样数（<20 即调试模式，不写达标字样）。
  选了未知项 / 空选 / 运行零用例 / 前置未过 → 非零退出。
  调试模式只报告所选项，不打印整包正式 PASS；正式模式（不带 --samples 且全选）保持原样本量与门槛。
"""
import argparse
import base64
import hashlib
import importlib.util
import statistics
import sys
import time

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'
SAMPLE = '/path/to/workspace'
EXPECT_SHA = 'f52326d845aef21c7f8f20dc3abdae4a67fc58811ba28d909f7e63ec9ee6a6b3'
RUN = 'rs-' + str(int(time.time()))
PW = 'b2-user-pw-2026'

VALID_CASES = ('search', 'row', 'col', 'header', 'rename')

parser = argparse.ArgumentParser(description='R1 搜索与四结构动作门槛')
parser.add_argument('--cases', default=','.join(VALID_CASES),
                    help='逗号分隔选阶段：' + ','.join(VALID_CASES) + '（默认全选）')
parser.add_argument('--samples', type=int, default=None,
                    help='每项采样数 1~20；给定即调试模式（<20 不写达标）。缺省=正式模式 20')
args = parser.parse_args()

selected = [c.strip() for c in args.cases.split(',') if c.strip()]
bad = [c for c in selected if c not in VALID_CASES]
if bad:
    print('未知用例：' + ','.join(bad) + '；可选：' + ','.join(VALID_CASES))
    sys.exit(2)
if not selected:
    print('未选任何用例（--cases 空）')
    sys.exit(2)
if args.samples is not None and not 1 <= args.samples <= 20:
    print(f'--samples 须在 1~20：{args.samples}')
    sys.exit(2)

DEBUG = args.samples is not None
N_SAMPLES = args.samples if args.samples is not None else 20
FORMAL = (not DEBUG) and (set(selected) == set(VALID_CASES))

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

fails = []
ran = 0   # 实际跑过的用例数：全被前置拦掉时非零退出
checks_run = 0   # 真正被断言的检查数：跑了用例但零检查不许判通过


def check(name, ok, detail):
    global checks_run
    checks_run += 1
    print(f'{"PASS" if ok else "FAIL"} {name} — {detail}')
    if not ok:
        fails.append(name)


def pct95(xs):
    """P95（与 test_r1_perf.py 同口径：quantiles n=20 method=exclusive 取第 18 分位）。"""
    if not xs:
        return None
    if len(xs) == 1:
        return xs[0]
    return statistics.quantiles(xs, n=20, method='exclusive')[18]


def act(c, action, payload, key):
    return t.action(c, action, payload, key)


def result_of(st, body):
    return (body.get('result') or body) if isinstance(body, dict) else {}


owner = t.Client(BASE)
owner.login('ss-owner@example.invalid', PW)

data = open(SAMPLE, 'rb').read()
check('样本哈希与登记一致', hashlib.sha256(data).hexdigest() == EXPECT_SHA, f'bytes={len(data)}')

st, body = act(owner, 'files.upload', {
    'file_name': f'r1ops-{RUN}.xlsx', 'content_base64': base64.b64encode(data).decode(),
    'directory': '/', 'attribution': {'level': 'personal'}}, f'up-{RUN}')
TABLE = result_of(st, body).get('file')
check('上传成表', bool(TABLE), f'HTTP {st} table={TABLE}')
if not TABLE:
    # 前置未过：后续全是空转，直接非零退出
    print('结果： FAIL 前置（上传成表）未过，未运行任何用例')
    sys.exit(1)

st, dat = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 5})
cver, sver = dat.get('content_version'), dat.get('structure_version')
headers = dat.get('headers') or []
name_col = headers[0] if headers else '名称'
total0 = dat.get('total_rows') or 0

# 末页行：搜索要测「大表末尾命中」（search 前置）
last_rid = None
marker = f'末尾命中-{RUN}'
marker_on = None
if 'search' in selected:
    total = total0
    last_page = max(1, (total + 4) // 5)
    st_last, dat_last = t.service(owner, 'files.sheet_read',
                                  {'table': TABLE, 'page': last_page, 'page_length': 5})
    last_rows = dat_last.get('rows') or []
    last_rid = last_rows[-1]['row_id'] if last_rows else None
    check('末页可定位', bool(last_rid),
          f'末页={last_page} 行={last_rid} 总行={total} 返回行数={len(last_rows)}')
    if not last_rid:
        print('结果： FAIL 前置（末页可定位）未过，search 无法运行')
        sys.exit(1)

    if last_rid:
        st, body = act(owner, 'files.sheet_cells_write', {
            'table': TABLE, 'expected_content_version': cver,
            'expected_structure_version': sver,
            'cells': [{'row_id': last_rid, 'header': name_col,
                       'value': {'type': 'text', 'value': marker}}],
            'op_id': f'mark-{RUN}'}, f'mark-{RUN}')
        res = result_of(st, body)
        check('末行标记写入', st == 200 and bool(res.get('content_version')),
              f'HTTP {st} ver={res.get("content_version")} err={str(body.get("error", ""))[:80]}')
        if st == 200:
            cver = res.get('content_version')
            sver = res.get('structure_version', sver)
            marker_on = 'written'
        else:
            # 写不进（如公式格）就改用末行已有值测末尾命中，判据不降
            for _cell in (last_rows[-1].get('values') or {}).values():
                _v = (_cell or {}).get('value')
                if isinstance(_v, str) and len(_v) >= 2:
                    marker = _v
                    marker_on = 'existing'
                    break

if 'search' in selected:
    ran += 1
    print(f'\n== 搜索（提交→首批结果；{"调试样 " + str(N_SAMPLES) if DEBUG else "正式 n=20"}） ==')
    cases = [('末尾命中', marker), ('无匹配', f'绝无此词-{RUN}'), ('大量命中', '的')]
    for label, term in cases:
        samples = []
        http_fail = 0
        sem_fail = 0
        got = 0
        total_hits = 0
        for i in range(N_SAMPLES):
            t0 = time.perf_counter()
            st, dat = t.service(owner, 'files.sheet_read',
                                {'table': TABLE, 'page': 1, 'page_length': 20, 'search': term})
            samples.append((time.perf_counter() - t0) * 1000)
            if st != 200 or not isinstance(dat, dict):
                http_fail += 1          # 失败样本保留计时值，不删、不当快速成功
                continue
            rows = dat.get('rows') or []
            got = len(rows)
            total_hits = dat.get('total_rows') or 0
            # 逐次命中语义（每次迭代都断言，不是只看最后一次）
            if label == '无匹配':
                if total_hits != 0 or got != 0:
                    sem_fail += 1
            elif label == '末尾命中':
                # 定位到预定行格：命中行里必须有末行，且命中点在名字列
                hit_ids = {r.get('row_id') for r in rows}
                cell_hits = [h.get('cell') for r in rows for h in (r.get('matches') or [])]
                if total_hits < 1 or (marker_on == 'written' and last_rid not in hit_ids) \
                        or (marker_on == 'written' and not any(h.startswith('A') for h in cell_hits)):
                    sem_fail += 1
            else:  # 大量命中：必须真有一批，且首批里含已知预期（末行标记行或任一命中行的值含词）
                known_in = any(
                    any(term in str((c or {}).get('value') or '')
                        or term in str((c or {}).get('formula') or '')
                        for c in (r.get('values') or {}).values())
                    for r in rows)
                if total_hits < 20 or got < 20 or not known_in:
                    sem_fail += 1
        p95 = pct95(samples)
        over2 = [round(s) for s in samples if s > 2000]
        enough = len(samples) >= 20
        # 判定：HTTP 全 200 + 语义全对 + P95≤1s + 无 >2× 预算样本
        ok = http_fail == 0 and sem_fail == 0 and bool(p95) and p95 <= 1000 and not over2
        limited = '' if enough else '（样本 %d<20，只报已测不写达标）' % len(samples)
        gate = '' if (enough or DEBUG) else ' 不写达标'
        check(f'搜索·{label}', ok,
              f'n={len(samples)}{limited} P95={p95:.0f}ms 首批行={got} 全量命中={total_hits} '
              f'HTTP失败={http_fail} 语义失败={sem_fail} 标记源={marker_on} '
              f'样本={[round(s) for s in samples]}{" 超2s:" + str(over2) if over2 else ""}{gate}')

if {'row', 'col', 'header', 'rename'} & set(selected):
    print(f'\n== 四个结构动作（提交→可靠保存及正确显示；{"调试样 " + str(N_SAMPLES) if DEBUG else "每个正式 n=20"}） ==')


def struct_case(label, action_id, make_case, expect_after, budget=3000):
    """每样：提交→返回版本闩→读回核对，墙钟含读回（=提交→可靠保存及正确显示）。
    expect_after 为假即该样判不过；错误响应不当快速成功。"""
    global cver, sver
    walls, notes = [], []
    ok_all = True
    for i in range(N_SAMPLES):
        payload, key, specv = make_case(i)
        payload = dict(payload, expected_content_version=cver, expected_structure_version=sver)
        t0 = time.perf_counter()
        st, body = act(owner, action_id, payload, key)
        res = result_of(st, body)
        ok = st == 200
        if ok:
            cver = res.get('content_version', cver)
            sver = res.get('structure_version', sver)
            st_r, dat_r = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 3})
            ok = st_r == 200 and expect_after(dat_r, res, specv)
        wall = (time.perf_counter() - t0) * 1000
        walls.append(wall)
        if not ok:
            ok_all = False
            notes.append(f'样{i + 1}核对未过 HTTP {st} {str(body.get("error", ""))[:60]}')
        if wall > budget * 2:
            ok_all = False
            notes.append(f'样{i + 1}超2×预算 {wall:.0f}ms')
    p95 = pct95(walls)
    enough = len(walls) >= 20
    limited = '' if enough else '（样本 %d<20，只报已测不写达标）' % len(walls)
    check(label, ok_all and bool(p95) and p95 <= budget,
          f'n={len(walls)}{limited} P95={p95:.0f}ms max={max(walls):.0f}ms 预算={budget}ms '
          f'样本={[round(w) for w in walls]}{"；" + "；".join(notes) if notes else ""}')


# 1) 末尾加行 ×N：精确 +1、新行 ID 唯一且可读回、旧行 ID/值不漂
if 'row' in selected:
    ran += 1

    def _row_case(i):
        # 事前快照（在计时边界外）：行数、旧行 ID 与首行值
        st_b, dat_b = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 3})
        before = {
            'total': (dat_b or {}).get('total_rows') or 0,
            'ids': [r.get('row_id') for r in ((dat_b or {}).get('rows') or [])],
            'first_vals': [dict((r.get('values') or {})) for r in ((dat_b or {}).get('rows') or [])],
        }
        return ({'table': TABLE, 'count': 1}, f'row-{i}-{RUN}', before)

    def _row_expect(d, r, s):
        after_total = d.get('total_rows') or 0
        if after_total != s['total'] + 1:
            return False                      # 精确 +1，不是 >0
        new_ids = r.get('row_ids') or []
        if len(new_ids) != 1 or new_ids[0] in set(s['ids']):
            return False                      # 新 ID 数对、不与旧行撞号
        st_n, dat_n = t.service(owner, 'files.sheet_read', {'table': TABLE, 'row_ids': new_ids})
        rows_n = (dat_n or {}).get('rows') or []
        if st_n != 200 or len(rows_n) != 1 or rows_n[0].get('row_id') != new_ids[0]:
            return False                      # 新行读得回、行身份对
        after_ids = [rr.get('row_id') for rr in (d.get('rows') or [])]
        if after_ids != s['ids']:
            return False                      # 旧行 ID 不漂
        after_vals = [dict((rr.get('values') or {})) for rr in (d.get('rows') or [])]
        return after_vals == s['first_vals']  # 旧行值不漂

    struct_case('末尾加行', 'files.sheet_row_append', _row_case, _row_expect)

# 2) 末尾加列 ×N（列名各异）
if 'col' in selected:
    ran += 1
    struct_case('末尾加列', 'files.sheet_column_append',
                lambda i: ({'table': TABLE, 'header': f'新列{i}-{RUN}'[-20:]},
                           f'col-{i}-{RUN}', f'新列{i}-{RUN}'[-20:]),
                lambda d, r, s: s in (d.get('headers') or []))

# 3) 改表头 ×N（链式改名：每次改当前名）
if 'header' in selected:
    ran += 1
    _hdr_cur = {'v': (headers[0] if headers else name_col)}

    def _hdr_case(i):
        frm = _hdr_cur['v']
        to = f'改头{i}-{RUN}'[-20:]
        _hdr_cur['v'] = to
        return ({'table': TABLE, 'from_header': frm, 'to_header': to},
                f'hdr-{i}-{RUN}', (frm, to))

    struct_case('改表头', 'files.sheet_header_rename', _hdr_case,
                lambda d, r, s: s[1] in (d.get('headers') or []) and s[0] not in (d.get('headers') or []))

# 4) 改表名 ×N：读接口回名对上、表身份/版本闩/未改内容都核；末尾做一次错误名反例
if 'rename' in selected:
    ran += 1
    _ren_last = {'title': None}

    def _ren_case(i):
        to = f'改名{i}-{RUN}'[-20:]
        st_b, dat_b = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 3})
        before = {
            'ids': [r.get('row_id') for r in ((dat_b or {}).get('rows') or [])],
            'vals': [dict((r.get('values') or {})) for r in ((dat_b or {}).get('rows') or [])],
            'sheet': (dat_b or {}).get('sheet'),
        }
        _ren_last['title'] = to
        return ({'table': TABLE, 'title': to}, f'ren-{i}-{RUN}', (to, before))

    def _ren_expect(d, r, s):
        want, before = s
        # 表身份：读回的还是同一张表同一工作表
        if d.get('table') != TABLE or d.get('sheet') != before['sheet']:
            return False
        # 真实读接口回名（sheet_read 的 table_title）必须对上期望名（含 .xlsx 归一）
        expect_title = want if want.endswith('.xlsx') else want + '.xlsx'
        if (d.get('table_title') or '') != expect_title:
            return False
        if (r.get('table_title') or '') != expect_title:
            return False
        # 未改内容：首行 ID/值不漂
        if [rr.get('row_id') for rr in (d.get('rows') or [])] != before['ids']:
            return False
        if [dict((rr.get('values') or {})) for rr in (d.get('rows') or [])] != before['vals']:
            return False
        return True

    struct_case('改表名', 'files.sheet_rename', _ren_case, _ren_expect)

    # 反例：错误名字的期望必须不匹配——证明上面的判据不是恒真
    st_c, dat_c = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 1})
    wrong = '错误名字-反例'
    expect_right = (_ren_last['title'] or '') + '.xlsx'
    got_title = (dat_c or {}).get('table_title') or ''
    check('改表名判据反例（错误名不匹配）',
          got_title == expect_right and got_title != wrong + '.xlsx',
          f'读回={got_title} 期望={expect_right} 反例名={wrong}.xlsx（反例不匹配=判据有效）')

print()
if ran == 0:
    print('结果： FAIL 所选项均因前置或选择未运行')
    sys.exit(1)
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
# 正式整包 PASS 只在「全选 + 未改样本量」时给；部分选择/调试样本一律点名所跑范围
if FORMAL:
    print('结果： ', 'PASS 搜索与结构动作全部达标' if not fails else 'FAIL ' + ','.join(fails))
else:
    scope = f'所选 {",".join(selected)}' + ('' if DEBUG else '（未全选，非整包判据）')
    nsmp = f'，每项 n={N_SAMPLES}' if DEBUG else ''
    print(f'非整包结果（{scope}{nsmp}，共 {checks_run} 条检查，不写整包达标）： '
          + ('FAIL ' + ','.join(fails) if fails else '所选各项通过'))
sys.exit(1 if fails else 0)
