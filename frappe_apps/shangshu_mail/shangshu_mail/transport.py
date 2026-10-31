"""薄 SMTP/IMAP 适配。只接允许的 TLS 服务商，不保存凭据或邮件事实。"""
import email.policy
import email.utils
import imaplib
import ipaddress
import os
import re
import smtplib
import ssl
import threading
from email.message import EmailMessage
from email.parser import BytesParser
from html.parser import HTMLParser

PROVIDERS = {
    'qq': {'id':'qq','label':'QQ 邮箱','domains':['qq.com','foxmail.com'],
           'smtp_host':'smtp.qq.com','imap_host':'imap.qq.com'},
    '163': {'id':'163','label':'网易 163 邮箱','domains':['163.com'],
            'smtp_host':'smtp.163.com','imap_host':'imap.163.com'},
    'netease-enterprise': {'id':'netease-enterprise','label':'网易企业邮箱（北京）','domains':[],
                          'smtp_host':'smtp.qiye.163.com','imap_host':'imap.qiye.163.com'},
    'netease-enterprise-hz': {'id':'netease-enterprise-hz','label':'网易企业邮箱（杭州）','domains':[],
                             'smtp_host':'smtphz.qiye.163.com','imap_host':'imaphz.qiye.163.com'},
}
MAX_MESSAGE_BYTES = 28 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
TIMEOUT = 20


def provider_for(address, provider=None):
    if not isinstance(address,str) or not re.fullmatch(r'[^\s@<>;,]+@[^\s@<>;,]+',address):
        raise ValueError('邮箱地址格式无效')
    domain = address.rsplit('@',1)[1].lower()
    if len(domain)>253 or '.' not in domain or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',part) for part in domain.split('.')):
        raise ValueError('邮箱域名格式无效')
    try: ipaddress.ip_address(domain)
    except ValueError: pass
    else: raise ValueError('邮箱地址必须使用域名')
    personal = next((item for item in PROVIDERS.values() if domain in item['domains']),None)
    if not provider:
        if personal: return personal
        raise ValueError('企业邮箱请明确选择服务商和所属机房，不能按邮箱后缀推断')
    selected = PROVIDERS.get(provider) if isinstance(provider,str) else None
    if not selected or (selected['domains'] and domain not in selected['domains']) or (not selected['domains'] and personal):
        raise ValueError('邮箱地址与选择的服务商不匹配')
    # 企业自定义域只用于登录地址，服务器始终来自固定可信预设；不探测或跨节点试密。
    return selected


# 同一发件人复用同一条 SMTP 连接。用户 2026-10-12 报「点发送要很久」，病根之一是
# 每发一封都新开 SSL + 握手 + 登录（DNS+TCP+TLS+认证，顺利 1～3 秒）。
# 这里按「发件身份」缓存连接；探活失败或发信抛错就丢掉，下次重连。
#
# 复用键 = **邮箱 + 凭据版本 + 安全配置**（用户 2026-10-12：「SMTP 连接复用必须按
# 邮箱、凭据版本和安全配置隔离，不能因同部门而共用连接身份」）。
#   · 邮箱          —— 谁在发
#   · 凭据版本      —— 改密/换授权后旧连接是**旧身份**，必须换新（binding_generation）
#   · 安全配置      —— 主机/端口/加密方式变了，旧连接是另一个安全域，不能接着用
# 同部门**不是**复用理由：部门里每个邮箱各有各的身份，共用账号本身是被禁止的。
_SESSIONS = {}
# 每条会话一把锁（键与 _SESSIONS 一致）。**长驻执行器那半的必需品**：
# 作业在同一个进程里跑，并发两个作业会从缓存里拿到**同一条连接**，
# 而 SMTP 是命令流 —— 两个线程交错写一条 socket，命令/响应就串台
# （一封信的 DATA 混进另一封，或对方读到半句）。
# fork-per-job 时代每个作业有自己的进程和缓存，天然没这个问题；换成常驻进程才有。
# 这把锁只管「同一条连接同一时刻只有一个作业在用」，不改生命周期、不改复用键。
_SESSION_LOCKS = {}
_LOCKS_GUARD = threading.Lock()


