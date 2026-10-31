"""受管对象纯编译器：无数据库访问、无 DDL，物理名称不接受客户端指定。

**两种权限声明形状**（PKG-117-T01，2026-10-25 列级权限按主体范围分配）：

  · **新形状（主体范围）** —— 受管表（晋升上来的表）走这一条：
    `{"read": {"scope": "global"}, "write": {"scope": "department", "departments": [...]},
    "download": {...}, "record_scope": "own"|"all"}`。
    规则本体在 `shangshu_core.subject_access`（**纯规则**，可脱离 frappe 测）。
  · **旧形状（角色键）** —— 建模对象链（用户用建模器建的普通对象）**照旧**：
    `{"read_roles": [...], "write_roles": [...], "record_scope": ...}`。

⇒ **两条链各自只用自己的模型**：这里按**声明自己的形状**分流，
**不写回落分支**互相兜；新形状里夹角色键 ⇒ **当场拒**（不留兼容写法）。
"""
import hashlib
import re
import math

from shangshu_core import subject_access


class ModelError(ValueError):
    pass


TYPES = {"text":"Data", "long_text":"Long Text", "integer":"Int", "decimal":"Float",
         "boolean":"Check", "date":"Date", "choice":"Select", "reference":"Link", "detail":"Table"}
FIELD_KEYS = {"id", "label", "type", "required", "options", "target", "deprecated", "constraints",
              "read_roles", "write_roles", "download_roles", "access", "value_domain",
              # 「从现在起必填」：必填**只对往后生效**，存量不用补齐（2026-10-30）。
              # ⚠️ **只在声明为 False 时才带这个键** ⇒ 别的字段规格一个字不变
              #   （全都带上 ⇒ 每���字段都算「变了」⇒ 白白触发一次全模型改版）。
              "required_backfill"}

# 物理表的**宽底座角色**（新形状落这条）：Frappe 的 DocPerm 只能写角色 ⇒
# 宽底座角色只让 `doc.check_permission` 过，**细判在域层/内核层**（按主体判）。
BASE_ROLE = "Desk User"


def _roles(value):
    if not isinstance(value, list) or not value or any(not isinstance(v,str) or not v.strip() or v in {"Guest","All"} for v in value):
        raise ModelError("权限需选择明确角色")
    return sorted(set(value))


def _value_domain(field, label):
    """**值域清单**（这一列能填哪些值）—— 编译期校验，形状错了当场拒。

    ★ **为什么要有它**（原收敛条目 02 · 2026-10-26）：
      值域清单原本**只存在文件域的声明里**（`rules.options` ＋ `rules.allow_custom`），
      编译成受管对象定义时**被丢掉** ⇒ 对象侧的写入口
      （`platform.object.create`／`update`）**不知道这一列有清单**
      ⇒ 清单外的值能从那条路写进去 ⇒ 「非法枚举在所有写入口均拒绝」不成立。
      ⇒ 现在清单**跟着定义进内核** ⇒ **所有写入口**都按同一份清单判。

    · `options` —— 标准项清单（不重复的单行文本）；
    · `allow_custom` —— **能不能填清单以外的值**：
      **没写 = 不拦**（清单只当提示：下拉提供其他，人工填写原文保存 —— 旧项目那条口径）；
      **显式写 `false` = 硬拦**（值不在清单里当场拒）。

    ⚠️ **逐字比对，不 trim** —— 「受理 」和「受理」是两种写法；
    trim 就等于偷偷把用户写的原文改成标准项（与「保留原文」相反）。
    """
    domain = field.get("value_domain")
    if domain is None:
        return None
    if not isinstance(domain, dict):
        raise ModelError("字段「%s」的值域声明必须是对象" % label)
    options = domain.get("options")
    if (not isinstance(options, list) or not options
            or any(not isinstance(x, str) or not x.strip() or len(x) > 100 or "\n" in x or "\r" in x
                   for x in options)
            or len(set(options)) != len(options)):
        raise ModelError("字段「%s」的值域清单需为不重复的单行文本列表" % label)
    allow = domain.get("allow_custom")
    if allow is not None and type(allow) is not bool:
        raise ModelError("字段「%s」的值域「允许自定义」必须是布尔值" % label)
    return {"options": list(options), "allow_custom": True if allow is None else bool(allow)}


