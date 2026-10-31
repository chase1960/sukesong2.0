"""PKG-122-T01：邮件域往统一日志库写**三段事实**（草稿建／确认／发）。

**测试通过 = 下面全部成立**（一句话）：

「邮件域新建一封草稿、确认它、再把它发出去 ⇒ 统一日志库里出现**三条各带自己动作标识**的记录
（`mail.draft.saved`／`mail.review.confirmed`／`mail.send.result`），三条**互不串**
（三个动作标识互不相同、各自带自己的可区分字段、三条都挂在**同一封邮件**上）；
**日志写不上不许把正事搞没**（确认照样过、信照样发出去）；
**新代码只走公开口**（邮件域不 import 内核内部模块）。」

为什么这件事要三段都有（处理契约 §8 待做清单第 11 条）：
统一日志库是**唯一事实** ⇒ 邮件域的每一段操作都得在里面留痕。
- 「草稿建」早就有（`mailprocess.record_draft_saved`）；
- 「确认」——**整单确认与逐项审核是谁点的** —— 以前**一处都没有**；
- 「发」——**邮件发给了谁（结果与失败原因）** —— 以前**一处都没有**。
⇒ 少一段 ⇒ 出了事就有一段查不到。

跑法（**离线可跑**，不带 bench）：
    cd frappe_apps/shangshu_mail && python3 -m unittest shangshu_mail.tests.test_mail_process_log

⚠️ 本判据**用公共那一份拟真 frappe 替身**（`scripts/shangshu_testkit/frappe_stub.py`，
全仓只许有那一份）—— **域里不另造**。跑的是**真模块**（`mailprocess`／`proposal_review`／
`delivery`），替身只顶掉框架与跨域那几口。

—— 先红后绿：下面这段红灯是**动实现之前**真跑出来的原文（2026-10-26，PKG-122-T01）——

RED（2026-10-26 05:1x，主窗亲自把三个实现文件还原到 HEAD 后实跑，原样贴）：

    ======================================================================
    FAIL: test_a_failing_log_write_does_not_break_the_business (shangshu_mail.tests.test_mail_process_log.TestMailProcessLog)
    ⑤ **日志写不上不许把正事搞没**（确认照样过、信照样发出去）。
    ----------------------------------------------------------------------
    Traceback (most recent call last):
      File ".../shangshu_mail/tests/test_mail_process_log.py", line 378, in test_a_failing_log_write_does_not_break_the_business
        self.assertTrue(harness.warnings,
    AssertionError: [] is not true : 日志写不上没有通报一声 ⇒ 事后没人知道少了一笔

    ======================================================================
    FAIL: test_confirming_writes_the_confirmation_record (shangshu_mail.tests.test_mail_process_log.TestMailProcessLog)
    ② **确认写一条**，且**那一条的标识是确认自己的**。
    ----------------------------------------------------------------------
    Traceback (most recent call last):
      File ".../shangshu_mail/tests/test_mail_process_log.py", line 302, in test_confirming_writes_the_confirmation_record
        self.assertTrue(
    AssertionError: False is not true : 邮件域没有「确认」那笔的写口（record_review_confirmed）⇒ 整单确认与逐项审核是谁点的，查不到

    ======================================================================
    FAIL: test_sending_writes_the_send_record_with_its_result (shangshu_mail.tests.test_mail_process_log.TestMailProcessLog)
    ③ **发写一条**，且那一条**带结果与失败原因**（自己的标识）。
    ----------------------------------------------------------------------
    Traceback (most recent call last):
      File ".../shangshu_mail/tests/test_mail_process_log.py", line 323, in test_sending_writes_the_send_record_with_its_result
        self.assertTrue(
    AssertionError: False is not true : 邮件域没有「发」那笔的写口（record_send_result）⇒ 邮件发给了谁、结果与失败原因，查不到

    ======================================================================
    FAIL: test_the_three_segments_write_three_records_that_do_not_mix (shangshu_mail.tests.test_mail_process_log.TestMailProcessLog)
    ④ **三条各带自己动作标识、三条互不串、都挂在同一封邮件上**。
    ----------------------------------------------------------------------
    Traceback (most recent call last):
      File ".../shangshu_mail/tests/test_mail_process_log.py", line 345, in test_the_three_segments_write_three_records_that_do_not_mix
        self.assertEqual(len(harness.records), 3,
    AssertionError: 1 != 3 : 草稿建／确认／发三段下来不是三条记录：['mail.draft.saved']

    ----------------------------------------------------------------------
    Ran 6 tests in 0.131s

    FAILED (failures=4)

⇒ **4 条红**（②③④⑤）；**①「草稿建仍写一条」与⑥「只走公开口」本来就绿**
（草稿建那一段是既有的、域也没引内核内部模块）⇒ **这正是「先红后绿」该有的形状**：
新增的两段（确认／发）红着，原来那一段（草稿建）不许被这次改动弄没。

MUTATION（2026-10-26 05:2x，主窗亲自改坏实现再跑，证明判据有牙齿）——

把 `mailprocess.py` 里「发」那一条的动作标识**故意写成草稿建那一条**：

    WHAT_SEND_RESULT = 'mail.draft.saved'      ← 故意写错（原来 'mail.send.result'）

⇒ 实跑：**6 条里红 2 条** —— ③「发写一条，且那一条带结果与失败原因（自己的标识）」
＋ ④「三条各带自己动作标识、三条互不串」（红灯原文：

    AssertionError: Lists differ: ['mail.draft.saved', 'mail.review.confirmed', 'mail.draft.saved']
                        != ['mail.draft.saved', 'mail.review.confirmed', 'mail.send.result']
    : 三段的标识不对或串了：['mail.draft.saved', 'mail.review.confirmed', 'mail.draft.saved']

⇒ 改回后 **6/6 复绿**（`md5` 逐字核对过：`b1b968e65b479f015a9bdccfddc05e5a`）
⇒ **判据不是摆设**：把「发」那一条的标识写错，它真的抓得住（③ 与 ④ 一起抓）。
"""
import contextlib
import json
import pathlib
import sys
import types
import unittest

