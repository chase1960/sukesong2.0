"""Agent 建表：一次动作建表＋表头＋占位＋归属；看得见、可改、归属先问清。

**这段测试通过 = 下面这些事同时成立**（一句一句都能重做）：

1. agent 少传归属调建表 ⇒ **当场拒**，拒因是「不传归属不能建文件…」那句人话，
   **库里一件都不建**（不留半成品行）。
2. 带上归属 ⇒ 表建出来，归属落**权威表**（`Shangshu Org Attribution`），
   详情页投影里**显示得出归属人**。
3. 建表提案的审核项里**看得见归属这一项**（表名／每个表头／占位文字／归属），
   归属**可改成部门或他人**；**只采用一部分 ⇒ 只落被采用的那部分**。
4. **确认前表不存在**（不留中间空表）；落表后回执**带得出能跳转的 file_id**。
5. 「无权为他人建个人表」「无权在该部门建表」两条拒因**仍然成立**（不许被绕）。
6. **人填路径与 agent 路径产物一致**（同一动作、同一份载荷 ⇒ 同一张表）。

判据编号：①～⑥ 对应交付说明里的六条验收判据。
"""
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_core.public_api import (
    accept_action_proposal_units,
    execute_registered_action,
    get_action_proposal_review,
    invoke_domain_service,
    propose_registered_action,
)

FILE_DOCTYPE = 'Shangshu File Center File'
ATTRIBUTION_DOCTYPE = 'Shangshu Org Attribution'


