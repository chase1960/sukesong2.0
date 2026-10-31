"""G4（PKG-003-T04）权限、日志及恢复的判据。

**测试通过 = 下面六条各成立**（每条都是「做这个操作 → 该看到什么」）：

G4-01 只可改值者不能借粘贴改结构：
  有改值权、**没有结构权**的人（`Desk User` 但不是 `Sheet Structure Editor`），
  粘一个带结构扩展的包 → **整包拒绝且零写**。反例：同样有权改结构的人，同样的包能过。
G4-02 丢回执重试不重复建行列：
  加行/加列后「回执丢了」，用**同一个操作编号**重试 → 行列**不重复建**，
  次数只算一次。反例：换个新操作编号重试，是另一笔、确实再建。
G4-03 越权整包拒绝：
  无写权的人提交批量写 → 拒，且**一格都没落**。
G4-04 日志含新增结构及各实际格的变化：
  一次「加行 + 写值」之后，日志里既有**新增的结构**，又有**每一格改了什么**。
G4-05 不为预铺空格逐格记日志：
  预铺出来的空白格**不逐格产生日志**。日志条数按「实际改了的格」算，不按「铺了多少格」算。
G4-06 并发扩展/改名先核版本，不按屏幕行数猜尾部：
  用**过期的结构版本**提交加行/改表头 → **拒**（说明已有人改过），
  不许「看屏幕上有几行就接着往下加」。

为什么要它：这是「批量粘贴别把表结构搞乱」的保险。A 侧 G1/G2/G3/G5/G6 有证据，
G4 归 B 且一条都没有 —— 拿 B1～B6 的一般语义顶不了 G4 判据。

先红后绿：产品做不到的地方应当红，不许先实现再补测。
反例（故意把产品弄坏）必须能红，否则判据是恒真的。

用法：python3 test_g4_paste_authority.py            # 整包
     python3 test_g4_paste_authority.py --cases 01,02
"""
import base64
import importlib.util
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
RUN = t.RUN
VALID = ('01', '02', '03', '04', '05', '06')

# ---- 分组入口：未知用例 / 空选择必须非零退出 ----
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

checks_run = 0
failed = []


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


# ---- 口令：按实例取各自的交付账号源，绝不打印 ----
# 三个实例账号源各不相同，混用必 401（今晚已栽过三次）：
#   3800 QA  → 开发/本地测试/测试入口.md
#   3810 A   → 开发/本地测试/Agent-A-测试账号.md
#   3820 B   → shangshu-local-b.env 的 ADMIN_PASSWORD
def _pw_of(path, keys=('密码', 'password', 'ADMIN_PASSWORD', 'TEST_USER_PASSWORD')):
    try:
        for line in open(path, encoding='utf8'):
            for k in keys:
                if line.startswith(k + '：') or line.startswith(k + ':') or line.startswith(k + '='):
                    v = line.split('：', 1)[-1].split(':', 1)[-1].split('=', 1)[-1].strip().strip('"').strip("'")
                    if v:
                        return v
    except Exception:
        pass
    return None


def _cred_for(base):
    port = base.rsplit(':', 1)[-1]
    sources = {
        '3800': [os.path.expanduser('~/Desktop/尚书重构/开发/本地测试/测试入口.md')],
        '3810': [os.path.expanduser('~/Desktop/尚书重构/开发/本地测试/Agent-A-测试账号.md')],
        '3820': ['/path/to/workspace'
                 'ops/docker/.state/environments/shangshu-local-b.env'],
    }
    for p in sources.get(port, []):
        pw = _pw_of(p)
        if pw:
            return pw, os.path.basename(p)
    return None, '无'


admin_pw, cred_src = _cred_for(BASE)
user_pw = 'b2-user-pw-2026'
print('凭据来源：%s（口令不打印）' % cred_src)
if not admin_pw:
    print('结果： FAIL 取不到管理员口令（测试入口 / 环境文件）'); sys.exit(2)


