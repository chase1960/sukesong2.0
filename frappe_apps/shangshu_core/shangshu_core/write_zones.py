"""仅直接 HTTP update_many@1.1.0 的有限细锁准入，不是另一套保存器。

准备发生在任何动作/域/请求写入之前。未知入口、钩子、配置、缓存或元数据
继续 App X；合格者仍逐行执行原 doc.save，只把 App X 改成 App S + Model X。
配置全范围共享锁与请求本地缓存保持到外事务结束。代码、DDL及框架元数据
变更须排空维护；这里不声称事务行锁保护隐式提交。CLI/流程/外层域均不缩锁。
同一外事务只接纳一个细锁根动作；取得 S 后不升级、不换对象、不自行重试。
"""
import hashlib
import json
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from pathlib import Path

import frappe

_ACTION = 'platform.object.update_many'
_VERSION = '1.1.0'
_HTTP = 'shangshu_core.public_api.http.action_execute'
_MODEL = 'Shangshu Object Model'
_MARKER = '_shangshu_shared_write_zone'
_current = ContextVar('shangshu_write_zone', default=None)
_CONFIG_TABLES = ('Assignment Rule', 'Document Naming Rule', 'Energy Point Rule', 'Milestone Tracker',
                  'Notification', 'Server Script', 'Webhook', 'Workflow', 'User Type')
