"""内核：**退役受管对象 / 应用**（2026-10-22 收进内核的公共口）。

**为什么要有这个口**（用户 2026-10-22 原话）：
「**没有『退役受管对象/应用』的口 ⇒ 昨晚清 91 个残留只能直接删内核表——今晚最脏的一处。**」

清理残留这件事，**只能靠脚本直接改内核表**（`DELETE FROM tabShangshu Object Model`、
`DROP TABLE`）——绕过内核的一切规矩（引用检查、权限、应用绑定、审计）。
这个口把那些规矩**收进内核**：

· **谁能退役**：走内核自己的身份与权限判定（不是脚本想删就删）；
· **为什么退役**：必须写原因，留进内核的审计（**不是**脚本里的一行 print）；
· **被谁引用着**：**还活着的对象引用它 ⇒ 当场拒**，说清被谁引用
  （直接删表会让引用方的字段变成死链）；
· **退役后还剩什么**：生效修订清零（不再可用）、物理表清掉、应用绑定解掉
  —— **一次性做完，不留半截状态**。

**同一个值只存一处**：退役记录只存「谁在什么时候为什么退役了它」，
**不把对象定义抄一份到退役记录里**。
"""
import frappe
import hashlib
import json
from frappe.utils import now_datetime

from shangshu_core.database import execute_ddl
from shangshu_core.identity import get_identity
from shangshu_core import write_zone_schema
from shangshu_core.design_support import lock_lifecycle

MODEL = "Shangshu Object Model"
DEFINITION = "Shangshu Application Definition"
RELEASE = "Shangshu Application Release"
RETIREMENT = "Shangshu Object Model Retirement"


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def _actor(actor_identity=None):
    """退役人：默认当前会话身份；显式传入时必须是**真实存在的身份**。"""
    if actor_identity:
        if not frappe.db.exists("Shangshu Identity", actor_identity):
            _fail("退役人身份不存在")
        return actor_identity
    return get_identity().name


def _referencing_objects(object_id):
    """排空后当前读全部已激活的入向引用；不能沿等待前的 RR 快照。"""
    rows = frappe.db.sql('SELECT name, active_json FROM `tabShangshu Object Model` '
                        'WHERE active_revision>0 ORDER BY name LOCK IN SHARE MODE', as_dict=True)
    holders = []
    for row in rows:
        if row["name"] == object_id:
            continue
        try:
            compiled = frappe.parse_json(row["active_json"] or "{}")
        except (ValueError, TypeError):
            _fail("对象 %s 的生效定义无法核验，暂不可退役其他对象" % row["name"])
        for field in compiled.get("fields") or []:
            if field.get("type") in {'detail', 'reference'} and field.get("target") == object_id:
                holders.append(row["name"])
    return holders


def _physical_table(physical_doctype):
    """Frappe 的物理表名＝`tab` ＋ DocType 名（**空格保留**）。

    ⚠️ 已知坑：物理**列**名是 `f_<hash>`，业务列名走 `active_json` 的 `columns` 映射 ——
    退役这里要删的是**表**，别去动列。
    """
    return "tab" + str(physical_doctype or "")



def get_managed_object_model(object_id):
    """**读受管对象的模型事实**（只读）：归属应用 ＋ 当前修订 ＋ 生效修订。

    **为什么要有这个口**（2026-10-24 · PKG-082-T01）：
    域要发布自己的受管对象修订，得知道「**这个对象归哪个应用、当前修订几号**」——
    而「受管对象模型」是**内核的表**。域自己去查它，就是**跨域摸内核的表**
    （`check-platform-contract.mjs` 判 `PRIVATE_CORE_DOCTYPE_ACCESS`）⇒
    这件事**收进内核**，域只走公开口。

    **只读**：不写、不发布、不改修订；发布是另一件事
    （`publish_application_definition`）。**同一个值只存一处** ——
    这里返回的是内核表里的**事实**，不另存一份副本。

    返回：`{object_id, owner, revision, active_revision}`；
    **对象不存在 ⇒ 当场拒**（不返回空壳让人误以为「没有 owner」）。
    """
    object_id = str(object_id or "").strip()
    if not object_id:
        _fail("请指定要读的受管对象")
    model = frappe.db.get_value(MODEL, object_id,
                                ["owner", "revision", "active_revision"], as_dict=True)
    if not model:
        frappe.throw("受管对象不存在：%s" % object_id, frappe.DoesNotExistError)
    return {"object_id": object_id,
            "owner": str(model.get("owner") or ""),
            "revision": int(model.get("revision") or 0),
            "active_revision": model.get("active_revision")}

