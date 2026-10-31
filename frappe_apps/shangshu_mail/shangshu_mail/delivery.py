"""邮件域受管收发。SMTP先落库冻结再发，任何不明结果都不自动重试。"""
import hashlib
import json
import mimetypes
import time
from email.utils import make_msgid

import frappe
from frappe.utils import now_datetime
from shangshu_core.public_api import domain_execution, get_request_context, get_record_attachments, require_roles
from shangshu_mail import account, transport
from shangshu_mail.domain import DOMAIN, DOCTYPE
from shangshu_mail.external_assets import external_image_urls, import_mail_assets


def _save(doc):
    from shangshu_mail.service import writing
    with writing(): doc.save(ignore_permissions=True)


def queue_send(payload,context):
    from shangshu_mail.service import message, projection
    # 先确认这封信我够得着，再判**代发权**，最后才去取凭据。
    # 顺序不能反：取凭据那步会因「没绑邮箱/邮箱未连接」先炸，
    # 把真正的原因（没代发权）盖掉 —— 排查时就只剩一句莫名其妙的提示。
    doc=message(payload['mail'],lock=True)
    # **能读不等于能发**（N5-2）：这封信住的那个箱上，我得有代发权。
    # 只看「我能打开这封信」会把只读授权的人也放过去 —— 那是越权代发。
    # getattr 兜底同 has_permission：旧记录/未迁移的行可能还没有 mailbox_id。
    home=getattr(doc,'mailbox_id',None) or account.account_name(doc.owner)
    account.require_right(home,'send')
    # 发信身份 = **这封信住的那个箱**（N5-3），不是操作人自己的个人箱。
    # 改之前一律 get_account() 取个人箱 —— 张三用部门箱代发，
    # 收件方看到的却是张三的个人邮箱，「部门发的信」在信头上根本不存在。
    binding=account.get_account(lock=True,required=True,mailbox=home)
    if doc.record_version != payload['expected_version']:
        frappe.throw('邮件已更新，请重新核对当前版本后发送',frappe.TimestampMismatchError)
    if doc.status not in ('Draft','Queued'):
        frappe.throw('本封邮件已经开始发送或已结束；请核对结果，不要重复发送',frappe.ValidationError)
    if doc.status=='Queued':
        if doc.binding_generation != binding.binding_generation:
            frappe.throw('邮箱授权已变化，待发邮件不能沿用旧授权发送',frappe.ValidationError)
    else:
        recipients=json.loads(doc.to_json or '[]')+json.loads(doc.cc_json or '[]')
        if not recipients: frappe.throw('请先保存至少一个收件人',frappe.ValidationError)
        if not (doc.subject or '').strip(): frappe.throw('请先保存邮件主题',frappe.ValidationError)
        if any(ord(c)<32 or ord(c)==127 for c in doc.subject):
            frappe.throw('邮件主题不能含换行或控制字符',frappe.ValidationError)
        attachments=get_record_attachments(DOCTYPE,doc.name,json.loads(doc.attachment_ids_json or '[]'))
        if sum(item['size'] for item in attachments)>transport.MAX_ATTACHMENT_BYTES:
            frappe.throw('发信附件合计不能超过20MiB',frappe.ValidationError)
        account.credentials(binding)
        doc.status='Queued';doc.binding_generation=binding.binding_generation
        doc.from_address=f'{binding.display_name} <{binding.email_address}>' if binding.display_name else binding.email_address
        doc.message_id=make_msgid(domain='shangshu.local')
        doc.delivery_error='';doc.rejected_json='[]';doc.record_version+=1
        _save(doc)
    # SMTP 那段丢后台任务，**不许留在请求里**：用户 2026-10-12 报「点发送要很久才发出去」。
    # 改之前这里挂的是 frappe.db.after_commit.add(...) —— after_commit 钩子仍在同一个请求里
    # 跑完，界面写着「发送中」，实际是浏览器在等 SMTP 走完（transport.TIMEOUT=20 就是天花板）。
    # 改之后：提交一落库就返回「已排队」，SMTP 由后台任务做。
    user=frappe.session.user;name=doc.name
    # 入参写法（用户放行真网测速后实跑抓到的真 bug）：
    #   改之前 `frappe.enqueue(process_send, queue='long', job_timeout=300,
    #                          enqueue_after_commit=True, kwargs={'name': name, 'user': user})`
    #   两处都错：Frappe 15.118 的 `enqueue` 超时参数叫 **`timeout`** 不叫 `job_timeout`；
    #   而且**没有 `kwargs=` 这个字典参数** —— 函数参数要直接摊在顶层传
    #   （它的文档：`:param kwargs: keyword arguments to be passed to the method`，
    #     实现是 `frappe.call(method, **kwargs)`）。
    #   于是 `job_timeout` 和 `kwargs` 两个键一起被当成**函数参数**塞给
    #   `process_send(name, user)` → TypeError → 任务失败 → 信永远停在「已排队」。
    #   worker 日志原话：`TypeError: process_send() got an unexpected keyword
    #   argument 'job_timeout'`。C7 的桩测试把 frappe.enqueue 整个 stub 掉，测不出来。
    frappe.enqueue(process_send, queue='long', timeout=300,
                   enqueue_after_commit=True, name=name, user=user)
    return projection(doc,True)


def _validate_actor():
    get_request_context()  # 当前身份仍有效，不能用提交时的角色缓存绕过停用。
    require_roles('Desk User','System Manager')


def _has_send_right(mailbox):
    """A queued job must not inherit an employee's subsequently revoked send grant.

    后台任务不继承排队时的代发授权；取凭据与投递前再次核验。
    """
    try:
        account.require_right(mailbox,'send')
    except frappe.PermissionError:
        return False
    return True


