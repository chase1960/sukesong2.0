"""B5 受管撤回（服务端核验的逐格撤回；不整文件覆盖别人的编辑）。

测试通过 = 下面七件全部成立（每条都是「做这个操作 → 该看到这个」）：

B5-01 撤回恢复原值：批量写 3 格（带 op_id）后按 op_id 撤回 → 3 格回到原值、
  content_version 恰 +1（撤回一步=一次落盘）、structure_version 不漂、同表未涉及
  格一字不动、回包 applied=3 且逐格 before/after 是「撤回前现值 → 回退到的原值」。
B5-02 不覆盖后来的编辑：同上写 A→B；另一身份（有编辑共享）把其中一格改成 C；
  撤回 → 仍是 B 的格回到 A，改成 C 的格**保持 C**且回包 skipped 报「已被修改」；
  未涉及格不动、版本只 +1。整文件回滚会把 C 拉回 A——这是「不整文件覆盖别人
  编辑」的反例判据。
B5-03 只撤本人 + 当前有权：无权身份 denied()（只认 403/PERMISSION_DENIED/无权）；
  **属主也不能代撤别人的 op**（批计划原话「只撤本人、有权、未被后改覆盖的操作」）；
  本人且有权的撤回成功（正对照）；**被撤编辑共享的原操作人也 denied**——
  本人还要当前写权，当时有权不算数。
B5-04 幂等不双撤：同幂等键重发同撤回 → 成功且版本不双跳；换新键再撤同一 op →
  applied=0 且版本不动（值已在原位，不被翻回去）。
B5-05 服务端核验：入参只有 table+op_id（带自报 cells 快照的请求被 schema 拒收）；
  未知 op_id → 拒（理由含「找不到」）；别的表的 op_id → 拒（台账按表隔离）。
B5-06 重放不泄漏（M7 缺口）：有编辑共享的身份写一格拿到带格值的结果（正对照），
  撤共享后同幂等键重放 execute **不能**再拿到旧结果（权限类拒绝）；
  GET /api/platform/action-requests/<key> 只回状态、不回格值。
B5-07 撤回可追溯：撤回动作自己的回执可查（status=Succeeded、failure_reason 空）。

接口契约（实现照此，改要同步改这份）：
  files.sheet_cells_undo {
    table,     # 表身份
    op_id      # 原写入操作编号（files.sheet_cells_write 入参/结果里的 op_id；
               #  files.sheet_cell_write 的回包 op_id=其操作号）
  } → result {
    table, sheet, op_id,
    applied,                     # 实际回退格数
    content_version, structure_version,   # applied>0 时 content_version 恰 +1；=0 时不落盘不升版
    cells: [{row_id, header, before, after}],  # 撤回这一步自己的快照
    skipped: [{row_id, header, reason}]        # changed=有人改过不覆盖 | already=已是原值 | missing=行列已不在
  }
  - 撤回门槛=**当前写权**（不是「只有原操作人」）；核验源=服务端操作台账（逐格 before/after
    服务端自记），**不接受客户端自报快照**；逐格现值比对，值已被别人改过的格不覆盖。
  - 撤回也走一次落盘（= content_version +1 = 一条版本记录）；什么都不用退时不落盘。

先红后绿：本文件先于实现写好，files.sheet_cells_undo 尚不存在时应按预期报
「动作不存在」类失败（denied()/rejected() 判据故意不认 404——红要红得诚实）。
"""
import base64
import importlib.util
import json
import sys
from io import BytesIO

BASE = 'http://127.0.0.1:3850'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

RUN = t.RUN
fails = []


def build_plain():
    """干净夹具（无外链/批注）：3 行 3 列，C4=公式格（撤回不碰公式）。"""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws.append(['名称', '数值', '备注'])
    ws.append(['甲', 1, 'a'])
    ws.append(['乙', 2, 'b'])
    ws.append(['丙', 3, 'c'])
    ws['C4'] = '=B4*2'
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
PW = ''
ENV = ('/path/to/workspace'
       'ops/docker/.state/environments/shangshu-local-review.env')
