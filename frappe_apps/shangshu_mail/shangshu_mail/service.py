"""私人邮件单一事实；草稿、收发及回收统一公共 Action。"""
import json
import re
from contextlib import contextmanager

import frappe
from frappe.utils import now_datetime
from shangshu_mail import account, unread_query
from shangshu_mail.quoting import restore_cids
from shangshu_mail.domain import DOCTYPE
from shangshu_core.public_api import bind_record_attachments, get_record_attachments

@contextmanager
def writing():
    previous = getattr(frappe.flags, 'shangshu_mail_write', False)
    frappe.flags.shangshu_mail_write = True
    try:
        yield
    finally:
        frappe.flags.shangshu_mail_write = previous

def _scope_sql(user):
    """邮件可见面的 SQL 片段。**两个条件都要**：

    · 共享箱：授权表说了算（N5-1 归属按邮箱算，不按收信人算）
    · 个人箱 / 旧信：还得 `owner = 本人` —— **改归属就是把这封信转走了**
      （重放守卫 B5 靠这条挡住「撤权后重放把正文换出来」，删不得）

    只按 mailbox_id 判会绕过重放守卫：管理员把 owner 改成别人之后，
    mailbox_id 还是原主的个人箱键，照样读得到正文。
    """
    personal = account.account_name(user)
    shared = [i for i in account.readable_mailbox_ids(user) if i != personal]
    parts = []
    if shared:
        parts.append('`tabShangshu Mail Message`.`mailbox_id` in (%s)'
                     % ','.join(frappe.db.escape(i) for i in shared))
    parts.append('(`tabShangshu Mail Message`.`mailbox_id` = %s'
                 ' AND `tabShangshu Mail Message`.`owner` = %s)'
                 % (frappe.db.escape(personal), frappe.db.escape(user)))
    # 旧信还没挂邮箱的 —— N5-1「旧个人邮箱及其原信不丢」
    parts.append('(`tabShangshu Mail Message`.`mailbox_id` is null'
                 ' AND `tabShangshu Mail Message`.`owner` = %s)' % frappe.db.escape(user))
    return '(' + ' OR '.join(parts) + ')'

def permission_query(user=None):
    user = user or frappe.session.user
    return _scope_sql(user)

def has_permission(doc, user=None, permission_type=None):
    user = user or frappe.session.user
    if user == 'Guest':
        return False
    mailbox = getattr(doc, 'mailbox_id', None)
    if not mailbox:
        # 旧信还没挂邮箱的，仍按本人归属 —— 同上，不丢旧信也不漏正文。
        return doc.owner == user
    if mailbox == account.account_name(user):
        # 我个人箱里的信：**还得归我**。改归属 = 转走了，我不该再看得见。
        return doc.owner == user
    return mailbox in account.readable_mailbox_ids(user)

def message(name, lock=False):
    doc = frappe.get_doc(DOCTYPE, name, for_update=lock)
    if not has_permission(doc):
        frappe.throw('只能访问自己邮箱或已获授权邮箱里的邮件', frappe.PermissionError)
    return doc

def require_mail_management(doc):
    """共用邮件的回收/恢复必须有明确 manage 权；读取、编辑草稿及代发不授予它。"""
    mailbox = doc.get('mailbox_id')
    # 兼容尚未挂邮箱的旧个人信；调用前仍由 message() 核本人归属。
    if not mailbox and doc.owner == frappe.session.user:
        return
    if not account.rights_for(mailbox).get('manage'):
        frappe.throw('当前没有该邮箱的邮件管理权限，不能删除或恢复邮件', frappe.PermissionError)

def require_draft_edit(doc):
    """以记录实际所在邮箱核编辑权，不依赖客户端是否带 mailbox。"""
    mailbox = doc.get('mailbox_id') or account.account_name(doc.owner)
    account.require_right(mailbox, 'edit_draft')

def proposal_guard(action_id, payload, purpose, actor_user):
    """提案显示/裁决检查真实邮箱；actor_user 是核心记录的可信发起者。"""
    if purpose not in ('read', 'resolve'):
        frappe.throw('未知的提案权限检查类型', frappe.ValidationError)
    value = payload if isinstance(payload, dict) else {}
    name = value.get('mail')
    if action_id == 'mail.sync':
        if not actor_user or actor_user != frappe.session.user:
            frappe.throw('只能查看或处理本人邮箱的同步提案', frappe.PermissionError)
        account.require_right(account.account_name(actor_user), 'read')
        return
    if action_id not in ('mail.save_draft', 'mail.send'):
        frappe.throw('此邮件动作不支持提案审核', frappe.PermissionError)
    if name:
        doc = message(name, lock=purpose == 'resolve')  # 始终核源邮件，不能用客户端目标箱替代。
        mailbox = doc.get('mailbox_id') or account.account_name(doc.owner)
        if purpose == 'resolve':
            if action_id == 'mail.save_draft':
                require_draft_edit(doc)
            else:
                account.require_right(mailbox, 'send')
        if action_id == 'mail.save_draft' and value.get('mailbox'):
            account.require_right(value['mailbox'], 'read' if purpose == 'read' else 'edit_draft')
        return
    if action_id != 'mail.save_draft':
        frappe.throw('发送提案缺少实际草稿目标', frappe.PermissionError)
    mailbox = value.get('mailbox')
    if not mailbox:
        if not actor_user:
            frappe.throw('新草稿提案缺少可信的发起人邮箱绑定', frappe.PermissionError)
        # 旧本人新稿仍可用；不按审核人派生个人箱来读到别人的候选正文。
        mailbox = account.account_name(actor_user)
        if purpose == 'resolve' and frappe.session.user != actor_user:
            frappe.throw('其他员工的新个人草稿须明确邮箱并授权后才能审核', frappe.PermissionError)
    account.require_right(mailbox, 'read' if purpose == 'read' else 'edit_draft')

