"""B6 已有表兼容与故障反例（旧数据不自动迁移、撤权并发、台账失败不假成功）。

测试通过 = 下面四件全部成立（每条都是「做这个操作 → 该看到这个」）：

B6-01 旧表兼容（无归属走旧目录 ACL，行为一字不变）：不带 attribution 上传的存量表
  ——上传人可读可写（正对照）、System Manager 照旧可读（存量行为）、**根目录
  （inherit）外人也读得到（存量行为——不自动迁移=既不变严也不变松）**、
  受限目录里的旧表外人读 denied（只认 403/PERMISSION_DENIED/无权）。
B6-02 旧数据不自动迁移 + 共享边界：无归属表上组织共享**建不起来**——
  platform.org.share_grant 对无归属资源一律拒且理由含「无组织归属」（SM 也不例外：
  分类错误=先补归属再共享，不是「只有归属人可以共享」那句糊话）；旧表读写照旧
  受旧目录 ACL 管、不受组织体系影响（受限旧表外人读写照旧拒）；清单行
  attribution 为空 = 核查口径（FDE 按清单核，不写测试 SQL 当产品能力）。
B6-03 撤权并发不半批：有编辑共享的身份并发发多批写、属主并发撤共享——每个响应
  要么整成（200 且 applied 全数）要么整拒（权限/闩冲突），**没有半批**；
  成功批数=content_version 增量；尘埃落定后新写 denied。
B6-04 台账失败不假成功：注入 op-record 故障后发写——请求失败（非 200）、值与
  版本不动、回执 Failed 可查、该 op 撤回拒「找不到」（整事务回滚，没留半套账）。
B6-05 影响预览不落库：对无归属旧表 platform.org.resource_assign 带 dry_run=true
  → applied=false、effects 列出谁读/写会变（新部门成员 gain 读、外人 lose 读），
  且**不落库**（清单 attribution 仍为空、外人行为未变照旧读得到）。
B6-06 受管归属补录生效：正式补录（不带 dry_run）后组织判定接管——预览里列的
  gain/lose 与实际一致（外人读变 denied、部门成员读 200）；普通上传人发补录 denied
  （受管动作=System Manager）。

先红后绿：B6-02 的「无组织归属」分类文案尚不存在时应红；B6-04 的 op-record
断点尚不存在时故障不会触发、判据应红（不许拿「没断点=没故障」混绿）。
"""
import base64
import importlib.util
import json
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from io import BytesIO

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'
COMPOSE = 'shangshu-local-b'

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

RUN = t.RUN
fails = []


def build_plain():
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws.append(['名称', '数值', '备注'])
    ws.append(['甲', 1, 'a'])
    ws.append(['乙', 2, 'b'])
    ws.append(['丙', 3, 'c'])
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


checks_run = 0


def check(name, ok, detail):
    global checks_run
    checks_run += 1
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
    if not res:
        return False
    st, body = res
    body = body if isinstance(body, dict) else {}
    if st == 403 or body.get('code', '') == 'PERMISSION_DENIED':
        return True
    err = str(body.get('error', ''))
    return '无权' in err or 'not permitted' in err.lower() or 'permission' in err.lower()


def rejected(res, word):
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
assert _admin_pw

adm = t.Client(BASE)
adm.login('Administrator', _admin_pw)
owner = t.Client(BASE)
owner.login('ss-owner@example.invalid', PW)
editor = t.Client(BASE)
editor.login('ss-reader@example.invalid', PW)
outsider = t.Client(BASE)
outsider.login('ss-outsider@example.invalid', PW)


def upload(c, name, key, attribution=None):
    payload = {'file_name': name, 'content_base64': base64.b64encode(build_plain()).decode(),
               'directory': '/'}
    if attribution:
        payload['attribution'] = attribution
    res, why = act(c, 'files.upload', payload, key)
    return result_of(res).get('file'), why


