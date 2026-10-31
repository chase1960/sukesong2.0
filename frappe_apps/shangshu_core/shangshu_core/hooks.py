app_name = "shangshu_core"
app_title = "尚书平台核心"
app_publisher = "Shangshu"
app_description = "身份、动作治理与 AI 混合流程运行时"
app_email = "dev@shangshu.local"
app_license = "MIT"
required_apps = ["frappe"]

override_doctype_class = {"File": "shangshu_core.attachments.PlatformFile"}

shangshu_domain_contributions = ["shangshu_core.domain.get_contribution"]

after_install = "shangshu_core.install.after_install"
after_migrate = "shangshu_core.install.after_migrate"

scheduler_events = {"all": ["shangshu_core.events.recover_event_deliveries"]}

doc_events = {
    "*": {
        "validate": "shangshu_core.model_records.guard_direct_write",
        "on_trash": ["shangshu_core.model_records.guard_direct_write", "shangshu_core.object_companions.guard_source_delete"],
        "on_update": "shangshu_core.object_companions.sync_source_document",
    },
    "User": {
        "after_insert": "shangshu_core.identity.ensure_identity_for_user",
    }
}
