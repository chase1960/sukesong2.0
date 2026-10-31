"""`files.action_proposals` / `files.action_proposal_resolve` —— A 的审核面板在等的两个服务口。

**任务归属**：PKG-010-T01 的**前置**（A 的 `loadProposals()` 调这个端点，404 挡住 5 条判据：
条目级拒绝、修改建议可编辑、同格多候选、过期标识、三类工具呈现）。

**测试通过 = 下面各条成立**：

P-① **服务调得到**：`POST /api/platform/services/files.action_proposals/invoke`
     回 HTTP 200，**不是** 404「领域服务不存在」。
P-② **回包形状对得上前端取值链**：`d.result?.proposals || d.proposals` **真能取到数组**。
     ⚠️ 这条是 identity 那单的教训 —— handler 回裸数组会被 BFF 的
     `res.json({ok:true,...msg})` 摊成 `{ok:true,"0":…}`，**端点通了但前端照旧空，
     「修了等于没修」**。所以必须回 `{proposals:[…]}`。
P-③ **每条带齐 A 要的字段**：`id / capability / payload / content_version /
     structure_version / expired`。
P-④ **按表过滤**：只回指定表的提案；**别的表的不混进来**。
P-⑤ **反例（不许静默空）**：传一个**不存在的 table** → **明确报错**，
     **不是**回空数组让人以为「这表没有待审」。**这条是 P-④ 的命根子** ——
     没它，「过滤」和「什么都查不到」是同一个现象。
P-⑥ **驳回可执行**：`files.action_proposal_resolve` 带 `decision=rejected` → 提案变 Rejected，
     **且独立读回零写**（不是「返回成功但没写」也不是「写了但没说」）。
P-⑦ **`edited_value` 生效**：带 `edited_value` 确认 → 落地的是**编辑后的值**，
     不是提案原值。反例：不带 edited_value 确认 → 落地的是**原值**。
P-⑧ **过期提案不许静默按新版本执行**：提案里的版本对不上当前版本 → `expired=true`；
     强行确认 → **被拒**，不许按当前版本偷偷执行。

---
**边界**：只加这两个**只读/受管服务**，不动内核、不动既有 6 条服务的 handler 与 schema。
P-⑨ **`edited_value` 走内核口**（010-T01 公共部分）：内核
`shangshu_core.public_api.http.action_proposal_resolve` 自己收 `edited_value`、
**在权限检查下**改，领域模块只传参。
**为什么补这条**：`files/proposals.py:100/:115` 今天是领域模块直接 `frappe.get_doc`
内核表 `Shangshu Action Proposal` 改 `payload_json` + `save(ignore_permissions=True)` ——
领域直写内核表、还关了权限检查（红线）。根因是内核口不收 `edited_value`，逼得文件域伸手。
**与 P-⑦ 的区别**：P-⑦ 走领域服务（靠那两行直写才成立），P-⑨ 钉内核口自己成立。
反例齐：不带 edited_value 必落原值（空判据自检）、多格明确拒绝 + 零改动 + 理由点名多格、
裸值拒绝。
P-⑩ **「人改过」留痕**：改 `payload_json` 是**覆盖**，而 doctype `track_changes=None`、
`payload_summary_json` 被 `_summary()` 截断到 500 字 + 脱敏 —— 不另存就**冒领**
（人的改动被记成「助手的稿被采用了」）。留痕后 R5 才能升成「confirmed 但**改动可辨**」。
判据：改值后 `edited` 为真、`edited_by`/`edited_at` 可归因、**`original_payload` 是改前
完整原值（900 字不截断，专打 `_summary` 的 500 字截断）**；反例：不带 edited_value 确认
必须标「未被改过」（若无条件置真 = 空判据）。
**两条路各自成立，不互相代过**：②③④ 钉内核路 `/api/confirmations/:id`；
**⑥ 钉 `files.action_proposal_resolve` 领域服务路**（它自己会重打包 payload，
内核路留痕好不等于这条也好 —— 实测踩过一次，按代码印象下结论说「files 路仍是冒领」，
可代码早就改成传参了：**代码读过 ≠ 验过，结论只认跑出来的**）。
路径在 `frappe_apps/shangshu_files/`（**不在 `core_paths`**），不需要 CORE-CANDIDATE。

**先红后绿**：服务没注册时 P-① 应红。
**反例（故意翻期望）必须能红**，否则判据恒真。

用法：python3 test_files_action_proposals.py [--cases 01,...,10]
"""
import base64
import importlib.util
import json
import os
import sys
import time
from io import BytesIO

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
# **RUN 必须到微秒**：秒级会在同秒重跑时复用幂等键 → 产品正确回 409，看起来像竞态其实不是。
RUN = '%s-%d' % (t.RUN, int(time.time() * 1e6) % 100000000)
VALID = ('01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11')

raw = ''
for i, a in enumerate(sys.argv):
    if a == '--cases' and i + 1 < len(sys.argv):
        raw = sys.argv[i + 1]
want = tuple(x.strip() for x in raw.split(',') if x.strip()) if raw else VALID
if raw and not want:
    print('结果： FAIL --cases 给了空选择'); sys.exit(2)
bad = [x for x in want if x not in VALID]
if bad:
    print('结果： FAIL --cases 有未知用例：%s' % ','.join(bad)); sys.exit(2)

from _ss_cred import CRED as _CRED, pw_of as _pw_of, admin_pw_for
admin_pw = admin_pw_for(BASE)
# 环境变量兜底：CI/别的实例上口令从 `PW_ADMIN` 进，**不写文件**
if not admin_pw:
    admin_pw = os.environ.get('PW_ADMIN') or os.environ.get('SS_D_PW') or None
if not admin_pw:
    print('结果： FAIL 取不到管理员口令（账号文件和 PW_ADMIN 都没有）'); sys.exit(2)

checks_run = 0
failed = []
not_yet = []


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


def notyet(label, why):
    global checks_run
    checks_run += 1
    not_yet.append(label)
    print('  ~ %s — 未测：%s' % (label, why))


def build_plain():
    """干净夹具：4 行 3 列。**必须用 openpyxl 的 `ws.append()`**，不手拼 XML ——
    手拼容易让每行都写成 `<c r="A1">`，openpyxl 按 `<c r=` 归并就全塌进 A1，
    而自研解析器按 `<row r=` 归并照样「读对」，于是看起来像「读得对、一写就冲掉」的
    **产品 bug**，其实是夹具坏。2026-10-14 因此误判过三条。"""
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


def act(c, action, payload, key):
    try:
        st, body = t.action(c, action, payload, key)
    except Exception as e:
        return None, '调用异常:%s' % e
    return (st, body), ('ok' if st == 200 else 'HTTP %s %s' % (st, json.dumps(body, ensure_ascii=False)[:160]))


