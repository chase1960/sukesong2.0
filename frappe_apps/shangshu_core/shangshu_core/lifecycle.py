"""管理员领域预检与执行共用投影；不保存第二份依赖/待办事实。"""
import json
from pathlib import Path
import yaml
import frappe
from shangshu_core.dependencies import dependencies, compatible_version


def assert_declared_call(target):
    caller = getattr(frappe.flags, 'shangshu_call_domain', None)
    if not caller or caller in (target, 'com.shangshu.core'):
        return
    app = frappe.db.get_value('Shangshu Domain', caller, 'owner_app')
    manifest = yaml.safe_load((Path(frappe.get_app_path(app)).parent / 'shangshu-plugin.yml').read_text())
    dependency = next((item for item in dependencies(manifest) if item['id'] == target), None)
    if not dependency:
        frappe.throw(f'未声明跨域调用依赖：{caller} → {target}', frappe.PermissionError)
    if dependency['optional']:
        rows = frappe.db.sql('SELECT domain_version FROM `tabShangshu Domain` WHERE name=%s LOCK IN SHARE MODE', (target,), as_dict=True)
        version = rows[0].domain_version if rows else None
        if not compatible_version(version, dependency):
            frappe.throw(f'可选集成未安装或版本不兼容：{caller} → {target}', frappe.ValidationError)


def _owned_data_counts(domain_id, contribution):
    """这个域名下**它自己声明的对象**底下有多少数据（受管记录条数 / DocType 行数）。

    为什么要有这个（2026-10-25 用户拍板）：**域拆了，数据不会跟着走** ——
    受管记录在内核的物理表里、DocType 行在 Frappe 里 ⇒ 逻辑没了、数据成了孤儿
    ⇒ 停用/拆走前必须先处理 ⇒ 这里把条数数出来，好点名。

    数不到（没权限/对象已下线）⇒ **如实说「查不到」**，不假装是 0
    （假装 0 ＝ 静悄悄地放过孤儿数据）。
    """
    from shangshu_core import model_records

    counts = []
    for item in (contribution or {}).get("objects") or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("managed_title") or "").strip()
        if title:
            object_id = ""
            for definition in model_records.list_definitions():
                if str(definition.get("title") or "") == title:
                    object_id = str(definition.get("id") or "")
                    break
            if not object_id:
                counts.append((title, "查不到（受管对象不在清单里）"))
                continue
            try:
                total = model_records.query_records(object_id, {}, 1, 1).get("total") or 0
            except Exception as error:  # noqa: BLE001 —— 数不到要**说清**，不假装 0
                counts.append((title, "查不到（%s）" % str(error)[:80]))
                continue
            counts.append((title, total))
            continue
        doctype = str(item.get("doctype") or "").strip()
        if doctype:
            try:
                total = frappe.db.count(doctype)
            except Exception as error:  # noqa: BLE001 —— 同上：数不到就说数不到
                counts.append((doctype, "查不到（%s）" % str(error)[:80]))
                continue
            counts.append((doctype, total))
    return counts


def domain_lifecycle(domain_id):
    from shangshu_core.domains import DOMAIN_DOCTYPE, CORE_DOMAIN_ID, invoke_domain_service, raw_resource
    from shangshu_core.applications import domain_application_dependents
    # 管理预检与实际停用都读取最新已提交状态，不能沿用等待屏障前的快照。
    rows = frappe.db.sql('SELECT domain_id, display_name, owner_app, domain_version, enabled, execution_stopped, health_status, contribution_json '
                         'FROM `tabShangshu Domain` LOCK IN SHARE MODE', as_dict=True)
    by_id = {row.domain_id: row for row in rows}
    row = by_id[domain_id]
    blockers, requirements = [], []
    if domain_id == CORE_DOMAIN_ID:
        blockers.append('平台核心是系统必需组件')
    for item in rows:
        path = Path(frappe.get_app_path(item.owner_app)).parent / 'shangshu-plugin.yml'
        manifest = yaml.safe_load(path.read_text())
        for dependency in dependencies(manifest):
            target, constraint = dependency['id'], dependency['version']
            if item.domain_id == domain_id:
                installed = by_id.get(target)
                compatible = bool(installed and compatible_version(installed.domain_version, dependency))
                enabled = bool(installed and installed.enabled)
                available = bool(compatible and enabled and not installed.execution_stopped and installed.health_status != 'unavailable')
                requirements.append({'id': target, 'version': constraint, 'installed_version': installed.domain_version if installed else None,
                                     'compatible': compatible, 'enabled': enabled, 'optional': dependency['optional'], 'available': available})
            if target == domain_id and item.enabled and not dependency['optional']:
                blockers.append('已启用领域依赖：' + item.display_name)
    applications = domain_application_dependents(domain_id)
    blockers.extend('已发布应用引用：' + item['title'] for item in applications)
    contribution = json.loads(row.contribution_json)
    process_ids = {item['id']: item for item in contribution.get('processes', [])}
    action_ids = {item['id'] for item in contribution.get('actions', [])}
    instances = []
    for instance in frappe.db.get_values('Shangshu Process Instance', {'status': ['in', ['Running', 'Failed']]},
                                        ['name', 'definition_id', 'definition_version'], as_dict=True, for_update=True):
        version = frappe.get_doc('Shangshu Process Definition Version', instance.definition_version)
        actions = json.loads(version.dependency_snapshot_json or '{}').get('actions', {})
        own = process_ids.get(instance.definition_id)
        if own is not None or action_ids.intersection(actions):
            continuation = bool(own and own.get('allow_disabled_continuation'))
            instances.append({'id': instance.name, 'continuation': continuation})
            if not continuation:
                blockers.append('在途流程需先完成或处理：' + instance.name)
    events = []
    for event in frappe.db.get_values('Shangshu Event Envelope', {'status': ['in', ['Published', 'Failed', 'Partial']]},
                                     ['name', 'event_id', 'owner_domain', 'status', 'deliveries_json'], as_dict=True, for_update=True):
        deliveries = json.loads(event.deliveries_json or '[]')
        if event.owner_domain == domain_id or any(item.get('domain_id') == domain_id and item.get('status') != 'Delivered' for item in deliveries):
            events.append({'id': event.name, 'event_id': event.event_id, 'status': event.status})
            blockers.append('未完成事件投递：' + event.name)
    service_id = contribution.get('lifecycle_service')
    if row.enabled and service_id:
        owner, service = raw_resource('services', service_id)
        if not owner or owner['id'] != domain_id or not service:
            frappe.throw('领域生命周期服务归属无效', frappe.ValidationError)
        result = invoke_domain_service(service_id, {})
        blockers.extend(result['blockers'])
    # 2026-10-25（用户拍板）：**域名下还有「没人接手的数据」⇒ 停用前必须先处理**。
    # 域拆了 ⇒ 逻辑没了，但数据还在（受管记录在内核的物理表里、DocType 行在 Frappe 里）
    # ⇒ 会静悄悄地变成孤儿数据 ⇒ 这里**点名**（哪张表、多少条）。
    from shangshu_core.data_ownership import orphan_data_blockers
    blockers.extend(orphan_data_blockers(row.display_name,
                                          _owned_data_counts(domain_id, contribution)))
    stop_blockers = blockers + ['在途流程需先完成或处理：' + item['id'] for item in instances if item['continuation']]
    return {'requirements': requirements, 'applications': applications, 'instances': instances, 'events': events,
            'disable_blockers': list(dict.fromkeys(blockers)), 'stop_blockers': list(dict.fromkeys(stop_blockers))}
