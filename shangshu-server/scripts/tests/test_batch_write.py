"""B4 一次范围写入（批量 Action，下一批 §5 B4 + 用户「批量写不能部分生效」）。

测试通过 = 下面六件全部成立（每条都是「做这个操作 → 该看到这个」）：

B4-01 一请求 N 格全成：一个幂等键把跨 ≥2 行的 N 格一次请求写入，回包 applied=N、
  content_version **恰 +1**（不是 +N——这是一次落盘的唯一硬指标，20,000 格也没有
  20,000 次落盘）、structure_version 不漂；sheet_read 逐格读回新值、同批未涉及的格
  一字不动；files.versions 只多 1 条；写后首读命中预热（D4：cache=hit——保存时把
  验证门重开的那份簿的解析结果焐进新版本缓存键，大表写完立刻打开不吃冷解析）。
B4-02 中间一格坏则全不成：坏格放中间/倒数第二（绝不放第一个），整批被拒且理由含
  坏格坐标与原因词；批量前后全 N 格快照逐格比对——**包括坏格之前那些「本该已写」的格**
  ——一格都不许变；content_version / structure_version / 版本条数三项都不动。
  三种坏因各一遍：类型不符、公式格、行不存在。
B4-03 版本闩冲突整批拒：expected_content_version 不符整批拒，理由是闩冲突词
  （内容闩=「已被其他操作修改」、结构闩=「表头已变化」；不是无权、不是 404），
  格值与两版本不动；换新闩重发同一内容立刻成功（正对照，防「一律拒绝」假绿）。
B4-04 幂等重试不双写：同 idempotency_key 连发两次同一批，第二次 idempotent=true 且
  content_version 不双跳、读回值只应用一次；坏批的回执能查到 failure_reason。
B4-05 无权整批拒：有权者（上传人）整批成（正对照）；只读/无权身份整批 denied()
  （只认 403 / PERMISSION_DENIED / 无权——417 校验错、404 动作缺失都不算被拒，
  否则反例假绿在「参数没写对」上）且一格没写、版本不漂。
B4-06 越界/重复整批拒且不留半点值：重复 (row_id, header) 拒、未知表头拒（不扩列）、
  不存在的 row_id 拒（不扩行）——每种都核格值与版本不动。

接口契约（实现照此，改要同步改这份）：
  files.sheet_cells_write {
    table, sheet?, expected_content_version, expected_structure_version,
    cells: [{row_id, header, value: {type, value}}],   # 1..20000
    op_id?  # 原操作编号（B5 撤回定位用）
  } → result {
    table, sheet, op_id, applied, content_version, structure_version,
    cells: [{row_id, header, before: {type, value}, after: {type, value}}]  # 快照=B5 输入
  }
  - 一次请求 = 一次落盘 = content_version 恰 +1 = 撤回一步；不许循环调单格冒充批量
  - 先校验全部目标、再统一保存；一格无权/非法 → 整批零生效
  - 定位一律 row_id + 表头名（+ 双版本闩），不接受视觉行列号

先红后绿：本文件先于实现写好，files.sheet_cells_write 尚不存在时应按预期报
「动作不存在」类失败（denied()/rejected() 判据故意不认 404——红要红得诚实）。
"""
import base64
import importlib.util
import json
import sys
from io import BytesIO

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

RUN = t.RUN
fails = []


def build_plain():
    """干净夹具（无外链/批注）：外链固化、批注提取是文档化的打开期副作用，
    会改「未涉及格」——B4-01 的「未涉及格一字不动」判据必须在干净簿上才严格成立。"""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws.append(['名称', '数值', '备注'])
    ws.append(['甲', 1, 'a'])
    ws.append(['乙', 2, None])
    ws.append(['丙', 3, 'c'])
    ws['C4'] = '=B4*2'  # 丙行备注=公式格（B4-02 反例用；数据第 3 行 = ROWS[2]）
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def check(name, ok, detail):
    print(f'{"PASS" if ok else "FAIL"} {name} — {detail}')
    if not ok:
        fails.append(name)