_DOC_EVENTS = {
    'on_update': ['frappe.desk.notifications.clear_doctype_notifications',
        'frappe.workflow.doctype.workflow_action.workflow_action.process_workflow_actions',
        'frappe.core.doctype.file.utils.attach_files_to_document',
        'frappe.automation.doctype.assignment_rule.assignment_rule.apply',
        'frappe.automation.doctype.assignment_rule.assignment_rule.update_due_date',
        'frappe.core.doctype.user_type.user_type.apply_permissions_for_non_standard_user_type',
        'frappe.search.sqlite_search.update_doc_index', 'shangshu_core.object_companions.sync_source_document'],
    'after_rename': ['frappe.desk.notifications.clear_doctype_notifications'],
    'on_cancel': ['frappe.desk.notifications.clear_doctype_notifications',
        'frappe.workflow.doctype.workflow_action.workflow_action.process_workflow_actions',
        'frappe.automation.doctype.assignment_rule.assignment_rule.apply'],
    'on_trash': ['frappe.desk.notifications.clear_doctype_notifications',
        'frappe.workflow.doctype.workflow_action.workflow_action.process_workflow_actions',
        'frappe.search.sqlite_search.delete_doc_index', 'shangshu_core.model_records.guard_direct_write',
        'shangshu_core.object_companions.guard_source_delete'],
    'on_update_after_submit': ['frappe.workflow.doctype.workflow_action.workflow_action.process_workflow_actions',
        'frappe.automation.doctype.assignment_rule.assignment_rule.apply',
        'frappe.automation.doctype.assignment_rule.assignment_rule.update_due_date',
        'frappe.core.doctype.file.utils.attach_files_to_document'],
    'on_change': ['frappe.social.doctype.energy_point_rule.energy_point_rule.process_energy_points',
        'frappe.automation.doctype.milestone_tracker.milestone_tracker.evaluate_milestone'],
    'validate': ['shangshu_core.model_records.guard_direct_write'],
}
_HOOK_LISTS = {
    'before_request': ['frappe.recorder.record', 'frappe.monitor.start', 'frappe.rate_limiter.apply'],
    'after_request': ['frappe.monitor.stop', 'shangshu_flow.auth.on_login_after_request'],
    'auth_hooks': [], 'sqlite_search': [], 'extend_doctype_class': [],
    'notification_config': ['frappe.core.notifications.get_notification_config'],
    'shangshu_managed_change_handlers': ['shangshu_files.promotion.on_managed_record_change'],
}
# 审核的是实际框架代码；同版本文件改变也只退粗。升级时须独立重新审核此表。
_FRAMEWORK_FILES = {
    'model/document.py': 'df0926c92a95130c427ab425ee2f4eb726601d29cc0976f735f1f2ed1ac426ef',
    'model/naming.py': 'fb23841d391a6657c8c82a616694b6e10366cf402dd35274dd0bf0c0d9aec002',
    'model/base_document.py': '6715fe10d3628c86813e1d64cd9f55de34ae211ec4a1b9ce32df6bba3a124bb1',
    'model/meta.py': '0bdc79bcceebc8722889b750c9006cb7dc4b7ca049c820c67f0a62848e41c02d',
    'utils/redis_wrapper.py': '6791bdd625428883c128214c71fc575562862ad15fb28ed72aebc540efba3455',
    'cache_manager.py': 'b6c2e5f9b3b34dd60752b0b28551be68a4291e589d83e067b186e5b0f0a78bfa',
    'model/workflow.py': 'f521f649e42287fb06ad84d34c9c4a1f97a148903cf6e1961bd686fb59183bc5',
    'core/doctype/server_script/server_script_utils.py': 'ed0d50b9000f1622fab22cda3d56d3cfab60877e54bf38a0c8bbc572adaf679e',
    'integrations/doctype/webhook/__init__.py': '1a3c313afeba12fb5ff28fc0530192331510b2e08e9d8aa077999e72245d471c',
    'automation/doctype/assignment_rule/assignment_rule.py': 'fa4d5564b23d82c414611f43214aa86b6ef1a416ab1352df775f0ad0c0a6e274',
    'automation/doctype/milestone_tracker/milestone_tracker.py': '58dce851bb04bfc0f34cdee7343ed3cc6e31bf722e725db925a79c6e639ec97d',
    'social/doctype/energy_point_rule/energy_point_rule.py': '2d7498240b34ff5778a7251678b060d458b8145b11d8feae315f79f6bb320e00',
    'core/doctype/user_type/user_type.py': 'ada6a43fb4786f838e81bb1cd354e2c9f45165f97bdbb173768a6fb9f7e85e81',
    'core/doctype/file/utils.py': 'b5a26d614f799d59661e7011e761b0628fe3e7fc5c301726fbbcc9c7dcd74c61',
    'desk/notifications.py': '806463337a471e948a366aec44dc4b79fda5bfe95d68c5b0ea857d75b135331b',
    'utils/global_search.py': 'ea720db78d9f4a0671eb6ebebab0a38c54b9a5625c177558d19e07f5d2e4e7c4',
    'search/sqlite_search.py': '917ff1f4c7353a65c5898d1ce9f00de836b7552a79258413970ca4d4e3ba38d4',
    'workflow/doctype/workflow_action/workflow_action.py': '205edbf3e553361d3168091071efa0d237165b1729e51d841b32ffb93ed131df',
    'core/notifications.py': 'ae98c5e64f20b1e8121f4a44831e85fb67a071803c2a57a7e019bb3a99813bc3',
    'recorder.py': '3e6fbe74cbea10621e4ccec0686f11d79c3c23820cfb769b76193c020d03549e',
    'monitor.py': 'cbcb41a9b36a194d8ca18655bec024863090aa373b60eb58129b898b49caeccb',
    'rate_limiter.py': '01475c94f6903576712e6fb534142642c5ad1f6452d3d92573fcb7056cc263fc',
}


def _database():
    resolve = getattr(frappe.db, '_get_current_object', None)
    return resolve() if callable(resolve) else frappe.db


def _reason(value):
    frappe.flags.shangshu_write_zone_reason = value


def _certificate(model):
    from shangshu_core.write_zone_certification import certificate_for
    return certificate_for(model)


def _evidence(model):
    try:
        raw = json.loads(model.write_zone_certification or '{}')
        actual = _certificate(model)
        nonce = raw.get('certification_id')
        if (type(raw.get('protocol')) is not int or type(raw.get('revision')) is not int
                or not isinstance(nonce, str) or len(nonce) != 32
                or any(char not in '0123456789abcdef' for char in nonce)
                or any(raw.get(key) != value for key, value in actual.items())):
            return None
        return raw
    except (AttributeError, TypeError, ValueError):
        return None


def _matches_certificate(model, expected=None):
    actual = _evidence(model)
    return actual is not None and (expected is None or actual == expected)


