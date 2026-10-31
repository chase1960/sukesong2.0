"""文件域的**公共事件载荷**（纯函数层：一个 `import frappe` 都没有 ⇒ 没有站点也能单测）。

**这一层只说明「刚才发生了什么」** —— 不说「接下来要做什么」：
· 「审核完了」**不等于**「要发邮件」；
· 载荷里**只有事实**：哪份文件、什么版本、采用了哪些记录的哪些字段、谁做的、什么时候、哪一次操作；
· **不许**出现「要发邮件／该结案／要通知客户」这类结论
  （`FORBIDDEN_CONCLUSIONS` 就是判据钉住的那份清单）。

**为什么单独一个模块**：载荷形状与「不许写什么」是**契约**，
放在纯函数层才能在没有站点的环境里判（判据直接 import 它）。
"""

import hashlib
import json

# 事件类型名（登记处在 `domain.FILE_REVIEW_COMPLETED_EVENT`；这里只作载荷层的同名字面量）。
REVIEW_COMPLETED_EVENT = 'files.review.completed'

# 成员清单事件（**文件域声明**）：「这个包收了哪些成员」。
# 声明者是**文件域**（长期存在的公共件）—— 事件由声明者的生死挂着
# （内核 `publish_event` 对声明者做 `assert_domain_enabled`）⇒ 业务域停用时事件声明留着。
PACKAGE_STORED_EVENT = 'files.package.stored'

# 载荷里**不许出现**的结论性说法 —— 「审核完了」不等于「要发邮件」。
# 判据：载荷里出现这些词就红（公共模块只说明事实，不下业务结论）。
FORBIDDEN_CONCLUSIONS = (
    '要发邮件', '要发信', '发邮件', '要通知', '通知客户',
    '该结案', '结案', '要建稿', '要写回', '要投影',
)


def build_review_completed_payload(file_name, file_version, relations,
                                   operator='', occurred_at='', trace_id=''):
    """「本次审核已完成」这条通知的**载荷**（只有事实）。

    `relations` ＝ 审核时采用的关联记录（每条：`object_id` / `name` / `values`）。
    `values` 只取**字段名**（采用了哪些字段），**不带值** ——
    值已经写进受管记录了，事件里再抄一遍就是多一份可能过期的副本。
    """
    adopted = []
    for ref in relations or []:
        ref = ref or {}
        values = ref.get('values') or {}
        if not values:
            # **没采用任何字段的关联不算「采用」**（只是挂了个关系）——
            # 载荷说的是「采用了哪些记录的哪些字段」，不是「挂了哪些记录」。
            continue
        adopted.append({'object_id': str(ref.get('object_id') or ''),
                        'name': str(ref.get('name') or ''),
                        'fields': sorted(str(key) for key in values)})
    payload = {'file': str(file_name or ''),
               'adopted': adopted,
               'file_version': str(file_version or '')}
    if operator:
        payload['operator'] = str(operator)
    if occurred_at:
        payload['occurred_at'] = str(occurred_at)
    if trace_id:
        payload['trace_id'] = str(trace_id)
    return payload


def review_completed_idempotency_key(file_name, file_version):
    """这条通知的**幂等键**（内核用它判「同一件事」）。

    同一份文件的**同一版本** ⇒ 同一把键 ⇒ 重复保存/重试**只发一次**
    （下游不会把同一件审核处理两遍）。
    """
    return 'files:review-completed:%s:%s' % (str(file_name or ''), str(file_version or ''))


def content_fingerprint(payload):
    """载荷的**内容指纹**（下游按它去重：同一份文件 ＋ 同一批结论 ⇒ 同一个指纹）。"""
    body = json.dumps(payload or {}, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(body.encode('utf-8')).hexdigest()[:16]


def build_package_stored_payload(container_sha256, members):
    """「这个包收了哪些**成员**」这条通知的**载荷**（只有事实）。

    · `container_sha256` ＝ 原包摘要 —— **每个成员靠它溯源到原包**；
    · `members[]` ＝ 解出来的成员（list.xml ＋ 正文 ＋ 附件）；
      **原包不在里面**（原包只作备份与血缘凭证，业务域不取它）；
    · **不许有结论**（「要不要处理」「是不是通知书」是业务域的判断，不是这里的事）。

    载荷形状与 Host 域纯计算层 `packages.member_event_payload()` 一致 ——
    两边各留一份是**有意的**：域与域之间只走公开 Action/Service/Event，
    文件域**不许** import Host 域的实现（`scripts/check-domain-boundary.mjs` 也这么判）。

    ⚠️ **2026-10-22（第 2 步）：每个成员多带一个 `file`（它在文件中心的编号）**。
    为什么加：业务域（example）拿到这份清单后要**认领这些件**（正文是哪一件、附件是哪几件），
    而**原包也带同一个血缘**（`container_sha256`）⇒ 只按血缘查**会把原包一起认领**
    ⇒ 「example 不取原包」这条就破了。
    ⇒ 载荷直接说清「这一件在文件中心的编号是谁」（**事实**）⇒ 认领不再靠名字猜。
    """
    return {
        'container_sha256': str(container_sha256 or ''),
        'members': [
            {
                'name': str(member.get('name') or ''),
                'kind': str(member.get('kind') or ''),
                'sha256': str(member.get('sha256') or ''),
                'size_bytes': int(member.get('size_bytes') or 0),
                'container_sha256': str(member.get('container_sha256') or container_sha256 or ''),
                # **这个件在文件中心的编号**（2026-10-22 第 2 步加）。
                'file': str(member.get('file') or ''),
            }
            for member in (members or [])
        ],
    }


def package_stored_idempotency_key(container_sha256):
    """成员清单这条通知的**幂等键**。

    同一个原包 ⇒ 同一把键 ⇒ 重复投递**只发一次**（下游不会把同一个包处理两遍）。
    """
    return 'files:package-stored:%s' % str(container_sha256 or '')
