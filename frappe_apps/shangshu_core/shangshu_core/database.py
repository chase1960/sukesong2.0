from contextlib import contextmanager

import frappe


def ensure_immutable_triggers(doctype, trigger_prefix):
    """用数据库触发器兜底 append-only；应用层 controller 仍负责可读错误。

    只有显式进入数据库维护会话并设置 @shangshu_immutable_maintenance=1 才可绕过，
    该变量不通过 HTTP/API 暴露，用于灾难恢复与受控卸载。
    """
    table = f"tab{doctype}"
    for operation in ("UPDATE", "DELETE"):
        trigger = f"{trigger_prefix}_no_{operation.lower()}"
        exists = frappe.db.sql(
            "select trigger_name from information_schema.triggers where trigger_schema=%s and trigger_name=%s",
            (frappe.conf.db_name, trigger),
        )
        if exists:
            continue
        # MariaDB 的 CREATE TRIGGER 会隐式提交。这里使用 Frappe 专门的 DDL
        # 入口，且只从迁移/运维阶段调用；不能放进 App 安装事务。
        frappe.db.sql_ddl(
            f"""
            create trigger `{trigger}` before {operation} on `{table}`
            for each row
            begin
                if coalesce(@shangshu_immutable_maintenance, 0) <> 1 then
                    signal sqlstate '45000' set message_text = '尚书不可变记录禁止 {operation}；请使用红冲或创建新版本';
                end if;
            end
            """
        )


# ---------- DDL 的独立事务（规矩收进内核） ----------

@contextmanager
def ddl_transaction():
    """DDL 用的**独立事务**（MariaDB 的 DDL 会隐式提交 ⇒ 不能在写事务里做）。

    为什么要有这个口（2026-10-22 实踩）：Frappe 会拒绝「在有写事务里做 DDL」，
    报 *This statement can cause implicit commit*。于是每个域、每个脚本都得自己记
    「先 commit 再 DDL」——**这规矩该在内核**，不该靠人人记得。
    ⇒ 域/脚本用 `execute_ddl()`，不用自己记。

    用法::

        from shangshu_core.database import execute_ddl
        execute_ddl("DROP TABLE IF EXISTS `tab%s`" % physical)
    """
    frappe.db.commit()
    try:
        yield
    except Exception:
        frappe.db.rollback()
        raise
    frappe.db.commit()


def execute_ddl(sql, *args):
    """跑一条 DDL（Frappe 的 DDL 入口 ＋ 独立事务；见 `ddl_transaction`）。"""
    with ddl_transaction():
        frappe.db.sql_ddl(sql, *args)