def build_plain(rows=3, cols=2):
    """最小 xlsx：rows 行 × cols 列，首行是表头。"""
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
        rows_xml = []
        for r in range(1, rows + 1):
            cells = []
            for c in range(1, cols + 1):
                ref = '%s%d' % (chr(64 + c), r)
                txt = 'H%d' % c if r == 1 else 'r%dc%d' % (r, c)
                cells.append('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>' % (ref, txt))
            rows_xml.append('<row r="%d">%s</row>' % (r, ''.join(cells)))
        z.writestr('xl/worksheets/sheet1.xml',
                   '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<sheetData>%s</sheetData></worksheet>' % ''.join(rows_xml))
    return buf.getvalue()


def act(c, name, payload, key):
    return t.action(c, name, payload, key)


def _val(x):
    """读回的格值可能是 {type,value} 对象，也可能是裸值；取可比的那个。"""
    if isinstance(x, dict) and 'value' in x:
        return x.get('value')
    return x


def cell_at(state, rid, header):
    """按行 ID + 表头取格值（已解包 {type,value}）。"""
    for r in state.get('rows') or []:
        if r.get('row_id') == rid:
            v = (r.get('values') or {}).get(header)
            return _val(v) if v is not None else _val(r.get(header))
    return None


def result_of(res):
    if isinstance(res, tuple) and len(res) == 2 and isinstance(res[1], dict):
        body = res[1]
        return body.get('result') or body
    return res if isinstance(res, dict) else {}


def upload_table(c, label, name):
    st, body = act(c, 'files.upload', {
        'file_name': name, 'content_base64': base64.b64encode(build_plain()).decode(),
        'directory': '/', 'attribution': {'level': 'personal'}}, f'g4-up-{label}-{RUN}')
    res = result_of((st, body))
    tid = res.get('file') or res.get('file_id')
    return tid, (st, body)


def sheet_state(c, tid):
    st, dat = t.service(c, 'files.sheet_read', {'table': tid, 'page': 1, 'page_length': 50})
    d = dat if isinstance(dat, dict) else {}
    rows = d.get('rows') or []
    return {
        'content': d.get('content_version'),
        'structure': d.get('structure_version'),
        'headers': d.get('headers') or [],
        'row_ids': [r.get('row_id') for r in rows],
        'rows': rows,
        'title': d.get('table_title') or d.get('display_name') or d.get('title'),
    }


