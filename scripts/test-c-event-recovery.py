"""C 事件提交/进程退出恢复探针；只允许既有独立回归库。"""
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

root = Path(sys.argv[1]).resolve()
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root / 'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非独立回归目录')
config = json.loads((root / 'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_name') != 'shangshu_b_tests' or config.get('db_socket') != str(root / 'db.sock'):
    raise SystemExit('拒绝其他数据库')
repo = Path(__file__).resolve().parent.parent
for app in ('shangshu_orders', 'shangshu_warehouse'):
    sys.path.insert(0, str(repo / 'frappe_apps' / app))
os.chdir(root / 'sites')
import frappe
frappe.init(site='b-test.localhost')
frappe.connect()
frappe.set_user('Administrator')
from shangshu_core.events import publish_event, raw_resource, recover_event_deliveries
try:
    phase = sys.argv[2] if len(sys.argv) > 2 else 'verify'
    if phase in ('rollback', 'publish'):
        domain, resource = raw_resource('events', 'platform.contract.checked')
        original = raw_resource
        def resolve(section, resource_id):
            return (domain, {**resource, 'delivery': 'after_commit'}) if section == 'events' else original(section, resource_id)
        with patch('shangshu_core.events.raw_resource', side_effect=resolve):
            event = publish_event(resource['id'], {'source': sys.argv[3]}, sys.argv[3])
        assert event['status'] == 'Published' and event['deliveries'][0]['attempts'] == 0
        if phase == 'rollback':
            frappe.db.rollback()
        else:
            frappe.db.commit()
        os._exit(17 if phase == 'publish' else 0)
    elif phase == 'recover':
        recover_event_deliveries()
    else:
        key = 'C-restart-' + frappe.generate_hash(length=16)
        def child(mode, expected=0):
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(root), mode, key], timeout=90)
            assert result.returncode == expected, (mode, result.returncode)
            frappe.db.rollback()  # 独立连接重新读已提交事实。
        child('rollback')
        assert not frappe.db.exists('Shangshu Event Envelope', {'idempotency_key': key})
        child('publish', 17)
        name = frappe.db.get_value('Shangshu Event Envelope', {'idempotency_key': key}, 'name')
        assert frappe.get_doc('Shangshu Event Envelope', name).status == 'Published'
        child('recover')
        event = frappe.get_doc('Shangshu Event Envelope', name)
        assert event.status == 'Delivered'
        first = event.deliveries_json
        child('recover')
        assert frappe.get_doc('Shangshu Event Envelope', name).deliveries_json == first
        print('PASS: 未提交发布回滚；提交后进程退出；新进程扫描恢复；再次扫描不重复消费')
finally:
    frappe.db.rollback()
    frappe.destroy()
