"""领域显式声明的原生对象接入公共表格/导出/导入；不开放任意 DocType 或裸 SQL。

原生对象自身 DocType 仍是唯一事实，不建镜像受管对象；表格读取沿声明字段，
单元格编辑与导入行都经声明中注册的本域写 Action，确认、幂等与审计语义一致。

⚠️ **2026-10-25 用户拍板的口径**：**新建业务表走「晋升」那条路，不建自己的 DocType**
（表文件 → 每一列都晋升 → 受管对象 ＋ 受管记录 → 动作从内核重新注册）。
**本模块是「存量接入方式」**，不是新建业务表该走的路 ——
域的声明里**新出现**一个带 `doctype` 的对象，内核**当场点名拒**
（见 `shangshu_core.data_ownership` 与 `domains.ensure_registered_domains`）；
**存量不拦**（逐域重走一遍晋升期间不许挡住迁移）。
为什么：受管记录是**内核里的东西**（受字段 ACL 管、受版本闸管、审计进统一日志库），
域拆了以后**数据还能被接手**；而自建的 DocType 是**域的私产**（别的域不许直接读写），
域拆了它就成了**没人认领的孤儿数据**（停用前由 `lifecycle.domain_lifecycle` 点名拦）。
"""
import base64
import hashlib
import json
import re

import frappe
from frappe.utils import getdate
from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

from shangshu_core.domains import assert_domain_enabled, raw_resource

SCALAR_TYPES = ("text", "long_text", "integer", "decimal", "date", "boolean", "choice")
MATCH_TYPES = ("text", "integer", "date", "choice")
MAX_ROWS = 5000
MAX_CELLS = 500000
MAX_BYTES = 20 * 1024 * 1024
MAX_IMPORT_ROWS = 500
MAX_IMPORT_BYTES = 10 * 1024 * 1024


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def declared(object_id):
    """返回 (domain, item, block, write, index)；未声明 native_table 时返回 None。"""
    if not isinstance(object_id, str) or not object_id:
        return None
    domain, item = raw_resource("objects", object_id)
    block = item.get("native_table") if item else None
    if not domain or not isinstance(block, dict):
        return None
    assert_domain_enabled(domain["id"])
    return _compile(domain, item, block)


def _action_options(action_id):
    """表格只允许本域已注册动作；跨域或未注册一律拒绝。"""
    domain, action = raw_resource("actions", action_id)
    if not domain or not action:
        return None
    return domain["id"]


def _action_properties(action_id):
    """写动作实际接受的载荷键；表格据此区分可写列与只读身份列。"""
    schema = frappe.db.get_value("Shangshu Action Definition", {"action_id": action_id, "enabled": 1},
                                 "input_schema_json", order_by="action_version desc")
    return set((json.loads(schema or "{}").get("properties") or {}))


