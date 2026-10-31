"""离线夹具用的「试用开放策略」桩。

⚠️ 只给**离线单测**用：真实现是 `shangshu_core/business_access.py`（连 Frappe）。
这里复刻的是**它的公开接口形状**与**开放口径下的结论**（角色闸不阻断），
让那些只关心「业务语义」的夹具不必为了业务_access 改自己的断言。

**不是**另一个策略实现：真判定必须走 `business_access.is_open()` / `resource_decision()`。
"""
from types import SimpleNamespace


def make_business_access_stub(open_policy=True):
    """返回一个与真模块同形状的桩。

    open_policy=True  ⇒ 试用开放口径：已登录账号一律放行（资源级仍要过企业归属）。
    open_policy=False ⇒ 关闭开放：回到角色闸。
    """
    state = {'open': open_policy}

    def require_identity(user=None):
        if not state['open']:
            return SimpleNamespace(enterprise_id='e1')
        return SimpleNamespace(enterprise_id='e1')

    def is_open(user=None):
        return bool(state['open'])

    def resource_is_open(resource_id, user=None):
        return bool(state['open'])

    def resource_decision(resource, user=None, owner=None):
        # None = 「归属那半判不了」⇒ 调用方回落自己的口径；开放口径下资源级一律放行。
        return True if state['open'] else None

    def same_enterprise(enterprise_id, user=None):
        return True if state['open'] else enterprise_id == 'e1'

    def file_query_condition(table, user=None):
        return '1=1' if state['open'] else '1=0'

    def authorized_get_list(doctype, **kwargs):
        import frappe
        return frappe.get_list(doctype, **kwargs)

    return SimpleNamespace(
        OPEN_BUSINESS_ACCESS=state['open'],
        require_identity=require_identity,
        is_open=is_open,
        resource_is_open=resource_is_open,
        resource_decision=resource_decision,
        same_enterprise=same_enterprise,
        file_query_condition=file_query_condition,
        authorized_get_list=authorized_get_list,
        set_open=lambda value: state.__setitem__('open', value),
    )
