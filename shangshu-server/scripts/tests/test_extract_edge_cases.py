"""批注提取/剔外链边界（对抗审查 16 条发现的高危项逐条钉死）。

测试通过 = 以下各成立：
  1 合并区非锚点格的批注（openpyxl 载入即弃）仍提取进备注（XML 兜底），不留丢；
  2 备注落点在合并区非锚点：保存 200 不 500、不写合并格、批注留原处；
  3 外链公式无缓存值：固化成公式原文文本（不许清成空）；
  5 只有表头+表头批注：不加空备注列、批注留原处、结构版本不涨；
  6 数据范围外孤行批注：总行数不跳变、批注留原处；
  7 追加超 32767 字：既有内容原样不截断、批注留原处；
  8 只有附表有批注：主表结构版本不涨；
  9 既有备注是日期：拼接不带 00:00:00。
只报数字与 PASS/FAIL。
"""
import base64
import importlib.util
import os
import zipfile
from io import BytesIO

BASE = os.environ.get('SHANGSHU_TEST_BASE', 'http://127.0.0.1:3820')
HERE = os.path.dirname(os.path.abspath(__file__))
TEST = os.path.join(HERE, '..', 'test-n2-structure.py')
CFIX = os.path.join(HERE, 'make_comment_fixture.py')
SFIX = os.path.join(HERE, 'make_strip_fixture.py')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', TEST)
cfix = _load('cfix', CFIX)
sfix = _load('sfix', SFIX)

c = t.Client(BASE)
c.login('ss-owner@example.invalid', os.environ.get('TEST_USER_PASSWORD', 'b2-user-pw-2026'))
fails = []


def check(name, ok, detail):
    print(f'{"PASS" if ok else "FAIL"} {name} — {detail}')
    if not ok:
        fails.append(name)


def upload(name, raw):
    st, body = t.action(c, 'files.upload', {
        'file_name': f'{name}-{t.RUN}.xlsx',
        'content_base64': base64.b64encode(raw).decode(),
        'directory': '/',
    }, f'edge-up-{name}')
    table = (body.get('result') or {}).get('file')
    assert table, f'上传失败 HTTP {st}'
    return table


def edit(table, header='名称', value='改值'):
    st, sheet = t.service(c, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 20})
    rows = sheet.get('rows') or []
    if not rows:
        st, body = t.action(c, 'files.sheet_layout_update', {
            'table': table, 'sheet': '', 'column_widths': {'1': 20},
            'expected_content_version': sheet.get('content_version'),
            'expected_structure_version': sheet.get('structure_version'),
        }, f'edge-layout-{table}')
        return sheet, st, body
    st, body = t.action(c, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': rows[0]['row_id'], 'header': header,
        'value': {'type': 'text', 'value': value},
        'expected_content_version': sheet.get('content_version'),
        'expected_structure_version': sheet.get('structure_version'),
    }, f'edge-write-{table}')
    return sheet, st, body


def newest_raw_and_note(table):
    # 〔2026-10-13 判据变更〕清洗（剔包/固化/批注提取）挪到上传后首次处理后，清洗痕迹在
    # 「上传后首次处理」那一版的备注里；改格那一版备注只写 sheet-edit。本 helper 改取
    # 带清洗痕迹的版本（note 含剔除/批注/固化/留原处字样），与 test_comment_extract 同口径。
    st, detail = t.service(c, 'files.versions', {'file': table})
    versions = detail.get('versions') or []
    marks = ('剔除', '批注', '固化', '留原处')
    strip = [v for v in versions if any(m in str(v.get('note') or '') for m in marks)]
    v = (strip[0] if strip else versions[0])
    st, blob = t.download(c, table, (v.get('source') or {}).get('file'))
    return blob.get('_bytes') or b'', str(v.get('note') or '')


def comment_parts(raw):
    names = zipfile.ZipFile(BytesIO(raw)).namelist()
    return [n for n in names if 'comment' in n.lower() or n.endswith('.vml')]


def read_rows(table):
    st, sheet = t.service(c, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 20})
    return sheet, {r['row_index']: r['values'] for r in (sheet.get('rows') or [])}


