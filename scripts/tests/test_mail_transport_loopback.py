"""Actual loopback TCP/TLS SMTP capture; no site, containers, credentials or external delivery.

Only the socket-opening seam is routed to a temporary TLS server. Production
provider validation, smtplib SMTP/AUTH/DATA, MIME and outcome handling run as-is.
This proves local SMTP acceptance, not an Internet recipient or deployed worker.
"""
import base64
import importlib.util
import ipaddress
import socket
import socketserver
import ssl
import tempfile
import threading
from datetime import datetime,timedelta
from email import policy
from email.parser import BytesParser
from pathlib import Path
from unittest import TestCase,main
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('loopback_mail_transport',ROOT/'frappe_apps/shangshu_mail/shangshu_mail/transport.py')
transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)

class Capture(socketserver.StreamRequestHandler):
    def send(self,value):self.wfile.write(value);self.wfile.flush()
    def handle(self):
        self.send(b'220 localhost synthetic capture\r\n')
        sender='';recipients=[]
        while True:
            raw=self.rfile.readline(8192)
            if not raw:return
            command,_,argument=raw.decode('ascii','replace').strip().partition(' ')
            command=command.upper()
            if command in ('EHLO','HELO'):self.send(b'250-localhost\r\n250-AUTH PLAIN\r\n250 SIZE 1048576\r\n')
            elif command=='AUTH':self.server.auth_count+=1;self.send(b'235 synthetic credentials accepted\r\n')
            elif command=='MAIL':sender=argument.partition(':')[2].strip().partition('>')[0].lstrip('<');recipients=[];self.send(b'250 sender accepted\r\n')
            elif command=='RCPT':
                recipient=argument.partition(':')[2].strip().partition('>')[0].lstrip('<')
                if recipient.startswith('reject@'):self.send(b'550 synthetic recipient rejection\r\n')
                else:recipients.append(recipient);self.send(b'250 recipient accepted\r\n')
            elif command=='DATA':
                self.send(b'354 end with dot\r\n');chunks=[]
                while True:
                    line=self.rfile.readline(1048576)
                    if not line:return
                    if line==b'.\r\n':break
                    chunks.append(line[1:] if line.startswith(b'..') else line)
                    if sum(map(len,chunks))>1048576:raise AssertionError('synthetic capture size exceeded')
                self.server.messages.append({'sender':sender,'recipients':recipients[:],'wire':b''.join(chunks)})
                if self.server.mode=='disconnect':return  # DATA complete, acceptance ack deliberately lost.
                self.send(b'550 synthetic DATA rejection\r\n' if self.server.mode=='reject-data' else b'250 locally accepted\r\n')
            elif command in ('NOOP','RSET'):self.send(b'250 ok\r\n')
            elif command=='QUIT':self.send(b'221 closing\r\n');return
            else:self.send(b'500 unsupported synthetic command\r\n')

class TLSCapture(socketserver.ThreadingTCPServer):
    daemon_threads=True
    def get_request(self):
        connection,address=super().get_request();connection.settimeout(3)
        return self.context.wrap_socket(connection,server_side=True),address

