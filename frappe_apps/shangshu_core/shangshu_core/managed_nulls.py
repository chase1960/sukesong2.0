"""受管可空数字/布尔值的物理适配，NULL 与 0/False 是不同事实。

Frappe v15 的 Int/Float/Check 默认 NOT NULL 且序列化 None 为 0。
DDL 只在对象定义阶段或显式工程迁移执行；日常写仅检查并保存真实 NULL。
"""
from contextlib import contextmanager
import hashlib
import json
import re

import frappe
from shangshu_core import write_zone_schema


NUMERIC_TYPES = {'integer': 'Int', 'decimal': 'Float', 'boolean': 'Check'}


def _columns(compiled):
    return [(field, column) for field, column in
            zip(compiled['fields'], compiled['doctype']['fields'])
            if field['type'] in NUMERIC_TYPES and not field.get('required')]


def _quote(name):
    return '`' + str(name).replace('`', '``') + '`'


def _schema(doctype):
    if not str(doctype).startswith('SSM '):
        frappe.throw('空值适配只支持受管物理表', frappe.ValidationError)
    return {row['Field']: row for row in frappe.db.sql(
        'SHOW COLUMNS FROM ' + _quote('tab' + doctype), as_dict=True)}


def _clear_write_schema_cache():
    frappe.local.shangshu_nullable_write_schema = None


def _write_schema(doctype):
    """同一请求/事务复用元信息；提交、回滚、DDL 后不复用旧结构证明。"""
    cache = getattr(frappe.local, 'shangshu_nullable_write_schema', None)
    if cache is None:
        cache = {}
        frappe.local.shangshu_nullable_write_schema = cache
        frappe.db.after_commit.add(_clear_write_schema_cache)
        frappe.db.after_rollback.add(_clear_write_schema_cache)
    if doctype not in cache:
        cache[doctype] = _schema(doctype)
    return cache[doctype]


def _ddl(compiled, actual):
    parts = []
    for field, column in _columns(compiled):
        row = actual.get(column['fieldname'])
        if not row:
            frappe.throw('受管空值字段尚未建好：' + field['label'], frappe.ValidationError)
        # 类型以真实列为准，保留长度/精度；只接受已经由模型生成的数值类型。
        sql_type = row['Type']
        if not re.fullmatch(r'(?:decimal\(\d+,\d+\)|(?:tinyint|smallint|mediumint|int|bigint)(?:\(\d+\))?)', sql_type):
            frappe.throw('受管数值列类型与定义不符：' + field['label'], frappe.ValidationError)
        if row['Null'] != 'YES' or row['Default'] not in (None, 'NULL'):
            parts.append('MODIFY COLUMN %s %s NULL DEFAULT NULL' %
                         (_quote(column['fieldname']), sql_type))
    return ('ALTER TABLE %s %s' % (_quote('tab' + compiled['doctype']['name']), ', '.join(parts))) if parts else None


def apply_schema(compiled):
    """仅供 model_changes 既有 DDL 阶段调用；不改任何行值。"""
    if not _columns(compiled):
        return
    _clear_write_schema_cache()
    statement = _ddl(compiled, _schema(compiled['doctype']['name']))
    if statement:
        frappe.db.sql_ddl(statement)
    _clear_write_schema_cache()
    actual = _schema(compiled['doctype']['name'])
    if _ddl(compiled, actual):
        frappe.throw('受管可空字段的物理迁移未完成', frappe.ValidationError)