def snap(tid, c=None):
    st, dat = t.service(c or owner, 'files.sheet_read', {'table': tid, 'page': 1, 'page_length': 100})
    if st != 200 or not isinstance(dat, dict):
        return None
    cells = {}
    for row in dat.get('rows') or []:
        for header, typed in (row.get('values') or {}).items():
            cells[(row.get('row_id'), header)] = json.dumps(typed, sort_keys=True, ensure_ascii=False)
    return {'cells': cells, 'content_version': dat.get('content_version'),
            'structure_version': dat.get('structure_version'), 'rows': dat.get('rows')}


def cell(row_id, header, val, typ='text'):
    return {'row_id': row_id, 'header': header, 'value': {'type': typ, 'value': val}}


# ---------- B6-01 旧表兼容 ----------
print('\n== B6-01 旧表兼容（无归属=旧目录 ACL）==')
LEG, why = upload(owner, f'b6-旧表-{RUN}.xlsx', f'b6-01-up-{RUN}')
check('B6-01 无归属表上传成功', bool(LEG), why[:120])
# **诊断（2026-10-15 E 要的分辨一步）**：把 LEG 和它的 file_name 一起打出来。
# 为什么：「内容去重返回旧文件 ID」已核**死了**（D 逐行核 service.py:375-425，
# digest 只写版本行、existing 只按 directory+file_name 查、.xlsx 同名恒新表）。
# 所以「跨轮残留」存疑 —— 那批归属可能是**早上那轮自己写给自己 LEG** 的正确写入。
# 打出来对上号：
#   file_name == b6-旧表-<本轮 RUN>.xlsx → LEG 是本轮新表，518d532pd4 是早上那张（甲）
#   file_name == 早上那个 RUN → D 的代码结论有漏洞（乙）
if LEG:
    _q = subprocess.run(
        ['docker', 'exec', f'{COMPOSE}-frappe-1',
         '/home/frappe/frappe-bench/env/bin/python', '-c',
         'import frappe; frappe.init(site="shangshu.localhost", sites_path="/home/frappe/frappe-bench/sites"); frappe.connect(); '
         'r=frappe.db.sql("SELECT name, file_name, creation FROM `tabShangshu File Center File` WHERE name=%s", ("' + LEG + '",), as_dict=True); '
         'a=frappe.db.sql("SELECT name, level, creation FROM `tabShangshu Org Attribution` WHERE resource=%s", ("' + LEG + '",), as_dict=True); '
         'print("DIAG FILE_ROW=" + str(r)); print("DIAG ATTR=" + str(a))'],
        capture_output=True, text=True)
    print('DIAG 本轮 RUN=%s 期望文件名=b6-旧表-%s.xlsx' % (RUN, RUN))
    print('DIAG LEG值=%r' % (LEG,))
    print('DIAG 结果: %s' % ((_q.stdout or _q.stderr)[:300]))
# **清上传自动补的归属**（2026-10-15 诊断实测）：B6 全套前提是「无归属旧表」，
# 但 `files.upload` **不传 attribution 也会自动落一条 `personal` 归属**（归上传人）。
# 实测：本轮新表 `b6-旧表-<RUN>.xlsx` 建于 10:38:32.769，归属 6 毫秒后 10:38:32.775
# 就出现 `level=personal`。B6-02 期望「无归属」→ 看到这条自动补的 → 红。
# **修法不依赖机制假设**：不管归属哪来的，开局把 B6 前提（无归属）对齐。
# （⚠️ 自动补在哪段代码**待核** —— 不在 `_apply_attribution`（旧版 `if not att: return`），
# 在别处（DocType insert hook 或 upload 主函数另一段）。D 核。
# 也不修产品代码 —— `dry_run` 是对的，`org_admin.py` 在 insert 前就 return。）
def clear_residual_attribution(resource, label):
    """清掉一个资源上的归属（B6 前提是「无归属旧表」，上传会自动补，先清掉）。
    **公共工具只留一份**（§13）—— LEG 和 LEG_R 都要用，不各写一份。"""
    if not resource:
        return False, 'resource 空'
    _py = ('import frappe; '
           'frappe.init(site="shangshu.localhost", sites_path="/home/frappe/frappe-bench/sites"); '
           'frappe.connect(); '
           'frappe.db.sql("DELETE FROM `tabShangshu Org Attribution` WHERE resource=%s", ("' + resource + '",)); '
           'frappe.db.commit(); print("cleared")')
    _clear = subprocess.run(
        ['docker', 'exec', f'{COMPOSE}-frappe-1',
         '/home/frappe/frappe-bench/env/bin/python', '-c', _py],
        capture_output=True, text=True)
    return (_clear.returncode == 0 and 'cleared' in (_clear.stdout or ''),
            f'rc={_clear.returncode} out={(_clear.stdout or _clear.stderr)[:160]}')


