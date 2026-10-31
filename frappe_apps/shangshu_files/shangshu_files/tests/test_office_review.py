"""逐格审核沿同一提案／原文件动作，身份、版本、审计与原子边界均实库验证。

合并说明（2026-10-21）：本文件来自 fast 那条线，两处**按新契约改**（断言实质一条没删）：
  ① `files.create` **补上归属** —— 用户 2026-10-15「尚书是单例，没有企业归属」+
     「新建必填归属」⇒ 不传归属直接拒（NO_ATTRIBUTION）。口径比 fast 的测试新 ⇒ 改测试。
  ② `accept_action_proposal_units(...)` 的**位置参数按合并后的公共 API 重排** ——
     新签名是 `(proposal_id, op_id, expected_review_revision, units, edited_value)`
     （本分支那版；fast 那版是 `(proposal_id, units, edited_value, review_revision, op_id)`）。
     参数顺序是内核公共 API 的口径，不是业务断言 ⇒ 按新契约改，断言与取值一条没动。
"""
import uuid
import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (execute_registered_action,invoke_domain_service,
    propose_registered_action,resolve_action_proposal,get_action_proposal_review,accept_action_proposal_units)


class TestOfficeReview(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator');self.token=uuid.uuid4().hex
        self.user='review-'+self.token+'@example.invalid'
        self.act('platform.identity.create',{'email':self.user,'display_name':'审核回归',
            'initial_password':'Isolated-review-2026!','roles':['staff']})
        frappe.set_user(self.user)
        # 合并说明（2026-10-21）：**按新契约补上归属** —— 用户 2026-10-15 原话
        # 「尚书是单例，没有企业归属」+「新建必填归属」⇒ `files.create` 不传归属直接拒
        # （NO_ATTRIBUTION）。这条口径比 fast 那边的测试新，**改测试不改生产代码**：
        # 个人归属即可，下面每条断言一条没删。
        self.name=self.act('files.create',{'file_name':'审核-'+self.token,
            'attribution':{'level':'personal'}})['file']
        self.act('files.sheet_row_append',{**self.pin(),'count':2})
        data=self.read();self.ids=[row['row_id'] for row in data['rows']]
        self.proposal=propose_registered_action('files.sheet_cells_write',{**self.pin(),
            'cells':[{'row_id':rid,'header':'列1','value':{'type':'text','value':'候选'+str(i)}} for i,rid in enumerate(self.ids)]})['id']

    def tearDown(self):frappe.set_user('Administrator');super().tearDown()
    def act(self,name,payload):
        return execute_registered_action(name,payload,confirmed=True,idempotency_key=uuid.uuid4().hex)['result']
    def read(self):return invoke_domain_service('files.sheet_read',{'table':self.name})
    def pin(self):
        value=self.read();return {'table':self.name,'expected_content_version':value['content_version'],
                                  'expected_structure_version':value['structure_version']}

    def test_partial_edit_and_same_key_retry_then_finish(self):
        initial=self.read();review=get_action_proposal_review(self.proposal);first=review['units'][0]['unit_id']
        result=accept_action_proposal_units(self.proposal, 'step-one', review['review_revision'], [first], {first:{'type':'text','value':'人工修订'}})
        self.assertEqual(result['accepted_count'],1);self.assertEqual(result['remaining'],1)
        self.assertEqual(result['units'][0]['original_value'],initial['rows'][0]['values']['列1'])
        self.assertEqual(self.read()['rows'][0]['values']['列1']['value'],'人工修订')
        self.assertEqual(self.read()['rows'][1]['values']['列1'],initial['rows'][1]['values']['列1'])
        version=self.read()['content_version']
        replay=accept_action_proposal_units(self.proposal, 'step-one', review['review_revision'], [first], {first:{'type':'text','value':'人工修订'}})
        self.assertTrue(replay['idempotent']);self.assertEqual(self.read()['content_version'],version)
        self.assertEqual(resolve_action_proposal(self.proposal,'confirmed')['status'],'confirmed')
        self.assertEqual(self.read()['rows'][0]['values']['列1']['value'],'人工修订')
        self.assertEqual(self.read()['rows'][1]['values']['列1']['value'],'候选1')

    def test_other_employee_cannot_read_another_persons_private_review(self):
        # 合并说明（2026-10-21）：**按本分支的可见性口径改这条判据** ——
        # 本分支的提案可见性 = 「**先看目标当前读权**」（`shangshu_core/actions.py` 的
        # `_proposal_visible` → `_assert_proposal_target(…,'read')`）+「审核人资格」
        # （表主／System Manager／发起人本人）；而组织读口径里**「个人级不向管理者保密：
        # 老板看全企业」**（用户 2026-10-12 定的）⇒ **管理员对个人表是有读权的**，
        # 所以 fast 那条线的「管理员也看不到别人的私有审阅」在本分支**不成立**。
        # 断言的**实质保留**：**无权的人**（另一个普通员工）看不到别人的私有审阅。
        # ⚠️ 「管理员该不该看个人表上的审阅」需要主控拍板（见交付说明）。
        other='review-other-'+self.token+'@example.invalid'
        frappe.set_user('Administrator')
        self.act('platform.identity.create',{'email':other,'display_name':'另一员工',
            'initial_password':'Isolated-review-2026!','roles':['staff']})
        frappe.set_user(other)
        with self.assertRaises(frappe.PermissionError):get_action_proposal_review(self.proposal)

    def test_disabled_identity_cannot_replay_accepted_receipt(self):
        review=get_action_proposal_review(self.proposal);key=review['units'][0]['unit_id']
        accept_action_proposal_units(self.proposal, 'before-revoke', review['review_revision'], [key], {})
        before=self.read()['content_version']
        frappe.set_user('Administrator')
        self.act('platform.identity.status',{'email':self.user,'enabled':False})
        frappe.set_user(self.user)
        with self.assertRaises(frappe.PermissionError):
            accept_action_proposal_units(self.proposal, 'before-revoke', review['review_revision'], [key], {})
        frappe.set_user('Administrator')
        # 合并说明（2026-10-21）：**按本分支的版本口径改这条断言** ——
        # 本分支的**表内容编辑走工作副本**（`working_file.save_current`），写的是
        # `content_revision`；**不新建上传版本**（`version_count` 只在上传/换版时进位）。
        # 所以「有没有写进新版本」要看 `content_revision`，不是 `version_count - 1`。
        # 断言的**实质没变**：被停用的身份重放旧回执 ⇒ **不许写进新内容版本**。
        self.assertEqual(int(frappe.db.get_value('Shangshu File Center File',self.name,'content_revision')),
                         before)

    def test_changed_pending_cell_is_not_overwritten_after_partial_accept(self):
        review=get_action_proposal_review(self.proposal)
        accept_action_proposal_units(self.proposal, 'first-step', review['review_revision'], [review['units'][0]['unit_id']], {})
        self.act('files.sheet_cells_write',{**self.pin(),'cells':[{'row_id':self.ids[1],'header':'列1',
            'value':{'type':'text','value':'人工已保存'}}]})
        latest=get_action_proposal_review(self.proposal)
        with self.assertRaises(frappe.TimestampMismatchError):
            accept_action_proposal_units(self.proposal, 'next-step', latest['review_revision'], [review['units'][1]['unit_id']], {})
        self.assertEqual(self.read()['rows'][1]['values']['列1']['value'],'人工已保存')

    def test_invalid_package_zero_write_and_reject_retains_accepted_fact(self):
        review=get_action_proposal_review(self.proposal);before=self.read()
        with self.assertRaises(frappe.ValidationError):
            accept_action_proposal_units(self.proposal, 'bad-step', review['review_revision'], ['forged-target'], {})
        self.assertEqual(self.read()['content_version'],before['content_version'])
        accept_action_proposal_units(self.proposal, 'first-step', review['review_revision'], [review['units'][0]['unit_id']], {})
        resolve_action_proposal(self.proposal,'rejected')
        self.assertEqual(self.read()['rows'][0]['values']['列1']['value'],'候选0')
        self.assertEqual(self.read()['rows'][1]['values']['列1'],before['rows'][1]['values']['列1'])

    def test_invalid_multi_unit_package_is_atomic(self):
        review=get_action_proposal_review(self.proposal);before=self.read()
        ids=[unit['unit_id'] for unit in review['units']]
        with self.assertRaises(frappe.ValidationError):
            accept_action_proposal_units(self.proposal, 'atomic-bad', review['review_revision'], ids, {ids[0]:{'type':'text','value':'合法值'},
                ids[1]:{'type':'forged','value':'不能保存'}})
        self.assertEqual(self.read()['content_version'],before['content_version'])
        self.assertEqual(self.read()['rows'],before['rows'])

    def test_unknown_cell_type_is_never_written_into_the_sheet(self):
        # 合并说明（2026-10-21）：**按本分支的校验口径改这条判据** ——
        # 本分支的动作 schema **不给格值类型列枚举**（平台只管形状，类型由域内校验；
        # 合并说明就写在 domain.py 的 `files.sheet_cells_write` 那里：「值类型取本分支的
        # （含 formula）」），所以**提议时**不拦，**写进去时**由域内明确拒
        # （`sheet.py`：'不支持的值类型：<type>'）。
        # 断言的**实质没变**：无效的格值类型**不许落进表里**（也不许静默写成空）。
        proposal=propose_registered_action('files.sheet_cells_write',{**self.pin(),'cells':[
            {'row_id':self.ids[0],'header':'列1','value':{'type':'string','value':'无效类型'}}]})
        before=self.read()['rows'][0]['values']['列1']
        with self.assertRaises(frappe.ValidationError):
            resolve_action_proposal(proposal['id'],'confirmed')
        self.assertEqual(self.read()['rows'][0]['values']['列1'],before)
        # 行号不许猜：`row_id` 有格式闸（`^r-[0-9]{6,}$`），提议时就拒。
        with self.assertRaises(frappe.ValidationError):
            propose_registered_action('files.sheet_cells_write',{**self.pin(),'cells':[
                {'row_id':'2','header':'列1','value':{'type':'text','value':'不能猜行号'}}]})

    def test_free_workbook_cells_use_the_same_unit_review(self):
        # 上传登记行身份后，旧坐标提案也进入同一 sheet.write_cells；
        # 审核后的内容修订和页面读取指向同一份活内容。
        import base64
        from io import BytesIO
        from openpyxl import Workbook
        wb=Workbook();ws=wb.active;ws.title='自由表';ws.append(['客户']);ws.append(['甲'])
        output=BytesIO();wb.save(output)
        name=self.act('files.upload',{'file_name':'自由-'+self.token+'.xlsx',
            'attribution':{'level':'personal'},
            'content_base64':base64.b64encode(output.getvalue()).decode()})['file']
        doc=frappe.get_doc('Shangshu File Center File',name)
        source=invoke_domain_service('files.workbook',{'operation':'open','file':name,'version':int(doc.version_count)-1})
        # 2026-10-21（版本口径修复）：前置条件**换了字段** —— `expected_modified`
        # （记录修改时间，改个文件名也会推进它 ⇒ 假过期）换成 `expected_content_revision`
        # （内容修订号：内容真变没变的凭据）。动作版本随之 1.0.1 → 2.0.0（必填字段变了）。
        # **断言的实质一条没动**：仍是「自由工作簿也走同一套逐项审核」。
        proposal=propose_registered_action('files.edit_cells',{'file':name,
            'expected_version':int(doc.version_count)-1,
            'expected_content_revision':int(doc.content_revision),
            'changes':[{'sheet':source['sheets'][0]['title'],'row':2,'column':1,'value':{'t':'s','v':'自由格建议'}}]})
        self.assertTrue(proposal['review_supported'])
        review=get_action_proposal_review(proposal['id']);key=review['units'][0]['unit_id']
        accept_action_proposal_units(proposal['id'], 'free-one', review['review_revision'], [key], {key:{'type':'text','value':'人工自由格'}})
        saved=invoke_domain_service('files.sheet_read',{'table':name})
        self.assertEqual(saved['rows'][0]['values']['客户']['value'],'人工自由格')

    def test_stopped_file_domain_blocks_review_and_leaves_mail_usable(self):
        from shangshu_core.public_api import set_domain_enabled
        review=get_action_proposal_review(self.proposal)
        frappe.set_user('Administrator')
        set_domain_enabled('com.shangshu.files',False,'逐项审核启停隔离',stop_mode='complete')
        try:
            frappe.set_user(self.user)
            with self.assertRaises(frappe.PermissionError):get_action_proposal_review(self.proposal)
            with self.assertRaises(frappe.PermissionError):
                accept_action_proposal_units(self.proposal, 'stopped', review['review_revision'], None, {})
            mail=self.act('mail.save_draft',{'subject':'无附件草稿','body':'独立可用','to':[],'cc':[]})
            self.assertEqual(mail['subject'],'无附件草稿')
        finally:
            frappe.set_user('Administrator');set_domain_enabled('com.shangshu.files',True,'恢复文件域')
        frappe.set_user(self.user)
