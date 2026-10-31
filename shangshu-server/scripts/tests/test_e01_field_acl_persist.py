"""UI019/105 actual field ACL persistence and production frontend HTTP bridge.

Explicit --execute-live and released QA window required. Unique synthetic users,
departments and files; exact public recycle/disable with independent verification.
Retains original ACL upgrade/search checks and adds omitted/empty/explicit role
semantics, real download positive/negative controls, employee self-grant denial,
and production editor save/reload/stale-definition rejection. Administrator
management read does not imply resource write: field sensitivity uses the same
ordinary owner with different persisted declarations.

The legacy DEPT_READ_DEFAULT probe is real backend/database integration inside
one isolated console, NOT HTTP. Its module constant is restored in finally and
all temporary legacy metadata/identity mapping is rolled back to a savepoint.
Modern organization attribution is an independent control.
"""
import importlib.util
import json
import os
import sys
import subprocess
from pathlib import Path
from test_e01_role_matrix import Fixture, successful, denied

if "--execute-live" not in sys.argv:
    sys.exit("Live writes require --execute-live after exclusive QA window release")

ROOT = str(Path(os.environ.get('SS_ROOT', Path(__file__).resolve().parents[3])))
os.environ.setdefault('SS_ROOT', ROOT)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')

BASE = os.environ.get('SS_BASE', '')

checks, fails, not_yet = [], [], []


def check(label, valid, detail=''):
    checks.append(label)
    if valid is None:
        not_yet.append(label)
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:190]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:190]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


def _err(body):
    return _ss_seed._err(body)


# ---- 带角色声明的定义形状（显式常量，不散落字面量）----
# 三列**三种不同的 ACL 结论**，敏感度就靠这个（不恒同）。
# `Desk User` = 合成普通账号身上有的那个角色；`System Manager` = 管理员。
#
# ⚠️ **`_ss_seed.MIXED_HEADERS` 是 ['项目名称','金额','备注']** ——
# 表头必须跟夹具造出来的表对得上，否则「列在哪」全错（栽过：start_col 打错列）。
ACL_COLUMNS = [
    # ① 对普通账号**不可读**（只有 System Manager 可读）
    {'header': '项目名称', 'promoted': True, 'field': 'project_name', 'type': 'text',
     'read_roles': ['System Manager'], 'write_roles': ['System Manager'],
     'download_roles': ['System Manager']},
    # ② **只读**（人人可读、`write_roles: []` = 无人可写）
    {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
     'rules': {'min': 0},
     'read_roles': ['Desk User'], 'write_roles': [], 'download_roles': ['Desk User']},
    # ③ 普通列（**不晋升**）—— 对照：普通列不进字段 ACL（用户 2026-10-15
    # 「新加的列就是 xlsx 里面的列，不是有意义的字段，只在 xlsx 上体现」）
    {'header': '备注', 'promoted': False},
]

ACL_BY_HEADER = {c['header']: c for c in ACL_COLUMNS}
THREE_KEYS = ('read_roles', 'write_roles', 'download_roles')


def _acl_of(cols, header):
    """从读回的定义里取某列的三个角色键。回 `dict`，**缺键就缺**（不补默认）。"""
    for c in cols or []:
        if isinstance(c, dict) and c.get('header') == header:
            return {k: c.get(k) for k in THREE_KEYS}
    return {}


def _latch(cli):
    """版本闩。**必须 int** —— `sheet_read` 回的可能是字符串，
    schema 要 integer，传错被 **schema 拒** → 那是**错因通过**（栽过：④a 第一版
    两列都 417「expected_content_version 应为 integer」，看着像「都拦住了」，
    其实产品根本没跑到）。"""
    rr = result_of(*t.service(cli, 'files.sheet_read', {'table': TABLE}))
    return int(rr.get('content_version') or 0), int(rr.get('structure_version') or 1)


def _sv():
    return _latch(c)[1]


def _by_right_gate(msg, st, words):
    """**拒因要点名是哪道闸** —— 只看「不是 200」是空判据（schema/版本/资源级拒
    也会不是 200）。要产品的话里出现**本道闸**的字眼才算。
    判据自己会撒谎，这里专门防：**错因通过不算过**。"""
    m = str(msg or '')
    return st != 200 and any(w in m for w in words)