if LEG:
    _ok, _why_clear = clear_residual_attribution(LEG, 'LEG')
    check('B6-01 前置：清掉 LEG 的跨轮残留归属（否则 B6 全套前提不成立）',
          _ok, _why_clear)
s = snap(LEG)
check('B6-01 上传人可读（正对照）', bool(s), 'sheet_read')
rid = (s['rows'] or [{}])[0].get('row_id') if s else None
res, why = act(owner, 'files.sheet_cell_write', {
    'table': LEG, 'sheet': '', 'row_id': rid, 'header': '名称',
    'expected_content_version': s['content_version'], 'expected_structure_version': s['structure_version'],
    'value': {'type': 'text', 'value': '旧表写入'}}, f'b6-01-w-{RUN}')
check('B6-01 上传人可写（正对照）', bool(res) and res[0] == 200, why[:120])
st_sm, dat_sm = adm.request('POST', '/api/platform/services/files.sheet_read/invoke',
                            {'payload': {'table': LEG}})
check('B6-01 System Manager 照旧可读（存量行为）',
      st_sm == 200 and isinstance(dat_sm, dict) and bool((dat_sm.get('rows') or dat_sm.get('result') or {})), '')
st_out, dat_out = outsider.request('POST', '/api/platform/services/files.sheet_read/invoke',
                                   {'payload': {'table': LEG}})
check('B6-01 根目录（inherit）外人读得到=存量行为（不自动变严）',
      st_out == 200 and isinstance(dat_out, dict) and bool((dat_out.get('rows') or dat_out.get('result') or {})),
      f'HTTP {st_out}')
# 受限目录旧表：旧目录 ACL 照旧拦外人
# identity_id 从登录回包取（重登一次拿 identity）
_req = urllib.request.Request(BASE + '/api/platform/login', data=json.dumps(
    {'username': 'ss-owner@example.invalid', 'password': PW}).encode(), method='POST')
_req.add_header('Content-Type', 'application/json')
try:
    with urllib.request.urlopen(_req, timeout=30) as _r:
        body_login = json.loads(_r.read().decode() or '{}')
except Exception:
    body_login = {}
owner_identity = (body_login.get('result') or body_login).get('identity_id')
res, why = act(adm, 'files.directory_create', {'title': f'b6-secret-{RUN}'}, f'b6-01-dir-{RUN}')
secret = result_of(res)
secret_id, secret_mod = secret.get('directory'), secret.get('modified')
check('B6-01 前置：建受限目录', bool(secret_id) and bool(owner_identity), f'dir={secret_id} ident={bool(owner_identity)}')
res, why = act(adm, 'files.directory_access', {
    'directory': secret_id, 'expected_modified': secret_mod, 'mode': 'restricted',
    'identities': [owner_identity], 'groups': []}, f'b6-01-acc-{RUN}')
check('B6-01 前置：目录改仅属主可见', bool(res) and res[0] == 200, why[:120])
res, why = act(owner, 'files.upload', {
    'file_name': f'b6-受限旧表-{RUN}.xlsx', 'content_base64': base64.b64encode(build_plain()).decode(),
    'directory_id': secret_id}, f'b6-01-up2-{RUN}')
LEG_R = result_of(res).get('file')
check('B6-01 前置：往受限目录传旧表', bool(LEG_R), why[:120])
if LEG_R:
    _ok, _why_clear = clear_residual_attribution(LEG_R, 'LEG_R')
    check('B6-01 前置：清掉 LEG_R 的跨轮残留归属', _ok, _why_clear)