def process_send(name,user):
    """after_commit边界，不是Action handler。每个提交都在domain_execution外。"""
    from shangshu_mail.service import message
    original_user=frappe.session.user
    try:
        frappe.set_user(user)
        with domain_execution(DOMAIN):
            _validate_actor()
            doc=message(name,lock=True)
            # 发信身份 = 这封信住的那个箱（N5-3），不是操作人自己的个人箱。
            home=getattr(doc,'mailbox_id',None) or account.account_name(doc.owner)
            binding=account.get_account(lock=True,required=True,mailbox=home)
            if doc.status != 'Queued': return
            home=getattr(doc,'mailbox_id',None) or account.account_name(doc.owner)
            if not _has_send_right(home):
                doc.status='Failed';doc.delivery_error='当前邮箱代发权限已收回，本封邮件未发送'
            elif doc.binding_generation != binding.binding_generation:
                doc.status='Failed';doc.delivery_error='邮箱绑定已改变，本封邮件未发送'
            else:
                doc.status='Sending';doc.delivery_started_at=now_datetime()
                doc.delivery_error='正在发送；若长时间不更新，请在原邮箱核对，勿重复发送'
            doc.record_version+=1;_save(doc)
            can_send=doc.status=='Sending'
            # **「发」那一条（早期失败）**：代发权被收回／邮箱绑定变了 ⇒
            # 这封信**没发出去**，但它已经是**终态** ⇒ 同样要留一笔痕迹
            # （不然「这封信到底发没发出去」这段查不到）。
            if not can_send:
                # **「发」那一条（早期失败）**：代发权被收回／邮箱绑定变了 ⇒
                # 这封信**没发出去**，但它已经是**终态** ⇒ 同样要留一笔痕迹
                # （不然「这封信到底发没发出去」这段查不到）。
                # ⚠ **写口就地调用**（不借模块级 helper）：`process_send` 有判据是
                #   「**把函数抠出来单独跑**」的 ⇒ 借模块级名字会 `NameError`
                #   ⇒ 反而把「写日志」变成「业务挂掉」。
                try:
                    from shangshu_mail.mailprocess import record_send_result
                    record_send_result(doc, status=doc.status, error=doc.delivery_error)
                except Exception as log_error:  # noqa: BLE001 —— 信已落终态，痕迹写不上只通报
                    try:
                        frappe.logger('shangshu_mail').warning(
                            '邮件已发出（或已判失败），但统一日志库那笔过程记录没写上：%s' % log_error)
                    except Exception:  # noqa: BLE001 —— 连通报都失败也不许把正事搞没
                        pass
        frappe.db.commit()
        if not can_send: return
        # Sending已持久化。进程此后退出，后续调用也不重发。
        with domain_execution(DOMAIN):
            _validate_actor()
            doc=message(name,lock=True)
            # 发信身份 = 这封信住的那个箱（N5-3），不是操作人自己的个人箱。
            home=getattr(doc,'mailbox_id',None) or account.account_name(doc.owner)
            binding=account.get_account(lock=True,required=True,mailbox=home)
            if doc.status != 'Sending': return
            home=getattr(doc,'mailbox_id',None) or account.account_name(doc.owner)
            if not _has_send_right(home):
                outcome={'status':'Failed','error':'当前邮箱代发权限已收回，本封邮件未发送','rejected':[]}
            elif doc.binding_generation != binding.binding_generation:
                outcome={'status':'Failed','error':'邮箱绑定已改变，本封邮件未发送','rejected':[]}
            else:
                address,password=account.credentials(binding)
                attachments=[]
                ids=json.loads(doc.attachment_ids_json or '[]')
                labels=json.loads(doc.attachment_labels_json or '{}')
                for item in get_record_attachments(DOCTYPE,doc.name,ids):
                    file_doc=frappe.get_doc('File',item['file'])
                    content=file_doc.get_content()
                    if isinstance(content,str): content=content.encode()
                    display=labels.get(item['file'],{})
                    # 类型按**发出去的名字**定，改过名就从原文件名兜底。
                    # 不传 mime_type 时 transport 一律退回 octet-stream ——
                    # 收件方客户端认不出 XLSX/PDF（用户 2026-10-17 req 1：附件跟草稿一致）。
                    sent_name=display.get('name',item['name']) if isinstance(display,dict) else item['name']
                    mime_type=(mimetypes.guess_type(sent_name)[0]
                               or mimetypes.guess_type(file_doc.file_name or '')[0]
                               or 'application/octet-stream')
                    attachments.append({'name':sent_name,'mime_type':mime_type,'content':content})
                # 受管内联图随信走 related 段，保留 Content-ID 与原始 MIME 类型。
                # 取字节前先经公共附件契约做归属校验：能看这封信 ≠ 能读任意 File 字节。
                inline=[]
                inline_files=[item.get('file') for item in json.loads(doc.inline_resources_json or '[]')
                              if item.get('content_id') and item.get('file')]
                authorized={item['file'] for item in get_record_attachments(DOCTYPE,doc.name,inline_files)} if inline_files else set()
                for item in json.loads(doc.inline_resources_json or '[]'):
                    if not item.get('content_id') or item.get('file') not in authorized: continue
                    content=frappe.get_doc('File',item['file']).get_content()
                    if isinstance(content,str): content=content.encode()
                    inline.append({'content_id':item['content_id'],'mime_type':item.get('mime_type') or 'image/png',
                                   'name':item.get('name') or 'inline.img','content':content})
                outcome=transport.send_message(address,password,binding.display_name or '',{
                    'subject':doc.subject,'body':doc.body or '','body_format':doc.get('body_format') or 'Text',
                    'to':json.loads(doc.to_json or '[]'),'cc':json.loads(doc.cc_json or '[]'),
                    'message_id':doc.message_id,'in_reply_to':doc.in_reply_to or ''},attachments,binding.provider,
                    inline_resources=inline,
                    # 连接池按「邮箱 + 凭据版本 + 安全配置」隔离；凭据版本就是 binding_generation
                    # —— 改密/换授权后旧连接是旧身份，不许再用（用户 2026-10-12）。
                    credential_version=binding.binding_generation)
            doc.status=outcome['status'];doc.delivery_error=outcome['error']
            doc.rejected_json=json.dumps(outcome['rejected']);doc.record_version+=1
            doc.sent_at=now_datetime() if outcome['status'] in ('Sent','Partial') else None
            _save(doc)
            # **「发」那一条（出终态）**：SMTP 完了、信落终态 ⇒ 留一笔痕迹
            # （结果与失败原因；**收件人地址不进日志**）。
            # ⚠ 这两条路径**互斥**（早期失败那条到这儿就 `return` 了）
            #   ⇒ 每次发信**恰好一条**记录。
            try:
                from shangshu_mail.mailprocess import record_send_result
                record_send_result(doc, status=outcome['status'], error=outcome.get('error') or '')
            except Exception as log_error:  # noqa: BLE001 —— 信已落终态，痕迹写不上只通报
                try:
                    frappe.logger('shangshu_mail').warning(
                        '邮件已发出（或已判失败），但统一日志库那笔过程记录没写上：%s' % log_error)
                except Exception:  # noqa: BLE001 —— 连通报都失败也不许把正事搞没
                    pass
        frappe.db.commit()
    except Exception:
        # 不把服务商异常/密码写日志；已提交的Sending是可见对账状态。
        frappe.db.rollback()
        frappe.clear_messages()
    finally:
        frappe.set_user(original_user)


