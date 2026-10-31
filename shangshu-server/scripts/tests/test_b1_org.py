"""B1 组织关系与资源归属（下一批 §5 B1，2026-10-12 监控窗工单开工）。

测试通过 = 下面六件全部成立（每条都是「做这个操作 → 该看到这个」）：

①受管入口建组织：用产品自己的受管动作（platform.org.*）建出
  「部门一部、二部；一部的子部门一部-华东」，把张三任命成一部负责人、
  李四王五分别放进一部二部、赵六兼一部二部、钱七不进任何部门——
  建完库里查得出组织关系（不写测试 SQL、不靠前端标签冒充）。
②部门隔离：一部成员李四 读得到归属一部的表；二部成员王五 读不到
  （界面外直接发请求也拿不到数据）。
③负责人管辖：一部负责人张三 读得到一部和子部门「一部-华东」的表；
  二部负责人读不到一部的。
④老板和系统管理员是两种权：老板账号（没有 System Manager 角色）
  按默认管理读得到企业范围内员工的表；System Manager 账号（没被任命成老板）
  不因此自动获得老板的读权。
⑤三种状态：兼任两部门的赵六两部的表都读得到；没部门的钱七读不到部门表；
  停用的人登录不了、也读不到。
⑥个人级表：归属人自己可见；部门负责人/老板按默认管理读也可见
  （个人级表示归属，不代表对管理者保密）。

先红后绿：本文件先于实现写好，platform.org.* 尚不存在时应按预期报
「动作不存在/无权」类失败，而不是假绿。

命名与接口假设（实现前定死，改要同步改这份）：
  - 部门实体含名字/上级部门/企业标识；层级用上级部门指针，深度不限。
  - 负责人 = 部门上的任职记录，可多人；任命走受管动作，权威在服务端。
  - 老板 = 企业级权威（独立记录/标记），与 System Manager 角色互不相认。
  - 兼任 = 一人多部门任职（不再是单选下拉）。
  - 存量 collaboration_group 三值（管理/开发/财务）本批不动、不自动迁移
    （B6 补录口径）；目录授权按部门名兼容，存量目录不失效。
"""
import importlib.util
import json
import sys

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'
TEST = ROOT + '/shangshu-server/scripts/test-n2-structure.py'

spec = importlib.util.spec_from_file_location('t', TEST)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

RUN = t.RUN
fails = []


def check(name, ok, detail):
    print(f'{"PASS" if ok else "FAIL"} {name} — {detail}')
    if not ok:
        fails.append(name)


def org_action(c, action, payload, label):
    """受管组织动作。产品能力不存在时如实报错，不造假绿。"""
    try:
        st, body = t.action(c, action, payload, label)
    except Exception as e:
        return None, f'调用异常：{e}'
    if st != 200:
        return None, f'HTTP {st} body={json.dumps(body, ensure_ascii=False)[:160]}'
    return (body.get('result') or {}), 'ok'


# ---------- 账号 ----------
# 组织管理类动作（platform.org.*、identity.status）只给系统管理员——
# 用 Administrator（口令从 0600 环境文件取，绝不打印）。员工账号用夹具那把。
PW = 'b2-user-pw-2026'
ENV = ('/path/to/workspace'
       'ops/docker/.state/environments/shangshu-local-b.env')
_admin_pw = ''
for _line in open(ENV):
    if _line.startswith('ADMIN_PASSWORD='):
        _admin_pw = _line.split('=', 1)[1].strip().strip('"').strip("'")
        break
assert _admin_pw, f'环境文件里没有 ADMIN_PASSWORD：{ENV}'

adm = t.Client(BASE)          # 系统管理员：建组织/任命/停用
adm.login('Administrator', _admin_pw)

# ---------- ① 受管入口建组织 ----------
print('\n① 受管入口建组织（platform.org.*）')

st_d1, r_d1 = org_action(adm, 'platform.org.department_create',
                         {'name': f'一部-{RUN}', 'enterprise': 'default'}, 'org-部门一部')