def _compile(domain, item, block):
    doctype = item.get("doctype")
    if not isinstance(doctype, str) or not doctype:
        _fail("原生表格对象缺少 DocType")
    if block.get("doctype") != doctype:
        _fail("原生表格声明的 DocType 与对象不一致")
    catalog = {field.get("id"): field for field in item.get("fields") or [] if field.get("id")}
    fields = []
    for field in block.get("fields") or []:
        if not isinstance(field, dict) or not field.get("id"):
            _fail("原生表格字段必须是对象已声明字段")
        spec = catalog.get(field["id"])
        if not spec:
            _fail("原生表格字段未在对象中声明：" + str(field["id"]))
        kind = field.get("type") or spec.get("type")
        if kind not in SCALAR_TYPES:
            _fail("原生表格字段类型无效：" + str(field["id"]))
        options = field.get("options")
        if options is not None and (kind != "choice" or not isinstance(options, list)
                                    or not all(isinstance(item, str) for item in options)):
            _fail("原生表格选项字段必须给出字符串选项：" + str(field["id"]))
        entry = {"id": field["id"], "label": field.get("label") or spec.get("label") or field["id"],
                 "type": kind, "required": bool(field.get("required"))}
        if options is not None:
            entry["options"] = list(options)
        fields.append(entry)
    if not fields:
        _fail("原生表格必须声明字段")
    ids = {field["id"] for field in fields}
    version_field = block.get("version_field")
    if version_field not in catalog:
        _fail("原生表格版本字段必须是对象已声明列")
    search_fields = block.get("search_fields") or []
    if set(search_fields) - ids:
        _fail("原生表格搜索字段必须在已声明字段中")
    for key, label in (("read_roles", "读"), ("write_roles", "写")):
        roles = block.get(key)
        if not isinstance(roles, list) or not roles or not all(isinstance(role, str) and role for role in roles):
            _fail("原生表格必须声明非空" + label + "角色")
    write = block.get("write")
    if not isinstance(write, dict) or not write.get("update_action"):
        _fail("原生表格必须声明写 Action")
    for key in ("update_action", "create_action"):
        action_id = write.get(key)
        if action_id and _action_options(action_id) != domain["id"]:
            _fail("原生表格写 Action 必须是本域已注册动作：" + str(action_id))
    mapping = write.get("map") or {}
    if not isinstance(mapping, dict) or set(mapping) - ids:
        _fail("原生表格写字段映射只能重命名已声明字段")
    fixed = write.get("fixed") or {}
    if not isinstance(fixed, dict):
        _fail("原生表格固定写字段必须是对象")
    return domain, item, {"fields": fields, "version_field": version_field, "search_fields": search_fields,
                          "order_by": block.get("order_by") or "modified desc",
                          "read_roles": block["read_roles"], "write_roles": block["write_roles"],
                          "title": block.get("title") or item.get("name") or item["id"],
                          "update_accepted": sorted(_action_properties(write["update_action"])),
                          "create_accepted": sorted(_action_properties(write["create_action"]))
                          if write.get("create_action") else []}, write, catalog


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def _require(object_id):
    found = declared(object_id)
    if not found:
        frappe.throw("该对象未声明原生表格，不能通过公共表格读写", frappe.ValidationError)
    return found


def revision(object_id):
    domain, item, block, write, catalog = _require(object_id)
    value = int(_digest({"id": item["id"], "doctype": item["doctype"], "fields": block["fields"],
                         "version_field": block["version_field"],
                         "write": {key: write.get(key) for key in ("update_action", "create_action", "map", "fixed")}})[:8], 16)
    return value or 1


def _roles():
    return set(frappe.get_roles())


def _gate_read(block):
    """角色档位不再阻断业务资格（PKG-132 · 试用开放口径）。

    ⚠️ **只放开「谁可以用」这一层**：登录与平台身份仍要过（`require_identity`），
    字段范围仍按对象自己声明的字段走，**数据规则、版本、事务、审计一个字不减**。
    关闭 `business_access.OPEN_BUSINESS_ACCESS` 即恢复原角色判定。
    """
    from shangshu_core import business_access
    business_access.require_identity()
    if business_access.is_open():
        return
    roles = _roles()
    if "System Manager" not in roles and not roles.intersection(block["read_roles"]):
        frappe.throw("没有该对象的读取权限", frappe.PermissionError)


def _writable(block):
    """写资格同读资格：试用开放口径下角色档位不再阻断（数据规则仍在动作里）。"""
    from shangshu_core import business_access
    if business_access.is_open():
        return True
    roles = _roles()
    return "System Manager" in roles or bool(roles.intersection(block["write_roles"]))


def _json_type(kind):
    return {"integer": "integer", "decimal": "number", "boolean": "boolean"}.get(kind, "string")


def _query_capabilities(block):
    fields = block['fields']
    return {'version': 1,
            'search_fields': list(block['search_fields']) or
                             [field['id'] for field in fields if field['type'] in ('text', 'long_text', 'choice')],
            'sort_fields': ['name'] + [field['id'] for field in fields if field['type'] != 'long_text'],
            'search_max_length': 200}