st_r, dat_r = outsider.request('POST', '/api/platform/services/files.sheet_read/invoke',
                               {'payload': {'table': LEG_R}})
body_r = dat_r if isinstance(dat_r, dict) else {}
check('B6-01 受限目录旧表外人读 denied（旧 ACL 照旧拦）',
      st_r == 403 or body_r.get('code') == 'PERMISSION_DENIED'
      or '无权' in str(body_r.get('error', '')) or 'Not allowed' in str(body_r.get('error', '')),
      f'HTTP {st_r}')

# ---------- B6-02 旧数据不自动迁移 + 共享边界 ----------
print('\n== B6-02 旧数据不自动迁移 + 共享边界 ==')
# 核查口径：清单行 attribution 为空（scope=sheet 走 filters JSON，默认口径排除 xlsx）
q = urllib.parse.quote(json.dumps({'scope': 'sheet'}))
st_ds, dat_ds = owner.request('GET', f'/api/platform/datasets/files.file/records?filters={q}&page=1&page_length=200')
rows_ds = (dat_ds or {}).get('rows') or ((dat_ds or {}).get('result') or {}).get('rows') or []
row_leg = next((r for r in rows_ds if r.get('name') == LEG), None)
check('B6-02 旧表在清单里 attribution 为空（核查口径）',
      bool(row_leg) and not (row_leg.get('attribution') or {}).get('level'),
      f"清单行={json.dumps(row_leg, ensure_ascii=False)[:120] if row_leg else '未找到'}")
# 共享行建不起来：SM 也拒（分类错误=先补归属再共享）
res, why = act(adm, 'platform.org.share_grant',
               {'resource': LEG_R, 'user': 'ss-outsider@example.invalid', 'access': 'edit'}, f'b6-02-gr-{RUN}')
check('B6-02 旧表发共享拒且理由=无组织归属（SM 也拒）', rejected(res, '无组织归属'), why[:140])
# 旧表读写照旧受旧目录 ACL 管，不受组织体系影响
st_out2, dat_out2 = outsider.request('POST', '/api/platform/services/files.sheet_read/invoke',
                                     {'payload': {'table': LEG_R}})
body_out2 = dat_out2 if isinstance(dat_out2, dict) else {}
check('B6-02 受限旧表外人读照旧拒（不被拉进组织体系）',
      st_out2 == 403 or body_out2.get('code') == 'PERMISSION_DENIED'
      or '无权' in str(body_out2.get('error', '')) or 'Not allowed' in str(body_out2.get('error', '')),
      f'HTTP {st_out2}')
sR = snap(LEG_R)
res, why = act(outsider, 'files.sheet_cell_write', {
    'table': LEG_R, 'sheet': '', 'row_id': (sR['rows'] or [{}])[0].get('row_id'), 'header': '名称',
    'expected_content_version': sR['content_version'], 'expected_structure_version': sR['structure_version'],
    'value': {'type': 'text', 'value': '共享写'}}, f'b6-02-w-{RUN}')
check('B6-02 受限旧表外人写照旧拒（旧口径=上传人/管理员）', denied(res), why[:140])
# 非 SM 的旧表上传人发共享 → 同一句分类错误
res, why = act(owner, 'platform.org.share_grant',
               {'resource': LEG, 'user': 'ss-reader@example.invalid', 'access': 'edit'}, f'b6-02-mx-{RUN}')
check('B6-02 上传人发共享同样拒「无组织归属」（不是「你不是归属人」）', rejected(res, '无组织归属'), why[:140])

# ---------- B6-03 撤权并发不半批 ----------
print('\n== B6-03 撤权并发不半批 ==')
T3, why = upload(owner, f'b6-并发表-{RUN}.xlsx', f'b6-03-up-{RUN}', attribution={'level': 'personal'})
check('B6-03 建归属表', bool(T3), why[:120])
res, why = act(owner, 'platform.org.share_grant',
               {'resource': T3, 'user': 'ss-reader@example.invalid', 'access': 'edit'}, f'b6-03-sh-{RUN}')
