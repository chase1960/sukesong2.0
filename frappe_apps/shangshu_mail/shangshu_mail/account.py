"""邮箱绑定与授权。授权码只存 Frappe Email Account 的 Password 字段。

N5-1：**账户身份独立于登录人**。邮箱有自己的稳定编号（`account_key`），
连着邮件、凭据、同步游标、草稿、签名和授权。谁能不能进、能干什么，
由 `Shangshu Mail Access` 说了算，**不看 owner** —— owner 是「谁建的记录」，
不是「谁能用这个邮箱」。
"""
import hashlib
import json
import re
from contextlib import contextmanager

import frappe
from frappe.utils import now_datetime
from frappe.utils.password import remove_encrypted_password
from shangshu_mail import transport

DOCTYPE='Shangshu Mail Account'
ACCESS='Shangshu Mail Access'

# 五项权限分开学（N5-2「能读不等于能发」）。顺序固定，输出时用得上。
RIGHTS=('read','edit_draft','send','manage','signature')


@contextmanager
def writing():
    previous=getattr(frappe.flags,'shangshu_mail_account_write',False)
    frappe.flags.shangshu_mail_account_write=True
    try: yield
    finally: frappe.flags.shangshu_mail_account_write=previous


@contextmanager
def access_writing():
    previous=getattr(frappe.flags,'shangshu_mail_access_write',False)
    frappe.flags.shangshu_mail_access_write=True
    try: yield
    finally: frappe.flags.shangshu_mail_access_write=previous


def account_name(user=None):
    """个人邮箱的稳定编号。**保留原口径**（sha256(登录人)）——
    N5-1 明写「旧个人邮箱及其原信/附件不丢」，改口径会把旧信丢成孤儿。"""
    return hashlib.sha256((user or frappe.session.user).encode()).hexdigest()[:40]


def rights_for(mailbox, user=None):
    """这个人在那个邮箱上有什么权。

    · 本人个人箱 = 全权（**不必有账号行** —— 没绑过邮箱的人，自己写的草稿也该看得见）
    · 个人箱归建它的那个人；部门箱一律查授权表
    返回的字典键固定是 RIGHTS 五项，没有的按 False。
    """
    user=user or frappe.session.user
    out={key:False for key in RIGHTS}
    if not mailbox: return out
    if mailbox==account_name(user): return {key:True for key in RIGHTS}
    doc=frappe.db.get_value(DOCTYPE,{'account_key':mailbox},
        ['account_key','kind','owner','department','email_address','display_name'],as_dict=True)
    if not doc: return out
    # **账号行的属主 = 这个邮箱的管理员**（谁把这箱接进来，谁管它）。
    # 不分个人/部门：部门箱也得有人能开别人的权限，否则建完箱就锁死了。
    # 这不是「老板/负责人凭身份白拿代发权」—— 那条是按角色给默认，另说。
    if doc.owner==user:
        return {key:True for key in RIGHTS}
    row=frappe.db.get_value(ACCESS,{'mailbox':mailbox,'user':user},
        ['can_read','can_edit_draft','can_send','can_manage','can_signature'],as_dict=True)
    if not row: return out
    return {'read':bool(row.can_read),'edit_draft':bool(row.can_edit_draft),
            'send':bool(row.can_send),'manage':bool(row.can_manage),
            'signature':bool(row.can_signature)}


def readable_mailbox_ids(user=None):
    """这个人能读的邮箱编号。**邮件归属判定用它，不再比 owner。**

    本人个人箱永远算在内（哪怕还没绑过邮箱）—— 否则自己写的草稿自己看不见。
    """
    user=user or frappe.session.user
    ids={account_name(user)}
    # 我拥有的邮箱（个人箱和我建的部门箱）都算能读 —— 见 rights_for 的属主规则。
    for row in frappe.get_all(DOCTYPE,filters={'owner':user},fields=['account_key']):
        ids.add(row.account_key)
    for row in frappe.get_all(ACCESS,filters={'user':user,'can_read':1},fields=['mailbox']):
        ids.add(row.mailbox)
    return sorted(ids)


def require_right(mailbox, right, user=None):
    """判一项权限。**能读不等于能发** —— 五项各判各的，不许由一项推出另一项。"""
    if right not in RIGHTS:
        frappe.throw('未知的邮箱权限项',frappe.ValidationError)
    if not rights_for(mailbox,user).get(right):
        frappe.throw('你在这个邮箱上没有%s权限' % {
            'read':'阅读','edit_draft':'编辑草稿','send':'代发',
            'manage':'邮箱配置','signature':'签名管理'}[right], frappe.PermissionError)


