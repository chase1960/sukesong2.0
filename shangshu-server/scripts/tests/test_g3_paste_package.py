"""G3 越界粘贴「扩展与写值一个动作包」的后端判据（PKG-003-T03）。

**测试通过 = 下面六条各成立**（和 A 的前端判据 ①～⑥ 一一对应，反例共用）：

G3-01 一次成包：越界粘贴提交后**只有一次受管动作**，不是「加行 1 + 加列 N + 写值 1」散提交。
G3-02 失败无残留：中途任一步失败（权限拒/容量超/类型不合）→ **表结构回到粘贴前**，
       无空行/空列残留，值一格没落。
G3-03 只可改值者粘贴带结构的包 → **整包拒绝且零写**（与 G4-01 共用这条反例，写一次两处引用）。
G3-04 表头区粘贴按**表头非空唯一**规则校验：重复表头拒、空表头按规则生成（不是 `列N` 糊过去）。
G3-05 不猜测剪贴板第一行含义：数据区粘贴的第一行**当数据写入**，不吞掉当表头。
G3-06 先核范围/权限/类型/容量，过了才提交。

为什么要它：现在的口子是拆开的（`sheet_cells_write` 写值 / `sheet_row_append`、
`sheet_column_append` 改结构），前端只能「加行→加列 N 次→写值」三段发，中途失败会留下
空结构。计划 PKG-003-T03 明写「扩展与写值作为一个动作包」「不能循环加一行→加一列→存一格」
「任一失败零正式生效、无空结构残留」。

先红后绿：`files.sheet_paste_apply` 尚不存在时应红（动作不存在）。
反例（故意把产品弄坏）必须能红，否则判据恒真。

用法：python3 test_g3_paste_package.py
     python3 test_g3_paste_package.py --cases 01,02
"""
import base64
import importlib.util
import io
import json
import os
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
RUN = t.RUN
VALID = ('01', '02', '03', '04', '05', '06')
PASTE = 'files.sheet_paste_apply'   # 后端成包动作（本笔要开的口子）

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


from _ss_cred import CRED as _CRED, pw_of as _pw_of, admin_pw_for
admin_pw = admin_pw_for(BASE)
user_pw = 'b2-user-pw-2026'
if not admin_pw:
    print('结果： FAIL 取不到管理员口令'); sys.exit(2)


def build_plain(rows=3, cols=2):
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


def result_of(st, body):
    b = body if isinstance(body, dict) else {}
    return b.get('result') or b


def _val(x):
    return x.get('value') if isinstance(x, dict) and 'value' in x else x


def sheet_state(c, tid):
    st, dat = t.service(c, 'files.sheet_read', {'table': tid, 'page': 1, 'page_length': 200})
    d = dat if isinstance(dat, dict) else {}
    rows = d.get('rows') or []
    return {
        'content': d.get('content_version'),
        'structure': d.get('structure_version'),
        'headers': d.get('headers') or [],
        'row_ids': [r.get('row_id') for r in rows],
        'rows': rows,
    }


def cell_at(state, rid, header):
    for r in state.get('rows') or []:
        if r.get('row_id') == rid:
            v = (r.get('values') or {}).get(header)
            return _val(v) if v is not None else _val(r.get(header))
    return None


def paste_payload(tid, s, matrix, start_row_idx, start_col_idx, header_row=False):
    """成包粘贴载荷：矩阵 + 起始行列（0 基）。具体字段名以下面实现为准，先定语义。"""
    return {
        'table': tid,
        'sheet': '',
        'expected_content_version': s['content'],
        'expected_structure_version': s['structure'],
        'op_id': 'op-g3-%s' % RUN,
        'start_row': start_row_idx,
        'start_col': start_col_idx,
        'header_row': header_row,
        'matrix': matrix,
    }


print('== G3 越界粘贴成包（后端） ==')
print('实例：%s　run=%s　所选：%s　动作=%s' % (BASE, RUN, ','.join(want), PASTE))

owner = t.Client(BASE)
owner.login('Administrator', admin_pw)

st, body = act(owner, 'files.upload', {
    'file_name': f'g3-表-{RUN}.xlsx', 'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/', 'attribution': {'level': 'personal'}}, f'g3-up-{RUN}')
res = result_of(st, body)
TID = res.get('file') or res.get('file_id')
check('G3 前置：建出测试表', bool(TID), 'HTTP %s' % st)
if not TID:
    print('结果： FAIL G3 前置失败'); sys.exit(1)

s0 = sheet_state(owner, TID)
# build_plain 造 3 行 × 2 列，其中第 1 行是表头 —— 数据行是 2 行
check('G3 前置：读到初始结构（2 数据行 × 2 列）',
      len(s0['row_ids']) == 2 and len(s0['headers']) == 2,
      '%d 数据行 × %d 列  表头=%r' % (len(s0['row_ids']), len(s0['headers']), s0['headers']))

