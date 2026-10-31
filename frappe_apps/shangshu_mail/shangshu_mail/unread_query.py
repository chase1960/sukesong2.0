"""未读筛选的 SQL 构造 —— **纯字符串，不导入 frappe**，便于离线判据。

为什么单独一个模块：
  改之前 `['not in', read_ids]` 会把**所有已读邮件的 name** 拉进 Python 再拼进 SQL。
  万封邮箱里已读上万条 → 巨型 NOT IN：查询变慢，还可能撞 `max_allowed_packet`。
  改成 **LEFT JOIN 反连接**，已读关系留在库里，参数个数是常数。

为什么用 LEFT JOIN 而不是 NOT EXISTS（2026-10-17 实测，SQLite 1 万封 / 9 千已读）：
  · 无索引：NOT EXISTS **6.8s**（每行相关子查询全表扫），LEFT JOIN **0.011s**
  · 有 (user, mail) 索引：两者都 ~0.005s
  索引要靠 migrate 才建得出来，建好之前 LEFT JOIN 也不会塌。

调用方（`service.py`）负责：
  · **授权先于分页**：`scope_sql` 必须由调用方按当前权限算好后传进来；
  · `order` 只允许 asc/desc —— 它要拼进 ORDER BY，不能接受任意输入。
"""

MAIL_TABLE = '`tabShangshu Mail Message`'
READ_TABLE = '`tabShangshu Mail Read`'

# 列表要投影的列 —— 与 get_list 那条路的字段表保持一致。
MAIL_FIELDS = (
    'name', 'subject', 'status', 'record_version', 'owner', 'modified', 'mailbox_id',
    'to_json', 'cc_json', 'attachment_ids_json', 'from_address', 'received_at', 'sent_at',
    'message_id', 'reply_to_mail', 'reply_to_address', 'delivery_error',
    'delivery_started_at', 'rejected_json', 'previous_status', 'read_at',
)

# 「搜一搜」覆盖的列 —— 与 get_list 那条路的 or_filters 保持一致。
SEARCH_FIELDS = ('subject', 'body', 'to_json', 'cc_json')


def _alias_scope(scope_sql):
    """把 scope_sql 的全表名限定换成原生 SQL 的别名 `m`。

    `service._scope_sql()` 是为 `frappe.get_list`（表不带别名）写的，引用
    `` `tabShangshu Mail Message`.`mailbox_id` ``；本模块的 SQL 用
    `FROM tabShangshu Mail Message m`。MySQL 在表带别名时禁止再用原表名限定列，
    会报 1054「Unknown column 'tabShangshu Mail Message.mailbox_id' in 'WHERE'」，
    即使该列真实存在。
    """
    if not scope_sql:
        return scope_sql
    return scope_sql.replace('`tabShangshu Mail Message`.', 'm.')


def _join_where(box_where, attach, q, user, scope_sql=None):
    """→ (JOIN 片段, where 片段, 参数)。

    参数顺序与 SQL 文本一致：**JOIN 里的 user 在最前**，然后是 where 里的值。
    `scope_sql` 是 `service._scope_sql(user)` 的可见面片段 —— **必须带**：
    `frappe.get_list` 的行级授权就是靠 `permission_query` 钩子注入它；
    换原生 SQL 时若不带，等于绕过授权（req 7 明写「不能优化后泄露标题/未读数」）。
    """
    join = f'LEFT JOIN {READ_TABLE} r ON r.`mail` = m.`name` AND r.`user` = %s'
    params = [user]
    clauses = []
    if scope_sql:
        clauses.append(_alias_scope(scope_sql))
    for key in ('mailbox_id', 'owner'):
        if key in box_where:
            clauses.append(f'm.`{key}` = %s')
            params.append(box_where[key])
    # 未读只对收件有意义（发件箱/草稿没有「我没读过」这回事）。
    clauses.append("m.`status` = 'Received'")
    # 反连接：这封信在我这套已读关系里没有对应行 = 我没读过。
    clauses.append('r.`mail` IS NULL')
    if attach:
        # 与 get_list 的 ['not in', ('', '[]')] 同义。
        clauses.append("COALESCE(m.`attachment_ids_json`, '') NOT IN ('', '[]')")
    if q:
        clauses.append('(' + ' OR '.join(f'm.`{field}` LIKE %s' for field in SEARCH_FIELDS) + ')')
        params.extend(['%' + q + '%'] * len(SEARCH_FIELDS))
    return join, ' AND '.join(clauses), params


def unread_count_sql(box_where, attach=False, q=None, user='', scope_sql=None):
    """计数用**同一套条件**、不分页 —— 数与列表同一口径。"""
    join, where, params = _join_where(box_where, attach, q, user, scope_sql)
    return f'SELECT COUNT(*) FROM {MAIL_TABLE} m {join} WHERE {where}', params


def unread_page_sql(box_where, attach=False, q=None, user='', order='desc',
                    limit_start=0, length=30, scope_sql=None):
    """未读列表：授权条件在 LIMIT/OFFSET 之前 —— 先缩范围再分页。"""
    if order not in ('asc', 'desc'):
        raise ValueError('order 只能是 asc/desc')
    join, where, params = _join_where(box_where, attach, q, user, scope_sql)
    columns = ', '.join(f'm.`{field}`' for field in MAIL_FIELDS)
    sql = (f'SELECT {columns} FROM {MAIL_TABLE} m {join} WHERE {where} '
           f'ORDER BY m.`modified` {order}, m.`name` asc LIMIT %s OFFSET %s')
    return sql, [*params, int(length), int(limit_start)]
