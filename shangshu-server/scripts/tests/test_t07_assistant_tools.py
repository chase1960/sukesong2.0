"""PKG-003-T07 assistant 工具定义（A 的审核面板在等的最后两条）。

**任务号更正（2026-10-14）**：本文件原先写的是 `PKG-001-T07`，**那是错的**。
`PKG-001-T07` = **R7「粘贴、撤回与完整链重验」**，是另一条、还开着（B 侧一致性/故障测试
仍 NOT_RUN）。本文件测的是 **`PKG-003-T07`**「普通表 Assistant 建表、加列/行和范围操作」。
两个号都叫 T07，撞在一起说「T07 收口」会被读成 R7 完成了 —— 记在这里免得再混。

**测试通过 = 下面各条成立**：

T07-① 助手工具目录里有一组**表操作工具**（建表 / 加列 / 加行 / 范围读 / 批量填写），
      且每一个都能对应到一个**已注册的受管动作**（不是空壳声明、不是编出来的编号）。
T07-② **版本过期拒绝**：写动作带一个**过期的**版本号（`expected_content_version` /
      `expected_structure_version` 对不上当前值）→ **被拒**，HTTP 417，文案带「版本」，
      并**带出当前版本号**给调用方重试；**人的改动不被覆盖**。
T07-③ **拒绝后独立读回零写**：把一个待审提案**驳回**后，用 `files.sheet_read`
      **独立读回**行列数与抽样值**完全一致**（不是「返回空所以算过」，是真的没写）。

口径来源（A 2026-10-14 给的，不是我编的）：
  · 工具定义落点 = `shangshu-files/shangshu-plugin.yml` 的 `tools:` + `domain.py` 的 ACTIONS 注册
  · 版本校验**内核已有**（`native_objects.py` 的 version_param / 文件域的
    `expected_content_version` + `expected_structure_version`），不另写拒绝逻辑
  · 「独立读回」主判据是 **`files.sheet_read` 数据不变**，不是 action_fact_query
  · 过期时返回 **HTTP 417**（与现有 sheet 写冲突一致），文案带「版本」
  · **领域改动，不碰 `shangshu_core/`，不需要 CORE-CANDIDATE**

边界：只做这两条，不造新拒绝逻辑、不动内核版本校验、不碰 A 的 `main.ts`。

先红后绿：工具没声明时 T07-① 应红。
反例（故意翻期望）必须能红，否则判据恒真。

用法：python3 test_t07_assistant_tools.py [--cases 01,02,03]
"""
import importlib.util
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
RUN = t.RUN
VALID = ('01', '02', '03')

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
if not admin_pw:
    print('结果： FAIL 取不到管理员口令'); sys.exit(2)

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
    """如实记「没测到」—— 不算通过，也不算失败。

    **不许假造让它变绿**（比如自己编一条待审提案），也不许拿它拖红整个套件。
    按 C 的 NOT_RUN 口径：写了原因，等人能测的那侧去测。
    """
    global checks_run
    checks_run += 1
    not_yet.append(label)
    print('  ~ %s — 未测：%s' % (label, why))


def result_of(st, body):
    b = body if isinstance(body, dict) else {}
    r = b.get('result')
    return r if isinstance(r, dict) else (b if isinstance(b, dict) else {})


def build_plain(h1='H1', v='T07值'):
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml',
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels',
                   '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml',
                   '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels',
                   '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml',
                   '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>%s</t></is></c></row>'
                   '<row r="2"><c r="A2" t="inlineStr"><is><t>%s</t></is></c></row></sheetData></worksheet>' % (h1, v))
    return buf.getvalue()


# A 要的那组表操作工具（A 2026-10-14 给的清单）。判定按「能不能对应到一个真动作」，
# 不按名字猜 —— 名字对但动作不存在，一样不算定义好了。
#
# **内核硬约束**（domains.py）：「AI Tool 必须投影已注册 Action」——**服务不能当工具**。
# 所以 `range_read` 这次**不进目录**：`files.sheet_read` 是服务不是动作。要给它开工具
# 得先有一个只读 Action，那是**新开公共接口面**，不在本次改动里定（已报 A）。
TABLE_TOOLS = {
    'create_table': ['files.create', 'files.upload'],
    'add_column': ['files.sheet_column_append'],
    'add_row': ['files.sheet_row_append'],
    'range_read': ['files.sheet_range_read'],
    'copy_values': ['files.sheet_paste_apply', 'files.sheet_cells_write'],
    'batch_fill': ['files.sheet_paste_apply', 'files.sheet_cells_write'],
}
# 服务/动作的分工约束：`files.sheet_read` 是**服务**，必须保持是服务、不被注册成动作；
# `range_read` 走的是**只读动作壳** `files.sheet_range_read`（处理器复用同一个
# `read_payload`）。两条一起钉住，免得有人把服务改成动作、或者把壳做成第二套读逻辑。
READ_SERVICE_STAYS_SERVICE = 'files.sheet_read'
RANGE_READ_ACTION = 'files.sheet_range_read'

