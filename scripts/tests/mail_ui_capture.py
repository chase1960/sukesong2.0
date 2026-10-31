"""Local verified-TLS capture for UI acceptance; never forwards SMTP.

Run --self-test before wiring a dedicated acceptance worker. Import CaptureServer
in that worker; routing is deliberately not installed in production processes.
AUTH contents are discarded, not logged. Captures contain synthetic messages.
"""
import argparse
import hashlib
import ipaddress
import json
import smtplib
import socketserver
import ssl
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

MAX_WIRE_BYTES = 32 * 1024 * 1024


class Handler(socketserver.StreamRequestHandler):
    def reply(self, data):
        self.wfile.write(data)
        self.wfile.flush()

    def handle(self):
        self.reply(b'220 localhost acceptance capture\r\n')
        sender, recipients = '', []
        while True:
            line = self.rfile.readline(16384)
            if not line:
                return
            command, _, argument = line.decode('ascii', 'replace').strip().partition(' ')
            command = command.upper()
            if command in ('EHLO', 'HELO'):
                self.reply(b'250-localhost\r\n250-AUTH PLAIN\r\n250 SIZE 33554432\r\n')
            elif command == 'AUTH':
                self.server.auth_count += 1
                self.reply(b'235 synthetic authentication accepted\r\n')
            elif command == 'MAIL':
                sender, recipients = argument, []
                self.reply(b'250 ok\r\n')
            elif command == 'RCPT':
                if 'reject@' in argument:
                    self.reply(b'550 synthetic recipient rejection\r\n')
                else:
                    recipients.append(argument)
                    self.reply(b'250 ok\r\n')
            elif command == 'DATA':
                self.reply(b'354 end with dot\r\n')
                chunks, size = [], 0
                while True:
                    part = self.rfile.readline(1048576)
                    if not part:
                        return
                    if part == b'.\r\n':
                        break
                    part = part[1:] if part.startswith(b'..') else part
                    size += len(part)
                    if size > MAX_WIRE_BYTES:
                        self.reply(b'552 capture size exceeded\r\n')
                        return
                    chunks.append(part)
                wire = b''.join(chunks)
                with self.server.capture_lock:
                    index = len(self.server.captures) + 1
                    mode = self.server.mode
                    path = self.server.output / ('capture-%03d.eml' % index)
                    path.write_bytes(wire)
                    record = {'index': index, 'mode': mode, 'sender': sender,
                              'recipients': recipients[:], 'bytes': len(wire),
                              'sha256': hashlib.sha256(wire).hexdigest(), 'file': path.name}
                    self.server.captures.append(record)
                    (self.server.output / 'captures.json').write_text(
                        json.dumps(self.server.captures, indent=2))
                if mode == 'disconnect':
                    return
                self.reply(b'550 synthetic DATA rejection\r\n' if mode == 'reject-data'
                           else b'250 locally accepted\r\n')
            elif command in ('NOOP', 'RSET'):
                self.reply(b'250 ok\r\n')
            elif command == 'QUIT':
                self.reply(b'221 bye\r\n')
                return
            else:
                self.reply(b'500 unsupported command\r\n')


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(30)
        return self.tls.wrap_socket(connection, server_side=True), address


class CaptureServer:
    def __init__(self, output):
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='ui-smtp-tls-')
        folder = Path(self.temporary.name)
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
        now = datetime.now(timezone.utc)
        certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                       .public_key(key.public_key()).serial_number(x509.random_serial_number())
                       .not_valid_before(now - timedelta(minutes=1))
                       .not_valid_after(now + timedelta(hours=2))
                       .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                       .add_extension(x509.SubjectAlternativeName([
                           x509.DNSName('localhost'), x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),
                           critical=False).sign(key, hashes.SHA256()))
        cert, private = folder / 'cert.pem', folder / 'key.pem'
        cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        private.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        private.chmod(0o600)
        self.client_context = ssl.create_default_context(cafile=str(cert))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(str(cert), str(private))
        self.server = Server(('127.0.0.1', 0), Handler)
        self.server.tls = tls
        self.server.output = self.output
        self.server.mode = 'accept'
        self.server.captures = []
        self.server.auth_count = 0
        self.server.capture_lock = threading.Lock()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def connect(self):
        # Fixed loopback peer plus verified certificate; caller cannot supply host.
        connection = smtplib.SMTP_SSL('localhost', self.server.server_address[1],
                                     timeout=30, context=self.client_context)
        assert connection.sock.getpeername()[0] == '127.0.0.1'
        return connection

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()


def self_test(output):
    from email import policy
    from email.parser import BytesParser
    server = CaptureServer(output)
    try:
        payload = b'UI065-SYNTHETIC\n' * (10 * 1024 * 1024 // 16 + 1)
        payload = (payload + b'x' * (10 * 1024 * 1024))[:10 * 1024 * 1024]
        mail = EmailMessage()
        mail['From'], mail['To'], mail['Subject'] = 'sender@example.invalid', 'receiver@example.invalid', 'UI capture self-test'
        mail.set_content('Synthetic only')
        mail.add_attachment(payload, maintype='application', subtype='octet-stream', filename='synthetic-10MiB.bin')
        with server.connect() as smtp:
            smtp.login('synthetic', 'discarded-synthetic-secret')
            smtp.send_message(mail)
            assert smtp.noop()[0] == 250
            try:
                smtp.sendmail('sender@example.invalid', ['reject@example.invalid'], b'Subject: reject\r\n\r\ntest')
                raise AssertionError('Expected recipient refusal')
            except smtplib.SMTPRecipientsRefused:
                pass
        wire = (Path(output) / 'capture-001.eml').read_bytes()
        received = BytesParser(policy=policy.default).parsebytes(wire)
        assert next(received.iter_attachments()).get_payload(decode=True) == payload
        for mode in ('reject-data', 'disconnect'):
            server.server.mode = mode
            smtp = server.connect()
            try:
                try:
                    smtp.sendmail('sender@example.invalid', ['receiver@example.invalid'], b'Subject: fault\r\n\r\ntest')
                    raise AssertionError('Expected controlled transport failure')
                except (smtplib.SMTPDataError, smtplib.SMTPServerDisconnected):
                    pass
            finally:
                smtp.close()
        result = {'verified_tls': True, 'loopback_only': True, 'attachment_bytes': len(payload),
                  'attachment_exact': True, 'captured_messages': len(server.server.captures),
                  'recipient_refusal': True, 'data_refusal': True, 'lost_ack': True,
                  'production_worker_wired': False}
        (Path(output) / 'self-test.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    finally:
        server.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    self_test(args.output)
