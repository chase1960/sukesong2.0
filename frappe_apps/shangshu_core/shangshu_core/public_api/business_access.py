"""开放试用资格公共面；业务域不导入内核私有实现。"""
from shangshu_core.business_access import (
    file_query_condition, is_open, require_identity, resource_decision, same_enterprise,
)

__all__ = ['file_query_condition', 'is_open', 'require_identity',
           'resource_decision', 'same_enterprise']