def _session_lock(key):
    """取某个复用键的会话锁（没有就建一把）。"""
    with _LOCKS_GUARD:
        lock = _SESSION_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _SESSION_LOCKS[key] = lock
        return lock


def _forget_inherited_sessions():
    """fork 出来的子进程**不继承**父进程的 SMTP 会话。

    同一个 socket 被两个进程轮着写会串话（一封信的 DATA 混进另一封）。
    这里只清引用、**不发 QUIT** —— 在子进程里 QUIT 会顺手把父进程那条连接也结束掉。

    ★ 这不是「复用」的实现：RQ 的 `execute_job` 每任务 fork 一个 work horse，
      子进程里攒下的连接随进程退出消失。要真的跨作业复用，得换长驻执行器
      （BASE967-46 窄设计），不能拿这里的进程内字典冒充。
    会话锁一并清：fork 那一刻若正被持有，子进程继承的那把会永远锁着。
    （Python 的 threading.Lock 在 fork 后会被 threading._after_fork 重建，这里
      清引用是为了**别换非 threading 的锁**时不至于把父进程那把带进子进程。）
    """
    _SESSIONS.clear()
    _SESSION_LOCKS.clear()


if hasattr(os, 'register_at_fork'):
    os.register_at_fork(after_in_child=_forget_inherited_sessions)


def _session_key(address, provider, credential_version, server=None):
    server = server if server is not None else provider_for(address, provider)
    security = '{0}|{1}|{2}'.format(
        server.get('smtp_host', ''), server.get('smtp_port', ''), server.get('security', ''))
    version = '' if credential_version is None else str(credential_version)
    return (address, provider or '', version, security)


def drop_session(address, provider=None, credential_version=None):
    """丢掉这条身份的连接（发信失败后调用，避免下次拿到一条死连接）。

    这里按「邮箱 + 凭据版本」扫掉所有匹配的键 —— 安全配置可能刚好在换，
    认指纹会漏掉该丢的那条。宁可多丢（下次重连），不可漏丢（拿到死连接）。"""
    version = '' if credential_version is None else str(credential_version)
    for key in [k for k in _SESSIONS if k[0] == address and k[1] == (provider or '') and k[2] == version]:
        connection = _SESSIONS.pop(key, None)
        if connection is not None:
            try: connection.close()
            except Exception: pass


def _open_smtp(server):
    """建外发连接：先按隐式 TLS 走 465；对面只肯「先聊、聊到一半再加密」时退回 587+STARTTLS。

    两条路都必须**带证书校验**，都不许把信明文丢出去。

    为什么要有回退：2026-10-13 下午实测，smtp.qq.com 的 465 和 587 都先吐**明文**
    banner（`220 … XMail Esmtp QQ Mail`），EHLO 里广告 STARTTLS；而这里原来写死
    `SMTP_SSL(…,465)` 一包 TLS 过去就是 `[SSL: WRONG_VERSION_NUMBER]`，
    信一封都交不出去，只剩「邮箱连接或授权失败，未开始发送」。
    同一时刻收信 993 是好的、宿主机和容器表现一致 —— 是外发这条的**加密方式对不上**，
    不是网络全断，也不是口令问题。

    只在「对面没在说 TLS」时才回退：网络不通那种错不回退，免得白等两倍超时。
    """
    context = ssl.create_default_context()
    try:
        return smtplib.SMTP_SSL(server['smtp_host'],465,timeout=TIMEOUT,context=context)
    except (ssl.SSLError, smtplib.SMTPServerDisconnected):
        pass   # 对面在说明文 —— 退回「明文 + STARTTLS」
    connection = smtplib.SMTP(server['smtp_host'],587,timeout=TIMEOUT)
    try:
        connection.ehlo()
        connection.starttls(context=ssl.create_default_context())
        connection.ehlo()      # 加密后再报一次能力，否则服务商按明文那次的清单处理
    except Exception:
        try: connection.close()
        except Exception: pass
        raise                  # 退回也不成 —— 如实抛，让上层说「未开始发送」
    return connection