def replay_guard(payload, request=None):
    """重放守卫（B5，公共入口在同键重放取旧结果前调用）：按**当前**归属复核。

    邮件的 `mail.save_draft` / `mail.recycle` / `mail.restore` 回的都是
    `projection(doc, True)` —— 带正文、附件、内联图。这些结果会加密缓存在
    `Shangshu Action Request` 里，同键重放时原样解密吐回。

    撤权/改归属之后，旧回执不该再把正文换出来（B 发现的 M7 缺口）：
    角色每次都会复核，跨人重放也被 `assert_binding` 挡住，
    剩下的缺口就是**同一个人、对这封信的归属没了之后**重放。

    定位是哪封信有两条路：
      · 载荷里带 `mail`（编辑/回收/恢复已存在的信）—— 直接用
      · 载荷里没有（**新建草稿**，那封信是那次才建出来的）—— 从请求缓存的
        结果里认出刚建的那封。只窥结果、不当响应放行；判无权就整请求拒。
        攻动者没法往载荷里补编号：`assert_binding` 要求重放载荷与原请求指纹一致。

    不归你 → 权限错整请求拒。认不出对象（极老的请求/结果缺失）也拒，
    **不静默放行** —— 这条守卫的意义就是「拿不准就不给」。
    """
    name = str((payload or {}).get('mail') or '')
    if not name and request is not None:
        from shangshu_core.public_api import peek_result
        result = peek_result(request)
        name = str((result or {}).get('name') or '')
    if not name or not frappe.db.exists(DOCTYPE, name):
        # 新建类动作若连对象都认不出来，宁可拒 —— 漏出去的是正文。
        if request is not None:
            frappe.throw('无法核实本次重放对应哪封邮件，已拒绝返回旧结果；请用新的请求重试',
                         frappe.PermissionError)
        return
    doc = message(name)
    # 回收/恢复的旧成功回包同样复核当前动作权，撤去 manage 后不得只凭读权重放。
    if request is not None and request.get('action_id') in ('mail.recycle', 'mail.restore'):
        require_mail_management(doc)
    elif request is not None and request.get('action_id') == 'mail.save_draft':
        require_draft_edit(doc)

def addresses(values):
    result=[]; seen=set()
    for value in values:
        if not isinstance(value,str) or any(ord(c)<32 or ord(c)==127 for c in value):
            frappe.throw('收件邮箱格式无效', frappe.ValidationError)
        value=value.strip()
        named=re.fullmatch(r'([^<>;,，；]+?)\s*<([^<>]+)>',value)
        display=named[1].strip().strip('"').strip("'").strip() if named else ''
        address=named[2].strip() if named else value
        # 剥掉外层引号和 mailto: 前缀，再校验 —— 用户 2026-10-12 报
        # 「mailto is not a valid Email Address」：带引号的 "mailto:x@y.com"
        # 会原样带着前缀进库、进收件人头。前端已洗，这里是第二道关，
        # 防别的入口（API / 收件 / 助手）绕过前端送脏地址进来。
        address=address.strip().strip('"').strip("'").strip()
        address=re.sub(r'^mailto:', '', address, flags=re.IGNORECASE).strip()
        if not re.fullmatch(r'[^\s@<>;,，；]+@[^\s@<>;,，；]+\.[^\s@<>;,，；]+',address):
            frappe.throw('收件邮箱格式无效', frappe.ValidationError)
        if address.casefold() not in seen:
            result.append(f'{display} <{address}>' if display else address)
            seen.add(address.casefold())
    return result

READ = 'Shangshu Mail Read'
_DEPT_KIND_CACHE = {}

def _is_department(mailbox_id):
    """这个箱是不是部门箱（决定要不要显示「部门未读」点）。"""
    if not mailbox_id: return False
    if mailbox_id in _DEPT_KIND_CACHE: return _DEPT_KIND_CACHE[mailbox_id]
    row = frappe.db.get_value(account.DOCTYPE, {'account_key': mailbox_id}, 'kind')
    _DEPT_KIND_CACHE[mailbox_id] = (row == 'department')
    return _DEPT_KIND_CACHE[mailbox_id]

def mark_read(doc, read, user=None):
    """标读 / 标未读。**读信状态按人记**（N5-4）。

    · 个人点 = 我读过没有 → `Shangshu Mail Read` 一人一行
    · 部门点 = 有没有任一获权成员读过 → 信上 `dept_read_at`，**写了不再改**
      （后来的人标未读不撤销这个部门已读事实）
    · **不改 `record_version`** —— 别人读信不该让正在编辑的稿件冒出冲突
    """
    user = user or frappe.session.user
    now = now_datetime()
    # 这里只动**阅读记录**和信上的字段；`doc.save` 由 execute 末尾统一做一次，
    # 不要在这里再存 —— 会存两遍。
    with writing():
        existing = frappe.db.get_value(READ, {'mail': doc.name, 'user': user}, 'name')
        if read:
            if existing:
                frappe.db.set_value(READ, existing, 'read_at', now, update_modified=False)
            else:
                frappe.get_doc({'doctype': READ, 'mail': doc.name,
                                'user': user, 'read_at': now}).insert(ignore_permissions=True)
        elif existing:
            frappe.get_doc(READ, existing).delete(ignore_permissions=True)
    if read:
        # 兼容旧口径：read_at 仍是「这封被读过」，个人箱的未读筛选靠它。
        doc.read_at = now
        # 部门点：任一获权成员读过就消，且**只消一次**（不重复减部门未读数）。
        if _is_department(doc.mailbox_id) and not doc.get('dept_read_at'):
            doc.dept_read_at = now
    else:
        # 只清**我**这条的痕迹；部门已读事实不动
        # （N5-4 表：李四标未读不撤销部门已有阅读事实）。
        doc.read_at = None

