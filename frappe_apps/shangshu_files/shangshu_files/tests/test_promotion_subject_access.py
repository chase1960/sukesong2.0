"""PKG-117-T01 **域侧**判据：列级/表级权限按「**四个操作 × 主体范围**」声明。

口径本体：`fde/设计/契约/账号与权限.md` 第 233–293 行
（2026-10-25「列级权限按『主体范围』分配」＋ 22:4x「**不留兼容函数**」订正）。

⚠️ **2026-10-26 23:0x 用户拍板：「助手」那一档整个去掉**（不是改成真拦）——
   助手和人走同一条读路 ⇒ 那一档从没被执行过 ⇒ 写上去「说了不算」。
⚠️ **2026-10-27 06:2x 用户拍板：降维** —— 权限只有**三个**操作：
   **读（筛）／写／下载**，且**递进**（不能读就不能写、不能下载）。
   ⇒ 声明形状是**三个操作**；**存量声明里带着 `assistant`／`filter` 的
   按「视同未声明」处理**（不拒、不放宽）——见 **PS-14**。

**测试通过 = 下面每一条都成立**（编号 PS-xx 与实现一一对应）：

- **PS-01** 晋升一列**不填主体范围** ⇒ **当场拒**，理由**点名是哪个列、哪个操作、缺什么**。
- **PS-02** 主体范围**形状不合法**（部门档缺 `departments`／个人档缺 `users`／
  全局档夹子键／第四个档）⇒ **当场拒**，理由说清缺什么。
- **PS-03** 列上还带**旧的三个角色键** ⇒ **明确拒**（不留兼容分支）。
- **PS-04** **表级 `access` 必填**（有列没表级 ⇒ 拒；没有晋升列也要有）。
- **PS-05** 列没声明 ⇒ **继承表级**（**三个操作各自**继承，不是只验「读」）。
- **PS-06** **递进**：读不通 ⇒ **写不通、下载不通**（哪怕写/下载自己声明得更宽）。
- **PS-07** **没有晋升列 ⇒ 全按表级**。
- **PS-08** **部门级表的列对表外员工不可见**（表外的人读不到那一列）。
- **PS-09** **真总表形态**（表级全局 ＋ 15 列逐列全局）⇒ **全员可读可写**
  （与改造前一致 —— **改的是声明，不是效果**）。
- **PS-10** **改一列 ⇒ 表级不变**（表级不再由各列推导）；**改表级 ⇒ 表级变**，
  且**受管对象**的表级 access 跟着变。
- **PS-11** 落库**不丢字段**：列的 `access` 与表级的 `access` **整份带过**。
- **PS-12** `my_access` 只有既有六键；**没有「可筛」「可给助手」那两维**（降维后不存在）。
- **PS-13** **存量表重写机制**可用：重写后**行为不变**（仍全员可读可写），
  且**表级不再由列推导**（列声明再改，表级也不动）。
- **PS-14** **存量声明里带着旧的 `assistant`／`filter`** ⇒ 照旧判**读／写／下载**
  （既不因此被拒，也不因此放宽别的判定）。

**判据分两截**：
· **PS-01～PS-09** 走**声明层与判定层**（不建受管对象，跑得快）；
· **PS-10～PS-13** 走**真表**（上传工作簿 → 晋升 → 改声明 → 重写），
  因为要证明的是「**落库的那份**」与「**受管对象那份**」都真的变了/没变。
"""
import base64
import unittest
import uuid

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    HAS_FRAPPE = True
except ImportError:  # pragma: no cover
    HAS_FRAPPE = False
    FrappeTestCase = unittest.TestCase


#: **全局**主体范围（全员可读可写）。
GLOBAL = {'scope': 'global'}
#: **部门**主体范围（财务部成员及其管理范围）。
DEPARTMENT = {'scope': 'department', 'departments': ['财务']}
#: **个人**主体范围。
PERSONAL = {'scope': 'personal', 'users': ['zhang@x.com']}


def access(read=None, write=None, download=None):
    """一份列级/表级 `access` 声明（**三个操作都必填**：读／写／下载）。

    ⚠️ **降维**（2026-10-27 用户拍板）：「筛」并进了「读」、「助手」那一档已去掉
    ⇒ 这里**只产出这三个键**；存量声明里带着 `assistant`／`filter` 的情形见 **PS-14**。
    """
    return {'read': read or GLOBAL, 'write': write or GLOBAL, 'download': download or GLOBAL}