def act(c, action, payload, key):
    try:
        st, body = t.action(c, action, payload, key)
    except Exception as e:
        return None, f'调用异常:{e}'
    return (st, body), ('ok' if st == 200 else f'HTTP {st} {json.dumps(body, ensure_ascii=False)[:140]}')


def result_of(res):
    if not res:
        return {}
    body = res[1] if isinstance(res[1], dict) else {}
    return body.get('result') or body


def denied(res):
    """只认权限类拒绝（403 / PERMISSION_DENIED / 无权）。"""
    if not res:
        return False
    st, body = res
    body = body if isinstance(body, dict) else {}
    code = body.get('code', '')
    err = str(body.get('error', ''))
    if st == 403 or code == 'PERMISSION_DENIED':
        return True
    return '无权' in err or 'not permitted' in err.lower() or 'permission' in err.lower()


def rejected(res, word):
    """业务规则类拒绝：被拒且理由里有这个词（404 动作缺失不算——防假绿）。"""
    if not res:
        return False
    st, body = res
    body = body if isinstance(body, dict) else {}
    err = f"{body.get('error', '')} {body.get('message', '')}"
    return st != 200 and word in err


# ---------- 账号 ----------
PW = 'b2-user-pw-2026'
ENV = ('/path/to/workspace'
       'ops/docker/.state/environments/shangshu-local-b.env')
_admin_pw = ''
for _line in open(ENV):
    if _line.startswith('ADMIN_PASSWORD='):
        _admin_pw = _line.split('=', 1)[1].strip().strip('"').strip("'")
        break
assert _admin_pw, f'环境文件里没有 ADMIN_PASSWORD：{ENV}'

adm = t.Client(BASE)
adm.login('Administrator', _admin_pw)
owner = t.Client(BASE)
owner.login('ss-owner@example.invalid', PW)     # 上传/编辑人（有权）
reader = t.Client(BASE)
reader.login('ss-reader@example.invalid', PW)   # 无共享的第二身份
outsider = t.Client(BASE)
outsider.login('ss-outsider@example.invalid', PW)

# ---------- 建表（上传人=ss-owner，有权正对照用） ----------
print('== 建表 ==')
payload = {
    'file_name': f'b4-批量表-{RUN}.xlsx',
    'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/',
}
res, why = act(owner, 'files.upload', payload, f'b4-up-{RUN}')
TABLE = result_of(res).get('file')
check('上传批量样本表', bool(TABLE), why[:120])


def snap(tid=None):
    """整表快照：{header: value} per row_id + 两版本。"""
    st, dat = t.service(owner, 'files.sheet_read', {'table': tid or TABLE, 'page': 1, 'page_length': 100})
    if st != 200 or not isinstance(dat, dict):
        return None
    cells = {}
    for row in dat.get('rows') or []:
        for header, typed in (row.get('values') or {}).items():
            cells[(row.get('row_id'), header)] = json.dumps(typed, sort_keys=True, ensure_ascii=False)
    return {'cells': cells, 'content_version': dat.get('content_version'),
            'structure_version': dat.get('structure_version'), 'rows': dat.get('rows'),
            'headers': dat.get('headers'), 'diagnostics': dat.get('diagnostics') or {}}


S0 = snap()
check('读回样本表', bool(S0), 'sheet_read 失败' if not S0 else f"行数={len(S0['rows'] or [])} 列={S0['headers']}")
HEADERS = (S0 or {}).get('headers') or []
ROWS = (S0 or {}).get('rows') or []
# 该夹具列：名称(文本) / 引用值 / 备注；行 4 条（甲乙丙丁）。运行时取真实 row_id。
NAME_COL = '名称' if '名称' in HEADERS else HEADERS[0]
r_ids = [r.get('row_id') for r in ROWS]


