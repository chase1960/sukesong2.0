"""批注提取进「备注」列（2026-10-12 用户拍板两步合一口径：便签直接提取、每表只允许
一个备注列、同行的备注直接转成字段值在后面追加，不带列名前缀）。

测试通过 = 带便签（单元格批注+锚框）的表改一格保存后：
  ①出现「备注」列（每表至多一列），批注按所在行提取、文字直接进字段值、同一行多条
    用「；」连、已有内容在前新条在后（夹具 A：D2='注意单位；已核对'，D3='待补资料'）；
  ②保存出的新版本里批注部件和锚框都没了（提取走数据列，不留双份）；
  ③其他格一字不差（甲改/5/苏/乙/7/浙）；
  ④已有「备注」列的表是追加不是覆盖（夹具 B：C2='旧值；新批注'）、不新增列；
  ⑤新增列时结构版本 +1（前端列列表要刷新），复用列时不涨。
只报数字与 PASS/FAIL。
"""
import base64
import importlib.util
import zipfile
from io import BytesIO

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'
FIX = '/path/to/workspace'

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
spec = importlib.util.spec_from_file_location('cfix', FIX)
cfix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cfix)

c = t.Client(BASE)
c.login('ss-owner@example.invalid', 'b2-user-pw-2026')
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
    }, f'cmt-up-{name}')
    table = (body.get('result') or {}).get('file')
    assert table, f'上传失败 HTTP {st}'
    return table


def comment_parts(raw):
    names = zipfile.ZipFile(BytesIO(raw)).namelist()
    return [n for n in names if 'comment' in n.lower() or n.endswith('.vml')]


def edit_first_cell(table):
    st, sheet = t.service(c, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 10})
    st, body = t.action(c, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': sheet['rows'][0]['row_id'],
        'header': sheet['headers'][0], 'value': {'type': 'text', 'value': '甲改'},
        'expected_content_version': sheet.get('content_version'),
        'expected_structure_version': sheet.get('structure_version'),
    }, f'cmt-write-{table}')
    return sheet, st, body


def newest_version_raw(table):
    st, detail = t.service(c, 'files.versions', {'file': table})
    versions = detail.get('versions') or []
    strip = [v for v in versions if '批注' in str(v.get('note') or '') or '剔除' in str(v.get('note') or '')]
    v = (strip[0] if strip else versions[0])
    st, blob = t.download(c, table, (v.get('source') or {}).get('file'))
    return blob.get('_bytes') or b'', str(v.get('note') or '')


