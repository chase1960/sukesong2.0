app_name = "shangshu_mail"
app_title = "尚书邮箱"
app_publisher = "Shangshu"
app_description = "企业邮件工作面：私人草稿与受管邮件生命周期"
app_email = "dev@shangshu.local"
app_license = "MIT"
# 合并说明（2026-10-21）：`shangshu_files` 从**必装**改成**可选集成** ——
# 与 `shangshu-plugin.yml` 的 `optional_dependencies` 对齐（内核的 manifest 检查
# 要求「manifest 的 dependencies」与「App 的 required_apps」**逐字一致**）。
# 理由：邮件域的生产代码自己就按「文件中心是可选集成」写（`delivery.py:imported_of`：
# 文件域未安装/停用/不可用时回 {} 不抛），反过来 files 对 mail 本来就是可选依赖。
# 必装依赖会让「停用文件域」被「已启用领域依赖：邮箱」直接挡掉，
# 「文件域停了邮件域还能用」这条产品行为就永远做不到。
required_apps = ["frappe", "shangshu_core"]
shangshu_domain_contributions = ["shangshu_mail.domain.get_contribution"]
after_install = "shangshu_mail.install.setup"
after_migrate = "shangshu_mail.install.setup"
permission_query_conditions = {"Shangshu Mail Message": "shangshu_mail.service.permission_query", "Shangshu Mail Account":"shangshu_mail.account.permission_query"}
has_permission = {"Shangshu Mail Message": "shangshu_mail.service.has_permission", "Shangshu Mail Account":"shangshu_mail.account.has_permission"}