def _grantees(mailbox):
    """这个邮箱上现在谁有哪些权 —— **只有可管授权的人看得到**。

    N5-5「设置页由有权者选邮箱和成员、逐项配置权限」的**读**那一半。
    不给可管授权的人吐，别让「谁被授权了」本身变成信息泄露。
    """
    out=[]
    for row in frappe.get_all(ACCESS,filters={'mailbox':mailbox},
        fields=['user','can_read','can_edit_draft','can_send','can_manage','can_signature'],
        order_by='user'):
        out.append({'user':row.user,'read':bool(row.can_read),'edit_draft':bool(row.can_edit_draft),
                    'send':bool(row.can_send),'manage':bool(row.can_manage),'signature':bool(row.can_signature)})
    return out


def mailboxes(_service=None,_payload=None,_context=None):
    """我能进入的邮箱：自己的个人箱 + 获授权的部门箱。

    N5-1「支持一个人选个人箱和获权部门箱」。返回里带每箱权限 ——
    **无权动作前端不提供入口、后端也拒绝**（N5-2），前端据此决定显不显示按钮。

    能管授权的箱再多带一份 `grantees`（当前授权名单），设置页拿它渲染；
    没管理权的箱**不带**这个键。
    """
    user=frappe.session.user
    # 我拥有的邮箱（含我建的部门箱）+ 我被授权的邮箱。
    rows=frappe.get_all(DOCTYPE,filters={'owner':user},
        fields=['account_key','kind','department','email_address','display_name','enabled','connection_status','signature_enabled','signature_html','signature_resources','signature_profiles','default_signature_id','signature_revision'])
    seen={row.account_key for row in rows}
    for grant in frappe.get_all(ACCESS,filters={'user':user},fields=['mailbox']):
        if grant.mailbox in seen: continue
        extra=frappe.db.get_value(DOCTYPE,{'account_key':grant.mailbox},
            ['account_key','kind','department','email_address','display_name','enabled','connection_status','signature_enabled','signature_html','signature_resources','signature_profiles','default_signature_id','signature_revision'],as_dict=True)
        if extra: rows.append(extra); seen.add(extra.account_key)
    out=[]
    for row in rows:
        rights=rights_for(row.account_key,user)
        item={'id':row.account_key,'kind':row.kind or 'personal','department':row.department or '',
              'email':row.email_address or '','display_name':row.display_name or '',
              'enabled':bool(row.enabled),'connection_status':row.connection_status or 'unbound',
              'rights':rights}
        if rights.get('manage'): item['grantees']=_grantees(row.account_key)
        # 默认签名：**能发信或能管签名的人本来就看得到**（签名本来就会随信发出去）。
        # T05「已手改签名切身份时明确保留/替换」要用它来换 —— 拿不到就只能闷着。
        if rights.get('send') or rights.get('signature'):
            item['signature']=signature_projection(row,include_profiles=rights.get('signature',False))
        out.append(item)
    return {'mailboxes':out}


def _grant_payload(payload):
    mailbox=str(payload.get('mailbox') or '').strip()
    target=str(payload.get('user') or '').strip()
    if not mailbox or not target:
        frappe.throw('授权必须写明邮箱和员工',frappe.ValidationError)
    if not frappe.db.exists(DOCTYPE,{'account_key':mailbox}):
        frappe.throw('要授权的邮箱不存在',frappe.ValidationError)
    if not frappe.db.exists('User',target):
        frappe.throw('要授权的员工不存在',frappe.ValidationError)
    return mailbox,target