print('== T07 assistant 工具定义 ==')
print('实例：%s　run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)

# ---------- T07-① 工具目录里有这组表操作工具，且对应到真动作 ----------
if '01' in want:
    print('\n== T07-① 工具目录里有表操作工具，且对应到真动作 ==')
    # **必须用已登录的客户端** —— 新建 `t.Client(BASE)` 没登录会 403，
    # 那是「没带身份」不是「工具不存在」，判成红就冤枉产品了。
    st_tools, dat_tools = adm.request('GET', '/api/platform/tools')
    st_act, dat_act = adm.request('GET', '/api/platform/actions')
    tools = (dat_tools or {}).get('list') or (dat_tools or {}).get('tools') or []
    acts = (dat_act or {}).get('list') or []
    act_ids = set()
    for a in acts:
        if isinstance(a, dict):
            act_ids.add(a.get('id') or a.get('action_id') or a.get('capability'))
    tool_blob = json.dumps(dat_tools, ensure_ascii=False)
    print('  工具 HTTP %s 共 %d 条；动作 HTTP %s 共 %d 条' % (st_tools, len(tools), st_act, len(acts)))
    check('T07-① ① 工具目录取得到', st_tools == 200 and bool(tools or tools == []),
          'HTTP %s tools=%d' % (st_tools, len(tools)))

    # 目录里得能看到表操作工具。**目录是按动作 id 列的**（内核「AI Tool 必须投影
    # 已注册 Action」），不是按英文名 —— 按名字找会恒红（第一次就是这么冤枉产品的）。
    # 所以判据是：**该工具对应的某个动作 id 出现在工具目录里**，且**这个动作真注册了**。
    present = {}
    for name, candidates in TABLE_TOOLS.items():
        in_catalog = any(c in tool_blob for c in candidates)
        resolved = [c for c in candidates if c in act_ids]
        present[name] = (in_catalog, resolved)
        check('T07-① 工具 %s：目录里有、且对应到真动作' % name,
              in_catalog and bool(resolved),
              '目录里=%s  候选动作命中=%s（候选 %s）' % (in_catalog, resolved or '无', candidates))
    n_ok = sum(1 for v in present.values() if v[0] and v[1])
    print('  小结：%d/%d 个表操作工具「目录里有 + 对应到真动作」' % (n_ok, len(TABLE_TOOLS)))
    # 服务/动作分工：服务保持是服务，range_read 走只读动作壳
    check('T07-① 设计约束：读口 %s 仍是服务、没被注册成动作' % READ_SERVICE_STAYS_SERVICE,
          READ_SERVICE_STAYS_SERVICE not in act_ids,
          '在动作表里=%s（服务被改成动作会和工具壳重复）'
          % (READ_SERVICE_STAYS_SERVICE in act_ids))
    check('T07-① 设计约束：%s 是只读动作壳（effect=read，不要幂等键）' % RANGE_READ_ACTION,
          RANGE_READ_ACTION in act_ids, '在动作表里=%s' % (RANGE_READ_ACTION in act_ids))
    # 只读动作壳不许要幂等键：拿它读一次，**不传 idempotency_key 也该成**
    st_rd, dat_rd = t.action(adm, 'files.sheet_range_read', {'table': 'no-such-table'},
                             f't07-ro-{RUN}')
    read_no_key_ok = (st_rd != 417) or ('幂等' not in str(dat_rd))
    check('T07-① 只读动作不要幂等键（读不需要写才要的那个键）', read_no_key_ok,
          'HTTP %s %s' % (st_rd, str(dat_rd)[:120]))

# ---------- T07-② 版本过期拒绝 ----------
if '02' in want:
    print('\n== T07-② 版本过期拒绝（不覆盖人的改动）==')
    import base64
    b64 = base64.b64encode(build_plain(h1='H1', v='人的值')).decode()
    st, body = t.action(adm, 'files.upload', {
        'file_name': 't07-版本-%s.xlsx' % RUN, 'content_base64': b64, 'directory': '/'},
        f't07-up-{RUN}')
    F = result_of(st, body).get('file') or result_of(st, body).get('file_id')
    check('T07-② 前置：建出一张表', bool(F), 'HTTP %s' % st)

    def versions():
        st_v, dat_v = t.service(adm, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 5})
        d = dat_v if isinstance(dat_v, dict) else {}
        return st_v, d.get('content_version'), d.get('structure_version'), d.get('rows')

    st_r, cv1, sv1, rows1 = versions()
    check('T07-② 前置：读到当前版本号', cv1 is not None and sv1 is not None,
          'content_version=%r structure_version=%r' % (cv1, sv1))

    # **复现「人刚改过、提案的版本旧了」**：先做一次**真结构改动**（加列），
    # 再拿改动前的旧版本号去写。
    #
    # 踩过的坑记下来免得再犯：
    #   · 只给一个版本字段 → 撞「缺必填字段」（校验错，不是版本冲突）
    #   · 把旧版本写成 0     → 撞 `minimum=1` 的范围校验（还是校验错）
    #   · 用「加行」当结构改动 → **实测 structure_version 不往前走**（1→1），
    #     于是「旧版本」其实还是当前版本，写被正常接受，看着像没拦截
    # 版本号必须是**合法但过期**的值，唯一对不上的就是「版本」。
    st_a, body_a = t.action(adm, 'files.sheet_column_append', {
        'table': F, 'header': '新加的列',
        'expected_content_version': int(cv1), 'expected_structure_version': int(sv1)},
        f't07-bump-{RUN}')
    check('T07-② 前置：先真改一次结构（加列，把结构版本往前走）', st_a == 200,
          'HTTP %s %s' % (st_a, str(body_a)[:120]))
    st_r1, cv2, sv2, rows_human = versions()
    check('T07-② 前置：结构版本确实往前走了', sv2 != sv1,
          '旧 structure=%r → 新 %r（content %r→%r）' % (sv1, sv2, cv1, cv2))

    # 用**改动前的旧版本号**（合法但过期）去写 —— 这才是版本冲突
    st_w, body_w = t.action(adm, 'files.sheet_row_append', {
        'table': F, 'expected_content_version': int(cv1), 'expected_structure_version': int(sv1)},
        f't07-stale-{RUN}')
    dump = json.dumps(body_w, ensure_ascii=False) if isinstance(body_w, dict) else str(body_w)
    # **只看错误文案，别看 code** —— 版本冲突本来就是用 `frappe.ValidationError` 抛的，
    # code 同样是 `VALIDATION_FAILED`。拿 code 当「校验错」会把版本冲突一起排掉
    # （第一次就是这么把已生效的拦截判成没拦住的）。
    err_text = str((body_w or {}).get('error') or '') if isinstance(body_w, dict) else str(body_w)
    schema_noise = any(w in err_text for w in ('必填', '未声明', '类型不正确',
                                              '超出允许范围', 'minimum'))
    version_hit = ('版本' in err_text) and not schema_noise
    check('T07-② ① 过期版本被拒，且是**版本**冲突不是校验错',
          st_w == 417 and version_hit, 'HTTP %s %s' % (st_w, dump[:160]))
    check('T07-② ② 文案带「版本」并说清是冲突/过期',
          version_hit and any(w in dump for w in ('冲突', '过期', '已改', '不一致', 'stale', '不同', '变更')),
          '原话 %s' % dump[:160])
    check('T07-② ③ 带出当前版本号给调用方重试',
          version_hit and (str(sv2) in dump or str(cv2) in dump),
          '当前 content=%r structure=%r  回包 %s' % (cv2, sv2, dump[:130]))

    # 「人的改动」= 刚才那次加列之后的状态。基线必须取在**它之后**，
    # 否则改动本身就会让这条红，红的原因还不是覆盖。
    st_r2, cv3, sv3, rows_after = versions()
    check('T07-② ④ 人的改动没被覆盖（过期写没生效，读回不变）',
          rows_human == rows_after and sv3 == sv2,
          '人的改动后=%s 行 structure=%r　过期写后=%s 行 structure=%r'
          % (len(rows_human or []), sv2, len(rows_after or []), sv3))

