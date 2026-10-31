"""Action、事件与办理表单共用的值校验子集。"""
import re
import math
from datetime import date

import frappe


# ⚠️ **「从现在起必填」的字段 id 名单**（2026-10-30 · PKG-133 · W2）。
#   模型规格里这类字段带 `required_backfill = False`（必填只对往后生效、存量不用补齐）。
#   ⚠️ **为什么名单在这里、不在调用方**：
#   · 整条记录校验这一步（写受管记录时合并全记录再校验）**发生在内核**，
#     调用方（文件域／example 域）拿不到「哪些字段是从现在起才必填」这份口径
#     ⇒ 口径必须**跟着模型规格走**（规格里已经带着那个标记），
#     而不是让每个调用方自己带一份名单（⇒ 迟早对不上）。
#   ⇒ 这里按**模型规格里的标记**判（`required_backfill`），不认字段名。
#   ⚠️ **为什么名单是空字符串集合、而不是判定逻辑**：
#   这份校验器是**通用**的（动作／事件／表单共用）⇒ 不该认识「案号方向」这种业务字面量
#   ⇒ 业务侧的「哪些字段从现在起必填」由**模型规格**声明，内核只读那个标记。

def _is_forward_only_required(field_schema):
    """这个字段是不是「**从现在起**才必填」（存量可以还空着）。"""
    return isinstance(field_schema, dict) and field_schema.get("required_backfill") is False


def _without_optional_nulls(value, schema):
    """**空值不算错**的那些字段，从校验用的值里拿掉。

    ⚠️ **为什么要有这一步**（2026-10-30 站上实测撞出来的）：
    内核写受管记录时会**合并整条记录再校验**
    ⇒ 存量行里那些**还没填**的必填字段（`None`）被合并进来
    ⇒ 类型校验说「它该是 string，可它是 None」⇒ **整条记录被拒**
    ⇒ 表现是：「人改那一行的**任何一个别的**格子，都被一条**没碰过**的空字段挡下来」
    （真站实测：往「申请号」粘一个值 ⇒ 417「示例企业总表…xlsx.case_direction 应为 string」）。

    ⚠️ **两类字段的区别**（这是这一件的全部要害）：
    · **老口径必填**（没声明 `required_backfill`）⇒ 存量也必须补齐
      ⇒ 空值**保留**在校验值里 ⇒ 照旧被拒（**老行为一个字没改**）。
    · **「从现在起」必填**（声明了 `required_backfill = False`）⇒ 存量不用补
      ⇒ 空值**拿掉**（不参与类型校验）⇒ 不挡别的格子。
      ⚠️ 但**写那一个字段本身**仍按必填拒（不许留空）—— 那是**字段级**的闸，不归这里管。
    """
    if schema.get("type") == "object":
        properties = schema.get("properties") or {}
        required = schema.get("required") or []
        out = {}
        for key, item in value.items():
            field_schema = properties.get(key) or {}
            if item is None and (key not in required or _is_forward_only_required(field_schema)):
                # —— 空值：老口径必填要**留着**（照旧拒）；「从现在起」必填**拿掉**（不挡别的格子）——
                continue
            out[key] = _without_optional_nulls(item, field_schema)
        return out
    if schema.get("type") == "array":
        items_schema = schema.get("items") or {}
        return [_without_optional_nulls(item, items_schema) for item in value]
    return value


def _matches_type(value, expected):
    if isinstance(expected, list):
        return any(_matches_type(value, kind) for kind in expected)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return False


