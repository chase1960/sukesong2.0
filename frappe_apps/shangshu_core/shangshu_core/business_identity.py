"""内核：**按业务编号找行**（表层公共能力，2026-10-22 收进内核）。

**为什么要有这个口**（用户 2026-10-22 原话）：
「没有『按业务编号找行』的公共能力 ⇒ example 自己写了一遍 `example.case_row.find_by_identity`。
  你的原话『**UC02 关联费用也用同一个办法**』还没做到——**该收进内核**。」

**这一层与 `model_records.find_record_by_identity` 的分工**：
· `model_records.find_record_by_identity`：**受管记录**层的找行（对象 id ＋ 字段 ＋ 值）；
· **本模块**：**业务表**层的找行（表身份 ＋ 身份列 ＋ 编号）——
  业务表是**工作簿**（Excel），行身份在**文件域**手里（编号 ↔ 工作簿行 ID 的映射），
  所以这一层**编排**「按受管列正式值精确找行」（文件域那一份），
  并把它包成**所有域都能用的统一形状**。

**example 与 UC02 用同一个办法** ⇒ 这段编排**只在内核有一份**：
域里只声明「这张表的哪一列是业务编号」（那是**域的业务事实**，各表不同），
其余（精确找行、多行时不猜、没晋升时说清代价）**一律走内核**。

**不猜**：对上多行 ⇒ `ambiguous=True` ＋ 候选清单，**不决定是哪一行**；
没登记／不是受管列 ⇒ 说清为什么，**不拿第一列凑一个**。
"""
import frappe


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def resolve_row_by_identity(_service, payload, _context=None):
    """把「**表 ＋ 工作簿行 ID**」解析成「**受管对象 id ＋ 受管记录名**」。

    **为什么要有这个口**（用户 2026-10-22 第四段）：
    「为了让『日志』这一块能按案件看，内核还需补两个口——让动作审计与事件能正式挂到
      受管记录上（与流程那个 `business_object_id` 同款思路），以及让域能按业务标识
      取到这些记录。」
    ⇒ 挂到受管记录上要两样东西：**受管对象 id** ＋ **受管记录名**；
    而业务域手里只有「表 ＋ 行 ID」⇒ 得有人把这两个换算出来。
    **换算的映射在文件域手里**（晋升绑定）⇒ 这里**编排**它，**不自己造一份**。

    「example 与 UC02 关联费用用**同一个办法**」⇒ 编排**只在内核有一份**。
    """
    from shangshu_core.domains import invoke_domain_service

    table = str((payload or {}).get("table") or "").strip()
    row_id = str((payload or {}).get("row_id") or "").strip()
    if not table:
        _fail("表身份必填")
    if not row_id:
        _fail("行 ID 必填")
    result = invoke_domain_service("files.row_resolve", {"table": table, "row_id": row_id})
    return {"table": table, "row_id": row_id,
            "object_id": str(result.get("object_id") or ""),
            "record": str(result.get("record") or ""),
            "found": bool(result.get("found")),
            "hint": str(result.get("hint") or "")}


def find_row_by_business_identity(_service, payload, _context=None):
    """按**业务编号**（行身份）在业务表里找那一行。

    ⚠️ 签名是**内核域服务的约定**：`handler(service_id, payload, context)`。

    输入：`{table, field, value}` ——
    · `table`：业务表身份（工作簿的表身份，**不写死**）；
    · `field`：**受管字段**名（如 `case_no`）——认行只能用**已晋升的列**；
    · `value`：业务编号（如示例企业内部编号）。

    输出（统一形状，各域一致）：
    · 命中一行 ⇒ `found=True` ＋ `row_id` ＋ `record`（受管记录名）；
    · 对上多行 ⇒ `found=False` ＋ `ambiguous=True` ＋ `candidates`；
    · 没找到   ⇒ `found=False` ＋ `hint`（说清为什么）。
    """
    from shangshu_core.domains import invoke_domain_service

    table = str((payload or {}).get("table") or "").strip()
    field = str((payload or {}).get("field") or "").strip()
    value = (payload or {}).get("value")
    if not table:
        _fail("表身份必填")
    if not field:
        _fail("请指定用哪一列作业务编号（受管字段名）")
    if value is None or (isinstance(value, str) and not value.strip()):
        _fail("业务编号不能为空")

    result = invoke_domain_service("files.row_find_by_value",
                                    {"table": table, "field": field, "value": value})
    base = {"table": table, "field": field, "value": value,
            "object_id": str(result.get("object_id") or ""),
            "exact": bool(result.get("exact")),
            "found": False, "ambiguous": False,
            "row_id": "", "record": "", "candidates": [], "hint": ""}
    if not result.get("exact"):
        base["hint"] = (result.get("hint")
                         or "按业务编号找行暂时做不到（这一列不是受管列，正式值不在受管记录里）")
        return base
    rows = result.get("rows") or []
    base["candidates"] = [{"row_id": str(row.get("row_id") or ""),
                            "record": str(row.get("record") or ""),
                            "value": row.get("value")} for row in rows]
    if not rows:
        base["hint"] = result.get("hint") or ("业务编号 %s 在这张表里没有对应的行" % value)
        return base
    if len(rows) > 1:
        base["ambiguous"] = True
        base["hint"] = ("这个业务编号对上了 %d 行，不敢决定是哪一行（请人工指定）" % len(rows))
        return base
    base["found"] = True
    base["row_id"] = base["candidates"][0]["row_id"]
    base["record"] = base["candidates"][0]["record"]
    base["value"] = base["candidates"][0].get("value")
    return base