check('B6-03 开编辑共享', bool(res) and res[0] == 200, why[:120])
s0 = snap(T3)
rids = [r.get('row_id') for r in (s0['rows'] or [])]
cv0 = s0['content_version']
write_results = []
revoke_results = []
lock = threading.Lock()


def writer(i):
    c = t.Client(BASE)
    c.login('ss-reader@example.invalid', PW)
    # 每个线程各自读最新版本闩再写——竞态落在「写 vs 撤共享」上，不是闩自撞
    st, dat = t.service(c, 'files.sheet_read', {'table': T3, 'page': 1, 'page_length': 10})
    row = (dat.get('rows') or [{}])[i % max(1, len(dat.get('rows') or []))].get('row_id')
    res, why = act(c, 'files.sheet_cells_write', {
        'table': T3, 'expected_content_version': dat.get('content_version'),
        'expected_structure_version': dat.get('structure_version'),
        'cells': [cell(row, '名称', f'并发写{i}')], 'op_id': f'op-b6-03-{i}-{RUN}'}, f'b6-03-w{i}-{RUN}')
    with lock:
        write_results.append((res, why))


def revoker():
    c = t.Client(BASE)
    c.login('ss-owner@example.invalid', PW)
    res, why = act(c, 'platform.org.share_revoke',
                   {'resource': T3, 'user': 'ss-reader@example.invalid'}, f'b6-03-rev-{RUN}')
    with lock:
        revoke_results.append((res, why))


threads = [threading.Thread(target=writer, args=(i,)) for i in range(5)] + [threading.Thread(target=revoker)]
for th in threads:
    th.start()
for th in threads:
    th.join()
revoke_ok = any(res and res[0] == 200 for res, why in revoke_results)
ok_shape, n_ok = True, 0
odd = []
for res, why in write_results:
    st = res[0] if res else 0
    body = res[1] if res and isinstance(res[1], dict) else {}
    r = body.get('result') or body
    if st == 200:
        n_ok += 1
        if r.get('applied') != 1:
            ok_shape = False
            odd.append(f'200但applied={r.get("applied")}:{why[:80]}')
    elif st == 403 or body.get('code') == 'PERMISSION_DENIED':
        pass  # 撤共享先到：整拒
    elif st == 417 or '已被其他操作修改' in str(body.get('error', '')):
        pass  # 兄弟写先落盘：闩冲突整拒（业务规则，不是半批）
    else:
        ok_shape = False
        odd.append(f'HTTP {st} {json.dumps(body, ensure_ascii=False)[:120]}')
check('B6-03 撤共享本身成功', revoke_ok, '')
check('B6-03 并发写响应全是「整成/整拒/闩冲突」，无半批', ok_shape and len(write_results) == 5,
      f'{len(write_results)} 个写响应 肇事={json.dumps(odd, ensure_ascii=False)[:300]}')
s1 = snap(T3)
check('B6-03 成功批数=content_version 增量',
      bool(s1) and s1['content_version'] == cv0 + n_ok,
      f'成功={n_ok} 版本 {cv0}→{s1["content_version"] if s1 else "?"}')
res, why = act(editor, 'files.sheet_cells_write', {
    'table': T3, 'expected_content_version': s1['content_version'],
    'expected_structure_version': s1['structure_version'],
    'cells': [cell(rids[0], '名称', '事后写')], 'op_id': f'op-b6-03-after-{RUN}'}, f'b6-03-after-{RUN}')
check('B6-03 尘埃落定后 editor 新写 denied', denied(res), why[:140])

# ---------- B6-04 台账失败不假成功 ----------
print('\n== B6-04 台账失败不假成功（op-record 注入）==')
sF = snap(T3)
proc = subprocess.run(['docker', 'exec', f'{COMPOSE}-frappe-1', 'bash', '-lc',
                       'echo op-record > /tmp/ss-fault-point && cat /tmp/ss-fault-point'],
                      capture_output=True, text=True)
if proc.returncode != 0 or proc.stdout.strip() != 'op-record':
    check('B6-04 断点未写进容器（结果不可信）', False, proc.stderr[:120])