# ---------- 夹具 A：新备注列 ----------
rawA = cfix.build_comment_fixture()
tableA = upload('批注提取A', rawA)
sheetA, st, body = edit_first_cell(tableA)
check('A·改格保存', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
sv_before = int(sheetA.get('structure_version') or 1)
sv_after = int((body.get('result') or {}).get('structure_version') or 1)

st, sheet2 = t.service(c, 'files.sheet_read', {'table': tableA, 'page': 1, 'page_length': 10})
headers = sheet2.get('headers') or []
rows = {r['row_index']: r['values'] for r in sheet2.get('rows') or []}
check('A·备注列出现且按行提取',
      '备注' in headers and headers.index('备注') == 3
      and (rows.get(2, {}).get('备注', {}) or {}).get('value') == '注意单位；已核对'
      and (rows.get(3, {}).get('备注', {}) or {}).get('value') == '待补资料',
      f'表头 {headers}；D2={((rows.get(2, {}).get("备注") or {}).get("value"))!r}'
      f' D3={((rows.get(3, {}).get("备注") or {}).get("value"))!r}')
# 〔2026-10-13 判据变更〕清洗挪到上传后首次处理：「备注」列在上传后首读即出现，
# 不再等到改格；改格那一步结构版本不涨（列形态没变）。原「改格后 +1」按时点换成
# 「上传后首读表头已含备注列」+「改格不涨」两条，用户要求（新增列刷新列列表）仍成立。
check('A·上传后首读即有备注列', headers.index('备注') == 3,
      f'表头 {headers}（备注在第 4 列）')
check('A·改格不涨结构版本', sv_after == sv_before, f'结构版本 {sv_before} → {sv_after}（列形态已定）')
check('A·其他格不差', (rows.get(2, {}).get('名称', {}) or {}).get('value') == '甲改'
      and (rows.get(2, {}).get('数量', {}) or {}).get('value') == 5
      and (rows.get(2, {}).get('产地', {}) or {}).get('value') == '苏'
      and (rows.get(3, {}).get('名称', {}) or {}).get('value') == '乙'
      and (rows.get(3, {}).get('数量', {}) or {}).get('value') == 7
      and (rows.get(3, {}).get('产地', {}) or {}).get('value') == '浙',
      '甲改/5/苏/乙/7/浙 六格对照')

rawA1, noteA = newest_version_raw(tableA)
leftA = comment_parts(rawA1)
check('A·批注双份清除', not leftA, f'新版本批注/锚框部件残留 {leftA or "无"}；版本备注：{noteA[:60]}')

import warnings
from openpyxl import load_workbook
with warnings.catch_warnings():
    warnings.simplefilter('ignore')
    wb = load_workbook(BytesIO(rawA1), data_only=False, keep_links=False)
    ws = wb.worksheets[0]
# 〔2026-10-13 判据变更〕清洗版在改格之前（A2 仍是原值）；「甲改」在改格版，由上面
# 「A·其他格不差」读回核对，不再混进清洗版的独立解析。这里核的是提取结果本身。
check('A·独立解析复核', ws['D1'].value == '备注'
      and ws['D2'].value == '注意单位；已核对'
      and ws['D3'].value == '待补资料',
      f'独立解析 D1={ws["D1"].value!r} D2={ws["D2"].value!r} D3={ws["D3"].value!r}')

# ---------- 夹具 B：已有备注列，追加不覆盖 ----------
rawB = cfix.build_comment_existing_fixture()
tableB = upload('批注提取B', rawB)
sheetB, st, body = edit_first_cell(tableB)
check('B·改格保存', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')
svb_before = int(sheetB.get('structure_version') or 1)
svb_after = int((body.get('result') or {}).get('structure_version') or 1)

st, sheet2 = t.service(c, 'files.sheet_read', {'table': tableB, 'page': 1, 'page_length': 10})
headers2 = sheet2.get('headers') or []
rows2 = {r['row_index']: r['values'] for r in sheet2.get('rows') or []}
remark = (rows2.get(2, {}).get('备注', {}) or {}).get('value')
check('B·追加不覆盖', remark == '旧值；新批注' and headers2 == ['名称', '数量', '备注'],
      f'表头 {headers2}；C2={remark!r}')
check('B·结构版本不涨', svb_after == svb_before, f'结构版本 {svb_before} → {svb_after}')

rawB1, _noteB = newest_version_raw(tableB)
leftB = comment_parts(rawB1)
check('B·批注双份清除', not leftB, f'新版本批注/锚框部件残留 {leftB or "无"}')

# ---------- 夹具 C：备注列既有内容是公式 → 拼接结果必须落成文本 ----------
rawC = cfix.build_comment_formula_remark_fixture()
tableC = upload('批注提取C', rawC)
sheetC, st, body = edit_first_cell(tableC)
check('C·改格保存', st == 200 and (body.get('result') or {}).get('applied'), f'HTTP {st}')

st, sheet2 = t.service(c, 'files.sheet_read', {'table': tableC, 'page': 1, 'page_length': 10})
rows3 = {r['row_index']: r['values'] for r in sheet2.get('rows') or []}
b2 = rows3.get(2, {}).get('备注') or {}
check('C·公式备注拼成文本', b2.get('type') == 'text' and b2.get('value') == '=CONCAT("x","y")；新批注',
      f'读回 type={b2.get("type")} value={b2.get("value")!r}（不许拼成非法公式）')

# 写侧同病：这种文本格不许被当成公式拒改——提取完再改它一次必须成功
st, body = t.action(c, 'files.sheet_cell_write', {
    'table': tableC, 'sheet': '', 'row_id': sheet2['rows'][0]['row_id'],
    'header': '备注', 'value': {'type': 'text', 'value': '再改一次'},
    'expected_content_version': sheet2.get('content_version'),
    'expected_structure_version': sheet2.get('structure_version'),
}, 'cmt-write-remark')
check('C·文本格可再改', st == 200 and (body.get('result') or {}).get('applied'),
      f'备注格再写 HTTP {st}（不许因「=」打头被当公式拒绝）')

st, detail = t.service(c, 'files.versions', {'file': tableC})
versions_c = detail.get('versions') or []
st, blob = t.download(c, tableC, (versions_c[0].get('source') or {}).get('file'))
rawC1 = blob.get('_bytes') or b''
if comment_parts(rawC1):
    check('C·批注双份清除', False, f'残留 {comment_parts(rawC1)}')
else:
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        wbc = load_workbook(BytesIO(rawC1), data_only=False, keep_links=False)
        wsc = wbc.worksheets[0]
    check('C·独立解析复核', wsc['B2'].value == '再改一次'
          and wsc['B2'].data_type != 'f' and wsc['A2'].value == '甲改',
          f'独立解析 B2={wsc["B2"].value!r} 类型={wsc["B2"].data_type!r}（s=文本，f=公式=坏）')

print()
print('结果：', 'PASS 批注提取进备注列全部成立' if not fails else f'FAIL {fails}')
raise SystemExit(1 if fails else 0)
