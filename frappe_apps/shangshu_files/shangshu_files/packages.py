"""包件交接：**按 `container_sha256` 存成员 ＋ 广播成员清单**（文件域这一侧）。

**这一层为什么在文件域**（架构判断，2026-10-22）：
· **域与域之间只走公开 Action/Service/Event** ⇒ 文件域**不许** import Host 域的实现
  （`scripts/check-domain-boundary.mjs` 的 `no-foreign-domain-import` 规则也这么判）；
· **谁声明，谁的生死挂在事件上**（内核 `publish_event` 对**声明者**做 `assert_domain_enabled`）
  ⇒ `files.package.stored` 必须由**保证长期存在的公共件**声明 ⇒ **文件域**声明；
· 成员是**文件域落的** ⇒ 事件归它声明，不是收包的那一头。

⇒ 所以：**收包的那一头**（Host 域）负责「一个包解出哪些成员」（纯计算），
**文件域**负责「把成员落进文件中心 ＋ 把成员清单广播出去」。

**这个动作做的三件事**（`fde/设计/契约/处理契约与状态转换.md` §1 链路全景）：
1. **原包**进文件中心 —— 只作**备份与血缘凭证**，**不进成员清单**（业务域不取它）；
2. **成员**（list.xml ＋ 正文 ＋ 附件）**逐个**进文件中心 —— **带目录**（域自己声明的那块路径）、
   **带血缘**（`container_sha256` ＝ 原包摘要）；
3. **广播** `files.package.stored`（成员清单；**只有事实**：谁、什么种类、什么摘要、多大、属于哪个包）。

**幂等**：同一个包（同一个 `container_sha256`）再来一次 ⇒
· 成员**不重复入库**（每个成员的落库幂等键 ＝ 容器摘要 ＋ 成员名 ＋ 成员摘要）；
· 事件**只发一次**（事件幂等键 ＝ 容器摘要）。

**发布失败不拦业务结论**（照 `review.py` 的做法）：成员已经落库了 ⇒ 通报失败**记日志**、
回执里说得出「没发出去」，但不把已经落库的成员说成没落。
"""
import hashlib

import frappe

from shangshu_files.domain import FILE_PACKAGE_STORED_EVENT
from shangshu_files.events import (build_package_stored_payload,
                                   package_stored_idempotency_key)

