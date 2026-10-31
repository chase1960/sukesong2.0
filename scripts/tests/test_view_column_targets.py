"""个人列序只映射显示坐标；原文件列序与未选中格保持，扩行仍一次提交。"""
import copy
import unittest
from test_incremental_daily_write import DailyEntries


class ViewColumnTargets(unittest.TestCase):
    def setUp(self):
        self.case = DailyEntries()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def test_single_input_uses_the_same_header_mapping(self):
        c = self.case
        c.h['input_write'](c.payload(start_row=0, start_col=0,
            target_headers=['备注'], value={'type': 'text', 'value': '0000123'}))
        self.assertEqual((c.sheet()['A2'].value, c.sheet()['C2'].value), ('00123', '0000123'))
        self.assertEqual(len(c.saves), 1)

    def test_public_schemas_declare_the_optional_mapping(self):
        from test_sheet_font_styles import run_domain
        from _f_module_seam import load_module_functions
        from types import SimpleNamespace
        validator = load_module_functions(__import__('pathlib').Path(__file__).resolve().parents[2] /
            'frappe_apps/shangshu_core/shangshu_core/schema_validation.py', {'_validate_schema'},
            stubs={'frappe': SimpleNamespace(ValidationError=ValueError,
                throw=lambda message, kind: (_ for _ in ()).throw(kind(message)))})['_validate_schema']
        import ast
        source = __import__('pathlib').Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files/promotion.py'
        constant = next(node.value for node in ast.parse(source.read_text()).body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'REVALIDATION_REASONS' for target in node.targets))
        self.case.promo.REVALIDATION_REASONS = ast.literal_eval(constant)
        actions = run_domain()['ACTIONS']
        for action in ('files.sheet_input_write', 'files.sheet_paste_apply'):
            schema = next(row[3] for row in actions if row[0] == action)
            payload = self.case.payload(start_row=0, start_col=4, target_headers=['备注', None])
            if action.endswith('input_write'):
                payload.update(target_headers=['备注'], value={'type':'text','value':'x'})
            else:
                payload.update(matrix=[['x','y']])
            validator(payload, schema)

    def test_existing_row_uses_explicit_headers_not_display_offsets(self):
        c = self.case
        c.h['paste_apply'](c.payload(start_row=0, start_col=0,
            target_row_ids=['r-000002'], target_headers=['备注', '编号'],
            matrix=[['中文新值', '00009']]))
        ws = c.sheet()
        self.assertEqual([ws.cell(1, i).value for i in range(1, 6)], ['编号', '金额', '备注', '日期', '确认'])
        self.assertEqual((ws['C3'].value, ws['A3'].value, ws['B3'].value), ('中文新值', '00009', 900))
        self.assertEqual(ws['C2'].value, 'old')
        self.assertEqual(len(c.saves), 1)

    def test_mixed_reordered_paste_and_new_row_share_one_atomic_plan(self):
        c = self.case
        c.enabled = True
        c.h['paste_apply'](c.payload(start_row=0, start_col=0,
            target_row_ids=['r-000002', None], target_headers=['备注', '金额', '编号'],
            matrix=[['已有行', 920, '00009'], ['新行\n格内第二行', 12, '00010']],
            matrix_types=[['text', 'number', 'text']] * 2))
        ws = c.sheet()
        self.assertEqual((ws['A3'].value, ws['B3'].value, ws['C3'].value), ('00009', 920, '已有行'))
        self.assertEqual((ws['A4'].value, ws['B4'].value, ws['C4'].value), ('00010', 12, '新行\n格内第二行'))
        self.assertEqual(c.formal['r-000002']['amount'], 920)
        self.assertEqual(c.formal[c.meta['rows'][-1]]['amount'], 12)
        self.assertEqual(len(c.saves), 1)

    def test_null_target_only_extends_a_new_tail_column(self):
        c = self.case
        c.h['paste_apply'](c.payload(start_row=0, start_col=4,
            target_headers=['备注', None], matrix=[['改备注', '新列值']]))
        ws = c.sheet()
        self.assertEqual((ws['C2'].value, ws['F2'].value, ws['E2'].value), ('改备注', '新列值', False))
        self.assertEqual(ws['F1'].value, '未命名6')

    def test_invalid_map_or_mixed_header_edit_has_zero_writes(self):
        for targets, extra in [(['备注', '备注'], {}), (['不存在'], {}), ([None], {}),
                               ([], {}), ('备注', {}), (['备注'], {'header_row': True})]:
            with self.subTest(targets=targets, extra=extra):
                c = self.case
                original = c.content
                meta = copy.deepcopy(c.meta)
                with self.assertRaises(ValueError):
                    c.h['paste_apply'](c.payload(start_row=0, start_col=0,
                        target_headers=targets, matrix=[['x']], **extra))
                self.assertEqual(c.content, original)
                self.assertEqual(c.meta, meta)
                self.assertEqual(c.saves, [])

    def test_bad_rule_in_reordered_new_row_rejects_entire_package(self):
        c = self.case
        c.enabled = True
        original = c.content
        with self.assertRaises(ValueError):
            c.h['paste_apply'](c.payload(start_row=0, start_col=0,
                target_row_ids=['r-000002', None], target_headers=['备注', '金额'],
                matrix=[['不应保存', 930], ['坏新行', -1]], matrix_types=[['text','number']] * 2))
        self.assertEqual(c.content, original)
        self.assertEqual(c.formal['r-000002']['amount'], 900)
        self.assertEqual(c.saves, [])


if __name__ == '__main__':
    unittest.main()