def retire_managed_object(object_id, reason, actor_identity=None):
    """退役一个受管对象：下线它、清掉物理表、解掉应用绑定，并留下记录。

    返回一张**回执**（谁、何时、为什么、退役了什么、还有谁在用它）。
    """
    write_zone_schema.assert_engineering_entry()
    identity = _actor(actor_identity)
    object_id = str(object_id or "").strip()
    reason = str(reason or "").strip()
    if not object_id:
        _fail("请指定要退役的受管对象")
    if not reason or len(reason) > 500:
        _fail("请填写 1–500 字退役原因")
    with write_zone_schema.schema_lock(object_id):
        lock_lifecycle()
        model = write_zone_schema.lock_model(object_id)
        if not model.active_revision and not model.get('scope_fence'):
            return {"retired": False, "object_id": object_id,
                    "hint": "它已经退役过了", "actor_identity": identity,
                    "retired_at": None, "reason": reason}
        token = 'retire:' + hashlib.sha256(json.dumps(
            [object_id, model.revision, identity, reason], separators=(',', ':')).encode()).hexdigest()
        if model.get('scope_fence'):
            write_zone_schema.recover_schema_change(model, token)
        holders = _referencing_objects(object_id)
        if holders:
            _fail("还有 %d 个在用的对象引用着它（%s）⇒ 先解除引用再退役"
                  % (len(holders), "、".join(holders[:5])))
        model = write_zone_schema.begin_schema_change(model, token)
        physical, application_id = model.physical_doctype, model.application
        retired_at = now_datetime()
        # 沿既有“下线后提交”边界使 fence 耐久；不额外加提交。
        # 后续失败即使 active_revision 已为0，也须同 token 续作，不能假称退役完成。
        frappe.db.set_value(MODEL, object_id, {"active_revision": 0, "active_json": "{}"},
                            update_modified=False)
        frappe.db.commit()
        if physical:
            execute_ddl("DROP TABLE IF EXISTS `%s`" % _physical_table(physical).replace('`', '``'))
            if frappe.db.exists('DocType', physical):
                frappe.delete_doc('DocType', physical, force=True, ignore_permissions=True)
        frappe.get_doc({
            "doctype": RETIREMENT, "object_id": object_id, "application": application_id,
            "physical_doctype": physical, "actor_identity": identity,
            "reason": reason, "retired_at": retired_at,
        }).insert(ignore_permissions=True)

        def verified(current):
            return (not current.active_revision and (not physical or (
                not frappe.db.exists('DocType', physical) and not frappe.db.sql(
                    'SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=%s',
                    (_physical_table(physical),)))))

        write_zone_schema.finish_schema_change(model, token, verified)
        frappe.db.commit()
        return {"retired": True, "object_id": object_id, "application_id": application_id,
                "physical_doctype": physical, "actor_identity": identity,
                "reason": reason, "retired_at": str(retired_at), "referenced_by": holders}


def object_life(object_id):
    """受管对象现在是**第几世**（1 ＝ 第一世）。

    **为什么要有「世」**（2026-10-25 站上实测撞出来的第三个内核缺口）：
    受管对象的 id 是**从幂等键推导**的（`application_id + ".object." + hash(表 id)`）
    ⇒ **同一张表永远是同一个 object_id**；
    而**退役故意保留模型行**（当退役记录用，审计要留）
    ⇒ 同一张表「晋升过 → 退役 → 再晋升」时，撞的不是主键，是**幂等键**
    （变更键唯一、行级键会重放上一世的旧结果）。

    ⇒ 解法不是改主键，是**幂等键带世**：**不同世互不撞，同一世内重试仍是同一把键**
    （幂等仍成立）。「世」＝ **已经退役过几次 ＋ 1**（退役记录数就是死过的次数）。

    **只读**：不改任何状态。
    """
    object_id = str(object_id or "").strip()
    if not object_id:
        return 1
    return int(frappe.db.count(RETIREMENT, {"object_id": object_id}) or 0) + 1


def retire_application(application_id, reason, actor_identity=None):
    """退役一个应用：它绑定的受管对象**一起下线**，应用本身不再可用。

    应用退役**不是**「停用」（停用还能再开）——退役是**收工**：
    对象下线、物理表清掉、应用停用、记录留下。
    """
    # 逐对象 DDL 会提交，App行锁无法覆盖整个集合；本期不宣称在线整域退役安全。
    write_zone_schema.assert_engineering_entry()
    write_zone_schema.require_maintenance_window()
    identity = _actor(actor_identity)
    application_id = str(application_id or "").strip()
    reason = str(reason or "").strip()
    if not application_id:
        _fail("请指定要退役的应用")
    if not reason or len(reason) > 500:
        _fail("请填写 1–500 字退役原因")
    if not frappe.db.exists(DEFINITION, application_id):
        _fail("应用不存在")
    retired_objects = []
    # 上次可能已下线并commit、但DROP/回执未完成；不能因active=0漏掉耐久fence。
    for row in frappe.get_all(MODEL, filters={"application": application_id},
                              or_filters={"active_revision": [">", 0], "scope_fence": ["is", "set"]},
                              fields=["name"]):
        receipt = retire_managed_object(row["name"], reason="随应用下线：" + reason,
                                        actor_identity=identity)
        retired_objects.append(receipt["object_id"])
    # 应用本身：停用（退役的应用不该再出现在可用清单里）。
    frappe.db.set_value(DEFINITION, application_id, "status", "Disabled", update_modified=False)
    frappe.db.commit()
    return {"retired": True, "application_id": application_id, "actor_identity": identity,
            "reason": reason, "retired_at": str(now_datetime()),
            "retired_objects": retired_objects}
