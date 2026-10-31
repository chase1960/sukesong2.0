"""Package resource identity through the real public action and storage path.

Only self-created test directories, ZIP/XML bytes and existing action schemas.
No real client data or outgoing mail. The test runner must use an isolated site.
"""
import base64
import hashlib
from io import BytesIO
import uuid
import zipfile
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core.public_api import execute_registered_action, invoke_domain_service
from shangshu_files import packages
from shangshu_files.events import package_stored_idempotency_key


class TestPackageFileIdentity(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.token = uuid.uuid4().hex
        self.directory = '/tests/package-identity/' + self.token
        self.seq = 0

    def payload(self, entries, source):
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.comment = (self.token + '-' + source).encode()
            for name, content in entries:
                archive.writestr(name, content)
        content = buffer.getvalue()
        return {'container_sha256': hashlib.sha256(content).hexdigest(),
            'directory': self.directory, 'attribution': {'level': 'personal'},
            'container': {'file_name': 'source.zip',
                          'content_base64': base64.b64encode(content).decode(),
                          'file_sha256': hashlib.sha256(content).hexdigest()},
            'members': [{'name': name, 'kind': 'list', 'sha256': hashlib.sha256(data).hexdigest(),
                         'size_bytes': len(data), 'content_base64': base64.b64encode(data).decode()}
                        for name, data in entries]}

    def act(self, payload, key=None):
        self.seq += 1
        return execute_registered_action('files.package.store', payload, confirmed=True,
            idempotency_key=key or 'package-identity-' + self.token + '-' + str(self.seq))['result']

    @staticmethod
    def content(file_id):
        return base64.b64decode(invoke_domain_service('files.content', {'file': file_id})['content_base64'])

    def rows(self):
        return frappe.get_all('Shangshu File Center File',
            filters={'directory': self.directory, 'status': 'Active'},
            fields=['name', 'current_sha256', 'container_sha256', 'version_count'],
            order_by='name asc', limit_page_length=0)

    @staticmethod
    def legacy_upload(file_name, content_base64, digest, directory, container_sha256,
                      idempotency_key, note, attribution):
        """历史成功请求夹具：复刻旧载荷，仍经原公共动作写入。"""
        payload = {'file_name': file_name, 'content_base64': content_base64,
            'attribution': dict(attribution or {}), 'directory': directory, 'note': note}
        if digest:
            payload['file_sha256'] = digest
        if container_sha256:
            payload['container_sha256'] = container_sha256
        result = execute_registered_action('files.upload', payload, confirmed=True,
            idempotency_key=idempotency_key, source='user')['result']
        return {'file': result['file'], 'sha256': digest, 'size_bytes': 0,
                'created': int(result.get('created') or 0)}

    def seed_old_package(self, payload, key=None):
        with patch.object(packages, '_upload', self.legacy_upload):
            return self.act(payload, key)

    def test_two_packages_same_name_preserve_the_original_resource_and_bytes(self):
        original = b'<list>original</list>'
        changed = b'<list>changed</list>'
        first = self.act(self.payload([('folder/list.xml', original)], 'a'))
        second = self.act(self.payload([('folder/list.xml', changed)], 'b'))
        self.assertNotEqual(first['container']['file'], second['container']['file'])
        self.assertNotEqual(first['members'][0]['file'], second['members'][0]['file'])
        self.assertEqual(self.content(first['members'][0]['file']), original)
        self.assertEqual(self.content(second['members'][0]['file']), changed)
        self.assertEqual(len(self.rows()), 4)
        self.assertTrue(all(row.version_count == 2 for row in self.rows()))

    def test_same_basename_in_different_package_paths_keeps_each_member(self):
        result = self.act(self.payload([('A/list.xml', b'<list>A</list>'),
                                        ('B/list.xml', b'<list>B</list>')], 'folders'))
        first, second = result['members']
        self.assertEqual([first['name'], second['name']], ['A/list.xml', 'B/list.xml'])
        self.assertNotEqual(first['file'], second['file'])
        self.assertEqual(self.content(first['file']), b'<list>A</list>')
        self.assertEqual(self.content(second['file']), b'<list>B</list>')

    def test_equal_member_bytes_from_two_packages_keep_both_source_identities(self):
        data = b'<list>same-bytes</list>'
        one = self.payload([('list.xml', data)], 'a')
        two = self.payload([('list.xml', data)], 'b')
        first, second = self.act(one), self.act(two)
        self.assertNotEqual(first['members'][0]['file'], second['members'][0]['file'])
        rows = {row.name: row for row in self.rows()}
        self.assertEqual(rows[first['members'][0]['file']].container_sha256, one['container_sha256'])
        self.assertEqual(rows[second['members'][0]['file']].container_sha256, two['container_sha256'])
        self.assertEqual(self.content(first['members'][0]['file']), data)
        self.assertEqual(self.content(second['members'][0]['file']), data)

    def test_equal_member_bytes_under_two_paths_do_not_merge_occurrences(self):
        data = b'<list>same-bytes</list>'
        result = self.act(self.payload([('A/list.xml', data), ('B/list.xml', data)], 'same-path-bytes'))
        self.assertNotEqual(result['members'][0]['file'], result['members'][1]['file'])
        self.assertEqual(len(self.rows()), 3)

    def test_root_and_source_retries_create_no_extra_resource_or_event(self):
        payload = self.payload([('A/list.xml', b'<list>A</list>')], 'retry')
        key = 'package-root-replay-' + self.token
        first = self.act(payload, key)
        before = self.rows()
        again = self.act(payload, key)
        # A fresh root request still uses the original member keys.
        third = self.act(payload)
        self.assertEqual(again['members'], first['members'])
        self.assertEqual(third['members'], first['members'])
        self.assertEqual(self.rows(), before)
        self.assertEqual(frappe.db.count('Shangshu Event Envelope', {
            'event_id': 'files.package.stored',
            'idempotency_key': package_stored_idempotency_key(payload['container_sha256'])}), 1)

    def test_old_successful_root_replay_does_not_reenter_the_handler(self):
        payload = self.payload([('A/list.xml', b'<list>old-root</list>')], 'legacy-root')
        key = 'old-package-root-' + self.token
        first = self.seed_old_package(payload, key)
        before = self.rows()
        with patch.object(packages, 'store_package', side_effect=AssertionError('must use cached root')):
            second = self.act(payload, key)
        self.assertEqual(first, second)
        self.assertEqual(self.rows(), before)

    def test_old_child_payload_conflicts_under_a_fresh_root_without_new_resources(self):
        payload = self.payload([('A/list.xml', b'<list>old-source</list>')], 'legacy-children')
        self.seed_old_package(payload)
        before = self.rows()
        with self.assertRaises(frappe.DuplicateEntryError):
            self.act(payload)
        self.assertEqual(self.rows(), before)

    def test_old_container_payload_conflict_is_not_retried_or_rebuilt(self):
        payload = self.payload([], 'legacy-container-only')
        self.seed_old_package(payload)
        before = self.rows()
        with self.assertRaises(frappe.DuplicateEntryError):
            self.act(payload)
        self.assertEqual(self.rows(), before)

    def test_old_equal_bytes_under_two_paths_are_not_accepted_as_separate_resources(self):
        content = b'<list>same-old-member</list>'
        payload = self.payload([('A/list.xml', content), ('B/list.xml', content)], 'legacy-merged-paths')
        old = self.seed_old_package(payload)
        self.assertEqual(old['members'][0]['file'], old['members'][1]['file'])
        before = self.rows()
        for member in payload['members']:
            with self.subTest(path=member['name']), self.assertRaises(frappe.DuplicateEntryError):
                packages._upload('list.xml', member['content_base64'], member['sha256'],
                    self.directory, payload['container_sha256'],
                    packages._member_key(payload['container_sha256'], member['name'], member['sha256']),
                    '包件成员（血缘：原包 %s）' % payload['container_sha256'][:12],
                    payload['attribution'])
        self.assertEqual(self.rows(), before)

    def test_old_child_business_parameter_change_is_a_visible_conflict(self):
        data = b'<list>old-success</list>'
        payload = self.payload([('A/list.xml', data)], 'legacy-key')
        digest = hashlib.sha256(data).hexdigest()
        key = packages._member_key(payload['container_sha256'], 'A/list.xml', digest)
        old_payload = {'file_name': 'list.xml', 'content_base64': base64.b64encode(data).decode(),
            'attribution': {'level': 'personal'}, 'directory': self.directory,
            'note': 'old-payload', 'file_sha256': digest,
            'container_sha256': payload['container_sha256']}
        original = execute_registered_action('files.upload', old_payload, confirmed=True,
            idempotency_key=key)['result']['file']
        before = self.rows()
        with self.assertRaises(frappe.DuplicateEntryError):
            packages._upload('list.xml', old_payload['content_base64'], digest,
                self.directory, payload['container_sha256'], key, 'changed-note', {'level': 'personal'})
        self.assertEqual(self.rows(), before)
        self.assertEqual(self.content(original), data)

    def test_declared_sha_is_checked_before_a_new_resource_is_created(self):
        before = self.rows()
        with self.assertRaises(frappe.ValidationError):
            packages._upload('invalid.xml', base64.b64encode(b'<list>real</list>').decode(),
                '0' * 64, self.directory, 'a' * 64, 'invalid-member-sha-' + self.token,
                'sha-test', {'level': 'personal'})
        self.assertEqual(self.rows(), before)

    def test_conflicting_container_sha_declarations_leave_no_new_file(self):
        payload = self.payload([('A/list.xml', b'<list>sha-check</list>')], 'sha-declarations')
        payload['container_sha256'] = '0' * 64
        before = self.rows()
        with self.assertRaisesRegex(frappe.ValidationError, '来源摘要不一致'):
            self.act(payload)
        self.assertEqual(self.rows(), before)

    def test_more_than_one_hundred_same_names_accept_the_next_real_upload(self):
        """只预造标题元数据；最后一件经过真实上传/私有文件/版本路径。"""
        from shangshu_files import directories
        folder = directories.resolve({'directory': self.directory})
        stamp = frappe.utils.now_datetime()
        fields = ['name', 'owner', 'creation', 'modified', 'modified_by',
                  'file_name', 'directory', 'directory_id', 'status', 'location_slot']
        names = ['list.xml'] + ['list (%d).xml' % number for number in range(2, 102)]
        rows = [('name-fixture-' + self.token + '-' + str(index), 'Administrator', stamp,
                 stamp, 'Administrator', name, self.directory, folder.name, 'Active', 'active')
                for index, name in enumerate(names)]
        frappe.db.bulk_insert('Shangshu File Center File', fields, rows)
        content = b'<list>after-one-hundred</list>'
        result = execute_registered_action('files.upload', {
            'file_name': 'list.xml', 'directory': self.directory, 'new_resource': True,
            'attribution': {'level': 'personal'},
            'content_base64': base64.b64encode(content).decode(),
            'file_sha256': hashlib.sha256(content).hexdigest()}, confirmed=True,
            idempotency_key='same-name-over-one-hundred-' + self.token)['result']
        self.assertEqual(frappe.db.get_value('Shangshu File Center File', result['file'], 'file_name'),
                         'list (102).xml')
        self.assertEqual(self.content(result['file']), content)
        self.assertEqual(len(self.rows()), 102)
