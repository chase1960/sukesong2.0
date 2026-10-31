import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('recruitment_evidence_policy', Path(__file__).parents[1] / 'evidence_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class TestEvidencePolicy(unittest.TestCase):
    def setUp(self):
        self.criteria = policy.criteria_rows('["交付案例"]', '["带教经验"]')
        self.source = '😀完成交付；暂无带教说明'
        self.matrix = [{'criterion_id': 'c1', 'status': 'supported', 'citations': [{'start': 1, 'end': 5, 'quote': '完成交付'}], 'question': '核实实际贡献'},
                       {'criterion_id': 'c2', 'status': 'missing', 'citations': [], 'question': '是否有带教案例？'}]

    def test_unicode_citations_and_missing_are_distinct(self):
        self.assertEqual(policy.validate_matrix(self.criteria, self.source, self.matrix), self.matrix)

    def test_cannot_invent_quote_or_go_outside_source(self):
        for change in ({'quote': '领导交付'}, {'start': -1}, {'end': 999}, {'start': True}):
            rows = copy.deepcopy(self.matrix)
            rows[0]['citations'][0].update(change)
            with self.assertRaises(ValueError):
                policy.validate_matrix(self.criteria, self.source, rows)

    def test_missing_conflicting_and_duplicate_rows_fail_closed(self):
        variants = [self.matrix[:1], [self.matrix[0], self.matrix[0]],
                    [{**self.matrix[0], 'status': 'missing'}, self.matrix[1]],
                    [{**self.matrix[0], 'citations': []}, self.matrix[1]],
                    [self.matrix[0], {**self.matrix[1], 'question': ''}]]
        for rows in variants:
            with self.assertRaises(ValueError):
                policy.validate_matrix(self.criteria, self.source, rows)

    def test_same_length_changes_and_rule_versions_change_fingerprint(self):
        first = {'source': '完成交付', 'rules': [{'name': 'R1', 'version_no': 1}]}
        self.assertNotEqual(policy.fingerprint(first), policy.fingerprint({**first, 'source': '参与交付'}))
        self.assertNotEqual(policy.fingerprint(first), policy.fingerprint({**first, 'rules': [{'name': 'R1', 'version_no': 2}]}))
        self.assertEqual(policy.fingerprint(first), policy.fingerprint(dict(reversed(list(first.items())))))

    def test_snapshot_pins_material_application_and_standards(self):
        app = SimpleNamespace(name='A', revision=3)
        job = SimpleNamespace(name='J', revision=2, current_jd_revision='JD1')
        resume = SimpleNamespace(name='R', revision=4, file_reference='F', file_sha256='hash')
        rubric = SimpleNamespace(name='S1', revision=2)
        snapshot = policy.review_snapshot(app, job, resume, rubric, self.criteria, [])
        self.assertEqual(snapshot['resume_revision'], 4)
        self.assertEqual(snapshot['application_revision'], 3)
        self.assertEqual(snapshot['jd_revision'], 'JD1')


if __name__ == '__main__':
    unittest.main()
