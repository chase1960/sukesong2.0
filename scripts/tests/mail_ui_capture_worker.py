"""Temporary green-site worker controller. Requires the explicit synthetic fixture.

Pauses one verified idle worker, enables only the synthetic mailbox, and waits
for an output/run file before consuming one validated queued job. A stop file,
signal or deadline disables that mailbox, fails unfinished fixture mail, and
resumes the original worker. No product modules are edited.
"""
import argparse
import json
import os
import signal
import time
from pathlib import Path

import frappe
from rq import SimpleWorker, Worker
from frappe.utils.background_jobs import get_queue
from shangshu_mail import account, service, transport
from mail_ui_capture import CaptureServer

BOX = 'ui967-local-tls-capture'
SITE = 'shangshu.localhost'
ACTOR = 'qa-a2@example.invalid'


def connect():
    frappe.init(site=SITE)
    frappe.connect()
    frappe.set_user(ACTOR)


def main(args):
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    capture = CaptureServer(output / 'smtp')
    connect()
    queues = [get_queue(name) for name in ('short', 'default', 'long')]
    assert all(q.count == 0 for q in queues), 'Existing queue must be empty'
    assert all(not w.get_current_job_id() for w in Worker.all(connection=queues[0].connection)), 'Worker is busy'
    command = Path('/proc/%d/cmdline' % args.worker_pid).read_bytes()
    assert b'frappe.utils.bench_helper' in command and b'worker' in command
    binding = frappe.get_doc(account.DOCTYPE, BOX)
    assert binding.email_address == 'ui967-capture@example.invalid' and not binding.enabled
    assert binding.owner == ACTOR and binding.provider == 'netease-enterprise'
    original_open, original_send = transport._open_smtp, transport.send_message
    def guarded_send(address, password, display, payload, *a, **kw):
        assert address == 'ui967-capture@example.invalid'
        assert payload['subject'].startswith('UI967-SEND')
        from email.utils import getaddresses
        assert all(addr.endswith('@example.invalid') for _, addr in getaddresses(payload['to'] + payload.get('cc', [])))
        return original_send(address, password, display, payload, *a, **kw)
    transport._open_smtp = lambda _server: capture.connect()
    transport.send_message = guarded_send
    stopped = False
    stop = [False]
    def request_stop(*_):
        stop[0] = True
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        os.kill(args.worker_pid, signal.SIGSTOP)
        stopped = True
        # SIGSTOP does not cancel Redis BLPOP: Redis can still reserve a job
        # into the paused worker's socket. Release its idle blocking read first.
        clients = [c for c in queues[0].connection.client_list() if c.get('cmd') == 'blpop']
        assert len(clients) <= 1, 'Unexpected additional blocking consumer'
        released = [c['id'] for c in clients if queues[0].connection.client_unblock(c['id'], error=False)]
        (output / 'released-blocking-reads.json').write_text(json.dumps(released))
        with account.writing():
            binding.enabled = 1
            binding.connection_status = 'connected'
            binding.save(ignore_permissions=True)
        frappe.db.commit()
        (output / 'ready.json').write_text(json.dumps({'mailbox': BOX, 'original_worker_paused': args.worker_pid,
            'controller_pid': os.getpid(), 'deadline_seconds': args.seconds, 'capture_loopback': True}))
        print('READY', flush=True)
        deadline = time.monotonic() + args.seconds
        while not stop[0] and not (output / 'stop').exists() and time.monotonic() < deadline:
            if (output / 'run').exists():
                mode = (output / 'run').read_text().strip() or 'accept'
                assert mode in ('accept', 'reject-data', 'disconnect')
                q = get_queue('long')
                jobs = q.get_jobs()
                assert jobs, 'No queued job'
                for job in jobs:
                    envelope = job.kwargs
                    method = envelope['method']
                    assert method == 'shangshu_mail.delivery.process_send' or getattr(method, '__name__', '') == 'process_send'
                    assert envelope['site'] == SITE and envelope['kwargs']['user'] == ACTOR
                    mail = frappe.get_doc('Shangshu Mail Message', envelope['kwargs']['name'])
                    assert mail.mailbox_id == BOX and mail.subject.startswith('UI967-SEND')
                capture.server.mode = mode
                (output / 'run').unlink()
                ids = [job.id for job in jobs]
                SimpleWorker([q], connection=q.connection).work(burst=True, max_jobs=len(jobs), logging_level='WARNING')
                connect()
                with (output / 'jobs.jsonl').open('a') as file:
                    file.write(json.dumps({'jobs': ids, 'mode': mode, 'captures': len(capture.server.captures),
                                           'auth_count': capture.server.auth_count}) + '\n')
            time.sleep(.1)
    finally:
        connect()
        # A queued fixture must not later be sent by the resumed production worker.
        for row in frappe.get_all('Shangshu Mail Message', filters={'mailbox_id': BOX, 'status': ['in', ['Queued', 'Sending']]}, fields=['name']):
            doc = frappe.get_doc('Shangshu Mail Message', row.name)
            with service.writing():
                doc.status = 'Failed'
                doc.delivery_error = 'Synthetic acceptance capture stopped; not delivered externally'
                doc.record_version += 1
                doc.save(ignore_permissions=True)
        with account.writing():
            binding = frappe.get_doc(account.DOCTYPE, BOX)
            binding.enabled = 0
            binding.connection_status = 'paused'
            binding.save(ignore_permissions=True)
        frappe.db.commit()
        transport._open_smtp, transport.send_message = original_open, original_send
        capture.close()
        if stopped:
            os.kill(args.worker_pid, signal.SIGCONT)
        (output / 'closed.json').write_text(json.dumps({'mailbox_disabled': True, 'original_worker_resumed': stopped}))
        frappe.destroy()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--worker-pid', required=True, type=int)
    parser.add_argument('--seconds', type=int, default=600)
    main(parser.parse_args())