# 成员种类（**与收包那一头同一份口径**：清单／正文／附件）。
KIND_LIST = "list"
KIND_BODY = "body"
KIND_ATTACHMENT = "attachment"


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def _safe_member_name(name):
    """成员名 → 文件名（**只取最后一段**）。

    包内成员名是**包内路径**（如 `受理通知书/list.xml`）⇒ 文件名不许带路径分隔符
    （文件中心的文件名规则）⇒ 取最后一段。
    """
    base = str(name or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not base:
        _fail("成员名必填")
    return base


def _member_key(container_sha256, name, digest):
    """**成员级**幂等键 ＝ 容器摘要 ＋ 成员名 ＋ 成员摘要（稳定生成）。

    ⇒ 同一个包再来一次 ⇒ 同一把键 ⇒ 成员**不重复入库**。

    ⚠️ 三个值直接拼起来会超过幂等键字段的长度上限（140）⇒ 取它们的**摘要**。
    摘要一样 ⇒ 键一样（这是幂等的依据）；键短 ⇒ 放得下。
    """
    blob = "%s|%s|%s" % (container_sha256, name, digest)
    return "files:package-member:%s" % hashlib.sha256(blob.encode("utf-8")).hexdigest()[:40]


def _upload(file_name, content_base64, digest, directory, container_sha256,
            idempotency_key, note, attribution):
    """**走文件域自己的公开动作**落库（字节进尚书只有这一条路）。

    幂等键由调用方给（成员级 ＝ 容器摘要 ＋ 成员名 ＋ 成员摘要）⇒
    同一个包再来一次**不重复入库**。
    """
    from shangshu_core.public_api import execute_registered_action

    payload = {"file_name": file_name,
               # 包/完整成员路径决定来源；文件名只负责显示，不能追旧资源版本。
               # 同源重试仍沿下方原幂等键，由核心核身份/载荷后返回成功回执。
               "new_resource": True,
               "content_base64": content_base64,
               "attribution": dict(attribution or {}),
               "directory": directory,
               "note": note}
    if digest:
        payload["file_sha256"] = digest
    if container_sha256:
        payload["container_sha256"] = container_sha256
    # 同键重放/冲突全部由核心校验，不读旧回执改载荷、不换键、不猜同名资源。
    outcome = execute_registered_action("files.upload", payload, confirmed=True,
                                        idempotency_key=idempotency_key, source="user")
    result = outcome.get("result") or {}
    return {"file": str(result.get("file") or ""),
            "sha256": digest or "",
            "size_bytes": 0,
            "created": int(result.get("created") or 0)}


def store_package(payload):
    """把一个包的**成员**（连同原包）落进文件中心，并广播成员清单。"""
    payload = payload or {}
    container_sha256 = str(payload.get("container_sha256") or "").strip()
    if not container_sha256:
        _fail("原包摘要必填（成员靠它溯源到原包）")
    directory = str(payload.get("directory") or "").strip()
    if not directory:
        _fail("目录必填（域自己声明的那块路径）")
    container = payload.get("container") or {}
    if not isinstance(container, dict) or not container.get("content_base64"):
        _fail("原包必填（原包是备份与血缘凭证）")
    if container.get('file_sha256') and str(container['file_sha256']) != container_sha256:
        _fail('原包校验摘要与来源摘要不一致；本次未保存')
    members = payload.get("members")
    if not isinstance(members, list):
        _fail("成员清单必须是列表")
    attribution = payload.get("attribution") or {}

    # ① **原包**：进文件中心（备份与血缘凭证）—— **不进成员清单**。
    container_file_name = _safe_member_name(container.get("file_name") or "原包.zip")
    container_receipt = _upload(
        container_file_name, container.get("content_base64"),
        str(container.get("file_sha256") or container_sha256), directory, container_sha256,
        "files:package-container:%s" % container_sha256,
        "包件原包（备份与血缘凭证；不进成员清单）", attribution)
    container_receipt["size_bytes"] = int(container.get("size_bytes") or 0)

    # ② **成员**：逐个落文件中心（带目录、带血缘）。
    stored = []
    for member in members:
        member = member if isinstance(member, dict) else {}
        name = str(member.get("name") or "")
        file_name = _safe_member_name(name)
        digest = str(member.get("sha256") or "")
        receipt = _upload(
            file_name, member.get("content_base64"), digest, directory, container_sha256,
            _member_key(container_sha256, name, digest),
            "包件成员（血缘：原包 %s）" % container_sha256[:12], attribution)
        receipt.update({"name": name,
                        "kind": str(member.get("kind") or ""),
                        "size_bytes": int(member.get("size_bytes") or 0)})
        stored.append(receipt)

    # ③ **广播成员清单**（只有事实；发不出去不拦业务结论，但要看得见）。
    event = _publish(container_sha256, stored)
    return {"container": container_receipt,
            "members": stored,
            "counts": _counts(stored),
            "event": event}


def _counts(stored):
    """页面四数里的两个（官文数／附件数）—— 按**成员种类**数（不含原包）。"""
    notices = sum(1 for item in stored if item.get("kind") == KIND_LIST)
    attachments = sum(1 for item in stored if item.get("kind") == KIND_ATTACHMENT)
    return {"notices": notices, "attachments": attachments}


def _publish(container_sha256, stored):
    """发「这个包收了哪些成员」事件（**失败不拦业务结论**，但要看得见）。"""
    from shangshu_core.public_api import publish_event

    body = build_package_stored_payload(container_sha256, stored)
    try:
        publish_event(FILE_PACKAGE_STORED_EVENT, body,
                      package_stored_idempotency_key(container_sha256))
        return {"published": True, "event_id": FILE_PACKAGE_STORED_EVENT,
                "members": len(body["members"])}
    except Exception as error:  # noqa: BLE001 —— 通报失败**不拦**成员已落库的结论
        # 但必须**看得见**：成员已经进文件中心了，事件没发出去要能查、能补发。
        frappe.logger('shangshu_files').error('包件成员已入库但成员清单事件没发出去：%s' % error)
        return {"published": False, "event_id": FILE_PACKAGE_STORED_EVENT,
                "members": len(body["members"]), "error": str(error)[:300]}