#: **判据目录**：…/shangshu_mail/shangshu_mail/tests
TESTS_DIR = pathlib.Path(__file__).resolve().parent
#: **域包根**（域源码根，解析「域用到哪些公共口」用）：…/shangshu_mail/shangshu_mail
DOMAIN_ROOT = TESTS_DIR.parent

#: 三段事实各自的**动作标识**（日志库里靠它认「是哪一段」；三个互不相同）。
WHAT_DRAFT_SAVED = 'mail.draft.saved'
WHAT_REVIEW_CONFIRMED = 'mail.review.confirmed'
WHAT_SEND_RESULT = 'mail.send.result'


def _find_tools_root():
    """**工具区**在哪儿？（**站上没有** —— bench 形状的树里只有 `apps/` ⇒ 返回 None）"""
    for ancestor in pathlib.Path(__file__).resolve().parents:
        candidate = ancestor / 'scripts' / 'shangshu_testkit'
        if candidate.is_dir():
            return ancestor / 'scripts'
    return None


_TOOLS_ROOT = _find_tools_root()
if _TOOLS_ROOT is not None and str(_TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TOOLS_ROOT))
try:  # **站上布局**：工具区不在站上 ⇒ 公共件 import 不到（下面有站上那条路）
    from shangshu_testkit import frappe_stub as _public
except ImportError:  # pragma: no cover - 只在站上（bench 形状）走这里
    _public = None