def read_state(names, user=None):
    """批量取这些信的两个点：我读过没有 / 部门有人读过没有。"""
    user = user or frappe.session.user
    if not names: return {}
    mine = {r.mail for r in frappe.get_all(READ, filters={'user': user, 'mail': ['in', list(names)]},
                                           fields=['mail'])}
    rows = frappe.get_all(DOCTYPE, filters={'name': ['in', list(names)]},
                          fields=['name', 'mailbox_id', 'dept_read_at', 'status'])
    out = {}
    for row in rows:
        dept = _is_department(row.mailbox_id)
        out[row.name] = {
            # 个人点：**我**读过没有。个人箱没有「部门点」这回事。
            'my_unread': row.name not in mine,
            'dept_unread': bool(dept and not row.dept_read_at),
        }
    return out

def projection(doc, body=False, state=None):
    """`state` 是这一封的双未读点（见 read_state）。
    列表路径由 query **批量**算好传进来 —— 一行一查会拖垮列表
    （计划 N5 有「邮件列表冷开可操作≤2s」的门槛）。详情路径自己算。"""
    if state is None:
        state = read_state([doc.get('name')]).get(doc.get('name')) or {}
    data={key:doc.get(key) for key in ('name','subject','status','record_version','owner','modified','mailbox_id')}
    # **关联案件**（§8 第 10 项）：这封信是哪个案件的（只是编号，不授予权限）。
    data['case_ref']=doc.get('case_ref') or ''
    data['to']=json.loads(doc.get('to_json') or '[]')
    data['cc']=json.loads(doc.get('cc_json') or '[]')
    attachment_ids=json.loads(doc.get('attachment_ids_json') or '[]')
    data['attachment_count']=len(attachment_ids)
    for key in ('from_address','received_at','sent_at','message_id','reply_to_mail','reply_to_address','delivery_error','delivery_started_at','previous_status','read_at'):
        data[key]=doc.get(key) or ''
    # 双未读点（N5-4）：**两个点各有各的**，已读后点消失、不是换个颜色。
    #  · my_unread   —— **我**读过没有（按人记，别人读了不影响我）
    #  · dept_unread —— 有没有任一获权部门成员读过（个人箱没这个点）
    received = doc.get('status') == 'Received'
    data['my_unread'] = received and bool(state.get('my_unread', not doc.get('read_at')))
    data['dept_unread'] = received and bool(state.get('dept_unread', False))
    # 旧字段 `unread` 保持「我这边还没读」的口径，列表小圆点/加粗照旧。
    data['unread'] = data['my_unread']
    data['rejected']=json.loads(doc.get('rejected_json') or '[]')
    data['transport_capability']='smtp_imap_v1'
    if body:
        data['body']=doc.get('body') or ''
        data['body_format']=doc.get('body_format') or 'Text'
        data['signature_guard']=doc.get('signature_guard') or ''
        data['attachments']=get_record_attachments(DOCTYPE,doc.name,attachment_ids)
        labels=json.loads(doc.get('attachment_labels_json') or '{}')
        # 「已入库」标记 —— 收信时附件**自动**进文件中心（C10），
        # 已经进去的不该再给用户一个「存入文件中心」按钮（用户 10-14 批注 6-1）。
        # 但**不删手动入口**：没进去的（导入失败/历史信）仍要能手动补 ——
        # 自动化不能是唯一路径（CLAUDE.md 六）。
        # 认不认「已入库」以**文件域自己的版本行为准**，走它公开声明的只读口
        # `files.imported_of`（见 delivery.imported_of），不直查它的内部表。
        # **一次把这封信的附件全问了**，别一行一查。
        from shangshu_mail.delivery import imported_of
        infos = imported_of([item.get('file') for item in data['attachments']]) \
            if data['attachments'] else {}
        for item in data['attachments']:
            display=labels.get(item['file'],{})
            if isinstance(display,str): display={'label':display}
            item['label']=display.get('label','')
            item['name']=display.get('name') or item['name']
            item['source']={'ref_doctype':DOCTYPE,'ref_name':doc.name,'file':item['file']}
            info = infos.get(str(item['file'])) or {}
            # 认 **`imported`**，不是 `known` —— 两者是两件事，不许合并。
            # `restricted:true` 也算 True（它确实进过了，界面就不该再给「存入」按钮）。
            item['imported'] = bool(info.get('imported'))
            # 顺手带出来，将来界面要显示「已入库（无权查看）」用得上。
            # **界面这一轮不改**（mail-center.js 是内核路径）。
            item['imported_restricted'] = bool(info.get('restricted'))
        data['attachment_capability']='fixed_references_v2'
        # 受管内联资源：content_id 与 MIME 类型必须随正文同次返回，正文 cid: 引用才解析得了。
        data['inline_resources']=json.loads(doc.get('inline_resources_json') or '[]')
        data['inline_capability']='managed_cid_v1'
    return data

def _drop_script_content(value):
    """先把危险标签连同内容删掉，再交给 bleach。

    bleach 的 strip=True 只剥标签本身，会把 <script>steal()</script> 的内容
    当普通文本留在正文里；接收净化器是连内容删的，两边必须对齐，否则保存路径漏脚本。

    **成对正则不够**：标签没闭合时删不掉，源码反而被 bleach 当正文吐出来
    （`<script>alert(1)<p>正文</p>` → 正文里出现 `alert(1)`，对端看得见）。
    没闭合的就从那个标签一路丢到末尾 —— 与浏览器一致：`<script>`/`<style>` 的内容
    是原始文本直到闭合标签，本来就会吞掉后面的东西。
    `form` 只丢标签本身，**里面的字是正文**（退订句、提示语）。
    """
    out = str(value or '')
    for tag in ('script', 'style', 'iframe', 'object', 'embed', 'title'):
        while True:
            open_m = re.search(rf'<\s*{tag}\b[^>]*>', out, re.I)
            if not open_m:
                break
            close_m = re.search(rf'<\s*/\s*{tag}\s*>', out[open_m.end():], re.I)
            end = open_m.end() + close_m.end() if close_m else len(out)
            out = out[:open_m.start()] + out[end:]
    # 空标签与 form：只丢标签本身
    out = re.sub(r'<\s*/?\s*(?:base|link|meta|form)\b[^>]*>', '', out, flags=re.I)
    return out

