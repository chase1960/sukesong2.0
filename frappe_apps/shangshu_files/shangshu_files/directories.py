"""域内目录：稳定引用、路径兼容和整棵子树的原子改名。"""
import frappe
from shangshu_core.public_api import business_access
from shangshu_files.business_permissions import get_list as business_get_list
from frappe.utils import get_datetime
from shangshu_files.location import FILE, normalize_directory

DOCTYPE = 'Shangshu File Directory'
ROOT = 'files-root'


def lock_tree(exclusive=False):
    # 只锁本域根记录：普通文件写共享，目录改名独占；均随外层事务释放。
    rows = frappe.db.sql('SELECT name FROM `tabShangshu File Directory` WHERE name=%s '
                         + ('FOR UPDATE' if exclusive else 'LOCK IN SHARE MODE'), (ROOT,))
    if not rows:
        frappe.throw('文件目录尚未迁移，请联系管理员', frappe.ValidationError)


def _insert(title, parent, path, name=None):
    doc = frappe.get_doc({'doctype': DOCTYPE, 'title': title, 'parent_directory': parent, 'path': path})
    return doc.insert(ignore_permissions=True, set_name=name)


def _read(name):
    rows = frappe.db.sql('SELECT * FROM `tabShangshu File Directory` WHERE name=%s LOCK IN SHARE MODE', (name,), as_dict=True)
    if not rows:
        frappe.throw('目录不存在，请刷新后重试', frappe.ValidationError)
    if not frappe.db.exists(DOCTYPE, name):
        frappe.throw('目录刚由其他操作创建，请刷新后重试；本次没有覆盖已有文件。', frappe.ValidationError)
    return frappe.get_doc({'doctype': DOCTYPE, **rows[0]})


def ensure_path(path):
    """兼容旧路径型上传；仅由已授权写操作或停写迁移调用。"""
    path = normalize_directory(path)
    parent = _read(ROOT)
    parent.check_permission('read')
    for title in path.strip('/').split('/') if path != '/' else []:
        next_path = parent.path.rstrip('/') + '/' + title
        names = frappe.db.sql('SELECT name FROM `tabShangshu File Directory` WHERE path=%s LOCK IN SHARE MODE', (next_path,))
        if names:
            parent = _read(names[0][0])
            parent.check_permission('read')
            continue
        checkpoint = 'directory_' + frappe.generate_hash(length=12)
        frappe.db.savepoint(checkpoint)
        try:
            parent = _insert(title, parent.name, next_path)
        except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
            frappe.db.rollback(save_point=checkpoint)
            # 不让 Frappe 后续 Link 校验沿用缺失目录的旧快照；由用户刷新重试整次操作。
            frappe.throw('目标目录刚由其他操作创建，请刷新后重试；本次没有覆盖已有文件。', frappe.ValidationError)
    return parent


def resolve(payload):
    if payload.get('directory_id'):
        directory = _read(payload['directory_id'])
        directory.check_permission('read')
        if 'directory' in payload and normalize_directory(payload['directory']) != directory.path:
            frappe.throw('目录已更名，请刷新后重试', frappe.ValidationError)
        return directory
    return ensure_path(payload.get('directory'))


def migrate():
    """停写迁移，不复制文件、不改文件属主或 modified；可重复运行。"""
    if not frappe.db.exists(DOCTYPE, ROOT):
        _insert('全部文件', None, '/', ROOT)
    for row in frappe.get_all(FILE, fields=['name', 'directory', 'directory_id'], limit_page_length=0):
        directory = ensure_path(row.directory)
        if row.directory_id != directory.name:
            frappe.db.set_value(FILE, row.name, 'directory_id', directory.name, update_modified=False)


def listing(_service, _payload, _context):
    manager = business_access.is_open() or 'System Manager' in frappe.get_roles()
    fields = ['name', 'title', 'parent_directory', 'path', 'modified']
    if manager:
        fields += ['access_mode', 'allowed_identities_json', 'allowed_groups_json']
    result = {'directories': business_get_list(DOCTYPE, fields=fields, order_by='path asc', limit_page_length=0),
              'can_manage': manager}
    if manager:
        from shangshu_core.public_api import list_collaboration_people
        from shangshu_files.access import _values
        for row in result['directories']:
            row['access'] = {'mode': row.pop('access_mode') or 'inherit',
                             'identities': _values(row.pop('allowed_identities_json')),
                             'groups': _values(row.pop('allowed_groups_json'))}
        # 开放试用不要求登录账号另获 Desk User；非员工账号没有组织授权编辑候选。
        people = (list_collaboration_people() if
                  frappe.db.get_value('User', frappe.session.user, 'user_type') == 'System User'
                  or not business_access.is_open() else [])
        result['access_options'] = {'version': 1, 'people': [
            {'identity_id': p['identity_id'], 'label': p['display_name'], 'group': p['group'], 'account': p['username']} for p in people],
            'groups': sorted({p['group'] for p in people if p['group']})}
    return result


def create(payload):
    _require_manager()
    parent = _read(payload.get('parent') or ROOT)
    title = _title(payload.get('title'))
    path = normalize_directory(parent.path.rstrip('/') + '/' + title)
    doc = _insert(title, parent.name, path)
    return {'directory': doc.name, 'path': doc.path, 'modified': str(doc.modified)}


def _require_manager():
    business_access.require_identity()
    if not business_access.is_open() and 'System Manager' not in frappe.get_roles():
        frappe.throw('仅系统管理员可管理目录', frappe.PermissionError)


def _title(value):
    title = str(value or '').strip()
    if not title or '/' in title or title in ('.', '..'):
        frappe.throw('请输入有效目录名，不能包含路径分隔符', frappe.ValidationError)
    normalize_directory('/' + title)
    return title


def rename(payload):
    _require_manager()
    name = payload.get('directory')
    if name == ROOT:
        frappe.throw('根目录不能重命名', frappe.ValidationError)
    doc = frappe.get_doc(DOCTYPE, name, for_update=True)
    if get_datetime(payload.get('expected_modified')) != get_datetime(doc.modified):
        frappe.throw('目录已被修改，请刷新后重试', frappe.ValidationError)
    title = _title(payload.get('title'))
    parent = _read(doc.parent_directory)
    new_path = normalize_directory(parent.path.rstrip('/') + '/' + title)
    if new_path == doc.path:
        return {'directory': doc.name, 'path': doc.path, 'modified': str(doc.modified)}
    # 树独占锁下当前读；不用 LIKE，避免目录名的 _ 被当通配符。
    rows = frappe.db.sql('SELECT name,path,parent_directory FROM `tabShangshu File Directory` FOR UPDATE', as_dict=True)
    children = {doc.name}
    while True:
        added = {r.name for r in rows if r.parent_directory in children} - children
        if not added:
            break
        children.update(added)
    changed = [(r, normalize_directory(new_path + r.path[len(doc.path):])) for r in rows if r.name in children]
    for row, path in changed:
        frappe.db.set_value(DOCTYPE, row.name, {'path': path, **({'title': title} if row.name == doc.name else {})})
        # 回收文件同样随目录移动，恢复不误回旧路径。版本和附件引用保持不变。
        frappe.db.set_value(FILE, {'directory_id': row.name}, 'directory', path, update_modified=False)
    doc.reload()
    return {'directory': doc.name, 'path': doc.path, 'modified': str(doc.modified)}