def cell(row_id, header, val, typ='text'):
    return {'row_id': row_id, 'header': header, 'value': {'type': typ, 'value': val}}


def batch(cells, cver, sver, key, op_id=None, table=None):
    p = {'table': table or TABLE, 'expected_content_version': cver,
         'expected_structure_version': sver, 'cells': cells}
    if op_id:
        p['op_id'] = op_id
    return act(owner, 'files.sheet_cells_write', p, key)


# ---------- B4-01 一请求 N 格全成 ----------
print('\n== B4-01 一请求 N 格全成（版本恰 +1）==')
if len(r_ids) >= 3:
    n = 3
    cells = [cell(r_ids[i], NAME_COL, f'批量甲{i}') for i in range(n)]
    before = S0
    res, why = batch(cells, before['content_version'], before['structure_version'],
                     f'b4-01-{RUN}', op_id=f'op-b4-01-{RUN}')
    r = result_of(res)
    ok_http = bool(res) and res[0] == 200
    check('B4-01 一请求 N 格 HTTP 全成', ok_http, why[:140])
    check('B4-01 applied=N', r.get('applied') == n, f"applied={r.get('applied')} 期望={n}")
    check('B4-01 content_version 恰 +1（一次落盘，不是 N 次）',
          r.get('content_version') == (before['content_version'] or 0) + 1,
          f"before={before['content_version']} after={r.get('content_version')}")
    check('B4-01 structure_version 不漂',
          r.get('structure_version') == before['structure_version'],
          f"before={before['structure_version']} after={r.get('structure_version')}")
    check('B4-01 逐格回执恰 N 条', len(r.get('cells') or []) == n, f"回执={len(r.get('cells') or [])}")
    after = snap()
    vals_ok = all(after['cells'].get((cells[i]['row_id'], NAME_COL)) ==
                  json.dumps({'type': 'text', 'value': f'批量甲{i}'}, sort_keys=True, ensure_ascii=False)
                  for i in range(n)) if after else False
    check('B4-01 读回逐格新值生效', vals_ok, 'sheet_read 比对')
    # 未涉及的格一字不动
    untouched = True
    for key_id, old in (before['cells'] or {}).items():
        if key_id in {(c['row_id'], c['header']) for c in cells}:
            continue
        if after['cells'].get(key_id) != old:
            untouched = False
            break
    check('B4-01 同批未涉及的格一字不动', untouched and bool(after), '全表快照比对')
    check('B4-01 写后首读命中预热（D4）',
          (after or {}).get('diagnostics', {}).get('cache') == 'hit',
          f"cache={(after or {}).get('diagnostics', {}).get('cache')}")
    st_v, dat_v = t.service(owner, 'files.versions', {'file': TABLE})
    n_versions = len(dat_v.get('versions') or []) if isinstance(dat_v, dict) else -1
    check('B4-01 版本只多 1 条（= 一次落盘）', n_versions == 2,
          f'版本条数={n_versions}（上传 1 条 + 批量 1 条）')
else:
    check('B4-01 夹具行数不足', False, f'行数={len(r_ids)}')

# ---------- B4-02 中间一格坏则全不成 ----------
print('\n== B4-02 中间一格坏 → 全批零生效 ==')
S_before = snap()
cv, sv = S_before['content_version'], S_before['structure_version']
st_v0, dat_v0 = t.service(owner, 'files.versions', {'file': TABLE})
N_VER0 = len(dat_v0.get('versions') or []) if isinstance(dat_v0, dict) else -1


