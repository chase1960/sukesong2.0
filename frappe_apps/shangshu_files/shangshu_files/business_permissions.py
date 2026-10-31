"""文件中心对公共试用策略的适配；不增加原生文档写权限。

Frappe has_permission hook 只能收紧 DocPerm，不能授权没有 Desk User 的
登录账号。本模块在文件中心的读入口显式授权，继续使用原生查询解析与分页，
在 SQL 中保留企业条件。保存仍只经业务动作，不打开裸 REST 写。
"""
import frappe
from shangshu_core.public_api import business_access


FILE = 'Shangshu File Center File'
VERSION = 'Shangshu File Center Version'
DIRECTORY = 'Shangshu File Directory'


def read_decision(doc, user=None):
    business_access.require_identity(user)
    if not business_access.is_open(user):
        return None
    if doc.doctype == DIRECTORY:
        # 目录是当前部署共用的基础设施，无独立企业数据；文件仍逐件判企业。
        return True
    if doc.doctype == VERSION:
        if not frappe.db.exists(FILE, doc.file):
            return False
        return read_decision(frappe.get_doc(FILE, doc.file), user)
    if doc.doctype == FILE:
        return business_access.resource_decision(doc.name, user, owner=doc.owner)
    frappe.throw('不支持的文件读取类型', frappe.PermissionError)


class BusinessReadMixin:
    def check_permission(self, permtype='read', permlevel=None):
        if permtype == 'read':
            decision = read_decision(self)
            if decision is not None:
                if not decision:
                    frappe.throw('当前企业不可访问该文件', frappe.PermissionError)
                return None
        return super().check_permission(permtype, permlevel)


def get_list(doctype, **kwargs):
    """仅固定文件表使用，保留 Frappe 的过滤/分页/SQL 安全解析。

    原生角色入场不适用于当前开放口径，因此在显式授权后替换权限条件；
    不修改 Frappe 全局，不给请求授管理员角色。
    """
    business_access.require_identity()
    if not business_access.is_open():
        return frappe.get_list(doctype, **kwargs)
    if doctype not in (FILE, VERSION, DIRECTORY):
        frappe.throw('不支持的文件清单类型', frappe.PermissionError)
    from frappe.model.db_query import DatabaseQuery
    if doctype == DIRECTORY:
        condition = '1=1'
    else:
        condition = business_access.file_query_condition(FILE)
        if doctype == VERSION:
            condition = ('`tabShangshu File Center Version`.file IN (SELECT name '
                         'FROM `tabShangshu File Center File` WHERE ' + condition + ')')

    class AuthorizedFileQuery(DatabaseQuery):
        def build_conditions(self):
            super().build_conditions()
            self.permission_conditions.append('(' + condition + ')')

    kwargs.pop('ignore_permissions', None)
    return AuthorizedFileQuery(doctype).execute(ignore_permissions=True, **kwargs)
