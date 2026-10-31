"""Atomic mutable File storage and temporary transaction recovery.

No history/archive is created by these primitives. The caller must hold its
resource/File database locks until its after_commit/after_rollback callback.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

def _sha(content):
    return hashlib.sha256(content).hexdigest()

def _sync_dir(path):
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_atomic(path, content):
    fd, name = tempfile.mkstemp(prefix='.save-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        _sync_dir(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class WorkingFileTransaction:
    """Caller holds the resource DB row lock before entering this file lock.

    Keep the file lock until after_commit/after_rollback. Readers either see a
    complete old file or a complete new file; they must compare its committed
    SHA and reload the resource row if a concurrent commit changed it.
    """
    def __init__(self, target, journal_root, key):
        self.target = Path(target)
        self.root = Path(journal_root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.key = hashlib.sha256(str(key).encode()).hexdigest()
        self.directory = self.root / (self.key + '.pending')
        self.lock = open(self.root / (self.key + '.lock'), 'a+b')
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        self.closed = False
        self.state = None

    def recover(self, committed_sha):
        if not self.directory.exists():
            return
        manifest = self.directory / 'manifest.json'
        if not manifest.exists():
            # An interrupted preparation cannot have replaced the target yet.
            shutil.rmtree(self.directory)
            _sync_dir(self.root)
            return
        state = json.loads(manifest.read_text())
        if state['target'] != str(self.target):
            raise RuntimeError('Working file recovery target mismatch')
        if committed_sha == state['after_sha']:
            if not self.target.exists() or _sha(self.target.read_bytes()) != committed_sha:
                raise RuntimeError('Committed workbook bytes do not match recovery journal')
        elif committed_sha == state['before_sha']:
            self._restore(state)
        else:
            raise RuntimeError('Workbook recovery requires a matching committed SHA')
        shutil.rmtree(self.directory)
        _sync_dir(self.root)

    def stage(self, content, before_sha):
        if self.state is None:
            if self.directory.exists():
                raise RuntimeError('Recover the pending workbook transaction before writing')
            self.directory.mkdir(mode=0o700)
            exists = self.target.exists()
            if exists:
                previous = self.target.read_bytes()
                if _sha(previous) != before_sha:
                    raise RuntimeError('Current workbook changed before save')
                _write_atomic(self.directory / 'before.bin', previous)
            self.state = {'target': str(self.target), 'before_sha': before_sha,
                          'after_sha': _sha(content), 'existed': exists,
                          'before_md5': hashlib.md5(previous).hexdigest() if exists else None,
                          'after_md5': hashlib.md5(content).hexdigest()}
        else:
            if before_sha != self.state['after_sha']:
                raise RuntimeError('Nested workbook write has a stale revision')
            self.state['after_sha'] = _sha(content)
            self.state['after_md5'] = hashlib.md5(content).hexdigest()
        _write_atomic(self.directory / 'manifest.json', json.dumps(self.state).encode())
        _sync_dir(self.root)
        _write_atomic(self.target, content)

    def _restore(self, state):
        if state['existed']:
            before = (self.directory / 'before.bin').read_bytes()
            if _sha(before) != state['before_sha']:
                raise RuntimeError('Workbook recovery before-image is damaged')
            _write_atomic(self.target, before)
        else:
            self.target.unlink(missing_ok=True)
            _sync_dir(self.target.parent)

    def checkpoint(self):
        """Package savepoint inside this still-open filesystem transaction.

        The usual first package needs no extra workbook copy. Only another
        package editing an already staged file retains its current bytes, so a
        caught later failure cannot undo an earlier caller's valid changes.
        """
        if self.closed:
            raise RuntimeError('Cannot checkpoint a closed workbook transaction')
        if self.state is None:
            return None
        return {'state': dict(self.state), 'content': self.target.read_bytes()}

    def restore_checkpoint(self, checkpoint):
        """Restore a package without releasing the outer transaction's lock."""
        if self.closed:
            raise RuntimeError('Cannot restore a closed workbook transaction')
        if checkpoint is None:
            if self.state is not None:
                self._restore(self.state)
            if self.directory.exists():
                shutil.rmtree(self.directory)
                _sync_dir(self.root)
            self.state = None
            return
        state, content = checkpoint['state'], checkpoint['content']
        if state['target'] != str(self.target) or _sha(content) != state['after_sha']:
            raise RuntimeError('Workbook package checkpoint is damaged')
        if self.state is None or not self.directory.exists():
            raise RuntimeError('Workbook transaction journal is missing')
        _write_atomic(self.directory / 'manifest.json', json.dumps(state).encode())
        _write_atomic(self.target, content)
        self.state = dict(state)

    def commit(self):
        try:
            if self.directory.exists():
                shutil.rmtree(self.directory)
                _sync_dir(self.root)
        finally:
            self.close()

    def rollback(self):
        try:
            if self.state is not None:
                self._restore(self.state)
            if self.directory.exists():
                shutil.rmtree(self.directory)
                _sync_dir(self.root)
        finally:
            self.close()

    def close(self):
        if not self.closed:
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            self.lock.close()
            self.closed = True


def read_mutable_file(file):
    """Return bytes for platform working blobs, None for ordinary attachments.

    File DB lock precedes filesystem lock, matching all writers. This also
    protects generic attachment downloads, not just the spreadsheet service.
    The generic File content hash resolves a crashed transaction; no business
    app is imported by the storage layer.
    """
    import re
    import frappe
    url = str(file.file_url or '')
    if not re.fullmatch(r'/private/files/ss-working-[a-f0-9]{64}\.xlsx', url):
        return None
    root = Path(frappe.get_site_path('private', 'files')).resolve()
    target = root / Path(url).name
    active = getattr(frappe.local, 'ss_workbook_transactions', None) or {}
    if any(txn.target == target for txn in active.values()):
        return target.read_bytes()  # same transaction already owns both locks
    fresh = frappe.get_doc('File', file.name, for_update=True)
    if fresh.file_url != url or not fresh.is_private:
        raise RuntimeError('Mutable file identity changed during read')
    committed_hash = str(fresh.content_hash or '').removeprefix('mutable:')
    txn = WorkingFileTransaction(target, root / '.ss-working-transactions', str(target))
    try:
        manifest = txn.directory / 'manifest.json'
        if manifest.exists():
            state = json.loads(manifest.read_text())
            if committed_hash == state.get('after_md5'):
                txn.recover(state['after_sha'])
            elif committed_hash == state.get('before_md5'):
                txn.recover(state['before_sha'])
            else:
                raise RuntimeError('Mutable file hash does not match recovery journal')
        elif txn.directory.exists():
            txn.recover('')  # preparation was interrupted before any replacement
        content = target.read_bytes()
        if hashlib.md5(content).hexdigest() != committed_hash:
            raise RuntimeError('Current file failed its committed content hash check')
        file.file_size, file.content_hash = len(content), fresh.content_hash
        return content
    finally:
        txn.close()

