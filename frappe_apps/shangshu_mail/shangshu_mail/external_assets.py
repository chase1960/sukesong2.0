"""外部内容（来信正文里的**外链图**）入库与内链化。

用户 2026-10-21 的口径：「对于外部内容，**接受就直接进入文件中心，给他一个内链**，
让这些都能显示和转发。」

本模块做三件事：
  ① 从正文里认出外链图（`<img src="http(s)://…">`）；
  ② 把字节取回来（受限：只 http/https、私网/环回地址不取、大小与类型有上限）；
  ③ 落成**文件中心**里的一条记录，正文里的外链引用换成 `cid:<content_id>`
     —— 正文里的图引用必须保持 `cid:` 形态（出站净化门只认 `cid:`，
     收件人那边才看得到图；换成受管地址反而会让转发丢图）。

为什么不直接给外链图配一个受管地址了事：
  受管地址（`/api/platform/file-content?…`）是**读**的口子；**转发**要的是字节。
  字节得在文件中心里有一份自己的记录（同一逻辑资源多人共用，不为每个收件人各存一份），
  出站时按 `cid:` 挂成 inline part —— 这条链走通，图才既能显示又能带走。

模块**不在导入期碰 frappe**（纯函数可离线单测）；需要 frappe 的部分都在函数体内 import。
"""
import ipaddress
import json
import re
import socket
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

# 正文里 `<img src="http(s)://…">` —— 只认 img 的 src（正文里的外链**链接**是另一回事：
# 那是给人点的，不该被悄悄抓回来入库）。
IMG_SRC_RE = re.compile(r'(<img\b[^>]*?\bsrc\s*=\s*)(["\'])(https?://[^"\'\s>]+)\2', re.IGNORECASE)

# 取回的外链图只认这几种类型 —— 别的（html/svg/脚本）不进文件中心。
ALLOWED_IMAGE_MIME = ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
# 单张上限（与邮件附件那条线同一个量级）。
MAX_EXTERNAL_IMAGE_BYTES = 5 * 1024 * 1024
# 取回的超时（秒）—— 不让一封信里的外链图把收信作业拖住。
FETCH_TIMEOUT_SECONDS = 8


def external_image_urls(body):
    """正文里的外链图地址（按出现顺序，去重）。纯函数。"""
    urls = []
    seen = set()
    for match in IMG_SRC_RE.finditer(str(body or '')):
        url = match.group(3)
        if url in seen:
            continue
        seen.add(url)
        urls.append(url)
    return urls


def rewrite_external_to_cids(body, mapping):
    """把外链图引用换成 `cid:<content_id>`。

    `mapping` = {外链地址: content_id}。**取不到的不换** ——
    换成一个编出来的地址比留着原样更糟（看着像好了，其实是破的）。
    纯函数。
    """
    def replace(match):
        url = match.group(3)
        content_id = (mapping or {}).get(url)
        if not content_id:
            return match.group(0)
        quote = match.group(2)
        return f'{match.group(1)}{quote}cid:{content_id}{quote}'
    return IMG_SRC_RE.sub(replace, str(body or ''))


def name_for_url(url):
    """从外链地址推一个文件名（去查询串、限长、去控制字符）。"""
    path = unquote(urlparse(str(url or '')).path or '')
    name = path.rsplit('/', 1)[-1] or 'external.img'
    name = ''.join(ch for ch in name if 32 <= ord(ch))[:120]
    return name or 'external.img'


def content_id_for_url(url):
    """外链图在正文里用的 `cid:` 标识 —— 按地址定死（同一张图重收一次还是同一条）。"""
    import hashlib
    digest = hashlib.sha1(str(url or '').encode('utf-8')).hexdigest()[:16]
    return f'external-{digest}@shangshu.local'


def is_blocked_host(url):
    """私网/环回/链路本地/保留地址**一律不取**。

    收信正文里的地址是**外部内容给的** —— 让服务器照着去取，等于让它替陌生人
    打内网（SSRF）。解析不出来也算挡掉。
    """
    parsed = urlparse(str(url or ''))
    if parsed.scheme not in ('http', 'https'):
        return True
    host = parsed.hostname or ''
    if not host:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return True
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return True
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return True
    return False