_GATE_FIELD = ('字段', '权限', '不可写', '不能改', '只读', 'write_roles', '角色')


print('== R967-E01 / BASE967-31：字段 ACL 进定义持久化、加载、升级 ==')

f = Fixture('fieldacl', ('owner', 'member'))
handle = None
attachment_mails = []
try:
    f.setup()
    c = f.admin
    emp = f.clients['owner']
    USER2 = f.users['owner']
    attrib = {'level': 'personal', 'owner_user': USER2}
    # Use the existing seed workbook, but track the returned resource at upload
    # time so a later failed promotion still receives exact creator cleanup.
    original_action = _ss_seed.t.action
    def tracked_action(client, action, payload, *args, **kwargs):
        response = original_action(client, action, payload, *args, **kwargs)
        file = result_of(*response).get('file') if action == 'files.upload' else None
        if file and file not in f.files:
            f.files.append(file)
            f.file_clients[file] = emp
        return response
    _ss_seed.t.action = tracked_action
    handle = _ss_seed.seed_mixed_table(emp, run=f.prefix, promote_with=c, attribution=attrib)
    TABLE = handle['table']
    RID = handle['row_ids'][0]
    print('FIXTURE', json.dumps({'table': TABLE, 'owner': USER2, 'row': RID}))

    # ---------- ① 前置：带三键的定义**存得进** ----------
    cur_sv = _sv()
    st1, b1 = t.action(c, 'files.promotion_define', {
        'table': TABLE, 'expected_structure_version': cur_sv,
        'definition': {'definition_version': 1, 'columns': ACL_COLUMNS}}, 'e01-def')
    check('① 前置·带三键的定义**存得进**（schema 不拒、动作 200）',
          st1 == 200, 'HTTP %s %s' % (st1, _err(b1)[:170]))

    # ---------- ② ★ 读回来三键原样还在（BASE967-31 本体）----------
    st2, b2 = t.service(c, 'files.promotion_definition', {'table': TABLE})
    got_cols = result_of(st2, b2).get('columns') or []
    check('② ★ **读回来三键原样还在**（BASE967-31 本体）——'
          ' 不被 `save_definition` 白名单扔掉',
          st2 == 200 and all(_acl_of(got_cols, h) == {k: ACL_BY_HEADER[h].get(k) for k in THREE_KEYS}
                             for h in ('项目名称', '金额')),
          '读回 %s' % json.dumps(
              {h: _acl_of(got_cols, h) for h in ('项目名称', '金额', '备注')},
              ensure_ascii=False)[:170])

    # ②-附：**逐键**点名，免得「三键一起比」蒙混过关
    for header in ('项目名称', '金额'):
        for key in THREE_KEYS:
            want, got = ACL_BY_HEADER[header].get(key), _acl_of(got_cols, header).get(key)
            check('②-附 %s.%s 原样在（要 %r）' % (header, key, want),
                  key in (_acl_of(got_cols, header) or {}) and got == want,
                  '实 %r%s' % (got, '　← **键被扔了**' if key not in (_acl_of(got_cols, header) or {}) else ''))

    # ---------- ③ ★ 升级定义后 ACL 保留 ----------
    # 改一列的 `rules`（跟 ACL 无关的那一面），**角色键照原样带上**，
    # 重存一版 = 「定义升级」。E01.3：ACL 要活过升级。
    cols_v2 = json.loads(json.dumps(ACL_COLUMNS))
    for col in cols_v2:
        if col.get('header') == '金额':
            col['rules'] = {'min': 5}          # 只动规则，不动 ACL
    st3, b3 = t.action(c, 'files.promotion_define', {
        'table': TABLE, 'expected_structure_version': _sv(),
        'definition': {'definition_version': 1, 'columns': cols_v2}}, 'e01-def-up')
    st3r, b3r = t.service(c, 'files.promotion_definition', {'table': TABLE})
    up_cols = result_of(st3r, b3r).get('columns') or []
    keep = all(_acl_of(up_cols, h) == {k: ACL_BY_HEADER[h].get(k) for k in THREE_KEYS}
               for h in ('项目名称', '金额'))
    check('③ ★ **升级定义后 ACL 保留**（E01.3「升级全过程」）',
          st3 == 200 and keep,
          'HTTP %s 升级后 %s' % (st3, json.dumps(
              {h: _acl_of(up_cols, h) for h in ('项目名称', '金额')}, ensure_ascii=False)[:150]))

    # ---------- ④ ★ 判定生效（**必须合成普通账号**，管理员恒真）----------
    if emp is None:
        check('④ ★ **只读列写被拒 / 不可读列值不出现**（合成账号）', None,
              '合成账号 %s 登录不进来，没跑（不假装验过）' % USER2)
    else:
        # --- ④a 只读列（金额 `write_roles: []`）写 → 该被**字段闸**拒 ---
        cv, sv = _latch(emp)
        st4a, b4a = t.action(emp, 'files.cell_write', {
            'table': TABLE, 'row_id': RID, 'header': '金额',
            'value': {'type': 'number', 'value': 999},
            'expected_content_version': cv,
            'expected_structure_version': sv}, 'e01-ro')
        rej_ro, msg_ro = _ss_seed.rejected(st4a, b4a)
        # **拒因必须点名字段闸** —— 只看「不是 200」是空判据
        # （schema / 版本 / 资源级拒都会不是 200，那是**错因通过**）。
        by_field_gate = _by_right_gate(msg_ro, st4a, _GATE_FIELD)
        # --- 对照：普通列（备注）写 → 该进 ---
        cv, sv = _latch(emp)
        st4b, b4b = t.action(emp, 'files.cell_write', {
            'table': TABLE, 'row_id': RID, 'header': '备注',
            'value': {'type': 'text', 'value': 'E01对照'},
            'expected_content_version': cv,
            'expected_structure_version': sv}, 'e01-plain')
        rej_plain, msg_plain = _ss_seed.rejected(st4b, b4b)
        check('④a ★ **只读列**（`write_roles: []`）被**字段闸**拒；对照·普通列写得进',
              rej_ro and by_field_gate and (not rej_plain),
              '只读列 HTTP %s 字段闸=%s %s　|　普通列 HTTP %s %s'
              % (st4a, by_field_gate, msg_ro[:70], st4b, msg_plain[:50]))

        # --- ④b 不可读列（项目名称 `read_roles: [System Manager]`）**值**不出现 ---
        # ⚠️ **标签说的是「值」，断言就得查值**（第一版查的是键 —— 标签和断言打架，
        # 又一次「判据自己会撒谎」）。实现语义是「**键留着、值不给**」：列名不是秘密，
        # 值是；前端凭 `hidden: true` 说「无权查看」，比莫名少一列清楚。
        st4c, b4c = t.service(emp, 'files.row_read', {'table': TABLE, 'row_id': RID})
        cells = result_of(st4c, b4c).get('cells') or {}
        hidden_cell = cells.get('项目名称') if isinstance(cells.get('项目名称'), dict) else {}
        leaked_value = hidden_cell.get('value')
        marked_hidden = bool(hidden_cell.get('hidden'))
        # **必须 200** —— 403/417 时「值不出现」是**资源级拒**掩盖的，**错因通过**。
        check('④b ★ **不可读列**的值**不出现在读回包**（键留着标 hidden，值一个字节不给）',
              (st4c == 200) and (leaked_value in (None, '')) and marked_hidden,
              'HTTP %s 该列回包=%r 读到的列 %r'
              % (st4c, hidden_cell, list(cells)[:8]))

        # --- ④c 对照：**可读**列的值**在**（不是把整行都藏了冒充「不泄露」）---
        ro_cell = cells.get('金额') if isinstance(cells.get('金额'), dict) else {}
        check('④c 对照·**可读**列（金额 `read_roles: [Desk User]`）的值**在**'
              '（不许把整行都藏了冒充不泄露）',
              (st4c == 200) and (not ro_cell.get('hidden')) and ('金额' in cells),
              '金额列回包=%r' % ro_cell)

        # 同一内容版本先以管理员填充搜索缓存，再切换普通用户，验证缓存不跨权限复用。
        sa, ba = t.service(c, 'files.sheet_read', {'table': TABLE, 'search': '夹具甲'})
        se, be = t.service(emp, 'files.sheet_read', {'table': TABLE, 'search': '夹具甲'})
        sp, bp = t.service(emp, 'files.sheet_read', {'table': TABLE, 'search': 'E01对照'})
        ar, er, pr = result_of(sa, ba), result_of(se, be), result_of(sp, bp)
        check('④d 隐藏列搜索不泄露命中、行或计数（管理员缓存已热）',
              sa == 200 and len(ar.get('rows') or []) == 1
              and se == 200 and not er.get('rows') and er.get('total_rows') == 0,
              '管理员命中=%s 普通人命中=%s total_rows=%s' % (
                  len(ar.get('rows') or []), len(er.get('rows') or []), er.get('total_rows')))
        check('④e 可读列仍可搜索定位，不能靠禁用全部搜索通过',
              sp == 200 and len(pr.get('rows') or []) == 1
              and pr['rows'][0].get('row_id') == RID,
              'HTTP %s 命中=%s' % (sp, len(pr.get('rows') or [])))

        # Resource management read must not be confused with a field-role bypass.
        cv_a, sv_a = _latch(c)
        st5, b5 = t.action(c, 'files.cell_write', {
            'table': TABLE, 'row_id': RID, 'header': '金额',
            'value': {'type': 'number', 'value': 123},
            'expected_content_version': cv_a,
            'expected_structure_version': sv_a}, 'e01-sm')
        rej_sm, msg_sm = _ss_seed.rejected(st5, b5)
        check('⑤ 管理员管理读不自动授资源写；字段正例另由同一owner省略声明验证',
              rej_sm and st5 == 403,
              '管理员HTTP %s %s' % (st5, msg_sm[:90]))
    # UI105: the same persisted promoted fields, same resource owner, differing
    # only in declared field roles. Never treat a schema/resource denial as ACL.
    base_columns = json.loads(json.dumps(ACL_COLUMNS))
    for col in base_columns:
        for key in THREE_KEYS: col.pop(key, None)
    def define(columns, client=c):
        return f.action(client, 'files.promotion_define', {'table': TABLE,
            'expected_structure_version': _sv(),
            'definition': {'definition_version': 1, 'columns': columns}})
    def read_columns():
        return result_of(*t.service(c, 'files.promotion_definition', {'table': TABLE})).get('columns', [])
    def write_amount(value):
        cv, sv = _latch(emp)
        return f.action(emp, 'files.cell_write', {'table': TABLE, 'row_id': RID,
            'header': '金额', 'value': {'type': 'number', 'value': value},
            'expected_content_version': cv, 'expected_structure_version': sv})
    check('UI105 omitted keys definition persisted', successful(define(base_columns)))
    got = read_columns()
    check('UI105 omitted read/write/download remain absent after reload',
          all(not any(k in col for k in THREE_KEYS) for col in got if col.get('promoted')))
    st, body = t.service(emp, 'files.row_read', {'table': TABLE, 'row_id': RID})
    check('UI105 omitted read permits actual value', st == 200 and
          result_of(st, body).get('cells', {}).get('金额', {}).get('value') == 10.5)
    check('UI105 omitted write permits actual write', successful(write_amount(456)))
    st, body = t.service(emp, 'files.row_read', {'table': TABLE, 'row_id': RID})
    check('UI105 omitted write independently reads back', st == 200 and
          result_of(st, body).get('cells', {}).get('金额', {}).get('value') == 456)
    check('UI105 omitted download rejects full actual file',
          denied(f.t.download(emp, TABLE, f.reference(TABLE))))
    attachment_payload = {'subject': f.prefix + '-omitted-download', 'body': 'ACL snapshot probe',
                          'to': [], 'cc': [], 'attachments': [f.reference(TABLE)]}
    response = f.action(emp, 'mail.save_draft', attachment_payload)
    unexpected_mail = result_of(*response).get('name')
    if unexpected_mail: attachment_mails.append(unexpected_mail)
    check('UI105 same omitted download denies mail attachment at permission gate',
          response[0] == 403 and any(word in str(response[1]) for word in ('权限', '下载', 'download', 'Permission')))
    persisted = f.console_module.run("RESULT['count']=frappe.db.count('Shangshu Mail Message',{'subject':%r})" % attachment_payload['subject'])
    check('UI105 denied omitted download creates zero draft messages', persisted.get('count') == 0)
    empty = json.loads(json.dumps(base_columns))
    for col in empty:
        if col.get('promoted'):
            col.update(read_roles=[], write_roles=[], download_roles=[])
    check('UI105 explicit empty keys definition persisted', successful(define(empty)))
    check('UI105 explicit empty keys reload unchanged', all(
        all(col.get(k) == [] for k in THREE_KEYS) for col in read_columns() if col.get('promoted')))
    st, body = t.service(emp, 'files.row_read', {'table': TABLE, 'row_id': RID})
    cells = result_of(st, body).get('cells', {})
    check('UI105 explicit empty read hides values while resource readable', st == 200 and
          cells.get('金额', {}).get('hidden') is True and cells.get('金额', {}).get('value') in (None, ''))
    before = result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    response = write_amount(789)
    after = result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    check('UI105 explicit empty write denies at field gate with unchanged version',
          response[0] in (403, 417) and any(w in str(response[1]) for w in _GATE_FIELD)
          and before.get('content_version') == after.get('content_version'))
    allow = json.loads(json.dumps(base_columns))
    for col in allow:
        if col.get('promoted'):col.update(read_roles=['Desk User'], write_roles=['Desk User'], download_roles=['Desk User'])
    check('UI105 explicit roles definition persisted', successful(define(allow)))
    response = f.t.download(emp, TABLE, f.reference(TABLE))
    check('UI105 explicit download role positive control returns bytes', response[0] == 200 and bool(response[1].get('_bytes')))
    response = f.action(emp, 'mail.save_draft', attachment_payload)
    positive_mail = result_of(*response).get('name')
    if positive_mail: attachment_mails.append(positive_mail)
    saved = f.console_module.run("RESULT['attachments']=frappe.db.get_value('Shangshu Mail Message',%r,'attachment_ids_json')" % positive_mail) if positive_mail else {}
    check('UI105 same explicit download grant allows persisted mail snapshot',
          successful(response) and len(json.loads(saved.get('attachments') or '[]')) == 1)
    prior = read_columns()
    response = define(empty, emp)
    check('UI019 ordinary resource owner cannot self-authorize field definition',
          response[0] == 403 and read_columns() == prior)
    modern = f.upload('owner', 'department-switch-control',
                      {'level': 'department', 'department': f.departments['a']})
    probe = f.console_module.run("""
from shangshu_files import service
from shangshu_core import org_admin
import json
prefix=__PREFIX__
owner=__OWNER__
member=__MEMBER__
source=__SOURCE__
modern=__MODERN__
department=__DEPARTMENT__
old=service.DEPT_READ_DEFAULT
checkpoint='field_acl_legacy_probe'
frappe.db.savepoint(checkpoint)
legacy_id=directory_id=None
try:
 identity=frappe.db.get_value('Shangshu Identity',{'user':member},'name')
 # Exact synthetic legacy identity mapping; rollback restores its prior group.
 frappe.db.set_value('Shangshu Identity',identity,'collaboration_group',department)
 directory=frappe.get_doc({'doctype':'Shangshu File Directory','title':prefix+'-legacy-only','parent_directory':'files-root','path':'/'+prefix+'-legacy-only','access_mode':'restricted','allowed_identities_json':'[]','allowed_groups_json':'[]'}).insert(ignore_permissions=True)
 directory_id=directory.name
 src=frappe.get_doc('Shangshu File Center File',source)
 legacy=frappe.get_doc({'doctype':'Shangshu File Center File','file_name':prefix+'-legacy.xlsx','status':'Active','owner':owner,'owner_subject_kind':'Department','owner_subject':department,'directory_id':directory.name,'directory':directory.path,'current_file':src.current_file,'current_sha256':src.current_sha256,'current_size':src.current_size,'sheet_meta_json':'{}','version_count':src.version_count}).insert(ignore_permissions=True)
 legacy_id=legacy.name
 assert org_admin.resource_attribution(legacy.name) is None
 frappe.set_user(member)
 RESULT['states']=[]
 for mode in ['open','closed','open']:
  service.DEPT_READ_DEFAULT=mode
  condition=service.permission_query(member)
  listed=bool(frappe.db.sql('SELECT name FROM `tabShangshu File Center File` WHERE name=%s AND ('+condition+')',(legacy.name,)))
  RESULT['states'].append({'mode':mode,'legacy_read':service.has_permission(legacy,'read',member),'legacy_listed':listed,'legacy_download':service._can_download(legacy),'modern_read':service.has_permission(frappe.get_doc('Shangshu File Center File',modern),'read',member)})
finally:
 service.DEPT_READ_DEFAULT=old
 frappe.set_user('Administrator')
 frappe.db.rollback(save_point=checkpoint)
RESULT['restored']=service.DEPT_READ_DEFAULT==old
RESULT['fixture_rolled_back']=not frappe.db.exists('Shangshu File Center File',legacy_id) and not frappe.db.exists('Shangshu File Directory',directory_id)
""".replace('__PREFIX__',repr(f.prefix)).replace('__OWNER__',repr(f.users['owner']))
        .replace('__MEMBER__',repr(f.users['member'])).replace('__SOURCE__',repr(TABLE))
        .replace('__MODERN__',repr(modern)).replace('__DEPARTMENT__',repr(f.departments['a'])))
    print('LEGACY_BACKEND_INTEGRATION_NOT_HTTP',json.dumps(probe,ensure_ascii=False))
    states=probe.get('states',[])
    check('UI105 legacy switch changes actual backend detail/list but not download',
          len(states)==3 and [x['legacy_read'] for x in states]==[True,False,True]
          and [x['legacy_listed'] for x in states]==[True,False,True]
          and all(x['legacy_download'] is False and x['modern_read'] is True for x in states))
    check('UI105 isolated console constant restored and exact legacy fixture rolled back',
          probe.get('restored') is True and probe.get('fixture_rolled_back') is True and not probe.get('__error__'))
    bridge_env = dict(os.environ, SS_FIELD_TABLE=TABLE,
                      SS_FIELD_COOKIE='; '.join(cookie.name+'='+cookie.value for cookie in c.jar))
    bridge = subprocess.run([str(Path(ROOT)/'shangshu-server/node_modules/.bin/tsx'),
        str(Path(ROOT)/'shangshu-server/scripts/tests/field-permissions-http-bridge.mjs')],
        env=bridge_env, text=True, capture_output=True, timeout=90)
    print(bridge.stdout)
    if bridge.returncode:print(bridge.stderr)
    check('UI019 production frontend real HTTP save/reload and stale-definition rejection', bridge.returncode == 0)
finally:
    for mail in attachment_mails:
        probe = f.console_module.run("RESULT['version']=frappe.db.get_value('Shangshu Mail Message',%r,'record_version')" % mail)
        response = f.action(emp, 'mail.recycle', {'mail': mail, 'expected_version': int(probe['version'])})
        verify = f.console_module.run("RESULT['status']=frappe.db.get_value('Shangshu Mail Message',%r,'status')" % mail)
        check('UI105 exact synthetic attachment draft recycled', successful(response) and verify.get('status') == 'Trash')
    f.cleanup()
    if not all(f.checks):fails.append('exact cleanup')

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
_verbs = []
if not fails:
    _verbs.append('三键原样落库并读回')
    _verbs.append('升级后 ACL 保留')
    _verbs.append('只读/不可读**待验**' if not_yet else '只读拒写 + 不可读不泄露')
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E01 / BASE967-31（%d 条）—— %s' % (len(checks), '；'.join(_verbs)))
                   if not not_yet else
                   ('**未判** R967-E01 / BASE967-31（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只验**字段 ACL 的持久化与生效**。')
print('   已验同配置附件下载闸；其他候选权限泄露仍属独立专项。')
sys.exit(1 if (fails or not_yet) else 0)
sys.exit(1 if fails else 0)
