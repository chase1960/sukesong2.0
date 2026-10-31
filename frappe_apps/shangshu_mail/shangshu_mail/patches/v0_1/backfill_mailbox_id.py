"""旧邮件回填 `mailbox_id`（BASE967 / C 分支新 schema 升级前置）。

**为什么要有**：新版邮件查询默认按 `mailbox_id` 定位「个人箱/部门箱」，
而旧数据只有 `source_mailbox`（邮箱地址），`mailbox_id` 为 NULL ——
不回填的话，**生产升级后旧邮件会在收件箱里整批消失**（权限片段里虽保留了
`mailbox_id is null` 的旧信分支，但列表按箱过滤时仍取不到它们）。

**回填规则**：
  1. `source_mailbox` 能对上某个 `Shangshu Mail Account` 的 `email_address`
     → 用该账号行的 `account_key`（部门/共享邮箱走这条）；
  2. `source_mailbox` 等于信主 `owner`（旧个人箱）
     → 用 `account.account_name(owner)`（sha256 前 40 位，与 N5-1 保留口径一致）；
  3. `source_mailbox` 为空、但有 `owner`
     → 同上按个人箱回填（旧草稿/旧收信没有来源地址）；
  4. 其余（地址非空但对不上账号、也不等于 owner）→ **不回填、记日志**，
     不猜（宁可留 NULL 让人核，也不能把别人的信塞进某人的个人箱）。

**幂等**：只处理 `mailbox_id IS NULL` 的行；重跑第二遍为 0 变更。
**失败不静默**：无法映射的行数写进 `frappe.log_error`，并打印计数。
"""
import frappe

MAIL_DOCTYPE = 'Shangshu Mail Message'
ACCOUNT_DOCTYPE = 'Shangshu Mail Account'


def execute():
    from shangshu_mail.account import account_name

    rows = frappe.get_all(
        MAIL_DOCTYPE,
        filters={'mailbox_id': ['is', 'not set']},
        fields=['name', 'owner', 'source_mailbox'],
        limit_page_length=0,
    )
    if not rows:
        return _report(0, 0, [])

    # 邮箱地址 → 稳定 account_key（只取有 email_address 的账号行）
    by_email = {}
    try:
        for row in frappe.get_all(
                ACCOUNT_DOCTYPE,
                fields=['account_key', 'email_address'],
                limit_page_length=0):
            email = str(row.get('email_address') or '').strip().lower()
            key = str(row.get('account_key') or '').strip()
            if email and key:
                by_email[email] = key
    except Exception as error:  # 账号表结构异常时不要静默跳过映射
        frappe.log_error(
            title='mailbox_id 回填：读取邮箱账号失败',
            message='%s: %s' % (type(error).__name__, error))

    updated = 0
    unmapped = []
    for row in rows:
        name = row.get('name')
        owner = str(row.get('owner') or '').strip()
        source = str(row.get('source_mailbox') or '').strip().lower()
        key = None
        if source and source in by_email:
            key = by_email[source]
        elif source and owner and source == owner.lower():
            key = account_name(owner)
        elif not source and owner:
            key = account_name(owner)
        if not key:
            unmapped.append(name)
            continue
        frappe.db.set_value(MAIL_DOCTYPE, name, 'mailbox_id', key,
                            update_modified=False)
        updated += 1

    return _report(len(rows), updated, unmapped)


def _report(scanned, updated, unmapped):
    left = len(unmapped)
    message = ('旧邮件 mailbox_id 回填：扫描 %d，回填 %d，无法映射 %d'
               % (scanned, updated, left))
    print('[mail-backfill] ' + message)
    if left:
        # **不静默**：地址对不上账号也不等于 owner 的信留 NULL，点名等人工核。
        frappe.log_error(
            title='mailbox_id 回填：%d 封无法映射（留 NULL）' % left,
            message=message + '\n' + '\n'.join(unmapped[:200]))
    return {'scanned': scanned, 'updated': updated, 'unmapped': unmapped}