def _img_attrs(tag, name, value):
    """只认受管 CID 内联图；外部图片一律丢弃，不放开任意外部图片请求。"""
    if name in ('alt', 'width', 'height'):
        return True
    if name == 'src':
        return bool(re.match(r'^cid:[A-Za-z0-9._@+-]{1,200}$', (value or '').strip()))
    return False

# bleach 的 CSS 白名单只管**属性名**，不看**值** —— `background:url(https://evil…)`
# 只要放行了 background 就整条过。危险值必须另外拦（与接收端 transport._BAD_STYLE 同一口径）。
_CSS_DANGER = re.compile(r'(?:expression|javascript:|url\s*\(|@import|behavior\s*:)', re.I)


def _attr_filter(allow):
    """包一层属性过滤：先认白名单，再挡 style 的危险**值**。

    白名单要按 bleach 的原样合并 —— `'*'` 是**所有标签通配**，
    不是「别的标签都没有」。合并错了会把 `td` 上的 `style` 整个拒掉。
    """
    def decide(tag, name, value):
        if name == 'style' and _CSS_DANGER.search(str(value or '')):
            return False
        for key in (tag, '*'):
            rule = allow.get(key)
            if callable(rule):
                if rule(tag, name, value):
                    return True
            elif isinstance(rule, (list, set, tuple)) and name in rule:
                return True
            elif rule is True:
                return True
        return False
    return decide


def html_body(value):
    """沿Frappe已有bleach依赖净化正文；不执行模板，不加载外部图片。

    保留表格结构与合并单元格(colspan/rowspan)；图片只认受管 CID 引用。
    """
    import bleach
    from bleach.css_sanitizer import CSSSanitizer
    from bleach.html5lib_shim import Filter
    class ManagedImageFilter(Filter):
        def __iter__(self):
            for token in super().__iter__():
                if token.get('name') == 'img' and token.get('type') in ('StartTag','EmptyTag'):
                    src = token.get('data', {}).get((None, 'src'), '')
                    if not re.fullmatch(r'cid:[A-Za-z0-9._@+-]{1,200}', src):
                        continue
                yield token
    cleaner = bleach.Cleaner(
        tags={'a','b','blockquote','br','div','em','font','li','ol','p','span','strong',
              'table','tbody','td','tfoot','th','thead','tr','u','ul','img'},
        attributes=_attr_filter({'*':['style'],'a':['href','title'],
                    'font':['color','face','size'],
                    'table':['border','cellpadding','cellspacing','width','role','align','valign','bgcolor'],
                    'tr':['align','valign','bgcolor'],
                    'td':['colspan','rowspan','align','valign','width','nowrap','height','bgcolor'],
                    'th':['colspan','rowspan','align','valign','width','nowrap','height','bgcolor'],
                    'img':_img_attrs}),
        protocols={'http','https','mailto','cid'},strip=True,filters=[ManagedImageFilter],
        css_sanitizer=CSSSanitizer(allowed_css_properties=[
            # `background` 简写必须在 —— 只留 background-color 的话，
            # 真实邮件和刚内联进来的 `.hd{background:#12263f}` 一保存就被剥掉
            # （用户 2026-10-13：「表头颜色发不出去」）。`white-space` 是回复引用
            # 保住纯文本换行用的，被剥就又压成一段。
            'background','background-color','border','border-collapse','border-color',
            'border-style','border-width','border-top','border-bottom','border-left','border-right',
            'color','font-family','font-size','font-style','font-weight','height','line-height',
            'margin','margin-top','margin-bottom','margin-left','margin-right',
            'max-width','min-width','padding','padding-bottom','padding-left','padding-right','padding-top',
            'text-align','text-decoration','text-indent','text-transform','vertical-align','white-space','width']))
    return cleaner.clean(_drop_script_content(value))

def read_payload(payload):
    """读一封信 —— **一份实现**（`mail.detail` 服务与 `mail.read` 动作共用这一段）。

    · 权限判定与 `mail.detail` **同一道门**（`message()` 的归属检查）：
      不是本人/获权邮箱里的信 ⇒ **当场拒并说得出原因**，
      **不**给空正文冒充「这封信是空的」。
    · **只读**：不改任何东西、不存库、不标已读、不动 `record_version`。
    · 正文里的外部内容**按现有净化口径**再过一道（`html_body`，与保存/收信同一套）：
      脚本、事件属性、外链图不回来。
    """
    value = payload if isinstance(payload, dict) else {}
    name = str(value.get('mail') or '').strip()
    if not name:
        frappe.throw('缺少邮件编号（mail）：读信要指明读哪一封', frappe.ValidationError)
    doc = message(name)  # 归属/读权判定（与 mail.detail 同一道门）
    expected = value.get('expected_version')
    if expected is not None:
        try:
            expected = int(expected)
        except (TypeError, ValueError):
            frappe.throw('expected_version 必须是整数', frappe.ValidationError)
        if expected != int(doc.record_version or 0):
            frappe.throw('邮件已更新，请重新读取后再看；本次未返回内容',
                         frappe.TimestampMismatchError)
    data = projection(doc, True)
    if str(data.get('body_format') or 'Text') == 'HTML':
        # 读面是 agent 直接看的正文 ⇒ **按现有净化口径再过一道**（同一个 html_body），
        # 不因为「库里存着就信它」（历史遗留的脏行也走这道门）。
        data['body'] = html_body(data.get('body') or '')
    return data