def field_schema(field):
    """逻辑字段到公共输入规则的唯一投影，不保存第二份 schema。"""
    kind = field["type"]
    result = {"type": {"integer":"integer", "decimal":"number", "boolean":"boolean",
                       "detail":"array"}.get(kind, "string"), "title":field["label"]}
    if kind == "choice":
        result["enum"] = field["options"]
    if kind == "date":
        result["format"] = "date"
    if kind == "long_text":
        result["multiline"] = True
    if kind == "text":
        result["maxLength"] = 140  # Frappe Data 的实际列容量。
    if kind == "integer":
        result.update(minimum=-2147483648, maximum=2147483647)
    if kind == "detail":
        result.update(minItems=1 if field["required"] else 0, maxItems=1000)
    result.update(field.get("constraints", {}))
    if field["required"] and result["type"] == "string":
        result["minLength"] = max(1, result.get("minLength", 0))
    if field["required"] and kind == "detail":
        result["minItems"] = max(1, result.get("minItems", 0))
    return result


def record_schema(compiled, references=None):
    """表单/动作共享逻辑键；明细目标必须由授权调用层提供。

    ⚠️ **「从现在起必填」的标记要带进 properties**（2026-10-30 · PKG-133 · W2）：
    整条记录校验（`schema_validation._without_optional_nulls`）要认出
    「这个字段是**从现在起**才必填、存量可以还空着」
    ⇒ 那个标记必须**跟着字段规格一起走**到校验那一步
    ⇒ 否则内核认不出来 ⇒ 存量行那条空字段会把整条记录拒掉
    （真站实测：往「申请号」粘一个值 ⇒ 417「…case_direction 应为 string」）。
    ⚠️ **只带 `False` 那一种**（`required_backfill = True` 是默认行为，不带）。
    """
    properties = {}
    for field in compiled["fields"]:
        if field["deprecated"]:
            continue
        spec = field_schema(field)
        if field["type"] == "detail":
            target = (references or {}).get(field["target"])
            if not target or target["kind"] != "detail":
                raise ModelError("缺少有权访问的明细定义")
            spec["items"] = record_schema(target)
        if field.get("required_backfill") is False:
            spec["required_backfill"] = False
        properties[field["id"]] = spec
    return {"type":"object", "properties":properties, "additionalProperties":False,
            "required":[field["id"] for field in compiled["fields"] if field["required"] and not field["deprecated"]]}


def _constraints(field, kind):
    rules = field.get("constraints", {})
    allowed = ({"minimum", "maximum"} if kind in {"integer", "decimal"} else
               {"minLength", "maxLength"} if kind in {"text", "long_text"} else
               {"minItems", "maxItems"} if kind == "detail" else set())
    if not isinstance(rules, dict) or set(rules)-allowed:
        raise ModelError("字段约束不适用于该类型")
    for key, value in rules.items():
        if type(value) not in {int, float} or not math.isfinite(value):
            raise ModelError("字段约束必须为有限数值")
        if kind not in {"integer", "decimal"} and (type(value) is not int or value < 0):
            raise ModelError("长度和行数约束必须为非负整数")
    for low, high in (("minimum", "maximum"), ("minLength", "maxLength"), ("minItems", "maxItems")):
        if low in rules and high in rules and rules[low] > rules[high]:
            raise ModelError("字段约束下限不能大于上限")
    if field.get("required") and (rules.get("maxLength") == 0 or rules.get("maxItems") == 0):
        raise ModelError("必填字段不能限制为零长度")
    if kind == "text" and any(rules.get(key, 0) > 140 for key in ("minLength", "maxLength")):
        raise ModelError("短文本最多 140 字，更长内容请使用长文本")
    if kind == "integer" and any(value < -2147483648 or value > 2147483647 for value in rules.values()):
        raise ModelError("整数约束超出存储范围")
    if kind == "detail" and any(value > 1000 for value in rules.values()):
        raise ModelError("明细最多支持 1000 行")
    return dict(rules)


