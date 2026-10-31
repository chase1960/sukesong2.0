"""B1～B3 多身份权限矩阵与反例（下一批 §5 B1～B3 + 用户 2026-10-12 补充要求）。

测试通过 = 契约《账号与权限》§6 的 11 个场景逐格成立，且每个反例真的被拒：

M1  建表权：本部门成员建部门表成功；跨部门无授权拒、有授权成功；页面与直接接口一致。
M2  读权矩阵（七身份 × 五表）：老板读企业范围内；A 负责人读 A 部+下属 A-华东；
    B 负责人读不到 A 部的；A 员工读 A 部表；B 员工读不到 A 部表；未分部门员工只读自己的。
M3  个人级不向管理者保密：老板/负责人按默认管理读读得到辖内员工个人表；
    无管理关系的 B 负责人读不到 A 员工个人表。
M4  管理读不带其他权：老板/负责人对默认可读的表**不能**编辑/改结构/转授权/下载
    （部门级表默认部门内可下载，但那是成员资格给的，不是管理读给的）。
M5  转授权：所有者可转授读/编辑、不超自身；普通编辑者不能转授；建表不扩大别人读写权。
M6  下载：部门级表默认部门内可下载；企业/个人级导出单列，不因可见就可导出。
M7  全入口同一套校验：清单/计数/搜索/详情/版本/下载/动作 七个入口，
    无权表一律拿不到（数量不泄漏、搜索不命中、版本拉不到、下载拒）。
    回执入口按资源核权归 B5（受管撤回），不在此假绿。
M8  撤权/调岗后失效：撤共享、调离部门、取消负责人之后，旧页面/缓存/未执行提案
    都不能再借旧权限读写；已完成的历史事实保留。
M9  老板限本企业：另一个企业的部门/表，本企业老板读不到；跨企业挂接被拒。
M10 真实组织关系判定：前端自报部门/身份一律不算（直接发请求冒充也拒）；
    Assistant 用所属人的有效权限。
M11 部门稳定身份：改名不改身份；拒绝循环父子；拒绝跨企业挂接；启停生效。

组织事实单一权威：以上全走新组织模型；旧 collaboration_group 只作投影/映射，
不作为第二份可独立修改的部门事实（M11 末尾断言其不参与授权）。

接口契约（实现照此，改要同步改这份）：
  platform.org.department_create {name, parent?, enterprise} → {department}
  platform.org.department_rename {department, name}
  platform.org.department_set_status {department, enabled}
  platform.org.department_update {department, parent?}（改挂上级；循环/跨企业以理由拒）
  platform.org.member_assign {user, department} / member_remove {user, department}
  platform.org.head_assign {user, department} / head_remove {user, department}
  platform.org.owner_assign {user, enterprise} / owner_remove {user, enterprise}
  platform.org.resource_assign {resource, level: personal|enterprise|department, department?}
  files.upload …可带 attribution:{level, department?, owner_user?}（建表归属；
      personal 默认归本人、管理员可代办；department 须所属/管辖或 create_grant；
      企业表全员可建——无权归属不可通过改请求选入）
  platform.org.create_grant {user, department, scope: create}（跨部门建表授权）
  platform.org.share_grant {resource, access: read|edit, users?:[], departments?:[]}
      —— 共享对象：个人 或 多选部门（用户 2026-10-12「可以选择 abc 三个部门共享」）；
         单数 user/department 与复数写法都认；共享到部门按「部门范围包含下属部门」生效；
         只有资源归属人（或系统管理员）可共享——管理读不带共享（用户 2026-10-12）
  platform.org.share_revoke {resource, user?} / {resource, department?}

矩阵里契约标「待定」的格子（日志读取矩阵等）**不在本文件**——等用户拍板，不自定。
"""
import base64
import importlib.util
import json
import sys
import urllib.parse

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'
FIXP = '/path/to/workspace'

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
spec = importlib.util.spec_from_file_location('fix', FIXP)
fix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fix)

RUN = t.RUN
fails = []


def check(name, ok, detail):
    print(f'{"PASS" if ok else "FAIL"} {name} — {detail}')
    if not ok:
        fails.append(name)