def smtp_session(address, password, provider=None, credential_version=None):
    server = provider_for(address, provider)
    key = _session_key(address, provider, credential_version, server)
    cached = _SESSIONS.get(key)
    if cached is not None:
        try:
            cached.noop()   # 探活：连接还在就直接复用，不重新握手登录
            return cached
        except Exception:
            drop_session(address, provider, credential_version)
    connection = _open_smtp(server)
    try:
        connection.login(address,password)
    except Exception:
        connection.close()
        raise
    _SESSIONS[key]=connection
    return connection


def imap_session(address, password, provider=None):
    server = provider_for(address,provider)
    connection = imaplib.IMAP4_SSL(server['imap_host'],993,timeout=TIMEOUT,
                                  ssl_context=ssl.create_default_context())
    try:
        connection.login(address,password)
        # 网易部分账号要求 IMAP ID；只发固定客户端标识，不带用户敏感信息。
        if b'ID' in [value.upper() if isinstance(value,bytes) else str(value).upper().encode()
                     for value in connection.capabilities]:
            imaplib.Commands.setdefault('ID', ('AUTH', 'SELECTED'))
            connection._simple_command('ID','("name" "Shangshu" "version" "1.0")')
        status, _ = connection.select('INBOX',readonly=True)
        if status != 'OK':
            raise ValueError('无法只读打开收件箱')
    except Exception:
        try: connection.logout()
        except Exception: pass
        raise
    return connection


def close(connection):
    if connection is None:
        return
    try:
        if hasattr(connection,'logout'): connection.logout()
        else: connection.quit()
    except Exception:
        try: connection.close()
        except Exception: pass


def test_connection(address,password,provider=None,credential_version=None):
    smtp = imap = None
    try:
        smtp = smtp_session(address,password,provider,credential_version=credential_version)
        imap = imap_session(address,password,provider)
    finally:
        close(imap); close(smtp)
        # 连接是「用完即弃」的：smtp_session 会把它放进池子，close 却不摘 ——
        # 留在池里的是条死连接，下次靠探活才自愈（白丢一次握手）。
        drop_session(address, provider, credential_version)