class _FakeDoc:
    """一封邮件（表里那一行的形状）。"""

    def __init__(self, **fields):
        self.__dict__.update({
            'name': 'MAIL-1', 'status': 'Draft', 'record_version': 1,
            'owner': 'owner@example.invalid', 'mailbox_id': 'mb-1',
            'subject': '案件邮件', 'body': '<p>正文</p>', 'body_format': 'Text',
            'to_json': json.dumps(['client@example.invalid']), 'cc_json': '[]',
            'attachment_ids_json': '[]', 'attachment_labels_json': '{}',
            'inline_resources_json': '[]', 'case_ref': '', 'delivery_error': '',
            'rejected_json': '[]', 'message_id': '<m-1@shangshu.local>',
            'in_reply_to': '', 'binding_generation': 1, 'sent_at': None,
            'delivery_started_at': None,
        })
        self.__dict__.update(fields)
        self.saved = 0

    def get(self, key, default=''):
        return getattr(self, key, default)

    def save(self, ignore_permissions=True):
        self.saved += 1


class _Harness:
    """离线跑邮件域那三段用的脚手架：**真模块** ＋ 替身（框架／跨域那几口）。

    装的东西只有四样：拟真 frappe 替身、公共口、域内那两份（account／service）、
    以及**真模块的新鲜一份**（import 之前先清掉旧的 ⇒ 绑定的是替身那一口）。
    """

    def __init__(self):
        self.records = []       # 写进统一日志库的那些行
        self.warnings = []      # 域记的警告（「痕迹写不上只通报」）
        self.commits = 0
        self.rollbacks = 0
        self.write_error = None  # 装上它 ⇒ 写日志会炸（测「写不上不许把正事搞没」）
        self.transport_outcome = {'status': 'Sent', 'error': '', 'rejected': []}
        self.doc = _FakeDoc()
        self._saved_modules = {}
        self._api_saved = {}

    # —— 装 ——
    def __enter__(self):
        if _public is None:
            # 站上布局：工具区不在站上 ⇒ 公共替身够不着。
            # 站上有真 frappe ⇒ 这份**离线**判据不跑（站上那趟由 FrappeTestCase 那份管）。
            raise unittest.SkipTest(
                '站上布局：工具区不在站上 ⇒ 公共替身够不着 ⇒ 这份离线判据不跑'
                '（站上那趟由 FrappeTestCase 那份判据管）')
        for name in ('shangshu_mail.account', 'shangshu_mail.service',
                     'shangshu_mail.mailprocess', 'shangshu_mail.delivery',
                     'shangshu_mail.proposal_review'):
            self._saved_modules[name] = sys.modules.get(name)
        # ① 拟真 frappe 替身（**公共那一份**；force=True ⇒ 连站上的真 frappe 也先顶掉，
        #    跑完原样还回去 ⇒ 站上跑这份判据也不会碰真数据）
        self._frappe_installed = _public.install_minimal_frappe(force=True)
        import frappe
        self.frappe = frappe
        self.frappe.session = types.SimpleNamespace(user='reviewer@example.invalid')
        self.frappe.set_user = lambda user: setattr(self.frappe.session, 'user', user)
        self.frappe.clear_messages = lambda *a, **k: None
        self.frappe.db = types.SimpleNamespace(
            commit=self._commit, rollback=self._rollback)
        self.frappe.logger = lambda *a, **k: self._logger()
        # ② 公共口（离线＝假件；站上＝真件）—— 只换**要用的那几个名字**
        names = _public.domain_public_api_names(DOMAIN_ROOT)
        self._api, self._api_installed = _public.install_minimal_public_api(names)
        for name, value in (
                ('write_process_record', self._write_process_record),
                ('domain_execution', self._domain_execution),
                ('get_record_attachments', lambda *a, **k: []),
                ('require_roles', lambda *a, **k: None),
                ('get_request_context', lambda *a, **k: {}),
                ('declare_process_log_fields', lambda *a, **k: None)):
            self._api_saved[name] = getattr(self._api, name, None)
            setattr(self._api, name, value)
        # ③ 域内那两份替身（account／service）
        import shangshu_mail
        self.account = self._make_account()
        self.service = self._make_service()
        sys.modules['shangshu_mail.account'] = self.account
        sys.modules['shangshu_mail.service'] = self.service
        shangshu_mail.account = self.account
        shangshu_mail.service = self.service
        # ④ 真模块的**新鲜一份**（import 时绑定的是替身那一口 ⇒ 先清掉旧的）
        #    ⚠️ `from shangshu_mail import X` **先看父包上的属性** ⇒ 光清 sys.modules 不够，
        #    父包上那个旧属性也得摘掉，否则下一个用例拿到的是**上一个**用例的捕获器。
        for name in ('shangshu_mail.mailprocess', 'shangshu_mail.delivery',
                     'shangshu_mail.proposal_review'):
            sys.modules.pop(name, None)
            if hasattr(shangshu_mail, name.split('.')[-1]):
                delattr(shangshu_mail, name.split('.')[-1])
        from shangshu_mail import delivery, mailprocess, proposal_review
        self.delivery = delivery
        self.mailprocess = mailprocess
        self.proposal_review = proposal_review
        # ⑤ SMTP 那一段不真发（替身只回一个结果）
        from shangshu_mail import transport
        self._transport_saved = transport.send_message
        transport.send_message = self._send_message
        return self

    def __exit__(self, *exc):
        from shangshu_mail import transport
        transport.send_message = self._transport_saved
        for name, value in self._api_saved.items():
            setattr(self._api, name, value)
        if self._api_installed:
            _public.uninstall_minimal_public_api(self._api_installed)
        import shangshu_mail
        for name in ('shangshu_mail.account', 'shangshu_mail.service',
                     'shangshu_mail.mailprocess', 'shangshu_mail.delivery',
                     'shangshu_mail.proposal_review'):
            attribute = name.split('.')[-1]
            saved = self._saved_modules.get(name)
            if saved is None:
                sys.modules.pop(name, None)
                if hasattr(shangshu_mail, attribute):
                    delattr(shangshu_mail, attribute)
            else:
                sys.modules[name] = saved
                setattr(shangshu_mail, attribute, saved)
        _public.uninstall_minimal_frappe(self._frappe_installed)
        return False

    # —— 替身那几口 ——
    def _make_account(self):
        module = types.ModuleType('shangshu_mail.account')
        module.account_name = lambda user=None: 'mb-1'
        module.get_account = lambda **kwargs: types.SimpleNamespace(
            binding_generation=1, display_name='测试',
            email_address='sender@example.invalid', provider='smtp')
        module.require_right = lambda mailbox, right: True
        module.credentials = lambda binding: ('sender@example.invalid', 'secret')
        return module

    def _make_service(self):
        module = types.ModuleType('shangshu_mail.service')
        module.message = lambda name, lock=False: self.doc
        module.require_draft_edit = lambda doc: None
        module.proposal_guard = lambda *a, **k: None

        @contextlib.contextmanager
        def writing():
            yield

        module.writing = writing
        return module

    def _logger(self):
        harness = self

        class _Log:
            def warning(self, message, *a, **k):
                harness.warnings.append(str(message))

            def error(self, message, *a, **k):
                harness.warnings.append(str(message))

            def info(self, message, *a, **k):
                pass

        return _Log()

    def _commit(self):
        self.commits += 1

    def _rollback(self):
        self.rollbacks += 1

    def _write_process_record(self, what_id, **kwargs):
        """统一日志库的公开写口 —— 这里只**收下**（真库不在离线环境里）。"""
        if self.write_error is not None:
            raise self.write_error
        row = {'what_id': what_id}
        row.update(kwargs)
        self.records.append(row)
        return row

    def _domain_execution(self, domain):
        @contextlib.contextmanager
        def _run():
            yield domain

        return _run()

    def _send_message(self, address, password, display_name, mail, attachments,
                      provider, inline_resources=None, credential_version=None):
        return dict(self.transport_outcome)

    # —— 三段动作 ——
    def draft_saved(self):
        """「草稿建」那一段（`mail.save_draft` 落库后写的那条）。"""
        return self.mailprocess.record_draft_saved(self.doc, source='user', is_new=True)

    def confirm(self, units=('subject', 'body')):
        """「确认」那一段（内核确认完、把结果绑回邮件之后域里那一口）。"""
        return self.proposal_review.review(
            'mail.save_draft', {}, {'bound_target': {'mail': self.doc.name}},
            {'operation': 'bind', 'purpose': 'resolve',
             'result': {'name': self.doc.name, 'case_ref': self.doc.get('case_ref')},
             'plan': {'payload': {}, 'units': list(units)}},
            'reviewer@example.invalid')

    def send(self, outcome=None):
        """「发」那一段（后台任务跑完 SMTP、邮件落终态那一口）。"""
        if outcome is not None:
            self.transport_outcome = dict(outcome)
        self.doc.status = 'Queued'
        return self.delivery.process_send(self.doc.name, 'sender@example.invalid')


