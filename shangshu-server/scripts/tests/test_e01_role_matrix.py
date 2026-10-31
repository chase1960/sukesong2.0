"""UI017/018 resource authorization through actual BFF HTTP.

Requires an explicitly released regression write window:
SS_BASE=http://127.0.0.1:3850 python3 shangshu-server/scripts/tests/test_e01_role_matrix.py --execute-live
Unique synthetic enterprise/users/resources; exact public recycle/disable only.
No browser or PDF preview claim. Imported helpers perform no live operations.
"""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import sys
import urllib.parse
import uuid

ROOT = Path(os.environ.get('SS_ROOT', Path(__file__).resolve().parents[3]))


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def result(response):
    status, body = response
    if status != 200 or not isinstance(body, dict):
        return {}
    return body.get('result', body)


def successful(response):
    status, body = response
    value = result(response)
    return (status == 200 and body.get('ok') is not False and bool(value)
            and value.get('applied') is not False and value.get('fatal') is not True)


def denied(response):
    # Transport failures, 404s and 500s must never pass authorization assertions.
    return response[0] == 403


class Fixture:
    """Shared only by these two live scripts; no fixture writes at import time."""
    def __init__(self, label, roles):
        self.base = os.environ.get('SS_BASE', '')
        if not self.base or not os.environ.get('SS_CONTAINER') and not self.base.rstrip('/').endswith(':3850'):
            raise RuntimeError('Set SS_BASE explicitly; non-3850 environments also require SS_CONTAINER')
        self.prefix = label + uuid.uuid4().hex[:12]
        self.password = secrets.token_urlsafe(24)
        self.users = {r: self.prefix + '-' + r + '@example.invalid' for r in roles}
        self.files = []
        self.file_clients = {}
        self.departments = {}
        self.checks = []
        self.t = load('matrix_http', 'shangshu-server/scripts/test-n2-structure.py')
        self.console_module = load('matrix_console', 'shangshu-server/scripts/tests/_ss_console.py')
        cred = load('matrix_credentials', 'shangshu-server/scripts/tests/_ss_cred.py')
        self.admin = self.t.Client(self.base)
        self.admin.login('Administrator', os.environ.get('SS_D_PW') or cred.admin_pw_for(self.base))
        self.clients = {}

    def check(self, label, condition):
        self.checks.append(bool(condition))
        print(('PASS ' if condition else 'FAIL ') + label, flush=True)

    def setup(self):
        # Public identity/org actions create the synthetic fixture. The only direct
        # identity metadata assignment isolates its enterprise from daily records.
        # Throttle override is confined to this console process and always restored.
        out = self.console_module.run('''
from shangshu_core.public_api import execute_registered_action
from frappe.core.doctype.user import user as user_module
users=__USERS__
prefix=__PREFIX__
seq=0
def act(action,payload):
 global seq
 seq+=1
 value=execute_registered_action(action,payload,confirmed=True,idempotency_key=prefix+'-seed-'+str(seq))
 if value.get('status')=='Failed' or not value.get('result'):raise RuntimeError('fixture action failed: '+action)
 return value['result']
RESULT['departments']={}
previous=user_module.throttle_user_creation
try:
 user_module.throttle_user_creation=lambda:None
 for role,email in users.items():
  act('platform.identity.create',{'email':email,'display_name':prefix+' '+role,'initial_password':__PASSWORD__,'role':'staff','collaboration_scope':'related'})
  identity=frappe.db.get_value('Shangshu Identity',{'user':email},'name')
  frappe.db.set_value('Shangshu Identity',identity,'enterprise_id',prefix)
  frappe.db.commit()
finally:user_module.throttle_user_creation=previous
for role,parent in [('a',None),('child','a'),('peer',None)]:
 payload={'name':prefix+' '+role,'enterprise':prefix}
 if parent:payload['parent']=RESULT['departments'][parent]
 dep=act('platform.org.department_create',payload)['department']
 RESULT['departments'][role]=dep
 frappe.db.commit()
for role,dep in [('owner','a'),('member','a'),('head','a'),('child','child'),('peer','peer')]:
 if role in users:act('platform.org.member_assign',{'user':users[role],'department':RESULT['departments'][dep]})
if 'head' in users:act('platform.org.head_assign',{'user':users['head'],'department':RESULT['departments']['a']})
if 'boss' in users:act('platform.org.owner_assign',{'user':users['boss'],'enterprise':prefix})
frappe.db.commit()
'''.replace('__USERS__', repr(self.users)).replace('__PREFIX__', repr(self.prefix))
            .replace('__PASSWORD__', repr(self.password)))
        self.departments = out.get('departments', {})
        if out.get('__error__'):
            raise RuntimeError('synthetic fixture setup failed; exact known fixtures will be disabled')
        for role, user in self.users.items():
            client = self.t.Client(self.base)
            client.login(user, self.password)
            self.clients[role] = client

    def action(self, client, action, payload):
        # Deliberately bypass test-n2-structure.action's automatic attribution fill.
        response = client.request('POST', '/api/platform/actions/' + action + '/execute', {
            'payload': payload, 'confirmed': True, 'idempotency_key': self.prefix + '-' + uuid.uuid4().hex})
        if action in ('files.create', 'files.upload'):
            file = result(response).get('file')
            if file and file not in self.files:
                self.files.append(file)
                self.file_clients[file] = client
        return response

    def service(self, client, service, payload):
        return self.t.service(client, service, payload)

    def upload(self, role, suffix, attribution=None):
        from openpyxl import Workbook
        book = Workbook(); book.active.append(['名称', '金额', '备注'])
        book.active.append([self.prefix, 1, '原值'])
        stream = io.BytesIO(); book.save(stream)
        payload = {'file_name': self.prefix + '-' + suffix + '.xlsx',
                   'content_base64': base64.b64encode(stream.getvalue()).decode(), 'directory': '/'}
        if attribution is not None:
            payload['attribution'] = attribution
        response = self.action(self.clients[role], 'files.upload', payload)
        if not successful(response):
            raise RuntimeError('synthetic upload failed: HTTP ' + str(response[0]))
        return result(response)['file']

    def view(self, client, file):
        return self.service(client, 'files.sheet_read', {'table': file})

    def write(self, client, file, value):
        before = result(self.view(self.admin, file))
        return self.action(client, 'files.sheet_cell_write', {
            'table': file, 'row_id': before['rows'][0]['row_id'], 'header': '备注',
            'value': {'type': 'text', 'value': value},
            'expected_content_version': before['content_version'],
            'expected_structure_version': before['structure_version']})

    def reference(self, file):
        versions = result(self.service(self.admin, 'files.versions', {'file': file}))
        current = versions.get('current', {})
        reference = current.get('frappe_file') or (current.get('source') or {}).get('ref')
        if not reference:
            for version in versions.get('versions', []):
                source = version.get('source') or {}
                reference = version.get('frappe_file') or source.get('ref') or source.get('file')
                if reference: break
        if not reference:
            raise RuntimeError('actual version response has no file reference')
        return reference

    def listing(self, client, scope='sheet', q=None, page=1, page_length=200):
        filters = {'scope': scope, 'q': q or self.prefix}
        return client.request('GET', '/api/platform/datasets/files.file/records?' + urllib.parse.urlencode({
            'filters': json.dumps(filters), 'page': page, 'page_length': page_length}))

    def cleanup(self):
        errors = []
        for file in self.files:
            response = self.action(self.file_clients[file], 'files.recycle', {'file': file})
            if not successful(response): errors.append('recycle:' + file)
        out = self.console_module.run('''
import json
from shangshu_core.public_api import execute_registered_action, retire_managed_object, retire_application
prefix=__PREFIX__
errors=[]
for index,user in enumerate(__USERS__):
 if frappe.db.exists('User',user):
  try:execute_registered_action('platform.identity.status',{'email':user,'enabled':False},confirmed=True,idempotency_key=prefix+'-disable-'+str(index))
  except Exception:errors.append('disable-user:'+user)
for dep in __DEPTS__:
 if frappe.db.exists('Shangshu Department',dep):
  try:execute_registered_action('platform.org.department_set_status',{'department':dep,'enabled':False},confirmed=True,idempotency_key=prefix+'-disable-dept-'+dep)
  except Exception:errors.append('disable-department:'+dep)
frappe.db.commit()
# —— **退役受管对象/应用**（2026-10-26 治理）——
#    只回收文件 ＝ 受管对象行、应用行、物理表**都还在站上**（停用 ≠ 退役）；
#    受管对象的幂等键按**表身份**算 ⇒ 每跑一次判据就多一个 ⇒ 必须退役掉。
retired_objects=[]
retired_applications=[]
for file in __FILES__:
 try:
  raw=frappe.db.get_value('Shangshu File Center File',file,'sheet_meta_json')
  binding=(json.loads(raw or '{}').get('promotion_binding') or {})
  object_id=binding.get('object_id')
  application_id=binding.get('application_id')
  if object_id:
   receipt=retire_managed_object(object_id,reason='live 判据收尾：退役本次跑造出来的受管对象')
   application_id=(receipt or {}).get('application_id') or application_id
   retired_objects.append(object_id)
  if application_id:
   retire_application(application_id,reason='live 判据收尾：退役本次跑造出来的应用')
   retired_applications.append(application_id)
 except Exception as error:
  errors.append('retire:%s:%s'%(file,str(error)[:120]))
frappe.db.commit()
# —— **回读确认**：受管对象/应用/文件三个状态逐个确认（失败要报出来）——
for user in __USERS__:
 if frappe.db.exists('User',user) and frappe.db.get_value('User',user,'enabled'):errors.append('active-user:'+user)
for dep in __DEPTS__:
 if frappe.db.get_value('Shangshu Department',dep,'enabled'):errors.append('active-department:'+dep)
for object_id in retired_objects:
 if int(frappe.db.get_value('Shangshu Object Model',object_id,'active_revision') or 0)!=0:
  errors.append('active-object:'+object_id)
 if not frappe.db.exists('Shangshu Object Model Retirement',{'object_id':object_id}):
  errors.append('no-retirement-record:'+object_id)
for application_id in retired_applications:
 if frappe.db.get_value('Shangshu Application Definition',application_id,'status')!='Disabled':
  errors.append('active-application:'+application_id)
for file in __FILES__:
 if frappe.db.get_value('Shangshu File Center File',file,'status')!='Recycled':errors.append('active-file:'+file)
RESULT['errors']=errors
RESULT['retired_objects']=retired_objects
RESULT['retired_applications']=retired_applications
'''.replace('__PREFIX__', repr(self.prefix)).replace('__USERS__', repr(list(self.users.values())))
            .replace('__DEPTS__', repr(list(self.departments.values()))).replace('__FILES__', repr(self.files)))
        errors.extend(out.get('errors', []))
        if out.get('__error__'): errors.append('cleanup verification failed')
        self.check('exact fixtures recycled/disabled; audit retained', not errors)
        print('FIXTURE', json.dumps({'prefix': self.prefix, 'files': self.files,
              'departments': self.departments,
              'retired_objects': out.get('retired_objects', []),
              'retired_applications': out.get('retired_applications', []),
              'cleanup_errors': errors}, ensure_ascii=False))

    def finish(self):
        print('RESULT', sum(self.checks), '/', len(self.checks))
        return 0 if self.checks and all(self.checks) else 1