def send_message(address,password,display_name,mail,attachments,provider=None,inline_resources=None,credential_version=None):
    message = EmailMessage()
    message['From'] = email.utils.formataddr((display_name,address)) if display_name else address
    message['To'] = ', '.join(mail['to'])
    if mail.get('cc'): message['Cc'] = ', '.join(mail['cc'])
    message['Subject'] = mail['subject']
    message['Message-ID'] = mail['message_id']
    message['Date'] = email.utils.formatdate(localtime=False)
    if mail.get('in_reply_to'):
        message['In-Reply-To'] = mail['in_reply_to']
        message['References'] = mail['in_reply_to']
    if mail.get('body_format','Text')=='HTML':
        plain=_Text();plain.feed(mail['body']);plain.close()
        plain_text=''.join(plain.values).strip()
        images=[item for item in (inline_resources or [])
                if len((item.get('mime_type') or '').split('/'))==2
                and (item.get('mime_type') or '').split('/')[0]=='image']
        if images:
            # 结构必须是 related{ alternative{plain,html}, inline... }：
            # EmailMessage 不允许 alternative 再转 related，故先挂 alternative 再补内联。
            alternative=EmailMessage()
            alternative.set_content(plain_text)
            alternative.add_alternative(mail['body'],subtype='html')
            message.make_related()
            message.attach(alternative)
            for item in images:
                mime=item['mime_type'].split('/')
                message.add_related(item['content'],maintype=mime[0],subtype=mime[1],
                                    filename=item.get('name') or f"{item.get('content_id','inline')}.img",
                                    cid=f"<{item['content_id']}>",disposition='inline')
        else:
            message.set_content(plain_text)
            message.add_alternative(mail['body'],subtype='html')
    else:
        message.set_content(mail['body'])
    for item in attachments:
        # 保留原 MIME 类型；未声明时才退回 octet-stream。
        mime=(item.get('mime_type') or 'application/octet-stream').split('/')
        if len(mime)!=2: mime=['application','octet-stream']
        message.add_attachment(item['content'],maintype=mime[0],subtype=mime[1],filename=item['name'])
    if len(message.as_bytes()) > MAX_MESSAGE_BYTES:
        return {'status':'Failed','error':'邮件连同附件过大，请减少附件后另建草稿','rejected':[]}
    connection = None
    sending = False
    delivered = False
    recipients = list(dict.fromkeys(pair[1] for pair in email.utils.getaddresses(mail['to'] + mail.get('cc',[]))))
    try:
        # 长驻执行器下并发作业会共用缓存里那条连接 —— 同一时刻只准一个作业用它
        # （SMTP 是命令流，并发写同一条 socket 会串台；fork-per-job 时代不存在这问题）。
        session_key = _session_key(address, provider, credential_version, provider_for(address, provider))
        with _session_lock(session_key):
            connection = smtp_session(address,password,provider,credential_version=credential_version)
            sending = True
            rejected = connection.send_message(message,from_addr=address,to_addrs=recipients) or {}
        delivered = True
        return {'status':'Partial' if rejected else 'Sent',
                'error':'部分收件人未被服务商接受，请核对后处理，勿整封重发' if rejected else '',
                'rejected':list(rejected)}
    except smtplib.SMTPRecipientsRefused:
        return {'status':'Failed','error':'服务商拒绝全部收件人，邮件未被接受','rejected':recipients}
    except smtplib.SMTPDataError:
        return {'status':'Failed','error':'服务商明确拒绝本封邮件，请检查内容或大小','rejected':[]}
    except Exception:
        return {'status':'Unknown' if sending else 'Failed',
                'error':'发送结果不明，请在原邮箱核对，不能直接重发' if sending else '邮箱连接或授权失败，未开始发送',
                'rejected':[]}
    finally:
        # 成功时**不关**连接：缓存里的必须是活的才叫复用。改之前无条件 `close(connection)`，
        # 而连接仍留在 `_SESSIONS` 里 —— 缓存里是条已经 QUIT 的死连接（BASE967-46 根因一）。
        # 失败/结果不明时逐出：可能是死连接或半开会话，留着只会让下次白等一次探活。
        # 空闲过久的连接由 `smtp_session` 的 NOOP 探活自愈（失败即丢、下次重连）。
        if not delivered:
            drop_session(address, provider, credential_version)


class _Text(HTMLParser):
    """HTML → 纯文本（外发信的 text/plain 备选）。

    藏 script/style/head 的内容也要用**栈**，不能用计数器：
    计数器假设严格配平，而 `</head>` 常被省略 —— 一失衡后面的字全丢，
    外发信的纯文本备选就空了，用纯文本客户端收信的人看到空邮件。
    """
    def __init__(self):
        super().__init__(convert_charrefs=True); self.values=[]; self.open=[]
    def handle_starttag(self,tag,attrs):
        if tag == 'body' or (self.open and self.open[-1] in _HEAD_SCOPED):
            self.open=[t for t in self.open if t not in _HEAD_SCOPED]
        if tag in _DROP_PAIR: self.open.append(tag)
        if tag in ('p','br','div','tr'): self.values.append('\n')
    def handle_endtag(self,tag):
        if tag in _DROP_PAIR:
            if tag in self.open: self.open.remove(tag)
        if tag in ('td','th'):self.values.append('\t')
    def handle_data(self,value):
        if not self.open: self.values.append(value)


# 允许保留的排版标签：表格、合并单元格属性随行保留；图片只认受管 CID。
_KEEP_TAGS = {'a','b','blockquote','br','div','em','li','ol','p','span','strong',
              'table','tbody','td','tfoot','th','thead','tr','u','ul','img','font'}