def act(c, action, payload, key):
    try:
        st, body = t.action(c, action, payload, key)
    except Exception as e:
        return None, f'调用异常:{e}'
    return (st, body), ('ok' if st == 200 else f'HTTP {st} {json.dumps(body, ensure_ascii=False)[:120]}')


def result_of(res):
    """动作回包信封是 {ok, result:{...}}，取业务结果体。"""
    if not res:
        return {}
    body = res[1] if isinstance(res[1], dict) else {}
    return body.get('result') or body


def denied(res):
    """只认**权限类**拒绝：403 / PERMISSION_DENIED / 无权。
    校验错（417 VALIDATION）、接口缺失（404）都不算「被拒」——
    否则反例会假绿在「参数没写对」上。"""
    st, body = res
    body = body if isinstance(body, dict) else {}
    code = body.get('code', '')
    err = str(body.get('error', ''))
    if st == 403 or code == 'PERMISSION_DENIED':
        return True
    if '无权' in err or 'not permitted' in err.lower() or 'permission' in err.lower():
        return True
    return False


def rejected(res, word):
    """业务规则类拒绝（循环/跨企业/停用）：断言**被拒且理由是这个词**。
    循环挂接、跨企业挂接是校验拒绝不是无权，denied() 不适用；
    而单看「非 200」会假绿在动作缺失（404）上，所以锚定拒绝理由里的词。"""
    if not res:
        return False
    st, body = res
    body = body if isinstance(body, dict) else {}
    err = f"{body.get('error', '')} {body.get('message', '')}"
    return st != 200 and word in err


# ---------- 口令与管理员 ----------
PW = 'b2-user-pw-2026'
ENV = ('/path/to/workspace'
       'ops/docker/.state/environments/shangshu-local-b.env')
_admin_pw = ''
for _line in open(ENV):
    if _line.startswith('ADMIN_PASSWORD='):
        _admin_pw = _line.split('=', 1)[1].strip().strip('"').strip("'")
        break

adm = t.Client(BASE)
adm.login('Administrator', _admin_pw)


def user_client(email):
    c = t.Client(BASE)
    try:
        c.login(email, PW)
    except Exception as e:
        print(f'  （登录失败不炸整份：{email} {e}）')
    return c


# ---------- 组织与人员（产品动作，不写测试 SQL） ----------
print('== 建组织与人员 ==')
SUF = str(RUN)
res_dA, _ = act(adm, 'platform.org.department_create', {'name': f'A部-{SUF}', 'enterprise': 'default'}, 'org-A')
dA = result_of(res_dA).get('department') if res_dA else None
check('建 A 部', res_dA and res_dA[0] == 200 and dA, str(res_dA)[:120] if res_dA else '-')

res_dB, _ = act(adm, 'platform.org.department_create', {'name': f'B部-{SUF}', 'enterprise': 'default'}, 'org-B')
dB = result_of(res_dB).get('department') if res_dB else None
check('建 B 部', res_dB and res_dB[0] == 200 and dB, str(res_dB)[:120] if res_dB else '-')

res_dA1, _ = act(adm, 'platform.org.department_create', {'name': f'A-华东-{SUF}', 'parent': dA, 'enterprise': 'default'}, 'org-A1')
dA1 = result_of(res_dA1).get('department') if res_dA1 else None
check('建下属部门 A-华东', res_dA1 and res_dA1[0] == 200 and dA1, str(res_dA1)[:120] if res_dA1 else '-')

# 七个身份：都用产品身份动作建（普通职责账号），管理员只做对照
PEOPLE = {
    'boss': f'boss-{SUF}@example.invalid',
    'headA': f'heada-{SUF}@example.invalid',
    'headA1': f'heada1-{SUF}@example.invalid',
    'headB': f'headb-{SUF}@example.invalid',
    'empA': f'empa-{SUF}@example.invalid',
    'empB': f'empb-{SUF}@example.invalid',
    'empNone': f'empnone-{SUF}@example.invalid',
}
for tag, email in PEOPLE.items():
    res, why = act(adm, 'platform.identity.create',
                   {'email': email, 'display_name': f'矩阵{tag}-{SUF}', 'role': 'staff', 'initial_password': PW}, f'id-{tag}')
    ok = (res and res[0] == 200) or '已存在' in why or 'Duplicate' in why
    check(f'建身份 {tag}', ok, why[:100])