def bad_case(name, cells, word):
    res, why = batch(cells, cv, sv, f'b4-02-{name}-{RUN}')
    ok_rej = rejected(res, word)
    s2 = snap()
    no_drift = (s2 and s2['content_version'] == cv and s2['structure_version'] == sv
                and s2['cells'] == S_before['cells'])
    st_v, dat_v = t.service(owner, 'files.versions', {'file': TABLE})
    n_versions = len(dat_v.get('versions') or []) if isinstance(dat_v, dict) else -1
    check(f'B4-02 {name}整批被拒（理由含「{word}」）', ok_rej, why[:140])
    check(f'B4-02 {name}全 N 格一格未变 + 版本不漂 + 无新版本条', no_drift and n_versions == N_VER0,
          f"快照={no_drift} 版本条={n_versions}（批前 {N_VER0}）")


if len(r_ids) >= 3:
    # 坏格放中间：第 1 格合法（本该已写）、第 2 格坏、第 3 格合法
    good1 = cell(r_ids[0], NAME_COL, '不应写入一')
    good2 = cell(r_ids[2], NAME_COL, '不应写入三')
    # 坏因 1：类型不符——数字写进「名称」文本列
    bad_case('类型不符', [good1, cell(r_ids[1], NAME_COL, 123, 'number'), good2], '类型')
    # 坏因 2：公式格——写「备注」列里带公式的行（夹具第 3 行 C 列是 =B3*2）
    formula_row = ROWS[2] if len(ROWS) > 2 else None
    remark_col = '备注' if '备注' in HEADERS else (HEADERS[-1] if HEADERS else NAME_COL)
    if formula_row:
        bad_case('公式格', [good1, cell(formula_row['row_id'], remark_col, '改公式'), good2], '公式')
    # 坏因 3：行不存在（越界，不扩行）
    bad_case('行不存在', [good1, cell('r-不存在-' + RUN, NAME_COL, '幽灵'), good2], '行不存在')

# ---------- B4-03 版本闩冲突整批拒 + 新闩正对照 ----------
print('\n== B4-03 版本闩冲突整批拒 ==')
if r_ids:
    cells = [cell(r_ids[0], NAME_COL, '闩测')]
    res, why = batch(cells, (cv or 0) + 1, sv, f'b4-03-{RUN}')
    check('B4-03 内容闩不符整批拒（理由=已被其他操作修改）', rejected(res, '已被其他操作修改'), why[:140])
    s2 = snap()
    check('B4-03 拒后值与版本不动', bool(s2) and s2['cells'] == S_before['cells']
          and s2['content_version'] == cv, '')
    res, why = batch(cells, cv, (sv or 1) + 1, f'b4-03b-{RUN}')
    check('B4-03 结构闩不符整批拒（理由=表头已变化）', rejected(res, '表头已变化'), why[:140])
    # 正对照：换新闩重发立刻成功（防「一律拒绝」假绿）
    s3 = snap()
    res, why = batch(cells, s3['content_version'], s3['structure_version'], f'b4-03-ok-{RUN}')
    check('B4-03 正对照：新闩重发成功', bool(res) and res[0] == 200, why[:140])
    snap_fresh = snap()
    check('B4-03 正对照：值真的写进去了',
          bool(snap_fresh) and snap_fresh['cells'].get((r_ids[0], NAME_COL)) ==
          json.dumps({'type': 'text', 'value': '闩测'}, sort_keys=True, ensure_ascii=False), '')

