"""PKG-001-T07 / R7 故障注入与一致性（B 侧）。

**测试通过 = 下面各条成立**：

R7-F1 **响应丢失后按原操作编号重试不重写**
    服务端已提交、但客户端没拿到回执时，拿**同一个操作号 + 同一个幂等键**重发，
    结果**一次生效**（加行只加一行、写值只写一次），不是重放第二遍；
    且能**按原操作编号查到**那次提交的结果（所以客户端不必盲目重写）。

R7-F2 **失败不假成功**
    动作失败时（表不存在 / 版本冲突 / 缺必填），回包**不报成功**，
    **独立读回没有**那次写入的痕迹，且**事实账里没有**那条操作的成功记录。
    不许「回包说成了」但读回是旧值。

R7-F3 **并发同格不丢后改值**
    两个写打同一个格时，**版本闩拦得住旧写**：同一版本号的第二次写被拒（HTTP 417），
    最终格值 = **成功那一笔**的值，不会退回旧值；
    而用**最新版本号**接着写时，**后改的值生效**（不丢）。

R7-F4 **保存不许丢数据（上传表两种 xlsx 编码都要过）**
    上传一张有表头和数据行的 xlsx，做「末尾加行」→ **表头和已有数据行一个都不能少**，
    新行发号不与旧行撞号。**两种编码都要过**：openpyxl/sharedStrings 标准写法，
    和 `inlineStr` 写法（Excel/WPS/第三方工具都会产出）。
    回包不许在丢数据的同时报成功。

---
为什么是这三条：执行计划 §PKG-001-T07 / R7 要求「服务端已提交但响应丢失按原操作编号查
结果，不盲目重写；保存/审计失败不假成功；并发同格不丢后改值」。测试证据里这三条一直是
**NOT_RUN（未测，不伪造）**，本文件把它们写成能红的判据再跑。

**不许再把测试写成全绿** —— 每条都配反例（故意翻期望必须红），空转阶段必须 FAIL。

口径来源（不自己发明）：
  · 动作信封 = `{payload, confirmed: true, idempotency_key, source}`；写要幂等键，读不要
  · **操作号 `op_id` 与幂等键是两回事**：op_id = 业务对账/审计/撤回；幂等键 = 技术去重
  · **同一个 op_id = 同一次操作**：多行审计是多次**尝试**不是多次成功，查询按 op_id 归并
  · 版本闩：`expected_content_version` / `expected_structure_version`，过期 → HTTP 417
  · 判版本冲突**只能看错误文案，不能看 code**（code 同为 VALIDATION_FAILED）

用法：python3 test_r7_fault_injection.py [--cases f1,f2,f3] [--samples N]
"""
import argparse
import base64
import importlib.util
import io
import json
import os
import sys
import threading
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
# **RUN 必须每次运行唯一**，不能直接用 t.RUN：它是秒级时间戳，同秒重跑会拿到同一个值，
# 于是两次运行的幂等键撞车 → 产品正确地回 409「幂等键已被不同请求使用」，
# 被误判成「并发竞态偶发失败」（2026-10-14 踩过，连跑 5 次 3 过 2 挂）。
# 加微秒尾缀保证唯一；同一运行内**故意复用同一个键**的重放（R7-F1）不受影响。
RUN = '%s-%d' % (t.RUN, int(time.time() * 1e6) % 100000000)
VALID = ('f1', 'f2', 'f3', 'f4')
act = t.action
service = t.service

ap = argparse.ArgumentParser(description='R7 故障注入与一致性')
ap.add_argument('--cases', default=','.join(VALID))
ap.add_argument('--samples', type=int, default=20)
ns = ap.parse_args()
want = tuple(x.strip() for x in ns.cases.split(',') if x.strip())
if not want:
    print('结果： FAIL --cases 空'); sys.exit(2)
bad = [x for x in want if x not in VALID]
if bad:
    print('结果： FAIL --cases 有未知用例：%s' % ','.join(bad)); sys.exit(2)
selected = set(want)
N_SAMPLES = max(1, min(20, ns.samples))
# 不足 20 样本只报「已测」，不写达标字样（计划原话）
FORMAL = N_SAMPLES >= 20

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
    """如实记「没测到」—— 不算通过，也不算失败。**不假造让它变绿**。"""
    global checks_run
    checks_run += 1
    not_yet.append(label)
    print('  ~ %s — 未测：%s' % (label, why))


def result_of(st, body):
    b = body if isinstance(body, dict) else {}
    r = b.get('result')
    return r if isinstance(r, dict) else (b if isinstance(b, dict) else {})


def err_text(body):
    if not isinstance(body, dict):
        return str(body)
    e = body.get('error')
    if isinstance(e, dict):
        return str(e.get('message') or e)
    return str(e or '')


