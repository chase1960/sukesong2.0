"""内核的**独立迁移**口：在**独立事务**里跑受管对象的 DDL 迁移。

**这个口解决什么**（2026-10-26 内核缺陷修复）：
  · 受管对象的物理表由 `model_changes.execute_object_change` 建立 —— 那是 **DDL**
    （**MariaDB 的 DDL 会隐式提交**），混在动作事务里会毁掉回滚点；
  · 但**领域围栏里不许自行提交**（`domain_execution` 的 `before_commit` 钩子：
    「领域执行器不得自行提交事务」）⇒ 晋升这条链（域动作 → 内核
    `promotion_records` → 这里）以前**必红**；
  · ⇒ 这里给出**唯一的、受控的**提交窗口：**只有 DDL 迁移这一小段**能提交，
    出窗立刻把域的屏障挂回去。

**它不是什么**（别把它当牌）：
  · **不是**「域可以间接提交」的通道 —— 它**不在 `public_api` 里**，
    域按域边界规矩拿不到它；窗口也不对外暴露成上下文管理器；
  · **不是**通用提交口 —— 它只做一件事：把某个**对象变更单**的 DDL 跑掉。

**提交的是什么**（2026-10-26 站上实测，3850 ＋ 核 Frappe v15 源码）：
DDL 跑在**调用方那条连接**上 ⇒ **Frappe 的 `updatedb()` 自己就 `self.commit()`**
（`frappe/database/mariadb/database.py` 末尾；`sql_ddl()` 跑 DDL 之前也提交）
⇒ **DDL 那一刻连接上还没提交的写，会被一起带走**（实测：哨兵行在迁移之后
被另一条连接看见了 ⇒ DDL 确实把调用方的待写内容提交了）。

⇒ **「不提前提交调用者的普通业务事务」改由「次序」保证**（不是靠连接干净）：
  · **域侧的业务写必须排在迁移之后**（文件域 `promotion.define`／`rewrite`
    已改成先跑迁移、后写声明与行 ID 登记）；
  · **本模块自己不提交调用方那条连接**（以前那句 `frappe.db.commit()` 是
    「替域提交」：它把域还没提交的写提前落了库 ⇒ 半写）。

⇒ **「失败不激活半套定义或权限」**：生效指针（③）与 DocPerm（④）在
  **同一次提交**里落库（`model_changes._write_object_permissions`）
  ⇒ 要么一起生效、要么一起没生效。

⇒ **失败收口在另一条连接上落库**（`model_changes._mark_object_change_failed`）
  ⇒ 「迁移中」这个被 DDL 提交带走的状态会被改成「失败」⇒ **同键可以重来**。

**失败怎么办**（保证 B）：
  · DDL 中途失败 ⇒ `execute_object_change` 把变更单置 `Failed`、
    **原生效版本保留**（生效指针只在 DDL 成功后移动）、可按同一幂等键重试；
  · 提交与 DDL 都**销毁 savepoint** ⇒ 本模块在退出前**按原名重建**它 ——
    不重建的话，动作失败时 `rollback(save_point=…)` 会报
    「SAVEPOINT does not exist」⇒ **失败记账跑不到** ⇒ **动作卡在 Running**、
    同键重试撞「该动作仍在执行或需要恢复」。
    ⚠️ **重建出来的 savepoint 只覆盖 DDL 之后那一段** —— DDL 之前那部分
    **已经被 DDL 的提交提交了** ⇒ **重建不是把原事务恢复回来**
    （用户 2026-10-26 定：不能拿重建冒充「外层事务还能完整回滚」）。
"""

import frappe

from contextlib import contextmanager

from shangshu_core.domain_execution import independent_migration_window

# 动作的 savepoint 名由 `actions.execute_registered_action` 挂在 flags 上
# （由外到内的一条链）⇒ 这里按**原名**重建它们。
SAVEPOINT_FLAG = "shangshu_action_savepoints"