def result_of(res):
    if not res:
        return {}
    body = res[1] if isinstance(res[1], dict) else {}
    return body.get('result') or body


print('== files.action_proposals / action_proposal_resolve ==')
print('实例：%s　run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)

PW = 'b2-user-pw-2026'


def _login_or_none(username, password=None):
    c = t.Client(BASE)
    try:
        c.login(username, password or PW)
        return c
    except SystemExit:
        return None


owner = _login_or_none('ss-owner@example.invalid')
PROPOSER_IS_SS_OWNER = owner is not None
if owner is None:
    # **前提修正（2026-10-14 实测推翻）**：原先注释写「必须以归属人造，管理员造的批下去会 403」，
    # 并据此在没有 ss-owner 的实例（D 3840）上把 P-②～P-⑩ **九个用例整段记未测**。
    # 实测（探针 probe_propose_admin.py）：**管理员造提案 HTTP 200**，APROP-2026-00001 照样建出来、
    # 照样批得动。那句注释是错的 —— 提案是**流程件**，谁能造由 `_assert_proposable` 管（只看动作
    # 有没有开给 Agent），**真正的写权限在执行时由 `_can_write` 把**（G1-⑪ 已单独验过资源闸）。
    #
    # 这跟 G1-⑩「基线必须落在被拒那侧」同族：**前提写错了，整段就白跳过，而且长得像「环境不齐」
    # 不像「前提写错」**。所以这里退回管理员，并**明说跑的不是同一个身份**，不许当成没差别。
    owner = _login_or_none('Administrator', admin_pw)
    if owner is not None:
        print('  ~ 本实例没有 ss-owner@example.invalid（B 侧专用账号，口令也写死成 B 的）')
        print('    **退回 Administrator 造提案** —— 实测走得通。')
        print('    **注意：跑的不是归属人身份**，「归属人自己造提案」那条语义不在此验证，')
        print('    验的是「过期提案拦不拦 / 零不零写」，那条与造提案的人无关（版本闩在写层）。')
    else:
        print('  ~ 连 Administrator 都登不进 —— 造不出提案，相关用例将记「未测」')

print('\n== 建样本表 ==')
TABLE = None
if owner is None:
    print('  ~ 跳过建表：没有归属人账号')
else:
    res, why = act(owner, 'files.upload', {
        'file_name': 'p-proposals-%s.xlsx' % RUN,
        'content_base64': base64.b64encode(build_plain()).decode(),
        'directory': '/',
        'attribution': {'level': 'personal'},
    }, 'pp-up-%s' % RUN)
    TABLE = result_of(res).get('file')
    check('上传样本表', bool(TABLE), why[:140])


def snap(client=None):
    c = client or owner
    if c is None or not TABLE:
        return None
    st, dat = t.service(c, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 200})
    if st != 200 or not isinstance(dat, dict):
        return None
    cells = {}
    for row in dat.get('rows') or []:
        for header, typed in (row.get('values') or {}).items():
            cells[(row.get('row_id'), header)] = json.dumps(typed, sort_keys=True, ensure_ascii=False)
    return {'cells': cells, 'content_version': dat.get('content_version'),
            'structure_version': dat.get('structure_version'), 'rows': dat.get('rows'),
            'headers': dat.get('headers'), 'row_ids': [r.get('row_id') for r in (dat.get('rows') or [])]}


# Frappe 本体（BFF 端口 +2）造待审提案 —— **必须以归属人造**，管理员造的批下去会 403
import http.cookiejar
import urllib.error
import urllib.request
_frappe = 'http://127.0.0.1:%d' % (int(BASE.rsplit(':', 1)[-1]) + 2)
_jar = http.cookiejar.CookieJar()
_op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))


