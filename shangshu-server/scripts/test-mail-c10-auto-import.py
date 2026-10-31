#!/usr/bin/env python3
"""C10 来信附件自动进入文件中心 + 所有人/关联邮件两个系统字段。

执行计划 §C10（2026-10-13 用户修订，取代上一版手动「存入」方案）：
  「收到的普通附件自动进入文件中心，不做『存入』按钮、目标选择或确认弹窗，
    不依赖任何员工先打开邮件。个人邮箱的附件归所属员工；共享邮箱的附件归所属部门，
    不归第一个打开邮件的人。」

字段权威语义见 字段字典#file-mail-system-fields；权限见 账号与权限#mail-attachment-access。

测试通过 = 下面全部成立：

 1. **自动入库**：受控收信拿到附件后，文件中心里**直接出现**对应文件 ——
    不打开邮件、不点任何保存入口。关联邮件指向收到的那封信。
 2. **所有人按邮箱归属推导**：个人邮箱的附件 → 归**邮箱所属员工**；
    共享邮箱的附件 → 归**所属部门**，不归收信执行者、不归发件人、不归第一个打开的人。
 3. **服务端筛选**：按「所有人」「关联邮件」及两者组合筛，只出有权看到的；
    筛选在服务端做，不是前端把别人藏起来。
 4. **幂等**：同一封信重收、同一附件重试，文件中心**只多一条**，不重复。
 5. **伪造被拒**：改请求里的所有人/关联邮件**换不掉** —— 服务端从邮箱归属推导，
    不信客户端传的值。
 6. **不放宽权限**：不能因为有了这两个字段就让没权的人看到文件。

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
from shangshu_mail.service import writing

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

def ok(label, detail=''):
    PASS.append(label)
    print(f"  ✔ {label}" + (f"  ← {detail}" if detail else ''))


def notyet(label, why):
    """还没实现的判据 —— 明确记「未做」，不许写成通过。"""
    FAIL.append(label)
    print(f"  ✖ {label}  ← 未实现：{why}")


print('=== 0 现状盘点：C10 需要的能力现在有没有 ===')

# 0-1 文件记录上有没有「所有人 / 关联邮件」这两个系统字段
FILE_DT = 'Shangshu File Center File'
file_meta = frappe.get_meta(FILE_DT) if frappe.db.exists('DocType', FILE_DT) else None
field_names = {f.fieldname for f in (file_meta.fields if file_meta else [])}
has_owner_field = 'owner_subject' in field_names and 'owner_subject_kind' in field_names
has_mail_field = 'related_mail' in field_names
print(f'    {FILE_DT} 里 mail/owner 相关字段：'
      f'{sorted(n for n in field_names if "mail" in n.lower() or "owner" in n.lower() or "belong" in n.lower())}')

require('0-1 文件记录上有「所有人」系统字段', has_owner_field,
        '还没有 —— 字段字典#file-mail-system-fields 要求服务端推导、员工不能改')
require('0-2 文件记录上有「关联邮件」系统字段', has_mail_field,
        '还没有 —— 同上')

# 0-2 收信路径有没有自动入库（不是靠员工点「存入」）
from pathlib import Path as _P
delivery_src = (_P('/home/frappe/frappe-bench/apps/shangshu_mail/shangshu_mail/delivery.py')
                .read_text(encoding='utf-8') if _P('/home/frappe/frappe-bench/apps/shangshu_mail/shangshu_mail/delivery.py').exists() else '')
auto_imports = ('import_attachment' in delivery_src) or ('files.import_attachment' in delivery_src)
require('0-3 收信路径已经自动把附件送进文件中心', auto_imports,
        '还没有 —— 现在只挂在邮件记录上，要员工打开邮件点「存入文件中心」才进')

# 0-3 服务端有没有按这两个字段筛选
files_service = (_P('/home/frappe/frappe-bench/apps/shangshu_files/shangshu_files/service.py')
                 .read_text(encoding='utf-8') if _P('/home/frappe/frappe-bench/apps/shangshu_files/shangshu_files/service.py').exists() else '')
can_filter = ('related_mail' in files_service) or ('owner_subject' in files_service) or ('belong_to' in files_service)
require('0-4 文件列表支持按所有人/关联邮件在服务端筛选', can_filter,
        '还没有 —— 计划要求「字段是判断依据，不是只在浏览器隐藏」')

print('\n=== 1 行为：收信后附件自动入库 + 两字段填对 ===')

# 只验**真实链**：个人邮箱。共享邮箱依赖 N5，按计划「若尚缺不能冒报」。
#
# 这一段调的是**生产同一条路**：delivery.import_mail_attachments ——
# 收信那边把这个函数丢后台跑。测试直接调它，就和真收信走的一模一样，
# 不另造一条「测试专用」的调用方式（那样测出来的不算数）。
try:
    from shangshu_mail import delivery as delivery_mod
    HAS_FILES = True
except Exception as exc:
    HAS_FILES = False
    print(f'    （拿不到 shangshu_mail.delivery：{str(exc)[:60]}）')

mail_name = ''
if not HAS_FILES:
    notyet('1-0 收信入库入口可用', 'shangshu_mail.delivery 不可用')
else:
    USER = 'c10-owner@shangshu.local'
    if not frappe.db.exists('User', USER):
        frappe.get_doc({'doctype': 'User', 'email': USER, 'first_name': 'C10归属',
                        'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    frappe.set_user(USER)
    # 夹具**先落定**：公共动作入口在失败路径上会 `frappe.db.rollback()` 再落一行失败记账并提交
    # —— 那是动作自己的事务边界，是对的。但测试整段跑在一个未提交事务里，
    # 夹具被那把回滚一起卷走，随后报出来的就是「找不到执行身份」这种**次生错误**，
    # 把真正要验的「伪造被拒」盖住了（实测 1-6 就栽在这）。
    # 所以身份/账号夹具先提交，最后统一清掉。
    frappe.db.commit()

    with writing():
        mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
            'subject': 'C10 来信', 'body': 'x', 'body_format': 'Text',
            'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
            'from_address': '对方 <other@x.example>', 'record_version': 1,
            'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
        mail_name = mail.name
        att = frappe.get_doc({'doctype': 'File', 'file_name': '来信附件.txt', 'is_private': 1,
            'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': mail.name,
            'content': b'hello attachment'}).insert(ignore_permissions=True)

    # 生产那条路：收信提交后把这个函数丢后台跑。
    delivery_mod.import_mail_attachments(mail.name, USER, [att.name])
    r = frappe.get_all('Shangshu File Center File',
                       filters={'related_mail': mail.name}, fields=['name'], limit_page_length=1)
    file_name = r[0]['name'] if r else ''
    require('1-1 收信后附件自动进入文件中心（不打开邮件、不点保存）',
            bool(file_name), f'文件中心里没有关联到这封信的文件：{r}')
    if file_name:
        row = frappe.get_doc('Shangshu File Center File', file_name)
        require('1-2 所有人 = 邮箱所属员工',
                row.owner_subject_kind == 'Employee' and row.owner_subject == USER,
                f'实际 kind={row.owner_subject_kind!r} subject={row.owner_subject!r}')
        require('1-3 关联邮件 = 实际收到的那封信', row.related_mail == mail.name,
                f'实际 related_mail={row.related_mail!r}')
    else:
        notyet('1-2 所有人 = 邮箱所属员工', '1-1 没过，无从查起')
        notyet('1-3 关联邮件 = 实际收到的那封信', '1-1 没过，无从查起')

    # 1-4 服务端筛选
    frappe.set_user(USER)
    from shangshu_files.domain import query as files_query
    hit = files_query('files.file', {'owner_subject': USER, 'related_mail': mail.name}, 1, 30)
    names = [x['name'] for x in hit['rows']]
    require('1-4 按所有人+关联邮件在服务端筛得到它', file_name in names, f'筛出 {names}')
    miss = files_query('files.file', {'owner_subject': 'someone-else-xyz'}, 1, 30)
    require('1-4b 筛别人筛不到它', file_name not in [x['name'] for x in miss['rows']],
            f'筛出 {[x["name"] for x in miss["rows"]]}')

    # 1-5 幂等：同一封信同一附件再导一次，**只多一条**（不看回执，数库里的条数）
    delivery_mod.import_mail_attachments(mail.name, USER, [att.name])
    again = frappe.get_all('Shangshu File Center File',
                           filters={'related_mail': mail.name}, fields=['name'], limit_page_length=5)
    require('1-5 同一附件重试不多建一条',
            [x['name'] for x in again] == [file_name],
            f'库里有 {len(again)} 条：{[x["name"] for x in again]}')

    # 1-6 伪造被拒：走**用户那条路**（公共动作入口，不在受管收信上下文里）带 mail_system
    # 这一步**故意失败**，而公共动作入口失败时会 `frappe.db.rollback()` 再落一行失败记账
    # （动作自己的事务边界，是对的）。但邮件/文件夹具还没提交的话会被那把回滚一起卷走，
    # 后面 1-7 就只能看到空结果。所以先落定夹具，最后统一清。
    frappe.db.commit()
    frappe.set_user(USER)
    from shangshu_core.public_api import execute_registered_action
    try:
        execute_registered_action('files.import_attachment', {
            'source': {'ref_doctype': 'Shangshu Mail Message', 'ref_name': mail.name, 'file': att.name},
            'directory': '/来信附件',
            'mail_system': {'owner_subject_kind': 'Employee', 'owner_subject': '伪造的人'}},
            confirmed=True, idempotency_key='c10-forge-' + frappe.generate_hash(length=8))
        require('1-6 改请求伪造所有人换不掉', False, '居然接受了客户端指定的所有人')
    except Exception as exc:
        require('1-6 改请求伪造所有人换不掉', '所有人' in str(exc) or '推导' in str(exc),
                f'拒了但理由不对：{str(exc)[:80]}')

    # 1-7 列表返回里**必须带**这三个键 —— A 联调实测报出的漏：
    # 筛选做得了（服务端收这三个键），但返回投影里没带 → 前端读不出值，列表上没法显示。
    # 「筛得了但读不出」等于没做。这里钉住返回面，不只是筛得出。
    frappe.set_user(USER)
    hit2 = files_query('files.file', {'related_mail': mail_name}, 1, 30)
    row0 = (hit2.get('rows') or [{}])[0]
    missing = [k for k in ('owner_subject_kind', 'owner_subject', 'related_mail') if k not in row0]
    require('1-7 列表返回里带得走「所有人/关联邮件」三个键（不能只筛不能读）',
            not missing, f'返回里缺 {missing}；实际键={sorted(row0)}')
    if not missing:
        require('1-7b 返回值和填进去的一致',
                row0['owner_subject_kind'] == 'Employee' and row0['owner_subject'] == USER
                and row0['related_mail'] == mail_name,
                f"实际 kind={row0['owner_subject_kind']!r} subject={row0['owner_subject']!r} mail={row0['related_mail']!r}")
    else:
        notyet('1-7b 返回值和填进去的一致', '1-7 没过，无从查起')

print(f"\n{'='*60}")
print(f"通过 {len(PASS)} 条，未过 {len(FAIL)} 条")
if FAIL:
    print('未过（都是「还没做」，不是回归）：')
    for f in FAIL:
        print(f'  - {f}')

# 夹具是**提交过**的（见上方说明），不能靠 rollback 收摊 —— 显式清掉，别在客户库里留垃圾。
try:
    frappe.set_user('Administrator')
    for doctype, filters in (
        ('Shangshu Action Request', {'action_id': 'files.import_attachment'}),
        ('Shangshu Action Execution Audit', {'action_id': 'files.import_attachment'}),
    ):
        for row in frappe.get_all(doctype, filters=filters, pluck='name'):
            try:
                frappe.delete_doc(doctype, row, ignore_permissions=True, force=True)
            except Exception:
                pass
    for doctype, field, value in (
        ('Shangshu File Center File', 'related_mail', mail_name),
        ('Shangshu Mail Message', 'name', mail_name),
    ):
        for row in frappe.get_all(doctype, filters={field: value}, pluck='name'):
            try:
                frappe.delete_doc(doctype, row, ignore_permissions=True, force=True)
            except Exception:
                pass
    for identity in frappe.get_all('Shangshu Identity', filters={'user': USER}, pluck='name'):
        try:
            frappe.delete_doc('Shangshu Identity', identity, ignore_permissions=True, force=True)
        except Exception:
            pass
    frappe.delete_doc('User', USER, ignore_permissions=True, force=True) if frappe.db.exists('User', USER) else None
    frappe.db.commit()
    print('夹具已清掉（提交过的夹具不能靠 rollback 收摊）')
except Exception as cleanup_error:
    frappe.db.rollback()
    print(f'夹具清理失败，需要人工删掉测试账号 {USER}：{str(cleanup_error)[:120]}')

sys.exit(1 if FAIL else 0)
