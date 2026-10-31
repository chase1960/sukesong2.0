"""Date inputs use the production public entry and keep existing styles, including first dates."""
import datetime
import sys
import unittest
from io import BytesIO
from pathlib import Path
from openpyxl import load_workbook
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts/tests'))
import test_incremental_daily_write as daily


class FastDate(unittest.TestCase):
    def setUp(self):
        self.case = daily.DailyEntries(); self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def test_first_date_and_existing_date_preserve_styles_and_roundtrip(self):
        case = self.case
        for initial, style in ((None, 'General'), (datetime.date(2026, 10, 19), 'yyyy/mm/dd')):
            for raw in ('2026-10-20', '2026-10-20T12:34:56'):
                with self.subTest(initial=initial, raw=raw):
                    book = load_workbook(BytesIO(case.content)); book.active['D2'] = initial
                    book.active['D2'].number_format = style
                    out = BytesIO(); book.save(out); case.content = out.getvalue(); case.index()
                    case.h['write_cell'](case.payload(row_id='r-000001', header='日期', value={'type':'date','value':raw}))
                    actual = case.sheet()['D2']
                    self.assertEqual(str(actual.value)[:10], raw[:10]); self.assertEqual(actual.number_format, style)
                    # A cold native XML parse also recognizes ISO dates without consulting styles.
                    entry = case.h['_entry_fast'](case.content, None)
                    self.assertEqual(str(entry['rows_raw'][0][3])[:10], raw[:10])

    def test_invalid_date_is_zero_write(self):
        before = self.case.content
        with self.assertRaises(ValueError):
            self.case.h['write_cell'](self.case.payload(row_id='r-000001',header='日期',value={'type':'date','value':'not-a-date'}))
        self.assertEqual(self.case.content, before); self.assertEqual(self.case.saves, [])

if __name__ == '__main__': unittest.main(verbosity=2)
