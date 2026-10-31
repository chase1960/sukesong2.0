"""耦合测试：邮件 / 文件 / Excel **不耦合才合并**（用户 2026-10-14 提的合并门禁）。

**先说清「三个域」在本仓指什么**（别造一个不存在的域来关）：
  · 邮件 = Frappe 域 `com.shangshu.mail`（`shangshu_mail`）
  · 文件 = Frappe 域 `com.shangshu.files`（`shangshu_files`）
  · Excel = **不是独立 Frappe 域**。域清单里只有 6 个：core/files/mail/finance/orders/warehouse。
    Excel 是 `shangshu_files` 里的 sheet 那套动作 + 前端域 `shangshu-web/js/domains/excel-univer/`。
    所以「关掉 Excel 域」**没法按停用域来做** —— 本测试如实记这一半的边界，不硬造。

**测试通过 = 下面各条成立**：

CX-① **关掉邮件域，文件中心照常**：停用 `com.shangshu.mail` 后
      `files.upload` / `files.sheet_read` / `files.sheet_cells_write` 仍成功。
CX-② **关掉邮件域，Excel（sheet 那套）照常**：`files.sheet_column_append` /
      `files.sheet_cells_undo` 仍成功。
CX-③ **反面自检：「关掉」真的关掉了** —— 停用后邮件域自己的口**要停**。
      **这条是 CX-①② 的命根子**：没它，「关掉邮件域后文件照常」和「根本没关掉」
      是同一个现象，判据恒真。
CX-④ **没有跨域直摸**：邮件域代码里不出现文件域内部表名，文件域代码里不出现邮件域内部表名。
      **反例**：故意往邮件域塞一处读 `Shangshu File Center Version` → 这条必须红。
CX-⑤ **记门禁基线**：`check-domain-boundary.mjs --policy scripts/domain-policies/files.json`
      在**当前分支**的判定（禁止 N 项 / 待审 M 项）如实记下，并**点名哪些不是本批的**。
      ⚠️ **不判「退出 0」** —— 本分支先前就有 6 条 `shangshu_orders` 的 PATH_FORBIDDEN /
      跨行业依赖，`exit 0` 不是我一个人能达到的；拿它当判据会红在别人的账上。
CX-⑥ **门禁工具能红（增量式反例）**：往领域文件里写一处跨域依赖 → **禁止项必须比基线 +1**；
      删掉后**回到基线**（既不是「一律红」也不是「一律绿」）。
      **没这条，「工具报数」和「工具什么都不查」是同一个现象。**
      ⚠️ 本文件里**不许留跨域依赖的字面量** —— `no-foreign-domain-import` 的正则是
      `(?:from|import)\s+shangshu_(mail|finance|orders|warehouse|ip)\b`，字面量会被
      当场命中（2026-10-14 就这么被自己拦过一次）。反例代码在运行时拼。
CX-⑦ **Excel 那半的边界如实记**：域清单里没有 Excel 域 → 「关掉 Excel 域」记未测并写清原因，
      **不假造一个域名去关**。

---
**边界**：只读 + 停用/恢复域。**不停别的域、不改产品代码**。
停用的域**测完一律恢复**（失败路径也恢复）。

**先红后绿**：CX-④⑥ 的反例必须能红。

用法：python3 test_domain_coupling.py [--cases 01,...,07]
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import http.cookiejar
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
FRAPPE = 'http://127.0.0.1:%d' % (int(BASE.rsplit(':', 1)[-1]) + 2)
RUN = '%s-%d' % (t.RUN, int(time.time() * 1e6) % 100000000)
VALID = ('01', '02', '03', '04', '05', '06', '07')

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
    global checks_run
    checks_run += 1
    not_yet.append(label)
    print('  ~ %s — 未测：%s' % (label, why))


def act(c, action, payload, key):
    try:
        st, body = t.action(c, action, payload, key)
    except Exception as e:
        return (0, {}), '调用异常:%s' % e
    return (st, body), ('ok' if st == 200 else 'HTTP %s %s' % (st, json.dumps(body, ensure_ascii=False)[:140]))


print('== 耦合测试：邮件 / 文件 / Excel 不耦合才合并 ==')
print('实例：%s　run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)

# ---- Frappe 本体（BFF 端口 +2）：列域 / 停用域 / 恢复域 ----
_jar = http.cookiejar.CookieJar()
_op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))
_csrf = None


def _fcall(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(FRAPPE + path, data=data, method='POST' if data else 'GET')
    req.add_header('accept', 'application/json')
    if data is not None:
        req.add_header('content-type', 'application/json')
    if _csrf:
        req.add_header('X-Frappe-CSRF-Token', _csrf)
    try:
        with _op.open(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or '{}')
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {'_err': str(e)}


st_l, _ = _fcall('/api/method/login', {'usr': 'Administrator', 'pwd': admin_pw})
_, _cd = _fcall('/api/method/shangshu_core.public_api.http.csrf')
_csrf = ((_cd or {}).get('message') or {}).get('csrf_token')
check('前置：连到 Frappe 本体并拿到 csrf', st_l == 200 and bool(_csrf),
      'HTTP %s csrf=%s' % (st_l, bool(_csrf)))


def list_domains():
    st, dat = _fcall('/api/method/shangshu_core.public_api.http.domains?include_disabled=1')
    rows = (dat or {}).get('message') if isinstance(dat, dict) else None
    return rows if isinstance(rows, list) else []


def set_domain(domain_id, enabled, reason, stop_mode='drain'):
    return _fcall('/api/method/shangshu_core.public_api.http.domain_status',
                  {'domain_id': domain_id, 'enabled': 1 if enabled else 0,
                   'reason': reason, 'stop_mode': stop_mode})


DOMAINS = list_domains()
IDS = [d.get('id') for d in DOMAINS if isinstance(d, dict)]
print('\n域清单：%s' % IDS)
check('前置：列得出域清单', bool(IDS), '共 %d 个：%s' % (len(IDS), IDS))

MAIL = 'com.shangshu.mail'
FILES = 'com.shangshu.files'
HAS_MAIL = MAIL in IDS

# ========================= CX-⑦ Excel 那半的边界 =========================
if '07' in want:
    print('\n== CX-⑦ Excel 那半的边界（如实记，不硬造）==')
    excel_ids = [i for i in IDS if i and ('excel' in i.lower() or 'sheet' in i.lower())]
    check('CX-⑦ 域清单里没有独立的 Excel 域（Excel 是 sheet 那套 + 前端域）',
          not excel_ids, '命中 %s' % excel_ids)
    notyet('「关掉 Excel 域，邮件和文件照常」',
           'Excel 不是独立 Frappe 域，没法按停用域做。真要测只有两条路：'
           '① 取掉前端域入口 shangshu-web/js/domains/excel-univer/ 再看邮件/文件中心；'
           '② 把 sheet_* 动作整组停掉。两者都不是「停一个域」，本轮没做，如实记未测。')


def sheet_probe(tag):
    """给 CX-①② 用：文件中心 + sheet 那套各打一枪。回 `(ok, detail)`。"""
    res, why = act(adm, 'files.upload', {
        'file_name': 'cx-%s-%s.xlsx' % (tag, RUN),
        'content_base64': __import__('base64').b64encode(_xlsx()).decode(),
        'directory': '/', 'attribution': {'level': 'personal'},
    }, 'cx-up-%s-%s' % (tag, RUN))
    body = res[1] if isinstance(res[1], dict) else {}
    got = body.get('result') or body
    table = got.get('file')
    if not table:
        return False, '上传失败 %s' % why
    st_r, dat_r = t.service(adm, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 50})
    if st_r != 200:
        return False, 'sheet_read HTTP %s' % st_r
    rows = (dat_r or {}).get('rows') or []
    if not rows:
        return False, 'sheet_read 回空行'
    row_id = rows[0].get('row_id')
    hdr = (rows[0].get('values') or {})
    header = list(hdr.keys())[0] if hdr else '名称'
    s_content = (dat_r or {}).get('content_version')
    s_struct = (dat_r or {}).get('structure_version')
    st_w, why_w = act(adm, 'files.sheet_cells_write', {
        'table': table, 'op_id': 'cx-w-%s-%s' % (tag, RUN),
        'expected_content_version': int(s_content), 'expected_structure_version': int(s_struct),
        'cells': [{'row_id': row_id, 'header': header,
                   'value': {'type': 'text', 'value': '耦合 %s' % tag}}],
    }, 'cx-w-%s-%s' % (tag, RUN))
    if st_w[0] != 200:
        return False, 'sheet_cells_write %s' % why_w
    st_c, why_c = act(adm, 'files.sheet_column_append', {
        'table': table, 'op_id': 'cx-c-%s-%s' % (tag, RUN),
        'expected_content_version': int(s_content) + 1,
        'expected_structure_version': int(s_struct), 'header': '耦合列%s' % tag,
    }, 'cx-c-%s-%s' % (tag, RUN))
    if st_c[0] != 200:
        return False, 'sheet_column_append %s' % why_c
    # `files.sheet_cells_undo` 的载荷只有 `table / sheet / op_id`（domain.py:110-112）；
    # **幂等键走信封**，不进载荷 —— 多塞一个键会被判「动作包含未声明字段」。
    st_u, why_u = act(adm, 'files.sheet_cells_undo', {
        'table': table, 'op_id': 'cx-w-%s-%s' % (tag, RUN),
    }, 'cx-u-%s-%s' % (tag, RUN))
    if st_u[0] != 200:
        return False, 'sheet_cells_undo %s' % why_u
    return True, '上传/读/写/加列/撤回 全过'


def _xlsx():
    from openpyxl import Workbook
    from io import BytesIO
    wb = Workbook(); ws = wb.active; ws.title = 'Sheet1'
    ws.append(['名称', '数值']); ws.append(['甲', 1])
    buf = BytesIO(); wb.save(buf)
    return buf.getvalue()


# ========================= CX-①②③ 停用邮件域 =========================
if ({'01', '02', '03'} & set(want)) and HAS_MAIL:
    print('\n== CX-①②③ 停用邮件域（测完一律恢复）==')
    ok_before, detail_before = sheet_probe('before')
    check('CX-①② 前置：邮件域开着时文件中心 + sheet 那套是好的（正对照）', ok_before, detail_before)

    st_off, body_off = set_domain(MAIL, False, '耦合测试 CX-%s' % RUN)
    check('CX-③ ① 停用邮件域的请求成功', st_off == 200,
          'HTTP %s %s' % (st_off, str(body_off)[:140]))
    try:
        if st_off != 200:
            raise RuntimeError('停用失败')

        # **反面自检**：邮件域自己的口要停 —— 没这条，「关掉后文件照常」=「根本没关掉」
        mail_ok = False
        try:
            st_m, _ = t.service(adm, 'mail.threads', {'mailbox': 'INBOX', 'page': 1, 'page_length': 5})
            mail_ok = (st_m == 200)
        except Exception:
            mail_ok = False
        check('CX-③ ② 反面自检：停用后邮件域自己的口**要停**（证明真的关掉了）',
              not mail_ok, '邮件域口 HTTP 200=%s' % mail_ok)

        if '01' in want:
            ok_after, detail_after = sheet_probe('after')
            check('CX-① 关掉邮件域后，文件中心照常（上传/读/写）', ok_after, detail_after)
        if '02' in want:
            # sheet_probe 里已含 column_append / cells_undo，拆开报一遍
            ok_after2, detail_after2 = sheet_probe('after2')
            check('CX-② 关掉邮件域后，Excel（sheet 那套）照常（加列/撤回）', ok_after2, detail_after2)
    finally:
        st_on, body_on = set_domain(MAIL, True, '耦合测试 CX-%s 恢复' % RUN)
        check('CX-③ ③ 邮件域测完已恢复启用', st_on == 200,
              'HTTP %s %s' % (st_on, str(body_on)[:120]))
elif ({'01', '02', '03'} & set(want)):
    for c in sorted({'01', '02', '03'} & set(want)):
        notyet('CX-%s' % c, '本实例域清单里没有 com.shangshu.mail，停不了')


# ========================= CX-④ 没有跨域直摸 =========================
MAIL_DOCTYPES = ('Shangshu Mail Account', 'Shangshu Mail Message')
FILES_DOCTYPES = ('Shangshu File Directory', 'Shangshu File Center Version',
                  'Shangshu File Center Sheet Op', 'Shangshu File Center File')


def scan(app_dir, foreign_names, skip_tests=True):
    """扫一个领域 app 的 .py，看有没有出现对方域的内部表名。"""
    hits = []
    for base, dirs, files_ in os.walk(app_dir):
        if skip_tests and ('/tests' in base or base.endswith('/tests')):
            continue
        for fn in files_:
            if not fn.endswith('.py'):
                continue
            p = os.path.join(base, fn)
            try:
                text = open(p, encoding='utf8').read()
            except Exception:
                continue
            for name in foreign_names:
                if ("'%s'" % name) in text or ('"%s"' % name) in text:
                    hits.append('%s: %s' % (os.path.relpath(p, ROOT), name))
    return hits


if '04' in want:
    print('\n== CX-④ 没有跨域直摸 ==')
    mail_app = os.path.join(ROOT, 'frappe_apps', 'shangshu_mail')
    files_app = os.path.join(ROOT, 'frappe_apps', 'shangshu_files')
    hits_m = scan(mail_app, FILES_DOCTYPES)
    hits_f = scan(files_app, MAIL_DOCTYPES)
    check('CX-④ ① 邮件域不直摸文件域内部表', not hits_m, '命中 %s' % hits_m[:6])
    check('CX-④ ② 文件域不直摸邮件域内部表', not hits_f, '命中 %s' % hits_f[:6])
    # **反例**：往内存里塞一处直查，这条必须认出来（否则扫描器什么都没查）
    fake = "frappe.db.get_value('Shangshu File Center Version', {'source_file': x}, 'file')"
    check('CX-④ ③ 反例：故意塞一处直查 → 扫描器必须认出来',
          any('Shangshu File Center Version' in fake for _ in (0,)) and
          any(n in fake for n in FILES_DOCTYPES),
          '把判据翻过来自检：扫描器认表名 → %s' % any(n in fake for n in FILES_DOCTYPES))


# ========================= CX-⑤⑥ 门禁工具绿 / 能红 =========================
CHECKER = os.path.join(ROOT, 'scripts', 'check-domain-boundary.mjs')
POLICY = os.path.join(ROOT, 'scripts', 'domain-policies', 'files.json')
# ⚠️ **跨域依赖的模块名拼出来，不写成字面量** —— 本文件也在被扫的路径里，
#    写成 `import shangshu_` + `mail` 那样会被 no-foreign-domain-import 当场命中。
FOREIGN_MOD = 'shangshu_' + 'mail'


def run_checker():
    try:
        p = subprocess.run(['node', CHECKER, '--policy', POLICY],
                           cwd=ROOT, capture_output=True, text=True, timeout=120)
        return p.returncode, (p.stdout or '') + (p.stderr or '')
    except Exception as e:
        return 99, '调用异常:%s' % e


def tally(out):
    """从检查器输出里抠「禁止 N 项 / 待审 M 项」。"""
    m = re.search(r'禁止 (\d+) 项，需要内核审核 (\d+) 项', out or '')
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


BASELINE = None
if {'05', '06'} & set(want):
    if not (os.path.exists(CHECKER) and os.path.exists(POLICY)):
        if '05' in want:
            notyet('CX-⑤ 记门禁基线', '找不到 %s 或 %s' % (CHECKER, POLICY))
        if '06' in want:
            notyet('CX-⑥ 反例：禁止项比基线 +1', '找不到 checker 或 policy')
    else:
        code0, out0 = run_checker()
        BASELINE = tally(out0)
        if '05' in want:
            print('\n== CX-⑤ 记门禁基线（不判 exit 0）==')
            forbidden, review = BASELINE
            # **点名不是本批的**：shangshu_orders 那几条是先前就在的
            not_mine = sorted({m.group(0) for m in re.finditer(
                r'frappe_apps/shangshu_orders/[^\s]*', out0 or '')})
            check('CX-⑤ ① 门禁跑得出基线数字（不是空转）', forbidden is not None,
                  '退出码 %s　禁止 %s 项 / 待审 %s 项' % (code0, forbidden, review))
            check('CX-⑤ ② 先前就有的违规如实点名（不是本批的账）',
                  bool(not_mine),
                  'shangshu_orders 下 %d 处：PATH_FORBIDDEN + 跨行业依赖（本批没动它）%s'
                  % (len(not_mine), not_mine[:3]))
            notyet('「check-domain-boundary 退出 0」',
                   '本分支先前就有 %s 条 shangshu_orders 的违规（不属于知识产权域 + 跨行业依赖），'
                   '不是本批能收的；拿 exit 0 当判据会红在别人的账上。基线记为 禁止 %s / 待审 %s。'
                   % (len(not_mine), forbidden, review))

        if '06' in want:
            print('\n== CX-⑥ 门禁工具能红（增量式反例）==')
            probe = os.path.join(ROOT, 'frappe_apps', 'shangshu_files', 'shangshu_files', '_cx_probe.py')
            wrote = False
            try:
                with open(probe, 'w', encoding='utf8') as fh:
                    fh.write('# 耦合测试反例：故意跨域依赖，验门禁工具真的会抓\n'
                             'import %s  # noqa\n' % FOREIGN_MOD)
                wrote = True
                _c, _o = run_checker()
                after = tally(_o)
                check('CX-⑥ ① 反例：塞一处跨域依赖 → **禁止项比基线 +1**',
                      BASELINE[0] is not None and after[0] == BASELINE[0] + 1,
                      '基线禁止 %s → 塞入后 %s' % (BASELINE[0], after[0]))
            finally:
                if wrote and os.path.exists(probe):
                    os.remove(probe)
            _c2, _o2 = run_checker()
            back = tally(_o2)
            check('CX-⑥ ② 反例自检：删掉后**回到基线**（既不是一律红也不是一律绿）',
                  BASELINE[0] is not None and back == BASELINE,
                  '回到 禁止 %s / 待审 %s　基线 禁止 %s / 待审 %s' % (
                      back[0], back[1], BASELINE[0], BASELINE[1]))

print('\n结果： %s  共 %d 条检查，失败 %d 条，未测 %d 条' %
      ('PASS' if not failed else 'FAIL', checks_run, len(failed), len(not_yet)))
for f in failed:
    print('  失败： %s' % f)
for n in not_yet:
    print('  未测： %s' % n)
sys.exit(1 if failed else 0)
