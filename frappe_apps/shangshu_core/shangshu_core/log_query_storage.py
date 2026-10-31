"""日志事实的数据库查询投影；仅显式 migrate 执行，日常读写不运行 DDL。

detail_json/trigger_source 仍是唯一事实。生成列随数据库写入维护，完整二进制
值不截断；短键只有完整值 <=191 字节时才生成，供常用来源查询覆盖索引。
版本名与查询 SQL 同步发布。已有同名列/索引定义漂移必须拒绝，不静默复用。
"""
import re

import frappe


TABLE = "tabShangshu Unified Log"
SHAPE_TABLE = "__shangshu_log_query_shape_v1"
INDEXES = {
    "ssq_conversation_v1": ("conversation_key", "what_kind", "actor_identity", "creation", "name"),
    "ssq_scope_v1": ("what_kind", "actor_identity", "creation", "name"),
    "ssq_process_v1": ("business_object_id", "what_kind", "actor_identity", "business_name"),
    "ssq_source_scope_v1": ("what_kind", "actor_identity", "ssq_action_key_v1",
                            "ssq_event_key_v1", "ssq_legacy_key_v1", "creation", "name"),
}


def column_definitions():
    # Python 投影的来源真假值语义；DOUBLE 保留 1e-100 等非零值，不能用
    # DECIMAL(65,30)（会舍入成 0，错误回退）。JSON 无效时与 _json 一样取空对象。
    detail = "CASE WHEN JSON_VALID(`detail_json`) THEN `detail_json` ELSE '{}' END"
    source = "JSON_EXTRACT(%s, '$.legacy.executor_source')" % detail
    text = "JSON_UNQUOTE(%s)" % source
    source_type = "JSON_TYPE(%s)" % source
    action = ("CASE WHEN {type} = 'STRING' AND BINARY {text} <> BINARY '' THEN {text} "
              "WHEN {type} IS NULL OR {type} = 'NULL' "
              "OR ({type} = 'STRING' AND BINARY {text} = BINARY '') "
              "OR ({type} = 'BOOLEAN' AND {text} = 'false') "
              "OR ({type} IN ('INTEGER', 'DOUBLE') AND CAST({text} AS DOUBLE) = 0) "
              "OR ({type} IN ('ARRAY', 'OBJECT') AND JSON_LENGTH({source}) = 0) "
              "THEN `trigger_source` ELSE NULL END").format(type=source_type, text=text, source=source)
    event = "CASE WHEN %s = 'STRING' THEN %s ELSE NULL END" % (source_type, text)
    legacy = "JSON_UNQUOTE(JSON_EXTRACT(%s, '$.legacy.trigger_source'))" % detail
    definitions = {
        name: "LONGBLOB GENERATED ALWAYS AS (%s) PERSISTENT" % expression
        for name, expression in (("ssq_action_source_v1", action),
                                 ("ssq_event_source_v1", event),
                                 ("ssq_legacy_trigger_v1", legacy))
    }
    for key, column in (("ssq_action_key_v1", "ssq_action_source_v1"),
                        ("ssq_event_key_v1", "ssq_event_source_v1"),
                        ("ssq_legacy_key_v1", "ssq_legacy_trigger_v1")):
        definitions[key] = ("VARBINARY(191) GENERATED ALWAYS AS (CASE WHEN OCTET_LENGTH(`%s`) "
                            "<= 191 THEN `%s` ELSE NULL END) PERSISTENT") % (column, column)
    return definitions


def _column_signature(create_sql, name):
    # SHOW CREATE 的一行包括实际类型、完整生成表达式和存储方式；让同一服务端
    # 规范化目标定义后精确比较，不能只检验列存在或依靠注释中的版本号。
    match = re.search(r"^\s*`" + re.escape(name) + r"`\s+(.+?)\s*,?\s*$", create_sql, re.M)
    return match.group(1).rstrip(",").strip() if match else None


def _validate_existing(create_sql, expected, indexes):
    for name, definition in expected.items():
        current = _column_signature(create_sql, name)
        if current is not None and current != definition:
            raise RuntimeError("日志查询投影 %s 定义与 v1 不符；停止迁移，请显式处理版本漂移" % name)
    grouped = {}
    for row in indexes:
        grouped.setdefault(row["Key_name"], []).append(row)
    for name, columns in INDEXES.items():
        rows = sorted(grouped.get(name, []), key=lambda row: row["Seq_in_index"])
        if not rows:
            continue
        actual = tuple(row["Column_name"] for row in rows)
        if (actual != columns or any(row.get("Sub_part") is not None
                or row.get("Non_unique") != 1 or row.get("Index_type") != "BTREE"
                or row.get("Collation") != "A" or row.get("Ignored", "NO") != "NO" for row in rows)):
            raise RuntimeError("日志查询索引 %s 定义与 v1 不符；停止迁移，请显式处理版本漂移" % name)


def ensure_log_query_storage():
    """安装后的显式 migrate 阶段幂等运行；不在请求中调用，不修改历史事实。"""
    version = str(frappe.db.sql("SELECT VERSION()")[0][0])
    if "MariaDB" not in version:
        raise RuntimeError("日志查询投影需要 MariaDB PERSISTENT 生成列；当前数据库不支持此迁移")
    definitions = column_definitions()
    # 临时表只为取得该服务器的规范生成表达式，不承载日志或任何业务事实。
    frappe.db.sql("DROP TEMPORARY TABLE IF EXISTS `%s`" % SHAPE_TABLE)
    try:
        frappe.db.sql("CREATE TEMPORARY TABLE `%s` (`detail_json` LONGTEXT, "
                      "`trigger_source` VARCHAR(140), %s) ENGINE=InnoDB" % (
                          SHAPE_TABLE, ", ".join("`%s` %s" % item for item in definitions.items())))
        target = frappe.db.sql("SHOW CREATE TABLE `%s`" % SHAPE_TABLE)[0][1]
        expected = {name: _column_signature(target, name) for name in definitions}
        if not all(expected.values()):
            raise RuntimeError("数据库未返回完整日志生成列定义；停止迁移")
    finally:
        frappe.db.sql("DROP TEMPORARY TABLE IF EXISTS `%s`" % SHAPE_TABLE)
    current = frappe.db.sql("SHOW CREATE TABLE `%s`" % TABLE)[0][1]
    indexes = frappe.db.sql("SHOW INDEX FROM `%s`" % TABLE, as_dict=True)
    _validate_existing(current, expected, indexes)
    names = {row["Key_name"] for row in indexes}
    clauses = ["ADD COLUMN `%s` %s" % (name, definition)
               for name, definition in definitions.items() if _column_signature(current, name) is None]
    clauses.extend("ADD INDEX `%s` (%s)" % (name, ", ".join("`%s`" % field for field in columns))
                   for name, columns in INDEXES.items() if name not in names)
    if clauses:
        frappe.db.sql_ddl("ALTER TABLE `%s` %s" % (TABLE, ", ".join(clauses)))
    installed = frappe.db.sql("SHOW CREATE TABLE `%s`" % TABLE)[0][1]
    installed_indexes = frappe.db.sql("SHOW INDEX FROM `%s`" % TABLE, as_dict=True)
    _validate_existing(installed, expected, installed_indexes)
    if (any(_column_signature(installed, name) is None for name in expected)
            or not set(INDEXES) <= {row["Key_name"] for row in installed_indexes}):
        raise RuntimeError("日志查询投影或索引不完整；停止迁移")
    return {"version": 1, "added": len(clauses)}
