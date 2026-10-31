"""Explicit registered atomic action packages; no ambient orchestration transaction.

Only the declared action version opens a package. Nested Actions keep their own
permission/schema/version/idempotency checks and contribute evidence to one root
log. Resource compensation is scoped to this package, never a full DB rollback.
"""
import copy
from contextlib import contextmanager
from contextvars import ContextVar

import frappe

_current = ContextVar('shangshu_atomic_action_package', default=None)


def current():
    return _current.get()


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def validate_declaration(resource):
    if not isinstance(resource, dict):
        return
    mode = resource.get('transaction')
    if mode is None:
        if any(key in resource for key in ('transaction_versions', 'package_actions', 'package_guard')):
            _fail('原子包声明缺少 transaction')
        return
    if mode != 'atomic_package':
        _fail('动作事务声明不支持')
    versions = resource.get('transaction_versions')
    children = resource.get('package_actions', [])
    if not isinstance(versions, list) or not versions or any(not isinstance(v, str) or not v for v in versions):
        _fail('原子包须明确动作版本')
    if not isinstance(children, list) or any(not isinstance(v, str) or not v for v in children):
        _fail('原子包须明确允许的子动作')


@contextmanager
def call_guard():
    """Even a caught child validation/permission exception poisons the package."""
    package = current()
    try:
        yield
    except Exception as error:
        if package is not None:
            package.failure = error
        from shangshu_core.transaction_failure import raise_if_transaction_failed
        raise_if_transaction_failed(error)
        raise


def reject_migration():
    if current() is not None:
        error = frappe.ValidationError('原子包中不得执行 DDL 或独立迁移')
        current().failure = error
        raise error


def assert_log_write(kind, what_id, idempotency_key):
    """Only finish may emit the package's single action fact."""
    from shangshu_core.transaction_failure import assert_transaction_healthy
    assert_transaction_healthy()
    package = current()
    if package is None or kind != 'action':
        return
    if package.emitting_root and what_id == package.action_id and idempotency_key == package.key:
        return
    failure = frappe.ValidationError('原子包动作审计必须由根动作统一落账')
    package.failure = failure
    raise failure


def prevent_commit(message):
    """A failed rollback cannot be made safe by an outer handler catching it."""
    from shangshu_core.transaction_failure import mark_transaction_failed
    return mark_transaction_failed(RuntimeError(message), force=True)


def register_package_rollback(callback, key=None):
    """Trusted Python resource adapter hook; True only for a new registration.

    Duplicate keys and calls outside a package return False (no checkpoint needed).

    Register a checkpoint restore before changing the resource. Callbacks run in
    reverse order on package failure, including failures caught by its handler.
    """
    package = current()
    if package is None:
        return False
    if not callable(callback):
        _fail('包回滚处理器必须可调用')
    if key is not None:
        if key in package.rollback_keys:
            return False
        package.rollback_keys.add(key)
    package.rollbacks.append(callback)
    return True


