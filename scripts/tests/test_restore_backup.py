import gzip,importlib.util,tempfile,unittest
from pathlib import Path


class TestRestoreBackup(unittest.TestCase):
    def test_only_trigger_definer_changes_and_source_is_preserved(self):
        path=Path(__file__).resolve().parents[1]/'prepare_restore_backup.py'
        spec=importlib.util.spec_from_file_location('prepare_restore_backup',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        original='/*!50003 CREATE*/ /*!50017 DEFINER=`old_user`@`localhost`*/ /*!50003 trigger `guard` before UPDATE on `ledger`\nSIGNAL SQLSTATE \'45000\';\n*/;\nINSERT INTO example VALUES (\'DEFINER=ordinary text\');\n'
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.sql.gz';target=Path(directory)/'restore.sql.gz'
            with gzip.open(source,'wt') as stream:stream.write(original)
            self.assertEqual(module.prepare(source,target),1)
            with gzip.open(source,'rt') as stream:self.assertEqual(stream.read(),original)
            with gzip.open(target,'rt') as stream:result=stream.read()
            self.assertNotIn('old_user',result)
            self.assertIn("SIGNAL SQLSTATE '45000'",result)
            self.assertIn('DEFINER=ordinary text',result)
            with self.assertRaises(FileExistsError):module.prepare(source,target)
            with self.assertRaises(ValueError):module.prepare(source,source)

if __name__=='__main__':unittest.main()
