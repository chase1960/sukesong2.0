"""邮件域仅贡献声明；收发接入不依赖文件中心在线。"""
DOMAIN = 'com.shangshu.mail'
DOCTYPE = 'Shangshu Mail Message'
ROLES = ['Desk User']
# 整单确认（旧确认接口）**允许人工改写的字段** —— 只有主题与正文。
# 编号、版本、收件人、抄送、附件、权限范围都不许跟着换（那些要走逐项审核入口）。
# 这份名单有**两个消费者**，是同一份口径：
#   ① 内核的整单确认闸（域声明的 `proposal_editable_fields`）；
#   ② 域自己的 `proposal_review.review`（`legacy_edit` 分支的白名单）。
# 合并说明（2026-10-21）：fast 那条线也只许改主题/正文，两边口径一致 ⇒ 取并集即这份。
EDITABLE_FIELDS = ('subject', 'body')

def schema(properties, required, description=None):
    return {'type':'object','properties':properties,'required':required,'additionalProperties':False,
            **({'description':description} if description else {})}

REF = {'mail':{'type':'string','minLength':1,'maxLength':140},
       'expected_version':{'type':'integer','minimum':1}}
ADDRESSES = {'type':'array','maxItems':100,'items':{'type':'string','maxLength':320}}
FILE_REF = {'type':'string','minLength':1,'maxLength':140,
            'description':'固定版本的 Frappe File ID。必须复制 files.versions 或已授权附件详情的 source.file / frappe_file；禁止使用文件中心业务记录 name、ref_name、业务ID 或文件URL，不能猜测或隐式改取最新版。'}
ATTACHMENTS = {'type':'array','maxItems':20,'items':FILE_REF,
               'description':'附件固定版本引用；先读取 files.versions，再逐项使用其中的 source.file 或 frappe_file。'}
# 受管内联图片：正文里用 cid:<content_id> 引用，资源必须随同一次保存一起提供，
# 引用悬空则拒存。file 同样是固定版本的 Frappe File ID，不许用业务记录号或文件URL。
INLINE_RESOURCE = schema({
    'content_id':{'type':'string','minLength':1,'maxLength':320,
                  'description':'正文 <img src="cid:…"> 里引用的标识，不含 cid: 前缀'},
    'mime_type':{'type':'string','enum':['image/png','image/jpeg','image/gif']},
    'name':{'type':'string','maxLength':255},
    'file':FILE_REF,
}, ['content_id','file'])
INLINE_RESOURCES = {'type':'array','maxItems':20,'items':INLINE_RESOURCE,
                    'description':'正文引用的受管内联图片；与正文同次生效，缺任一引用即拒存。'}
# 动作契约版本（改输入契约就升版本号；同版本不同定义会被拒）。
# install.py 从这儿取版本，不再各写一份。
ACTION_VERSIONS = {
    # 1.5.0 → 1.6.0：新增 case_ref（§8 第 10 项：邮件对象加案件关联）。
    'mail.save_draft': '1.6.0',
    'mail.sync': '1.1.0',
    # G2：入参加 kind/department（建部门邮箱的入口）
    'mail.account.configure': '1.2.0',
    'mail.account.signature': '1.3.0',
    # ★ 2026-10-21：回复/转发两个新动作（首次登记 = 1.0.0）
    'mail.reply': '1.0.0',
    'mail.forward': '1.0.0',
    # ★ 2026-10-21：只读动作 —— agent 读得到正文/收件人/抄送/附件（首次登记 = 1.0.0）
    'mail.read': '1.0.0',
    # ★ 2026-10-22（PKG-036-T03）：把**受管文件**（文件中心里的）绑定到一封信上
    #   —— 字节**由文件域放**，邮件域只绑引用（字节不动）⇒ 收掉「外链图自己建 File」那处豁免。
    'mail.attachment.bind': '1.0.0',
}

