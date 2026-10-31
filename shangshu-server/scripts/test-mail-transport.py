"""邮件协议回归：受控假 SMTP/IMAP，不触达外部邮箱或真实凭据。"""
import sys
import json
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_mail'))
from shangshu_mail import transport


class FakeSMTP:
    refused = {}
    failure = None
    calls = []

    def __init__(self, host, port, **kwargs):
        self.__class__.calls.append((host, port, kwargs))
    def login(self, login, password):
        self.login_args = (login, password)
    def send_message(self, message, **kwargs):
        self.message = message
        if self.failure:
            raise self.failure
        return self.refused
    def quit(self):
        pass
    def close(self):
        pass


class TransportTests(unittest.TestCase):
    def test_external_tracking_image_removed_but_managed_cid_kept(self):
        clean=transport.sanitize_html('<p>正文</p><img src="https://tracker.invalid/pixel"><img src="cid:logo" alt="公司">')
        self.assertNotIn('tracker.invalid',clean)
        self.assertEqual(clean.count('<img'),1)
        self.assertIn('cid:logo',clean)

    def test_html_mail_preserves_table_plain_alternative_and_fixed_attachment(self):
        captured=[]
        class Capture(FakeSMTP):
            def send_message(self,message,**kwargs):
                captured.append(message)
                return {}
        body='<p>客户您好</p><table><tr><th>案件</th><th>金额</th></tr><tr><td>A001</td><td>150.00</td></tr></table>'
        with patch.object(transport.smtplib,'SMTP_SSL',Capture):
            result=transport.send_message('demo@qq.com','synthetic','',{
                'subject':'年费核对','body':body,'body_format':'HTML',
                'to':['client@example.invalid'],'cc':[],
                'message_id':'<fixed-html@example.invalid>'},[{'name':'核对材料.pdf','content':b'%PDF-synthetic'}])
        self.assertEqual(result['status'],'Sent')
        self.assertEqual(captured[0].get_body(preferencelist=('html',)).get_content().strip(),body)
        plain=captured[0].get_body(preferencelist=('plain',)).get_content()
        self.assertIn('A001\t150.00',plain)
        self.assertNotIn('<table>',plain)
        self.assertEqual(next(captured[0].iter_attachments()).get_payload(decode=True),b'%PDF-synthetic')
        self.assertEqual(captured[0]['Message-ID'],'<fixed-html@example.invalid>')

    def test_draft_declares_explicit_html_and_private_thread_lookup(self):
        from shangshu_mail.domain import ACTIONS,get_contribution
        draft=next(row[2] for row in ACTIONS if row[0]=='mail.save_draft')
        self.assertEqual(draft['properties']['body_format']['enum'],['Text','HTML'])
        self.assertNotIn('body_format',draft['required'])
        thread=next(row for row in get_contribution()['services'] if row['id']=='mail.thread')
        self.assertEqual(thread['effect'],'read')
        self.assertEqual(thread['roles'],['Desk User'])
        self.assertEqual(thread['input_schema']['required'],['mail'])

    def test_enterprise_requires_explicit_provider_and_fixed_node(self):
        for provider, smtp, imap in [
            ('netease-enterprise','smtp.qiye.163.com','imap.qiye.163.com'),
            ('netease-enterprise-hz','smtphz.qiye.163.com','imaphz.qiye.163.com'),
        ]:
            found=transport.provider_for('buyer@company.example',provider)
            self.assertEqual((found['smtp_host'],found['imap_host']),(smtp,imap))
            for invalid in ('root@localhost','x@127.0.0.1','x@qq.com','x@163.com',
                            'x@company.example\r\nBcc: other@example.com'):
                with self.assertRaises(ValueError): transport.provider_for(invalid,provider)
        with self.assertRaises(ValueError): transport.provider_for('buyer@company.example')
        with self.assertRaises(ValueError): transport.provider_for('buyer@company.example','smtp.attacker.example')

    def test_enterprise_tls_connection_and_send_preserve_selected_provider(self):
        calls=[]
        class Inbox:
            capabilities=()
            def __init__(self,host,port,**kwargs): calls.append((host,port,kwargs))
            def login(self,*args): pass
            def select(self,folder,readonly=False):
                self.assert_readonly=readonly
                return 'OK',[]
            def logout(self): pass
        FakeSMTP.calls=[];FakeSMTP.failure=None;FakeSMTP.refused={}
        with patch.object(transport.smtplib,'SMTP_SSL',FakeSMTP),patch.object(transport.imaplib,'IMAP4_SSL',Inbox):
            for provider,smtp,imap in [
                ('netease-enterprise','smtp.qiye.163.com','imap.qiye.163.com'),
                ('netease-enterprise-hz','smtphz.qiye.163.com','imaphz.qiye.163.com'),
            ]:
                transport.test_connection('buyer@company.example','fake',provider)
                outcome=transport.send_message('buyer@company.example','fake','采购',{
                    'subject':'测试','body':'正文','to':['supplier@example.com'],
                    'cc':[],'message_id':'<enterprise@example.com>'},[],provider)
                self.assertEqual(outcome['status'],'Sent')
                self.assertEqual(FakeSMTP.calls[-1][:2],(smtp,465))
                self.assertEqual(FakeSMTP.calls[-2][:2],(smtp,465))
                self.assertEqual(calls[-1][:2],(imap,993))
                self.assertTrue(calls[-1][2]['ssl_context'].check_hostname)
                self.assertTrue(FakeSMTP.calls[-1][2]['context'].check_hostname)
        self.assertEqual(len(FakeSMTP.calls),4)
        self.assertEqual(len(calls),2)

    def test_enterprise_login_failure_does_not_try_another_node(self):
        calls=[]
        class Refused(FakeSMTP):
            def __init__(self,host,port,**kwargs): calls.append(host)
            def login(self,*args): raise RuntimeError('secret must not leak')
        with patch.object(transport.smtplib,'SMTP_SSL',Refused):
            outcome=transport.send_message('buyer@company.example','fake','',{
                'subject':'测试','body':'正文','to':['supplier@example.com'],
                'cc':[],'message_id':'<enterprise@example.com>'},[],'netease-enterprise-hz')
        self.assertEqual(calls,['smtphz.qiye.163.com'])
        self.assertEqual(outcome['status'],'Failed')
        self.assertNotIn('secret',str(outcome))

    def test_enterprise_schema_and_app_versions_are_published_consistently(self):
        from shangshu_mail.domain import ACTIONS,get_contribution
        import shangshu_mail
        root=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_mail'
        schema=next(item[2] for item in ACTIONS if item[0]=='mail.account.configure')
        expected={'qq','163','netease-enterprise','netease-enterprise-hz'}
        self.assertEqual(set(schema['properties']['provider']['enum']),expected)
        data=json.loads((root/'shangshu_mail/shangshu_mail/doctype/shangshu_mail_account/shangshu_mail_account.json').read_text())
        field=next(item for item in data['fields'] if item['fieldname']=='provider')
        self.assertEqual(field['fieldtype'],'Select')
        self.assertEqual(set(field['options'].splitlines()),expected)
        self.assertEqual(shangshu_mail.__version__,'0.4.0')
        self.assertEqual(get_contribution()['version'],shangshu_mail.__version__)
        self.assertIn('version = "'+shangshu_mail.__version__+'"',(root/'pyproject.toml').read_text())
        self.assertIn('version: '+shangshu_mail.__version__,(root/'shangshu-plugin.yml').read_text())

    def test_attachment_contract_requires_fixed_file_reference_not_business_record(self):
        from shangshu_mail.domain import ACTIONS
        schema=next(item[2] for item in ACTIONS if item[0]=='mail.save_draft')
        field=schema['properties']['attachments']
        description=field.get('description','')+' '+field['items'].get('description','')
        for word in ('source.file','frappe_file','files.versions','ref_name','URL','固定'):
            self.assertIn(word,description)

    def test_imap_only_reads_with_tls_and_peek(self):
        raw=EmailMessage();raw['From']='factory@example.com';raw.set_content('报价')
        wire=raw.as_bytes();calls=[]
        class Inbox:
            capabilities=()
            def __init__(self,*args,**kwargs):
                self.args=args;self.kwargs=kwargs;calls.append(('connect',args,kwargs))
            def login(self,*args): calls.append(('login',))
            def select(self,folder,readonly=False):
                calls.append(('select',folder,readonly));return 'OK',[b'1']
            def response(self,key): return key,[b'123']
            def uid(self,command,*args):
                calls.append((command,*args))
                if command=='search':return 'OK',[b'12 13']
                if args[1]=='(RFC822.SIZE)':return 'OK',[f'1 (RFC822.SIZE {len(wire)})'.encode()]
                return 'OK',[(b'1',wire)]
            def logout(self): calls.append(('logout',))
        with patch.object(transport.imaplib,'IMAP4_SSL',Inbox):
            inbox=transport.imap_session('demo@qq.com','fake-password')
            self.assertEqual(transport.inbox_uids(inbox),('123',[12,13]))
            self.assertIn('报价',transport.fetch_message(inbox,13)['body'])
            transport.close(inbox)
        self.assertIn(('select','INBOX',True),calls)
        self.assertIn(('fetch','13','(BODY.PEEK[])'),calls)
        self.assertTrue(calls[0][2]['ssl_context'].check_hostname)
        self.assertFalse(any(item[0] in ('store','expunge','delete') for item in calls))

    def test_provider_is_allowlisted_not_arbitrary_host(self):
        self.assertEqual(transport.provider_for('hello@qq.com')['smtp_host'], 'smtp.qq.com')
        self.assertEqual(transport.provider_for('hello@163.com')['imap_host'], 'imap.163.com')
        for value in ['root@localhost', 'http://127.0.0.1', 'x@qq.com\r\nBcc: bad@example.com']:
            with self.assertRaises(ValueError):
                transport.provider_for(value)

    def test_parse_preserves_reply_attachment_and_plain_text(self):
        raw = EmailMessage()
        raw['From'] = '工厂 <factory@example.com>'
        raw['To'] = 'demo@qq.com'
        raw['Subject'] = '采购回复'
        raw['Message-ID'] = '<reply@example.com>'
        raw['In-Reply-To'] = '<request@example.com>'
        raw.set_content('报价 100 元')
        raw.add_attachment(b'price,100', maintype='text', subtype='csv', filename='报价.csv')
        parsed = transport.parse_message(raw.as_bytes())
        self.assertEqual(parsed['message_id'], '<reply@example.com>')
        self.assertEqual(parsed['in_reply_to'], '<request@example.com>')
        self.assertIn('100', parsed['body'])
        self.assertEqual(parsed['attachments'][0]['content'], b'price,100')

    def test_html_is_kept_sanitized_never_remote_loading_or_script(self):
        # 契约变更（H3 MAIL-02）：收件 HTML 不再压成纯文本，而是净化后留存表格结构；
        # 仍必须拒绝脚本与任意外部图片请求。旧的“转文本”断言不能继续当通过依据。
        raw = EmailMessage()
        raw['From'] = 'factory@example.com'
        raw.set_content('<p>报价</p><table><tr><td colspan="2">合并</td></tr></table>'
                        '<script>steal()</script><img src="https://tracker.invalid/pixel">', subtype='html')
        parsed = transport.parse_message(raw.as_bytes())
        self.assertEqual(parsed['body_format'], 'HTML')
        self.assertIn('报价', parsed['body'])
        self.assertIn('<table', parsed['body'])
        self.assertIn('colspan="2"', parsed['body'])
        self.assertNotIn('steal', parsed['body'])
        self.assertNotIn('https://', parsed['body'])

    def test_raw_size_bound_is_explicit(self):
        with self.assertRaises(ValueError):
            transport.parse_message(b'x' * (transport.MAX_MESSAGE_BYTES + 1))

    def test_smtp_uses_certificate_verification_and_fixed_headers(self):
        FakeSMTP.refused = {}; FakeSMTP.failure = None; FakeSMTP.calls = []
        with patch.object(transport.smtplib, 'SMTP_SSL', FakeSMTP):
            outcome = transport.send_message('demo@qq.com', 'private-test-code', '方舟', {
                'subject':'采购确认','body':'确认采购','to':['工厂 <factory@example.com>'],
                'cc':[],'message_id':'<fixed@example.com>'}, [])
        self.assertEqual(outcome['status'], 'Sent')
        self.assertTrue(FakeSMTP.calls[0][2]['context'].check_hostname)

    def test_partial_refusal_is_not_reported_as_sent(self):
        FakeSMTP.refused = {'second@example.com':(550, b'bad')}; FakeSMTP.failure = None
        with patch.object(transport.smtplib, 'SMTP_SSL', FakeSMTP):
            outcome = transport.send_message('demo@qq.com', 'private-test-code', '', {
                'subject':'测试','body':'正文','to':['first@example.com','second@example.com'],
                'cc':[],'message_id':'<fixed@example.com>'}, [])
        self.assertEqual(outcome['status'], 'Partial')
        self.assertEqual(outcome['rejected'], ['second@example.com'])

    def test_network_failure_during_send_is_unknown_not_retryable(self):
        FakeSMTP.refused = {}; FakeSMTP.failure = TimeoutError('password-must-never-leak')
        with patch.object(transport.smtplib, 'SMTP_SSL', FakeSMTP):
            outcome = transport.send_message('demo@qq.com', 'private-test-code', '', {
                'subject':'测试','body':'正文','to':['first@example.com'],
                'cc':[],'message_id':'<fixed@example.com>'}, [])
        self.assertEqual(outcome['status'], 'Unknown')
        self.assertNotIn('password', str(outcome))
        FakeSMTP.failure = None

    # ---- 加密方式对不上时，不许把信卡死 ----
    #
    # 为什么需要这几条：2026-10-13 下午实测，smtp.qq.com 的 465 和 587 都**先说人话**
    # （明文 banner `220 … XMail Esmtp QQ Mail`），EHLO 里广告 STARTTLS；
    # 而产品写死 `SMTP_SSL(host, 465)` 一上去就包 TLS，对面在说明文 →
    # `[SSL: WRONG_VERSION_NUMBER]`，信一封都没交出去，只留下
    # 「邮箱连接或授权失败，未开始发送」。收信 (993) 同一时刻是好的，宿主机和
    # 容器表现一致 —— 不是网络全断，是外发这条的加密方式对不上。
    #
    # 测试通过 = 加密方式对不上时信照样交得出去；对得上时还走老路；
    #            且**任何一条路都不许明文把信丢出去**。

    def test_send_falls_back_to_starttls_when_implicit_tls_is_refused(self):
        """服务商只肯「明文 + STARTTLS」不肯隐式 TLS → 信照样交得出去。"""
        made = []

        class StartTLSOnly:
            def __init__(self, host, port, **kwargs):
                made.append((host, port, kwargs))
                self.tls = False
                self.logged = None
                self.sent = None
            def ehlo(self):
                return (250, b'ok')
            def starttls(self, context=None):
                assert context is not None, 'starttls 必须带证书校验上下文，不能裸奔'
                self.tls = True
            def login(self, login, password):
                self.logged = (login, password)
            def send_message(self, message, **kwargs):
                assert self.tls, '必须先 STARTTLS 再发信，不能明文把信丢出去'
                assert self.logged, '必须先登录再发信'
                self.sent = message
                return {}
            def quit(self):
                pass
            def close(self):
                pass

        class RefuseImplicitTLS:
            def __init__(self, *args, **kwargs):
                raise transport.ssl.SSLError('[SSL: WRONG_VERSION_NUMBER] wrong version number')

        with patch.object(transport.smtplib, 'SMTP_SSL', RefuseImplicitTLS), \
             patch.object(transport.smtplib, 'SMTP', StartTLSOnly):
            outcome = transport.send_message('demo@qq.com', 'synthetic', '', {
                'subject': '退回 STARTTLS', 'body': '正文',
                'to': ['peer@example.invalid'], 'cc': [],
                'message_id': '<fallback@example.invalid>'}, [])

        self.assertEqual(outcome['status'], 'Sent', outcome)
        self.assertEqual(len(made), 1, '该退回到明文通道并只建一次连接')
        self.assertEqual(made[0][1], 587, '退回时走 587 STARTTLS，不是 465')
        self.assertEqual(made[0][2].get('timeout'), transport.TIMEOUT)

    def test_send_never_sends_plaintext_when_starttls_is_unavailable(self):
        """服务商连 STARTTLS 都不给 → 一封都不许明文发出去，宁可失败。

        光看返回状态是**假绿**：没加密时失败也会返回 Failed/Unknown。
        所以这里盯的是「有没有人动手」—— 登录和发信一次都不许发生，
        断言放外面，免得被 send_message 的 `except Exception` 吞掉。
        """
        touched = []

        class NoTLS:
            def __init__(self, host, port, **kwargs):
                pass
            def ehlo(self):
                return (250, b'ok')
            def starttls(self, context=None):
                raise transport.smtplib.SMTPNotSupportedError('STARTTLS not available')
            def login(self, login, password):
                touched.append('login')
            def send_message(self, message, **kwargs):
                touched.append('send')
                return {}
            def quit(self):
                pass
            def close(self):
                pass

        class RefuseImplicitTLS:
            def __init__(self, *args, **kwargs):
                raise transport.ssl.SSLError('[SSL: WRONG_VERSION_NUMBER] wrong version number')

        with patch.object(transport.smtplib, 'SMTP_SSL', RefuseImplicitTLS), \
             patch.object(transport.smtplib, 'SMTP', NoTLS):
            outcome = transport.send_message('demo@qq.com', 'synthetic', '', {
                'subject': '不许裸奔', 'body': '正文',
                'to': ['peer@example.invalid'], 'cc': [],
                'message_id': '<naked@example.invalid>'}, [])

        self.assertEqual(touched, [],
                         f'加密没做成却还是动手了：{touched} —— 信被明文丢出去了')
        self.assertIn(outcome['status'], ('Failed', 'Unknown'), outcome)
        self.assertNotIn('password', str(outcome))

    def test_signature_flows_into_plain_text_alternative(self):
        """SIG-K：发出去的 MIME 里 text/plain 替代**也有签名**，和预览一致。

        测试通过 = 带签名的 HTML 正文发出去后，独立解析那份 MIME：
          · 有 text/plain 替代
          · 纯文本里**也有签名那几个字**（不是只在 HTML 里有）
          · HTML 里签名也还在
        计划 §4.4「版本与资源」原话：「预览、重开及独立解析 MIME/纯文本替代一致」。
        """
        captured = []

        class Capture(FakeSMTP):
            def send_message(self, message, **kwargs):
                captured.append(message)
                return {}

        body = ('<p>正文一段</p>'
                '<div data-mail-signature="1"><p class="mail-signature">'
                '—— 张三<br>银聆科技</p></div>'
                '<div data-mail-quote="1"><p>原信引用</p></div>')
        with patch.object(transport.smtplib, 'SMTP_SSL', Capture):
            outcome = transport.send_message('demo@qq.com', 'synthetic', '', {
                'subject': '带签名', 'body': body, 'body_format': 'HTML',
                'to': ['peer@example.invalid'], 'cc': [],
                'message_id': '<sig@example.invalid>'}, [])
        self.assertEqual(outcome['status'], 'Sent', outcome)
        msg = captured[0]
        # 独立解析那份 MIME（不是看构造时的中间变量）
        from email import message_from_bytes
        parsed = message_from_bytes(msg.as_bytes())
        plain_parts, html_parts = [], []
        for part in parsed.walk():
            if part.get_content_type() == 'text/plain':
                plain_parts.append(part.get_payload(decode=True) or b'')
            elif part.get_content_type() == 'text/html':
                html_parts.append(part.get_payload(decode=True) or b'')
        self.assertTrue(plain_parts, 'MIME 里应当有 text/plain 替代')
        plain = b'\n'.join(plain_parts).decode('utf-8', 'replace')
        html = b'\n'.join(html_parts).decode('utf-8', 'replace')
        for word in ('张三', '银聆科技'):
            self.assertIn(word, plain, f'纯文本替代里也该有签名（缺 {word}）：{plain[:200]!r}')
            self.assertIn(word, html, f'HTML 里该有签名（缺 {word}）：{html[:200]!r}')
        # 引用也该在两种里都在
        self.assertIn('原信引用', plain)
        self.assertIn('原信引用', html)

    def test_implicit_tls_is_preferred_when_provider_accepts_it(self):
        """服务商肯收隐式 TLS → 还走老路，不因为加了回退就无谓改道。"""
        used = {'starttls_channel': False}

        class Implicit(FakeSMTP):
            def __init__(self, host, port, **kwargs):
                FakeSMTP.__init__(self, host, port, **kwargs)

        class ShouldNotBeUsed:
            def __init__(self, *args, **kwargs):
                used['starttls_channel'] = True
                raise AssertionError('隐式 TLS 可用时不许改走明文通道')

        FakeSMTP.refused = {}; FakeSMTP.failure = None
        with patch.object(transport.smtplib, 'SMTP_SSL', Implicit), \
             patch.object(transport.smtplib, 'SMTP', ShouldNotBeUsed):
            outcome = transport.send_message('demo@qq.com', 'synthetic', '', {
                'subject': '老路优先', 'body': '正文',
                'to': ['peer@example.invalid'], 'cc': [],
                'message_id': '<prefer@example.invalid>'}, [])

        self.assertEqual(outcome['status'], 'Sent', outcome)
        self.assertFalse(used['starttls_channel'])
        self.assertEqual(FakeSMTP.calls[-1][1], 465)
        self.assertIsNotNone(FakeSMTP.calls[-1][2].get('context'),
                             '隐式 TLS 必须带证书校验上下文')


if __name__ == '__main__':
    unittest.main()