def grant(_action=None,payload=None,_context=None):
    """开/改一个人在一个邮箱上的权限。**只有可管授权的人能做**，
    且管理权不等于代发权（N5-2）。"""
    mailbox,target=_grant_payload(payload)
    require_right(mailbox,'manage')
    rights=payload.get('rights') or {}
    if not isinstance(rights,dict) or any(key not in RIGHTS for key in rights):
        frappe.throw('权限项无效',frappe.ValidationError)
    doc=frappe.db.get_value(ACCESS,{'mailbox':mailbox,'user':target},'name')
    fields={'can_read':int(bool(rights.get('read'))),
            'can_edit_draft':int(bool(rights.get('edit_draft'))),
            'can_send':int(bool(rights.get('send'))),
            'can_manage':int(bool(rights.get('manage'))),
            'can_signature':int(bool(rights.get('signature')))}
    with access_writing():
        if doc: frappe.get_doc(ACCESS,doc).update(fields).save(ignore_permissions=True)
        else: frappe.get_doc({'doctype':ACCESS,'mailbox':mailbox,'user':target,**fields}).insert(ignore_permissions=True)
    return {'mailbox':mailbox,'user':target,'rights':rights_for(mailbox,target)}


def revoke(_action=None,payload=None,_context=None):
    """收回一个人在一个邮箱上的全部权限。"""
    mailbox,target=_grant_payload(payload)
    require_right(mailbox,'manage')
    with access_writing():
        for name in frappe.get_all(ACCESS,filters={'mailbox':mailbox,'user':target},pluck='name'):
            frappe.get_doc(ACCESS,name).delete(ignore_permissions=True)
    return {'mailbox':mailbox,'user':target,'rights':rights_for(mailbox,target)}


def get_account(lock=False, required=False, mailbox=None):
    """取一个邮箱的配置。

    不传 `mailbox` = 本人个人箱（老口径，收发脚本一直在用）。
    传了就是那个箱 —— **先判有没有权进**，不是谁改个编号就能摸到别人的箱。
    """
    if mailbox:
        if not frappe.db.exists(DOCTYPE,{'account_key':mailbox}):
            # 本人个人箱没绑过 → 提示去绑定；别人的箱编号不存在 → 提示不存在。
            # 两句不能混，混了排查时只会得到「邮箱不存在」这种废话。
            if mailbox==account_name():
                frappe.throw('请先在邮箱设置中绑定自己的邮箱',frappe.ValidationError)
            frappe.throw('邮箱不存在',frappe.ValidationError)
        require_right(mailbox,'read')
        doc=frappe.get_doc(DOCTYPE,{'account_key':mailbox},for_update=lock)
    else:
        name=account_name()
        if not frappe.db.exists(DOCTYPE,name):
            if required: frappe.throw('请先在邮箱设置中绑定自己的邮箱',frappe.ValidationError)
            return None
        doc=frappe.get_doc(DOCTYPE,name,for_update=lock)
        if doc.owner != frappe.session.user:
            frappe.throw('不能访问他人的邮箱配置',frappe.PermissionError)
    if required and (not doc.enabled or not doc.email_account):
        frappe.throw('邮箱未连接或已暂停，请在邮箱设置中处理',frappe.ValidationError)
    return doc


def _sig_resources(doc):
    """签名里引用的受管图（JSON）。坏数据就当没有，不让一条脏记录卡死账号状态。"""
    raw=getattr(doc,'signature_resources',None) or '[]'
    try:
        items=json.loads(raw)
    except Exception:
        return []
    return items if isinstance(items,list) else []


def signature_projection(doc,include_profiles=False):
    """Default is the legacy-compatible projection; profiles remain mailbox-scoped."""
    raw=getattr(doc,'signature_profiles',None)
    try: profiles=json.loads(raw) if raw else []
    except (ValueError,TypeError): profiles=[]
    if not isinstance(profiles,list): profiles=[]
    if not profiles and (doc.signature_html or _sig_resources(doc)):
        profiles=[{'id':'legacy-default','name':'默认签名','html':doc.signature_html or '',
                   'resources':_sig_resources(doc)}]
    default_id=getattr(doc,'default_signature_id',None) or (profiles[0]['id'] if profiles else '')
    default=next((item for item in profiles if item.get('id')==default_id),None)
    state={'enabled':bool(doc.signature_enabled),'html':default['html'] if default else (doc.signature_html or ''),
           'resources':default.get('resources',[]) if default else _sig_resources(doc),
           'default_signature_id':default_id,'signature_revision':int(getattr(doc,'signature_revision',None) or 0)}
    if include_profiles: state['signatures']=profiles
    return state