def _entry_safe(action_id, payload, action_version):
    from shangshu_core.action_packages import current
    from shangshu_core.action_provenance import current_action_origin, _node
    request = getattr(frappe.local, 'request', None)
    form = getattr(frappe.local, 'form_dict', {}) or {}
    if (action_id != _ACTION or action_version not in (None, _VERSION) or not isinstance(payload, dict)
            or not payload.get('object_id') or request is None or request.method != 'POST'
            or form.get('cmd') != _HTTP or form.get('execution_id') or _current.get() is not None
            or current() is not None or current_action_origin() or _node.get() is not None):
        return False
    for key in ('shangshu_domain_execution_depth', 'shangshu_call_domain', 'shangshu_action_pin',
                'shangshu_resolving_proposal', 'shangshu_action_savepoints', 'currently_saving',
                'shangshu_managed_change_batch', 'in_migrate', 'in_install', 'in_patch',
                'in_import', 'in_setup_wizard'):
        if getattr(frappe.flags, key, None):
            return False
    db = _database()
    if getattr(db, 'transaction_writes', None) != 0 or getattr(db, 'auto_commit_on_many_writes', True):
        return False
    if any(getattr(getattr(db, key, None), '_functions', (True,)) for key in
           ('before_commit', 'after_commit', 'before_rollback', 'after_rollback')):
        return False
    return True


@lru_cache(maxsize=1)
def _framework_known():
    if getattr(frappe, '__version__', None) != '15.118.0':
        return False
    root = Path(frappe.__file__).resolve().parent
    return all(hashlib.sha256((root / path).read_bytes()).hexdigest() == expected
               for path, expected in _FRAMEWORK_FILES.items())


def _installed_apps():
    """**装着的应用**名单 —— 口径必须与实际取钩子的那处一致。

    ⚠️ **2026-10-28 独立审查揪出来的（订正）**：
    钩子是从 `_load_app_hooks` 取的，那边用的是
    `frappe.get_installed_apps(_ensure_on_bench=True)`
    ⇒ **应用登记还在、但 bench 目录已经不在**的那些，**不参与钩子**。
    ⇒ 这里若用不带 `_ensure_on_bench` 的全局名单 ⇒ 期望名单会**多留一条**
    ⇒ 永远对不上 ⇒ **App S 又打不开**（正是这轮要修的那个毛病换个形式复发）。
    ⇒ 口径对齐：都用 `_ensure_on_bench=True`。
    """
    try:
        return set(frappe.get_installed_apps(_ensure_on_bench=True))
    except TypeError:
        # 老版本 Frappe 没有这个参数 ⇒ 退回全局名单（宁可保守：退粗锁）。
        try:
            return set(frappe.get_installed_apps())
        except Exception:
            return set()
    except Exception:
        return set()


def _hook_app_installed(entry):
    """这条钩子来自哪个应用；那个应用**装了吗**。"""
    return entry.split('.', 1)[0] in _installed_apps()


def _audited_list(entries):
    """只留**装着的应用**带来的钩子。

    ⚠️ **2026-10-28 修的真实缺陷（隔离站＋3850 站都实测到）**：
    这张表是「**审过的**钩子名单」——审的是「哪些钩子会挂在写路径上」。
    原来写成**死名单**：哪怕某个应用根本没装（本部署里 `shangshu_flow` 压根没装），
    名单里也留着它那一条 ⇒ 实际钩子比名单**少一条** ⇒ 判「对不上」⇒ **永远退粗锁**
    ⇒ 并行写（App S）这条路**从来没被打开过**（不是偶发，是必然）。
    ⇒ 改成：只按「**装着的应用**」算实际名单。

    ⚠️ **安全性质一点没变**：多出来的（没审过的）钩子照样让名单对不上
    ⇒ 照样退粗锁 ⇒ 共享锁照旧只对「审过的那几个钩子」放行。
    """
    return [entry for entry in entries if _hook_app_installed(entry)]


def _audited_events(events):
    """同上：文档事件按「装着的应用」算；某个事件一条都不剩就整个去掉。"""
    audited = {}
    for event, entries in events.items():
        kept = _audited_list(entries)
        if kept:
            audited[event] = kept
    return audited


