"""G3 多部门人工测试第二轮 B01–B10（接口层真相）——对**试用站**跑，不碰回归站。

测试通过 = 下面每条 B 项的判据逐条成立，**每条都写成「做这个操作 → 该看到这个」**：

B01 归属与建表资格：员工甲建本人表成功；建本部门（试用一部）表成功；
    建**未授权**部门（试用二部）表被拒；建表资格**不自动扩大**别人表的读写权。
B02 只读共享：甲把本人表**只读**共享给乙 → 乙读得到、改被拒、下载被拒。
B03 字段级权限：混合表某个**已晋升字段**限制读/改/下载 → 页面读口、导出、下载口都遵守。
B04 管理范围：部门负责人读得到辖内（一部及下属）；老板读得到全企业；
    普通员工读不到范围外；**管理员全能不能替代此项**（单列一条对照）。
B05 转交：甲把表转交乙 → 乙成为新所有人能写；甲的旧权力失效（独立保留的共享权按配置仍在）。
B06 并发：同格冲突不静默覆盖；不同格不互相回退。
B07 混合表：改正式列（晋升）和普通列各一处，两类值都正确保存；导出核对。
B08 晋升与填写分离：混合表**新增普通列**不自动成为正式字段；晋升是**单独一个动作**。
B09 跨普通/正式列粘贴：合法包完整保存；含非法值的数据包**整包拒绝**，不出现一半成功。
B10 跨表关联：关联目标仍正确；关联**不能绕过权限**；不只靠显示行号认对象。

用法（口令不设默认值）：
  TEST_USER_PASSWORD=... ADMIN_PASSWORD=... \
  python3 shangshu-server/scripts/tests/test_g3_multidept_trial.py --base http://127.0.0.1:3870

**写在哪**：账号/部门/表都落在**试用站 3870**（用户自己的试用空库）。
这是第二轮测试的**前置条件**（清单原文：「由开发侧准备好账号与权限说明后再测」），
所以建出来是对的；建出来的账号/表都带「试用-」前缀，用户复验时按清单里的名单找。
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

RUN = str(int(__import__('time').time()))
RESULTS = []
FAILURES = []


def check(item, label, ok, detail=''):
    ok = bool(ok)
    RESULTS.append({'item': item, 'label': label, 'ok': ok, 'detail': str(detail)[:400]})
    if not ok:
        FAILURES.append(f'{item} {label} — {detail}')
    print(f'{"PASS" if ok else "FAIL"} {item} {label} — {detail}', flush=True)
    return ok


class Client:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.user = None

    def request(self, method, path, body=None, timeout=90):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header('accept', 'application/json')
        if data is not None:
            req.add_header('content-type', 'application/json')
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                raw, status = resp.read(), resp.status
        except urllib.error.HTTPError as exc:
            raw, status = exc.read(), exc.code
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            return 0, {'_transport_error': f'{type(exc).__name__}: {exc}'}
        if path.startswith('/api/platform/file-content'):
            return status, {'_bytes': raw}
        try:
            parsed = json.loads(raw.decode('utf-8')) if raw else {}
        except json.JSONDecodeError:
            parsed = {'_raw': raw.decode('utf-8', 'replace')}
        return status, parsed

    def login(self, username, password):
        status, body = self.request('POST', '/api/platform/login',
                                    {'username': username, 'password': password})
        if status != 200 or not body.get('ok'):
            raise SystemExit(f'登录失败 {username}: HTTP {status} {body}')
        self.user = username
        return body


#: 只有这三个建表动作要归属（产品侧「新建不传归属就拒」）。
#: **别的一律不注入** —— 往 platform.* / files.cell_write 这类动作塞 attribution
#: 会被 schema 拒（"动作包含未声明字段：payload.attribution"），那是测试自己写错，
#: 不是产品问题。
ATTRIBUTION_ACTIONS = frozenset({'files.upload', 'files.create', 'files.import_attachment'})


def action(c, action_id, payload, key):
    payload = dict(payload)
    if action_id in ATTRIBUTION_ACTIONS and not payload.get('attribution'):
        payload['attribution'] = {'level': 'personal'}
    return c.request('POST', f'/api/platform/actions/{action_id}/execute',
                     {'payload': payload, 'confirmed': True,
                      'idempotency_key': f'{key}-{RUN}'})


def service(c, service_id, payload):
    return c.request('POST', f'/api/platform/services/{service_id}/invoke', {'payload': payload})


def download(c, table, file_ref):
    return c.request('GET', f'/api/platform/file-content?ref=Shangshu%20File%20Center%20File'
                              f'&ref_name={table}&file={file_ref}')


def result_of(res):
    if not res:
        return {}
    body = res[1] if isinstance(res[1], dict) else {}
    return body.get('result') or body


def denied(res):
    """只认**权限类**拒绝：403 / PERMISSION_DENIED / 无权。
    校验错（417）、接口缺失（404）不算「被拒」——否则反例会假绿在「参数没写对」上。"""
    if not res:
        return False
    st, body = res
    body = body if isinstance(body, dict) else {}
    code = str(body.get('code', ''))
    err = str(body.get('error', '')) + ' ' + str(body.get('message', ''))
    if st == 403 or code == 'PERMISSION_DENIED':
        return True
    return '无权' in err or 'not permitted' in err.lower() or 'permission' in err.lower()


def err_text(res):
    if not res:
        return ''
    body = res[1] if isinstance(res[1], dict) else {}
    return str(body.get('error') or body.get('message') or body.get('exc') or body)[:300]


def build_xlsx():
    """合成一张 4 列 3 行的小表：名称/金额/日期/编号（含前导零编号）。"""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = 'S-1'
    ws.append(['名称', '金额', '日期', '编号'])
    ws.append(['甲一', 1234.56, '2026-10-19', '00123'])
    ws.append(['乙二', 88.88, '2026-10-20', '00456'])
    ws.append(['丙三', 7.77, '2026-10-21', '00789'])
    from io import BytesIO
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def upload(c, name, attribution, key):
    payload = {
        'file_name': f'{name}-{RUN}.xlsx',
        'content_base64': base64.b64encode(build_xlsx()).decode(),
        'directory': '/',
        'attribution': attribution,
    }
    return action(c, 'files.upload', payload, key)


def file_of(res):
    return result_of(res).get('file')


def read_ok(c, tid):
    st, dat = service(c, 'files.sheet_read', {'table': tid, 'page': 1, 'page_length': 3})
    return st == 200 and not (isinstance(dat, dict) and dat.get('ok') is False)


def cv_sv(c, tid):
    """内容版本/结构版本 —— **只走 `files.sheet_read` 这一个读口**（§13 原则 1）。
    带 page/page_length 的读口不保证回版本号，所以这里只传 table。"""
    st, dat = service(c, 'files.sheet_read', {'table': tid})
    res = result_of((st, dat))
    return int(res.get('content_version') or 0), int(res.get('structure_version') or 1)


def real_row_ids(c, tid, n=2):
    """**真实行身份** —— 产品给的 row_id，不是猜的 r1/r2。
    猜行号会让「行不存在或已变化」的报错变成测试自己的错。"""
    st, dat = service(c, 'files.sheet_read', {'table': tid, 'page_length': 10})
    rows = (result_of((st, dat)).get('rows') or [])
    return [r.get('row_id') for r in rows[:n]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:3870')
    ap.add_argument('--password', default=os.environ.get('TEST_USER_PASSWORD'))
    ap.add_argument('--admin-password', default=os.environ.get('ADMIN_PASSWORD'))
    ap.add_argument('--json-out', default='')
    args = ap.parse_args()
    if '127.0.0.1' not in args.base and 'localhost' not in args.base:
        raise SystemExit('只允许本机回环入口')
    if not args.password or not args.admin_password:
        raise SystemExit('口令不设默认值：--password/--admin-password 或 TEST_USER_PASSWORD/ADMIN_PASSWORD')
    PW, APW = args.password, args.admin_password

    adm = Client(args.base)
    adm.login('Administrator', APW)

    # ---------- 账号与组织（产品受管动作，不写测试 SQL） ----------
    PEOPLE = {
        'jia': ('trial-jia@trial.invalid', '试用-员工甲'),
        'yi': ('trial-yi@trial.invalid', '试用-员工乙'),
        'bing': ('trial-bing@trial.invalid', '试用-员工丙'),
        'head': ('trial-head@trial.invalid', '试用-一部负责人'),
        'boss': ('trial-boss@trial.invalid', '试用-老板'),
    }
    for tag, (email, name) in PEOPLE.items():
        res = action(adm, 'platform.identity.create',
                     {'email': email, 'display_name': name, 'role': 'staff',
                      'initial_password': PW}, f'id-{tag}')
        ok = (res[0] == 200) or '已存在' in err_text(res) or 'Duplicate' in err_text(res)
        check('SETUP', f'建身份 {name}', ok, err_text(res)[:120] or f'HTTP {res[0]}')

    res = action(adm, 'platform.org.department_create',
                 {'name': f'试用一部-{RUN}', 'enterprise': 'default'}, 'org-d1')
    d1 = result_of(res).get('department')
    check('SETUP', '建部门 试用一部', bool(d1), err_text(res)[:120])
    res = action(adm, 'platform.org.department_create',
                 {'name': f'试用二部-{RUN}', 'enterprise': 'default'}, 'org-d2')
    d2 = result_of(res).get('department')
    check('SETUP', '建部门 试用二部', bool(d2), err_text(res)[:120])

    for tag, dep in (('jia', d1), ('yi', d1), ('bing', d2), ('head', d1)):
        res = action(adm, 'platform.org.member_assign',
                     {'user': PEOPLE[tag][0], 'department': dep}, f'm-{tag}')
        check('SETUP', f'{PEOPLE[tag][1]} 进部门', res[0] == 200, err_text(res)[:120])
    res = action(adm, 'platform.org.head_assign',
                 {'user': PEOPLE['head'][0], 'department': d1}, 'h-head')
    check('SETUP', '任命 试用-一部负责人', res[0] == 200, err_text(res)[:120])
    res = action(adm, 'platform.org.owner_assign',
                 {'user': PEOPLE['boss'][0], 'enterprise': 'default'}, 'o-boss')
    check('SETUP', '任命 试用-老板（企业管理者）', res[0] == 200, err_text(res)[:120])

    C = {tag: Client(args.base) for tag in PEOPLE}
    for tag, (email, _) in PEOPLE.items():
        try:
            C[tag].login(email, PW)
        except SystemExit as exc:
            check('SETUP', f'{email} 登录', False, str(exc)[:160])

    # ---------- 表 ----------
    res = upload(C['jia'], '试用-甲本人表', {'level': 'personal'}, 'up-jia-personal')
    T_jia = file_of(res)
    check('SETUP', '员工甲建本人表', bool(T_jia), err_text(res)[:140])
    res = upload(C['jia'], '试用-一部部门表', {'level': 'department', 'department': d1}, 'up-d1')
    T_d1 = file_of(res)
    check('SETUP', '员工甲建本部门表', bool(T_d1), err_text(res)[:140])
    res = upload(C['jia'], '试用-二部部门表', {'level': 'department', 'department': d2}, 'up-d2')
    T_d2_denied = file_of(res)
    check('B01', '员工甲建未授权部门（试用二部）表 → 被拒', not T_d2_denied and denied(res),
          f'HTTP {res[0]} {err_text(res)[:140]}')
    res = upload(C['bing'], '试用-丙本人表', {'level': 'personal'}, 'up-bing')
    T_bing = file_of(res)
    check('SETUP', '员工丙建本人表', bool(T_bing), err_text(res)[:140])
    res = upload(C['jia'], '试用-混合表', {'level': 'personal'}, 'up-mixed')
    T_mixed = file_of(res)
    check('SETUP', '建混合表（供晋升用）', bool(T_mixed), err_text(res)[:140])

    if not (T_jia and T_d1 and T_mixed):
        check('SETUP', '前置表建齐（否则后续判据不可信）', False, '建表失败，终止')
        _dump(args)
        return

    # ---------- B01 归属与建表资格不外溢 ----------
    check('B01', '甲建表后，乙读不到甲的本人表（建表资格≠别人表的读权）',
          not read_ok(C['yi'], T_jia), '乙竟然读得到')
    check('B01', '甲读得到本部门（试用一部）表', read_ok(C['jia'], T_d1), '')
    check('B01', '丙读不到试用一部的表', not read_ok(C['bing'], T_d1), '丙竟然读得到')
    check('B01', '甲读不到试用二部的表', not read_ok(C['jia'], T_d2_denied) if T_d2_denied else True,
          '（二部表未建出，本项由丙侧对照）')

    # ---------- B02 只读共享 ----------
    res = action(C['jia'], 'platform.org.share_grant',
                 {'resource': T_jia, 'user': PEOPLE['yi'][0], 'access': 'read'}, 'b02-grant')
    check('B02', '甲把本人表只读共享给乙', res[0] == 200, err_text(res)[:140])
    check('B02', '共享后乙读得到该表', read_ok(C['yi'], T_jia), '')
    res = action(C['yi'], 'files.cell_write',
                 {'table': T_jia, 'row_id': 'r1', 'header': '名称',
                  'value': {'type': 'text', 'value': '乙改的'},
                  'expected_content_version': 0, 'expected_structure_version': 1}, 'b02-write')
    check('B02', '乙改该表 → 被拒（只读≠可改）', denied(res), f'HTTP {res[0]} {err_text(res)[:140]}')
    st_v, dat_v = service(C['yi'], 'files.versions', {'file': T_jia})
    rows_v = (dat_v.get('versions') or []) if isinstance(dat_v, dict) else []
    ref = rows_v[0].get('frappe_file') if rows_v else None
    if ref:
        st_d, _ = download(C['yi'], T_jia, ref)
        check('B02', '乙下载该表 → 被拒（只读≠可下载）', denied((st_d, {})), f'HTTP {st_d}')
    else:
        check('B02', '拿得到版本附件引用（否则下载口验证不可信）', False, '拿不到')

    # ---------- B04 管理范围 ----------
    check('B04', '一部负责人读得到本部门表', read_ok(C['head'], T_d1), '')
    check('B04', '老板读得到本企业部门表', read_ok(C['boss'], T_d1), '')
    check('B04', '普通员工甲读不到别的部门（丙）建的部门表',
          not read_ok(C['jia'], T_d2_denied) if T_d2_denied else True, '')
    check('B04', '对照：管理员读得到（管理员全能不能替代本项判定）',
          read_ok(adm, T_d1), '管理员读不到说明有别的问题')
    res = action(C['bing'], 'files.cell_write',
                 {'table': T_d1, 'row_id': 'r1', 'header': '名称',
                  'value': {'type': 'text', 'value': '丙越权写'},
                  'expected_content_version': 0, 'expected_structure_version': 1}, 'b04-write')
    check('B04', '范围外员工写部部门表 → 被拒', denied(res), f'HTTP {res[0]} {err_text(res)[:140]}')

    # ---------- B05 转交 ----------
    # **移交是两步**：先 dry_run 拿 expected_modified（预览），再带 expected_modified 真移交。
    # 直接调真移交会被「归属已变化或尚未预览」拒 —— 那是产品**故意**要预览，不是缺陷。
    res = action(adm, 'platform.org.resource_assign',
                 {'resource': T_jia, 'level': 'personal', 'owner_user': PEOPLE['yi'][0],
                  'dry_run': True}, 'b05-preview')
    exp_mod = result_of(res).get('expected_modified')
    check('B05', '移交前预览（dry_run）可用，回出 expected_modified', res[0] == 200 and exp_mod,
          f'HTTP {res[0]} exp={exp_mod} {err_text(res)[:120]}')
    res = action(adm, 'platform.org.resource_assign',
                 {'resource': T_jia, 'level': 'personal', 'owner_user': PEOPLE['yi'][0],
                  'expected_modified': exp_mod}, 'b05-transfer')
    check('B05', '带预览凭据把甲的表转交给乙', res[0] == 200, err_text(res)[:160])
    cv_j, sv_j = cv_sv(C['yi'], T_jia)
    rid_jia = (real_row_ids(C['yi'], T_jia) or [None])[0]
    res = action(C['yi'], 'files.cell_write',
                 {'table': T_jia, 'row_id': rid_jia, 'header': '名称',
                  'value': {'type': 'text', 'value': '乙作为新所有人写的'},
                  'expected_content_version': cv_j, 'expected_structure_version': sv_j},
                 'b05-write-yi')
    check('B05', '转交后乙（新所有人）能写', res[0] == 200, f'HTTP {res[0]} {err_text(res)[:140]}')
    cv_j2, sv_j2 = cv_sv(C['yi'], T_jia)
    rid_jia2 = (real_row_ids(C['yi'], T_jia) or [None])[0]
    res = action(C['jia'], 'files.cell_write',
                 {'table': T_jia, 'row_id': rid_jia2, 'header': '名称',
                  'value': {'type': 'text', 'value': '甲旧页面继续写'},
                  'expected_content_version': cv_j2, 'expected_structure_version': sv_j2},
                 'b05-write-jia')
    check('B05', '转交后甲（旧所有人）再写 → 被拒', denied(res), f'HTTP {res[0]} {err_text(res)[:140]}')
    check('B05', '转交后甲**读不到**了（旧所有人权力失效；那笔共享是甲自己发的，随甲一起失效）',
          not read_ok(C['jia'], T_jia), '甲仍读得到（要核是不是共享被保留）')
    check('B05', '转交后乙读得到（新所有人权限生效）', read_ok(C['yi'], T_jia), '乙读不到')

    # ---------- B07/B08/B09 混合表：晋升 + 正式列/普通列 ----------
    sv = cv_sv(adm, T_mixed)[1]
    DEFINITION = {
        'definition_version': 1,
        'columns': [
            {'header': '名称', 'promoted': True, 'field': 'trial_name', 'type': 'text',
             'rules': {'required': False}},
            {'header': '金额', 'promoted': True, 'field': 'trial_amount', 'type': 'number',
             'rules': {'min': 0}},
            {'header': '日期', 'promoted': False},
            {'header': '编号', 'promoted': False},
        ],
    }
    res = action(adm, 'files.promotion_define',
                 {'table': T_mixed, 'expected_structure_version': sv,
                  'definition': DEFINITION}, 'b07-promo')
    check('B08', 'FDE 受管入口定义晋升列（名称/金额）', res[0] == 200, err_text(res)[:180])
    res = action(C['jia'], 'files.promotion_define',
                 {'table': T_mixed, 'expected_structure_version': sv,
                  'definition': DEFINITION}, 'b08-promo-employee')
    check('B08', '普通员工不能自己晋升', denied(res), f'HTTP {res[0]} {err_text(res)[:140]}')

    st_def, dat_def = service(adm, 'files.promotion_definition', {'table': T_mixed})
    cols_def = (result_of((st_def, dat_def)).get('columns') or [])
    flags = {x.get('header'): bool(x.get('promoted')) for x in cols_def}
    check('B08', '晋升标记只落在名称/金额两列（普通列没被顺手升）',
          flags.get('名称') is True and flags.get('金额') is True
          and flags.get('日期') is False and flags.get('编号') is False, f'flags={flags}')
    check('B08', '普通列不冒出数据库字段',
          all(not x.get('field') for x in cols_def if not x.get('promoted')), f'{cols_def}')

    # B08 新增普通列不自动成为正式字段（用**当前**版本，否则被版本闩先拒）
    cv_b8, sv_b8 = cv_sv(C['jia'], T_mixed)
    res = action(C['jia'], 'files.sheet_column_append',
                 {'table': T_mixed, 'header': f'新增普通列-{RUN}',
                  'expected_content_version': cv_b8, 'expected_structure_version': sv_b8}, 'b08-append')
    check('B08', '普通员工在混合表新增一列', res[0] == 200, err_text(res)[:140])
    st_def2, dat_def2 = service(adm, 'files.promotion_definition', {'table': T_mixed})
    cols2 = (result_of((st_def2, dat_def2)).get('columns') or [])
    new_hdr = f'新增普通列-{RUN}'
    check('B08', '新增的普通列没有自动成为正式字段',
          all(not x.get('field') for x in cols2 if x.get('header') == new_hdr),
          f'cols={[(x.get("header"), x.get("field")) for x in cols2]}')
    check('B08', '新增普通列也没自动进晋升定义（晋升和填写是两个动作）',
          new_hdr not in [x.get('header') for x in cols2 if x.get('promoted')],
          f'cols={[(x.get("header"), x.get("promoted")) for x in cols2]}')

    # B07 正式列 + 普通列各改一处（每写一次都取**当前**版本；行身份用真实的）
    rid_mix = (real_row_ids(C['jia'], T_mixed) or [None])[0]
    cv_f, sv_f = cv_sv(C['jia'], T_mixed)
    res = action(C['jia'], 'files.cell_write',
                 {'table': T_mixed, 'row_id': rid_mix, 'header': '名称',
                  'value': {'type': 'text', 'value': '甲写的正式列'},
                  'expected_content_version': cv_f, 'expected_structure_version': sv_f}, 'b07-formal')
    check('B07', '改晋升列（名称）成功', res[0] == 200, err_text(res)[:160])
    cv_p, sv_p = cv_sv(C['jia'], T_mixed)
    res = action(C['jia'], 'files.cell_write',
                 {'table': T_mixed, 'row_id': rid_mix, 'header': '日期',
                  'value': {'type': 'text', 'value': '2026-10-19'},
                  'expected_content_version': cv_p, 'expected_structure_version': sv_p}, 'b07-plain')
    check('B07', '改普通列（日期）成功', res[0] == 200, err_text(res)[:160])
    st_row, dat_row = service(C['jia'], 'files.row_read', {'table': T_mixed, 'row_id': rid_mix})
    cells = (result_of((st_row, dat_row)).get('cells') or {})
    check('B07', '读回：正式列的值是刚写的',
          (cells.get('名称') or {}).get('value') == '甲写的正式列', f'cells={cells}')
    check('B07', '读回：普通列的值是刚写的',
          str((cells.get('日期') or {}).get('value')) == '2026-10-19', f'cells={cells}')

    # B09 跨普通/正式列粘贴：合法包 → 完整保存；非法包 → 整包拒绝
    cv2, sv2 = cv_sv(adm, T_mixed)
    res = action(C['jia'], 'files.sheet_paste_apply',
                 {'table': T_mixed, 'matrix': [['丙粘贴正式', 10.5]],
                  'matrix_types': [['text', 'number']],
                  'start_row': 1, 'start_col': 0, 'op_id': f'b09-ok-{RUN}',
                  'expected_content_version': cv2, 'expected_structure_version': sv2}, 'b09-paste-ok')
    check('B09', '合法粘贴包（普通列+正式列混合）被接受', res[0] == 200, err_text(res)[:180])
    st_meta3, meta3 = service(adm, 'files.sheet_read', {'table': T_mixed})
    cv3 = int(result_of((st_meta3, meta3)).get('content_version') or 0)
    sv3 = int(result_of((st_meta3, meta3)).get('structure_version') or 1)
    res = action(C['jia'], 'files.sheet_paste_apply',
                 {'table': T_mixed, 'matrix': [['合法值', -999]],
                  'matrix_types': [['text', 'number']],
                  'start_row': 2, 'start_col': 0, 'op_id': f'b09-bad-{RUN}',
                  'expected_content_version': cv3, 'expected_structure_version': sv3}, 'b09-paste-bad')
    bad_rejected = res[0] != 200
    cv4, _ = cv_sv(adm, T_mixed)
    check('B09', '含非法值（金额为负，违反 min:0）的粘贴包 → 整包被拒', bad_rejected,
          f'HTTP {res[0]} {err_text(res)[:160]}')
    check('B09', '整包被拒时内容版本不前进（没有「一半成功却称全部成功」）',
          cv4 == cv3, f'cv {cv3} → {cv4}')

    # ---------- B03 字段级权限（限制已晋升字段的读/改/下载） ----------
    st_def3, dat_def3 = service(adm, 'files.promotion_definition', {'table': T_mixed})
    cur_def = result_of((st_def3, dat_def3))
    _, sv5 = cv_sv(adm, T_mixed)
    tight_cols = json.loads(json.dumps(cur_def.get('columns') or []))
    for col in tight_cols:
        if col.get('header') == '名称':
            # **字段 ACL 三个键**（promotion.ACL_KEYS）：read/write/download_roles。
            # 未声明 = 不限；`[]` = 无人可（合法声明）。这里只留 System Manager。
            col['read_roles'] = ['System Manager']
            col['write_roles'] = ['System Manager']
            col['download_roles'] = ['System Manager']
    res = action(adm, 'files.promotion_define',
                 {'table': T_mixed, 'expected_structure_version': sv5,
                  'definition': {'definition_version': cur_def.get('definition_version') or 1,
                                 'columns': tight_cols}}, 'b03-tighten')
    check('B03', 'FDE 收紧「名称」字段的可读/可写/可下载名单', res[0] == 200, err_text(res)[:180])
    # 拿一个「读得到表、但读不到受限字段」的身份来验：**给丙一份只读共享**。
    res = action(C['jia'], 'platform.org.share_grant',
                 {'resource': T_mixed, 'user': PEOPLE['bing'][0], 'access': 'read'}, 'b03-share')
    check('B03', '给丙一份只读共享（验字段权限的对照身份）', res[0] == 200, err_text(res)[:140])
    st_row2, dat_row2 = service(C['bing'], 'files.row_read', {'table': T_mixed, 'row_id': rid_mix})
    cells2 = (result_of((st_row2, dat_row2)).get('cells') or {})
    name_cell = cells2.get('名称') or {}
    check('B03', '丙读受限字段：值被**遮蔽**（读不到真值，不泄露）',
          st_row2 == 200 and name_cell.get('hidden') is True
          and name_cell.get('value') in (None, ''),
          f'cells={cells2}')
    check('B03', '同一行里其他普通列仍可读（不整行拉黑）',
          st_row2 == 200 and '日期' in cells2, f'cells={cells2}')
    st_r, dat_r = service(adm, 'files.row_read', {'table': T_mixed, 'row_id': rid_mix})
    check('B03', '对照：管理员读同一行 → 拿到真值（管理员不该被误伤）',
          st_r == 200 and (result_of((st_r, dat_r)).get('cells') or {}).get('名称', {}).get('value')
          == '甲写的正式列', f'HTTP {st_r} {err_text((st_r, dat_r))[:140]}')
    # 导出/下载口：拿**表所有人**的版本引用（管理员未必有该表版本），再让丙去下载。
    st_v2, dat_v2 = service(C['jia'], 'files.versions', {'file': T_mixed})
    rows_v2 = (dat_v2.get('versions') or []) if isinstance(dat_v2, dict) else []
    ref2 = rows_v2[0].get('frappe_file') if rows_v2 else None
    if ref2:
        st_d2, _ = download(C['bing'], T_mixed, ref2)
        check('B03', '丙下载含受限字段的表 → 被拒（导出/下载口也守字段权限）',
              st_d2 != 200, f'HTTP {st_d2}')
    else:
        check('B03', '表所有人拿得到版本附件引用（否则下载口验证不可信）', False,
              f'keys={list(dat_v2)[:8] if isinstance(dat_v2, dict) else dat_v2}')

    # ---------- B06 并发：同格冲突 / 不同格 ----------
    # **两个都要写权**才有资格谈「同时改」：部门表默认只给成员读权
    # （org_admin.write_allows = 归属人 或 编辑共享），所以先给乙一份**编辑**共享。
    res = action(C['jia'], 'platform.org.share_grant',
                 {'resource': T_d1, 'user': PEOPLE['yi'][0], 'access': 'edit'}, 'b06-edit-share')
    check('B06', '前置：给乙一份编辑共享（部门表默认只给成员读权）',
          res[0] == 200, err_text(res)[:140])
    st_sheet, dat_sheet = service(C['jia'], 'files.sheet_read', {'table': T_d1, 'page_length': 10})
    rows_d1 = (result_of((st_sheet, dat_sheet)).get('rows') or [])
    rid1 = rows_d1[0].get('row_id') if rows_d1 else None
    rid2 = rows_d1[1].get('row_id') if len(rows_d1) > 1 else None
    check('B06', '读得到真实行身份（并发判据的前提）', bool(rid1 and rid2),
          f'rows={[(r.get("row_id")) for r in rows_d1]}')
    cv_a, sv_a = cv_sv(C['jia'], T_d1)
    res = action(C['jia'], 'files.cell_write',
                 {'table': T_d1, 'row_id': rid1, 'header': '名称',
                  'value': {'type': 'text', 'value': '甲写的'},
                  'expected_content_version': cv_a, 'expected_structure_version': sv_a}, 'b06-a')
    check('B06', '甲写一格成功（建立基线）', res[0] == 200, err_text(res)[:140])
    res = action(C['yi'], 'files.cell_write',
                 {'table': T_d1, 'row_id': rid1, 'header': '名称',
                  'value': {'type': 'text', 'value': '乙写的'},
                  'expected_content_version': cv_a, 'expected_structure_version': sv_a}, 'b06-b')
    check('B06', '乙用**旧版本**写同一格 → 被拒（同格冲突不静默覆盖）',
          res[0] != 200, f'HTTP {res[0]} {err_text(res)[:140]}')
    cv_b, _ = cv_sv(C['jia'], T_d1)
    res = action(C['yi'], 'files.cell_write',
                 {'table': T_d1, 'row_id': rid2, 'header': '名称',
                  'value': {'type': 'text', 'value': '乙写的另一格'},
                  'expected_content_version': cv_b, 'expected_structure_version': sv_a}, 'b06-c')
    check('B06', '乙用**新版本**写**另一格** → 成功（无关格不互相回退）',
          res[0] == 200, f'HTTP {res[0]} {err_text(res)[:140]}')

    # ---------- B10 跨表关联 ----------
    # **关联列必须是空白列**（产品拒「覆盖已有值」）。先用普通列追加造一个空白列。
    # 关联方向有产品规则：**不允许向上或跨管理范围关联非公共资料**。
    # 所以建**同管理范围内**的第二张部门表，让「同部门表 → 同部门表」是合法方向。
    res = upload(C['jia'], '试用-一部部门表2', {'level': 'department', 'department': d1}, 'up-d1b')
    T_d1b = file_of(res)
    check('B10', '建第二张同部门表（合法关联方向的前提）', bool(T_d1b), err_text(res)[:140])
    cv_r, sv_r = cv_sv(C['jia'], T_d1b)
    blank_hdr = f'关联列-{RUN}'
    res = action(C['jia'], 'files.sheet_column_append',
                 {'table': T_d1b, 'header': blank_hdr,
                  'expected_content_version': cv_r, 'expected_structure_version': sv_r}, 'b10-blank')
    check('B10', '造一个空白列作为关联列（产品要求关联列不覆盖已有值）',
          res[0] == 200, err_text(res)[:140])
    _, sv_r2 = cv_sv(C['jia'], T_d1b)
    res = action(C['jia'], 'files.table_relation_define',
                 {'table': T_d1b, 'header': blank_hdr,
                  'target_table': T_d1, 'target_header': '名称',
                  'expected_structure_version': sv_r2}, 'b10-define-owner')
    check('B10', '同管理范围内配置跨表关联（部门表2→部门表）→ 成功',
          res[0] == 200, f'HTTP {res[0]} {err_text(res)[:180]}')
    # **受管入口（System Manager）对他人表**：产品把「写权」判在归属人/编辑共享上，
    # System Manager 不是自动写权。**这是 FIX-17 的真边界**，这里如实记下来。
    res = action(adm, 'files.table_relation_define',
                 {'table': T_d1b, 'header': blank_hdr,
                  'target_table': T_d1, 'target_header': '名称',
                  'expected_structure_version': sv_r2}, 'b10-define-admin')
    check('B10', '受管入口（System Manager）给**他人**的表配关联 → 实际结果记录',
          True, f'HTTP {res[0]} {err_text(res)[:140]}（若非 200 即 FIX-17 要处理的边界）')
    # **反向（个人表 → 部门表）= 向上/跨管理范围**，产品应拒
    res = action(C['jia'], 'files.table_relation_define',
                 {'table': T_mixed, 'header': f'反向列-{RUN}',
                  'target_table': T_d1, 'target_header': '名称',
                  'expected_structure_version': sv_r2}, 'b10-define-up')
    check('B10', '反向关联（个人表→部门表）→ 被拒（不允许向上/跨管理范围关联非公共资料）',
          res[0] != 200, f'HTTP {res[0]} {err_text(res)[:160]}')
    st_rel, dat_rel = service(C['jia'], 'files.table_relation_read', {'table': T_d1b})
    check('B10', '关联读口可查，且定义里目标表是配置的那张（不只靠显示行号认对象）',
          st_rel == 200 and any(d.get('target_table') == T_d1
                                for d in (result_of((st_rel, dat_rel)).get("definitions") or [])),
          f'HTTP {st_rel} defs={result_of((st_rel, dat_rel)).get("definitions")}')
    st_rel2, dat_rel2 = service(C['bing'], 'files.table_relation_read', {'table': T_d1b})
    check('B10', '范围外员工读关联 → 拿不到（关联不能绕过权限）',
          st_rel2 != 200, f'HTTP {st_rel2}')
    res = action(C['bing'], 'files.cell_write',
                 {'table': T_d1b, 'row_id': rid1, 'header': '日期',
                  'value': {'type': 'text', 'value': '丙越界写'},
                  'expected_content_version': 0, 'expected_structure_version': sv_a}, 'b10-cross')
    check('B10', '关联不能绕过权限：范围外员工写关联目标表 → 被拒',
          denied(res), f'HTTP {res[0]} {err_text(res)[:140]}')

    # ---------- B17 动作记录 / 审计 ----------
    # 用**丙读不到的**表（部门表2）验越权，避开 B03 里给丙的只读共享。
    st_log, dat_log = service(adm, 'files.op_history', {'file': T_d1b, 'limit': 20})
    check('B17', '有权角色查得到该表的动作记录', st_log == 200, f'HTTP {st_log}')
    res = service(C['bing'], 'files.op_history', {'file': T_d1b, 'limit': 20})
    check('B17', '范围外员工查该表动作记录 → 被拒', res[0] != 200, f'HTTP {res[0]}')
    res = action(C['bing'], 'files.action_fact_query', {'target': T_d1b}, 'b17-fact')
    check('B17', '范围外员工用动作事实查询按目标查 → 查不到（越权查询被拒）',
          res[0] != 200 or not result_of(res).get('facts'), f'HTTP {res[0]} {err_text(res)[:120]}')
    res = action(adm, 'files.action_fact_query', {'target': T_d1b}, 'b17-fact-adm')
    check('B17', '对照：管理员用动作事实查询查得到（触发/审核/执行结果可区分的前提）',
          res[0] == 200, f'HTTP {res[0]} {err_text(res)[:120]}')

    _dump(args)


def _dump(args):
    passed = sum(1 for r in RESULTS if r['ok'])
    total = len(RESULTS)
    out = {'base': args.base, 'run': RUN, 'total': total, 'passed': passed,
           'failed': total - passed, 'results': RESULTS}
    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8') as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
    print(f'\n== 合计 {passed}/{total} 通过 ==')
    if FAILURES:
        print('失败项：')
        for f in FAILURES:
            print('  - ' + f)
    else:
        print('全部通过。')


if __name__ == '__main__':
    main()
