import frappe
from frappe.model.document import Document


class ShangshuMetricDefinition(Document):
    """指标定义（PKG-018-T09，**轻量**）：「统计什么／按哪个日期／如何去重」。

    ⚠️ **只能经受管动作改**（`platform.metric.define`）——
    直接改这张表会让「定义版本」与「内容指纹」对不上（口径变了看不出来）。
    所以这里只留一条自检：内容指纹必须与当前内容一致。
    """

    def validate(self):
        from shangshu_core import metric_registry
        name = str(self.metric_name or "").strip()
        if not metric_registry.NAME_RE.match(name):
            frappe.throw("指标名要用小写字母开头的字母数字下划线（例如 amount_total）",
                         frappe.ValidationError)
        content = {"object_id": self.object_id,
                   "metrics": frappe.parse_json(self.metrics_json or "[]"),
                   "date_field": self.date_field or None,
                   "distinct_field": self.distinct_field or None,
                   "filters": frappe.parse_json(self.filters_json or "{}")}
        if not self.object_id:
            frappe.throw("请说明这个指标统计哪一个受管对象", frappe.ValidationError)
        if int(self.definition_version or 0) < 1:
            frappe.throw("定义版本从 1 起", frappe.ValidationError)
        # 内容指纹**每次都重算**：口径变了它必须跟着变（旧结果里带的是旧指纹）。
        self.definition_hash = metric_registry.definition_hash(content)