def projection(doc=None):
    doc=doc or get_account()
    if not doc:
        return {'bound':False,'provider':'','email':'','display_name':'','enabled':False,
                'connection_status':'unbound','last_error':''}
    return {'bound':bool(doc.email_account),'provider':doc.provider or '',
            'email':doc.email_address or '', 'display_name':doc.display_name or '',
            # G2：归属要回填到邮箱设置表单 —— 不带这两个键的话，打开设置页永远显示
            # 「个人邮箱」，一保存就把部门箱改回个人箱了（静默改坏，最糟的那种）。
            'kind':doc.kind or 'personal','department':doc.department or '',
            'enabled':bool(doc.enabled),'connection_status':doc.connection_status or 'unbound',
            'last_error':doc.last_error or '', 'last_sync_at':doc.last_sync_at,
            'last_tested_at':doc.last_tested_at,
            # 默认签名：按邮箱身份存（不是按登录人），N5 迁移时跟着邮箱走。
            # enabled=False 表示「关掉自动插入」—— 前端不再往正文里塞。
            # resources 是签名里引用的受管图 —— 计划 §4.4「本封保存签名内容快照
            # **及所用图片引用**」。不带它的话，插进新信只剩一个取不到的 cid:，就是破图。
            'signature':signature_projection(doc,include_profiles=True)}


def status(_service=None,_payload=None,_context=None):
    return {'account':projection(),'providers':[{'id':v['id'],'label':v['label'],'domains':v['domains']}
                                               for v in transport.PROVIDERS.values()]}


def credentials(doc):
    """取这个邮箱的凭据。**只喂给 SMTP/IMAP，不返回给界面。**

    改之前这里要求 `source.owner == session.user` —— 共享箱的凭据是**箱的**，
    不是某一个人的，那条会把部门箱代发整个挡死（N5-3）。
    改成按「我对这个箱有没有使用权」判；其余完整性校验一条不减。
    """
    # 有使用权才取得出凭据。没有 → 拒。**员工/助手拿不到授权码**。
    require_right(doc.account_key,'read')
    source=frappe.get_doc('Email Account',doc.email_account)
    try: provider=transport.provider_for(doc.email_address,doc.provider)
    except ValueError: frappe.throw('邮箱服务商配置无效，请重新配置',frappe.ValidationError)
    # Framework scheduler remains OFF: only this domain may execute transport.
    if (source.email_id != doc.email_address
            or source.smtp_server != provider['smtp_host'] or source.email_server != provider['imap_host']
            or str(source.smtp_port) != '465' or str(source.incoming_port) != '993'
            or not source.use_ssl_for_outgoing or not source.use_ssl or not source.use_imap
            or source.enable_incoming or source.enable_outgoing):
        frappe.throw('邮箱绑定失配，请重新配置',frappe.PermissionError)
    password=source.get_password('password',raise_exception=False)
    if not password: frappe.throw('邮箱授权已解除，请重新配置',frappe.ValidationError)
    return source.email_id,password


def _test(address,password,provider):
    try: transport.test_connection(address,password,provider)
    except Exception:
        # 禁止把 IMAP/SMTP 原始异常（可能含用户输入/授权）放进响应或日志。
        frappe.clear_messages()
        frappe.throw('连接失败：请核对邮箱地址、所选服务商机房、IMAP/SMTP开关及客户端授权码；不要使用网页登录密码',frappe.ValidationError)