# 危险/无用标签分三类，**不许混在一个计数器里**：
#   _DROP_PAIR  有内容要连内容一起藏（script/style/head/title/iframe/object）
#   _DROP_VOID  空标签，**没有结束标签**，只丢自己（base/link/meta/embed）
#   form        只丢标签本身，**里面的字要留住**（表单里的说明文字是正文）
# 用户 2026-10-13 实测两轮：真实 HTML 信 head 里的 <meta>/<link> 是空标签，
# 计数器永远减不回来 → 正文整段丢掉；省略 </head>、<form> 不闭合、<title/> 自闭合
# 同样把后面的正文吞光。**不再靠计数器配平**，改用「还开着的危险标签」栈 +
# HTML 自己的隐式闭合规则（<body> 会收掉 <head> 段）。
_DROP_PAIR = {'script','style','head','title','iframe','object'}
_DROP_VOID = {'base','link','meta','embed'}
_DROP_TAG_ONLY = {'form'}
_DROP_WITH_CONTENT = _DROP_PAIR | _DROP_VOID | _DROP_TAG_ONLY
# head 段里的标签：见到正文标签就可以认定它们被隐式收掉了（HTML 允许省略 </head>）
_HEAD_SCOPED = {'head','title','style'}
_KEEP_ATTRS = {'a':{'href','title'},'img':{'src','alt','width','height'},
               'table':{'border','cellpadding','cellspacing','width','bgcolor'},
               'tr':{'bgcolor'},
               'td':{'colspan','rowspan','align','valign','width','bgcolor'},
               'th':{'colspan','rowspan','align','valign','width','bgcolor'},
               'font':{'color','face','size'}}
# bgcolor 是**颜色值**不是地址，可以留；但只认颜色写法，防止塞 url()/expression 进来。
_COLOR = re.compile(r'^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|rgb[a]?\([\d\s.,%]+\))$', re.I)
_CID_RE = re.compile(r'^cid:[A-Za-z0-9._@+-]{1,200}$')
_CITE_RE = re.compile(r'cid:([A-Za-z0-9._@+-]{1,200})', re.I)
_BAD_STYLE = re.compile(r'(?:expression|javascript:|url\s*\(|@import|behavior\s*:)', re.I)
_STYLE_BLOCK = re.compile(r'<style[^>]*>(.*?)</style>', re.I | re.S)
_RULE = re.compile(r'([^{}]+)\{([^{}]*)\}')
# 只认**简单选择器**：.class / #id / tag。`div p`、`a:hover`、`table td.x` 这类不处理
# （处理它们要真的 CSS 引擎，做了反而容易错），原样丢掉不内联。
_SIMPLE_SEL = re.compile(r'^[.#]?[A-Za-z][\w-]*(\.[\w-]+)*$')


def _style_rules(value):
    """从 <style> 块里取出可内联的规则：[(选择器, [声明, …]), …]。

    为什么要有这一步：`<style>` 整块要剥（它是无用/危险的），但里面的排版规则
    —— 比如 `.hd{background:#12263f}` —— 是**正文外观**，得先落到元素的 style 上。
    不做这步，真实营销邮件的表头底色就整块消失（用户 2026-10-13：「表头颜色发不出去」）。
    """
    rules = []
    for block in _STYLE_BLOCK.findall(str(value or '')):
        for selector, decls in _RULE.findall(block):
            selector = selector.strip()
            if not _SIMPLE_SEL.match(selector):
                continue
            keep = [d.strip() for d in decls.split(';')
                    if d.strip() and not _BAD_STYLE.search(d)]
            if keep:
                rules.append((selector, keep))
    return rules


def _apply_style_rules(tag, attrs, cleaned, rules):
    """把 <style> 里匹上的规则并进元素的 style 属性；元素自己写的 style **优先**。"""
    if not rules:
        return cleaned
    values = {str(n or '').lower(): (v or '') for n, v in attrs}
    class_names = set(values.get('class', '').split())
    element_id = values.get('id', '').strip()
    matched = []
    for selector, decls in rules:
        if selector.startswith('.'):
            if selector[1:] in class_names: matched.extend(decls)
        elif selector.startswith('#'):
            if element_id and selector[1:] == element_id: matched.extend(decls)
        elif selector == tag:
            matched.extend(decls)
    if not matched:
        return cleaned
    existing = next((v for n, v in cleaned if n == 'style'), '')
    present = {p.split(':', 1)[0].strip().lower()
               for p in existing.split(';') if p and ':' in p}
    add = [d for d in matched if d.split(':', 1)[0].strip().lower() not in present]
    if not add:
        return cleaned
    merged = ';'.join(([existing.rstrip(';')] if existing else []) + add)
    return [(n, merged if n == 'style' else v) for n, v in cleaned] if existing \
        else cleaned + [('style', merged)]


