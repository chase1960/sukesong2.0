"""BASE967-43 / req 7：万封邮箱的「未读」筛选**不许把所有已读 ID 拼成巨型 NOT IN**。

用户 2026-10-17 req 7 原话：
  「**万封邮箱避免把所有已读 ID 拼成巨型 NOT IN**；授权范围必须先于计数/分页，
    不能优化后泄露标题/未读数。」

改之前（`service.py:556-558` / `_unread_counts`）：
    read_ids = [r.mail for r in frappe.get_all(READ, filters={'user': ...}, fields=['mail'])]
    where['name'] = ['not in', read_ids]
  一万封信里九千封已读 → 先把 9000 个 name 拉进 Python，再拼成 9000 个占位符的
  NOT IN。查询变慢，还可能撞 `max_allowed_packet`。

判据只验**构造出来的 SQL**（纯字符串，不需要 bench / 数据库）：
  测试通过 = 下面每一条都成立
    1. 「我没读过」用 `LEFT JOIN ... IS NULL` 反连接表达，SQL 里**没有**已读邮件
       name 的列表；参数个数不随邮件数增长（万封也是常数个）。
    2. 授权范围（`mailbox_id` / `owner`）和状态条件出现在 `LIMIT` / `OFFSET` **之前**
       —— 先缩范围再分页，不是取完再筛。
    3. 搜索词只作为 `%s` 参数传，**不拼进 SQL 文本**（拿 `' OR 1=1` 试）。
    4. 计数用**同一套条件**、且不带 `LIMIT`（数与列表同一口径）。
    5. `service.py` 的列表查询和两套未读数**都走这个构造器**，源码里不再出现
       `['not in', read_ids]`。
"""
import importlib.util
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / 'frappe_apps/shangshu_mail/shangshu_mail/unread_query.py'
SERVICE = ROOT / 'frappe_apps/shangshu_mail/shangshu_mail/service.py'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UnreadQueryTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(MODULE.exists(), f'缺 {MODULE}（未读 SQL 构造器）')
        self.q = load(MODULE, 'shangshu_mail_unread_query')

    def test_未读SQL用反连接且不含已读ID列表(self):
        """测试通过 = 没有 NOT IN 列表，参数个数是常数（不随邮件数增长）。"""
        sql, params = self.q.unread_page_sql(
            {'mailbox_id': 'box-1', 'owner': 'me@x.invalid'},
            attach=False, q=None, user='me@x.invalid',
            order='desc', limit_start=0, length=30)
        self.assertIn('LEFT JOIN', sql, '没用 LEFT JOIN 反连接表达「我没读过」')
        self.assertIn('IS NULL', sql, 'LEFT JOIN 少了「没匹配上 = 未读」的判据')
        self.assertNotRegex(sql, r'NOT\s+IN\s*\(', '还在用 NOT IN')
        self.assertNotIn('read_ids', sql)
        # 万封邮箱：参数里不许出现邮件 name 的列表
        for value in params:
            self.assertNotIsInstance(value, (list, tuple, set),
                                     f'参数里出现了列表：{value!r} —— 会退回巨型 NOT IN')
        self.assertLessEqual(len(params), 10, f'参数 {len(params)} 个，不像常数规模')
        self.assertLess(len(sql), 4000, 'SQL 文本过长，疑似把 ID 拼了进来')

    def test_授权范围先于分页(self):
        """测试通过 = 行级授权片段 + mailbox_id/owner 都出现在 LIMIT 之前。

        `service._scope_sql(user)` 就是 `frappe.get_list` 靠 `permission_query`
        注入的可见面；换原生 SQL 必须把它带在最前面，否则等于绕过授权。
        """
        scope = "SCOPE_MARK_FOR_TEST"
        sql, params = self.q.unread_page_sql(
            {'mailbox_id': 'box-1', 'owner': 'me@x.invalid'},
            attach=False, q=None, user='me@x.invalid',
            order='desc', limit_start=30, length=30, scope_sql=scope)
        upper = sql.upper()
        limit_at = upper.index('LIMIT')
        self.assertIn(scope, sql, '没带行级授权片段')
        self.assertLess(sql.index(scope), limit_at, '授权片段在分页之后')
        self.assertLess(sql.index('mailbox_id'), limit_at, 'mailbox 条件在分页之后')
        self.assertLess(sql.index('owner'), limit_at, 'owner 条件在分页之后')
        self.assertIn('status', sql, '未读筛选必须限定 status=Received')
        self.assertEqual(sql.count('%s'), len(params),
                         '占位符与参数个数对不上')

    def test_搜索词只作参数不拼SQL(self):
        """测试通过 = 恶意搜索词原样留在参数里，不出现在 SQL 文本里。"""
        evil = "%' OR 1=1 --"
        sql, params = self.q.unread_page_sql(
            {'mailbox_id': 'box-1', 'owner': 'me@x.invalid'},
            attach=False, q=evil, user='me@x.invalid',
            order='asc', limit_start=0, length=30)
        self.assertNotIn(evil, sql, '搜索词被拼进了 SQL 文本')
        self.assertIn('%' + evil + '%', params, '搜索词没按参数传')

    def test_计数与列表同一套条件且不带LIMIT(self):
        """测试通过 = 计数 SQL 的条件片段与列表一致，且没有 LIMIT/OFFSET。"""
        page_sql, _ = self.q.unread_page_sql(
            {'mailbox_id': 'box-1'}, attach=True, q='核对', user='me@x.invalid',
            order='desc', limit_start=0, length=30)
        count_sql, _ = self.q.unread_count_sql(
            {'mailbox_id': 'box-1'}, attach=True, q='核对', user='me@x.invalid')
        where_of = lambda s: s.split(' WHERE ', 1)[1].split(' ORDER BY ', 1)[0]
        self.assertEqual(where_of(page_sql), where_of(count_sql), '数与列表条件不一致')
        self.assertNotIn('LIMIT', count_sql.upper(), '计数不该分页')

    def test_反连接在真数据库上结果正确(self):
        """测试通过 = 1 万封（9 千已读）真跑一遍：未读数对、分页对、授权片段生效。

        用 SQLite 在内存里建两张同形表跑构造出来的 SQL（反引号两边都认）。
        验的不是字符串长相，是**结果**：已读的不出现、没读的一封不少、
        换一个把范围排除掉的授权片段就一封都不返回。
        """
        import sqlite3
        db = sqlite3.connect(':memory:')
        cols = ('name', 'subject', 'status', 'record_version', 'owner', 'modified',
                'mailbox_id', 'to_json', 'cc_json', 'attachment_ids_json', 'from_address',
                'received_at', 'sent_at', 'message_id', 'reply_to_mail', 'reply_to_address',
                'delivery_error', 'delivery_started_at', 'rejected_json', 'previous_status',
                'read_at', 'body')
        db.execute(f'CREATE TABLE `tabShangshu Mail Message` ({", ".join(cols)})')
        db.execute('CREATE TABLE `tabShangshu Mail Read` (mail TEXT, user TEXT)')

        total_mails, read_by_me = 10000, 9000
        mails = [(f'm{i}', 's', 'Received', 1, 'me@x.invalid', f'2026-10-01 {i % 24:02d}:00',
                  'box-1', '[]', '[]', '[]', '', '', '', '', '', '', '', '', '[]', '', '', '正文')
                 for i in range(total_mails)]
        placeholders = ', '.join('?' * len(cols))
        db.executemany(f'INSERT INTO `tabShangshu Mail Message` VALUES ({placeholders})', mails)
        db.executemany('INSERT INTO `tabShangshu Mail Read` VALUES (?, ?)',
                       [(f'm{i}', 'me@x.invalid') for i in range(read_by_me)])
        # 别人读的不算我读过 —— 这 200 封必须还算我的未读
        db.executemany('INSERT INTO `tabShangshu Mail Read` VALUES (?, ?)',
                       [(f'm{i}', 'other@x.invalid') for i in range(read_by_me, read_by_me + 200)])
        db.commit()

        page_sql, page_params = self.q.unread_page_sql(
            {'mailbox_id': 'box-1'}, attach=False, q=None, user='me@x.invalid',
            order='desc', limit_start=0, length=30)
        rows = db.execute(page_sql.replace('%s', '?'), page_params).fetchall()
        self.assertEqual(len(rows), 30, '第一页应该是 30 条')
        names = {row[0] for row in rows}
        self.assertFalse({f'm{i}' for i in range(read_by_me)} & names, '已读的信混进了未读列表')

        count_sql, count_params = self.q.unread_count_sql(
            {'mailbox_id': 'box-1'}, user='me@x.invalid')
        count = db.execute(count_sql.replace('%s', '?'), count_params).fetchone()[0]
        self.assertEqual(count, total_mails - read_by_me,
                         f'未读数应为 {total_mails - read_by_me}（别人读的不算我读过）')

        # 授权片段生效：把范围排除掉，一封都不该返回
        scoped_sql, scoped_params = self.q.unread_page_sql(
            {'mailbox_id': 'box-1'}, user='me@x.invalid', limit_start=0, length=30,
            scope_sql="m.`mailbox_id` = 'not-mine'")
        self.assertEqual(db.execute(scoped_sql.replace('%s', '?'), scoped_params).fetchall(), [],
                         '授权片段没生效 —— 优化后泄露了别箱的标题')

        # 「带附件」筛选与搜索也必须和旧口径一致
        db.execute("UPDATE `tabShangshu Mail Message` SET attachment_ids_json = '[\"f1\"]' WHERE name = 'm9999'")
        db.execute("UPDATE `tabShangshu Mail Message` SET body = '客户同意代缴' WHERE name = 'm9998'")
        db.commit()
        att_sql, att_params = self.q.unread_count_sql(
            {'mailbox_id': 'box-1'}, attach=True, user='me@x.invalid')
        self.assertEqual(db.execute(att_sql.replace('%s', '?'), att_params).fetchone()[0], 1,
                         '带附件筛选结果不对')
        q_sql, q_params = self.q.unread_count_sql(
            {'mailbox_id': 'box-1'}, q='客户同意代缴', user='me@x.invalid')
        self.assertEqual(db.execute(q_sql.replace('%s', '?'), q_params).fetchone()[0], 1,
                         '搜索筛选结果不对')

    def test_service走构造器且不再拼已读列表(self):
        """测试通过 = service.py 的列表与两套未读数都调用构造器，旧写法消失。"""
        src = SERVICE.read_text(encoding='utf-8')
        self.assertIn('unread_query', src, 'service.py 没接未读 SQL 构造器')
        self.assertIn('unread_page_sql', src, '列表查询没走构造器')
        self.assertIn('unread_count_sql', src, '未读数没走构造器')
        self.assertIn('scope_sql=_scope_sql', src,
                      '原生 SQL 没带行级授权片段 _scope_sql —— 会绕过可见面')
        self.assertNotRegex(src, r"\['not in'\s*,\s*read_ids\]",
                            "service.py 里还留着 ['not in', read_ids]")
        self.assertNotIn('read_ids=[r.mail', src,
                         '还在把已读邮件的 name 全量拉进 Python')


if __name__ == '__main__':
    unittest.main()