def definition(object_id):
    domain, item, block, write, catalog = _require(object_id)
    _gate_read(block)
    fields = [dict(field) for field in block["fields"]]
    writable = _writable(block)
    can_create = bool(write.get("create_action"))
    return {"id": object_id, "name": block["title"], "title": block["title"], "owner": domain["id"],
            "source": "native", "revision": revision(object_id), "doctype": item["doctype"], "fields": fields,
            "input_schema": {"type": "object", "properties": {field["id"]: {"type": _json_type(field["type"])}
                                                              for field in fields}},
            "query": _query_capabilities(block),
            "history": {"version": 1, "service": "platform.object.history", "available": False},
            "import": {"version": 1, "service": "platform.object.import_preview", "action": "platform.object.import",
                       "available": writable and "System Manager" in _roles(),
                       "max_bytes": MAX_IMPORT_BYTES, "max_rows": MAX_IMPORT_ROWS},
            "export": {"version": 1, "service": "platform.object.export", "format": "xlsx",
                       "available": "System Manager" in _roles(), "max_rows": MAX_ROWS},
            "lifecycle": {"version": 1, "available": False, "scopes": ["active"], "auto_purge": False},
            "operations": ["read"] + (["create"] if writable and can_create else []) + (["update"] if writable else []),
            "record_actions": []}


def _public_definition(object_id):
    """列表投影；无权限时返回 None，不让一张表格的出现泄露对象存在。"""
    try:
        return definition(object_id)
    except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
        return None


def _order_by(block, sort, direction, readable):
    allowed = {field["id"] for field in block["fields"]} | {"name"}
    if sort and sort in allowed and sort in readable:
        return "{0} {1}, name asc".format(sort, "desc" if direction == "desc" else "asc")
    # Default ordering also reveals relative values; never sort by a hidden field.
    terms = str(block.get("order_by") or "").split(",")
    for term in terms:
        match = re.fullmatch(r"`?([A-Za-z_][A-Za-z0-9_]*)`?(?:\s+(?:asc|desc))?", term.strip(), re.I)
        if not match or match.group(1) not in readable:
            return "name asc"
    return block["order_by"]


def _readable_fields(doctype, declared=None):
    """可读字段：默认取 Frappe 的角色可读集；试用开放口径下取**对象自己声明的字段**。

    ⚠️ 原生对象的字段范围是**对象声明**（`item['fields']`）说了算，不是 Frappe 角色档位
    的产物 ⇒ 开放口径下用声明集，避免「角色看不到 ⇒ 字段整片消失」。
    **不会放宽到对象没声明的列**（含 `name` 这个固定身份）。
    """
    from shangshu_core import business_access
    if business_access.is_open():
        return set(declared or ())
    from frappe.model import get_permitted_fields
    return set(get_permitted_fields(doctype, user=frappe.session.user, permission_type="read"))


from shangshu_core import query_receipt


