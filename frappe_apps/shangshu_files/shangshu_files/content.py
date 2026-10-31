"""文件域 · **读一份受管文件的原始字节**（`files.content`）。

**为什么要有这个口**（2026-10-22 第 2 步查出来的缺口）：
example 要按 ``list.xml`` 的**结构**把一个包里的件分组
（**一份清单 = 一份通知书 = 正文 ＋ 它的附件**），
而现有的 ``files.document_text`` **只给文字节点**（标记被丢掉了）
⇒ 拿不到「哪个名字是正文、哪些是附件」⇒ 分不了组。
⇒ 给业务域一个**受控的**字节读口。

**规矩**（一条都不许松）：
· **只读受管私有原件**（不走工作副本、不走公开文件）；
· **限大小**（默认 1 MiB，最多 4 MiB）—— 大件请走下载，不要从口里灌；
· **读权与导出闸都走既有那条**（`files.versions` ＋ `require_no_pending_writeback`）
  ⇒ **不另设一套读权**（另设一套就会漂）；
· **哈希对不上当场拒**（读到的字节必须就是那个固定版本）；
· **只读**：这个口不改任何东西。
"""

import base64
import hashlib

import frappe

# 默认与上限（字节）。
DEFAULT_MAX_BYTES = 1024 * 1024
HARD_MAX_BYTES = 4 * 1024 * 1024


def read_content(_service, payload, context):
    """`files.content`：读一份受管文件的**原始字节**（base64 回包）。

    回包：`{file, name, size_bytes, sha256, content_base64}` ——
    `sha256` 是**读到的这批字节**的摘要（与固定版本对不上会当场拒，拒不到这里）。
    """
    from shangshu_files.domain import versions

    payload = payload or {}
    file_name = str(payload.get("file") or "").strip()
    if not file_name:
        frappe.throw("请选择要读内容的文件", frappe.ValidationError)
    max_bytes = payload.get("max_bytes", DEFAULT_MAX_BYTES)
    if type(max_bytes) is not int or not 1 <= max_bytes <= HARD_MAX_BYTES:
        frappe.throw("每次最多读取 %d 字节" % HARD_MAX_BYTES, frappe.ValidationError)

    # 读权 + 当前固定版本都走既有那条口（**不另设一套读权**）。
    history = versions("files.versions", {"file": file_name}, context)
    current = history.get("current") or {}
    frappe_file = current.get("frappe_file")
    if not frappe_file:
        frappe.throw("这份文件还没有可读的固定版本", frappe.ValidationError)
    file_doc = frappe.get_doc("File", frappe_file)
    if not file_doc.get("is_private") or not str(file_doc.get("file_url") or "").startswith("/private/files/"):
        frappe.throw("只读取受管私有原件", frappe.PermissionError)
    content = file_doc.get_content()
    if not isinstance(content, bytes):
        content = str(content).encode("utf-8")
    if len(content) > max_bytes:
        frappe.throw("这份文件有 %d 字节，超过这次要读的 %d 字节（请走下载）"
                     % (len(content), max_bytes), frappe.ValidationError)
    digest = hashlib.sha256(content).hexdigest()
    expected = str(current.get("sha256") or "")
    if expected and digest != expected:
        frappe.throw("原件哈希已变化，请核对文件", frappe.ValidationError)
    detail = history.get("file") or {}
    return {
        "file": file_name,
        "name": str(detail.get("file_name") or ""),
        "size_bytes": len(content),
        "sha256": digest,
        "content_base64": base64.b64encode(content).decode("ascii"),
    }
