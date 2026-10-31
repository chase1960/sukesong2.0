"""业务唯一键实库回归：仅在独立 allow_tests 站点运行；不接触用户站或冻结 demo。

用法：python scripts/test-unique-keys.py <site> [sites_path]
"""
import sys

site = sys.argv[1] if len(sys.argv) > 1 else ''
sites_path = sys.argv[2] if len(sys.argv) > 2 else None
if not site.endswith('.localhost') or not sites_path:
    raise SystemExit('用法：test-unique-keys.py <site.localhost> <sites_path>')

import frappe  # noqa: E402
frappe.init(site=site, sites_path=sites_path)
frappe.connect()
if not frappe.conf.get('allow_tests'):
    raise SystemExit('拒绝在未开启 allow_tests 的站点运行')
frappe.set_user('Administrator')

from shangshu_core.public_api import (  # noqa: E402
    create_application_definition, prepare_object_change, execute_object_change, execute_registered_action,
)

checks = []


def check(label, valid):
    checks.append((label, bool(valid)))
    print(('OK  ' if valid else 'FAIL ') + label)


def rejected(label, operation, expected):
    try:
        operation()
    except expected:
        check(label, True)
    else:
        check(label, False)


def run():
    app = create_application_definition('唯一键回归', 'uq-' + frappe.generate_hash(length=20))

    def table(title, fields, **extra):
        planned = prepare_object_change(app['id'], {'schema_version': 1, 'title': title, 'fields': fields, **extra},
                                        frappe.generate_hash(length=24))
        frappe.db.commit()
        execute_object_change(planned['id'], True)
        return planned['object_id']

    def create(target, values):
        return execute_registered_action('platform.object.create',
            {'object_id': target, 'expected_revision': 1, 'values': values}, True, frappe.generate_hash(length=24))['result']

    uid = table('业务唯一键表', [{'id': 'title', 'label': '名称', 'type': 'text'},
                              {'id': 'quantity', 'label': '数量', 'type': 'integer'}], unique_keys=[['title', 'quantity']])
    first = create(uid, {'title': '同值', 'quantity': 1})
    rejected('同组合重复被拒绝', lambda: create(uid, {'title': '同值', 'quantity': 1}), frappe.ValidationError)
    check('组合取值不同可保存', bool(create(uid, {'title': '同值', 'quantity': 2})['name']))
    updated = execute_registered_action('platform.object.update', {'object_id': uid, 'expected_revision': 1,
        'name': first['name'], 'expected_modified': first['modified'], 'values': {'title': '同值', 'quantity': 1}},
        True, frappe.generate_hash(length=24))['result']
    check('自身字段不与自己冲突', updated['name'] == first['name'])
    check('空值不参与唯一', bool(create(uid, {'title': '', 'quantity': 0})['name'])
          and bool(create(uid, {'title': '', 'quantity': 0})['name']))
    trashed = execute_registered_action('platform.object.recycle', {'object_id': uid, 'expected_revision': 1,
        'name': first['name'], 'expected_modified': updated['modified']}, True, frappe.generate_hash(length=24))['result']
    rejected('回收记录仍占用唯一键', lambda: create(uid, {'title': '同值', 'quantity': 1}), frappe.ValidationError)
    restored = execute_registered_action('platform.object.restore', {'object_id': uid, 'expected_revision': 1,
        'name': trashed['name'], 'expected_modified': trashed['modified']}, True, frappe.generate_hash(length=24))['result']
    check('自身回收后仍可恢复', restored['state'] == 'active')
    rejected('关联字段不能作为唯一键', lambda: prepare_object_change(app['id'], {'schema_version': 1, 'title': '唯一键非法',
        'fields': [{'id': 'title', 'label': '名称', 'type': 'text'},
                   {'id': 'linked', 'label': '关联', 'type': 'reference', 'target': uid}],
        'unique_keys': [['linked']]}, frappe.generate_hash(length=24)), frappe.ValidationError)
    rejected('重复声明唯一组合被拒绝', lambda: prepare_object_change(app['id'], {'schema_version': 1, 'title': '唯一键重复',
        'fields': [{'id': 'title', 'label': '名称', 'type': 'text'}], 'unique_keys': [['title'], ['title']]},
        frappe.generate_hash(length=24)), frappe.ValidationError)


try:
    run()
except Exception as error:  # noqa: BLE001
    checks.append(('运行未抛异常', False))
    print('EXCEPTION ' + repr(error))

frappe.db.rollback()
print('TOTAL %d PASS %d FAIL %d' % (len(checks), sum(1 for _, ok in checks if ok), sum(1 for _, ok in checks if not ok)))
raise SystemExit(0 if all(ok for _, ok in checks) else 1)
