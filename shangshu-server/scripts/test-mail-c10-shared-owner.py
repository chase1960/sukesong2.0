#!/usr/bin/env python3
"""C10 归属规则：**个人箱归员工，共享箱归部门**。

执行计划 §C10 原话：
  「个人邮箱的附件归所属员工；共享邮箱的附件归所属部门，
    不归第一个打开邮件的人。」

上一版 `test-mail-c10-auto-import.py` 的 1-2 只验了个人箱那半边
（文件里写明「共享邮箱依赖 N5，按计划若尚缺不能冒报」）。N5 共享邮箱已交付，
这一份补上共享箱那半边。

字段权威语义见 字段字典#file-mail-system-fields：
  所有人 = 文件归属主体（员工ID或部门ID），**不是**发件人、不是收信服务、
  也不是第一个打开邮件的人。

测试通过 = 下面全部成立：

 1. **个人箱归员工** —— 收进个人箱的信，附件所有人 = 这个个人箱所属的员工
 2. **共享箱归部门** —— 收进部门箱的信，附件所有人 = 这个邮箱登记的所属部门
 3. **不归点同步的那个人** —— 共享箱附件的所有人**不是**执行同步的员工
 4. **部门名取自邮箱登记** —— 和 `Shangshu Mail Account.department` 一字不差
 5. **谁点同步不影响归属** —— 两人先后导同一封部门箱来信，附件只一条，
    所有人仍是那个部门（不因为后一个人重导就变）
 5b. **重导不留假警报** —— 第二个人再导同一条附件，失败日志**一条都不新增**。
    共享箱几个人各同步一次是常态，「已经归档过了」是成功，不是失败；
    假警报会把真失败淹掉
 6. **伪造防线不松** —— 普通请求带上 `mail_system` 仍然当场拒
 7. **列表投影带得走 Department** —— 读出来的 `owner_subject_kind` 就是 `Department`，
    不是空的、不是被折成 Employee

跑在容器里（依赖 frappe）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … python /tmp/…
"""
import sys
from pathlib import Path

_roots = [Path('/home/frappe/frappe-bench/apps'), Path.cwd()]
try:
    _roots.append(Path.cwd().parents[2])
except IndexError:
    pass
for _a in ('shangshu_mail', 'shangshu_core', 'shangshu_files'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
from shangshu_mail import account as account_mod
from shangshu_mail.service import writing

# 公共件 helper（require/ensure_user/PASS/FAIL）。**两用都要成立**：
# · 公共跑具把 mail_fixture.py 合进同一文件跑（见 mail_fixture.py 头部）——
#   名字已经在全局，这里 ImportError 什么都不用干；
# · 直接单跑本文件（python test-mail-c10-shared-owner.py）——显式从 scripts/ 引。
# 之前只写了名字没给来源，单跑就 NameError（3850 实测 ensure_user 崩在这）。
try:
    from mail_fixture import PASS, FAIL, require, ensure_user  # noqa: F401
except ImportError:
    for _p in (Path(__file__).resolve().parent, Path.cwd() / 'scripts', Path.cwd()):
        if (_p / 'mail_fixture.py').exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))
    from mail_fixture import PASS, FAIL, require, ensure_user  # noqa: F401

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

def notyet(label, why):
    """还没实现的判据 —— 明确记「未做」，不许写成通过。"""
    FAIL.append(label)
    print(f"  ✖ {label}  ← 未实现：{why}")


PERSON_KEY = 'c10so-personal'
DEPT_KEY = 'c10so-dept'
DEPT_NAME = 'C10归属测试部'
USER_A = ensure_user('c10so-a@shangshu.local', 'C10共享A')
USER_B = ensure_user('c10so-b@shangshu.local', 'C10共享B')

