"""R967-E 候选权限实测：自建夹具，不能用历史候选数量或任意目录行作判据。

同一张共享表：管理员与发起人可读候选；仅有表读取权的其他员工不可读。
撤销发起人的表权限后，原会话列表、单条、审核与 units 都不得保留候选内容。
仅用于回归站。只回收本次建立的表，保留审计，不清理历史前缀。
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import uuid

ROOT = Path(os.environ.get('SS_ROOT', Path(__file__).resolve().parents[3]))
def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

t = load('structure', 'shangshu-server/scripts/test-n2-structure.py')
seed = load('seed', 'shangshu-server/scripts/tests/_ss_seed.py')
cred = load('cred', 'shangshu-server/scripts/tests/_ss_cred.py')
console = load('console', 'shangshu-server/scripts/tests/_ss_console.py')
BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3850')
RUN = uuid.uuid4().hex[:12]
users = [f'e26-{role}-{RUN}@example.invalid' for role in ('actor', 'reader')]
password = uuid.uuid4().hex
admin = t.Client(BASE)
admin.login('Administrator', cred.admin_pw_for(BASE))
checks = []
handle = None

def check(label, ok):
    checks.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + label, flush=True)

def managed(code):
    result = console.run(code)
    if result.get('__error__'):
        raise RuntimeError(result['__error__'])
    return result

def ids(cli):
    st, body = cli.request('GET', '/api/platform/action-proposals?status=Proposed&limit=200')
    assert st == 200, (st, body)
    return {p.get('id') for p in (body.get('items') or body.get('list') or [])}

try:
    managed('''
import frappe
for email in %r:
    frappe.get_doc({'doctype':'User', 'email':email, 'first_name':'候选权限合成测试',
        'send_welcome_email':0, 'new_password':%r,
        'roles':[{'role':'Desk User'}]}).insert(ignore_permissions=True)
frappe.db.commit()
RESULT['created'] = True
''' % (users, password))
    handle = seed.seed_mixed_table(admin, run=RUN, attribution={'level':'personal','owner_user':'Administrator'})
    table = handle['table']
    for i, user in enumerate(users):
        st, body = t.action(admin, 'platform.org.share_grant',
                            {'resource':table,'user':user,'access':'edit'}, f'e26-share-{RUN}-{i}')
        assert st == 200, (st, body)
    actor, reader = t.Client(BASE), t.Client(BASE)
    actor.login(users[0], password)
    reader.login(users[1], password)
    st, body = t.service(actor, 'files.sheet_read', {'table':table})
    r = seed._result(st, body)
    assert st == 200 and r.get('rows'), (st, body)
    payload = {'table':table,'cells':[{'row_id':r['rows'][0]['row_id'],'header':'备注',
               'value':{'type':'text','value':'候选保密内容-'+RUN}}],
               'expected_content_version':int(r['content_version']),
               'expected_structure_version':int(r['structure_version'])}
    out = managed('''
import frappe
from shangshu_core.public_api import propose_registered_action
frappe.set_user(%r)
p = propose_registered_action('files.sheet_cells_write', %r, idempotency_key=%r)
RESULT['proposal'] = p['id']
frappe.db.commit()
''' % (users[0], payload, 'e26-proposal-'+RUN))
    proposal = out['proposal']
    check('管理员列表包含本次真实候选', proposal in ids(admin))
    check('发起人列表包含本人候选', proposal in ids(actor))
    st, _ = t.service(reader, 'files.sheet_read', {'table':table})
    check('非审核人确实具有表读取权（反例前置）', st == 200)
    check('仅有表读取权不能看到他人候选', proposal not in ids(reader))
    paths = [f'/api/platform/action-proposal-get/{proposal}',
             f'/api/platform/action-proposals/{proposal}/review',
             f'/api/platform/action-proposals/{proposal}/units?offset=0&limit=1']
    for path in paths:
        st, _ = actor.request('GET', path)
        check('发起人有权 '+path.rsplit('/',1)[-1], st == 200)
        st, body = reader.request('GET', path)
        check('非审核人拒读 '+path.rsplit('/',1)[-1],
              st == 403 and ('候选保密内容-'+RUN) not in json.dumps(body, ensure_ascii=False))
    for endpoint, body in [('accept', {'op_id':'e26-denied-'+RUN,
                                       'expected_review_revision':'not-authorized', 'units':None}),
                           ('resolve', {'decision':'rejected'})]:
        st, _ = reader.request('POST', f'/api/platform/action-proposals/{proposal}/{endpoint}', body)
        check('非审核人不能裁决 '+endpoint, st == 403)
    check('拒绝越权裁决后原候选仍待审', proposal in ids(actor))
    st, _ = t.action(admin, 'platform.org.share_revoke',
                      {'resource':table,'user':users[0]}, 'e26-revoke-'+RUN)
    check('撤销发起人资源权限成功', st == 200)
    check('撤权后原会话候选列表不返回目标', proposal not in ids(actor))
    for path in paths:
        st, body = actor.request('GET', path)
        check('撤权后原会话拒读 '+path.rsplit('/',1)[-1],
              st == 403 and ('候选保密内容-'+RUN) not in json.dumps(body, ensure_ascii=False))
finally:
    if handle:
        seed.seed_cleanup(admin, handle)
    # 只停用本次确切创建的账号；不删除身份、审计或其他回归数据。
    managed('''
import frappe
for email in %r:
    if frappe.db.exists('User', email):
        doc = frappe.get_doc('User', email)
        doc.enabled = 0
        doc.save(ignore_permissions=True)
frappe.db.commit()
RESULT['disabled'] = True
''' % users)
print('结果：%d/%d PASS' % (sum(checks), len(checks)))
sys.exit(0 if checks and all(checks) else 1)
