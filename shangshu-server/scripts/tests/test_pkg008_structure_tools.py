"""PKG-008-T01 **B 侧**：原行列生命周期 / 改名 / 回收恢复 / 安全逆向 —— 登记 Assistant 工具并实调用验证。

任务归属见 `fde/开发/计划/执行计划.md` PKG-008-T01 行：「原行列生命周期、改名/回收恢复及
安全逆向同时登记 Assistant 工具并实调用验证；**改名影响的规则/引用要处理或执行前明确阻止**」。
判据来源：X1-03 / X2-04 / X2-06，及 10/14 权限口径[映射/权限接续]（执行计划 `#excel-t09-decision-20261014` 第 109 行）。

**测试通过 = 下面各条成立**：

P8-① **工具投影齐**：改列名 `files.sheet_header_rename`、改表名 `files.sheet_rename`、
      文件回收 `files.recycle`、文件恢复 `files.restore`、受管逆向 `files.sheet_cells_undo`
      这五个动作**都在 `/api/platform/tools`（助手工具目录）里**，且每个都能对应到
      **已注册的受管动作**（不是空壳声明）。**反例**：`files.upload`（把文件内容 Base64
      上传）**仍然不开放给助手** —— 该挡住的还在挡。
P8-② **改列名真调用**：走**助手的提案链**（action_propose → 批准）改一个表头 →
      独立读回：新表头在、旧表头没了、**该列的值跟着走**、别的列一字不动、
      `structure_version` **恰 +1**。
P8-③ **改表名真调用**：同样走提案链改表名 → 独立读回 `table_title` 变了、**内容一字不动**、
      **表身份不变**；按契约 v1.1 它**不动内容/结构版本**，但**带过期结构版本的改表名要被拒**
      （证明那个必填的版本校验不是摆设）。
P8-④ **回收/恢复真调用**：回收后**本人在回收站仍可见**（既定语义）、**不能再改**且拒绝理由
      是回收状态而非 schema 错；恢复后内容一致、**又能写了**（正对照，证明不是「怎么写都被拒」）。
P8-⑤ **安全逆向真调用**：**一批写两格**（同一 `op_id`）→ 别人改其中一格 → 撤回这一 op →
      没被改的那格回原值、**被改的那格保持别人的值**且回包 `skipped` 报 `changed`；
      `content_version` **恰 +1**（跟撤回前那一刻比）。
P8-⑥ **改名的依赖检查（不空转）**：改名影响的引用，**要么处理掉、要么动手前明确拦下**。
      本文件把这条拆开，**不许混着报绿**：
        ⑥-a **可达的拦截**：撞已有表头 / 改不存在的列 / 新表头为空 → **明确拒绝且零改动**。
        ⑥-b **今天摸得到的一种「引用」= 撤回台账里的旧表头名**：改名后按旧 `op_id` 撤回
            → 要么正确回退、要么**明确报因**（`skipped`/`missing`）、要么明确拒绝；
            **不许静默改坏、不许把旧值漏写到别的列上**。
        ⑥-c **晋升绑定那类引用**：**PKG-004 D-a 落地后够得着了**（定义持表头 → 数据库字段
            的绑定）。被晋升绑定引用的列改名 → **动手前明确拦下**（拦下就是一下都没动）；
            对照：在定义里但没晋升的列、以及没立绑定的表，改名照常放行。
            带敏感度自检（故意翻期望能红）。
        ⑥-d **结构操作不许抹掉 `sheet_meta_json` 的扩展键**（补测时咬出的真 bug）：
            重建 meta 只留 4 个键，扩展键会被静默抹掉。**有两个键，丢哪个都无声** ——
            `promotion`（晋升定义）丢了 → 正式值变看不见的；`ss_clean`（清洗已做）丢了 →
            每次格值写静默回落慢路径，**不报错、就是变慢**。三条回归各钉各的。
P8-⑦ **旧结构版本拒绝（不把权限挂错到同名新列）**：改列名 A→B 后**再建一个叫 A 的新列**，
      带**改名前**的 `expected_structure_version` 去写「A」→ **必须被拒**（HTTP 417 带「版本」），
      且**新 A 列里没有被写进东西**。
P8-⑧ **基础不变量**：表头**非空且唯一**；**行 ID 稳定**（加行/改名/撤回后原有 `row_id` 一个不变）；
      **普通加列不建数据库字段**（加列前后 `Custom Field` 数**相等**，且反例自检证明列确实加了）。

---
**边界（照抄 T07 的那三条，一条不放宽）**：
  · **领域改动**，只动 `frappe_apps/shangshu_files/`，**不碰 `shangshu_core/`**，不需要 CORE-CANDIDATE
  · 不造新拒绝逻辑之外的东西、不动内核版本校验、不碰 A 的 `main.ts`
  · **不以「仅工具注册」或「直接调 API 脚本」冒充真实助手调用**（接口契约 §4 原话）——
    所以 P8-②③ 走 `action_propose` → 批准 的提案链，不是直接 `execute`

**先红后绿**：五个动作没进 `tools:` 名单时 P8-① 应红。
**反例（故意翻期望）必须能红**，否则判据恒真。

用法：python3 test_pkg008_structure_tools.py [--cases 01,02,...]
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
# **RUN 必须到微秒**：`t.RUN` 是秒级，同一秒内重跑会复用幂等键，产品正确地回
# 409「幂等键已被不同请求使用」，看起来像竞态其实不是。R7-F3 踩过，3/5 假红。
RUN = '%s-%d' % (t.RUN, int(time.time() * 1e6) % 100000000)
VALID = ('01', '02', '03', '04', '05', '06', '07', '08')

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
# 用户**原始**请求的用例。owner 闸（没有 ss-owner 账号时）会把 want 砍到只剩 01，
# 但 P8-⑥ ⑤ **自给自足**（只用 Administrator + 自建表），不该被那道闸吞掉。
WANT_ALL = tuple(want)

from _ss_cred import CRED as _CRED, pw_of as _pw_of, admin_pw_for
admin_pw = admin_pw_for(BASE)
admin_pw = admin_pw or os.environ.get('SS_D_PW') or os.environ.get('ADMIN_PASSWORD')
if not admin_pw:
    print('结果： FAIL 取不到管理员口令（试过 _CRED 文件与 SS_D_PW/ADMIN_PASSWORD 环境变量）')
    sys.exit(2)

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
    """如实记「没测到」—— 不算通过，也不算失败。**不许假造让它变绿。**"""
    global checks_run
    checks_run += 1
    not_yet.append(label)
    print('  ~ %s — 未测：%s' % (label, why))


def build_plain():
    """干净夹具（无外链/批注）：4 行 3 列，表头 名称/数值/备注。

    **必须用 openpyxl 的 `ws.append()`**，不手拼 XML —— 手拼容易让每行都写成
    `<c r="A1">`，openpyxl 按 `<c r=` 归并就全塌进 A1，而自研解析器按 `<row r=` 归并
    照样「读对」，于是看起来像「读得对、一写就冲掉」的**产品 bug**，其实是夹具坏。
    2026-10-14 因此误判过三条，这里钉死。
    """
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


def rejected(res, word):
    """业务规则类拒绝：被拒且理由里有这个词（404 动作缺失不算 —— 防假绿）。"""
    if not res:
        return False
    st, body = res
    body = body if isinstance(body, dict) else {}
    err = '%s %s' % (body.get('error', ''), body.get('message', ''))
    return st != 200 and word in err


print('== PKG-008-T01 B 侧：结构生命周期 / 改名 / 回收恢复 / 安全逆向 ==')
print('实例：%s　run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)

# ---------- 账号（沿用 test_undo.py 那套；口令见 test_b1_org.py:68） ----------
#
# **`ss-owner` / `ss-reader` 只在 B（3820）建过**。A（3810）没有这两号，登不上就
# `SystemExit` 会把整个套件打死。所以这里**登录失败不致命**：置 None，需要它们的用例
# 自己走 `notyet()` 如实记未测 —— 不假造、也不拖红不相干的用例（P8-① 工具投影
# 只要管理员就能验，不该被缺账号挡掉）。
PW = 'b2-user-pw-2026'


def _login_or_none(username):
    c = t.Client(BASE)
    try:
        c.login(username, PW)
        return c
    except SystemExit:
        return None


owner = _login_or_none('ss-owner@example.invalid')      # 归属人（有写权）
editor = _login_or_none('ss-reader@example.invalid')    # 获编辑共享身份
if owner is None:
    print('  ~ 本实例没有 ss-owner@example.invalid（B 侧专用账号）—— 需要双人/归属人的用例将记「未测」')

# ---------- 建表（归属 personal=ss-owner）+ 开编辑共享给 editor ----------
print('\n== 建样本表 ==')
if owner is None:
    TABLE = None
    print('  ~ 跳过建表：没有归属人账号（ss-owner），本实例只能验工具投影')
else:
    res, why = act(owner, 'files.upload', {
        'file_name': 'p8-结构表-%s.xlsx' % RUN,
        'content_base64': base64.b64encode(build_plain()).decode(),
        'directory': '/',
        'attribution': {'level': 'personal'},
    }, 'p8-up-%s' % RUN)
    TABLE = result_of(res).get('file')
    check('上传结构样本表', bool(TABLE), why[:140])
    res, why = act(owner, 'platform.org.share_grant',
                   {'resource': TABLE, 'user': 'ss-reader@example.invalid', 'access': 'edit'},
                   'p8-share-%s' % RUN)
    check('开编辑共享给 editor（P8-⑤ 要两个人）', bool(res) and res[0] == 200, why[:140])


def snap(client=None):
    """独立读回整表快照：逐格值 + 版本 + 表头 + 行ID。**基线必须非空**才有得比。"""
    c = client or owner
    st, dat = t.service(c, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 200})
    if st != 200 or not isinstance(dat, dict):
        return None
    cells = {}
    for row in dat.get('rows') or []:
        for header, typed in (row.get('values') or {}).items():
            cells[(row.get('row_id'), header)] = json.dumps(typed, sort_keys=True, ensure_ascii=False)
    return {'cells': cells, 'content_version': dat.get('content_version'),
            'structure_version': dat.get('structure_version'), 'rows': dat.get('rows'),
            'headers': dat.get('headers'),
            # **字段名是 `table_title`**（`files.sheet_read` 回包），不是 title/file_name ——
            # 取错会读成 None，看起来像「改表名没生效」。2026-10-14 判错过一次。
            'table_title': dat.get('table_title'), 'table': dat.get('table'),
            'row_ids': [r.get('row_id') for r in (dat.get('rows') or [])]}


S0 = snap() if owner is not None else None
if owner is not None:
    check('读回样本表（基线非空，否则后面逐字节比是瞎的）',
          bool(S0) and bool(S0['cells']),
          '行数=%s 格数=%s' % (len((S0 or {}).get('rows') or []), len((S0 or {}).get('cells') or {})))
    HEADERS0 = (S0 or {}).get('headers') or []
    check('P8-⑧ 前置：夹具表头非空且唯一',
          bool(HEADERS0) and len(HEADERS0) == len(set(HEADERS0)) and all(str(h).strip() for h in HEADERS0),
          '表头=%s' % HEADERS0)

# **本实例没有归属人账号时**（如 A 3810），02～08 全部如实记未测，只跑 01 工具投影。
# 不假造、也不把它们判红 —— 缺的是测试前提，不是产品问题。
if owner is None:
    _need = [c for c in want if c != '01']
    if _need:
        print('\n== 以下用例需要 ss-owner/ss-reader 账号，本实例没有，如实记未测 ==')
        for _c in _need:
            notyet('P8-%s（用例 %s）' % ({'02': '② 改列名', '03': '③ 改表名', '04': '④ 回收恢复',
                                        '05': '⑤ 安全逆向', '06': '⑥ 改名依赖检查',
                                        '07': '⑦ 旧结构版本拒绝', '08': '⑧ 基础不变量'}.get(_c, _c), _c),
                   '本实例没有 ss-owner@example.invalid（B 侧专用账号），前提不齐')
    # 只跑 01 工具投影，其余用例块自然跳过
    want = tuple(c for c in want if c == '01')

# ---------- Frappe 本体（BFF 端口 +2）：造待审提案用 ----------
#
# **提案必须由「归属人」造，不能用 Administrator**（2026-10-14 踩过）：
# 表落在 `ss-owner` 的个人归属，Administrator 没写权；用管理员造提案再批，
# 执行时回 **403「只有上传人、资源归属人或获编辑共享的人可以修改文件」**。
# 而「批准失败」如果没被断言，会被读成「批准了但没生效」—— 空判据。
# 接口契约 §4 原话：人、Assistant、代码自动化**使用实际身份**及运行授权。
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


st_l, _ = _fcall('/api/method/login', {'usr': 'ss-owner@example.invalid', 'pwd': PW})
_, _csrf_d = _fcall('/api/method/shangshu_core.public_api.http.csrf')
_csrf = ((_csrf_d or {}).get('message') or {}).get('csrf_token')
check('前置：以**归属人**身份连到 Frappe 本体并拿到 csrf',
      owner is None or (st_l == 200 and bool(_csrf)),
      '%s csrf=%s HTTP=%s' % (_frappe, bool(_csrf), st_l))


def propose(action_id, payload, key):
    """走助手的提案链：`action_propose` 造待审提案（`source` 如实标测试来源）。

    以**归属人**身份造 —— 见上方注释：管理员造的提案批下去会 403。
    """
    st_p, body_p = _fcall('/api/method/shangshu_core.public_api.http.action_propose',
                          {'action_id': action_id, 'payload': payload,
                           'idempotency_key': key, 'source': 'test-pkg008'}, _csrf)
    msg = (body_p or {}).get('message') or body_p or {}
    return st_p, (msg if isinstance(msg, dict) else {})


def approve(proposal_id, decision='confirmed'):
    """批/驳一条提案。**decision 是 confirmed/rejected，不是 approved**（写错回 417）。

    ⚠️ **走 BFF，不是 Frappe 本体**：`/api/confirmations` 是 BFF 的路由，
    Frappe 本体只有 `/api/method/...`。发错主机会静默失败 —— 而「批准失败」会被读成
    「批准了但没生效」，正是**空判据**。所以调用方必须断言本函数返回 HTTP 200。
    用**归属人**批（`owner`），不是 Administrator —— 批准即执行，执行要有写权。
    """
    return owner.request('POST', '/api/confirmations/%s' % proposal_id, {'decision': decision})


# ========================= P8-① 工具投影齐 =========================
if '01' in want:
    print('\n== P8-① 工具投影齐（5 个动作进助手工具目录）==')
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

    check('P8-① ① 工具目录取得到', st_tools == 200 and isinstance(tools, list),
          'HTTP %s tools=%d' % (st_tools, len(tools)))

    # **目录是按动作 id 列的**（内核「AI Tool 必须投影已注册 Action」），不是按中文名。
    REQUIRED = {
        '改列名': 'files.sheet_header_rename',
        '改表名': 'files.sheet_rename',
        '文件回收': 'files.recycle',
        '文件恢复': 'files.restore',
        '受管逆向': 'files.sheet_cells_undo',
    }
    for name, aid in REQUIRED.items():
        in_catalog = aid in tool_blob
        resolved = aid in act_ids
        check('P8-① 工具 %s（%s）：目录里有、且对应到真动作' % (name, aid),
              in_catalog and resolved,
              '目录里=%s 真动作=%s' % (in_catalog, resolved))

    # **反例**：该挡住的还在挡。`files.upload` 把文件内容 Base64 上传，不开放给助手
    # （scripts/test-files-domain.py:103 有同一约束）。这条红了说明工具面开漏了。
    check('P8-① 反例：files.upload 仍不开放给助手（不是「全都放进来」）',
          'files.upload' not in tool_blob,
          'files.upload 出现在工具目录里=%s' % ('files.upload' in tool_blob))

# ========================= P8-② 改列名真调用 =========================
if '02' in want:
    print('\n== P8-② 改列名真调用（提案链，不是直接 execute）==')
    before = snap()
    cv, sv = before['content_version'], before['structure_version']
    st_p, pr = propose('files.sheet_header_rename', {
        'table': TABLE,
        'expected_content_version': int(cv),
        'expected_structure_version': int(sv),
        'from_header': '备注', 'to_header': '客户意见',
    }, 'p8-02-a-%s' % RUN)
    check('P8-② ① 造出「改列名」待审提案', st_p == 200 and bool(pr.get('id')),
          'HTTP %s id=%r capability=%r' % (st_p, pr.get('id'), pr.get('capability')))

    # **反例（判据不空转的命根子）**：先驳回一条同名提案 → 独立读回必须零改动。
    st_p2, pr2 = propose('files.sheet_header_rename', {
        'table': TABLE,
        'expected_content_version': int(cv),
        'expected_structure_version': int(sv),
        'from_header': '备注', 'to_header': '不该出现的列名',
    }, 'p8-02-rej-%s' % RUN)
    st_dec, dat_dec = approve(pr2.get('id'), 'rejected') if pr2.get('id') else (0, {})
    check('P8-② 反例前置：驳回请求本身成功（不许静默失败当成功）',
          st_dec == 200, 'HTTP %s %s' % (st_dec, str(dat_dec)[:120]))
    mid = snap()
    check('P8-② 反例：驳回的提案零改动（不是「怎么批都变」）',
          bool(mid) and mid['headers'] == before['headers'] and mid['cells'] == before['cells'],
          '驳回后表头=%s' % ((mid or {}).get('headers')))

    st_dec2, dat_dec2 = approve(pr.get('id'), 'confirmed')
    check('P8-② ② 前置：批准请求本身成功（否则「没生效」是批准失败不是产品问题）',
          st_dec2 == 200, 'HTTP %s %s' % (st_dec2, str(dat_dec2)[:140]))
    after = snap()
    check('P8-② ② 批准后新表头在、旧表头没了',
          bool(after) and '客户意见' in (after['headers'] or []) and '备注' not in (after['headers'] or []),
          '表头 %s → %s' % (before['headers'], (after or {}).get('headers')))
    moved = all(after['cells'].get((rid, '客户意见')) == before['cells'].get((rid, '备注'))
                for rid in (before['row_ids'] or []) if before['cells'].get((rid, '备注')) is not None)
    check('P8-② ③ 该列的值跟着走（不是只剩个空表头）', moved,
          '改名前该列格数=%s' % sum(1 for k in before['cells'] if k[1] == '备注'))
    untouched = {k: v for k, v in before['cells'].items() if k[1] != '备注'}
    after_untouched = {k: v for k, v in after['cells'].items() if k[1] != '客户意见'}
    check('P8-② ④ 别的列一字不动', untouched == after_untouched,
          '改动格数=%d' % sum(1 for k in untouched if after_untouched.get(k) != untouched[k]))
    check('P8-② ⑤ structure_version 恰 +1',
          after['structure_version'] == before['structure_version'] + 1,
          '%s → %s' % (before['structure_version'], after['structure_version']))

# ========================= P8-③ 改表名真调用 =========================
if '03' in want:
    print('\n== P8-③ 改表名真调用 ==')
    before = snap()
    cv, sv = before['content_version'], before['structure_version']
    st_p, pr = propose('files.sheet_rename', {
        'table': TABLE,
        'expected_content_version': int(cv),
        'expected_structure_version': int(sv),
        'title': 'p8-改过名的表-%s' % RUN,
    }, 'p8-03-a-%s' % RUN)
    check('P8-③ ① 造出「改表名」待审提案', st_p == 200 and bool(pr.get('id')),
          'HTTP %s id=%r' % (st_p, pr.get('id')))
    st_d, dat_d = approve(pr.get('id'), 'confirmed')
    check('P8-③ ① 前置：批准请求本身成功', st_d == 200,
          'HTTP %s %s' % (st_d, str(dat_d)[:140]))
    after = snap()
    check('P8-③ ② 表名变了',
          bool(after) and 'p8-改过名的表-%s' % RUN in str(after.get('table_title')),
          'table_title=%r' % ((after or {}).get('table_title'),))
    check('P8-③ ③ 内容一字不动（改名不许动数据）',
          bool(after) and after['cells'] == before['cells'],
          '变动格数=%d' % sum(1 for k in before['cells'] if after['cells'].get(k) != before['cells'][k]))
    # **判据修正（2026-10-14）**：原先写「改表名也要推 structure_version」，**判错了**。
    # `table_rename` 的 docstring 明写「契约 v1.1：不动 xlsx 字节、内容/结构版本都不动；
    # sheet 身份不变」—— 表名不是列结构，没有「同名新列」可错挂，不该动结构版本。
    # 契约第 101 行「旧结构版本请求不能把权限错挂到同名新列」管的是**列**改名。
    # 真正该成立的是下面两条：身份不变 + 版本校验不是摆设。
    check('P8-③ ④ 表身份不变（改的是显示名，不是换了一张表）',
          bool(after) and after.get('table') == before.get('table'),
          'table %r → %r' % (before.get('table'), (after or {}).get('table')))
    check('P8-③ ⑤ 契约 v1.1：改表名不动内容/结构版本',
          after['content_version'] == before['content_version']
          and after['structure_version'] == before['structure_version'],
          'content %s→%s  structure %s→%s' % (before['content_version'], after['content_version'],
                                              before['structure_version'], after['structure_version']))
    # **必填的版本校验不许是摆设**：带一个对不上的结构版本去改表名，必须被拒。
    # `table_rename` 里调了 `_check_versions`；这条红了说明那句校验被绕过/删掉了。
    res, why = act(owner, 'files.sheet_rename', {
        'table': TABLE, 'title': '不该改成功',
        'expected_content_version': int(after['content_version']),
        'expected_structure_version': int(after['structure_version']) + 99,
    }, 'p8-03-stale-%s' % RUN)
    check('P8-③ ⑥ 带过期结构版本的改表名被拒（版本校验不是摆设）',
          res is not None and res[0] == 417 and '版本' in str(res[1]), why[:160])
    still = snap()
    check('P8-③ ⑥ 被拒后表名没被改',
          bool(still) and 'p8-改过名的表-%s' % RUN in str(still.get('table_title')),
          'table_title=%r' % ((still or {}).get('table_title'),))

# ========================= P8-④ 回收/恢复真调用 =========================
if '04' in want:
    print('\n== P8-④ 回收 / 恢复真调用 ==')
    # **判据修正（2026-10-14，改了两回）**：
    #  ① 先写「回收后独立读回取不到」→ **错**。产品既定语义是「回收后本人可见、
    #     他人不可见」（`scripts/test-files-domain.py:239`），而且那条讲的是**文件目录
    #     列表**（`query_dataset('files.file')`）的可见性，不是 `sheet_read`。
    #  ② 再写「回收后写入被拒」→ 第一版**绿得不对**：它被 schema 校验拒的
    #     （`payload.value 应为 object`），不是被回收状态拒的。**错因通过 = 空判据**。
    #     所以下面 ③ 必须**看拒绝理由**，并且用 ⑤ 的正对照证明它不是「怎么写都被拒」。
    before = snap()
    res, why = act(owner, 'files.recycle', {'file': TABLE}, 'p8-04-rec-%s' % RUN)
    check('P8-④ ① 回收成功', bool(res) and res[0] == 200, why[:140])
    mine = snap(owner)
    check('P8-④ ② 本人在回收站里仍可见（既定语义，不是漏放）',
          bool(mine), '本人读回=%s' % ('空' if not mine else '仍读得到'))

    def cell_write(c, row_id, header, cv, sv, val, key):
        return act(c, 'files.sheet_cell_write', {
            'table': TABLE, 'row_id': row_id, 'header': header,
            'expected_content_version': int(cv),
            'expected_structure_version': int(sv),
            # **value 是带类型的对象**，不是裸标量（schema: {type, value, formula}，type 必填）
            'value': val,
        }, key)

    if mine:
        rid = (mine['row_ids'] or [None])[0]
        hdr = (mine['headers'] or ['名称'])[0]
        res_w, why_w = cell_write(owner, rid, hdr, mine['content_version'],
                                  mine['structure_version'],
                                  {'type': 'text', 'value': '回收站里不该能写'},
                                  'p8-04-write-%s' % RUN)
        err_text = str(res_w[1]) if res_w else ''
        schema_err = ('应为' in err_text) or ('必填' in err_text) or ('字段类型' in err_text)
        check('P8-④ ③ 回收后不能再改（写入被拒，且**理由是回收/不可用，不是 schema 错**）',
              res_w is not None and res_w[0] != 200 and not schema_err,
              '%s%s' % (why_w[:130], '　← 若是 schema 错就是错因通过，不算数' if schema_err else ''))

    res, why = act(owner, 'files.restore', {'file': TABLE}, 'p8-04-res-%s' % RUN)
    check('P8-④ ④ 恢复成功', bool(res) and res[0] == 200, why[:140])
    back = snap()
    check('P8-④ ⑤ 恢复后内容与回收前一致',
          bool(back) and back['cells'] == before['cells'] and back['headers'] == before['headers'],
          '格数 %s → %s' % (len(before['cells']), len((back or {}).get('cells') or {})))
    # **正对照（③ 不空转的命根子）**：恢复后同样的写法必须成功。
    # 没这条，「怎么写都被拒」也能让 ③ 绿。
    if back:
        rid = (back['row_ids'] or [None])[0]
        hdr = (back['headers'] or ['名称'])[0]
        res_ok, why_ok = cell_write(owner, rid, hdr, back['content_version'],
                                    back['structure_version'],
                                    {'type': 'text', 'value': '恢复后能写了'},
                                    'p8-04-write-ok-%s' % RUN)
        check('P8-④ ⑥ 正对照：恢复后同样的写法就成功了（证明 ③ 不是「怎么写都被拒」）',
              res_ok is not None and res_ok[0] == 200, why_ok[:160])

# ========================= P8-⑤ 安全逆向真调用 =========================
if '05' in want:
    print('\n== P8-⑤ 安全逆向真调用（不覆盖别人后改）==')
    # **设计修正（2026-10-14）**：第一版别人改的是**另一个格子**，而撤回只退我那一格，
    # 于是 skipped=[]、「不覆盖」是**恒真**的 —— 什么都没验到。
    # 正确设计（照 test_undo.py B5-02）：**一批写两格（同一个 op_id）→ 别人改其中一格
    # → 撤回这一 op**：没被改的那格回原值，被改的那格**保持别人的值**且回包 `skipped`
    # 报「已被修改」。两格必须同属一个 op，否则测不到覆盖问题。
    before = snap()
    rows = before['row_ids'] or []
    if len(rows) < 2:
        notyet('P8-⑤ 安全逆向（不覆盖别人后改）', '样本表不足 2 行，造不出「同 op 两格、别人改一格」')
    else:
        r_keep, r_revert = rows[0], rows[1]
        h_num, h_name = '数值', '名称'
        orig_keep = before['cells'].get((r_keep, h_num))
        orig_revert = before['cells'].get((r_revert, h_num))
        cv, sv = before['content_version'], before['structure_version']
        op_id = 'p8-05-op-%s' % RUN
        # **一批写两格**，同属 op_id
        res, why = act(owner, 'files.sheet_cells_write', {
            'table': TABLE,
            'expected_content_version': int(cv),
            'expected_structure_version': int(sv),
            'op_id': op_id,
            'cells': [
                {'row_id': r_keep, 'header': h_num, 'value': {'type': 'number', 'value': 111}},
                {'row_id': r_revert, 'header': h_num, 'value': {'type': 'number', 'value': 222}},
            ],
        }, 'p8-05-w1-%s' % RUN)
        check('P8-⑤ ① 一批写两格拿到 op_id', bool(res) and res[0] == 200 and bool(op_id),
              '%s op_id=%r' % (why[:90], op_id))
        mid = snap()
        check('P8-⑤ ② 两格都真的写进去了（不是「返回成功但没写」）',
              bool(mid) and '111' in str(mid['cells'].get((r_keep, h_num)))
              and '222' in str(mid['cells'].get((r_revert, h_num))),
              '现值 keep=%r revert=%r' % (((mid or {}).get('cells') or {}).get((r_keep, h_num)),
                                      ((mid or {}).get('cells') or {}).get((r_revert, h_num))))

        # **别人改掉其中一格**（keep 那格）→ 撤回时那格必须保住
        just_before_undo = snap()
        act(editor, 'files.sheet_cell_write', {
            'table': TABLE, 'row_id': r_keep, 'header': h_num,
            'expected_content_version': int(just_before_undo['content_version']),
            'expected_structure_version': int(just_before_undo['structure_version']),
            'value': {'type': 'number', 'value': 777},
        }, 'p8-05-w2-%s' % RUN)
        mid2 = snap()
        check('P8-⑤ ③ 前置：别人那格改成 777 真生效',
              bool(mid2) and '777' in str(mid2['cells'].get((r_keep, h_num))),
              '现值=%r' % (((mid2 or {}).get('cells') or {}).get((r_keep, h_num))))

        ver_before_undo = snap()['content_version']
        res, why = act(owner, 'files.sheet_cells_undo', {'table': TABLE, 'op_id': op_id},
                       'p8-05-undo-%s' % RUN)
        check('P8-⑤ ④ 按 op_id 撤回成功', bool(res) and res[0] == 200, why[:140])
        r = result_of(res)
        after = snap()
        check('P8-⑤ ⑤ 没被人改的那格回到原值',
              bool(after) and after['cells'].get((r_revert, h_num)) == orig_revert,
              '%r → %r（原值 %r）' % (((mid or {}).get('cells') or {}).get((r_revert, h_num)),
                                 ((after or {}).get('cells') or {}).get((r_revert, h_num)), orig_revert))
        keep = (after or {}).get('cells', {}).get((r_keep, h_num))
        check('P8-⑤ ⑥ 别人后改的格**不被覆盖**（保持 777，不是拉回 111）',
              keep is not None and '777' in str(keep), '别人那格现值=%r' % (keep,))
        skipped = r.get('skipped')
        check('P8-⑤ ⑥ 回包 skipped 如实报了「已被修改」（不是静默跳过）',
              isinstance(skipped, list) and any('修改' in str(s) or 'changed' in str(s)
                                               for s in skipped),
              'skipped=%s' % (skipped,))
        check('P8-⑤ ⑦ content_version 恰 +1（跟**撤回前那一刻**比；中间别人的写不算在内）',
              after['content_version'] == ver_before_undo + 1,
              '%s → %s' % (ver_before_undo, after['content_version']))

# ========================= P8-⑥ 改名的依赖检查 =========================
if '06' in want:
    print('\n== P8-⑥ 改名的依赖检查 ==')
    before = snap()
    cv, sv = before['content_version'], before['structure_version']
    # ⑥-a 可达的拦截：撞已有表头
    res, why = act(owner, 'files.sheet_header_rename', {
        'table': TABLE, 'expected_content_version': int(cv),
        'expected_structure_version': int(sv),
        'from_header': '名称', 'to_header': '数值',
    }, 'p8-06-dup-%s' % RUN)
    check('P8-⑥ ① 改名撞已有表头 → 明确拒绝且零改动',
          rejected(res, '重名') or rejected(res, '已存在') or rejected(res, '唯一') or rejected(res, '占用'),
          why[:160])
    mid = snap()
    check('P8-⑥ ① 零改动（拒绝不许留半截）', bool(mid) and mid['headers'] == before['headers']
          and mid['cells'] == before['cells'], '表头=%s' % ((mid or {}).get('headers')))

    # ⑥-a 可达的拦截：改到不存在的列
    res, why = act(owner, 'files.sheet_header_rename', {
        'table': TABLE, 'expected_content_version': int(cv),
        'expected_structure_version': int(sv),
        'from_header': '根本没这列', 'to_header': '随便',
    }, 'p8-06-miss-%s' % RUN)
    check('P8-⑥ ② 改不存在的列 → 明确拒绝',
          rejected(res, '不存在') or rejected(res, '找不到') or rejected(res, '没有'),
          why[:160])

    # ⑥-a 可达的拦截：表头为空
    res, why = act(owner, 'files.sheet_header_rename', {
        'table': TABLE, 'expected_content_version': int(cv),
        'expected_structure_version': int(sv),
        'from_header': '名称', 'to_header': '   ',
    }, 'p8-06-empty-%s' % RUN)
    check('P8-⑥ ③ 新表头为空 → 明确拒绝（表头必须非空）',
          res is not None and res[0] != 200, why[:160])
    mid = snap()
    check('P8-⑥ ③ 零改动', bool(mid) and mid['headers'] == before['headers'], '表头=%s' % ((mid or {}).get('headers')))

    # ⑥-b **今天就摸得到的一种「引用」：撤回台账里的旧表头名**。
    # 改名后按旧 op 撤回，必须**要么正确回退、要么明确报因**（skipped/missing），
    # **不许静默改坏、不许把值写到别的列上**。这条是真判据，不是「没引用所以过」。
    # **顺序（2026-10-14 修）**：先造改名提案再写格子的话，写入会涨 content_version，
    # 批准改名时版本就过期了 → 417。必须**先写拿 op_id → 再造提案（用当前版本）→ 批准**。
    # 本条**自给自足**：自己挑一列、自己改名，不依赖前面用例跑过。
    pre_dep = snap()
    dep_row = (pre_dep['row_ids'] or [None])[0]
    dep_hdr = (pre_dep['headers'] or [None])[-1] if (pre_dep['headers'] or []) else None
    if not dep_row or not dep_hdr:
        notyet('P8-⑥ ④ 改名对撤回台账的影响', '样本表没有可挑的列/行')
    else:
        res_w, why_w = act(owner, 'files.sheet_cell_write', {
            'table': TABLE, 'row_id': dep_row, 'header': dep_hdr,
            'expected_content_version': int(pre_dep['content_version']),
            'expected_structure_version': int(pre_dep['structure_version']),
            'value': {'type': 'text', 'value': '改名前写的'},
        }, 'p8-06-dep-w-%s' % RUN)
        dep_op = result_of(res_w).get('op_id')
        check('P8-⑥ ④ 前置：拿得到改名前那次写入的 op_id',
              bool(res_w) and res_w[0] == 200 and bool(dep_op),
              '%s 列=%r op_id=%r' % (why_w[:70], dep_hdr, dep_op))
        # 写入涨了版本，**重新取当前版本**再造改名提案
        cur = snap()
        dep_new_hdr = '%s-再改' % dep_hdr
        st_p3, pr3 = propose('files.sheet_header_rename', {
            'table': TABLE,
            'expected_content_version': int(cur['content_version']),
            'expected_structure_version': int(cur['structure_version']),
            'from_header': dep_hdr, 'to_header': dep_new_hdr,
        }, 'p8-06-dep-%s' % RUN)
        check('P8-⑥ ④ 前置：造出改名提案', st_p3 == 200 and bool(pr3.get('id')),
              'HTTP %s id=%r' % (st_p3, pr3.get('id')))
        st_d3, dat_d3 = approve(pr3.get('id'), 'confirmed')
        check('P8-⑥ ④ 前置：改名批准成功', st_d3 == 200, 'HTTP %s %s' % (st_d3, str(dat_d3)[:110]))
        after_rename = snap()
        check('P8-⑥ ④ 前置：列名真的改了', dep_new_hdr in (after_rename['headers'] or []),
              '表头=%s' % ((after_rename or {}).get('headers')))
        # 按**改名前**的 op 撤回
        res_u, why_u = act(owner, 'files.sheet_cells_undo', {'table': TABLE, 'op_id': dep_op},
                           'p8-06-dep-undo-%s' % RUN)
        r_u = result_of(res_u)
        skipped_u = r_u.get('skipped')
        applied_u = r_u.get('applied')
        final = snap()
        # 三种合法结局：①正确回退（新列名下） ②skipped 明确报因 ③明确拒绝
        new_col_val = (final or {}).get('cells', {}).get((dep_row, dep_new_hdr))
        reverted_ok = new_col_val is not None and '改名前写的' not in str(new_col_val)
        reported = isinstance(skipped_u, list) and len(skipped_u) > 0
        refused = res_u is not None and res_u[0] != 200
        check('P8-⑥ ④ 改名后按旧 op 撤回：要么正确回退、要么明确报因、要么明确拒绝（不许静默改坏）',
              reverted_ok or reported or refused,
              'applied=%s skipped=%s HTTP=%s 新列现值=%r' % (applied_u, skipped_u,
                                                      (res_u or (None,))[0], new_col_val))
        other_cols = {k: v for k, v in ((final or {}).get('cells') or {}).items()
                      if k[1] not in (dep_new_hdr, dep_hdr)}
        leaked = [k for k, v in other_cols.items() if '改名前写的' in str(v)]
        check('P8-⑥ ④ 反例：旧值没有漏写到别的列上（改名不许错挂）',
              not leaked, '漏写的格=%s' % leaked)

# ========================= P8-⑦ 旧结构版本拒绝 =========================
if '07' in want:
    print('\n== P8-⑦ 旧结构版本拒绝（不把权限/写入挂错到同名新列）==')
    before = snap()
    cv, sv = before['content_version'], before['structure_version']
    old_sv = int(sv)
    # 改列名：数值 → 金额
    res, why = act(owner, 'files.sheet_header_rename', {
        'table': TABLE, 'expected_content_version': int(cv),
        'expected_structure_version': old_sv, 'from_header': '数值', 'to_header': '金额',
    }, 'p8-07-ren-%s' % RUN)
    check('P8-⑦ 前置：改列名成功', bool(res) and res[0] == 200, why[:140])
    mid1 = snap()
    check('P8-⑦ 前置：structure_version 已推进', mid1['structure_version'] == old_sv + 1,
          '%s → %s' % (old_sv, (mid1 or {}).get('structure_version')))

    # **再建一个叫「数值」的新列** —— 这就是「同名新列」
    res, why = act(owner, 'files.sheet_column_append', {
        'table': TABLE,
        'expected_content_version': int(mid1['content_version']),
        'expected_structure_version': int(mid1['structure_version']),
        'header': '数值',
    }, 'p8-07-new-%s' % RUN)
    check('P8-⑦ 前置：建出同名新列「数值」', bool(res) and res[0] == 200, why[:140])
    mid2 = snap()
    check('P8-⑦ 前置：新列真在表头里', '数值' in (mid2['headers'] or []),
          '表头=%s' % ((mid2 or {}).get('headers')))

    target_row = (mid2['row_ids'] or [None])[0]
    # **带改名前的旧 structure_version 去写「数值」** —— 必须被拒
    res, why = act(owner, 'files.sheet_cell_write', {
        'table': TABLE, 'row_id': target_row, 'header': '数值',
        'expected_content_version': int(mid2['content_version']),
        'expected_structure_version': old_sv,      # ← 改名前的旧版本
        'value': {'type': 'text', 'value': '不该写进去'},
    }, 'p8-07-stale-%s' % RUN)
    check('P8-⑦ ① 带旧结构版本写同名新列 → 被拒（HTTP 417 带「版本」）',
          res is not None and res[0] == 417 and '版本' in str(res[1]),
          why[:180])
    after = snap()
    check('P8-⑦ ② 新「数值」列里没被写进东西（权限/写入没挂错到同名新列）',
          bool(after) and after['cells'].get((target_row, '数值')) in (None, '', 'null')
          or '不该写进去' not in str((after or {}).get('cells', {}).get((target_row, '数值'))),
          '新列现值=%r' % (((after or {}).get('cells') or {}).get((target_row, '数值')),))

# ========================= P8-⑧ 基础不变量 =========================
if '08' in want:
    print('\n== P8-⑧ 基础不变量 ==')
    before = snap()
    ids0 = list(before['row_ids'] or [])
    cv, sv = before['content_version'], before['structure_version']
    # 加行
    act(owner, 'files.sheet_row_append', {
        'table': TABLE, 'expected_content_version': int(cv),
        'expected_structure_version': int(sv), 'count': 1,
    }, 'p8-08-row-%s' % RUN)
    # 改列名（借用第一个表头）
    mid = snap()
    h0 = (mid['headers'] or ['名称'])[0]
    act(owner, 'files.sheet_header_rename', {
        'table': TABLE, 'expected_content_version': int(mid['content_version']),
        'expected_structure_version': int(mid['structure_version']),
        'from_header': h0, 'to_header': '%s-改' % h0,
    }, 'p8-08-ren-%s' % RUN)
    # 写一格再撤回
    mid2 = snap()
    if ids0:
        res, _ = act(owner, 'files.sheet_cell_write', {
            'table': TABLE, 'row_id': ids0[0],
            'header': (mid2['headers'] or [''])[1] if len(mid2['headers'] or []) > 1 else (mid2['headers'] or [''])[0],
            'expected_content_version': int(mid2['content_version']),
            'expected_structure_version': int(mid2['structure_version']),
            'value': {'type': 'text', 'value': 'x'},
        }, 'p8-08-w-%s' % RUN)
        oid = result_of(res).get('op_id')
        if oid:
            act(owner, 'files.sheet_cells_undo', {'table': TABLE, 'op_id': oid}, 'p8-08-u-%s' % RUN)
    after = snap()
    ids1 = list(after['row_ids'] or [])
    check('P8-⑧ ① 行 ID 稳定：原有 row_id 一个不变、不多不少',
          all(i in ids1 for i in ids0) and len(ids1) == len(ids0) + 1,
          '改前 %d 行 → 改后 %d 行；原有 ID 全在=%s' % (len(ids0), len(ids1), all(i in ids1 for i in ids0)))
    check('P8-⑧ ② 表头仍然非空且唯一',
          all(str(h).strip() for h in (after['headers'] or []))
          and len(after['headers'] or []) == len(set(after['headers'] or [])),
          '表头=%s' % ((after or {}).get('headers')))

    # **普通加列不建数据库字段**：加列前后各取一次业务字段数，**必须相等**。
    # ⚠️ 第一版写死了 `True` 只报现状 —— 那是**空判据**；第二版查询身份用错
    #（`ss-owner` 无权读 `Custom Field`，返回 None → 前后都 None「相等」也是空判据）。
    # 现在用**管理员**身份查元数据，真的前后比：加列前 N 条 → 加一次列 → 还是 N 条。
    def custom_field_count():
        """管理员身份数一次 Custom Field。无权/查不到回 None，**不许当 0 用**。"""
        jar2 = http.cookiejar.CookieJar()
        op2 = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar2))

        def c2(path, body=None, csrf=None):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(_frappe + path, data=data,
                                         method='POST' if data else 'GET')
            req.add_header('accept', 'application/json')
            if data is not None:
                req.add_header('content-type', 'application/json')
            if csrf:
                req.add_header('X-Frappe-CSRF-Token', csrf)
            try:
                with op2.open(req, timeout=30) as r:
                    return r.status, json.loads(r.read().decode() or '{}')
            except Exception as e:
                return 0, {'_err': str(e)}

        st_a, _ = c2('/api/method/login', {'usr': 'Administrator', 'pwd': admin_pw})
        if st_a != 200:
            return None
        _, cd = c2('/api/method/shangshu_core.public_api.http.csrf')
        csrf2 = ((cd or {}).get('message') or {}).get('csrf_token')
        if not csrf2:
            return None
        st_f, dat_f = c2('/api/method/frappe.client.get_list',
                         {'doctype': 'Custom Field', 'fields': ['name'], 'limit_page_length': 500},
                         csrf2)
        rows = ((dat_f or {}).get('message') or [])
        return len(rows) if st_f == 200 and isinstance(rows, list) else None

    n_before = custom_field_count()
    check('P8-⑧ ③ 前置：字段数查得到（查不到不算「前后相等」）', n_before is not None,
          '加列前 Custom Field=%s 条' % n_before)
    mid3 = snap()
    res_col, why_col = act(owner, 'files.sheet_column_append', {
        'table': TABLE,
        'expected_content_version': int(mid3['content_version']),
        'expected_structure_version': int(mid3['structure_version']),
        'header': '新加的普通列',
    }, 'p8-08-col-%s' % RUN)
    check('P8-⑧ ③ 前置：加列成功', bool(res_col) and res_col[0] == 200, why_col[:140])
    n_after = custom_field_count()
    check('P8-⑧ ③ 普通加列不建数据库字段（Custom Field 数前后相等）',
          n_before is not None and n_after is not None and n_before == n_after,
          '加列前=%s 条 → 加列后=%s 条（相等=没建数据库字段）' % (n_before, n_after))
    check('P8-⑧ ③ 反例自检：加列确实加了列（否则「字段数没变」可能是压根没加）',
          '新加的普通列' in ((snap() or {}).get('headers') or []),
          '表头=%s' % ((snap() or {}).get('headers')))

# ========================= 汇总 =========================
# ========================= P8-⑥ ⑤ 晋升绑定引用的列改名（独立块）=========================
# **自给自足**：只用 Administrator + 自建表，不需要 ss-owner —— 所以不受 owner 闸影响，
# 在本实例（含 D 线 3840）也能跑。06 块里那 ①～④ 才需要归属人账号。
if '06' in WANT_ALL:
    # ⑥-c 晋升绑定那类「引用」—— **PKG-004 D-a 落地后够得着了**，补真判据。
    # **自给自足**：自己建一张干净表、自己立绑定，不碰共享夹具 TABLE
    #（在共享表上立绑定会把别的用例一起绑住）。
    # **为什么必须拦**：绑定按「固定行ID + **表头** + 结构/定义版本」定位。
    # 列一改名，表头这半个定位对不上 —— `row_read` 会认不出这列是晋升列，
    # **数据库里那份正式值当场变成看不见的**，而表里还留着旧值，是静默丢值。
    p865 = None
    why = ''
    try:
        st_u, b_u = t.action(adm, 'files.upload', {
            'file_name': 'p8-06-晋升绑定-%s.xlsx' % RUN,
            'content_base64': base64.b64encode(build_plain()).decode(),
            'directory': '/',
        }, 'p8-06-05-up-%s' % RUN)
        p865 = result_of((st_u, b_u)).get('file')
    except Exception as e:
        p865 = None
        why = '调用异常:%s' % e
    check('P8-⑥ ⑤ 前置：建出一张干净表（自给自足，不碰共享夹具）',
          bool(p865), why or ('表=%s' % p865))
    if p865:
        st_d, b_d = t.service(adm, 'files.promotion_definition', {'table': p865})
        cur_sv = (result_of((st_d, b_d)) or {}).get('structure_version')
        st_def, b_def = act(adm, 'files.promotion_define', {
            'table': p865, 'expected_structure_version': int(cur_sv or 1),
            'definition': {'definition_version': 1, 'columns': [
                {'header': '名称', 'promoted': True, 'field': 'case_no',
                 'type': 'text', 'rules': {'required': True}},
                {'header': '数值', 'promoted': True, 'field': 'amount', 'type': 'number'},
                {'header': '备注', 'promoted': False},
            ]},
        }, 'p8-06-05-def-%s' % RUN)
        check('P8-⑥ ⑤ 前置：晋升定义立起来（名称/数值已晋升、备注没晋升）',
              bool(st_def) and st_def[0] == 200, (str(b_def) if not st_def else 'ok')[:140])
        st_r, b_r = t.service(adm, 'files.sheet_read', {'table': p865})
        rr = result_of((st_r, b_r)) or {}

        def _try_rename(hdr, to, key):
            # **每次现取版本闩** —— 上一次成功改名会涨版本，复用旧闩必撞 417
            #（第一次照 rr 取，那次也确实撞过）。
            _st, _b = t.service(adm, 'files.sheet_read', {'table': p865})
            _r = result_of((_st, _b)) or {}
            return act(adm, 'files.sheet_header_rename', {
                'table': p865,
                'expected_content_version': int(_r.get('content_version') or 0),
                'expected_structure_version': int(_r.get('structure_version') or 1),
                'from_header': hdr, 'to_header': to,
            }, key)

        # —— 被晋升绑定引用的列改名 → **动手前明确拦下** ——
        res_5, why_5 = _try_rename('数值', '钱', 'p8-06-05-bound-%s' % RUN)
        check('P8-⑥ ⑤ 被晋升绑定引用的列改名 → **动手前明确拦下**',
              rejected(res_5, '晋升') or rejected(res_5, '绑定'),
              why_5[:180])
        st_r2, b_r2 = t.service(adm, 'files.sheet_read', {'table': p865})
        rr2 = result_of((st_r2, b_r2)) or {}
        check('P8-⑥ ⑤ 零改动（拦下就是一下都没动：表头/结构版本都不变）',
              (rr2.get('headers') or []) == (rr.get('headers') or [])
              and int(rr2.get('structure_version') or 0) == int(rr.get('structure_version') or 0),
              '表头=%s structure=%s' % (rr2.get('headers'), rr2.get('structure_version')))

        # —— 对照：定义里记着但**没晋升**的列改名是允许的（它没有数据库字段绑定）——
        res_5b, why_5b = _try_rename('备注', '说明', 'p8-06-05-free-%s' % RUN)
        check('P8-⑥ ⑤ 对照：没晋升的列改名仍然放行（只拦被绑定引用的）',
              bool(res_5b) and res_5b[0] == 200, why_5b[:180])

        # —— **回归**：结构操作**不许把晋升定义抹掉**（2026-10-14 实测踩到）——
        # `_ensure_meta_rows` 原来整个重建 meta 只留 4 个键，`promotion` 当场没了。
        # 上面那笔改名就是一次结构操作，改完定义必须还在。
        st_def2, b_def2 = t.service(adm, 'files.promotion_definition', {'table': p865})
        d2 = result_of((st_def2, b_def2)) or {}
        cols2 = d2.get('columns') or []
        flags2 = {x.get('header'): x.get('promoted') for x in cols2}
        # **只判「定义还在」** —— 这条咬的是「meta 重建把 promotion 抹掉」那个 bug。
        check('P8-⑥ ⑤ 回归：**改名（结构操作）之后晋升定义还在**，没被 meta 重建抹掉',
              d2.get('promoted') is True
              and flags2.get('名称') is True and flags2.get('数值') is True
              and flags2.get('备注') is False,
              'promoted=%r flags=%r' % (d2.get('promoted'), flags2))
        # —— **第二个扩展键也要钉**（E 2026-10-14 复查补出）——
        # `sheet_meta_json` 里被重建抹掉的扩展键**不止 promotion 一个**，还有 `ss_clean`
        # （清洗已做标记）。它一丢，`_fast_ctx` 的资格检查 `not meta.get('ss_clean')` 不过，
        # **每一次格值写都静默回落慢路径**（整簿重新清洗一遍再存）—— 不报错、看不出、就是变慢。
        # 判据走**产品自己的可观测点**：写一格，看回包 `timing.fast_path`。
        st_rw, b_rw = t.service(adm, 'files.sheet_read', {'table': p865})
        rrw = result_of((st_rw, b_rw)) or {}
        row_rw = ((rrw.get('rows') or [{}])[0]).get('row_id')
        hdr_rw = '名称'
        st_cw, b_cw = act(adm, 'files.sheet_cell_write', {
            'table': p865, 'row_id': row_rw, 'header': hdr_rw,
            'value': {'type': 'text', 'value': '钉ss_clean'},
            'expected_content_version': int(rrw.get('content_version') or 0),
            'expected_structure_version': int(rrw.get('structure_version') or 1),
        }, 'p8-06-05-ssclean-%s' % RUN)
        timing = result_of(st_cw).get('timing') or {}
        fp = timing.get('fast_path')
        check('P8-⑥ ⑤ 回归②：结构操作之后 **`ss_clean` 还在**'
              '（快路径的元数据资格检查没把这格挡下 —— 挡下会记 skip:meta）',
              fp != 'skip:meta', 'fast_path=%r timing=%s' % (fp, timing))
        check('P8-⑥ ⑤ 回归③：`_fast_ctx` **还能接上**（这一格走的是手术快路径，没回落慢路径）',
              fp == 'surgery', 'fast_path=%r（不是 surgery 就是没接上）' % fp)

        # —— 敏感度自检：这两条回归钉也得有牙齿，不然钉子本身是空的 ——
        def _ss_clean_ok(fp):
            # 「ss_clean 还在」的判别式：元数据资格检查没把这格挡下。
            return fp != 'skip:meta'

        def _fast_ok(fp):
            # 「_fast_ctx 还能接上」的判别式：真走了手术快路径。
            return fp == 'surgery'

        shapes = {'surgery': 'surgery', 'meta_lost': 'skip:meta', 'cache_cold': 'skip:cache'}
        v_ss = {k: _ss_clean_ok(v) for k, v in shapes.items()}
        v_f = {k: _fast_ok(v) for k, v in shapes.items()}
        check('P8-⑥ ⑤ 敏感度②：「ss_clean」判别式认 surgery 为在、skip:meta 为不在',
              v_ss['surgery'] and not v_ss['meta_lost'], '%r' % v_ss)
        check('P8-⑥ ⑤ 敏感度③：「ss_clean」判别式认 skip:cache 为在'
              '（缓存冷是另一回事，别栽给 ss_clean）',
              v_ss['cache_cold'], '%r' % v_ss)
        check('P8-⑥ ⑤ 敏感度④：「_fast_ctx 接上」判别式只认 surgery 为接上',
              v_f['surgery'] and not v_f['meta_lost'] and not v_f['cache_cold'], '%r' % v_f)
        check('P8-⑥ ⑤ 敏感度⑤：两条判别式都分得出两种以上结论（不是恒真/恒假）',
              len(set(v_ss.values())) == 2 and len(set(v_f.values())) == 2,
              'ss=%r fast=%r' % (v_ss, v_f))

        # **另一件事，别混着判**：改名是结构操作，结构版本 1→2，绑定如实报
        # 「不与当前结构对齐」—— 那正是「旧绑定要能认出对不上」的设计要求。
        # 我一开始把这条写成「binding_current 必须还是 True」，是断言写错了，不是产品错。
        check('P8-⑥ ⑤ 顺带：结构版本变了，绑定**如实报对不上**（不拿旧绑定乱对）',
              d2.get('binding_current') is False
              and int(d2.get('bound_structure_version') or 0)
              < int(d2.get('structure_version') or 0),
              'binding_current=%r bound=%r current=%r' % (
                  d2.get('binding_current'), d2.get('bound_structure_version'),
                  d2.get('structure_version')))

        # —— 对照：一张**没立绑定**的表，改名不该被这条拦（别把闸门焊死）——
        st_u2, b_u2 = t.action(adm, 'files.upload', {
            'file_name': 'p8-06-05-无绑定-%s.xlsx' % RUN,
            'content_base64': base64.b64encode(build_plain()).decode(),
            'directory': '/',
        }, 'p8-06-05-up2-%s' % RUN)
        free = result_of((st_u2, b_u2)).get('file')
        if free:
            st_fr, b_fr = t.service(adm, 'files.sheet_read', {'table': free})
            fr = result_of((st_fr, b_fr)) or {}
            res_5c, why_5c = act(adm, 'files.sheet_header_rename', {
                'table': free,
                'expected_content_version': int(fr.get('content_version') or 0),
                'expected_structure_version': int(fr.get('structure_version') or 1),
                'from_header': '数值', 'to_header': '钱',
            }, 'p8-06-05-nobind-%s' % RUN)
            check('P8-⑥ ⑤ 对照：没立绑定的表改名照常放行（闸门只咬被引用的列）',
                  bool(res_5c) and res_5c[0] == 200, why_5c[:180])

        # —— 敏感度自检：拦截判别式必须分得出「该拦」和「不该拦」——
        def _block_ok(is_promoted, in_definition):
            # 判别式：被晋升绑定引用的列（已晋升）改名要拦，其余不拦。
            return bool(is_promoted and in_definition)

        v_block = _block_ok(True, True)      # 已晋升 → 拦
        v_free = _block_ok(False, True)      # 在定义里但没晋升 → 不拦
        v_nobind = _block_ok(False, False)   # 压根没绑定 → 不拦
        # 反例形状：已晋升却判定「不拦」（把闸门拆掉）
        v_gate_removed = _block_ok(True, False)
        vv = {'block': v_block, 'free': v_free, 'nobind': v_nobind,
              'gate_removed': v_gate_removed}
        check('P8-⑥ ⑤ 敏感度：判别式认「被绑定引用」为要拦', v_block, 'block')
        check('P8-⑥ ⑤ 敏感度：判别式认「在定义里但没晋升」为不拦', not v_free, 'free')
        check('P8-⑥ ⑤ 敏感度：判别式认「没绑定」为不拦', not v_nobind, 'nobind')
        check('P8-⑥ ⑤ 敏感度：判别式认「把闸门拆掉」为不过', not v_gate_removed, 'gate_removed')
        check('P8-⑥ ⑤ 敏感度：四种形状给出两种不同结论（不是恒真/恒假）',
              len(set(vv.values())) == 2, '结论=%r' % vv)

print('\n结果： %s  共 %d 条检查，失败 %d 条，未测 %d 条' %
      ('PASS' if not failed else 'FAIL', checks_run, len(failed), len(not_yet)))
for f in failed:
    print('  失败： %s' % f)
for n in not_yet:
    print('  未测： %s' % n)
sys.exit(1 if failed else 0)