# 先探一次：成包动作在不在（这是「先红」的锚点）
st_probe, body_probe = act(owner, PASTE, paste_payload(TID, s0, [['x']], 0, 0), f'g3-probe-{RUN}')
missing = st_probe in (404,) or '不存在' in json.dumps(body_probe, ensure_ascii=False) \
    or '无该动作' in json.dumps(body_probe, ensure_ascii=False)
if missing:
    print('  · 成包动作 %s 尚不存在（先红后绿应当如此）HTTP %s %s' % (PASTE, st_probe, str(body_probe)[:120]))

# ---------- G3-01 一次成包 ----------
if '01' in want:
    print('\n== G3-01 越界粘贴一次成包 ==')
    s = sheet_state(owner, TID)
    # 从最后一行最后一列起，贴 2×2 → 右侧+下方同时越界
    matrix = [['G3-a-%s' % RUN[-4:], 'G3-b-%s' % RUN[-4:]],
              ['G3-c-%s' % RUN[-4:], 'G3-d-%s' % RUN[-4:]]]
    st, body = act(owner, PASTE, paste_payload(TID, s, matrix, len(s['row_ids']) - 1, len(s['headers']) - 1),
                   f'g3-01-{RUN}')
    check('G3-01 ① 成包动作提交成功', st == 200, 'HTTP %s %s' % (st, str(body)[:160]))
    res = result_of(st, body)
    # 受管动作计数 = 1（回包应带「这一包只记一笔」的证据，而不是多次）
    acts = res.get('actions') or res.get('managed_actions') or res.get('action_count')
    check('G3-01 ② 事实日志里受管动作计数 = 1（不是三段散提交）',
          acts in (1, [1]) or (isinstance(acts, list) and len(acts) == 1),
          '回包 actions=%r' % (acts,))
    s2 = sheet_state(owner, TID)
    check('G3-01 ③ 行列都扩了（右侧+下方同时越界）',
          len(s2['row_ids']) > len(s['row_ids']) and len(s2['headers']) > len(s['headers']),
          '%d行%d列 → %d行%d列' % (len(s['row_ids']), len(s['headers']), len(s2['row_ids']), len(s2['headers'])))
    v = cell_at(s2, s2['row_ids'][-1], s2['headers'][-1])
    check('G3-01 ④ 越界格的值落了盘', v == 'G3-d-%s' % RUN[-4:], '读回=%r' % (v,))

# ---------- G3-02 失败无残留 ----------
if '02' in want:
    print('\n== G3-02 中途失败无残留 ==')
    s = sheet_state(owner, TID)
    rows_before, cols_before = len(s['row_ids']), len(s['headers'])
    # 人为让包中途失败：塞一个类型不合的格（type 用不存在的类型）
    bad = [['G3-2-ok', 'G3-2-bad'],
           ['G3-2-ok2', 'G3-2-bad2']]
    payload = paste_payload(TID, s, bad, rows_before - 1, cols_before - 1)
    payload['matrix_types'] = [['text', 'text'], ['text', '__no_such_type__']]
    st, body = act(owner, PASTE, payload, f'g3-02-{RUN}')
    check('G3-02 ① 失败的包被拒', st != 200, 'HTTP %s %s' % (st, str(body)[:160]))
    s2 = sheet_state(owner, TID)
    check('G3-02 ② 行列数回到粘贴前（无空行/空列残留）',
          len(s2['row_ids']) == rows_before and len(s2['headers']) == cols_before,
          '现 %d行×%d列，原 %d行×%d列' % (len(s2['row_ids']), len(s2['headers']), rows_before, cols_before))
    vals = [cell_at(s2, rid, h) for rid in s2['row_ids'] for h in s2['headers']]
    check('G3-02 ③ 值一格没落',
          not any(v and str(v).startswith('G3-2-') for v in vals),
          '残留值=%r' % ([v for v in vals if v and str(v).startswith('G3-2-')],))