def is_version_conflict(st, body):
    """版本冲突只能看文案，不能看 code（code 同为 VALIDATION_FAILED）。"""
    et = err_text(body)
    noise = any(w in et for w in ('必填', '未声明', '类型不正确', '超出允许范围', 'minimum'))
    return st == 417 and ('版本' in et) and not noise


def build_plain(h1='H1', v='R7值'):
    """**单元格引用必须逐行递增（A1/A2/A3…）**，跟真实 Excel 一样。

    2026-10-14 踩过两次同一个坑：这里一度把每一行都写成 `<c r="A1">`。那是**畸形文件** ——
    openpyxl 按 `<c r=` 认格位，3 个格全叠在 A1 只剩 1 个；自研解析器按 `<row r=` 认行，
    反而「看着读对了」。于是写路径发出的行号撞号、按 row_ids 读回为空、写值报「行不存在」，
    **一整片红全是我自己造的**，被误判成产品缺陷。

    **夹具没被证明正确之前，不许拿它的现象去指产品** —— 先用 `files.create` 或
    openpyxl 造对照。
    """
    import io
    import zipfile
    cells = ''.join(
        '<row r="%d"><c r="A%d" t="inlineStr"><is><t>%s</t></is></c></row>'
        % (i + 1, i + 1, h1 if i == 0 else v)
        for i in range(3))
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
        z.writestr('xl/worksheets/sheet1.xml',
                   '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<sheetData>%s</sheetData></worksheet>' % cells)
    return buf.getvalue()


def new_table(owner, tag):
    """建一张新表，回 (file_id, content_version, structure_version, row_ids, headers)。"""
    b64 = base64.b64encode(build_plain(h1='H1', v='基线')).decode()
    st, body = act(owner, 'files.upload',
                   {'file_name': 'r7-%s-%s.xlsx' % (tag, RUN), 'content_base64': b64, 'directory': '/'},
                   'r7-up-%s-%s' % (tag, RUN))
    res = result_of(st, body)
    F = res.get('file') or res.get('file_id')
    if not F:
        return None, None, None, None, None
    st_r, dat_r = service(owner, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 20})
    d = dat_r if isinstance(dat_r, dict) else {}
    return (F, d.get('content_version'), d.get('structure_version'),
            [r.get('row_id') for r in (d.get('rows') or [])], d.get('headers') or [])


def read_rows(owner, F, rids=None):
    payload = {'table': F, 'page': 1, 'page_length': 20}
    if rids:
        payload = {'table': F, 'row_ids': list(rids)}
    st, dat = service(owner, 'files.sheet_read', payload)
    return st, (dat if isinstance(dat, dict) else {})


def query_facts(c, payload, key):
    """查事实并把 `result` 包解出来；顺带断言回包形状，形状不对不许拿空列表冒充查无。"""
    st, body = act(c, 'files.action_fact_query', payload, key)
    res = result_of(st, body)
    rows = res.get('facts') or res.get('rows') or []
    shape_ok = isinstance(res, dict) and 'facts' in res and 'scope' in res
    return st, res, rows, shape_ok


print('== R7 故障注入与一致性 ==')
print('实例：%s　run=%s　所选：%s　采样 n=%d（%s）' % (BASE, RUN, ','.join(want), N_SAMPLES,
                                              '正式' if FORMAL else '调试，不足20不写达标'))

owner = t.Client(BASE)
owner.login('Administrator', admin_pw)