def subject(user, member_of=(), head_departments=()):
    """主体判定上下文（形状与内核 `org_admin.subject_context` 一致）。"""
    return {'user': user, 'member_of': list(member_of),
            'head_departments': list(head_departments)}


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestDeclarationGate(FrappeTestCase):
    """PS-01～PS-04：入口闸（声明形状）。"""

    def setUp(self):
        frappe.set_user('Administrator')

    def _definition(self, columns, table_access=None):
        out = {'columns': columns}
        if table_access is not None:
            out['access'] = table_access
        return out

    def _column(self, **extra):
        col = {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number'}
        col.update(extra)
        return col

    # ---------- PS-01 ----------

    def test_晋升一列不填主体范围被拒且点名(self):
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError) as caught:
            promotion.validate_definition(self._definition(
                [self._column()], table_access=access()))
        message = str(caught.exception)
        self.assertIn('金额', message)
        self.assertIn('access', message)

    def test_列少写一个必填操作被拒且点名是哪个操作(self):
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError) as caught:
            promotion.validate_definition(self._definition(
                [self._column(access={'read': GLOBAL, 'write': GLOBAL})],
                table_access=access()))
        message = str(caught.exception)
        self.assertIn('金额', message)
        self.assertIn('下载', message)

    # ---------- PS-02 ----------

    def test_部门档缺departments被拒(self):
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError) as caught:
            promotion.validate_definition(self._definition(
                [self._column(access=access(write={'scope': 'department'}))],
                table_access=access()))
        message = str(caught.exception)
        self.assertIn('departments', message)
        self.assertIn('金额', message)

    def test_个人档缺users被拒(self):
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError) as caught:
            promotion.validate_definition(self._definition(
                [self._column(access=access(download={'scope': 'personal'}))],
                table_access=access()))
        self.assertIn('users', str(caught.exception))

    def test_全局档夹子键被拒(self):
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError):
            promotion.validate_definition(self._definition(
                [self._column(access=access(read={'scope': 'global',
                                                  'departments': ['财务']}))],
                table_access=access()))

    def test_未定义的档被拒(self):
        # ⚠️ 用例名订正（2026-10-26）：第四档**已经存在**了（`none` ＝ 无人）
        # ⇒ 这条不再叫「第四个主体档被拒」，它测的是**没定义过的档**（`enterprise`）。
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError):
            promotion.validate_definition(self._definition(
                [self._column(access=access(read={'scope': 'enterprise'}))],
                table_access=access()))

    # ---------- PS-03 ----------

    def test_旧角色键被明确拒(self):
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError) as caught:
            promotion.validate_definition(self._definition(
                [self._column(read_roles=['Desk User'])], table_access=access()))
        message = str(caught.exception)
        self.assertIn('read_roles', message)
        self.assertIn('角色键', message)

    # ---------- PS-04 ----------

    def test_表级access必填(self):
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError) as caught:
            promotion.validate_definition(self._definition(
                [self._column(access=access())]))
        self.assertIn('access', str(caught.exception))

    def test_没有晋升列时表级access也要必填(self):
        from shangshu_files import promotion
        with self.assertRaises(frappe.ValidationError):
            promotion.validate_definition(self._definition(
                [{'header': '名称', 'promoted': False}]))


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestInheritance(FrappeTestCase):
    """PS-05～PS-08：继承链与主体判定（**走内核那个口**，域不自己判）。"""

    def setUp(self):
        frappe.set_user('Administrator')

    def _allows(self, field_access, op, table_access, person):
        from shangshu_files import access_scope
        return bool(access_scope.field_allows(
            {'id': '金额', 'access': field_access}, op,
            user=person.get('user'), table_access=table_access, ctx=person))

    # ---------- PS-05 ----------

    def test_列没声明就继承表级_五个操作各自继承(self):
        table = {'read': GLOBAL, 'write': DEPARTMENT, 'download': PERSONAL}
        # 逐个断言「继承到的是**哪一档**」—— 用**不同的人**验不同的档。
        self.assertTrue(self._allows({}, 'read', table, subject('li@x.com')),
                        '「读」没继承到表级（全局）')
        self.assertTrue(self._allows({}, 'write', table,
                                     subject('wang@x.com', member_of=['财务'])),
                        '「写」没继承到表级（部门档）')
        self.assertFalse(self._allows({}, 'write', table, subject('li@x.com')))
        self.assertTrue(self._allows({}, 'download', table, subject('zhang@x.com')),
                        '「下载」没继承到表级（个人档）')
        self.assertFalse(self._allows({}, 'download', table, subject('li@x.com')))

    # ---------- PS-06 ----------

    def test_递进_读不通则写不通下载不通(self):
        """读＝个人（只有张三读得着）⇒ **李四写不了、也下载不了**，
        哪怕写/下载自己声明的是「全局」。"""
        table = {'read': GLOBAL, 'write': GLOBAL, 'download': GLOBAL}
        field = {'read': PERSONAL, 'write': GLOBAL, 'download': GLOBAL}
        for op in ('write', 'download'):
            self.assertFalse(self._allows(field, op, table, subject('li@x.com')),
                             '「%s」在读不通的情况下照样放行了（递进没生效）' % op)
            self.assertTrue(self._allows(field, op, table, subject('zhang@x.com')),
                            '「%s」把读得着的人挡了（递进误伤）' % op)

    def test_递进_表级读无人则列的写也不通(self):
        table = {'read': {'scope': 'none'}, 'write': GLOBAL, 'download': GLOBAL}
        self.assertFalse(self._allows({}, 'write', table, subject('li@x.com')),
                         '读不通的人照样能写')
        self.assertFalse(self._allows({}, 'download', table, subject('li@x.com')),
                         '读不通的人照样能下载')

    # ---------- PS-07 ----------

    def test_没有晋升列时全按表级(self):
        from shangshu_files import access_scope
        table = {'read': GLOBAL, 'write': DEPARTMENT, 'download': PERSONAL}
        # 没有晋升列 ⇒ 每一列的每个操作都按**表级**算：
        # 读＝全局 ⇒ 通得过；写＝部门档 ⇒ 表外的人通不过；
        # 下载＝个人档 ⇒ 只有本人通得过。
        person = subject('li@x.com', member_of=['销售'])
        expected = {'read': True, 'write': False, 'download': False}
        for op, want in expected.items():
            allowed = bool(access_scope.field_allows(
                {'id': '普通列'}, op, user=person['user'],
                table_access=table, ctx=person))
            self.assertEqual(allowed, want, '「%s」没按表级算' % op)

    # ---------- PS-08 ----------

    def test_部门级表的列对表外员工不可见(self):
        table = {'read': DEPARTMENT, 'write': DEPARTMENT, 'download': DEPARTMENT}
        outsider = subject('li@x.com', member_of=['销售'])
        insider = subject('wang@x.com', member_of=['财务'])
        self.assertFalse(self._allows({}, 'read', table, outsider))
        self.assertTrue(self._allows({}, 'read', table, insider))

    def test_部门档也认管理范围(self):
        table = {'read': DEPARTMENT, 'write': GLOBAL, 'download': GLOBAL}
        boss = subject('boss@x.com', head_departments=['财务'])
        self.assertTrue(self._allows({}, 'read', table, boss))


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestManagedTable(FrappeTestCase):
    """PS-09～PS-13：真表（上传 → 晋升 → 改声明 → 重写）。"""

    def setUp(self):
        frappe.set_user('Administrator')
        self.key = 'ps117-' + uuid.uuid4().hex[:8]
        self.table = None
        self.created = []

    def tearDown(self):
        frappe.set_user('Administrator')
        from shangshu_core import model_records
        for object_id, application_id in self.created:
            try:
                model = frappe.get_doc(model_records.MODEL, object_id)
                frappe.db.commit()
                frappe.db.sql('DROP TABLE IF EXISTS `%s`' % model.physical_doctype)
                frappe.delete_doc('DocType', model.physical_doctype, force=True,
                                  ignore_permissions=True)
                frappe.delete_doc(model_records.MODEL, object_id, force=True,
                                  ignore_permissions=True)
            except Exception:
                pass
            try:
                frappe.delete_doc('Shangshu Application Definition', application_id,
                                  force=True, ignore_permissions=True)
            except Exception:
                pass
        try:
            frappe.db.commit()
        except Exception:
            pass
        super().tearDown()

    # ---------- 夹具 ----------

    def _upload(self):
        from shangshu_files import service
        from shangshu_files.tests import promotion_fixture as fixture
        result = service.upload({
            'file_name': '主体范围-%s.xlsx' % self.key,
            'content_base64': base64.b64encode(fixture.workbook_bytes()).decode(),
            'attribution': {'level': 'personal'}})
        frappe.db.commit()
        self.table = result['file']
        return self.table

    def _promote(self, columns=None, table_access=None):
        from shangshu_files import promotion
        from shangshu_files.tests import promotion_fixture as fixture
        if columns is None:
            columns = fixture.PROMOTED
        definition = {'columns': columns}
        if table_access is None:
            definition['access'] = dict(fixture.TABLE_ACCESS)
        else:
            definition['access'] = table_access
        outcome = promotion.define({'table': self.table, 'definition': definition})
        frappe.db.commit()
        binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, self.table))
        if binding and binding.get('object_id') and binding.get('object_id') not in self.created:
            self.created.append((binding['object_id'], binding.get('application_id')))
        return outcome, binding

    def _definition(self):
        from shangshu_files import promotion
        return promotion.load_definition(frappe.get_doc(promotion.FILE, self.table))

    def _object_access(self, binding):
        """受管对象**编译后**的表级 access。

        ⚠️ `model_records.definition()` 给的是**公开子集**（里面没有 access）⇒
        这里**直接读内核那份 compiled JSON**（**测试才有的特权**，
        生产代码不许直查内核表）。
        """
        import json
        row = frappe.db.get_value('Shangshu Object Model', binding['object_id'], 'active_json')
        compiled = json.loads(row or '{}')
        return compiled.get('access') or {}

    # ---------- PS-09 ----------

    def test_真总表形态全员可读可写(self):
        """表级全局 ＋ **15 列逐列全局** ⇒ 全员可读可写（与改造前一致）。"""
        from shangshu_files import access_scope
        columns = []
        for index in range(15):
            columns.append({'header': '列%02d' % index, 'promoted': True,
                            'field': 'col%02d' % index, 'type': 'text',
                            'access': access()})
        table_access = dict(access(), record_scope='all')
        person = subject('li@x.com', member_of=['销售'])
        for op in ('read', 'write', 'download'):
            for col in columns:
                self.assertTrue(
                    access_scope.field_allows({'id': col['field'], 'access': col['access']},
                                              op, user=person['user'],
                                              table_access=table_access, ctx=person),
                    '列 %s 的「%s」不通' % (col['header'], op))

    # ---------- PS-10 ----------

    def test_改一列表级不变且受管对象表级也不变(self):
        self._upload()
        _, binding = self._promote()
        before = self._definition()
        from shangshu_files import promotion
        columns = [dict(c) for c in before['columns']]
        for col in columns:
            if col.get('promoted'):
                col['access'] = access(write=DEPARTMENT)
        promotion.rewrite({'table': self.table, 'access': before['access'],
                            'columns': {c['header']: c['access'] for c in columns
                                        if c.get('promoted')}})
        frappe.db.commit()
        after = self._definition()
        self.assertEqual(after['access'], before['access'],
                         '改一列不该动表级（并集联动已取消）')
        self.assertEqual(self._object_access(binding), before['access'],
                         '改一列不该动受管对象的表级 access')

    def test_改表级表级变且受管对象表级跟着变(self):
        self._upload()
        _, binding = self._promote()
        before = self._definition()
        from shangshu_files import promotion
        new_table = access(read=DEPARTMENT)
        promotion.rewrite({'table': self.table, 'access': new_table,
                            'default_column_access': new_table})
        frappe.db.commit()
        after = self._definition()
        self.assertNotEqual(after['access'], before['access'], '改表级表级就该变')
        self.assertEqual(after['access']['read'], DEPARTMENT)
        object_access = self._object_access(binding)
        self.assertEqual(object_access.get('read'), DEPARTMENT,
                         '受管对象的表级 access 也要跟着变')

    # ---------- PS-11 ----------

    def test_落库不丢字段(self):
        self._upload()
        self._promote()
        stored = self._definition()
        self.assertIsNotNone(stored.get('access'), '表级 access 丢了')
        for key in ('read', 'write', 'download'):
            self.assertIn(key, stored['access'])
        for col in stored['columns']:
            if not col.get('promoted'):
                continue
            self.assertIn('access', col, '列 %s 的 access 丢了' % col.get('header'))
            for key in ('read', 'write', 'download'):
                self.assertIn(key, col['access'])

    # ---------- PS-12 ----------

    def test_my_access没有可筛与可给助手那两维(self):
        from shangshu_core.public_api import invoke_domain_service
        self._upload()
        self._promote()
        result = invoke_domain_service('files.sheet_read', {'table': self.table})
        my_access = result.get('my_access') or {}
        for key in ('read', 'preview', 'download', 'write', 'review', 'structure'):
            self.assertIn(key, my_access, '原有维度「%s」不见了' % key)
        # ⚠️ 2026-10-27 用户拍定降维 ⇒ 回包里**没有**「可筛」「可给助手」那两维。
        for key in ('filter', 'assistant'):
            self.assertNotIn(key, my_access, '回包里还留着「%s」那一维' % key)

    # ---------- PS-13 ----------

    def test_存量表重写机制行为不变且表级不再由列推导(self):
        from shangshu_files import promotion
        from shangshu_files import promotion_rewrite_data
        self._upload()
        self._promote()
        before = self._definition()
        outcome = promotion.rewrite(dict(promotion_rewrite_data.example_MASTER_TABLE_REWRITE,
                                          table=self.table))
        frappe.db.commit()
        after = self._definition()
        # **行为不变**：重写前后都是「全员可读可写」。
        self.assertEqual(after['access']['read'], GLOBAL)
        self.assertEqual(after['access']['write'], GLOBAL)
        self.assertEqual(after['access']['download'], GLOBAL)
        # **逐列明确声明**（不再是「未声明 ⇒ 继承」那种凑合）。
        for col in after['columns']:
            if col.get('promoted'):
                self.assertIn('access', col)
                self.assertEqual(col['access']['read'], GLOBAL)
        # **表级不再由列推导**：把某一列改窄，表级不动。
        narrow = dict(after['access'])
        columns = {c['header']: access(write=DEPARTMENT)
                   for c in after['columns'] if c.get('promoted')}
        promotion.rewrite({'table': self.table, 'access': narrow, 'columns': columns})
        frappe.db.commit()
        self.assertEqual(self._definition()['access'], narrow,
                         '改一列不该连带把表级收窄')
        self.assertTrue(outcome['definition']['promoted'])


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 站点")
class TestLegacyAssistantKey(FrappeTestCase):
    """PS-14 **存量声明里带着旧的 `assistant`／`filter`** ⇒ 照旧判读／写／下载。

    用户 2026-10-26 23:0x 拍板：「助手」那一档**整个去掉**（**不是**改成真拦）
    ⇒ 存量声明里写着它的那一档，按「**视同未声明**」处理：
    **不因此拒绝加载**，**也不因此放宽别的判定**。

    **测试通过 = 下面每一条都成立**：
    - 老声明带 `assistant`／`filter` ⇒ **能正常读／写／下载**（判定结果与不带它们时一模一样）；
    - 那一档**不放宽**：声明成「下载只有本人」时，别人照样下不了；
    - 那一档**不收紧**：声明成「读＝全局」时，读照样通得过。
    """

    def setUp(self):
        frappe.set_user('Administrator')

    def _allows(self, field_access, op, table_access, person):
        from shangshu_files import access_scope
        return bool(access_scope.field_allows(
            {'id': '金额', 'access': field_access}, op,
            user=person.get('user'), table_access=table_access, ctx=person))

    def test_带助手那一档的声明照旧判读写下载(self):
        table = {'read': GLOBAL, 'write': DEPARTMENT, 'download': PERSONAL}
        field = {'read': GLOBAL, 'write': DEPARTMENT, 'download': PERSONAL,
                 'assistant': {'scope': 'none'}, 'filter': {'scope': 'none'}}
        # 读＝全局 ⇒ 谁都读得着（那一档没把它收紧）。
        self.assertTrue(self._allows(field, 'read', table, subject('li@x.com')),
                        '带「助手」那一档的声明把「读」挡了')
        # 写＝部门档 ⇒ 财务部的人写得着，表外的人写不着（那一档没放宽它）。
        self.assertTrue(self._allows(field, 'write', table,
                                     subject('wang@x.com', member_of=['财务'])),
                        '带「助手」那一档的声明把财务部的人挡在「写」外面')
        self.assertFalse(self._allows(field, 'write', table, subject('li@x.com')),
                         '带「助手」那一档的声明把表外的人放进「写」了')
        # 下载＝个人档 ⇒ 只有本人下得了（那一档没放宽它）。
        self.assertTrue(self._allows(field, 'download', table, subject('zhang@x.com')))
        self.assertFalse(self._allows(field, 'download', table, subject('li@x.com')),
                         '带「助手」那一档的声明把下载放宽了')


if __name__ == '__main__':
    unittest.main()