def _hooks_known(doctypes):
    hooks = frappe.get_doc_hooks()
    if hooks.get('*', {}) != _audited_events(_DOC_EVENTS) or any(hooks.get(dt) for dt in doctypes):
        return False
    for key, expected in _HOOK_LISTS.items():
        if (frappe.get_hooks(key) or []) != _audited_list(expected):
            return False
    for key in ('override_doctype_class', 'has_permission', 'permission_query_conditions'):
        configured = frappe.get_hooks(key) or {}
        if not isinstance(configured, dict) or any(configured.get(dt) for dt in doctypes):
            return False
    overrides = frappe.get_hooks('override_doctype_class') or {}
    if overrides.get('User') or overrides.get('Shangshu Identity'):
        return False
    overrides = frappe.get_hooks('override_whitelisted_methods') or {}
    return isinstance(overrides, dict) and not overrides.get(_HTTP)


def _action_known():
    from shangshu_core.domains import raw_resource
    domain, resource = raw_resource('actions', _ACTION)
    return (domain is not None and domain.get('id') == 'com.shangshu.core'
        and isinstance(resource, dict)
        and resource.get('handler') == 'shangshu_core.model_records.write_records'
        and resource.get('transaction') == 'atomic_package'
        and resource.get('transaction_versions') == [_VERSION]
        and resource.get('package_actions') == []
        and not any(resource.get(key) for key in ('execution_guard', 'replay_guard', 'package_guard')))


def _engine_known(doctypes=()):
    rows = frappe.db.sql('SELECT @@tx_isolation AS isolation_level, @@autocommit AS auto_commit, '
                         'VERSION() AS version', as_dict=True)
    if (not rows or rows[0]['isolation_level'].upper().replace('_', '-') != 'REPEATABLE-READ'
            or int(rows[0]['auto_commit']) != 0 or 'MariaDB' not in rows[0]['version']):
        return False
    names = tuple('tab' + dt for dt in dict.fromkeys((*_CONFIG_TABLES, 'User',
        'Shangshu Identity', 'Shangshu Application Definition', _MODEL, *doctypes)))
    engines = frappe.db.sql('SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES '
        'WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (' + ','.join(['%s'] * len(names)) + ')',
        names, as_dict=True)
    return {row['name']: row['engine'] for row in engines} == {name: 'InnoDB' for name in names}


def _configuration_empty(current):
    # 不过滤enabled/disabled，不分析条件表达式。PRIMARY完整范围含空表gap。
    for dt in _CONFIG_TABLES:
        columns = 'name, is_standard' if dt == 'User Type' else 'name'
        query = f'SELECT {columns} FROM `tab{dt}` FORCE INDEX (PRIMARY) ORDER BY name'
        rows = frappe.db.sql(query + (' LOCK IN SHARE MODE' if current else ''), as_dict=True)
        if any(row.get('is_standard') != 1 for row in rows) if dt == 'User Type' else bool(rows):
            return False
    return True


def _configuration_snapshot_empty():
    return _configuration_empty(False)


def _lock_configuration():
    return _configuration_empty(True)


def _script_map_empty(value):
    return isinstance(value, dict) and all(not item for item in value.values())