def reply_or_forward_payload(action, payload, _context):
    """回复/转发：**一份实现**（`shangshu_mail.quoting`）—— 人点与 agent 调动作共用。

    返回给 `mail.save_draft` 那条路用的载荷：
      · 正文 = 新写的字 ＋ 引用块（**内联图已换成文件中心的路径索引**）；
      · 随草稿带走的 `inline_resources` = 原信那张图（草稿自己也要显示得出）；
      · 主题默认 `Re: `/`Fwd: ` + 原信主题（调用方给了就用调用方的）。

    原信编号没给、或原信读不到 ⇒ **当场拒并说得出原因**（不生成空引用的草稿）。
    """
    from shangshu_mail import quoting
    original_id=str(payload.get('reply_to_mail') or '').strip()
    try:
        # 原信读不到 / 已回收 ⇒ 当场拒并说得出原因（公共实现里那一条）。
        original=quoting.require_original(original_id, message)
    except quoting.OriginalNotReadable as error:
        frappe.throw(str(error), frappe.ValidationError)
    user=_context.get('user') or frappe.session.user
    signature=quoting.default_signature(str(payload.get('mailbox') or ''), user=user)
    built=quoting.build_reply_body(original, payload.get('body') or '', user=user, signature=signature)
    subject=str(payload.get('subject') or '').strip()
    if not subject:
        prefix='Re: ' if action=='mail.reply' else 'Fwd: '
        subject=prefix+(original.get('subject') or '')
    result=dict(payload)
    result['body']=built['body']
    result['body_format']='HTML'
    result['subject']=subject
    result['reply_to_mail']=original_id
    if built['inline_resources']:
        result['inline_resources']=built['inline_resources']
    return result


def bind_managed_attachments(payload):
    """把**受管文件**（文件中心里的）绑定到一封信上 —— **绑的是引用，字节不动**。

    为什么要有它（2026-10-22 · PKG-036-T03）：
    · 字节**必须**由文件域放（契约「所有进尚书的文件都进文件中心」）；
    · 这封信上的图**还要能按这封信的归属取字节**（读信面按这封信取附件；
      正文 `cid:` 引用要解析得出图 —— 出站净化门只认 `cid:`）⇒ 需要一个**挂在信上的引用**；
    · 内核 `bind_record_attachments` 走 Frappe v15 的 `create_attachment_copy`，
      原话是「**reusing `file_url`**」⇒ **同一个磁盘文件、两个身份** ⇒ 字节仍然只有一份。

    ⚠️ **为什么必须是「本域的公共动作」**：内核那道闸核的是「当前调用域 == 记录归属域 == 动作属主」
    ⇒ 绑定**只能**由邮件域自己的动作发起（后台任务里直接调会被拒：
    「附件绑定必须由所属领域的公共动作执行」）。
    """
    from shangshu_core.public_api import invoke_domain_service

    payload = payload or {}
    mail = str(payload.get('mail') or '').strip()
    files = [str(item).strip() for item in (payload.get('files') or []) if str(item).strip()]
    if not mail or not files:
        frappe.throw('邮件编号与受管文件清单都要给', frappe.ValidationError)
    doc = message(mail, lock=True)          # 核这封信在、且当前人有它的读权
    rows = []
    for file_id in files:
        history = invoke_domain_service('files.versions', {'file': file_id})
        current = history.get('current') or {}
        frappe_file = str(current.get('frappe_file') or '')
        if not frappe_file:
            frappe.throw('受管文件 %s 没有可绑定的固定版本' % file_id, frappe.ValidationError)
        rows.append(frappe_file)
    bound = bind_record_attachments(DOCTYPE, doc.name, rows)
    return {'mail': doc.name, 'files': [str(item.get('file') or '') for item in bound]}


