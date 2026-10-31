"""模型结构工程的持久门闸。此模块不缩锁、不提交、不推断并行资格。

scope_fence 由既有 DDL 的提交边界持久化；DDL 后只有同一操作核验成功
才能清除。认证由调用方完成全部核验后显式授予，结构或绑定变更只撤销。
"""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json

import frappe

MODEL = 'Shangshu Object Model'
APPLICATION = 'Shangshu Application Definition'
_OPERATION = ContextVar('shangshu_schema_operation', default=None)
_DEFINITION_FIELDS = ('revision', 'active_revision', 'draft_json', 'active_json',
                      'application', 'enterprise_id', 'physical_doctype')


def _get(model, field):
    return model.get(field) if hasattr(model, 'get') else getattr(model, field, None)


def _name(model):
    return model if isinstance(model, str) else _get(model, 'name')


def _token(token):
    if not isinstance(token, str) or not token.strip() or len(token) > 140:
        frappe.throw('结构操作必须使用有效且稳定的恢复标识', frappe.ValidationError)
    return token


def lock_model(model_or_id):
    """按既有 App X → Model X 顺序读取当前模型；不授予权限。

    ⚠️ **应用已经不在时，这一步不许炸**（2026-10-30 真站实测撞出来的内核缺口）：
       「**孤儿**受管对象」＝ 它的**应用已经被删**，而对象行还活着
       （判据跑完 → 文件回收 → 有人清了应用；对象行按审计规矩**故意留着**）。
       ⇒ 退役口第一句 `lock_model` 读应用 ⇒ **应用不在 ⇒ 当场拒**
       ⇒ 那个对象**永远退不掉**、**物理表一直占库**（实测：47 个残留里 2 个退不掉）。
       ⇒ 这里：**应用不在就跳过读它**（没什么可读的了），**模型行照锁**
       ⇒ 退役口就能把它下线 ＋ DROP 物理表。
       ⚠️ **只放宽这一处**：「还在被别的对象引用」那道闸**照旧拒**（那是有在用的）。
    """
    name = _name(model_or_id)
    hint = frappe.get_doc(MODEL, name)
    if frappe.db.exists(APPLICATION, hint.application):
        frappe.get_doc(APPLICATION, hint.application, for_update=True)
    model = frappe.get_doc(MODEL, name, for_update=True)
    if model.application != hint.application:
        frappe.throw('对象归属已变化，请重新核验', frappe.TimestampMismatchError)
    return model


def _write(model, values):
    # 仅协调字段的内部受控更新；不用整份模型保存覆盖其他定义，不改 modified。
    frappe.db.set_value(MODEL, model.name, values, update_modified=False)
    for key, value in values.items():
        setattr(model, key, value)
    return model


def assert_model_writable(model):
    """所有普通写口在取得 Model X 后调用，包括仍使用 App X 的旧路径。"""
    if _get(model, 'scope_fence'):
        frappe.throw('对象结构工程尚未完成，暂不可写入；请按原计划恢复', frappe.ValidationError)


def assert_engineering_entry():
    """直接 Python 公共工程入口也必须先拒原子包，不能等到 DDL 提交时才拒。"""
    from shangshu_core.action_packages import reject_migration
    reject_migration()


def assert_reference_targets(compiled, *, source=None, token=None):
    """结构准备/DDL/激活分别锁后重核引用，不能沿旧 RR 快照启用死链。"""
    targets = sorted({field['target'] for field in compiled.get('fields', [])
                      if field.get('type') in ('reference', 'detail') and field.get('target')})
    for name in targets:
        target = lock_model(name)
        if target.application != compiled.get('owner') or not target.active_revision:
            frappe.throw('引用对象已退役或不属于当前应用，不能激活定义', frappe.ValidationError)
        if not (name == source and token and target.get('scope_fence') == token):
            assert_model_writable(target)
        pinned = compiled.get('reference_revisions', {}).get(name)
        if pinned is not None and target.active_revision != pinned:
            frappe.throw('明细对象修订已变化，请重新核验定义', frappe.TimestampMismatchError)


def require_maintenance_window():
    """跨对象工程仅在排空后的维护/migrate 入口执行，不在业务动作中开放。

    运维仍须停止并排空 HTTP、队列和调度；维护配置不替代排空证明。
    """
    flags = getattr(frappe, 'flags', None)
    conf = getattr(frappe, 'conf', None)
    if (getattr(flags, 'shangshu_domain_execution_depth', 0)
            or not (getattr(flags, 'in_migrate', False) or getattr(conf, 'maintenance_mode', False))):
        frappe.throw('应用整域退役及全量结构工程只允许在排空后的维护窗口执行', frappe.ValidationError)