_admin_pw = ''
for _line in open(ENV):
    if _line.startswith('ADMIN_PASSWORD='):
        _admin_pw = _line.split('=', 1)[1].strip().strip('"').strip("'")
PW = ''
for _line in open(ENV):
    if _line.startswith('TEST_USER_PASSWORD='):
        PW = _line.split('=', 1)[1].strip().strip(chr(34)).strip(chr(39))
assert PW, 'Review test password missing'
assert _admin_pw, f'环境文件里没有 ADMIN_PASSWORD：{ENV}'

adm = t.Client(BASE)
adm.login('Administrator', _admin_pw)
owner = t.Client(BASE)
owner.login('ss-owner@example.invalid', PW)     # 上传/归属人（有写权）
editor = t.Client(BASE)
editor.login('ss-reader@example.invalid', PW)   # 获编辑共享身份（写权随共享走）
outsider = t.Client(BASE)
outsider.login('ss-outsider@example.invalid', PW)

# ---------- 建表（归属 personal=ss-owner）+ 开编辑共享给 editor ----------
print('== 建表 ==')
res, why = act(owner, 'files.upload', {
    'file_name': f'b5-撤回表-{RUN}.xlsx',
    'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/',
    'attribution': {'level': 'personal'},
}, f'b5-up-{RUN}')
TABLE = result_of(res).get('file')
check('上传撤回样本表', bool(TABLE), why[:120])
res, why = act(owner, 'platform.org.share_grant',
               {'resource': TABLE, 'user': 'ss-reader@example.invalid', 'access': 'edit'},
               f'b5-share-{RUN}')
check('开编辑共享给 editor（前提）', bool(res) and res[0] == 200, why[:120])


def snap(client=None):
    c = client or owner
    st, dat = t.service(c, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 100})
    if st != 200 or not isinstance(dat, dict):
        return None
    cells = {}
    for row in dat.get('rows') or []:
        for header, typed in (row.get('values') or {}).items():
            cells[(row.get('row_id'), header)] = json.dumps(typed, sort_keys=True, ensure_ascii=False)
    return {'cells': cells, 'content_version': dat.get('content_version'),
            'structure_version': dat.get('structure_version'), 'rows': dat.get('rows'),
            'headers': dat.get('headers')}


S0 = snap()
check('读回样本表', bool(S0), 'sheet_read 失败' if not S0 else f"行数={len(S0['rows'] or [])}")
HEADERS = (S0 or {}).get('headers') or []
ROWS = (S0 or {}).get('rows') or []
NAME_COL = '名称' if '名称' in HEADERS else (HEADERS[0] if HEADERS else '名称')
r_ids = [r.get('row_id') for r in ROWS]


def cell(row_id, header, val, typ='text'):
    return {'row_id': row_id, 'header': header, 'value': {'type': typ, 'value': val}}


def batch(c, cells, cver, sver, key, op_id, table=None):
    return act(c, 'files.sheet_cells_write', {
        'table': table or TABLE, 'expected_content_version': cver,
        'expected_structure_version': sver, 'cells': cells, 'op_id': op_id}, key)


def undo(c, op_id, key, table=None):
    return act(c, 'files.sheet_cells_undo', {'table': table or TABLE, 'op_id': op_id}, key)


def typed_json(val, typ='text'):
    return json.dumps({'type': typ, 'value': val}, sort_keys=True, ensure_ascii=False)


# ---------- B5-01 撤回恢复原值 ----------
print('\n== B5-01 撤回恢复原值 ==')
OP1 = f'op-b5-01-{RUN}'
sA = snap()
cells3 = [cell(r_ids[i], NAME_COL, f'待撤甲{i}') for i in range(3)] if len(r_ids) >= 3 else []
res, why = batch(owner, cells3, sA['content_version'], sA['structure_version'], f'b5-01-w-{RUN}', OP1)
check('B5-01 前置：批量写 3 格成功', bool(res) and res[0] == 200, why[:120])
sB = snap()
vals_written = bool(sB) and all(
    sB['cells'].get((cells3[i]['row_id'], NAME_COL)) == typed_json(f'待撤甲{i}') for i in range(min(3, len(cells3))))
