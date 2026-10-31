from shangshu_files.business_permissions import BusinessReadMixin
import frappe
from shangshu_files.domain import file_kind
from shangshu_files.working_file import content_revision
from shangshu_files.location import slot, normalize_directory


class ShangshuFileCenterFile(BusinessReadMixin, frappe.model.document.Document):
    def validate(self):
        before = self.get_doc_before_save()
        from shangshu_files.binding_metadata import guard_saved_binding
        guard_saved_binding(self, before)
        changed = any(self.get(field) != (before.get(field) if before else None)
                      for field in ('reviewed_version', 'relations_json')
                      if self.get(field) or (before and before.get(field)))
        if changed and not frappe.flags.shangshu_file_review_write:
            frappe.throw('审核状态和业务关联只能通过文件审核动作保存', frappe.ValidationError)
        self.review_status = 'Reviewed' if int(self.reviewed_version or 0) >= content_revision(self) else 'Pending'
        from shangshu_files.directories import lock_tree, resolve
        lock_tree()
        # 路径是兼容投影；已绑定目录时以稳定 ID 为准。
        directory = resolve({'directory_id': self.directory_id} if self.directory_id else {'directory': self.directory})
        self.directory_id, self.directory = directory.name, directory.path
        self.directory = normalize_directory(self.directory)
        self.file_kind = file_kind(self.file_name)
        if not self.file_name or '/' in self.file_name or '\\' in self.file_name:
            frappe.throw('文件名不能包含路径分隔符', frappe.ValidationError)
        if self.status not in ('Active', 'Recycled'):
            frappe.throw('状态仅支持在库或已回收', frappe.ValidationError)
        self.location_slot = slot(self.status, self.name)
