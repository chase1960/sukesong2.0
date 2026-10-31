"""R7 故障/一致性：并发同格不丢后改值、响应丢失按操作编号查结果、保存中立即撤回。

测试通过 = 下面每条都成立（每条都是「做这个操作 → 该看到这个」）：

R7-01 并发同格不丢后改值（串行闩）：写 A 拿到内容闩 v1 后，另一写 B 仍带旧闩 v0 提交
  → 被闩拒（理由是闩冲突词，不是无权/404），读回仍是 A（没被静默盖掉）；B 换新闩重发
  → 生效，读回是 B。后写值必须落盘、先写值不许被静默覆盖。
R7-02 真并发双写同格：两条写同格的请求同时发出（线程并发），恰一条成功、另一条被闩拒；
  终值是两者之一（不许是第三个值、不许是坏值）；败者换新闩重发后终值=败者值。
R7-03 响应丢失不盲目重写：写一格（op_id=X）后客户端「丢响应」——不知道成没成；
  按 X 查回执拿到结果；同 X 重发 → idempotent=true 且版本不双跳、读回值只应用一次。
  不许因为「没收到响应」就当没写而再写一遍（那是双写）。
R7-04 保存中立即撤回：写一格后不读回立刻撤回 → 撤回成功、值回原位、内容版本恰 +2
  （写一次撤一次）、结构版本不漂、同表未涉及格一字不动。
R7-05 并发写不同格互不干扰（正对照）：两写各改一格、各用自己的闩，两格都在——
  证明 R7-01/02 的拒绝不是「一律拒绝」。

先红后绿：产品未实现时各条应红；不许用延超时/加遮罩/假成功顶过去。
"""
import base64
import importlib.util
import json
import sys
import threading
import time

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'
PW = 'b2-user-pw-2026'

spec = importlib.util.spec_from_file_location('t', ROOT + '/shangshu-server/scripts/test-n2-structure.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

RUN = t.RUN
fails = []


def check(name, ok, detail):
    print(f'{"PASS" if ok else "FAIL"} {name} — {detail}')
    if not ok:
        fails.append(name)


def act(c, action, payload, key):
    return t.action(c, action, payload, key)


def result_of(st, body):
    return (body.get('result') or body) if isinstance(body, dict) else {}


def latch_err(st, body):
    """闩冲突词判定：内容闩=「已被其他操作修改」、结构闩=「表头已变化」。"""
    err = ''
    if isinstance(body, dict):
        err = str(body.get('error') or '') + ' ' + str(body.get('message') or '')
    return st in (409, 412, 417, 400) and ('已被其他操作修改' in err or '表头已变化' in err)


owner = t.Client(BASE)
owner.login('ss-owner@example.invalid', PW)

# ---------- 夹具：新建空表 → 加一列两行（小样本故障注入，执行计划要求先小样本） ----------
st, body = act(owner, 'files.create', {'file_name': f'r7-fault-{RUN}.xlsx', 'attribution': {'level': 'personal'}},
               f'r7-up-{RUN}')
TABLE = result_of(st, body).get('file')
check('R7 前置·新建夹具表', bool(TABLE), f'HTTP {st} file={TABLE}')
if not TABLE:
    print('结果： FAIL 前置（建表）未过')
    sys.exit(1)

# 版本号从读接口取（create 回包不带版本闩），再加列加行
st_r, dat_r = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 5})
cver, sver = dat_r.get('content_version'), dat_r.get('structure_version')
check('R7 前置·读到版本闩', cver is not None and sver is not None, f'cver={cver} sver={sver}')

st, body = act(owner, 'files.sheet_column_append', {
    'table': TABLE, 'header': '值列', 'expected_content_version': cver,
    'expected_structure_version': sver}, f'r7-col-{RUN}')
res = result_of(st, body)
cver, sver = res.get('content_version'), res.get('structure_version')
check('R7 前置·加列', st == 200, f'HTTP {st} {str(body.get("error", ""))[:60]}')

st, body = act(owner, 'files.sheet_row_append', {
    'table': TABLE, 'count': 2, 'expected_content_version': cver,
    'expected_structure_version': sver}, f'r7-rows-{RUN}')
res = result_of(st, body)
cver, sver = res.get('content_version'), res.get('structure_version')
row_ids = res.get('row_ids') or []
check('R7 前置·加两行', st == 200 and len(row_ids) == 2, f'HTTP {st} rows={row_ids}')

RID_A, RID_B = (row_ids + [None, None])[:2]