def execute(action, payload, _context):
    if action == 'mail.attachment.bind':
        return bind_managed_attachments(payload)
    if action == 'mail.read':
        # 只读：直接回读到的内容 —— **不碰** record_version、不存库、不标已读。
        # 读取与权限判定与 `mail.detail` 同一份实现（`read_payload`）。
        return read_payload(payload)
    if action in ('mail.reply','mail.forward'):
        # 回复/转发**不是另一套保存逻辑** —— 载荷算好后交给 `mail.save_draft` 那条路。
        payload=reply_or_forward_payload(action, payload, _context)
        action='mail.save_draft'
    if action in ('mail.send','mail.sync'):
        if action == 'mail.send':
            doc = message(payload['mail'], lock=True)
            account.require_right(doc.get('mailbox_id') or account.account_name(doc.owner), 'send')
            from shangshu_core.public_api import assert_no_pending_proposal_reviews
            assert_no_pending_proposal_reviews({'module':'mail','mail':doc.name})
        from shangshu_mail.delivery import queue_send, sync
        return (queue_send if action=='mail.send' else sync)(payload,_context)
    bindings={}
    supplied_labels={item['file']:{key:item[key] for key in ('label','name') if key in item} for item in payload.get('attachment_labels',[])}
    if set(supplied_labels)-set(payload.get('attachments',[])):
        frappe.throw('附件展示标签必须对应本次选择',frappe.ValidationError)
    name=payload.get('mail')
    if name:
        doc=message(name,lock=True)
        if payload.get('expected_version') != doc.record_version:
            frappe.throw('邮件已更新，请刷新后再操作；当前修改未保存', frappe.TimestampMismatchError)
    else:
        doc=frappe.new_doc(DOCTYPE)
        doc.status='Draft'
        doc.record_version=0
    if action=='mail.save_draft':
        if doc.status != 'Draft':
            frappe.throw('只有草稿可以编辑；已发送与收到的邮件不能改写', frappe.ValidationError)
        if name:
            # 合并说明：fast 那边把这行内联成
            # `account.require_right(doc.mailbox_id or account.account_name(doc.owner),'edit_draft')`，
            # 本分支的 `require_draft_edit(doc)` **就是同一句**（以记录实际所在邮箱核编辑权，
            # 不依赖客户端是否带 mailbox）—— 取本分支的具名实现。
            require_draft_edit(doc)
        # T05「编辑页选哪个获权身份就用哪个」：草稿要**住**在那个箱里，
        # 发信时 From 才是那个箱（N5-3 已经按 mailbox 发，From 用这封信住的箱）。
        # 不带 mailbox = 老口径（before_insert 默认建者个人箱），个人收发不受影响。
        # 要的是**编辑草稿权**，不是读权 —— 能读不等于能写（N5-2 五项分开）。
        target=str(payload.get('mailbox') or '').strip()
        if target:
            account.require_right(target,'edit_draft')
            doc.mailbox_id=target
        to,cc=addresses(payload['to']),addresses(payload['cc'])
        if not (payload['subject'].strip() or payload['body'].strip() or to or cc or
                payload.get('attachments',json.loads(doc.get('attachment_ids_json') or '[]'))):
            frappe.throw('空草稿不保存', frappe.ValidationError)
        if 'signature_guard' in payload:
            if payload['signature_guard'] != 'inserted':
                frappe.throw('签名元数据无效', frappe.ValidationError)
            doc.signature_guard=payload['signature_guard']
        # **关联案件**（§8 第 10 项）：**带了才写**（不带 = 不改）——
        # 跟 mailbox 一个口径：省略这个字段**不许把已有的关联抹掉**。
        if 'case_ref' in payload:
            doc.case_ref=str(payload.get('case_ref') or '').strip()
        doc.subject=payload['subject']
        doc.body_format=payload.get('body_format') or doc.get('body_format') or 'Text'
        # 编辑期的 `data-managed-cid`（文件中心路径索引）**先还原成 `cid:`** ——
        # 出站净化门只认 `cid:`，不还原那张图就被当外链剥掉（转发出去是破图）。
        body_value = (restore_cids(payload['body'])
                      if doc.body_format=='HTML' else payload['body'])
        doc.body=html_body(body_value) if doc.body_format=='HTML' else payload['body']
        # 受管内联资源：正文 cid: 引用必须与本次资源同批生效，引用悬空则拒存，不静默丢图。
        inline_payload=[]
        if 'inline_resources' in payload:
            resources=payload.get('inline_resources') or []
            from shangshu_mail.transport import referenced_cids
            available={str(item.get('content_id') or '').strip().strip('<>')
                       for item in resources if item.get('content_id')}
            missing=set(referenced_cids(doc.body))-available
            if missing:
                frappe.throw('正文引用的内联图片未随本次保存提供：'+ '、'.join(sorted(missing)), frappe.ValidationError)
            inline_payload=[
                {'content_id':str(item['content_id']).strip().strip('<>'),
                 'mime_type':item.get('mime_type') or 'image/png',
                 'name':item.get('name') or 'inline.img',
                 'file':item.get('file') or ''}
                for item in resources if item.get('content_id')]
            doc.inline_resources_json=json.dumps(inline_payload,ensure_ascii=False)
        doc.to_json=json.dumps(to,ensure_ascii=False);doc.cc_json=json.dumps(cc,ensure_ascii=False)
        if 'reply_to_mail' in payload:
            original=message(payload['reply_to_mail']) if payload['reply_to_mail'] else None
            doc.reply_to_mail=original.name if original else None
            doc.in_reply_to=(original.message_id or '') if original else ''
    elif action=='mail.set_read':
        # 读信状态只对**收到的信**有意义：自己写的草稿、发出去的信没有「读过没有」这回事。
        if doc.status!='Received':
            frappe.throw('只有收到的邮件才有已读/未读；草稿和已发送的信没有这个状态', frappe.ValidationError)
        # **按人记**（N5-4）：我读过没有进 Shangshu Mail Read；
        # 部门那条「有人看过」另记在信上，两条互不牵连。
        # 改之前只有 doc.read_at 一个字段 —— 张三一读，李四的未读也跟着没了。
        mark_read(doc, bool(payload.get('read')))
    elif action in ('mail.recycle','mail.restore'):
        require_mail_management(doc)
        if doc.status in ('Queued','Sending'):
            frappe.throw('待发或发送中邮件不能移入回收站，请先核对结果',frappe.ValidationError)
        target='Trash' if action=='mail.recycle' else (doc.get('previous_status') or 'Draft')
        if action=='mail.restore' and doc.status!='Trash':
            frappe.throw('只有回收站邮件可以恢复',frappe.ValidationError)
        if doc.status==target:
            frappe.throw('邮件状态已改变，请刷新后操作', frappe.ValidationError)
        if action=='mail.recycle': doc.previous_status=doc.status
        doc.status=target
        doc.trashed_at=now_datetime() if target=='Trash' else None
    else:
        frappe.throw('不支持的邮件动作', frappe.ValidationError)
    # **读信不改内容版本**（N5-4）：`record_version` 是正文/草稿的版本，
    # 别人读一封信不该让正在编辑的稿件冒出「版本已更新」的冲突。
    # 改之前这里无条件 +1 —— 两个人轮流读，正在写回信的人就被莫名顶掉。
    if action!='mail.set_read':
        doc.record_version += 1
    # `bind_record_attachments` 用**模块顶部**从 `shangshu_core.public_api` 拿的那份
    # （第 9 行）。这里**刻意不再局部 import**：函数体里一旦出现 `from x import y`，
    # y 就被当成整个函数的局部变量 —— 此前它写在 `if inline_payload:` 里面，
    # 于是「有附件、无内联图」的草稿走到下面用它那行时还没赋值，
    # UnboundLocalError 500，存都存不上（N2-C5 正式页实测抓到）。
    # 而且局部那份原来直连 `shangshu_core.attachments` 私有模块，被
    # `check:platform-contract` 判 PRIVATE_CORE_IMPORT（B 2026-10-12 报）。
    # 删掉局部导入既修了遮蔽坑，也回到公共面。
    with writing():
        doc.save(ignore_permissions=True)
        if action=='mail.save_draft' and inline_payload:
            # 受管内联图必须**挂在这封信上**，内核 file_content 的挂载校验才放行。
            # 此前只把 file id 原样存进 inline_resources_json，File 仍挂在文件库记录上，
            # 于是「ref=Shangshu Mail Message」取字节被拒「该文件未挂在此记录上」——
            # 真实产品页上图就停在 cid: 显示不出来。
            # 与收件路径 delivery.py 建 File 的归属保持一致；附件也早已走同一条 bind。
            # 已挂在本信上的沿用（固定版本不变）；挂在别处的复制一份挂到本信。
            resolved=[]
            for item in inline_payload:
                if not item.get('file'):
                    resolved.append(item); continue
                bound=bind_record_attachments(DOCTYPE,doc.name,[item['file']])
                resolved.append({**item,'file':bound[0]['file']})
            doc.inline_resources_json=json.dumps(resolved,ensure_ascii=False)
            doc.save(ignore_permissions=True)
            inline_payload=resolved
        if action=='mail.save_draft' and 'attachments' in payload:
            attachments=bind_record_attachments(DOCTYPE,doc.name,payload['attachments'])
            old_labels=json.loads(doc.get('attachment_labels_json') or '{}')
            labels={}
            for item in attachments:
                bindings.update({source:item['file'] for source in item['source_files']})
                labels[item['file']]=next((supplied_labels[source] for source in item['source_files'] if source in supplied_labels),old_labels.get(item['file'],{}))
                if item.get('snapshot'):
                    # Server provenance, distinct from user-supplied display labels.
                    labels[item['file']]={**labels[item['file']], 'snapshot':item['snapshot']}
            doc.attachment_ids_json=json.dumps([item['file'] for item in attachments])
            # 显示备注属于邮件快照；绝不能据此定位原件或作授权判断。
            doc.attachment_labels_json=json.dumps(labels,ensure_ascii=False)
            doc.save(ignore_permissions=True)
    # **邮件域往统一日志库写过程记录**（§8 第 11 项）：
    # 「这封信存过了、谁存的、跟哪个案件有关」—— 痕迹进统一日志库，
    # **信的内容不进**（内容住在受管记录里）。**写日志失败不许把草稿搞没**：
    # 草稿已经存好了，日志只是补一笔痕迹 ⇒ 失败只记日志，不回滚草稿。
    if action=='mail.save_draft':
        try:
            from shangshu_mail.mailprocess import record_draft_saved
            record_draft_saved(doc, source=str((_context or {}).get('source') or 'user'),
                               is_new=not bool(name))
        except Exception as error:  # noqa: BLE001 —— 草稿已存好，痕迹写不上只通报
            frappe.logger('shangshu_mail').warning(
                '草稿已存好，但统一日志库那笔过程记录没写上：%s' % error)
    result=projection(doc,True)
    result['attachment_bindings']=bindings
    return result