frappe.set_user('Administrator')
# 账号行**由邮箱属主自己建**（USER_A）——`rights_for` 认「账号行属主 = 这个邮箱的管理员」。
# 拿 Administrator 建的话属主是 Administrator，USER_A 反而没权限，个人箱那条就导不进去。
# 夹具**先提交**：`execute_registered_action` 的失败路径会 rollback 再落一行失败记账
# （动作自己的事务边界，是对的）。夹具不先落定就会被那把回滚卷走，
# 后面报出来的是「找不到执行身份」这种次生错误，把真正要验的盖住。
frappe.set_user(USER_A)
with account_mod.writing():
    for key, kind, dept, addr in (
        (PERSON_KEY, 'personal', '', 'c10so-personal@shangshu.local'),
        (DEPT_KEY, 'department', DEPT_NAME, 'c10so-dept@shangshu.local'),
    ):
        if not frappe.db.exists('Shangshu Mail Account', {'account_key': key}):
            frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                            'kind': kind, 'department': dept,
                            'provider': 'qq', 'email_address': addr,
                            'display_name': 'C10归属测试', 'enabled': 1,
                            'connection_status': 'connected',
                            'binding_generation': 'gen-c10so'}).insert(ignore_permissions=True)

mails, atts = {}, {}
# 夹具按**生产那条路**造：谁跑的收信，那封信就记在谁名下（收信是收信人自己的动作）。
#   · 个人箱：属主 USER_A 同步自己的箱 → 信记在 USER_A 名下
#   · 部门箱：成员 USER_B 同步部门箱 → 信记在 USER_B 名下
# 归属该跟**邮箱**走，所以个人箱那条的附件仍应是 USER_A，部门箱那条应是部门。
# 另给 USER_A 开部门箱的读权，好让「谁点同步不影响归属」那条真能两个人各导一次。
account_mod.execute('mail.mailbox.grant',
                    {'mailbox': DEPT_KEY, 'user': USER_A,
                     'rights': {'read': True, 'send': True}},
                    {'source': 'user'})
account_mod.execute('mail.mailbox.grant',
                    {'mailbox': DEPT_KEY, 'user': USER_B,
                     'rights': {'read': True, 'send': True}},
                    {'source': 'user'})
with writing():
    for tag, box, owner in (('personal', PERSON_KEY, USER_A), ('dept', DEPT_KEY, USER_B)):
        m = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                            'subject': f'C10归属 {tag}', 'body': 'x', 'body_format': 'Text',
                            'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
                            'from_address': '对方 <other@x.example>', 'record_version': 1,
                            'mailbox_id': box, 'owner': owner,
                            'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
        a = frappe.get_doc({'doctype': 'File', 'file_name': f'归属-{tag}.txt', 'is_private': 1,
                           'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': m.name,
                           'content': f'attachment {tag}'.encode()}).insert(ignore_permissions=True)
        mails[tag], atts[tag] = m.name, a.name

frappe.db.commit()

print('=== C10 归属规则：个人箱归员工，共享箱归部门 ===\n')

try:
    from shangshu_mail import delivery as delivery_mod
except Exception as exc:
    print(f'  （拿不到 shangshu_mail.delivery：{str(exc)[:80]}）')
    delivery_mod = None

if delivery_mod is None:
    notyet('1-0 收信入库入口可用', 'shangshu_mail.delivery 不可用')