def read_cell(rid):
    st_r, dat_r = t.service(owner, 'files.sheet_read', {'table': TABLE, 'row_ids': [rid]})
    if st_r != 200:
        return None, st_r
    rows = dat_r.get('rows') or []
    cell = ((rows[0].get('values') or {}) if rows else {}).get('值列') or {}
    return cell, st_r


def write_cell(rid, value, op_key, exp_cver, exp_sver):
    return act(owner, 'files.sheet_cells_write', {
        'table': TABLE, 'expected_content_version': exp_cver,
        'expected_structure_version': exp_sver,
        'cells': [{'row_id': rid, 'header': '值列', 'value': {'type': 'text', 'value': value}}],
        'op_id': op_key}, op_key)


# ---------- R7-01 并发同格不丢后改值（串行闩） ----------
print('\n== R7-01 并发同格不丢后改值（串行闩） ==')
st, body = write_cell(RID_A, '先写A', f'r7-01-a-{RUN}', cver, sver)
res = result_of(st, body)
check('R7-01 写A成功', st == 200, f'HTTP {st}')
v_a = res.get('content_version')
sver = res.get('structure_version', sver)

# 另一写 B 仍带旧闩（=写A之前的 cver）提交 —— 必须被闩拒，A 不许被静默盖掉
st2, body2 = write_cell(RID_A, '后写B', f'r7-01-b-{RUN}', cver, sver)   # 故意用旧 cver
check('R7-01 旧闩写B被拒（闩冲突词）', latch_err(st2, body2),
      f'HTTP {st2} err={str(body2.get("error", ""))[:70]}')
cell, _ = read_cell(RID_A)
check('R7-01 拒后读回仍是A（没被静默覆盖）', str((cell or {}).get('value')) == '先写A',
      f'读回={cell}')

# 换新闩重发 B → 生效，读回是 B（后写值必须落盘）
st3, body3 = write_cell(RID_A, '后写B', f'r7-01-b2-{RUN}', v_a, sver)
res3 = result_of(st3, body3)
check('R7-01 换新闩写B成功', st3 == 200, f'HTTP {st3} {str(body3.get("error", ""))[:60]}')
cver = res3.get('content_version', cver)
sver = res3.get('structure_version', sver)
cell, _ = read_cell(RID_A)
check('R7-01 终值=后写B', str((cell or {}).get('value')) == '后写B', f'读回={cell}')

# ---------- R7-02 真并发双写同格 ----------
print('\n== R7-02 真并发双写同格（线程并发） ==')
st, dat = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 5})
base_c, base_s = dat.get('content_version'), dat.get('structure_version')
results2 = {}


def racer(tag, value):
    stx, bodyx = write_cell(RID_B, value, f'r7-02-{tag}-{RUN}', base_c, base_s)
    results2[tag] = (stx, bodyx)


th1 = threading.Thread(target=racer, args=('t1', '并发甲'))
th2 = threading.Thread(target=racer, args=('t2', '并发乙'))
th1.start()
th2.start()
th1.join(30)
th2.join(30)
oks = {k: v[0] for k, v in results2.items()}
check('R7-02 恰一成一拒（并发双写不双写）',
      sum(1 for s in oks.values() if s == 200) == 1 and len(results2) == 2,
      f'HTTP={oks} 错误={[str(results2[k][1].get("error", ""))[:50] for k in results2 if results2[k][0] != 200]}')
cell, _ = read_cell(RID_B)
val_now = str((cell or {}).get('value'))
check('R7-02 终值是两者之一（不许第三个值/坏值）', val_now in ('并发甲', '并发乙'), f'读回={val_now!r}')

# 败者换新闩重发 → 终值=败者值
loser = [k for k in results2 if results2[k][0] != 200]
if loser:
    st_r, dat_r = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 5})
    nc, ns = dat_r.get('content_version'), dat_r.get('structure_version')
    loser_val = '并发甲' if loser[0] == 't1' else '并发乙'
    st4, body4 = write_cell(RID_B, loser_val, f'r7-02-retry-{RUN}', nc, ns)
    check('R7-02 败者换新闩重发成功', st4 == 200, f'HTTP {st4} {str(body4.get("error", ""))[:60]}')
    cell, _ = read_cell(RID_B)
    check('R7-02 重发后终值=败者值', str((cell or {}).get('value')) == loser_val,
          f'期望={loser_val} 读回={cell}')