def physical_name(object_id):
    return "SSM " + hashlib.sha256(object_id.encode()).hexdigest()[:28]


def physical_permissions(access):
    """物理表的 **DocPerm**：按对象声明的 `access` 落。

    **两种形状，落法不同**（PKG-117-T01）：

    · **新形状（主体范围）** ⇒ 落**宽底座角色**（读＋写）。
      理由：Frappe 的 DocPerm **只能写角色** ⇒ 主体范围（全局/部门/个人）
      没法写进 DocPerm ⇒ 物理表只给宽底座让 `doc.check_permission` 过，
      **细判留给域层/内核层**（`org_admin.subject_allows` / `field_subject_allows`）。
    · **旧形状（角色键）** ⇒ 照旧：`read_roles` 里的角色**能读**；
      `write_roles` 里的角色**才能写**（只在 read 里的 ⇒ 只读）；
      两个都没声明 ⇒ **一点权限都不给**（不许凭空给）。

    @param {dict} access 对象声明的权限
    @returns {list} Frappe 的权限行形状（`{role, read, write}`）
    """
    access = access if isinstance(access, dict) else {}
    if subject_access.is_subject_access(access):
        # 宽底座：让底层闸过，细判在主体层（域层/内核层按主体判）。
        return [{"role": BASE_ROLE, "read": 1, "write": 1}]
    read_roles = [role for role in (access.get("read_roles") or []) if isinstance(role, str) and role.strip()]
    write_roles = [role for role in (access.get("write_roles") or []) if isinstance(role, str) and role.strip()]
    permissions = []
    for role in read_roles + [role for role in write_roles if role not in read_roles]:
        permissions.append({"role": role, "read": 1, "write": 1 if role in write_roles else 0})
    return permissions