def query_records(object_id, filters=None, page=1, page_length=30, *, object_projection=False,
                  fields=None, read_scope=None, include_definition=True):
    from shangshu_core.read_scope import normalize_read_scope
    plan = normalize_read_scope(read_scope, fields=fields, default_mode='query')
    if plan['mode'] != 'query':
        _fail('原生对象分页查询必须使用 query 范围')
    if not isinstance(include_definition, bool):
        _fail('include_definition 必须是布尔值')
    domain, item, block, write, catalog = _require(object_id)
    _gate_read(block)
    if "read" not in set(item.get("operations") or ["read"]):
        frappe.throw("该对象不允许通用查询", frappe.PermissionError)
    readable = _readable_fields(item["doctype"], set(catalog) | {"name", "modified"})
    raw = filters if isinstance(filters, dict) else frappe.parse_json(filters or "{}")
    options = {"$search", "$sort", "$direction", "$scope"}
    # Native table columns describe the editable surface, not the object's read filters.
    # Preserve explicitly declared read-only filters without granting write/projection access.
    declared_filters = item.get("filter_fields") or []
    if (not isinstance(declared_filters, list)
            or any(not isinstance(field, str) or field not in set(catalog) | {"name"}
                   for field in declared_filters)):
        frappe.throw("原生对象筛选字段必须在对象声明中", frappe.ValidationError)
    # 合并说明：fast 那边额外允许用 `name` 精确定位受管记录（公共 query_dataset 的旧调用）。
    # `name` 是所有受管记录的固定身份，这里**并集**加上；下面的读权闸照样要过。
    allowed = {field["id"] for field in block["fields"]} | set(declared_filters) | {"name"}
    if not isinstance(raw, dict) or set(raw) - allowed - options:
        frappe.throw("筛选只能使用已声明字段的明确值", frappe.ValidationError)
    if (set(raw) - options) - readable:
        frappe.throw("没有筛选字段的读取权限", frappe.PermissionError)
    if raw.get("$scope", "active") != "active":
        frappe.throw("原生表格暂不支持回收站范围", frappe.ValidationError)
    search = raw.get("$search", "")
    sort = raw.get("$sort", "")
    direction = raw.get("$direction", "asc")
    capabilities = _query_capabilities(block)
    capabilities['search_fields'] = [field for field in capabilities['search_fields'] if field in readable]
    capabilities['sort_fields'] = [field for field in capabilities['sort_fields'] if field in readable]
    public = None
    if include_definition:
        public = definition(object_id)
        public['fields'] = [field for field in public['fields'] if field['id'] in readable]
        public['input_schema']['properties'] = {key: value for key, value in public['input_schema']['properties'].items()
                                                if key in readable}
        public['query'] = capabilities
    if (not isinstance(search, str) or len(search) > capabilities["search_max_length"]
            or not isinstance(sort, str) or (sort and sort not in capabilities["sort_fields"])
            or direction not in ("asc", "desc")):
        frappe.throw("搜索或排序无效，请使用已声明字段和 asc/desc 方向", frappe.ValidationError)
    safe = {key: value for key, value in raw.items() if key not in options and value not in (None, "")}
    # Public object/dataset reads keep declared read-only columns; table/export retain their surface.
    # 合并说明：fast 那边用 `get_permitted_fields` 直接算读投影；本行的 `readable` 就是同一口径
    # （_readable_fields = get_permitted_fields(..., permission_type='read')），且多留了
    # name / modified 两列、并支持 object_projection 切换，**是 fast 那版的超集**，取本版。
    projection = (item.get("fields") or []) if object_projection else block["fields"]
    declared_projection = [spec['id'] for spec in projection]
    selected = plan['fields']
    if selected is None:
        selected = [field for field in declared_projection if field in readable]
    else:
        if set(selected) - set(declared_projection) - {'name', 'modified'}:
            _fail('读取字段必须在对象已声明的投影范围中')
        if set(selected) - readable:
            frappe.throw('没有读取所选字段的权限', frappe.PermissionError)
    # Identity/version remain explicit metadata; search/filter/order dependencies
    # are checked separately and never forced into the returned value projection.
    fields = list(dict.fromkeys([*selected, *[field for field in ('name', 'modified') if field in readable]]))
    page = max(1, int(page))
    length = min(100, max(1, int(page_length)))
    or_filters = None
    if search.strip():
        if not capabilities["search_fields"]:
            frappe.throw("没有可读取的搜索字段", frappe.PermissionError)
        term = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        or_filters = {field: ["like", "%" + term + "%"] for field in capabilities["search_fields"]}
    from shangshu_core import business_access
    rows = business_access.authorized_get_list(
        item["doctype"], fields=fields, filters=safe,
        or_filters=or_filters, order_by=_order_by(block, sort, direction, readable),
        limit_start=(page - 1) * length, limit_page_length=length)
    total = business_access.authorized_get_list(
        item["doctype"], filters=safe, or_filters=or_filters,
        fields=["count(name) as count"])[0].count
    rows = [{key: value for key, value in row.items() if key in fields} for row in rows]
    for row in rows:
        if "modified" in row:
            row["modified"] = str(row["modified"])
    receipt = query_receipt.build_receipt(
        object_id=object_id, object_name=block["title"], domain_id=domain["id"],
        matched_total=total, returned_rows=len(rows), page=page, page_length=length,
        filters=safe, search=search, sort=sort, direction=direction, scope="active",
        counting="row", exact=True, details_complete=len(rows) == total,
        aggregate_complete=None, exceptions=[])
    return {"object_id": object_id, **({"object": public} if include_definition else {}), "domain_id": domain["id"],
            "rows": rows, "total": total, "page": page, "page_length": length, "receipt": receipt}


