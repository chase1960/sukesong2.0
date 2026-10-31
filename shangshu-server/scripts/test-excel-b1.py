"""Excel 首批（B1-01～B1-07）真实后端链路回归；对测试入口跑真实登录会话。

用法：
  python3 test-excel-b1.py --base https://<项目>-test.dev.lingeringtek.cn \
      --manifest /path/to/excel-b1-manifest.json --secrets /path/to/excel-b1-secrets.json \
      [--only B1-01] [--json-out /path/to/evidence.json]

也可直连容器内 node BFF（仍是真实 Frappe + MariaDB 链路，只绕开公网 TLS 网关）：
  python3 test-excel-b1.py --base http://127.0.0.1:<node端口> ...

约定：
- 只允许打到带 -test 的测试入口或本机回环地址；生产域名直接拒绝（不提供开关）。
- 夹具清单（manifest）由 excel-b1-fixture.py 生成；账号口令只放在 secrets 文件/环境变量，不进仓库、不进证据。
- 逐项输出 ✓/✗，--only 可单跑一项；退出码非 0 表示有未通过断言。
- 传输层失败（连不上、TLS 被掐）记为该条 ✗ 并继续，不中断整套。
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

# ---------- 采集与判定 ----------

CHECKS = []  # (item, label, ok)


def check(item, label, valid):
    CHECKS.append((item, label, bool(valid)))
    print(('  ✓ ' if valid else '  ✗ ') + label)
    return bool(valid)


def rejected(item, label, operation):
    try:
        status, body = operation()
    except AssertionError as exc:
        check(item, f'{label}（客户端错误：{exc}）', False)
        return
    ok = status >= 400 or (isinstance(body, dict) and body.get('ok') is False)
    code = body.get('code') if isinstance(body, dict) else '-'
    check(item, f'{label}（HTTP {status}, code={code}）', ok)


class Client:
    """真实 HTTP 会话（cookie jar + JSON）。"""

    def __init__(self, base):
        self.base = base.rstrip('/')
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.user = None

    def request(self, method, path, body=None):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header('accept', 'application/json')
        if data is not None:
            req.add_header('content-type', 'application/json')
        try:
            with self.opener.open(req, timeout=30) as resp:
                raw = resp.read().decode('utf-8')
                status = resp.status
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode('utf-8')
            status = exc.code
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            # 传输层失败不是产品断言结果：记为 status 0，让该条干净地 ✗，不炸整套。
            return 0, {'_transport_error': f'{type(exc).__name__}: {exc}'}
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            # 非 JSON 回包（如 index.html）要留全文：断言要在里面找注入的入口脚本。
            parsed = {'_raw': raw}
        return status, parsed

    def login(self, username, password):
        status, body = self.request('POST', '/api/platform/login',
                                    {'username': username, 'password': password})
        if status != 200 or not body.get('ok'):
            raise SystemExit(f'登录失败 {username}: HTTP {status} {body}')
        self.user = username
        return body


# ---------- 各项断言 ----------

def item_b1_01(ctx):
    """真实登录、开表和访问边界。"""
    item = 'B1-01'
    m, a, b, c = ctx['manifest'], ctx['a'], ctx['b'], ctx['c']
    oid = m['object_id']

    status, session = a.request('GET', '/api/platform/session')
    check(item, f"A 会话有效且带真实身份（identity={session.get('identity_id')}）",
          status == 200 and session.get('ok') and session.get('identity_id'))

    status, objs = a.request('GET', '/api/platform/objects')
    ids = [row.get('id') for row in objs.get('list', [])] if isinstance(objs.get('list'), list) else []
    check(item, 'A 能在对象目录看到测试表', status == 200 and oid in ids)

    status, page = a.request('GET', f'/api/platform/objects/{oid}/records?page=1&page_length=30')
    rows = page.get('rows') or page.get('records') or []
    names = [row.get('name') for row in rows]
    check(item, f'A 首页读到真实行（{len(names)} 行，含固定行 ID）',
          status == 200 and len(names) == 30 and all(names))
    first_probe = m['special']['first_page_probe']['name']
    special = m['special']['leading_zero']['name']
    check(item, 'A 首页含夹具指定行且行 ID 一致', first_probe in names)

    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{special}')
    rec = one.get('record') or one
    check(item, f"A 按行 ID 读到真实值（编号={rec.get('bianhao')!r}）",
          status == 200 and str(rec.get('bianhao')) == '00123')

    status_b, page_b = b.request('GET', f'/api/platform/objects/{oid}/records?page=1&page_length=30')
    names_b = [row.get('name') for row in (page_b.get('rows') or page_b.get('records') or [])]
    check(item, 'B 独立会话读到同一批行 ID', status_b == 200 and names_b == names)

    rejected(item, 'C 直接调记录列表接口被拒',
             lambda: c.request('GET', f'/api/platform/objects/{oid}/records?page=1'))
    rejected(item, 'C 直接调单条记录接口被拒',
             lambda: c.request('GET', f'/api/platform/objects/{oid}/records/{special}'))

    # 新页面资产应在工作台体系内可取到（未接入前应当失败）。
    status, idx = a.request('GET', '/index.html')
    html = idx.get('_raw', '')
    check(item, '工作台 index.html 可取且注入了 Univer 页面入口脚本',
          status == 200 and 'excel-univer-entry.js' in html)
    status, _ = a.request('GET', '/js/domains/excel-univer/excel-univer-entry.js')
    check(item, 'Univer 页面入口脚本可访问', status == 200)


def item_b1_02(ctx):
    """单格编辑与原值完整（真实持久化前后比较）。"""
    item = 'B1-02'
    m, a = ctx['manifest'], ctx['a']
    oid = m['object_id']
    revision = ctx['revision']

    def write(name, values, expected_modified, key=None):
        payload = {'object_id': oid, 'name': name,
                   'expected_revision': revision,
                   'expected_modified': expected_modified, 'values': values}
        body = {'payload': payload, 'confirmed': True,
                'idempotency_key': key or f"b1-02-{os.urandom(8).hex()}", 'source': 'user'}
        return a.request('POST', '/api/platform/actions/platform.object.update/execute', body)

    target = m['special']['leading_zero']['name']
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec = one.get('record') or one

    status, body = write(target, {'bianhao': '00123'}, rec.get('modified'))
    check(item, '前导零编号写入成功', status == 200 and body.get('ok'))
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec2 = one.get('record') or one
    check(item, f"保存刷新后编号仍为 '00123'（现值 {rec2.get('bianhao')!r}）",
          rec2.get('bianhao') == '00123')

    # 长编号保真用夹具里专门那一行，且每轮写不同的 28 字符值：
    # 不能覆盖前导零行（B1-01 依赖它恒为 '00123'），也不能写回原值（那不是一次真写入）。
    long_row = m['special']['long_id']['name']
    long_id = f"ZZ{os.urandom(13).hex()}"
    assert len(long_id) == 28, long_id
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{long_row}')
    long_mod = (one.get('record') or one).get('modified')
    status, body = write(long_row, {'bianhao': long_id}, long_mod)
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{long_row}')
    rec3 = one.get('record') or one
    check(item, f'长编号（{len(long_id)} 字符）保存后原样', rec3.get('bianhao') == long_id)

    note_row = m['special']['long_note']['name']
    note = m['special']['long_note']['beizhu']
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{note_row}')
    note_mod = (one.get('record') or one).get('modified')
    status, body = write(note_row, {'beizhu': note}, note_mod)
    check(item, f'长备注写入成功（{len(note)} 字符、含换行）', status == 200 and body.get('ok'))
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{note_row}')
    rec4 = one.get('record') or one
    check(item, '长备注读后逐字一致、未截断', rec4.get('beizhu') == note)

    money = 1234.56
    money_row = m['special']['money_row']['name']
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{money_row}')
    money_mod = (one.get('record') or one).get('modified')
    status, body = write(money_row, {'jine': money}, money_mod)
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{money_row}')
    rec5 = one.get('record') or one
    got = rec5.get('jine')
    check(item, f'金额数值保存正确（现值 {got!r}）',
          got == money or (got is not None and float(got) == money))

    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec6 = one.get('record') or one
    rejected(item, '只读列绕过前端直接提交被服务端拒绝',
             lambda: write(target, {'jiaoyan': '被篡改'}, rec6.get('modified')))


def item_b1_03(ctx):
    """全表文字搜索：跨页命中、重复名称、无匹配、隐藏字段不参与。"""
    item = 'B1-03'
    m, a = ctx['manifest'], ctx['a']
    oid = m['object_id']

    def search(term, page=1, length=30):
        filters = json.dumps({'$search': term}, ensure_ascii=False)
        return a.request('GET', f'/api/platform/objects/{oid}/records'
                                f'?filters={urllib.parse.quote(filters)}&page={page}&page_length={length}')

    sp = m['special']
    status, body = search(sp['hit_outside']['keyword'])
    rows = body.get('rows') or body.get('records') or []
    check(item, f"首载范围外唯一命中可被全表搜到（total={body.get('total')}）",
          status == 200 and body.get('total') == 1 and rows
          and rows[0].get('name') == sp['hit_outside']['name'])

    status, body = search(sp['hit_inside']['keyword'])
    rows = body.get('rows') or body.get('records') or []
    check(item, '首载范围内唯一命中行 ID 正确',
          body.get('total') == 1 and rows and rows[0].get('name') == sp['hit_inside']['name'])

    status, body = search(sp['dup_name']['keyword'])
    rows = body.get('rows') or body.get('records') or []
    got = sorted(row.get('name') for row in rows)
    check(item, f"重复名称命中 total={body.get('total')} 且行 ID 集合正确（不跳错行）",
          got == sorted(sp['dup_name']['names']))

    status, body = search(sp['many_match']['keyword'], length=30)
    rows = body.get('rows') or body.get('records') or []
    check(item, f"大量命中返回首批 30 条且总数正确（total={body.get('total')}）",
          body.get('total') == sp['many_match']['count'] and len(rows) == 30)
    status, body = search(sp['many_match']['keyword'], page=2, length=30)
    check(item, '大量命中可续载第 2 页', len(body.get('rows') or []) == 30)

    status, body = search(sp['few_match']['keyword'])
    check(item, f"少量命中 total={body.get('total')} 与夹具一致",
          body.get('total') == sp['few_match']['count'])

    status, body = search(sp['no_match']['keyword'])
    check(item, '无匹配关键词 total=0（且不是接口失败）', status == 200 and body.get('total') == 0)

    status, body = search(sp['hidden_field_keyword']['keyword'])
    check(item, '隐藏/无权字段不参与搜索（命中 0）', status == 200 and body.get('total') == 0)

    status, body = search(sp['hit_outside']['keyword'])
    rows = body.get('rows') or body.get('records') or []
    blob = json.dumps(rows, ensure_ascii=False)
    check(item, '返回结果不含隐藏字段的值', sp['hidden_field_keyword']['keyword'] not in blob)


def item_b1_04(ctx):
    """按次保存、双账号读回、连续两笔编辑顺序不塌缩。"""
    item = 'B1-04'
    m, a, b = ctx['manifest'], ctx['a'], ctx['b']
    oid = m['object_id']
    target = m['special']['update_target']['name']

    def write(client, values, expected_modified, key=None):
        payload = {'object_id': oid, 'name': target,
                   'expected_revision': ctx['revision'],
                   'expected_modified': expected_modified, 'values': values}
        return client.request('POST', '/api/platform/actions/platform.object.update/execute',
                              {'payload': payload, 'confirmed': True,
                               'idempotency_key': key or f"b1-04-{os.urandom(8).hex()}",
                               'source': 'user'})

    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec = one.get('record') or one
    v0 = rec.get('mingcheng')
    status, body = write(a, {'mingcheng': 'A改后名称'}, rec.get('modified'))
    check(item, 'A 第一笔编辑保存成功', status == 200 and body.get('ok'))

    status, one = b.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec_b = one.get('record') or one
    check(item, f"B 另一会话刷新读到同一实际值（{rec_b.get('mingcheng')!r}）",
          rec_b.get('mingcheng') == 'A改后名称')

    status, body = write(b, {'mingcheng': 'B再改名称'}, rec_b.get('modified'))
    check(item, 'B 第二笔编辑保存成功', status == 200 and body.get('ok'))

    status, hist = b.request('POST', '/api/platform/services/platform.object.history/invoke',
                             {'payload': {'object_id': oid, 'name': target,
                                          'page': 1, 'page_length': 10}})
    items = hist.get('items') or []
    chain = []
    for it in items:
        if it.get('operation') != 'update':
            continue
        for ch in it.get('changes') or []:
            if ch.get('field') == 'mingcheng':
                chain.append({'before': ch.get('before'), 'after': ch.get('after')})
    check(item, f'同一格连续两笔编辑都在历史里（{len(chain)} 笔）', len(chain) >= 2)
    # 顺序保留的真实含义是值的链条没断：两笔各自独立、后一笔接着前一笔的值改；
    # 且日志按新→旧排，后发生的 B 这笔必须排在 A 这笔前面。
    a_idx = next((i for i, c in enumerate(chain) if c['after'] == 'A改后名称'), None)
    b_idx = next((i for i, c in enumerate(chain) if c['after'] == 'B再改名称'), None)
    check(item, '两笔顺序保留（A→B、B→C 不塌缩成一笔）',
          a_idx is not None and b_idx is not None
          and chain[a_idx]['before'] == v0
          and chain[b_idx]['before'] == 'A改后名称'
          and b_idx < a_idx)


def item_b1_05(ctx):
    """断网/回执丢失/冲突/过期请求的服务端侧断言（真实版本与权限验证）。"""
    item = 'B1-05'
    m, a, b, c = ctx['manifest'], ctx['a'], ctx['b'], ctx['c']
    oid = m['object_id']
    target = m['special']['update_target']['name']

    def write(client, values, expected_modified, key, expected_revision=None, object_id=None, name=None):
        payload = {'object_id': object_id or oid, 'name': name or target,
                   'expected_revision': expected_revision if expected_revision is not None else ctx['revision'],
                   'expected_modified': expected_modified, 'values': values}
        return client.request('POST', '/api/platform/actions/platform.object.update/execute',
                              {'payload': payload, 'confirmed': True,
                               'idempotency_key': key, 'source': 'user'})

    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec = one.get('record') or one
    current = rec.get('modified')

    key = f'b1-05-receipt-{os.urandom(8).hex()}'
    status, body = write(a, {'mingcheng': '回执测试值'}, current, key)
    check(item, '带幂等键的写入成功', status == 200 and body.get('ok'))
    status, replay = write(a, {'mingcheng': '回执测试值'}, current, key)
    check(item, '回执丢失后同键重试得到同一结果（idempotent）',
          status == 200 and replay.get('idempotent') is True)
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    check(item, '重试没有产生第二次实际修改',
          (one.get('record') or one).get('mingcheng') == '回执测试值')

    stale = current
    status, one = b.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec_b = one.get('record') or one
    status, body = write(b, {'mingcheng': 'B新值'}, rec_b.get('modified'), f'b1-05-b-{os.urandom(8).hex()}')
    check(item, 'B 并发写入成功', status == 200 and body.get('ok'))
    rejected(item, 'A 用旧版本提交被服务端拒绝（不覆盖 B 的新值）',
             lambda: write(a, {'mingcheng': 'A旧值覆盖'}, stale, f'b1-05-stale-{os.urandom(8).hex()}'))
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    check(item, '最终值仍是 B 的新值', (one.get('record') or one).get('mingcheng') == 'B新值')

    probe = m.get('probe_object_id')
    admin = ctx['admin']
    if probe:
        # 结构版本每轮都会 +1，清单里那份会过期；每次都读当前修订号。
        status, objs = admin.request('GET', '/api/platform/objects')
        probe_entry = next((r for r in (objs.get('list') or []) if r.get('id') == probe), None)
        old_revision = (probe_entry or {}).get('revision')
        status, page = admin.request('GET', f'/api/platform/objects/{probe}/records?page=1&page_length=1')
        rows = page.get('rows') or []
        if rows and old_revision is not None:
            pname = rows[0].get('name')
            status, one = admin.request('GET', f'/api/platform/objects/{probe}/records/{pname}')
            prec = one.get('record') or one
            # 从对象当前字段出发只加一列：清单里的定义会随上一轮加列过期，
            # 拿它当基准等于删掉上一轮的列（删列是 blocked，根本执行不了）。
            base_fields = list((probe_entry or {}).get('fields')
                               or (m.get('probe_definition') or {}).get('fields') or [])
            # 每轮加一个唯一列：重跑时结构仍真有变化，才能验到“结构版本已变”。
            new_col = f'extra_{os.urandom(3).hex()}'
            definition = {'schema_version': 1,
                          'title': (probe_entry or {}).get('title') or '结构版本探针',
                          'fields': base_fields + [
                              {'id': new_col, 'label': f'新加列-{new_col}', 'type': 'text'}]}
            # 权限沿用夹具那份（对象列表不带 access）；不顺手改权限，验的才是“加列”这一件事。
            access = (m.get('probe_definition') or {}).get('access')
            if access:
                definition['access'] = access
            status, change = admin.request(
                'POST', f"/api/platform/application-definitions/{m['app_id']}/object-changes",
                {'object_id': probe, 'definition': definition,
                 'expected_revision': old_revision,
                 'idempotency_key': f'b1-05-schema-{os.urandom(8).hex()}'})
            # 回包是 {ok, change:{...}} 信封。
            cid = (change.get('change') or {}).get('id') or change.get('id')
            check(item, f"结构变更计划可创建（真实 DDL 准备）{'' if cid else '：' + str(change)[:120]}",
                  status == 200 and bool(cid))
            if cid:
                status, applied = admin.request(
                    'POST',
                    f'/api/platform/object-changes/{cid}/execute', {'confirmed': True})
                check(item, '结构变更真实执行（结构版本 +1）', status == 200)
            rejected(item, '结构版本已变时旧版本写入被拒绝',
                     lambda: write(admin, {'note': '旧结构写入'}, prec.get('modified'),
                                   f'b1-05-oldrev-{os.urandom(8).hex()}',
                                   expected_revision=old_revision,
                                   object_id=probe, name=pname))
        else:
            check(item, '探针对象有可用记录', False)
    else:
        check(item, '结构版本用例（夹具未提供探针对象）', False)

    rejected(item, '无权账号写入被服务端拒绝（真实权限验证）',
             lambda: write(c, {'mingcheng': '越权'}, 'whatever', f'b1-05-c-{os.urandom(8).hex()}'))


def item_b1_06(ctx):
    """修改日志准确且读取受控。"""
    item = 'B1-06'
    m, a, b, c = ctx['manifest'], ctx['a'], ctx['b'], ctx['c']
    oid = m['object_id']
    target = m['special']['update_target']['name']

    marker = f'日志核对-{os.urandom(4).hex()}'
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec = one.get('record') or one
    key = f'b1-06-{os.urandom(8).hex()}'
    status, body = a.request('POST', '/api/platform/actions/platform.object.update/execute',
                             {'payload': {'object_id': oid, 'name': target,
                                          'expected_revision': ctx['revision'],
                                          'expected_modified': rec.get('modified'),
                                          'values': {'mingcheng': marker}},
                              'confirmed': True, 'idempotency_key': key, 'source': 'user'})
    check(item, '单格修改成功', status == 200 and body.get('ok'))

    status, hist = ctx['admin'].request('POST', '/api/platform/services/platform.object.history/invoke',
                                        {'payload': {'object_id': oid, 'name': target,
                                                     'page': 1, 'page_length': 10}})
    items = hist.get('items') or []
    mine = next((it for it in items
                 if any(ch.get('after') == marker for ch in it.get('changes') or [])), None)
    check(item, '授权验证入口（管理员）能查到该笔修改', mine is not None)
    if mine:
        check(item, '含操作编号（幂等键）',
              mine.get('op_id') == key or mine.get('idempotency_key') == key)
        check(item, '含真实用户与人为来源',
              bool(mine.get('actor')) and mine.get('source') in ('user', 'record'))
        check(item, '含表标识/当时表名、行 ID',
              mine.get('object_id') == oid and bool(mine.get('object_title')))
        check(item, '含当时字段名与结构版本',
              bool(mine.get('changes') and mine['changes'][0].get('label'))
              and mine.get('revision') is not None)
        check(item, '含修改前后实际值',
              any(ch.get('before') is not None or ch.get('after') is not None
                  for ch in mine.get('changes') or []))

    note = m['special']['long_note']['beizhu']
    status, hist = a.request('POST', '/api/platform/services/platform.object.history/invoke',
                             {'payload': {'object_id': oid, 'name': m['special']['long_note']['name'],
                                          'page': 1, 'page_length': 50}})
    note_changes = [ch for it in (hist.get('items') or [])
                    for ch in (it.get('changes') or []) if ch.get('field') == 'beizhu']
    check(item, '权威明细中长备注不截断', any(ch.get('after') == note for ch in note_changes))

    key2 = f'b1-06-retry-{os.urandom(8).hex()}'
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec2 = one.get('record') or one
    # 标记每次运行唯一：历史会累积，固定值会把上一轮的笔数算进来。
    retry_marker = f'重试客户-{os.urandom(4).hex()}'
    payload = {'object_id': oid, 'name': target, 'expected_revision': ctx['revision'],
               'expected_modified': rec2.get('modified'), 'values': {'kehu': retry_marker}}
    body_req = {'payload': payload, 'confirmed': True, 'idempotency_key': key2, 'source': 'user'}
    a.request('POST', '/api/platform/actions/platform.object.update/execute', body_req)
    a.request('POST', '/api/platform/actions/platform.object.update/execute', body_req)
    status, hist = a.request('POST', '/api/platform/services/platform.object.history/invoke',
                             {'payload': {'object_id': oid, 'name': target,
                                          'page': 1, 'page_length': 50}})
    retry_ops = [it for it in (hist.get('items') or [])
                 if any(ch.get('after') == retry_marker for ch in it.get('changes') or [])]
    check(item, '回执重试不追加第二份成功记录', len(retry_ops) == 1)

    stale_key = f'b1-06-fail-{os.urandom(8).hex()}'
    rejected(item, '用旧版本提交被拒（制造一笔已知失败）',
             lambda: a.request('POST', '/api/platform/actions/platform.object.update/execute',
                               {'payload': {'object_id': oid, 'name': target,
                                            'expected_revision': ctx['revision'],
                                            'expected_modified': 'stale-on-purpose',
                                            'values': {'mingcheng': '不该成功'}},
                                'confirmed': True, 'idempotency_key': stale_key, 'source': 'user'}))
    status, hist = a.request('POST', '/api/platform/services/platform.object.history/invoke',
                             {'payload': {'object_id': oid, 'name': target,
                                          'page': 1, 'page_length': 50}})
    success_bad = [it for it in (hist.get('items') or [])
                   if any(ch.get('after') == '不该成功' for ch in it.get('changes') or [])]
    check(item, '已拒绝操作没有记成成功变更', not success_bad)
    status, receipt = a.request('GET', f'/api/platform/action-requests/{stale_key}')
    got_status = receipt.get('status') if isinstance(receipt, dict) else '-'
    check(item, f'失败尝试有可查询结果（status={got_status}）',
          status == 200 and got_status not in ('NotFound', '-', None))

    rejected(item, 'C 调历史接口被拒',
             lambda: c.request('POST', '/api/platform/services/platform.object.history/invoke',
                               {'payload': {'object_id': oid, 'name': target}}))
    status, anylog = b.request('GET', '/api/platform/action-requests/none-such')
    check(item, 'B 查不到他人/不存在的操作编号（不越权）',
          status in (200, 404) and (anylog.get('status') == 'NotFound'
                                    or anylog.get('ok') is False))


def item_b1_07(ctx):
    """脚本侧可验部分：单次编辑只产生一次修改请求。"""
    item = 'B1-07'
    m, a = ctx['manifest'], ctx['a']
    oid = m['object_id']
    target = m['special']['update_target']['name']
    status, one = a.request('GET', f'/api/platform/objects/{oid}/records/{target}')
    rec = one.get('record') or one
    key = f'b1-07-{os.urandom(8).hex()}'
    marker = f'一次请求-{os.urandom(4).hex()}'
    status, body = a.request('POST', '/api/platform/actions/platform.object.update/execute',
                             {'payload': {'object_id': oid, 'name': target,
                                          'expected_revision': ctx['revision'],
                                          'expected_modified': rec.get('modified'),
                                          'values': {'zhuangtai': marker}},
                              'confirmed': True, 'idempotency_key': key, 'source': 'user'})
    check(item, '单次编辑保存成功', status == 200 and body.get('ok'))
    status, hist = a.request('POST', '/api/platform/services/platform.object.history/invoke',
                             {'payload': {'object_id': oid, 'name': target,
                                          'page': 1, 'page_length': 20}})
    ops = [it for it in (hist.get('items') or [])
           if any(ch.get('after') == marker for ch in it.get('changes') or [])]
    check(item, '单次编辑只对应一次修改请求（一条成功记录）', len(ops) == 1)
    check(item, '该次操作由单一幂等键驱动（无重复请求痕迹）',
          bool(ops) and (ops[0].get('op_id') == key or ops[0].get('idempotency_key') == key))


SECTIONS = {
    'B1-01': item_b1_01, 'B1-02': item_b1_02, 'B1-03': item_b1_03,
    'B1-04': item_b1_04, 'B1-05': item_b1_05, 'B1-06': item_b1_06, 'B1-07': item_b1_07,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--secrets', required=True)
    ap.add_argument('--only', action='append')
    ap.add_argument('--json-out')
    args = ap.parse_args()

    host = urllib.parse.urlparse(args.base).hostname or ''
    if '-test.' not in host and host not in {'127.0.0.1', 'localhost', '::1'}:
        raise SystemExit(f'拒绝非测试入口：{args.base}（只允许 -test 域名或本机回环）')

    manifest = json.loads(open(args.manifest, encoding='utf-8').read())
    secrets = json.loads(open(args.secrets, encoding='utf-8').read())

    clients = {}
    for key in ('a', 'b', 'c', 'admin'):
        clients[key] = Client(args.base)
        clients[key].login(manifest['accounts'][key], secrets[key])
    ctx = {'manifest': manifest, 'a': clients['a'], 'b': clients['b'], 'c': clients['c'],
           'admin': clients['admin'],
           'revision': manifest.get('revision', 1),
           'probe_revision': manifest.get('probe_revision', 1)}

    only = set(args.only or SECTIONS)
    for name, fn in SECTIONS.items():
        if name not in only:
            continue
        print(f'\n== {name} ==')
        fn(ctx)

    total = len(CHECKS)
    failed = sum(1 for c in CHECKS if not c[2])
    print(f'\n合计 {total} 条断言，未通过 {failed} 条。')
    if args.json_out:
        json.dump({'base': args.base,
                   'checks': [{'item': i, 'label': l, 'ok': o} for i, l, o in CHECKS],
                   'total': total, 'failed': failed},
                  open(args.json_out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f'证据已写入 {args.json_out}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