def query(_dataset, filters=None, page=1, page_length=30):
    raw=filters or {}
    if not isinstance(raw,dict) or set(raw)-{'q','scope','order','unread','attach','mailbox'} or any(not isinstance(v,str) or len(v)>200 for v in raw.values()):
        frappe.throw('邮件筛选无效', frappe.ValidationError)
    scope=raw.get('scope','draft')
    if scope not in ('all','inbox','draft','sent','trash','queued','failed') or raw.get('order','desc') not in ('asc','desc'):
        frappe.throw('邮件范围或排序无效', frappe.ValidationError)
    statuses={'draft':'Draft','trash':'Trash','inbox':'Received','sent':['in',['Sent','Partial']],
              'all':['!=','Trash'],'queued':['in',['Queued','Sending']], 'failed':['in',['Failed','Unknown']]}
    mailbox=raw.get('mailbox')
    if mailbox:
        # 指定了箱：**先判有没有读权**，再取这个箱的信。
        # 无权时不回空列表糊弄，直接拒 —— 让人知道是「没权限」不是「箱里没信」。
        account.require_right(mailbox,'read')
        box_where={'mailbox_id':mailbox}
        if mailbox==account.account_name(frappe.session.user):
            # 个人箱还要 `owner` 对得上 —— 改归属就是转走了（见 _scope_sql）。
            box_where['owner']=frappe.session.user
    else:
        # 不指定箱 = **本人个人箱**（新建的信都自动挂在这，见 doctype 的 before_insert）。
        # 不能只写 owner=本人 —— 张三同步了部门箱，owner 会是张三，
        # 他的个人列表就会被部门信灌满；也不能只写 mailbox_id —— 改过归属的信会漏出来。
        box_where={'mailbox_id':account.account_name(frappe.session.user),
                   'owner':frappe.session.user}
    where={**box_where,'status':statuses[scope]}
    # 「带附件」筛选：附件引用存成 JSON 数组，空数组/空串就是没有附件。
    if raw.get('attach'):
        where['attachment_ids_json']=['not in', ('', '[]')]
    matches=[[key,'like','%'+raw['q']+'%'] for key in ('subject','body','to_json','cc_json')] if raw.get('q') else []
    length=min(100,max(1,int(page_length)));current=max(1,int(page))
    if raw.get('unread'):
        # 「未读」筛选：**我**没读过 = 这封还没看过。**在后端筛**，前端一次只拿 30 条。
        # 认 `Shangshu Mail Read`（按人记）—— **不看 read_at**，那是「有人读过」，
        # 张三读了不该把李四的未读筛没（和 read_state / _unread_counts 同一口径）。
        # 万封邮箱：**不把已读 name 拉进 Python**，用 LEFT JOIN 反连接（req 7）。
        # 走原生 SQL 就丢了 get_list 的 permission_query 钩子，所以显式做两道：
        #   ① doctype 级读权限；② 行级可见面 `_scope_sql` 拼在 WHERE 最前面（分页之前）。
        if not frappe.has_permission(DOCTYPE,'read'):
            frappe.throw('无权读取邮件',frappe.PermissionError)
        page_sql,page_params=unread_query.unread_page_sql(
            box_where,attach=bool(raw.get('attach')),q=raw.get('q'),user=frappe.session.user,
            order=raw.get('order','desc'),limit_start=(current-1)*length,length=length,
            scope_sql=_scope_sql(frappe.session.user))
        rows=frappe.db.sql(page_sql,tuple(page_params),as_dict=True)
        count_sql,count_params=unread_query.unread_count_sql(
            box_where,attach=bool(raw.get('attach')),q=raw.get('q'),user=frappe.session.user,
            scope_sql=_scope_sql(frappe.session.user))
        total=frappe.db.sql(count_sql,tuple(count_params))[0][0]
    else:
        rows=frappe.get_list(DOCTYPE,filters=where,or_filters=matches,
            fields=['name','subject','status','record_version','owner','modified','mailbox_id','to_json','cc_json','attachment_ids_json',
                    'from_address','received_at','sent_at','message_id','reply_to_mail','reply_to_address','delivery_error','delivery_started_at','rejected_json','previous_status','read_at'],
            order_by='modified '+raw.get('order','desc')+', name asc',limit_start=(current-1)*length,limit_page_length=length)
        total=frappe.get_list(DOCTYPE,filters=where,or_filters=matches,fields=['count(name) as count'])[0]['count']
    # 双未读点**批量**算好再投影 —— 一行一查会拖垮列表。
    states=read_state([row['name'] for row in rows])
    return {'rows':[projection(row,False,states.get(row['name'])) for row in rows],
            'total':total,'page':current,'page_length':length,
            # 两套未读数（N5-4：两套数不能相加为邮件总数）
            'unread_counts':_unread_counts(box_where),
            'attachment_capability':'fixed_references_v2','transport_capability':'smtp_imap_v1'}