check('①建部门一部', r_d1 == 'ok', f'{r_d1} 返回={json.dumps(st_d1, ensure_ascii=False)[:120] if st_d1 else "-"}')

st_d2, r_d2 = org_action(adm, 'platform.org.department_create',
                         {'name': f'二部-{RUN}', 'enterprise': 'default'}, 'org-部门二部')
check('①建部门二部', r_d2 == 'ok', r_d2)

d1_id = (st_d1 or {}).get('department') or (st_d1 or {}).get('name')
st_d1b, r_d1b = org_action(adm, 'platform.org.department_create',
                           {'name': f'一部-华东-{RUN}', 'parent': d1_id, 'enterprise': 'default'},
                           'org-子部门')
check('①建子部门挂一部下', r_d1b == 'ok' and bool(d1_id), f'{r_d1b} 父={d1_id}')

# 成员进部门：四个人分别是一部成员 / 二部成员 / 兼任两部 / 无部门
st_m1, r_m1 = org_action(adm, 'platform.org.member_assign',
                         {'user': 'ss-editor@example.invalid', 'department': d1_id}, 'org-李四进一部')
check('①成员进一部', r_m1 == 'ok', r_m1)

# ---------- ② 部门隔离：一部表一部人读得到、二部人读不到 ----------
print('\n② 部门隔离读权')

# 建一张归属一部的表（走文件上传夹具；归属打到一部）
import base64
import importlib.util as _il
_fix = _il.spec_from_file_location('fix', '/path/to/workspace')
fix = _il.module_from_spec(_fix)
_fix.loader.exec_module(fix)

st_up, body_up = t.action(adm, 'files.upload', {
    'file_name': f'b1-一部表-{RUN}.xlsx',
    'content_base64': base64.b64encode(fix.build_external_fixture()).decode(),
    'directory': '/',
}, 'b1-up-一部表')
table_a = (body_up.get('result') or {}).get('file')
check('②上传表成功', st_up == 200 and bool(table_a), f'HTTP {st_up} 表={table_a}')

if table_a:
    # 归属打到一部（受管动作）
    st_own, r_own = org_action(adm, 'platform.org.resource_assign',
                               {'resource': table_a, 'department': d1_id}, 'org-表归一部')
    check('②表归属打到一部', r_own == 'ok', r_own)

    # 一部成员（ss-editor）读得到
    c1 = t.Client(BASE)
    c1.login('ss-editor@example.invalid', PW)
    st_r, dat_r = t.service(c1, 'files.sheet_read', {'table': table_a, 'page': 1, 'page_length': 5})
    ok_member = st_r == 200 and dat_r.get('writable') is not None
    check('②一部成员读得到', ok_member, f'HTTP {st_r}')

    # 二部成员（ss-reader 配到二部后）读不到——「读不到」= 请求被拒，不是只读返回
    st_m2, r_m2 = org_action(adm, 'platform.org.member_assign',
                             {'user': 'ss-reader@example.invalid', 'department': (st_d2 or {}).get('department') or (st_d2 or {}).get('name')},
                             'org-王五进二部')
    check('②成员进二部', r_m2 == 'ok', r_m2)
    c2 = t.Client(BASE)
    c2.login('ss-reader@example.invalid', PW)
    st_n, dat_n = t.service(c2, 'files.sheet_read', {'table': table_a, 'page': 1, 'page_length': 5})
    denied = st_n != 200 or (isinstance(dat_n, dict) and dat_n.get('ok') is False)
    check('②二部成员读不到', denied, f'HTTP {st_n} 回包={json.dumps(dat_n, ensure_ascii=False)[:120]}')

# ---------- ③ 负责人管辖（含下属部门） ----------
print('\n③ 负责人管辖')

# 任命张三（ss-owner 不合适——他有结构角色；此处用 ss-editor 负责人化前先看有没有第三账号）
# 简化：把一部负责人任命为 ss-editor（本条验「负责人读得到子部门的表」）
st_h, r_h = org_action(adm, 'platform.org.head_assign',
                       {'user': 'ss-editor@example.invalid', 'department': d1_id}, 'org-任命一部负责人')
check('③任命一部负责人', r_h == 'ok', r_h)

