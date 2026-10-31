"""旧邮件 `mailbox_id` 回填补丁判据（容器内跑）。

**测试通过 = 下面每条成立**：
1. 造一封 `mailbox_id` 为 NULL、`source_mailbox` = 信主邮箱的旧信；
2. 跑 `shangshu_mail.patches.v0_1.backfill_mailbox_id.execute()`：
   · 该信 `mailbox_id` = `account_name(owner)`（个人箱稳定键）；
   · 返回计数 `updated >= 1`；
3. 再造一封地址对不上任何账号、也不等于 owner 的旧信：补丁**不回填**（留 NULL），
   且 `unmapped` 里点名它（不静默）；
4. **再跑一次**：这两封都不再变更（幂等，`updated` 不含它们）；
5. 清理：删掉本次造的合成信（失败也删）。

用法（3820 容器）：
```
docker cp shangshu-server/scripts/tests/test_mail_mailbox_backfill.py \\
  shangshu-local-b-frappe-1:/tmp/t.py
docker exec -w /home/frappe/frappe-bench shangshu-local-b-frappe-1 \\
  ./env/bin/python /tmp/t.py
```
需要容器 app 里已有补丁模块（patches/v0_1/backfill_mailbox_id.py）。
"""
import frappe

MAIL = 'Shangshu Mail Message'
TAG = 'MAIL-BACKFILL-TEST'


def main():
    frappe.init(site='shangshu.localhost', sites_path='/home/frappe/frappe-bench/sites')
    frappe.connect()
    frappe.set_user('Administrator')
    from shangshu_mail.account import account_name
    from shangshu_mail.patches.v0_1 import backfill_mailbox_id as patch

    owner = 'boss-1792046972@example.invalid'
    made = []
    checks, fails = [], []

    def check(label, ok, detail=''):
        checks.append(label)
        if not ok:
            fails.append(label)
        print('  %s %s%s' % ('✓' if ok else '✗', label,
                             ('　—　' + str(detail)[:200]) if detail else ''))

    def make(subject, source, owner_email):
        # **旧数据模拟必须走裸 SQL**：doctype 的 `before_insert` 会自动填 mailbox_id、
        # `validate` 又拦非受管写 —— 用 ORM 根本造不出「mailbox_id 为 NULL 的旧信」。
        name = 'MBT-' + frappe.generate_hash(length=10)
        frappe.db.sql(
            "INSERT INTO `tabShangshu Mail Message` "
            "(name, creation, modified, modified_by, owner, docstatus, idx, "
            " subject, body, body_format, status, record_version, mailbox_id, "
            " source_mailbox, message_id, incoming_key) "
            "VALUES (%s, NOW(), NOW(), %s, %s, 0, 0, %s, %s, 'text', 'Received', 1, NULL, %s, %s, %s)",
            (name, owner_email, owner_email, subject, '判据用合成信', source,
             '<%s-%s@example.invalid>' % (TAG, frappe.generate_hash(length=8)),
             '%s-%s' % (TAG, frappe.generate_hash(length=10))))
        made.append(name)
        return name

    try:
        mapped = make(TAG + '-mapped', owner, owner)
        unknown = make(TAG + '-unmapped', 'nobody@example.invalid', owner)
        frappe.db.commit()
        check('前置：两封旧信 mailbox_id 均为空',
              not frappe.db.get_value(MAIL, mapped, 'mailbox_id')
              and not frappe.db.get_value(MAIL, unknown, 'mailbox_id'))

        result = patch.execute()
        got = frappe.db.get_value(MAIL, mapped, 'mailbox_id')
        check('1 个人箱旧信回填为 account_name(owner)',
              got == account_name(owner), 'mailbox_id=%r 期望=%r' % (got, account_name(owner)))
        left = frappe.db.get_value(MAIL, unknown, 'mailbox_id')
        check('2 地址对不上的信不回填（留 NULL）', not left, 'mailbox_id=%r' % (left,))
        check('3 无法映射的在 unmapped 里点名（不静默）',
              unknown in (result.get('unmapped') or []),
              'unmapped=%r' % ((result.get('unmapped') or [])[:5],))

        before = (frappe.db.get_value(MAIL, mapped, 'mailbox_id'),
                  frappe.db.get_value(MAIL, unknown, 'mailbox_id'))
        result2 = patch.execute()
        after = (frappe.db.get_value(MAIL, mapped, 'mailbox_id'),
                 frappe.db.get_value(MAIL, unknown, 'mailbox_id'))
        check('4 重跑幂等：两封都不再变更',
              before == after and mapped not in (result2.get('unmapped') or []),
              'before=%r after=%r updated=%r' % (before, after, result2.get('updated')))
    finally:
        try:
            for name in made:
                # 裸 SQL 删除：doctype 的 `on_trash` 拦非受管删除（合成夹具按测试清理）。
                frappe.db.sql("DELETE FROM `tabShangshu Mail Message` WHERE name=%s", (name,))
            frappe.db.commit()
            print('  [cleanup] 已删除合成信 %r' % made)
        except Exception as error:
            print('  [cleanup] 删除失败（需人工清）：%s: %s' % (type(error).__name__, error))
            frappe.db.rollback()

    print()
    if not checks:
        print('结果： FAIL 零条检查被断言')
        return 1
    print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                      'PASS 旧邮件 mailbox_id 回填（%d 条）' % len(checks)))
    return 1 if fails else 0


if __name__ == '__main__':
    raise SystemExit(main())
