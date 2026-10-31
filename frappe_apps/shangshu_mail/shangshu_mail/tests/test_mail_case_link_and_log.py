"""PKG-041-T02：邮件对象加案件关联 ＋ **邮件域自己**往统一日志库写过程记录。

**测试通过 = 什么成立**（一句话）：

「**邮件对象上有案件关联**：`mail.save_draft` 带上 `case_ref`（案件号）⇒
 草稿那一行**存着它**、`mail.message` 的投影里**读得到**、读到的**就是传进去的那一个**
 （不是别的字段、不是空）；**邮件域自己往统一日志库写了过程记录**：保存一封草稿
 ⇒ 统一日志表**多一行**（`what_kind='process'`、`domain_id='com.shangshu.mail'`、
 业务记录指向**那封信**），且**域专属字段 `case_ref` 落在邮件域自己那张扩展表里**
 ——**公开读口读得回来**（`domain_fields.case_ref` 就是那个案件号）；
 **新代码只走公开口**（邮件域不 import 内核内部模块）。」

为什么这两件事要一起做（§8 第 10／11 项）：
- 「邮件对象加案件关联」—— 邮件域以前**不知道**一封信是哪个案件的
 （`Shangshu Mail Message` 上**没有案件列**）⇒ 出了事查不到那封信跟哪个案子有关。
- 「邮件域往日志库写」—— 统一日志库是**唯一事实**；邮件域的操作痕迹**不进**它
 ⇒ 那部分操作**没有痕迹**。而**写进去还得读得回来** ⇒ 判据里有一条
 就是**用公开读口把它读出来**（只写不读等于写进黑洞）。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_mail.tests.test_mail_case_link_and_log --skip-test-records
"""
import pathlib
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core.public_api import (
    execute_registered_action,
    invoke_domain_service,
    query_process_records,
)

MAIL_DOCTYPE = 'Shangshu Mail Message'


class TestMailCaseLinkAndLog(FrappeTestCase):
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
        return self.act('mail.save_draft', {
            'subject': '案件邮件' + self.prefix,
            'body': '原正文', 'to': ['client@example.invalid'], 'cc': [], **extra})

    def test_draft_stores_the_case_ref_and_the_projection_shows_it(self):
        """案件号**存住了**、**投影读得到**、**读到的就是传进去的那个**。"""
        case_ref = 'CASE-' + self.prefix[:8].upper()
        saved = self.draft(case_ref=case_ref)
        # ① 那一行**存着它**。
        row = frappe.get_doc(MAIL_DOCTYPE, saved['name'])
        self.assertEqual(row.get('case_ref'), case_ref,
            '邮件那一行没存住案件号（实际 %r）' % row.get('case_ref'))
        # ② **投影读得到**（`mail.message` 的字段里列了它）。
        detail = invoke_domain_service('mail.detail', {'mail': saved['name']})
        self.assertEqual((detail.get('mail') or {}).get('case_ref'), case_ref,
            '投影里读不到案件号')
        # ③ **不带 = 不改**（跟 mailbox 一个口径：省略不许把已有的关联抹掉）。
        again = self.act('mail.save_draft', {
            'mail': saved['name'], 'expected_version': saved['record_version'],
            'subject': saved['subject'], 'body': saved['body'],
            'to': ['client@example.invalid'], 'cc': []})
        self.assertEqual(again.get('case_ref'), case_ref,
            '不带 case_ref 的修改把已有的关联抹掉了')

    def test_saving_a_draft_writes_a_process_record_with_the_domain_fields(self):
        """存一封草稿 ⇒ **统一日志表多一行**，且**域专属字段接得上**。"""
        case_ref = 'CASE-' + self.prefix[:8].upper()
        saved = self.draft(case_ref=case_ref)
        # ① **公开读口读得回来**（按受管对象 ＋ 受管记录名取）。
        out = query_process_records('mail.message', business_name=saved['name'])
        items = (out or {}).get('items') or []
        mine = [item for item in items
                if item.get('what_id') == 'mail.draft.saved']
        self.assertTrue(mine, '存完草稿，统一日志里没有「mail.draft.saved」这一行：%r' % (out,))
        row = mine[0]
        self.assertEqual(row.get('what_kind'), 'process')
        self.assertEqual(row.get('domain_id'), 'com.shangshu.mail',
            '这行的域不是邮件域（域专属字段就接不上）')
        self.assertEqual(row.get('business_object_id'), 'mail.message')
        self.assertEqual(row.get('business_name'), saved['name'])
        self.assertEqual(row.get('status'), 'Succeeded')
        # ② **域专属字段**（`case_ref`）落在**邮件域自己那张扩展表**里，读得出来。
        self.assertEqual((row.get('domain_fields') or {}).get('case_ref'), case_ref,
            '域专属字段没接上：%r' % (row.get('domain_fields'),))
        # ③ **不抄业务值**：主题**不进日志**（它住在受管记录里 —— 同一个值只存一处）。
        self.assertNotIn('案件邮件' + self.prefix, str(row.get('detail') or ''),
            '日志里抄了主题 ⇒ 业务值被抄了第二份')

    def test_the_new_mail_code_only_uses_the_public_api(self):
        """**新代码只走公开口**（域不许 import 内核内部模块）。"""
        root = pathlib.Path(__file__).resolve().parent.parent
        for name in ('mailprocess.py',):
            source = (root / name).read_text(encoding='utf-8')
            for line in source.splitlines():
                stripped = line.strip()
                if not stripped.startswith(('from ', 'import ')):
                    continue
                if 'shangshu_core' not in stripped:
                    continue
                self.assertIn('shangshu_core.public_api', stripped,
                    '%s 里引了内核内部模块：%s（域只许引 public_api）' % (name, stripped))
