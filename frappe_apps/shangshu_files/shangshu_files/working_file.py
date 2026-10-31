"""One mutable workbook, transaction-scoped crash recovery; not a version archive.

The resource row remains the authority for committed SHA/revision. A temporary
before-image exists only until its database transaction commits or rolls back.
After a process crash, the committed database SHA decides which bytes survive.
Never acknowledge a commit before both the replacement and DB commit succeed.
"""
import hashlib
import json
from pathlib import Path
from shangshu_core.public_api import WorkingFileTransaction


def content_revision(doc):
    # Lazy compatibility with pre-migration workbooks. No history is rewritten.
    return max(int(getattr(doc, 'content_revision', 0) or 0),
               max(0, int(getattr(doc, 'version_count', 1) or 1) - 1))


def has_working_copy(doc):
    """这份文件有没有**工作副本**（页面里改过的那一份活内容）。

    有工作副本 ⇒ **活内容是工作副本**，不是「当前上传版本」那份字节 ——
    两条血脉**不是一份内容**（`tests/test_office_review.py` 里那句话）。
    拿上传版本那份字节去改，会把用户手改的内容覆盖掉。
    """
    meta = json.loads(getattr(doc, 'sheet_meta_json', None) or '{}')
    return bool(meta.get('working_file_id'))


def _sha(content):
    return hashlib.sha256(content).hexdigest()



def save_current(doc, content):
    """All sheet writes/format/structure/undo use this, never _record_version.

    The first edit lazily isolates a private working File from immutable legacy
    snapshots/shared hash-deduplicated blobs. Every later edit reuses that File
    ID and the same path. Old upload/checkpoint records remain untouched.
    """
    import frappe
    from shangshu_files.service import DOCTYPE, MAX_FILE_BYTES, _can_write

    from shangshu_files.object_projection import system_projection_allows
    if (not _can_write(doc) and not system_projection_allows(doc)) or doc.status != 'Active':
        frappe.throw('当前无权保存此表', frappe.PermissionError)
    if not isinstance(content, bytes) or not content or len(content) > MAX_FILE_BYTES:
        frappe.throw('表格内容为空或超过保存上限', frappe.ValidationError)
    meta = json.loads(doc.sheet_meta_json or '{}')
    revision = content_revision(doc) + 1
    key = hashlib.sha256(doc.name.encode()).hexdigest()
    root = Path(frappe.get_site_path('private', 'files')).resolve()
    target = root / ('ss-working-' + key + '.xlsx')
    journal_root = root / '.ss-working-transactions'
    transactions = getattr(frappe.local, 'ss_workbook_transactions', None)
    if transactions is None:
        transactions = frappe.local.ss_workbook_transactions = {}
    if meta.get('working_file_id'):
        frappe.get_doc('File', meta['working_file_id'], for_update=True)
    txn = transactions.get(doc.name)
    if txn is None:
        txn = WorkingFileTransaction(target, journal_root, str(target))
        try:
            txn.recover(doc.current_sha256)
        except BaseException:
            txn.close()
            raise
        transactions[doc.name] = txn
        def committed():
            try:
                txn.commit()
            finally:
                transactions.pop(doc.name, None)
        def rolled_back():
            try:
                txn.rollback()
            finally:
                transactions.pop(doc.name, None)
        frappe.db.after_commit.add(committed)
        frappe.db.after_rollback.add(rolled_back)
    # Database savepoint rollback does not run Frappe's whole-transaction hooks.
    # Register the corresponding file checkpoint with this explicit core action
    # package; earlier successful caller work survives a caught package error.
    from shangshu_core.public_api import register_package_rollback
    checkpoint = {}
    def restore_package():
        if 'value' not in checkpoint:
            return  # checkpoint creation failed before any file was staged
        try:
            txn.restore_checkpoint(checkpoint['value'])
        finally:
            from shangshu_files.sheet import _invalidate_parse
            _invalidate_parse(doc.name)
    if register_package_rollback(restore_package, key=('workbook', doc.name)):
        checkpoint['value'] = txn.checkpoint()
    txn.stage(content, doc.current_sha256)
    file_url = '/private/files/' + target.name
    working_id = meta.get('working_file_id')
    if working_id:
        if doc.current_file != working_id:
            frappe.throw('当前表格存储身份不一致，未保存', frappe.ValidationError)
        file = frappe.get_doc('File', working_id, for_update=True)
        if (not file.is_private or file.file_url != file_url
                or file.attached_to_doctype != DOCTYPE or file.attached_to_name != doc.name):
            frappe.throw('当前表格存储归属不一致，未保存', frappe.PermissionError)
        file.db_set({'content_hash': 'mutable:' + hashlib.md5(content).hexdigest(), 'file_size': len(content)},
                    update_modified=False)
    else:
        # Official File copy path keeps validation/attachment ownership without
        # re-importing/deduplicating the already durable private working blob.
        file = frappe.get_doc({'doctype': 'File', 'file_name': doc.file_name,
            'file_url': file_url, 'is_private': 1, 'file_size': len(content),
            'content_hash': 'mutable:' + hashlib.md5(content).hexdigest(),
            'attached_to_doctype': DOCTYPE, 'attached_to_name': doc.name})
        file.flags.copy_from_existing_file = True
        file.insert(ignore_permissions=True)
        meta['working_file_id'] = file.name
    doc.current_file = file.name
    doc.current_sha256 = _sha(content)
    doc.current_size = len(content)
    doc.content_revision = revision
    doc.sheet_meta_json = json.dumps(meta, ensure_ascii=False)
    doc.save(ignore_permissions=True)
    return revision


def recover_current(doc):
    """Recover a crashed save before exposing file bytes. No journal = no SQL.

    Recovery takes a current resource row lock before the file lock, exactly as
    writers do. An old repeatable-read snapshot cannot choose recovery content.
    """
    import frappe
    key = hashlib.sha256(doc.name.encode()).hexdigest()
    root = Path(frappe.get_site_path('private', 'files')).resolve()
    journal_root = root / '.ss-working-transactions'
    target = root / ('ss-working-' + key + '.xlsx')
    lock_key = hashlib.sha256(str(target).encode()).hexdigest()
    if not (journal_root / (lock_key + '.pending')).exists():
        return
    if doc.name in (getattr(frappe.local, 'ss_workbook_transactions', None) or {}):
        return
    fresh = frappe.get_doc(doc.doctype, doc.name, for_update=True)
    fresh.check_permission('read')
    txn = WorkingFileTransaction(target, journal_root, str(target))
    try:
        txn.recover(fresh.current_sha256)
    finally:
        txn.close()
    doc.update(fresh.as_dict())