def _cache_configuration_empty(doctypes):
    from frappe.model.workflow import get_workflow_name
    from frappe.integrations.doctype.webhook import get_all_webhooks
    from frappe.core.doctype.server_script.server_script_utils import get_server_script_map
    from frappe.automation.doctype.milestone_tracker.milestone_tracker import get_milestone_trackers
    from frappe.core.doctype.user_type.user_type import get_non_standard_user_types
    from frappe.cache_manager import get_doctype_map
    if (not _script_map_empty(get_server_script_map())
            or frappe.cache.get_value('webhooks', get_all_webhooks)
            or frappe.cache.get_value('non_standard_user_types', get_non_standard_user_types)):
        return False
    for dt in doctypes:
        # 使用Document.run_notifications原键/原生成器参数，空结果暖入同请求local.cache。
        notifications = frappe.cache.hget('notifications', dt, lambda dt=dt: frappe.get_all(
            'Notification', fields=['name', 'event', 'method'], filters={'enabled': 1, 'document_type': dt}))
        if (get_workflow_name(dt) or notifications
                or get_doctype_map('Document Naming Rule', dt,
                    filters={'document_type': dt, 'disabled': 0}, order_by='priority desc')
                or get_doctype_map('Assignment Rule', dt,
                    filters={'document_type': dt, 'disabled': 0}, order_by='priority desc')
                or get_doctype_map(doctype='Assignment Rule', name=f'due_date_rules_for_{dt}',
                    filters={'due_date_based_on': ['is', 'set'], 'document_type': dt, 'disabled': 0})
                or get_doctype_map('Energy Point Rule', dt, dict(reference_doctype=dt, enabled=1))
                or get_milestone_trackers(dt)):
            return False
    return True


def _identity_snapshot():
    user = frappe.session.user
    if not user or user == 'Guest':
        return None
    snapshot = frappe.db.sql('SELECT name, enabled, follow_created_documents FROM `tabUser` WHERE name=%s',
                            (user,), as_dict=True)
    if (len(snapshot) != 1 or not snapshot[0]['enabled'] or snapshot[0]['follow_created_documents']
            or frappe.get_cached_value('User', user, 'follow_created_documents')):
        return None
    identities = frappe.db.sql('SELECT name, user, status, enterprise_id FROM `tabShangshu Identity` '
                              'WHERE user=%s', (user,), as_dict=True)
    if len(identities) != 1 or identities[0]['status'] != 'Active':
        return None
    # 复核执行器实际复用的请求Identity缓存；上面的同快照已存在，不会顺带新建。
    from shangshu_core.identity import get_identity
    identity = get_identity()
    if not all(getattr(identity, key, None) == value for key, value in identities[0].items()):
        return None
    return {'user': snapshot[0], 'identity': identities[0]}


def _lock_identity(expected):
    user = expected['user']['name']
    users = frappe.db.sql('SELECT name, enabled, follow_created_documents FROM `tabUser` '
                         'WHERE name=%s LOCK IN SHARE MODE', (user,), as_dict=True)
    identities = frappe.db.sql('SELECT name, user, status, enterprise_id FROM `tabShangshu Identity` '
        'WHERE user=%s LOCK IN SHARE MODE', (user,), as_dict=True)
    return users == [expected['user']] and identities == [expected['identity']]


def _meta_known(doctypes):
    from frappe.model.base_document import get_controller
    from frappe.model.document import Document
    from shangshu_core.shangshu_core.doctype.shangshu_action_request.shangshu_action_request import ShangshuActionRequest
    from shangshu_core.shangshu_core.doctype.shangshu_unified_log.shangshu_unified_log import ShangshuUnifiedLog
    expected = (Document, ShangshuActionRequest, ShangshuUnifiedLog)
    for dt, cls in zip(doctypes, expected):
        if get_controller(dt) is not cls:
            return False
        meta = frappe.get_meta(dt)
        required_name = {'Shangshu Action Request': 'field:request_key', 'Shangshu Unified Log': 'field:log_no'}.get(dt)
        if required_name is not None and meta.get('autoname') != required_name:
            return False
        if any(meta.get(key) for key in ('track_changes', 'track_seen', 'track_views', 'issingle',
                                        'istable', 'is_tree', 'is_submittable', 'is_virtual')):
            return False
        if (meta.get_table_fields() or meta.get_global_search_fields()
                or any(field.fieldtype in ('Attach', 'Attach Image') for field in meta.fields)):
            return False
    return True