check('B5-01 前置：3 格真的写进去了', vals_written, 'sheet_read 比对')

res, why = undo(owner, OP1, f'b5-01-u-{RUN}')
r = result_of(res)
check('B5-01 撤回成功', bool(res) and res[0] == 200, why[:140])
check('B5-01 applied=3', r.get('applied') == 3, f"applied={r.get('applied')}")
check('B5-01 content_version 恰 +1（撤回一步=一次落盘）',
      r.get('content_version') == (sB['content_version'] or 0) + 1,
      f"撤前={sB['content_version']} 撤后={r.get('content_version')}")
check('B5-01 structure_version 不漂', r.get('structure_version') == sB['structure_version'], '')
check('B5-01 回包逐格快照恰 3 条', len(r.get('cells') or []) == 3, f"回执={len(r.get('cells') or [])}")
sC = snap()
restored = bool(sC) and all(
    sC['cells'].get((cells3[i]['row_id'], NAME_COL)) == sA['cells'].get((cells3[i]['row_id'], NAME_COL))
    for i in range(min(3, len(cells3))))
check('B5-01 3 格读回全到原值', restored, 'sheet_read 与写前快照比对')
untouched = True
for k, old in (sA['cells'] or {}).items():
    if cells3 and k in {(c['row_id'], c['header']) for c in cells3}:
        continue
    if sC['cells'].get(k) != old:
        untouched = False
        break
check('B5-01 同表未涉及格一字不动（不是整文件回滚）', untouched and bool(sC), '全表快照比对')

# ---------- B5-02 不覆盖后来的编辑 ----------
print('\n== B5-02 不覆盖后来的编辑 ==')
OP2 = f'op-b5-02-{RUN}'
sD = snap()
cells3 = [cell(r_ids[i], NAME_COL, f'乙批甲{i}') for i in range(3)] if len(r_ids) >= 3 else []
res, why = batch(owner, cells3, sD['content_version'], sD['structure_version'], f'b5-02-w-{RUN}', OP2)
check('B5-02 前置：批量写 3 格成功', bool(res) and res[0] == 200, why[:120])
sE = snap()
# editor（另一身份）把第 2 格改成 C——模拟「别人后来的编辑」
res, why = act(editor, 'files.sheet_cell_write', {
    'table': TABLE, 'sheet': '', 'row_id': cells3[1]['row_id'], 'header': NAME_COL,
    'expected_content_version': sE['content_version'], 'expected_structure_version': sE['structure_version'],
    'value': {'type': 'text', 'value': '别人改的C'}}, f'b5-02-e-{RUN}')
check('B5-02 前置：editor 后来改了第 2 格', bool(res) and res[0] == 200, why[:120])
sF = snap()

res, why = undo(owner, OP2, f'b5-02-u-{RUN}')
r = result_of(res)
check('B5-02 撤回成功（部分）', bool(res) and res[0] == 200, why[:140])
check('B5-02 applied=2（只退没被改的）', r.get('applied') == 2, f"applied={r.get('applied')}")
sk = {(x.get('row_id'), x.get('header')): x.get('reason') for x in (r.get('skipped') or [])}
check('B5-02 被改的格进 skipped 且理由=已被修改',
      sk.get((cells3[1]['row_id'], NAME_COL)) in ('changed', '已被修改'),
      f"skipped={json.dumps(r.get('skipped'), ensure_ascii=False)[:140]}")
sG = snap()
back_ok = (bool(sG) and sG['cells'].get((cells3[0]['row_id'], NAME_COL)) == sD['cells'].get((cells3[0]['row_id'], NAME_COL))
           and sG['cells'].get((cells3[2]['row_id'], NAME_COL)) == sD['cells'].get((cells3[2]['row_id'], NAME_COL)))
