"""`mail.read`（**只读**动作）—— 判据。

**测试通过 = 下面全部成立**：
 ① agent 调 `mail.read` 能拿到这一封信的**正文／收件人／抄送／附件**（不只是 7 个列表字段）；
 ② 读**别人的信** ⇒ **当场拒并说得出无权**（不给内容，也不给空正文冒充「这封信是空的」）；
 ③ `mail.read` 已登记成**只读**动作（effect=read、不要人工确认卡）并**投影进 agent 工具面**
    （`list_registered_actions(tools_only=True)` 里查得到）；
 ④ **净化姿态没放松**：正文里的 `<script>`／事件属性／外链图不出现在回包里
    （走保存那道门存的、绕开保存直接进库的，都一样）；
 ⑤ 读信**不改任何东西**（版本、状态、条数都不动）；
 ⑥ 缺编号／编号不存在／版本对不上 ⇒ **明说读不到**，不编内容。

跑法（bench 上，隔离站）：
    bench --site <站点> run-tests --module shangshu_mail.tests.test_mail_read --skip-test-records
"""
import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils.file_manager import save_file
from shangshu_core.public_api import execute_registered_action, list_registered_actions
from shangshu_mail import service


class TestMailRead(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.prefix = uuid.uuid4().hex

    def tearDown(self):
        frappe.set_user('Administrator')
        super().tearDown()

    def act(self, action, payload, key=None):
        return execute_registered_action(action, payload, confirmed=True,
                                         idempotency_key=key or uuid.uuid4().hex)['result']

    def draft(self, **extra):
        payload = {'subject': '客户来信' + self.prefix, 'body': '原正文',
                   'to': ['client@example.invalid'], 'cc': []}
        payload.update(extra)
        return self.act('mail.save_draft', payload)

    def attach(self, mail_name, filename='read-probe.txt'):
        """真挂一个私有附件到这封信上（读回的附件列表要有它）。"""
        file = save_file(filename, b'probe-bytes', service.DOCTYPE, mail_name, is_private=1)
        with service.writing():
            doc = frappe.get_doc(service.DOCTYPE, mail_name)
            ids = json.loads(doc.get('attachment_ids_json') or '[]')
            ids.append(file.name)
            doc.attachment_ids_json = json.dumps(ids)
            doc.save(ignore_permissions=True)
        return file.name

    def insert_dirty_mail(self, body):
        """绕开保存那道门直接进库的脏正文（模拟历史遗留行）。"""
        with service.writing():
            return frappe.get_doc({
                'doctype': service.DOCTYPE, 'subject': '历史脏信' + self.prefix,
                'body': body, 'body_format': 'HTML', 'status': 'Received',
                'record_version': 1, 'to_json': '[]', 'cc_json': '[]',
            }).insert(ignore_permissions=True)

    # —— ① 读得到正文／收件人／抄送／附件 ——
    def test_read_returns_body_recipients_cc_and_attachments(self):
        saved = self.draft(body='<p>正文里的内容</p><p>第二段</p>', body_format='HTML',
                           cc=['boss@example.invalid'])
        file_name = self.attach(saved['name'])
        read = self.act('mail.read', {'mail': saved['name']})
        self.assertEqual(read['name'], saved['name'])
        self.assertIn('正文里的内容', read['body'])
        self.assertEqual(read['subject'], '客户来信' + self.prefix)
        self.assertEqual(read['to'], ['client@example.invalid'])
        self.assertEqual(read['cc'], ['boss@example.invalid'])
        self.assertEqual([item['file'] for item in read['attachments']], [file_name])
        # 内联资源引用也在回包里（cid 引用得跟着 content_id 一起给）
        self.assertIn('inline_resources', read)

    # —— ② 读别人的信 ⇒ 拒，且说得出原因 ——
    def test_reading_another_employee_mail_is_refused_with_a_reason(self):
        email = 'mail-read-' + self.prefix + '@example.invalid'
        self.act('platform.identity.create', {'email': email, 'display_name': '读信测试同事',
                                             'initial_password': 'Isolated-only-2026!',
                                             'roles': ['staff']})
        frappe.set_user(email)
        theirs = self.draft(body='私人资料不该被读走')
        # 本人读自己的信 ⇒ 读得到
        mine = self.act('mail.read', {'mail': theirs['name']})
        self.assertIn('私人资料不该被读走', mine['body'])
        frappe.set_user('Administrator')
        with self.assertRaises(frappe.PermissionError) as caught:
            self.act('mail.read', {'mail': theirs['name']})
        message = str(caught.exception)
        self.assertNotIn('私人资料不该被读走', message, '拒的回报里不该带正文')
        self.assertRegex(message, '只能访问|无权|没有权限')

    # —— ③ 已登记成只读动作 ＋ 投影进 agent 工具面 ——
    def test_read_is_registered_as_read_only_action_and_projected_as_agent_tool(self):
        from shangshu_mail import domain
        rows = {row['id']: row for row in list_registered_actions(tools_only=True)}
        self.assertIn('mail.read', rows, 'mail.read 不在 agent 工具面里 ⇒ agent 用不了')
        self.assertEqual(rows['mail.read']['effect'], 'read')
        self.assertEqual(rows['mail.read']['confirmation'], 'none')
        self.assertTrue(rows['mail.read']['executable'])
        contribution = domain.get_contribution()
        self.assertIn('mail.read', [item['id'] for item in contribution['actions']])
        self.assertIn('mail.read', [item['id'] for item in contribution['tools']])
        self.assertIn('mail.read', domain.ACTION_VERSIONS)

    # —— ④ 净化姿态没放松 ——
    def test_read_keeps_the_sanitizing_posture(self):
        dirty = ('<p onclick="steal()">核对</p><script>steal()</script>'
                 '<img src="https://tracker.invalid/pixel" onerror="steal()">')
        saved = self.draft(body=dirty, body_format='HTML')
        read = self.act('mail.read', {'mail': saved['name']})
        self.assertNotIn('steal()', read['body'])
        self.assertNotIn('onclick', read['body'])
        self.assertNotIn('tracker.invalid', read['body'])
        # 绕开保存直接进库的脏正文：**可执行**的脚本标签、事件属性、外链图一样不回来
        # （Frappe 存这一行时已把脚本标签转义成文本；读面再过一道 `html_body`，
        #  外链图与事件属性在这里被剥掉 —— 存着的与读出来的不是同一份危险度）。
        legacy = self.insert_dirty_mail(dirty)
        read_legacy = self.act('mail.read', {'mail': legacy.name})
        body = read_legacy['body'].lower()
        self.assertNotIn('<script', body)
        self.assertNotIn('</script', body)
        self.assertNotIn('onclick', body)
        self.assertNotIn('onerror', body)
        self.assertNotIn('tracker.invalid', body)

    # —— ⑤ 读信不改任何东西 ——
    def test_read_changes_nothing(self):
        saved = self.draft()
        before_count = frappe.db.count('Shangshu Mail Message')
        read = self.act('mail.read', {'mail': saved['name']})
        self.assertEqual(read['record_version'], saved['record_version'])
        self.assertEqual(frappe.db.count('Shangshu Mail Message'), before_count)
        again = frappe.get_doc(service.DOCTYPE, saved['name'])
        self.assertEqual(again.record_version, saved['record_version'])
        self.assertEqual(again.status, saved['status'])

    # —— ⑥ 读不到就说读不到，不编内容 ——
    def test_missing_unknown_and_stale_are_reported_not_faked(self):
        with self.assertRaises(frappe.ValidationError):
            self.act('mail.read', {})
        with self.assertRaises(frappe.DoesNotExistError):
            self.act('mail.read', {'mail': 'no-such-mail-' + self.prefix})
        saved = self.draft()
        with self.assertRaises(frappe.TimestampMismatchError):
            self.act('mail.read', {'mail': saved['name'], 'expected_version': 99})
        # 版本对得上 ⇒ 照常读
        read = self.act('mail.read', {'mail': saved['name'],
                                       'expected_version': saved['record_version']})
        self.assertEqual(read['name'], saved['name'])