class Package:
    def __init__(self, action_id, key, resource):
        self.action_id, self.key = action_id, key
        self.allowed = frozenset(resource.get('package_actions') or [])
        self.steps, self.receipts, self.requests, self.rollbacks = [], [], [], []
        self.rollback_keys = set()
        self.provenance = None
        self.root_entry = None
        self.failure = None
        self.audit = None
        self.emitting_root = False

    def assert_healthy(self):
        from shangshu_core.transaction_failure import assert_transaction_healthy
        assert_transaction_healthy()
        if self.failure is not None:
            raise self.failure

    def collect(self, entry, changes, receipt):
        self.assert_healthy()
        copied = copy.deepcopy(changes)
        keys = [row.get('idempotency_key') for row in copied if row.get('idempotency_key')]
        if len(keys) != len(set(keys)):
            _fail('批量记录的审计键重复，本包未保存')
        detail = entry['detail']
        step = dict(action_id=entry['what_id'], action_version=detail['action_version'],
            idempotency_key=entry['idempotency_key'], source=detail['executor_source'],
            record_changes=copied)
        if entry['idempotency_key'] != self.key:
            step.update(input_summary=copy.deepcopy(detail['input_summary']),
                        result_summary=copy.deepcopy(detail['result_summary']))
        self.steps.append(step)
        self.receipts.append(receipt)
        if entry['idempotency_key'] == self.key:
            self.root_entry = copy.deepcopy(entry)

    def remember_request(self, request):
        self.requests.append(request)

    def finish(self, write_log):
        self.assert_healthy()
        if self.root_entry is None:
            _fail('原子包缺少根动作审计')
        # Preserve invocation evidence and every actual before/after change. Only
        # ordinary summaries use the existing bounded/redacted summary policy.
        rows = [row for step in self.steps for row in step['record_changes']]
        change_count = sum(len((row.get('data') or {}).get('changes') or []) for row in rows)
        package = dict(version=1, steps=self.steps,
            record_count=len({(row.get('doctype'), row.get('name')) for row in rows}),
            change_count=change_count, step_change_count=change_count)
        entry = self.root_entry
        entry['detail']['package'] = package
        entry['detail']['record_changes'] = None
        # The root is one package, not arbitrarily the last affected record.
        objects = {str((row.get('data') or {}).get('object_id') or '') for row in rows}
        entry['business_object_id'] = next(iter(objects)) if len(objects) == 1 else ''
        entry['business_name'] = ''
        entry['reference_doctype'] = entry['reference_name'] = ''
        legacy = entry['detail']['legacy']
        legacy.update(business_object_id=entry['business_object_id'], business_name='',
                      reference_doctype='', reference_name='')
        # Full evidence has exactly one stored location: package.steps. Legacy
        # read adapters project it on demand, never store a second JSON copy.
        legacy['record_changes_json'] = None
        self.emitting_root = True
        try:
            log = write_log(**entry)
        finally:
            self.emitting_root = False
        self.audit = log.name
        for receipt in self.receipts:
            receipt['audit'] = self.audit
        # Child requests already hold their encrypted full results. Their audit
        # link is attached only after the root log exists, in the same transaction.
        for request in self.requests:
            request.db_set('execution_audit', self.audit, update_modified=False)


def validate_child(action_id, action):
    parent = current()
    if parent is not None and (action_id not in parent.allowed or action.effect != 'write'):
        _fail('子动作未登记为本原子包的事务内写入：' + action_id)


def assert_new_child_request(created):
    if current() is not None and not created:
        _fail('原子包子请求已单独执行；请通过原根动作查询或重试，不能拼接旧执行')


def package_enabled(action, resource, payload):
    """Validate the declaration/selector before reserving a new request."""
    validate_declaration(resource)
    enabled = (resource.get('transaction') == 'atomic_package'
               and action.action_version in resource.get('transaction_versions', []))
    guard = resource.get('package_guard')
    if enabled and guard:
        owner = str(resource.get('handler') or '').split('.', 1)[0]
        if not owner or not str(guard).startswith(owner + '.'):
            _fail('原子包守卫必须属于动作原域')
        enabled = frappe.get_attr(guard)(payload) is True
    if enabled and action.effect != 'write':
        _fail('原子包仅支持已声明的事务内写入')
    return enabled


def assert_new_version(action, resource, payload):
    """Old successful receipts may replay; old package versions cannot write anew."""
    if resource.get('transaction') != 'atomic_package' or action.action_version in resource.get('transaction_versions', []):
        return
    guard = resource.get('package_guard')
    if guard:
        owner = str(resource.get('handler') or '').split('.', 1)[0]
        if not owner or not str(guard).startswith(owner + '.'):
            _fail('原子包守卫必须属于动作原域')
        if frappe.get_attr(guard)(payload) is not True:
            return
    _fail('该原子包动作版本已更新，请使用当前版本重新确认；旧成功请求只能按原键重放')


@contextmanager
def execution_scope(action_id, key, action, resource, payload, enabled=None):
    parent = current()
    if parent is not None:
        validate_child(action_id, action)
        yield parent
        return
    if enabled is None:
        enabled = package_enabled(action, resource, payload)
    if not enabled:
        yield None
        return
    package = Package(action_id, key, resource)
    token = _current.set(package)
    try:
        yield package
        package.assert_healthy()
    except Exception as original_error:
        # These are package checkpoints, not after_rollback callbacks for the
        # whole outer transaction: earlier unrelated caller work stays intact.
        compensation_error = None
        for callback in reversed(package.rollbacks):
            try:
                callback()
            except Exception as error:
                compensation_error = compensation_error or error
        if compensation_error is not None:
            failure = prevent_commit('原子包资源回滚失败，禁止提交；请恢复资源后重试')
            if hasattr(original_error, '_ss_failed_action'):
                failure._ss_failed_action = original_error._ss_failed_action
            raise failure from compensation_error
        raise
    finally:
        _current.reset(token)
