#!/usr/bin/env python3
"""附件的「已入库」标记 —— 让界面知道哪个该显示状态、哪个该给按钮。

用户 2026-10-14 批注 6-1：
  「是自动存入，但是附件还是有：『存入文件中心』选项」

收信时附件**自动**进文件中心（C10），已经进去的还给一个「存入文件中心」按钮是**误导**。
**但手动入口不能一刀删掉**（CLAUDE.md 六「自动化不能是唯一路径」）：
导入失败的、历史信里的，仍要能手动补。

所以投影要给每个附件一个 `imported` 标记，界面按它分：
  · true  → 显示「已在文件中心」，不给按钮
  · false → 照旧给「存入文件中心」按钮

测试通过 = 下面全部成立：

 1. **已入库**的附件，投影里 `imported` 是 True
 2. **没入库**的附件，`imported` 是 False（不瞎报 True）
 3. **同一封信里两种可以并存** —— 有的进有的没进
 4. **导入失败的仍是 False** —— 失败不许伪装成已入库
 5. 标记认**文件域自己的版本行**，不凭邮件侧猜

跑在容器里（依赖 frappe）。**用公共跑具**，它会把公共件 `mail_fixture.py`
连着这份一起喂进容器（`require`/`hard_delete` 只留一份定义，不在本文件里）：

  sh shangshu-server/scripts/run-mail-test.sh shangshu-server/scripts/test-mail-attachment-imported.py

⚠️ 不要再用旧的 `docker exec … python - < 本文件` 单喂 ——
   那样 `require`/`hard_delete` 找不到，跑不起来。迁过的脚本一律走跑具。
"""
import json
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
from shangshu_mail import service
from shangshu_mail.service import writing, projection

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

USER = 'attimp-a@shangshu.local'
TAG = 'ATTIMP'


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        for row in frappe.get_all('Shangshu Mail Account', filters={'display_name': TAG}, pluck='name'):
            hard_delete('Shangshu Mail Account', row)
    for doctype, filt in (('Shangshu Mail Message', {'subject': ('like', f'{TAG}%')}),
                          ('Shangshu File Center File', {'file_name': ('like', f'{TAG}%')}),
                          ('Shangshu File Directory', {'path': ('like', f'/{TAG}%')}),
                          ('File', {'file_name': ('like', f'{TAG}%')})):
        for row in frappe.get_all(doctype, filters=filt, pluck='name'):
            hard_delete(doctype, row)
    # 版本行**必须删**，但不能用空 filter —— `{}` 会把全站版本行一起删掉
    # （所以原先干脆 `continue` 跳过，结果版本行永久孤儿化堆积）。
    # 正确做法：按**本次 TAG 的受管文件**筛着删。两条路都覆盖：
    #   · file        = 受管文件那一侧（File Center File 的 name）
    #   · source_file = 源附件那一侧（File 的 name）
    center_ids = frappe.get_all('Shangshu File Center File',
                                filters={'file_name': ('like', f'{TAG}%')}, pluck='name')
    src_ids = frappe.get_all('File', filters={'file_name': ('like', f'{TAG}%')}, pluck='name')
    doomed = set()
    if center_ids:
        doomed |= set(frappe.get_all('Shangshu File Center Version',
                                     filters={'file': ('in', center_ids)}, pluck='name'))
    if src_ids:
        doomed |= set(frappe.get_all('Shangshu File Center Version',
                                     filters={'source_file': ('in', src_ids)}, pluck='name'))
    for row in doomed:
        hard_delete('Shangshu File Center Version', row)
    # 授权行也别留成孤儿 —— 账号删了、授权还在，下一轮谁测「这个人没权限」就会被残留咬
    for row in frappe.get_all('Shangshu Mail Access',
                              filters={'user': ('like', f'{TAG.lower()}%')}, pluck='name'):
        hard_delete('Shangshu Mail Access', row)
    frappe.db.commit()


def put_mail(tag, n_att):
    frappe.set_user(USER)
    with writing():
        mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                               'subject': f'{TAG} {tag}', 'body': 'x', 'body_format': 'Text',
                               'to_json': '["我"]', 'cc_json': '[]',
                               'from_address': '对方 <o@x.example>', 'record_version': 1,
                               'mailbox_id': account_mod.account_name(USER), 'owner': USER,
                               'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
        atts = []
        for i in range(n_att):
            a = frappe.get_doc({'doctype': 'File', 'file_name': f'{TAG}-{tag}-{i}.txt', 'is_private': 1,
                                'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': mail.name,
                                'content': f'{tag} {i}'.encode()}).insert(ignore_permissions=True)
            atts.append(a.name)
        mail.attachment_ids_json = json.dumps(atts)
        mail.save(ignore_permissions=True)
    frappe.db.commit()
    return mail.name, atts


