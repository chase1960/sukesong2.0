"""**声明邮件域在统一日志库里的专属字段**（§8 第 11 项）。

**为什么要有这个补丁**：邮件域的过程记录走**同一张日志表**（不另开日志表 ——
契约 `contracts/unified-log-v1.json` 的 `hard_rules`），而「这封信跟哪个案件有关」
（`case_ref`）是**邮件域自己的字段** ⇒ 按契约 `extension_fields.storage=per_domain`
落在**邮件域自己那张扩展表**里（`Shangshu Log Extension com-shangshu-mail`）。

**为什么需要补丁而不是只在装域时建**：扩展表是**代码建出来的**（不是 App 里
放一份 DocType JSON）⇒ 新装站会由 `install.py` 建；**已在跑的站**不会重跑装域
⇒ 升级时得由这个补丁补上，否则邮件域写过程记录时会因为扩展表不在而写不进去。

**幂等**：`declare_process_log_fields` 本身幂等（表在就改列，不在就建）⇒
重跑不产生第二张表。
"""
from shangshu_mail.mailprocess import declare_log_fields


def execute():
    declare_log_fields()
