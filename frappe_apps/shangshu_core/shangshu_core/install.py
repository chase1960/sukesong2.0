import frappe

from shangshu_core.identity import ensure_identity_for_user, backfill_collaboration_keys
from shangshu_core.identity_admin import GROUPS, PLATFORM_ROLES
from shangshu_core.database import ensure_immutable_triggers
from shangshu_core.domains import ensure_registered_domains
from shangshu_core.runtime import register_action


def ensure_roles():
    """内核声明的角色必须真实存在，否则贡献里的角色能力投影永远不生效。"""
    for role in ("Collaboration Manager",):
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype": "Role", "role_name": role}).insert(ignore_permissions=True)


def after_install():
    # App 首次安装仍在 Frappe 事务中；这里只写普通记录，DDL 留给 migrate。
    ensure_foundation(install_triggers=False)


def after_migrate():
    # ① **对账在前**（既有安全规矩，**不动**）：manifest 与域贡献不一致 ⇒ **停下**，
    #    不继续注册（注册了 manifest 里没有的动作 ⇒ 「打包声明」与「真跑的」成了两套）。
    #    2026-10-22 改了这件事的**报错**：说清**怎么改**（缺失/多余分别指哪边、文件在哪）。
    from shangshu_core.manifest import check_registered_manifests
    check_registered_manifests()
    # 签发密钥在显式迁移准备；请求中不生成配置、不执行 DDL。
    from frappe.utils.password import get_encryption_key
    get_encryption_key()

    # 日志查询投影与对应索引先于域刷新就绪；缺失/漂移则阻止升级，不在读请求补 DDL。
    from shangshu_core.log_query_storage import ensure_log_query_storage
    frappe.db.commit()
    ensure_log_query_storage()
    from shangshu_core.log_targets import ensure_log_target_indexes
    ensure_log_target_indexes()
    # ② **代各域刷新**（2026-10-22 收进内核）：域在贡献里声明 `refresh` ⇒ migrate 时内核逐个调用。
    #    以前域的 setup 只在装域时跑 ⇒ 改完动作/工具清单 migrate 不刷新 ⇒
    #    现场「动作未注册或已停用」⇒ 靠人记得手工跑 install.setup（规矩不该靠人记得）。
    from shangshu_core.domains import refresh_domain_contributions
    refresh_domain_contributions()
    from shangshu_core.record_lifecycle import migrate_record_lifecycle
    frappe.db.commit()
    migrate_record_lifecycle()
    ensure_foundation()


