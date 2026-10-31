from shangshu_core import __version__

DOMAIN_ID = "com.shangshu.core"


def get_contribution():
    from shangshu_core.record_import_xlsx import input_schema as import_schema
    from shangshu_core.input_constraints import input_schema as input_constraints_schema
    from shangshu_core.record_values import input_schema as values_read_schema
    from shangshu_core.proposal_values import input_schema as proposal_values_schema
    return {
        "id": DOMAIN_ID,
        "name": "尚书平台核心",
        "owner_app": "shangshu_core",
        "version": __version__,
        "platform_api": ">=1.0 <2.0",
        "default_enabled": True,
        "health": {"status": "healthy", "message": "公共对象、动作、事件与流程运行时"},
        "applications": [],
        "navigation": [],
        "workbench": [],
        "objects": [],
        # 部门下拉（A1 可选归属）：只出当前用户可建表归属的部门，字段 name/title/parent/enterprise/enabled
        "datasets": [
            {"id": "platform.department", "name": "部门", "roles": ["Desk User"],
             "query": "shangshu_core.org_admin.query_departments",
             "columns": [{"field": "title", "label": "部门"},
                         {"field": "parent", "label": "上级部门"},
                         {"field": "enterprise", "label": "企业"}]},
        ],
        "processes": [],
        "actions": [
            {"id": "platform.object.query", "handler": "shangshu_core.public_handlers.execute_action"},
        {"id": "platform.object.aggregate", "handler": "shangshu_core.public_handlers.execute_action"},
        # 结果集引用的有效性检查口（PKG-018-T08）：只报「还准不准」，不返数据。
        {"id": "platform.object.result_set", "handler": "shangshu_core.public_handlers.execute_action"},
        # **指标注册**（PKG-018-T09，轻量）：define 是配置面（不给 AI 投影），
        # run/list 是读面（给助手用）。
        {"id": "platform.metric.define", "handler": "shangshu_core.public_handlers.execute_action"},
        {"id": "platform.metric.run", "handler": "shangshu_core.public_handlers.execute_action"},
        {"id": "platform.metric.list", "handler": "shangshu_core.public_handlers.execute_action"},
        # 跨表 JOIN（PKG-018-T10）：只支持**声明过的引用关联**。
        {"id": "platform.object.join_aggregate", "handler": "shangshu_core.public_handlers.execute_action"},
        {"id": "platform.object.audit_log", "handler": "shangshu_core.public_handlers.execute_action"},
            {"id": "platform.object.create", "handler": "shangshu_core.model_records.write_record"},
            {"id": "platform.object.companion_write", "handler": "shangshu_core.companion_writes.write", "replay_guard": "shangshu_core.companion_writes.replay_guard", "transaction": "atomic_package", "transaction_versions": ["1.1.0"], "package_actions": ["platform.object.update_many"], "package_guard": "shangshu_core.companion_writes.is_managed_package"},
            {"id": "platform.object.companion_undo", "handler": "shangshu_core.companion_writes.write", "replay_guard": "shangshu_core.companion_writes.replay_guard", "transaction": "atomic_package", "transaction_versions": ["1.1.0"], "package_actions": ["platform.object.update_many"], "package_guard": "shangshu_core.companion_writes.is_managed_package"},
            {"id": "platform.object.companion_bind", "handler": "shangshu_core.object_companions.bind_action"},
            {"id": "platform.object.update", "handler": "shangshu_core.model_records.write_record"},
            # **一次写多行**（2026-10-27 夜 · PKG-132 性能线）：契约《处理契约与状态转换》
            # 第 4 步③ 要求的内核批量写能力 —— 动作框架走一次，**每条记录的门一件不少**。
            # Harness的局部批量填值复用同一动作；仍经当前身份、提案确认及原子包规则。
            {"id": "platform.object.update_many", "handler": "shangshu_core.model_records.write_records", "transaction": "atomic_package", "transaction_versions": ["1.1.0"], "package_actions": []},
            {"id": "platform.object.recycle", "handler": "shangshu_core.record_lifecycle.change_state"},
            {"id": "platform.object.restore", "handler": "shangshu_core.record_lifecycle.change_state"},
            {"id": "platform.object.import", "handler": "shangshu_core.record_import.import_records"},
            {"id": "platform.application.configure", "handler": "shangshu_core.application_delivery.configure"},
            {"id": "platform.application.inspect", "handler": "shangshu_core.application_delivery.inspect_application"},
            # 账号生命周期属内核身份职责（kernel-baseline §4.1），复用既有确认、幂等与执行审计。
            # 刻意不加入 tools：身份管理是高权限管理面，不给 AI 投影（人工在用户管理页执行）。
            {"id": "platform.identity.create", "handler": "shangshu_core.identity_admin.create_identity"},
            {"id": "platform.identity.status", "handler": "shangshu_core.identity_admin.set_identity_status"},
            {"id": "platform.identity.group", "handler": "shangshu_core.identity_admin.set_identity_group"},
            {"id": "platform.identity.role", "handler": "shangshu_core.identity_admin.set_identity_role"},
            {"id": "platform.identity.password", "handler": "shangshu_core.identity_admin.reset_identity_password"},
            # 组织事实（B1）：部门/任职/负责人/企业管理者/资源归属。组织事实唯一权威在
            # Shangshu Department/Org Member/Org Owner/Org Attribution；同样不进 tools。
            {"id": "platform.org.department_create", "handler": "shangshu_core.org_admin.department_create"},
            {"id": "platform.org.department_rename", "handler": "shangshu_core.org_admin.department_rename"},
            {"id": "platform.org.department_set_status", "handler": "shangshu_core.org_admin.department_set_status"},
            {"id": "platform.org.department_update", "handler": "shangshu_core.org_admin.department_update"},
            {"id": "platform.org.member_assign", "handler": "shangshu_core.org_admin.member_assign"},
            {"id": "platform.org.member_remove", "handler": "shangshu_core.org_admin.member_remove"},
            {"id": "platform.org.head_assign", "handler": "shangshu_core.org_admin.head_assign"},
            {"id": "platform.org.head_remove", "handler": "shangshu_core.org_admin.head_remove"},
            {"id": "platform.org.owner_assign", "handler": "shangshu_core.org_admin.owner_assign"},
            {"id": "platform.org.owner_remove", "handler": "shangshu_core.org_admin.owner_remove"},
            {"id": "platform.org.public_resource", "handler": "shangshu_core.public_resources.publish"},
            {"id": "platform.org.resource_assign", "handler": "shangshu_core.org_admin.resource_assign"},
            {"id": "platform.org.create_grant", "handler": "shangshu_core.org_admin.create_grant"},
            {"id": "platform.org.share_grant", "handler": "shangshu_core.org_admin.share_grant"},
            {"id": "platform.org.share_revoke", "handler": "shangshu_core.org_admin.share_revoke"},
        ],
        "tools": [{"id": "platform.object.query"}, {"id": "platform.object.aggregate"}, {"id": "platform.object.result_set"}, {"id":"platform.metric.run"}, {"id":"platform.metric.list"}, {"id":"platform.object.join_aggregate"}, {"id":"platform.object.create"}, {"id":"platform.object.update"}, {"id":"platform.object.update_many"}, {"id":"platform.object.companion_write"}, {"id":"platform.object.recycle"}, {"id":"platform.object.restore"}, {"id":"platform.object.import"}, {"id":"platform.application.configure"}, {"id":"platform.application.inspect"}],
        "services": [{'id':'platform.action_proposal.values', 'handler':'shangshu_core.proposal_values.read',
                      'roles':['Desk User'],'effect':'read',
                      'description':'显式恢复一条表格改值提案的原始差量；重验当前目标访问，保留原版本，不读取提案目录。',
                      'input_schema':proposal_values_schema(),
                      'output_schema':{'type':'object','additionalProperties':False,
                          'required':['id','capability','payload'],'properties':{
                              'id':{'type':'string'},'capability':{'type':'string'},'payload':{'type':'object'}}}},
                     {'id':'platform.object.values_read', 'handler':'shangshu_core.record_values.read',
                      'roles':['Desk User'],'effect':'read','purpose':'detail',
                      'description':'按明确记录和字段一次读取受管值与原版本；不读全表或逐行装配详情。',
                      'input_schema':values_read_schema()},
                     {'id':'platform.object.input_constraints',
                      'handler':'shangshu_core.input_constraints.read',
                      'roles':['Desk User'],'effect':'read','purpose':'detail',
                      'description':'按指定可读字段取可选值、是否允许自定义、是否能留空；不读记录或存储结构。',
                      'input_schema':input_constraints_schema()},
                     {'id':'platform.file.preview','handler':'shangshu_core.file_preview.preview',
                      'roles':['Desk User'],'effect':'read','input_schema':{'type':'object','additionalProperties':False,
                      'required':['ref_doctype','ref_name','file'],'properties':{key:{'type':'string','minLength':1,'maxLength':140} for key in ('ref_doctype','ref_name','file')}}},
                     {'id':'platform.file.pdf_page','handler':'shangshu_core.pdf_preview.preview',
                      'roles':['Desk User'],'effect':'read','input_schema':{'type':'object','additionalProperties':False,
                      'required':['ref_doctype','ref_name','file'],'properties':{
                          **{key:{'type':'string','minLength':1,'maxLength':140} for key in ('ref_doctype','ref_name','file')},
                          'page':{'type':'integer','minimum':1,'maximum':2000}}}},
                     {'id':'platform.object.import_preview','handler':'shangshu_core.record_import.preview_import',
                      'roles':['System Manager'],'effect':'read','input_schema':import_schema()},
                     {'id':'platform.object.history','handler':'shangshu_core.record_history.record_history',
                      'roles':['Desk User'],'effect':'read','input_schema':{'type':'object','additionalProperties':False,
                      'required':['object_id','name'],'properties':{'object_id':{'type':'string'},'name':{'type':'string'},
                      'page':{'type':'integer','minimum':1},'page_length':{'type':'integer','minimum':1,'maximum':50}}}},
                     {'id':'platform.object.export','handler':'shangshu_core.record_export.export_records',
                      'roles':['System Manager'],'effect':'read','input_schema':{'type':'object','additionalProperties':False,
                      'required':['object_id','expected_revision'],'properties':{'object_id':{'type':'string'},
                      'expected_revision':{'type':'integer'},'filters':{'type':'object'}}}},
                     {'id':'platform.application.delivery','handler':'shangshu_core.application_delivery.inspect_delivery',
                      'roles':['System Manager'],'effect':'read','input_schema':{'type':'object','additionalProperties':False,
                      'required':['operation','application_id'],'properties':{'operation':{'type':'string','enum':['export','import_preview','change_preview']},
                      'application_id':{'type':'string'},'package':{'type':'object'},'definition':{'type':'object'},'expected_revision':{'type':'integer'}}}},
                     # 协作人员目录（C10-A 文件中心「所有人筛选」下拉的数据源）。
                     # 函数 list_collaboration_people() 一直在 identity.py，缺的只是这一步注册。
                     # 2026-10-14 前它没进这张名单 → file-center.js 调到 404「领域服务不存在」，
                     # 而前端 catch{} 把错误吞了，下拉永远只剩「所有所有人」（静默空，用户无从察觉）。
                     # handler 走 collaboration_people() 而不是裸函数：回包要 `{people:[…]}`，
                     # 见该函数的说明 —— 数组会被 BFF 摊成对象，前端取值链就取不到了。
                     # **BASE967-16 联合筛选**（2026-10-19）：owner-filter 之前只装员工身份
                     # → 部门归属无法筛选 → A 要按 `kind` 分组/标 label。
                     # `include_groups: bool` 默认 False（不撑大下拉），True 时**额外**装
                     # 部门项到 `groups` 字段（**不混进 people**——A 的 `kind` 分组依赖）。
                     # 按业务编号找行（2026-10-22 收进内核）：example 与 UC02 关联费用**用同一个办法**，
                     # 域里不再各写一遍找行编排。
                     {'id':'platform.business_identity.find_row','handler':'shangshu_core.business_identity.find_row_by_business_identity',
                      'roles':['Desk User'],'effect':'read',
                      'input_schema':{'type':'object','additionalProperties':False,
                                     'required':['table','field','value'],
                                     'properties':{'table':{'type':'string','minLength':1,'maxLength':140},
                                                   'field':{'type':'string','minLength':1,'maxLength':140},
                                                   'value':{'type':['string','number','boolean']}}}},
                     # 按**工作簿行 ID** 解析成受管记录（2026-10-22 第四段）：
                     # 日志要能**按案件看** ⇒ 审计与事件得挂到受管记录上
                     # ⇒ 得先知道「这一行对应哪个受管对象、哪条受管记录」。
                     # 映射在文件域手里 ⇒ 这里编排，**不自己造一份**。
                     {'id':'platform.business_identity.resolve_row','handler':'shangshu_core.business_identity.resolve_row_by_identity',
                      'roles':['Desk User'],'effect':'read',
                      'input_schema':{'type':'object','additionalProperties':False,
                                     'required':['table','row_id'],
                                     'properties':{'table':{'type':'string','minLength':1,'maxLength':140},
                                                   'row_id':{'type':'string','minLength':1,'maxLength':140}}}},
                     {'id':'identity.list_collaboration_people','handler':'shangshu_core.identity.collaboration_people',
                      'roles':['Desk User'],'effect':'read',
                      'input_schema':{'type':'object','additionalProperties':False,
                                     'properties':{'include_groups':{'type':'boolean','default':False,
                                                                    'title':'是否同时装部门项（A 端 owner-filter 用）'}}}},
                     # **写一条过程记录**（2026-10-23，§8 第 11／12 项）：统一日志库的**写口**。
                     # 域走 `public_api.write_process_record`；**助手与别的域走这个平台服务** ——
                     # ⇒ 域与域之间**不直接依赖**，都汇到内核这一条路。
                     # 挂**服务段**而不是动作段：动作段要走**动作登记**、写动作还要**确认卡**
                     # ⇒ 助手那条路走不通；服务段是助手/别的域真正用的那条。
                     {'id':'platform.log.record','handler':'shangshu_core.public_handlers.record_process_log',
                      'roles':['Desk User'],'effect':'write',
                      'input_schema':{'type':'object','additionalProperties':False,
                                     'required':['what_id','domain_id'],
                                     'properties':{'what_id':{'type':'string','minLength':1,'maxLength':140},
                                                   'domain_id':{'type':'string','minLength':1,'maxLength':140},
                                                   'business_object_id':{'type':'string','maxLength':140},
                                                   'business_name':{'type':'string','maxLength':140},
                                                   'result':{'type':'string','enum':['Succeeded','Failed','Delivering','Rejected','Unknown']},
                                                   'trigger_source':{'type':'string','enum':['user','agent','scheduled','system','unknown']},
                                                   'detail':{'type':'object'}}},
                      'output_schema':{'type':'object',
                                        'properties':{'log_no':{'type':'string'},'domain_id':{'type':'string'},
                                                      'what_kind':{'type':'string'},'what_id':{'type':'string'},
                                                      'result':{'type':'string'},'business_object_id':{'type':'string'}}}}],        "events": [
            {
                "id": "platform.contract.checked",
                "version": "1.0.0",
                "roles": ["System Manager"],
                "sensitivity": "internal",
                "delivery": "at_least_once",
                "payload_schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["source"],
                    "properties": {"source": {"type": "string"}, "fail_once": {"type": "boolean"}},
                },
            }
        ],
        "subscriptions": [
            {
                "id": "platform.contract.checked.audit",
                "event_id": "platform.contract.checked",
                "versions": ["1.0.0"],
                "handler": "shangshu_core.public_handlers.handle_contract_checked",
            }
        ],
        # 通用协作角色：让"能管协作任务"不再借用财务的 Expense Approver 能力。
        "roles": [
            {"role": "Collaboration Manager", "label": "协作管理", "capabilities": ["collaboration_manage"]},
        ],
        "pages": [],
    }