def fetch_image(url, opener=None):
    """取回外链图的字节。

    返回 `{'content': bytes, 'mime_type': str, 'name': str}`；**取不到返回 None**
    （不猜、不造、不留半截）。纯网络部分，地址与类型都受上面那两条限制。
    """
    if is_blocked_host(url):
        return None
    request = Request(str(url), headers={'User-Agent': 'ShangshuMail/1.0', 'Accept': 'image/*'})
    opener = opener or urlopen
    try:
        with opener(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            mime = (response.headers.get('Content-Type') or '').split(';')[0].strip().lower()
            if mime not in ALLOWED_IMAGE_MIME:
                return None
            content = response.read(MAX_EXTERNAL_IMAGE_BYTES + 1)
    except Exception:
        return None
    if not content or len(content) > MAX_EXTERNAL_IMAGE_BYTES:
        return None
    return {'content': content, 'mime_type': mime, 'name': name_for_url(url)}


def plan_external_images(body, fetch=None, guard=None):
    """把正文里的外链图逐个取回来，规划成「正文怎么改 + 资源表怎么加」。

    **纯逻辑 + 取字节**（不含 frappe）：返回
      `{'body': 新正文, 'resources': [{content_id, mime_type, name, content}],
        'results': [{'url':…, 'status':'fetched'|'skipped', 'reason':…}]}`
    取不到的引用**留原样**（不编地址）。

    `guard` = 地址闸门（默认 `is_blocked_host`）：**先过闸再取** ——
    外部内容给的地址一律先判「能不能取」（私网/环回/非 http 不取）。
    """
    fetch = fetch or fetch_image
    guard = guard or is_blocked_host
    urls = external_image_urls(body)
    resources = []
    results = []
    mapping = {}
    for url in urls:
        if guard(url):
            results.append({'url': url, 'status': 'skipped', 'reason': '外链地址不可取（私网/非 http）'})
            continue
        payload = fetch(url)
        if not payload or not payload.get('content'):
            results.append({'url': url, 'status': 'skipped', 'reason': '取不到字节'})
            continue
        content_id = content_id_for_url(url)
        mapping[url] = content_id
        resources.append({'content_id': content_id,
                          'mime_type': payload.get('mime_type') or 'image/png',
                          'name': payload.get('name') or name_for_url(url),
                          'content': payload['content']})
        results.append({'url': url, 'status': 'fetched'})
    new_body = rewrite_external_to_cids(body, mapping)
    # `mapping` 也带出来：**调用方要按「哪些真的存进去了」再换一次引用**
    # （存失败的保持原地址 ⇒ 图不丢）。
    return {'body': new_body, 'resources': resources, 'results': results, 'mapping': mapping}


def import_mail_assets(mail, user, fetch=None, guard=None, create_file=None, import_files=None):
    """收信之后那一趟：**内联图与外链图都进文件中心**，资源表补上文件中心记录（`source`）。

    · 外链图：取字节 → 落成挂在**这封信**上的 File → 正文里的外链引用换成 `cid:`；
    · 内联图（`cid:`）：也一并进文件中心（原来**只有附件**进）——
      有了 `source`，**转发时就不用再存一次**（前端按 `source` 直接取路径索引，
      只有没有 `source` 的才去补入库）；
    · 取不到的：引用**留原样**（不编地址），资源表里也没有那一条。

    `fetch` / `create_file` / `import_files` 可注入（离线单测与受控环境靠它）。
    返回 `{'body':…, 'resources':[…], 'results':[…]}`。
    """
    import frappe
    doc = frappe.get_doc('Shangshu Mail Message', mail)
    body = doc.get('body') or ''
    try:
        inline = json.loads(doc.get('inline_resources_json') or '[]')
    except Exception:
        inline = []
    create_file = create_file or _store_managed_asset
    import_files = import_files or _import_into_file_center

    # ① 外链图：取字节（取不到的不换引用）。
    plan = plan_external_images(body, fetch=fetch, guard=guard)
    stored_ids = set()
    for resource in plan['resources']:
        try:
            stored = create_file(mail, resource['name'], resource['content'])
            if isinstance(stored, dict):
                # **新路径**：字节已由文件域放并受管 ⇒ 直接记 `source`（后面那步「认领」就不必做它）。
                resource['file'] = stored.get('file') or ''
                if stored.get('managed'):
                    resource['source'] = {'ref_doctype': 'Shangshu File Center File',
                                          'ref_name': stored['managed'], 'file': resource['file']}
            else:
                # **老路径**（离线判据注入的假 create_file）：只给 File 编号。
                resource['file'] = stored
            if resource.get('file'):
                stored_ids.add(resource['content_id'])
        except Exception as error:
            frappe.log_error(title='外链图落文件失败',
                             message=f'mail={mail} reason={_reason(error)}')
            resource.pop('file', None)
    fresh = [{k: v for k, v in item.items() if k != 'content'} for item in plan['resources'] if item.get('file')]
    resources = merge_inline_resources(inline, fresh)
    # ⚠️ **只给存成功的那几张换引用**（存失败的保持原地址 ⇒ 不换就不丢图）。
    body_after = rewrite_external_to_cids(
        body, {url: cid for url, cid in (plan.get('mapping') or {}).items() if cid in stored_ids})

    # ② 正文与资源表先落定（`cid:` 形态 —— 出站净化门只认 `cid:`，换地址转发就丢图）。
    with _writing():
        doc.body = body_after
        doc.inline_resources_json = dumps_inline_resources(resources)
        doc.save(ignore_permissions=True)

    # ③ 进文件中心：内联图（还没有 source 的）+ 刚取回来的外链图。
    pending = [item['file'] for item in resources
               if item.get('file') and not item.get('source')]
    if pending:
        try:
            centers = import_files(mail, user, pending)
        except Exception as error:
            frappe.log_error(title='来信图片入库文件中心失败',
                             message=f'mail={mail} reason={_reason(error)}')
            centers = {}
        for item in resources:
            center = (centers or {}).get(item.get('file'))
            if center:
                item['source'] = {'ref_doctype': 'Shangshu File Center File',
                                  'ref_name': center, 'file': item['file']}
        # ④ 入库过程里的「链接重接」会把 `cid:` 换成受管地址 ——
        #    那是**读**的口子；**出站只认 `cid:`** ⇒ 正文换回去（转发才带得走图）。
        with _writing():
            doc.body = body_after
            doc.inline_resources_json = dumps_inline_resources(resources)
            doc.save(ignore_permissions=True)
    return {'body': body_after, 'resources': resources, 'results': plan['results']}


def _writing():
    """邮件域自己的写入上下文（与 delivery.py 同一套）。"""
    from shangshu_mail.service import writing
    return writing()


def _reason(error):
    return ''.join(ch if 32 <= ord(ch) else ' ' for ch in str(error))[:200]


def _store_managed_asset(mail, name, content, user=None):
    """外链图的字节：**由文件域放**（契约「所有进尚书的文件都进文件中心」），
    再把**受管原件绑定到这封信上**（绑的是引用，**字节不动**）。

    改前：邮件域**自己**建 `File`（挂在信上）⇒ 那正是契约 `file-center-v1.json`
    的 `exemptions` 里登记的**限期豁免**（2026-10-22 · PKG-036-T03 已收口）。

    为什么还要「绑一下」：字节必须由文件域放（唯一去处），
    而这封信上的图**还要能按这封信的归属取字节**（读信面／正文 `cid:` 解析）⇒
    需要一个**挂在信上的引用**。内核 `bind_record_attachments` 走 Frappe v15 的
    `create_attachment_copy`，原话是「**reusing `file_url`**」⇒ **同一个磁盘文件、两个身份**
    ⇒「字节只写一次」成立。

    返回 `{'file': 挂在信上的 File 编号, 'managed': 文件中心里的受管文件编号}`。
    """
    import base64
    import frappe
    from shangshu_core.public_api import execute_registered_action
    # 路径常量在 delivery 里（**只留一份**，免得两处漂）
    from shangshu_mail.delivery import MAIL_ASSET_PATH, attachment_attribution

    receipt = execute_registered_action(
        'files.upload',
        {'file_name': name,
         'content_base64': base64.b64encode(content).decode('ascii'),
         'directory': MAIL_ASSET_PATH,
         'note': '来信外链图（邮件域）',
         # 归属按**这封信的归属**推（邮箱 → 员工／部门），不是请求里随便填的。
         'attribution': attachment_attribution(mail, user or frappe.session.user)},
        confirmed=True,
        idempotency_key='mail:asset:%s:%s' % (mail, name),
    )
    managed = str((receipt.get('result') or {}).get('file') or '')
    if not managed:
        frappe.throw('外链图没能进文件中心', frappe.ValidationError)
    bound = execute_registered_action(
        'mail.attachment.bind', {'mail': mail, 'files': [managed]}, confirmed=True,
        idempotency_key='mail:asset-bind:%s:%s' % (mail, managed))
    file_id = str(((bound.get('result') or {}).get('files') or [''])[0] or '')
    if not file_id:
        frappe.throw('受管原件没能绑定到这封信上', frappe.ValidationError)
    return {'file': file_id, 'managed': managed}


def _import_into_file_center(mail, user, files):
    """送进文件中心 —— **走文件域自己的受管动作**（与附件入库同一条路，
    直调文件服务会被内核拒：「附件绑定必须由所属领域的公共动作执行」）。

    返回 {File id: 文件中心记录 id}。
    """
    from shangshu_mail.delivery import import_mail_attachments
    outcome = import_mail_attachments(mail, user, files)
    centers = {}
    for item in (outcome or {}).get('attachments', []):
        if item.get('status') in ('imported', 'already') and item.get('file_center'):
            centers[item['file']] = item['file_center']
    return centers


def merge_inline_resources(existing, added):
    """资源表合并：同 content_id 以新的一条为准（文件 id / 文件中心记录是新的）。"""
    merged = []
    index = {}
    for item in list(existing or []) + list(added or []):
        content_id = str(item.get('content_id') or '')
        if not content_id:
            continue
        if content_id in index:
            merged[index[content_id]] = item
        else:
            index[content_id] = len(merged)
            merged.append(item)
    return merged


def dumps_inline_resources(items):
    return json.dumps(list(items or []), ensure_ascii=False)