def ensure_foundation(install_triggers=True):
    """幂等补齐身份；不修改业务流程定义，也不创建测试账号。"""
    ensure_roles()
    backfill_collaboration_keys()
    for user in frappe.get_all(
        "User",
        filters={"enabled": 1, "user_type": "System User"},
        pluck="name",
    ):
        ensure_identity_for_user(user)
    ensure_registered_domains()
    register_action('platform.object.companion_bind','1.0.0','登记原对象伴随表','write','required',['System Manager'],
        {'type':'object','additionalProperties':False,'required':['object_id','file_id','field_columns'],
         'properties':{'object_id':{'type':'string'},'file_id':{'type':'string'},
          'field_columns':{'type':'array','items':{'type':'object','additionalProperties':False,
             'required':['field_id','header'],'properties':{'field_id':{'type':'string'},
                'header':{'type':'string'},'type':{'type':'string'}}}}}}, {}, 120, 'none')

    from shangshu_core.companion_writes import input_schema as companion_schema
    for undo in (False,True):
        register_action('platform.object.companion_'+('undo' if undo else 'write'),'1.1.0',
            '撤回伴随混合包' if undo else '写入伴随混合包','write','required',['Desk User'],
            companion_schema(undo),{},120,'none')

    from shangshu_core.record_import_xlsx import input_schema as import_schema
    register_action('platform.object.import','1.0.1','确认导入数据记录','write','required',['System Manager'],
                    import_schema(execute=True),{},120,'none')
    # **跨表 JOIN**（PKG-018-T10）：只支持**声明过的引用关联**；基数必须显式声明。
    register_action(
        "platform.object.join_aggregate", "1.0.0",
        "按声明过的引用关联做跨对象统计（基数必须声明；两端权限都查）",
        "read", "none", ["Desk User"],
        {"type": "object", "additionalProperties": False,
         "required": ["object_id", "join", "cardinality"],
         "properties": {
             "object_id": {"type": "string"},
             "join": {"type": "object", "additionalProperties": False,
                      "required": ["target_object_id", "field", "declared_on"],
                      "properties": {"target_object_id": {"type": "string"},
                                    "field": {"type": "string"},
                                    "declared_on": {"type": "string", "enum": ["self", "target"]}}},
             "cardinality": {"type": "string", "enum": ["one_to_one", "one_to_many"]},
             "filters": {"type": "object"},
             "right_filters": {"type": "object"},
             "metrics": {"type": "array", "maxItems": 3,
                         "items": {"type": "object", "additionalProperties": False, "required": ["op"],
                                   "properties": {"op": {"type": "string",
                                                         "enum": ["count_rows", "count_distinct", "sum"]},
                                                  "field": {"type": "string"},
                                                  "side": {"type": "string", "enum": ["left", "right"]}}}},
             "group_by": {"type": "object", "additionalProperties": False, "required": ["field"],
                          "properties": {"field": {"type": "string"},
                                         "side": {"type": "string", "enum": ["left", "right"]}}},
             "scope": {"type": "string", "enum": ["active", "trash"]}}},
        {"type": "object", "properties": {
            "receipt": {"type": "object"}, "metrics": {"type": "object"},
            "groups": {"type": "array"}, "join": {"type": "object"}}},
        30, "safe_read")
    # **指标注册**（PKG-018-T09，轻量）：FDE 登记「统计什么／按哪个日期／如何去重」，
    # 登记后按名字跑。**完整指标平台（建模、配置版本、管理界面）后放**。
    # 登记是**配置面** ⇒ 只给系统管理员；跑是**读面** ⇒ 普通员工可跑
    #（跑的时候照旧按调用方的权限算）。
    register_action(
        "platform.metric.define", "1.0.0", "登记/修改一个指标定义（统计什么、按哪个日期、如何去重）",
        "write", "required", ["System Manager"],
        {"type": "object", "additionalProperties": False, "required": ["metric_name", "object_id"],
         "properties": {
             "metric_name": {"type": "string", "minLength": 2, "maxLength": 48,
                             "pattern": "^[a-z][a-z0-9_]+$"},
             "title": {"type": "string", "maxLength": 100},
             "object_id": {"type": "string"},
             "metrics": {"type": "array", "maxItems": 3,
                         "items": {"type": "object", "additionalProperties": False, "required": ["op"],
                                   "properties": {"op": {"type": "string",
                                                         "enum": ["count_rows", "count_distinct", "sum"]},
                                                  "field": {"type": "string"}}}},
             "date_field": {"type": "string"},
             "distinct_field": {"type": "string"},
             "filters": {"type": "object"},
             "active": {"type": "boolean"}}},
        {"type": "object", "properties": {
            "metric_name": {"type": "string"}, "definition_version": {"type": "integer"},
            "definition_hash": {"type": "string"}, "created": {"type": "boolean"}}},
        30, "none")
    register_action(
        "platform.metric.run", "1.0.0", "按名字跑一个登记好的指标",
        "read", "none", ["Desk User"],
        {"type": "object", "additionalProperties": False, "required": ["metric_name"],
         "properties": {
             "metric_name": {"type": "string", "minLength": 1, "maxLength": 48},
             "filters": {"type": "object"},
             "group_by": {"type": "string"},
             "date_from": {"type": "string"},
             "date_to": {"type": "string"},
             "scope": {"type": "string", "enum": ["active", "trash"]},
             "result_set": {"type": "string"}}},
        {"type": "object", "properties": {
            "receipt": {"type": "object"}, "metrics": {"type": "object"}, "groups": {"type": "array"},
            "metric": {"type": "object"}, "result_set": {"type": "object"}}},
        30, "safe_read")
    register_action(
        "platform.metric.list", "1.0.0", "看有哪些登记好的指标（只给口径摘要，不含业务数据）",
        "read", "none", ["Desk User"],
        {"type": "object", "additionalProperties": False, "properties": {}},
        {"type": "object", "properties": {"items": {"type": "array"}}},
        30, "safe_read")
    register_action(
        "platform.object.aggregate",
        "1.1.0",
        "统计业务对象（行数／去重计数／求和；可按一个字段分组；可续用结果集引用）",
        "read",
        "none",
        ["Desk User"],
        {
            "type": "object",
            "additionalProperties": False,
            "required": [],
            "properties": {
                "object_id": {"type": "string"},
                "filters": {"type": "object"},
                "metrics": {
                    "type": "array", "maxItems": 3,
                    "items": {
                        "type": "object", "additionalProperties": False, "required": ["op"],
                        "properties": {
                            "op": {"type": "string", "enum": ["count_rows", "count_distinct", "sum"]},
                            "field": {"type": "string"},
                        },
                    },
                },
                "group_by": {"type": "string"},
                "scope": {"type": "string", "enum": ["active", "trash"]},
                # **结果集引用**（PKG-018-T08）：给一个 rs_… 编号 ⇒ 以它记下的范围为底继续统计。
                # 引用**先核有效性**（数据变了/权限被撤/定义升版/过期 ⇒ 当场拒并要求重新查询）。
                "result_set": {"type": "string"},
            },
        },
        {
            "type": "object",
            "properties": {
                "receipt": {"type": "object"},
                "metrics": {"type": "object"},
                "groups": {"type": "array"},
                "group_truncation": {"type": "object"},
                "result_set": {"type": "object"},
            },
        },
        30, "none")
    # **结果集引用的有效性检查口**（PKG-018-T08）：只回答「这个编号还准不准」，不返数据。
    register_action(
        "platform.object.result_set",
        "1.0.0",
        "检查结果集引用是否还有效（数据变了／权限被撤／定义升版／过期都会作废）",
        "read",
        "none",
        ["Desk User"],
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["ref"],
            "properties": {"ref": {"type": "string", "minLength": 1, "maxLength": 200}},
        },
        {
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "valid": {"type": "boolean"},
                "reason": {"type": "string"},
                "object_id": {"type": "string"},
                "matched_total": {"type": "integer"},
                "criteria": {"type": "object"},
                "receipt": {"type": "object"},
            },
        },
        30, "safe_read")
    register_action(
        "platform.object.aggregate",
        "1.0.0",
        "统计业务对象（行数／去重计数／求和；可按一个字段分组）",
        "read",
        "none",
        ["Desk User"],
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["object_id"],
            "properties": {
                "object_id": {"type": "string"},
                "filters": {"type": "object"},
                "metrics": {
                    "type": "array", "maxItems": 3,
                    "items": {
                        "type": "object", "additionalProperties": False, "required": ["op"],
                        "properties": {
                            "op": {"type": "string", "enum": ["count_rows", "count_distinct", "sum"]},
                            "field": {"type": "string"},
                        },
                    },
                },
                "group_by": {"type": "string"},
                "scope": {"type": "string", "enum": ["active", "trash"]},
            },
        },
        {
            "type": "object",
            "properties": {
                "receipt": {"type": "object"},
                "metrics": {"type": "object"},
                "groups": {"type": "array"},
                "group_truncation": {"type": "object"},
            },
        },
        30, "none")
    register_action(
        "platform.object.query",
        "1.2.0",
        "查询业务对象",
        "read",
        "none",
        ["Desk User"],
        {
            "type": "object",
            "additionalProperties": False,
            "required": [],
            "properties": {
                "object_id": {"type": "string"},
                "filters": {"type": "object"},
                "page": {"type": "integer", "minimum": 1},
                "page_length": {"type": "integer", "minimum": 1, "maximum": 100},
                # **结果集引用**（PKG-018-T08）：给一个 rs_… 编号 ⇒ 以它记下的范围为底继续查。
                "result_set": {"type": "string"},
                "fields": {
                    "type": "array", "items": {"type": "string", "minLength": 1},
                    "description": "省略表示当前可读列；空数组只读身份和版本。字段权限沿原对象校验。",
                },
                "read_scope": {
                    "type": "object", "additionalProperties": False,
                    "description": "沿原 filters/page/page_length 分页查询，不能改成按行或全量读取。",
                    "properties": {
                        "mode": {"type": "string", "enum": ["query"], "default": "query"},
                        "purpose": {"type": "string", "default": "interactive",
                                    "enum": ["interactive", "export", "migration", "analysis", "recovery"]},
                        "fields": {"type": "array", "items": {"type": "string", "minLength": 1},
                                   "description": "可选字段范围；与顶层 fields 同时提供时须一致。"},
                    },
                },
                "include_definition": {
                    "type": "boolean", "default": True,
                    "description": "false 时仅查询数据，省略本次对象完整定义装配。",
                },
            },
        },
        {},
        30,
        "safe_read",
    )
    # **按受管记录取日志**（2026-10-22 第四段）：日志块要能**按案件看**，
    # 前端与助手都调得到 ⇒ 发布成**平台动作**（走公共动作通道，不用另开 BFF 口）。
    # 授权与全局流水**同一套独立日志授权**（缩小范围不放宽权限）。
    register_action(
        "platform.object.audit_log",
        "1.0.0",
        "按受管记录取日志（谁动了它、发生了什么判断；每条带来源编号）",
        "read",
        "none",
        ["Desk User"],
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["object_id"],
            "properties": {
                "object_id": {"type": "string"},
                "business_name": {"type": "string"},
                "page": {"type": "integer", "minimum": 1},
                "page_length": {"type": "integer", "minimum": 1, "maximum": 200},
            },
        },
        {
            "type": "object",
            "properties": {
                "items": {"type": "array"},
                "object_id": {"type": "string"},
                "business_name": {"type": "string"},
            },
        },
        30,
        "safe_read",
    )
    for operation, title in (("create","新建业务记录"),("update","修改业务记录"),("recycle","回收业务记录"),("restore","恢复业务记录")):
        properties = {"object_id":{"type":"string"}, "values":{"type":"object"},
                      "expected_revision":{"type":"integer","minimum":1}}
        if operation in ('recycle','restore'):properties.pop('values')
        required = list(properties)
        if operation != "create":
            properties.update(name={"type":"string"}, expected_modified={"type":"string"})
            required.extend(["name","expected_modified"])
        register_action("platform.object."+operation,"1.0.0",title,"write","required",["Desk User"],
                        {"type":"object","additionalProperties":False,"required":required,"properties":properties},
                        {},30,"none")
    # **一次写多行**（2026-10-27 夜 · PKG-132 性能线）：契约要求的内核批量写能力。
    # ⚠️ **快也不许绕闸**：版本闸/字段权限/值域/唯一键/审计**逐条照走**
    # （实现与单条写共用 `model_records._write_one_record` 同一份代码）。
    register_action("platform.object.update_many","1.1.0",
                    "一次写多行业务记录（逐行校验，一次动作一条完整日志）",
                    "write","required",["Desk User"],
                    {"type":"object","additionalProperties":False,
                     "required":["object_id","expected_revision","records"],
                     "properties":{"object_id":{"type":"string"},
                                   "expected_revision":{"type":"integer","minimum":1},
                                   "records":{"type":"array","minItems":1,"maxItems":20000,
                                     "items":{"type":"object","additionalProperties":False,
                                       "required":["name","expected_modified","values"],
                                       "properties":{"name":{"type":"string"},
                                                     "expected_modified":{"type":"string"},
                                                     "values":{"type":"object"},
                                                     "row_id":{"type":"string"},
                                                     "idempotency_key":{"type":"string"}}}}}},
                    {},120,"none")
    register_action('platform.application.inspect','1.0.0','读取应用草稿、修订与可用资源；修改前先读取，再用 configure 提交完整定义','read','none',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['application_id'],
                     'properties':{'application_id':{'type':'string'}}},{},30,'safe_read')
    register_action('platform.application.configure','1.0.1','修改应用草稿（不发布）','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['application_id','expected_revision','definition'],
                     'properties':{'application_id':{'type':'string'},'expected_revision':{'type':'integer','minimum':1},'definition':{'type':'object'},'dependency_hash':{'type':'string'}}},
                    {},30,'none')
    # 账号生命周期（内核身份职责）：确认 + 幂等 + 执行审计；不在 tools 中给 AI 投影。
    register_action('platform.identity.create','1.4.0','新建员工账号','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['email','display_name','initial_password'],
                     'properties':{'email':{'type':'string'},'display_name':{'type':'string','minLength':1},'role':{'type':'string','enum':list(PLATFORM_ROLES)},
                                   'roles':{'type':'array','minItems':1,'uniqueItems':True,'items':{'type':'string','enum':list(PLATFORM_ROLES)}},
                                   'initial_password':{'type':'string','minLength':8},'collaboration_group':{'type':'string','enum':['']+list(GROUPS)},
                                   'collaboration_scope':{'type':'string','enum':['related','department','company']},
                                   'username':{'type':'string','pattern':'^[a-z0-9][a-z0-9._-]{1,30}$','maxLength':31}}},
                    {},30,'none')
    register_action('platform.identity.status','1.0.0','启用或停用账号','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['email','enabled'],
                     'properties':{'email':{'type':'string'},'enabled':{'type':'boolean'}}},
                    {},30,'none')
    register_action('platform.identity.group','1.2.0','设置账号部门与任务管理范围','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['email'],
                     'properties':{'email':{'type':'string'},'collaboration_group':{'type':'string','enum':['']+list(GROUPS)},
                                   'collaboration_scope':{'type':'string','enum':['related','department','company']}}},
                    {},30,'none')
    register_action('platform.identity.role','1.2.0','设置账号平台角色与明确声明的业务角色','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['email'],
                     'properties':{'email':{'type':'string'},'role':{'type':'string','enum':list(PLATFORM_ROLES)},
                                   'roles':{'type':'array','minItems':1,'uniqueItems':True,'items':{'type':'string','enum':list(PLATFORM_ROLES)}},
                                   'business_roles':{'type':'array','uniqueItems':True,'items':{'type':'string'}}}},
                    {},30,'none')
    register_action('platform.identity.password','1.0.0','重置账号密码','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['email','new_password'],
                     'properties':{'email':{'type':'string'},'new_password':{'type':'string','minLength':8}}},
                    {},30,'none')
    # 组织事实与资源归属（B1，内核组织职责）：组织事实唯一权威在 Shangshu Department/
    # Org Member/Org Owner/Org Attribution；旧 collaboration_group 不再是部门权威。
    # 与身份动作一样：确认 + 幂等 + 执行审计；不进 tools（管理面不给 AI 投影）。
    register_action('platform.org.department_create','1.0.0','新建部门','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['name'],
                     'properties':{'name':{'type':'string','minLength':1,'maxLength':100},
                                   'parent':{'type':'string','maxLength':64},
                                   'enterprise':{'type':'string','maxLength':64}}},
                    {},30,'none')
    register_action('platform.org.department_rename','1.0.0','部门改名（身份不变）','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['department','name'],
                     'properties':{'department':{'type':'string','minLength':1,'maxLength':64},
                                   'name':{'type':'string','minLength':1,'maxLength':100}}},
                    {},30,'none')
    register_action('platform.org.department_set_status','1.0.0','部门启停','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['department','enabled'],
                     'properties':{'department':{'type':'string','minLength':1,'maxLength':64},
                                   'enabled':{'type':'boolean'}}},
                    {},30,'none')
    register_action('platform.org.department_update','1.0.0','改挂上级部门','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['department'],
                     'properties':{'department':{'type':'string','minLength':1,'maxLength':64},
                                   'parent':{'type':'string','maxLength':64}}},
                    {},30,'none')
    register_action('platform.org.member_assign','1.0.0','成员任职（可多部门兼任）','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['user','department'],
                     'properties':{'user':{'type':'string','minLength':3,'maxLength':140},
                                   'department':{'type':'string','minLength':1,'maxLength':64}}},
                    {},30,'none')
    register_action('platform.org.member_remove','1.0.0','移出部门（调岗）','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['user','department'],
                     'properties':{'user':{'type':'string','minLength':3,'maxLength':140},
                                   'department':{'type':'string','minLength':1,'maxLength':64}}},
                    {},30,'none')
    register_action('platform.org.head_assign','1.0.0','任命部门负责人','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['user','department'],
                     'properties':{'user':{'type':'string','minLength':3,'maxLength':140},
                                   'department':{'type':'string','minLength':1,'maxLength':64}}},
                    {},30,'none')
    register_action('platform.org.head_remove','1.0.0','取消部门负责人','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['user','department'],
                     'properties':{'user':{'type':'string','minLength':3,'maxLength':140},
                                   'department':{'type':'string','minLength':1,'maxLength':64}}},
                    {},30,'none')
    register_action('platform.org.owner_assign','1.0.0','任命企业管理者','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['user'],
                     'properties':{'user':{'type':'string','minLength':3,'maxLength':140},
                                   'enterprise':{'type':'string','maxLength':64}}},
                    {},30,'none')
    register_action('platform.org.owner_remove','1.0.0','取消企业管理者','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['user'],
                     'properties':{'user':{'type':'string','minLength':3,'maxLength':140},
                                   'enterprise':{'type':'string','maxLength':64}}},
                    {},30,'none')
    # 版本号 **2.0.0（大版本）** —— 不是 1.2.0：`level='enterprise'` 原先是**合法载荷**、
    # 现在**被拒**，老调用方当场失败 = 破坏兼容 = major（D 2026-10-15 提出，semver 口径）。
    # 1.2.0 传的信号是「老的照旧能用」，其实不能。改定义要升号，**升几位看兼容性**，
    # 不是「升一位」——删原本合法的值就是 major。
    #
    # `level` 的约束**故意不写 `enum`，写 `description`**（D 2026-10-15 实测取舍）：
    # 写 enum 会被 `schema_validation.py` 的通用文案「动作字段值不在允许范围」先拦掉，
    # **用户那句口径「尚书是单例，没有企业归属」根本到不了眼前**。
    # 拒因落在 `field_access.attribution_level`（文案对、契约诚实、UI 无损）。
    # 将来要「拒因说人话」且保留 enum 闸，得让 schema_validation 支持 per-value 提示
    # —— 那是内核的，本笔不动，记在「公共组合块建议」。
    register_action('platform.org.resource_assign','2.2.0','资源归属（个人/部门两级，尚书是单例无企业归属）','write','required',['Desk User'],
                    {'type':'object','additionalProperties':False,'required':['resource'],
                     'properties':{'resource':{'type':'string','minLength':1,'maxLength':140},
                                   'level':{'type':'string','description':'归属层级：只认 personal / department。**尚书是单例，没有企业归属**（用户 2026-10-15 原话）—— enterprise 永不产生，不许显式传、也不许没给 level 时兜底成它。'},
                                   'department':{'type':'string','maxLength':64},
                                   'owner_user':{'type':'string','maxLength':140},
                                   'expected_modified':{'type':'string','maxLength':140},
                                   'dry_run':{'type':'boolean','title':'仅影响预览，不落库（B6）'}}},
                    {},30,'none')
    # 建表授权与明确共享（契约 §3.11：默认读权之外唯一例外=明确共享，可多选部门）。
    # share 两动作给 Desk User：归属人自助共享（服务端判归属，不信客户端自报）；
    # create_grant 是受管授权，仍限系统管理员。
    register_action('platform.org.create_grant','1.0.0','跨部门建表授权','write','required',['System Manager'],
                    {'type':'object','additionalProperties':False,'required':['user','department','scope'],
                     'properties':{'user':{'type':'string','minLength':3,'maxLength':140},
                                   'department':{'type':'string','minLength':1,'maxLength':64},
                                   'scope':{'type':'string','enum':['create']}}},
                    {},30,'none')
    register_action('platform.org.public_resource','1.0.0','发布或撤出企业公共资料','write','required',['Desk User'],
                    {'type':'object','additionalProperties':False,'required':['resource','enabled'],
                     'properties':{'resource':{'type':'string','minLength':1,'maxLength':140},'enabled':{'type':'boolean'}}},
                    {},30,'none')
    register_action('platform.org.share_grant','1.1.0','共享资源给个人或多个部门','write','required',['Desk User'],
                    {'type':'object','additionalProperties':False,'required':['resource','access'],
                     'properties':{'resource':{'type':'string','minLength':1,'maxLength':140},
                                   'access':{'type':'string','enum':['read','edit']},
                                   'user':{'type':'string','maxLength':140},
                                   'users':{'type':'array','uniqueItems':True,'items':{'type':'string','maxLength':140}},
                                   'department':{'type':'string','maxLength':64},
                                   'departments':{'type':'array','uniqueItems':True,'items':{'type':'string','maxLength':64}}}},
                    {},30,'none')
    register_action('platform.org.share_revoke','1.1.0','撤销共享','write','required',['Desk User'],
                    {'type':'object','additionalProperties':False,'required':['resource'],
                     'properties':{'resource':{'type':'string','minLength':1,'maxLength':140},
                                   'user':{'type':'string','maxLength':140},
                                   'users':{'type':'array','uniqueItems':True,'items':{'type':'string','maxLength':140}},
                                   'department':{'type':'string','maxLength':64},
                                   'departments':{'type':'array','uniqueItems':True,'items':{'type':'string','maxLength':64}}}},
                    {},30,'none')
    if install_triggers:
        ensure_immutable_triggers("Shangshu Process Definition Version", "shangshu_process_version")