def compile_object(owner, object_id, definition, references=None):
    """owner/object_id 由调用层分配和鉴权；references 仅含调用者获准使用的目标。"""
    if not isinstance(owner,str) or not re.fullmatch(r"com\.shangshu\.app\.[a-f0-9]{32}",owner):
        raise ModelError("对象必须归属受管应用")
    if not isinstance(object_id,str) or not re.fullmatch(re.escape(owner)+r"\.object\.[a-f0-9]{32}",object_id):
        raise ModelError("对象 ID 不属于当前应用")
    if not isinstance(definition,dict) or set(definition)-{"schema_version","title","kind","fields","access","unique_keys"}:
        raise ModelError("对象定义含不支持的属性")
    if type(definition.get("schema_version")) is not int or definition["schema_version"]!=1:
        raise ModelError("对象定义版本不支持")
    title=definition.get("title")
    if not isinstance(title,str) or not 1<=len(title.strip())<=100:
        raise ModelError("对象名称需为 1–100 字")
    kind=definition.get("kind","record")
    if kind not in {"record","detail"}:
        raise ModelError("对象种类不支持")
    access = definition.get("access", {"read_roles":["Desk User"], "write_roles":["Desk User"], "record_scope":"own"})
    if not isinstance(access,dict):
        raise ModelError("对象权限需声明读写角色及本人/全部记录范围")
    if subject_access.is_subject_access(access):
        # ---- 新形状：五操作 × 主体范围（受管表链） ----
        try:
            subject_access.assert_no_role_keys(access, where="对象「%s」的权限声明" % title.strip())
            record_scope = access.get("record_scope", "own")
            if record_scope not in {"own", "all"}:
                raise ModelError("对象权限需声明本人/全部记录范围")
            normalized = subject_access.normalize_access(
                access, where="对象「%s」的权限声明" % title.strip(),
                required=subject_access.REQUIRED_OPS, extra_keys=("record_scope",))
        except ValueError as error:
            raise ModelError(str(error))
        access = {**normalized, "record_scope": record_scope}
    else:
        # ---- 旧形状：角色键（建模对象链）—— 照旧 ----
        if set(access)-{"read_roles","write_roles","record_scope","recycle_roles"} or not {"read_roles","write_roles","record_scope"}<=set(access) or access["record_scope"] not in {"own","all"}:
            raise ModelError("对象权限需声明读写角色及本人/全部记录范围")
        access = {**access, "read_roles":_roles(access["read_roles"]), "write_roles":_roles(access["write_roles"])}
        if 'recycle_roles' in access:
            access['recycle_roles']=[] if access['recycle_roles']==[] else _roles(access['recycle_roles'])
    fields=definition.get("fields")
    if not isinstance(fields,list) or not 1<=len(fields)<=100:
        raise ModelError("每个对象需有 1–100 个字段")
    seen, normalized, columns = set(), [], []
    for field in fields:
        if not isinstance(field,dict) or set(field)-FIELD_KEYS:
            raise ModelError("字段含不支持的属性")
        field_id=field.get("id")
        if not isinstance(field_id,str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,47}",field_id) or field_id in seen or field_id in {"name","modified","creation"}:
            # ⚠️ `name`／`modified`／`creation` 是**内核给的固定尾注**（行 ID／最后写入的时间／
            #   **进到这个受管对象的时间**）⇒ 域不许拿它们当自己的字段名
            #   （否则域给的那一列会被内核那一行**悄悄盖掉** ⇒ 人看到的值就是错的）。
            raise ModelError("字段 ID 格式错误或重复")
        seen.add(field_id)
        label=field.get("label")
        if not isinstance(label,str) or not 1<=len(label.strip())<=100:
            raise ModelError("字段名称需为 1–100 字")
        field_type=field.get("type")
        if field_type not in TYPES:
            raise ModelError("字段类型未支持")
        if any(key in field and type(field[key]) is not bool for key in ("required","deprecated")):
            raise ModelError("必填与弃用标记必须为布尔值")
        item={"id":field_id,"label":label.strip(),"type":field_type,
              "required":field.get("required",False),"deprecated":field.get("deprecated",False)}
        # —— 「从现在起必填」：模型字段**照样** required
        #   （⇒ harness-values 那三项约束里的「能不能留空」是准的；
        #   空着的存量字段**不挡**这一行的别的格子 —— 整条记录校验时跳过空值）；
        #   只是**不要求把存量补齐** ⇒ 回填那道闸放行（见 plan_object_change）。
        #   ⚠️ **「写空」现在不拒**（2026-10-30 用户口径：必填是**提醒**不是拦路
        #   ——「不强制不能保存（因为我一行要一个格子一个格子输入）」，
        #   空着的格子由前端**框红＋toast 提醒**）⇒ 拒空不再是这一层的职责。
        if field.get("required_backfill") is False:
            item["required_backfill"]=False
        constraints = _constraints(field, field_type)
        if constraints:
            item["constraints"] = constraints
        # ---- 值域清单（跟着定义进内核 ⇒ 所有写入口按同一份清单判）----
        value_domain = _value_domain(field, label.strip())
        if value_domain:
            item["value_domain"] = value_domain
        if "access" in field:
            # ---- 新形状：列级主体范围（受管表链）→ 编译期就校验形状 ----
            try:
                subject_access.assert_no_role_keys(field, where="字段「%s」" % label.strip())
                item["access"] = subject_access.normalize_access(
                    field["access"], where="字段「%s」的权限声明" % label.strip(),
                    required=subject_access.REQUIRED_OPS)
            except ValueError as error:
                raise ModelError(str(error))
        for rule in ("read_roles", "write_roles", "download_roles"):
            if rule in field:
                item[rule] = [] if rule == "download_roles" and field[rule] == [] else _roles(field[rule])
        # ⚠️ **「从现在起必填」的字段：物理列**不标** `reqd`（2026-10-30 · PKG-133 · W2）。
        #   物理列的 `reqd` 是 **Frappe 那一层**的闸 ⇒ 它拦的是**整行**（不是那一格）：
        #   存量行那些还没填的字段一旦标了 `reqd` ⇒ **Frappe 直接拒整次保存**
        #   （真站实测：「Value missing for SSM …: 申请途径」MandatoryError）
        #   ⇒ 「从现在起必填」会变成「**这一行一个格子都不能改**」。
        #   ⇒ 「从现在起必填」的字段物理列 `reqd = 0`；
        #   　**「不许留空」那句谁来说** ⇒ 2026-10-30 起**不再拒空**
        #   　（必填改成**提醒**：空着的格子**框红＋toast**，**不挡保存**）
        #   　⇒ 「能不能留空」这条口径仍然准（模型字段照样 required）。
        #   ⚠️ **老口径必填照旧**（没声明 `required_backfill`）⇒ `reqd = 1`（一个字没改）。
        column={"fieldname":"f_"+hashlib.sha256((object_id+":"+field_id).encode()).hexdigest()[:20],
                "label":label.strip(),"fieldtype":TYPES[field_type],
                "reqd":int(item["required"] and item.get("required_backfill") is not False),
                "hidden":int(item["deprecated"])}
        if item["deprecated"] and item["required"]:
            raise ModelError("弃用字段不能继续必填")
        if field_type=="choice":
            options=field.get("options")
            if not isinstance(options,list) or not 1<=len(options)<=100 or any(not isinstance(x,str) or not x.strip() or len(x)>100 or "\n" in x or "\r" in x for x in options) or len(set(options))!=len(options):
                raise ModelError("选项需为不重复的单行文本列表")
            item["options"]=list(options);column["options"]="\n".join(options)
        elif "options" in field:
            raise ModelError("只有选项字段可设置选项")
        if field_type in {"reference","detail"}:
            target=field.get("target")
            reference=(references or {}).get(target) if isinstance(target,str) else None
            if not reference or not reference.get("doctype"):
                raise ModelError("关联目标不存在或无引用权限")
            if (field_type=="detail") != (reference.get("kind")=="detail") or (kind=="detail" and field_type=="detail"):
                raise ModelError("明细只允许关联明细对象，且不能嵌套明细")
            item["target"]=target;column["options"]=reference["doctype"]
        elif "target" in field:
            raise ModelError("该字段类型不能设置关联目标")
        normalized.append(item);columns.append(column)
    pins = {f["target"]: references[f["target"]]["revision"] for f in normalized
            if f["type"]=="detail" and references[f["target"]].get("revision")}
    unique_keys = _unique_keys(definition.get("unique_keys", []), normalized)
    return {"id":object_id,"owner":owner,"schema_version":1,"title":title.strip(),"kind":kind,"fields":normalized,"access":access,
            "unique_keys":unique_keys,"reference_revisions":pins,
            "doctype":{"name":physical_name(object_id),"custom":1,"istable":int(kind=="detail"),"fields":columns,
                       "permissions":physical_permissions(access)}}


