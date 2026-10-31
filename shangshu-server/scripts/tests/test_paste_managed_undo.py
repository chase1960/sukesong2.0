"""粘贴成包的受管撤回（留操作痕迹 + 只撤本人）—— 用户 2026-10-14 口径。

用户原话：
  「撤回动作要能留那个"会留下操作痕迹、会查「是不是本人操作」"」

这句话定死了 G5 批量撤回走哪条路：**走受管撤回 `files.sheet_cells_undo`**，
不走「前端拿 paste 回包的 before 值自己 writeCells 写回」那条 ——
后者不过审计、不查本人，是拿前端绕后端的缺口。

测试通过 = 下面五件全部成立（每条都是「做这个操作 → 该看到这个」）：

PU-① 粘贴留痕可撤：批量粘贴（带 op_id）写完后，用**同一 op_id** 走
  `files.sheet_cells_undo` → **能撤**。
  **反例（两条都不许出现，否则就是没补上）**：
    · 回「找不到该操作的台账记录」→ 说明 `paste_apply` 没往台账落账
    · 回「该操作不是格值写入」→ 说明落了账但没进 `OP_ACTIONS`
  这两条正是今天踩的坑：`sheet.py:1731` 的 `OP_ACTIONS` 只有
  `sheet_cell_write`/`sheet_cells_write`/`sheet_cells_undo`，而全文 `_record_op`
  6 处调用里 `paste_apply` 一处都没有。

PU-② 值回到粘贴前：粘贴前格是 X、粘贴写成 Y，撤回后是 X；
  content_version 恰 +1（撤回一步=一次落盘）；未涉及的格一字不动。

PU-③ 台账记的形状对：撤回回包 `cells` 带逐格 `{row_id, header, before, after}`，
  且语义与单格写/批量写一致（before=撤回前现值，after=回退到的原值）。
  格式照 `sheet.py:1315` 的 `cells_out`，不另发明一种。

PU-④ 只撤本人：另一个**有编辑权**的人拿同一 op_id 调撤回 → 拒，
  理由含「只能撤回本人发起的操作」。
  **正对照**：同一 op_id 由原操作人自己撤回成功（否则 PU-④ 是因为别的原因红）。

PU-⑤ 反例自检：**同一个判断函数喂坏数据必须判错**（防判据恒真）。
  别写成「把期望翻过来」—— 翻过来跟正面是同一断言的两面，加了等于没加。

PU-⑥ 操作号必填，落账键与撤回查询键不可能走岔：不带 `op_id` 的粘贴被拒
  （理由点名 op_id）；带 `op_id` 的粘贴回包 `op_id` **原样等于**调用方给的
  （不改写、不兜底成幂等键），拿它撤必须能撤。
  这条钉的是 `op_id` 与 `idempotency_key` **不许兜底串起来** ——
  一个是一次操作一个（对账/撤回定位），一个是一次尝试一个（技术去重）。

先红后绿：本文件先于实现写好。当前实现下 PU-① **必红** ——
粘贴不落账，撤回一定回「找不到该操作的台账记录」。

结构扩展的口径（A 2026-10-14 核过自己代码后定）：**只回退值，扩展的空行/列留下**。
A 的 `main.ts:651-654` 里 `rebuildAfterStructure()` 其实只刷新显示、不删行列，
注释写「移除自动扩展」不准确。产品里**没有删行/删列能力**，真删是新产品功能，
不塞进合并。本判据**只钉值的回退**，不钉行列消失。
"""
import base64
import importlib.util
import json
import sys

BASE = 'http://127.0.0.1:3850'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

RUN = t.RUN
fails = []
PASTE = 'files.sheet_paste_apply'
UNDO = 'files.sheet_cells_undo'


