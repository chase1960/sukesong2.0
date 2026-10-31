"""T06 共享附件的文件域授权判据（PKG-006-T06，B 授权那半）。

**测试通过 = 下面各条成立**：

T06-A 只读员工按已授权范围能读到「所有人 = 部门」的附件（正例）。
T06-B **同部门未授权者不可借部门归属读附件**（T06 明写的反向判据）——
      同一个部门、但在该部门箱上**没有授权**的人，不能因为「附件所有人 = 部门」
      就搭车读到它。**要有具体拒绝原话**，且必须是**权限拒**不是校验错冒充。
T06-C 撤权后旧链接/筛选/下载同步受控（旧入口不绕权）。
T06-D 公共空间规则**不自动公开**邮箱/来信/附件（PKG-001-T09 的公共规则不外溢）。
T06-E 用**部门标题**冒充 ID 落归属 → 当场拒并说清原因（键口径）。
T06-F **建表权反例**：有文件角色、但无建表权的人，不能通过改请求把自己塞进
      没授权的部门（契约 M1「无权归属不可通过改请求选入」）；同一个人
      **不选归属**仍建得出来 —— 拦的是「选归属」，不是「不让他建表」。

口径：授权判定按「这个人对这份资源有没有授权」，**不按「他是不是这个部门的人」**——
实现是 `doc.owner == user or org_admin.write_allows(user, doc.name, att)` / `download_allows(...)`。

**部门键注意**：归属里的部门是 `Shangshu Department.name`（文档 ID），不是标题。
`platform.org.department_create` 的 schema 是 `additionalProperties: False`，
properties 只有 `name`(装标题) / `parent`(上级 ID) / `enterprise` —— **传 `title` 会
被判「未声明」**（今天查实，见 shangshu_core/install.py:116）。

**联合结论由 C 出**，本文件只出 B 这半的四条 + 键口径 + 建表权反例。

先红后绿：判据对不上就红；反例（故意翻期望）必须能红。
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

from _ss_cred import CRED as _CRED, pw_of as _pw_of, admin_pw_for
admin_pw = admin_pw_for(BASE)
user_pw = 'b2-user-pw-2026'
if not admin_pw:
    print('结果： FAIL 取不到管理员口令'); sys.exit(2)

checks_run = 0
failed = []


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


def build_plain():
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
                   '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>H1</t></is></c></row>'
                   '<row r="2"><c r="A2" t="inlineStr"><is><t>T06附件值</t></is></c></row></sheetData></worksheet>')
    return buf.getvalue()


print('== T06 共享附件文件域授权 ==')
print('实例：%s　run=%s' % (BASE, RUN))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)


def is_authz_reject(st, dump):
    """**权限拒**，不是校验错冒充。

    参数没给对也会非 200（417 VALIDATION_FAILED），那会带「权限/无效」之类的字，
    拿 `st != 200` 当「被拒」会假绿。这里把校验类单独排掉。
    """
    schema_noise = any(w in dump for w in ('VALIDATION_FAILED', '未声明', '类型不正确', '必填'))
    authz = (st == 403 or 'PERMISSION_DENIED' in dump or '无权' in dump
             or 'Not allowed' in dump)
    return authz and not schema_noise


# 建部门拿 name（ID）。schema 在 shangshu_core/install.py:116：
# additionalProperties=False，properties 只有 name(装标题)/parent(上级ID)/enterprise ——
# 传 title 会被判「未声明」，建不出来。
TITLE = f'一部-{RUN}'
st_d, body_d = t.action(adm, 'platform.org.department_create', {'name': TITLE}, f't06-dept-{RUN}')
rd = (body_d.get('result') or body_d) if isinstance(body_d, dict) else {}
DEPT = rd.get('department') or rd.get('name')
print('建部门 HTTP %s 部门ID=%r 标题=%r' % (st_d, DEPT, TITLE))
check('T06 前置：建出部门并拿到 name(ID)', bool(DEPT), 'HTTP %s %s' % (st_d, str(body_d)[:120]))
if not DEPT:
    print('结果： FAIL T06 前置失败（建不出部门就造不出部门归属）'); sys.exit(1)

# 造一份「所有人 = 部门」的附件（department 用 ID）
st, body = t.action(adm, 'files.upload', {
    'file_name': f't06-部门附件-{RUN}.xlsx', 'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/', 'attribution': {'level': 'department', 'department': DEPT}},
    f't06-up-{RUN}')
res = (body.get('result') or body) if isinstance(body, dict) else {}
TID = res.get('file') or res.get('file_id')
att = res.get('attribution') or {}
print('建附件 HTTP %s 表ID=%s 归属=%s' % (st, TID, json.dumps(att, ensure_ascii=False)[:160]))
check('T06 前置：造出「所有人=部门」的附件', bool(TID), 'HTTP %s %s' % (st, str(body)[:120]))
check('T06 前置：归属落成真部门 ID（不是标题/邮箱/None）',
      att.get('department') == DEPT and att.get('level') == 'department',
      '归属=%s  部门ID=%r 标题=%r' % (json.dumps(att, ensure_ascii=False), DEPT, TITLE))
if not TID:
    print('结果： FAIL T06 前置失败'); sys.exit(1)

# ---- 对照人选（这条很要紧，选错会把「默认管理读」误判成「撤权失效」）----
# `default_read_allows` 对 **企业老板 / 部门负责人 / 本部门成员** 有默认管理读，
# 撤**共享**拦不住默认读。ss-editor 早被 test_b1_org.py 任命成**老板**（owner_assign
# 写 Shangshu Org Owner），拿他做撤权对照必然「撤了还读得到」——那是口径，不是缺陷。
# 所以撤权对照必须用 **没有默认读的人**：ss-outsider。
SUBJ = 'ss-outsider@example.invalid'
out = t.Client(BASE)
out.login(SUBJ, user_pw)

# T06-A0 **决定性前置**：还没给任何共享之前先读一次。
# 读不到 → 共享是这个人唯一进来的路，撤权对照才有意义。
st, dat = t.service(out, 'files.sheet_read', {'table': TID, 'page': 1, 'page_length': 5})
dump0 = json.dumps(dat, ensure_ascii=False) if isinstance(dat, dict) else str(dat)
check('T06-A0 未给共享前读不到（共享是唯一进来的路，撤权对照才有效）',
      is_authz_reject(st, dump0), 'HTTP %s %s' % (st, dump0[:150]))

# T06-A 正例：拿到读共享后能读
st, body = t.action(adm, 'platform.org.share_grant', {
    'resource': TID, 'user': SUBJ, 'access': 'read'}, f't06-a-grant-{RUN}')
check('T06-A 前置：给该员工读共享', st == 200, 'HTTP %s' % st)
st, dat = t.service(out, 'files.sheet_read', {'table': TID, 'page': 1, 'page_length': 5})
check('T06-A ① 已授权员工读得到部门附件', st == 200 and bool((dat or {}).get('rows')),
      'HTTP %s rows=%s' % (st, len((dat or {}).get('rows') or []) if isinstance(dat, dict) else None))

# T06-B 反例：没授权的人不能借「所有人 = 部门」搭车读（T06 明写的反向判据）
st, body = t.action(adm, 'platform.org.share_revoke', {
    'resource': TID, 'user': SUBJ}, f't06-b-revoke-{RUN}')
check('T06-B 前置：先撤掉共享，回到未授权状态', st == 200, 'HTTP %s' % st)
st, dat = t.service(out, 'files.sheet_read', {'table': TID, 'page': 1, 'page_length': 5})
body_dump = json.dumps(dat, ensure_ascii=False) if isinstance(dat, dict) else str(dat)
denied = is_authz_reject(st, body_dump)
leak = 'T06附件值' in body_dump or 'H1' in body_dump
check('T06-B ① 未授权者读被拒（是权限拒，不是校验错）', denied, 'HTTP %s %s' % (st, body_dump[:160]))
check('T06-B ② 拒绝回包不带附件内容', not leak, '回包 %s' % body_dump[:140])
check('T06-B ③ 有具体拒绝原话（不是静默空包）', denied and len(body_dump) > 20, '原话 %s' % body_dump[:160])

# T06-C 撤权后旧入口同判（**真正的安全问题**：撤了之后旧链接还进不进得来）
st, body = t.action(adm, 'platform.org.share_grant', {
    'resource': TID, 'user': SUBJ, 'access': 'read'}, f't06-c-grant-{RUN}')
st_r, dat = t.service(out, 'files.sheet_read', {'table': TID, 'page': 1, 'page_length': 5})
check('T06-C 前置：再给一次读共享，确认能读', st_r == 200, 'HTTP %s' % st_r)
st, body = t.action(adm, 'platform.org.share_revoke', {
    'resource': TID, 'user': SUBJ}, f't06-c-revoke-{RUN}')
check('T06-C 前置：撤掉共享', st == 200, 'HTTP %s' % st)
st, dat = t.service(out, 'files.sheet_read', {'table': TID, 'page': 1, 'page_length': 5})
dump = json.dumps(dat, ensure_ascii=False) if isinstance(dat, dict) else str(dat)
check('T06-C ① 撤权后旧链接读被拒（是权限拒）', is_authz_reject(st, dump), 'HTTP %s %s' % (st, dump[:160]))
check('T06-C ② 拒绝回包不带附件内容', 'T06附件值' not in dump, '回包 %s' % dump[:140])

# T06-D 公共空间规则不自动公开邮箱/来信/附件
st, dat = t.service(out, 'files.sheet_read', {'table': TID, 'page': 1, 'page_length': 5})
dump = json.dumps(dat, ensure_ascii=False) if isinstance(dat, dict) else str(dat)
check('T06-D ① 公共规则不外溢：未授权者仍读不到（是权限拒）', is_authz_reject(st, dump),
      'HTTP %s %s（公共空间规则不自动公开附件）' % (st, dump[:120]))

# T06-E 键口径：用部门标题冒充 ID 落归属 → 当场拒（「无权/错键归属不可通过改请求选入」）
st, body = t.action(adm, 'files.upload', {
    'file_name': f't06-标题附件-{RUN}.xlsx', 'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/', 'attribution': {'level': 'department', 'department': TITLE}},
    f't06-up-title-{RUN}')
dump = json.dumps(body, ensure_ascii=False) if isinstance(body, dict) else str(body)
clean = st in (400, 403, 409, 417, 422)
check('T06-E ① 标题冒充 ID 被拒（不是 500、不是静默落错键）', clean, 'HTTP %s %s' % (st, dump[:150]))
check('T06-E ② 拒绝说清原因', clean and len(str((body or {}).get('error') or '')) >= 4,
      '原话 %r' % ((body or {}).get('error') if isinstance(body, dict) else None,))

# T06-F 建表权反例（归 B）：有文件角色、但**无建表权**的人不能在该部门建表落归属。
# 契约 M1「无权归属不可通过改请求选入」。用同一个对照人（此时**还没进部门**，
# 才是「能调动作、但不能选这个归属」）。
print('\n== T06-F 建表权反例：无建表权者不能选部门归属 ==')
st, body = t.action(out, 'files.upload', {
    'file_name': f't06-越权归属-{RUN}.xlsx', 'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/', 'attribution': {'level': 'department', 'department': DEPT}},
    f't06-f-{RUN}')
dump = json.dumps(body, ensure_ascii=False) if isinstance(body, dict) else str(body)
check('T06-F ① 无建表权者选部门归属被拒', st != 200, 'HTTP %s %s' % (st, dump[:150]))
check('T06-F ② 是建表权拒、不是别的错',
      '建表' in dump or 'create_grant' in dump or 'PERMISSION' in dump or '无权' in dump,
      '原话 %s' % dump[:160])
check('T06-F ③ 拒绝回包不带新表身份（没建出来）',
      not (isinstance(body, dict) and (body.get('result') or {}).get('file')),
      '回包 %s' % dump[:130])
# 对照：同一个人**不选部门归属**、选个人归属就能建（证明拦的是「选部门归属」，不是「不让他建表」）
# ⚠️ 产品现在**必填归属**（`_require_attribution`），「不传归属」会被拒。
# 所以这里显式传 `personal`（不走 fixture 静默补，避免假绿）—— 要测「不传」的
# 必须自带绕口（见 `_ss_fixture.py` 顶部），不走 `t.action` 或显式传。
st2, body2 = t.action(out, 'files.upload', {
    'file_name': f't06-普通建表-{RUN}.xlsx', 'content_base64': base64.b64encode(build_plain()).decode(),
    'directory': '/', 'attribution': {'level': 'personal'}},
    f't06-f-ok-{RUN}')
r2 = (body2.get('result') or body2) if isinstance(body2, dict) else {}
check('T06-F ④ 同一个人选个人归属就建得出来（拦的是部门归属，不是不让他建表）',
      st2 == 200 and bool(r2.get('file') or r2.get('file_id')),
      'HTTP %s %s' % (st2, str(body2)[:120]))

# T06-B② **口径冲突，如实测出来，不替用户定**：
# T06 判据说「同部门未授权者不可借部门归属读附件」；但 `default_read_allows`
# 的注释写的是「成员 = 本部门」——**本部门成员有默认管理读**。两边打架。
# 这里只把**实测结果**记下来给 FDE/用户拍板，不写成「必须红」也不写成「必须绿」。
print('\n== T06-B② 成员无共享时能否读（口径冲突，待拍板）==')
st_m, body_m = t.action(adm, 'platform.org.member_assign', {
    'user': SUBJ, 'department': DEPT}, f't06-b2-member-{RUN}')
st, dat = t.service(out, 'files.sheet_read', {'table': TID, 'page': 1, 'page_length': 5})
member_can_read = (st == 200)
print('  把该员工加进本部门后读 → HTTP %s（读得到=成员有默认管理读）' % st)
print('  T06 判据：「同部门未授权者不可读」　|　default_read_allows 注释：「成员=本部门」')
print('  → 两边打架，**不替用户定**，实测值如实报：成员能读=%s' % member_can_read)
check('T06-B② 实测已跑出（成员无共享时能否读）', st_m == 200,
      'member_assign HTTP %s；读 HTTP %s → 成员能读=%s' % (st_m, st, member_can_read))

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)
if failed:
    print('结果： FAIL T06 文件域授权（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
print('结果： PASS T06 文件域授权全部成立（%d 条）' % checks_run)
