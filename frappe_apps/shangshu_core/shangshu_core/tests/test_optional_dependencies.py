"""可选依赖只放宽安装/启停前置条件，不放宽目标执行和授权。"""
from contextlib import contextmanager
from unittest.mock import patch

import frappe
import yaml
from frappe.tests.utils import FrappeTestCase

from shangshu_core.domains import ensure_registered_domains, set_domain_enabled
from shangshu_core.domain_execution import domain_execution
from shangshu_core.lifecycle import assert_declared_call, domain_lifecycle
from shangshu_core.manifest import _check_dependencies

CORE = 'com.shangshu.core'
FINANCE = 'com.shangshu.finance'


@contextmanager
def optional_manifest(constraint='>=0.2 <1.0'):
    original = yaml.safe_load
    def load(text):
        value = original(text)
        if value['id'] == CORE:
            value['optional_dependencies'] = [FINANCE + '@"' + constraint + '"']
        return value
    with patch('shangshu_core.lifecycle.yaml.safe_load', side_effect=load):
        yield


class TestOptionalDependencies(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        ensure_registered_domains()
        # These tests isolate finance lifecycle; the separately tested orders
        # consumer is installed in the integrated baseline but not active here.
        # 合并说明：fast 那边用**真实生命周期口**（set_domain_enabled）隔离，并在 tearDown
        # 用真实口复原；本分支直接改库 + addCleanup 复原（不触发强依赖检查，隔离更稳）。
        # 两边都留：setUp 按本分支口径隔离，tearDown 按 fast 的口径用真实口复原。
        dependent = 'com.shangshu.orders'
        self.orders_enabled = bool(frappe.db.get_value('Shangshu Domain', dependent, 'enabled'))
        enabled = frappe.db.get_value('Shangshu Domain', dependent, 'enabled')
        if enabled is not None:
            frappe.db.set_value('Shangshu Domain', dependent, 'enabled', 0)
            self.addCleanup(frappe.db.set_value, 'Shangshu Domain', dependent, 'enabled', enabled)

    def tearDown(self):
        frappe.set_user('Administrator')
        if getattr(self, 'orders_enabled', False):
            if not frappe.db.get_value('Shangshu Domain', FINANCE, 'enabled'):
                set_domain_enabled(FINANCE, True, '测试恢复目标')
            set_domain_enabled('com.shangshu.orders', True, '测试恢复消费者')
        super().tearDown()

    def test_missing_and_incompatible_optional_do_not_block_registration(self):
        manifests = {CORE:{'version':'0.3.0', 'optional_dependencies':[FINANCE+'@">=99"']}}
        _check_dependencies(manifests)
        manifests[FINANCE] = {'version':'0.2.0', 'dependencies':[CORE+'@">=0.1 <1"']}
        _check_dependencies(manifests)
        manifests[CORE]['dependencies'] = manifests[CORE].pop('optional_dependencies')
        with self.assertRaises(frappe.ValidationError):
            _check_dependencies(manifests)

    def test_optional_declaration_errors_are_not_silently_ignored(self):
        for declaration in ('bad', CORE+'@">=0.1"', FINANCE+'@"broken"'):
            with self.assertRaises(frappe.ValidationError):
                _check_dependencies({'com.shangshu.caller':{'version':'1.0.0', 'optional_dependencies':[declaration]}})
        with self.assertRaises(frappe.ValidationError):
            _check_dependencies({CORE:{'version':'0.3.0'}, 'com.shangshu.caller':{'version':'1.0.0', 'dependencies':[CORE+'@">=0.1"'], 'optional_dependencies':[CORE+'@">=0.1"']}})

    def test_lifecycle_marks_optional_and_does_not_block_target_stop(self):
        with optional_manifest():
            requirement = next(item for item in domain_lifecycle(CORE)['requirements'] if item['id']==FINANCE)
            self.assertTrue(requirement['optional'])
            self.assertTrue(requirement['available'])
            set_domain_enabled(FINANCE, False, '可选依赖隔离测试', stop_mode='complete')
            requirement = next(item for item in domain_lifecycle(CORE)['requirements'] if item['id']==FINANCE)
            self.assertFalse(requirement['available'])
            with domain_execution(CORE):
                pass
            with self.assertRaises(frappe.PermissionError):
                with domain_execution(FINANCE, allow_disabled=True):
                    self.fail('完全停用目标不得执行')
            set_domain_enabled(FINANCE, True, '可选依赖恢复测试')
            with domain_execution(FINANCE):
                pass

    def test_optional_call_requires_compatible_installed_target(self):
        # 使用真实域记录，但用公开调用上下文模拟业务调用者，不授予目标角色。
        previous = getattr(frappe.flags, 'shangshu_call_domain', None)
        frappe.flags.shangshu_call_domain = FINANCE
        original = yaml.safe_load
        def load(text):
            value = original(text)
            if value['id'] == FINANCE:
                value['optional_dependencies'] = ['com.shangshu.missing@">=0.1"']
            return value
        try:
            with patch('shangshu_core.lifecycle.yaml.safe_load', side_effect=load):
                with self.assertRaises(frappe.ValidationError):
                    assert_declared_call('com.shangshu.missing')
            with self.assertRaises(frappe.PermissionError):
                assert_declared_call('com.shangshu.undeclared')
        finally:
            frappe.flags.shangshu_call_domain = previous

    def test_consumer_enable_and_calls_survive_optional_target_stop(self):
        caller = 'com.shangshu.optionaltest'
        frappe.get_doc({'doctype':'Shangshu Domain', 'domain_id':caller, 'display_name':'可选依赖隔离夹具',
            'owner_app':'shangshu_core', 'domain_version':'0.3.0', 'enabled':1,
            'contribution_json':'{"id":"com.shangshu.optionaltest"}'}).insert()
        with optional_manifest():
            with domain_execution(caller):
                with domain_execution(FINANCE):
                    pass
            version = frappe.db.get_value('Shangshu Domain', FINANCE, 'domain_version')
            frappe.db.set_value('Shangshu Domain', FINANCE, 'domain_version', '99.0.0')
            with domain_execution(caller):
                with self.assertRaises(frappe.ValidationError):
                    with domain_execution(FINANCE):
                        self.fail('不兼容的可选目标不得执行')
            frappe.db.set_value('Shangshu Domain', FINANCE, 'domain_version', version)
            set_domain_enabled(FINANCE, False, '可选目标停用', stop_mode='complete')
            set_domain_enabled(caller, False, '来源域停用', stop_mode='complete')
            set_domain_enabled(caller, True, '目标未启用仍可启用来源域')
            with domain_execution(caller):
                with self.assertRaises(frappe.PermissionError):
                    with domain_execution(FINANCE):
                        self.fail('可选声明不能绕过停用屏障')
            set_domain_enabled(FINANCE, True, '恢复可选目标')
            with domain_execution(caller):
                with domain_execution(FINANCE):
                    pass
