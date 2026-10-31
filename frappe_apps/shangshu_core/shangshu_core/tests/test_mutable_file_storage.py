"""Filesystem/transaction contract, no live site or synthetic business data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('mutable_files_under_test',
    Path(__file__).resolve().parents[1] / 'mutable_files.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
sha = lambda value: hashlib.sha256(value).hexdigest()
json_load = lambda path: json.loads(path.read_text())


class MutableFileStorageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.target = self.root / 'same-workbook.xlsx'
        self.journal = self.root / 'transactions'

    def transaction(self):
        txn = storage.WorkingFileTransaction(self.target, self.journal, str(self.target))
        self.addCleanup(txn.close)
        return txn

    def test_continuous_edits_keep_one_path_without_history(self):
        self.target.write_bytes(b'old')
        for before, after in [(b'old', b'first'), (b'first', b'second')]:
            txn = self.transaction()
            txn.stage(after, sha(before))
            txn.commit()
            self.assertEqual(self.target.read_bytes(), after)
            self.assertFalse(any(self.journal.glob('*.pending')))
        self.assertEqual([p.name for p in self.root.glob('*.xlsx')], [self.target.name])

    def test_rollback_restores_exact_bytes(self):
        self.target.write_bytes(b'original\x00bytes')
        txn = self.transaction()
        txn.stage(b'changed', sha(b'original\x00bytes'))
        txn.rollback()
        self.assertEqual(self.target.read_bytes(), b'original\x00bytes')
        self.assertFalse(txn.directory.exists())

    def test_failed_first_package_restores_file_without_closing_outer_transaction(self):
        self.target.write_bytes(b'old')
        txn = self.transaction()
        checkpoint = txn.checkpoint()
        self.assertIsNone(checkpoint)
        txn.stage(b'failed package', sha(b'old'))
        txn.restore_checkpoint(checkpoint)
        self.assertEqual(self.target.read_bytes(), b'old')
        self.assertFalse(txn.closed)
        self.assertFalse(txn.directory.exists())
        txn.stage(b'next package', sha(b'old'))
        txn.commit()
        self.assertEqual(self.target.read_bytes(), b'next package')

    def test_failed_second_package_preserves_first_and_outer_rollback_still_works(self):
        self.target.write_bytes(b'original')
        txn = self.transaction()
        txn.stage(b'first', sha(b'original'))
        checkpoint = txn.checkpoint()
        txn.stage(b'second', sha(b'first'))
        txn.restore_checkpoint(checkpoint)
        self.assertEqual(self.target.read_bytes(), b'first')
        self.assertEqual(json_load(txn.directory / 'manifest.json')['after_sha'], sha(b'first'))
        txn.rollback()
        self.assertEqual(self.target.read_bytes(), b'original')

    def test_failed_second_package_then_outer_commit_keeps_first(self):
        self.target.write_bytes(b'original')
        txn = self.transaction()
        txn.stage(b'first', sha(b'original'))
        checkpoint = txn.checkpoint()
        txn.stage(b'second', sha(b'first'))
        txn.restore_checkpoint(checkpoint)
        txn.commit()
        self.assertEqual(self.target.read_bytes(), b'first')

    def test_failed_new_working_file_package_removes_uncommitted_file(self):
        txn = self.transaction()
        checkpoint = txn.checkpoint()
        txn.stage(b'new', sha(b'legacy file elsewhere'))
        txn.restore_checkpoint(checkpoint)
        txn.commit()
        self.assertFalse(self.target.exists())

    def test_crash_before_database_commit_restores_old_file(self):
        self.target.write_bytes(b'old')
        txn = self.transaction()
        txn.stage(b'new', sha(b'old'))
        txn.close()  # simulates process death: callbacks never ran
        recovered = self.transaction()
        recovered.recover(sha(b'old'))
        self.assertEqual(self.target.read_bytes(), b'old')
        self.assertFalse(recovered.directory.exists())

    def test_crash_after_database_commit_keeps_new_file(self):
        self.target.write_bytes(b'old')
        txn = self.transaction()
        txn.stage(b'new', sha(b'old'))
        txn.close()
        recovered = self.transaction()
        recovered.recover(sha(b'new'))
        self.assertEqual(self.target.read_bytes(), b'new')
        self.assertFalse(recovered.directory.exists())

    def test_first_migration_rollback_does_not_leave_working_copy(self):
        txn = self.transaction()
        txn.stage(b'new', sha(b'immutable original elsewhere'))
        txn.rollback()
        self.assertFalse(self.target.exists())

    def test_unrelated_committed_sha_fails_closed_and_keeps_recovery(self):
        self.target.write_bytes(b'old')
        txn = self.transaction()
        txn.stage(b'new', sha(b'old'))
        txn.close()
        recovered = self.transaction()
        with self.assertRaisesRegex(RuntimeError, 'matching committed SHA'):
            recovered.recover(sha(b'unrelated'))
        self.assertTrue(recovered.directory.exists())

    def test_nested_writes_rollback_to_transaction_start(self):
        self.target.write_bytes(b'old')
        txn = self.transaction()
        txn.stage(b'first', sha(b'old'))
        txn.stage(b'second', sha(b'first'))
        txn.rollback()
        self.assertEqual(self.target.read_bytes(), b'old')

    def test_stale_writer_cannot_overwrite_current_file(self):
        self.target.write_bytes(b'current')
        txn = self.transaction()
        with self.assertRaisesRegex(RuntimeError, 'changed before save'):
            txn.stage(b'wrong', sha(b'stale'))
        self.assertEqual(self.target.read_bytes(), b'current')

    def test_corrupt_committed_workbook_is_not_accepted(self):
        self.target.write_bytes(b'old')
        txn = self.transaction()
        txn.stage(b'new', sha(b'old'))
        txn.close()
        self.target.write_bytes(b'corrupt')
        recovered = self.transaction()
        with self.assertRaisesRegex(RuntimeError, 'do not match'):
            recovered.recover(sha(b'new'))
        self.assertTrue(recovered.directory.exists())


if __name__ == '__main__':
    unittest.main()
