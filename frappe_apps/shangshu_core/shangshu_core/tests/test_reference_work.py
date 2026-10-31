"""记录级租约/通知沿原确认链；真实库仅使用合成身份。"""
import uuid
from contextlib import contextmanager
from unittest.mock import patch
import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core import public_api as api


def _update_test_handler(action,payload,context):
    return api.update_reference_work(payload['object_id'],payload['name'],previous_user='Administrator',
        recipient_user='Administrator',event_key=payload['event_key'],title='合成接手提醒',reason='原动作确认与审计')


class TestReferenceWork(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.key=uuid.uuid4().hex
        self.point='work_test_'+self.key
        frappe.db.savepoint(self.point)
        self.reference=frappe.get_doc({'doctype':'Role','role_name':'work-'+self.key}).insert(ignore_permissions=True)
        self.object={'id':'platform.test.work','doctype':'Role','operations':['read'],
            'fields':[{'id':'role_name','type':'string'}],'execution_actor_field':'owner'}
        from shangshu_core.domains import raw_resource
        self.resource=patch('shangshu_core.domains.raw_resource',side_effect=lambda section,key:({'id':'com.shangshu.core','contribution':{'owner_app':'shangshu_core'}},self.object) if section=='objects' and key==self.object['id'] else raw_resource(section,key))
        self.resource.start();self.addCleanup(self.resource.stop)

    def tearDown(self):
        frappe.set_user('Administrator')
        frappe.db.rollback(save_point=self.point)
        super().tearDown()

    def begin(self):return api.reference_execution('begin',object_id=self.object['id'],name=self.reference.name)

    @contextmanager
    def action(self):
        # 原动作执行器固定此pin；替身只验证受权上下文，不冒充业务动作实测。
        with patch.dict(frappe.flags,shangshu_action_pin={'action_id':'platform.test.mutate','action_version':'1.0.0'}), api.domain_execution('com.shangshu.core'):
            from shangshu_core.domains import raw_resource
            with patch('shangshu_core.domains.raw_resource',side_effect=lambda section,key:({'id':'com.shangshu.core'},{'effect':'write','version':'1.0.0'}) if section=='actions' and key=='platform.test.mutate' else raw_resource(section,key)):
                yield

    def test_begin_check_finish_do_not_create_business_tasks(self):
        lease=self.begin()
        self.assertEqual(api.reference_execution('check',execution_id=lease['id'])['status'],'Active')
        self.assertEqual(api.reference_execution('end',execution_id=lease['id'])['status'],'Completed')
        with self.assertRaises(frappe.PermissionError):api.reference_execution('check',execution_id=lease['id'])
        self.assertTrue(frappe.db.exists('Role',self.reference.name))

    def test_owner_change_and_expiration_revoke_authority_even_for_admin(self):
        from frappe.utils import add_to_date,now_datetime
        lease=self.begin()
        frappe.db.set_value('Role',self.reference.name,'owner','Guest')
        with self.assertRaises(frappe.PermissionError):api.reference_execution('check',execution_id=lease['id'])
        frappe.db.set_value('Role',self.reference.name,'owner','Administrator')
        frappe.db.set_value('Shangshu Reference Execution',lease['id'],'expires_at',add_to_date(now_datetime(),seconds=-1))
        with self.assertRaises(frappe.PermissionError):api.reference_execution('check',execution_id=lease['id'])

    def test_update_requires_matching_trusted_domain_and_revoke_is_idempotent(self):
        lease=self.begin()
        with self.assertRaises(frappe.PermissionError):api.update_reference_work(self.object['id'],self.reference.name,previous_user='Administrator',reason='外部不能直接取消')
        with self.action():
            first=api.update_reference_work(self.object['id'],self.reference.name,previous_user='Administrator',reason='合成交接撤销')
            second=api.update_reference_work(self.object['id'],self.reference.name,previous_user='Administrator',reason='重复核对')
        self.assertEqual(first['revoked'],1);self.assertEqual(second['revoked'],0)
        with self.assertRaises(frappe.PermissionError):api.reference_execution('check',execution_id=lease['id'])

    def test_notification_single_fact_close_and_recipient_scope(self):
        with self.action():
            values={'recipient_user':'Administrator','event_key':self.key,'title':'合成接手提醒','reason':'核对原事项，不外发邮件'}
            first=api.update_reference_work(self.object['id'],self.reference.name,**values)
            second=api.update_reference_work(self.object['id'],self.reference.name,**values)
            self.assertEqual(first['notification'],second['notification'])
        rows=api.reference_notifications()['rows']
        self.assertEqual(sum(row['name']==first['notification'] for row in rows),1)
        with self.action():
            api.update_reference_work(self.object['id'],self.reference.name,previous_user='Administrator',reason='合成提醒收尾')
        self.assertFalse(any(row['name']==first['notification'] for row in api.reference_notifications()['rows']))
        frappe.set_user('Guest')
        with self.assertRaises(frappe.PermissionError):api.reference_notifications()

    def test_revoke_closes_original_unexecuted_proposal_and_never_executes_it(self):
        app=api.create_application_definition('合成租约应用',self.key)
        payload={'application_id':app['id'],'expected_revision':app['draft_revision'],'definition':app['draft']}
        lease=self.begin()
        proposal=api.propose_registered_action('platform.application.configure',payload,execution_id=lease['id'])
        api.reference_execution('end',execution_id=lease['id'])
        with self.action():
            api.update_reference_work(self.object['id'],self.reference.name,previous_user='Administrator',reason='已交接，不再执行旧提案')
        result=api.resolve_action_proposal(proposal['id'],'confirmed')
        self.assertEqual(result['status'],'rejected')
        self.assertFalse(frappe.db.exists('Shangshu Action Execution Audit',{'idempotency_key':frappe.db.get_value('Shangshu Action Proposal',proposal['id'],'idempotency_key')}))

    def test_composite_failure_restores_original_lease_and_notification(self):
        lease=self.begin()
        with self.action():
            values={'recipient_user':'Administrator','event_key':self.key,'title':'原合成提醒','reason':'原依据'}
            original=api.update_reference_work(self.object['id'],self.reference.name,**values)
            with self.assertRaises(frappe.TimestampMismatchError):
                api.update_reference_work(self.object['id'],self.reference.name,previous_user='Administrator',**{**values,'title':'篡改同键内容'})
        self.assertEqual(api.reference_execution('check',execution_id=lease['id'])['status'],'Active')
        self.assertEqual(frappe.db.get_value('Shangshu Reference Notification',original['notification'],'status'),'Pending')

    def test_raw_mutations_cannot_create_or_rewrite_work_authority(self):
        lease=self.begin();doc=frappe.get_doc('Shangshu Reference Execution',lease['id']);doc.actor_user='Guest'
        with self.assertRaises(frappe.PermissionError):doc.save(ignore_permissions=True)
        with self.assertRaises(frappe.PermissionError):frappe.delete_doc(doc.doctype,doc.name,ignore_permissions=True)

    def test_readonly_domain_context_cannot_mutate_notifications(self):
        with api.domain_execution('com.shangshu.core'), self.assertRaises(frappe.PermissionError):
            api.update_reference_work(self.object['id'],self.reference.name,recipient_user='Administrator',event_key=self.key,title='拒绝绕过',reason='仅有域上下文，不是写动作')

    def test_source_guard_can_authorize_manager_without_globally_granting_write(self):
        self.object['work_update_guard']='shangshu_core.tests.synthetic_work_guard'
        with self.action(), patch.object(type(self.reference),'has_permission',side_effect=lambda permission,user=None:permission=='read'), patch('frappe.get_attr',return_value=lambda doc,user,action:action['action_id']=='platform.test.mutate'):
            result=api.update_reference_work(self.object['id'],self.reference.name,previous_user='Administrator',reason='原域管理动作明确受权')
            self.assertEqual(result['revoked'],0)
        self.object['work_update_guard']='foreign_app.unsafe'
        with self.action(), patch.object(type(self.reference),'has_permission',side_effect=lambda permission,user=None:permission=='read'), self.assertRaises(frappe.PermissionError):
            api.update_reference_work(self.object['id'],self.reference.name,previous_user='Administrator',reason='不能借其他域守卫')

    def test_locked_checks_read_current_document_not_prior_transaction_snapshot(self):
        original=frappe.get_doc;lease=self.begin()
        with patch('frappe.get_doc',side_effect=original) as reads:
            api.reference_execution('check',execution_id=lease['id'])
        self.assertTrue(any(call.args[:2]==('Role',self.reference.name) and call.kwargs.get('for_update') for call in reads.call_args_list))
        self.assertTrue(any(call.args[:2]==('Shangshu Reference Execution',lease['id']) and call.kwargs.get('for_update') for call in reads.call_args_list))

    def test_original_action_audit_and_idempotency_cover_work_effects(self):
        action_id='platform.test.work.'+self.key
        api.register_action(action_id,'1.0.0','合成原事项交接','write','required',roles=['System Manager'],input_schema={'type':'object'})
        from shangshu_core.domains import raw_resource
        resource={'id':action_id,'version':'1.0.0','effect':'write','handler':'shangshu_core.tests.test_reference_work._update_test_handler'}
        lookup=lambda section,key:({'id':'com.shangshu.core','owner_app':'shangshu_core'},resource) if section=='actions' and key==action_id else raw_resource(section,key)
        lease=self.begin();payload={'object_id':self.object['id'],'name':self.reference.name,'event_key':self.key}
        with patch('shangshu_core.domains.raw_resource',side_effect=lookup),patch('shangshu_core.actions.raw_resource',side_effect=lookup):
            with self.assertRaises(frappe.ValidationError):api.execute_registered_action(action_id,payload,idempotency_key=self.key)
            self.assertEqual(api.reference_execution('check',execution_id=lease['id'])['status'],'Active')
            first=api.execute_registered_action(action_id,payload,confirmed=True,idempotency_key=self.key)
            second=api.execute_registered_action(action_id,payload,confirmed=True,idempotency_key=self.key)
        self.assertEqual(first['audit'],second['audit'])
        self.assertEqual(first['result']['notification'],second['result']['notification'])
        self.assertEqual(frappe.db.get_value('Shangshu Reference Execution',lease['id'],'status'),'Cancelled')

    def test_agent_can_confirm_own_handover_without_rejecting_current_proposal(self):
        action_id='platform.test.work.agent.'+self.key
        api.register_action(action_id,'1.0.0','合成助手交接','write','required',roles=['System Manager'],input_schema={'type':'object'})
        from shangshu_core.domains import raw_resource
        resource={'id':action_id,'version':'1.0.0','effect':'write','handler':'shangshu_core.tests.test_reference_work._update_test_handler'}
        lookup=lambda section,key:({'id':'com.shangshu.core','owner_app':'shangshu_core'},resource) if section=='actions' and key==action_id else raw_resource(section,key)
        lease=self.begin();payload={'object_id':self.object['id'],'name':self.reference.name,'event_key':self.key}
        with patch('shangshu_core.domains.raw_resource',side_effect=lookup),patch('shangshu_core.actions.raw_resource',side_effect=lookup),patch('shangshu_core.actions.platform_contributions',return_value={'tools':[{'id':action_id}]}):
            proposal=api.propose_registered_action(action_id,payload,execution_id=lease['id'])
            other=api.propose_registered_action(action_id,payload,execution_id=lease['id'])
            result=api.resolve_action_proposal(proposal['id'],'confirmed')
            self.assertEqual(result['status'],'confirmed')
            with patch('shangshu_core.tests.test_reference_work._update_test_handler', side_effect=AssertionError('receipt retry must not execute')):
                self.assertEqual(api.resolve_action_proposal(proposal['id'],'confirmed')['status'],'confirmed')
            with patch.object(type(self.reference), 'has_permission', return_value=False):
                with self.assertRaises(frappe.PermissionError):
                    api.resolve_action_proposal(proposal['id'],'confirmed')
            with patch('shangshu_core.actions._assert_action_role', side_effect=frappe.PermissionError):
                with self.assertRaises(frappe.PermissionError):
                    api.resolve_action_proposal(proposal['id'],'confirmed')
            resource['replay_guard']='shangshu_core.tests.test_reference_work._update_test_handler'
            with patch('shangshu_core.actions.invoke_replay_guard', side_effect=frappe.PermissionError) as guard:
                with self.assertRaises(frappe.PermissionError):
                    api.resolve_action_proposal(proposal['id'],'confirmed')
                guard.assert_called_once()
            resource.pop('replay_guard')
            with self.assertRaises(frappe.PermissionError):
                api.execute_registered_action(action_id,payload,confirmed=True,idempotency_key=self.key+'-new',execution_id=lease['id'])
        self.assertEqual(frappe.db.get_value('Shangshu Action Proposal',other['id'],'status'),'Rejected')
        self.assertEqual(frappe.db.get_value('Shangshu Reference Execution',lease['id'],'status'),'Cancelled')

    def test_source_declared_guard_failure_and_cross_identity_are_fail_closed(self):
        from shangshu_core.domains import _public
        projection=_public({'objects':[{'execution_guard':'shangshu_core.private_guard','work_update_guard':'shangshu_core.private_write_guard'}]})
        self.assertNotIn('execution_guard',projection['objects'][0])
        self.assertNotIn('work_update_guard',projection['objects'][0])
        lease=self.begin();self.object['execution_guard']='shangshu_core.tests.synthetic_execution_guard'
        with patch('frappe.get_attr',return_value=lambda doc,user:False),self.assertRaises(frappe.PermissionError):
            api.reference_execution('check',execution_id=lease['id'])
        self.object.pop('execution_guard')
        from shangshu_core.reference_work import authorize_execution
        frappe.set_user('Guest')
        with self.assertRaises(frappe.PermissionError):authorize_execution(lease['id'])

    def test_active_execution_limit_does_not_create_ninth_lease(self):
        leases=[self.begin() for _ in range(8)]
        with self.assertRaises(frappe.ValidationError):self.begin()
        api.reference_execution('end',execution_id=leases[0]['id'])
        self.assertEqual(self.begin()['status'],'Active')

    def test_complete_domain_stop_denies_old_lease_and_restore_keeps_it(self):
        # 合成来源元数据绑定真实finance生命周期；不复制或写财务事实。
        from shangshu_core.domains import raw_resource
        frappe.db.set_value('Shangshu Domain','com.shangshu.finance',{'enabled':1,'execution_stopped':0})
        projected=lambda section,key:({'id':'com.shangshu.finance','owner_app':'shangshu_finance'},self.object) if section=='objects' and key==self.object['id'] else raw_resource(section,key)
        with patch('shangshu_core.domains.raw_resource',side_effect=projected):
            lease=self.begin()
            with patch('shangshu_core.lifecycle.domain_lifecycle',return_value={'disable_blockers':[],'stop_blockers':[],'requirements':[]}):
                api.set_domain_enabled('com.shangshu.finance',False,'合成租约停域核对',stop_mode='complete')
                with self.assertRaises(frappe.PermissionError):api.reference_execution('check',execution_id=lease['id'])
                # 原核心来源不受业务域完全停用牵连。
                with patch('shangshu_core.domains.raw_resource',side_effect=raw_resource):self.assertEqual(self.begin()['status'],'Active')
                api.set_domain_enabled('com.shangshu.finance',True,'合成租约恢复核对')
            self.assertEqual(api.reference_execution('check',execution_id=lease['id'])['status'],'Active')

    def test_lease_and_notification_cannot_cross_current_enterprise(self):
        lease=self.begin();identity=api.get_identity()
        with self.action():
            notice=api.update_reference_work(self.object['id'],self.reference.name,recipient_user='Administrator',event_key=self.key,title='本企业合成提醒',reason='本企业事项')
        frappe.db.set_value('Shangshu Reference Execution',lease['id'],'enterprise_id','foreign-synthetic-enterprise')
        with self.assertRaises(frappe.PermissionError):api.reference_execution('check',execution_id=lease['id'])
        frappe.db.set_value('Shangshu Identity',identity.name,'enterprise_id','foreign-synthetic-enterprise')
        self.assertNotIn(notice['notification'],[row['name'] for row in api.reference_notifications()['rows']])
        frappe.db.set_value('Shangshu Identity',identity.name,'status','Disabled')
        with self.action(),self.assertRaises(frappe.PermissionError):
            api.update_reference_work(self.object['id'],self.reference.name,recipient_user='Administrator',event_key=self.key,title='不能跨身份',reason='身份停用必须拒绝')