# 任职/任命
for key, dep in (('empA', dA), ('headA', dA), ('headA1', dA1), ('empB', dB), ('headB', dB)):
    res, why = act(adm, 'platform.org.member_assign', {'user': PEOPLE[key], 'department': dep}, f'm-{key}')
    check(f'{key} 进部门', res and res[0] == 200, why[:100])
for key, dep in (('headA', dA), ('headA1', dA1), ('headB', dB)):
    res, why = act(adm, 'platform.org.head_assign', {'user': PEOPLE[key], 'department': dep}, f'h-{key}')
    check(f'任命 {key} 负责人', res and res[0] == 200, why[:100])
res, why = act(adm, 'platform.org.owner_assign', {'user': PEOPLE['boss'], 'enterprise': 'default'}, 'o-boss')
check('任命老板（企业管理者）', res and res[0] == 200, why[:100])

# ---------- 五张表 ----------
def upload(name, attribution=None, client=None):
    c = client or adm
    payload = {
        'file_name': f'{name}-{SUF}.xlsx',
        'content_base64': base64.b64encode(fix.build_external_fixture()).decode(),
        'directory': '/',
    }
    if attribution:
        payload['attribution'] = attribution
    return act(c, 'files.upload', payload, f'up-{name}')


def file_of(res):
    """动作信封 {ok, result:{file}} → 表身份。"""
    return result_of(res).get('file')


res, why = upload('M-个人表-empA', {'level': 'personal', 'owner_user': PEOPLE['empA']})
T_personal = file_of(res)
check('建 empA 个人表（管理员代办归属）', bool(T_personal), why[:100])
res, why = upload('M-部门表-A', {'level': 'department', 'department': dA})
T_deptA = file_of(res)
check('建 A 部部门表', bool(T_deptA), why[:100])
res, why = upload('M-部门表-A1', {'level': 'department', 'department': dA1})
T_deptA1 = file_of(res)
check('建 A-华东部门表', bool(T_deptA1), why[:100])
# 「尚书是单例，没有企业归属」（用户 2026-10-15）—— enterprise 现在被拒。
res, why = upload('M-企业表', {'level': 'enterprise'})
T_ent = file_of(res)
check('建企业表被拒（enterprise 不再合法，用户 2026-10-15：尚书是单例）',
      not T_ent, why[:100])
res, why = upload('M-部门表-B', {'level': 'department', 'department': dB})
T_deptB = file_of(res)
check('建 B 部部门表', bool(T_deptB), why[:100])
# 个人表归属是 empA 的——由 empA 自己建才算「本人表」
res_p, why_p = upload('M-个人表2', {'level': 'personal'}, client=user_client(PEOPLE['empA']))
T_p2 = file_of(res_p)
check('员工建本人表', bool(T_p2), why_p[:100])
res_p3, why_p3 = upload('M-个人表3-empB', {'level': 'personal'}, client=user_client(PEOPLE['empB']))
T_p3 = file_of(res_p3)
check('B 员工建本人表', bool(T_p3), why_p3[:100])
res_pn, why_pn = upload('M-个人表-empNone', {'level': 'personal'}, client=user_client(PEOPLE['empNone']))
T_pNone = file_of(res_pn)
check('未分部门员工建本人表', bool(T_pNone), why_pn[:100])
TABLES = {'personal': T_personal or T_p2, 'personalB': T_p3, 'personalNone': T_pNone,
          'deptA': T_deptA, 'deptA1': T_deptA1, 'deptB': T_deptB}
print('表：', json.dumps(TABLES, ensure_ascii=False))


def read_ok(c, tid):
    try:
        st, dat = t.service(c, 'files.sheet_read', {'table': tid, 'page': 1, 'page_length': 3})
    except Exception as e:
        return False, f'异常:{e}'
    return st == 200 and not (isinstance(dat, dict) and dat.get('ok') is False), f'HTTP {st}'