def main():
    f = Fixture('roles', ('owner', 'member', 'head', 'child', 'peer', 'none', 'boss', 'reader'))
    try:
        f.setup()
        for level, attribution in (
            ('personal', {'level': 'personal', 'owner_user': f.users['owner']}),
            ('department', {'level': 'department', 'department': f.departments['a']}),
        ):
            created = f.action(f.clients['owner'], 'files.create', {
                'file_name': f.prefix + '-create-' + level + '.xlsx', 'attribution': attribution})
            f.check('UI018 actual create allowed ' + level, successful(created))
        personal = {}
        for role in ('owner', 'child', 'peer', 'none'):
            personal[role] = f.upload(role, role, {'level': 'personal', 'owner_user': f.users[role]})
        # Boss isn't System Manager. Head reads descendants, never peers/no-dept.
        allowed = {'boss': set(personal), 'head': {'owner', 'child'},
                   'member': set(), 'peer': {'peer'}, 'none': {'none'}}
        for actor, sources in allowed.items():
            for source, file in personal.items():
                response = f.view(f.clients[actor], file)
                f.check('UI017 personal read ' + actor + '/' + source,
                        successful(response) if source in sources else denied(response))
        for actor in ('boss', 'head'):
            file = personal['owner']; before = result(f.view(f.admin, file))
            f.check('UI017 management read does not grant write ' + actor,
                    denied(f.write(f.clients[actor], file, 'forbidden')))
            after = result(f.view(f.admin, file))
            f.check('UI017 denied write preserves values/version ' + actor,
                    before['rows'] == after['rows'] and before['content_version'] == after['content_version'])
            f.check('UI017 management read does not grant original download ' + actor,
                    denied(f.t.download(f.clients[actor], file, f.reference(file))))
        department = f.upload('owner', 'department', {'level': 'department', 'department': f.departments['a']})
        detail = result(f.service(f.clients['owner'], 'files.versions', {'file': department}))
        f.check('UI018 new department creator is current custodian',
                detail.get('file', {}).get('attribution', {}).get('owner_user') == f.users['owner'])
        f.check('UI018 current custodian edits', successful(f.write(f.clients['owner'], department, '管理人写入')))
        for actor in ('member', 'head'):
            f.check('UI018 department member reads ' + actor, successful(f.view(f.clients[actor], department)))
            f.check('UI018 create membership does not grant other writer ' + actor,
                    denied(f.write(f.clients[actor], department, 'forbidden')))
            response = f.t.download(f.clients[actor], department, f.reference(department))
            f.check('UI018 independent department download grant ' + actor,
                    response[0] == 200 and response[1].get('_bytes', b'').startswith(b'PK'))
        # Invalid create is an actual HTTP operation; 500/transport failures fail.
        name = f.prefix + '-cross-create.xlsx'
        payload = {'file_name': name, 'attribution': {'level': 'department', 'department': f.departments['peer']}}
        before = result(f.listing(f.admin, q=name)).get('total')
        bad = f.action(f.clients['member'], 'files.create', payload)
        after = result(f.listing(f.admin, q=name)).get('total')
        f.check('UI018 unauthorized cross-department create denied zero resources', denied(bad) and before == after == 0)
        grant = f.action(f.admin, 'platform.org.create_grant', {
            'user': f.users['member'], 'department': f.departments['peer'], 'scope': 'create'})
        f.check('UI018 explicit cross-department create grant succeeds', successful(grant))
        created = f.action(f.clients['member'], 'files.create', payload)
        f.check('UI018 explicit grant creates at target department', successful(created))
        if successful(created):
            file = result(created)['file']
            response = f.service(f.clients['peer'], 'files.versions', {'file': file})
            value = result(response).get('file', {})
            f.check('UI018 target peer read only, no sharing/assignment/structure',
                    successful(response) and value.get('can_edit') is False
                    and value.get('can_share') is False and value.get('can_assign') is False
                    and value.get('can_structure') is False)
        # Same-session revocation; independent read grant is not an export grant.
        file = personal['owner']; client = f.clients['reader']
        f.check('share read created', successful(f.action(f.clients['owner'], 'platform.org.share_grant',
                {'resource': file, 'user': f.users['reader'], 'access': 'read'})))
        f.check('read shared resource via HTTP', successful(f.view(client, file)))
        f.check('read share cannot download', denied(f.t.download(client, file, f.reference(file))))
        f.check('share revoked', successful(f.action(f.clients['owner'], 'platform.org.share_revoke',
                {'resource': file, 'user': f.users['reader']})))
        f.check('same session old link rejected after revoke', denied(f.view(client, file)))
    except Exception as exc:
        f.check('runner/prerequisite completed: ' + type(exc).__name__ + ': ' + str(exc), False)
    finally:
        # Cross-department create alone does not grant read. Join only the synthetic
        # target department for creator cleanup, after all authorization assertions.
        if "member" in f.clients and "peer" in f.departments:
            moved = f.action(f.admin, "platform.org.member_assign", {"user": f.users["member"], "department": f.departments["peer"]})
            f.check("cleanup creator joins exact synthetic target department", successful(moved))
        f.cleanup()
    print('NOT_COVERED PDF body preview/private File URL, proposal approval, frontend controls/return-state; no UI017/018 whole-case PASS claim')
    return f.finish()


if __name__ == '__main__':
    if '--execute-live' not in sys.argv:
        sys.exit('Live writes require --execute-live and explicit SS_BASE after a released QA window')
    sys.exit(main())