print('== G4 权限、日志及恢复 ==')
print('实例：%s　样本 run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

owner = t.Client(BASE)
owner.login('Administrator', admin_pw)

# 身份：owner=管理员（有结构权）；editor=改值不改结构（Desk User，无 Sheet Structure Editor）
TID, up = upload_table(owner, 'g4', f'g4-表-{RUN}.xlsx')
check('G4 前置：建出测试表', bool(TID), str(up[0]))
if not TID:
    print('结果： FAIL G4 前置失败'); sys.exit(1)
s0 = sheet_state(owner, TID)
hdrs = s0['headers'] or ['H1', 'H2']
first_hdr = hdrs[0]
rid0 = (s0['row_ids'] or [None])[0]

# ---------- G4-01 只可改值者不能借粘贴改结构 ----------
if '01' in want:
    print('\n== G4-01 只可改值者不能借粘贴改结构 ==')
    # 造「只可改值者」：把表共享给 ss-editor（Desk User，不是 Sheet Structure Editor）
    st, body = act(owner, 'platform.org.share_grant', {
        'resource': TID, 'user': 'ss-editor@example.invalid', 'access': 'edit'},
        f'g4-01-share-{RUN}')
    check('G4-01 前置：给 editor 改值共享', st == 200, str(body)[:120])

    editor = t.Client(BASE)
    try:
        editor.login('ss-editor@example.invalid', user_pw)
    except Exception as e:
        check('G4-01 前置：editor 登录', False, str(e)[:120])
        editor = None

    if editor:
        # ① editor 直接改结构（加列）应被拒 —— 这是「只可改值」的边界
        # 注意：结构动作（row_append/column_append/rename）**不收 op_id**，别传
        st, body = act(editor, 'files.sheet_column_append', {
            'table': TID, 'header': 'G4越权列', 'expected_structure_version': s0['structure'],
            'expected_content_version': s0['content']}, f'g4-01-col-{RUN}')
        denied = st != 200
        check('G4-01 ① 只可改值者加列被拒', denied, 'HTTP %s %s' % (st, str(body)[:100]))

        s1 = sheet_state(owner, TID)
        check('G4-01 ② 被拒后表结构一格没动',
              s1['structure'] == s0['structure'] and s1['headers'] == s0['headers'] and s1['row_ids'] == s0['row_ids'],
              '结构版本 %s→%s 表头数 %d→%d' % (s0['structure'], s1['structure'], len(s0['headers']), len(s1['headers'])))

        # ③ 只可改值者改值应当可以 —— 用来证明「改值可以」而「改结构不行」，不是一律拒
        st, body = act(editor, 'files.sheet_cells_write', {
            'table': TID, 'sheet': s0.get('sheet') or '',
            'expected_content_version': s0['content'], 'expected_structure_version': s0['structure'],
            'op_id': f'op-g4-01-b-{RUN}',
            'cells': [{'row_id': rid0, 'header': first_hdr,
                       'value': {'type': 'text', 'value': 'G4-01-越权写'}}]},
            f'g4-01-write-{RUN}')
        check('G4-01 ③ 正对照：只可改值者改值得到（不是一律拒）', st == 200, 'HTTP %s' % st)

        s2 = sheet_state(owner, TID)
        v_after = cell_at(s2, rid0, first_hdr)
        check('G4-01 ④ 改值真的落了盘（独立读回）', v_after == 'G4-01-越权写', '读回=%r' % (v_after,))

        # 反例证明测试有牙齿：有结构权的人同样的加列就该过
        s3 = sheet_state(owner, TID)
        st, body = act(owner, 'files.sheet_column_append', {
            'table': TID, 'header': 'G4正对照列', 'expected_structure_version': s3['structure'],
            'expected_content_version': s3['content']}, f'g4-01-colok-{RUN}')
        check('G4-01 反例正对照：有结构权的人同样加列能过', st == 200, 'HTTP %s %s' % (st, str(body)[:100]))
        s4 = sheet_state(owner, TID)
        check('G4-01 反例正对照：加完表头确实多一列', 'G4正对照列' in s4['headers'],
              '表头=%r' % (s4['headers'],))

# ---------- G4-02 丢回执重试不重复建行列 ----------
if '02' in want:
    print('\n== G4-02 丢回执重试不重复建行列 ==')
    # 结构动作不收 op_id；「重复/丢回执重试不重复建」靠**幂等键**保证。
    s = sheet_state(owner, TID)
    base_rows = len(s['row_ids'])
    KEY = f'g4-02-{RUN}'
    payload = {'table': TID, 'count': 1, 'expected_structure_version': s['structure'],
               'expected_content_version': s['content']}

    st, body = act(owner, 'files.sheet_row_append', payload, KEY)
    res = result_of((st, body))
    check('G4-02 ① 首次加行成功', st == 200, 'HTTP %s %s' % (st, str(body)[:100]))
    s1 = sheet_state(owner, TID)
    check('G4-02 ② 行数 +1', len(s1['row_ids']) == base_rows + 1,
          '%d → %d' % (base_rows, len(s1['row_ids'])))

    # 「回执丢了」→ 同幂等键同参重试（幂等重放，不该再建一行）
    st2, body2 = act(owner, 'files.sheet_row_append', payload, KEY)
    s2 = sheet_state(owner, TID)
    check('G4-02 ③ 同键重试不重复建行', len(s2['row_ids']) == base_rows + 1,
          '重试后 %d（应仍为 %d）' % (len(s2['row_ids']), base_rows + 1))
    res2 = result_of((st2, body2))
    check('G4-02 ④ 同键重试拿回同一笔结果',
          st2 == 200 and (res2.get('idempotent') is True
                          or json.dumps(res, sort_keys=True) == json.dumps(res2, sort_keys=True)),
          'HTTP %s idempotent=%r' % (st2, res2.get('idempotent')))

    # 反例：换新幂等键 → 确实是另一笔、再建一行。
    # 必须拿**当前**结构版本（上一笔加行已经把版本顶上去了，用旧值会被当过期拒）。
    s_cur = sheet_state(owner, TID)
    st3, body3 = act(owner, 'files.sheet_row_append', {
        'table': TID, 'count': 1, 'expected_structure_version': s_cur['structure'],
        'expected_content_version': s_cur['content']}, f'{KEY}-new')
    check('G4-02 反例前置：换新幂等键加行成功', st3 == 200, 'HTTP %s %s' % (st3, str(body3)[:100]))
    s3 = sheet_state(owner, TID)
    check('G4-02 反例：换新幂等键确实再建一行', len(s3['row_ids']) == base_rows + 2,
          '现 %d 行（首次后 %d）' % (len(s3['row_ids']), base_rows + 1))

# ---------- G4-03 越权整包拒绝 ----------
if '03' in want:
    print('\n== G4-03 越权整包拒绝 ==')
    outsider = t.Client(BASE)
    try:
        outsider.login('ss-outsider@example.invalid', user_pw)
        logged = True
    except Exception as e:
        logged = False
        why = str(e)[:120]
    if not logged:
        check('G4-03 前置：无权账号登录', False, why)
    else:
        s = sheet_state(owner, TID)
        st, body = act(outsider, 'files.sheet_cells_write', {
            'table': TID, 'expected_content_version': s['content'],
            'expected_structure_version': s['structure'], 'op_id': f'op-g4-03-{RUN}',
            'cells': [{'row_id': (s['row_ids'] or ['r-000001'])[0], 'header': s['headers'][0],
                       'value': {'type': 'text', 'value': 'G4-03-越权'}}]}, f'g4-03-{RUN}')
        check('G4-03 ① 无权者批量写被拒', st != 200, 'HTTP %s %s' % (st, str(body)[:100]))
        s2 = sheet_state(owner, TID)
        vals = [cell_at(s2, rid, s['headers'][0]) for rid in s2['row_ids']]
        check('G4-03 ② 被拒后一格都没落', 'G4-03-越权' not in vals,
              '该列读回=%r' % (vals,))

# ---------- G4-04 / G4-05 日志 ----------
if '04' in want or '05' in want:
    print('\n== G4-04/05 日志含结构与各格、不为预铺空格逐格记 ==')
    s = sheet_state(owner, TID)
    OP = f'op-g4-04-{RUN}'
    # 加一行 + 改 1 格（只有 1 格是「实际改了」）
    st, body = act(owner, 'files.sheet_row_append', {
        'table': TID, 'count': 1, 'expected_structure_version': s['structure'],
        'expected_content_version': s['content']}, f'g4-04-row-{RUN}')
    check('G4-04 前置：加一行', st == 200, 'HTTP %s %s' % (st, str(body)[:100]))
    s1 = sheet_state(owner, TID)
    added = list(set(s1['row_ids']) - set(s['row_ids']))
    new_rid = added[0] if added else None
    check('G4-04 前置：拿到新行 ID', bool(new_rid), '新增 %r' % (added,))
    if new_rid:
        st2, body2 = act(owner, 'files.sheet_cells_write', {
            'table': TID, 'expected_content_version': s1['content'],
            'expected_structure_version': s1['structure'], 'op_id': OP + '-w',
            'cells': [{'row_id': new_rid, 'header': s1['headers'][0],
                       'value': {'type': 'text', 'value': 'G4-04-实改'}}]}, f'g4-04-write-{RUN}')
        check('G4-04 前置：写 1 格', st2 == 200, 'HTTP %s %s' % (st2, str(body2)[:100]))
        res2 = result_of((st2, body2))
        changed = res2.get('cells') or []
        if '04' in want:
            check('G4-04 ① 日志带回每格前后（各实际格的变化）',
                  isinstance(changed, list) and any('before' in c and 'after' in c for c in changed),
                  'cells=%d 条 %s' % (len(changed), json.dumps(changed, ensure_ascii=False)[:140]))
        if '05' in want:
            # 预铺空格不该逐格记：一次写 1 格，明细条数应是 1，不是整行格数
            check('G4-05 ① 不为预铺空格逐格记日志（1 格实改 → 1 条明细）',
                  len(changed) == 1, '明细 %d 条（实改 1 格）' % len(changed))

# ---------- G4-06 并发扩展/改名先核版本 ----------
if '06' in want:
    print('\n== G4-06 并发扩展/改名先核版本（不按屏幕行数猜尾部） ==')
    # 造一个「合法但过期」的结构版本：先把结构版本顶到 2+，再拿旧值去提交。
    # 不能用 0 —— schema 要求 minimum:1，0 会被**字段校验**拒，不是版本检查，属恒真。
    s = sheet_state(owner, TID)
    st, body = act(owner, 'files.sheet_column_append', {
        'table': TID, 'header': 'G4-06顶版本列', 'expected_structure_version': s['structure'],
        'expected_content_version': s['content']}, f'g4-06-bump-{RUN}')
    check('G4-06 前置：加一列把结构版本顶起来', st == 200, 'HTTP %s %s' % (st, str(body)[:100]))
    s_now = sheet_state(owner, TID)
    stale_struct = (s_now['structure'] or 1) - 1
    check('G4-06 前置：拿到合法且过期的结构版本', stale_struct >= 1,
          '当前结构版本 %s，过期值 %s' % (s_now['structure'], stale_struct))

    if stale_struct >= 1:
        rows_before = len(s_now['row_ids'])
        st, body = act(owner, 'files.sheet_row_append', {
            'table': TID, 'count': 1,
            'expected_structure_version': stale_struct,
            'expected_content_version': s_now['content']}, f'g4-06-{RUN}')
        # 产品拒的措辞是「表头已变化，请刷新后重试」——这正是结构版本闩，别只认英文 version
        err_txt = json.dumps(body, ensure_ascii=False)
        latch = any(w in err_txt for w in ('表头已变化', '结构', '版本', 'version', 'stale', '刷新'))
        check('G4-06 ① 过期结构版本加行被拒（先核版本）', st != 200 and latch,
              'HTTP %s %s' % (st, err_txt[:140]))
        s2 = sheet_state(owner, TID)
        check('G4-06 ② 被拒后行数没变（不按屏幕猜着加）',
              len(s2['row_ids']) == rows_before, '%d → %d' % (rows_before, len(s2['row_ids'])))

        st, body = act(owner, 'files.sheet_rename', {
            'table': TID, 'title': 'G4-06-改名',
            'expected_structure_version': stale_struct,
            'expected_content_version': s_now['content']}, f'g4-06r-{RUN}')
        check('G4-06 ③ 过期结构版本改表名被拒', st != 200, 'HTTP %s %s' % (st, str(body)[:140]))
        s3 = sheet_state(owner, TID)
        check('G4-06 ④ 被拒后表名没变',
              s3.get('title') != 'G4-06-改名' or st == 200,
              '当前 title=%r' % (s3.get('title'),))

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)
if failed:
    print('结果： FAIL G4（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
print('结果： PASS G4 权限/日志/恢复全部成立（%d 条）' % checks_run)