def _employee_key(user):
    """登录名 → 员工身份键（Shangshu Identity 的 `identity_id`，docname 即此值）。

    UI-054 / BASE967-16：「所有人」显示/筛选/读取要**同一个身份键**。文件域 schema
    早就声明 `owner_subject`=「所有人ID（员工ID或部门ID）」，文件中心筛选下拉给的
    也是 `identity_id`；而这里以前写登录名（`qa-a2@example.invalid`），筛选按等值
    一比就成 0。登录名 → 员工键走 Shangshu Identity 的 user 映射，**可验证转换**，
    不靠名字猜员工；没有身份行就建一行（内核 `ensure_identity_for_user` 的语义）。
    """
    if not user:
        return ''
    from shangshu_core.public_api import ensure_identity_for_user
    return ensure_identity_for_user(user) or ''


def attachment_owner(mail, fallback_user):
    """来信附件的「所有人」按**邮箱归属**推导，不看点同步的那个人。

    执行计划 §C10 原话：「个人邮箱的附件归所属员工；共享邮箱的附件归所属部门，
    不归第一个打开邮件的人。」

    为什么不直接用收信执行者（第一版就是这么写的，实测撞了两处）：
      共享箱是几个人共用一个箱，**谁点的同步是偶然的**。
      · 归属上：同一批来信的附件会分属不同人，「共享箱归部门」成了一句空话；
      · 幂等上：两人先后导同一条附件，幂等键相同但推导出来的所有人不同，
        动作层当场报「幂等键已被不同请求使用」—— 后一个人白点一次，还在失败日志里留一条假警报。
      归属跟邮箱走，两个人算出来的内容就一样了。

    没有账号行时用收信执行者兜底（往**少**了给，不会越权）：
      取不到邮箱登记就认不出部门，只能按员工算；宁可归窄不归宽。
    """
    box = frappe.db.get_value(DOCTYPE, mail, 'mailbox_id')
    acct = frappe.db.get_value('Shangshu Mail Account', {'account_key': box},
                               ['kind', 'department', 'owner', 'email_address'], as_dict=True) if box else None
    if acct and acct.kind == 'department':
        # 「所有人」是**授权链认得出的受管部门 ID**，不是随手写的标题 ——
        # 见 department_key()。这一条不再拿邮箱地址兜底（那一版把
        # 「所有人」写成了 sales@xx.com 这种既非员工ID也非部门ID的东西，
        # 授权判定永远解析不了，「共享箱归部门」成了摆设）。
        return {'owner_subject_kind': 'Department',
                'owner_subject': department_key(acct.department)}
    owner = (acct.owner if acct else None) or fallback_user
    # 员工键是**员工 ID**（UI-054：筛选按员工 ID 等值，写登录名就筛出 0）。
    return {'owner_subject_kind': 'Employee', 'owner_subject': _employee_key(owner)}