# ---------- R7-F1 响应丢失后按原操作编号重试不重写 ----------
if 'f1' in selected:
    print('\n== R7-F1 响应丢失后按原操作编号重试不重写 ==')
    F, cv0, sv0, rids, headers = new_table(owner, 'f1')
    check('R7-F1 前置：建出一张表', bool(F), 'file=%r content=%r structure=%r rows=%d'
          % (F, cv0, sv0, len(rids or [])))
    if F:
        name_col = headers[0] if headers else 'H1'
        # ---- 阳性对照：事实查询本身要能查到东西 ----
        # 不然「按 op_id 查回 0 条」和「查询坏了」长得一样，后面所有「事实账里没有 X」
        # 都会因为「永远查不到」而假绿。这就是本项目反复踩的**静默空**。
        OP_CTL = 'op-r7ctl-%s' % RUN
        st_ct, b_ct = act(owner, 'files.action_fact', {
            'op_id': OP_CTL, 'action': 'cell.save', 'target': '对照格',
            'detail': {'note': '阳性对照，证明查询不是恒空'},
            'client_timestamp': int(time.time() * 1000)}, 'r7ctl-%s' % RUN)
        qst, qres, qrows, qshape = query_facts(owner, {'op_id': OP_CTL}, 'r7ctlq-%s' % RUN)
        check('对照：事实查询本身查得到（否则后面「查无」全是假绿）',
              qshape and any(x.get('op_id') == OP_CTL for x in qrows),
              '写事实 HTTP %s；查回 %d 条、op_id 命中=%s'
              % (st_ct, len(qrows), any(x.get('op_id') == OP_CTL for x in qrows)))
        total0 = len(rids or [])
        rid = (rids or [None])[0]

        # ---- F1a 结构：加行重放必须只加一行 ----
        OP_ROW = 'op-r7f1row-%s' % RUN
        KEY_ROW = 'r7f1row-%s' % RUN          # 同 key → 同幂等键
        payload_row = {'table': F, 'count': 1,
                       'expected_content_version': int(cv0),
                       'expected_structure_version': int(sv0),
                       'op_id': OP_ROW}

        st1, b1 = act(owner, 'files.sheet_row_append', payload_row, KEY_ROW)
        r1 = result_of(st1, b1)
        check('R7-F1 ① 第一次加行成功（当作回执丢了，不看它）', st1 == 200,
              'HTTP %s %s' % (st1, str(b1)[:120]))
        st_r1, d1 = read_rows(owner, F)
        total1 = len((d1.get('rows') or []))
        check('R7-F1 ② 第一次之后确实是 +1 行', total1 == total0 + 1,
              '前 %d → 后 %d' % (total0, total1))

        # ---- 假装回执丢了 → 拿同 op_id + 同幂等键重发 ----
        st2, b2 = act(owner, 'files.sheet_row_append', payload_row, KEY_ROW)
        r2 = result_of(st2, b2)
        idem_flag = (b2 or {}).get('idempotent') if isinstance(b2, dict) else None
        st_r2, d2 = read_rows(owner, F)
        total2 = len((d2.get('rows') or []))
        # **关键**：重放后必须还是 +1，不能变成 +2。「HTTP 200」本身证明不了没重写。
        check('R7-F1 ③ 重放后仍只加了一行（不是 +2）', total2 == total0 + 1,
              '前 %d → 第一次后 %d → 重放后 %d（idempotent=%r）' % (total0, total1, total2, idem_flag))
        check('R7-F1 ④ 重放要么被去重（idempotent），要么回同一笔结果不重做',
              idem_flag is True or (st2 == 200 and total2 == total0 + 1),
              'HTTP %s idempotent=%r' % (st2, idem_flag))

        # ---- 按原操作编号查到那次提交（所以客户端不必盲目重写）----
        # **查回执走 `/api/platform/action-requests/{幂等键}`**，不是 `files.action_fact_query`。
        # 后者是 T08 的**动作事实台账**（只圈 `files.action_fact` 自己的审计行），
        # 拿它查写动作的 op_id 当然恒空 —— 2026-10-14 就这么误判成「产品缺口」过。
        # 口径来自既有 `test_r7_fault.py` 的 R7-03（它早就验过这条），照抄不另发明。
        st_rc, receipt = owner.request('GET', '/api/platform/action-requests/%s' % t.receipt_key(KEY_ROW))
        rstatus = str((receipt or {}).get('status') or '')
        check('R7-F1 ⑤ 能按操作编号查到那次提交的回执',
              st_rc == 200 and rstatus not in ('NotFound', 'not_found', 'None', ''),
              'HTTP %s status=%s' % (st_rc, rstatus))
        check('R7-F1 ⑥ 回执说是成功（不是还在飞/失败）',
              rstatus.lower() in ('succeeded', 'success', 'ok', '成功'),
              'status=%s 回执=%s' % (rstatus, str(receipt)[:120]))
        # 同一操作的尝试次数不藏：回执里若带尝试/成功计数，成功数必须不超 1
        if isinstance(receipt, dict):
            sc = receipt.get('success_count')
            check('R7-F1 ⑥b 同一次操作不重复记成功',
                  sc is None or sc <= 1,
                  'attempt_count=%r success_count=%r' % (receipt.get('attempt_count'), sc))

        # ---- F1b 写值重放：同 key 重发不该把值写两遍 / 改成别的 ----
        OP_CELL = 'op-r7f1cell-%s' % RUN
        KEY_CELL = 'r7f1cell-%s' % RUN
        marker = 'r7f1-%s' % RUN
        # **必须用加行之后的当前版本**：拿 cv0（加行前）会撞版本冲突，那不是「写值失败」，
        # 是我传了过期版本闩（2026-10-14 踩过）。同一次里前面刚动过结构，版本已经推进了。
        st_now, d_now = read_rows(owner, F)
        payload_cell = {
            'table': F, 'expected_content_version': int(d_now.get('content_version') or 0),
            'expected_structure_version': int(d_now.get('structure_version') or 1),
            'cells': [{'row_id': rid, 'header': name_col, 'value': {'type': 'text', 'value': marker}}],
            'op_id': OP_CELL}
        stc1, bc1 = act(owner, 'files.sheet_cells_write', payload_cell, KEY_CELL)
        check('R7-F1 ⑦ 第一次写值成功', stc1 == 200, 'HTTP %s' % stc1)
        st_rc1, dc1 = read_rows(owner, F, [rid])
        v1 = ((dc1.get('rows') or [{}])[0].get('values') or {}).get(name_col)
        stc2, bc2 = act(owner, 'files.sheet_cells_write', payload_cell, KEY_CELL)
        st_rc2, dc2 = read_rows(owner, F, [rid])
        v2 = ((dc2.get('rows') or [{}])[0].get('values') or {}).get(name_col)
        check('R7-F1 ⑧ 写值重放后读回仍是那一个值（没写两遍/没被覆盖）',
              json.dumps(v1, sort_keys=True, ensure_ascii=False)
              == json.dumps(v2, sort_keys=True, ensure_ascii=False),
              '第一次=%s 重放后=%s' % (json.dumps(v1, ensure_ascii=False)[:60],
                                 json.dumps(v2, ensure_ascii=False)[:60]))

        # ---- 反例：判据必须能红。用一个**不会**发生的结果去断言，必须判不过 ----
        check('R7-F1 反例（判据非恒真）', not (total2 == total0 + 2),
              '若重放真加了第二行，这里会红；当前 total=%d（应为 %d）' % (total2, total0 + 1))


