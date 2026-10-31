"""表格格值写入操作台账（B5 受管撤回的核验源）。

逐格 before/after 由服务端写入时自记；撤回只信这份台账，不收客户端自报快照。
台账不给普通角色读写入口——撤回经动作走，动作内按当前写权核验。
"""
import frappe


class ShangshuFileCenterSheetOp(frappe.model.document.Document):
    pass