@contextmanager
def independent_connection():
    """开一条**独立连接**（失败收口用它把「失败」落库），退出时收干净。

    **它只干这一件事**：DDL 在调用方那条连接上跑 ⇒ MariaDB 的隐式提交已经把
    「迁移中」这个状态提交了 ⇒ 外层回滚之后库里那条变更单停在「迁移中」
    ⇒ **同键重试会被挡住**。⇒ 失败收口改走**另一条连接**写「失败」并提交
    （那条连接上只有这一笔写 ⇒ 提交它只影响这一行）。

    **连接怎么开**：用 `site_config` 的**同一套凭据**建一条新连接 ——
    `frappe.database.get_db(...)` 就是 Frappe 自己建 `local.db` 用的那个口
    ⇒ 不自己写连接管理代码。`get_db` 只**造对象**，连接要自己 `connect()`。

    **退出时**：**先回滚再关** ⇒ 这条连接上没提交的写一律丢掉。
    """
    from frappe.database import get_db

    conf = frappe.conf
    db = get_db(socket=conf.db_socket, host=conf.db_host, port=conf.db_port,
                user=conf.db_name, password=conf.db_password,
                cur_db_name=conf.db_name)
    db.connect()
    try:
        yield db
    finally:
        try:
            db.rollback()
        finally:
            db.close()


def rebuild_action_savepoints():
    """把被提交 / DDL 销毁的**动作 savepoint** 按原名重建。

    为什么必须**同名**重建：动作失败时回滚的是**它自己那个** savepoint
    （`actions.py`）⇒ 名字必须一样。MySQL 允许同名覆盖
    （`SAVEPOINT x` 会替换掉旧的 x）。

    按**由外到内**的顺序重建 ⇒ 内层 savepoint 仍落在内层之后
    （`ROLLBACK TO SAVEPOINT 外层` 会释放它之后建立的 savepoint）。

    返回重建了几个（没有动作 savepoint 时是 0 —— 不是错）。
    """
    names = list(getattr(frappe.flags, SAVEPOINT_FLAG, None) or [])
    for name in names:
        frappe.db.savepoint(name)
    return len(names)


def run_independent_migration(change_id, confirmed=False, executor=None):
    """在独立事务里跑一次受管对象的 **DDL 迁移**。

    `change_id` 是 `model_changes.prepare_object_change` 给的**变更单号**；
    `confirmed` 必须为 `True`（与 `execute_object_change` 同一口径：
    建表 / 改表不许闷头跑）。

    返回变更单的公开形状（`{"id", "object_id", "status", "target_revision", ...}`）。

    `executor` 只是给**离线判据**注入假执行器用的（离线那几条只验
    屏障挂起/恢复、savepoint 重建、失败收口，不碰真 DDL）；
    生产路径**不传**它 ⇒ 走的是真的 `execute_object_change`。
    """
    if confirmed is not True:
        frappe.throw("请明确确认独立迁移", frappe.ValidationError)
    if executor is None:
        from shangshu_core.model_changes import execute_object_change
        executor = execute_object_change
    with independent_migration_window():
        try:
            # ⚠️ **这里没有显式提交**（2026-10-26 用户定「乙」）——
            #    以前那句 `frappe.db.commit()` 是「替域提交」：它把域还没提交的写
            #    **提前落库** ⇒ 域的写与对象的写分成两笔 ⇒ 半写。
            #    现在**只有 DDL 自己那次隐式提交**（MariaDB 的规矩，改不了）。
            result = executor(change_id, confirmed=True)
        finally:
            # ③ **重建 savepoint** ——
            #    DDL 把当前事务的 savepoint 销毁了
            #    （MySQL：COMMIT / DDL 会释放 savepoint）
            #    ⇒ 不重建的话，动作失败时 `rollback(save_point=…)` 会报
            #    「SAVEPOINT does not exist」⇒ **失败记账跑不到**
            #    ⇒ **动作卡在 Running**、同键重试撞「该动作仍在执行」。
            #    ⚠️ **重建出来的只覆盖 DDL 之后那一段** —— DDL 之前那部分已经
            #    被隐式提交提交了 ⇒ **它不是「原事务还能完整回滚」的证明**。
            rebuild_action_savepoints()
    return result