def _runs(action_id, action_payload, key):
    from shangshu_core.actions import execute_registered_action
    return execute_registered_action(action_id, action_payload, True, key)


def write_record(action_id, payload, context):
    if not context.get("confirmed") or not getattr(frappe.flags, "shangshu_action_pin", None):
        frappe.throw("原生记录写入必须经过公共动作确认", frappe.PermissionError)
    object_id = payload.get("object_id")
    found = declared(object_id)
    if not found:
        frappe.throw("该对象未声明原生表格，不能通过表格写入", frappe.ValidationError)
    domain, item, block, write, catalog = found
    if not _writable(block):
        frappe.throw("没有该对象的写入权限", frappe.PermissionError)
    creating = action_id == "platform.object.create"
    target = write.get("create_action") if creating else write.get("update_action")
    if creating and not target:
        frappe.throw("该对象未声明新建 Action", frappe.ValidationError)
    if payload.get("expected_revision") != revision(object_id):
        frappe.throw("字段定义已变化，请刷新表格后重试", frappe.TimestampMismatchError)
    values = payload.get("values")
    allowed = {field["id"] for field in block["fields"]}
    if not isinstance(values, dict) or set(values) - allowed:
        frappe.throw("包含未声明字段", frappe.PermissionError)
    mapping = write.get("map") or {}
    action_payload = dict(write.get("fixed") or {})
    for key, value in values.items():
        action_payload[mapping.get(key, key)] = value
    accepted = set(block["create_accepted"] if creating else block["update_accepted"])
    unknown = sorted(set(action_payload) - accepted)
    if unknown:
        frappe.throw("该动作不接受这些字段：" + "、".join(unknown), frappe.PermissionError)
    request_key = context["idempotency_key"]
    if creating:
        result = _runs(target, action_payload, "table-create-" + _digest([request_key]))
        name = (result.get("result") or {}).get("name") or result.get("name")
        doc = frappe.get_doc(item["doctype"], name)
    else:
        doc = frappe.get_doc(item["doctype"], payload["name"], for_update=True)
        from shangshu_core import business_access
        # 试用开放口径：Frappe 角色档位不再阻断原生对象的写（**写仍只经声明的写动作**：
        # 确认、幂等、业务校验、版本比对、审计都在那条动作里）。
        if not business_access.is_open():
            doc.check_permission("write")
        if str(doc.modified) != payload["expected_modified"]:
            frappe.throw("记录已被修改，请刷新后重试", frappe.TimestampMismatchError)
        action_payload[write.get("name_param", "name")] = doc.name
        version = doc.get(block["version_field"])
        action_payload[write.get("version_param", "expected_version")] = str(version) if hasattr(version, "isoformat") else version
        result = _runs(target, action_payload, "table-update-" + _digest([request_key]))
    current = frappe.get_doc(item["doctype"], doc.name)
    context["record_change"] = {"doctype": item["doctype"], "name": current.name,
        "data": {"version": 1, "object_id": object_id, "revision": revision(object_id), "action": target}}
    return {"object_id": object_id, "name": current.name, "modified": str(current.modified),
            "revision": revision(object_id)}


def require_export_permission():
    """原生对象导出门（伴生工作簿导出同用这一份）。

    试用开放口径下导出对全体已登录账号开放；导出仍走**声明字段**与分页取全量，
    行数/单元格上限、版本比对、审计都照旧。
    """
    from shangshu_core import business_access
    business_access.require_identity()
    if business_access.is_open():
        return
    if "System Manager" not in _roles():
        frappe.throw("数据导出暂仅开放给系统管理员", frappe.PermissionError)


