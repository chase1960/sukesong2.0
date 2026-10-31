"""安装/CI 检查已安装贡献与包声明，不执行未安装行业代码。"""
from pathlib import Path
import yaml
import frappe
from shangshu_core.dependencies import dependencies, compatible_version


def _check_dependencies(manifests):
    graph = {}
    for domain_id, manifest in manifests.items():
        targets = set()
        for dependency in dependencies(manifest):
            target, constraint = dependency['id'], dependency['version']
            if dependency['optional']:
                continue
            targets.add(target)
            if target not in manifests:
                frappe.throw(f'领域依赖未安装：{domain_id} → {target}', frappe.ValidationError)
            if not compatible_version(manifests[target]['version'], dependency):
                frappe.throw(f'领域依赖版本不兼容：{domain_id} → {target} 需要 {constraint}，实际 {manifests[target]["version"]}', frappe.ValidationError)
        graph[domain_id] = targets
    visited, active = set(), []
    def visit(domain_id):
        if domain_id in active:
            frappe.throw('领域依赖存在循环：' + ' → '.join([*active, domain_id]), frappe.ValidationError)
        if domain_id in visited:
            return
        active.append(domain_id)
        for target in sorted(graph[domain_id]):
            visit(target)
        active.pop()
        visited.add(domain_id)
    for domain_id in graph:
        visit(domain_id)


def check_registered_manifests():
    from shangshu_core.domains import _providers, _resource_id, RESOURCE_SECTIONS
    checked = []
    contributions = _providers()
    manifests = {}
    for contribution in contributions:
        app = contribution['owner_app']
        path = Path(frappe.get_app_path(app)).parent / 'shangshu-plugin.yml'
        if not path.is_file():
            frappe.throw(f'领域缺少 manifest：{app}', frappe.ValidationError)
        manifests[contribution['id']] = yaml.safe_load(path.read_text(encoding='utf-8'))
    _check_dependencies(manifests)
    owner_ids = {item['owner_app']: item['id'] for item in contributions}
    for contribution in contributions:
        app = contribution['owner_app']
        manifest = manifests[contribution['id']]
        for key in ('id', 'version', 'platform_api'):
            if manifest.get(key) != contribution.get(key):
                frappe.throw(f'manifest 与运行贡献不一致：{app}/{key}', frappe.ValidationError)
        exports = manifest.get('exports') or {}
        for section in RESOURCE_SECTIONS:
            key = 'workflows' if section == 'processes' else section
            declared = set(exports.get(key) or [])
            actual = {_resource_id(section, item) for item in contribution.get(section) or []}
            if declared != actual:
                # **说清怎么修**（2026-10-22）：只报「缺失/多余」的话，人得自己猜是改哪一边。
                #   缺失＝域的贡献里有、manifest 里没有 ⇒ **把 manifest 的 {section} 段补上**；
                #   多余＝manifest 里有、域的贡献里没有 ⇒ **把 manifest 的 {section} 段删掉**。
                missing = sorted(actual - declared)
                extra = sorted(declared - actual)
                parts = []
                if missing:
                    parts.append(f"缺失={missing}（域的贡献里有、manifest 的 {section} 段没有 ⇒ 把它们加进 manifest）")
                if extra:
                    parts.append(f"多余={extra}（manifest 的 {section} 段有、域的贡献里没有 ⇒ 把它们从 manifest 删掉）")
                frappe.throw(
                    f'manifest 资源不一致：{app}/{section} ' + '；'.join(parts)
                    + f'（manifest 文件：{app}/shangshu-plugin.yml）',
                    frappe.ValidationError)
        declared_apps = {str(item).split('@',1)[0] for item in manifest.get('dependencies') or []}
        required = {owner_ids[name] for name in frappe.get_hooks('required_apps', app_name=app) or [] if name in owner_ids}
        if declared_apps != required:
            frappe.throw(f'manifest 依赖与 App 依赖不一致：{app}', frappe.ValidationError)
        checked.append(contribution['id'])
    return {'checked': checked}
