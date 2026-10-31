"""接入回归：运行真实函数 AST，隔离 Frappe/数据库依赖；不代替实库验收。"""
import ast
import json
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment
# 真 app 包进 sys.path —— actions.py / domain.py / service.py 里那些**函数级** import
# （`from shangshu_core.public_api import ...`）在包不在路径上时直接 ModuleNotFoundError。
install_real_environment()
import shangshu_core.actions as core_actions

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'frappe_apps/shangshu_core/shangshu_core'
FILES = ROOT / 'frappe_apps/shangshu_files/shangshu_files'


def function(path, name, env):
    tree = ast.parse(path.read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), 'exec'), env)
    return env[name]


class IntegrationTests(unittest.TestCase):
    def proposal_editor(self):
        class Denied(Exception):
            pass
        def throw(message, kind):
            raise kind(message)
        env={'json':json, '_json':lambda v,default=None:json.loads(v) if v else default,
             '_definition':lambda *args:SimpleNamespace(input_schema_json='{}'),
             '_validate_schema':lambda *args:None,
             'raw_resource':lambda *args:({}, {'proposal_editable_fields':['subject','body']}),
             'now_datetime':lambda:'2026-10-14 21:00:00',
             # 留痕那两段（摘要脱敏 + 规范化落盘）用**真实现**，不另抄一份。
             '_summary':core_actions._summary,'_canonical':core_actions._canonical,
             'frappe':SimpleNamespace(throw=throw,PermissionError=Denied,ValidationError=Denied,
                                      session=SimpleNamespace(user='staff'))}
        return function(CORE/'actions.py','_apply_edited_value',env),Denied

    def test_mail_revision_keeps_complete_original_and_actor(self):
        edit,_=self.proposal_editor();original={'body':'a'*900,'mail':'fixed-id','expected_version':4}
        proposal=SimpleNamespace(payload_json=json.dumps(original),original_payload_json='',
            action_id='mail.save_draft',action_version='1.4.0',save=lambda **kwargs:None)
        edit(proposal,{'type':'fields','value':{'body':'人工修订'}})
        self.assertEqual(json.loads(proposal.original_payload_json),original)
        self.assertEqual(json.loads(proposal.payload_json),{**original,'body':'人工修订'})
        self.assertEqual(proposal.edited_by,'staff')

    def test_mail_revision_cannot_switch_target_or_version(self):
        edit,denied=self.proposal_editor();writes=[]
        proposal=SimpleNamespace(payload_json='{"mail":"fixed-id"}',action_id='mail.save_draft',
            save=lambda **kwargs:writes.append(kwargs))
        for key in ['mail','expected_version','attachments','mailbox']:
            with self.assertRaises(denied):edit(proposal,{'type':'fields','value':{key:'forged'}})
        self.assertEqual(writes,[])

    def test_executor_never_commits_or_rolls_back_callers_transaction(self):
        tree = ast.parse((CORE / 'actions.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'execute_registered_action')
        forbidden = [ast.unparse(n) for n in ast.walk(node) if isinstance(n, ast.Call)
                     and isinstance(n.func, ast.Attribute)
                     and ast.unparse(n.func.value) == 'frappe.db'
                     and (n.func.attr == 'commit' or (n.func.attr == 'rollback' and not n.keywords))]
        self.assertEqual(forbidden, [], '动作失败不能撤销调用方事务或释放域屏障')

    def test_attribution_requires_a_pinned_write_action(self):
        tree=ast.parse((CORE/'public_api/organization.py').read_text())
        node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='attribution_record')
        source=ast.unparse(node)
        self.assertIn("_definition(pin['action_id'], pin['action_version'])",source)
        self.assertIn("action.effect in ('read', 'external/read', 'extract')",source)

    def test_failure_reason_does_not_expose_internal_exception(self):
        reason = function(CORE / 'actions.py', '_failure_reason', {})
        self.assertNotIn('db-password-secret', reason(RuntimeError('db-password-secret')))

    def test_proposal_failure_uses_the_same_sanitized_reason(self):
        """提案失败与动作失败**必须用同一句**失败原因（不许两处各写一套）。

        ⚠️ 2026-10-24 12:1x 改写：产品把对外口径换成 `_human_failure_reason()`
        （失败原因得是**一句中文** —— 用户 2026-10-24 12:0x 拍板「要换成中文」）
        ⇒ 断言跟着改；**原意（同一套口径）用更强的断言保住**：
        两处（提案失败／动作失败回执）**必须调同一个函数名**。
        """
        tree=ast.parse((CORE/'actions.py').read_text())
        source=ast.unparse(tree)
        resolve=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='resolve_action_proposal')
        assignment=next(n for n in ast.walk(resolve) if isinstance(n,ast.Assign)
            and any(isinstance(t,ast.Attribute) and t.attr=='error_message' for t in n.targets)
            and not isinstance(n.value,ast.Constant))
        self.assertIn('_human_failure_reason(error)',ast.unparse(assignment.value))
        # 「同一个口径」不许只靠眼力：动作失败回执那一处也必须调它
        self.assertIn('action_requests.fail(request, _human_failure_reason(error))',source)

    def test_recycled_xlsx_not_excluded_from_trash_query(self):
        calls = []
        def get_list(_doctype, **kwargs):
            calls.append(kwargs)
            return [{'count': 0}] if kwargs['fields'] == ['count(name) as count'] else []
        # ⚠️ files/domain.py 现在走 `business_get_list`（＝ business_permissions.get_list，
        #    试用开放策略下的清单读口）⇒ 夹具要给同一个桩，不再是 frappe.get_list。
        env = {'frappe': SimpleNamespace(get_list=get_list, session=SimpleNamespace(user='staff'),
                                         db=SimpleNamespace(exists=lambda *a, **k: False)),
               'business_get_list': get_list,
               'DOMAIN': 'com.shangshu.files', 'FILE_KINDS': {}, 'OBJECT_FIELDS': [], 'file_detail': lambda row: row}
        query = function(FILES / 'domain.py', 'query', env)
        query('files.file', {'scope': 'trash'})
        for call in calls:
            self.assertIn(['status', '=', 'Recycled'], call['filters'])
            self.assertNotIn(['file_name', 'not like', '%.xlsx'], call['filters'])

    def test_file_center_all_files_keeps_workbooks(self):
        calls=[]
        def get_list(_doctype,**kwargs):
            calls.append(kwargs)
            return [{'count':0}] if kwargs['fields']==['count(name) as count'] else []
        query=function(FILES/'domain.py','query',{
            'frappe':SimpleNamespace(get_list=get_list,session=SimpleNamespace(user='staff'),
                                     db=SimpleNamespace(exists=lambda *a,**k:False)),
            'business_get_list':get_list,
            'DOMAIN':'com.shangshu.files','FILE_KINDS':{},'OBJECT_FIELDS':[]})
        query('files.file',{'scope':'all'})
        self.assertNotIn(['file_name','not like','%.xlsx'],calls[0]['filters'])

    def test_structured_sheet_rejects_ambiguous_headers_without_writing(self):
        def reject(message,kind):raise kind(message)
        check=function(FILES/'sheet.py','_assert_table_headers',{
            'frappe':SimpleNamespace(throw=reject,ValidationError=ValueError)})
        for headers in [['备注','备注'],['客户',''],['']]:
            with self.assertRaisesRegex(ValueError,'文件中心'):check(headers)
        self.assertEqual(check(['客户','备注']),['客户','备注'])

    def test_sheet_read_never_persists_row_identity(self):
        tree=ast.parse((FILES/'sheet.py').read_text())
        read=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='read_payload')
        call=next(n for n in ast.walk(read) if isinstance(n,ast.Call)
                  and isinstance(n.func,ast.Name) and n.func.id=='_ensure_meta_rows')
        persist=next(k.value for k in call.keywords if k.arg=='persist')
        self.assertIsInstance(persist,ast.Constant)
        self.assertIs(persist.value,False,'只读服务不得顺手写行身份事实')


if __name__ == '__main__':
    unittest.main()