ACTIONS = [
    # ★ 2026-10-22（PKG-036-T03）：把**受管文件**绑定到这封信上（绑的是引用，字节不动）。
    #   为什么要有这个动作：字节**必须**由文件域放（契约「所有进尚书的文件都进文件中心」），
    #   而这封信上的图**还要能按这封信的归属取字节**（读信面／正文 `cid:` 解析）
    #   ⇒ 需要一个**挂在信上的引用**；内核 `bind_record_attachments` 复用同一份 `file_url`
    #   ⇒ **字节仍然只有一份**（同一份字节的两种身份）。
    #   ⚠️ 本域的动作元组是**三个**（编号／标题／输入 schema）—— 多写一个就 unpack 炸。
    ('mail.attachment.bind','把受管文件绑定到这封信上',schema({**REF,
        'mail':{**REF['mail'],'description':'邮件记录编号（Shangshu Mail Message 的 name），不是邮箱编号。'},
        'files':{'type':'array','maxItems':50,'items':{'type':'string','maxLength':140},
                 'title':'受管文件编号（文件中心里的那几条）'}},['mail','files'])),
    ('mail.save_draft','保存邮件草稿',schema({**REF,
        'mail':{**REF['mail'],'description':'已有草稿的邮件记录编号（mail.detail 的 name），不是邮箱编号或邮箱地址。新建草稿必须省略此字段；修改已有草稿才传，并同时传 expected_version。'},
        'expected_version':{**REF['expected_version'],'description':'修改已有草稿时，传最近一次 mail.detail 返回的 record_version；新建草稿时省略。'},
        # T05 真实发件身份选择：草稿住哪个箱，发信 From 就是哪个箱。
        # 不带 = 老口径（建者个人箱）。要有那个箱的**编辑草稿权**。
        'mailbox':{'type':'string','maxLength':140,'description':'草稿所属/发件邮箱的稳定编号（mail.mailboxes 返回的 id），不是邮件记录编号。新建到指定邮箱时传此字段，省略则使用发起人的个人邮箱；需要目标邮箱 edit_draft 权限。'},
        'subject':{'type':'string','maxLength':500},'body':{'type':'string','maxLength':100000},
        'body_format':{'type':'string','enum':['Text','HTML'],'title':'正文格式'},
        'reply_to_mail':{'type':'string','maxLength':140},
        # **关联案件**（§8 第 10 项）：这封信是**哪个案件**的。
        # 不带 = 不改（新建时为空）；它只是**一个编号**，不授予任何权限，
        # 也不自动把信挂到案件上（挂不挂由人决定）。
        'case_ref':{'type':'string','maxLength':140,'description':'这封信关联的案件编号（受管记录的编号，如 TEST-3IN-2021A257）。只是编号，不授予权限；省略＝不改。'},
        'to':ADDRESSES,'cc':ADDRESSES,'attachments':ATTACHMENTS,
        'inline_resources':INLINE_RESOURCES,
        'signature_guard':{'type':'string','enum':['inserted'],'description':'签名已插入的草稿元数据；不是正文内容，也不授予任何权限。'},
        'attachment_labels':{'type':'array','maxItems':20,'items':schema({
            'file':FILE_REF,
            'label':{'type':'string','maxLength':40},'name':{'type':'string','minLength':1,'maxLength':255}},['file','label'])}},['subject','body','to','cc'],
        '只保存草稿，不发送。新建：省略 mail 和 expected_version；邮箱编号放 mailbox。修改已有草稿：mail 放邮件记录编号并传对应 expected_version。subject、body、to、cc 必须提供，可用空字符串/空数组，但至少要有一项非空内容。')),
    # ★ 回复 / 转发：给 agent 的两个动作（人点那条路只活在前端，agent 够不到）。
    #   入参沿用 mail.save_draft 那套，**外加原信编号**（reply_to_mail）。
    #   引用块与内联图改写由 `shangshu_mail.quoting` **一份实现**产出（不拼第二份正文字符串）。
    ('mail.reply','回复一封邮件（生成带引用块的草稿）',schema({**REF,
        'mailbox':{'type':'string','maxLength':140,'description':'草稿所属/发件邮箱的稳定编号；省略=建者个人箱。需要该箱的编辑草稿权。'},
        'subject':{'type':'string','maxLength':500,'description':'主题；省略时按原信自动加 Re: 前缀。'},
        'body':{'type':'string','maxLength':100000,'description':'新写的正文；引用块由系统接在后面。'},
        'body_format':{'type':'string','enum':['Text','HTML'],'title':'正文格式'},
        'reply_to_mail':{**REF['mail'],'description':'**被回复的那一封**（mail.detail 的 name）。必填。'},
        'to':ADDRESSES,'cc':ADDRESSES,'attachments':ATTACHMENTS,
        'inline_resources':INLINE_RESOURCES,
        'attachment_labels':{'type':'array','maxItems':20,'items':schema({
            'file':FILE_REF,
            'label':{'type':'string','maxLength':40},'name':{'type':'string','minLength':1,'maxLength':255}},['file','label'])}},
        ['reply_to_mail','to','cc'],
        '只生成草稿，不发送。正文 = 你写的内容 ＋ 原信引用块（表格/合并格/受管内联图都带得上）。'
        '怎么用：① 先用 mail.detail 取原信（拿它的 name）；② reply_to_mail 填那一封；'
        '③ body 写你要说的话（引用块系统自动接在后面）；④ 要真发出去另走 mail.send。')),
    ('mail.forward','转发一封邮件（生成带引用块的草稿）',schema({**REF,
        'mailbox':{'type':'string','maxLength':140,'description':'草稿所属/发件邮箱的稳定编号；省略=建者个人箱。需要该箱的编辑草稿权。'},
        'subject':{'type':'string','maxLength':500,'description':'主题；省略时按原信自动加 Fwd: 前缀。'},
        'body':{'type':'string','maxLength':100000,'description':'新写的正文；引用块由系统接在后面。'},
        'body_format':{'type':'string','enum':['Text','HTML'],'title':'正文格式'},
        'reply_to_mail':{**REF['mail'],'description':'**被转发的那一封**（mail.detail 的 name）。必填。'},
        'to':ADDRESSES,'cc':ADDRESSES,'attachments':ATTACHMENTS,
        'inline_resources':INLINE_RESOURCES,
        'attachment_labels':{'type':'array','maxItems':20,'items':schema({
            'file':FILE_REF,
            'label':{'type':'string','maxLength':40},'name':{'type':'string','minLength':1,'maxLength':255}},['file','label'])}},
        ['reply_to_mail','to','cc'],
        '只生成草稿，不发送。正文 = 你写的内容 ＋ 原信引用块（表格/合并格/受管内联图都带得上）。'
        '怎么用：① 先用 mail.detail 取原信（拿它的 name）；② reply_to_mail 填那一封；'
        '③ to 填收件人（转发必填，回复可只回发件人）；④ body 写你要说的话（引用块自动接在后面）；'
        '⑤ 要真发出去另走 mail.send。')),
    # ★ 只读：读一封信的正文/收件人/抄送/附件/内联图引用。
    #   邮件域给 agent 的对象 `mail.message` 只有 7 个列表字段（没有正文、收件人、抄送、附件），
    #   能读正文的是**服务** `mail.detail` —— 而 agent 的工具面只取**动作**（tools_only）
    #   ⇒ 服务不在 agent 手里 ⇒ 回信/转发是「盲回」。这个动作补上「读得到内容」那一半。
    ('mail.read','读取一封邮件（正文/收件人/抄送/附件，只读）',schema({
        'mail':{**REF['mail'],'description':'要读的那一封**邮件记录编号**（不是邮箱编号、不是邮箱地址）。'},
        'expected_version':{**REF['expected_version'],'description':'可选：传了就必须是最近一次读到的 record_version，不一致就拒（不返回旧内容）。省略=读当前这一版。'},
    },['mail'],
        '**只读**：读一封邮件的正文、收件人、抄送、附件与内联图引用，**不修改任何东西、不发送、不标已读**。'
        '只回本人或已获授权邮箱里的信；读不到会**明确回报无权**（不会给空正文冒充「这封信是空的」）。'
        '正文按现有净化口径处理：脚本、事件属性与外链图不回来。'
        '怎么用：回复/转发之前先用它取原信（拿它的 name 与 record_version），再调 mail.reply / mail.forward。')),
    ('mail.recycle','邮件移入回收站',schema(REF,['mail','expected_version'])),
    ('mail.restore','恢复邮件',schema(REF,['mail','expected_version'])),
    ('mail.set_read','标记邮件已读/未读',schema({**REF,
        'read':{'type':'boolean','title':'true=标为已读，false=标回未读'}},['mail','expected_version','read'])),
    ('mail.send','发送已核对的邮件',schema(REF,['mail','expected_version'])),
    ('mail.sync','同步当前收件箱',schema({'mailbox_id':{'type':'string','minLength':1,'maxLength':140,'description':'获权邮箱稳定编号；省略仅兼容本人邮箱，指定箱不得回退本人'}},[])),
    ('mail.account.configure','测试连接并保存邮箱绑定',schema({
        'provider':{'type':'string','enum':['qq','163','netease-enterprise','netease-enterprise-hz']},
        'email':{'type':'string','minLength':3,'maxLength':320},
        'display_name':{'type':'string','maxLength':100},
        'password':{'type':'string','maxLength':512},
        'enabled':{'type':'boolean'},
        # G2：部门邮箱要能**通过产品动作**建起来，不是只能测试直插行。
        # 任务范围「两个员工用各自账号进入同一个部门邮箱」—— 进入那半（N5）有了，
        # 建/绑这半一直没有入口，真实 FDE 无从配置。
        # kind 不填 = 老口径「本人邮箱」，旧调用照旧。
        # kind='department' 必填 department，且经 department_key 校验
        # （受管部门表在时收成 ID；空/查无/同名多个当场拒）。
        'kind':{'type':'string','enum':['personal','department'],'title':'归属'},
        'department':{'type':'string','maxLength':140,'title':'所属部门'}},['provider','email'])),
    ('mail.account.test','测试本人邮箱连接',schema({},[])),
    ('mail.account.status','暂停或恢复本人邮箱',schema({'enabled':{'type':'boolean'}},['enabled'])),
    ('mail.account.disconnect','解除本人邮箱授权',schema({},[])),
    # SIG 默认签名：按**邮箱身份**存（不是按登录人），N5 迁移时跟着邮箱走。
    # 只改默认配置；本封手改签名不走这里（那属于正文，随草稿存）。
    ('mail.account.signature','维护邮箱默认签名',schema({
        # T05 部门默认签名：按**箱**设签名。不带这个键 = 老口径「本人个人箱」，
        # 带上就是那个箱 —— 但要有那个箱的**签名管理权**（能读不等于能改签名）。
        'mailbox':{'type':'string','maxLength':140},
        'enabled':{'type':'boolean'},
        'html':{'type':'string','maxLength':20000},
        # 签名里引用的受管图。不带它，签名插进新信只剩取不到的 cid: = 破图
        'resources':{'type':'array','maxItems':20},
        'signatures':{'type':'array','minItems':1,'maxItems':20,'items':schema({
            'id':{'type':'string','minLength':1,'maxLength':100,'pattern':'^[A-Za-z0-9_-]+$'},
            'name':{'type':'string','minLength':1,'maxLength':80},
            'html':{'type':'string','maxLength':20000},
            'resources':{'type':'array','maxItems':20}},['id','name','html'])},
        'default_signature_id':{'type':'string','maxLength':100},
        'signature_revision':{'type':'integer','minimum':0}},['enabled'])),
    # N5-2：阅读 / 编辑草稿 / 代发 / 邮箱配置 / 签名管理**分开控制**，
    # 能读不等于能发。只有「可管授权」的人能开别人的权限，且管理权不等于代发权。
    ('mail.mailbox.grant','开/改员工对某个邮箱的权限',schema({
        'mailbox':{'type':'string','minLength':1,'maxLength':140,
                   'description':'稳定邮箱ID（Shangshu Mail Account 的 account_key），不是登录人'},
        'user':{'type':'string','minLength':1,'maxLength':140},
        'rights':schema({
            'read':{'type':'boolean'},'edit_draft':{'type':'boolean'},
            'send':{'type':'boolean'},'manage':{'type':'boolean'},
            'signature':{'type':'boolean'}},[])},['mailbox','user'])),
    ('mail.mailbox.revoke','收回员工对某个邮箱的全部权限',schema({
        'mailbox':{'type':'string','minLength':1,'maxLength':140},
        'user':{'type':'string','minLength':1,'maxLength':140}},['mailbox','user'])),
]