else:
    # ── 1 个人箱：归这个箱所属的员工 ──────────────────────────────────────
    delivery_mod.import_mail_attachments(mails['personal'], USER_A, [atts['personal']])
    rows = frappe.get_all('Shangshu File Center File',
                          filters={'related_mail': mails['personal']},
                          fields=['name', 'owner_subject_kind', 'owner_subject'], limit_page_length=5)
    row_p = rows[0] if rows else None
    require('1 收信后附件自动进入文件中心（个人箱）', bool(row_p), f'文件中心里没有：{rows}')
    if row_p:
        from shangshu_core.identity import ensure_identity_for_user
        emp_key = ensure_identity_for_user(USER_A)
        require('1-2 个人箱附件归**邮箱所属员工**（键=员工ID，UI-054 统一口径）',
                row_p.owner_subject_kind == 'Employee' and row_p.owner_subject == emp_key,
                f"实际 kind={row_p.owner_subject_kind!r} subject={row_p.owner_subject!r}"
                f"（期望员工ID {emp_key!r}，邮箱属主 {USER_A}；登录名是老口径，筛选会筛出 0）")

    # ── 2 / 3 / 4 共享箱：归部门，不归点同步的那个人 ───────────────────────
    # 收信的是 USER_B（部门箱成员），但归属应是**部门**。
    delivery_mod.import_mail_attachments(mails['dept'], USER_B, [atts['dept']])
    rows_d = frappe.get_all('Shangshu File Center File',
                            filters={'related_mail': mails['dept']},
                            fields=['name', 'owner_subject_kind', 'owner_subject'], limit_page_length=5)
    row_d = rows_d[0] if rows_d else None
    require('2 收信后附件自动进入文件中心（共享箱）', bool(row_d), f'文件中心里没有：{rows_d}')
    if row_d:
        require('2-2 共享箱附件归**所属部门**',
                row_d.owner_subject_kind == 'Department',
                f"实际 kind={row_d.owner_subject_kind!r} subject={row_d.owner_subject!r}"
                f"（期望 kind='Department' subject={DEPT_NAME!r}）")
        require('3 不归点同步的那个人',
                row_d.owner_subject != USER_B and row_d.owner_subject != USER_A,
                f"实际所有人 = {row_d.owner_subject!r}，"
                f"点同步的是 {USER_B}、邮箱属主是 {USER_A}")
        require('4 部门名取自邮箱登记，一字不差',
                row_d.owner_subject == DEPT_NAME,
                f"实际 {row_d.owner_subject!r} vs 邮箱登记 {DEPT_NAME!r}")
    else:
        notyet('2-2 共享箱附件归所属部门', '2 没过，无从查起')
        notyet('3 不归点同步的那个人', '2 没过，无从查起')
        notyet('4 部门名取自邮箱登记，一字不差', '2 没过，无从查起')

    # ── 5 / 5b 谁点同步不影响归属，且不留假警报 ───────────────────────────
    # USER_A 再导一次同一封部门箱来信。应回到同一条，且所有人**还是那个部门** ——
    # 不许被后来的人改掉（import_attachment 里「补齐而不是覆盖」那条正是为这个）。
    logs_before = frappe.db.count('Error Log', {'method': '来信附件自动入库失败'})
    delivery_mod.import_mail_attachments(mails['dept'], USER_A, [atts['dept']])
    logs_after = frappe.db.count('Error Log', {'method': '来信附件自动入库失败'})
    rows_d2 = frappe.get_all('Shangshu File Center File',
                             filters={'related_mail': mails['dept']},
                             fields=['name', 'owner_subject_kind', 'owner_subject'], limit_page_length=5)
    only_one = [x['name'] for x in rows_d2] == ([row_d['name']] if row_d else [])
    still_dept = bool(rows_d2) and rows_d2[0].owner_subject_kind == 'Department' \
        and rows_d2[0].owner_subject == DEPT_NAME
    require('5 谁点同步不影响归属（重导不多建、不改所有人）',
            only_one and still_dept,
            f'实际 {[(x["owner_subject_kind"], x["owner_subject"]) for x in rows_d2]}，'
            f'条数 {len(rows_d2)}（期望 1 条且仍是 {DEPT_NAME!r}）')
    require('5b 重导不留假警报（失败日志一条都不新增）',
            logs_after == logs_before,
            f'失败日志从 {logs_before} 条涨到 {logs_after} 条 —— '
            f'「已经归档过了」被当成了失败，假警报会把真失败淹掉')

    # ── 6 伪造防线不松 ──────────────────────────────────────────────────
    # 走**用户那条路**（公共动作入口，不在受管收信上下文里）带 mail_system。
    # 这一步故意失败，动作入口会 rollback 再落失败记账 —— 夹具已提交，卷不走。
    frappe.db.commit()
    frappe.set_user(USER_B)
    from shangshu_core.public_api import execute_registered_action
    try:
        execute_registered_action('files.import_attachment', {
            'source': {'ref_doctype': 'Shangshu Mail Message',
                       'ref_name': mails['dept'], 'file': atts['dept']},
            'directory': '/来信附件',
            'mail_system': {'owner_subject_kind': 'Department', 'owner_subject': '伪造的部门'}},
            confirmed=True, idempotency_key='c10so-forge-' + frappe.generate_hash(length=8))
        require('6 改请求伪造所有人换不掉', False, '居然接受了客户端指定的所有人')
    except Exception as exc:
        require('6 改请求伪造所有人换不掉', '所有人' in str(exc) or '推导' in str(exc),
                f'拒了但理由不对：{str(exc)[:100]}')

    # ── 7 列表投影带得走 Department ─────────────────────────────────────
    from shangshu_files.domain import query as files_query
    frappe.set_user(USER_A)
    hit = files_query('files.file', {'related_mail': mails['dept']}, 1, 30)
    r0 = (hit.get('rows') or [{}])[0]
    require('7 列表投影带得走 Department（不是空的、不是被折成 Employee）',
            r0.get('owner_subject_kind') == 'Department' and r0.get('owner_subject') == DEPT_NAME,
            f"实际 kind={r0.get('owner_subject_kind')!r} subject={r0.get('owner_subject')!r}"
            f"；返回键={sorted(r0)}")