def _schema_equal(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_schema_equal(left[key],right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_schema_equal(a,b) for a,b in zip(left,right))
    return left == right


def _shape_gate(schema, path):
    """**声明本身的形状**（2026-10-29）。

    ⚠️ **为什么要有这一件**：内核查询口没有「限定字段的搜索」…
    （这里说的是**校验**：声明写坏时，下面那几行会抛**英文 TypeError** ⇒
    HTTP 500 ＋ 英文栈 ⇒ 人看到的是「服务器坏了」，不是「你带的字段不对」。
    ⇒ 形状不对**一律中文 `ValidationError`**（417），且**说清是声明里的哪一项**。

    **校验的形状**：
    · `properties` ＝ 对象（字段名 → 字段声明）；
    · `required` / `enum` ＝ 数组；
    · `items` ＝ 对象；
    · `additionalProperties` ＝ 布尔（关掉额外字段）或对象（额外字段的声明）。
    """
    for key, expected in (("properties", dict), ("items", dict)):
        value = schema.get(key)
        if value is not None and not isinstance(value, expected):
            frappe.throw(f"字段定义含未支持的校验规则：{path}.{key}（形状不对）", frappe.ValidationError)
    for key in ("required", "enum"):
        value = schema.get(key)
        if value is not None and not isinstance(value, (list, tuple)):
            frappe.throw(f"字段定义含未支持的校验规则：{path}.{key}（形状不对）", frappe.ValidationError)
    value = schema.get("additionalProperties")
    if value is not None and not isinstance(value, (bool, dict)):
        frappe.throw(f"字段定义含未支持的校验规则：{path}.additionalProperties（形状不对）", frappe.ValidationError)


def _validate_schema(value, schema, path="payload"):
    if not schema:
        return
    supported = {"type", "properties", "required", "additionalProperties", "items", "enum", "title", "description",
                 "default", "enumNames", "multiline", "suggestions", "minimum", "maximum", "exclusiveMinimum",
                 "exclusiveMaximum", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems",
                 # `ss_role` 是**字段角色元标记**，不是校验规则：`audit` = 审计上下文，
                 # 不参与「是不是同一次」的业务指纹比对（PKG-013-T01）。
                 # 详见 action_requests.audit_keys_of / BUSINESS_CRITICAL_KEYS。
                 "ss_role",
                 # ⚠️ `required_backfill` 也是**字段级元标记**，不是校验规则（2026-10-30 · PKG-133 · W2）：
                 #   它说的是「这一列是**从现在起**才必填，存量不用补齐」
                 #   ⇒ **校验器不拿它判什么**，但它**跟着模型规格走**（`record_schema` 会带上它）
                 #   ⇒ 不认它 ⇒ **整条记录写不进去**（真站实测：写「申请号」⇒
                 #   417「字段定义含未支持的校验规则：…case_direction」）。
                 #   ⇒ 认它（当它不存在），**别让这个标记挡住人写数据**。
                 "required_backfill"}
    if not isinstance(schema, dict) or set(schema) - supported:
        frappe.throw(f"字段定义含未支持的校验规则：{path}", frappe.ValidationError)
    # ⚠️ **声明本身的形状也要校验**（2026-10-29 站上实测撞出来的）：
    #   声明写坏（`properties` 写成数组 / `required` 写成数字 / `enum` 写成数字）
    #   ⇒ 下面那几行会抛**英文 TypeError**（⇒ HTTP 500 + 英文栈）
    #   ⇒ 同一个「报未声明字段」的场景，**有时中文 417、有时英文 500**
    #   （用户原话：「新核心报 payload 有未声明字段时抛英文 TypeError ⇒ 要中文错」）。
    #   ⇒ 这里先把形状收成中文 ⇒ 后面的代码只处理「形状对」的声明。
    _shape_gate(schema, path)
    expected = schema.get("type")
    if expected and not _matches_type(value, expected):
        frappe.throw(f"动作字段类型不正确：{path} 应为 {expected}", frappe.ValidationError)
    if "enum" in schema and not any(_schema_equal(value,item) for item in schema["enum"]):
        frappe.throw(f"动作字段值不在允许范围：{path}", frappe.ValidationError)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value,float) and not math.isfinite(value):
            frappe.throw(f"字段必须为有限数值：{path}", frappe.ValidationError)
        for key, rejected in (("minimum", lambda a,b:a<b), ("maximum", lambda a,b:a>b),
                              ("exclusiveMinimum", lambda a,b:a<=b), ("exclusiveMaximum", lambda a,b:a>=b)):
            if key in schema:
                bound = schema[key]
                if isinstance(bound, bool) or not isinstance(bound,(int,float)) or (isinstance(bound,float) and not math.isfinite(bound)):
                    frappe.throw(f"数值边界定义无效：{path}.{key}", frappe.ValidationError)
                if rejected(value,bound):
                    frappe.throw(f"字段超出允许范围：{path}（{key}={bound}）", frappe.ValidationError)
    if isinstance(value, (str,list)):
        keys = ("minLength","maxLength") if isinstance(value,str) else ("minItems","maxItems")
        for key, rejected in ((keys[0],lambda a,b:a<b),(keys[1],lambda a,b:a>b)):
            if key in schema:
                bound=schema[key]
                if isinstance(bound,bool) or not isinstance(bound,int) or bound<0:
                    frappe.throw(f"长度边界定义无效：{path}.{key}", frappe.ValidationError)
                if rejected(len(value),bound):
                    frappe.throw(f"字段长度不符合要求：{path}（{key}={bound}）", frappe.ValidationError)
    if isinstance(value,str):
        if "format" in schema:
            if schema["format"] != "date":
                frappe.throw(f"尚未支持该字段格式：{path}", frappe.ValidationError)
            try:
                if date.fromisoformat(value).isoformat() != value:
                    raise ValueError()
            except ValueError:
                frappe.throw(f"日期需为有效的 YYYY-MM-DD：{path}", frappe.ValidationError)
        if "pattern" in schema:
            pattern=schema["pattern"]
            # 仅支持简单字符/字符类及固定重复；避免用户正则造成回溯拒绝服务。
            if not isinstance(pattern,str) or len(pattern)>256 or len(value)>4096 or re.search(r"[()|]|\\[1-9]",pattern) or len(re.findall(r"(?<!\\)[*+?]|\{\d+,",pattern))>1:
                frappe.throw(f"字段格式规则超出安全子集：{path}", frappe.ValidationError)
            try:
                matched=re.search(pattern,value)
            except (re.error, OverflowError):
                frappe.throw(f"字段格式规则无效：{path}", frappe.ValidationError)
            if not matched:
                frappe.throw(f"字段格式不符合要求：{path}", frappe.ValidationError)
    if isinstance(value,list) and schema.get("uniqueItems"):
        if len(value)>1000:
            frappe.throw(f"去重列表最多支持 1000 项：{path}", frappe.ValidationError)
        if any(_schema_equal(item,previous) for index,item in enumerate(value) for previous in value[:index]):
            frappe.throw(f"列表不能包含重复项：{path}", frappe.ValidationError)
    if isinstance(value, dict):
        properties = schema.get("properties") or {}
        for key in schema.get("required") or []:
            if key not in value:
                # ⚠️ **「从现在起必填」的字段可以还空着**（2026-10-30 · PKG-133 · W2）：
                #   必填只对**往后**生效 ⇒ 存量行那些还没填的字段**不参与**这道闸
                #   ⇒ 否则「人改这一行的任何一个别的格子」都会被一条**没碰过**的空字段挡下来
                #   （真站实测：往「申请号」粘一个值 ⇒ 417「…case_direction 应为 string」）。
                #   ⚠️ **写那一个字段本身**仍按必填拒 —— 那是**字段级**的闸（写入口那道），不归这里管。
                if _is_forward_only_required(properties.get(key)):
                    continue
                frappe.throw(f"动作缺少必填字段：{path}.{key}", frappe.ValidationError)
        if schema.get("additionalProperties") is False:
            unknown = set(value) - set(properties)
            if unknown:
                # ⚠️ **键可能混型**（字符串 ＋ 数字）⇒ 直接 `sorted` 会抛英文 TypeError
                #   ⇒ 按字符串排（键名照原样打印）⇒ 一律中文。
                frappe.throw(f"动作包含未声明字段：{path}.{sorted(unknown, key=str)[0]}", frappe.ValidationError)
        for key, item in value.items():
            if key in properties:
                _validate_schema(item, properties[key], f"{path}.{key}")
            elif isinstance(schema.get("additionalProperties"),dict):
                _validate_schema(item,schema["additionalProperties"],f"{path}.{key}")
    if isinstance(value, list) and schema.get("items"):
        for index, item in enumerate(value):
            _validate_schema(item, schema["items"], f"{path}[{index}]")

