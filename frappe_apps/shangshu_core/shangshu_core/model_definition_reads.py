"""受管模型正式定义的定点批读；与 compiled_definition 同属服务端策略元数据能力。"""
import json

import frappe


def managed_object_definitions(object_ids):
    """返回指定对象的 active 定义，不加载记录、全目录或页面权限投影。

    与 managed_object_definition 一致：这是供服务端规则判定使用的正式元数据，
    不是用户可见字段列表，也不授予读取/写入记录的权限。不得直接作为 HTTP 响应暴露。
    缺失、未启用、损坏的定义不出现在结果中；调用方不能据此编造权威数据。
    空范围返回空；每批最多 500 个显式 ID，无逐对象查询或跨请求缓存。
    """
    if object_ids is None:
        return {}
    if not isinstance(object_ids, (list, tuple)) or any(not isinstance(oid, str) for oid in object_ids):
        frappe.throw('受管定义批读必须提供对象 ID 列表', frappe.ValidationError)
    ids = list(dict.fromkeys(oid for oid in object_ids if oid))
    if not ids:
        return {}
    # 延迟导入，公共 API 导出时不提前装载记录运行时。
    from shangshu_core.model_records import MODEL

    result = {}
    for offset in range(0, len(ids), 500):
        batch = ids[offset:offset + 500]
        rows = frappe.get_all(MODEL,
            filters={'name': ['in', batch], 'active_revision': ['>', 0]},
            fields=['name', 'active_json'], limit_page_length=len(batch))
        for row in rows:
            try:
                compiled = json.loads(row.get('active_json') or '{}')
            except (TypeError, ValueError):
                continue
            if isinstance(compiled, dict):
                result[row['name']] = compiled
    return result
