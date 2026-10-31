from shangshu_core.immutable import ImmutableDocument
import frappe


class ShangshuUnifiedLog(ImmutableDocument):
    """统一日志行：写下就锁住（不可改、不可删）。

    日志是「谁在什么时候动了什么」的证据 —— 改它等于改证据。
    要纠错就追加新行，不要覆盖旧行。
    """
    def validate(self):
        super().validate()
        if self.name != self.log_no:
            frappe.throw('日志主键必须等于日志编号，命名规则不能改写审计身份', frappe.ValidationError)