def attachment_attribution(mail, fallback_user):
    """给文件域的**归属载荷**（`files.import_attachment` 的 `attribution` 入参）。

    「所有人」（`attachment_owner`）是文件中心的**显示/筛选**字段；
    这一份是**授权判定**认的那一份 —— 同一个**用户**、同一次推导，落点和键不同：
    显示/筛选用**员工身份键**（`identity_id`，UI-054 统一口径），
    授权链用**登录名**（`owner_user`，`org_admin` 按 User 认）——
    两者经 Shangshu Identity 的 user↔identity_id 映射**可验证**互认，
    不拿显示字段替换授权（源文明确）。前者进 `mail_system`，后者进文件域的
    `attribution`，由它经 `org_admin.attribution_record` 落 `Shangshu Org Attribution`。

    **为什么不让文件域直接吃 `mail_system`**（B 2026-10-14）：
    文件域注释写着「来源授权与目标域存储相互独立，**不导入邮件/财务代码**」——
    把 `mail_system` 开进文件域等于给它塞一份邮件耦合。所以邮件域自己推好归属，
    以文件域**本来就有的** `attribution` 入参交过去，`mail_system` 留在邮件域。

    **建表权那道门不在这儿判**（B 的口径）：
    「**用户选的**归属必须过建表权；**服务端从受管登记推的**归属不看建表权，
      但必须只在受管上下文可达」—— 差别在**谁选的**，不在落不落表。
    这里推的是后者：部门来自邮箱登记（服务端），用户改不了请求；
    `mail_system` 本来就只在受管收信上下文（`writing()`）才准带。

    返回形状（B 定死，不变）：
      个人箱 → `{'level':'personal','owner_user':<邮箱所属员工>}`
      部门箱 → `{'level':'department','department':<受管部门 ID>}`
    """
    box = frappe.db.get_value(DOCTYPE, mail, 'mailbox_id')
    acct = frappe.db.get_value('Shangshu Mail Account', {'account_key': box},
                               ['kind', 'department', 'owner'], as_dict=True) if box else None
    if acct and acct.kind == 'department':
        return {'level': 'department', 'department': department_key(acct.department)}
    owner = (acct.owner if acct else None) or fallback_user
    return {'level': 'personal', 'owner_user': owner}


def _attribution_supported():
    """文件域认不认 `attribution` 入参（B 的 a4057290）。

    两支还没合（`mail-c1-batch1` 与 `excel-ab-int` 岔开 72/84 笔，用户交代「有冲突别硬解」）。
    本分支的 `files.import_attachment` schema 是 `additionalProperties: False` ——
    硬传会把**整条导入**拒掉，附件直接不入库，比不落归属还糟。

    所以：认就传、不认就不传。**两支合了自动点亮，不用回来改代码。**
    """
    from shangshu_core.public_api import list_registered_actions
    for entry in list_registered_actions():
        if entry['id'] == 'files.import_attachment':
            return 'attribution' in (entry.get('input_schema') or {}).get('properties', {})
    return False


def _has_dept_authority():
    """受管部门表在不在（B 的组织层：Shangshu Department / Shangshu Org Attribution）。

    合并说明：fast 那边改成「受管组织能力由公共版本依赖保证，不探测/直查核心数据表」
    ⇒ 恒为 True。本分支是**真的探一次**（走公共面 `has_department_authority`，
    不直查核心表）—— 组织层还没合进来时，部门口径就不该假装可用。
    两边不冲突：表在 → 都是 True；表不在 → 本分支更严（拒），不会给出错的部门授权。
    """
    from shangshu_core.public_api import has_department_authority
    return has_department_authority()


def department_key(raw):
    """把邮箱登记的「所属部门」收成**授权链认得出的部门 ID**（`Shangshu Department.name`）。

    为什么不能写自由文本（B 2026-10-14 实测原话）：
      `attribution.department` 填**标题** → HTTP 417「部门不存在」
      `attribution.department` 填 `Shangshu Department.name`（ID） → 正确路径
    写标题 = 写一个 `write_allows` / `download_allows` 永远解析不了的键，
    「共享箱归部门」看着成立、授权那半全是空的。

    解析放在这一步（**绑邮箱的时候**），导入只做透传，不再做第二次映射 ——
    标题→ID 是会漂的映射，不该在附件导入这条热路径上赌。

    · 值已经是部门 ID → 一字不差用
    · 值是标题且**只有一个**部门叫这个名 → 收成那个 ID
    · **同名多个 / 查无此部门 / 空** → 当场拒，提示改成部门编号
      （宁可这条附件不入库、留一条可查的失败，也不写一个假所有人）
    """
    raw = str(raw or '').strip()
    if not raw:
        frappe.throw('部门邮箱没有登记所属部门，附件无从归属。'
                     '请先在邮箱设置里把这个邮箱的所属部门填成受管部门。', frappe.ValidationError)
    if not _has_dept_authority():
        # 过渡：受管部门表还没合入本分支（在 excel-ab-int）。
        # 这时候这个键**只做显示**，write_allows / download_allows 认不出它 ——
        # 不假装能授权。等组织层合进来，下面那几条自然接管。
        return raw
    # 合并说明：fast 那边走 `organization.resolve_department(raw)`（新公共面里的同名实现），
    # 本分支走 `resolve_department_key(raw)` —— **两者口径一致**（同企业、启用的部门，
    # 编号优先、名称唯一才认，认不出就拒）。两个入口在 public_api 里都在，这里取本分支的。
    from shangshu_core.public_api import resolve_department_key
    return resolve_department_key(raw)