check('B5-02 未被改的 2 格回到原值', back_ok, '')
c_stays = bool(sG) and sG['cells'].get((cells3[1]['row_id'], NAME_COL)) == typed_json('别人改的C')
check('B5-02 被改的格保持别人的新值（不整文件覆盖）', c_stays, '若被拉回原值=整文件回滚，反例失败')
untouched = True
for k, old in (sF['cells'] or {}).items():
    if cells3 and k in {(c['row_id'], c['header']) for c in cells3}:
        continue
    if sG['cells'].get(k) != old:
        untouched = False
        break
check('B5-02 未涉及格一字不动 + 版本只 +1',
      untouched and bool(sG) and sG['content_version'] == (sF['content_version'] or 0) + 1,
      f"撤前={sF['content_version']} 撤后={sG['content_version']}")

# ---------- B5-03 只撤本人 + 当前有权 ----------
print('\n== B5-03 只撤本人 + 当前有权 ==')
OP3 = f'op-b5-03-{RUN}'
sH = snap()
res, why = batch(editor, [cell(r_ids[0], NAME_COL, 'editor写的')], sH['content_version'],
                 sH['structure_version'], f'b5-03-w-{RUN}', OP3)
check('B5-03 前置：editor（有共享）写 1 格成功', bool(res) and res[0] == 200, why[:120])
sH2 = snap()   # 基线=写入之后（写入本身就该变值变版本）
res, why = undo(outsider, OP3, f'b5-03-o-{RUN}')
check('B5-03 无权身份撤回 denied', denied(res), why[:140])
# 属主也不能代撤别人的 op（只撤本人）
res, why = undo(owner, OP3, f'b5-03-owner-{RUN}')
check('B5-03 属主代撤别人 op 也 denied（只撤本人）', denied(res), why[:140])
# 正对照：本人且有权 → 撤回成功
res, why = undo(editor, OP3, f'b5-03-ok-{RUN}')
check('B5-03 正对照：本人+有权撤回成功', bool(res) and res[0] == 200, why[:140])
sJ = snap()
check('B5-03 正对照：格真的回到原值',
      bool(sJ) and sJ['cells'].get((r_ids[0], NAME_COL)) == sH['cells'].get((r_ids[0], NAME_COL)), '')
# 再写一格后撤共享 → 原操作人失写权 → 本人也撤不动
OP3b = f'op-b5-03b-{RUN}'
sH3 = snap()
res, why = batch(editor, [cell(r_ids[0], NAME_COL, 'editor再写')], sH3['content_version'],
                 sH3['structure_version'], f'b5-03-w2-{RUN}', OP3b)
check('B5-03 前置：editor 再写 1 格', bool(res) and res[0] == 200, why[:120])
sH4 = snap()
res, why = act(owner, 'platform.org.share_revoke',
               {'resource': TABLE, 'user': 'ss-reader@example.invalid'}, f'b5-03-rev-{RUN}')
check('B5-03 前置：撤掉 editor 共享', bool(res) and res[0] == 200, why[:120])
res, why = undo(editor, OP3b, f'b5-03-e-{RUN}')
check('B5-03 被撤权的原操作人也 denied（本人还要当前写权）', denied(res), why[:140])
sI = snap()
check('B5-03 拒后值与版本不动', bool(sI) and sI['cells'] == sH4['cells']
      and sI['content_version'] == sH4['content_version'], '')

# ---------- B5-04 幂等不双撤 ----------
print('\n== B5-04 幂等不双撤 ==')
OP4 = f'op-b5-04-{RUN}'
sK = snap()
res, why = batch(owner, [cell(r_ids[0], NAME_COL, '幂等待撤')], sK['content_version'],
                 sK['structure_version'], f'b5-04-w-{RUN}', OP4)