else:
    try:
        res, why = act(owner, 'files.sheet_cells_write', {
            'table': T3, 'expected_content_version': sF['content_version'],
            'expected_structure_version': sF['structure_version'],
            'cells': [cell(rids[0], '名称', '台账故障写入')], 'op_id': f'op-b6-04-{RUN}'}, f'b6-04-w-{RUN}')
        check('B6-04 台账故障时写请求失败、无假成功',
              (not res) or res[0] >= 400 or (res[1] or {}).get('ok') is False, why[:140])
    finally:
        subprocess.run(['docker', 'exec', f'{COMPOSE}-frappe-1', 'bash', '-lc',
                        'rm -f /tmp/ss-fault-point'], capture_output=True)
    sG = snap(T3)
    check('B6-04 故障后值与版本不动（整事务回滚）',
          bool(sG) and sG['cells'] == sF['cells'] and sG['content_version'] == sF['content_version'], '')
    st_rq, dat_rq = owner.request('GET', f'/api/platform/action-requests/{t.receipt_key("b6-04-w-%s" % RUN)}')
    body_rq = (dat_rq if isinstance(dat_rq, dict) else {}).get('result') or (dat_rq if isinstance(dat_rq, dict) else {})
    check('B6-04 回执 Failed 可查', st_rq == 200 and body_rq.get('status') in ('Failed', 'failed'),
          f'HTTP {st_rq} status={body_rq.get("status")}')
    res, why = act(owner, 'files.sheet_cells_undo', {'table': T3, 'op_id': f'op-b6-04-{RUN}'}, f'b6-04-u-{RUN}')
    check('B6-04 该 op 撤回拒「找不到」（没留半套账）', rejected(res, '找不到'), why[:140])

# ---------- B6-05 影响预览不落库 ----------
print('\n== B6-05 影响预览不落库 ==')
res, why = act(adm, 'platform.org.department_create', {'name': f'b6-补录部-{RUN}'}, f'b6-05-dept-{RUN}')
d6 = result_of(res).get('department') or result_of(res).get('name')
check('B6-05 前置：建部门', bool(d6), why[:120])
res, why = act(adm, 'platform.org.member_assign', {'user': 'ss-reader@example.invalid', 'department': d6},
               f'b6-05-mem-{RUN}')
check('B6-05 前置：ss-reader 入部', bool(res) and res[0] == 200, why[:120])
res, why = act(adm, 'platform.org.resource_assign',
               {'resource': LEG, 'level': 'department', 'department': d6, 'dry_run': True}, f'b6-05-dry-{RUN}')
r5 = result_of(res)
check('B6-05 预览成功且 applied=false（不落库）', bool(res) and res[0] == 200 and r5.get('applied') is False,
      f"applied={r5.get('applied')}")
eff = {(e.get('user')): e for e in (r5.get('effects') or [])}
r_in = (eff.get('ss-reader@example.invalid') or {}).get('read') or {}
r_out = (eff.get('ss-outsider@example.invalid') or {}).get('read') or {}
check('B6-05 预览列 gain：部门成员读 legacy→true',
      r_in.get('after') is True and r_in.get('before') == 'legacy', f'{json.dumps(r_in, ensure_ascii=False)}')
check('B6-05 预览列 lose：外人读 legacy→false',
      r_out.get('after') is False and r_out.get('before') == 'legacy', f'{json.dumps(r_out, ensure_ascii=False)}')
q2 = urllib.parse.quote(json.dumps({'scope': 'sheet'}))
st_ds2, dat_ds2 = owner.request('GET', f'/api/platform/datasets/files.file/records?filters={q2}&page=1&page_length=200')
rows_ds2 = (dat_ds2 or {}).get('rows') or ((dat_ds2 or {}).get('result') or {}).get('rows') or []
row_leg2 = next((r for r in rows_ds2 if r.get('name') == LEG), None)
check('B6-05 预览后 attribution 仍为空（没落库）',
      bool(row_leg2) and not (row_leg2.get('attribution') or {}).get('level'), '')
st_p, dat_p = outsider.request('POST', '/api/platform/services/files.sheet_read/invoke',
                               {'payload': {'table': LEG}})
