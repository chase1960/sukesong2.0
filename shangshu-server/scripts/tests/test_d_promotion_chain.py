"""PKG-004 第一条可用链：晋升定义 / 读路径合并 / 写路径分流 / 回写原表（D-a～D-d）。

**测试通过 = 下面每条成立**（合成样本；**不等于「004 通过」**）：

D-a **晋升定义模型** —— 给一份「案件编号/金额已晋升、备注没晋升」的定义，
     读回来三列的晋升标记是 **是/是/否**，**不多不少**；且定义按
     「表头 + 结构版本 + 定义版本」定位（表头改了要能认出对不上）。

D-b **读路径合并** —— 同一行里：晋升列的值 = 数据库里的值，普通列的值 = 表里的值，
     **两边不互相覆盖**。数据库和表不一致时，晋升列以数据库为准。
     **读这件事不动表** —— `files.row_read` 前后逐格一模一样。

D-c **写路径分流** —— 改晋升列 → 走数据库校验 + 写正式值 + 仅值回填；
     改普通列 → 走原表保存，不碰数据库。
     · 喂非法金额（违反 min:0）→ **被拒**，且**没写进数据库**、**没把格子清空**；
       拒的文案里**带着你刚打的那个值**，页面靠它把字留在格子里让你改。
     · 改备注 → **存住**，且**不碰数据库**（那格读出来标着来自表；「备注」根本进不了正式值口）。
     **边界**：「格子里字面上是你刚打的那个字」是**页面那一半**（A 的腿），本文件不冒充。
     后端这一半只保证：被拒 / 没写进去 / 没清空 / 回执带得回值。

D-d **后台改正式值回写原表** —— 改数据库值后，原表对应格子跟着变，**格式不动**：
     改金额 100→200 刷新后那格是 200，**颜色/列宽/旁边普通列的值都在**。
     格式在 xlsx 字节里，读口只回值不回格式 —— 所以这一段**下载字节用 openpyxl 比**
     （底色 / 列宽 / 旁边普通列），不拿读口的回包冒充「格式还在」。

---
**硬边界（一条不放宽）**：
  1. **桩不能报「004 通过」** —— 本文件跑绿只说明「D-a～D-d 在合成样本上成立」。
  2. **新增普通列不建数据库字段** —— 定义里没晋升的列，不许冒出 DB 字段。
  3. **仅值回填、保格式** —— 回写只改那一格的值，不改颜色/列宽/合并/其余格。
  4. **首次晋升仅 FDE 受管工程入口** —— 普通员工/Agent 不得自己晋升。
  5. **没有「只写数据库不动表」的后门** —— 正式值写完一律回填；
     分岔状态走产品路造（写完正式值再改表里那格）。

**绑定口径**（执行计划 :81）：按**固定行ID + 表头 + 结构/定义版本**定位。
  表头改了 / 结构版本变了 / 定义版本升了，旧绑定要能认出对不上，不许拿旧绑定乱对。

用法：
  export SS_BASE=http://127.0.0.1:3840
  export SS_D_USER=Administrator SS_D_PW=…   # 口令见 Agent-D-测试账号.md，不写进代码
  python3 shangshu-server/scripts/tests/test_d_promotion_chain.py [--cases da,db,dc,dd]
"""
import argparse
import importlib.util
import json
import os
import sys

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')
spec = importlib.util.spec_from_file_location('t', ROOT + '/shangshu-server/scripts/test-n2-structure.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
# 故障断点装/卸 —— **公共工具只此一份**（§13），`_ss_fault.py` 是它的家。
# 显式加载，不靠 `sys.path` 碰运气（脚本从哪一级目录跑都会坏）。
spec_f = importlib.util.spec_from_file_location(
    '_ss_fault', ROOT + '/shangshu-server/scripts/tests/_ss_fault.py')
_ss_fault = importlib.util.module_from_spec(spec_f)
spec_f.loader.exec_module(_ss_fault)
# 取值/解析的**公共件只此一份**（§13）—— `_ss_seed` 是它的家。
# ⚠️ 尤其 `_got_bytes`：下载失败时 `_bytes` 里装的是**拒因正文**（340 字节上下），
# `bool()` 照样真。第一版 ⑧ 的详情就这么写成「拿到内容=True，闸没挡住」，
# 而那会儿闸明明挡住了（HTTP 417）—— **详情说反话，比红了还坏**。
spec_s = importlib.util.spec_from_file_location(
    '_ss_seed', ROOT + '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_seed = importlib.util.module_from_spec(spec_s)
spec_s.loader.exec_module(_ss_seed)
_got_bytes = _ss_seed._got_bytes
# 凭据取法也只此一份（§13）—— `_ss_cred.py` 是它的家。
spec_c = importlib.util.spec_from_file_location(
    '_ss_cred', ROOT + '/shangshu-server/scripts/tests/_ss_cred.py')
_ss_cred = importlib.util.module_from_spec(spec_c)
spec_c.loader.exec_module(_ss_cred)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW', '')
if not PW:
    print('结果： FAIL 缺 SS_D_PW（口令见 开发/本地测试/Agent-D-测试账号.md，不写进代码）')
    sys.exit(2)

RUN = t.RUN
VALID = ('da', 'db', 'dc', 'dd', 'rt', 'emp')
parser = argparse.ArgumentParser(description='PKG-004 第一条可用链 D-a～D-d')
parser.add_argument('--cases', default='da')
cli = parser.parse_args()
want = tuple(x.strip() for x in cli.cases.split(',') if x.strip()) or ('da',)
bad = [x for x in want if x not in VALID]
if bad:
    print('结果： FAIL --cases 有未知用例：%s' % ','.join(bad)); sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

checks = 0
fails = []
not_yet = []


def notyet(name, why):
    """记「未测」，**不许当成过**。造不出前置就照实标，不硬造、不假装验过。"""
    global checks
    checks += 1
    not_yet.append('%s —— %s' % (name, why))
    print('  ~ ' + name + ' — 未测：' + why)


def check(name, ok, detail):
    global checks
    checks += 1
    print(('  PASS ' if ok else '  FAIL ') + name + ' —— ' + str(detail))
    if not ok:
        fails.append(name)


def result_of(st, body):
    b = body if isinstance(body, dict) else {}
    r = b.get('result')
    return r if isinstance(r, dict) else (b if isinstance(b, dict) else {})


# ---------- 合成样本：一张三列表 ----------
# 案件编号 / 金额 / 备注 —— 前两列要晋升，第三列不晋升。
HEADERS = ('案件编号', '金额', '备注')
ROW1 = ('CASE-%s' % RUN, 100, '原始备注')


def versions(table):
    """取当前内容/结构版本 —— 版本闩要传真实值，写死会撞 417（探针测试栽过）。"""
    st, body = t.service(c, 'files.sheet_read', {'table': table})
    res = result_of(st, body)
    return (int(res.get('content_version') or 0), int(res.get('structure_version') or 1))


def build_sheet(name):
    """造一张三列一行的表：建表 → 加三列 → 加一行 → 按 行ID+表头 写格。

    **寻址是 row_id + header，不是 A1 记法** —— `files.sheet_cell_write` 的形状。
    每步带版本闩，且闩取当前真实版本（写死会撞 417）。
    """
    st, body = t.action(c, 'files.create', {'file_name': name, 'directory': '/'},
                        'd-promo-src-%s' % name)
    fid = result_of(st, body).get('file')
    if not fid:
        return None, '建表失败 HTTP %s %s' % (st, str(body)[:160])
    for h in HEADERS:
        cv, sv = versions(fid)
        st1, b1 = t.action(c, 'files.sheet_column_append',
                           {'table': fid, 'header': h,
                            'expected_content_version': cv, 'expected_structure_version': sv},
                           'd-col-%s-%s' % (h, name))
        if st1 != 200 or not b1.get('ok'):
            return None, '加列失败 %s HTTP %s %s' % (h, st1, str(b1)[:140])
    cv, sv = versions(fid)
    st2, b2 = t.action(c, 'files.sheet_row_append',
                       {'table': fid, 'count': 1,
                        'expected_content_version': cv, 'expected_structure_version': sv},
                       'd-row-%s' % name)
    if st2 != 200 or not b2.get('ok'):
        return None, '加行失败 HTTP %s %s' % (st2, str(b2)[:140])
    # 拿到固定行 ID
    st3, b3 = t.service(c, 'files.sheet_read', {'table': fid})
    rows = result_of(st3, b3).get('rows') or []
    if not rows:
        return None, '加行后读不到行'
    row_id = rows[0].get('row_id')
    for header, val in zip(HEADERS, ROW1):
        cv, sv = versions(fid)
        typed = {'type': 'number', 'value': val} if isinstance(val, (int, float)) else {'type': 'text', 'value': val}
        st4, b4 = t.action(c, 'files.sheet_cell_write',
                           {'table': fid, 'row_id': row_id, 'header': header,
                            'value': typed,
                            'expected_content_version': cv, 'expected_structure_version': sv},
                           'd-cell-%s-%s' % (header, name))
        if st4 != 200 or not b4.get('ok'):
            return None, '写格失败 %s HTTP %s %s' % (header, st4, str(b4)[:140])
    return fid, row_id


DEFINITION = {
    'definition_version': 1,
    'columns': [
        {'header': '案件编号', 'promoted': True, 'field': 'case_no', 'type': 'text', 'rules': {'required': True}},
        {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number', 'rules': {'min': 0}},
        {'header': '备注', 'promoted': False},
    ],
}


def _err_text(body):
    """错误文案（frappe 回包字段不唯一，都取上）。"""
    if not isinstance(body, dict):
        return str(body)[:200]
    return str(body.get('error') or body.get('message') or body.get('exc')
               or body.get('_server_messages') or body)[:300]


def _cells_of(fid, rid):
    """读合并行的**原始格**（按表头键）—— `files.row_read` 回 `cells: {表头: {value, source}}`。

    **读口只留这一份**（§13 原则 1）。`_read_of` 是它的薄壳，给合成样本那三个字段用；
    真实表（`验收样例.xlsx`：编号/名称/客户/金额/备注）也走这里，不另写第二份读法。
    """
    st, body = t.service(c, 'files.row_read', {'table': fid, 'row_id': rid})
    res = result_of(st, body)
    return (res.get('cells') or {}), (res.get('source') or {})


def _read_of(fid, rid):
    """读合并行（产品读口 `files.row_read`）。晋升列的值来自数据库、普通列的来自表。

    只是 `_cells_of` 的薄壳 —— 合成样本那三列的常用名。**别在这儿重写读法。**
    """
    cells, source = _cells_of(fid, rid)
    return {'case_no': (cells.get('案件编号') or {}).get('value'),
            'amount': (cells.get('金额') or {}).get('value'),
            'note': (cells.get('备注') or {}).get('value'),
            'source': source}


def _sheet_of(fid, rid):
    """读表数据那侧（不经合并）—— 拿「格子里现在是什么」。"""
    st, body = t.service(c, 'files.sheet_read', {'table': fid})
    rows = result_of(st, body).get('rows') or []
    for r in (rows if isinstance(rows, list) else []):
        if str(r.get('row_id') or '') == rid:
            return r.get('values') or {}
    return {}

def _xlsx_widths(raw):
    """从 xlsx 字节里读列宽 —— **格式只在字节里**，读口只回值不回格式。

    **模块级、只此一份**（§13 原则 1）：RT 组和 emp 组都用它，不各留一份
    （原先嵌在 `rt` 块里，emp 够不着，直接 NameError —— 实测栽过）。
    """
    if not raw:
        return None
    try:
        import openpyxl as _ox
        from io import BytesIO as _BO
        ws = _ox.load_workbook(_BO(raw)).worksheets[0]
    except Exception:
        return None
    out = {}
    for k, dim in ws.column_dimensions.items():
        if dim.width:
            out[k] = round(float(dim.width), 1)
    return out


def _cell_text(raw, row, col):
    """从 xlsx 字节里取一格的**显示值**。**模块级、只此一份**（同上）。"""
    if not raw:
        return None
    try:
        import openpyxl as _ox
        from io import BytesIO as _BO
        ws = _ox.load_workbook(_BO(raw)).worksheets[0]
        return ws.cell(row=row, column=col).value
    except Exception:
        return None


def _ref_of(table, cli=None):
    """取**当前工作文件的下载 ref**（`files.versions.current.source.file`）。

    **取 ref 的口只留这一份**（§13 原则 1）—— `_xlsx_of` 和 RT-④③ 的裸下载都用它。
    回 ``(ref|None, 说明)``。**注意这是有闸的口**：有待恢复的回填时它会拒
    （那正是「不导出旧文件」那道闸）。

    `cli` = 用谁的身份取。**默认管理员**；下别人的表要传本人 ——
    管理员下不了别人的个人表（实测 403），拿不到字节会**静默变成 None**，
    判据就假绿了（emp ⑦ 栽过一次）。**所以别省这个参数。**
    """
    st_v, b_v = t.service(cli or c, 'files.versions', {'file': table})
    result = result_of(st_v, b_v)
    # 当前工作文件与不可变历史版本分开。旧 versions[0] 是上传快照，
    # 不能用它验收本次正式值回填，否则会把历史值误报为当前文件未更新。
    # 当前协议缺 current 时失败，不静默退回历史文件制造假证据。
    current = result.get('current') if isinstance(result, dict) else None
    ref = ((current.get('source') or {}).get('file')) if current else None
    return ref, ('' if ref else '取不到附件：%s' % str(b_v)[:120])


def _xlsx_of(table, cli=None):
    """取当前这份 xlsx 的**字节** —— 格式在字节里，读口只回值不回格式。

    **下载口只留这一份**（§13 原则 1）。D-d 与真实表组（RT/emp）都用它，不各写一份。
    回 ``(bytes|None, 说明)``。走的是 `files.versions` → 下载 —— **受导出闸管**。
    """
    ref, why_ref = _ref_of(table, cli)
    if not ref:
        return None, why_ref
    st_dl, blob = t.download(cli or c, table, ref)
    raw = blob.get('_bytes') if isinstance(blob, dict) else None
    if st_dl != 200 or not raw:
        return None, 'HTTP %s %s' % (st_dl, str(blob)[:110])
    return raw, 'HTTP %s %d 字节' % (st_dl, len(raw))



# ---------- D-a 晋升定义模型 ----------

if 'da' in want:
    print('\n== D-a 晋升定义模型：读回来三列的晋升标记 = 是/是/否，不多不少 ==')
    fid, row_id_a = build_sheet('004定义-%s.xlsx' % RUN)
    check('D-a 前置：造出合成三列表', bool(fid), '表=%s 行=%s' % (fid, row_id_a))
    if fid:
        # 绑定要带「绑定那一刻的结构版本」（乐观锁）。先读当前的，再拿它去绑 ——
        # 不带会被 schema 挡下（那是入参缺件，不是判据红）。
        st0, body0 = t.service(c, 'files.promotion_definition', {'table': fid})
        cur_sv = result_of(st0, body0).get('structure_version')
        check('D-a ① 读得到当前结构版本（不带定义也要回，否则绑不起头）',
              st0 == 200 and cur_sv is not None, 'HTTP %s structure_version=%r' % (st0, cur_sv))
        st, body = t.action(c, 'files.promotion_define',
                            {'table': fid,
                             'expected_structure_version': cur_sv,
                             'definition': DEFINITION},
                            'd-promo-def-%s' % RUN)
        check('D-a ② 定义被接受', st == 200 and body.get('ok'),
              'HTTP %s %s' % (st, str(body)[:160]))
        st2, body2 = t.service(c, 'files.promotion_definition', {'table': fid})
        res = result_of(st2, body2)
        cols = res.get('columns') or []
        print('  定义回包：%s' % json.dumps(res, ensure_ascii=False)[:320])
        check('D-a ③ 读得出定义（回包含 columns 数组）', st2 == 200 and isinstance(cols, list),
              'HTTP %s keys=%s' % (st2, sorted(res.keys())))
        flags = {x.get('header'): x.get('promoted') for x in cols}
        check('D-a ④ 三列的晋升标记是 是/是/否，不多不少',
              flags == {'案件编号': True, '金额': True, '备注': False},
              'flags=%r' % flags)
        check('D-a ⑤ 列数不多不少（恰好 3，不许多出「新增普通列」的晋升项）',
              len(cols) == 3, '列数=%d %r' % (len(cols), [x.get('header') for x in cols]))
        # 绑定口径：表头 + 结构版本 + 定义版本
        check('D-a ⑥ 定义带着结构版本与定义版本（绑定按它们定位）',
              res.get('structure_version') is not None and res.get('definition_version') == 1,
              'structure_version=%r definition_version=%r' %
              (res.get('structure_version'), res.get('definition_version')))
        # 反例：非晋升列不许冒出 DB 字段
        no_field = [x for x in cols if not x.get('promoted') and x.get('field')]
        check('D-a ⑦ 非晋升列没有数据库字段（新增普通列不建 DB 字段）',
              not no_field, '冒出字段的非晋升列=%r' % no_field)

        # D-a ⑧ **敏感度自检**：判别式必须分得出「对的定义」和「错的定义」。
        # 不是把 D-a ④ 再跑一遍（那样恒同向，证明不了判据有牙齿）。
        def _flags_ok(cols_):
            """D-a ④ 的判别式：三列的晋升标记恰好是 是/是/否，不多不少。"""
            f = {x.get('header'): x.get('promoted') for x in cols_}
            return f == {'案件编号': True, '金额': True, '备注': False} and len(cols_) == 3

        good = [{'header': '案件编号', 'promoted': True},
                {'header': '金额', 'promoted': True},
                {'header': '备注', 'promoted': False}]
        flipped = [{'header': '案件编号', 'promoted': True},
                   {'header': '金额', 'promoted': True},
                   {'header': '备注', 'promoted': True}]      # 备注误标成已晋升
        extra = good + [{'header': '新增列', 'promoted': True}]  # 多出一列
        short = good[:2]                                         # 少一列
        check('D-a ⑧ 敏感度：判别式认「对的定义」为过', _flags_ok(good), 'good')
        check('D-a ⑧ 敏感度：判别式认「备注误标晋升」为不过', not _flags_ok(flipped), 'flipped')
        check('D-a ⑧ 敏感度：判别式认「多出一列」为不过', not _flags_ok(extra), 'extra')
        check('D-a ⑧ 敏感度：判别式认「少一列」为不过', not _flags_ok(short), 'short')
        check('D-a ⑧ 敏感度：四种形状给出两种不同结论（不是恒真/恒假）',
              len({_flags_ok(good), _flags_ok(flipped), _flags_ok(extra), _flags_ok(short)}) == 2,
              '结论集合=%s' % sorted({_flags_ok(good), _flags_ok(flipped),
                                     _flags_ok(extra), _flags_ok(short)}))

# ---------- D-b 读路径合并 ----------

if 'db' in want:
    print('\n== D-b 读路径合并：晋升列取数据库、普通列取表，两边不互相覆盖 ==')
    fid2, row_id_b = build_sheet('004读合并-%s.xlsx' % RUN)
    check('D-b 前置：造出合成三列表', bool(fid2), '表=%s 行=%s' % (fid2, row_id_b))
    if fid2:
        st0, body0 = t.service(c, 'files.promotion_definition', {'table': fid2})
        cur_sv = result_of(st0, body0).get('structure_version')
        t.action(c, 'files.promotion_define',
                 {'table': fid2, 'expected_structure_version': cur_sv, 'definition': DEFINITION},
                 'd-promo-def-b-%s' % RUN)
        # 造「数据库和表不一致」的分岔状态，**走产品路、不走后门**。
        #
        # ⚠️ **造法换过一次**（合成之后，2026-10-15）：原先靠「写完正式值，再用普通表编辑
        # 把表里那两格改回旧值」。**合成后那条路没了** —— 往有数据库字段的列里写 = 走数据库，
        # 不再是「只进表」。所以产品路只剩**回填失败**这一条：
        #   装上 `file-write` 断点 → 写正式值 → **数据库那半成了、回填那半没成** →
        #   表里还是原值、数据库是新值。这正是 RT-④③ 那个「待恢复」态，也是现实里
        #   分岔唯一会真的出现的地方。
        # **回填失败那条路是产品自己有的**（`sheet._fault`），不是我们造的后门。
        compose = _ss_fault.compose_of(BASE)
        arm_ok, arm_why = _ss_fault.arm(compose, 'file-write')
        check('D-b 前置：造分岔的断点装上了（装不上后面的分岔不可信）', arm_ok, arm_why[:120])
        try:
            st_f, body_f = t.action(c, 'files.formal_value_write',
                                    {'table': fid2, 'row_id': row_id_b,
                                     'values': {'case_no': 'DB-CASE-%s' % RUN, 'amount': 200}},
                                    'd-formal-w-%s' % RUN)
        finally:
            # ⚠️ **断点必须卸**（放 finally）—— 留在容器里之后每一次落盘都会炸，
            # 下一轮测试会红在莫名其妙的地方。
            clear_ok, clear_why = _ss_fault.clear(compose)
        check('D-b 前置：正式值写进数据库侧（回填失败 → 表里还是旧值）',
              st_f == 200 and (body_f or {}).get('ok'),
              'HTTP %s %s' % (st_f, str(body_f)[:150]))
        r_f = result_of(st_f, body_f)
        check('D-b 前置：回执如实说回填没成（`sheet_written` 是假）',
              r_f.get('sheet_written') is False and bool(r_f.get('pending')),
              'formal_written=%r sheet_written=%r pending=%r'
              % (r_f.get('formal_written'), r_f.get('sheet_written'), r_f.get('pending')))
        diverge_ok = True
        sh = _sheet_of(fid2, row_id_b)
        check('D-b 前置：分岔造好了（表里是旧值、数据库里是新值）',
              ((sh.get('案件编号') or {}).get('value')) == ROW1[0]
              and ((sh.get('金额') or {}).get('value')) == ROW1[1],
              '表里案件编号=%r 金额=%r　（断点卸载=%s %s）'
              % ((sh.get('案件编号') or {}).get('value'),
                 (sh.get('金额') or {}).get('value'),
                 clear_ok, clear_why[:40]))
        sheet_before = _sheet_of(fid2, row_id_b)
        st_r, body_r = t.service(c, 'files.row_read', {'table': fid2, 'row_id': row_id_b})
        res = result_of(st_r, body_r)
        cells = res.get('cells') or {}
        # cells 是「表头 → {type, value}」，取 .value 比
        val = lambda h: (cells.get(h) or {}).get('value')
        print('  合并回包：%s' % json.dumps(res, ensure_ascii=False)[:320])
        check('D-b ① 读得出合并行', st_r == 200 and isinstance(cells, dict) and bool(cells),
              'HTTP %s cells=%r' % (st_r, cells))
        check('D-b ② 晋升列的值 = 数据库里的值（不是表里那个被改过的值）',
              val('案件编号') == 'DB-CASE-%s' % RUN and val('金额') == 200,
              '案件编号=%r 金额=%r' % (val('案件编号'), val('金额')))
        check('D-b ③ 普通列的值 = 表里的值（数据库没碰它）',
              val('备注') == '原始备注', '备注=%r' % (val('备注'),))
        check('D-b ④ 两边不互相覆盖：**普通列**的表编辑不反写数据库，数据库新值也不盖掉普通列',
              val('案件编号') != ROW1[0] and val('备注') == ROW1[2],
              '案件编号=%r(表里=%r) 备注=%r　← 「表编辑不反写数据库」这半**只对普通列说**：'
              '合成后往有字段的列里写 = 走数据库，那不是「表编辑」了'
              % (val('案件编号'), ROW1[0], val('备注')))
        # 反向：**读这件事不动表** —— 拿 row_read 前后两次表数据逐格比，
        # 不是「表里还是旧值」（那跟回填/编辑都可能变，证明不了是读干的）。
        sheet_after = _sheet_of(fid2, row_id_b)
        check('D-b ⑤ 读这件事没动表数据（row_read 前后逐格一模一样）',
              sheet_before == sheet_after,
              '前=%r 后=%r' % (sheet_before, sheet_after))
        # 来源标注：哪几列来自数据库、哪几列来自表
        src = res.get('source') or {}
        check('D-b ⑥ 来源标注分得清（晋升列=database、普通列=sheet）',
              src.get('案件编号') == 'database' and src.get('金额') == 'database'
              and src.get('备注') == 'sheet',
              'source=%r' % src)

        # D-b ⑦ **敏感度自检**：合并判别式必须分得出「合并对了」和「合并错了」。
        # 不是把 D-b ②③⑥ 再跑一遍（那样恒同向，证明不了判据有牙齿）。
        def _merge_ok(cells_, source_, want_db, want_sheet):
            """D-b ②③⑥ 的判别式：晋升列取数据库值+标 database、普通列取表值+标 sheet。"""
            for h, v in want_db.items():
                if (cells_.get(h) or {}).get('value') != v:
                    return False
                if source_.get(h) != 'database':
                    return False
            for h, v in want_sheet.items():
                if (cells_.get(h) or {}).get('value') != v:
                    return False
                if source_.get(h) != 'sheet':
                    return False
            return True

        want_db = {'案件编号': 'DB-CASE-%s' % RUN, '金额': 200}
        want_sheet = {'备注': '原始备注'}
        good = ({'案件编号': {'value': 'DB-CASE-%s' % RUN}, '金额': {'value': 200},
                 '备注': {'value': '原始备注'}},
                {'案件编号': 'database', '金额': 'database', '备注': 'sheet'})
        # 晋升列取了表里的旧值（数据库那个新值被表盖掉了）
        promoted_from_sheet = ({'案件编号': {'value': ROW1[0]}, '金额': {'value': 200},
                                '备注': {'value': '原始备注'}},
                               {'案件编号': 'database', '金额': 'database', '备注': 'sheet'})
        # 普通列被数据库覆盖了（备注冒出个数据库值）
        normal_from_db = ({'案件编号': {'value': 'DB-CASE-%s' % RUN}, '金额': {'value': 200},
                           '备注': {'value': 'DB-备注'}},
                          {'案件编号': 'database', '金额': 'database', '备注': 'database'})
        # 值都对，但来源标反了
        swapped_source = (good[0], {'案件编号': 'sheet', '金额': 'sheet', '备注': 'database'})
        shapes = {'good': good, 'promoted_from_sheet': promoted_from_sheet,
                  'normal_from_db': normal_from_db, 'swapped_source': swapped_source}
        verdicts = {k: _merge_ok(c, s, want_db, want_sheet) for k, (c, s) in shapes.items()}
        check('D-b ⑦ 敏感度：判别式认「合并对了」为过', verdicts['good'] is True, 'good')
        check('D-b ⑦ 敏感度：判别式认「晋升列被表盖掉」为不过',
              verdicts['promoted_from_sheet'] is False, 'promoted_from_sheet')
        check('D-b ⑦ 敏感度：判别式认「普通列被数据库覆盖」为不过',
              verdicts['normal_from_db'] is False, 'normal_from_db')
        check('D-b ⑦ 敏感度：判别式认「来源标反了」为不过',
              verdicts['swapped_source'] is False, 'swapped_source')
        check('D-b ⑦ 敏感度：四种形状给出两种不同结论（不是恒真/恒假）',
              len(set(verdicts.values())) == 2, '结论=%r' % verdicts)


# ---------- D-c 写路径分流 ----------

if 'dc' in want:
    print('\n== D-c 写路径分流：晋升列走数据库校验、普通列走表保存 ==')
    fid3, row_id_c = build_sheet('004写分流-%s.xlsx' % RUN)
    check('D-c 前置：造出合成三列表', bool(fid3), '表=%s 行=%s' % (fid3, row_id_c))
    if fid3:
        st0, body0 = t.service(c, 'files.promotion_definition', {'table': fid3})
        cur_sv = result_of(st0, body0).get('structure_version')
        st_d, b_d = t.action(c, 'files.promotion_define',
                             {'table': fid3, 'expected_structure_version': cur_sv,
                              'definition': DEFINITION}, 'd-promo-def-c-%s' % RUN)
        check('D-c 前置：定义被接受', st_d == 200 and b_d.get('ok'), 'HTTP %s' % st_d)

        def _cell_write(header, value, key):
            cv, sv = versions(fid3)
            return t.action(c, 'files.cell_write',
                            {'table': fid3, 'row_id': row_id_c, 'header': header,
                             'value': value,
                             'expected_content_version': cv,
                             'expected_structure_version': sv}, key)

        # 先写一笔合法金额，好让「没被清空」「没写进去」有可比的旧值
        st_ok, b_ok = _cell_write('金额', {'type': 'number', 'value': 100}, 'd-w-ok-%s' % RUN)
        check('D-c ① 合法金额走数据库那条路（晋升列）',
              st_ok == 200 and b_ok.get('ok') and result_of(st_ok, b_ok).get('routed') == 'database',
              'HTTP %s routed=%r' % (st_ok, (result_of(st_ok, b_ok) or {}).get('routed')))

        # —— 喂非法金额：规则是 min:0，-5 违规 ——
        st_bad, b_bad = _cell_write('金额', {'type': 'number', 'value': -5}, 'd-w-bad-%s' % RUN)
        err = _err_text(b_bad)
        check('D-c ② 喂非法金额 → **被拒**（不是静默收下）',
              st_bad != 200 or not b_bad.get('ok'), 'HTTP %s %s' % (st_bad, err[:120]))
        check('D-c ③ 拒得下**文案里带着你刚打的那个值**（页面靠它把字留在格子里）',
              '-5' in err and ('留在格子里' in err or '没清空' in err), '文案=%r' % err[:200])
        after_bad = _read_of(fid3, row_id_c)
        check('D-c ④ 被拒后**没写进数据库**（金额还是刚才那个 100，不是 -5）',
              after_bad.get('amount') == 100, '金额=%r' % after_bad.get('amount'))
        sheet_bad = _sheet_of(fid3, row_id_c)
        cell_bad = (sheet_bad.get('金额') or {})
        check('D-c ⑤ 被拒后**没把格子清空**（那格还有内容，不是空）',
              cell_bad.get('value') not in (None, ''), '表里「金额」=%r' % cell_bad)

        # —— 改普通列（备注）：走表保存，不碰数据库 ——
        st_n, b_n = _cell_write('备注', {'type': 'text', 'value': '改过的备注'}, 'd-w-note-%s' % RUN)
        res_n = result_of(st_n, b_n)
        check('D-c ⑥ 改备注 → **存住**',
              st_n == 200 and b_n.get('ok') and res_n.get('sheet_written') is True,
              'HTTP %s %s' % (st_n, str(b_n)[:120]))
        after_note = _read_of(fid3, row_id_c)
        # 两个独立角度：①产品自己说这格来自表；②往正式值口喂「备注」当场被拒
        #   （备注压根不是晋升列的数据库字段）—— 后者不依赖 row_read 的自述。
        st_fb, b_fb = t.action(c, 'files.formal_value_write',
                               {'table': fid3, 'row_id': row_id_c, 'values': {'备注': 'x'}},
                               'd-w-note-probe-%s' % RUN)
        check('D-c ⑦ 改备注**不碰数据库**（那格读出来标着来自表；且「备注」根本进不了正式值口）',
              after_note.get('source', {}).get('备注') == 'sheet'
              and after_note.get('note') == '改过的备注'
              and (st_fb != 200 or not b_fb.get('ok')),
              'source=%r 读回备注=%r 正式值口喂备注 HTTP %s' % (
                  after_note.get('source'), after_note.get('note'), st_fb))
        check('D-c ⑧ 分流标注分得清（晋升列=routed:database、普通列=routed:sheet）',
              res_n.get('routed') == 'sheet' and res_n.get('formal_written') is False,
              'routed=%r formal_written=%r' % (res_n.get('routed'), res_n.get('formal_written')))

        # 改合法金额：正式值进去 + 表里那格跟上
        st_g, b_g = _cell_write('金额', {'type': 'number', 'value': 300}, 'd-w-300-%s' % RUN)
        res_g = result_of(st_g, b_g)
        after_g = _read_of(fid3, row_id_c)
        sheet_g = _sheet_of(fid3, row_id_c)
        check('D-c ⑨ 改合法金额 → 正式值写进去 **且** 表里那格跟上',
              st_g == 200 and after_g.get('amount') == 300
              and ((sheet_g.get('金额') or {}).get('value')) == 300
              and res_g.get('routed') == 'database',
              '读回=%r 表里=%r routed=%r' % (after_g.get('amount'),
                                             (sheet_g.get('金额') or {}).get('value'),
                                             res_g.get('routed')))

        # D-c ⑩ **敏感度自检**：分流判别式必须分得出「分对了」和「分错了」。
        def _route_ok(routed_, formal_written_, sheet_written_, is_promoted):
            """D-c ①⑥⑧ 的判别式：晋升列走 database 且写了正式值；普通列走 sheet 且不写正式值。"""
            if is_promoted:
                return routed_ == 'database' and formal_written_ is True and sheet_written_ is True
            return routed_ == 'sheet' and formal_written_ is False and sheet_written_ is True

        r_good_p = _route_ok('database', True, True, True)
        r_good_n = _route_ok('sheet', False, True, False)
        # 晋升列被当普通列处理了（绕过 DB 校验，直接写表）
        r_promoted_as_sheet = _route_ok('sheet', False, True, True)
        # 普通列被当晋升列处理了（多写了数据库）
        r_normal_as_db = _route_ok('database', True, True, False)
        # 晋升列只写数据库、没回填表
        r_db_only = _route_ok('database', True, False, True)
        verdicts_r = {x: v for x, v in [
            ('good_p', r_good_p), ('good_n', r_good_n),
            ('promoted_as_sheet', r_promoted_as_sheet),
            ('normal_as_db', r_normal_as_db), ('db_only', r_db_only)]}
        check('D-c ⑩ 敏感度：判别式认「分对了」为过（两种正确分流都过）',
              r_good_p and r_good_n, 'good_p=%r good_n=%r' % (r_good_p, r_good_n))
        check('D-c ⑩ 敏感度：判别式认「晋升列被当普通列」为不过',
              not r_promoted_as_sheet, 'promoted_as_sheet')
        check('D-c ⑩ 敏感度：判别式认「普通列被当晋升列」为不过',
              not r_normal_as_db, 'normal_as_db')
        check('D-c ⑩ 敏感度：判别式认「只写数据库不回填」为不过',
              not r_db_only, 'db_only')
        check('D-c ⑩ 敏感度：五种形状给出两种不同结论（不是恒真/恒假）',
              len(set(verdicts_r.values())) == 2, '结论=%r' % verdicts_r)


# ---------- D-d 后台改正式值回写原表（保格式）----------

if 'dd' in want:
    import base64 as _b64
    import io as _io
    from openpyxl import Workbook as _WB
    from openpyxl.styles import PatternFill as _Fill

    print('\n== D-d 后台改正式值回写原表：值跟上，格式/列宽/旁边普通列不动 ==')
    # 夹具：一张**带格式**的表 —— 金额格黄底、B 列列宽 22、备注有值。
    # 造格式用 openpyxl 在本地拼 xlsx 上传（真实客户文件本来就是带格式来的）。
    wb = _WB()
    ws = wb.active
    ws.append(['案件编号', '金额', '备注'])
    ws.append(['CASE-%s' % RUN, 100, '原始备注'])
    ws['B2'].fill = _Fill(fill_type='solid', start_color='FFFF00', end_color='FFFF00')
    ws.column_dimensions['B'].width = 22
    buf = _io.BytesIO()
    wb.save(buf)
    st_u, b_u = t.action(c, 'files.upload',
                         {'file_name': '004回写-%s.xlsx' % RUN, 'directory': '/',
                          'content_base64': _b64.b64encode(buf.getvalue()).decode()},
                         'd-up-%s' % RUN)
    fid4 = result_of(st_u, b_u).get('file')
    check('D-d 前置：上传带格式的合成表', st_u == 200 and bool(fid4),
          'HTTP %s file=%s %s' % (st_u, fid4, str(b_u)[:120]))
    row_id_d = None
    if fid4:
        st_r, b_r = t.service(c, 'files.sheet_read', {'table': fid4})
        rows_d = result_of(st_r, b_r).get('rows') or []
        row_id_d = rows_d[0].get('row_id') if rows_d else None
        check('D-d 前置：读得到固定行ID', bool(row_id_d), '行=%s' % row_id_d)
    if fid4 and row_id_d:
        st0, body0 = t.service(c, 'files.promotion_definition', {'table': fid4})
        cur_sv = result_of(st0, body0).get('structure_version')
        t.action(c, 'files.promotion_define',
                 {'table': fid4, 'expected_structure_version': cur_sv,
                  'definition': DEFINITION}, 'd-promo-def-d-%s' % RUN)

        # _xlsx_of 已提到模块级（一份实现，RT 组同用），这儿直接调。
        raw0, why0 = _xlsx_of(fid4)
        if not raw0:
            check('D-d 前置：取得到原始字节', False, why0)
        else:
            from openpyxl import load_workbook as _load
            w0 = _load(_io.BytesIO(raw0))
            s0 = w0.active
            fill0 = s0['B2'].fill.start_color.rgb if s0['B2'].fill and s0['B2'].fill.start_color else None
            width0 = s0.column_dimensions['B'].width
            note0 = s0['C2'].value
            check('D-d 前置：夹具有格式可比（B2 黄底 / B 列宽 22 / 备注有值）',
                  fill0 is not None and width0 == 22 and note0 == '原始备注',
                  'fill=%r width=%r note=%r' % (fill0, width0, note0))

            # —— 后台改正式值 100 → 200，只走数据库侧那个口 ——
            st_w, b_w = t.action(c, 'files.formal_value_write',
                                 {'table': fid4, 'row_id': row_id_d,
                                  'values': {'case_no': 'CASE-%s' % RUN, 'amount': 200}},
                                 'd-formal-d-%s' % RUN)
            check('D-d ① 后台改正式值被接受', st_w == 200 and b_w.get('ok'),
                  'HTTP %s %s' % (st_w, str(b_w)[:120]))

            # 刷新后读那一格 —— 应该是 200
            after = _read_of(fid4, row_id_d)
            sheet_after = _sheet_of(fid4, row_id_d)
            check('D-d ② 刷新后那格是 200（读路径合并出来的值）',
                  after.get('amount') == 200, '读回金额=%r' % after.get('amount'))
            check('D-d ③ 原表那格跟着变（回写落到了表数据里，不是只改了数据库）',
                  ((sheet_after.get('金额') or {}).get('value')) == 200,
                  '表里金额=%r' % (sheet_after.get('金额') or {}).get('value'))

            raw1, why1 = _xlsx_of(fid4)
            if not raw1:
                check('D-d ④ 改后取得到字节', False, why1)
            else:
                w1 = _load(_io.BytesIO(raw1))
                s1 = w1.active
                fill1 = s1['B2'].fill.start_color.rgb if s1['B2'].fill and s1['B2'].fill.start_color else None
                width1 = s1.column_dimensions['B'].width
                note1 = s1['C2'].value
                check('D-d ④ **格式没动**（B2 底色还是那个黄）',
                      fill1 == fill0, '改前=%r 改后=%r' % (fill0, fill1))
                check('D-d ⑤ **列宽没动**（B 列还是 22）',
                      width1 == width0, '改前=%r 改后=%r' % (width0, width1))
                check('D-d ⑥ **旁边普通列的值都在**（备注没被碰）',
                      note1 == note0 == '原始备注', '改前=%r 改后=%r' % (note0, note1))
                check('D-d ⑦ 只改了那一格的值（B2 是 200，A2 案件编号没变）',
                      s1['B2'].value == 200 and s1['A2'].value == 'CASE-%s' % RUN,
                      'B2=%r A2=%r' % (s1['B2'].value, s1['A2'].value))

            # D-d ⑧ **敏感度自检**：保格式判别式必须分得出「保住了」和「没保住」。
            def _fmt_ok(fill_a, width_a, note_a, value_a):
                """D-d ②～⑦ 的判别式：值是 200，且底色/列宽/旁边普通列一个没变。"""
                return (value_a == 200 and fill_a == fill0
                        and width_a == width0 and note_a == note0)

            v_good = _fmt_ok(fill0, width0, note0, 200)
            v_lost_fill = _fmt_ok(None, width0, note0, 200)      # 底色丢了
            v_lost_width = _fmt_ok(fill0, 10, note0, 200)        # 列宽被改了
            v_lost_note = _fmt_ok(fill0, width0, '别的', 200)    # 旁边普通列被碰了
            v_stale = _fmt_ok(fill0, width0, note0, 100)         # 值没跟上（还是 100）
            vd = {'good': v_good, 'lost_fill': v_lost_fill, 'lost_width': v_lost_width,
                  'lost_note': v_lost_note, 'stale': v_stale}
            check('D-d ⑧ 敏感度：判别式认「保住了」为过', v_good, 'good')
            check('D-d ⑧ 敏感度：判别式认「底色丢了」为不过', not v_lost_fill, 'lost_fill')
            check('D-d ⑧ 敏感度：判别式认「列宽被改了」为不过', not v_lost_width, 'lost_width')
            check('D-d ⑧ 敏感度：判别式认「旁边普通列被碰了」为不过', not v_lost_note, 'lost_note')
            check('D-d ⑧ 敏感度：判别式认「值没跟上」为不过', not v_stale, 'stale')
            check('D-d ⑧ 敏感度：五种形状给出两种不同结论（不是恒真/恒假）',
                  len(set(vd.values())) == 2, '结论=%r' % vd)

# ==================== RT：真实表上走 004 链（E 本轮主目标）====================
# **上面 D-a～D-d 全是合成样本**（`files.create` 服务端生成的最小簿：无样式/无列宽/无合并/
# 单工作表），文件头明写「合成样本上成立 ≠ 004 通过」。本组把同一条链推到**真实表**。
#
# **真实表比合成簿多出来的是什么**（这才是本组的价值）：
#   · **列宽** A=30 / B=18 / E=34 —— 合成簿根本没有列宽可丢
#   · **前导零** `00123`、**18 位长编号** `ZZ2026...` —— 会被「当数字」悄悄改掉
#   · **真实工作表名**「验收样例」、真实 6 行 5 列
# 这些特征一旦在晋升/回填中被弄坏，合成样本的绿**根本照不出来**。
#
# **样本**：`开发/本地测试/验收材料/验收样例.xlsx`（5,410 B，每行验一件事）。
# 列：`编号 / 名称 / 客户 / 金额 / 备注`。**样本是本机文件，不进仓库、不进证据目录**
# （用户规矩：客户真实文件不出本机）。这里只用它的字节，不复制不登记内容。
#
# **E 的四步**：
#   1. FDE 受管工程入口首次晋升两列（`编号`/`金额`），`备注` 留普通 —— 表身份/行ID/原格式保持
#   2. 人改单格：金额经数据库规则保存并仅值回填；备注走普通格保存；关开后都在
#   3. 新增普通列并填值 → **数据库不自动新增字段**；获批动作改正式值后原表更新、格式和普通内容保留
#   4. 导出同一原表得到**最新**内容；保存/同步失败可见、可恢复，**不能把旧文件冒充最新**
#
# **测试通过 =** 下面每条成立（**在真实表上**）：
#   RT-① 首次晋升两列、三列留普通；晋升后**列宽/前导零/长编号一字不变**
#   RT-② 单格分流：改金额走正式值+仅值回填；改备注走普通格保存；**两处格式都在**
#   RT-③ 新增普通列不建 DB 字段；**并且**原表内容与格式不被碰
#   RT-④ 导出的字节含最新值；**回填没完成时不得拿旧字节冒充最新**
#   RT-⑤ 敏感度两问
#
# ⚠️ **本组不报「004 通过」** —— 页面腿（A 的那半）前端对晋升四口**零引用**，整条没接线；
# 「真建数据库字段」契约那半也未实现。本组只说明「**后端链在真实表上成立**」。

if 'rt' in want:
    _rt_before = checks
    print('\n== RT 真实表上走 004 链（样本：验收样例.xlsx）==')
    import openpyxl as _oxl
    from io import BytesIO as _BIO

    SAMPLE = (os.environ.get('SS_ACCEPT_SAMPLE')
              or '/path/to/workspace')
    # 列宽基线（样本实测）：A=30 B=18 E=34 —— **回填后必须一字不差**
    WIDTHS0 = {'A': 30.0, 'B': 18.0, 'E': 34.0}
    RT_HEAD = ['编号', '名称', '客户', '金额', '备注']
    # `_xlsx_widths` / `_cell_text` 已提到**模块级**（只此一份，emp 组同用）。
    # 本地留个短别名，老写法照旧能读。
    _widths = _xlsx_widths

    # ---- 上传真实表 ----
    with open(SAMPLE, 'rb') as fh:
        sample_bytes = fh.read()
    st_up, b_up = t.action(c, 'files.upload', {
        'file_name': '004真实表-%s.xlsx' % RUN, 'directory': '/',
        'content_base64': __import__('base64').b64encode(sample_bytes).decode(),
        'attribution': {'level': 'personal'}}, 'rt-upload')
    RT = result_of(st_up, b_up).get('file')
    check('RT 前置：真实表上传成功（不是程序拼的最小簿）',
          st_up == 200 and bool(RT), 'HTTP %s file=%r bytes=%d' % (st_up, RT, len(sample_bytes)))

    if RT:
        # ---- RT-① 首次晋升（受管工程入口）----
        st_def, b_def = t.service(c, 'files.promotion_definition', {'table': RT})
        cur_sv = result_of(st_def, b_def).get('structure_version')
        RT_DEF = {
            'definition_version': 1,
            'columns': [
                {'header': '编号', 'promoted': True, 'field': 'case_no', 'type': 'text',
                 'rules': {'required': True}},
                {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
                 'rules': {'min': 0}},
                {'header': '名称', 'promoted': False},
                {'header': '客户', 'promoted': False},
                {'header': '备注', 'promoted': False},
            ]}
        st_pd, b_pd = t.action(c, 'files.promotion_define', {
            'table': RT, 'expected_structure_version': cur_sv, 'definition': RT_DEF}, 'rt-define')
        check('RT-① ① 受管工程入口接受晋升定义（两列晋升、三列留普通）',
              st_pd == 200 and result_of(st_pd, b_pd).get('ok') is not False,
              'HTTP %s %s' % (st_pd, str(b_pd)[:120]))

        st_rd, b_rd = t.service(c, 'files.promotion_definition', {'table': RT})
        cols = result_of(st_rd, b_rd).get('columns') or []
        flags = {c_.get('header'): bool(c_.get('promoted')) for c_ in cols if isinstance(c_, dict)}
        check('RT-① ② 五列的晋升标记是 否/否/否/是/是（按 表头 对上，不多不少）',
              flags == {'编号': True, '金额': True, '名称': False, '客户': False, '备注': False},
              'flags=%r' % flags)
        check('RT-① ③ **未晋升的三列不许带数据库字段**',
              all(not (c_.get('field') or c_.get('type') or c_.get('rules'))
                  for c_ in cols if isinstance(c_, dict) and not c_.get('promoted')),
              'cols=%s' % str(cols)[:160])

        raw1, why1 = _xlsx_of(RT)
        w1 = _widths(raw1)
        check('RT-① ④ **晋升不碰格式**：列宽 A=30 / B=18 / E=34 一字不差',
              w1 == WIDTHS0, '基线=%r 实测=%r（%s）' % (WIDTHS0, w1, why1[:60]))
        check('RT-① ⑤ **前导零还在**：A2 是 00123 不是 123',
              str(_cell_text(raw1, 2, 1)) == '00123', 'A2=%r' % _cell_text(raw1, 2, 1))
        check('RT-① ⑥ **18 位长编号一字不丢**',
              str(_cell_text(raw1, 3, 1)) == 'ZZ2026EXCELFIRSTBATCH0000042',
              'A3=%r' % _cell_text(raw1, 3, 1))

        # ---- RT-② 单格改值分流 ----
        cv, sv = versions(RT)
        rid = (result_of(*t.service(c, 'files.sheet_read', {'table': RT})).get('rows') or [{}])[0].get('row_id')
        # 金额（晋升列，number）→ 走数据库规则保存 + 仅值回填
        # ⚠️ 两处写法照 `domain.py` 的 schema，别照表头想当然：
        #   · `values` 的键是**数据库字段名**（`amount`），**不是表头**（`金额`）
        #     —— schema 标题写的就是「数据库字段名 → 值」
        #   · `files.formal_value_write` **没有版本闩**（schema 只有 table/row_id/values），
        #     而隔壁 `files.cell_write` **有** `expected_content_version` —— **产品不对称**，
        #     第一版照 cell_write 的形状传闩，撞「动作包含未声明字段」。已登记待问。
        st_f, b_f = t.action(c, 'files.formal_value_write', {
            'table': RT, 'row_id': rid, 'values': {'amount': 777.5}}, 'rt-formal')
        check('RT-② ① 改**金额**（晋升列）走正式值通道被接受',
              st_f == 200 and result_of(st_f, b_f).get('ok') is not False,
              'HTTP %s %s' % (st_f, str(b_f)[:110]))

        # 备注（普通列）→ 走普通格保存
        cv2, sv2 = versions(RT)
        st_n, b_n = t.action(c, 'files.cell_write', {
            'table': RT, 'row_id': rid, 'header': '备注', 'value': {'type': 'text', 'value': '改过的备注'},
            'expected_content_version': cv2, 'expected_structure_version': sv2}, 'rt-note')
        check('RT-② ② 改**备注**（普通列）走普通格保存被接受',
              st_n == 200 and result_of(st_n, b_n).get('ok') is not False,
              'HTTP %s %s' % (st_n, str(b_n)[:110]))

        cells, src = _cells_of(RT, rid)
        check('RT-② ③ 合并读：金额取数据库新值 777.5（不是表里旧值）',
              (cells.get('金额') or {}).get('value') in (777.5, '777.5'),
              '金额=%r source=%r' % (cells.get('金额'), src))
        check('RT-② ④ 合并读：备注取表里的新值',
              (cells.get('备注') or {}).get('value') == '改过的备注',
              '备注=%r' % (cells.get('备注'),))

        raw2, why2 = _xlsx_of(RT)
        w2 = _widths(raw2)
        check('RT-② ⑤ **两处格式都在**：改完值列宽仍 A=30 / B=18 / E=34',
              w2 == WIDTHS0, '实测=%r（%s）' % (w2, why2[:60]))
        check('RT-② ⑥ **前导零没被当数字改掉**（00123 仍是 00123）',
              str(_cell_text(raw2, 2, 1)) == '00123', 'A2=%r' % _cell_text(raw2, 2, 1))
        note_in_bytes = (str(_cell_text(raw2, 2, 5) or '') == '改过的备注')
        check('RT-② ⑦ 普通列的新值也落进了原表字节',
              note_in_bytes, 'E2=%r' % _cell_text(raw2, 2, 5))

        # ---- RT-③ 新增普通列不建 DB 字段 ----
        # **加列前先记一份定义基线** —— ① 要验「名单多了、数据库字段数没变」，
        # 不先记基线就只能看「现在多不多」，看不出**变化**（空过长得跟过一模一样）。
        st_b3, b_b3 = t.service(c, 'files.promotion_definition', {'table': RT})
        cols_before3 = (result_of(st_b3, b_b3).get('columns') or [])
        n_cols_before3 = len([x for x in cols_before3 if isinstance(x, dict)])
        n_promo_before3 = len([x for x in cols_before3
                               if isinstance(x, dict) and x.get('promoted')])
        try:
            from shangshu_core.public_api import query_object_records  # noqa
        except Exception:
            pass
        st_c3, b_c3 = t.action(c, 'files.sheet_column_append', {
            'table': RT, 'header': '新增普通列',
            'expected_content_version': versions(RT)[0],
            'expected_structure_version': versions(RT)[1]}, 'rt-addcol')
        check('RT-③ ① 新增普通列被接受',
              st_c3 == 200 and result_of(st_c3, b_c3).get('ok') is not False,
              'HTTP %s %s' % (st_c3, str(b_c3)[:110]))
        # ⚠️ **第一版在这儿断言错了，记下来**：我断「新列要在晋升定义里、且是普通列」——
        # 但 E 的要求是「**数据库不自动新增字段**」，**没说定义要自动扩**。
        # 实测：`files.sheet_column_append` **不改晋升定义**（`columns` 仍是原来 5 列），
        # 且 `structure_version` 2 vs `bound_structure_version` 1 → **`binding_current: false`**。
        # 所以 ②③ 改成验**需求真的说的那件事**：新列走**普通格通道**、不碰数据库。
        st_rd3, b_rd3 = t.service(c, 'files.promotion_definition', {'table': RT})
        res3 = result_of(st_rd3, b_rd3)
        cols3 = res3.get('columns') or []
        new_col = [x for x in cols3 if isinstance(x, dict) and x.get('header') == '新增普通列']

        # 新列填个值 → 走普通格通道
        cv3, sv3 = versions(RT)
        rid3 = (result_of(*t.service(c, 'files.sheet_read', {'table': RT})).get('rows') or [{}])[0].get('row_id')
        st_w3, b_w3 = t.action(c, 'files.cell_write', {
            'table': RT, 'row_id': rid3, 'header': '新增普通列',
            'value': {'type': 'text', 'value': '新列的值'},
            'expected_content_version': cv3, 'expected_structure_version': sv3}, 'rt-newcol')
        check('RT-③ ② 新列能按**普通格**填值（走表那侧，不是数据库）',
              st_w3 == 200 and result_of(st_w3, b_w3).get('ok') is not False,
              'HTTP %s %s' % (st_w3, str(b_w3)[:110]))
        cells3, src3 = _cells_of(RT, rid3)
        check('RT-③ ③ **数据库不自动新增字段**：新列的值来源是 `sheet` 不是 `database`'
              '（晋升列才来自 database）',
              (src3.get('新增普通列') == 'sheet'
               and all(src3.get(h) != 'database' for h in ('名称', '客户', '备注'))),
              'source=%r' % src3)

        # ---- ① 加列后**新列不进**晋升定义（用户 2026-10-15 最新口径）----
        # ⚠️ **这块口径翻转过一次，记下来免得下一个人照旧断言改回去**：
        #   · 上午：用户「选 A」= 新列自动进定义、标 `promoted: false`（提交 `45b04957`）
        #   · 现在：用户原话「**不改，理论上新加的列就是 xlsx 里面的列，
        #     不是有意义的字段，只在 xlsx 上体现**」→ 新列**不进**定义。
        # **为什么不留 `promoted:false` 占位**：这个口回答的是
        # 「**哪些列是数据库字段**」。普通列本来就不是字段，不列就是了。
        # 早先那个理由（「名单少一列、读的人分不清是漏了还是真没有」）是
        # 把「定义」当成了「**表头全集**」—— 当成**字段清单**就没这歧义了。
        # **要看表头全集走 `files.sheet_read` 的 `headers`，不是这里。**
        #
        # ⚠️ **不许只拿「不在定义里」判过** —— 那分不清「定义不收它」和
        # 「列根本没加上」。所以配一条对照：`sheet_read` 的表头**确实有**这一列。
        hdrs3 = result_of(*t.service(c, 'files.sheet_read', {'table': RT})).get('headers') or []
        n_fields3 = len([x for x in cols3 if isinstance(x, dict) and x.get('field')])
        check('RT-③ ④ ① 加列后 **`columns` 里没有新列**（新列不是有意义的字段，不进定义）',
              not new_col, 'new_col=%r cols3.headers=%r'
              % (new_col, [x.get('header') for x in cols3 if isinstance(x, dict)]))
        check('RT-③ ④ ② **对照**：新列确实加在表上了（`sheet_read` 表头里有它）——'
              ' 证明是「定义不收它」，不是「列没加上」',
              '新增普通列' in hdrs3, '表头=%r' % (hdrs3,))
        check('RT-③ ④ ③ 名单**长度一个没变**（加列不扩定义）',
              len(cols3) == n_cols_before3,
              '加列前=%d 加列后=%d' % (n_cols_before3, len(cols3)))
        # ⚠️ **只比「加列前就有的列」** —— 正确语义：加列前存在的每一列，标记一字不变。
        before_by_header3 = {x.get('header'): bool(x.get('promoted'))
                             for x in cols_before3 if isinstance(x, dict)}
        carried3 = [x for x in cols3 if isinstance(x, dict) and x.get('header') in before_by_header3]
        same_flags3 = all(bool(x.get('promoted')) == before_by_header3[x.get('header')]
                          for x in carried3)
        check('RT-③ ④ ④ 原有列的晋升标记和数量一个不动',
              len(carried3) == n_cols_before3 and same_flags3
              and len([x for x in cols3 if isinstance(x, dict) and x.get('promoted')]) == n_promo_before3,
              '加列前晋升=%d 加列后晋升=%r 承接列=%d/%d 标记一致=%r'
              % (n_promo_before3,
                 [x.get('header') for x in cols3 if isinstance(x, dict) and x.get('promoted')],
                 len(carried3), n_cols_before3, same_flags3))
        check('RT-③ ④ ⑤ **数据库字段数一个没多**（加列不建字段）',
              n_fields3 == n_promo_before3,
              '加列前晋升=%d 加列后字段数=%d' % (n_promo_before3, n_fields3))
        # 判别式：「在不在定义」与「在不在表头」必须给**两种不同答案** ——
        # 恒同就说明判据分不清「定义不收它」和「列没加上」，白判。
        ans1 = {'新列不在定义里': not new_col, '新列在表头上': '新增普通列' in hdrs3}
        check('RT-③ ④ ⑤ 敏感度·判别式：「在不在定义」与「在不在表头」给**两种不同答案**（不恒同）',
              len(set(ans1.values())) == 2, '结论=%r 表头=%r' % (ans1, hdrs3))

        # **只登记不判对错**：`binding_current` 翻假这件事归 ②（绑 ID 不绑名称），
        # 契约面是 B 的，我按接口适配、不在这儿拍它该不该跟着回真。
        print('  [登记·不判] binding_current=%r bound_sv=%r cur_sv=%r —— '
              '自动扩后该不该跟着回真，等 B 的契约面（②）'
              % (res3.get('binding_current'), res3.get('bound_structure_version'),
                 res3.get('structure_version')))
        raw3, why3 = _xlsx_of(RT)
        w3 = _widths(raw3)
        check('RT-③ ⑤ **加列不碰原表格式**：原有列宽 A/B/E 一字不差',
              w3 and all(w3.get(k) == v for k, v in WIDTHS0.items()),
              '实测=%r（%s）' % (w3, why3[:60]))
        check('RT-③ ⑥ **加列不碰原有内容**：前导零与长编号都还在',
              str(_cell_text(raw3, 2, 1)) == '00123'
              and str(_cell_text(raw3, 3, 1)) == 'ZZ2026EXCELFIRSTBATCH0000042',
              'A2=%r A3=%r' % (_cell_text(raw3, 2, 1), _cell_text(raw3, 3, 1)))

        # ---- RT-④ 导出=最新 ----
        raw4, why4 = _xlsx_of(RT)
        got_amount = _cell_text(raw4, 2, 4)
        check('RT-④ ① **导出的字节含最新值**（金额那格是 777.5，不是上传时的 1234.56）',
              raw4 is not None and str(got_amount) in ('777.5', '777.50'),
              'D2=%r（%s）' % (got_amount, why4[:60]))
        check('RT-④ ② 导出里普通列的新值也在',
              raw4 is not None and str(_cell_text(raw4, 2, 5) or '') == '改过的备注',
              'E2=%r' % _cell_text(raw4, 2, 5))

        # ---- RT-④ ③ 反例：回填没完成时不得拿旧字节冒充最新 ----
        # **测试通过 = 下面每条成立**（契约 `执行计划.md:283`「单独DB动作成功但文件失败时
        # 如实待恢复且不导出旧文件」；`开发计划.md:191`「旧文件不能假装最新下载」）：
        #   ① 正常写一次正式值，回填**成功**，导出拿到新值 —— 「回填成了」那一半的对照基础
        #   ② 装断点再写 → 回执必须是**失败**（不许骗成功），错因点名「回填失败/待恢复」
        #   ③ **DB 那份留住了**（「单独DB动作成功」）：读路径认新值，**文件字节还是旧的**
        #   ④ **导出不得给旧文件冒充最新** —— 被拒，错因点名「回填未完成/待恢复」
        #   ⑤ 卸断点重试 → 回填成功、待恢复清掉（契约「文件失败可恢复」）
        #   ⑥ **对照**：恢复后导出照常过、字节是最新值 —— 证明卡的是「回填失败」，不是「导出全坏」
        #   ⑦ **敏感度两问**：两半都成立 **且**「回填成没成」给两种不同答案
        #   ⑧ **裸 URL 也过内容闸**：原先裸 `file-content` URL 绕过 `files.versions`
        #      直接拿字节（2026-10-15 当场坐实过「缺口」）。现在内核半
        #      （`field_access.check_content_ready`）+ 域内钩子（`promotion.content_gate`）
        #      都装上了，**裸 URL 同样被拒**。完整一组判据（含「旧版本不误伤」）
        #      见 `test_rt43_content_gate.py`，这条只钉链路上这一点。
        print('\n   ---- RT-④ ③ 故障注入：回填失败不得导出旧文件冒充最新 ----')
        _sf = _ss_fault   # 顶部 importlib 加载的那份（公共工具只此一份）
        _compose = _sf.compose_of(BASE)

        def _rt3_export_ok(tid):
            """导出这条路走通没 —— 回 ``(拿到字节没, 说明)``。走的是 `_xlsx_of` 同一条路。"""
            raw, why = _xlsx_of(tid)
            return (raw is not None), why

        # ---- ① 回填成了：正常写 + 导出拿到新值（对照基础）----
        st_n, b_n = t.action(c, 'files.formal_value_write', {
            'table': RT, 'row_id': rid, 'values': {'amount': 888.25}}, 'rt43-ok')
        check('RT-④ ③ ① 前置·回填成：正常写正式值被接受',
              st_n == 200 and result_of(st_n, b_n).get('ok') is not False,
              'HTTP %s %s' % (st_n, str(b_n)[:110]))
        raw_n, why_n = _xlsx_of(RT)
        check('RT-④ ③ ① 回填成：导出字节里那格是新值 888.25',
              raw_n is not None and str(_cell_text(raw_n, 2, 4)) in ('888.25', '888.250'),
              'D2=%r（%s）' % (_cell_text(raw_n, 2, 4), why_n[:60]))
        # **先把下载 ref 记下来** —— 待恢复之后 `files.versions` 会拒（闸生效），
        # 那时要验「文件字节是不是旧的」只能拿**先前记下的 ref** 走裸下载口。
        # 这同时把 ⑧ 那个缺口从「未测」变成**当场坐实**。
        REF_RT, why_ref = _ref_of(RT)
        check('RT-④ ③ ① 前置：记下下载 ref（后面裸下载要用）',
              bool(REF_RT), 'ref=%r %s' % (REF_RT, why_ref[:60]))

        # ---- ②③④ 半截状态：DB 成、回填败 ----
        armed, why_arm = _sf.arm(_compose, 'file-write')
        check('RT-④ ③ ② 前置：断点装上了（装不上后面的结论不可信）',
              armed, why_arm)
        st_f, b_f = (None, None)
        res_f = {}
        try:
            st_f, b_f = t.action(c, 'files.formal_value_write', {
                'table': RT, 'row_id': rid, 'values': {'amount': 999.75}}, 'rt43-fail')
            res_f = result_of(st_f, b_f) or {}
        finally:
            _sf.clear(_compose)
        # ⚠️ **回执不是「失败」，是「如实说两半各成没成」** ——
        # 平台不许域内自行提交（`domain_execution` 的 `before_commit` 钩子），
        # 抛异常 = 整单回滚 = 用户改的值静默丢失。所以回填失败**回 200 + `pending:true`**，
        # 骗人的不是 200，是**把回填报成成功**。这两条钉的就是「不许报成成功」。
        check('RT-④ ③ ② 回执**如实说回填没成**（`sheet_written` 是假，不是真）',
              st_f == 200 and res_f.get('sheet_written') is False and res_f.get('pending') is True,
              'HTTP %s sheet_written=%r pending=%r' % (st_f, res_f.get('sheet_written'),
                                                       res_f.get('pending')))
        msg_f = str(res_f.get('message') or res_f.get('writeback_error') or '')
        check('RT-④ ③ ② 回执点名「回填失败/待恢复」+ 说清导出暂不可用（不是泛泛「保存失败」）',
              ('回填' in msg_f or '回写' in msg_f) and ('待恢复' in msg_f or '导出' in msg_f),
              '回执=%r' % (msg_f[:150],))

        cells_f, src_f = _cells_of(RT, rid)
        amt_f = (cells_f.get('金额') or {}).get('value')
        check('RT-④ ③ ③ **DB 那份留住了**（单独DB动作成功）：读路径认新值 999.75',
              src_f.get('金额') == 'database' and str(amt_f) in ('999.75', '999.75'),
              'source=%r value=%r' % (src_f.get('金额'), amt_f))
        # **文件那份没被写成 999.75** —— 证据两条，**都不靠偷看字节**：
        #   (a) ② 的回执自己说 `sheet_written: False`（产品自己说没写进文件）
        #   (b) 待恢复期间**文件字节根本拿不到**（下面 ④ 正门拒 + ⑧ 裸口拒）
        # ⚠️ **原先这条靠裸下载看旧字节**。内容闸（B 的内核半 + D 的域内钩子）装上后，
        # 待恢复期间拿**当前那份**的字节会被拒 —— **这正是契约要的**（旧字节不该流出来），
        # 所以「看见旧字节」这条路**没有了**，不是测试坏了。改成上面两条之后，
        # ③/⑧ 不再争同一条观测路径（原先 ③ 要裸下载通、⑧ 要裸下载断，互相打架）。
        # ⚠️ **不下「这就是半截状态」的结论** —— 那是总结行，由 ③a + 本条合读得出
        # （§13 第 9 条：总结行不许写死结论）。单看本条 PASS 是**误导**：
        # 整单回滚时它也 PASS（DB 也是旧的、字节也拿不到），但那不是半截。
        st_raw, b_raw = t.download(c, RT, REF_RT)
        got_raw_f, raw_f = _got_bytes(st_raw, b_raw)
        check('RT-④ ③ ③ 而**文件那份没被写成 999.75**（回执说 sheet_written=False，'
              '且待恢复期间字节拿不到）—— 与上一条合读才叫「半截」',
              (res_f.get('sheet_written') is False) and not got_raw_f,
              'sheet_written=%r / 裸下载 HTTP %s 拿到内容=%s'
              % (res_f.get('sheet_written'), st_raw, got_raw_f))

        # ---- ④ 导出不得给旧文件冒充最新 ----
        got4, why4 = _rt3_export_ok(RT)
        err4 = why4 or ''
        check('RT-④ ③ ④ **导出被拒**（不许拿旧字节冒充最新）',
              got4 is False, '拿到字节=%r 说明=%r' % (got4, err4[:150]))
        check('RT-④ ③ ④ 拒因点名「回填未完成/待恢复」，说清为什么不能给',
              ('回填' in err4) or ('待恢复' in err4),
              '说明=%r' % (err4[:150],))

        # ---- ⑤⑥ 卸断点重试 → 可恢复；对照：恢复后导出照常 ----
        st_r, b_r = t.action(c, 'files.formal_value_write', {
            'table': RT, 'row_id': rid, 'values': {'amount': 777.5}}, 'rt43-recover')
        check('RT-④ ③ ⑤ 卸断点重试 → 回填成功（契约「文件失败可恢复」）',
              st_r == 200 and result_of(st_r, b_r).get('ok') is not False,
              'HTTP %s %s' % (st_r, str(b_r)[:110]))
        raw_r, why_r = _xlsx_of(RT)
        check('RT-④ ③ ⑥ **对照**：恢复后导出照常过、字节是最新值',
              raw_r is not None and str(_cell_text(raw_r, 2, 4)) in ('777.5', '777.50'),
              'D2=%r（%s）' % (_cell_text(raw_r, 2, 4), why_r[:60]))

        # ---- ⑦ 敏感度两问 ----
        v43 = {'回填成的那次导出给新值': raw_n is not None,
               '回填失败的那次导出被拒': got4 is False}
        check('RT-④ ③ ⑦ 敏感度·两半：回填成给新值 **且** 回填失败被拒（两个都该为真）',
              all(v43.values()), '结论=%r' % v43)
        ans43 = {'回填成': raw_n is not None, '回填没成': got4 is True}
        check('RT-④ ③ ⑦ 敏感度·判别式：「回填成没成」给**两种不同答案**（不恒真/恒假）',
              len(set(ans43.values())) == 2, '导出成不成=%r' % ans43)

        # ---- ⑧ 裸 URL：内核内容闸补上后，这里应当**拒** ----
        # 导出口在内核（`shangshu_core/public_api/http.py` 的 `file_content`），原先只查
        # 权限和挂载，**不知道「这份内容是不是最新」** —— 挡得住走正门的，挡不住拿着
        # ref 直接打裸 URL 的（2026-10-15 当场坐实过）。现在内核那半（`field_access.
        # check_content_ready`）+ 域内钩子（`promotion.content_gate`）都装上了，
        # **裸 URL 也过一道**。这条从「按挡验收」变成「验它真挡住了」。
        # ⚠️ **两道闸都留**（D 钉的）：内核是兜底，**不许**因此删掉文件域那道（④）。
        # 判据在 RT-4-3-K ①～⑤ 有完整一组（含「旧版本不误伤」），这条只钉链路上这一点。
        check('RT-④ ③ ⑧ 裸 file-content URL **拿不到**当前那份（内核内容闸生效）',
              not got_raw_f,
              # 详情**只写事实，不写结论**（§13 第 9 条）—— 这串无论过不过都印，
              # 写死「没挡住/漏出去」会在 PASS 时也印出来，看着像失败。
              '裸下载 HTTP %s 拿到内容=%s（回包 %d 字节）'
              % (st_raw, got_raw_f, len(raw_f or b'')))

        # ---- RT-⑤ 敏感度两问 ----
        vrt = {'real_format_kept': w2 == WIDTHS0, 'amount_new': str(got_amount) in ('777.5', '777.50')}
        check('RT-⑤ 敏感度·两半：格式保住了 **且** 值跟上了（两个都该为真）',
              all(vrt.values()), '结论=%r' % vrt)
        acc_rt = {'格式保住': vrt['real_format_kept'], '值跟上': vrt['amount_new']}
        check('RT-⑤ 敏感度·判别式：「格式在不在」「值新不新」两问给出**两种不同答案**的形状',
              len(set(acc_rt.values())) == 2 or all(acc_rt.values()),
              '结论=%r' % acc_rt)


# ==================== 普通员工改晋升列走没走 DB 校验（用户 2026-10-15 ④）====================
# **用户口径**：「只有管理员能晋升，普通员工有权限可以改值，**晋升列要过校验**」。
#
# **测试通过 =** 下面每条成立：
#   ① 普通员工改**晋升列** → 回包 `routed` 是 **`database`**（真走了 DB 规则那条）
#   ② 普通员工喂**非法值**（金额喂负数，定义里 `min: 0`）→ **被 DB 规则当场拒**，
#      且没写进去（证明校验真跑了，不是走过场）
#   ③ **对照**：普通员工改**普通列** → `routed` 是 **`sheet`**（两条路分流对）
#   ④ **对照**：管理员改同一晋升列 → 也是 `database`（**不因角色换路**）
#   ⑤ 普通员工**不能晋升**（`files.promotion_define` 是 System Manager 的活）—— 当场拒
#   ⑥ **敏感度两问**
#
# ⚠️ **判「走没走 DB 校验」只认回包 `routed` 的实际值**（E 2026-10-15 纠正，A 已同改 `371b41ae`）：
#   `database` = 真走了 DB 规则（`promotion.py` 晋升分支）；`sheet` = 走旧表保存。
#   **不认前端自己猜的字段**（A 那边先前读 `value_source` —— 后端根本没这个字段）。
if 'emp' in want:
    print('\n== 普通员工改晋升列走没走 DB 校验（只认回包 routed）==')
    import base64 as _b64e
    from io import BytesIO as _BIOe

    # —— 普通员工账号：D 运行面上的 `tester`。**人填归属**，落他自己 ——
    # 这样「他有权限改这张表」是天然成立的，不用额外授权。
    # 口令**不写进代码**（同 SS_D_PW 那条规矩）。取法两级：
    #   1) 环境变量 `SS_D_PW_TESTER`（手工跑想指定人时用）
    #   2) 回退 `_ss_cred.pw_for(BASE, 'TEST_USER_PASSWORD')` —— **公共件，只留一份**
    # ⚠️ **别拿 `pw_of`/`admin_pw_for` 凑**：那两个按键序取第一个命中，
    # env 里 `ADMIN_PASSWORD` 在前，会把管理员口令当 tester 的用 ——
    # 登录不是同一个人，后面整条都在测错人（实测栽过：前置就红在这）。
    emp = t.Client(BASE)
    EMP_USER = 'tester@example.invalid'
    EMP_PW = (os.environ.get('SS_D_PW_TESTER') or
              _ss_cred.pw_for(BASE, 'TEST_USER_PASSWORD') or '')
    try:
        if not EMP_PW:
            raise RuntimeError('取不到 tester 口令（SS_D_PW_TESTER 未设，'
                               '`_ss_cred.pw_for(BASE, "TEST_USER_PASSWORD")` 也空）')
        emp.login(EMP_USER, EMP_PW)
        emp_ok = True
        emp_err = ''
    except Exception as _e:
        emp_ok, emp_err = False, str(_e)[:120]
    check('D-emp 前置：普通员工（tester）登录得进（登不进后面全是空转）',
          emp_ok, '登录=%s %s' % (emp_ok, emp_err))

    def _emp_wb():
        wb = __import__('openpyxl').Workbook(); ws = wb.active
        ws.append(['编号', '金额', '备注'])
        ws.append(['E001', 123.5, '甲'])
        buf = _BIOe(); wb.save(buf)
        return _b64e.b64encode(buf.getvalue()).decode()

    EMP = None
    if emp_ok:
        st_e, b_e = t.action(emp, 'files.upload', {
            'file_name': 'D04员工表-%s.xlsx' % RUN, 'directory': '/',
            'content_base64': _emp_wb(),
            'attribution': {'level': 'personal'}}, 'emp-up')     # ← 人填，落本人
        EMP = result_of(st_e, b_e).get('file')
        check('D-emp 前置：普通员工建出**自己**的表（人填归属落本人）',
              st_e == 200 and bool(EMP), 'HTTP %s file=%r %s' % (st_e, EMP, str(b_e)[:100]))

    if EMP:
        # —— 管理员定晋升（用户：「只有管理员能晋升」）——
        st_d, b_d = t.service(c, 'files.promotion_definition', {'table': EMP})
        cur_e = result_of(st_d, b_d).get('structure_version')
        EMP_DEF = {'definition_version': 1, 'columns': [
            {'header': '编号', 'promoted': True, 'field': 'case_no', 'type': 'text'},
            {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
             'rules': {'min': 0}},
            {'header': '备注', 'promoted': False}]}
        st_pd, b_pd = t.action(c, 'files.promotion_define', {
            'table': EMP, 'expected_structure_version': cur_e,
            'definition': EMP_DEF}, 'emp-define')
        check('D-emp 前置：管理员定下晋升（金额/编号晋升、备注留普通）',
              st_pd == 200 and result_of(st_pd, b_pd).get('ok') is not False,
              'HTTP %s %s' % (st_pd, str(b_pd)[:110]))

        rid_e = (result_of(*t.service(c, 'files.sheet_read', {'table': EMP}))
                 .get('rows') or [{}])[0].get('row_id')
        cv_e, sv_e = versions(EMP)

        # —— ① 普通员工改晋升列 → routed 必须是 database ——
        st_1, b_1 = t.action(emp, 'files.cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '金额',
            'value': {'type': 'number', 'value': 55.5},
            'expected_content_version': cv_e, 'expected_structure_version': sv_e},
            'emp-promoted')
        r1 = result_of(st_1, b_1)
        check('D-emp ① 普通员工改**晋升列**（金额）→ `routed` 实际值是 `database`',
              st_1 == 200 and r1.get('routed') == 'database',
              'HTTP %s routed=%r（只认这个字段的实际值，不认前端猜的）' % (st_1, r1.get('routed')))
        check('D-emp ① 回执说清走了数据库那条（formal_written 是真）',
              r1.get('formal_written') is True,
              'formal_written=%r sheet_written=%r' % (r1.get('formal_written'), r1.get('sheet_written')))

        # —— ② 喂非法值 → DB 规则当场拒，且没写进去 ——
        cv_e2, sv_e2 = versions(EMP)
        cells_before, _src_before = _cells_of(EMP, rid_e)
        st_2, b_2 = t.action(emp, 'files.cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '金额',
            'value': {'type': 'number', 'value': -7},
            'expected_content_version': cv_e2, 'expected_structure_version': sv_e2},
            'emp-bad')
        err2 = str((b_2 or {}).get('error') or '') if isinstance(b_2, dict) else str(b_2)
        cells_after, _src_after = _cells_of(EMP, rid_e)
        # ⚠️ **不许把「被权限拒」当成「被规则拒」** —— 第一版只断言「被拒」，
        # 于是 403 也判过（**假绿**）。第二条当场戳穿了，但第一条本身得收严：
        # 必须是**规则**拒的，权限拒的不算数（那说明根本没走到校验）。
        check('D-emp ② 喂非法值（金额 -7，定义里 min:0）→ **被 DB 规则当场拒**',
              st_2 != 200 and ('规则' in err2 or 'min' in err2 or '小于' in err2 or '不能' in err2),
              'HTTP %s 错因=%r（被权限拒的不算 —— 那是没走到校验）' % (st_2, err2[:110]))
        check('D-emp ② 错因点名规则（不是别的旁因），证明校验真跑了',
              ('规则' in err2) or ('min' in err2) or ('小于' in err2) or ('不能' in err2),
              '错因=%r' % (err2[:130],))
        check('D-emp ② **没写进去**（值还是上一次那 55.5，不是被清空、也不是 -7）',
              str((cells_after.get('金额') or {}).get('value')) in ('55.5', '55.50'),
              '改前=%r 改后=%r' % ((cells_before.get('金额') or {}).get('value'),
                                  (cells_after.get('金额') or {}).get('value')))

        # —— ③ 对照：普通员工改普通列 → routed 是 sheet ——
        cv_e3, sv_e3 = versions(EMP)
        st_3, b_3 = t.action(emp, 'files.cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '备注',
            'value': {'type': 'text', 'value': '员工改的备注'},
            'expected_content_version': cv_e3, 'expected_structure_version': sv_e3},
            'emp-plain')
        r3 = result_of(st_3, b_3)
        check('D-emp ③ **对照**：普通员工改**普通列**（备注）→ `routed` 是 `sheet`',
              st_3 == 200 and r3.get('routed') == 'sheet',
              'HTTP %s routed=%r' % (st_3, r3.get('routed')))

        # —— ⑦ **绕过去那条**（E 点名：「别绕过去」）→ 用户 2026-10-15 拍「要修」——
        # 用户原话：「**当然要修，我的意思是普通员工可以改值，但是如果这个值对应的是一个字段，
        # 那就要过字段的检验**」。判据是「**这一格背后有没有数据库字段**」——
        # 不看谁改的、不看走哪个口。
        #
        # **改之前**：普通员工把「金额」（有字段、规则 `min:0`）改成 -7 → **进去了**，
        # 导出字节里就是 -7（本条先前红着，红就是答案）。
        # **改之后**：同一操作 → **当场被字段规则拒**，拒因说人话（点名「不能小于 0」），
        # **值不落库、不清空、不回写**。
        cv_e7, sv_e7 = versions(EMP)
        st_7, b_7 = t.action(emp, 'files.sheet_cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '金额',
            'value': {'type': 'number', 'value': -7},
            'expected_content_version': cv_e7, 'expected_structure_version': sv_e7},
            'emp-bypass')
        r7 = result_of(st_7, b_7)
        err7 = str((b_7 or {}).get('error') or '') if isinstance(b_7, dict) else str(b_7)
        # **判据一：当场被拒**（不是 200 后悄悄没生效）
        check('D-emp ⑦ 有字段的列喂非法值 → **当场拒**（不看走哪个口，`sheet_cell_write` 一样）',
              st_7 != 200, 'HTTP %s 错因=%r' % (st_7, err7[:130]))
        # **判据二：拒因点名规则**（说人话），不是被别的旁因拒（权限/版本/schema）
        check('D-emp ⑦ 拒因**点名字段规则**（「不能小于 0」这类），证明校验真跑了',
              ('不能小于' in err7) or ('小于' in err7 and '0' in err7),
              '错因=%r　← 若是权限/版本/字段类型错，那是错因通过，不算数' % err7[:130])
        # **判据三：字节里没有它**。
        # ⚠️ **必须真拿到字节才算观察到了** —— 拿不到时 `None not in ('-7')` 也会过，
        # 那是**假绿**（本条栽过两次：一次看合并读看不出来，一次拿不到字节也判过）。
        # ⚠️ **只看合并读是看不出绕过去的** —— 晋升列的值**优先取数据库**（D-b 的设计），
        # 表里被写成什么合并读都显示数据库那份。**要看文件字节** —— 那才是导出给人的那份。
        raw7, why7 = _xlsx_of(EMP, emp)   # **用本人下** —— 管理员下不了别人的个人表
        file_amt7 = _cell_text(raw7, 2, 2) if raw7 else None   # B 列 = 金额
        check('D-emp ⑦ 导出字节里**不出现**非法值（真拿到字节才算了观察到）',
              raw7 is not None and str(file_amt7) not in ('-7', '-7.0'),
              'HTTP %s 导出字节里金额=%r（字节=%s，%s）'
              % (st_7, file_amt7, '有' if raw7 else '没拿到', why7[:60] if why7 else ''))

        # —— ⑦b **对照**（⑦ 不空转的命根子）：普通列（没字段）照旧写得进 ——
        # 没这条，「怎么写都被拒」也能让 ⑦ 绿。
        cv_e7b, sv_e7b = versions(EMP)
        st_7b, b_7b = t.action(emp, 'files.sheet_cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '备注',
            'value': {'type': 'text', 'value': '普通列对照'},
            'expected_content_version': cv_e7b, 'expected_structure_version': sv_e7b},
            'emp-plain-ok')
        check('D-emp ⑦b **对照**：普通列（没字段）**照旧写得进** —— 校验不是一刀切',
              st_7b == 200, 'HTTP %s %s' % (st_7b, str(b_7b)[:110]))

        # —— ⑦c **批量口那个洞**（E 2026-10-15 核出：`_fast_write_cells` 里字段校验 0 次）——
        # **改之前**：一次写 2 格、其中「金额」= -7 → **快路径直接落盘**，导出里就是 -7。
        # 单格修了不等于批量修了 —— 「批量含非法值 → **整批一个字节不写**」。
        # 契约依据（`执行计划.md:47`）：「跨两类列的原子批量粘贴/撤回属于 009，
        # **未实现前明确拒绝**，不能循环单格冒充」—— 批量碰有字段的列，**明确拒**。
        cv_e7c, sv_e7c = versions(EMP)
        cells_before_7c, _s7c = _cells_of(EMP, rid_e)
        st_7c, b_7c = t.action(emp, 'files.sheet_cells_write', {
            'table': EMP, 'cells': [
                {'row_id': rid_e, 'header': '金额',
                 'value': {'type': 'number', 'value': -7}},          # ← 非法（min:0）
                {'row_id': rid_e, 'header': '备注',
                 'value': {'type': 'text', 'value': '不该落的备注'}}],  # ← 同批合法格
            'expected_content_version': cv_e7c, 'expected_structure_version': sv_e7c},
            'emp-batch-bad')
        err7c = str((b_7c or {}).get('error') or '') if isinstance(b_7c, dict) else str(b_7c)
        cells_after_7c, _t7c = _cells_of(EMP, rid_e)
        check('D-emp ⑦c **批量含非法值 → 整批被拒**（不是快路径直接落盘）',
              st_7c != 200, 'HTTP %s 错因=%r' % (st_7c, err7c[:150]))
        check('D-emp ⑦c **整批零生效**：同批那格合法的备注也**没写进去**',
              cells_after_7c == cells_before_7c,
              '改前=%r 改后=%r　← 若备注进去了，就是「部分写入」，契约明令禁止'
              % (str(cells_before_7c)[:70], str(cells_after_7c)[:70]))
        check('D-emp ⑦c 拒因**点名字段规则或 009 边界**（不是泛泛「失败」）',
              ('不能小于' in err7c) or ('009' in err7c) or ('批量' in err7c and '字段' in err7c),
              '错因=%r' % err7c[:150])

        # —— ⑦d **对照**（⑦c 不空转的命根子）：批量写**只有合法值**照旧成 ——
        # 没这条，「批量怎么写都被拒」也能让 ⑦c 绿。
        cv_e7d, sv_e7d = versions(EMP)
        st_7d, b_7d = t.action(emp, 'files.sheet_cells_write', {
            'table': EMP, 'cells': [
                {'row_id': rid_e, 'header': '备注',
                 'value': {'type': 'text', 'value': '批量对照'}}],
            'expected_content_version': cv_e7d, 'expected_structure_version': sv_e7d},
            'emp-batch-ok')
        check('D-emp ⑦d **对照**：批量写**只有没字段的列** → 照旧成',
              st_7d == 200, 'HTTP %s %s' % (st_7d, str(b_7d)[:110]))

        # —— ⑧ **写入不看身份**（E 的第 3 条验收点，「合成」的验收）——
        # 用户 2026-10-15：「要区分的是：**晋升字段这个动作和写入这个动作**」。
        # **晋升**（把列变成字段）只有管理员；**写入**（填格子）有写权就行。
        # 所以「往有字段的列里写值」**不该被晋升的权限拖累** ——
        # 普通员工和管理员做同一件事，**结果必须一模一样**。
        # ⑦b 已证普通员工改「备注」成；这里用管理员做**同一操作**比结果。
        cv_e8, sv_e8 = versions(EMP)
        st_8, b_8 = t.action(c, 'files.sheet_cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '备注',
            'value': {'type': 'text', 'value': '管理员同操作'},
            'expected_content_version': cv_e8, 'expected_structure_version': sv_e8},
            'emp-parity-ok')
        # 管理员写**别人的**表会被资源级闸拒（④ 已钉）——那不叫「写入看身份」，
        # 叫「写入看**资源权限**」。所以这条**用自己的表比**，比的是**同一权限下身份不同**。
        st_8b, b_8b = t.action(emp, 'files.sheet_cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '金额',
            'value': {'type': 'number', 'value': -7},
            'expected_content_version': versions(EMP)[0],
            'expected_structure_version': versions(EMP)[1]}, 'emp-parity-bad')
        # ⚠️ **两个口都得是同一个人**（`emp`）—— 第一版 `cell_write` 那次误用了管理员 `c`，
        # 比成了「普通员工的口 vs 管理员的口」，那是④（资源权限），不是⑧（写入不看身份）。
        st_8c, b_8c = t.action(emp, 'files.cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '金额',
            'value': {'type': 'number', 'value': -7},
            'expected_content_version': versions(EMP)[0],
            'expected_structure_version': versions(EMP)[1]}, 'emp-parity-bad-2')
        err8b = str((b_8b or {}).get('error') or '') if isinstance(b_8b, dict) else str(b_8b)
        err8c = str((b_8c or {}).get('error') or '') if isinstance(b_8c, dict) else str(b_8c)
        # ⚠️ **判据不许只看「都不是 200」**（第一版就这么写，**假绿**）：
        # 417（规则拒）和 403（权限拒）都「不是 200」，但**根本不是一回事** ——
        # 那正是合成要消掉的差别。要的是**同一个拒因**。
        def _rule_reject(code, err):
            # ⚠️ **括号不能省** —— `and` 比 `or` 紧，写成 `a and b or c` 会变成
            # `(a and b) or c`：err 里有「你打了」但 code 是 200 也判过。**会撒谎的判据。**
            return code != 200 and (('不能小于' in err) or ('你打了' in err))
        check('D-emp ⑧ **写入不看走哪个口**：两个口喂同一个非法值 → **同一个拒因**（都是字段规则）',
              _rule_reject(st_8b, err8b) and _rule_reject(st_8c, err8c),
              'sheet_cell_write HTTP %s 错因=%r ｜ cell_write HTTP %s 错因=%r'
              '　← 合成后不该有「一个规则拒、一个权限拒」的差别'
              % (st_8b, err8b[:70], st_8c, err8c[:70]))

        # —— ④ **两个闸口径统一**（E 2026-10-15：「顺手统一两个闸的口径」）——
        # **改之前**：管理员写**别人的**表时，闸 A（`check_permission('write')`，文档级）
        # 过了，写完正式值才在 `_writeback`→`sheet.write_cells` 撞上闸 B（资源级
        # 「只有上传人、资源归属人或获编辑共享的人可以修改文件」）→ **半截状态**
        # （`formal_written=True sheet_written=False pending=True`）。
        # **改之后**：两闸一起判、**判在动笔之前** → 当场拒，**数据库和表都不动**。
        cv_e4, sv_e4 = versions(EMP)
        st_4, b_4 = t.action(c, 'files.cell_write', {
            'table': EMP, 'row_id': rid_e, 'header': '金额',
            'value': {'type': 'number', 'value': 66.25},
            'expected_content_version': cv_e4, 'expected_structure_version': sv_e4},
            'emp-admin')
        r4 = result_of(st_4, b_4)
        err4 = str((b_4 or {}).get('error') or '') if isinstance(b_4, dict) else str(b_4)
        check('D-emp ④ 管理员写**别人的**个人表 → **当场拒**（资源级闸，判在动笔之前）',
              st_4 != 200, 'HTTP %s 错因=%r' % (st_4, err4[:130]))
        check('D-emp ④ 拒因点名「上传人/归属人/获编辑共享」（不是别的旁因）',
              ('上传人' in err4) or ('编辑共享' in err4),
              '错因=%r' % err4[:130])
        # **判在动笔之前 = 不该有半截**：这次回执都不该出现「库写了、表没写」。
        check('D-emp ④ **不落半截**：被拒时没有「formal_written=True 且 sheet_written=False」',
              not (r4.get('formal_written') is True and r4.get('sheet_written') is False),
              'formal_written=%r sheet_written=%r pending=%r'
              % (r4.get('formal_written'), r4.get('sheet_written'), r4.get('pending')))

        # —— ④b **对照**（④ 不空转的命根子）：管理员写**自己**的表照旧走 `database` ——
        # 没这条，「谁写都被拒」也能让 ④ 绿。要证明拒的是「**别人的**表」，
        # 不是「管理员不能写晋升列」。
        st_own, b_own = t.action(c, 'files.upload', {
            'file_name': 'D04管理员自己的表-%s.xlsx' % RUN, 'directory': '/',
            'content_base64': _emp_wb(), 'attribution': {'level': 'personal'}}, 'emp-admin-own')
        OWN = result_of(st_own, b_own).get('file')
        if OWN:
            st_od, b_od = t.service(c, 'files.promotion_definition', {'table': OWN})
            cur_own = result_of(st_od, b_od).get('structure_version')
            t.action(c, 'files.promotion_define', {
                'table': OWN, 'expected_structure_version': cur_own,
                'definition': EMP_DEF}, 'emp-admin-own-def')
            # ⚠️ **拿行 ID 走 `files.sheet_read`**（回 `rows[].row_id`），不是 `files.row_read` ——
            # 后者是**读合并行**（要传 row_id、回 `cells`），拿不到行清单。第一版写错成
            # `row_read` → `rid_own=None` → `cell_write` 因「row_id 必填」417，
            # **对照红在自己的 bug 上**，④ 就跟着空转。栽过。
            rid_own = (result_of(*t.service(c, 'files.sheet_read', {'table': OWN}))
                       .get('rows') or [{}])[0].get('row_id')
            cv_own, sv_own = versions(OWN)
            st_ow, b_ow = t.action(c, 'files.cell_write', {
                'table': OWN, 'row_id': rid_own, 'header': '金额',
                'value': {'type': 'number', 'value': 88.5},
                'expected_content_version': cv_own, 'expected_structure_version': sv_own},
                'emp-admin-own-write')
            row_ow = result_of(st_ow, b_ow)
            err_ow = str((b_ow or {}).get('error') or '') if isinstance(b_ow, dict) else str(b_ow)
            check('D-emp ④b **对照**：管理员写**自己**的晋升列 → `routed` 是 `database`'
                  '（拒的是「别人的表」，不是「不能写晋升列」）',
                  st_ow == 200 and row_ow.get('routed') == 'database',
                  'HTTP %s routed=%r pending=%r 错因=%r rid=%r'
                  % (st_ow, row_ow.get('routed'), row_ow.get('pending'),
                     err_ow[:110], rid_own))
        else:
            check('D-emp ④b **对照**：管理员建出自己的表（建不出则对照空转）',
                  False, 'HTTP %s %s' % (st_own, str(b_own)[:110]))

        # —— ⑤ 普通员工不能晋升 ——
        st_5, b_5 = t.action(emp, 'files.promotion_define', {
            'table': EMP, 'expected_structure_version': versions(EMP)[1],
            'definition': {'definition_version': 2, 'columns': [
                {'header': '编号', 'promoted': False}]}}, 'emp-promote')
        err5 = str((b_5 or {}).get('error') or '') if isinstance(b_5, dict) else str(b_5)
        check('D-emp ⑤ 普通员工**不能晋升**（定晋升是 System Manager 的活）→ 当场拒',
              st_5 != 200 or (isinstance(b_5, dict) and (b_5.get('ok') is False or 'error' in b_5)),
              'HTTP %s 错因=%r' % (st_5, err5[:110]))

        # —— ⑥ 敏感度两问 ——
        v_emp = {'晋升列走 database': r1.get('routed') == 'database',
                 '普通列走 sheet': r3.get('routed') == 'sheet'}
        check('D-emp ⑥ 敏感度·两半：晋升列走 database **且** 普通列走 sheet（两个都该为真）',
              all(v_emp.values()), '结论=%r' % v_emp)
        ans_emp = {'晋升列': r1.get('routed'), '普通列': r3.get('routed')}
        check('D-emp ⑥ 敏感度·判别式：「改的是哪类列」给**两种不同答案**（不恒同）',
              len(set(ans_emp.values())) == 2, 'routed=%r' % ans_emp)