check('B5-04 前置：写 1 格成功', bool(res) and res[0] == 200, why[:120])
sL = snap()
res1, why1 = undo(owner, OP4, f'b5-04-u-{RUN}')
r1 = result_of(res1)
sL2 = snap()   # 基线=第一次撤回之后（值已在原位）
res2, why2 = undo(owner, OP4, f'b5-04-u-{RUN}')   # 同键重放
r2 = result_of(res2)
check('B5-04 同键重放不双撤（版本不双跳）',
      bool(res1) and res1[0] == 200 and bool(res2) and res2[0] == 200
      and r2.get('content_version') == r1.get('content_version'),
      f"一次={r1.get('content_version')} 二次={r2.get('content_version')}")
res3, why3 = undo(owner, OP4, f'b5-04-u2-{RUN}')  # 换新键再撤同一 op
r3 = result_of(res3)
check('B5-04 换键再撤同一 op → applied=0 且版本不动',
      bool(res3) and res3[0] == 200 and r3.get('applied') == 0
      and r3.get('content_version') == r1.get('content_version'),
      f"applied={r3.get('applied')} 版本={r3.get('content_version')} vs {r1.get('content_version')}")
sM = snap()
not_flipped = (bool(sM) and sM['cells'].get((r_ids[0], NAME_COL)) != typed_json('幂等待撤'))
check('B5-04 值没有被翻回写入位（仍在撤回位）', not_flipped and bool(sM) and sM['cells'] == sL2['cells'],
      f"现值={str((sM or {}).get('cells', {}).get((r_ids[0], NAME_COL)))[:40]}")

# ---------- B5-05 服务端核验 ----------
print('\n== B5-05 服务端核验（不收自报快照）==')
res, why = act(owner, 'files.sheet_cells_undo', {
    'table': TABLE, 'op_id': 'op-不存在-' + RUN,
    'cells': [{'row_id': r_ids[0], 'header': NAME_COL,
               'before': {'type': 'text', 'value': '自报'}, 'after': {'type': 'text', 'value': '自报'}}]},
    f'b5-05-self-{RUN}')
# 只认「输入校验拒」：404 动作缺失不算过（防假绿兜底）
st_self = res[0] if res else 0
check('B5-05 自报快照请求被拒收（schema 不收 cells）',
      bool(res) and st_self not in (200, 404) and (
          rejected(res, '格') or rejected(res, '字段') or rejected(res, 'additional')
          or rejected(res, '不允许') or rejected(res, '不符合') or rejected(res, '无效')
          or rejected(res, '未知属性') or rejected(res, 'schema')), why[:140])
res, why = undo(owner, 'op-不存在-' + RUN, f'b5-05-unk-{RUN}')
check('B5-05 未知 op_id 拒（理由含「找不到」）', rejected(res, '找不到'), why[:140])
# 别的表的 op_id：先在另一张表写一个 op，再拿它的 op_id 撤本表
res2, why2 = act(owner, 'files.upload', {
    'file_name': f'b5-别表-{RUN}.xlsx', 'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/', 'attribution': {'level': 'personal'}}, f'b5-up2-{RUN}')
T2 = result_of(res2).get('file')
sT2 = snap() if False else None
st, dat2 = t.service(owner, 'files.sheet_read', {'table': T2, 'page': 1, 'page_length': 10})
rows2 = dat2.get('rows') or []
res3, why3 = batch(owner, [cell(rows2[0]['row_id'], NAME_COL, '别表写')], dat2.get('content_version'),
                   dat2.get('structure_version'), f'b5-05-w2-{RUN}', f'op-别表-{RUN}', table=T2)
check('B5-05 前置：另一张表写 1 格', bool(res3) and res3[0] == 200, why3[:120])
res4, why4 = undo(owner, f'op-别表-{RUN}', f'b5-05-cross-{RUN}')
check('B5-05 别的表的 op_id 拒（台账按表隔离）', rejected(res4, '找不到'), why4[:140])

# ---------- B5-06 重放不泄漏（M7 缺口） ----------
print('\n== B5-06 重放不泄漏 ==')
# 重新给 editor 编辑共享，写一格拿结果，再撤共享后同键重放
res, why = act(owner, 'platform.org.share_grant',
               {'resource': TABLE, 'user': 'ss-reader@example.invalid', 'access': 'edit'},
               f'b5-06-share-{RUN}')