def build_plain():
    """干净夹具：3 行 2 列。粘贴只往已有格里写，不碰结构扩展。"""
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
        for r in range(1, 4):
            cells = []
            for c in range(1, 3):
                ref = '%s%d' % (chr(64 + c), r)
                txt = 'H%d' % c if r == 1 else 'orig-%d-%d' % (r, c)
                cells.append('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>' % (ref, txt))
            rows_xml.append('<row r="%d">%s</row>' % (r, ''.join(cells)))
        z.writestr('xl/worksheets/sheet1.xml',
                   '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<sheetData>%s</sheetData></worksheet>' % ''.join(rows_xml))
    return buf.getvalue()


def check(name, ok, detail):
    print(f'{"PASS" if ok else "FAIL"} {name} — {detail}')
    if not ok:
        fails.append(name)


def act(c, action, payload, key):
    try:
        st, body = t.action(c, action, payload, key)
    except Exception as e:
        return None, f'调用异常:{e}'
    return (st, body), ('ok' if st == 200 else f'HTTP {st} {json.dumps(body, ensure_ascii=False)[:160]}')


def result_of(res):
    if not res:
        return {}
    body = res[1] if isinstance(res[1], dict) else {}
    return body.get('result') or body


def err_of(res):
    if not res:
        return ''
    body = res[1] if isinstance(res[1], dict) else {}
    return f"{body.get('error', '')} {body.get('message', '')}"


def not_ledger(res):
    """PU-① 的反例甲：台账里根本没这条。"""
    return '找不到' in err_of(res)


def not_undoable(res):
    """PU-① 的反例乙：落了账但不在 OP_ACTIONS 里。"""
    return '不是格值写入' in err_of(res)


def denied_self(res):
    """PU-④：不是本人发起的操作。"""
    return '只能撤回本人' in err_of(res)


def snap(client, tid):
    st, dat = t.service(client, 'files.sheet_read', {'table': tid, 'page': 1, 'page_length': 50})
    if st != 200 or not isinstance(dat, dict):
        return None
    cells = {}
    for row in dat.get('rows') or []:
        for header, typed in (row.get('values') or {}).items():
            cells[(row.get('row_id'), header)] = json.dumps(typed, sort_keys=True, ensure_ascii=False)
    return {'cells': cells, 'content': dat.get('content_version'),
            'structure': dat.get('structure_version'), 'rows': dat.get('rows'),
            'headers': dat.get('headers') or []}


def cell_text(state, rid, header):
    for r in state.get('rows') or []:
        if r.get('row_id') == rid:
            v = (r.get('values') or {}).get(header)
            if isinstance(v, dict) and 'value' in v:
                return v.get('value')
            return v
    return None


def _v(x):
    return x.get('value') if isinstance(x, dict) and 'value' in x else x


def semantic_ok(before_v, after_v, want_before, want_after):
    """PU-③ 的判断本体。**真判据和反例自检跑的是同一个函数** ——
    否则反例那边写死常量，怎么跑都过，证不了真判据会不会失效。"""
    return _v(before_v) == want_before and _v(after_v) == want_after


def value_ok(actual, want):
    """PU-②「值回到粘贴前」的判断本体，同样给反例自检复用。"""
    return actual == want


# ---------- 账号 ----------
PW = ''
ENV = ('/path/to/workspace'
       'ops/docker/.state/environments/shangshu-local-review.env')
_admin_pw = ''
for _line in open(ENV):
    if _line.startswith('ADMIN_PASSWORD='):
        _admin_pw = _line.split('=', 1)[1].strip().strip('"').strip("'")
PW = ''
for _line in open(ENV):
    if _line.startswith('TEST_USER_PASSWORD='):
        PW = _line.split('=', 1)[1].strip().strip(chr(34)).strip(chr(39))
assert PW, 'Review test password missing'
assert _admin_pw, f'环境文件里没有 ADMIN_PASSWORD：{ENV}'

owner = t.Client(BASE)
owner.login('ss-owner@example.invalid', PW)
editor = t.Client(BASE)
editor.login('ss-reader@example.invalid', PW)   # 获编辑共享（写权随共享走），但不是本人