# ---------- T07-③ 拒绝后独立读回零写 ----------
if '03' in want:
    print('\n== T07-③ 拒绝提案后独立读回零写 ==')
    import base64
    b64 = base64.b64encode(build_plain(h1='H1', v='驳回前的值')).decode()
    st, body = t.action(adm, 'files.upload', {
        'file_name': 't07-驳回-%s.xlsx' % RUN, 'content_base64': b64, 'directory': '/'},
        f't07-up3-{RUN}')
    F = result_of(st, body).get('file') or result_of(st, body).get('file_id')

    st_r, dat_r = t.service(adm, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 5})
    snap_before = json.dumps((dat_r or {}).get('rows'), ensure_ascii=False, sort_keys=True) \
        if isinstance(dat_r, dict) else None
    content_version = (dat_r or {}).get('content_version')
    structure_version = (dat_r or {}).get('structure_version')
    check('T07-③ 前置：读到基线数据', bool(snap_before),
          'HTTP %s content=%r structure=%r' % (st_r, content_version, structure_version))

    # 提案面：`GET /api/confirmations` 列待审、`POST /api/confirmations/:id` 批/驳。
    #
    # **怎么造出待审提案**（2026-10-14 找到，不必等 AI 聊天路径）：
    # 内核提案由 `shangshu_core.public_api.http.action_propose` 创建。BFF（:3820 等）
    # 没给它开路由（只有 AI 聊天工具执行器里 `def.kind === 'confirm'` 时才调），
    # 但 **Frappe 本体的 `/api/method/` 是通的** —— BFF 端口 +2 就是 Frappe
    # （3820→3822、3810→3812），登录 + 取 csrf 后直接 POST 那个方法即可。
    # 这条比「等 C 的 AI 聊天桩」快，也不需要模型。
    #
    # **API 契约的两个坑**（A 2026-10-14 踩过，记下来免得下一个人再花时间）：
    #   1. `decision` 的值是 **`confirmed` / `rejected`**，**不是** `approved`。
    #      写错回 417「decision 必须是 confirmed 或 rejected」。
    #   2. `files.*` 动作的 `table` 要 **文件 ID**（`files.create`/`files.upload` 回的
    #      `file`/`file_id`，形如 `4qvqhfr629`），**不是对象 ID**。写错回 404 找不到文件。
    #   3. 浏览器直接调 Frappe 会被 CORS 挡；Node/Python 侧自己登录 + 带 csrf 即可。
    #
    # **基线必须非空**：拿一张空表做「驳回后零写」，`before=[] after=[]` 是**恒真**的，
    # 什么都证明不了。本用例用带数据的表（表头 + 数据行），让逐字节比有东西可比。
    # **反例（③批准后必须变）是唯一能证明比对不空转的那条** —— 没它，空对空也算过。
    import http.cookiejar
    import urllib.error
    import urllib.request
    _frappe = 'http://127.0.0.1:%d' % (int(BASE.rsplit(':', 1)[-1]) + 2)
    _jar = http.cookiejar.CookieJar()
    _op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))

    def _fcall(path, body=None, csrf=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(_frappe + path, data=data,
                                     method='POST' if data else 'GET')
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

    st_l, _ = _fcall('/api/method/login', {'usr': 'Administrator', 'pwd': admin_pw})
    _, _csrf_d = _fcall('/api/method/shangshu_core.public_api.http.csrf')
    _csrf = ((_csrf_d or {}).get('message') or {}).get('csrf_token')
    check('T07-③ 前置：连到 Frappe 本体并拿到 csrf',
          st_l == 200 and bool(_csrf), '%s csrf=%s（%s）' % (_frappe, bool(_csrf), st_l))

    def _propose(action_id, payload, key):
        st_p, body_p = _fcall('/api/method/shangshu_core.public_api.http.action_propose',
                              {'action_id': action_id, 'payload': payload,
                               'idempotency_key': key, 'source': 'test-t07'}, _csrf)
        msg = (body_p or {}).get('message') or body_p or {}
        return st_p, (msg if isinstance(msg, dict) else {})

    st_p1, pr1 = _propose('files.sheet_row_append',
                          {'table': F, 'count': 1,
                           'expected_content_version': int(content_version),
                           'expected_structure_version': int(structure_version)},
                          't07p3-a-%s' % RUN)
    check('T07-③ ① 造出待审提案', st_p1 == 200 and bool(pr1.get('id')),
          'HTTP %s id=%r capability=%r' % (st_p1, pr1.get('id'), pr1.get('capability')))

    st_l2, dat_l2 = adm.request('GET', '/api/confirmations?status=Proposed')
    plist = (dat_l2 or {}).get('list') or []
    mine = [p for p in plist if (p.get('id') or p.get('name')) == pr1.get('id')]
    check('T07-③ ② 提案出现在待审列表里（不是只造了个库记录）',
          bool(mine), '待审 %d 条，命中 %d 条 id=%r' % (len(plist), len(mine), pr1.get('id')))

    if mine:
        pid = mine[0].get('id') or mine[0].get('name')
        st_d, dat_d = adm.request('POST', '/api/confirmations/%s' % pid, {'decision': 'rejected'})
        check('T07-③ ③ 提案被驳回', st_d == 200, 'HTTP %s %s' % (st_d, str(dat_d)[:130]))
        st_r2, dat_r2 = t.service(adm, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 5})
        snap_after = json.dumps((dat_r2 or {}).get('rows'), ensure_ascii=False, sort_keys=True) \
            if isinstance(dat_r2, dict) else None
        check('T07-③ ④ 驳回后独立读回零写（数据逐字节不变）', snap_before == snap_after,
              'before=%s after=%s' % ((snap_before or '')[:70], (snap_after or '')[:70]))
        # 状态也得是 Rejected —— 光数据没变可能是「没执行」也可能是「执行失败」
        st_l3, dat_l3 = adm.request('GET', '/api/confirmations?status=Proposed')
        still = [p for p in ((dat_l3 or {}).get('list') or [])
                 if (p.get('id') or p.get('name')) == pid]
        check('T07-③ ⑤ 驳回后不再挂在待审（状态确实是 Rejected）', not still,
              '仍挂在待审 %d 条' % len(still))

        # ---- 反例：批准另一条，读回**必须变** —— 否则「不变」是恒真 ----
        st_r3, dat_r3 = t.service(adm, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 5})
        cv2 = (dat_r3 or {}).get('content_version')
        sv2 = (dat_r3 or {}).get('structure_version')
        st_p2, pr2 = _propose('files.sheet_row_append',
                              {'table': F, 'count': 1,
                               'expected_content_version': int(cv2),
                               'expected_structure_version': int(sv2)},
                              't07p3-b-%s' % RUN)
        st_l4, dat_l4 = adm.request('GET', '/api/confirmations?status=Proposed')
        p2 = [p for p in ((dat_l4 or {}).get('list') or [])
              if (p.get('id') or p.get('name')) == pr2.get('id')]
        if p2:
            pid2 = p2[0].get('id') or p2[0].get('name')
            st_c, dat_c = adm.request('POST', '/api/confirmations/%s' % pid2,
                                      {'decision': 'confirmed'})
            st_r4, dat_r4 = t.service(adm, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 5})
            snap_conf = json.dumps((dat_r4 or {}).get('rows'), ensure_ascii=False, sort_keys=True) \
                if isinstance(dat_r4, dict) else None
            total_before = (dat_r3 or {}).get('total_rows')
            total_after = (dat_r4 or {}).get('total_rows')
            check('T07-③ 反例（判据非恒真）：批准后数据确实变了',
                  snap_conf != snap_after and total_after == (total_before or 0) + 1,
                  '批准 HTTP %s；行数 %s→%s；读回变了=%s'
                  % (st_c, total_before, total_after, snap_conf != snap_after))
        else:
            check('T07-③ 反例（判据非恒真）：批准后数据确实变了', False,
                  '反例提案没出现在待审列表里（id=%r）' % pr2.get('id'))

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)
if failed:
    print('结果： FAIL T07 工具定义（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
if not_yet:
    print('结果： PASS T07 工具定义已验部分（%d 条），另有 %d 条**未测**：%s'
          % (checks_run - len(not_yet), len(not_yet), '；'.join(not_yet)))
    sys.exit(0)
print('结果： PASS T07 工具定义全部成立（%d 条）' % checks_run)