def add_nullable_columns(compiled, context):
    """续建模先以 NULL 创建新列，避免原生 ADD DEFAULT 0 给历史行制造值。

    仅供已持有模型结构锁的 DDL 阶段调用；随后仍由原生 DocType 同步元数据。
    已存在列一字不改，因此不猜测历史零值，不承担类型转换。
    """
    from frappe.database.schema import get_definition
    actual = _schema(compiled['doctype']['name'])
    clauses = []
    for _, column in _columns(compiled):
        if column['fieldname'] in actual:
            continue
        native_type = get_definition(column['fieldtype'], precision=column.get('precision'),
                                     length=column.get('length'))
        if not native_type:
            frappe.throw('受管数值列无法生成物理类型', frappe.ValidationError)
        clauses.append('ADD COLUMN %s %s NULL DEFAULT NULL' %
                       (_quote(column['fieldname']), native_type))
    if clauses:
        # sql_ddl 本身会先提交；标记必须覆盖后续 DDL 抛错的恢复路径。
        frappe.db.commit()
        context['durable'] = True
        _clear_write_schema_cache()
        frappe.db.sql_ddl('ALTER TABLE %s %s' %
                         (_quote('tab' + compiled['doctype']['name']), ', '.join(clauses)))
        _clear_write_schema_cache()


def _engineering_model(object_id):
    from shangshu_core.identity import get_identity
    identity = get_identity()
    if 'System Manager' not in frappe.get_roles():
        frappe.throw('空值物理迁移仅供管理员工程入口使用', frappe.PermissionError)
    model = frappe.get_doc('Shangshu Object Model', object_id)
    if model.enterprise_id != identity.enterprise_id or not model.active_revision:
        frappe.throw('受管对象不在当前企业或尚未生效', frappe.PermissionError)
    return model, json.loads(model.active_json)


def preview_migration(object_id):
    """显式指定一张受管表：返回 DDL 与历史值计数，不猜历史 0 是否为空。"""
    model, compiled = _engineering_model(object_id)
    actual = _schema(model.physical_doctype)
    counts = {}
    for field, column in _columns(compiled):
        name = _quote(column['fieldname'])
        count = frappe.db.sql('SELECT COUNT(*) AS rows_total, '
            'COALESCE(SUM(%s IS NULL),0) AS null_count, '
            'COALESCE(SUM(%s=0),0) AS zero_count FROM %s' %
            (name, name, _quote('tab' + model.physical_doctype)), as_dict=True)[0]
        counts[field['id']] = dict(count)
    statement = _ddl(compiled, actual)
    snapshot = {'object_id': model.name, 'revision': model.active_revision,
                'columns': [dict(actual[column['fieldname']]) for _, column in _columns(compiled)]}
    digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True, default=str).encode()).hexdigest()
    return {**snapshot, 'plan_hash': digest, 'ddl': statement, 'historical_counts': counts,
            'data_conversion': False, 'note': '仅使列允许 NULL；历史 0/False 原样保留，无法据此推断旧空值。'}


def execute_migration(object_id, expected_plan_hash, confirmed=False):
    """独立工程事务，不从业务动作或启动钩子自动执行。"""
    write_zone_schema.assert_engineering_entry()
    if not confirmed:
        frappe.throw('请先检查空值迁移预览并明确确认', frappe.ValidationError)
    if frappe.db.transaction_writes or getattr(frappe.flags, 'shangshu_domain_execution_depth', 0):
        frappe.throw('空值迁移必须在没有业务写入的独立工程事务执行', frappe.ValidationError)
    model, _ = _engineering_model(object_id)
    token = 'nullable:' + hashlib.sha256(json.dumps(
        [object_id, expected_plan_hash], separators=(',', ':')).encode()).hexdigest()
    with write_zone_schema.schema_lock(model.name), write_zone_schema.schema_operation(model.name, token):
        # 显式工程入口已排除未提交业务写；刷新只读快照后再取锁内的当前定义。
        frappe.db.commit()
        model = write_zone_schema.lock_model(object_id)
        compiled = json.loads(model.active_json)
        recovering = bool(model.get('scope_fence'))
        if recovering:
            write_zone_schema.recover_schema_change(model, token)
        plan = preview_migration(object_id)
        # DDL 可能已改变物理列，因此恢复认耐久的原 token；不允许换计划接管。
        if not recovering and plan['plan_hash'] != expected_plan_hash:
            frappe.throw('对象定义或物理列已变化，请重新预览', frappe.TimestampMismatchError)
        write_zone_schema.begin_schema_change(model, token)
        try:
            apply_schema(compiled)
            from shangshu_core.unified_log import write_log
            from shangshu_core.identity import get_identity
            receipt = write_log('action', 'platform.object.nullable_migrate',
                actor_user=frappe.session.user, actor_identity=get_identity().name,
                result='Succeeded', trigger_source='user',
                detail={'object_id': object_id, 'revision': model.active_revision,
                      'plan_hash': expected_plan_hash, 'ddl': plan['ddl'], 'data_conversion': False})
            write_zone_schema.finish_schema_change(model, token,
                lambda current: current.active_revision == model.active_revision
                    and not _ddl(compiled, _schema(current.physical_doctype)))
            frappe.db.commit()
        except Exception as error:
            # MariaDB DDL 已独立提交，回滚只能撤销随后未完成的审计写入。
            frappe.db.rollback()
            frappe.throw('空值迁移未取得完整回执；DDL 可能已生效，请重新预览对象 %s '
                         '并核验后再执行（原计划 %s）。原错误：%s' %
                         (object_id, expected_plan_hash, error), frappe.ValidationError)
        return {'object_id': object_id, 'changed': bool(plan['ddl']), 'audit': receipt.name,
                'data_conversion': False}


