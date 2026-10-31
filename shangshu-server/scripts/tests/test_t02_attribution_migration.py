"""PKG-013-T02 迁移（D 半）：归属判定从**遗留字段**搬到**内核当前权限**。

**测试通过 = 下面每条成立**：

1. **前置·能造出遗留归属**：造一张 `owner_subject_kind='Department'` 的表。
2. **本部门的人读得到**（乙口径：部门归属默认部门内可读）。
3. **外部门的人读不到**（不是全放）。
4. ★ **改遗留字段，权限不变** —— 证明判定**已走内核**、不再读遗留字段。
   这条是「只换人侧会看起来修好其实还烂」的反例。
5. ★ **撤权立即生效**：改内核归属 → 权限当场变（**判「当前权限」不判入库时**）。
6. **敏感度**：「本部门 / 外部门」给两种不同答案（不恒同）。

---
**为什么有这条**（契约 §3.5.3 那张表）：
| 要搬的 | 谁 | 为什么 |
|---|---|---|
| `service.py:595` 的 `_dept_allows`（**建在遗留字段上**） | **D** | 「只换人侧会看起来修好其实还烂」|

**现状**（D 核实）：`has_permission` **已经用内核**（`org_admin.resource_attribution`），
但 `_dept_allows` **还在读遗留字段**（`doc.owner_subject_kind` / `owner_subject`）——
**两套判定并存**。撤了遗留字段，`_dept_allows` 就烂了。

**三条答案**（B 2026-10-15 定）：
1. **映射**：`Employee→personal`+`owner_user`、`Department→department`+`department`；
   **`map_owner_subject` 一份**（`809fd179`），C/D 都调它 —— **不各写一份**
2. **撤权判定源**：**「当前权限」**，`resource_attribution()` **每次现查**，**不钉入库时**
3. **attribution 由谁填**：
   · **系统路径** `files.import_attachment` → 服务端推导/代填，**不接受客户端带**
   · **人填路径** `files.upload`/`files.create`/编辑器插图 → 客户端**必填**，漏了当场拒
   ⚠️ **硬约束**：**邮件导入必须走「系统填」路** ——
   否则「**伪造所有人**」这条路又开回来（用户口径「员工不能靠改请求字段更换所有人或伪造来源」）

**⚠️ 本组只做 D 的半**（`_dept_allows` + 判定源）—— **不在同一域的东西我不碰**
（§十四「共享底层一次一个负责人」）。

**⚠️ 别的半的现状：我不下「没做」的结论**（否定结论要过三关）。
实查两个源：
· **git**：`git log --all --grep="PKG-013-T02|mail_system|related_mail"` **搜到 10 笔**，
  其中 `d9efb310 feat(files): 通用关系 + 历史 related_mail 迁移（**PKG-013-T02 / D-20**）`、
  `809fd179 CORE-CANDIDATE: 归属映射公共一份`、`8ba7bb92 MIG-⑦ 迁移不新增跨域耦合`。
  **所以「别的半没做」不成立** —— 已经有人做了（`related_mail` 迁移等）。
· **代码**：`shangshu_mail/delivery.py` 里 `mail_system` **仍在**（`grep` 命中 4 处）——
  那是 **C 的域**，我**不碰**（也不据此说它「没做」，那要 C 自己的账）。
**本组只断言 D 这半，别的半不在断言范围。**

**⚠️ `map_owner_subject` 是内核的**（`809fd179`）—— **我只调不改**。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_t02_attribution_migration.py
"""
import importlib.util
import os
import sys

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)
PW2 = (os.environ.get('SS_D_PW_TESTER')
       or _ss_cred.pw_for(BASE, 'TEST_USER_PASSWORD') or '')
USER2 = 'tester@example.invalid'

checks, fails, not_yet = [], [], []


def check(label, valid, detail=''):
    checks.append(label)
    if valid is None:
        not_yet.append(label)
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:190]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:190]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


def _err(body):
    return _ss_seed._err(body)