def imported_of(source_files):
    """按**来源附件**批量问文件域「进过文件中心没有」—— 走它公开声明的只读口。

    为什么不是 `frappe.db.exists('Shangshu File Center Version', {'source_file': …})`
    这种直查：那张表是文件域的**内部表**，跨域直接读对方的表，
    平台契约检查（`check-platform-contract.mjs`）拦不到 —— 它的 doctype 名单只从
    `shangshu_core` 收，`Shangshu File Center Version` 属 `shangshu_files`，**放行**。
    改走 `files.imported_of`，耦合还在，但从「读对方的表」变成「调对方声明的口」，
    后者能被 `assert_declared_call` 和插件依赖声明管住。

    文件域的三条语义（B 2026-10-14 给的契约，照读，别自己发挥）：
      · `known` 和 `imported` 是**两件事，不许合并**。
        `known:false`（来源附件根本不存在）**不等于**「没入库」。
      · 无权看那个受管文件时回 `imported:true` + `file_center_id:null` + `restricted:true`，
        **不抛** —— 界面上等于「已入库」，**不是**「未入库」。
      · 「已入库」认**两条路**：`source_file`（被 import_attachment 导过）
        **和** `frappe_file`（本来就是某个受管版本的固定附件）。
        只认前一条会把后者判成「没入库」，多一个「存入」按钮，点下去再导一遍。

    返回 `{来源附件编号: 那一条 item}`；口一次最多 100 个，超出的分批问。
    """
    from shangshu_core.public_api import invoke_domain_service, list_domains
    ids = [str(one).strip() for one in (source_files or []) if str(one or '').strip()]
    if not ids:
        return {}
    # 文件中心是可选集成：未安装、停用或未提供查询时仍可读邮件自身附件。
    # 仅根据公共领域声明判断可用性；不吞服务的权限错误，也不直查文件域内部表。
    files_domain = next((row for row in list_domains(include_disabled=True)
                         if row.get('id') == 'com.shangshu.files'), None)
    if not files_domain or not files_domain.get('enabled') or files_domain.get('execution_stopped') \
            or (files_domain.get('health') or {}).get('status') == 'unavailable':
        return {}
    services = (files_domain.get('contribution') or {}).get('services') or []
    if not any(service.get('id') == 'files.imported_of' for service in services):
        return {}
    out = {}
    for start in range(0, len(ids), 100):
        reply = invoke_domain_service('files.imported_of',
                                      {'source_files': ids[start:start + 100]}) or {}
        for item in (reply.get('items') or []):
            out[str(item.get('source_file'))] = item
    return out


def attachment_idempotency_key(mail, source_file, operator):
    """自动入库的幂等键 —— 「信 + 附件 + **操作人**」。

    **为什么键里要有操作人**（B 2026-10-14 的治根方子）：
      两个不同的人各同步同一个附件，是**两次尝试**，不是一次的重试 —— 键本来就该不同。
      只按「信 + 附件」定死时，第二个人撞上内核 `action_requests.assert_binding`：
      它连 `actor_identity`（谁发的这次请求）一起比，两个人本来就不同 →
      抛「幂等键已被不同请求使用」，而附件其实好好的只有一条、所有人也没变。
      **假警报** —— 失败日志每多一个人同步就涨一条，把真失败淹掉。
      拼上操作人之后：两人两个键，第二个人拿到 `imported_attachment` 自己的
      `already_imported: True`，而不是 409。

    **同一人重复同步仍是同一个键**（不是随机数）—— 那才是重试，照走重放、不重复导。

    内核 `assert_binding` **不动**：它在 `core_paths`，一动影响所有动作，该单独立项。
    """
    return 'mail-att-' + hashlib.sha256(
        f'{mail}\0{source_file}\0{operator}'.encode()).hexdigest()[:40]


# 本域在文件中心的那块路径（用户 2026-10-22 15:52 的口径：每个域注册都要有自己的路径）。
MAIL_ASSET_PATH = "/com.shangshu.mail/来信资料"


def _store_incoming_asset(mail, name, content):
    """来信的附件／内联图：**字节由文件域放**，并**挂在这封信上**。

    改前（2026-10-22 之前）：邮件域**自己**建 `File`（塞内容、挂在信上）
    ⇒ 那正是文件中心契约 `exemptions` 里登记的**限期豁免**
    ⇒ 「所有进尚书的文件都进文件中心」这句话，在来信附件这条链上是破的。

    改后：走**文件域的公开动作 `files.upload_attached`**（放字节 ＋ 指定挂在谁身上）
    ⇒ ① 字节由文件域放（受管入库 ＋ 归属 ＋ 审计 ＋ 幂等）；
    ② 那个 File 行**仍挂在这封信上** ⇒ **读信面按这封信的归属取字节照旧**、
    正文 `cid:` 引用**照旧解析得出图**；
    ③ **字节仍然只有一份**（File 行指向同一个磁盘文件，不是复制）。

    ⚠️ **为什么必须在收信事务里就放**（不是等后台任务）：附件字节**当场就得落盘** ——
    等后台任务的话，事务一提交这批字节就没了（邮件还在、附件丢了）。
    ⇒ 所以放在**收信事务里**（内核的动作失败路径只回滚到本动作的 savepoint，不会提前提交）。

    返回：**挂在信上的那个 File 编号**（`attachment_ids_json` 与内联资源表要的就是它）。
    """
    import base64
    import hashlib
    from shangshu_core.public_api import execute_registered_action

    digest = hashlib.sha256(content).hexdigest()
    receipt = execute_registered_action(
        'files.upload_attached',
        {'file_name': name,
         'content_base64': base64.b64encode(content).decode('ascii'),
         'file_sha256': digest,
         'attach_to': {'doctype': DOCTYPE, 'name': mail},
         'directory': MAIL_ASSET_PATH,
         'note': '来信附件／内联图（邮件域）',
         # 归属按**这封信的归属**推（邮箱 → 员工／部门），不是请求里随便填的。
         'attribution': attachment_attribution(mail, frappe.session.user)},
        confirmed=True,
        # 幂等键按「这封信 ＋ 字节摘要」算 ⇒ 同一封信重收一次不会长出第二份。
        idempotency_key='mail:incoming-asset:%s:%s' % (mail, digest),
    )
    result = receipt.get('result') or {}
    file_id = str(result.get('attached_file') or '')
    if not file_id:
        frappe.throw('来信附件没能进文件中心（%s）' % name, frappe.ValidationError)
    return file_id