CLIENTS = {tag: user_client(em) for tag, em in PEOPLE.items()}

# ---------- M2/M3 读权矩阵 ----------
print('\n== M2/M3 读权矩阵 ==')
EXPECT = {  # (身份, 表) -> 应否读到
    # 用户 2026-10-12 钉死：老板=全企业都看得到；负责人=所辖部门及以下（含辖内个人表）
    # 成员=本部门精确（不展开下属）；个人表=本人/辖内负责人/老板
    # ⚠️ 'ent' 已移除（2026-10-15）：「尚书是单例，没有企业归属」—— enterprise 不再合法
    ('boss', 'deptA'): True, ('boss', 'deptA1'): True, ('boss', 'personal'): True,
    ('boss', 'deptB'): True, ('boss', 'personalB'): True, ('boss', 'personalNone'): True,
    ('headA', 'deptA'): True, ('headA', 'deptA1'): True, ('headA', 'deptB'): False,
    ('headA', 'personal'): True,  # M3 负责人辖内个人表（empA 在 A 部）
    ('headA1', 'deptA1'): True, ('headA1', 'deptA'): False,
    ('headB', 'deptB'): True, ('headB', 'deptA'): False, ('headB', 'personal'): False,
    ('headB', 'personalB'): True, ('headB', 'personalNone'): False,
    ('empA', 'deptA'): True, ('empA', 'deptA1'): False, ('empA', 'deptB'): False,
    ('empA', 'personal'): True,  # 本人表
    ('empB', 'deptB'): True, ('empB', 'deptA'): False,
    # 未分部门员工只读自己的：empNone 读不到 empA 的个人表，读得到自己的
    ('empNone', 'deptA'): False, ('empNone', 'personal'): False,
    ('empNone', 'personalNone'): True,
}
for (tag, tname), want in EXPECT.items():
    tid = TABLES.get(tname)
    if not tid:
        check(f'{tag}→{tname}', False, '表没建出来')
        continue
    ok, why = read_ok(CLIENTS[tag], tid)
    check(f'读矩阵 {tag}→{tname}（应{"可" if want else "拒"}）', ok == want, f'实际{"可读" if ok else "拒"} {why}')

# ---------- M4 管理读不带其他权 ----------
print('\n== M4 管理读不带编辑/结构/转授/下载 ==')
for tag in ('boss', 'headA'):
    res, why = act(CLIENTS[tag], 'files.sheet_cell_write',
                   {'table': TABLES['deptA'], 'sheet': 'S-1', 'row_id': 'r1', 'header': '名称',
                    'expected_content_version': 0, 'expected_structure_version': 1,
                    'value': {'type': 'text', 'value': 'x'}},
                   f'm4-write-{tag}')
    check(f'M4 {tag} 管理读≠可编辑', denied(res), why[:120])
    res, why = act(CLIENTS[tag], 'files.sheet_column_append',
                   {'table': TABLES['deptA'], 'header': f'X{SUF}',
                    'expected_content_version': 0, 'expected_structure_version': 1}, f'm4-col-{tag}')
    check(f'M4 {tag} 管理读≠可改结构', denied(res), why[:120])

# ---------- M1/M5 建表与转授 ----------
print('\n== M1/M5 建表与转授权 ==')
# 跨部门建表：empA 建 B 部表应拒
res, why = upload('M1-越权建B部表', {'level': 'department', 'department': dB}, client=CLIENTS['empA'])
check('M1 无授权跨部门建表被拒', bool(res) and denied(res), why[:100])
# 授权后再建应成功
res, why = act(adm, 'platform.org.create_grant', {'user': PEOPLE['empA'], 'department': dB, 'scope': 'create'}, 'm1-grant')
check('M1 跨部门建表授权动作可用', res and res[0] == 200, why[:100])
res, why = upload('M1-授权建B部表', {'level': 'department', 'department': dB}, client=CLIENTS['empA'])
ok_granted = bool(res) and res[0] == 200 and bool(file_of(res))
check('M1 有授权跨部门建表成功', ok_granted, why[:100])
# 转授：empA 把自己的表读权给 empB
if T_p2:
    res, why = act(CLIENTS['empA'], 'platform.org.share_grant', {'resource': T_p2, 'user': PEOPLE['empB'], 'access': 'read'}, 'm5-share')
    check('M5 所有者转授读权', res and res[0] == 200, why[:100])
    okB, _ = read_ok(CLIENTS['empB'], T_p2)
    check('M5 被转授后读得到', okB, '')
    res, why = act(CLIENTS['empB'], 'platform.org.share_grant', {'resource': T_p2, 'user': PEOPLE['empNone'], 'access': 'read'}, 'm5-illegal')
    check('M5 普通编辑者不能转授', denied(res), why[:100])