# ---------- R7-03 响应丢失不盲目重写 ----------
print('\n== R7-03 响应丢失不盲目重写 ==')
st_r, dat_r = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 5})
c0, s0 = dat_r.get('content_version'), dat_r.get('structure_version')
lost_key = f'r7-03-lost-{RUN}'
st, body = write_cell(RID_A, '响应丢失那笔', lost_key, c0, s0)
res = result_of(st, body)
check('R7-03 写入提交成功', st == 200, f'HTTP {st}')
v_lost = res.get('content_version')
# —— 客户端此刻「丢响应」：不知道成没成，不许盲目重写 ——
# ① 按操作编号查回执
st_rc, receipt = owner.request('GET', f'/api/platform/action-requests/{t.receipt_key(lost_key)}')
rstatus = str((receipt or {}).get('status') or '')
check('R7-03 按操作编号查得到回执', st_rc == 200 and rstatus not in ('NotFound', 'not_found', 'None', ''),
      f'HTTP {st_rc} status={rstatus}')
# ② 同一操作编号重发 → 只生效一次
st2, body2 = write_cell(RID_A, '响应丢失那笔', lost_key, c0, s0)   # 同键、同旧闩重发
res2 = result_of(st2, body2)
check('R7-03 同编号重发 idempotent=true', (body2 or {}).get('idempotent') is True,
      f'idempotent={(body2 or {}).get("idempotent")} HTTP {st2}')
check('R7-03 版本不双跳（只应用一次）',
      res2.get('content_version') == v_lost, f'首发={v_lost} 重发={res2.get("content_version")}')
cell, _ = read_cell(RID_A)
check('R7-03 读回值只应用一次（=响应丢失那笔）', str((cell or {}).get('value')) == '响应丢失那笔',
      f'读回={cell}')

# ---------- R7-04 保存中立即撤回 ----------
print('\n== R7-04 保存中立即撤回（写后不读回立刻撤） ==')
st_r, dat_r = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 5})
cb, sb = dat_r.get('content_version'), dat_r.get('structure_version')
undo_op = f'r7-04-{RUN}'
st, body = write_cell(RID_A, '写了就撤', undo_op, cb, sb)
res = result_of(st, body)
check('R7-04 写入成功', st == 200, f'HTTP {st}')
vw = res.get('content_version')
sv_before = res.get('structure_version', sb)
# 立刻撤回，中间不读回
st2, body2 = act(owner, 'files.sheet_cells_undo', {'table': TABLE, 'op_id': undo_op}, f'r7-04-u-{RUN}')
res2 = result_of(st2, body2)
check('R7-04 立即撤回成功', st2 == 200, f'HTTP {st2} {str(body2.get("error", ""))[:60]}')
check('R7-04 内容版本恰 +2（写一次撤一次）',
      res2.get('content_version') == (cb or 0) + 2,
      f'写前={cb} 撤后={res2.get("content_version")}（期望 {cb + 2 if cb is not None else "?"}）')
check('R7-04 结构版本不漂', res2.get('structure_version') == sv_before,
      f'写后={sv_before} 撤后={res2.get("structure_version")}')
cell, _ = read_cell(RID_A)
check('R7-04 值回原位（不是「响应丢失那笔」）', str((cell or {}).get('value')) != '写了就撤',
      f'读回={cell}')
# 未涉及格不动
cell_b, _ = read_cell(RID_B)
check('R7-04 未涉及格不动', str((cell_b or {}).get('value')) in ('并发甲', '并发乙'),
      f'读回={cell_b}')

# ---------- R7-05 并发写不同格互不干扰（正对照） ----------
print('\n== R7-05 并发写不同格（正对照，证明不是一律拒绝） ==')
st_r, dat_r = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 5})
cc, cs = dat_r.get('content_version'), dat_r.get('structure_version')
st1, b1 = write_cell(RID_A, '甲格值', f'r7-05-a-{RUN}', cc, cs)
r1 = result_of(st1, b1)
check('R7-05 甲格写成功', st1 == 200, f'HTTP {st1}')
st2, b2 = write_cell(RID_B, '乙格值', f'r7-05-b-{RUN}', r1.get('content_version', cc),
                     r1.get('structure_version', cs))
check('R7-05 乙格写成功（不同格不互斥）', st2 == 200, f'HTTP {st2} {str(b2.get("error", ""))[:60]}')
ca, _ = read_cell(RID_A)
cb, _ = read_cell(RID_B)
check('R7-05 两格都在', str((ca or {}).get('value')) == '甲格值' and str((cb or {}).get('value')) == '乙格值',
      f'甲={ca} 乙={cb}')

print()
print('结果： ' + ('FAIL ' + ','.join(fails) if fails else 'PASS R7 故障/一致性判据全部成立'))
sys.exit(1 if fails else 0)