check('B5-06 前置：再开编辑共享', bool(res) and res[0] == 200, why[:120])
sN = snap()
KEY6 = f'b5-06-replay-{RUN}'
res, why = batch(editor, [cell(r_ids[0], NAME_COL, '重放源写入')], sN['content_version'],
                 sN['structure_version'], KEY6, f'op-b5-06-{RUN}')
r6 = result_of(res)
has_vals = any('before' in c and 'after' in c for c in (r6.get('cells') or []))
check('B5-06 正对照：有权时拿到带格值的结果', bool(res) and res[0] == 200 and has_vals, why[:140])
res, why = act(editor, 'files.sheet_cells_write', {
    'table': TABLE, 'expected_content_version': sN['content_version'],
    'expected_structure_version': sN['structure_version'],
    'cells': [cell(r_ids[0], NAME_COL, '重放源写入')], 'op_id': f'op-b5-06-{RUN}'}, KEY6)
r6b = result_of(res)
check('B5-06 正对照：有权时同键重放拿得到旧结果', bool(res) and res[0] == 200
      and bool(r6b.get('cells') or r6b.get('idempotent') is True), why[:140])
res, why = act(owner, 'platform.org.share_revoke',
               {'resource': TABLE, 'user': 'ss-reader@example.invalid'}, f'b5-06-rev-{RUN}')
check('B5-06 前置：撤共享', bool(res) and res[0] == 200, why[:120])
res, why = act(editor, 'files.sheet_cells_write', {
    'table': TABLE, 'expected_content_version': sN['content_version'],
    'expected_structure_version': sN['structure_version'],
    'cells': [cell(r_ids[0], NAME_COL, '重放源写入')], 'op_id': f'op-b5-06-{RUN}'}, KEY6)
body6 = res[1] if res and isinstance(res[1], dict) else {}
leak = json.dumps(body6, ensure_ascii=False)
check('B5-06 撤权后同键重放被拒（旧回执不能换出值）', denied(res), why[:140])
check('B5-06 拒绝回包里不带格值', 'before' not in leak and '重放源写入' not in leak, leak[:120])
st_rq, dat_rq = editor.request('GET', f'/api/platform/action-requests/{t.receipt_key(KEY6)}')
rq = dat_rq if isinstance(dat_rq, dict) else {}
leak2 = json.dumps(rq, ensure_ascii=False)
check('B5-06 回执入口只回状态不回格值',
      st_rq in (200, 403) and 'before' not in leak2 and '重放源写入' not in leak2, leak2[:120])

# ---------- B5-07 撤回可追溯 ----------
print('\n== B5-07 撤回可追溯 ==')
KEY7 = f'b5-07-u-{RUN}'
OP7 = f'op-b5-07-{RUN}'
sO = snap()
res, why = batch(owner, [cell(r_ids[0], NAME_COL, '可追溯写入')], sO['content_version'],
                 sO['structure_version'], f'b5-07-w-{RUN}', OP7)
check('B5-07 前置：写 1 格', bool(res) and res[0] == 200, why[:120])
res, why = undo(owner, OP7, KEY7)
check('B5-07 撤回成功', bool(res) and res[0] == 200, why[:140])
st_rq, dat_rq = owner.request('GET', f'/api/platform/action-requests/{t.receipt_key(KEY7)}')
rq = dat_rq if isinstance(dat_rq, dict) else {}
body7 = rq.get('result') or rq
ok_trace = (st_rq == 200 and body7.get('status') in ('Succeeded', 'succeeded')
            and not body7.get('failure_reason'))
check('B5-07 撤回回执可查（Succeeded、无失败原因）', ok_trace,
      f'HTTP {st_rq} {json.dumps(body7, ensure_ascii=False)[:140]}')

print()
if fails:
    print(f'结果： FAIL {len(fails)} 项未过')
    print('未过清单：', json.dumps(fails, ensure_ascii=False))
    sys.exit(1)
print('结果： PASS 受管撤回七项判据全部成立')
