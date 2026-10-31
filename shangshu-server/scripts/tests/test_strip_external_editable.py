"""真实表可编辑·剔外链（2026-10-12 用户拍板「要改，但是直接把外链排除掉」）。

〔2026-10-13 判据变更〕清洗时点挪到**上传后首次处理**（R1/R4：处理归上传→可编辑首屏预算；
原文件仍是第 1 版）。原来「改格才剔包/固化」的中间形态断言随之换成「上传后形态」。

测试通过 = 对带「外链 + 自定义XML」的合成表：
  ①上传后 writable=true；
  ②上传后首次处理：xl/externalLinks/ 和 customXml/ 部件已剔（独立解压核包），
    外链格固化成当时的数：B2=42、B4=202412345678901234（18 位长编号逐位都在、不丢精度）；
  ③改一格保存成功（HTTP 200，内容版本 +1）；保存出的新版本仍无外链部件；
  ④内部公式 C3='=B3*2' 不受清洗和改格影响；其他格一字不差；
  ⑤第一版仍能下载回和上传一模一样的原文件（字节级）；
且对带图表的表：仍 writable=false、改格仍 417（硬黑名单不动）。
只报数字与 PASS/FAIL。
"""
import base64
import importlib.util
import os
import sys
import zipfile
from io import BytesIO

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'
FIX = '/path/to/workspace'

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
spec = importlib.util.spec_from_file_location('fix', FIX)
fix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fix)

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
    }, f'strip-up-{name}')
    table = (body.get('result') or {}).get('file')
    assert table, f'上传失败 HTTP {st}'
    return table


def version_ref(table, exclude=None, newest_last=False):
    st, detail = t.service(c, 'files.versions', {'file': table})
    refs = [((v.get('source') or {}).get('file')) for v in (detail.get('versions') or [])]
    refs = [r for r in refs if r and r != exclude]
    if not refs:
        return None
    return refs[-1] if newest_last else refs[0]   # 版本列表新→旧；newest_last=取第 1 版


# ---------- ①～④ 外链夹具：能改、剔包、固化 ----------
ext_raw = fix.build_external_fixture()
table = upload('剔外链夹具', ext_raw)
st, sheet = t.service(c, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 10})
check('①可写标记', bool(sheet.get('writable')) and not sheet.get('readonly_reason'),
      f"writable={sheet.get('writable')} 只读理由={sheet.get('readonly_reason')!r}")

ref_v0 = version_ref(table, newest_last=True)
st, blob = t.download(c, table, ref_v0)
check('⑤原版字节', (blob.get('_bytes') or b'') == ext_raw,
      f'第 1 版下载 {len(blob.get("_bytes") or b"")} 字节 = 上传 {len(ext_raw)} 字节')

rows = {r['row_index']: r['values'] for r in sheet.get('rows') or []}
# 〔2026-10-13 判据变更〕清洗（剔外链/固化）挪到上传后首次处理（R1/R4：处理归上传→可编辑
# 首屏预算）——所以「打开时」引用值已是固化数、外链包已剔；不变的是：原文件保在第 1 版可下载
# （上面⑤），内部公式不误伤（下面④独立解析仍核 C3 公式在）。原「改前是外链公式格」只在
# 旧时点（改格才清洗）成立，不再作判据。
check('④上传后形态', rows.get(2, {}).get('引用值', {}).get('type') == 'number'
      and rows.get(3, {}).get('备注', {}).get('formula') == '=B3*2',
      '上传后 B2 已固化为数（42）、C3 内部公式仍在')

st, body = t.action(c, 'files.sheet_cell_write', {
    'table': table, 'sheet': '', 'row_id': (sheet['rows'][0]['row_id']),
    'header': '名称', 'value': {'type': 'text', 'value': '甲改'},
    'expected_content_version': sheet.get('content_version'),
    'expected_structure_version': sheet.get('structure_version'),
}, 'strip-write')
check('②改格保存', st == 200 and (body.get('result') or {}).get('applied'),
      f'改格 HTTP {st}（改前这里是 417 只读拒绝）')

st, sheet2 = t.service(c, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 10})
rows2 = {r['row_index']: r['values'] for r in sheet2.get('rows') or []}
b2 = rows2.get(2, {}).get('引用值') or {}
b4 = rows2.get(4, {}).get('引用值') or {}
c3 = rows2.get(3, {}).get('备注') or {}
check('④外链格固化成数', b2.get('type') == 'number' and abs(float(b2.get('value')) - 42) < 1e-9,
      f'B2 读回 type={b2.get("type")} value={b2.get("value")!r}（应为 number 42）')
