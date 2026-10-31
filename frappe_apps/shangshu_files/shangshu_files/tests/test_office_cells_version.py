"""助手改表格单元格：版本口径 ＋ 活内容落点（2026-10-21 修复）。

**这段测试通过 = 下面这些同时成立**（一句话说清）：

1. 读方**一次**就能读到写入路径要的那一对值（`upload_version` ＋ `content_revision`），
   助手用它造 `files.edit_cells` 提案 ⇒ 审核可采纳 ⇒ 采纳后**那一格真变了**
   （这正是 2026-10-21 用户在 3850 站失败的那条：曾报「提案对应的原始记录已更新」）。
2. 内容**真被别人改过**（换了上传版本／工作副本被改过）⇒ 提案**仍然被拒**
   （并发保护不许因为口径改了就放宽）。
3. 有工作副本的文件 ⇒ 改的是**活内容**：用户手改的内容**不被覆盖**，
   落库后页面照常能改能存（再写一格 `files.sheet_cells_write` 仍然成功）。

2026-10-27：旧坐标动作和表格页面统一进入同一格值写入口。
已完成行身份登记的上传文件首次编辑建立工作副本；之后只推进内容修订。
上传版本与内容版本的双检查保留，不再分成两套值保存实现。
"""
import base64
import uuid
from io import BytesIO

import frappe
from frappe.tests.utils import FrappeTestCase
from openpyxl import Workbook
from shangshu_core.public_api import (accept_action_proposal_units, execute_registered_action,
                                     get_action_proposal_review, invoke_domain_service,
                                     propose_registered_action)


