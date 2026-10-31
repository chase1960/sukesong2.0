app_name = "shangshu_files"
app_title = "尚书文件中心"
app_publisher = "Shangshu"
app_description = "企业共享文件库：目录、上传、版本与回收"
app_email = "dev@shangshu.local"
app_license = "MIT"
required_apps = ["frappe", "shangshu_core"]
shangshu_domain_contributions = ["shangshu_files.domain.get_contribution"]
after_install = "shangshu_files.install.setup"
after_migrate = "shangshu_files.install.setup"
permission_query_conditions = {
    "Shangshu File Directory": "shangshu_files.access.permission_query",
    "Shangshu File Center File": "shangshu_files.service.permission_query",
    "Shangshu File Center Version": "shangshu_files.service.version_permission_query",
}
has_permission = {
    "Shangshu File Directory": "shangshu_files.access.has_permission",
    "Shangshu File Center File": "shangshu_files.service.has_permission",
    "Shangshu File Center Version": "shangshu_files.service.version_has_permission",
}


# ---------- 启动时挂内容就绪闸（D §17 域内半） ----------
# **挂载点是本文件**（app 初始化会 import `hooks.py`，代码即执行），不是 `install.setup()` ——
# 内核的 `_CONTENT_GATES` 是**进程内存字典**，在 `bench migrate` 里挂对 web 进程没用。
#
# **为什么不放 `domain.py`**：那边还压着一笔**待用户放行的角色面改动**，
# 两件事缠在一个文件里会一起卡住。**拆开，各提各的。**
#
# **内核缺了不抛、但大声记日志**（`register_content_gate_with_kernel` 的设计）——
# 抛了会把整个文件域弄挂。**闸到底挂上没有由判据查**
# （`promotion.content_gate_registered`），不由这里自说；判据先钉「闸在不在」
# 再钉「闸拦不拦」，闸没装后面全是空过。
try:
    from shangshu_files import promotion as _promo_for_gate
    _promo_for_gate.register_content_gate_with_kernel()
    del _promo_for_gate
except Exception as _gate_err:      # 导 promotion 本身失败也不许弄挂启动
    try:
        import frappe as _f
        _f.logger().error('[shangshu_files] 内容就绪闸挂载异常：%s: %s'
                          % (type(_gate_err).__name__, _gate_err))
    except Exception:
        pass

# **资源属主解析器**（`org_admin.structure_allows` 用）——
# 内核不认识领域 doctype（`Shangshu File Center File` 是文件域的），
# 所以内核只定契约、**由领域注册**（同 `objects.register_attribution_resolver` 的形状）。
# 不注册 → `resource_owner()` 回 `None` → `structure_allows` 跳过表主那条，
# 表主会在第 1 条就该拿到的 True 拿不到（**退回按角色判**）。
try:
    from shangshu_core import org_admin as _oa_owner

    def _file_owner(resource):
        """资源名 → 创建人。查不到回 None（不猜）。"""
        import frappe as _frappe
        try:
            return _frappe.db.get_value('Shangshu File Center File', resource, 'owner')
        except Exception:
            return None

    _oa_owner.register_owner_resolver(_file_owner)
    del _oa_owner
except Exception as _own_err:
    try:
        import frappe as _f
        _f.logger().error('[shangshu_files] 资源属主解析器注册异常：%s: %s'
                          % (type(_own_err).__name__, _own_err))
    except Exception:
        pass

# Core-only registered provider; not a client-selected callable.
shangshu_object_companion_project = "shangshu_files.object_projection.project"

shangshu_object_companion_operation = 'shangshu_files.object_projection.get_operation'

shangshu_public_resource_validate = 'shangshu_files.table_relations.validate_public'

# ---------- 受管记录变化 ⇒ 本域负责把正式值回填到那份文件投影 ----------
# **通用注册口**（内核 `shangshu_core.managed_changes`）：内核**不认得**本域，
# 它只按这个名单逐个调用 ⇒ 别的域要用，声明一行即可（**不给内核加专用分支**）。
# ⚠️ 本域自己的写入（cell_write／formal_write）**不走这条** —— 那两条路自己回填
#    （带两阶段「已入库、回填待恢复」语义）⇒ 处理器里会看到那个标志并让开。
shangshu_managed_change_handlers = ["shangshu_files.promotion.on_managed_record_change"]
shangshu_write_zone_projection_checks = ["shangshu_files.binding_metadata.inspect_projection_scope"]

# 旧链接只按完整 ID 精确识别；解析器异常不得当作‘未命中’换存储重试。
shangshu_table_resource_resolvers = ["shangshu_files.table_identity.resolve_table_resource"]