def execute(action,payload,context):
    if context.get('source') != 'user':
        frappe.throw('邮箱授权只能由本人在账号设置页操作，不能交给AI',frappe.PermissionError)
    # 授权管理（给谁开哪个箱）不绑定在「本人的邮箱」上 —— 先走它自己的闸，
    # 不要因为管授权的人自己还没绑邮箱就卡住（他管的是别人的箱）。
    if action=='mail.mailbox.grant': return grant(action,payload,context)
    if action=='mail.mailbox.revoke': return revoke(action,payload,context)
    # 签名按**箱**取（T05 部门默认签名），不走下面那条「本人个人箱」老口径 ——
    # 走老口径的话，只给部门箱签名管理权、自己还没绑个人箱的人会撞「请先绑定邮箱」，
    # 报出来的理由完全对不上（实测 3 号就是这么红的）。
    if action=='mail.account.signature': return signature(action,payload,context)
    doc=get_account(lock=True)
    if action=='mail.account.configure':
        address=payload['email'].strip().lower()
        try: provider=transport.provider_for(address,payload['provider'])
        except ValueError as error: frappe.throw(str(error),frappe.ValidationError)
        display=payload.get('display_name','').strip()
        if any(ord(c)<32 or ord(c)==127 for c in display):
            frappe.throw('发件姓名不能含换行或控制字符',frappe.ValidationError)
        password=payload.get('password')
        if not password:
            if not doc or doc.email_address != address or doc.provider != provider['id'] or not doc.email_account:
                frappe.throw('首次绑定、更换邮箱或服务商机房必须重新填写客户端授权码',frappe.ValidationError)
            _,password=credentials(doc)
        _test(address,password,provider['id'])
        # G2：kind/department 决定这个箱是个人箱还是**部门邮箱**。
        # 不填 kind = 老口径「本人邮箱」，旧调用照旧（输入契约加字段，不改旧语义）。
        # kind='department' 必填 department，且经 department_key 收成**受管部门 ID**
        # —— 不收的话附件「所有人」会写出一个授权判定解析不了的键（T06 那颗雷）。
        kind=str(payload.get('kind') or 'personal').strip() or 'personal'
        if kind not in ('personal','department'):
            frappe.throw('邮箱归属只能是 personal 或 department',frappe.ValidationError)
        dept_raw=str(payload.get('department') or '')
        if kind=='department':
            from shangshu_mail.delivery import department_key
            department=department_key(dept_raw)   # 空/查无/同名多个 → 当场拒
        else:
            if dept_raw.strip():
                frappe.throw('个人邮箱不填所属部门',frappe.ValidationError)
            department=''
        email_name='Shangshu Personal '+account_name()
        source=frappe.get_doc('Email Account',email_name) if frappe.db.exists('Email Account',email_name) else frappe.new_doc('Email Account')
        if not source.is_new() and source.owner != frappe.session.user:
            frappe.throw('邮箱配置归属不匹配',frappe.PermissionError)
        source.update({'email_account_name':email_name,'email_id':address,'password':password,
                       'auth_method':'Basic','smtp_server':provider['smtp_host'],'smtp_port':'465',
                       'use_ssl_for_outgoing':1,'use_tls':0,'email_server':provider['imap_host'],
                       'incoming_port':'993','use_imap':1,'use_ssl':1,'use_starttls':0,
                       'enable_incoming':0,'enable_outgoing':0,'default_incoming':0,'default_outgoing':0,
                       'enable_automatic_linking':0,'enable_auto_reply':0,'append_emails_to_sent_folder':0})
        source.save(ignore_permissions=True)
        if not doc:
            doc=frappe.new_doc(DOCTYPE); doc.account_key=account_name()
        doc.update({'provider':provider['id'],'email_address':address,'display_name':display,
                    'kind':kind,'department':department,
                    'email_account':source.name,'enabled':int(payload.get('enabled',True)),
                    'connection_status':'connected' if payload.get('enabled',True) else 'paused',
                    'last_error':'','last_tested_at':now_datetime(),
                    'binding_generation':frappe.generate_hash(length=24)})
    elif action=='mail.account.test':
        if not doc or not doc.email_account:
            frappe.throw('请先绑定邮箱',frappe.ValidationError)
        _test(*credentials(doc),doc.provider); doc.last_tested_at=now_datetime();doc.last_error=''
        doc.connection_status='connected' if doc.enabled else 'paused'
    elif action=='mail.account.status':
        if not doc or not doc.email_account: frappe.throw('请先绑定邮箱',frappe.ValidationError)
        if payload['enabled']: _test(*credentials(doc),doc.provider)
        doc.enabled=int(payload['enabled']);doc.connection_status='connected' if doc.enabled else 'paused'
    elif action=='mail.account.disconnect':
        if not doc: return status()
        if doc.email_account:
            remove_encrypted_password('Email Account',doc.email_account,'password')
        doc.enabled=0;doc.email_account=None;doc.connection_status='unbound';doc.last_error=''
        doc.binding_generation=frappe.generate_hash(length=24)
    else: frappe.throw('不支持的邮箱设置操作',frappe.ValidationError)
    with writing(): doc.save(ignore_permissions=True)
    return status()


