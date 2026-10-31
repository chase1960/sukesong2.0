"""Same-name allocation reads only one constrained file-name projection."""
import os
import re
from types import SimpleNamespace
import unittest

from test_upload_workbook_validation import production_function


class Invalid(Exception):
    pass


def like_matches(value, pattern):
    pieces, offset = [], 0
    while offset < len(pattern):
        char = pattern[offset]
        if char == '\\' and offset + 1 < len(pattern):
            offset += 1
            pieces.append(re.escape(pattern[offset]))
        else:
            pieces.append('.*' if char == '%' else '.' if char == '_' else re.escape(char))
        offset += 1
    return re.fullmatch(''.join(pieces), value, flags=re.IGNORECASE) is not None


class FileUniqueName(unittest.TestCase):
    def setUp(self):
        self.rows, self.queries = [], []

        def selected(filters):
            def matches(row):
                for key, value in filters.items():
                    if isinstance(value, (tuple, list)) and value[0] == 'like':
                        if not like_matches(row[key], value[1]):
                            return False
                    elif str(row[key]).lower() != str(value).lower():
                        return False
                return True
            return [row for row in self.rows if matches(row)]

        def get_all(doctype, *, filters, fields, **kwargs):
            self.queries.append(('get_all', doctype, filters, fields, kwargs))
            return [{field: row[field] for field in fields} for row in selected(filters)]

        def get_value(doctype, filters, field):
            self.queries.append(('get_value', doctype, filters, field, {}))
            values = selected(filters)
            return values[0][field] if values else None

        def reject(message, kind=Invalid):
            raise kind(message)

        fake = SimpleNamespace(get_all=get_all, db=SimpleNamespace(get_value=get_value),
                               throw=reject, ValidationError=Invalid)
        self.allocate = production_function('frappe_apps/shangshu_files/shangshu_files/service.py',
            '_unique_sheet_name', {'frappe': fake, 'os': os, 'DOCTYPE': 'Shangshu File Center File'})

    def add(self, name, directory='/same-source', status='Active'):
        self.rows.append({'name': str(len(self.rows)), 'file_name': name,
                          'directory': directory, 'status': status})

    def assert_one_projection(self):
        self.assertEqual(len(self.queries), 1)
        kind, doctype, filters, fields, options = self.queries[0]
        self.assertEqual(kind, 'get_all')
        self.assertEqual(doctype, 'Shangshu File Center File')
        self.assertEqual(fields, ['file_name'])
        self.assertEqual(filters['directory'], '/same-source')
        self.assertEqual(filters['status'], 'Active')
        self.assertEqual(options.get('limit_page_length'), 0)

    def test_more_than_one_hundred_names_have_no_artificial_cap(self):
        self.add('list.xml')
        for number in range(2, 102):
            self.add('list (%d).xml' % number)
        self.assertEqual(self.allocate('/same-source', 'list.xml'), 'list (102).xml')
        self.assert_one_projection()

    def test_first_gap_is_reused_without_a_query_per_candidate(self):
        for name in ('list.xml', 'list (2).xml', 'list (3).xml', 'list (5).xml'):
            self.add(name)
        self.assertEqual(self.allocate('/same-source', 'list.xml'), 'list (4).xml')
        self.assert_one_projection()

    def test_filename_wildcards_are_literal_and_other_locations_are_excluded(self):
        self.add('a%_[] (2).xml')
        self.add('aZZz[] (3).xml')
        self.add('a%_[] (3).xml', directory='/another-source')
        self.add('a%_[] (3).xml', status='Recycled')
        self.assertEqual(self.allocate('/same-source', 'a%_[].xml'), 'a%_[] (3).xml')
        self.assert_one_projection()
        pattern = self.queries[0][2]['file_name'][1]
        self.assertIn('\\%', pattern)
        self.assertIn('\\_', pattern)

    def test_only_strict_ascii_numeric_suffixes_reserve_a_number(self):
        for name in ('list (02).xml', 'list (+2).xml', 'list (٢).xml',
                     'list (note (2).xml', 'list (2) backup.xml', 'list (0).xml'):
            self.add(name)
        self.assertEqual(self.allocate('/same-source', 'list.xml'), 'list (2).xml')
        self.assert_one_projection()

    def test_database_case_insensitive_matches_still_reserve_the_number(self):
        self.add('LIST (2).XML')
        self.add('List (3).Xml')
        self.assertEqual(self.allocate('/same-source', 'list.xml'), 'list (4).xml')
        self.assert_one_projection()


if __name__ == '__main__':
    unittest.main()