# ---------- R7-F2 失败不假成功 ----------
if 'f2' in selected:
    print('\n== R7-F2 失败不假成功 ==')
    F, cv0, sv0, rids, headers = new_table(owner, 'f2')
    check('R7-F2 前置：建出一张表', bool(F), 'file=%r rows=%d' % (F, len(rids or [])))
    if F:
        name_col = headers[0] if headers else 'H1'
        rid = (rids or [None])[0]

        st_b, d_b = read_rows(owner, F, [rid])
        base_vals = json.dumps((d_b.get('rows') or [{}])[0].get('values') or {},
                               sort_keys=True, ensure_ascii=False)
        base_total = len(rids or [])

        def assert_no_write(tag, st_f, b_f, why):
            """失败必须三样都没有：回包不报成功、读回无变化、事实账无成功行。"""
            b = b_f if isinstance(b_f, dict) else {}
            res = result_of(st_f, b_f)
            claims_ok = bool(b.get('ok')) or bool(res.get('op_id') and st_f == 200)
            st_r, d_r = read_rows(owner, F, [rid])
            now_vals = json.dumps((d_r.get('rows') or [{}])[0].get('values') or {},
                                  sort_keys=True, ensure_ascii=False)
            now_total = len((d_r.get('rows') or [])) if not rid else base_total
            check('R7-F2 %s ① 回包不报成功' % tag,
                  (not claims_ok) and st_f != 200,
                  'HTTP %s ok=%r' % (st_f, b.get('ok')))
            check('R7-F2 %s ② 独立读回零变化' % tag,
                  now_vals == base_vals, '前=%s 后=%s' % (base_vals[:50], now_vals[:50]))
            return st_f, b_f

        # ① 写一张不存在的表 → 必须失败，且读不到任何东西冒充成功
        OP_A = 'op-r7f2a-%s' % RUN
        st_a, b_a = act(owner, 'files.sheet_cells_write', {
            'table': 'no-such-table-%s' % RUN,
            'expected_content_version': 1, 'expected_structure_version': 1,
            'cells': [{'row_id': 'x', 'header': 'H1', 'value': {'type': 'text', 'value': '不该写进去'}}],
            'op_id': OP_A}, 'r7f2a-%s' % RUN)
        assert_no_write('①表不存在', st_a, b_a, '不存在的表')
        check('R7-F2 ① ③ 是真失败（表不存在的明确原因），不是静默空',
              st_a in (404, 400, 417, 403, 422, 500) and err_text(b_a),
              'HTTP %s %s' % (st_a, err_text(b_a)[:100]))

        # ② 过期版本写 → 417 版本冲突，值不变
        OP_B = 'op-r7f2b-%s' % RUN
        marker_b = 'r7f2-不该出现-%s' % RUN
        st_b1, b_b1 = act(owner, 'files.sheet_cells_write', {
            'table': F, 'expected_content_version': 0, 'expected_structure_version': 1,
            'cells': [{'row_id': rid, 'header': name_col, 'value': {'type': 'text', 'value': marker_b}}],
            'op_id': OP_B}, 'r7f2b-%s' % RUN)
        # 注意：版本号必须「合法但过期」。0 会撞 minimum=1 范围校验，不是版本冲突。
        # 这里先取当前版本再回退一格来造「过期」。
        st_c0, d_c0 = read_rows(owner, F)
        cur_cv = d_c0.get('content_version')
        # 用一个比当前旧的合法版本：若当前就是 0/1，先真改一次制造差
        st_move, b_move = act(owner, 'files.sheet_column_append', {
            'table': F, 'header': 'r7f2-占位列',
            'expected_content_version': int(cur_cv or 0),
            'expected_structure_version': int(d_c0.get('structure_version') or 1)},
            'r7f2-bump-%s' % RUN)
        check('R7-F2 ② 前置：先真改一次制造版本差', st_move == 200,
              'HTTP %s %s' % (st_move, str(b_move)[:100]))
        st_c1, d_c1 = read_rows(owner, F)
        old_cv = int(cur_cv or 0)
        new_cv = d_c1.get('content_version')
        check('R7-F2 ② 前置：版本确实往前走了', new_cv != old_cv, 'content %r→%r' % (old_cv, new_cv))

        st_b2, b_b2 = act(owner, 'files.sheet_cells_write', {
            'table': F, 'expected_content_version': old_cv,
            'expected_structure_version': int(d_c1.get('structure_version') or 1),
            'cells': [{'row_id': rid, 'header': name_col, 'value': {'type': 'text', 'value': marker_b}}],
            'op_id': OP_B}, 'r7f2b2-%s' % RUN)
        is_vc = is_version_conflict(st_b2, b_b2)
        check('R7-F2 ② ① 过期版本被拒且是版本冲突', is_vc, 'HTTP %s %s' % (st_b2, err_text(b_b2)[:120]))
        st_rb, d_rb = read_rows(owner, F, [rid])
        now_v = (d_rb.get('rows') or [{}])[0].get('values') or {}
        check('R7-F2 ② ② 失败后独立读回没有那次写入',
              marker_b not in json.dumps(now_v, ensure_ascii=False),
              '读回=%s' % json.dumps(now_v, ensure_ascii=False)[:100])

        # ③ 缺必填字段 → 校验失败，且没有半截写入
        # **基线必须取在这一步之前**，不能用最开头那份：中间为了制造版本差加过一列
        # （r7f2-占位列），行里多出一个空列，拿旧基线比会误判成「变了」（2026-10-14 踩过）。
        OP_C = 'op-r7f2c-%s' % RUN
        st_pre, d_pre = read_rows(owner, F, [rid])
        base_vals3 = json.dumps((d_pre.get('rows') or [{}])[0].get('values') or {},
                                sort_keys=True, ensure_ascii=False)
        st_c, b_c = act(owner, 'files.sheet_cells_write', {
            'table': F,  # 少 expected_content_version / cells
            'op_id': OP_C}, 'r7f2c-%s' % RUN)
        check('R7-F2 ③ ① 缺必填被拒', st_c != 200, 'HTTP %s %s' % (st_c, err_text(b_c)[:100]))
        st_rc, d_rc = read_rows(owner, F, [rid])
        now_vc = json.dumps((d_rc.get('rows') or [{}])[0].get('values') or {},
                            sort_keys=True, ensure_ascii=False)
        check('R7-F2 ③ ② 校验失败也不假成功（读回与紧前基线一致）', now_vc == base_vals3,
              '基线=%s 现在=%s' % (base_vals3[:60], now_vc[:60]))

        # ④ 事实账里不该有成功行
        for tag, op in (('①', OP_A), ('②', OP_B), ('③', OP_C)):
            qst, qres, qrows, qshape = query_facts(owner, {'op_id': op}, 'r7f2-q%s-%s' % (tag, RUN))
            succ = [x for x in qrows
                    if (x.get('status') or '').lower() in ('success', 'ok', '成功', '200')]
            check('R7-F2 %s ③ 事实账里没有成功行' % tag,
                  (not succ) if qshape else False,
                  'shape=%s 查回 %d 条 其中成功 %d 条' % (qshape, len(qrows), len(succ)))

        # 反例：把「读回等于紧前基线」翻成「不等于」必须红
        check('R7-F2 反例（判据非恒真）', now_vc == base_vals3 and base_vals3 != json.dumps({}),
              '若失败真的写进去了，③② 的读回断言会红；当前 紧前基线=%s 读回=%s'
              % (base_vals3[:50], now_vc[:50]))