def export_records(payload):
    """按声明字段与当前身份分页取全量；行数受 5000 上限保护。"""
    from shangshu_core.record_export import write_workbook
    object_id = payload["object_id"]
    domain, item, block, write, catalog = _require(object_id)
    require_export_permission()
    if payload.get("expected_revision") != revision(object_id):
        frappe.throw("字段已变化，请刷新数据表后重新导出", frappe.TimestampMismatchError)
    filters = payload.get("filters") or {}
    first = query_records(object_id, filters, 1, 100)
    total = first["total"]
    if total > MAX_ROWS:
        frappe.throw("导出超过 5000 行，请缩小筛选范围", frappe.ValidationError)
    fields = [{"id": field["id"], "label": field["label"], "type": field["type"]} for field in block["fields"]]
    if (total + 1) * len(fields) > MAX_CELLS:
        frappe.throw("导出超过 50 万单元格，请缩小筛选范围", frappe.ValidationError)
    rows = []
    for page in range(1, (total + 99) // 100 + 1):
        chunk = first if page == 1 else query_records(object_id, filters, page, 100)
        if chunk["total"] != total:
            frappe.throw("数据范围已变化，请重新导出", frappe.ValidationError)
        rows.extend(chunk["rows"])
    if len(rows) != total:
        frappe.throw("导出行数不完整，请重新尝试", frappe.ValidationError)
    return write_workbook(block["title"], fields, rows)


def import_plan(payload, write=False):
    """原生对象导入预检：与受管对象相同语义，写行仍走声明写 Action。"""
    from shangshu_core import record_import as managed
    from shangshu_core import record_import_xlsx as xlsx
    object_id = payload["object_id"]
    domain, item, block, wblock, catalog = _require(object_id)
    from shangshu_core import business_access
    business_access.require_identity()
    if not business_access.is_open() and "System Manager" not in _roles():
        frappe.throw("数据导入暂仅开放给系统管理员", frappe.PermissionError)
    if payload.get("expected_revision") != revision(object_id):
        frappe.throw("字段定义已变化，请重新核对导入列", frappe.TimestampMismatchError)
    fields = [dict(field) for field in block["fields"]]
    content, sheets, selected = managed._source(payload)
    response = {"sheets": sheets, "fields": fields, "revision": revision(object_id)}
    if selected is None:
        return response
    response.update(columns=selected["columns"], errors=list(selected["issues"]),
                    sample=[{"row": row["row"], "values": [str(cell["value"]) if cell["value"] is not None else "" for cell in row["cells"]]}
                            for row in selected["rows"][:10]])
    mapping = payload.get("mapping")
    if not mapping:
        return response
    available = {field["id"]: field for field in fields}
    if set(mapping) - available.keys() or len(set(mapping.values())) != len(mapping):
        frappe.throw("列映射无效，不能映射未声明字段或重复使用同一列", frappe.ValidationError)
    if any(type(index) is not int or not 1 <= index <= len(selected["columns"]) for index in mapping.values()):
        frappe.throw("映射列不在当前工作表中", frappe.ValidationError)
    match = payload.get("match_field")
    if match not in mapping or available[match]["type"] not in MATCH_TYPES:
        frappe.throw("请选择已映射的文本、整数、日期或选项列作为匹配依据", frappe.ValidationError)
    write_map = wblock.get("map") or {}
    accepted = set(block["update_accepted"])
    readonly = sorted(field for field in mapping
                      if field != match and write_map.get(field, field) not in accepted)
    if readonly:
        frappe.throw("这些列只读，不能通过导入修改：" + "、".join(readonly), frappe.ValidationError)
    writable = [field for field in mapping if write_map.get(field, field) in accepted]
    existing = frappe.get_list(item["doctype"], fields=["name", match], limit_page_length=MAX_ROWS + 1)
    if len(existing) > MAX_ROWS:
        frappe.throw("目标表超过当前 5000 行导入保护范围，请缩小表后再处理；未截断匹配范围", frappe.ValidationError)
    lookup = {}
    for record in existing:
        lookup.setdefault(record.get(match), []).append(record["name"])
    errors = response["errors"]
    rows = []
    keys = {}
    def issue(row, field, message):
        errors.append({"sheet": selected["sheet"], "row": row, "column": mapping.get(field, 0) or available[field]["label"],
                       "field": field, "label": available[field]["label"], "message": message})
    for source in selected["rows"]:
        values = {}
        match_value = None
        start_errors = len(errors)
        for field, index in mapping.items():
            try:
                value = xlsx.cell_value(source["cells"][index - 1], available[field]["type"])
                if value is None and available[field]["required"] and field in writable:
                    raise xlsx.ImportError("必填列不能为空，请补全原表后重试")
                if field in writable:
                    values[field] = value
                if field == match:
                    match_value = value
            except (xlsx.ImportError, frappe.ValidationError) as error:
                issue(source["row"], field, str(error))
        key = match_value
        if key is None or key == "":
            if not any(error.get("field") == match and error["row"] == source["row"] for error in errors):
                issue(source["row"], match, "匹配依据不能为空")
        elif key in keys:
            issue(source["row"], match, "与第 {0} 行重复，请明确取舍，不能任意覆盖".format(keys[key]))
        else:
            keys[key] = source["row"]
        if len(errors) != start_errors:
            continue
        matches = lookup.get(key, [])
        if len(matches) > 1:
            issue(source["row"], match, "目标表中匹配值不唯一，请先在原表处理重复记录")
            continue
        if matches:
            doc = frappe.get_doc(item["doctype"], matches[0], for_update=write)
            before = {field: doc.get(field) for field in writable}
        elif not wblock.get("create_action"):
            issue(source["row"], match, "该对象未声明新建 Action，未匹配的行不能新增，请核对匹配值")
            continue
        else:
            doc = frappe.new_doc(item["doctype"])
            before = {}
        missing = [field for field in fields if field["required"] and field["id"] not in values
                   and not before.get(field["id"]) and before.get(field["id"]) not in (0, False)]
        if missing:
            for field in missing:
                issue(source["row"], field["id"], "新增记录缺少必填列映射，请补选对应列")
            continue
        changes = [{"field": field, "label": available[field]["label"], "type": available[field]["type"],
                    "before": before.get(field), "after": values[field]}
                   for field in values if before.get(field) != values[field]]
        rows.append({"row": source["row"], "operation": "create" if not matches else "update" if changes else "unchanged",
                     "name": doc.name if matches else None, "modified": str(doc.modified) if matches else None,
                     "values": values, "changes": changes})
    response.update(rows=rows, summary={operation: sum(row["operation"] == operation for row in rows)
                                        for operation in ("create", "update", "unchanged")})
    response["summary"]["errors"] = len(errors)
    response["preview_hash"] = _digest({"object_id": object_id, "revision": revision(object_id),
        "file": hashlib.sha256(content).hexdigest(), "sheet": selected["sheet"], "header_row": selected["header_row"],
        "mapping": mapping, "match_field": match, "rows": rows, "errors": errors})
    return response


def import_records(payload, context):
    from shangshu_core.actions import execute_registered_action
    pin = getattr(frappe.flags, "shangshu_action_pin", None)
    if not context.get("confirmed") or not pin or pin.get("action_id") != "platform.object.import":
        frappe.throw("导入必须经过公共动作确认", frappe.PermissionError)
    plan = import_plan(payload, write=True)
    if plan.get("errors") or not plan.get("rows"):
        frappe.throw("导入仍有错误，请修正后重新核对；本次没有写入任何记录", frappe.ValidationError)
    if payload["preview_hash"] != plan["preview_hash"]:
        frappe.throw("预览后数据或字段已变化，请重新检查新增/更新范围；本次未写入", frappe.TimestampMismatchError)
    for row in plan["rows"]:
        if row["operation"] == "unchanged":
            continue
        values = {"object_id": payload["object_id"], "expected_revision": payload["expected_revision"], "values": row["values"]}
        if row["operation"] == "update":
            values.update(name=row["name"], expected_modified=row["modified"])
        key = "native-import-" + _digest([context["idempotency_key"], row["row"]])
        execute_registered_action("platform.object." + row["operation"], values, True, key)
    return {"object_id": payload["object_id"], "revision": payload["expected_revision"], **plan["summary"]}