class TestAgentCreateTable(FrappeTestCase):
    def setUp(self):
        frappe.set_user('Administrator')
        self.token = uuid.uuid4().hex
        self.user = 'create-' + self.token + '@example.invalid'
        self.act('platform.identity.create', {'email': self.user, 'display_name': '建表回归',
            'initial_password': 'Isolated-create-2026!', 'roles': ['staff']})
        frappe.set_user(self.user)

    def tearDown(self):
        frappe.set_user('Administrator')
        super().tearDown()

    # ---- 小工具（公共工具只留一份：只写"准备什么、做什么、应该发生什么"） ----

    def act(self, action, payload, key=None):
        return execute_registered_action(action, payload, confirmed=True,
            idempotency_key=key or uuid.uuid4().hex)['result']

    def files_named(self, base):
        """按表名前缀找建出来的表（同名恒新，所以用前缀找）。"""
        return frappe.get_all(FILE_DOCTYPE, filters={'file_name': ['like', base + '%']},
            fields=['name', 'file_name', 'status'])

    def read(self, name):
        return invoke_domain_service('files.sheet_read', {'table': name})

    def propose_create(self, base, **extra):
        payload = {'file_name': base, 'attribution': {'level': 'personal'}}
        payload.update(extra)
        proposal = propose_registered_action('files.create', payload)
        return proposal['id'], get_action_proposal_review(proposal['id'])

    def units_by_field(self, review):
        grouped = {}
        for unit in review['units']:
            grouped.setdefault(unit['target'].get('field'), []).append(unit)
        return grouped

    # ---- ① 没带归属 ⇒ 当场拒，库里一件都不建 ----

    def test_missing_attribution_is_refused_and_nothing_is_created(self):
        base = '无归属-' + self.token
        with self.assertRaises(frappe.ValidationError) as caught:
            self.act('files.create', {'file_name': base})
        self.assertIn('不传归属不能建文件', str(caught.exception))
        self.assertIn('尚书是单例，没有企业归属', str(caught.exception))
        # 一件都不建：表行没有，归属行也没有（不许留半成品）
        self.assertEqual(self.files_named(base), [])
        self.assertEqual(frappe.get_all(ATTRIBUTION_DOCTYPE,
            filters={'resource': ['like', base + '%']}, fields=['name']), [])

    # ---- ② 带归属 ⇒ 表建出来、归属落权威表、详情页显示得出归属人 ----

    def test_create_with_attribution_lands_in_authority_table_and_detail_shows_owner(self):
        base = '有归属-' + self.token
        result = self.act('files.create', {'file_name': base, 'attribution': {'level': 'personal'}})
        name = result['file']
        self.assertTrue(name)
        row = frappe.db.get_value(ATTRIBUTION_DOCTYPE, {'resource': name},
            ['level', 'owner_user', 'department'], as_dict=True)
        self.assertEqual(row['level'], 'personal')
        self.assertEqual(row['owner_user'], self.user)
        self.assertFalse(row['department'])
        # 详情页投影：归属人显示得出来（前端详情页读的就是这份 attribution/ownership）
        detail = invoke_domain_service('files.versions', {'file': name})['file']
        self.assertEqual(detail['attribution']['level'], 'personal')
        self.assertEqual(detail['attribution']['owner_user'], self.user)

    # ---- ③ 提案的审核项：看得见归属、可改；只采用一部分 ⇒ 只落被采用的那部分 ----

    def test_proposal_units_expose_name_headers_placeholder_and_attribution(self):
        base = '提案项-' + self.token
        _, review = self.propose_create(base, headers=['客户', '金额'], placeholder='占位示例')
        grouped = self.units_by_field(review)
        self.assertEqual(sorted(grouped), ['attribution', 'file_name', 'headers', 'placeholder'])
        self.assertEqual(len(grouped['headers']), 2)
        self.assertEqual([u['value'] for u in grouped['headers']], ['客户', '金额'])
        self.assertEqual(grouped['placeholder'][0]['value'], '占位示例')
        self.assertEqual(grouped['attribution'][0]['value'], 'personal')
        for unit in review['units']:
            for key in ('unit_id', 'label', 'kind', 'target', 'value', 'current_value', 'editable'):
                self.assertIn(key, unit)
            self.assertTrue(unit['editable'], '每一项都要能人工改：' + unit['label'])

    def test_partial_accept_applies_only_the_accepted_units(self):
        base = '部分采用-' + self.token
        proposal_id, review = self.propose_create(base, headers=['客户', '金额'], placeholder='占位示例')
        grouped = self.units_by_field(review)
        # 只采用：表名 ＋ 第一个表头 ＋ 归属（不采用第二个表头、不采用占位文字）
        selected = [grouped['file_name'][0]['unit_id'], grouped['headers'][0]['unit_id'],
                    grouped['attribution'][0]['unit_id']]
        accepted = accept_action_proposal_units(proposal_id, 'partial', review['review_revision'],
            selected, {})
        name = accepted['result']['file_id']
        table = self.read(name)
        self.assertEqual(table['headers'], ['客户'])
        self.assertEqual(table['rows'], [])          # 占位文字没被采用 ⇒ 没有占位行
        row = frappe.db.get_value(ATTRIBUTION_DOCTYPE, {'resource': name}, 'level')
        self.assertEqual(row, 'personal')            # 归属被采用 ⇒ 落了权威表

    def test_a_second_accept_cannot_create_a_second_table(self):
        # 表已经建出来之后**不许再建一次**（否则同一个提案会建出第二张表）。
        base = '不许建两次-' + self.token
        proposal_id, review = self.propose_create(base, headers=['客户', '金额'], placeholder='占位示例')
        grouped = self.units_by_field(review)
        accept_action_proposal_units(proposal_id, 'first', review['review_revision'],
            [grouped['file_name'][0]['unit_id'], grouped['attribution'][0]['unit_id']], {})
        self.assertEqual(len(self.files_named(base)), 1)
        latest = get_action_proposal_review(proposal_id)
        self.assertFalse(latest['can_accept'])
        with self.assertRaises(frappe.ValidationError) as caught:
            accept_action_proposal_units(proposal_id, 'second', latest['review_revision'], None, {})
        self.assertIn('已经建好了', str(caught.exception))
        self.assertEqual(len(self.files_named(base)), 1)   # 还是那一张表

    def test_proposal_without_attribution_cannot_be_confirmed_until_a_person_fills_it(self):
        # **归属必须由人明确指定**：agent 少传归属时，提案里归属那一项是**空的**，
        # 人不填就采用 ⇒ 当场拒，**一件都不建**（不许悄悄替人默认一个）。
        base = '没问归属-' + self.token
        proposal = propose_registered_action('files.create', {'file_name': base, 'headers': ['客户']})
        review = get_action_proposal_review(proposal['id'])
        grouped = self.units_by_field(review)
        self.assertEqual(grouped['attribution'][0]['value'], '')
        with self.assertRaises(frappe.ValidationError) as caught:
            accept_action_proposal_units(proposal['id'], 'no-attribution', review['review_revision'],
                [grouped['attribution'][0]['unit_id']], {})
        self.assertIn('建表必须先确认归属', str(caught.exception))
        self.assertEqual(self.files_named(base), [])

    def test_attribution_unit_can_be_changed_to_department_before_creating(self):
        base = '改归属-' + self.token
        proposal_id, review = self.propose_create(base, headers=['客户'])
        grouped = self.units_by_field(review)
        # 人把归属这一项改成部门（审核项里改值，再落库）
        edited = {grouped['attribution'][0]['unit_id']: 'department:' + self.department()}
        # 本人不在该部门 ⇒ 建表权那道闸必须拦（不许绕），且**一件都不建**
        with self.assertRaises(frappe.PermissionError) as caught:
            accept_action_proposal_units(proposal_id, 'to-department', review['review_revision'],
                [grouped['attribution'][0]['unit_id']], edited)
        self.assertIn('无权在该部门建表', str(caught.exception))
        self.assertEqual(len(self.files_named(base)), 0)

    def test_attribution_unit_edited_to_department_lands_when_department_granted(self):
        base = '部门归属-' + self.token
        department = self.department()
        # 本人被任进该部门 ⇒ 有建表权
        frappe.set_user('Administrator')
        self.act('platform.org.member_assign', {'user': self.user, 'department': department})
        frappe.set_user(self.user)
        proposal_id, review = self.propose_create(base, headers=['客户'])
        grouped = self.units_by_field(review)
        edited = {grouped['attribution'][0]['unit_id']: 'department:' + department}
        accepted = accept_action_proposal_units(proposal_id, 'to-department', review['review_revision'],
            [grouped['attribution'][0]['unit_id']], edited)
        name = accepted['result']['file_id']
        row = frappe.db.get_value(ATTRIBUTION_DOCTYPE, {'resource': name},
            ['level', 'department'], as_dict=True)
        self.assertEqual(row['level'], 'department')
        self.assertEqual(row['department'], department)

    # ---- ④ 确认前表不存在；落表后回执带得出 file_id ----

    def test_table_does_not_exist_before_confirmation_and_receipt_carries_file_id(self):
        base = '确认前-' + self.token
        proposal_id, review = self.propose_create(base, headers=['客户'], placeholder='占位示例')
        # 确认前：表不存在（没有中间空表）
        self.assertEqual(self.files_named(base), [])
        accepted = accept_action_proposal_units(proposal_id, 'confirm-all', review['review_revision'],
            None, {})
        receipt = accepted['result']
        self.assertTrue(receipt['file_id'])
        self.assertEqual(receipt['file_id'], receipt['file'])
        self.assertEqual(len(self.files_named(base)), 1)
        # 落表后：表头与占位文字都在
        table = self.read(receipt['file_id'])
        self.assertEqual(table['headers'], ['客户'])
        self.assertEqual(len(table['rows']), 2)      # 前两行第一格写了占位
        self.assertEqual(table['rows'][0]['values']['客户']['value'], '占位示例')
        self.assertEqual(table['rows'][1]['values']['客户']['value'], '占位示例')

    # ---- ⑤ 两条既有权限拒因仍然成立 ----

    def test_cross_owner_and_cross_department_creation_stay_refused(self):
        other = 'other-' + self.token + '@example.invalid'
        frappe.set_user('Administrator')
        self.act('platform.identity.create', {'email': other, 'display_name': '另一同事',
            'initial_password': 'Isolated-create-2026!', 'roles': ['staff']})
        frappe.set_user(self.user)
        with self.assertRaises(frappe.PermissionError) as caught:
            self.act('files.create', {'file_name': '他人-' + self.token,
                'attribution': {'level': 'personal', 'owner_user': other}})
        self.assertIn('无权为他人建个人表', str(caught.exception))
        self.assertEqual(self.files_named('他人-' + self.token), [])
        with self.assertRaises(frappe.PermissionError) as caught:
            self.act('files.create', {'file_name': '跨部门-' + self.token,
                'attribution': {'level': 'department', 'department': self.department()}})
        self.assertIn('无权在该部门建表', str(caught.exception))
        self.assertEqual(self.files_named('跨部门-' + self.token), [])

    # ---- ⑥ 人填路径与 agent 路径产物一致 ----

    def test_human_path_and_agent_path_produce_the_same_table(self):
        payload = {'file_name': '同产物-' + self.token, 'headers': ['客户', '金额'],
            'placeholder': '占位示例', 'attribution': {'level': 'personal'}}
        human = self.act('files.create', dict(payload))
        proposal_id, review = self.propose_create(payload['file_name'], headers=payload['headers'],
            placeholder=payload['placeholder'])
        accepted = accept_action_proposal_units(proposal_id, 'same', review['review_revision'],
            None, {})
        agent = accepted['result']
        # 同名恒新：第二个同名表叫「<表名> (2).xlsx」（改名加在主名后面，不加在扩展名后面）
        self.assertEqual(agent['file_name'], human['file_name'].replace('.xlsx', ' (2).xlsx'))
        left = self.read(human['file_id'])
        right = self.read(agent['file_id'])
        self.assertEqual(left['headers'], right['headers'])
        self.assertEqual(left['rows'], right['rows'])
        left_attr = frappe.db.get_value(ATTRIBUTION_DOCTYPE, {'resource': human['file_id']},
            ['level', 'owner_user'], as_dict=True)
        right_attr = frappe.db.get_value(ATTRIBUTION_DOCTYPE, {'resource': agent['file_id']},
            ['level', 'owner_user'], as_dict=True)
        self.assertEqual(left_attr, right_attr)

    # ---- 夹具 ----

    def department(self):
        """一个与本测试无关的部门（跨部门建表要授权 ⇒ 用它当反例）。"""
        frappe.set_user('Administrator')
        created = self.act('platform.org.department_create', {'name': '无关部门-' + self.token})
        frappe.set_user(self.user)
        return created['department']