print('== 粘贴成包的受管撤回（留痕 + 只撤本人） ==')
print('实例：%s　run=%s　粘贴=%s　撤回=%s' % (BASE, RUN, PASTE, UNDO))

# ---------- 建表 + 开编辑共享 ----------
res, why = act(owner, 'files.upload', {
    'file_name': f'pu-粘贴撤回表-{RUN}.xlsx',
    'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/',
    'attribution': {'level': 'personal'},
}, f'pu-up-{RUN}')
TID = result_of(res).get('file')
check('上传样本表', bool(TID), why[:120])
if not TID:
    print('结果： FAIL 建不了表，后面没法跑'); sys.exit(2)

res, why = act(owner, 'platform.org.share_grant',
               {'resource': TID, 'user': 'ss-reader@example.invalid', 'access': 'edit'},
               f'pu-share-{RUN}')
check('开编辑共享给 editor（前提）', bool(res) and res[0] == 200, why[:120])

before = snap(owner, TID)
check('读到粘贴前状态', bool(before), f'content={before["content"] if before else None} 行数={len(before["rows"]) if before else 0}')
if not before:
    print('结果： FAIL 读不到表'); sys.exit(2)

# 记下粘贴目标格的原值（PU-② 要比对）
target_rid = (before.get('rows') or [{}])[0].get('row_id')
target_header = (before.get('headers') or ['H1'])[0]
orig_value = cell_text(before, target_rid, target_header)

# ---------- 粘贴成包（只写已有格，不扩展结构） ----------
OPID = f'op-pu-{RUN}'
res, why = act(owner, PASTE, {
    'table': TID,
    'sheet': '',
    'expected_content_version': before['content'],
    'expected_structure_version': before['structure'],
    'op_id': OPID,
    'start_row': 0,
    'start_col': 0,
    'header_row': False,
    'matrix': [['粘贴-新值']],
}, f'pu-paste-{RUN}')
check('粘贴成包写入成功', bool(res) and res[0] == 200, why[:160])

after_paste = snap(owner, TID)
check('粘贴后目标格是新值', cell_text(after_paste, target_rid, target_header) == '粘贴-新值',
      f'实际={cell_text(after_paste, target_rid, target_header)!r} 原值={orig_value!r}')

# ---------- PU-① 粘贴留痕可撤 ----------
res, why = act(owner, UNDO, {'table': TID, 'op_id': OPID}, f'pu-undo-{RUN}')
r1_ok = bool(res) and res[0] == 200
check('PU-① 粘贴后能走受管撤回', r1_ok, why[:200])
if not r1_ok:
    # 把反例说清楚：是「没落账」还是「没进 OP_ACTIONS」
    if not_ledger(res):
        print('     ↑ 反例甲命中：台账里没有这条 —— paste_apply 没调 _record_op')
    elif not_undoable(res):
        print('     ↑ 反例乙命中：落了账但不在 OP_ACTIONS —— sheet.py:1731 少了 sheet_paste_apply')

undo_res = result_of(res)

# ---------- PU-② 值回到粘贴前 ----------
after_undo = snap(owner, TID)
check('PU-② 值回到粘贴前', value_ok(cell_text(after_undo, target_rid, target_header), orig_value),
      f'撤回后={cell_text(after_undo, target_rid, target_header)!r} 原值={orig_value!r}')
check('PU-② content_version 恰 +1（撤回一步=一次落盘）',
      bool(after_paste) and bool(after_undo) and after_undo['content'] == after_paste['content'] + 1,
      f"粘贴后={after_paste['content'] if after_paste else None} 撤回后={after_undo['content'] if after_undo else None}")
check('PU-② structure_version 不漂',
      bool(after_undo) and after_undo['structure'] == before['structure'],
      f"前={before['structure']} 后={after_undo['structure'] if after_undo else None}")