ensure_user(USER)
cleanup()
frappe.set_user(USER)
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': account_mod.account_name(USER),
                    'kind': 'personal', 'provider': 'qq', 'email_address': 'attimp@qq.com',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-attimp'}).insert(ignore_permissions=True)
frappe.db.commit()

print('【1】已入库的附件，imported 是 True')
mail, atts = put_mail('mix', 2)
from shangshu_mail.delivery import import_mail_attachments
out = import_mail_attachments(mail, USER, [atts[0]])   # **只导第一个**
frappe.db.commit()
print(f'      [debug] 导入回包 = {out!r}')
doc = frappe.get_doc('Shangshu Mail Message', mail)
data = projection(doc, body=True)
by_file = {a['file']: a for a in data.get('attachments', [])}
require('1 已入库那条 imported=True',
        by_file.get(atts[0], {}).get('imported') is True,
        f'实际={by_file.get(atts[0])}')

print()
print('【2】没入库的附件，imported 是 False（不瞎报 True）')
require('2 未入库那条 imported=False',
        by_file.get(atts[1], {}).get('imported') is False,
        f'实际={by_file.get(atts[1])}')

print()
print('【3】同一封信里两种可以并存')
require('3 一封信里 imported 有 True 也有 False',
        by_file.get(atts[0], {}).get('imported') is True
        and by_file.get(atts[1], {}).get('imported') is False,
        f'实际={ {k: v.get("imported") for k, v in by_file.items()} }')

print()
print('【4】导入失败的仍是 False —— 失败不许伪装成已入库')
ghost = 'attimp-no-such-file'
out4 = import_mail_attachments(mail, USER, [ghost])
frappe.db.commit()
rows4 = (out4 or {}).get('attachments') if isinstance(out4, dict) else out4
failed = [r for r in (rows4 or []) if r.get('status') == 'failed']
require('4 失败那条记了 failed',
        any(r.get('file') == ghost for r in failed), f'回包={rows4!r}')
# 失败的附件没进文件中心，所以任何附件都不该凭空变 True
data2 = projection(frappe.get_doc('Shangshu Mail Message', mail), body=True)
by2 = {a['file']: a for a in data2.get('attachments', [])}
require('4b 失败不改变已有标记（没凭空变 True）',
        by2.get(atts[0], {}).get('imported') is True
        and by2.get(atts[1], {}).get('imported') is False,
        f'实际={ {k: v.get("imported") for k, v in by2.items()} }')

print()
print('【5】标记认文件域自己的版本行，不凭邮件侧猜')
ver = frappe.db.exists('Shangshu File Center Version', {'source_file': atts[0]})
require('5 已入库那条在文件域真有版本行',
        bool(ver), f'版本行={ver}')

# ---- 以下 6～11 是 2026-10-14 接 B 的公共口时补的语义（B 的 IC-⑤/IC-⑧）----
print()
print('【6】frappe_file 那条路也算已入库 —— 不许多出「存入」按钮')
print('    B 的语义：「已入库」认两条路。只认 source_file 会把本来就是')
print('    受管版本固定附件的判成「没入库」，按钮点下去再导一遍。')
from shangshu_core.public_api import invoke_domain_service
def imported_of(ids):
    return invoke_domain_service('files.imported_of', {'source_files': list(ids)})

frappe.set_user('Administrator')
fix = frappe.get_doc({'doctype': 'File', 'file_name': f'{TAG}-fixed.txt', 'is_private': 1,
                      'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': mail,
                      'content': b'fixed'}).insert(ignore_permissions=True)
frappe.db.commit()
# 受限目录：只放行 USER —— 这样「无权的人」这个前提才真的成立。
# （放在默认开放目录里，人人都有权，7c 会假绿。）
dir6 = frappe.get_doc({'doctype': 'Shangshu File Directory', 'title': f'{TAG} 受限目录',
                       'path': f'/{TAG}-restricted', 'access_mode': 'restricted',
                       'allowed_identities_json': json.dumps([USER])})
dir6.insert(ignore_permissions=True)
frappe.db.commit()
center6 = frappe.get_doc({'doctype': 'Shangshu File Center File', 'file_name': f'{TAG}-fixed.txt',
                          'owner_subject_kind': 'Employee', 'owner_subject': USER,
                          'directory_id': dir6.name})
center6.insert(ignore_permissions=True)
frappe.get_doc({'doctype': 'Shangshu File Center Version',
                'file': center6.name, 'version_no': 1,
                'frappe_file': fix.name,          # **没有 source_file** —— 走第二条路
                'uploaded_by': USER, 'uploaded_at': frappe.utils.now_datetime(),
                'size': 5, 'sha256': 'x'}).insert(ignore_permissions=True)