# ---------- 1 合并区非锚点批注：提取不丢 ----------
raw = cfix.build_merged_anchor_fixture()
tb = upload('E1-非锚点批注', raw)
sheet, st, body = edit(tb)
check('1·保存不炸', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
sheet2, rows = read_rows(tb)
remark = (rows.get(2, {}).get('备注') or {}).get('value')
check('1·非锚点批注提取到', remark == '非锚点便签',
      f'读回备注={remark!r}（openpyxl 直读为空的那条，靠 XML 兜底）')
raw1, note1 = newest_raw_and_note(tb)
check('1·提取后批注层清掉', not comment_parts(raw1), f'残留 {comment_parts(raw1) or "无"}')

# ---------- 2 备注落点在合并区非锚点：跳过不 500、批注留原处 ----------
raw = cfix.build_merged_remark_target_fixture()
tb = upload('E2-合并落点', raw)
sheet, st, body = edit(tb)
check('2·保存不炸', st == 200 and (body.get('result') or {}).get('applied'),
      f'HTTP {st}（改前这里是 500 AttributeError）')
sheet2, rows = read_rows(tb)
d2 = (rows.get(2, {}).get('备注') or {}).get('value')
raw1, note1 = newest_raw_and_note(tb)
check('2·不写合并格+留原批注', not d2 and bool(comment_parts(raw1)) and '留原处' in note1,
      f'备注={d2!r}；批注部件残留 {len(comment_parts(raw1))} 个；版本备注：{note1[:70]}')

# ---------- 3 无缓存值外链公式：固化成公式原文文本 ----------
raw = sfix.build_external_nocache_fixture()
tb = upload('E3-无缓存外链', raw)
sheet, st, body = edit(tb)
check('3·保存不炸', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
sheet2, rows = read_rows(tb)
b2 = rows.get(2, {}).get('引用值') or {}
check('3·固化成公式原文', b2.get('type') == 'text' and str(b2.get('value') or '').startswith('=') and '[1]外部源' in str(b2.get('value')),
      f'读回 type={b2.get("type")} value={str(b2.get("value"))[:40]!r}（不许清成空）')

# ---------- 5 表头孤批注：不加空备注列、留原处 ----------
raw = cfix.build_header_only_comment_fixture()
tb = upload('E5-表头孤批注', raw)
sheet, st, body = edit(tb)   # 无数据行 → 走列宽写触发保存
check('5·保存不炸', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
sheet2, rows = read_rows(tb)
sv_same = int(sheet2.get('structure_version') or 1) == int(sheet.get('structure_version') or 1)
raw1, note1 = newest_raw_and_note(tb)
check('5·不加列不涨版本', '备注' not in (sheet2.get('headers') or []) and sv_same,
      f'表头 {sheet2.get("headers")}；结构版本 {sheet.get("structure_version")} → {sheet2.get("structure_version")}')
check('5·批注留原处', bool(comment_parts(raw1)) and '留原处' in note1,
      f'批注部件残留 {len(comment_parts(raw1))} 个；版本备注：{note1[:70]}')

# ---------- 6 范围外孤行批注：不撑爆行表 ----------
raw = cfix.build_out_of_extent_comment_fixture()
tb = upload('E6-范围外批注', raw)
sheet, st, body = edit(tb)
check('6·保存不炸', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
sheet2, rows = read_rows(tb)
check('6·行数不跳变', sheet2.get('total_rows') == sheet.get('total_rows') == 1,
      f'总行 {sheet.get("total_rows")} → {sheet2.get("total_rows")}（孤行批注不许把表撑出空行）')
raw1, note1 = newest_raw_and_note(tb)
check('6·批注留原处', bool(comment_parts(raw1)) and '留原处' in note1,
      f'批注部件残留 {len(comment_parts(raw1))} 个；版本备注：{note1[:70]}')

# ---------- 7 超长追加：不截断既有内容 ----------
raw = cfix.build_overflow_remark_fixture()
tb = upload('E7-超长追加', raw)
sheet, st, body = edit(tb)
check('7·保存不炸', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
sheet2, rows = read_rows(tb)
b2 = (rows.get(2, {}).get('备注') or {}).get('value') or ''
check('7·既有内容原样', len(b2) == 32000 and set(b2) == {'x'},
      f'备注长度 {len(b2)}（应 32000 原样；不许截断拼接）')
raw1, note1 = newest_raw_and_note(tb)
check('7·批注留原处', bool(comment_parts(raw1)) and '留原处' in note1,
      f'批注部件残留 {len(comment_parts(raw1))} 个；版本备注：{note1[:70]}')

# ---------- 8 只有附表批注：主表结构版本不涨 ----------
raw = cfix.build_secondary_sheet_comment_fixture()
tb = upload('E8-非主表批注', raw)
sheet, st, body = edit(tb)
check('8·保存不炸', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
sv_after = int((body.get('result') or {}).get('structure_version') or 1)
sheet2, rows = read_rows(tb)
raw1, note1 = newest_raw_and_note(tb)
check('8·主表版本不涨', sv_after == int(sheet.get('structure_version') or 1)
      and '备注' not in (sheet2.get('headers') or []),
      f'结构版本 {sheet.get("structure_version")} → {sv_after}；主表表头 {sheet2.get("headers")}')
check('8·附表批注照提取', '批注提取 1 条' in note1 and not comment_parts(raw1),
      f'版本备注：{note1[:80]}；批注部件残留 {len(comment_parts(raw1))} 个')

# ---------- 9 日期拼接不带 00:00:00 ----------
raw = cfix.build_date_remark_fixture()
tb = upload('E9-日期拼接', raw)
sheet, st, body = edit(tb)
check('9·保存不炸', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
sheet2, rows = read_rows(tb)
b2 = (rows.get(2, {}).get('备注') or {}).get('value')
check('9·日期格式干净', b2 == '2026-10-12；新批注',
      f'读回备注={b2!r}（不许带 00:00:00）')

print()
print('结果：', 'PASS 边界全部成立' if not fails else f'FAIL {fails}')
raise SystemExit(1 if fails else 0)