@contextmanager
def preserve_nulls(doc, compiled):
    """在受管保存的校验之后、原生序列化之前保留 NULL；从不先写 0 再修补。

    只临时适配当前受管文档的方法，不改 Frappe 类/全局行为。
    原生权限、validate、版本、数据库唯一约束与 on_update 仍正常执行。
    """
    restore = []
    documents = []
    def replace_method(current, name, method):
        restore.append((current, name, current.__dict__.get(name)))
        setattr(current, name, method)

    def check_nulls(current, names):
        if names:
            actual = _write_schema(current.doctype)
            if any(actual.get(name, {}).get('Null') != 'YES' for name in names):
                frappe.throw('该受管表尚未完成可空数值迁移，清空操作未保存；请由 FDE 预览并执行显式迁移',
                             frappe.ValidationError)

    def prepare(current, schema):
        names = [column['fieldname'] for _, column in _columns(schema)]
        if names:
            documents.append((current, names))
            check_nulls(current, [name for name in names if current.get(name) is None])
            original = current.get_valid_dict
            def nullable_dict(*args, **kwargs):
                # 取序列化当时的值，保留 validate/before_save 明确生成的值。
                nulls = [name for name in names if current.get(name) is None]
                check_nulls(current, nulls)
                values = original(*args, **kwargs)
                ignore_nulls = kwargs.get('ignore_nulls', args[2] if len(args) > 2 else False)
                for name in nulls:
                    if ignore_nulls:
                        values.pop(name, None)
                    else:
                        values[name] = None
                return values
            replace_method(current, 'get_valid_dict', nullable_dict)
        from shangshu_core.model_records import _references
        refs = _references(schema)
        for field, column in zip(schema['fields'], schema['doctype']['fields']):
            if field['type'] == 'detail':
                for child in current.get(column['fieldname']) or []:
                    prepare(child, refs[field['target']])
    try:
        prepare(doc, compiled)
        original_defaults = doc._set_defaults
        def nullable_defaults(*args, **kwargs):
            # 原生 _set_defaults 在业务钩子之前填隐式 0；只撤销这一步，
            # 不在保存结束后覆盖业务钩子输出，也不改原生类或其他文档。
            empty = [(current, [name for name in names if current.get(name) is None])
                     for current, names in documents]
            result = original_defaults(*args, **kwargs)
            for current, names in empty:
                for name in names:
                    current.set(name, None)
            return result
        replace_method(doc, '_set_defaults', nullable_defaults)
        yield
    finally:
        for current, name, previous in reversed(restore):
            if previous is None:
                current.__dict__.pop(name, None)
            else:
                setattr(current, name, previous)