# 未涉及的格一字不动
untouched_ok = True
untouched_detail = '全部一致'
for key, val in before['cells'].items():
    if key == (target_rid, target_header):
        continue
    if after_undo and after_undo['cells'].get(key) != val:
        untouched_ok = False
        untouched_detail = f'{key} 变了 {after_undo["cells"].get(key)!r}'
        break
check('PU-② 未涉及的格一字不动', untouched_ok, untouched_detail)

# ---------- PU-③ 台账记的形状对 ----------
cells_out = undo_res.get('cells') if isinstance(undo_res, dict) else None
check('PU-③ 撤回回包带逐格快照', bool(cells_out), f'cells={type(cells_out).__name__}')
if cells_out:
    first = cells_out[0] if cells_out else {}
    shape_ok = all(k in first for k in ('row_id', 'header', 'before', 'after'))
    check('PU-③ 快照形状是 {row_id, header, before, after}', shape_ok,
          f'实际键={sorted(first.keys()) if isinstance(first, dict) else first}')
    # 语义：before=撤回前现值（粘贴写的新值），after=回退到的原值
    hit = [c for c in cells_out
           if isinstance(c, dict) and c.get('row_id') == target_rid and c.get('header') == target_header]
    if hit:
        c = hit[0]
        check('PU-③ 语义对（before=撤回前现值 / after=回退到的原值）',
              semantic_ok(c.get('before'), c.get('after'), '粘贴-新值', orig_value),
              f"before={_v(c.get('before'))!r} after={_v(c.get('after'))!r} 原值={orig_value!r}")
    else:
        check('PU-③ 语义对（before=撤回前现值 / after=回退到的原值）', False,
              f'回包里找不到 {target_rid}/{target_header}')

# ---------- PU-④ 只撤本人 ----------
# 再粘贴一次，让 editor（有编辑权，但不是本人）来撤
before2 = snap(owner, TID)
OPID2 = f'op-pu2-{RUN}'
res, why = act(owner, PASTE, {
    'table': TID, 'sheet': '',
    'expected_content_version': before2['content'],
    'expected_structure_version': before2['structure'],
    'op_id': OPID2,
    'start_row': 0, 'start_col': 0, 'header_row': False,
    'matrix': [['第二次粘贴']],
}, f'pu-paste2-{RUN}')
check('第二次粘贴成功（PU-④ 前提）', bool(res) and res[0] == 200, why[:160])

res, why = act(editor, UNDO, {'table': TID, 'op_id': OPID2}, f'pu-undo-notself-{RUN}')
# ⚠️ 判据必须**点名拒绝理由**，不许只判「没成功」。
# 只判 res[0] != 200 的话，「找不到台账」也会让这条绿 —— 那是**错因通过 = 空判据**，
# 2026-10-14 先红时就是这么红的（别人那条 PASS 过一版，实际是被「找不到」拒的）。
# 所以这里只认「只能撤回本人发起的操作」这一种拒绝理由。
check('PU-④ 别人（有编辑权）被拒，理由必须点名「只能撤回本人发起的操作」',
      denied_self(res), err_of(res)[:160])
if res and res[0] != 200 and not denied_self(res):
    check('PU-④ 错因自检：拒了但理由不是「只能撤回本人」= 判据是空的', False,
          f'实际拒绝理由={err_of(res)[:160]}')

# 正对照：本人自己撤，必须成功（否则 PU-④ 可能是因为别的原因红）
res, why = act(owner, UNDO, {'table': TID, 'op_id': OPID2}, f'pu-undo-self-{RUN}')
check('PU-④ 正对照：本人自己撤回成功', bool(res) and res[0] == 200, why[:160])

