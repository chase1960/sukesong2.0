"""D：人工与 AI 使用同一应用草稿执行面，真实库验证。"""
import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (create_application_definition, get_application_definition,
    execute_registered_action, propose_registered_action, resolve_action_proposal, invoke_domain_service,
    list_registered_actions, list_action_proposals)


class TestApplicationDelivery(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')

    def test_import_references_are_remapped_and_preview_is_read_only(self):
        target=create_application_definition('导入关联',frappe.generate_hash(length=24))
        source='com.shangshu.app.'+'a'*32
        supplier=source+'.object.'+'b'*32
        order=source+'.object.'+'c'*32
        model={'schema_version':1,'kind':'record','title':'供应商','fields':[{'id':'title','label':'名称','type':'text'}]}
        package={'format':'shangshu.application/1','definition':{**target['draft'],'bindings':[
            {'kind':'objects','resource_id':supplier,'owner_domain':source,'version':'1'},
            {'kind':'objects','resource_id':order,'owner_domain':source,'version':'1'}]},
            'models':[{'id':order,'definition':{**model,'title':'采购单','fields':[{'id':'supplier','label':'供应商','type':'reference','target':supplier}]}},
                      {'id':supplier,'definition':model}], 'dependencies':[]}
        payload={'operation':'import_preview','application_id':target['id'],'package':package}
        preview=invoke_domain_service('platform.application.delivery',payload)
        self.assertEqual(len(preview['models']),2)
        self.assertEqual(preview['models'][1]['definition']['fields'][0]['target'],preview['models'][0]['object_id'])
        self.assertTrue(all(binding['owner_domain']==target['id'] for binding in preview['definition']['bindings']))
        self.assertFalse(frappe.db.exists('Shangshu Object Model',{'application':target['id']}))
        self.assertEqual(preview,invoke_domain_service('platform.application.delivery',payload))
        package['dependencies']=[{'resource_id':'fabricated'}]
        with self.assertRaisesRegex(frappe.ValidationError,'依赖'):
            invoke_domain_service('platform.application.delivery',payload)

    def test_package_is_definition_only_and_conflicts_do_not_write(self):
        source=create_application_definition('采购定义源',frappe.generate_hash(length=24))
        target=create_application_definition('采购导入目标',frappe.generate_hash(length=24))
        package=invoke_domain_service('platform.application.delivery', {'operation':'export','application_id':source['id']})['package']
        self.assertEqual(set(package), {'format','definition','models','dependencies'})
        preview=invoke_domain_service('platform.application.delivery', {'operation':'import_preview','application_id':target['id'],'package':package})
        self.assertEqual(preview['expected_revision'],1)
        self.assertEqual(get_application_definition(target['id'])['draft_revision'],1)
        self.assertEqual(preview['definition']['title'],'采购定义源')
        with self.assertRaises(frappe.ValidationError):
            invoke_domain_service('platform.application.delivery', {'operation':'import_preview','application_id':target['id'],'package':{**package,'password':'not-allowed'}})
        execute_registered_action('platform.application.configure',{'application_id':target['id'],'expected_revision':1,'definition':preview['definition']},confirmed=True,idempotency_key=frappe.generate_hash(length=24))
        with self.assertRaisesRegex(frappe.ValidationError,'空应用'):
            invoke_domain_service('platform.application.delivery', {'operation':'import_preview','application_id':target['id'],'package':package})

    def test_human_and_ai_share_revision_confirmation_and_permissions(self):
        action = 'platform.application.configure'
        app = create_application_definition('D 采购配置', frappe.generate_hash(length=24))
        inspected=execute_registered_action('platform.application.inspect',{'application_id':app['id']})
        self.assertEqual(inspected['result']['draft_revision'],1)
        self.assertEqual(inspected['result']['draft'],get_application_definition(app['id'])['draft'])
        payload = {'application_id':app['id'], 'expected_revision':1,
                   'definition':{**app['draft'], 'title':'采购协同'}}
        with self.assertRaisesRegex(frappe.ValidationError, '必须经过确认'):
            execute_registered_action(action, payload, confirmed=False)
        self.assertEqual(get_application_definition(app['id'])['draft_revision'], 1)
        proposal = propose_registered_action(action, payload, frappe.generate_hash(length=24))
        self.assertEqual(proposal['preview']['status'],'checked')
        self.assertEqual(proposal['preview']['changes'][0]['after'],'采购协同')
        self.assertEqual(get_application_definition(app['id'])['draft_revision'], 1)
        result = resolve_action_proposal(proposal['id'], 'confirmed')
        self.assertEqual(result['result']['draft']['title'], '采购协同')
        self.assertEqual(result['result']['draft_revision'], 2)
        manual=create_application_definition('D 采购配置',frappe.generate_hash(length=24))
        human=execute_registered_action(action,{**payload,'application_id':manual['id']},confirmed=True,idempotency_key=frappe.generate_hash(length=24))
        self.assertEqual(human['result']['draft'],result['result']['draft'])
        self.assertFalse(human['result']['published_revision'])
        self.assertTrue(human['audit'])
        frappe.db.commit()  # Prior successful requests must survive the next action rollback.
        with self.assertRaisesRegex(frappe.TimestampMismatchError,'依赖'):
            execute_registered_action(action,{**payload,'application_id':manual['id'],'expected_revision':2,'dependency_hash':'stale'},confirmed=True,idempotency_key=frappe.generate_hash(length=24))
        # 旧修订提案不能覆盖人工后来保存的内容。
        stale = propose_registered_action(action, payload, frappe.generate_hash(length=24))
        self.assertEqual(stale['preview']['status'],'blocked')
        frappe.db.commit()  # Persist the proposal before its rejected confirmation request.
        with self.assertRaises(frappe.TimestampMismatchError):
            resolve_action_proposal(stale['id'], 'confirmed')
        user='delivery-'+frappe.generate_hash(length=12)+'@example.invalid'
        frappe.get_doc({'doctype':'User','email':user,'first_name':'普通员工','send_welcome_email':0,
                        'roles':[{'role':'Desk User'}]}).insert(ignore_permissions=True)
        frappe.set_user(user)
        self.assertNotIn(action,[item['id'] for item in list_registered_actions(tools_only=True)])
        self.assertNotIn('platform.application.inspect',[item['id'] for item in list_registered_actions(tools_only=True)])
        with self.assertRaises(frappe.PermissionError):
            execute_registered_action('platform.application.inspect',{'application_id':app['id']})
        with self.assertRaises(frappe.PermissionError):
            invoke_domain_service('platform.application.delivery',{'operation':'export','application_id':app['id']})
        with self.assertRaises(frappe.PermissionError):
            propose_registered_action(action, payload, frappe.generate_hash(length=24))

    def test_proposal_listing_does_not_cross_enterprise_boundary(self):
        app=create_application_definition('企业提案隔离',frappe.generate_hash(length=24))
        proposal=propose_registered_action('platform.application.configure',{'application_id':app['id'],
            'expected_revision':1,'definition':{**app['draft'],'title':'新名称'}},frappe.generate_hash(length=24))
        # 合成外企业数据，只用于验证列表不得因同角色而泄露提案。
        frappe.db.set_value('Shangshu Action Proposal',proposal['id'],'enterprise_id','foreign-test-enterprise')
        self.assertNotIn(proposal['id'],[item['id'] for item in list_action_proposals()["items"]])
        with self.assertRaises(frappe.PermissionError):resolve_action_proposal(proposal['id'],'confirmed')

    def test_conversation_is_pinned_on_proposal_and_written_only_with_confirmed_log(self):
        from shangshu_core.conversation_evidence import issue_conversation, conversation_scope
        from shangshu_core.unified_log import unified_rows
        first, other = issue_conversation(), issue_conversation()
        app = create_application_definition('合成会话证据测试', frappe.generate_hash(length=24))
        payload = {'application_id':app['id'], 'expected_revision':1,
                   'definition':{**app['draft'], 'title':'合成确认后才保存'}}
        key = frappe.generate_hash(length=24)
        with conversation_scope(first['credential']):
            proposal = propose_registered_action('platform.application.configure',payload,key)
        self.assertEqual(frappe.get_doc('Shangshu Action Proposal',proposal['id']).conversation_key,first['conversation_key'])
        self.assertEqual(unified_rows('action',{'idempotency_key':key}),[])
        self.assertEqual(get_application_definition(app['id'])['draft_revision'],1)
        # 确认发生在后续请求；自报另一场会话不能覆盖提案的原始关联。
        with conversation_scope(other['credential']):
            resolve_action_proposal(proposal['id'],'confirmed')
        rows=unified_rows('action',{'idempotency_key':key})
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['conversation_key'],first['conversation_key'])
        self.assertEqual(get_application_definition(app['id'])['draft_revision'],2)
        resolve_action_proposal(proposal['id'],'confirmed')
        self.assertEqual(len(unified_rows('action',{'idempotency_key':key})),1)
        cancelled_key=frappe.generate_hash(length=24)
        with conversation_scope(first['credential']):
            cancelled=propose_registered_action('platform.application.configure',
                {**payload,'expected_revision':2},cancelled_key)
        resolve_action_proposal(cancelled['id'],'rejected')
        self.assertEqual(unified_rows('action',{'idempotency_key':cancelled_key}),[])
