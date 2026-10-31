"""Sorted visible positions always resolve stable row identities in the public writer."""
import unittest
import test_incremental_daily_write as daily


class TestTargets(unittest.TestCase):
    def setUp(self):
        self.case=daily.DailyEntries();self.case.setUp();self.addCleanup(self.case.doCleanups)
    def run_range(self,**extra):
        payload=self.case.payload(start_row=0,start_col=2,matrix=[['first'],['second']],target_row_ids=['r-000002','r-000001']) | extra
        return self.case.h['paste_apply'](payload)
    def test_sorted_range_keeps_original_ids_in_one_package(self):
        result=self.run_range();self.assertEqual(result['action_count'],1);self.assertEqual(len(self.case.saves),1)
        self.assertEqual([c['row_id'] for c in result['cells']],['r-000002','r-000001'])
        self.assertEqual(self.case.sheet()['C2'].value,'second');self.assertEqual(self.case.sheet()['C3'].value,'first')
    def test_unknown_identity_never_falls_back_to_visible_position(self):
        with self.assertRaises(ValueError):self.run_range(target_row_ids=['unknown','r-000001'])
        self.assertEqual(self.case.saves,[])
    def test_sorted_append_must_pass_structure_guard(self):
        self.case.h['_require_structure']=lambda *_:(_ for _ in ()).throw(ValueError('denied'))
        with self.assertRaisesRegex(ValueError,'denied'):
            self.run_range(target_row_ids=['r-000002',None],append_at_end=True)
        self.assertEqual(self.case.saves,[])

if __name__=='__main__':unittest.main(verbosity=2)
