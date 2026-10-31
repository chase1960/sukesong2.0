"""单文件审核实库回归；仅独立自动回归站，禁止验收站。"""
import os as _os, sys as _sys
_sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tests')
                if os.path.basename(os.path.dirname(os.path.abspath(__file__))) != 'tests'
                else os.path.dirname(os.path.abspath(__file__)))
import _ss_fixture  # noqa: E402  测试夹具默认归属（**不是产品默认**）
import base64
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

root = Path(sys.argv[1]).resolve()
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root / 'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非自动回归站')
config = json.loads((root / 'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_name') != 'shangshu_b_tests' or config.get('db_socket') != str(root / 'db.sock'):
    raise SystemExit('数据库边界不匹配')
repo = Path(__file__).resolve().parents[2]
for app in ('core', 'finance', 'orders', 'warehouse', 'files', 'mail'):
    sys.path.insert(0, str(repo / 'frappe_apps' / ('shangshu_' + app)))
os.chdir(root / 'sites')
import frappe
from shangshu_core.public_api import (create_application_definition, prepare_object_change,
    execute_object_change, execute_registered_action, get_object_record, invoke_domain_service,
    query_dataset)
from shangshu_files.install import setup

frappe.init(site='b-test.localhost', sites_path=str(root / 'sites'))
frappe.connect(); frappe.set_user('Administrator')
file_id = None
checks = []
def check(label, condition):
    checks.append(bool(condition)); print(('✓ ' if condition else '✗ ') + label)
def act(action, payload, key=None):
    payload = _ss_fixture.fill(action, payload)  # 夹具默认归属（不是产品默认）
    return execute_registered_action(action, payload, True, key or frappe.generate_hash(length=24))
def reject(label, operation):
    try:
        operation()
    except (frappe.ValidationError, frappe.PermissionError):
        check(label, True)
    else:
        check(label, False)
def detail():
    return invoke_domain_service('files.review', {'file': file_id})

try:
    frappe.reload_doc('shangshu_files', 'doctype', 'shangshu_file_center_file', force=True)
    setup(); frappe.db.commit()
    file_id = act('files.upload', {'file_name': '审核-'+frappe.generate_hash(length=10)+'.txt',
        'content_base64': base64.b64encode(b'review fixture').decode()})['result']['file']
    context = detail()  # 首次红灯：审核服务尚不存在。
    check('新文件待审核且无虚构关联', context['file']['review_pending'] and not context['relations'])
    app = create_application_definition('审核自动回归', frappe.generate_hash(length=24))
    change = prepare_object_change(app['id'], {'schema_version': 1, 'title': '审核记录', 'fields': [
        {'id': 'title', 'label': '名称', 'type': 'text', 'required': True},
        {'id': 'date', 'label': '日期', 'type': 'date'}]}, frappe.generate_hash(length=24))
    frappe.db.commit(); execute_object_change(change['id'], True)
    obj = change['object_id']
    record = act('platform.object.create', {'object_id': obj, 'expected_revision': 1,
        'values': {'title': '原名称', 'date': '2026-09-01'}})['result']
    def payload(values=None):
        row = get_object_record(obj, record['name'])['record']
        f = detail()['file']
        return {'file': file_id, 'expected_modified': f['modified'], 'expected_version': f['version'],
            'file_name': f['file_name'], 'tags': ['审核'], 'note': '人工核对', 'relations': [{
                'object_id': obj, 'name': record['name'], 'expected_revision': 1,
                'expected_modified': row['modified'], 'values': values or {}}]}
    plan = payload({'title': '采用的新名称'})
    check('保存前正式字段不变', get_object_record(obj, record['name'])['record']['title'] == '原名称')
    key = frappe.generate_hash(length=24)
    result = act('files.review', plan, key)
    check('文件信息、关联和采用字段一起保存', not detail()['file']['review_pending'] and
        detail()['relations'][0]['name'] == record['name'] and
        get_object_record(obj, record['name'])['record']['title'] == '采用的新名称' and
        get_object_record(obj, record['name'])['record']['date'] == '2026-09-01')
    check('重复请求不二次修改', act('files.review', plan, key)['idempotent'])
    linked = {'scope': 'all', 'related_object': obj, 'related_record': record['name']}
    check('从业务记录查询真实关联文件', file_id in [r['name'] for r in query_dataset('files.file', linked)['rows']])
    other = act('platform.object.create', {'object_id': obj, 'expected_revision': 1,
        'values': {'title': '无文件的记录'}})['result']
    check('没有关联不混入同表其他文件', query_dataset('files.file', {**linked, 'related_record': other['name']})['total'] == 0)
    reject('关联筛选不接受半份引用', lambda: query_dataset('files.file', {'related_object': obj}))
    reject('空关联引用不能静默变成全部文件', lambda: query_dataset('files.file', {'related_object': '', 'related_record': ''}))
    with patch('shangshu_files.service.permission_query', return_value='1=0'):
        check('文件ACL限制同时应用于关联结果和计数', query_dataset('files.file', linked)['total'] == 0)
    from shangshu_core.public_api import list_registered_actions
    restore_definition = next(a for a in list_registered_actions() if a['id'] == 'files.restore')
    check('恢复增量使用版本化动作', restore_definition['version'] == '1.1.0')
    act('files.recycle', {'file': file_id})
    restored = frappe.get_doc('Shangshu File Center File', file_id)
    restore_payload = {'file': file_id, 'expected_modified': str(restored.modified), 'keep_relations': True}
    reject('恢复选择缺少快照明确拒绝', lambda: act('files.restore', {'file': file_id, 'keep_relations': False}))
    restore_key = frappe.generate_hash(length=24)
    act('files.restore', restore_payload, restore_key)
    check('保留关联恢复后两端可查询', len(detail()['relations']) == 1 and query_dataset('files.file', linked)['total'] == 1)
    check('恢复重放不重复办理', act('files.restore', restore_payload, restore_key)['idempotent'])
    act('files.recycle', {'file': file_id})
    restored = frappe.get_doc('Shangshu File Center File', file_id)
    clear_payload = {'file': file_id, 'expected_modified': str(restored.modified), 'keep_relations': False}
    reject('过期恢复快照不能覆盖', lambda: act('files.restore', restore_payload))
    with patch('shangshu_core.public_api.get_object_record', side_effect=frappe.PermissionError('已撤权')):
        reject('恢复不能静默解除已撤权目标', lambda: act('files.restore', clear_payload))
    check('拒绝后仍回收且原关联保留', frappe.db.get_value('Shangshu File Center File', file_id, 'status') == 'Recycled'
          and len(json.loads(frappe.db.get_value('Shangshu File Center File', file_id, 'relations_json'))) == 1)
    from frappe.model.document import Document
    original_restore_insert = Document.insert
    def fail_restore_audit(doc, *args, **kwargs):
        if doc.doctype == 'Shangshu Action Execution Audit' and doc.get('action_id') == 'files.restore':
            frappe.throw('测试恢复审计失败', frappe.ValidationError)
        return original_restore_insert(doc, *args, **kwargs)
    with patch.object(Document, 'insert', fail_restore_audit):
        reject('恢复审计失败同事务回滚', lambda: act('files.restore', clear_payload))
    check('回滚同时保留回收状态和关联', frappe.db.get_value('Shangshu File Center File', file_id, 'status') == 'Recycled'
          and len(json.loads(frappe.db.get_value('Shangshu File Center File', file_id, 'relations_json'))) == 1)
    act('files.restore', clear_payload)
    check('解除只改文件关联，业务值和版本不变', not detail()['relations']
          and get_object_record(obj, record['name'])['record']['title'] == '采用的新名称'
          and detail()['file']['version'] == 1)
    check('解除恢复立即从反向查询消失', query_dataset('files.file', linked)['total'] == 0)
    act('files.review', payload())
    from shangshu_core import public_api
    with patch.object(public_api, 'get_object_record', side_effect=frappe.PermissionError('已撤权')):
        reject('关联记录撤权后不返回文件和计数', lambda: query_dataset('files.file', linked))
    reject('旧文件修订拒绝覆盖', lambda: act('files.review', plan))
    from frappe.model.document import Document
    original = Document.insert
    def fail_outer(doc, *args, **kwargs):
        if doc.doctype == 'Shangshu Action Execution Audit' and doc.get('action_id') == 'files.review':
            frappe.throw('测试最终审核审计失败', frappe.ValidationError)
        return original(doc, *args, **kwargs)
    before = detail()['file']['modified']
    with patch.object(Document, 'insert', fail_outer):
        reject('最终审计失败整份回滚', lambda: act('files.review', payload({'title': '不应保存'})))
    check('正式字段、文件修订与关联没有部分成功', get_object_record(obj, record['name'])['record']['title'] == '采用的新名称' and detail()['file']['modified'] == before)
    invalid = payload({'date': '不是日期'})
    reject('字段校验失败不保存元信息', lambda: act('files.review', invalid))
    check('失败后文件修订不变', detail()['file']['modified'] == before)
    unbind = payload(); unbind['relations'] = []
    act('files.review', unbind)
    check('解除关联不删除文件或业务字段', not detail()['relations'] and get_object_record(obj, record['name'])['record']['title'] == '采用的新名称')
    check('解除关联立即从反向查询消失', query_dataset('files.file', linked)['total'] == 0)
    act('files.new_version', {'file': file_id, 'content_base64': base64.b64encode(b'new content').decode()})
    check('新原件版本重新待审核，旧版仍保留', detail()['file']['review_pending'] and detail()['file']['version'] == 2)
    reject('不能绕过审核动作直改审核状态', lambda: frappe.get_doc('Shangshu File Center File', file_id).update({'reviewed_version': 2}).save(ignore_permissions=True))
    frappe.db.rollback()
finally:
    frappe.db.rollback(); frappe.set_user('Administrator')
    if file_id and frappe.db.exists('Shangshu File Center File', file_id):
        attachments = frappe.get_all('File', filters={'attached_to_doctype': 'Shangshu File Center File', 'attached_to_name': file_id}, pluck='name')
        for row in frappe.get_all('Shangshu File Center Version', filters={'file': file_id}, pluck='name'):
            frappe.delete_doc('Shangshu File Center Version', row, force=True, ignore_permissions=True)
        frappe.delete_doc('Shangshu File Center File', file_id, force=True, ignore_permissions=True)
        for name in attachments:
            frappe.delete_doc('File', name, force=True, ignore_permissions=True)
    frappe.db.commit(); frappe.destroy()
print(f'{sum(checks)}/{len(checks)}')
if not all(checks):
    raise SystemExit(1)
