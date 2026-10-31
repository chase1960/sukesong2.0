from frappe.model.document import Document


class ShangshuObjectCompanion(Document):
    def before_validate(self):
        self._invalidate_zone()

    def on_trash(self):
        self._invalidate_zone()

    def _invalidate_zone(self):
        from shangshu_core.model_records import is_managed
        from shangshu_core.write_zone_schema import revoke_certification
        previous = self.get_doc_before_save()
        ids = {self.object_id, previous.object_id if previous else None}
        for object_id in sorted(value for value in ids if is_managed(value)):
            revoke_certification(object_id)