RIGHTS_DESC='read=阅读 edit_draft=编辑草稿 send=代发 manage=邮箱配置与授权 signature=签名管理'

def get_contribution():
    return {
        # 合并说明：版本与 platform_api 取**更高**的一边（fast 的 0.5.0 / >=1.11）。
        'id':DOMAIN,'name':'邮箱','owner_app':'shangshu_mail',
        # 2026-10-22（PKG-036-T03）：域版本 0.5.0 → **0.6.0** ——
        # 新增动作 `mail.attachment.bind`（把受管文件绑定到这封信上）＋
        # **声明本域在文件中心的那块路径**（外链图／内联图／附件的受管原件落这儿）。
        # 0.6.0 → 0.7.0：邮件对象加案件关联（case_ref）＋ 保存草稿时写过程记录（§8 第 10／11 项）。
        'version':'0.7.0',
        'platform_api':'>=1.11 <2.0','default_enabled':True,
        'applications':[],
        'objects':[{'id':'mail.message','name':'我的邮件','doctype':DOCTYPE,'version':'1.1.0',
                    'schema_version':1,'operations':['read'],'filter_fields':['subject','status'],
                    'fields':[{'id':'name','label':'邮件编号','type':'string'},
                              {'id':'record_version','label':'版本','type':'integer'},
                              {'id':'from_address','label':'发件人','type':'string'},
                              {'id':'received_at','label':'收信时间','type':'string'},
                              {'id':'subject','label':'主题','type':'string'},
                              {'id':'status','label':'状态','type':'string'},
                              # **关联案件**（§8 第 10 项）：这封信是哪个案件的。
                              {'id':'case_ref','label':'关联案件','type':'string'},
                              {'id':'modified','label':'更新时间','type':'string'}],'record_actions':[]}],
        'datasets':[{'id':'mail.message','object_id':'mail.message','name':'我的邮件','roles':ROLES,
                     'query':'shangshu_mail.service.query','columns':[{'field':'subject','label':'主题'},
                     {'field':'modified','label':'更新时间'}],'filters':[]}],
        'actions':[{'id':a[0],
                    # 合并说明：fast 那边还声明了 `proposal_editable_fields`（旧整单确认接口
                    # 只允许改 subject/body）—— 取并集；内核的 _apply_edited_value 会按它设闸。
                    # 白名单用域里的**同一份** `EDITABLE_FIELDS`（见文件头），两处口径不漂。
                    **({'proposal_editable_fields':list(EDITABLE_FIELDS),
                        'review_handler':'shangshu_mail.proposal_review.review'} if a[0]=='mail.save_draft' else {}),
                    **({'proposal_guard':'shangshu_mail.service.proposal_guard'}
                       if a[0] in ('mail.save_draft','mail.send','mail.sync') else {}),
                    'handler':('shangshu_mail.account.execute'
                               if a[0].startswith(('mail.account.','mail.mailbox.'))
                               else 'shangshu_mail.service.execute'),
                    # 这几个回的都是 projection(doc, True) —— 带正文/附件/内联图。
                    # 结果会加密缓存、同键重放原样吐回，所以重放前要按**当前**归属复核
                    # （B5 重放守卫；B 在 shangshu_files 的格值写入上先做了同一套）。
                    # `mail.read` 也在这张表里 —— 它回的正是带正文的那一份。
                    **({'replay_guard':'shangshu_mail.service.replay_guard'}
                       if a[0] in ('mail.save_draft','mail.recycle','mail.restore','mail.read') else {})}
                   for a in ACTIONS],
        'services':[{'id':'mail.thread','handler':'shangshu_mail.service.thread','roles':ROLES,
                     'purpose':'detail','effect':'read','input_schema':schema({'mail':REF['mail']},['mail'])},
                    {'id':'mail.detail','handler':'shangshu_mail.service.detail','roles':ROLES,
                     'purpose':'detail','effect':'read','input_schema':schema({'mail':REF['mail']},['mail']),
                     'output_schema':{'type':'object','properties':{'mail':{'type':'object'}},'required':['mail']}},
                    {'id':'mail.account.status','handler':'shangshu_mail.account.status','roles':ROLES,
                     'purpose':'settings','effect':'read','input_schema':schema({},[])},
                    # N5-1：我能进入哪些邮箱（个人箱 + 获授权的部门箱），以及每个箱上我有什么权。
                    # 前端据此决定**显不显示**按钮；后端仍逐项拒绝，不靠前端藏。
                    {'id':'mail.mailboxes','handler':'shangshu_mail.account.mailboxes','roles':ROLES,
                     'purpose':'settings','effect':'read','input_schema':schema({},[]),
                     'output_schema':{'type':'object',
                                      'properties':{'mailboxes':{'type':'array','items':{'type':'object'}}},
                                      'required':['mailboxes']}}],
        # 工具投影的形状**照 files 域那一行**（`{'id': key}`）——
        # 内核认的是 `id`（domains.py 的 _resource_id 只读 id；`action_id` 没人读），
        # 而 agent 能不能把某个动作**提成交给人工确认**认的也是这张表里的 id
        # （actions.py:394 `_assert_proposable`）⇒ 这两个新动作进表，agent 才提得起来。
        'tools':[{'id':a} for a in ('mail.save_draft','mail.send','mail.sync','mail.reply','mail.forward','mail.read')],
        'processes':[],'roles':[],'events':[],'subscriptions':[],
        'navigation':[],'pages':[],'workbench':[],
        # **本域在文件中心的那块路径**（用户 2026-10-22 15:52 的口径）：
        # 各域**自己声明**；文件中心**照办**（幂等建目录），文件中心**不许硬编码任何域 id**。
        'file_paths':[{'path':'/com.shangshu.mail/来信资料','note':'来信的外链图／内联图／附件的受管原件。'}],
    }