# ---------- G3-03 只可改值者带结构的包整包拒绝且零写 ----------
if '03' in want:
    print('\n== G3-03 只可改值者粘贴带结构的包 → 整包拒绝且零写 ==')
    st, body = act(owner, 'platform.org.share_grant', {
        'resource': TID, 'user': 'ss-editor@example.invalid', 'access': 'edit'},
        f'g3-03-share-{RUN}')
    check('G3-03 前置：给 editor 改值共享', st == 200, str(body)[:120])
    editor = t.Client(BASE)
    try:
        editor.login('ss-editor@example.invalid', user_pw)
        logged = True
    except Exception as e:
        logged = False
        why = str(e)[:120]
    if not logged:
        check('G3-03 前置：editor 登录', False, why)
    else:
        s = sheet_state(owner, TID)
        rows_before, cols_before = len(s['row_ids']), len(s['headers'])
        m = [['G3-3-a', 'G3-3-b']]
        st, body = act(editor, PASTE,
                       paste_payload(TID, s, m, rows_before - 1, cols_before - 1), f'g3-03-{RUN}')
        check('G3-03 ① 带结构扩展的包整包拒绝', st != 200, 'HTTP %s %s' % (st, str(body)[:160]))
        s2 = sheet_state(owner, TID)
        check('G3-03 ② 零写：行列数没变',
              len(s2['row_ids']) == rows_before and len(s2['headers']) == cols_before,
              '%d×%d → %d×%d' % (rows_before, cols_before, len(s2['row_ids']), len(s2['headers'])))
        vals = [cell_at(s2, rid, h) for rid in s2['row_ids'] for h in s2['headers']]
        check('G3-03 ③ 零写：值一格没落',
              not any(v and str(v).startswith('G3-3-') for v in vals))
        # 正对照：只改值不带扩展的包，editor 应当能过（不是一律拒）
        s3 = sheet_state(owner, TID)
        m2 = [['G3-3-正对照']]
        p2 = paste_payload(TID, s3, m2, 1, 0)
        p2['extend'] = False   # 明确不扩展
        st2, body2 = act(editor, PASTE, p2, f'g3-03-ok-{RUN}')
        check('G3-03 正对照：不带扩展的包 editor 能过（不是一律拒）', st2 == 200,
              'HTTP %s %s' % (st2, str(body2)[:140]))

# ---------- G3-04 表头区粘贴按非空唯一校验 ----------
if '04' in want:
    print('\n== G3-04 表头区粘贴按非空唯一校验 ==')
    s = sheet_state(owner, TID)
    dup = s['headers'][0] if s['headers'] else 'H1'
    p = paste_payload(TID, s, [[dup]], 0, len(s['headers']), header_row=True)
    st, body = act(owner, PASTE, p, f'g3-04-dup-{RUN}')
    check('G3-04 ① 重复表头被拒', st != 200, 'HTTP %s %s' % (st, str(body)[:160]))

    s2 = sheet_state(owner, TID)
    p2 = paste_payload(TID, s2, [['']], 0, len(s2['headers']), header_row=True)
    st2, body2 = act(owner, PASTE, p2, f'g3-04-empty-{RUN}')
    res2 = result_of(st2, body2)
    s3 = sheet_state(owner, TID)
    new_hdrs = [h for h in s3['headers'] if h not in s2['headers']]
    ok_gen = st2 == 200 and new_hdrs and all(h and not h.startswith('列') for h in new_hdrs)
    check('G3-04 ② 空表头按规则生成（非空、不是 `列N` 占位）', ok_gen,
          'HTTP %s 新表头=%r' % (st2, new_hdrs))

# ---------- G3-05 第一行当数据写入 ----------
if '05' in want:
    print('\n== G3-05 不猜测剪贴板第一行含义 ==')
    s = sheet_state(owner, TID)
    rows_before = len(s['row_ids'])
    hdr0 = s['headers'][0]
    m = [['G3-5-第一行', 'G3-5-第一行b'], ['G3-5-第二行', 'G3-5-第二行b']]
    st, body = act(owner, PASTE, paste_payload(TID, s, m, 1, 0), f'g3-05-{RUN}')
    s2 = sheet_state(owner, TID)
    rid_first = s2['row_ids'][1] if len(s2['row_ids']) > 1 else None
    v = cell_at(s2, rid_first, hdr0) if rid_first else None
    check('G3-05 ① 第一行当数据写入（不吞掉当表头）', v == 'G3-5-第一行',
          '第 2 行 %s 列读回=%r' % (hdr0, v))
    check('G3-05 ② 表头没被第一行改掉', s2['headers'][0] == hdr0,
          '表头 %r → %r' % (hdr0, s2['headers'][0]))

# ---------- G3-06 先核范围/权限/类型/容量 ----------
if '06' in want:
    print('\n== G3-06 先核范围/权限/类型/容量再提交 ==')
    s = sheet_state(owner, TID)
    rows_before, cols_before = len(s['row_ids']), len(s['headers'])
    # 容量超：一次贴超过上限的格（20001 格 > 单次 20000 上限）
    huge = [['x'] * 200 for _ in range(101)]   # 20200 格
    st, body = act(owner, PASTE, paste_payload(TID, s, huge, 0, 0), f'g3-06-{RUN}')
    check('G3-06 ① 超容量的包在预检被拒', st != 200, 'HTTP %s %s' % (st, str(body)[:160]))
    s2 = sheet_state(owner, TID)
    check('G3-06 ② 预检拒绝后表结构没动',
          len(s2['row_ids']) == rows_before and len(s2['headers']) == cols_before,
          '%d×%d → %d×%d' % (rows_before, cols_before, len(s2['row_ids']), len(s2['headers'])))

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)
if failed:
    print('结果： FAIL G3 成包（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
print('结果： PASS G3 成包全部成立（%d 条）' % checks_run)