print(f"\n{'=' * 60}")
print(f"通过 {len(PASS)} 条，未过 {len(FAIL)} 条")
if FAIL:
    print('未过：')
    for f in FAIL:
        print(f'  - {f}')

# ── 清夹具：提交过的不能靠 rollback 收摊，显式删 ─────────────────────────
try:
    frappe.set_user('Administrator')
    for doctype, filters in (
        ('Shangshu Action Request', {'action_id': 'files.import_attachment'}),
        ('Shangshu Action Execution Audit', {'action_id': 'files.import_attachment'}),
    ):
        for name in frappe.get_all(doctype, filters=filters, pluck='name'):
            try:
                frappe.delete_doc(doctype, name, ignore_permissions=True, force=True)
            except Exception:
                pass
    for mail_name in mails.values():
        for name in frappe.get_all('Shangshu File Center File',
                                   filters={'related_mail': mail_name}, pluck='name'):
            try:
                frappe.delete_doc('Shangshu File Center File', name, ignore_permissions=True, force=True)
            except Exception:
                pass
        try:
            frappe.delete_doc('Shangshu Mail Message', mail_name, ignore_permissions=True, force=True)
        except Exception:
            frappe.db.delete('Shangshu Mail Message', {'name': mail_name})
    with account_mod.writing():
        for name in frappe.get_all('Shangshu Mail Account',
                                   filters={'account_key': ['in', (PERSON_KEY, DEPT_KEY)]}, pluck='name'):
            try:
                frappe.delete_doc('Shangshu Mail Account', name, ignore_permissions=True, force=True)
            except Exception:
                frappe.db.delete('Shangshu Mail Account', {'name': name})
    for user in (USER_A, USER_B):
        for identity in frappe.get_all('Shangshu Identity', filters={'user': user}, pluck='name'):
            try:
                frappe.delete_doc('Shangshu Identity', identity, ignore_permissions=True, force=True)
            except Exception:
                pass
        if frappe.db.exists('User', user):
            frappe.delete_doc('User', user, ignore_permissions=True, force=True)
    frappe.db.commit()
    print(f'夹具已清掉（账号键 {PERSON_KEY} / {DEPT_KEY}）')
except Exception as cleanup_error:
    frappe.db.rollback()
    print(f'夹具清理失败，需人工清 {PERSON_KEY} / {DEPT_KEY}：{str(cleanup_error)[:150]}')

sys.exit(1 if FAIL else 0)