class TestMailProcessLog(unittest.TestCase):
    """① 草稿建仍写一条；② 确认写一条（自己的标识）；③ 发写一条（自己的标识）；
    ④ 三条互不串；⑤ 日志写不上不许把正事搞没；⑥ 只走公开口。"""

    def test_draft_saved_still_writes_its_own_record(self):
        """① **草稿建仍写一条**（原来就有的那一条不许被这次改动弄没）。"""
        with _Harness() as harness:
            self.assertTrue(hasattr(harness.mailprocess, 'record_draft_saved'),
                            '邮件域没有「草稿建」那笔的写口（record_draft_saved）')
            harness.draft_saved()
            self.assertEqual(len(harness.records), 1,
                             '存一封草稿没写进一条过程记录：%r' % (harness.records,))
            row = harness.records[0]
            self.assertEqual(row['what_id'], WHAT_DRAFT_SAVED)
            self.assertEqual(row['domain_id'], 'com.shangshu.mail')
            self.assertEqual(row['business_object_id'], 'mail.message')
            self.assertEqual(row['business_name'], 'MAIL-1')
            self.assertEqual(row['result'], 'Succeeded')
            self.assertEqual((row.get('extension_values') or {}).get('message_ref'), 'MAIL-1')

    def test_confirming_writes_the_confirmation_record(self):
        """② **确认写一条**，且**那一条的标识是确认自己的**。"""
        with _Harness() as harness:
            self.assertTrue(
                hasattr(harness.mailprocess, 'record_review_confirmed'),
                '邮件域没有「确认」那笔的写口（record_review_confirmed）'
                '⇒ 整单确认与逐项审核是谁点的，查不到')
            out = harness.confirm()
            # 确认的**业务结果一个字没变**（还是那个绑定结果）。
            self.assertEqual(out, {'module': 'mail', 'mail': 'MAIL-1'},
                             '确认那段的返回变了（不该变）：%r' % (out,))
            self.assertEqual(len(harness.records), 1,
                             '确认一次没写进一条过程记录：%r' % (harness.records,))
            row = harness.records[0]
            self.assertEqual(row['what_id'], WHAT_REVIEW_CONFIRMED,
                             '确认那一条没带自己的动作标识：%r' % (row,))
            self.assertNotEqual(row['what_id'], WHAT_DRAFT_SAVED,
                                '确认那一条跟草稿建那条撞了标识 ⇒ 三段分不开')
            self.assertEqual(row['business_object_id'], 'mail.message')
            self.assertEqual(row['business_name'], 'MAIL-1')

    def test_sending_writes_the_send_record_with_its_result(self):
        """③ **发写一条**，且那一条**带结果与失败原因**（自己的标识）。"""
        with _Harness() as harness:
            self.assertTrue(
                hasattr(harness.mailprocess, 'record_send_result'),
                '邮件域没有「发」那笔的写口（record_send_result）'
                '⇒ 邮件发给了谁、结果与失败原因，查不到')
            harness.send({'status': 'Sent', 'error': '', 'rejected': []})
            self.assertEqual(len(harness.records), 1,
                             '发一封信没写进一条过程记录：%r' % (harness.records,))
            row = harness.records[0]
            self.assertEqual(row['what_id'], WHAT_SEND_RESULT,
                             '发那一条没带自己的动作标识：%r' % (row,))
            self.assertEqual(row['result'], 'Succeeded')
            detail = row.get('detail') or {}
            self.assertEqual(detail.get('status'), 'Sent')
            self.assertNotIn('client@example.invalid', json.dumps(detail, ensure_ascii=False),
                             '日志里抄了收件人地址 ⇒ 同一个值存了两处')

    def test_the_three_segments_write_three_records_that_do_not_mix(self):
        """④ **三条各带自己动作标识、三条互不串、都挂在同一封邮件上**。"""
        with _Harness() as harness:
            harness.draft_saved()
            harness.confirm()
            harness.send()
            self.assertEqual(len(harness.records), 3,
                             '草稿建／确认／发三段下来不是三条记录：%r' % (
                                 [row.get('what_id') for row in harness.records],))
            what_ids = [row['what_id'] for row in harness.records]
            self.assertEqual(what_ids,
                             [WHAT_DRAFT_SAVED, WHAT_REVIEW_CONFIRMED, WHAT_SEND_RESULT],
                             '三段的标识不对或串了：%r' % (what_ids,))
            self.assertEqual(len(set(what_ids)), 3, '三段里有两段撞了标识：%r' % (what_ids,))
            # 三条都挂在**同一封邮件**上（按这封信取日志 ⇒ 三段一次取齐）。
            for row in harness.records:
                self.assertEqual(row['business_object_id'], 'mail.message')
                self.assertEqual(row['business_name'], 'MAIL-1')
                self.assertEqual(row['domain_id'], 'com.shangshu.mail')
            # 各自带**自己的可区分字段**（不共用一个「都差不多」的 detail）。
            details = [row.get('detail') or {} for row in harness.records]
            self.assertEqual(details[0].get('operation'), 'mail.save_draft')
            self.assertEqual(details[1].get('operation'), 'mail.review.confirm')
            self.assertEqual(details[2].get('operation'), 'mail.send')
            self.assertIn('is_new', details[0])
            self.assertNotIn('is_new', details[1])
            self.assertIn('units', details[1])
            self.assertNotIn('units', details[0])
            self.assertIn('status', details[2])
            self.assertNotIn('status', details[0])

    def test_a_failing_log_write_does_not_break_the_business(self):
        """⑤ **日志写不上不许把正事搞没**（确认照样过、信照样发出去）。"""
        with _Harness() as harness:
            harness.write_error = RuntimeError('日志库此刻写不上')
            # 「确认」：写不上只通报 ⇒ 绑定结果照样给回去。
            out = harness.confirm()
            self.assertEqual(out, {'module': 'mail', 'mail': 'MAIL-1'},
                             '日志写不上把确认搞没了：%r' % (out,))
            self.assertTrue(harness.warnings,
                            '日志写不上没有通报一声 ⇒ 事后没人知道少了一笔')
            # 「发」：写不上 ⇒ 信**照样发出去**（状态落终态、不回滚）。
            harness.send()
            self.assertEqual(harness.doc.status, 'Sent',
                             '日志写不上把信的状态弄没了：%r' % (harness.doc.status,))
            self.assertEqual(harness.rollbacks, 0,
                             '日志写不上引发了回滚 ⇒ 正事被搞没了')
            self.assertTrue(harness.doc.saved, '信没落库')

    def test_the_new_mail_code_only_uses_the_public_api(self):
        """⑥ **新代码只走公开口**（域不许 import 内核内部模块）。"""
        for name in ('mailprocess.py', 'proposal_review.py', 'delivery.py'):
            source = (DOMAIN_ROOT / name).read_text(encoding='utf-8')
            for line in source.splitlines():
                stripped = line.strip()
                if not stripped.startswith(('from ', 'import ')):
                    continue
                if 'shangshu_core' not in stripped:
                    continue
                self.assertIn('shangshu_core.public_api', stripped,
                              '%s 里引了内核内部模块：%s（域只许引 public_api）'
                              % (name, stripped))


if __name__ == '__main__':
    unittest.main()