def signature(_action,payload,_context):
    """维护**这个箱**的默认签名（T05 部门默认签名）。

    计划 PKG-006-T05 交付原话：「邮箱切换、真实发件身份选择、**部门默认签名**、
    授权设置交互」。SIG（PKG-005）交的是**个人**默认签名，这一条补部门那半。

    不带 `mailbox` = 老口径「本人个人箱」；带上就是那个箱 ——
    但要有那个箱的**签名管理权**（`require_right(box,'signature')`）。
    「能读不等于能改签名」是 N5-2 五项分开的直接推论，不能由读权推出。

    维护签名**不授予发信权**（计划 §4.4）：只改签名三个字段，
    不碰 enabled/connection_status/凭据，也不因为能改签名就能发信。
    """
    box=str(payload.get('mailbox') or '').strip()
    if box:
        require_right(box,'signature')
        doc=get_account(lock=True,mailbox=box)
    else:
        doc=get_account(lock=True)
    if not doc: frappe.throw('请先绑定邮箱',frappe.ValidationError)
    state=signature_projection(doc,include_profiles=True)
    revision=state['signature_revision']
    if 'signatures' in payload:
        expected=payload.get('signature_revision')
        if isinstance(expected,bool) or not isinstance(expected,int) or expected!=revision:
            frappe.throw('签名设置已更新，请重新打开后核对再保存',frappe.ValidationError)
        profiles=payload['signatures']
        if not isinstance(profiles,list) or not 1<=len(profiles)<=20:
            frappe.throw('请保留1至20个签名',frappe.ValidationError)
        default_id=payload.get('default_signature_id')
    else:
        # Legacy calls edit the existing default and retain every other profile.
        profiles=[dict(item) for item in state['signatures']]
        default_id=state['default_signature_id'] or 'legacy-default'
        current=next((item for item in profiles if item.get('id')==default_id),None)
        if current is None:
            current={'id':default_id,'name':'默认签名','html':'','resources':[]};profiles.append(current)
        current['html']=payload.get('html') or ''
        if 'resources' in payload: current['resources']=payload['resources']
    normalized=[];ids=set();names=set()
    for item in profiles:
        if not isinstance(item,dict): frappe.throw('签名格式无效',frappe.ValidationError)
        key=item.get('id');name=item.get('name');html=item.get('html','');resources=item.get('resources',[])
        if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',key) or key in ids:
            frappe.throw('签名编号无效或重复',frappe.ValidationError)
        if not isinstance(name,str) or not name.strip() or len(name.strip())>80 or name.strip().casefold() in names:
            frappe.throw('签名名称不能为空、重复或超过80字',frappe.ValidationError)
        if not isinstance(html,str) or len(html)>20000:
            frappe.throw('签名过长，请精简后保存',frappe.ValidationError)
        if re.search(r'<\s*(script|iframe|object|embed|form)\b',html,re.I) or re.search(r'\son[a-z]+\s*=',html,re.I):
            frappe.throw('签名不能含脚本、事件、表单或嵌入内容',frappe.ValidationError)
        if not isinstance(resources,list) or len(resources)>20 or any(not isinstance(x,dict) or not x.get('content_id') for x in resources):
            frappe.throw('签名图片引用格式无效',frappe.ValidationError)
        ids.add(key);names.add(name.strip().casefold())
        normalized.append({'id':key,'name':name.strip(),'html':html.strip(),'resources':resources})
    default=next((item for item in normalized if item['id']==default_id),None)
    if default is None: frappe.throw('请选择列表中的默认签名',frappe.ValidationError)
    # Same locked account and transaction: the default projection cannot drift from its profile.
    doc.signature_enabled=int(bool(payload.get('enabled')))
    doc.signature_profiles=json.dumps(normalized,ensure_ascii=False)
    doc.default_signature_id=default_id;doc.signature_revision=revision+1
    doc.signature_html=default['html'];doc.signature_resources=json.dumps(default['resources'],ensure_ascii=False)
    with writing(): doc.save(ignore_permissions=True)
    return {'account':projection(),'signature':signature_projection(doc,include_profiles=True)}



def permission_query(user=None):
    """账号配置的可见面 = **我能管的邮箱**（本人个人箱 + 有管理权的箱）。

    不再是「我 owner 的」—— 部门箱的配置，被授权管理的人也该看得到。
    """
    user=user or frappe.session.user
    ids=readable_mailbox_ids(user)
    if not ids:
        return '1=0'
    return ('`tabShangshu Mail Account`.`account_key` in (%s)'
            % ','.join(frappe.db.escape(i) for i in ids))


def has_permission(doc,user=None,permission_type=None):
    user=user or frappe.session.user
    if user=='Guest': return False
    return bool(rights_for(doc.account_key,user).get('manage')) or doc.owner==user