class TestOfficeCellsVersion(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.token = uuid.uuid4().hex
        self.user = 'cells-' + self.token + '@example.invalid'
        self.act('platform.identity.create', {'email': self.user, 'display_name': '单元格回归',
                                              'initial_password': 'Isolated-cells-2026!', 'roles': ['staff']})
        frappe.set_user(self.user)

    def tearDown(self):
        frappe.set_user('Administrator')
        super().tearDown()

    def act(self, name, payload):
        return execute_registered_action(name, payload, confirmed=True,
                                         idempotency_key=uuid.uuid4().hex)['result']

    # ---- 夹具：一个「自由上传」的 xlsx（表头一行 ＋ 数据一行）----
    def upload_free_xlsx(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = '自由表'
        sheet.append(['客户', '金额'])
        sheet.append(['甲', 1])
        output = BytesIO()
        workbook.save(output)
        name = self.act('files.upload', {'file_name': '自由-' + self.token + '.xlsx',
                                         'attribution': {'level': 'personal'},
                                         'content_base64': base64.b64encode(output.getvalue()).decode()})['file']
        return name

    def pair(self, name):
        """读方拿到的**那一对值**：当前上传版本号 ＋ 当前内容修订号。"""
        record = invoke_domain_service('files.versions', {'file': name})
        return record['file']['upload_version'], record['file']['content_revision']

    def read_cells(self, name):
        record = invoke_domain_service('files.sheet_read', {'table': name})
        return record['rows'][0]['values']

    def propose(self, name, changes, version=None, revision=None):
        upload_version, content_revision = self.pair(name)
        return propose_registered_action('files.edit_cells', {
            'file': name,
            'expected_version': upload_version if version is None else version,
            'expected_content_revision': content_revision if revision is None else revision,
            'changes': changes})

    # ---- ① 读方：一次读到那一对值 ----
    def test_read_side_exposes_the_pair_the_write_path_needs(self):
        """读方拿得到「当前上传版本号」和「当前内容修订号」，不必猜 `version_count` 的含义。"""
        name = self.upload_free_xlsx()
        doc = frappe.get_doc('Shangshu File Center File', name)
        upload_version, content_revision = self.pair(name)
        self.assertEqual(upload_version, int(doc.version_count) - 1)
        self.assertEqual(content_revision, int(doc.content_revision))
        detail = invoke_domain_service('files.versions', {'file': name})['file']
        self.assertFalse(detail['working_copy'])

    # ---- ② 助手用正确的那一对值造提案 ⇒ 可采纳 ⇒ 那一格真变了 ----
    def test_assistant_proposal_from_the_read_pair_is_accepted_and_the_cell_changes(self):
        """助手用读到的正确值造提案 ⇒ 审核可采纳 ⇒ 采纳后那一格真变了（今天失败的那条）。"""
        name = self.upload_free_xlsx()
        proposal = self.propose(name, [{'sheet': '自由表', 'row': 2, 'column': 2,
                                        'value': {'t': 'n', 'v': 99}}])
        review = get_action_proposal_review(proposal['id'])
        self.assertTrue(review['can_accept'])
        result = accept_action_proposal_units(proposal['id'], 'cells-one',
                                              review['review_revision'],
                                              [review['units'][0]['unit_id']], {})
        self.assertEqual(result['status'], 'confirmed')
        self.assertEqual(result['accepted_count'], 1)
        self.assertEqual(self.read_cells(name)['金额']['value'], 99)

    # ---- ③ 并发保护不许削弱：内容真被改过 ⇒ 仍然被拒 ----
    def test_proposal_is_still_rejected_after_the_content_really_changed(self):
        """上传版本换了（内容真变）⇒ 提案仍然被拒，不许因为口径改了就放行。"""
        name = self.upload_free_xlsx()
        proposal = self.propose(name, [{'sheet': '自由表', 'row': 2, 'column': 2,
                                        'value': {'t': 'n', 'v': 99}}])
        # 别人把内容真改了：换了一个上传版本 ⇒ 内容修订号进位。
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = '自由表'
        sheet.append(['客户', '金额'])
        sheet.append(['乙', 2])
        output = BytesIO()
        workbook.save(output)
        doc = frappe.get_doc('Shangshu File Center File', name)
        self.act('files.new_version', {'file': name, 'expected_version': int(doc.version_count) - 1,
                                       'expected_modified': str(doc.modified),
                                       'content_base64': base64.b64encode(output.getvalue()).decode()})
        review = get_action_proposal_review(proposal['id'])
        self.assertFalse(review['can_accept'])
        with self.assertRaises(frappe.TimestampMismatchError):
            accept_action_proposal_units(proposal['id'], 'cells-stale',
                                         review['review_revision'],
                                         [review['units'][0]['unit_id']], {})
        self.assertNotEqual(self.read_cells(name)['客户']['value'], '甲')

    # ---- ③ 并发保护不许削弱：内容真被改过 ⇒ 仍然被拒 ----
    def test_proposal_is_still_rejected_after_the_working_copy_was_edited(self):
        """工作副本内容被别人改过（内容修订号进位）⇒ 提案仍然被拒。"""
        name = self.upload_free_xlsx()
        sheet = invoke_domain_service('files.sheet_read', {'table': name})
        row_id = sheet['rows'][0]['row_id']
        proposal = self.propose(name, [{'sheet': '自由表', 'row': 2, 'column': 2,
                                        'value': {'t': 'n', 'v': 99}}])
        # 别人在页面里改了同一份表（工作副本那支）⇒ 内容修订号进位。
        self.act('files.sheet_cells_write', {**self.pin(name), 'cells': [
            {'row_id': row_id, 'header': '客户', 'value': {'type': 'text', 'value': '别人改的'}}]})
        review = get_action_proposal_review(proposal['id'])
        self.assertFalse(review['can_accept'])
        with self.assertRaises(frappe.TimestampMismatchError):
            accept_action_proposal_units(proposal['id'], 'cells-stale-copy',
                                         review['review_revision'],
                                         [review['units'][0]['unit_id']], {})
        self.assertNotEqual(self.read_cells(name)['金额']['value'], 99)

    # ---- ④ 有工作副本的文件：改活内容，不覆盖用户手改，落库后页面照常能存 ----
    def test_working_copy_file_edits_live_content_and_keeps_the_page_writable(self):
        """用户手改过（文件有工作副本）⇒ 助手改的是**活内容**：手改不被覆盖、页面照常能存。"""
        name = self.upload_free_xlsx()
        sheet = invoke_domain_service('files.sheet_read', {'table': name})
        row_id = sheet['rows'][0]['row_id']
        # 页面里手改一格 ⇒ 产生工作副本（内容修订 +1，上传版本不动）。
        self.act('files.sheet_cells_write', {**self.pin(name), 'cells': [
            {'row_id': row_id, 'header': '客户', 'value': {'type': 'text', 'value': '甲改'}}]})
        detail = invoke_domain_service('files.versions', {'file': name})['file']
        self.assertTrue(detail['working_copy'])
        before = frappe.get_doc('Shangshu File Center File', name)
        versions_before = int(before.version_count)
        revision_before = int(before.content_revision)

        proposal = self.propose(name, [{'sheet': '自由表', 'row': 2, 'column': 2,
                                        'value': {'t': 'n', 'v': 99}}])
        review = get_action_proposal_review(proposal['id'])
        self.assertTrue(review['can_accept'])
        accept_action_proposal_units(proposal['id'], 'cells-live', review['review_revision'],
                                     [review['units'][0]['unit_id']], {})

        after = frappe.get_doc('Shangshu File Center File', name)
        self.assertEqual(int(after.version_count), versions_before)      # 不新建上传版本
        self.assertGreater(int(after.content_revision), revision_before)  # 内容修订进位
        cells = self.read_cells(name)
        self.assertEqual(cells['金额']['value'], 99)   # 助手改的那格真变了
        self.assertEqual(cells['客户']['value'], '甲改')  # 用户手改的内容**没被覆盖**
        # 页面照常能改能存（双击直改走的就是这条写路径）。
        self.act('files.sheet_cells_write', {**self.pin(name), 'cells': [
            {'row_id': row_id, 'header': '客户', 'value': {'type': 'text', 'value': '甲再改'}}]})
        self.assertEqual(self.read_cells(name)['客户']['value'], '甲再改')

    # ---- ⑤ 公共壳的确认卡读回：要一个 `expected_modified`（投影里必须带上）----
    def test_projection_carries_the_file_revision_for_the_confirmation_card(self):
        """公共壳（`shangshu-web/js/file-detail.js` 的 `files.edit_cells` presenter）
        核对「文件没被动过」时要一个 `expected_modified` ⇒ 域的载荷投影里必须带上它。
        （只是显示层；过期判定仍以「上传版本号 ＋ 内容修订号」为准。）"""
        import json
        from shangshu_files.proposal_projection import project
        name = self.upload_free_xlsx()
        proposal = self.propose(name, [{'sheet': '自由表', 'row': 2, 'column': 2,
                                        'value': {'t': 'n', 'v': 99}}])
        stored = json.loads(frappe.get_doc('Shangshu Action Proposal', proposal['id']).payload_json)
        projected = project('files.edit_cells', stored)
        self.assertEqual(projected['payload']['expected_modified'],
                         str(frappe.get_doc('Shangshu File Center File', name).modified))
        self.assertFalse(projected['redacted'])

    def pin(self, name):
        sheet = invoke_domain_service('files.sheet_read', {'table': name})
        return {'table': name, 'expected_content_version': sheet['content_version'],
                'expected_structure_version': sheet['structure_version']}
