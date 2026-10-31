"""**邮件域往统一日志库写过程记录**（§8 第 10／11 项）。

**这里写的是三段事实**（§8 第 11 项：草稿建／确认／发）——
`mail.draft.saved`（草稿建）／`mail.review.confirmed`（确认）／
`mail.send.result`（发）⇒ **三个动作标识互不相同**（撞了就分不开哪段出的事）。

**为什么邮件域也要写**：邮件域的操作（存草稿、发出、标读）同样是「谁在什么时候
动了什么」的一部分 ⇒ 统一日志库是**唯一事实** ⇒ 邮件域的过程记录**进同一张表**，
**不另开日志表**（契约 `contracts/unified-log-v1.json` 的 `hard_rules`）。

**域只许走公开口**：域按规矩**只能依赖 `shangshu_core.public_api`** ⇒
这里 import 的是 `public_api`，**不是**内核内部模块
（`CORE_PRIVATE_IMPORT` 那道闸盯着这件事）。

**写的是什么**：**过程痕迹**，不是业务值 ——
「这封信存过了、谁存的、跟哪个案件有关」记在日志里；
信的**当前内容**（主题、正文、收件人）住在受管记录（邮件那一行）里，
**不抄进日志**（同一个值只存一处 —— 契约 `not_carries`）。
"""
from shangshu_core.public_api import declare_process_log_fields, write_process_record
import json

#: 本域的域 id（与 `shangshu-plugin.yml` 里的 `id` 一致）。
DOMAIN_ID = 'com.shangshu.mail'

#: 本域的**受管对象** id（进程记录要挂在它下面 ⇒ 才能「按受管记录取日志」）。
OBJECT_ID = 'mail.message'

#: **三段事实各自的动作标识**（§8 第 11 项：草稿建／确认／发）——
#: 日志库里靠它认「这一行是哪一段」⇒ **三个互不相同**（撞了就分不开哪段出的事）。
WHAT_DRAFT_SAVED = 'mail.draft.saved'
WHAT_REVIEW_CONFIRMED = 'mail.review.confirmed'
WHAT_SEND_RESULT = 'mail.send.result'

#: 发信结果（`transport` 的口径）→ 统一日志的 `result` 枚举。
#: 「部分被拒」记成 `Rejected`（不是全成）⇒ 那一档原话另记在 `detail.status` 里。
SEND_RESULTS = {'Sent': 'Succeeded', 'Partial': 'Rejected',
                'Failed': 'Failed', 'Unknown': 'Unknown'}

#: 本域的**专属字段**（落在**本域自己那张扩展表**里；本域被拔掉 ⇒ 这张表随之拔掉）。
LOG_FIELDS = [
    {'name': 'case_ref', 'label': '关联案件', 'type': 'Data'},
    {'name': 'message_ref', 'label': '邮件编号', 'type': 'Data'},
]


def declare_log_fields():
    """声明本域的过程记录专属字段（**建表**；只在装域／迁移时跑一次，幂等）。"""
    return declare_process_log_fields(DOMAIN_ID, LOG_FIELDS)


def record_draft_saved(doc, source='user', result='Succeeded', is_new=False):
    """**记一条「草稿存好了」的过程记录**。

    - `business_object_id`＝`mail.message`（**受管对象** id）、
      `business_name`＝邮件记录编号（**受管记录名**）——
      与「按受管记录取日志」**同一套口径**（内核那个读口就是按这两列取的）。
    - 专属字段：`case_ref`（这封信跟哪个案件有关）＋ `message_ref`（邮件编号）。
    - **不抄业务值**：主题／正文／收件人**不进日志**（它们住在受管记录里）。
    """
    return write_process_record(
        WHAT_DRAFT_SAVED,
        domain_id=DOMAIN_ID,
        business_object_id=OBJECT_ID,
        business_name=str(doc.get('name') or ''),
        result=result,
        trigger_source=source or 'unknown',
        detail={'operation': 'mail.save_draft', 'is_new': bool(is_new)},
        extension_values={
            'case_ref': str(doc.get('case_ref') or ''),
            'message_ref': str(doc.get('name') or ''),
        },
    )


def record_review_confirmed(mail_name, source='user', units=None, case_ref=''):
    """**记一条「这封草稿的候选值被确认采纳了」的过程记录**（§8 第 11 项的「确认」）。

    - 动作标识 `mail.review.confirmed`（**与草稿建、发那两条各不相同**）。
    - `business_name`＝**那封邮件的编号** ⇒ 这条记录挂在邮件这一行上
      ⇒「按这封信取日志」能一次取齐**草稿建／确认／发**三段。
    - `units`＝**这一轮确认了哪几项**（只记字段 id，**不记值**）⇒
      看得出这一轮是整单确认还是逐项审核。
    - **不抄业务值**：主题／正文／收件人**不进日志**（它们住在受管记录里）。
    """
    return write_process_record(
        WHAT_REVIEW_CONFIRMED,
        domain_id=DOMAIN_ID,
        business_object_id=OBJECT_ID,
        business_name=str(mail_name or ''),
        result='Succeeded',
        trigger_source=source or 'unknown',
        detail={'operation': 'mail.review.confirm',
                'units': [str(item) for item in (units or [])]},
        extension_values={
            'case_ref': str(case_ref or ''),
            'message_ref': str(mail_name or ''),
        },
    )


def _json_list(value):
    """受管记录里那几个 JSON 列（`to_json`／`cc_json`／`rejected_json`）⇒ 列表。"""
    if isinstance(value, list):
        return list(value)
    try:
        parsed = json.loads(value or '[]')
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def record_send_result(doc, status='', error='', source='user'):
    """**记一条「这封信发出去的结果」的过程记录**（§8 第 11 项的「发」）。

    - 动作标识 `mail.send.result`（**与草稿建、确认那两条各不相同**）。
    - `result` 用统一日志的枚举（`Sent`→`Succeeded`、`Partial`→`Rejected`…），
      细的那一档留在 `detail.status` 里 ⇒ 既看得出成败、也看得出原话。
    - **不抄收件人地址**：地址住在受管记录里（同一个值只存一处）⇒
      日志只记「发了几个人、几个被拒、失败原因」。
    """
    recipients = _json_list(doc.get('to_json')) + _json_list(doc.get('cc_json'))
    rejected = _json_list(doc.get('rejected_json'))
    return write_process_record(
        WHAT_SEND_RESULT,
        domain_id=DOMAIN_ID,
        business_object_id=OBJECT_ID,
        business_name=str(doc.get('name') or ''),
        result=SEND_RESULTS.get(str(status or ''), 'Unknown'),
        trigger_source=source or 'unknown',
        detail={'operation': 'mail.send',
                'status': str(status or ''),
                'error': str(error or ''),
                'recipient_count': len(recipients),
                'rejected_count': len(rejected)},
        extension_values={
            'case_ref': str(doc.get('case_ref') or ''),
            'message_ref': str(doc.get('name') or ''),
        },
    )