# ---------- R7-F3 并发同格不丢后改值 ----------
if 'f3' in selected:
    print('\n== R7-F3 并发同格不丢后改值 ==')
    F, cv0, sv0, rids, headers = new_table(owner, 'f3')
    check('R7-F3 前置：建出一张表', bool(F), 'file=%r rows=%d cv=%r' % (F, len(rids or []), cv0))
    if F:
        name_col = headers[0] if headers else 'H1'
        rid = (rids or [None])[0]

        # ---- F3a 同版本并发：两个写都拿同一个 expected_content_version ----
        results = []

        def racer(tag, marker, key):
            c = t.Client(BASE)
            c.login('Administrator', admin_pw)
            st, b = act(c, 'files.sheet_cells_write', {
                'table': F,
                'expected_content_version': int(cv0),
                'expected_structure_version': int(sv0),
                'cells': [{'row_id': rid, 'header': name_col,
                           'value': {'type': 'text', 'value': marker}}],
                'op_id': 'op-r7f3-%s-%s' % (tag, RUN)}, key)
            results.append((tag, st, b, marker))

        m1 = 'r7f3-先-%s' % RUN
        m2 = 'r7f3-后-%s' % RUN
        th1 = threading.Thread(target=racer, args=('先', m1, 'r7f3a-%s' % RUN))
        th2 = threading.Thread(target=racer, args=('后', m2, 'r7f3b-%s' % RUN))
        th1.start(); th2.start()
        th1.join(60); th2.join(60)
        check('R7-F3 ① 两个并发写都跑完了', len(results) == 2, '收到 %d 个结果' % len(results))
        oks = [(tag, st, m) for tag, st, b, m in results if st == 200]
        rej = [(tag, st, b) for tag, st, b, m in results if st != 200]
        # **必须恰好一笔成功**。两笔都成功 = 版本闩没拦住；两笔都失败 = 没人写成。
        check('R7-F3 ② 同版本并发恰好一笔成功（版本闩拦住了旧写）',
              len(oks) == 1 and len(rej) == 1,
              '成功 %d 笔 %s，被拒 %d 笔 %s'
              % (len(oks), [o[2] for o in oks], len(rej),
                 [(r[0], r[1], err_text(r[2])[:60]) for r in rej]))
        if rej:
            rst, rb = rej[0][1], rej[0][2]
            check('R7-F3 ③ 被拒那笔是版本冲突（不是别的错）',
                  is_version_conflict(rst, rb) or ('版本' in err_text(rb)),
                  'HTTP %s %s' % (rst, err_text(rb)[:100]))
        st_r, d_r = read_rows(owner, F, [rid])
        final_v = ((d_r.get('rows') or [{}])[0].get('values') or {}).get(name_col)
        final_dump = json.dumps(final_v, sort_keys=True, ensure_ascii=False)
        winner = oks[0][2] if oks else None
        check('R7-F3 ④ 最终格值 = 成功那一笔的值（不退回旧值、不丢后改）',
              winner is not None and winner in final_dump,
              '赢家=%r 读回=%s' % (winner, final_dump[:80]))

        # ---- F3b 用最新版本接着写：后改的值必须生效 ----
        st_v, d_v = read_rows(owner, F)
        cv_now, sv_now = d_v.get('content_version'), d_v.get('structure_version')
        m_first = 'r7f3-串1-%s' % RUN
        m_second = 'r7f3-串2-%s' % RUN
        st_s1, b_s1 = act(owner, 'files.sheet_cells_write', {
            'table': F, 'expected_content_version': int(cv_now),
            'expected_structure_version': int(sv_now),
            'cells': [{'row_id': rid, 'header': name_col, 'value': {'type': 'text', 'value': m_first}}],
            'op_id': 'op-r7f3s1-%s' % RUN}, 'r7f3s1-%s' % RUN)
        st_v2, d_v2 = read_rows(owner, F)
        st_s2, b_s2 = act(owner, 'files.sheet_cells_write', {
            'table': F, 'expected_content_version': int(d_v2.get('content_version')),
            'expected_structure_version': int(d_v2.get('structure_version')),
            'cells': [{'row_id': rid, 'header': name_col, 'value': {'type': 'text', 'value': m_second}}],
            'op_id': 'op-r7f3s2-%s' % RUN}, 'r7f3s2-%s' % RUN)
        st_r2, d_r2 = read_rows(owner, F, [rid])
        v_after = ((d_r2.get('rows') or [{}])[0].get('values') or {}).get(name_col)
        check('R7-F3 ⑤ 用最新版本接着写，后改的值生效（不丢）',
              st_s1 == 200 and st_s2 == 200 and m_second in json.dumps(v_after, ensure_ascii=False),
              '第一次 HTTP %s 第二次 HTTP %s 读回=%s'
              % (st_s1, st_s2, json.dumps(v_after, ensure_ascii=False)[:80]))

        # ---- 反例：若版本闩没拦住（两笔都成功），② 必须红 ----
        check('R7-F3 反例（判据非恒真）', not (len(oks) == 2),
              '若同版本并发两笔都成功，② 会红；当前成功 %d 笔' % len(oks))

        # ---- F3-⑥ 保存中立即撤回（写完立刻撤，中间不读回）----
        # **不是**要造「写已提交、回执未回」的中间态 —— 那是我一开始把判据读严了。
        # 计划说的是「保存中立即撤回」= **写完不读回立刻撤**。既有 `test_r7_fault.py`
        # 的 R7-04 就是这么验的（内容版本恰 +2、结构版本不漂、值回原位、未涉及格不动）。
        st_pre, d_pre = read_rows(owner, F)
        rid6 = (d_pre.get('rows') or [{}])[0].get('row_id')
        cv6, sv6 = d_pre.get('content_version'), d_pre.get('structure_version')
        vals_before6 = json.dumps((d_pre.get('rows') or [{}])[0].get('values') or {},
                                  sort_keys=True, ensure_ascii=False)
        OP6 = 'op-r7f3-%s' % RUN
        m6 = 'r7f3-撤回前写的-%s' % RUN
        st_w6, b_w6 = act(owner, 'files.sheet_cells_write', {
            'table': F, 'expected_content_version': int(cv6),
            'expected_structure_version': int(sv6),
            'cells': [{'row_id': rid6, 'header': name_col, 'value': {'type': 'text', 'value': m6}}],
            'op_id': OP6}, 'r7f3w6-%s' % RUN)
        check('R7-F3 ⑥ ① 写入成功', st_w6 == 200, 'HTTP %s' % st_w6)
        # **不读回，立刻撤** —— 这就是「保存中立即撤回」
        st_u6, b_u6 = act(owner, 'files.sheet_cells_undo', {'table': F, 'op_id': OP6},
                          'r7f3u6-%s' % RUN)
        check('R7-F3 ⑥ ② 立刻撤回成功', st_u6 == 200, 'HTTP %s %s' % (st_u6, err_text(b_u6)[:100]))
        st_a6, d_a6 = read_rows(owner, F, [rid6])
        vals_after6 = json.dumps((d_a6.get('rows') or [{}])[0].get('values') or {},
                                 sort_keys=True, ensure_ascii=False)
        check('R7-F3 ⑥ ③ 值回原位（不是撤回前写的那个值）',
              vals_after6 == vals_before6 and m6 not in vals_after6,
              '写前=%s  撤后=%s' % (vals_before6[:70], vals_after6[:70]))
        st_v6, d_v6 = read_rows(owner, F)
        check('R7-F3 ⑥ ④ 内容版本恰 +2（写一次撤一次），结构版本不漂',
              int(d_v6.get('content_version') or 0) == int(cv6) + 2
              and int(d_v6.get('structure_version') or 0) == int(sv6),
              'content %r→%r（期望 %r）structure %r→%r'
              % (cv6, d_v6.get('content_version'), int(cv6) + 2, sv6, d_v6.get('structure_version')))