def import_into_file_center(mail,user,files):
    """把一批 File 送进文件中心 —— **不动邮件正文**（逐条回报 imported/already/failed）。

    这是「入库」那一步本身；「把正文里的 `cid:` 换成受管地址」是**另一步**
    （`repoint_body_links`）—— 分开是为了让别处能复用入库而不动正文
    （回复/转发那条公共实现要的是「原信正文一个字不改」）。
    """
    from shangshu_core.public_api import execute_registered_action
    from shangshu_mail.service import writing
    original_user=frappe.session.user
    mail_system={'related_mail': mail, **attachment_owner(mail, user)}
    # 归属载荷交给文件域（B 的 a4057290 加的 attribution 入参，和 files.upload 同一套）：
    # 它经 _apply_attribution → org_admin.attribution_record 落 Shangshu Org Attribution，
    # 那才是 write_allows / download_allows 认的权威表。
    # 宁可不自动入库（邮件里的附件还在，只是没进文件中心），
    # 也不要带着错的授权进。
    if not _attribution_supported():
        frappe.throw(
            '文件域当前不接受归属入参（attribution），本次不入库：'
            '带着没有归属的附件进文件中心，授权会回落到旧目录判定。',
            frappe.ValidationError)
    attribution = attachment_attribution(mail, user)
    # 这次**真正在点同步的员工** —— 幂等键里的「操作人」。
    # **不取 `attribution.owner_user`**：归属是按邮箱推的，共享箱里几个人推出来是**同一个**。
    operator = user or frappe.session.user
    results=[]
    try:
        frappe.set_user(user)
        with writing():
            for fid in (files or []):
                # 同一条附件已经归档过就不再走动作入口 —— 共享箱几个人各同步一次是常态。
                info = imported_of([fid]).get(str(fid)) or {}
                if info.get('imported'):
                    # `restricted:true` 时 `file_center_id` 是空 —— 这种**照旧记 already**。
                    results.append({'file': fid, 'status': 'already',
                                    'file_center': info.get('file_center_id')})
                    continue
                try:
                    outcome=execute_registered_action(
                        'files.import_attachment',
                        {'source': {'ref_doctype': DOCTYPE, 'ref_name': mail, 'file': fid},
                         'directory': '/来信附件',
                         'mail_system': mail_system,
                         **({'attribution': attribution} if attribution else {})},
                        confirmed=True, source='system',
                        # 键里带操作人 —— 两个人各同步是两次尝试，不是一次重试。
                        idempotency_key=attachment_idempotency_key(mail, fid, operator))
                    # **成功就落定**：动作层的失败路径是整事务 `frappe.db.rollback()` ——
                    # 那个假设对**批量循环**是错的（后面的失败会把前面导好的卷走）。
                    # 每个提交一次，坏的不拖累好的。
                    frappe.db.commit()
                    body=(outcome or {}).get('result') if isinstance(outcome,dict) and 'result' in outcome else outcome
                    results.append({'file':fid,'status':'imported',
                                    'file_center':(body or {}).get('file')})
                except Exception as import_error:
                    # 单条失败**不拖累其它**，但**必须报出来**（吞进失败日志等于把故障藏起来）。
                    reason=''.join(c if 32 <= ord(c) else ' ' for c in str(import_error))[:200]
                    frappe.log_error(title='来信附件自动入库失败',
                                     message=f'mail={mail} file={fid} reason={reason}')
                    results.append({'file':fid,'status':'failed','reason':reason})
    finally:
        frappe.set_user(original_user)
    return results


def import_mail_attachments(mail,user,files):
    """C10：把收进来的信的附件送进文件中心 —— **走文件域自己的受管动作**。

    为什么不能直调 `shangshu_files.service.import_attachment`（实测撞过）：
      内核 `bind_record_attachments` 要求「附件绑定必须由所属领域的公共动作执行」，
      它核的是「当前调用域 == 该记录的归属域 == 该动作的属主」。
      邮件收信是**邮件域**的动作，直调文件服务时三个都对不上 →
      `PermissionError: 附件绑定必须由所属领域的公共动作执行`。
      所以必须经 `execute_registered_action('files.import_attachment')` ——
      那条正门会把「当前域 / 动作钉」设对，还管角色、幂等与审计。

    为什么在提交后的后台跑，不套在收信事务里：
      动作入口有自己的失败记账和提交边界（失败路径会落一行失败请求并提交），
      套在收信事务里会把收信那次提交提前放出去。

    幂等：幂等键按「信 + 附件 + **操作人**」定死。动作层的语义正好 ——
      失败的键允许重跑（那次的副作用已整体回滚），成功的键返回同一结果。
      叠上 import_attachment 自己的 already_imported，重试不会多建一条。
      **操作人是 B 2026-10-14 提的治根方子**：两个不同的人各提交一次是**两次尝试**，
      不是一次的重试 —— 键本来就该不同（详见下面 operator 那段注释）。
      内核 `action_requests.assert_binding` **不动**：那是 `core_paths`，
      一动影响所有动作，该单独立项。

    所有人 / 关联邮件由**服务端**推导填，不信任何请求值：
      见 attachment_owner() —— 个人邮箱归邮箱所属员工，共享邮箱归所属部门。
      只有受管收信上下文（writing()）才准带这两个字段，普通请求带上一律拒。

    失败不影响邮件可读（契约：「不伪称附件已可用」），但要有原因可查。
    """
    results = import_into_file_center(mail, user, files)
    repoint_body_links(mail, results)
    return {'mail':mail,'attachments':results,
            'failed':[r for r in results if r.get('status')=='failed']}


def managed_file_url(file_center_id, file_name):
    """受管地址 —— **文件中心自己在用的那个下载口**（`file-center.js` 349/358 行同款）。

    它带 `can_read_reference` 权限判定：授权范围内的人点得开，撤权后失效。
    这就是用户说的「受管外链可行」里的那个**受管**。
    既然走的是受管口，就**不需要放宽任何安全检查** —— 外链图转成它即可放行。
    """
    from urllib.parse import urlencode
    return '/api/platform/file-content?' + urlencode({
        'ref': 'Shangshu File Center File',
        'ref_name': str(file_center_id or ''),
        'file': str(file_name or ''),
    })


