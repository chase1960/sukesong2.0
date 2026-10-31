"""Run the production migration against bounded database/document collaborators."""
import contextlib
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from _f_module_seam import install_real_environment

install_real_environment('shangshu_core')
from shangshu_core import record_lifecycle as lifecycle


class LifecycleMigration(unittest.TestCase):
    def run_migration(self, models, applications, documents):
        db=SimpleNamespace(transaction_writes=0,exists=Mock(side_effect=lambda kind,name: name in applications if kind=='Shangshu Application Definition' else False),updatedb=Mock(),commit=Mock())
        def get_doc(kind,name):
            if name not in documents:raise LookupError('DocType missing: '+name)
            return documents[name]
        def fail(message,error=None):raise ValueError(message)
        logger=Mock();stdout=io.StringIO()
        fake=SimpleNamespace(db=db,flags=SimpleNamespace(),get_all=Mock(return_value=models),get_doc=Mock(side_effect=get_doc),throw=fail,ValidationError=ValueError,logger=Mock(return_value=logger),clear_cache=Mock())
        with patch.object(lifecycle,'frappe',fake),contextlib.redirect_stdout(stdout):
            result=lifecycle.migrate_record_lifecycle()
        return result,fake,logger,stdout.getvalue()

    @staticmethod
    def model(name='valid',application='app',doctype='SSM valid'):
        return SimpleNamespace(name=name,application=application,physical_doctype=doctype,active_json=json.dumps({'kind':'record'}))

    @staticmethod
    def document():
        doc=SimpleNamespace(name='SSM valid',custom=1,module='Shangshu Core',fields=[])
        doc.append=Mock(side_effect=lambda kind,field:doc.fields.append(SimpleNamespace(**field)))
        doc.save=Mock()
        return doc

    def test_orphan_skip_has_evidence_and_valid_model_still_migrates(self):
        doc=self.document();orphan=self.model('orphan','gone','SSM orphan')
        result,fake,logger,output=self.run_migration([orphan,self.model()],{'app'},{'SSM valid':doc})
        fake.get_doc.assert_called_once_with('DocType','SSM valid')
        fake.db.updatedb.assert_called_once_with('SSM valid');doc.save.assert_called_once_with(ignore_permissions=True)
        self.assertEqual({f.fieldname for f in doc.fields},{f['fieldname'] for f in lifecycle.FIELDS})
        self.assertEqual(result['migrated'],['valid']);self.assertEqual(result['skipped'][0]['model'],'orphan')
        self.assertEqual(result['skipped'][0]['reason'],'missing_parent_application')
        logger.warning.assert_called_once();self.assertIn('orphan',output);self.assertIn('SSM orphan',output)
        self.assertIn('application',fake.get_all.call_args.kwargs['fields']);self.assertIn('name',fake.get_all.call_args.kwargs['fields'])

    def test_orphan_with_metadata_is_not_modified_either(self):
        doc=self.document();result,fake,_,_=self.run_migration([self.model(application='gone')],set(),{'SSM valid':doc})
        fake.get_doc.assert_not_called();fake.db.updatedb.assert_not_called();fake.db.commit.assert_not_called();doc.save.assert_not_called()
        self.assertEqual(len(result['skipped']),1)

    def test_existing_parent_with_missing_doctype_still_fails(self):
        with self.assertRaisesRegex(LookupError,'DocType missing'):
            self.run_migration([self.model()],{'app'},{})

    def test_absent_parent_id_is_not_evidence_of_deleted_application(self):
        with self.assertRaisesRegex(ValueError,'归属应用'):
            self.run_migration([self.model(application='')],set(),{})

    def test_existing_model_field_conflict_still_fails(self):
        doc=self.document();doc.fields=[SimpleNamespace(fieldname='ss_recycled',fieldtype='Data')]
        with self.assertRaisesRegex(ValueError,'冲突'):
            self.run_migration([self.model()],{'app'},{'SSM valid':doc})
        doc.save.assert_not_called()

if __name__=='__main__':unittest.main()
