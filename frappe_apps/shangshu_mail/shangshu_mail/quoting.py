"""回复 / 转发的**公共实现**（引用块 ＋ 内联图改写）。

为什么放在后端做一份：
  · agent（assistant agent）够不到前端的编辑器面 —— 「人点转发」那条路只活在前端；
  · 两边各拼一套正文字符串，就是「同一个意思、两种产物」——
    ⇒ **一份实现**（本模块），人点与 agent 调动作都调它。

本模块只做三件事（都不碰邮件记录本身）：
  ① 引用块：分隔线 ＋ 抬头（发件人/时间/收件人/抄送/主题）＋ 原信正文；
  ② 内联图 `cid:` → **文件中心的路径索引**（`/api/platform/file-content?…`），
     并留 `data-managed-cid` —— 存回正文时由 `restore_cids()` 还原成 `cid:`
     （**出站净化门只认 `cid:`**，不还原就把图丢了）；
  ③ 取不到字节/没权限的图**照原样留着**（不编地址）。

模块**不在导入期碰 frappe**（纯函数可离线单测）；需要 frappe 的部分都在函数体内 import。
"""
import json
import re
from urllib.parse import urlencode

# 与前端那条路**同形**的分隔线（前端 mail-center.js 的 buildQuote 用的是同一句）。
QUOTE_SEPARATOR = '---------- 原始邮件 ----------'
FILE_CENTER_DOCTYPE = 'Shangshu File Center File'

# `src="cid:xxx"` —— 正文里的图引用形态（出站净化门只认这个）。
CID_SRC_RE = re.compile(r'(src\s*=\s*)(["\'])cid:([^"\']+)\2', re.IGNORECASE)
# `src="…" data-managed-cid="cid:xxx"` —— 编辑期的形态（存回时还原成 cid:）。
MANAGED_CID_RE = re.compile(
    r'(src\s*=\s*)(["\'])([^"\']+)\2(\s+data-managed-cid\s*=\s*)(["\'])cid:([^"\']+)\5', re.IGNORECASE)


def managed_file_url(file_center_id, file_name):
    """文件中心的受管地址（**内链**）—— 与 file-center.js / delivery.py 同款。

    它带 `can_read_reference` 权限判定：授权范围内的人点得开，撤权后失效。
    """
    return '/api/platform/file-content?' + urlencode({
        'ref': FILE_CENTER_DOCTYPE,
        'ref_name': str(file_center_id or ''),
        'file': str(file_name or ''),
    })