# ---------- B4-04 幂等重试不双写 ----------
print('\n== B4-04 幂等重试不双写 ==')
if len(r_ids) >= 2:
    sA = snap()
    cells = [cell(r_ids[0], NAME_COL, '幂等甲'), cell(r_ids[1], NAME_COL, '幂等乙')]
    key = f'b4-04-{RUN}'
    res1, why1 = batch(cells, sA['content_version'], sA['structure_version'], key)
    r1 = result_of(res1)
    sB = snap()
    res2, why2 = batch(cells, sA['content_version'], sA['structure_version'], key)  # 同键同内容重放
    r2 = result_of(res2)
    idem_flag = r2.get('idempotent') is True or (bool(res2) and res2[0] == 200 and r2.get('content_version') == r1.get('content_version'))
    check('B4-04 同键重放成功且不双写', bool(res1) and res1[0] == 200 and bool(res2) and res2[0] == 200
          and r2.get('content_version') == r1.get('content_version'),
          f"一次={r1.get('content_version')} 二次={r2.get('content_version')} idempotent={r2.get('idempotent')}")
    sC = snap()
    check('B4-04 读回值只应用一次', bool(sC) and sC['cells'] == sB['cells'], '两次快照比对')
    # 坏批回执可查 failure_reason
    res_bad, _ = batch([cell(r_ids[0], NAME_COL, 999, 'number')], sC['content_version'],
                       sC['structure_version'], f'b4-04-bad-{RUN}')
    st_rq2, dat_rq2 = owner.request('GET', f'/api/platform/action-requests/{t.receipt_key("b4-04-bad-%s" % RUN)}')
    rq2 = dat_rq2 if isinstance(dat_rq2, dict) else {}
    body2 = rq2.get('result') or rq2
    ok_fail_reason = (st_rq2 == 200 and (body2.get('status') in ('Failed', 'failed')
                                         or body2.get('failure_reason')))
    check('B4-04 坏批回执可查 failure_reason', ok_fail_reason,
          f'HTTP {st_rq2} {json.dumps(body2, ensure_ascii=False)[:140]}')

# ---------- B4-05 无权整批拒 ----------
print('\n== B4-05 无权/只读整批拒 ==')
sP = snap()
cells = [cell(r_ids[0], NAME_COL, '无权写入')]


def other_batch(c, key):
    p = {'table': TABLE, 'expected_content_version': sP['content_version'],
         'expected_structure_version': sP['structure_version'], 'cells': cells}
    return act(c, 'files.sheet_cells_write', p, key)


res, why = other_batch(reader, f'b4-05-reader-{RUN}')
check('B4-05 只读身份整批 denied', denied(res), why[:140])
res, why = other_batch(outsider, f'b4-05-outsider-{RUN}')
check('B4-05 无权身份整批 denied', denied(res), why[:140])
s2 = snap()
check('B4-05 拒后一格没写、版本不漂', bool(s2) and s2['cells'] == sP['cells']
      and s2['content_version'] == sP['content_version'], '')
# 正对照：有权者（上传人）同一批成功（防「一律拒绝」假绿）
res, why = other_batch(owner, f'b4-05-owner-{RUN}')
check('B4-05 正对照：有权者同批成功', bool(res) and res[0] == 200, why[:140])

# ---------- B4-06 越界/重复整批拒 ----------
print('\n== B4-06 越界/重复整批拒且不留半点值 ==')
sQ = snap()
cv2, sv2 = sQ['content_version'], sQ['structure_version']


def reject_case(name, cells, word, key):
    res, why = batch(cells, cv2, sv2, key)
    s2 = snap()
    check(f'B4-06 {name}整批拒（理由含「{word}」）', rejected(res, word), why[:140])
    check(f'B4-06 {name}拒后值与版本不动', bool(s2) and s2['cells'] == sQ['cells']
          and s2['content_version'] == cv2, '')


if r_ids:
    reject_case('重复目标', [cell(r_ids[0], NAME_COL, '甲'), cell(r_ids[0], NAME_COL, '乙')], '重复', f'b4-06-dup-{RUN}')
    reject_case('未知表头', [cell(r_ids[0], '没有这一列', 'x')], '表头', f'b4-06-hdr-{RUN}')
    reject_case('不存在的行', [cell('r-无-' + RUN, NAME_COL, 'x')], '行不存在', f'b4-06-row-{RUN}')

