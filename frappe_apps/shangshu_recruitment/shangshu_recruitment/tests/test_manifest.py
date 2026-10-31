import importlib
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]


def _runtime_unavailable(*_args, **_kwargs):
    raise RuntimeError('声明一致性测试不执行 Frappe 运行时')


class TestRecruitmentManifest(unittest.TestCase):
    def test_manifest_and_policy_declare_recruitment_namespace(self):
        manifest = yaml.safe_load((ROOT / 'shangshu-plugin.yml').read_text())
        self.assertEqual(manifest['id'], 'com.shangshu.recruitment')
        # 邮件收件（mail）与附件入库（files）是跨域依赖，走各自公开契约。
        self.assertEqual(manifest['dependencies'],
                         ['com.shangshu.core@">=0.1"', 'com.shangshu.mail@">=0.7 <1.0"',
                          'com.shangshu.files@">=0.19 <1.0"'])
        self.assertTrue(all(item.startswith('recruitment.') for item in manifest['exports']['actions']))
        policy_path = ROOT.parents[1] / 'scripts/domain-policies/recruitment.json'
        policy = json.loads(policy_path.read_text())
        self.assertEqual(policy['domain'], manifest['id'])
        self.assertIn('frappe_apps/shangshu_recruitment/', policy['paths']['allowed'])

    def test_manifest_exports_match_domain_contribution(self):
        # 只隔离 Frappe/内核运行时；实际加载本域全部模块的真实声明聚合。
        frappe = types.ModuleType('frappe')
        frappe.__path__ = []
        frappe.__getattr__ = lambda _name: _runtime_unavailable
        core = types.ModuleType('shangshu_core')
        core.__path__ = []
        public_api = types.ModuleType('shangshu_core.public_api')
        public_api.__getattr__ = lambda _name: _runtime_unavailable
        core.public_api = public_api
        modules = {
            'frappe': frappe,
            'shangshu_core': core,
            'shangshu_core.public_api': public_api,
        }
        domain_modules = ('shangshu_recruitment.domain', 'shangshu_recruitment.common',
                          'shangshu_recruitment.job', 'shangshu_recruitment.revisions',
                          'shangshu_recruitment.candidate', 'shangshu_recruitment.application',
                          'shangshu_recruitment.intake', 'shangshu_recruitment.mailbox',
                          'shangshu_recruitment.screening', 'shangshu_recruitment.interview',
                          'shangshu_recruitment.hire', 'shangshu_recruitment.sync',
                          'shangshu_recruitment.workbench', 'shangshu_recruitment.evidence_policy')
        try:
            with patch.dict(sys.modules, modules), patch.object(sys, 'path', [str(ROOT), *sys.path]):
                for module in domain_modules:
                    sys.modules.pop(module, None)
                contribution = importlib.import_module('shangshu_recruitment.domain').get_contribution()
        finally:
            # pytest 与站点测试可能同进程运行，不能留下引用 stub frappe 的本域模块。
            for module in domain_modules:
                sys.modules.pop(module, None)
        manifest = yaml.safe_load((ROOT / 'shangshu-plugin.yml').read_text())
        self.assertEqual(set(manifest['exports']['actions']), {item['id'] for item in contribution['actions']})
        self.assertEqual(set(manifest['exports']['objects']), {item['id'] for item in contribution['objects']})
        self.assertEqual(set(manifest['exports']['datasets']), {item['id'] for item in contribution['datasets']})
        self.assertEqual(set(manifest['exports']['services']), {item['id'] for item in contribution['services']})
        # 对象投影必须对应实际 DocType，防止字段漂移导致正式页面读不回业务事实。
        for obj in contribution['objects']:
            folder = obj['doctype'].lower().replace(' ', '_')
            path = ROOT / 'shangshu_recruitment/shangshu_recruitment/doctype' / folder / (folder + '.json')
            fields = {field['fieldname'] for field in json.loads(path.read_text(encoding='utf-8'))['fields']} | {'name'}
            self.assertFalse({f['id'] for f in obj['fields']} - fields, obj['id'] + ' 投影字段不匹配')
        self.assertEqual(manifest['exports']['applications'],
                         [item['id'] for item in contribution['applications']])
        self.assertEqual(manifest['exports']['tools'], ['recruitment.jd.save'])
        self.assertEqual({item['handler'] for item in contribution['actions']},
                         {'shangshu_recruitment.service.execute'})
        # 候选人对象投影不得携带 PII 字段（邮箱/电话/归并键默认不进对象层）。
        candidate = next(item for item in contribution['objects'] if item['id'] == 'recruitment.candidate')
        projected = {field['id'] for field in candidate['fields']}
        self.assertNotIn('primary_email', projected)
        self.assertNotIn('primary_phone', projected)
        self.assertNotIn('normalized_contact_key', projected)

    def test_hooks_declare_every_doctype_permission(self):
        # 域内全部 DocType 必须挂权限钩子：前端隐藏按钮不能替代服务端授权。
        hooks = (ROOT / 'shangshu_recruitment' / 'hooks.py').read_text()
        doctype_dir = ROOT / 'shangshu_recruitment' / 'shangshu_recruitment' / 'doctype'
        for folder in sorted(path.parent.name for path in doctype_dir.glob('*/__init__.py')):
            json_path = doctype_dir / folder / (folder + '.json')
            if not json_path.exists():
                continue
            doctype = json.loads(json_path.read_text())['name']
            self.assertIn('"%s"' % doctype, hooks, 'hooks.py 缺少 %s 的权限钩子' % doctype)


if __name__ == '__main__':
    unittest.main()
