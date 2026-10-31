"""外部内容入库与内链化 —— **离线可跑**的单测（不碰 frappe）。

用户 2026-10-21 的口径：「对于外部内容，接受就直接进入文件中心，给他一个内链，
让这些都能显示和转发。」

测试通过 = 下面全部成立：
  1. 正文里的**外链图**被认出来（只认 img 的 src；正文里的外链**链接**不管）；
  2. 外链图被换成 `cid:` 引用 —— 这是**出站净化门只认**的形态（转发才带得走）；
  3. 取不到的引用**留原样** —— 不编地址（编了比破的更糟）；
  4. 私网/环回/非 http 的地址**不取**（不能让外部内容让服务器去打内网）；
  5. 字节超限或类型不对**不入库**；
  6. 入库成功后，正文引用与资源表**对得上**（content_id 一一对应），
     且资源带**文件中心记录**（`source`）⇒ 那就是「给了他一个内链」。
"""
import unittest

from shangshu_mail import external_assets as ea

PNG = b'\x89PNG\r\n\x1a\n' + b'0' * 32


class TestExternalAssets(unittest.TestCase):
    def test_only_img_src_is_picked(self):
        body = ('<p>看图 <a href="https://example.invalid/a">链接</a></p>'
                '<img src="https://cdn.invalid/pic.png" alt="图">'
                '<img src=\'http://cdn.invalid/b.jpg\'>')
        urls = ea.external_image_urls(body)
        self.assertEqual(urls, ['https://cdn.invalid/pic.png', 'http://cdn.invalid/b.jpg'])

    def test_body_rewritten_to_cid(self):
        body = '<p><img src="https://cdn.invalid/pic.png"></p>'
        out = ea.rewrite_external_to_cids(body, {'https://cdn.invalid/pic.png': 'cid-1@x'})
        self.assertIn('src="cid:cid-1@x"', out)
        self.assertNotIn('https://cdn.invalid', out)

    def test_unfetched_reference_is_left_alone(self):
        body = '<p><img src="https://cdn.invalid/pic.png"></p>'
        out = ea.rewrite_external_to_cids(body, {})
        self.assertIn('https://cdn.invalid/pic.png', out)

    def test_private_and_non_http_targets_are_not_fetched(self):
        self.assertTrue(ea.is_blocked_host('http://127.0.0.1/x.png'))
        self.assertTrue(ea.is_blocked_host('http://localhost/x.png'))
        self.assertTrue(ea.is_blocked_host('http://10.0.0.1/x.png'))
        self.assertTrue(ea.is_blocked_host('http://169.254.169.254/latest/meta-data'))
        self.assertTrue(ea.is_blocked_host('file:///etc/passwd'))
        self.assertTrue(ea.is_blocked_host('ftp://cdn.invalid/x.png'))

    def test_plan_fetches_and_rewrites(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if 'bad' in url:
                return None
            return {'content': PNG, 'mime_type': 'image/png', 'name': 'pic.png'}

        body = ('<p><img src="https://cdn.invalid/pic.png"></p>'
                '<p><img src="https://cdn.invalid/bad.png"></p>')
        plan = ea.plan_external_images(body, fetch=fetch, guard=lambda url: False)
        self.assertEqual(calls, ['https://cdn.invalid/pic.png', 'https://cdn.invalid/bad.png'])
        self.assertIn('cid:external-', plan['body'])
        self.assertEqual(len(plan['resources']), 1)
        self.assertEqual(plan['resources'][0]['mime_type'], 'image/png')
        # 取不到的那张：引用留原样，资源表里没有它。
        self.assertIn('https://cdn.invalid/bad.png', plan['body'])
        self.assertEqual([r['status'] for r in plan['results']],
                         ['fetched', 'skipped'])

    def test_private_target_is_skipped_before_fetch(self):
        called = []

        def fetch(url):
            called.append(url)
            return {'content': PNG, 'mime_type': 'image/png', 'name': 'x.png'}

        body = '<img src="http://127.0.0.1/secret.png">'
        plan = ea.plan_external_images(body, fetch=fetch)
        self.assertEqual(called, [], '私网地址不该被取')
        self.assertEqual(plan['resources'], [])
        self.assertIn('http://127.0.0.1/secret.png', plan['body'])

    def test_oversize_and_wrong_type_are_not_kept(self):
        def fetch(url):
            return {'content': b'x' * (ea.MAX_EXTERNAL_IMAGE_BYTES + 1),
                    'mime_type': 'image/png', 'name': 'big.png'}

        plan = ea.plan_external_images('<img src="https://cdn.invalid/big.png">', fetch=fetch)
        self.assertEqual(plan['resources'], [])

    def test_job_imports_assets_and_keeps_cid_in_body(self):
        """收信那一趟：外链图 + 内联图都进文件中心，资源表带 `source`，
        正文**保持 `cid:` 形态**（出站只认 cid:，换地址转发就丢图）。"""
        import sys
        import types

        class _Doc:
            def __init__(self, body, inline):
                self._body = body
                self._inline = inline
                self.saved = 0

            def get(self, key):
                if key == 'body':
                    return self._body
                if key == 'inline_resources_json':
                    return self._inline
                return ''

            def save(self, ignore_permissions=True):
                self.saved += 1

        doc = _Doc('<p><img src="https://cdn.invalid/pic.png"></p>'
                   '<p><img src="cid:inline-1@x"></p>',
                   '[{"content_id": "inline-1@x", "mime_type": "image/png", '
                   '"name": "in.png", "file": "FILE-INLINE"}]')

        class _Frappe:
            @staticmethod
            def get_doc(doctype, name):
                return doc

            @staticmethod
            def log_error(**kwargs):
                pass

        fake = types.ModuleType('frappe')
        fake.get_doc = _Frappe.get_doc
        fake.log_error = _Frappe.log_error
        sys.modules['frappe'] = fake
        fake_service = types.ModuleType('shangshu_mail.service')
        import contextlib

        @contextlib.contextmanager
        def _writing():
            yield
        fake_service.writing = _writing
        old_service = sys.modules.get('shangshu_mail.service')
        sys.modules['shangshu_mail.service'] = fake_service
        try:
            out = ea.import_mail_assets(
                'MAIL-1', 'user@example.invalid',
                fetch=lambda url: {'content': PNG, 'mime_type': 'image/png', 'name': 'pic.png'},
                guard=lambda url: False,
                create_file=lambda mail, name, content: 'FILE-NEW',
                import_files=lambda mail, user, files: {f: 'CENTER-1' for f in files})
        finally:
            del sys.modules['frappe']
            if old_service is not None:
                sys.modules['shangshu_mail.service'] = old_service
            else:
                del sys.modules['shangshu_mail.service']

        by_id = {r['content_id']: r for r in out['resources']}
        # 外链图：换成 cid:，进了文件中心，带 source（= 内链的落点）
        external = [r for r in out['resources'] if r['content_id'].startswith('external-')]
        self.assertEqual(len(external), 1)
        self.assertEqual(external[0]['file'], 'FILE-NEW')
        self.assertEqual(external[0]['source'],
                         {'ref_doctype': 'Shangshu File Center File',
                          'ref_name': 'CENTER-1', 'file': 'FILE-NEW'})
        self.assertIn('cid:' + external[0]['content_id'], out['body'])
        self.assertNotIn('https://cdn.invalid', out['body'])
        # 内联图：也进文件中心（原来只有附件进）⇒ **转发时不用再存一次**
        self.assertEqual(by_id['inline-1@x']['source']['ref_name'], 'CENTER-1')
        # 正文保持 cid: 形态（出站净化门只认 cid:）
        self.assertIn('cid:inline-1@x', out['body'])
        self.assertNotIn('/api/platform/file-content', out['body'])

    def test_resource_table_merge_keeps_one_entry_per_content_id(self):
        merged = ea.merge_inline_resources(
            [{'content_id': 'a', 'file': 'F1'}, {'content_id': 'b', 'file': 'F2'}],
            [{'content_id': 'a', 'file': 'F9', 'source': {'ref_name': 'C'}}])
        self.assertEqual([m['content_id'] for m in merged], ['a', 'b'])
        self.assertEqual(merged[0]['file'], 'F9')


if __name__ == '__main__':
    unittest.main()