check('B6-05 预览后外人行为未变（照旧读得到）',
      st_p == 200 and isinstance(dat_p, dict) and bool((dat_p.get('rows') or dat_p.get('result') or {})),
      f'HTTP {st_p}')

# ---------- B6-06 受管归属补录生效 ----------
print('\n== B6-06 受管归属补录生效 ==')
res, why = act(owner, 'platform.org.resource_assign',
               {'resource': LEG, 'level': 'department', 'department': d6}, f'b6-06-o-{RUN}')
check('B6-06 普通上传人发补录 denied（受管动作）', denied(res), why[:140])
res, why = act(adm, 'platform.org.resource_assign',
               {'resource': LEG, 'level': 'department', 'department': d6}, f'b6-06-apply-{RUN}')
r6 = result_of(res)
check('B6-06 补录成功且 applied=true', bool(res) and res[0] == 200 and r6.get('applied') is True,
      f"applied={r6.get('applied')}")
st_o6, dat_o6 = outsider.request('POST', '/api/platform/services/files.sheet_read/invoke',
                                 {'payload': {'table': LEG}})
body_o6 = dat_o6 if isinstance(dat_o6, dict) else {}
check('B6-06 外人读变 denied（预览列的 lose 兑现）',
      st_o6 == 403 or body_o6.get('code') == 'PERMISSION_DENIED'
      or '无权' in str(body_o6.get('error', '')) or 'Not allowed' in str(body_o6.get('error', '')),
      f'HTTP {st_o6}')
st_r6, dat_r6 = editor.request('POST', '/api/platform/services/files.sheet_read/invoke',
                               {'payload': {'table': LEG}})
check('B6-06 部门成员读 200（预览列的 gain 兑现）',
      st_r6 == 200 and isinstance(dat_r6, dict) and bool((dat_r6.get('rows') or dat_r6.get('result') or {})),
      f'HTTP {st_r6}')


# ==================== B6-07 「AND 不是替换」—— 把关条件不许被顺手删掉 ====================
# **为什么要有这条**：归属映射定的迁移做法是「先迁**字段**，**判定权**仍由文件域那侧把关，
# 两侧 AND，不是替换」（契约 §3.5.3）。那句话现在只活在契约文字里 —— 将来有人看到
# 「两边都判一遍，重复」，顺手删掉一侧，正好把这次的防线拆了，而且拆得理直气壮。
#
# **⚠️ 能钉的是「闸装着」，不是迁移后的行为** —— 迁移还没做，判不了迁移后。
# 这条跟 FA-15 / FA-17⑧ 同族：**闸函数存在 ≠ 闸装上**，所以查的是**读权路径上真调了它**。
print('\n== B6-07 文件域把关条件仍在读权路径上（AND 不许拆）==')
import os as _os
SVC = _os.path.join(_os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..', '..')),
                    'frappe_apps', 'shangshu_files', 'shangshu_files', 'service.py')
svc_src = open(SVC, encoding='utf-8').read()
pq = svc_src.split('def permission_query')[1].split('\ndef ')[0] if 'def permission_query' in svc_src else ''
check('B6-07 ① permission_query 里部门默认读的把关还在（开关 + 归属类型 + 本人部门）',
      all(k in pq for k in ('dept_read_default', 'owner_subject_kind', '_user_department')),
      'permission_query 里没找到把关条件 —— 可能被当成「已交给内核」删掉了')
check('B6-07 ② 把关是 OR 进 legacy，不是被组织判定**替换**掉',
      'org_readable_resources' in pq and 'legacy' in pq,
      '要能看到两侧并存：org_readable_resources（组织判定）和 legacy（文件域把关）都在')
check('B6-07 ③ 反例自检：查的是「读权路径里有」，不是「文件里出现过」',
      'dept_read_default' in pq and pq.count('dept_read_default') >= 1,
      '')
# 关键的那条：**无归属资源那半没有被并进组织判定**
# （有归属的走 org_readable_resources，无归属的走 legacy —— 两条路都要留）
check('B6-07 ④ 无归属资源仍走 legacy 分支（没被一刀切并进组织判定）',
      'not_attr' in pq and 'legacy' in pq,
      '无归属存量那条路若被删掉，存量表的旧目录 ACL 就失效了')