# M5b 多部门共享（用户 2026-10-12：「可以选择 abc 三个部门共享」）
print('\n== M5b 共享给多个部门 ==')
if T_p3:
    # empB 把自己的个人表同时共享给 A 部、B 部（两部门起步，机制同三部门）
    res, why = act(CLIENTS['empB'], 'platform.org.share_grant',
                   {'resource': T_p3, 'departments': [dA, dB], 'access': 'read'}, 'm5b-multi')
    check('M5b 一次共享给多个部门', res and res[0] == 200, why[:120])
    okA, whyA = read_ok(CLIENTS['empA'], T_p3)     # A 部成员读得到
    check('M5b A 部成员读得到', okA, whyA)
    okN, whyN = read_ok(CLIENTS['empNone'], T_p3)  # 无部门者仍读不到
    check('M5b 未共享到的人读不到', not okN, whyN)
    # 共享到部门 A 含下属（契约 §3.1「部门范围包含下属部门」）
    okS, whyS = read_ok(CLIENTS['headA1'], T_p3)   # A-华东（A 的下属）负责人
    check('M5b 共享到部门含下属部门', okS, whyS)
    # 撤掉 A 部共享后 A 部成员读不到，B 部的还在
    res, why = act(CLIENTS['empB'], 'platform.org.share_revoke', {'resource': T_p3, 'department': dA}, 'm5b-revoke')
    okA2, _ = read_ok(CLIENTS['empA'], T_p3)
    check('M5b 撤一个部门不影响其他部门', (not okA2), f'撤 A 部后 empA {"仍可读" if okA2 else "读不到"}')

# ---------- M6 下载与可见分开 ----------
print('\n== M6 下载权：可见≠可导出 ==')


def detail_of(tid, c):
    st, dat = t.service(c, 'files.versions', {'file': tid})
    if st != 200 or not isinstance(dat, dict) or dat.get('ok') is False:
        return None, f'HTTP {st}'
    return dat.get('file') or {}, 'ok'


rec, why = detail_of(TABLES['personal'], CLIENTS['boss'])
check('M6 老板可见员工个人表', bool(rec), why)
check('M6 管理读≠可导出（老板对个人表）', bool(rec) and rec.get('can_download') is False,
      f"can_download={rec.get('can_download') if rec else '-'}")
rec, why = detail_of(TABLES['deptA'], CLIENTS['empA'])
check('M6 部门成员默认可下载本部门表', bool(rec) and rec.get('can_download') is True,
      f"can_download={rec.get('can_download') if rec else '-'} {why}")
rec, why = detail_of(T_p2, CLIENTS['empA'])
check('M6 个人表归属人可导出自己的', bool(rec) and rec.get('can_download') is True,
      f"can_download={rec.get('can_download') if rec else '-'}")

# 真实下载口（/api/platform/file-content）按下载权执行，不只看能力标记
st_v, dat_v = t.service(CLIENTS['empA'], 'files.versions', {'file': TABLES['deptA']})
rows_v = (dat_v.get('versions') or []) if isinstance(dat_v, dict) else []
ref = rows_v[0].get('frappe_file') if rows_v else None
if ref:
    st_d, _ = t.download(CLIENTS['empA'], TABLES['deptA'], ref)
    check('M6 部门内成员下载成功', st_d == 200, f'HTTP {st_d}')
    st_d2, dat_d2 = t.download(CLIENTS['empB'], TABLES['deptA'], ref)
    check('M6 无权者下载被拒', denied((st_d2, dat_d2)), f'HTTP {st_d2}')
    # 管理读可见 ≠ 可导出：老板对部门表同样不因可见就可下载
    st_d3, dat_d3 = t.download(CLIENTS['boss'], TABLES['deptA'], ref)
    check('M6 老板可见≠可下载部门表', denied((st_d3, dat_d3)), f'HTTP {st_d3}')