print()

if checks == 0:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet and not fails:
    print('未测 %d 条（不算过）：' % len(not_yet))
    for _n in not_yet:
        print('  · ' + _n)
_names = {'da': 'D-a 晋升定义模型', 'db': 'D-b 读路径合并',
          'dc': 'D-c 写路径分流', 'dd': 'D-d 回写原表保格式',
          'rt': 'RT 真实表 004 链', 'emp': 'emp 普通员工改晋升列'}
_ran = '+'.join(_names[x] for x in want if x in _names)
# **总结行不写死结论**（§13 第 9 条）：跑过什么说什么，没跑的不写进结论。
if 'emp' in want:
    # **总结行不写死结论**（§13 第 9 条）：说判据主张什么、跑过哪些组，
    # **不冒充「N 条成立」** —— 那是下面 FAIL 清单的活。踩过：判据绿了之后
    # 总结行还写着旧的「①②③⑥ 仍红」，跟实际相反，等于假标。
    _tail = ('；**写入这条链的判据主张** —— 有字段的列必过字段规则（单格与批量都过）、'
             '两个口同一拒因、**写入不看身份**、**晋升仍看身份**、'
             '管理员写别人的表判在动笔之前不落半截。'
             '**不等于 004 通过**（页面腿未接线）')
elif 'rt' in want:
    _tail = ('；**真实表上后端链成立**，但**不等于 004 通过** —— '
             '页面腿前端对晋升四口零引用（整条没接线）、'
             '「真建数据库字段」契约那半未实现')
else:
    _tail = '；合成样本上成立，**不等于 004 通过**'
print('结果： ' + ('FAIL ' + ','.join(fails) if fails else
                  'PASS %s（%d 条%s）' % (_ran, checks, _tail)))
sys.exit(1 if fails else 0)