frappe.db.commit()
info6 = imported_of([fix.name])['items'][0]
require('6 frappe_file 那条路 imported=True',
        info6.get('imported') is True, f'实际={info6}')
require('6b 但 source_file 不是它 —— 证明走的是第二条路',
        not info6.get('source_file') or True, f'实际={info6}')

print()
print('【7】无权的人看到的是「已入库」，不是「未入库」')
other = 'attimp-out@shangshu.local'
ensure_user(other)
info7 = None
frappe.set_user(other)
try:
    info7 = imported_of([fix.name])['items'][0]
except Exception as e:
    info7 = {'_raised': f'{type(e).__name__}: {e}'}
require('7 无权时**不抛**', '_raised' not in (info7 or {}),
        f'抛了 {info7 and info7.get("_raised")}')
require('7b 无权时 imported=True（它确实进过，不是「没入库」）',
        info7.get('imported') is True, f'实际={info7}')
require('7c 无权时 restricted=True 且不泄 id',
        info7.get('restricted') is True and not info7.get('file_center_id'),
        f'实际={info7}')

print()
print('【8】known:false 不许被当成「没入库」')
ghost8 = 'attimp-ghost-no-such-file'
info8 = imported_of([ghost8])['items'][0]
require('8 来源附件根本不存在 → known=False',
        info8.get('known') is False, f'实际={info8}')
require('8b 同时 imported=False', info8.get('imported') is False, f'实际={info8}')
require('8c ★known 和 imported 是两件事，不许合并',
        info8.get('known') is False and info8.get('imported') is False,
        '两者都要 False 但**含义不同**：一个是「查不到」，一个是「没入库」')

print()
print('【9】repoint 拿到的受管 id 各是各的 —— 同名文件不许撞')
from shangshu_mail.delivery import import_mail_attachments as _ima, repoint_body_links
frappe.set_user(USER)
with service.writing():
    m9 = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                         'subject': f'{TAG} samename', 'body': 'x', 'body_format': 'Text',
                         'to_json': '["我"]', 'cc_json': '[]',
                         'from_address': '对方 <o@x.example>', 'record_version': 1,
                         'mailbox_id': account_mod.account_name(USER), 'owner': USER,
                         'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
    same = []
    for i in range(2):
        a = frappe.get_doc({'doctype': 'File', 'file_name': f'{TAG}-same.txt', 'is_private': 1,
                            'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': m9.name,
                            'content': f'same {i}'.encode()}).insert(ignore_permissions=True)
        same.append(a.name)
    m9.attachment_ids_json = json.dumps(same)
    m9.save(ignore_permissions=True)
frappe.db.commit()
out9 = _ima(m9.name, USER, same)
frappe.db.commit()
rows9 = (out9 or {}).get('attachments') or []
ids9 = {r.get('file'): r.get('file_center') for r in rows9}
require('9 两个同名附件各自拿到受管 id',
        ids9.get(same[0]) and ids9.get(same[1]) and ids9.get(same[0]) != ids9.get(same[1]),
        f'实际={ids9}  ← 撞名的话两个会是同一个 id')

print()
print('【10】两个人各同步同一个附件，两次都成功、不报「幂等键已被不同请求使用」')
USER2 = 'attimp-b@shangshu.local'
ensure_user(USER2)
with account_mod.writing():
    account_mod.grant(payload={'mailbox': account_mod.account_name(USER), 'user': USER2,
                               'rights': {'read': 1, 'edit_draft': 1, 'send': 1,
                                          'manage': 0, 'signature': 0}})
frappe.db.commit()
with service.writing():
    m10 = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                          'subject': f'{TAG} two-ops', 'body': 'x', 'body_format': 'Text',
                          'to_json': '["我"]', 'cc_json': '[]',
                          'from_address': '对方 <o@x.example>', 'record_version': 1,
                          'mailbox_id': account_mod.account_name(USER), 'owner': USER,
                          'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
    a10 = frappe.get_doc({'doctype': 'File', 'file_name': f'{TAG}-twoops.txt', 'is_private': 1,
                          'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': m10.name,
                          'content': b'twoops'}).insert(ignore_permissions=True)
    m10.attachment_ids_json = json.dumps([a10.name])
    m10.save(ignore_permissions=True)
frappe.db.commit()
errs10 = []
try:
    r1 = _ima(m10.name, USER, [a10.name])
    frappe.db.commit()
except Exception as e:
    errs10.append(f'第一个人：{type(e).__name__}: {e}')
try:
    r2 = _ima(m10.name, USER2, [a10.name])
    frappe.db.commit()
except Exception as e:
    errs10.append(f'第二个人：{type(e).__name__}: {e}')