def repoint_body_links(mail, results):
    """链接重接（用户 2026-10-13 口径）：正文里的图/附件引用**重接到文件库的受管地址**。

      「正文中的附件引用/图片链接重接到文件库的受管地址，不再指向原始 MIME 内嵌
        或临时路径。同一逻辑资源多人共用，不为每个收件人各存一份。」

    做法：把正文里每一个 `cid:<content_id>` 换成对应文件的**受管地址**。

    **失败的不瞎改**（判据第 5 条）：没真入库成功的那条引用**留原样**。
    改成一个假地址比留着原样更糟 —— 看着像好了，其实是破的。
    """
    from shangshu_mail.service import writing
    doc=frappe.get_doc(DOCTYPE, mail)
    body=doc.get('body') or ''
    if not body or 'cid:' not in body:
        return
    # 真入库成功 / 早已入库 的才有受管地址；failed 的不进这张表
    ok={r.get('file'): r for r in (results or [])
        if r.get('status') in ('imported','already') and r.get('file')}
    if not ok:
        return
    # content_id → 附件 File id（正文里引的是 content_id，不是 File id）
    try:
        inline=json.loads(doc.get('inline_resources_json') or '[]')
    except Exception:
        return
    changed=False
    for item in inline:
        cid=str(item.get('content_id') or '').strip().strip('<>')
        fid=item.get('file')
        if not cid or fid not in ok:
            continue
        record=ok[fid]
        # 受管 id 只从**这一条附件自己的**回包/预判结果里取，不再兜底去查。
        # 改之前那两行兜底有两个真毛病（B 2026-10-14 也点出来了）：
        #   · `Shangshu File Center Version` **没有 `parent` 列** —— 指向受管文件的
        #     Link 字段叫 `file`。这行取不到正确列。
        #   · 兜底那个 `{'file_name': …}` 是**全库按文件名匹配**，同名文件会取错。
        # 现在：`already` 那条路的 `file_center` 已经由预判（走 files.imported_of）
        # 带回来了；取不到就**留原样**，不拼假地址 —— 假地址比留着原样更糟。
        center=record.get('file_center')
        if not center:
            continue
        url=managed_file_url(center, fid)
        # cid: 在 HTML 里是 src="cid:…" / href="cid:…"，整段换掉
        for attr in ('src','href'):
            old=f'{attr}="cid:{cid}"'
            new=f'{attr}="{url}"'
            if old in body:
                body=body.replace(old,new); changed=True
            oldq=f"{attr}='cid:{cid}'"
            newq=f"{attr}='{url}'"
            if oldq in body:
                body=body.replace(oldq,newq); changed=True
        # 也可能写成裸 cid: 后跟引号外的形式（少见）—— 保守起见只替换前缀
        if f'cid:{cid}' in body:
            body=body.replace(f'cid:{cid}', url); changed=True
    if not changed:
        return
    doc.body=body
    with writing():
        doc.save(ignore_permissions=True)
    frappe.db.commit()


def sync_account(payload):
    # 阅读权允许拉取当前箱，不授予代发或配置权；显式编号从不回退本人。
    target=str((payload or {}).get('mailbox_id') or '').strip()
    if target:
        account.require_right(target,'read')
    binding=account.get_account(lock=True,required=True,**({'mailbox':target} if target else {}))
    if binding.connection_status!='connected':
        frappe.throw('邮箱未连接或已暂停，请在邮箱设置中处理',frappe.ValidationError)
    return binding