def revoke_certification(model_or_id):
    """当前模型锁内撤销资格；不清结构门闸，不自动提交。"""
    model = lock_model(model_or_id)
    if _get(model, 'write_zone_certification'):
        _write(model, {'write_zone_certification': ''})
    if not isinstance(model_or_id, str):
        model_or_id.write_zone_certification = ''
    return model


def set_certification(model_or_id, certificate):
    """仅供内核认证工程口：调用方须已核验绑定、配置及保存执行面。

    这是可信 Python 内部接口，不注册为通用对象字段或 HTTP patch 能力。
    """
    if not isinstance(certificate, dict) or not certificate:
        frappe.throw('范围认证必须提供完整核验依据', frappe.ValidationError)
    value = json.dumps(certificate, ensure_ascii=False, sort_keys=True,
                       separators=(',', ':'), allow_nan=False)
    model = lock_model(model_or_id)
    assert_model_writable(model)
    return _write(model, {'write_zone_certification': value})


def begin_schema_change(model_or_id, token):
    """排空在途写后登记门闸；同 token 可续作，其他操作不得覆盖。"""
    token = _token(token)
    model = lock_model(model_or_id)
    current = _get(model, 'scope_fence')
    if current and current != token:
        frappe.throw('对象已有未完成结构工程，必须先按原恢复标识处理', frappe.TimestampMismatchError)
    return _write(model, {'scope_fence': token, 'write_zone_certification': ''})


def recover_schema_change(model_or_id, token):
    """只认已存在的相同 token；恢复本身不清门闸。"""
    model = lock_model(model_or_id)
    if _get(model, 'scope_fence') != _token(token):
        frappe.throw('结构恢复标识与当前工程不一致', frappe.TimestampMismatchError)
    return model


def finish_schema_change(model_or_id, token, verify):
    """完整工程及回执核验成功后清门闸；随后不得再执行 DDL。

    本函数不提交。外层原提交边界前仍持 Model X；回滚会恢复耐久门闸。
    """
    model = recover_schema_change(model_or_id, token)
    if not callable(verify) or verify(model) is not True:
        frappe.throw('结构工程尚未通过完整核验，保留恢复门闸', frappe.ValidationError)
    return _write(model, {'scope_fence': '', 'write_zone_certification': ''})


@contextmanager
def schema_operation(object_id, token):
    """仅结构工程允许在自己持有的门闸内更新定义；嵌套退出恢复。"""
    state = _OPERATION.set((str(object_id), _token(token)))
    try:
        yield
    finally:
        _OPERATION.reset(state)


def validate_model_update(doc):
    """普通模型保存不得改协调字段；任何定义重写撤销旧认证。"""
    before = doc.get_doc_before_save()
    for key in ('scope_fence', 'write_zone_certification'):
        if (_get(doc, key) or '') != ((_get(before, key) or '') if before else ''):
            frappe.throw('结构门闸和范围认证只能由内核工程入口维护', frappe.PermissionError)
    changed = before and any(_get(doc, key) != _get(before, key) for key in _DEFINITION_FIELDS)
    if changed:
        fence = _get(before, 'scope_fence')
        if fence and _OPERATION.get() != (str(doc.name), fence):
            assert_model_writable(before)
        doc.write_zone_certification = ''


@contextmanager
def schema_lock(object_id):
    """复用原 ss_schema 名字；命名锁跨 DDL commit，异常不清持久门闸。"""
    canonical = json.dumps(object_id, sort_keys=True, separators=(',', ':'), allow_nan=False)
    name = 'ss_schema_' + hashlib.sha256(canonical.encode()).hexdigest()[:48]
    if not frappe.db.sql('SELECT GET_LOCK(%s,0)', (name,))[0][0]:
        frappe.throw('对象结构工程正在执行，请稍后按原计划重试', frappe.ValidationError)
    original_error = None
    try:
        yield
    except BaseException as error:
        original_error = error
        raise
    finally:
        try:
            frappe.db.sql('SELECT RELEASE_LOCK(%s)', (name,))
        except Exception as release_error:
            if original_error is not None:
                # 失联时 RELEASE 也可能失败；保留原始工程错误及驱动异常链。
                raise original_error from release_error
            raise