# ---------- B4-07 公式是值形状，可落进文本列 ----------
print('\n== B4-07 公式写进文本列（2026-10-17 A 实测口径）==')
sF = snap()
if r_ids and sF:
    res, why = batch([{'row_id': r_ids[0], 'header': NAME_COL,
                       'value': {'type': 'formula', 'formula': '=SUM(B1:B2)', 'value': None}}],
                     sF['content_version'], sF['structure_version'],
                     f'b4-07-f-{RUN}', op_id=f'b4-07-f-{RUN}')
    check('B4-07 公式写进文本列被接受（不再报「须为文本」）',
          bool(res) and res[0] == 200, why[:140])
    sF2 = snap()
    got = None
    for row in (sF2 or {}).get('rows') or []:
        if row.get('row_id') == r_ids[0]:
            got = (row.get('values') or {}).get(NAME_COL)
    check('B4-07 读回是公式（type=formula，不是文本 "=SUM…"）',
          (got or {}).get('type') == 'formula' and 'SUM' in str((got or {}).get('formula') or ''),
          '读回=%r' % (got,))
    if sF2 and len(r_ids) >= 2:
        # ⚠️ **不能拿刚才写成公式的那格再试** —— 产品有「公式格不支持直接修改」的既有规则，
        # 会先撞那条，验不出「空公式」这条。换另一格。
        res2, why2 = batch([{'row_id': r_ids[1], 'header': NAME_COL,
                             'value': {'type': 'formula', 'formula': '   ', 'value': None}}],
                           sF2['content_version'], sF2['structure_version'],
                           f'b4-07-empty-{RUN}')
        check('B4-07 空公式明确拒（不是静默写成空值）',
              rejected(res2, '空公式'), why2[:140])

# ---------- B4-08 写空值（自闭合 <c/>）不得被校验误杀 ----------
print('\n== B4-08 写空值：清空一格要真的落盘（A 2026-10-17 实测 417 回滚）==')
sE = snap()
# ⚠️ 不能拿 B4-07 写成公式的那一格再清 —— 产品有「公式格不支持直接修改」的既有规则。
# 用另一列（备注优先），与公式判据隔离。
EMPTY_COL = '备注' if '备注' in HEADERS else HEADERS[-1]
if sE and r_ids:
    st_e, why_e = batch([{'row_id': r_ids[0], 'header': EMPTY_COL,
                          'value': {'type': 'empty', 'value': None}}],
                        sE['content_version'], sE['structure_version'],
                        f'b4-08-empty-{RUN}', op_id=f'b4-08-empty-{RUN}')
    check('B4-08 type=empty 写空值 → 200（不再「目标值不符」）',
          bool(st_e) and st_e[0] == 200, why_e[:160])
    sE2 = snap()
    got_e = None
    for row in (sE2 or {}).get('rows') or []:
        if row.get('row_id') == r_ids[0]:
            got_e = (row.get('values') or {}).get(EMPTY_COL)
    check('B4-08 读回是 empty（原值真的清掉）',
          (got_e or {}).get('type') == 'empty', '读回=%r' % (got_e,))
    # 文本空串：与 empty 等价，同样要落盘
    if sE2 and len(r_ids) >= 2:
        st_t, why_t = batch([{'row_id': r_ids[1], 'header': EMPTY_COL,
                              'value': {'type': 'text', 'value': ''}}],
                            sE2['content_version'], sE2['structure_version'],
                            f'b4-08-textempty-{RUN}', op_id=f'b4-08-textempty-{RUN}')
        check('B4-08 type=text 空串写空值 → 200', bool(st_t) and st_t[0] == 200, why_t[:160])
        sE3 = snap()
        got_t = None
        for row in (sE3 or {}).get('rows') or []:
            if row.get('row_id') == r_ids[1]:
                got_t = (row.get('values') or {}).get(EMPTY_COL)
        check('B4-08 文本空串读回 empty', (got_t or {}).get('type') == 'empty', '读回=%r' % (got_t,))

print()
if fails:
    print(f'结果： FAIL {len(fails)} 项未过')
    print('未过清单：', json.dumps(fails, ensure_ascii=False))
    sys.exit(1)
print('结果： PASS 批量写判据全部成立（B4-01～B4-08）')