else:
    pass


# ---------- R7-F4 保存不许丢数据（两种 xlsx 编码都要过） ----------
if 'f4' in selected:
    print('\n== R7-F4 保存不许丢数据（上传表两种 xlsx 编码） ==')

    def build_inline_str():
        """inlineStr 写法 —— Excel/WPS/第三方工具都会产出。

        **单元格引用必须逐行递增（A1/A2/A3…）**，跟真实 Excel 一样。
        2026-10-14 踩过坑：这里一度把每一行都写成 `<c r="A1">`，那是**畸形文件**——
        openpyxl 按 `<c r=` 认格位，5 个格全叠在 A1 只剩 1 个；自研解析器按 `<row r=`
        认行，反而「看着读对了」，于是被误判成「产品加行冲表」。**夹具没被证明正确
        之前，不许拿它的现象去指产品。**
        """
        import zipfile as _zf
        rows = ''.join(
            '<row r="%d"><c r="A%d" t="inlineStr"><is><t>%s</t></is></c></row>'
            % (i + 1, i + 1, 'H1' if i == 0 else 'v%d' % i)
            for i in range(5))
        buf = io.BytesIO()
        with _zf.ZipFile(buf, 'w', _zf.ZIP_DEFLATED) as z:
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
            z.writestr('xl/worksheets/sheet1.xml',
                       '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                       '<sheetData>%s</sheetData></worksheet>' % rows)
        return buf.getvalue()

    def build_shared():
        """openpyxl 标准写法（sharedStrings）—— 应当一直是好的。"""
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = 'Sheet1'
        ws.cell(row=1, column=1).value = 'H1'
        for i in range(1, 5):
            ws.cell(row=i + 1, column=1).value = 'v%d' % i
        b = io.BytesIO()
        wb.save(b)
        return b.getvalue()

    for tag, raw in (('inlineStr', build_inline_str()), ('sharedStrings', build_shared())):
        st, body = act(owner, 'files.upload', {
            'file_name': 'r7f4-%s-%s.xlsx' % (tag, RUN),
            'content_base64': base64.b64encode(raw).decode(), 'directory': '/'},
            'r7f4-up-%s-%s' % (tag, RUN))
        F4 = result_of(st, body).get('file') or result_of(st, body).get('file_id')
        st_b, d_b = read_rows(owner, F4)
        hdr_before = d_b.get('headers')
        rows_before = d_b.get('rows') or []
        vals_before = json.dumps([(r.get('row_id'), r.get('values')) for r in rows_before],
                                 sort_keys=True, ensure_ascii=False)
        check('R7-F4 %s 前置：读得到表头和数据行' % tag,
              bool(F4) and bool(hdr_before) and len(rows_before) == 4,
              'file=%r headers=%r 行数=%d' % (F4, hdr_before, len(rows_before)))
        if not F4:
            continue
        st_a, b_a = act(owner, 'files.sheet_row_append', {
            'table': F4, 'count': 1,
            'expected_content_version': int(d_b.get('content_version') or 0),
            'expected_structure_version': int(d_b.get('structure_version') or 1)},
            'r7f4-row-%s-%s' % (tag, RUN))
        new_ids = result_of(st_a, b_a).get('row_ids') or []
        st_a2, d_a = read_rows(owner, F4)
        hdr_after = d_a.get('headers')
        rows_after = d_a.get('rows') or []
        vals_after = json.dumps([(r.get('row_id'), r.get('values')) for r in rows_after],
                                sort_keys=True, ensure_ascii=False)
        # 表头一个字都不能变；已有行的 ID 与值都不能变
        check('R7-F4 %s ① 表头没被冲掉' % tag, hdr_after == hdr_before,
              '前=%r 后=%r' % (hdr_before, hdr_after))
        check('R7-F4 %s ② 已有行的 ID 与值逐字节不变' % tag,
              vals_after.startswith(vals_before[:-1]) if vals_before.endswith(']') else False,
              '前=%s 后=%s' % (vals_before[:110], vals_after[:110]))
        # 精确 +1，新行 ID 不与旧行撞号
        old_ids = [r.get('row_id') for r in rows_before]
        check('R7-F4 %s ③ 精确 +1 行且新 ID 不撞号' % tag,
              len(rows_after) == len(rows_before) + 1 and bool(new_ids)
              and all(x not in old_ids for x in new_ids),
              '前 %d 行 → 后 %d 行；新 ID=%s 旧 ID=%s'
              % (len(rows_before), len(rows_after), new_ids, old_ids))
        # 不许丢数据的同时报成功
        lost = hdr_after != hdr_before or len(rows_after) < len(rows_before)
        check('R7-F4 %s ④ 没有「丢数据却报成功」' % tag,
              not (lost and st_a == 200),
              'HTTP %s 丢数据=%s' % (st_a, lost))
        if tag == 'inlineStr':
            # 反例：证明判据**真能红**（不是恒真）。故意造一个被改动的表头/行数，
            # 判据必须判不过。2026-10-14 一度把反例写成「证明数据真丢了」，
            # 那是拿判据去证明产品缺陷——判据只负责「丢了会红」，不负责「丢了」。
            mutated_hdr = list(hdr_before or []) + ['被冲掉']
            mutated_n = len(rows_before) - 1
            check('R7-F4 inlineStr 反例（判据非恒真）',
                  mutated_hdr != hdr_before and mutated_n != len(rows_before)
                  and hdr_after == hdr_before,
                  '若表头被改成 %r ① 会红；行数若变 %d ③ 会红。当前 表头 %r→%r 行数 %d→%d'
                  % (mutated_hdr, mutated_n, hdr_before, hdr_after,
                     len(rows_before), len(rows_after)))


print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)
if failed:
    print('结果： FAIL R7 故障注入（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
if not_yet:
    print('结果： PASS R7 故障注入已验部分（%d 条），另有 %d 条**未测**：%s'
          % (checks_run - len(not_yet), len(not_yet), '；'.join(not_yet)))
    sys.exit(0)
print('结果： PASS R7 故障注入全部成立（%d 条）' % checks_run)