check('④长编号不丢位', b4.get('type') == 'text' and b4.get('value') == '202412345678901234',
      f'B4 读回 type={b4.get("type")} value={b4.get("value")!r}（18 位逐位对照）')
check('④内部公式不受影响', c3.get('type') == 'formula' and c3.get('formula') == '=B3*2',
      f'C3 读回 type={c3.get("type")} formula={c3.get("formula")!r}')
check('④其他格一字不差', rows2.get(2, {}).get('备注', {}).get('value') == '本地'
      and rows2.get(3, {}).get('名称', {}).get('value') == '乙'
      and rows2.get(3, {}).get('引用值', {}).get('value') == 7
      and rows2.get(2, {}).get('名称', {}).get('value') == '甲改',
      '甲改/乙/7/本地 四格对照（含本次目标格新值）')
c4 = rows2.get(4, {}).get('备注') or {}
check('④[1]字样内部公式不误固化', c4.get('type') == 'formula' and c4.get('formula') == '=IF(A4="图[1]",1,2)',
      f'C4 读回 type={c4.get("type")} formula={c4.get("formula")!r}（字符串字面量里的 [1] 不是外链）')
c5 = rows2.get(5, {}).get('备注') or {}
check('④结构化引用不误固化', c5.get('type') == 'formula' and c5.get('formula') == '=SUM(甲[乙])',
      f'C5 读回 type={c5.get("type")} formula={c5.get("formula")!r}（Table[列] 式引用不是外链）')

ref_v1 = version_ref(table, exclude=ref_v0)
if not ref_v1:
    check('③剔包干净', False, '保存失败拿不到新版本（改前行为）')
else:
    st, blob = t.download(c, table, ref_v1)
    raw_v1 = blob.get('_bytes') or b''
    names = zipfile.ZipFile(BytesIO(raw_v1)).namelist()
    stripped = [n for n in names if n.startswith('xl/externalLinks/') or n.startswith('customXml/')]
    check('③剔包干净', st == 200 and not stripped,
          f'新版本 {len(raw_v1)} 字节，外链/自定义XML 部件残留 {stripped or "无"}')

# 独立解析核固化结果（不信读接口，重新开包看）
import warnings
from openpyxl import load_workbook
if not ref_v1:
    check('④独立解析复核', False, '没有新版本可解析（改前行为）')
else:
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        wb = load_workbook(BytesIO(raw_v1), data_only=False, keep_links=False)
        ws = wb.worksheets[0]
    check('④独立解析复核', ws['B2'].value == 42 and ws['B4'].value == '202412345678901234'
          and ws['C3'].value == '=B3*2' and ws['A2'].value == '甲改' and ws['B3'].value == 7
          and ws['C4'].value == '=IF(A4="图[1]",1,2)',
          f'独立解析：B2={ws["B2"].value!r} B4={ws["B4"].value!r} C3={ws["C3"].value!r}'
          f' A2={ws["A2"].value!r} B3={ws["B3"].value!r} C4={ws["C4"].value!r}')

# ---------- 硬黑名单：带图表的表仍拒 ----------
chart_raw = fix.build_chart_fixture()
table2 = upload('图表夹具', chart_raw)
st, sheetc = t.service(c, 'files.sheet_read', {'table': table2, 'page': 1, 'page_length': 5})
check('硬名单·只读标记', not sheetc.get('writable') and bool(sheetc.get('readonly_reason')),
      f"writable={sheetc.get('writable')} 理由长度 {len(sheetc.get('readonly_reason') or '')}")
st, body = t.action(c, 'files.sheet_cell_write', {
    'table': table2, 'sheet': '', 'row_id': (sheetc['rows'][0]['row_id']),
    'header': '名称', 'value': {'type': 'text', 'value': '改不动'},
    'expected_content_version': sheetc.get('content_version'),
    'expected_structure_version': sheetc.get('structure_version'),
}, 'strip-write-chart')
check('硬名单·仍拒编辑', st == 417, f'图表表改格 HTTP {st}（应为 417）')

print()
print('结果：', 'PASS 剔外链可编辑全部成立' if not fails else f'FAIL {fails}')
raise SystemExit(1 if fails else 0)
