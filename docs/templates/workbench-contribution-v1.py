"""工作台贡献 v1 模板。

复制到业务 App 自己的领域模块后替换 example 命名空间；不要放进
shangshu_core，也不要直接修改公共工作台前端。
"""

import frappe


DOMAIN_ID = "com.shangshu.example"


def get_contribution():
    return {
        "id": DOMAIN_ID,
        "name": "示例业务域",
        "owner_app": "example_app",
        "version": "1.0.0",
        "platform_api": ">=1.0 <2.0",
        "workbench_api": "1.0.0",
        "workbench": [{
            "id": "example.pending_items",
            "title": "待处理事项",
            "kind": "metric",
            "route": "objects",
            "roles": ["Example User"],
        }],
        "workbench_provider": "example_app.domain.workbench_cards",
        # 其余 applications/datasets/actions 等领域贡献在本 App 内声明。
    }


def workbench_cards():
    # get_list 会执行当前用户的 Frappe 权限；不要改成 ignore_permissions 或裸 SQL。
    names = frappe.get_list("Example Item", filters={"status": "Open"}, pluck="name", limit_page_length=500)
    return [{
        "id": "example.pending_items",
        "value": len(names),
        "unit": "项",
        "description": "等待当前用户处理",
    }]
