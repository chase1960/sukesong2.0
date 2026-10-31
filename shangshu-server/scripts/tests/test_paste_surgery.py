"""Public range-paste regressions. All inputs use the same ZIP path, without legacy fallback."""
import sys
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts/tests'))
import test_incremental_daily_write as daily


class PasteRegression(unittest.TestCase):
    def setUp(self):
        self.case = daily.DailyEntries(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
    def paste(self, **kw):
        return self.case.h['paste_apply'](self.case.payload(start_row=0,start_col=2,matrix=[['中文']],**kw))

    def test_existing_range_one_package_preserves_all_other_parts(self):
        case = self.case; before = case.content
        result = self.paste()
        self.assertEqual(result['action_count'],1); self.assertEqual(result['rows_added'],0)
        self.assertEqual(len(case.saves),1); self.assertEqual(case.logs[0].action_id,'files.sheet_paste_apply')
        with zipfile.ZipFile(BytesIO(before)) as old, zipfile.ZipFile(BytesIO(case.content)) as new:
            for name in old.namelist():
                if name != daily.PART: self.assertEqual(old.read(name),new.read(name),name)
        self.assertEqual(case.sheet()['C2'].value,'中文'); self.assertEqual(case.sheet()['A2'].value,'00123')

    def test_missing_op_and_formula_are_zero_write(self):
        case = self.case
        for changes in ({'op_id':''},{'matrix':[['=1+1']], 'matrix_types':[['formula']]}):
            with self.assertRaises(ValueError):
                case.h['paste_apply'](case.payload(start_row=0,start_col=2,matrix=[['valid']]) | changes)
            self.assertEqual(case.saves,[]); self.assertEqual(case.logs,[])

    def test_last_of_fifty_cells_illegal_is_zero_write(self):
        case = self.case
        for invalid in ('x'*32768,):
            matrix = [['ok']*5 for _ in range(10)]; matrix[-1][-1]=invalid
            with self.assertRaises(ValueError):
                case.h['paste_apply'](case.payload(start_row=2,start_col=5,matrix=matrix))
            self.assertEqual(case.saves,[]); self.assertEqual(len(case.meta['rows']),2)

    def test_expansion_and_header_paste_use_same_path(self):
        case = self.case
        result = case.h['paste_apply'](case.payload(start_row=2,start_col=5,header_row=True,matrix=[['新列'],['value']]))
        self.assertEqual(result['rows_added'],1); self.assertEqual(result['cols_added'],1)
        self.assertEqual(case.sheet()['F1'].value,'新列'); self.assertEqual(case.sheet()['F4'].value,'value')
        self.assertEqual(len(case.saves),1)

    def test_stale_version_and_invalid_later_cell_are_zero_write(self):
        case=self.case
        for updates in ({'expected_content_version':99}, {'matrix':[['ok','nan']],'matrix_types':[['text','number']]}):
            payload=case.payload(start_row=0,start_col=2,matrix=[['valid']]) | updates
            with self.assertRaises(ValueError):case.h['paste_apply'](payload)
            self.assertEqual(case.saves,[]); self.assertEqual(case.logs,[])

if __name__ == '__main__':unittest.main(verbosity=2)