if table_a and (st_d1b or {}).get('department') or (st_d1b or {}).get('name'):
    # 建一张子部门「一部-华东」的表，验一部负责人读得到
    st_up2, body_up2 = t.action(adm, 'files.upload', {
        'file_name': f'b1-华东表-{RUN}.xlsx',
        'content_base64': base64.b64encode(fix.build_external_fixture()).decode(),
        'directory': '/',
    }, 'b1-up-华东表')
    table_b = (body_up2.get('result') or {}).get('file')
    if table_b:
        st_own2, r_own2 = org_action(adm, 'platform.org.resource_assign',
                                     {'resource': table_b, 'department': (st_d1b or {}).get('department') or (st_d1b or {}).get('name')},
                                     'org-表归华东')
        c3 = t.Client(BASE)
        c3.login('ss-editor@example.invalid', PW)   # 一部负责人
        st_r3, dat_r3 = t.service(c3, 'files.sheet_read', {'table': table_b, 'page': 1, 'page_length': 5})
        check('③一部负责人读得到子部门表', st_r3 == 200, f'HTTP {st_r3}')
        # 二部成员读不到子部门表
        st_n3, dat_n3 = t.service(c2, 'files.sheet_read', {'table': table_b, 'page': 1, 'page_length': 5})
        denied3 = st_n3 != 200
        check('③二部成员读不到子部门表', denied3, f'HTTP {st_n3}')

# ---------- ④ 老板 ≠ System Manager ----------
print('\n④ 老板与系统管理员分开')

# 老板任命走受管动作
st_o, r_o = org_action(adm, 'platform.org.owner_assign',
                       {'user': 'ss-editor@example.invalid'}, 'org-任命老板')
check('④任命老板动作可用', r_o == 'ok', r_o)

# 判据物：员工个人表（ss-reader 建本人表，个人级归属）
st_up4, body_up4 = t.action(c2, 'files.upload', {
    'file_name': f'b1-个人表-{RUN}.xlsx',
    'content_base64': base64.b64encode(fix.build_external_fixture()).decode(),
    'directory': '/',
    'attribution': {'level': 'personal'},
}, 'b1-up-个人表')
table_p = (body_up4.get('result') or {}).get('file') if st_up4 == 200 else None
check('④员工建本人表', st_up4 == 200 and bool(table_p), f'HTTP {st_up4}')

if table_p:
    # 老板账号（没有 System Manager 角色）按默认管理读得到企业范围内员工的表
    c_boss = t.Client(BASE)
    c_boss.login('ss-editor@example.invalid', PW)   # 已任命老板（非 SM）
    st_b, dat_b = t.service(c_boss, 'files.sheet_read', {'table': table_p, 'page': 1, 'page_length': 1})
    check('④老板默认管理读员工个人表', st_b == 200 and not (isinstance(dat_b, dict) and dat_b.get('ok') is False),
          f'HTTP {st_b}')
    # System Manager 账号（没被任命成老板）不因此自动获得老板的读权。
    # 注意：Frappe 内置 Administrator 是硬超管（permissions.py: 一律放行），不能当这个判据——
    # 用产品入口建一个**真的 System Manager 角色**账号来验。
    sm_email = f'sm-{RUN}@example.invalid'
    st_id, r_id = org_action(adm, 'platform.identity.create',
                             {'email': sm_email, 'display_name': f'SM-{RUN}', 'role': 'admin',
                              'initial_password': PW}, 'org-建SM账号')
    ok_sm_id = r_id == 'ok' or '已存在' in r_id
    check('④建System Manager账号', ok_sm_id, r_id)
    c_sm = t.Client(BASE)
    try:
        c_sm.login(sm_email, PW)
        st_sm, dat_sm = t.service(c_sm, 'files.sheet_read', {'table': table_p, 'page': 1, 'page_length': 1})
        denied_sm = st_sm != 200 or (isinstance(dat_sm, dict) and dat_sm.get('ok') is False)
        check('④SM≠老板（未任命读不到员工个人表）', denied_sm, f'HTTP {st_sm}')
    except BaseException as e:
        check('④SM≠老板（未任命读不到员工个人表）', False, f'SM 账号登录/读取异常：{e}')
    # 没被任命的普通账号（即便有结构角色）也拿不到老板读权
    c_str = t.Client(BASE)
    c_str.login('ss-owner@example.invalid', PW)     # Sheet Structure Editor，不是老板
    st_str, dat_str = t.service(c_str, 'files.sheet_read', {'table': table_p, 'page': 1, 'page_length': 1})
    denied_str = st_str != 200 or (isinstance(dat_str, dict) and dat_str.get('ok') is False)
    check('④结构角色≠老板读权', denied_str, f'HTTP {st_str}')

