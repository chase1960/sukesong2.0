"""manifest 依赖唯一解析；可选仅改变前置条件，不授予目标权限。"""
import re

import frappe
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version


def dependencies(manifest):
    result, seen = [], set()
    for key in ('dependencies', 'optional_dependencies'):
        declarations = manifest.get(key) or []
        if not isinstance(declarations, list):
            frappe.throw(f'领域依赖必须为列表：{key}', frappe.ValidationError)
        for declaration in declarations:
            target, separator, constraint = str(declaration).partition('@')
            constraint = constraint.strip().strip('"\'')
            optional = key == 'optional_dependencies'
            if (not separator or not constraint or not re.fullmatch(r'com\.shangshu\.[a-z0-9][a-z0-9._-]*', target)
                    or target in seen or (optional and target == 'com.shangshu.core')):
                frappe.throw(f'领域依赖声明无效或重复：{manifest.get("id", "")}/{declaration}', frappe.ValidationError)
            try:
                spec = SpecifierSet(re.sub(r'\s+', ',', constraint))
            except InvalidSpecifier:
                frappe.throw(f'领域依赖版本规则无效：{target}@{constraint}', frappe.ValidationError)
            seen.add(target)
            result.append({'id': target, 'version': constraint, 'optional': optional, 'spec': spec})
    return result


def compatible_version(version, dependency):
    try:
        return bool(version and Version(str(version)) in dependency['spec'])
    except InvalidVersion:
        return False