def _fcall(path, body=None, csrf=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(_frappe + path, data=data, method='POST' if data else 'GET')
    req.add_header('accept', 'application/json')
    if data is not None:
        req.add_header('content-type', 'application/json')
    if csrf:
        req.add_header('X-Frappe-CSRF-Token', csrf)
    try:
        with _op.open(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or '{}')
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {'_err': str(e)}


_csrf = None
if owner is not None:
    # 登 Frappe 本体的身份必须和 `owner` **是同一个人** —— 上面写死 ss-owner，
    # 而 owner 已经退回 Administrator 时，这里会登错人（提案造出来 actor 对不上）。
    _proposer_usr = 'ss-owner@example.invalid' if PROPOSER_IS_SS_OWNER else 'Administrator'
    _proposer_pw = PW if PROPOSER_IS_SS_OWNER else admin_pw
    st_l, _ = _fcall('/api/method/login', {'usr': _proposer_usr, 'pwd': _proposer_pw})
    _, _csrf_d = _fcall('/api/method/shangshu_core.public_api.http.csrf')
    _csrf = ((_csrf_d or {}).get('message') or {}).get('csrf_token')
    check('前置：%s 连到 Frappe 本体并拿到 csrf' % _proposer_usr, st_l == 200 and bool(_csrf),
          'HTTP %s csrf=%s' % (st_l, bool(_csrf)))


def propose(action_id, payload, key):
    st_p, body_p = _fcall('/api/method/shangshu_core.public_api.http.action_propose',
                          {'action_id': action_id, 'payload': payload,
                           'idempotency_key': key, 'source': 'test-proposals'}, _csrf)
    msg = (body_p or {}).get('message') or body_p or {}
    return st_p, (msg if isinstance(msg, dict) else {})


# ---------- 别的表（用来验「按表过滤」不混进来） ----------
OTHER = None
if owner is not None:
    res, why = act(owner, 'files.upload', {
        'file_name': 'p-proposals-other-%s.xlsx' % RUN,
        'content_base64': base64.b64encode(build_plain()).decode(),
        'directory': '/', 'attribution': {'level': 'personal'},
    }, 'pp-up2-%s' % RUN)
    OTHER = result_of(res).get('file')
    check('上传「别的表」（验按表过滤不混进来）', bool(OTHER), why[:120])

# **连 Administrator 都登不进时**才记未测（上面已先试 ss-owner、再退回 Administrator）。
# 2026-10-14 修正：原先「没有 ss-owner 就整段跳过」是**假前提**造成的（见上方注释），
# 九个用例白跳。现在只有**两个身份都拿不到**才跳，理由也照实写「登不进」而不是「缺专用账号」。
if owner is None:
    _skip = [c for c in want if c not in ('01', '05')]
    if _skip:
        print('\n== 以下用例要建样表/造提案，本实例连 Administrator 都登不进，如实记未测 ==')
        for _c in _skip:
            notyet('P-%s（用例 %s）' % ({'02': '② 回包形状', '03': '③ 字段齐', '04': '④ 按表过滤',
                                       '06': '⑥ 驳回零写', '07': '⑦ edited_value',
                                       '08': '⑧ 过期提案',
                                       '09': '⑨ edited_value 走内核口',
                                       '10': '⑩ 人改过留痕'}.get(_c, _c), _c),
                   'ss-owner 与 Administrator 都登不进本实例，造不出样表和提案')
    want = tuple(c for c in want if c in ('01', '05'))

# ---------- 造提案 ----------
PROPOSAL_ID = None
if owner is not None and TABLE:
    s = snap()
    res, why = act(owner, 'files.sheet_cells_write', {
        'table': TABLE,
        'expected_content_version': int(s['content_version']),
        'expected_structure_version': int(s['structure_version']),
        'op_id': 'pp-w-%s' % RUN,
        'cells': [{'row_id': s['row_ids'][0], 'header': '数值',
                   'value': {'type': 'number', 'value': 42}}],
    }, 'pp-w-%s' % RUN)
    check('前置：先写一格（让表有内容、版本有基线）', bool(res) and res[0] == 200, why[:120])
    s2 = snap()
    # **只能给「开给 Agent 的动作」造提案**（`_assert_proposable`）。
    # `files.sheet_cell_write`（单格写）**没进 tools**，造提案回 403
    # 「该动作未开放给 Agent」；批量写 `files.sheet_cells_write` 在 tools 里，用它。
    st_p, pr = propose('files.sheet_cells_write', {
        'table': TABLE,
        'expected_content_version': int(s2['content_version']),
        'expected_structure_version': int(s2['structure_version']),
        'op_id': 'pp-propose-%s' % RUN,
        'cells': [{'row_id': s2['row_ids'][1], 'header': '数值',
                   'value': {'type': 'number', 'value': 7}}],
    }, 'pp-propose-%s' % RUN)
    PROPOSAL_ID = pr.get('id')
    check('前置：造出待审提案', st_p == 200 and bool(PROPOSAL_ID),
          'HTTP %s id=%r capability=%r err=%s' % (st_p, PROPOSAL_ID, pr.get('capability'),
                                                  str(pr.get('error') or pr.get('exception') or pr)[:150]))

# ========================= P-① 服务调得到 =========================
if '01' in want:
    print('\n== P-① 服务调得到 ==')
    # **判据修正（2026-10-14）**：原先写「HTTP 200」，拿一个不存在的表去调当然 404，
    # 于是**分不清是「服务没注册」还是「表不存在」** —— A 侧服务明明已生效却被判红。
    # 真正该成立的是：**错因不是「领域服务不存在」**（服务在），表对不对是 P-④/⑤ 的事。
    st, dat = t.service(adm, 'files.action_proposals', {'table': TABLE or 'x'})
    err_text = str(dat)
    svc_missing = '领域服务不存在' in err_text
    check('P-① 服务已注册（错因不是「领域服务不存在」）', not svc_missing,
          'HTTP %s  错因=%s' % (st, err_text[:150]))
    if TABLE:
        st2, dat2 = t.service(adm, 'files.action_proposals', {'table': TABLE})
        check('P-① ② 用真表调得到 HTTP 200', st2 == 200, 'HTTP %s %s' % (st2, str(dat2)[:130]))
    else:
        notyet('P-① ② 用真表调得到 HTTP 200', '本实例没有归属人账号，建不了样表')

# ========================= P-② 形状对得上前端取值链 =========================
if '02' in want:
    print('\n== P-② 回包形状对得上前端取值链 ==')
    st, dat = t.service(owner or adm, 'files.action_proposals', {'table': TABLE or 'x'})
    body = dat if isinstance(dat, dict) else {}
    # **前端取值链**：`d.result?.proposals || d.proposals`
    got = (body.get('result') or {}).get('proposals') if isinstance(body.get('result'), dict) else None
    if got is None:
        got = body.get('proposals')
    check('P-② d.result?.proposals || d.proposals 真能取到数组',
          isinstance(got, list),
          '顶层键=%s result.proposals=%s d.proposals=%s' %
          (sorted(body.keys())[:8],
           type((body.get('result') or {}).get('proposals') if isinstance(body.get('result'), dict) else None).__name__,
           type(body.get('proposals')).__name__))
    # **反例**：裸数组会被摊成 {ok:true,"0":…} —— 那种形状这里必须红
    spread = any(k.isdigit() for k in body.keys())
    check('P-② 反例：回包没被摊成 {ok:true,"0":…}（裸数组会这样）',
          not spread, '出现数字键=%s' % [k for k in body if k.isdigit()][:5])

# ========================= P-③ 字段齐 =========================
if '03' in want and PROPOSAL_ID:
    print('\n== P-③ 每条带齐 A 要的字段 ==')
    st, dat = t.service(owner, 'files.action_proposals', {'table': TABLE})
    body = dat if isinstance(dat, dict) else {}
    lst = (body.get('result') or {}).get('proposals') or body.get('proposals') or []
    mine = [p for p in lst if isinstance(p, dict) and p.get('id') == PROPOSAL_ID]
    check('P-③ ① 待审提案出现在列表里', bool(mine), '列表 %d 条，命中 %d 条' % (len(lst), len(mine)))
    if mine:
        p = mine[0]
        need = ('id', 'capability', 'payload', 'content_version', 'structure_version', 'expired')
        missing = [k for k in need if k not in p]
        check('P-③ ② 字段齐（id/capability/payload/content_version/structure_version/expired）',
              not missing, '缺=%s 实有=%s' % (missing, sorted(p.keys())))

# ========================= P-④ 按表过滤 =========================
if '04' in want and PROPOSAL_ID and OTHER:
    print('\n== P-④ 按表过滤 ==')
    st, dat = t.service(owner, 'files.action_proposals', {'table': OTHER})
    body = dat if isinstance(dat, dict) else {}
    lst = (body.get('result') or {}).get('proposals') or body.get('proposals') or []
    leak = [p for p in lst if isinstance(p, dict) and p.get('id') == PROPOSAL_ID]
    check('P-④ 别的表查不到这张表的提案（不混进来）',
          not leak, '别的表返回 %d 条，泄漏 %d 条' % (len(lst), len(leak)))
    st2, dat2 = t.service(owner, 'files.action_proposals', {'table': TABLE})
    lst2 = ((dat2 or {}).get('result') or {}).get('proposals') or (dat2 or {}).get('proposals') or []
    hit2 = [p for p in lst2 if isinstance(p, dict) and p.get('id') == PROPOSAL_ID]
    check('P-④ 正对照：本表能查到（证明上一条不是「什么都没查到」）',
          bool(hit2), '本表 %d 条，命中 %d 条' % (len(lst2), len(hit2)))

# ========================= P-⑤ 反例：不存在的 table 明确报错 =========================
if '05' in want:
    print('\n== P-⑤ 反例：不存在的 table 不许静默空 ==')
    st, dat = t.service(owner or adm, 'files.action_proposals', {'table': 'no-such-table-%s' % RUN})
    body = dat if isinstance(dat, dict) else {}
    err = '%s %s' % (body.get('error', ''), body.get('message', ''))
    lst = (body.get('result') or {}).get('proposals') if isinstance(body.get('result'), dict) else None
    if lst is None:
        lst = body.get('proposals')
    check('P-⑤ 不存在的 table 明确报错（不是回空数组让人以为「这表没有待审」）',
          st != 200 and bool(err.strip()),
          'HTTP %s  err=%r  proposals=%s' % (st, err.strip()[:120], '空数组' if lst == [] else type(lst).__name__))
    # 反例自检：错的不是「什么都返回 200」
    if TABLE:
        check('P-⑤ 反例自检：正常 table 仍是 200（证明不是「一律报错」）',
              (t.service(owner or adm, 'files.action_proposals', {'table': TABLE})[0]) == 200, '')
    else:
        notyet('P-⑤ 反例自检：正常 table 仍是 200', '本实例没有归属人账号，建不了样表')

# ========================= P-⑥ 驳回可执行 + 零写 =========================
if '06' in want and PROPOSAL_ID:
    print('\n== P-⑥ 驳回可执行，且零写 ==')
    before = snap()
    st, dat = t.service(owner, 'files.action_proposal_resolve',
                        {'proposal_id': PROPOSAL_ID, 'decision': 'rejected'})
    check('P-⑥ ① 驳回请求本身成功（不许静默失败当成功）', st == 200,
          'HTTP %s %s' % (st, str(dat)[:140]))
    after = snap()
    check('P-⑥ ② 驳回后独立读回零写（逐格不变）',
          bool(before) and bool(after) and before['cells'] == after['cells'],
          '变动格数=%d' % sum(1 for k in (before or {}).get('cells', {})
                            if (after or {}).get('cells', {}).get(k) != (before or {}).get('cells', {})[k]))

# ========================= P-⑦ edited_value 生效 =========================
if '07' in want:
    print('\n== P-⑦ edited_value 生效（改进建议可编辑）==')
    s = snap()
    # `edited_value` 的语义（本文件定的，改要同步改这里）：
    #   带类型值 `{type,value}`。确认时**替换目标格的值**再执行 ——
    #   payload 有 `value` 键就换它；没有但有 `cells` 数组就换 `cells[0].value`
    #   （多格提案不支持逐格编辑，明确拒绝，不猜）。
    st_p, pr = propose('files.sheet_cells_write', {
        'table': TABLE,
        'expected_content_version': int(s['content_version']),
        'expected_structure_version': int(s['structure_version']),
        'op_id': 'pp-edited-%s' % RUN,
        'cells': [{'row_id': s['row_ids'][0], 'header': '备注',
                   'value': {'type': 'text', 'value': '原提案值'}}],
    }, 'pp-edited-%s' % RUN)
    pid = pr.get('id')
    check('P-⑦ ① 造出待审提案', st_p == 200 and bool(pid),
          'HTTP %s id=%r err=%s' % (st_p, pid, str(pr.get('error') or '')[:110]))
    before = snap()
    st, dat = t.service(owner, 'files.action_proposal_resolve',
                        {'proposal_id': pid, 'decision': 'confirmed',
                         'edited_value': {'type': 'text', 'value': '编辑后的值'}})
    check('P-⑦ ② 带 edited_value 确认成功', st == 200, 'HTTP %s %s' % (st, str(dat)[:140]))
    after = snap()
    val = (after or {}).get('cells', {}).get((s['row_ids'][0], '备注'))
    check('P-⑦ ③ 落地的是**编辑后的值**，不是提案原值',
          val is not None and '编辑后的值' in str(val) and '原提案值' not in str(val),
          '落地=%r' % (val,))
    check('P-⑦ ④ 反例自检：原值没被写进去',
          '原提案值' not in str(val), '落地=%r' % (val,))

# ========================= P-⑧ 过期提案不许静默执行 =========================
if '08' in want:
    print('\n== P-⑧ 过期提案不许静默按新版本执行 ==')
    s = snap()
    st_p, pr = propose('files.sheet_cells_write', {
        'table': TABLE,
        'expected_content_version': int(s['content_version']),
        'expected_structure_version': int(s['structure_version']),
        'op_id': 'pp-expire-%s' % RUN,
        'cells': [{'row_id': s['row_ids'][0], 'header': '名称',
                   'value': {'type': 'text', 'value': '过期提案的值'}}],
    }, 'pp-expire-%s' % RUN)
    pid = pr.get('id')
    check('P-⑧ ① 造出待审提案', st_p == 200 and bool(pid),
          'HTTP %s id=%r err=%s' % (st_p, pid, str(pr.get('error') or '')[:110]))
    # **让版本过期**：加一列推 structure_version
    s2 = snap()
    act(owner, 'files.sheet_column_append', {
        'table': TABLE, 'expected_content_version': int(s2['content_version']),
        'expected_structure_version': int(s2['structure_version']), 'header': '让版本过期的列',
    }, 'pp-expire-col-%s' % RUN)
    st, dat = t.service(owner, 'files.action_proposals', {'table': TABLE})
    body = dat if isinstance(dat, dict) else {}
    lst = (body.get('result') or {}).get('proposals') or body.get('proposals') or []
    mine = [p for p in lst if isinstance(p, dict) and p.get('id') == pid]
    check('P-⑧ ② 过期后 expired 标识为真', bool(mine) and mine[0].get('expired') is True,
          'expired=%r structure_version=%r' % ((mine[0].get('expired') if mine else None),
                                            (mine[0].get('structure_version') if mine else None)))

    # —— ③④ 这两条是本用例的正题 ——
    # **断言修正（2026-10-14，E 要求「不许为绿而放宽」）**：原先写
    #   `st2 != 200 or not changed`
    # 是 **OR** —— 只要 HTTP 没回 200（哪怕 500 炸了、哪怕 404 找不到提案），后半句**根本不看**，
    # 于是「表被改了但接口报错」也会绿。**空过长得跟过一模一样**（同 G1-⑩/G1-⑪ 那两个坑）。
    # 现在拆成两条独立咬：**必须被拒**（且报错点名版本冲突）**和** **必须零写**（四项逐项比）。
    before = snap()
    st2, dat2 = t.service(owner, 'files.action_proposal_resolve',
                          {'proposal_id': pid, 'decision': 'confirmed'})
    after = snap()
    txt2 = ''
    if isinstance(dat2, dict):
        txt2 = str(dat2.get('error') or dat2.get('message') or dat2.get('detail') or '')
    check('P-⑧ ③ 强行确认过期提案 → **被拒**（不是悄悄按当前版本执行）',
          st2 != 200,
          'HTTP %s %s' % (st2, txt2[:130]))
    check('P-⑧ ③′ 拒因点名**版本冲突**（不是别的错碰巧拒了 —— 拒因不对就没有证明力）',
          ('版本' in txt2) or ('已被其他操作修改' in txt2) or ('conflict' in txt2.lower()),
          '拒因=%s' % txt2[:130])
    zw_cells = (before or {}).get('cells') == (after or {}).get('cells')
    zw_headers = (before or {}).get('headers') == (after or {}).get('headers')
    zw_cv = (before or {}).get('content_version') == (after or {}).get('content_version')
    zw_sv = (before or {}).get('structure_version') == (after or {}).get('structure_version')
    check('P-⑧ ④ **零写**：拒完表一个字节没动（格子/表头/内容版本/结构版本 逐项比）',
          zw_cells and zw_headers and zw_cv and zw_sv,
          '格子同=%s 表头同=%s cv 同=%s（前 %s 后 %s）sv 同=%s' % (
              zw_cells, zw_headers, zw_cv, (before or {}).get('content_version'),
              (after or {}).get('content_version'), zw_sv))

    # —— ⑤ **对照**：不过期的提案批得动。分不出「拦了」和「接口坏了」就不算数 ——
    s3 = snap()
    st_c, pr_c = propose('files.sheet_cells_write', {
        'table': TABLE,
        'expected_content_version': int(s3['content_version']),
        'expected_structure_version': int(s3['structure_version']),
        'op_id': 'pp-expire-ctrl-%s' % RUN,
        'cells': [{'row_id': s3['row_ids'][0], 'header': '备注',
                   'value': {'type': 'text', 'value': '对照：不过期'}}],
    }, 'pp-expire-ctrl-%s' % RUN)
    pid_c = pr_c.get('id')
    st_rc, dat_rc = t.service(owner, 'files.action_proposal_resolve',
                              {'proposal_id': pid_c, 'decision': 'confirmed'})
    after_c = snap()
    ctrl_wrote = (after_c or {}).get('cells') != (s3 or {}).get('cells')
    check('P-⑧ ⑤ **对照**：不过期的提案批得动（不然分不出「拦了」和「接口坏了」）',
          st_c == 200 and st_rc == 200 and ctrl_wrote,
          '造=%s 采用=%s 写进去了=%s' % (st_c, st_rc, ctrl_wrote))

    # —— ⑥ 判别式自检：过不过必须由「拒 + 零写 + 对照能写」三者共同决定 ——
    def _p8_ok(rejected, zero_write, ctrl_ok):
        return bool(rejected) and bool(zero_write) and bool(ctrl_ok)

    v_ok = _p8_ok(True, True, True)     # 该有的形状
    v_silent = _p8_ok(False, True, True)   # 没拒 = 静默按新版本执行（本条要防的洞）
    v_half = _p8_ok(True, False, True)     # 拒了但落了一半
    v_dead = _p8_ok(True, True, False)     # 对照也写不进 = 接口本来就坏，不是「拦了」
    vv = {'ok': v_ok, 'silent_exec': v_silent, 'half_wrote': v_half, 'iface_dead': v_dead}
    check('P-⑧ ⑥ 敏感度：判别式认「拒了 + 零写 + 对照能写」为过', v_ok, 'ok')
    check('P-⑧ ⑥ 敏感度：判别式认「没拒（静默按新版本执行）」为不过', not v_silent, 'silent_exec')
    check('P-⑧ ⑥ 敏感度：判别式认「拒了但落了一半」为不过', not v_half, 'half_wrote')
    check('P-⑧ ⑥ 敏感度：判别式认「对照也写不进（接口坏了）」为不过', not v_dead, 'iface_dead')
    check('P-⑧ ⑥ 敏感度：四种形状给出两种不同结论（不是恒真/恒假）',
          len(set(vv.values())) == 2, '结论=%r' % vv)

def core_resolve(client, proposal_id, decision, edited=None):
    """走 **BFF 的公共 HTTP API**（`/api/confirmations/:id`）—— A/C/D 真正调的口。

    **不走 `/api/method/...` 直连**：那条被 `platform-legacy-policy.ts` 闸门 410
    `LEGACY_SURFACE_DISABLED` 挡掉（实测踩到过），不是合法入口。
    P-⑨ 与 P-⑩ 共用（公共工具只留一份）。
    """
    body = {'decision': decision}
    if edited is not None:
        body['edited_value'] = edited
    return client.request('POST', '/api/confirmations/%s' % proposal_id, body)


# ==================== P-⑨ edited_value 走内核口（010-T01 公共部分）====================
# **P-⑦ 与 P-⑨ 的区别**：P-⑦ 走 `files.action_proposal_resolve`（领域服务），
# 靠 `files/proposals.py:100/:115` 直接改内核表 `payload_json` + `save(ignore_permissions=True)`
# 才成立 —— 领域直写内核表、还关了权限检查（红线）。P-⑨ 钉的是**内核口自己收 `edited_value`**，
# 补完 D 才能把那两行删掉改传参。
if '09' in want:
    print('\n== P-⑨ edited_value 走内核口（领域模块不再需要直写内核表）==')

    def landed(row_id, header):
        a = snap()
        v = (a or {}).get('cells', {}).get((row_id, header))
        return v

    s = snap()
    st_p, pr = propose('files.sheet_cells_write', {
        'table': TABLE,
        'expected_content_version': int(s['content_version']),
        'expected_structure_version': int(s['structure_version']),
        'op_id': 'pp-core-edited-%s' % RUN,
        'cells': [{'row_id': s['row_ids'][0], 'header': '备注',
                   'value': {'type': 'text', 'value': '内核口提案原值'}}],
    }, 'pp-core-edited-%s' % RUN)
    pid = pr.get('id')
    check('P-⑨ ① 造出待审提案', st_p == 200 and bool(pid),
          'HTTP %s id=%r err=%s' % (st_p, pid, str(pr.get('error') or '')[:110]))
    if not pid:
        notyet('P-⑨ ②~⑥', '提案没造出来')
    else:
        st, dat = core_resolve(owner, pid, 'confirmed', {'type': 'text', 'value': '内核口编辑后'})
        # **只判 HTTP 200 是空判据** —— 实测踩到过：BFF 只转发 proposal_id/decision，
        # `edited_value` 被**静默丢弃**，请求照样 200，落地还是原值。
        # 这里要钉的是「传了参数却不认 = 必须报错」，正是契约 010-③ 失败回执。
        landed_ok = landed(s['row_ids'][0], '备注')
        honored = landed_ok is not None and '内核口编辑后' in str(landed_ok)
        check('P-⑨ ② edited_value 被受理（不许静默丢弃）',
              st == 200 and honored,
              'HTTP %s 落地=%r（若落地还是原值，说明 edited_value 被静默丢弃）' % (st, landed_ok))
        val = landed(s['row_ids'][0], '备注')
        check('P-⑨ ③ 落地的是编辑后的值，不是提案原值',
              val is not None and '内核口编辑后' in str(val) and '内核口提案原值' not in str(val),
              '落地=%r' % (val,))

        # 反例（空判据自检）：不带 edited_value 走内核口 → 必须落原值
        s2 = snap()
        st_p2, pr2 = propose('files.sheet_cells_write', {
            'table': TABLE,
            'expected_content_version': int(s2['content_version']),
            'expected_structure_version': int(s2['structure_version']),
            'op_id': 'pp-core-noedit-%s' % RUN,
            'cells': [{'row_id': s2['row_ids'][0], 'header': '备注',
                       'value': {'type': 'text', 'value': '不带编辑时的原值'}}],
        }, 'pp-core-noedit-%s' % RUN)
        pid2 = pr2.get('id')
        if not pid2:
            notyet('P-⑨ ④ 反例：不带 edited_value 落原值', '第二条提案没造出来')
        else:
            st2, dat2 = core_resolve(owner, pid2, 'confirmed')
            v2 = landed(s2['row_ids'][0], '备注')
            check('P-⑨ ④ 反例：不带 edited_value 走内核口落**原值**',
                  st2 == 200 and v2 is not None and '不带编辑时的原值' in str(v2),
                  'HTTP %s 落地=%r（若等于「内核口编辑后」说明 edited_value 被无条件套用 = 空判据）'
                  % (st2, v2))

        # 多格提案：明确拒绝 + 零改动 + 理由点名多格
        s3 = snap()
        st_p3, pr3 = propose('files.sheet_cells_write', {
            'table': TABLE,
            'expected_content_version': int(s3['content_version']),
            'expected_structure_version': int(s3['structure_version']),
            'op_id': 'pp-core-multi-%s' % RUN,
            'cells': [{'row_id': s3['row_ids'][0], 'header': '备注',
                       'value': {'type': 'text', 'value': '多格甲'}},
                      {'row_id': s3['row_ids'][1] if len(s3['row_ids']) > 1 else s3['row_ids'][0],
                       'header': '数值',
                       'value': {'type': 'number', 'value': 7}}],
        }, 'pp-core-multi-%s' % RUN)
        pid3 = pr3.get('id')
        if not pid3:
            notyet('P-⑨ ⑤ 多格明确拒绝', '多格提案没造出来')
        else:
            before = snap()
            st3, dat3 = core_resolve(owner, pid3, 'confirmed', {'type': 'text', 'value': '想改某格'})
            after = snap()
            msg = str((dat3 or {}).get('error') or dat3)[:140] if isinstance(dat3, dict) else str(dat3)[:140]
            names_multi = any(k in msg for k in ('单值', '多格', '逐格', 'cells'))
            # **只判「没成功」是空判据** —— 被 410/网关/旧接口闸门拦下也会「没成功」。
            # 只认「理由点名多格/非单值」这一种拒绝，其它一律不算数。
            check('P-⑨ ⑤ 多格提案带 edited_value 被明确拒绝（理由点名多格/非单值）',
                  st3 != 200 and names_multi, 'HTTP %s 理由=%s' % (st3, msg))
            check('P-⑨ ⑤ 拒绝后零改动',
                  (before or {}).get('cells') == (after or {}).get('cells'),
                  '内容变了=%s' % ((before or {}).get('cells') != (after or {}).get('cells')))
            # 错因自检：若理由是闸门/网关/未接入，说明被别的东西拦了 —— 那这条是假绿，要红
            wrong_reason = any(k in msg for k in ('LEGACY_SURFACE', '旧版能力', '未接入', '停用', '404', '不存在'))
            check('P-⑨ ⑤ 错因自检：拒绝理由不是「闸门/未接入」冒充',
                  not wrong_reason, '理由=%s' % msg)

        # 裸值必须拒（对齐 files 侧既有语义：edited_value 须带 type）
        s5 = snap()
        st_p5, pr5 = propose('files.sheet_cells_write', {
            'table': TABLE,
            'expected_content_version': int(s5['content_version']),
            'expected_structure_version': int(s5['structure_version']),
            'op_id': 'pp-core-raw-%s' % RUN,
            'cells': [{'row_id': s5['row_ids'][0], 'header': '备注',
                       'value': {'type': 'text', 'value': '裸值测试原值'}}],
        }, 'pp-core-raw-%s' % RUN)
        pid5 = pr5.get('id')
        if not pid5:
            notyet('P-⑨ ⑥ 裸值被拒', '第五条提案没造出来')
        else:
            st5, dat5 = core_resolve(owner, pid5, 'confirmed', '裸字符串不是值对象')
            msg5 = str((dat5 or {}).get('error') or dat5)[:140] if isinstance(dat5, dict) else str(dat5)[:140]
            names_raw = any(k in msg5 for k in ('type', '值对象', 'edited_value', '带 type'))
            wrong5 = any(k in msg5 for k in ('LEGACY_SURFACE', '旧版能力', '未接入', '停用'))
            # 同样只判「没成功」是空判据 —— 必须点名 edited_value 该是值对象
            check('P-⑨ ⑥ edited_value 裸值被明确拒绝（理由点名须是带 type 的值对象）',
                  st5 != 200 and names_raw and not wrong5, 'HTTP %s 理由=%s' % (st5, msg5))

# ==================== P-⑩ 「人改过」留痕 —— 不许冒领助手原稿 ====================
# **为什么必须有这条**：`edited_value` 改 `payload_json` 是**覆盖**，而 doctype
# `track_changes=None`（Frappe 版本历史没开）、`payload_summary_json` 又被 `_summary()`
# **截断到 500 字 + 脱敏**。不另存就「助手原稿查不到、人改过不可辨」——
# `status=confirmed` 就成了**把人的改动冒领成『助手的稿被采用了』**（C 的 R5）。
# 留痕齐了之后 R5 才能升成「confirmed 但**改动可辨**」。
if '10' in want:
    print('\n== P-⑩ 「人改过」留痕（原值不截断、改动可归因）==')

    LONG = 'x' * 900   # >500 字 —— 专打 `_summary()` 的截断，看原值是不是完整留下的
    s = snap()
    st_p, pr = propose('files.sheet_cells_write', {
        'table': TABLE,
        'expected_content_version': int(s['content_version']),
        'expected_structure_version': int(s['structure_version']),
        'op_id': 'pp-trace-%s' % RUN,
        'cells': [{'row_id': s['row_ids'][0], 'header': '备注',
                   'value': {'type': 'text', 'value': LONG}}],
    }, 'pp-trace-%s' % RUN)
    pid = pr.get('id')
    check('P-⑩ ① 造出待审提案（原值是 900 字长串）', st_p == 200 and bool(pid),
          'HTTP %s id=%r' % (st_p, pid))
    if not pid:
        notyet('P-⑩ ②~④', '提案没造出来')
    else:
        # ②~④ 走**内核路**（`/api/confirmations/:id`）—— A/C/D 真正调的公共口。
        # files 路的同一件事在 ⑥ 单独钉（两条路各自成立，不互相代过）。
        st, dat = core_resolve(owner, pid, 'confirmed', {'type': 'text', 'value': '人改后的短值'})
        body = dat if isinstance(dat, dict) else {}
        # 内核公共口经 BFF 回 `{ok:true, ..._proposal_public(...)}` —— 提案字段摊在顶层。
        pub = body.get('proposal') if isinstance(body.get('proposal'), dict) else body
        check('P-⑩ ② 确认回包带「人改过」标记', pub.get('edited') is True,
              'edited=%r（回包字段：%s）' % (pub.get('edited'), ','.join(sorted(pub.keys())[:12])))

        # **原值必须完整**，不许是 _summary() 那种截断摘要
        orig = pub.get('original_payload')
        orig_val = None
        if isinstance(orig, dict):
            cells = orig.get('cells')
            if isinstance(cells, list) and cells:
                v = cells[0].get('value')
                orig_val = v.get('value') if isinstance(v, dict) else v
            elif 'value' in orig:
                v = orig.get('value')
                orig_val = v.get('value') if isinstance(v, dict) else v
        check('P-⑩ ③ 原值完整留下（900 字不截断）',
              orig_val is not None and len(str(orig_val)) == 900,
              '原值长度=%s（900=完整；500~503=被 _summary 截断=不算留痕）'
              % (len(str(orig_val)) if orig_val is not None else None))

        check('P-⑩ ④ 改值人/改值时间可归因',
              bool(pub.get('edited_by')) and bool(pub.get('edited_at')),
              'edited_by=%r edited_at=%r' % (pub.get('edited_by'), pub.get('edited_at')))

        # 反例（空判据自检）：不带 edited_value 确认 → 必须**不可辨**地标着「没被改过」
        s2 = snap()
        st_p2, pr2 = propose('files.sheet_cells_write', {
            'table': TABLE,
            'expected_content_version': int(s2['content_version']),
            'expected_structure_version': int(s2['structure_version']),
            'op_id': 'pp-trace-noedit-%s' % RUN,
            'cells': [{'row_id': s2['row_ids'][0], 'header': '备注',
                       'value': {'type': 'text', 'value': '没人改过的值'}}],
        }, 'pp-trace-noedit-%s' % RUN)
        pid2 = pr2.get('id')
        if not pid2:
            notyet('P-⑩ ⑤ 反例：没改过必须标「未改」', '第二条提案没造出来')
        else:
            st2, dat2 = core_resolve(owner, pid2, 'confirmed')
            body2 = dat2 if isinstance(dat2, dict) else {}
            pub2 = body2.get('proposal') if isinstance(body2.get('proposal'), dict) else body2
            # **字段必须在场且为假** —— `None` 也算不到账：字段压根不存在时 `.get('edited')`
            # 同样回 None，那就成了「什么都没有」冒充「标着未被改过」（实测踩到过）。
            check('P-⑩ ⑤ 反例：不带 edited_value 确认 → 标着「未被改过」',
                  'edited' in pub2 and not pub2.get('edited'),
                  'edited 键在场=%s edited=%r（字段缺失或为真都不算）'
                  % ('edited' in pub2, pub2.get('edited')))

        # ⑥ **files 路的留痕** —— 与 ②③④ 的内核路**各自成立，不互相代过**。
        # 为什么必须单独钉：`files.action_proposal_resolve` 是领域服务口，它自己会
        # **重打包 payload**。判过内核路留痕好，不等于这条也留痕（实测踩过一次：
        # 我按代码印象说「files 路仍是冒领」，可代码早就改成传参了 ——
        # **代码读过 ≠ 验过，结论只认跑出来的**）。
        s3 = snap()
        st_p3, pr3 = propose('files.sheet_cells_write', {
            'table': TABLE,
            'expected_content_version': int(s3['content_version']),
            'expected_structure_version': int(s3['structure_version']),
            'op_id': 'pp-trace-files-%s' % RUN,
            'cells': [{'row_id': s3['row_ids'][0], 'header': '备注',
                       'value': {'type': 'text', 'value': 'F' * 900}}],
        }, 'pp-trace-files-%s' % RUN)
        pid3 = pr3.get('id')
        if not pid3:
            notyet('P-⑩ ⑥ files 路留痕', '第三条提案没造出来')
        else:
            st3, dat3 = t.service(owner, 'files.action_proposal_resolve',
                                  {'proposal_id': pid3, 'decision': 'confirmed',
                                   'edited_value': {'type': 'text', 'value': 'files 路改后的短值'}})
            body3 = dat3 if isinstance(dat3, dict) else {}
            # 领域服务口回 `{proposal: <内核 _proposal_public 的形状>, …}`（proposals.py:107）
            pub3 = body3.get('proposal') if isinstance(body3.get('proposal'), dict) else {}
            check('P-⑩ ⑥ files 路确认成功且带「人改过」标记',
                  st3 == 200 and pub3.get('edited') is True,
                  'HTTP %s edited=%r（回包顶层：%s）' % (st3, pub3.get('edited'), ','.join(sorted(body3.keys())[:8])))
            orig3 = pub3.get('original_payload')
            val3 = None
            if isinstance(orig3, dict):
                cells3 = orig3.get('cells')
                if isinstance(cells3, list) and cells3:
                    v3 = cells3[0].get('value')
                    val3 = v3.get('value') if isinstance(v3, dict) else v3
                elif 'value' in orig3:
                    v3 = orig3.get('value')
                    val3 = v3.get('value') if isinstance(v3, dict) else v3
            check('P-⑩ ⑥ files 路原值完整留下（900 字不截断）',
                  val3 is not None and len(str(val3)) == 900,
                  '原值长度=%s' % (len(str(val3)) if val3 is not None else None))
            check('P-⑩ ⑥ files 路改值人/改值时间可归因',
                  bool(pub3.get('edited_by')) and bool(pub3.get('edited_at')),
                  'edited_by=%r edited_at=%r' % (pub3.get('edited_by'), pub3.get('edited_at')))

# ==================== P-⑪ 前提反例：造提案**不**限定归属人 ====================
# **本用例钉的是「夹具前提」本身，不是业务功能** —— 所以它自给自足（自己建表、自己造提案），
# 不吃上面那份共用夹具的 TABLE，免得夹具一变它跟着变、钉不住东西。
#
# **测试通过 =** 一个**不是 ss-owner** 的身份（本实例是 Administrator）能：
#   造出待审提案（HTTP 200）→ 列表里查得到 → 采用得动（HTTP 200 且真写进去了）。
#
# **为什么要有这条**：原先夹具注释写「必须以归属人造，管理员造的批下去会 403」，
# 并据此把 P-②～P-⑩ **九个用例整段跳过**。2026-10-14 实测推翻：管理员 HTTP 200 造得出来、
# 也批得动。**那句话是错的** —— 提案是流程件，谁能造由 `_assert_proposable` 管（只看动作有没有
# 开给 Agent）；**真正的写权限在执行时由 `_can_write` 把**（G1-⑪ 已单独验过角色闸 + 资源闸）。
#
# **没有这条判据，下一个人看到注释又会把它改回「必须归属人」** —— 九个用例再白跳一轮，
# 而且长得像「环境不齐」不像「前提写错」（同 G1-⑩「基线必须落在被拒那侧」那族病）。
if '11' in want:
    print('\n== P-⑪ 前提反例：造提案不限定归属人 ==')
    T11 = None
    res11, why11 = act(owner, 'files.upload', {
        'file_name': 'p-premise-%s.xlsx' % RUN,
        'content_base64': base64.b64encode(build_plain()).decode(),
        'directory': '/', 'attribution': {'level': 'personal'},
    }, 'pp-premise-up-%s' % RUN)
    T11 = result_of(res11).get('file')
    check('P-⑪ ① 自给自足建出样表（不吃共用夹具）', bool(T11), why11[:120])

    st_r, b_r = t.service(owner, 'files.sheet_read', {'table': T11})
    rr = (b_r.get('result') or b_r) if isinstance(b_r, dict) else {}
    rows11 = rr.get('rows') or []
    row11 = rows11[0].get('row_id') if rows11 else None
    check('P-⑪ ② 读得出基线版本（造提案要钉版本）',
          bool(row11) and rr.get('content_version') is not None,
          'row=%s cv=%s sv=%s' % (row11, rr.get('content_version'), rr.get('structure_version')))

    st_pp, pr_pp = propose('files.sheet_cells_write', {
        'table': T11,
        'expected_content_version': int(rr.get('content_version') or 1),
        'expected_structure_version': int(rr.get('structure_version') or 1),
        'op_id': 'pp-premise-%s' % RUN,
        'cells': [{'row_id': row11, 'header': '名称',
                   'value': {'type': 'text', 'value': '前提反例的值'}}],
    }, 'pp-premise-%s' % RUN)
    pid_pp = pr_pp.get('id')
    check('P-⑪ ③ **不是 ss-owner 也造得出待审提案**（反例：那句「必须归属人、管理员会 403」是错的）',
          st_pp == 200 and bool(pid_pp),
          '身份=%s HTTP %s id=%r err=%s' % ('ss-owner' if PROPOSER_IS_SS_OWNER else 'Administrator',
                                            st_pp, pid_pp, str(pr_pp.get('error') or '')[:110]))

    st_l11, b_l11 = t.service(owner, 'files.action_proposals', {'table': T11})
    body_l = b_l11 if isinstance(b_l11, dict) else {}
    lst11 = (body_l.get('result') or {}).get('proposals') or body_l.get('proposals') or []
    hit11 = [p for p in lst11 if isinstance(p, dict) and p.get('id') == pid_pp]
    check('P-⑪ ④ 列表里查得到这条（不是造完就丢）', bool(hit11),
          '列表 %d 条，命中 %d 条' % (len(lst11), len(hit11)))

    snap_before = None
    st_rb, b_rb = t.service(owner, 'files.sheet_read', {'table': T11})
    snap_before = (b_rb.get('result') or b_rb) if isinstance(b_rb, dict) else {}
    st_rc11, b_rc11 = t.service(owner, 'files.action_proposal_resolve',
                                {'proposal_id': pid_pp, 'decision': 'confirmed'})
    st_ra, b_ra = t.service(owner, 'files.sheet_read', {'table': T11})
    snap_after = (b_ra.get('result') or b_ra) if isinstance(b_ra, dict) else {}
    wrote11 = (snap_before or {}).get('rows') != (snap_after or {}).get('rows')
    check('P-⑪ ⑤ **也采用得动**（真写进去了 —— 只回 200 不算，得看到值变）',
          st_rc11 == 200 and wrote11,
          'HTTP %s 写进去了=%s 前 cv=%s 后 cv=%s' % (
              st_rc11, wrote11, (snap_before or {}).get('content_version'),
              (snap_after or {}).get('content_version')))

    # —— 敏感度：这条判据必须咬得住「前提被改回去」——
    def _p11_ok(proposed, listed, adopted):
        return bool(proposed) and bool(listed) and bool(adopted)

    a = _p11_ok(True, True, True)      # 现状：非归属人全流程通
    b_ = _p11_ok(False, True, True)    # 前提被改回去：非归属人造不出（就是那句错注释描述的世界）
    c_ = _p11_ok(True, False, True)    # 造得出但查不到
    d_ = _p11_ok(True, True, False)    # 造得出、查得到，但采用不动
    vv11 = {'ok': a, 'premise_reverted': b_, 'lost': c_, 'not_adoptable': d_}
    check('P-⑪ ⑥ 敏感度：判别式认「非归属人全流程通」为过', a, 'ok')
    check('P-⑪ ⑥ 敏感度：判别式认「前提被改回去（非归属人造不出）」为不过', not b_, 'premise_reverted')
    check('P-⑪ ⑥ 敏感度：判别式认「造得出但查不到」为不过', not c_, 'lost')
    check('P-⑪ ⑥ 敏感度：判别式认「采用不动」为不过', not d_, 'not_adoptable')
    check('P-⑪ ⑥ 敏感度：四种形状给出两种不同结论（不是恒真/恒假）',
          len(set(vv11.values())) == 2, '结论=%r' % vv11)

print('\n结果： %s  共 %d 条检查，失败 %d 条，未测 %d 条' %
      ('PASS' if not failed else 'FAIL', checks_run, len(failed), len(not_yet)))
for f in failed:
    print('  失败： %s' % f)
for n in not_yet:
    print('  未测： %s' % n)
sys.exit(1 if failed else 0)
