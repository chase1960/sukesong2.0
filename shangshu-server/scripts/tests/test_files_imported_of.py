"""`files.imported_of` —— 按「来源附件」反查「已入库的受管文件」。

**任务归属**：合并门禁「邮件/文件/Excel 不耦合才合并」（用户 2026-10-14 提）。
邮件侧有 4 处 `frappe.db.exists('Shangshu File Center Version', {'source_file': …})`
这种**直查文件域内部表**的跨域耦合，要换成走公共口。本口覆盖其中的**批量读**那一类。

**先说清哪些不用本口**（避免把耦合面越补越大）：
  · 幂等判断、图片重接取受管文件 id —— `files.import_attachment` 的**回包**本来就带
    `file`（受管文件 id）和 `already_imported`，改用回包即可，**不需要查询口**，
    顺带消掉按 `file_name` 全库匹配取 id 的隐患（回包给的是稳定 id）。
  · 只有**列表投影里给每个附件算 `imported` 标记**是批量读，导入动作答不了 —— 那才是本口。

**测试通过 = 下面各条成立**：

IC-① **口调得到**：`files.imported_of` 已注册，**错因不是「领域服务不存在」**。
IC-② **回包形状对得上前端取值链**：`d.result?.items || d.items` **真能取到数组**。
     ⚠️ 这条是 identity 那单的教训 —— handler 回裸数组会被 BFF 的
     `res.json({ok:true,...msg})` 摊成 `{ok:true,"0":…}`，**端点通了但前端照旧空，
     「修了等于没修」**。所以必须回 `{items:[…]}`。反例：回包里不许出现数字键。
IC-③ **没入库 → 明确的「没有」**：`imported: false` + `file_center_id: null`。
IC-④ **入库后 → `imported: true` + `file_center_id`，且这个 id 和
     `files.import_attachment` 回包的 `file` 是同一个**（同源稳定 id，不是按名字猜的）。
     **反例（本条的命根子）**：两个**同名**的来源附件分别导入 → 必须给出**不同**的
     `file_center_id`。没这条，「按稳定身份查」和「按文件名全库匹配」是同一个现象，
     而后者正是 `delivery.py:422` 的隐患。
IC-⑤ **不存在的 source_file 明确报错**，**不许回 `imported: false`** ——
     「查不到」和「没入库」是同一个现象，会被读成「这附件还没进」。
IC-⑥ **批量**：一次查多个，各自独立正确；**含「有」「无」混合**不互相污染。
IC-⑦ **无权不越权**（两半都要，缺一半就虚）：
      ⑦-① **正对照**：对受管文件**有**读权的调用者，拿得到 `file_center_id`。
           **这条是命根子** —— 没它，「无权不泄」和「口一律回 null」是同一个现象。
      ⑦-② **负例**：对受管文件**无**读权的调用者，`imported` 如实是 true（不撒谎说没入库），
           但 `file_center_id` **不泄**（置空 + `restricted: true`）。
           ⚠️ 造不出「真无权」状态时**如实记未测**，不拿「拿不到 id」冒充通过 ——
           那是把假绿当绿（2026-10-14 踩过：`ss-reader` 在 B 上是编辑者，
           本来就有权，拿得到 id 是对的）。
IC-⑧ **「已入库」认两条路**（少一条就判错）：附件**从文件中心选来**当附件用时
      （`file-reference-picker.js` 推的是 `frappe_file`），它本来就在中心里，
      但 `source_file` 反查不成立。**只认 `source_file` 会误判「没入库」**，
      界面多出一个「存入」按钮，点下去再导一遍。
      所以：`frappe_file` 那条路也要认成 `imported: true`。

---
**边界**：只加一个**只读**领域服务。路径在 `frappe_apps/shangshu_files/`
（**不在 `core_paths`**，见 `fde-commit-policy.json` 的 special_paths），
不需要 CORE-CANDIDATE。**不动内核**、不动既有服务的 handler 与 schema。

**先红后绿**：服务没注册时 IC-① 应红。
**反例（故意翻期望）必须能红**，否则判据恒真。

用法：python3 test_files_imported_of.py [--cases 01,...,07]
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
# **RUN 必须到微秒**：秒级会在同秒重跑时复用幂等键 → 产品正确回 409，看着像竞态其实不是。
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
    return (st, body), ('ok' if st == 200 else 'HTTP %s %s' % (st, json.dumps(body, ensure_ascii=False)[:160]))


def svc(c, name, payload):
    try:
        return t.service(c, name, payload)
    except Exception as e:
        return 0, {'error': '调用异常:%s' % e}


def items_of(dat):
    """取 `d.result?.items || d.items` —— 前端取值链。"""
    if not isinstance(dat, dict):
        return None
    got = (dat.get('result') or {}).get('items') if isinstance(dat.get('result'), dict) else None
    return got if got is not None else dat.get('items')


print('== files.imported_of ==')
print('实例：%s　run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)

PW = 'b2-user-pw-2026'


def _login_or_none(username):
    c = t.Client(BASE)
    try:
        c.login(username, PW)
        return c
    except SystemExit:
        return None


owner = _login_or_none('ss-owner@example.invalid')
if owner is None:
    print('  ~ 本实例没有 ss-owner@example.invalid —— 归属人相关用例将记「未测」')

print('\n== 建样本：两个**同名**来源附件，落**两个目录**（IC-④ 反例的命根子）==')
SRC_A = SRC_B = None      # 来源附件的 Frappe File id（import_attachment 的 source.file）
SRCFILE_A = SRCFILE_B = None
if owner is None:
    print('  ~ 跳过：没有归属人账号')
else:
    from openpyxl import Workbook

    def _xlsx(val):
        wb = Workbook(); ws = wb.active; ws.title = 'Sheet1'
        ws.append(['名称', '数值']); ws.append(['甲', val])
        buf = BytesIO(); wb.save(buf)
        return base64.b64encode(buf.getvalue()).decode()

    def _src_of(file_id):
        """来源附件 id = `files.versions` 回的 `frappe_file`（照 test_g1 的现成口径）。"""
        st_v, dat_v = svc(owner, 'files.versions', {'file': file_id})
        vers = (dat_v or {}).get('versions') or []
        return vers[0].get('frappe_file') if vers else None

    # **两个目录**：同目录会同名合并成一个受管文件，那就打不中「按文件名匹配会串号」的隐患。
    # `files.directory_create` 要 `title`（不是 name），且要 System Manager —— 用 Administrator 建。
    DIRS = []
    for tag in ('A', 'B'):
        res, why = act(adm, 'files.directory_create', {'title': 'ic-%s-%s' % (tag, RUN), 'parent': ''},
                       'ic-dir-%s-%s' % (tag, RUN))
        body = res[1] if isinstance(res[1], dict) else {}
        got = body.get('result') or body
        d = got.get('directory') or got.get('name') or got.get('id')
        check('建目录 %s' % tag, res[0] == 200 and bool(d), 'HTTP %s d=%r %s' % (res[0], d, why[:100]))
        # `files.upload` / `import_attachment` 的 `directory` 要**路径**不是 id
        # （id 会撞「目录路径须形如 /案件/CN3024518」的校验）。
        DIRS.append('/ic-%s-%s' % (tag, RUN))

    # 同一个文件名，分别放进两个目录
    for tag, val, d in (('A', 1, DIRS[0]), ('B', 2, DIRS[1])):
        res, why = act(owner, 'files.upload', {
            'file_name': 'ic-same-name-%s.xlsx' % RUN,
            'content_base64': _xlsx(val),
            'directory': d, 'attribution': {'level': 'personal'},
        }, 'ic-up-%s-%s' % (tag, RUN))
        body = res[1] if isinstance(res[1], dict) else {}
        got = body.get('result') or body
        fid = got.get('file') or got.get('file_id')
        att = _src_of(fid) if fid else None
        check('上传同名来源附件 %s 并取到来源附件 id' % tag, bool(fid and att),
              '受管=%r 来源附件=%r %s' % (fid, att, why[:80]))
        if tag == 'A':
            SRCFILE_A, SRC_A = fid, att
        else:
            SRCFILE_B, SRC_B = fid, att
    print('  来源附件 A=%r B=%r（同名不同目录）' % (SRC_A, SRC_B))

print('\n== 结果会在下面按用例逐条出 ==')
if owner is None:
    for c in want:
        notyet('IC-%s' % c, '本实例没有 ss-owner@example.invalid（B 侧专用账号），前提不齐')
    print('\n结果： %s  共 %d 条检查，失败 %d 条，未测 %d 条' %
          ('PASS' if not failed else 'FAIL', checks_run, len(failed), len(not_yet)))
    sys.exit(1 if failed else 0)

# ========================= IC-① 口调得到 =========================
if '01' in want:
    print('\n== IC-① 口调得到 ==')
    st, dat = svc(adm, 'files.imported_of', {'source_files': ['x']})
    err = str(dat)
    check('IC-① 服务已注册（错因不是「领域服务不存在」）', '领域服务不存在' not in err,
          'HTTP %s  错因=%s' % (st, err[:150]))

# ========================= IC-② 回包形状 =========================
if '02' in want:
    print('\n== IC-② 回包形状对得上前端取值链 ==')
    st, dat = svc(owner, 'files.imported_of', {'source_files': [SRC_A] if SRC_A else ['x']})
    got = items_of(dat)
    check('IC-② d.result?.items || d.items 真能取到数组', isinstance(got, list),
          '顶层键=%s items=%s' % (sorted(dat.keys())[:8] if isinstance(dat, dict) else type(dat).__name__,
                                  type(got).__name__))
    if isinstance(dat, dict):
        spread = any(k.isdigit() for k in dat.keys())
        check('IC-② 反例：回包没被摊成 {ok:true,"0":…}（裸数组会这样）',
              not spread, '出现数字键=%s' % [k for k in dat if k.isdigit()][:5])

# ========================= IC-③④⑤⑥⑦ —— 需要真实导入 =========================
print('\n== 用 import_attachment 真导入，再查 ==')
IMPORTED_A = IMPORTED_B = None
if SRC_A and SRC_B and SRCFILE_A and SRCFILE_B:
    for tag, ref, att in (('A', SRCFILE_A, SRC_A), ('B', SRCFILE_B, SRC_B)):
        res, why = act(owner, 'files.import_attachment', {
            'source': {'ref_doctype': 'Shangshu File Center File', 'ref_name': ref, 'file': att},
            'directory': '/ic-%s-%s' % (tag, RUN), 'note': 'ic 导入 %s' % tag,
        }, 'ic-imp-%s-%s' % (tag, RUN))
        body = res[1] if isinstance(res[1], dict) else {}
        got = body.get('result') or body
        fid = got.get('file')
        check('导入来源附件 %s（拿到受管文件 id）' % tag, res[0] == 200 and bool(fid),
              'HTTP %s file=%r already_imported=%r err=%s' % (
                  res[0], fid, got.get('already_imported'), why[:100]))
        if tag == 'A':
            IMPORTED_A = fid
        else:
            IMPORTED_B = fid
    check('反例前提：两个受管文件同名但不同 id（否则打不中「按文件名匹配会串号」）',
          bool(IMPORTED_A and IMPORTED_B and IMPORTED_A != IMPORTED_B),
          'A=%r B=%r' % (IMPORTED_A, IMPORTED_B))
else:
    print('  ~ 前提不齐，跳过导入')

if '03' in want:
    print('\n== IC-③ 没入库 → 明确的「没有」 ==')
    ghost = 'ic-ghost-%s' % RUN
    st, dat = svc(owner, 'files.imported_of', {'source_files': [ghost]})
    lst = items_of(dat) or []
    row = lst[0] if lst and isinstance(lst[0], dict) else {}
    check('IC-③ 未入库回 imported:false + file_center_id:null',
          row.get('imported') is False and row.get('file_center_id') in (None, ''),
          'row=%s' % json.dumps(row, ensure_ascii=False)[:140])

if '04' in want and IMPORTED_A and IMPORTED_B:
    print('\n== IC-④ 入库后 id 同源；同名不同附件不许串 ==')
    st, dat = svc(owner, 'files.imported_of', {'source_files': [SRC_A, SRC_B]})
    lst = items_of(dat) or []
    by_src = {r.get('source_file'): r for r in lst if isinstance(r, dict)}
    ra, rb = by_src.get(SRC_A, {}), by_src.get(SRC_B, {})
    check('IC-④ ① 入库后 imported:true 且带 file_center_id',
          ra.get('imported') is True and bool(ra.get('file_center_id')),
          'A=%s' % json.dumps(ra, ensure_ascii=False)[:120])
    check('IC-④ ② file_center_id 与 import_attachment 回包同源',
          ra.get('file_center_id') == IMPORTED_A and rb.get('file_center_id') == IMPORTED_B,
          '查到 A=%r 期望=%r　查到 B=%r 期望=%r' % (
              ra.get('file_center_id'), IMPORTED_A, rb.get('file_center_id'), IMPORTED_B))
    # **命根子**：同名不同附件必须给出不同 id —— 按文件名全库匹配会在这里串号
    check('IC-④ ③ 反例：同名不同附件给出**不同**的 file_center_id（不按文件名匹配）',
          ra.get('file_center_id') != rb.get('file_center_id'),
          'A=%r  B=%r' % (ra.get('file_center_id'), rb.get('file_center_id')))

if '05' in want:
    print('\n== IC-⑤ 不存在的 source_file 不许静默「没入库」 ==')
    st, dat = svc(owner, 'files.imported_of', {'source_files': ['ic-nope-%s' % RUN]})
    lst = items_of(dat)
    err = ''
    if isinstance(dat, dict):
        err = str(dat.get('error') or '') + ' ' + str(dat.get('message') or '')
    # ⚠️ **错因必须点名「来源不存在」，不许是「领域服务不存在」** ——
    #    服务没注册时这条会因为「有报错」而假绿（2026-10-14 踩过：错因通过 = 空判据）。
    svc_missing = '领域服务不存在' in err
    row = lst[0] if isinstance(lst, list) and lst and isinstance(lst[0], dict) else {}
    ok = (not svc_missing) and (
        (st != 200 and bool(err.strip())) or row.get('known') is False)
    check('IC-⑤ 不存在的 source_file 明确报错或标 known:false（不许回 imported:false 充当「没入库」）',
          ok, 'HTTP %s err=%r svc_missing=%s row=%s' % (
              st, err.strip()[:100], svc_missing, json.dumps(row, ensure_ascii=False)[:80]))
    # 反例自检：服务在的时候这条才作数
    check('IC-⑤ 反例自检：错因不是「领域服务不存在」', not svc_missing,
          'err=%s' % err.strip()[:120])

if '06' in want and IMPORTED_A:
    print('\n== IC-⑥ 批量：有/无混合不互相污染 ==')
    mix = [SRC_A, 'ic-ghost2-%s' % RUN]
    st, dat = svc(owner, 'files.imported_of', {'source_files': mix})
    lst = items_of(dat) or []
    check('IC-⑥ ① 批量回齐两条', isinstance(lst, list) and len(lst) == 2,
          '回 %s 条' % (len(lst) if isinstance(lst, list) else lst))
    by_src = {r.get('source_file'): r for r in lst if isinstance(r, dict)}
    ra = by_src.get(SRC_A, {})
    check('IC-⑥ ② 「有」那条不受「无」影响',
          ra.get('imported') is True and ra.get('file_center_id') == IMPORTED_A,
          'A=%s' % json.dumps(ra, ensure_ascii=False)[:120])

if '07' in want and IMPORTED_A:
    print('\n== IC-⑦ 无权不越权（正对照 + 负例）==')
    reader = _login_or_none('ss-reader@example.invalid')
    if reader is None:
        notyet('IC-⑦ ① 正对照：有权者拿得到 id', '本实例没有 ss-reader@example.invalid')
        notyet('IC-⑦ ② 负例：无权者不泄 id', '本实例没有 ss-reader@example.invalid')
    else:
        # ---- ⑦-① 正对照：有权者拿得到 id（证明口不是一律抹掉）----
        st, dat = svc(reader, 'files.imported_of', {'source_files': [SRC_A]})
        lst = items_of(dat) or []
        row = lst[0] if lst and isinstance(lst[0], dict) else {}
        err = str(dat.get('error') or '') if isinstance(dat, dict) else ''
        svc_missing = '领域服务不存在' in err
        check('IC-⑦ ① 正对照：有权者拿得到 file_center_id（不是一律回 null）',
              (not svc_missing) and row.get('imported') is True and row.get('file_center_id') == IMPORTED_A,
              'HTTP %s row=%s err=%s' % (st, json.dumps(row, ensure_ascii=False)[:110], err[:60]))

        # ---- ⑦-② 负例：把 `/ic-A` 那个目录收权，再让无权者查同一条 ----
        # **不新建目录** —— 新建的受限目录管不到 SRC_A 那个文件，负例会空转。
        # 造不出「真无权」状态就如实记未测，**不拿「拿不到 id」冒充通过**。
        st_g, dat_g = svc(adm, 'files.directories', {})
        dirs = (dat_g or {}).get('directories') or (dat_g or {}).get('result', {}).get('directories') or []
        want_path = '/ic-A-%s' % RUN
        target = next((d for d in dirs if isinstance(d, dict)
                       and (d.get('path') == want_path or d.get('directory') == want_path
                            or d.get('name') == want_path)), None)
        lock_id = (target or {}).get('id') or (target or {}).get('directory') or (target or {}).get('name')
        modified = (target or {}).get('modified') or (target or {}).get('expected_modified')
        restricted_ok = False
        if lock_id and modified:
            res_a, why_a = act(adm, 'files.directory_access', {
                'directory': lock_id, 'expected_modified': str(modified),
                'mode': 'restricted', 'identities': [], 'groups': [],
            }, 'ic-lock-acl-%s' % RUN)
            st_a, body_a = res_a
            restricted_ok = (st_a == 200)
            acl_err = why_a if st_a != 200 else ''
        else:
            acl_err = '目录没找到'
        if not restricted_ok:
            notyet('IC-⑦ ② 负例：无权者不泄 id',
                   '造不出「真无权」状态（id=%r modified=%r）—— %s —— 不拿假绿冒充'
                   % (lock_id, modified, acl_err))
        else:
            st2, dat2 = svc(reader, 'files.imported_of', {'source_files': [SRC_A]})
            lst2 = items_of(dat2) or []
            row2 = lst2[0] if lst2 and isinstance(lst2[0], dict) else {}
            check('IC-⑦ ② 负例：无权时不泄 file_center_id，且 imported 不撒谎',
                  row2.get('file_center_id') in (None, '') and row2.get('imported') is True
                  and row2.get('restricted') is True,
                  'row=%s' % json.dumps(row2, ensure_ascii=False)[:120])

if '08' in want:
    print('\n== IC-⑧ 「已入库」认两条路（frappe_file 那条）==')
    # 第三份附件：**只上传、从不 import_attachment** —— 它的 frappe_file 本来就是
    # 某个受管版本的固定附件（用户从文件中心选件当附件用的那种）。
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active; ws.title = 'Sheet1'
    ws.append(['名称']); ws.append(['丙'])
    buf = BytesIO(); wb.save(buf)
    res, why = act(owner, 'files.upload', {
        'file_name': 'ic-picked-%s.xlsx' % RUN,
        'content_base64': base64.b64encode(buf.getvalue()).decode(),
        'directory': '/', 'attribution': {'level': 'personal'},
    }, 'ic-up-c-%s' % RUN)
    body = res[1] if isinstance(res[1], dict) else {}
    got = body.get('result') or body
    picked = got.get('file')
    st_v, dat_v = svc(owner, 'files.versions', {'file': picked}) if picked else (0, {})
    vers = (dat_v or {}).get('versions') or []
    picked_att = vers[0].get('frappe_file') if vers else None
    check('IC-⑧ 前置：造出「从文件中心选来」的附件（frappe_file，从不导入）',
          bool(picked and picked_att), '受管=%r frappe_file=%r %s' % (picked, picked_att, why[:80]))
    if picked_att:
        st, dat = svc(owner, 'files.imported_of', {'source_files': [picked_att]})
        lst = items_of(dat) or []
        row = lst[0] if lst and isinstance(lst[0], dict) else {}
        check('IC-⑧ frappe_file 那条路也认成 imported:true（不误判「没入库」）',
              row.get('known') is True and row.get('imported') is True and row.get('file_center_id') == picked,
              'row=%s  期望 file_center_id=%r' % (json.dumps(row, ensure_ascii=False)[:120], picked))
    else:
        notyet('IC-⑧ frappe_file 那条路也认成 imported:true', '前置附件没造出来')

print('\n结果： %s  共 %d 条检查，失败 %d 条，未测 %d 条' %
      ('PASS' if not failed else 'FAIL', checks_run, len(failed), len(not_yet)))
for f in failed:
    print('  失败： %s' % f)
for n in not_yet:
    print('  未测： %s' % n)
sys.exit(1 if failed else 0)