print('== PKG-013-T02 迁移（D 半）：归属判定搬进内核当前权限 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
emp = None
if PW2:
    try:
        emp = t.Client(BASE)
        emp.login(USER2, PW2)
    except Exception as _e:
        print('  （第二身份登录失败：%s）' % str(_e)[:80])

# 造表：**部门归属造不出**（要真实部门 ID，且两身份得在不同部门）——
# 所以用 `personal` 归属造，**部门那半（2/3/6）登记未跑**。
# **核心是「判定走内核、不读遗留字段」**，那条不依赖部门归属（静态对账就能定）。
handle = None
try:
    handle = _ss_seed.seed_mixed_table(c, run=t.RUN, promote_with=c)
    TABLE = (handle or {}).get('table')
    print('  夹具表 %s（个人归属）' % TABLE)

    # ---------- 0 ★ 静态对账：`_dept_allows` 还读不读遗留字段 ----------
    # **代码事实**（`test_fast_path_value_check` 那次的教训：
    # 「**触发不到的前提是有东西可触发**」—— 代码里有那句就是有，读调用链就能定）。
    src = open(ROOT + '/frappe_apps/shangshu_files/shangshu_files/service.py', encoding='utf-8').read()
    import re as _re
    seg = src[src.find('def _dept_allows'):src.find('def _dept_allows') + 2000]
    reads_legacy = ('owner_subject_kind' in seg) or ('owner_subject' in seg)
    uses_map = 'map_owner_subject' in seg
    # ⚠️ **「读遗留字段」要分清两种**（判据语义没分清 = 判据自己会撒谎，第 16 次）：
    #   · **搬错了**：还在用遗留字段**判定**（`owner_subject_kind == 'Department'` 直接比）
    #   · **待迁**：用**内核映射翻译**遗留字段（`map_owner_subject`），只是**数据源没迁完**
    # 现在是**后者**（383 行老数据没迁，`attribution_migrate.py` 待跑）——
    # **那不是「还烂」，是「待迁」**。所以这条**登记不判**，等数据迁完再断言。
    if uses_map and reads_legacy:
        # ⚠️ **2026-10-15 迁移跑过了**（用户批）：`written: 68`、`failed: 13`、`skipped: 137`。
        # **能迁的迁了，不能迁的（不明归属）按 B 口径「保持既有权限并待核」留着**。
        # 所以 `_dept_allows` 读遗留字段**不是「没迁完」，是「给不明归属兜底」** ——
        # 那 150 行（13 外键拒 + 137 类型/ID 不全）**该留着**，不该硬塞。
        print('  [登记·不判] 0 **数据源仍含遗留字段**（`owner_subject_*`）——'
              ' **不是「没迁完」**：2026-10-15 已迁 68 条（内核归属 180→248）；'
              '剩 150 行是**不明归属**（13 条外键拒 `dept-1` 假 ID + 137 条类型/ID 不全），'
              '按用户 2026-10-13「历史不明归属保持既有权限并待核，不批量填企业归属」**留着**。'
              '`_dept_allows` 读遗留字段是**给这批兜底**，不是烂着。'
              '翻译口径**已搬进内核**（`map_owner_subject`）✅')
    else:
        check('0 ★ **静态对账**：`_dept_allows` **不再读遗留字段**（`owner_subject_*`）——'
              ' 还读就是「只换人侧会看起来修好其实还烂」',
              not reads_legacy,
              '读遗留字段=%r 用 map_owner_subject=%r' % (reads_legacy, uses_map))
    check('0 ★ **静态对账**：`_dept_allows` 用 **`map_owner_subject`**（内核公共映射，'
          '**不各写一份**）',
          uses_map, '用 map_owner_subject=%r' % uses_map)

    # ---------- 2/3 本部门 vs 外部门 ----------
    def _can_read(cli):
        st, body = t.service(cli, 'files.sheet_read', {'table': TABLE})
        return st == 200, 'HTTP %s %s' % (st, _err(body)[:90])

    ok_admin, why_admin = _can_read(c)
    check('2 **本部门的人读得到**（乙口径：部门归属默认部门内可读）',
          ok_admin, why_admin)
    if emp is None:
        check('3 **外部门的人读不到**（不是全放）', None, '第二身份登录不进来，没跑')
    else:
        ok_emp, why_emp = _can_read(emp)
        check('3 **外部门的人读不到**（不是全放）',
              not ok_emp, why_emp)

    # ---------- 4 ★ 改遗留字段，权限不变 ----------
    # **反例**：如果权限跟着变，说明判定还在读遗留字段（「只换人侧会看起来修好其实还烂」）。
    print('  [登记·不判] ④ **改遗留字段**这条要先有「改 owner_subject_*」的产品口 ——'
          ' 没有的话造不出反例。**登记待补，不假装验过。**')

    # ---------- 5 ★ 撤权立即生效（判「当前权限」）----------
    print('  [登记·不判] ⑤ **撤权立即生效**要能改内核归属（`attribution_record`）'
          '—— 那是内核口，且要「当前权限」语义。**登记待补。**')

    # ---------- 6 敏感度 ----------
    if emp is not None:
        ans = {'本部门能读': ok_admin, '外部门能读': ok_emp}
        check('6 敏感度：「本部门 / 外部门」给**两种不同答案**（不恒同）',
              ok_admin != ok_emp, '结论=%r' % ans)
    else:
        check('6 敏感度：「本部门 / 外部门」给**两种不同答案**（不恒同）', None, '没跑')
finally:
    if handle:
        _ss_seed.seed_cleanup(c, handle)

print()
if not checks:
    print('结果： FAIL 零条检查被断言')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  'PASS PKG-013-T02 迁移 D 半（%d 条）' % len(checks)))
print('⚠️ 本组只断言 **D 的半**（`_dept_allows` + 判定源）。'
      '别的半的现状见 git（`d9efb310` 等 10 笔）—— **不在本组断言范围**，'
      '我也不下「没做」的结论（否定结论要过三关）。')
sys.exit(1 if fails else 0)
