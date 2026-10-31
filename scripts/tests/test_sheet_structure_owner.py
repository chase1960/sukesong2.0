"""Structure guard: closed-policy legacy checks plus explicit open-trial behavior."""
import ast
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files'

def functions(file, names, namespace):
    tree = ast.parse((ROOT / file).read_text())
    exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[]), file, 'exec'), namespace)

class StructureOwnerTests(unittest.TestCase):
    def setUp(self):
        self.roles = ['Desk User']
        self.writable = True
        self.att = None
        self.doc = types.SimpleNamespace(name='mine', owner='alice', status='Active')
        self.frappe = types.SimpleNamespace(session=types.SimpleNamespace(user='alice'), get_roles=lambda:self.roles, PermissionError=PermissionError, throw=lambda message, cls: (_ for _ in ()).throw(cls(message)))
        org = types.SimpleNamespace(resource_attribution=lambda name:self.att)
        self.modules = patch.dict(sys.modules, {'shangshu_core':types.SimpleNamespace(org_admin=org)})
        self.modules.start();self.addCleanup(self.modules.stop)
        self.trial = None  # 原有六项固定测关闭试用策略后的声明权限。
        def require_identity(*args):
            if self.frappe.session.user == 'Guest': raise PermissionError('login required')
        self.policy = types.SimpleNamespace(require_identity=require_identity,
            resource_decision=lambda *a, **k:self.trial)
        self.ns={'frappe':self.frappe,'_can_write':lambda doc:self.writable, 'business_access':self.policy}
        functions('service.py', ['_can_structure','_require_structure'], self.ns)
    def test_creator_without_global_structure_role(self):
        self.assertTrue(self.ns['_can_structure'](self.doc))
        self.ns['_require_structure'](self.doc)
    def test_resource_owner_without_global_role(self):
        self.doc.owner='uploader';self.att=types.SimpleNamespace(owner_user='ALICE')
        self.assertTrue(self.ns['_can_structure'](self.doc))
    def test_edit_share_and_other_owner_denied(self):
        self.doc.owner='bob';self.att=types.SimpleNamespace(owner_user='bob')
        self.assertFalse(self.ns['_can_structure'](self.doc))
        with self.assertRaises(PermissionError):self.ns['_require_structure'](self.doc)
    def test_role_never_overrides_write_or_recycled(self):
        self.doc.owner='bob';self.roles+=['Sheet Structure Editor']
        self.assertTrue(self.ns['_can_structure'](self.doc))
        self.writable=False;self.assertFalse(self.ns['_can_structure'](self.doc))
        self.writable=True;self.doc.status='Recycled';self.assertFalse(self.ns['_can_structure'](self.doc))
    def test_permissions_rechecked_each_call(self):
        self.assertTrue(self.ns['_can_structure'](self.doc))
        self.frappe.session.user='bob';self.assertFalse(self.ns['_can_structure'](self.doc))
    def test_open_trial_allows_other_owner_but_not_recycled(self):
        self.trial=True;self.doc.owner="bob";self.writable=False
        self.assertTrue(self.ns["_can_structure"](self.doc))
        self.doc.status="Recycled"
        self.assertFalse(self.ns["_can_structure"](self.doc))
    def test_open_trial_still_rejects_guest(self):
        self.trial=True;self.frappe.session.user="Guest"
        with self.assertRaises(PermissionError):self.ns["_can_structure"](self.doc)
    def test_each_structural_entry_blocks_before_file_access(self):
        self.doc.owner='bob'
        ns={**self.ns, '_writable':lambda _:self.doc, '_Seg':lambda:None}
        def forbidden(*a,**k):raise AssertionError('file was touched before authorization')
        ns['_content']=forbidden;ns['_load_meta']=forbidden
        names=['_structure_open','row_append','column_append','header_rename','table_rename']
        functions('sheet.py', names, ns)
        for name in names:
            with self.subTest(name=name),self.assertRaises(PermissionError):ns[name]({'table':'mine'})

if __name__ == '__main__':unittest.main()
