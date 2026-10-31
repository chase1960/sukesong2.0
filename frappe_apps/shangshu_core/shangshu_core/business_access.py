"""当前开放试用策略：业务资格全开，身份与企业边界不变。

唯一开关，不写角色、不替换用户、不改保存/日志/校验流程。账号管理、
安装与系统凭据处理器仍使用各自的管理保护。关闭本开关恢复声明权限。
"""
import frappe

from shangshu_core.identity import get_identity


OPEN_BUSINESS_ACCESS = True
# 系统管理与凭据资源不属于业务资格全开范围，仍执行原角色/处理器保护。
_PROTECTED_PREFIXES = ('platform.identity.', 'platform.org.', 'platform.domain.',
                       'ip.device_credential.', 'mail.account.', 'mail.mailbox.')


def resource_is_open(resource_id, user=None):
    resource_id = str(resource_id or '')
    return bool(resource_id and not resource_id.startswith(_PROTECTED_PREFIXES)
                and is_open(user))


def require_identity(user=None):
    current = str(getattr(frappe.session, 'user', '') or '')
    target = str(user or current)
    if current in ('', 'Guest') or target in ('', 'Guest'):
        frappe.throw('需要登录后才能使用业务功能', frappe.PermissionError)
    # Frappe local 随请求销毁；只复用本次请求的身份检查，不跨请求缓存撤权。
    cache = getattr(frappe.local, 'shangshu_business_identities', None)
    if not isinstance(cache, dict):
        cache = {}
        frappe.local.shangshu_business_identities = cache
    if target not in cache:
        cache[target] = get_identity(target)
    return cache[target]


def is_open(user=None):
    if not OPEN_BUSINESS_ACCESS:
        return False
    try:
        require_identity(user)
    except frappe.PermissionError:
        return False
    return True


def same_enterprise(enterprise_id, user=None):
    return bool(enterprise_id and is_open(user)
                and require_identity(user).enterprise_id == enterprise_id)


def resource_decision(resource, user=None, owner=None):
    """True/False 是试用授权结论；None 表示开关已关闭，交原权限声明判。

    文件/表归属不重新建模。归属部门或所有人的企业仍须匹配；无归属旧文件
    按历史创建人的身份企业判，缺少企业依据时明确拒绝，不猜成当前企业。
    """
    if not OPEN_BUSINESS_ACCESS:
        return None
    if not is_open(user):
        return False
    from shangshu_core import org_admin
    att = org_admin.resource_attribution(resource)
    if not att:
        owner = owner or org_admin.resource_owner(resource)
        if not owner:
            return None  # 非文件资源没有组织归属，由其自身对象权限继续判。
        enterprise = frappe.db.get_value('Shangshu Identity', {'user': owner}, 'enterprise_id')
    else:
        enterprise = org_admin._attribution_enterprise(att, resource)
    return same_enterprise(enterprise, user)


def file_query_condition(table, user=None):
    """文件清单 SQL 与单件判定同源；不把全量文件搬到 Python 后再筛。

    只供文件域固定表调用，不接收浏览器提供的表名。
    """
    if table != 'Shangshu File Center File':
        frappe.throw('不支持的业务资源表', frappe.ValidationError)
    if not is_open(user):
        return '1=0'
    enterprise = frappe.db.escape(require_identity(user).enterprise_id)
    return ("CASE WHEN EXISTS (SELECT 1 FROM `tabShangshu Org Attribution` ba "
            "WHERE ba.resource=`tabShangshu File Center File`.name) THEN "
            "(SELECT CASE WHEN ba.level='department' THEN "
            "(SELECT bd.enterprise_id FROM `tabShangshu Department` bd WHERE bd.name=ba.department) "
            "ELSE (SELECT bi.enterprise_id FROM `tabShangshu Identity` bi WHERE bi.user=ba.owner_user) END "
            "FROM `tabShangshu Org Attribution` ba WHERE ba.resource=`tabShangshu File Center File`.name) "
            "ELSE (SELECT bi.enterprise_id FROM `tabShangshu Identity` bi "
            "WHERE bi.user=`tabShangshu File Center File`.owner) END=" + enterprise)


def authorized_get_list(doctype, **kwargs):
    """试用开放口径下的清单读：**角色档位不再筛行**，字段/筛选范围仍由调用方按声明收紧。

    ⚠️ **只放开「谁能看到行」这一层**：
    · 调用方给的 `fields` 与 `filters` **一个字段都不放宽**（声明之外的列取不到）；
    · 排序、翻页、条数上限照旧走 Frappe 的查询构造（**不走裸 SQL**）；
    · **数据规则、版本、事务、审计不在这里**（那些在动作与受管记录那条路上）。

    为什么需要它：Frappe 的 `frappe.get_list` 会按 **DocPerm 角色档位**过滤行 ——
    一个刚建好、还没领到「Desk User」角色的**已登录账号**会看到**空列表**，
    与「试用期对全体已登录账号开放」的口径直接矛盾。
    建模对象/原生表这条路原本就是 Frappe 角色说了算；这里换成**公共开放策略**说了算。

    与文件域 `shangshu_files.business_permissions.get_list` 同一套写法
    （同一个 DatabaseQuery 子类 + 显式权限条件），**不给请求授管理员角色**、
    **不改 Frappe 全局**。
    """
    if not is_open():
        return frappe.get_list(doctype, **kwargs)
    from frappe.model.db_query import DatabaseQuery

    class AuthorizedObjectQuery(DatabaseQuery):
        def build_conditions(self):
            super().build_conditions()
            self.permission_conditions.append('(1=1)')

    kwargs.pop('ignore_permissions', None)
    return AuthorizedObjectQuery(doctype).execute(ignore_permissions=True, **kwargs)