def _prepare(payload):
    if (getattr(frappe.conf, 'developer_mode', False) or getattr(frappe.local, 'dev_server', False)
            or getattr(frappe.local, '_recorder', None) or getattr(frappe.local, 'monitor', None)
            or not _framework_known()):
        _reason('framework_profile'); return None
    rows = frappe.db.sql(f'SELECT name, application, active_revision, physical_doctype, active_json, '
        f'enterprise_id, write_zone_certification FROM `tab{_MODEL}` WHERE name=%s',
        (payload['object_id'],), as_dict=True)
    if len(rows) != 1:
        _reason('model_missing'); return None
    model = rows[0]
    if not _matches_certificate(model):
        _reason('not_certified'); return None
    compiled = json.loads(model.active_json)
    if compiled.get('kind') != 'record' or any(f.get('type') in ('reference', 'detail') for f in compiled.get('fields', [])):
        _reason('definition_scope'); return None
    doctypes = (model.physical_doctype, 'Shangshu Action Request', 'Shangshu Unified Log')
    # 已有未知配置先走无锁预检，直接保留粗路径。不能先拿规则S再退粗，
    # NamingRule.apply等粗路径会更新规则counter，可能引入S→X升级死锁。
    for reason, probe in (('hooks', lambda: _hooks_known(doctypes)), ('action_registration', _action_known),
            ('metadata', lambda: _meta_known(doctypes)),
            ('database_mode', lambda: _engine_known(doctypes)),
            ('configuration', _configuration_snapshot_empty),
            ('cached_configuration', lambda: _cache_configuration_empty(doctypes))):
        if not probe():
            _reason(reason); return None
    identity = _identity_snapshot()
    if identity is None:
        _reason('identity'); return None
    # 从首次配置锁起只能准入或结束外事务；任何变化/普通异常都不能带S退粗。
    try:
        if not _lock_configuration() or not _lock_identity(identity):
            raise frappe.ValidationError('并行准入的配置或身份已变化，请结束事务后重新读取')
        _reason('eligible')
        return dict(object_id=model.name, application=model.application, certificate=_evidence(model),
                    physical_doctype=model.physical_doctype, user=frappe.session.user)
    except Exception as error:
        from shangshu_core.transaction_failure import mark_transaction_failed
        mark_transaction_failed(error, force=True)
        raise


def _reject(message, *, force=False):
    error = frappe.ValidationError(message)
    if force or getattr(_database(), _MARKER, None) is not None:
        from shangshu_core.transaction_failure import mark_transaction_failed
        mark_transaction_failed(error, force=True)
    raise error


@contextmanager
def action_scope(action_id, payload, action_version=None):
    if getattr(_database(), _MARKER, None) is not None:
        _reject('细锁动作已占用当前外事务，请结束该事务后再执行动作')
    candidate = None
    _reason('coarse_entry')
    if _entry_safe(action_id, payload, action_version):
        try:
            candidate = _prepare(payload)
        except Exception as error:
            from shangshu_core.transaction_failure import raise_if_transaction_failed
            raise_if_transaction_failed(error)
            _reason('admission_unavailable')
    token = _current.set(candidate)
    try:
        yield
    finally:
        _current.reset(token)


def application_lock_mode(object_id):
    candidate = _current.get()
    occupied = getattr(_database(), _MARKER, None)
    if candidate is None:
        if occupied is not None:
            _reject('当前细锁事务不能扩大写入范围')
        return 'exclusive'
    pin = getattr(frappe.flags, 'shangshu_action_pin', None) or {}
    if (object_id != candidate['object_id'] or pin.get('action_id') != _ACTION
            or pin.get('action_version') != _VERSION or frappe.session.user != candidate['user']):
        # candidate只会在配置/身份当前锁均已取得后产生；即使App S尚未取，
        # 也不能把这些新增S锁带回未审核的粗路径。
        _reject('当前细锁事务的目标、动作版本或身份已变化', force=True)
    if occupied is None:
        db = _database()
        setattr(db, _MARKER, candidate)
        def clear():
            if getattr(db, _MARKER, None) is candidate:
                delattr(db, _MARKER)
        db.after_commit.add(clear)
        db.after_rollback.add(clear)
    _reason('shared')
    return 'shared'


def assert_locked_model(model, compiled):
    candidate = getattr(_database(), _MARKER, None)
    if candidate is None:
        return
    if (model.name != candidate['object_id'] or model.application != candidate['application']
            or not _matches_certificate(model, candidate['certificate'])
            or compiled != json.loads(model.active_json)):
        _reject('对象定义或并行范围凭据已变化，请结束事务后重新读取')