def sync(payload,context):
    from shangshu_mail.service import writing
    binding=sync_account(payload)
    address,password=account.credentials(binding)
    connection=None;added=0;skipped=0;errors=[];started=time.monotonic()
    try:
        connection=transport.imap_session(address,password,binding.provider)
        validity,uids=transport.inbox_uids(connection)
        # 首批面向人工即时同步，明确只取最近100封，不伪称历史全量迁移。
        candidates=[]
        # 个人邮箱保留原去重键；企业节点分别命名空间化，改机房不误认另一邮箱的UID。
        mailbox=address if binding.provider in ('qq','163') else f'{address}\0{binding.provider}'
        for uid in reversed(uids[-100:]):
            # 去重键按**邮箱**算，不按登录人（N5-4「一个邮箱同步一次、多用户共读」）。
            # 改之前含 frappe.session.user —— 张三和李四各同步一次同一个部门箱，
            # 同一封信会算出两个键 → 收成两份。这正是「不为每个人复制一份」要挡的。
            identity=hashlib.sha256(f'{binding.account_key}\0{mailbox}\0{validity}\0{uid}'.encode()).hexdigest()
            # 旧键（含登录人）也算一遍 —— 否则改了公式，库里已有的信会被当新的重收一遍。
            legacy=hashlib.sha256(f'{frappe.session.user}\0{mailbox}\0{validity}\0{uid}'.encode()).hexdigest()
            if frappe.db.exists(DOCTYPE,{'incoming_key':['in',(identity,legacy)]}): skipped+=1
            else: candidates.append((uid,identity))
        processed=0
        # 名额仍按新→旧挑（「最近 100 封 / 每次最多 20 封」），但**处理顺序改成 UID 升序**：
        # 回信靠 in_reply_to 回指原信（下面 :154-156），新的先入库会让回指落空 ——
        # 同批里原信还没建，线程就断了（N2-C4 实测：同批的「线程根」与「Re: 线程根」只聚到根）。
        batch=sorted(candidates[:20],key=lambda item:item[0])
        for uid,identity in batch:
            if time.monotonic()-started>45: break
            # 单封失败只坏这一封：解析失败（ValueError）**和存信/存附件失败**都要隔离。
            # 实测：一封信附了个名字叫 .pdf 却不是合法 PDF 的附件，Frappe 存盘时去解析 PDF 查 JS
            # 抛 PdfStreamError —— 它不是 ValueError，旧写法落进外层「整批中止」，好信也进不去。
            # 用 savepoint 回到这一封开始前，不牵连本批前面已经存好的信。
            save='mail_sync_'+frappe.generate_hash(length=8)
            frappe.db.savepoint(save)
            try:
                parsed=transport.fetch_message(connection,uid)
                doc=frappe.new_doc(DOCTYPE)
                doc.update({'subject':parsed['subject'],'body':parsed['body'],'status':'Received',
                            'record_version':1,'to_json':json.dumps(parsed['to'],ensure_ascii=False),
                            'cc_json':json.dumps(parsed['cc'],ensure_ascii=False),'from_address':parsed['from_address'],
                            'received_at':now_datetime(),'message_id':parsed['message_id'],
                            'in_reply_to':parsed['in_reply_to'],'incoming_key':identity,
                            # Reply-To 头存下来，回复时优先用它（RFC 5322）
                            'reply_to_address':parsed.get('reply_to_address',''),
                            'source_mailbox':address,'binding_generation':binding.binding_generation,
                            # 收进哪个箱就挂哪个箱 —— 部门箱的信归部门，
                            # 不归第一个把它同步进来的人（N5-1）。
                            'mailbox_id':binding.account_key,
                            'body_format':parsed.get('body_format') or 'Text'})
                if parsed['in_reply_to']:
                    doc.reply_to_mail=frappe.db.get_value(DOCTYPE,{'mailbox_id':binding.account_key,
                        'message_id':parsed['in_reply_to']},'name')
                with writing():
                    doc.insert(ignore_permissions=True)
                    attachments=[]
                    for item in parsed['attachments']:
                        attachments.append(_store_incoming_asset(doc.name, item['name'], item['content']))
                    doc.attachment_ids_json=json.dumps(attachments)
                    # 受管内联资源：保留 Content-ID 与原始 MIME 类型，正文 cid: 引用才解析得了。
                    inline=[]
                    for item in parsed.get('inline_resources',[]):
                        inline.append({'content_id':item['content_id'],'mime_type':item.get('mime_type') or 'image/png',
                                       'name':item.get('name') or 'inline.img',
                                       'file':_store_incoming_asset(doc.name, item.get('name') or 'inline.img', item['content'])})
                    doc.inline_resources_json=json.dumps(inline,ensure_ascii=False)
                    doc.save(ignore_permissions=True)
                    # C10：来信附件**自动**进文件中心 —— 不等员工打开邮件、不点「存入」。
                    # 所有人按邮箱归属推导：个人邮箱 → 邮箱所属员工。
                    # 共享邮箱 → 所属部门那条依赖 N5，现在还没有共享邮箱概念，**不冒报**。
                    #
                    # 这里**只登记要入库哪些附件**，真正的入库丢到提交之后跑：
                    #   · 入库必须走文件域自己的受管动作（内核的 bind_record_attachments
                    #     要求「附件绑定必须由所属领域的公共动作执行」，邮件域直调会被拒）；
                    #   · 而那个动作入口有自己的失败记账和提交边界，**不能套在收信事务里**；
                    #   · 收信这一封的落库也不该被文件中心的问题拖住（契约：「不伪称附件已可用」）。
                    if attachments:
                        frappe.enqueue(import_mail_attachments, queue='default', timeout=120,
                                       enqueue_after_commit=True,
                                       mail=doc.name, user=frappe.session.user, files=attachments)
                    # ★ 外部内容入库与内链化（用户 2026-10-21：「对于外部内容，接受就直接进入
                    #   文件中心，给他一个内链，让这些都能显示和转发」）：
                    #   · 来信正文里的**外链图**（http/https）取回来 → 落成这封信的 File →
                    #     进文件中心 → 正文里的引用换成 `cid:`（出站净化门只认 cid:）；
                    #   · 来信的**内联图**也一并进文件中心（原来**只有附件**进）——
                    #     有了文件中心记录，**转发时就不用再存一次**。
                    #   这一趟要**联网取字节** ⇒ 丢到提交之后跑（与附件入库同一层），
                    #   不拖住收信；取不到的引用**留原样**（不编地址）。
                    if attachments or inline or external_image_urls(doc.body or ''):
                        frappe.enqueue(import_mail_assets, queue='default', timeout=300,
                                       enqueue_after_commit=True,
                                       mail=doc.name, user=frappe.session.user)
                frappe.db.release_savepoint(save)
            except frappe.PermissionError:
                raise                       # 授权问题不是「这一封坏了」，整批停
            except Exception as error:
                frappe.db.rollback(save_point=save)
                # 原始异常可能带服务商回显/用户输入，不能原样进响应：去控制字符、限长。
                text=str(error) or error.__class__.__name__
                reason=''.join(ch if 32 <= ord(ch) else ' ' for ch in text)[:200].strip() or error.__class__.__name__
                errors.append({'uid':str(uid),'reason':reason});processed+=1;continue
            added+=1;processed+=1
        binding.last_sync_at=now_datetime();binding.connection_status='connected';binding.last_error=''
        with account.writing(): binding.save(ignore_permissions=True)
        return {'added':added,'skipped':skipped,'errors':errors,'has_more':processed<len(candidates),
                'notice':'同步收件箱最近100封，每次最多20封；不修改原邮箱已读或删除状态',
                'account':account.projection(binding)}
    except (frappe.PermissionError,frappe.ValidationError): raise
    except Exception:
        frappe.clear_messages()
        frappe.throw('收信失败，请核对邮箱授权后重试；已保存邮件不会重复导入',frappe.ValidationError)
    finally: transport.close(connection)