def _escape_html(value):
    """正文里的字面文本（地址里的尖括号是邮箱写法，不是标记）。"""
    return (str(value or '').replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def quote_head(original):
    """引用块抬头：发件人 / 发送时间 / 收件人 / 抄送 / 主题（与前端同形）。"""
    from shangshu_mail.domain import DOCTYPE  # noqa: F401  （保留域常量归属，不参与计算）
    def _text(value):
        return _escape_html(value)
    to = original.get('to_json') or '[]'
    cc = original.get('cc_json') or '[]'
    try:
        to_list = json.loads(to) if isinstance(to, str) else to
    except Exception:
        to_list = []
    try:
        cc_list = json.loads(cc) if isinstance(cc, str) else cc
    except Exception:
        cc_list = []
    def _addr(item):
        if isinstance(item, dict):
            name = item.get('name') or ''
            addr = item.get('addr') or item.get('email') or ''
            return f'{name} <{addr}>' if name else str(addr)
        return str(item)
    head = f'发件人: {_text(original.get("from_address"))}<br>'
    head += f'发送时间: {_text(original.get("received_at") or original.get("modified"))}<br>'
    head += f'收件人: {_text("；".join(_addr(item) for item in (to_list or [])) or "—")}'
    if cc_list:
        head += f'<br>抄送: {_text("；".join(_addr(item) for item in cc_list))}'
    head += f'<br>主题: {_text(original.get("subject"))}'
    return head


def build_quote_block(original):
    """引用块（HTML）—— 空行 ＋ 分隔线 ＋ 抬头 ＋ 原信正文。

    **只引原文，不改原信**：原信正文原样带进来（表格/合并格/受管内联图都在）。

    原信是**纯文本**时，它的换行要保得住（用户 2026-10-13：「能不能排版一下,
    包括横杠长度\\换行这些」）—— HTML 渲染会把 `\\n` 折成空格，
    所以纯文本正文包进 `white-space:pre-wrap`（与前端那条旧分支同一口径）。
    """
    body = original.get('body') or ''
    if (original.get('body_format') or 'HTML') != 'HTML':
        body = ('<div data-mail-quote-body="1" style="white-space:pre-wrap">'
                + _escape_html(body) + '</div>')
    else:
        body = f'<div data-mail-quote-body="1">{body}</div>'
    return ('<p><br></p>'
            + '<div data-mail-quote="1" style="color:#666">'
            + f'<div data-mail-quote-sep="1">{QUOTE_SEPARATOR}</div>'
            + '<div data-mail-quote-head="1" style="font-size:12px;margin:10px 0 12px;line-height:1.8">'
            + quote_head(original) + '</div>'
            + body
            + '</div>')


def apply_path_index(html, index):
    """`cid:` → 文件中心路径索引（并留 `data-managed-cid`）。

    `index` = {content_id: {ref_doctype, ref_name, file}}。
    **索引里没有的照原样留着**（不编地址）。
    """
    def replace(match):
        content_id = match.group(3)
        source = (index or {}).get(content_id)
        if not source:
            return match.group(0)
        url = managed_file_url(source.get('ref_name'), source.get('file'))
        quote = match.group(2)
        return (f'{match.group(1)}{quote}{url}{quote}'
                f' data-managed-cid={quote}cid:{content_id}{quote}')
    return CID_SRC_RE.sub(replace, str(html or ''))


def restore_cids(html):
    """编辑期的 `data-managed-cid` → `src="cid:…"`（出站净化门只认 `cid:`）。"""
    def replace(match):
        quote = match.group(2)
        return f'{match.group(1)}{quote}cid:{match.group(6)}{quote}'
    return MANAGED_CID_RE.sub(replace, str(html or ''))


class OriginalNotReadable(Exception):
    """原信读不到 —— 当场拒并说得出原因（不生成空引用的草稿）。"""


def require_original(original_id, loader):
    """取原信：编号没给 / 读不到 / 已回收 ⇒ **当场拒并说得出原因**。

    `loader` 由调用方给（后端传 `service.message` —— 它核读权）。
    """
    ident = str(original_id or '').strip()
    if not ident:
        raise OriginalNotReadable('回复/转发必须指明原信编号（reply_to_mail）')
    try:
        original = loader(ident)
    except Exception as error:
        raise OriginalNotReadable('原信读不到：%s（%s）' % (ident, str(error)[:160]))
    if not original:
        raise OriginalNotReadable('原信读不到：%s' % ident)
    if (original.get('status') or '') == 'Trash':
        raise OriginalNotReadable('这封信已移入回收站，不能据此回复或转发')
    return original


def inline_resources_of(original):
    """原信登记的受管内联资源（content_id / mime_type / name / file / source）。"""
    try:
        return json.loads(original.get('inline_resources_json') or '[]')
    except Exception:
        return []


def path_index_for_inline(original, user, importer=None):
    """原信的内联图 → 文件中心记录（**已有 `source` 的直接用**；没有的入库一次）。

    入库走**文件域自己的受管动作**（与附件入库同一条路）。
    返回 {content_id: {ref_doctype, ref_name, file}}。
    """
    resources = inline_resources_of(original)
    index = {}
    pending = []
    for item in resources:
        content_id = str(item.get('content_id') or '').strip().strip('<>')
        if not content_id:
            continue
        source = item.get('source')
        if source and source.get('ref_name') and source.get('file'):
            index[content_id] = {'ref_doctype': source.get('ref_doctype') or FILE_CENTER_DOCTYPE,
                                 'ref_name': source['ref_name'], 'file': source['file']}
        elif item.get('file'):
            pending.append((content_id, item))
    if pending:
        importer = importer or _import_into_file_center
        try:
            centers = importer(original.get('name'), user, [item['file'] for _, item in pending])
        except Exception:
            centers = {}
        for content_id, item in pending:
            center = (centers or {}).get(item.get('file'))
            if center:
                index[content_id] = {'ref_doctype': FILE_CENTER_DOCTYPE,
                                     'ref_name': center, 'file': item['file']}
    return index


def _import_into_file_center(mail, user, files):
    """送进文件中心 —— 走文件域自己的受管动作（**不动原信正文**）。

    返回 {File id: 文件中心记录 id}。
    """
    from shangshu_mail.delivery import import_into_file_center
    results = import_into_file_center(mail, user, files)
    centers = {}
    for item in results or []:
        if item.get('status') in ('imported', 'already') and item.get('file_center'):
            centers[item.get('file')] = item['file_center']
    return centers


def default_signature(mailbox_key='', user=None):
    """目标箱的**默认签名**（html ＋ 它引用的受管图资源）；没有签名返回 None。

    服务端取（`account.signature_projection`）—— 与前端 `signatureFor(mailbox)` 同一份数据源，
    所以「人点转发」和「agent 调 mail.forward」拿到的签名**一模一样**。
    """
    from shangshu_mail import account
    try:
        doc = account.get_account(mailbox=(mailbox_key or None))
    except Exception:
        return None
    if not doc:
        return None
    state = account.signature_projection(doc)
    if not state.get('enabled') or not state.get('html'):
        return None
    return {'html': state.get('html') or '', 'resources': state.get('resources') or []}


def insert_signature(body, signature_html):
    """把签名插在**引用块之前**（与前端 `withDefaultSignature` 同一位置口径）。"""
    if not signature_html:
        return body
    text = str(body or '')
    block = '<div>' + signature_html + '</div>'
    at = text.find('<div data-mail-quote')
    return text[:at] + block + text[at:] if at >= 0 else text + block


def build_reply_body(original, new_body='', user=None, importer=None, mode='forward', signature=None):
    """回复/转发草稿的正文 = **新写的字** ＋ 引用块（内联图已换成文件中心路径索引）。

    返回 `{'body':…, 'inline_resources':[…]}`：
      · `body` 里那张图的 `src` 是**文件中心路径**（不是裸 `cid:`）——
        存回时由 `restore_cids()` 还原成 `cid:`（出站只认 cid:）；
      · `inline_resources` 是随草稿带走的受管内联图（草稿要能自己显示那张图）。
    """
    index = path_index_for_inline(original, user, importer=importer) if user else {}
    quote = apply_path_index(build_quote_block(original), index)
    prefix = str(new_body or '')
    resources = []
    for item in inline_resources_of(original):
        content_id = str(item.get('content_id') or '').strip().strip('<>')
        if not content_id:
            continue
        record = {'content_id': content_id,
                  'mime_type': item.get('mime_type') or 'image/png',
                  'name': item.get('name') or 'inline.img',
                  'file': item.get('file') or ''}
        source = index.get(content_id)
        if source:
            record['source'] = source
        resources.append(record)
    body = (prefix + quote) if prefix else quote
    resources = list(resources)
    if signature and signature.get('html'):
        body = insert_signature(body, signature.get('html'))
        # 签名里引用的受管图要**跟着走**（不带过去，正文里只剩一个取不到的 cid: —— 破图）。
        have = {item['content_id'] for item in resources}
        for item in signature.get('resources') or []:
            content_id = str(item.get('content_id') or item.get('id') or '').strip().strip('<>')
            if not content_id or content_id in have:
                continue
            have.add(content_id)
            resources.append({'content_id': content_id,
                              'mime_type': item.get('mime_type') or 'image/png',
                              'name': item.get('name') or 'inline.img',
                              'file': item.get('file') or ''})
    return {'body': body, 'inline_resources': resources}