def sanitize_html(value):
    """进存储/进DOM前净化：保留表格结构、合并格与受管CID，剥脚本、事件属性和外链图片。

    不放开任意外部图片请求；只有 cid: 引用保留。合并信息(colspan/rowspan)属正文结构，不能误伤。
    """
    out = []
    rules = _style_rules(value)
    class Sanitizer(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.open = []
        def handle_starttag(self, tag, attrs, self_closing=False):
            if tag in _DROP_VOID:
                return
            if tag in _DROP_PAIR:
                if not self_closing:
                    self.open.append(tag)   # 只有**真的成对**的才记账
                return
            # <body> 一到就说明 head 段结束了 —— HTML 允许省略 </head>，
            # 这里按同一套规矩收掉还开着的 head 段标签，否则后面的正文全被吞。
            if tag == 'body' or (self.open and self.open[-1] in _HEAD_SCOPED):
                self.open = [t for t in self.open if t not in _HEAD_SCOPED]
            if self.open or tag not in _KEEP_TAGS:
                return
            keep = _KEEP_ATTRS.get(tag, set())
            cleaned = []
            for name, val in attrs:
                name = (name or '').lower()
                # srcset 能拉外部图，与 src 同等对待；style 单独走下面的安全过滤。
                if name.startswith('on') or name == 'srcset':
                    continue
                if name == 'style':
                    if val and not _BAD_STYLE.search(val):
                        cleaned.append(('style', val))
                    continue
                if name not in keep:
                    continue
                if name == 'src':
                    val = (val or '').strip()
                    # 只认受管 CID 引用；外部图片一律丢弃，不发起外链请求。
                    if not _CID_RE.match(val):
                        continue
                if name == 'href':
                    val = (val or '').strip()
                    if not re.match(r'^(?:https?:|mailto:|#)', val, re.I):
                        continue
                if name == 'bgcolor':
                    # bgcolor 是颜色不是地址，但只认颜色写法，别让 url() 混进来。
                    val = (val or '').strip()
                    if not _COLOR.match(val):
                        continue
                cleaned.append((name, val or ''))
            # <style> 里的排版规则落到元素上 —— 块本身等下会被丢掉。
            cleaned = _apply_style_rules(tag, attrs, cleaned, rules)
            if tag == 'img' and not any(name == 'src' for name, _ in cleaned):
                return  # 不保留已剥除外链来源的空图片占位。
            rendered = ''.join(
                f' {n}="{(v or "").replace(chr(34), "&quot;")}"' for n, v in cleaned)
            if tag in ('br',):
                out.append(f'<{tag}{rendered} />')
            else:
                out.append(f'<{tag}{rendered}>')
        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs, self_closing=True)
            if tag not in _DROP_WITH_CONTENT and tag not in ('br','img') and not self.open:
                out.append(f'</{tag}>')
        def handle_endtag(self, tag):
            if tag in _DROP_PAIR:
                # 只收这一层，不靠计数猜配平 —— 没闭合的就让它开着，不影响后面的兄弟。
                if tag in self.open:
                    self.open.remove(tag)
                return
            if tag == 'img' or tag in _DROP_VOID or tag in _DROP_TAG_ONLY or self.open or tag not in _KEEP_TAGS:
                return
            out.append(f'</{tag}>')
        def handle_data(self, data):
            if not self.open and data:
                out.append(data.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))
    parser = Sanitizer()
    parser.feed(str(value or ''))
    parser.close()
    return ''.join(out)


def referenced_cids(value):
    """正文中被引用的受管内联资源 Content-ID 列表，用于核对引用与资源同次生效。"""
    return list(dict.fromkeys(_CITE_RE.findall(str(value or ''))))


def _text(part):
    payload = part.get_payload(decode=True) or b''
    return payload.decode(part.get_content_charset() or 'utf-8',errors='replace')


def _header(value,limit=1000):
    return re.sub(r'[\r\n\x00-\x1f\x7f]',' ',str(value or ''))[:limit].strip()