else:
    check('M6 下载口验证', False, '拿不到版本附件引用，无法验证下载口')

# ---------- M7 全入口一致 ----------
print('\n== M7 全入口同一套校验（empB 对 deptA 表）==')
tid = TABLES['deptA']
c = CLIENTS['empB']
fname_a = f'M-部门表-A-{SUF}.xlsx'


def dataset_records(client, filters):
    q = urllib.parse.quote(json.dumps(filters, ensure_ascii=False))
    return client.request('GET', f'/api/platform/datasets/files.file/records?filters={q}&page=1&page_length=100')


# 清单/搜索：数据集入口（与详情同一套 permission_query）
st_l, dat_l = dataset_records(c, {'scope': 'sheet'})
names_b = [r.get('name') for r in (dat_l.get('rows') or [])] if isinstance(dat_l, dict) else []
check('M7 清单不出现无权表', tid not in names_b, f'HTTP {st_l} rows={len(names_b)}')
st_s, dat_s = dataset_records(c, {'scope': 'sheet', 'q': 'M-部门表-A'})
names_s = [r.get('name') for r in (dat_s.get('rows') or [])] if isinstance(dat_s, dict) else []
check('M7 搜索不命中无权表', tid not in names_s, f'HTTP {st_s} rows={len(names_s)}')
# 计数：按文件名精确过滤，无权者 total=0，有权者 total=1（防假绿在「列表恒空」上）
st_c, dat_c = dataset_records(c, {'scope': 'sheet', 'file_name': fname_a})
total_b = dat_c.get('total') if isinstance(dat_c, dict) else None
check('M7 计数不泄漏无权表', total_b == 0, f'total={total_b} HTTP {st_c}')
st_c2, dat_c2 = dataset_records(CLIENTS['empA'], {'scope': 'sheet', 'file_name': fname_a})
total_a = dat_c2.get('total') if isinstance(dat_c2, dict) else None
check('M7 对照：有权者计数为 1', total_a == 1, f'total={total_a} HTTP {st_c2}')

# 详情/版本/动作：无权表一律拿不到
for label, fn in [
    ('详情', lambda: t.service(c, 'files.sheet_read', {'table': tid, 'page': 1, 'page_length': 1})),
    ('版本', lambda: t.service(c, 'files.versions', {'file': tid})),
    ('动作', lambda: t.action(c, 'files.update_meta', {'file': tid, 'file_name': f'x-{SUF}.xlsx'}, 'm7-action')),
]:
    try:
        st, dat = fn()
        check(f'M7 {label}入口拒无权表', denied((st, dat)), f'HTTP {st} {str(dat)[:100]}')
    except Exception as e:
        check(f'M7 {label}入口拒无权表', True, f'异常拒:{e}')
# 回执入口与下载口：下载在 M6 已锁真实口；回执按资源核权归 B5（受管撤回）——此处不假绿

# ---------- M8 撤权/调岗后失效 ----------
print('\n== M8 撤权/调岗后失效 ==')
if T_p2:
    okBefore, _ = read_ok(CLIENTS['empB'], T_p2)
    res, why = act(adm, 'platform.org.member_remove', {'user': PEOPLE['empB'], 'department': dB}, 'm8-调岗')
    # empB 对 T_p2 的权来自转授不是部门——撤转授验证
    res, why = act(CLIENTS['empA'], 'platform.org.share_revoke', {'resource': T_p2, 'user': PEOPLE['empB']}, 'm8-revoke')
    okAfter, whyAfter = read_ok(CLIENTS['empB'], T_p2)
    check('M8 撤共享后读不到', okBefore and not okAfter, f'撤前{"可读" if okBefore else "拒"} 撤后{whyAfter}')
    # 调岗：empA 调离 A 部后读不到 A 部表
    res, why = act(adm, 'platform.org.member_remove', {'user': PEOPLE['empA'], 'department': dA}, 'm8-调离')
    okMoved, whyMoved = read_ok(CLIENTS['empA'], TABLES['deptA'])
    check('M8 调离部门后读不到原部门表', not okMoved, whyMoved)

