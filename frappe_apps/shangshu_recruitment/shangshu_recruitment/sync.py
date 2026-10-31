import frappe

from shangshu_core.public_api import (execute_registered_action, invoke_domain_service,
                                      query_dataset, write_process_record)
from shangshu_recruitment.common import DOMAIN
from shangshu_recruitment.intake import INTAKE_DOCTYPE, MAX_AUTO_ATTEMPTS

MAILBOX_DOCTYPE = 'Shangshu Recruitment Mailbox'
SYNC_BATCH = 50
TELEMETRY_ID = 'recruitment.mailbox.sync'


def poll_mailboxes():
    """调度入口（hooks.scheduler_events，5 分钟一次）：拉信 → 登记收件 → 重试未就绪附件。

    幂等的真正防线是收件动作的幂等键 + 收件唯一索引，这里只做进程内防重入省空跑。
    每个邮箱彼此隔离：单箱失败只记 Error Log（title/消息都不含候选人数据），
    动作内部的半截写入由内核的执行器 savepoint 自动回滚，catch 后继续不会污染提交。
    """
    if getattr(frappe.flags, 'recruitment_sync_running', False):
        return
    frappe.flags.recruitment_sync_running = True
    try:
        for name in frappe.get_all(MAILBOX_DOCTYPE, filters={'enabled': 1}, pluck='name'):
            try:
                _poll_one(name)
            except Exception as error:
                frappe.log_error(title='招聘收件轮询失败',
                                 message='%s: %s' % (name, str(error)[:300]))
    finally:
        frappe.flags.recruitment_sync_running = False


def _poll_one(mailbox_name):
    """以绑定的同步账号身份执行：真正收信在 mail 域，凭据不出邮件域。"""
    mailbox = frappe.get_doc(MAILBOX_DOCTYPE, mailbox_name)
    previous_user = frappe.session.user
    frappe.set_user(mailbox.sync_user)
    try:
        execute_registered_action('mail.sync', {'mailbox_id': mailbox.mailbox_id},
                                  confirmed=True, source='scheduler',
                                  idempotency_key='recruitment:mailsync:%s:%s'
                                                   % (mailbox.mailbox_id, _run_key()))
        collected = _collect_new(mailbox.mailbox_id)
        retried = _retry_pending(mailbox.mailbox_id)
        _telemetry(mailbox, 'Succeeded', '新收件 %s 条，重试 %s 条' % (collected, retried))
    except Exception as error:
        _telemetry(mailbox, 'Failed', '%s: %s' % (type(error).__name__, str(error)[:150]))
        raise
    finally:
        frappe.set_user(previous_user)


def _collect_new(mailbox_id):
    """未登记过且带附件的来信 → 收件动作（无附件的信留给人工在邮箱里看）。

    每轮最多处理 SYNC_BATCH 封最新来信；积压靠下一轮继续消化（收件幂等兜底）。
    """
    reply = query_dataset('mail.message', {'mailbox': mailbox_id, 'scope': 'inbox',
                                           'order': 'desc'}, 1, SYNC_BATCH) or {}
    created = 0
    for row in reply.get('rows') or []:
        name = str(row.get('name') or '').strip()
        if not name or frappe.db.exists(INTAKE_DOCTYPE, {'mail_message': name}):
            continue
        if not _has_attachments(row):
            continue
        detail = invoke_domain_service('mail.detail', {'mail': name}) or {}
        mail = detail.get('mail') or {}
        attachments = [{'file': item.get('file'), 'name': item.get('name')}
                       for item in (mail.get('attachments') or []) if item.get('file')]
        if not attachments:
            continue
        execute_registered_action('recruitment.application.intake', {
            'source_type': 'mail',
            'mail_message': name,
            'mail_account': mailbox_id,
            'sender_email': mail.get('from_address') or row.get('from_address') or '',
            'subject': mail.get('subject') or row.get('subject') or '',
            'attachments': attachments,
        }, confirmed=True, source='scheduler', idempotency_key='mail:%s:%s' % (mailbox_id, name))
        created += 1
    return created


def _has_attachments(row):
    raw = str(row.get('attachment_ids_json') or '').strip()
    return raw not in ('', '[]', 'null', 'None')


def _retry_pending(mailbox_id):
    """processing 态且附件未就绪的收件自动重试；达到上限的动作内部会转 needs_manual。"""
    pending = frappe.get_all(INTAKE_DOCTYPE,
                             filters={'mail_account': mailbox_id, 'status': 'processing',
                                      'failure_code': 'RECRUITMENT_ATTACHMENT_NOT_READY',
                                      'attempts': ['<', MAX_AUTO_ATTEMPTS]},
                             pluck='name', limit_page_length=SYNC_BATCH)
    retried = 0
    for name in pending:
        try:
            execute_registered_action('recruitment.intake.retry', {'intake': name},
                                      confirmed=True, source='scheduler',
                                      idempotency_key='recruitment:retry:%s:%s' % (name, _run_key()))
            retried += 1
        except (frappe.PermissionError, frappe.ValidationError, frappe.DoesNotExistError):
            continue  # 状态已被人工改动/岗位关闭等：留下一轮再看，不中断整箱
    return retried


def _telemetry(mailbox, result, detail):
    """同步遥测走统一过程记录：只记共享箱标识与计数，不记候选人字段。"""
    try:
        write_process_record(TELEMETRY_ID, domain_id=DOMAIN,
                             business_object_id='recruitment.mailbox',
                             business_name=mailbox.mailbox_id, result=result,
                             trigger_source='scheduler', detail=detail)
    except Exception:
        # 遥测是旁路：失败只放弃本条记录，不能为它打断收件主链路。
        return


def _run_key():
    return frappe.utils.now_datetime().strftime('%Y%m%d%H%M%S')