def _unread_counts(box_where):
    """两套未读数，**和 read_state 严格同一口径** —— 不许点说没读、数说读了。

    用户 2026-10-14 批注 5-1：真页面上行里两个点都在，页头却写「本人未读 0 · 部门未读 0」。
    根因是这里原来**按「调用方有没有传 mailbox」分叉**：传了才认 `Shangshu Mail Read`，
    没传就退回去认 `read_at`。而 `read_at` 是「**有人**读过」（`mark_read` 谁读都写），
    别人一读就把我的未读数抹掉，我的点却还在。

    现在改成**按信实际所在的箱**判，两条都走同一套账：
      · `mine` = 我没读过的（`Shangshu Mail Read` 按人记，**不看 read_at**）
      · `dept` = 所在箱是部门箱、且还没人读过的（`dept_read_at`）
    个人箱没有部门那套。**两套数不能相加** —— 一封未读信在两套里各算一次。
    """
    user = frappe.session.user
    base = {'status': 'Received'}
    base.update({k: v for k, v in box_where.items() if k in ('mailbox_id', 'owner')})
    # 万封邮箱：已读关系用 LEFT JOIN 反连接，不把已读 name 拉进 Python（req 7）。
    # 行级可见面 `_scope_sql` 拼在最前面 —— 与 get_list 的 permission_query 同口径。
    count_sql, count_params = unread_query.unread_count_sql(
        base, user=user, scope_sql=_scope_sql(user))
    mine = frappe.db.sql(count_sql, tuple(count_params))[0][0]
    # 部门未读：**按这些信实际所在的箱**判是不是部门箱，不按「有没有传 mailbox」。
    # 万封邮箱：按箱分组只取计数，不把每封信的 mailbox_id 逐行拉进 Python。
    dept_rows = frappe.get_list(DOCTYPE, filters={**base, 'dept_read_at': ['is', 'not set']},
                                fields=['mailbox_id', 'count(name) as count'],
                                group_by='mailbox_id')
    dept = sum(int(r['count']) for r in dept_rows if _is_department(r['mailbox_id']))
    return {'mine': mine, 'dept': dept}

def detail(_service, payload, _context):
    # 与 `mail.read` 动作**同一份**读取实现（不新写一套读信/判权限的代码）。
    return {'mail':read_payload(payload)}

def thread(_service,payload,_context):
    """按原信/回复索引读取原事实，最多100封，不扫描整库或跨邮箱。"""
    root=message(payload['mail']);seen={root.name}
    for _ in range(20):
        if not root.reply_to_mail:break
        if root.reply_to_mail in seen:frappe.throw('邮件回复链循环，请核对原信',frappe.ValidationError)
        root=message(root.reply_to_mail);seen.add(root.name)
    else:frappe.throw('邮件回复层级超过20层，请定位更早的原信',frappe.ValidationError)
    fields=['name','subject','status','record_version','owner','modified','to_json','cc_json',
        'attachment_ids_json','from_address','received_at','sent_at','message_id','reply_to_mail',
        'delivery_error','delivery_started_at','rejected_json','previous_status','mailbox_id']
    rows=[projection(root)];frontier=[root.name];visited={root.name};has_more=False
    # 线程只在**同一个邮箱**里找回复 —— 不同箱的同主题不是一条线程。
    # 注意 filters 必须**每次重建**：`['in', frontier]` 抓的是列表对象，
    # 写在循环外的话 frontier 换成新列表后它还指着旧的，第二层就永远查不到。
    home_mailbox=root.mailbox_id or account.account_name(root.owner)
    for _ in range(20):
        found=frappe.get_list(DOCTYPE,
            filters={'mailbox_id':home_mailbox,'reply_to_mail':['in',frontier]},
            fields=fields,order_by='creation asc, name asc',limit_page_length=101-len(rows))
        if not found:break
        frontier=[]
        for row in found:
            if row.name in visited:frappe.throw('邮件回复链循环，请核对原信',frappe.ValidationError)
            if len(rows)==100:has_more=True;break
            visited.add(row.name);frontier.append(row.name);rows.append(projection(row))
        if has_more or not frontier:break
    else:has_more=True
    return {'root':root.name,'rows':rows,'has_more':has_more,
            'notice':'仅本人邮件；每次最多100封/20层，更多往来请在邮箱查阅' if has_more else '仅本人邮件，回复状态来自原邮件记录'}