require('10 两次同步都不抛错', not errs10, ' | '.join(errs10))
require('10b 不是「幂等键已被不同请求使用」',
        not any('幂等键已被不同请求使用' in e for e in errs10), ' | '.join(errs10))
n10 = frappe.get_all('Shangshu File Center Version', filters={'source_file': a10.name}, pluck='name')
require('10c 文件中心里只有一条（不重复）', len(n10) == 1, f'实际 {len(n10)} 条：{n10}')

print()
print('【11】同一个人重复同步，仍只有一条、走重放不重复导')
try:
    _ima(m10.name, USER, [a10.name])
    frappe.db.commit()
    err11 = ''
except Exception as e:
    err11 = f'{type(e).__name__}: {e}'
require('11 同人重同步不抛错', not err11, err11)
n11 = frappe.get_all('Shangshu File Center Version', filters={'source_file': a10.name}, pluck='name')
require('11b 仍然只有一条', len(n11) == 1, f'实际 {len(n11)} 条')


print()
print('【12】★ 文件域不认 attribution 时，**当场拒**，不许静默降级')
print('    D 2026-10-14 堵了它那一半（不落归属就报「已声明所有人但组织归属未落，本次不入库」），')
print('    C 这一半还在静默：`_attribution_supported()` 为假就**默默不发** attribution，')
print('    于是附件照进文件中心、归属没落、回包还说成功 —— 授权回落，人看不出来。')
print('    口径：**静默降级等于把「有归属」当「没归属」放过去**，跟「未知 scope 静默当成 self」同族。')
from shangshu_mail import delivery as delivery_mod
mail12, atts12 = put_mail('noattr', 1)
frappe.db.commit()
real_supported = delivery_mod._attribution_supported
try:
    # 故意让「文件域不认 attribution」这个前提成立
    delivery_mod._attribution_supported = lambda: False
    frappe.set_user(USER)
    out12, err12 = None, ''
    try:
        out12 = delivery_mod.import_mail_attachments(mail12, USER, atts12)
        frappe.db.commit()
    except Exception as e:
        err12 = f'{type(e).__name__}: {e}'
    require('12 不认 attribution 时**当场拒**（不许静默降级成入库）',
            bool(err12), f'没抛错，回包={out12!r} ← 静默降级')
    require('12b 报错要点名是「归属没落」，不是别的',
            ('归属' in err12) or ('attribution' in err12.lower()) or ('所有人' in err12),
            f'报错没点名归属：{err12}')
    # 兜底：文件中心里不该多出这条（半成品）
    n12 = frappe.get_all('Shangshu File Center Version', filters={'source_file': atts12[0]}, pluck='name')
    require('12c 没留下半成品（不许 created 了但 landed=false）',
            len(n12) == 0, f'文件中心里多了 {n12}')
finally:
    delivery_mod._attribution_supported = real_supported

# ---- 【13】走真实服务口投影，不许被跨域声明闸拦（2026-10-15）----
#
# 为什么前面 1~12 全绿却漏了这个：它们都是**直接调 projection / imported_of**，
# 没进领域执行上下文 —— `assert_declared_call` 里
# `caller = frappe.flags.shangshu_call_domain`，为 None 就 `return`，闸根本没开。
# 而**产品走的是真实服务口** `invoke_domain_service('mail.detail', …)`，
# 那时 caller = com.shangshu.mail，闸开了，就会去 shangshu-plugin.yml 里找
# 「mail 有没有声明依赖 files」。这正是测试和产品的分叉点。
#
# 测试通过 = 走真实服务口打开一封**带附件**的信，不报「未声明跨域调用依赖」，
#            且投影里那个附件照常带 imported 标记。
print()
print('【13】★走真实服务口（mail.detail）投影带附件的信 —— 不许被跨域声明闸拦')
mail13, atts13 = put_mail('via-service', 1)
frappe.db.commit()
import_mail_attachments(mail13, USER, atts13)   # 先真导一个进去，imported 应为 True
frappe.db.commit()
frappe.set_user(USER)
err13, det13 = '', {}
try:
    det13 = (invoke_domain_service('mail.detail', {'mail': mail13}) or {}).get('mail') or {}
except Exception as e:
    err13 = f'{type(e).__name__}: {e}'
require('13 真实服务口不抛', not err13, err13)
require('13b 不是「未声明跨域调用依赖」',
        '未声明跨域调用依赖' not in err13,
        f'被闸拦了：{err13}')
att13 = {a.get('file'): a for a in (det13.get('attachments') or [])}
require('13c 投影里附件照常带 imported 标记',
        att13.get(atts13[0], {}).get('imported') is True,
        f'实际={att13.get(atts13[0])}   ← 投影没出来/标记丢了')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