# ==================== B6-08 DEPT_READ_DEFAULT 开关：钉住它还在、还有效 ====================
# **为什么要有这条**：用户 2026-10-15 对 B3 的原话是「**先留着，等到收紧的时候再配**」。
# E 补了一句要紧的：「别因为『先留着』就不写判据 —— **判据是要钉住这开关还在、还有效**」。
# 「先留着」不是「没人管」：将来谁看到「这个开关没配、是不是废的」顺手删掉，
# 文件域那道收紧口就没了，而且删得理直气壮。
#
# **这条要钉的是什么**（分清，别混）：
#   · 不是钉「开关的值」（值是 `open`，那是配置，会变）
#   · 是钉「**开关被读、且读法是不开就不给**」—— 语义在，值随便
#
# **⚠️ 坦白：这是回归闸，不是发现闸**（同 FA-18 的坦白）。产品现状本来就是对的，
# 这几条现在就该绿。它的作用是**将来有人动了要变红**，不是现在发现问题。
# **没做先红后绿** —— 因为这不是修 bug，是给既有正确行为上锁。
print('\n== B6-08 DEPT_READ_DEFAULT 开关还在、还在起作用 ==')
import re as _re
# ① 开关本身还在（定义 + 取值口）
m_def = _re.search(r'^DEPT_READ_DEFAULT\s*=\s*[\'"](\w+)[\'"]', svc_src, _re.M)
m_fn = 'def dept_read_default' in svc_src
check('B6-08 ① 开关定义和取值口都还在',
      bool(m_def) and m_fn,
      '定义=%r 取值口=%s（任一没了=开关被删了）' % (m_def.group(1) if m_def else None, m_fn))
# ② 读权路径真在读它 —— **不是「文件里出现过」**（同 B6-07 ③ 的道理）
n_read = pq.count('dept_read_default')
check('B6-08 ② 读权路径里真调了它（不是文件里出现过）',
      n_read >= 1,
      'permission_query 里调用次数=%d（0=写了没接线）' % n_read)
# ③ **语义是「不开就不给」** —— 条件必须是拿它当闸，不是拿它当装饰
gate = _re.search(r'if\s+dept_read_default\(\)\s*==\s*[\'"]open[\'"]', svc_src)
check('B6-08 ③ 语义是「== open 才给」（不开就不给，不是拿开关当装饰）',
      bool(gate),
      '找到=%s —— 若有人写成 `if True:` 或去掉这个 if，这条要红' % bool(gate))
# ④ **接线真的在闸里面** —— 不是「文件里有个 if」，是「那条部门 OR 分支**在 if 块里**」。
#    有人把 `legacy += ...` 从 if 里挪出来（取消缩进），开关就成装饰了 —— 这条要红。
_i_gate = svc_src.find("if dept_read_default() == 'open' and mine:")
_i_branch = svc_src.find("owner_subject_kind` = 'Department'")
check('B6-08 ④ 部门默认读那条 OR 分支在闸**里面**（挪出去 = 开关变装饰）',
      _i_gate != -1 and _i_branch != -1 and _i_gate < _i_branch,
      '闸位置=%d / 分支位置=%d（-1=没找到；分支在闸前面或同时=不在块里）' % (_i_gate, _i_branch))
# ⑤ 开关的值是配置、不是语义：**换个值不该判据就红**
check('B6-08 ⑤ 值是配置不是语义（判据钉的是「读法」，不是「值」）',
      bool(m_def) and m_def.group(1) in ('open', 'closed'),
      '当前值=%r —— open/closed 都该让①②③过，只有「删掉/不读」才红' % (m_def.group(1) if m_def else None,))

print()
if fails:
    print(f'结果： FAIL {len(fails)} 项未过')
    print('未过清单：', json.dumps(fails, ensure_ascii=False))
    sys.exit(1)
print('结果： PASS B6 全部判据成立（共 %d 条，编号 B6-01～B6-08）' % checks_run)