class LoopbackSMTP(TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='shangshu-loopback-smtp-');self.addCleanup(self.temporary.cleanup)
        folder=Path(self.temporary.name);key=ec.generate_private_key(ec.SECP256R1());name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
        certificate=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(datetime.utcnow()-timedelta(minutes=1))
            .not_valid_after(datetime.utcnow()+timedelta(hours=1)).add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False)
            .sign(key,hashes.SHA256()))
        cert=folder/'certificate.pem';private=folder/'private.pem'
        cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        private.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));private.chmod(0o600)
        self.client_context=ssl.create_default_context(cafile=str(cert))
        server_context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);server_context.load_cert_chain(str(cert),str(private))
        self.server=TLSCapture(('127.0.0.1',0),Capture);self.server.context=server_context;self.server.mode='accept';self.server.messages=[];self.server.auth_count=0
        threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':0.01},daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        real_connect=socket.create_connection
        def loopback_only(address,*args,**kwargs):
            if address[0] not in ('localhost','127.0.0.1'):raise AssertionError('external SMTP socket forbidden')
            return real_connect(address,*args,**kwargs)
        self.network=patch.object(socket,'create_connection',side_effect=loopback_only);self.network.start();self.addCleanup(self.network.stop)
        def open_local(_):
            connection=transport.smtplib.SMTP_SSL('localhost',self.server.server_address[1],timeout=3,context=self.client_context)
            self.assertEqual(connection.sock.getpeername()[0],'127.0.0.1')
            return connection
        self.route=patch.object(transport,'_open_smtp',side_effect=open_local);self.route.start();self.addCleanup(self.route.stop)
        transport._SESSIONS.clear()
        self.addCleanup(lambda:transport.drop_session('sender@capture.invalid','netease-enterprise','synthetic-1'))

    def send(self,to=None,**extra):
        payload={'subject':'本地捕获 · 合成邮件','body':'<p>合成正文</p>','body_format':'HTML',
                 'to':to or ['receiver@example.invalid'],'cc':[],'message_id':'<loopback@example.invalid>',**extra}
        return transport.send_message('sender@capture.invalid','synthetic-not-a-real-secret','合成部门邮箱',payload,
            [{'name':'合成清单.csv','content':b'00123,1234.56\n'}],'netease-enterprise',
            inline_resources=extra.get('inline_resources'),credential_version='synthetic-1')

    def test_verified_tls_smtp_receives_exact_html_table_signature_quote_inline_and_attachment(self):
        body='<p>合成正文</p><table><tr><td>00123</td><td>1234.56</td></tr></table><div data-mail-signature="1">合成签名</div><blockquote>原信引用</blockquote><img src="cid:synthetic-image">'
        image=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0bEAAAAASUVORK5CYII=')
        result=self.send(body=body,cc=['copy@example.invalid'],in_reply_to='<original@example.invalid>',inline_resources=[{'content_id':'synthetic-image','mime_type':'image/png','name':'synthetic.png','content':image}])
        self.assertEqual(result['status'],'Sent');self.assertEqual(len(self.server.messages),1);self.assertEqual(self.server.auth_count,1)
        captured=self.server.messages[0];self.assertEqual(captured['sender'],'sender@capture.invalid');self.assertEqual(captured['recipients'],['receiver@example.invalid','copy@example.invalid'])
        parsed=BytesParser(policy=policy.default).parsebytes(captured['wire'])
        self.assertEqual(parsed['Message-ID'],'<loopback@example.invalid>');self.assertEqual(parsed['In-Reply-To'],'<original@example.invalid>')
        self.assertEqual(parsed.get_body(preferencelist=('html',)).get_content().strip(),body)
        plain=parsed.get_body(preferencelist=('plain',)).get_content()
        for value in ('00123','1234.56','合成签名','原信引用'):self.assertIn(value,plain)
        self.assertEqual(next(part for part in parsed.walk() if part.get_filename()=='合成清单.csv').get_payload(decode=True),b'00123,1234.56\n')
        self.assertEqual(next(part for part in parsed.walk() if part.get('Content-ID')=='<synthetic-image>').get_payload(decode=True),image)
        self.assertTrue(self.client_context.check_hostname);self.assertEqual(self.client_context.verify_mode,ssl.CERT_REQUIRED)
        self.assertEqual(transport.PROVIDERS['netease-enterprise']['smtp_host'],'smtp.qiye.163.com')

    def test_one_refused_recipient_is_partial_not_full_success(self):
        result=self.send(['receiver@example.invalid','reject@example.invalid'])
        self.assertEqual((result['status'],result['rejected']),('Partial',['reject@example.invalid']))
        self.assertEqual(self.server.messages[0]['recipients'],['receiver@example.invalid'])

    def test_all_refused_recipients_never_send_data(self):
        result=self.send(['reject@example.invalid'])
        self.assertEqual(result['status'],'Failed');self.assertEqual(self.server.messages,[])

    def test_explicit_data_rejection_is_failed(self):
        self.server.mode='reject-data';result=self.send()
        self.assertEqual(result['status'],'Failed');self.assertEqual(len(self.server.messages),1)

    def test_lost_ack_after_data_is_unknown_even_when_capture_has_full_message(self):
        self.server.mode='disconnect';result=self.send()
        self.assertEqual(result['status'],'Unknown');self.assertEqual(len(self.server.messages),1)
        self.assertIn('不能直接重发',result['error'])

if __name__=='__main__':main()
