#!/usr/bin/env python3
"""N5 真页面实测的**临时**夹具：给当前登录人开一个部门箱，好让 R5 有第二个箱可切。

用法：`n5-real-page-setup.py up` 建、`n5-real-page-setup.py down` 清。
**验完必须清掉**，不在客户库里留垃圾（同 SIG 真页面实测的做法）。

夹具用产品自己的受管写入（`account.writing()` / `account.access_writing()`），
不绕任何闸。授权走真实的 `mail.mailbox.grant` 动作。
"""
import sys
from pathlib import Path

_roots = [Path('/home/frappe/frappe-bench/apps'), Path.cwd()]
try:
    _roots.append(Path.cwd().parents[2])
except IndexError:
    pass
for _a in ('shangshu_mail', 'shangshu_core'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
from shangshu_mail import account

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

MARK = 'N5真页实测'


def up():
    """建一个部门箱 + 一封共享未读来信，并把**读+代发**开给当前登录人。"""
    user = 'Administrator'
    frappe.set_user(user)
    key = 'dept-n5realpage'
    if not frappe.db.exists('Shangshu Mail Account', {'account_key': key}):
        with account.writing():
            frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                            'kind': 'department', 'department': MARK,
                            'provider': 'qq', 'email_address': 'n5-realpage@shangshu.local',
                            'display_name': MARK, 'enabled': 1,
                            'connection_status': 'connected',
                            'binding_generation': 'gen-n5-fixture'}).insert(ignore_permissions=True)
    # 走真实授权动作（source=user）—— 正是平台那条路
    account.execute('mail.mailbox.grant',
                    {'mailbox': key, 'user': user, 'rights': {'read': True, 'send': True}},
                    {'source': 'user'})
    # ★R11 要的是「**非属主**、没管理权」的箱 —— 只读账号 ss-c@example.invalid
    #   （10-11 用户「给 c 开一个就行啦」，Desk User，无结构/管理权）。
    #   只开「阅读」，其余全不勾 —— `rights_for` 里属主恒全权，所以建箱的人自己验不了
    #   R11（脚本 R11 那段注释就是这么说的）。必须借一个不是属主的身份看。
    account.execute('mail.mailbox.grant',
                    {'mailbox': key, 'user': 'ss-c@example.invalid',
                     'rights': {'read': True}},
                    {'source': 'user'})
    # 一封**共享未读**来信 —— 双未读点要在真页面上看得见
    from shangshu_mail.service import writing
    if not frappe.db.exists('Shangshu Mail Message', {'subject': MARK + ' 双未读样本'}):
        with writing():
            frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                            'subject': MARK + ' 双未读样本', 'body': '正文', 'body_format': 'Text',
                            'to_json': '["我们 <n5-realpage@shangshu.local>"]', 'cc_json': '[]',
                            'from_address': '对方 <o@x.example>', 'record_version': 1,
                            'mailbox_id': key,
                            'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
    frappe.db.commit()
    print(key)


def down():
    """清掉夹具：先撤授权，再删账号行。

    账号 doctype 的 `on_trash` 故意不许删（「请解除邮箱绑定，不能直接删除配置历史」）——
    那是给**客户真实绑定**留的保护。这里是几分钟前造的测试夹具
    （账号键 `dept-n5realpage`，写死了名字），留着会混进邮箱列表像真的部门箱，
    所以直接清库删掉。**只删这个写死的键**，不碰任何别的邮箱。
    """
    key = 'dept-n5realpage'
    frappe.set_user('Administrator')
    with account.access_writing():
        for name in frappe.get_all('Shangshu Mail Access',
                                   filters={'mailbox': key}, pluck='name'):
            frappe.get_doc('Shangshu Mail Access', name).delete(ignore_permissions=True)
    # 夹具造的那封共享来信一并清掉（写死主题，不做模糊匹配）
    from shangshu_mail.service import writing
    with writing():
        for name in frappe.get_all('Shangshu Mail Message',
                                   filters={'subject': MARK + ' 双未读样本'}, pluck='name'):
            frappe.delete_doc('Shangshu Mail Message', name,
                              ignore_permissions=True, force=True)
    # 只删这个写死的夹具键，不做任何模糊匹配
    frappe.db.delete('Shangshu Mail Account', {'account_key': key})
    frappe.db.commit()
    left = frappe.db.exists('Shangshu Mail Account', {'account_key': key})
    print('cleaned' if not left else 'STILL-THERE')


if __name__ == '__main__':
    (up if (len(sys.argv) < 2 or sys.argv[1] == 'up') else down)()
    frappe.db.rollback()