UNIQUE_SCALAR = {"text","long_text","integer","decimal","date","choice","boolean"}


def _unique_keys(value, fields):
    """业务唯一键：显式声明字段组合；空组合不视为唯一，明细/关联/弃用字段不允许。"""
    if not isinstance(value,list) or len(value)>10:
        raise ModelError("业务唯一键最多声明 10 组")
    by_id={field["id"]:field for field in fields}
    normalized=[];seen=set()
    for group in value:
        if not isinstance(group,list) or not 1<=len(group)<=5 or any(not isinstance(key,str) for key in group):
            raise ModelError("每组唯一键需为 1–5 个字段")
        keys=sorted(set(group))
        if len(keys)!=len(group):
            raise ModelError("同一组唯一键不能重复字段")
        canonical=tuple(keys)
        if canonical in seen:
            raise ModelError("重复声明的唯一键")
        seen.add(canonical)
        for key in keys:
            field=by_id.get(key)
            if not field:
                raise ModelError("唯一键字段不存在")
            if field["deprecated"]:
                raise ModelError("弃用字段不能作为唯一键")
            if field["type"] not in UNIQUE_SCALAR:
                raise ModelError("唯一键字段须为标量，不含关联或明细")
        normalized.append(list(canonical))
    return normalized


def plan_object_change(previous, proposed):
    """仅生成变化分类；needs_data_check 不代表可以直接执行。"""
    if previous is None:
        return {"operation":"create","changes":[],"blocked":[],"needs_data_check":[],"ddl_required":True}
    if any(previous[key]!=proposed[key] for key in ("id","owner","kind")):
        raise ModelError("不能改变对象 ID、所有者或主从类型")
    old={field["id"]:field for field in previous["fields"]}
    new={field["id"]:field for field in proposed["fields"]}
    blocked=[{"field":key,"reason":"field_removal_requires_deprecation"} for key in sorted(old.keys()-new.keys())]
    changes=[];checks=[];ddl=False
    for key, operation in (("access","permissions"),("reference_revisions","references"),("title","title"),("unique_keys","unique_keys")):
        if previous.get(key)!=proposed.get(key):changes.append({"field":None,"operation":operation})
    if previous.get("unique_keys")!=proposed.get("unique_keys"):
        checks.append({"field":None,"reason":"existing_uniqueness_conflicts"})
    for key,field in new.items():
        if key not in old:
            changes.append({"field":key,"operation":"add"});ddl=True
            if field["required"]:checks.append({"field":key,"reason":"backfill_required"})
            continue
        prior=old[key]
        if prior==field:continue
        changes.append({"field":key,"operation":"update"})
        if prior["type"]!=field["type"] or prior.get("target")!=field.get("target"):
            blocked.append({"field":key,"reason":"type_or_target_change_requires_migration"})
        # ⚠️ **「从现在起必填」**（2026-10-30）：字段声明了 `required_backfill = False`
        #   ⇒ 必填**只对往后生效** ⇒ **不要求把存量补齐**（这一道闸就是那件事的闸）。
        #   ⇒ 模型字段**照样** required（「能不能留空」是准的）；
        #   ⚠️ **写空不拒**（2026-10-30 起必填改成**提醒**：框红＋toast，不挡保存）。
        if field["required"] and not prior["required"] and field.get("required_backfill", True):
            checks.append({"field":key,"reason":"existing_nulls"})
        if set(prior.get("options",[]))-set(field.get("options",[])):
            checks.append({"field":key,"reason":"removed_options_in_use"})
        if prior.get("constraints", {}) != field.get("constraints", {}):
            checks.append({"field":key,"reason":"existing_values_constraints"})
        # ---- 值域清单收窄 ⇒ 存量值可能已在清单外 ⇒ 要查 ----
        prior_domain = prior.get("value_domain") or {}
        new_domain = field.get("value_domain") or {}
        if prior_domain != new_domain:
            dropped = set(prior_domain.get("options") or []) - set(new_domain.get("options") or [])
            if dropped and not new_domain.get("allow_custom", True):
                checks.append({"field":key,"reason":"existing_values_value_domain"})
    return {"operation":"update","changes":changes,"blocked":blocked,"needs_data_check":checks,"ddl_required":ddl}
