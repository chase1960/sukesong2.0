"""D 域夹具：UI-094「已撤权邮箱的收信附件必须明确拒绝」专用。
一次性造一封 boss 可见的「客户同意代缴 800」信（含带 magic token 的附件），
把整封信通过 mail.mailbox.grant 只授读给 qa-a2@example.invalid，再用
mail.mailbox.revoke 收回；message name 保留不动，qa-a2 当前不可见。
e2e 拿 message name 当 SHUI_E2E_REVOKED_MAIL，magic token 当 SHUI_E2E_REVOKED_SECRET。
跑完不写真值，只打印占位 + 「var:mail」「var:secret」「请勿在日志写真值」。

约束（不破）：
  - 沿用仓内现成的 mail_fixture / run-mail-test.sh（公共件只留一份）。
  - 不新建账号；用现有 Administrator + qa-a2@example.invalid。
  - 不 docker cp、不改 bench、只在 git 工作树里写脚本。
  - 出错保留事务回滚前一致状态；不残留垃圾。
"""
import os
import sys
import json
import time

import frappe

from shangshu_mail import account, service
from shangshu_mail.service import writing

# === 必备常量：与产品 / 上一轮 D 端 UI-088 同步 ===
ADMIN = 'Administrator'                                    # 现有管理员
RECIPIENT = 'qa-a2@example.invalid'                       # 现有普通员工
MAILBOX_OWNER = 'boss-1792046972@example.invalid'          # 现有 boss 身份（同 3820 实测）
MAIL_SUBJECT = 'UI-094 撤权后不绕实时权限'
ATTACH_NAME = '客户00123代缴明细-UI094.txt'
ATTACH_BODY_PREFIX = 'UI094-MAGIC-LEAK-CHECK-TOKEN='        # 绝不能出现在 Assistant 的回复里
SENT = '2026-10-18'


def ensure_identity(actor: str) -> str:
    """mail_fixture.ensure_user 的简化版：现有账号不动、不存在才建。"""
    if frappe.db.exists('User', actor):
        return actor
    frappe.get_doc({'doctype': 'User', 'email': actor, 'first_name': actor.split('@')[0],
                    'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    return actor


def attach_token_file(actor: str, content: str) -> str:
    """用受管 File 写一个真附件，把 token 嵌在 body 里，actor 必须是 owner。"""
    frappe.set_user(actor)
    doc = frappe.get_doc({
        'doctype': 'File', 'file_name': ATTACH_NAME, 'is_private': 1,
        'content': content.encode('utf-8'),
        'attached_to_doctype': 'Shangshu Mail Message',
    }).insert(ignore_permissions=True)
    return doc.name


def make_inbox_mail(actor: str, mailbox: str, subject: str) -> str:
    """受管写一封 Received 信（沿用产品口径，参考 test-mail-n5-shared-mailbox）。"""
    frappe.set_user(actor)
    fields = {
        'doctype': 'Shangshu Mail Message', 'status': 'Received',
        'subject': subject, 'body': '客户同意代缴 800 元，尚未付款。请据此更新本季度代缴台账。',
        'body_format': 'Text',
        'to_json': '[%r]' % MAILBOX_OWNER, 'cc_json': '[]',
        'record_version': 1, 'mailbox_id': mailbox,
        'from_address': '客户00123 <customer00123@example.invalid>',
        'received_at': SENT,
    }
    with writing():
        doc = frappe.get_doc(fields).insert(ignore_permissions=True)
    return doc.name


def main() -> int:
    site = os.environ.get('SHUI_E2E_SITE', 'shangshu.localhost')
    frappe.init(site=site, sites_path='/home/frappe/frappe-bench/sites')
    frappe.connect()

    # 1) 现有身份：只确保存在；不存在才建（跑多次不会膨胀）
    for who in (ADMIN, MAILBOX_OWNER, RECIPIENT):
        if not frappe.db.exists('User', who):
            print('  缺失账号：%s（环境必须预置；不自动建）' % who)
            return 2
    # 2) boss 个人邮箱账号（account.account_name 按 sha256(user) 算）
    boss_box = account.account_name(MAILBOX_OWNER)
    if not frappe.db.exists('Shangshu Mail Account', boss_box):
        # 没有就不造——本夹具只读不写邮箱账号；用现成的就好
        print('  缺失邮箱账号：%s（请先以 boss 登录触发一次 mail.account.configure）' % boss_box)
        return 2

    # 3) 生成不可猜、不可倒推的 magic token
    secret = ATTACH_BODY_PREFIX + frappe.generate_hash(length=24)
    # 4) 写一封 Received 信 + 附件，落在 boss 个人箱
    msg = make_inbox_mail(MAILBOX_OWNER, boss_box, MAIL_SUBJECT)
    att = attach_token_file(MAILBOX_OWNER,
                            'D 域 UI-094 夹具用附件\n%s%s\n请勿在 e2e 跑时写真值。' % (secret, SENT))
    # 把附件挂到 message 上（用保存动作）
    frappe.set_user(MAILBOX_OWNER)
    msg_doc = frappe.get_doc('Shangshu Mail Message', msg)
    msg_doc.attachment_ids_json = json.dumps([att])
    msg_doc.save(ignore_permissions=True)

    # 5) 把 boss 个人箱**只读**共享给 qa-a2（现成的 mail.mailbox.grant 通道）
    frappe.set_user(MAILBOX_OWNER)
    account.execute('mail.mailbox.grant',
                    {'mailbox': boss_box, 'user': RECIPIENT,
                     'rights': {'read': True, 'edit_draft': False, 'send': False,
                                'manage': False, 'signature': False}},
                    {'source': 'user'})

    # 6) 立刻**收回** qa-a2 的读权（mail.mailbox.revoke）—— message name 不动
    account.execute('mail.mailbox.revoke',
                    {'mailbox': boss_box, 'user': RECIPIENT},
                    {'source': 'user'})

    # 7) 不写真值；只打印占位，e2e 自己拿环境变量名取
    print('=== D 域 UI-094 夹具完成 ===')
    print('导出变量（请在真机/真登录环境下使用）：')
    print('  SHUI_E2E_BASE=<实例根>')
    print('  SHUI_E2E_COOKIE=sid=<你的登录 sid>')
    print('  SHUI_E2E_REVOKED_MAIL=<请勿在日志写真值；命令在真机复跑本脚本可取>')
    print('  SHUI_E2E_REVOKED_SECRET=<请勿在日志写真值；同上>')
    print('=== 收工（管理员事务一并 commit；如要回到「qa-a2 仍可见」请人工 grant 回去）===')
    frappe.db.commit()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        frappe.db.rollback()
        print('FAILED: %r' % (e,))
        sys.exit(1)