def parse_message(content):
    if len(content) > MAX_MESSAGE_BYTES:
        raise ValueError('邮件超过28MiB接收上限，请在原邮箱查看')
    message = BytesParser(policy=email.policy.default).parsebytes(content)
    attachments=[]; plain=[]; html=[]; inline=[]
    for part in message.walk():
        if part.is_multipart(): continue
        filename = part.get_filename()
        content_id = (part.get('Content-ID') or '').strip().strip('<>')
        disposition = part.get_content_disposition()
        if content_id and disposition != 'attachment':
            # 受管内联资源：保留 Content-ID 与原始 MIME 类型，正文用 cid: 引用。
            value = part.get_payload(decode=True) or b''
            if len(value) > MAX_ATTACHMENT_BYTES or len(inline) >= 20:
                raise ValueError('邮件内联资源超过20MiB或20个限制，请在原邮箱查看')
            inline.append({'content_id':_header(content_id,200),
                           'mime_type':part.get_content_type(),
                           'name':_header(filename or f'{content_id}.bin',255),
                           'disposition':'inline','content':value})
            continue
        if filename or disposition == 'attachment':
            value = part.get_payload(decode=True) or b''
            if len(value)>MAX_ATTACHMENT_BYTES or len(attachments)>=20:
                raise ValueError('邮件附件超过20MiB或20个限制，请在原邮箱查看')
            clean = _header(filename or '附件.bin',255).replace('/','_').replace('\\','_')
            attachments.append({'name':clean,'content':value,'mime_type':part.get_content_type()})
        elif part.get_content_type()=='text/plain': plain.append(_text(part))
        elif part.get_content_type()=='text/html': html.append(_text(part))
    # HTML 正文留存：净化后按 HTML 保存，表格与合并格不丢；纯文本作替代。
    body_format = 'HTML' if html else 'Text'
    if html:
        body = sanitize_html('\n'.join(html))
    else:
        body = '\n'.join(plain)
        parser=_Text(); parser.feed(body); body=''.join(parser.values)
    if len(body)>100000: raise ValueError('邮件正文超过10万字，请在原邮箱查看')
    return {'subject':_header(message.get('Subject'),500),'body':body,'body_format':body_format,
            'from_address':_header(message.get('From')),'to':[_header(value) for value in message.get_all('To',[])],
            'cc':[_header(value) for value in message.get_all('Cc',[])],
            # Reply-To 优先于原发件人（RFC 5322）：原信指定了回信地址就该回那里。
            # 刻意**不解析 Bcc** —— 用户 2026-10-12 要求「不泄露也不推断 Bcc」。
            'reply_to_address':_header(message.get('Reply-To')),
            'message_id':_header(message.get('Message-ID'),998),'in_reply_to':_header(message.get('In-Reply-To'),998),
            'attachments':attachments,'inline_resources':inline,'date':_header(message.get('Date'),100)}


def inbox_uids(connection):
    status, data = connection.uid('search',None,'ALL')
    if status != 'OK': raise ValueError('无法读取收件箱目录')
    validity = connection.response('UIDVALIDITY')[1]
    validity = validity[0].decode() if validity and isinstance(validity[0],bytes) else str(validity[0] if validity else '')
    if not validity or not validity.isdigit(): raise ValueError('服务商未提供有效的收件箱标识')
    return validity, sorted([int(value) for value in (data[0] or b'').split()])


def fetch_message(connection,uid):
    status, data = connection.uid('fetch',str(uid),'(RFC822.SIZE)')
    joined = b' '.join(value for value in data or [] if isinstance(value,bytes))
    size = re.search(rb'RFC822.SIZE\s+(\d+)',joined)
    if status != 'OK' or not size: raise ValueError('无法核对邮件大小')
    if int(size[1])>MAX_MESSAGE_BYTES: raise ValueError('邮件超过28MiB接收上限，请在原邮箱查看')
    status, data = connection.uid('fetch',str(uid),'(BODY.PEEK[])')
    values = [value[1] for value in data or [] if isinstance(value,tuple) and isinstance(value[1],bytes)]
    if status != 'OK' or len(values)!=1: raise ValueError('邮件读取失败，请稍后同步')
    return parse_message(values[0])
