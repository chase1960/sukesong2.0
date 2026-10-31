"""Package sources must not version or silently substitute another resource.

Runs the production package functions and production service.upload with an
in-memory persistence/identity boundary. Real SHA/Base64/version branching is
not mocked. Native file/transaction checks are a separate isolated-site test.
"""
import base64
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_file_unique_name import like_matches
from test_upload_workbook_validation import production_function


SERVICE = 'frappe_apps/shangshu_files/shangshu_files/service.py'
PACKAGES = 'frappe_apps/shangshu_files/shangshu_files/packages.py'


class Invalid(Exception):
    pass


class Duplicate(Exception):
    pass


class Row(dict):
    __setattr__ = dict.__setitem__

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None

    def insert(self, **_):
        self.name = 'file-%03d' % (len(self._database) + 1)
        self._database[self.name] = self
        return self

    def save(self, **_):
        return self


class PackageFileIdentity(unittest.TestCase):
    def setUp(self):
        self.rows = {}
        self.requests = {}
        self.actor = 'original-user'
        self.failure = None
        self.upload_calls = []

        def reject(message, kind=Invalid):
            raise kind(message)

        def lookup(_doctype, filters, fields, **_):
            for row in self.rows.values():
                if all(row.get(key) == value for key, value in filters.items()):
                    if isinstance(fields, str):
                        return row.get(fields)
                    return Row({key: row.get(key) for key in fields})
            return None

        def get_all(_doctype, *, filters, fields, **_):
            return [{field: row.get(field) for field in fields} for row in self.rows.values()
                    if all(like_matches(row.get(key, ''), value[1])
                           if isinstance(value, (tuple, list)) and value[0] == 'like'
                           else row.get(key) == value for key, value in filters.items())]

        def get_doc(values):
            row = Row(values)
            object.__setattr__(row, '_database', self.rows)
            return row

        self.frappe = SimpleNamespace(throw=reject, ValidationError=Invalid,
            DuplicateEntryError=Duplicate,
            db=SimpleNamespace(get_value=lookup), get_doc=get_doc, get_all=get_all)
        self.service_env = dict(frappe=self.frappe, os=os, base64=base64, hashlib=hashlib,
            DOCTYPE='Shangshu File Center File', MAX_FILE_BYTES=20 * 1024 * 1024,
            directories=SimpleNamespace(resolve=lambda payload: Row(path=payload['directory'], name='dir')),
            _safe_name=lambda value: value, _writable=lambda name: self.rows[name],
            _require_attribution=lambda *a: None, _apply_attribution=lambda *a: None,
            _attribution_of=lambda *a: None, _dump=json.dumps,
            _normalize_tags=lambda value: value or [])
        for name in ('_read_content', '_unique_sheet_name'):
            production_function(SERVICE, name, self.service_env)
        self.service_env['_append_version'] = self.append_version
        self.upload = production_function(SERVICE, 'upload', self.service_env)
        self.package_env = dict(frappe=self.frappe, hashlib=hashlib)
        available = {node.name for node in ast.parse((Path(__file__).resolve().parents[2] / PACKAGES).read_text()).body
                     if isinstance(node, ast.FunctionDef)}
        for name in ('_fail', '_safe_member_name', '_member_key', '_existing_stored',
                     '_upload', 'store_package'):
            if name in available:
                production_function(PACKAGES, name, self.package_env)
        self.modules = patch.dict(sys.modules, {
            'shangshu_core.public_api': SimpleNamespace(execute_registered_action=self.execute),
            'shangshu_files.service': SimpleNamespace(DOCTYPE='Shangshu File Center File'),
        })
        self.modules.start()
        self.addCleanup(self.modules.stop)

    @staticmethod
    def digest(content):
        return hashlib.sha256(content).hexdigest()

    def append_version(self, row, content, digest, *_args, **_kwargs):
        version = int(row.get('version_count') or 1)
        row.update(current_sha256=digest, current_size=len(content), content=content,
                   version_count=version + 1)
        return version

    def execute(self, action, payload, *, idempotency_key, **_):
        self.assertEqual(action, 'files.upload')
        self.upload_calls.append(copy.deepcopy(payload))
        if self.failure is not None:
            raise self.failure
        prior = self.requests.get(idempotency_key)
        if prior:
            if prior['actor'] != self.actor or prior['payload'] != payload:
                raise Duplicate('请求作用域或业务内容不符')
            return {**copy.deepcopy(prior['outcome']), 'idempotent': True}
        outcome = {'result': self.upload(payload), 'idempotent': False}
        self.requests[idempotency_key] = {'actor': self.actor,
            'payload': copy.deepcopy(payload), 'outcome': copy.deepcopy(outcome)}
        return outcome

    def legacy(self, content=b'<list>A</list>', source='a' * 64):
        digest = self.digest(content)
        key = self.package_env['_member_key'](source, 'list.xml', digest)
        payload = {'file_name': 'list.xml', 'content_base64': base64.b64encode(content).decode(),
            'attribution': {'level': 'personal'}, 'directory': '/isolated/identity',
            'note': 'package-test', 'container_sha256': source}
        if digest:
            payload['file_sha256'] = digest
        first = self.execute('files.upload', payload, idempotency_key=key)
        return key, payload, first['result']['file']

    def member(self, content, source, *, name='list.xml', path=None, attribution=None):
        digest = self.digest(content)
        key = self.package_env['_member_key'](source, path or name, digest)
        return self.package_env['_upload'](name, base64.b64encode(content).decode(), digest,
            '/isolated/identity', source, key, 'package-test', attribution or {'level': 'personal'})

    def test_same_basename_in_different_packages_does_not_advance_old_resource(self):
        first = self.member(b'<list>A</list>', 'a' * 64)
        old = copy.deepcopy(dict(self.rows[first['file']]))
        second = self.member(b'<list>B</list>', 'b' * 64)
        self.assertNotEqual(first['file'], second['file'])
        self.assertEqual(self.rows[first['file']]['content'], old['content'])
        self.assertEqual(self.rows[first['file']]['version_count'], old['version_count'])
        self.assertEqual(self.rows[first['file']]['container_sha256'], 'a' * 64)

    def test_same_basename_under_two_member_paths_has_independent_resources(self):
        first = self.member(b'<list>A</list>', 'c' * 64, path='A/list.xml')
        second = self.member(b'<list>B</list>', 'c' * 64, path='B/list.xml')
        self.assertNotEqual(first['file'], second['file'])
        self.assertEqual(self.rows[first['file']]['content'], b'<list>A</list>')

    def test_equal_bytes_from_distinct_sources_keep_separate_lineage(self):
        first = self.member(b'<list>same</list>', 'a' * 64)
        second = self.member(b'<list>same</list>', 'b' * 64)
        self.assertNotEqual(first['file'], second['file'])
        self.assertEqual(self.rows[first['file']]['container_sha256'], 'a' * 64)
        self.assertEqual(self.rows[second['file']]['container_sha256'], 'b' * 64)

    def test_equal_bytes_at_different_member_paths_do_not_collapse_occurrences(self):
        first = self.member(b'<list>same</list>', 'c' * 64, path='A/list.xml')
        second = self.member(b'<list>same</list>', 'c' * 64, path='B/list.xml')
        self.assertNotEqual(first['file'], second['file'])

    def test_same_source_retry_replays_without_an_extra_resource_or_version(self):
        first = self.member(b'<list>A</list>', 'a' * 64, path='A/list.xml')
        before = copy.deepcopy(self.rows)
        again = self.member(b'<list>A</list>', 'a' * 64, path='A/list.xml')
        self.assertEqual(again['file'], first['file'])
        self.assertEqual(self.rows, before)
        self.assertEqual(len(self.requests), 1)

    def test_same_key_wrong_payload_is_not_replaced_by_a_basename_lookup(self):
        self.member(b'<list>A</list>', 'a' * 64)
        before = copy.deepcopy(self.rows)
        error = Duplicate('业务内容已变化，请用新的操作号')
        self.failure = error
        with self.assertRaises(Duplicate) as caught:
            self.member(b'<list>A</list>', 'a' * 64)
        self.assertIs(caught.exception, error)
        self.assertEqual(self.rows, before)

    def test_another_actor_cannot_replay_a_private_source_through_fallback(self):
        self.member(b'<list>A</list>', 'a' * 64)
        before = copy.deepcopy(self.rows)
        self.actor = 'another-user'
        with self.assertRaises(Duplicate):
            self.member(b'<list>A</list>', 'a' * 64)
        self.assertEqual(self.rows, before)

    def test_old_payload_conflict_is_returned_without_a_second_execute_or_new_resource(self):
        key, payload, _file = self.legacy()
        before = copy.deepcopy(self.rows)
        calls = len(self.upload_calls)
        with self.assertRaises(Duplicate):
            self.package_env['_upload']('list.xml', payload['content_base64'], payload['file_sha256'],
                payload['directory'], payload['container_sha256'], key, payload['note'], payload['attribution'])
        self.assertEqual(len(self.upload_calls), calls + 1)
        self.assertEqual(self.rows, before)
        self.assertEqual(len(self.requests), 1)

    def test_old_identical_members_merged_under_two_paths_are_explicitly_rejected(self):
        content, source = b'<list>identical</list>', 'c' * 64
        digest = self.digest(content)
        _unused, payload, _file = self.legacy(content, source)
        first_key = self.package_env['_member_key'](source, 'A/list.xml', digest)
        second_key = self.package_env['_member_key'](source, 'B/list.xml', digest)
        one = self.execute('files.upload', payload, idempotency_key=first_key)
        two = self.execute('files.upload', payload, idempotency_key=second_key)
        self.assertEqual(one['result']['file'], two['result']['file'])  # The historical ambiguity.
        before = copy.deepcopy(self.rows)
        for path in ('A/list.xml', 'B/list.xml'):
            with self.subTest(path=path), self.assertRaises(Duplicate):
                self.member(content, source, path=path)
        self.assertEqual(self.rows, before)

    def test_conflicting_container_sha_declarations_create_nothing(self):
        with self.assertRaisesRegex(Invalid, '来源摘要不一致'):
            self.package_env['store_package']({'container_sha256': 'a' * 64,
                'directory': '/isolated/identity', 'container': {'content_base64': 'ZmlsZQ==',
                    'file_sha256': 'b' * 64}, 'members': []})
        self.assertEqual(self.rows, {})
        self.assertEqual(self.upload_calls, [])

    def test_sha_is_validated_by_existing_upload_before_resource_insert(self):
        before = copy.deepcopy(self.rows)
        with self.assertRaisesRegex(Invalid, '摘要校验失败'):
            self.package_env['_upload']('bad.xml', base64.b64encode(b'<list>A</list>').decode(),
                '0' * 64, '/isolated/identity', 'a' * 64, 'bad-sha', 'test', {'level': 'personal'})
        self.assertEqual(self.rows, before)

    def test_ordinary_unspecified_upload_keeps_existing_same_bytes_dedupe(self):
        payload = {'file_name': 'normal.xml', 'content_base64': base64.b64encode(b'<list>A</list>').decode(),
                   'directory': '/ordinary', 'attribution': {'level': 'personal'}}
        first = self.upload(payload)
        second = self.upload({**payload, 'file_name': 'another.xml'})
        self.assertEqual(first['file'], second['file'])
        self.assertEqual(len(self.rows), 1)


if __name__ == '__main__':
    unittest.main()
