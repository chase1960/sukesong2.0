"""已注册只读服务的 GET 入口；执行仍由原领域服务调度器负责。"""
import frappe

from shangshu_core.domains import invoke_domain_service, raw_resource


def read_registered_service(service_id, payload=None):
    domain, service = raw_resource('services', service_id)
    if not domain or not service:
        frappe.throw('领域服务不存在', frappe.DoesNotExistError)
    if service.get('effect') != 'read':
        frappe.throw('该服务未声明为只读，不能通过 GET 执行', frappe.PermissionError)
    # 客户端参数不参与效应判定。原入口继续检查登录、域调用声明、启停、权限与输入输出。
    return invoke_domain_service(service_id, payload)