# ---------- PU-⑤ 反例自检（防判据恒真） ----------
# ⚠️ 别写成「把期望翻过来」—— 翻过来跟正面是同一断言的两面，加了等于没加。
# 也别写死常量去比 —— 那样怎么跑都过，证不了真判据会不会失效。
# 真正能证伪的是：**同一个判断函数，喂坏数据必须判错**。
# 数据一变就红，才说明它真在比数据。（另一条非恒真的实证是「先红」：
# 本文件在补实现之前跑过 7 条红，实现后才绿。）
poison_semantic = semantic_ok('被改坏的-before', '被改坏的-after', '粘贴-新值', orig_value)
check('PU-⑤ 反例自检：同一判据喂坏数据必须判错（语义）', not poison_semantic,
      '喂了坏数据，semantic_ok 判 False（判据非恒真）' if not poison_semantic
      else '喂了坏数据 semantic_ok 还判 True = before/after 判据恒真')

poison_value = value_ok('被改坏的值', orig_value)
check('PU-⑤ 反例自检：同一判据喂坏数据必须判错（值）', not poison_value,
      '喂了坏数据，value_ok 判 False（判据非恒真）' if not poison_value
      else '喂了坏数据 value_ok 还判 True = 值比对恒真')

# ---------- PU-⑥ 操作号必填：落账键与撤回查询键不可能走岔 ----------
# moniter 2026-10-14 提的担心（形状对）：落账时 `op_id` 缺省兜底成幂等键、撤回却按
# `op_id` 精确查 —— 两个语义不同的字段兜起来，就「落账落的是幂等键、撤回拿操作号
# 查 → 查不到」的走岔（跟 `files.action_fact` 那次同类）。
#
# 核下来 `files.sheet_paste_apply` 的 **op_id 是必填**（domain.py 的 required 表里有），
# 所以这条兜底走不到、也**不可能走岔**。判据就钉住这个保证本身：
#   ① 不带 op_id 的粘贴必须被拒（schema 或处理器，理由点名 op_id）——
#      将来哪天 op_id 变可选了，这条会红，提醒补「回包 op_id = 台账键」的判据
#   ② 带 op_id 的粘贴，回包 op_id 必须**原样等于**调用方给的那个（不改写、不兜底）
#      —— 撤回拿它查，才保证查得到
before3 = snap(owner, TID)
res, why = act(owner, PASTE, {
    'table': TID, 'sheet': '',
    'expected_content_version': before3['content'],
    'expected_structure_version': before3['structure'],
    # 'op_id' **故意不给**
    'start_row': 0, 'start_col': 0, 'header_row': False,
    'matrix': [['不带操作号']],
}, f'pu-paste-noid-{RUN}')
check('PU-⑥ 不带 op_id 的粘贴被拒，理由点名 op_id',
      bool(res) and res[0] != 200 and 'op_id' in err_of(res), err_of(res)[:160])

OPID3 = f'op-pu3-{RUN}'
res, why = act(owner, PASTE, {
    'table': TID, 'sheet': '',
    'expected_content_version': before3['content'],
    'expected_structure_version': before3['structure'],
    'op_id': OPID3,
    'start_row': 0, 'start_col': 0, 'header_row': False,
    'matrix': [['带操作号']],
}, f'pu-paste-withid-{RUN}')
check('PU-⑥ 前置：带 op_id 的粘贴成功', bool(res) and res[0] == 200, why[:160])
back_key = (result_of(res) or {}).get('op_id') if isinstance(result_of(res), dict) else None
check('PU-⑥ 回包 op_id 原样等于调用方给的（不改写、不兜底）', back_key == OPID3,
      f'回包={back_key!r} 调用方给的={OPID3!r}')

res, why = act(owner, UNDO, {'table': TID, 'op_id': OPID3}, f'pu-undo-withid-{RUN}')
check('PU-⑥ 用同一个 op_id 撤回能撤（落账键=查询键）', bool(res) and res[0] == 200, why[:200])

print()
if fails:
    print(f'结果： FAIL {len(fails)} 条 —— ' + '；'.join(fails))
    sys.exit(1)
print('结果： PASS 粘贴成包的受管撤回全部成立')
