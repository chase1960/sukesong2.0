"""**文件 ↔ 文件附件绑定**（文件域这一侧）。

**这一层解决的是契约 §8 第 13 项那个缺口**：
内核**没有**「附件绑定到某件但前端不显示」的口；`platform.object.companion_bind` 是
**受管对象 ↔ 伴随表**的绑定（且限 System Manager），**不是**文件 ↔ 文件的附件绑定。

**为什么在文件域**（架构判断）：
· 「文件 ↔ 文件」是**文件自己的事**（文件域是保证长期存在的公共件）；
· 域与域之间只走公开 Action ⇒ 这个口必须是**公开动作**（别的域才能用它挂派生件）；
· 放进内核要动所有行业线共用的底座 ⇒ 代价大于收益。

**父件侧零改动**（抄老项目 `example_xml_to_pdf.py:660-673`）：
关系记在**附件侧**那一行的四格里（`attachment_of`／`attachment_relation`／
`attachment_derivation_json`／`attachment_visible`）⇒ 父件那一行**一个字都没动**
⇒ 不用给父件加字段、不用 bench migrate 改父件。

**附件不是版本**：绑定**不碰** versions 表、**不占** version_no、**不顶替** current_file
⇒ 父件的版本号与当前内容摘要**不变**（判据 ④ 钉住这条）。

**绑定不扩大权限**：附件能被谁看到，仍按**它自己那份归属**判
（挂到谁身上**不改变**它的归属）⇒ 判据 ⑦ 钉住这条。

**幂等**：绑定键 ＝ 父子两件 + 关系 + 顺序（`attachments.idempotency_key`）⇒
重放拿同一把键 ⇒ **不重复绑**。派生件另有��把键（父件 + 规则版本 + 顺序）
⇒ 同一份原件用同一规则再转一次**不产生第二份派生件**（输出字节一样）。

**孤儿件看得见**：父件被回收／删了，附件**还在**（不静默消失）⇒
父件侧查不到它，但文件中心列表里**看得见它**（它是独立的一件）。
"""
import frappe

from shangshu_files import attachments as rules
from shangshu_files.service import DOCTYPE


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def _file_row(name, fields):
    """读一条 File 行的几格（**读不到就是没有**）。"""
    return frappe.db.get_value(DOCTYPE, name, fields, as_dict=True)


def _require_file(name, what):
    """这个件必须在文件中心里（**不许绑到空气**）。"""
    row = _file_row(name, ["name", "file_name", "status", "current_sha256"])
    if not row or not row.get("name"):
        _fail("%s不存在（编号 %s）" % (what, name))
    return row


def bind(payload):
    """`files.attachment.bind`：把一件**挂成另一件的附件**。

    载荷：
    · `parent_file`（必填）—— 父件编号；
    · `child_file`（必填）—— 附件编号（**这一件已经自己在文件中心里**）；
    · `relation`（可选，默认 `attachment`）—— `attachment`／`derived`；
    · `visible`（可选，默认 true）—— **给不给前端显示**（契约 §8 待拍点 2 的
      「单独存一件但不显示」：不显示 ≠ 查不到，只是不进列表）；
    · **派生件专有**：`rule_version`／`action_ref`／`order`／`sources`
      （血缘五元组的其余四元；`sources` 缺省时用父件当前字节摘要）。
    """
    payload = payload or {}
    parent = str(payload.get("parent_file") or "").strip()
    child = str(payload.get("child_file") or "").strip()
    if not parent:
        _fail("请选择要挂到哪件文件下面（parent_file）")
    if not child:
        _fail("请选择要挂的附件（child_file）")
    if parent == child:
        _fail("不能把一件挂成它自己的附件")

    parent_row = _require_file(parent, "父件")
    child_row = _require_file(child, "附件")

    relation = rules.check_relation(payload.get("relation"))
    visible = payload.get("visible", True)
    visible = 1 if visible in (True, 1, "1", "true", "True") else 0

    derivation_json = ""
    if relation == rules.RELATION_DERIVED:
        sources = payload.get("sources")
        if not sources:
            # 缺省：父件当前字节摘要（**原件不可改** ⇒ 派生自哪份字节要记准）
            sources = [str(parent_row.get("current_sha256") or "")]
        derivation = rules.build_derivation(
            sources=sources,
            output_ref=str(child_row.get("current_sha256") or ""),
            rule_version=payload.get("rule_version"),
            action_ref=payload.get("action_ref"),
            order=payload.get("order", 1),
        )
        derivation_json = rules.derivation_json(derivation)

    # **幂等**：同一对父子重复绑 ⇒ 覆盖同一行（不是新增一行）。
    # ⚠️ `attachment_derivation_json` 是 MySQL 的 **JSON 列** ⇒ **空字符串不是合法 JSON**
    # （直接写 "" 会被数据库当坏数据拒：CONSTRAINT ... failed）⇒ 普通附件写 **`{}`**。
    frappe.db.set_value(
        DOCTYPE, child,
        {
            "attachment_of": parent,
            "attachment_relation": relation,
            "attachment_derivation_json": derivation_json or "{}",
            "attachment_visible": visible,
        },
        update_modified=False,
    )
    return {
        "bound": True,
        "parent_file": parent,
        "child_file": child,
        "relation": relation,
        "visible": bool(visible),
        "already": bool(child_row.get("attachment_of")),
    }


def list_of(payload):
    """`files.attachment.list`：**父件侧**列出挂在它下面的附件。

    ⚠️ 这个口**只按父件反查**（父件侧零字段 ⇒ 靠附件那一行的 `attachment_of` 反查）
    ⇒ 父件被删了 ⇒ 这里查不到（附件还在文件中心列表里，看得见）。
    """
    payload = payload or {}
    parent = str(payload.get("parent_file") or "").strip()
    if not parent:
        _fail("请选择要查哪件文件的附件（parent_file）")
    relation = str(payload.get("relation") or "").strip()
    filters = {"attachment_of": parent}
    if relation:
        filters["attachment_relation"] = rules.check_relation(relation)
    rows = frappe.get_all(
        DOCTYPE,
        filters=filters,
        fields=["name", "file_name", "attachment_relation", "attachment_visible",
                "attachment_derivation_json", "current_sha256", "current_size", "status"],
        order_by="creation asc",
    )
    items = []
    for row in rows:
        derivation = {}
        try:
            derivation = frappe.parse_json(row.get("attachment_derivation_json") or "{}") or {}
        except Exception:  # noqa: BLE001 —— 读侧不因为历史脏数据整份失败
            derivation = {}
        items.append({
            "file": str(row.get("name")),
            "file_name": str(row.get("file_name") or ""),
            "relation": str(row.get("attachment_relation") or ""),
            "visible": bool(row.get("attachment_visible")),
            "sha256": str(row.get("current_sha256") or ""),
            "size_bytes": int(row.get("current_size") or 0),
            "status": str(row.get("status") or ""),
            "derivation": derivation,
        })
    return {"parent_file": parent, "attachments": items, "count": len(items)}
