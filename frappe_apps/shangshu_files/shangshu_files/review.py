from shangshu_files.working_file import content_revision
"""整份文件审核。文件域只存关联键；正式业务值经公共对象动作写入。"""
import hashlib
import json

import frappe
from frappe.utils import get_datetime
from shangshu_core.public_api import get_object_record, execute_registered_action
from shangshu_files.service import DOCTYPE, _writable, _safe_name, _normalize_tags, _check_location
from shangshu_files.domain import file_detail


def links(doc):
    raw = doc.get('relations_json') or []
    return json.loads(raw) if isinstance(raw, str) else raw


def read(_service, payload, _context):
    doc = frappe.get_doc(DOCTYPE, payload['file'])
    doc.check_permission('read')
    relations, unavailable = [], 0
    for ref in links(doc):
        try:
            target = get_object_record(ref['object_id'], ref['name'])
            relations.append({**ref, **target})
        except (frappe.PermissionError, frappe.DoesNotExistError, frappe.ValidationError):
            unavailable += 1  # 不回传撤权记录的编号、名称或字段。
    return {'file': file_detail(doc), 'relations': relations, 'unavailable': unavailable,
            'can_review': file_detail(doc)['can_edit'] and not unavailable}


def save(payload, context):
    doc = _writable(payload['file'])
    if doc.status != 'Active':
        frappe.throw('先恢复文件再审核', frappe.ValidationError)
    if get_datetime(doc.modified) != get_datetime(payload['expected_modified']) or content_revision(doc) != payload['expected_version']:
        frappe.throw('文件或原件版本已变化，请重新打开核对；本次未保存', frappe.TimestampMismatchError)
    # 无权读取的既有关联不能被整个表单静默丢弃；由仍有权限者处理。
    for ref in links(doc):
        get_object_record(ref['object_id'], ref['name'])
    refs = payload['relations']
    seen = set()
    for ref in sorted(refs, key=lambda r: (r['object_id'], r['name'])):
        identity = (ref['object_id'], ref['name'])
        if identity in seen:
            frappe.throw('同一记录不能重复关联', frappe.ValidationError)
        seen.add(identity)
        target = get_object_record(*identity)
        obj, record = target['object'], target['record']
        if obj.get('source') != 'managed':
            frappe.throw('该对象暂不支持通用字段审核，请使用其业务办理入口', frappe.ValidationError)
        if obj['revision'] != ref['expected_revision'] or str(record['modified']) != ref['expected_modified']:
            frappe.throw('关联记录已变化，请重新核对', frappe.TimestampMismatchError)
        if ref['values']:
            if len(ref['values']) > 100:
                frappe.throw('单份记录最多采用100个字段', frappe.ValidationError)
            key = hashlib.sha256((context['idempotency_key'] + '\n' + '\n'.join(identity)).encode()).hexdigest()
            execute_registered_action('platform.object.update', ref, True, 'file-review-' + key)
    if 'file_name' in payload:
        doc.file_name = _safe_name(payload['file_name'])
    if 'tags' in payload:
        doc.tags_json = json.dumps(_normalize_tags(payload['tags']), ensure_ascii=False)
    if 'note' in payload:
        doc.note = payload['note']
    doc.relations_json = json.dumps([{'object_id': r['object_id'], 'name': r['name']} for r in refs])
    doc.reviewed_version = payload['expected_version']
    _check_location(doc)
    previous = frappe.flags.shangshu_file_review_write
    try:
        frappe.flags.shangshu_file_review_write = True
        doc.save(ignore_permissions=True)
    finally:
        frappe.flags.shangshu_file_review_write = previous
    event = _publish_review_completed(doc, refs, payload, context)
    return {'file': doc.name, 'record': file_detail(doc), 'relation_count': len(refs),
            'event': event}


def _publish_review_completed(doc, refs, payload, context=None):
    """发「文件审核完成」事件（**失败不拦审核**，但要看得见）。

    为什么要发：公共审核入口以前是**哑的** —— 员工用公共审核能力完成，
    自动化不知道「刚才发生了什么」，这条接缝就断在这儿。
    发的只是**事实**（哪份文件、采用了哪些记录、谁做的、什么时候、哪一次操作），
    **不表达「要发邮件」**。

    幂等：键＝文件 ＋ 原件版本 ⇒ 同一版本重复保存**只发一次**（重试不会重复通报）。
    """
    from shangshu_core.public_api import publish_event
    from shangshu_files.domain import FILE_REVIEW_COMPLETED_EVENT
    from shangshu_files.events import (build_review_completed_payload,
                                       review_completed_idempotency_key)

    context = context or {}
    body = build_review_completed_payload(
        doc.name, payload.get('expected_version'), refs,
        operator=str(context.get('user_name') or ''),
        occurred_at=str(doc.modified or ''),
        trace_id=str(context.get('idempotency_key') or ''))
    try:
        publish_event(FILE_REVIEW_COMPLETED_EVENT, body,
                      review_completed_idempotency_key(doc.name, body['file_version']))
        return {'published': True, 'event_id': FILE_REVIEW_COMPLETED_EVENT,
                'adopted': len(body['adopted'])}
    except Exception as error:  # noqa: BLE001 —— 通报失败**不拦**审核结论
        # 但必须**看得见**：审核已经落库，事件没发出去要能查、能补发。
        frappe.logger('shangshu_files').error('文件审核已保存但事件没发出去：%s' % error)
        return {'published': False, 'event_id': FILE_REVIEW_COMPLETED_EVENT,
                'adopted': len(body['adopted']), 'error': str(error)[:300]}