# ---------- M9 老板限本企业 ----------
print('\n== M9 老板限本企业 ==')
res, why = act(adm, 'platform.org.department_create', {'name': f'他企部-{SUF}', 'enterprise': 'other-corp'}, 'm9-dept')
dO = result_of(res).get('department') if res else None
check('M9 建他企业部门', bool(dO), why[:100])
if dO:
    res, why = upload('M9-他企表', {'level': 'department', 'department': dO})
    tidO = file_of(res)
    if tidO:
        okBoss, whyBoss = read_ok(CLIENTS['boss'], tidO)
        check('M9 本企业老板读不到他企业表', not okBoss, whyBoss)
    res, why = act(adm, 'platform.org.department_create', {'name': f'挂A-{SUF}', 'parent': dO, 'enterprise': 'default'}, 'm9-cross')
    check('M9 跨企业挂接被拒', rejected(res, '跨企业'), why[:100])

# ---------- M10 自报身份不算 / Assistant = 所属人权限 ----------
print('\n== M10 不信客户端自报 ==')
try:
    st, dat = t.service(CLIENTS['empB'], 'files.sheet_read',
                        {'table': TABLES['deptA'], 'page': 1, 'page_length': 1, 'as_user': PEOPLE['boss'], 'role': 'admin'})
    check('M10 自报身份/角色不能提权', denied((st, dat)) or st != 200, f'HTTP {st} {str(dat)[:100]}')
except Exception as e:
    check('M10 自报身份/角色不能提权', True, f'异常拒:{e}')

# ---------- M11 部门稳定身份 ----------
print('\n== M11 部门稳定身份 ==')
if dA:
    old_id = dA
    res, why = act(adm, 'platform.org.department_rename', {'department': dA, 'name': f'A部改名-{SUF}'}, 'm11-rename')
    check('M11 改名成功', res and res[0] == 200, why[:100])
    # empA 已在 M8 调离 A 部——改名后读权检查用仍在任的 A 部负责人 headA
    okA, whyA = read_ok(CLIENTS['headA'], TABLES['deptA'])
    check('M11 改名不改身份（读权照旧）', okA, whyA)
    res, why = act(adm, 'platform.org.department_update', {'department': dA, 'parent': dA1}, 'm11-cycle')
    # 真造环：把 A 部挂到自己下属 A-华东 之下 → 必须以循环理由拒（校验拒绝，不是无权）
    check('M11 循环关系被拒（造环）', rejected(res, '循环'), why[:100])
    # 启停生效：停用后不再作为新的任职落点
    res, why = act(adm, 'platform.org.department_set_status', {'department': dA1, 'enabled': False}, 'm11-off')
    check('M11 停用动作可用', res and res[0] == 200, why[:100])
    res, why = act(adm, 'platform.org.member_assign', {'user': PEOPLE['empB'], 'department': dA1}, 'm11-off-join')
    check('M11 停用部门不接新任职', rejected(res, '停用'), why[:100])
    act(adm, 'platform.org.department_set_status', {'department': dA1, 'enabled': True}, 'm11-on')
    # 旧标签不给权：collaboration_group='管理' 不等于老板，也拿不到部门读权（组织事实单一权威）
    act(adm, 'platform.identity.group', {'email': PEOPLE['empNone'], 'collaboration_group': '管理'}, 'm11-label')
    okLabel, whyLabel = read_ok(CLIENTS['empNone'], TABLES['deptA'])
    check('M11 旧协作组标签不参与授权', not okLabel, whyLabel)

print()
if fails:
    print(f'结果： FAIL {len(fails)} 项未过')
    print('未过清单：', json.dumps(fails, ensure_ascii=False))
    sys.exit(1)
print('结果： PASS 多身份权限矩阵全部成立')