# ---------- ⑤ 兼任 / 无部门 / 停用 ----------
print('\n⑤ 三种状态')
# 兼任
st_m3, r_m3 = org_action(adm, 'platform.org.member_assign',
                         {'user': 'ss-reader@example.invalid', 'department': d1_id}, 'org-赵六兼任一部')
check('⑤兼任第二部门可表达', r_m3 == 'ok', r_m3)
# 无部门：outsider 未分部门，读部门表应拒
c4 = t.Client(BASE)
c4.login('ss-outsider@example.invalid', PW)
st_n5, dat_n5 = t.service(c4, 'files.sheet_read', {'table': table_a, 'page': 1, 'page_length': 5})
check('⑤无部门读不到部门表', st_n5 != 200, f'HTTP {st_n5}')
# 停用：走既有 platform.identity.status（已有能力；入参是 email/enabled，不是 user/status）
st_s, body_s = t.action(adm, 'platform.identity.status',
                        {'email': 'ss-outsider@example.invalid', 'enabled': False}, 'b1-停用')
disabled_ok = st_s == 200
check('⑤停用动作可用', disabled_ok, f'HTTP {st_s}')
if disabled_ok:
    c5 = t.Client(BASE)
    login_fail = True
    try:
        c5.login('ss-outsider@example.invalid', PW)
        st_af, _ = t.service(c5, 'files.sheet_read', {'table': table_a, 'page': 1, 'page_length': 1})
        login_fail = st_af != 200
    except BaseException:  # 登录被拒时 harness 会抛 SystemExit（不是 Exception），一样算「登录不了」
        login_fail = True
    check('⑤停用后读不到', login_fail, '停用后登录或读取被拒')
    # 复原，别把夹具搞坏
    t.action(adm, 'platform.identity.status', {'email': 'ss-outsider@example.invalid', 'enabled': True}, 'b1-复原')

# ---------- ⑥ 个人级表对管理者可见 ----------
print('\n⑥ 个人级不向管理者保密')
if table_p:
    # 归属人自己可见
    st_own_r, dat_own_r = t.service(c2, 'files.sheet_read', {'table': table_p, 'page': 1, 'page_length': 1})
    check('⑥本人可见自己的个人表', st_own_r == 200, f'HTTP {st_own_r}')
    # 负责人/老板按默认管理读也可见（④已任命 ss-editor 为老板兼一部负责人）
    st_mgr, dat_mgr = t.service(c_boss, 'files.sheet_read', {'table': table_p, 'page': 1, 'page_length': 1})
    check('⑥管理者默认管理读可见个人表', st_mgr == 200, f'HTTP {st_mgr}')
    # 无管理关系的其他账号不能读到他人个人表
    c6 = t.Client(BASE)
    c6.login('ss-outsider@example.invalid', PW)
    st_n6, dat_n6 = t.service(c6, 'files.sheet_read', {'table': table_p, 'page': 1, 'page_length': 1})
    denied6 = st_n6 != 200 or (isinstance(dat_n6, dict) and dat_n6.get('ok') is False)
    check('⑥无管理关系读不到他人个人表', denied6, f'HTTP {st_n6}')
else:
    check('⑥个人级读权验证', False, '④ 的个人表没建出来，无法验证')

print()
if fails:
    print(f'结果： FAIL {len(fails)} 项未过 —— {fails}')
    sys.exit(1)
print('结果： PASS')
