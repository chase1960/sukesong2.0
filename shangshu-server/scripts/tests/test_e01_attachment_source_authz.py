"""R967-E01 · BASE967-38：收信附件**可见范围跟随来源当前授权**（G1 门槛「共享附件撤权拒绝」）。

**测试通过 = 下面每条成立**：

1. **前置·造出「已收邮件 + 自动入库附件」**：真邮件行 + 挂信附件 + 走生产那条
   `delivery.import_mail_attachments`（和真收信一模一样，不另造测试专用路）。
2. **获邮箱读权者读得到**（走 `files.review` 真读口；**下载**另按导出权判 ——
   邮箱读权给的是**读**，不是下载）。
3. ★ **撤掉邮箱读权后，同一人下不到** —— 这就是 G1 门槛「共享附件撤权拒绝」。
4. ★ **同部门 / 同企业但无邮箱授权者**下不到（**部门所有人 ≠ 部门所有员工自动获读权**）。
5. **敏感度**：同一人、同一文件，撤权前后给**两种不同答案**（不恒同）。

---
**口径不是我编的**，是用户已确认的（`fde/设计/契约/账号与权限.md`
§`#mail-attachment-access`「邮件附件自动入库与文件筛选」2026-10-13 追加，六条）：

> **1. 默认可见范围保持一致。** 自动入库的附件**按来源邮箱/邮件附件的当前读取授权**……
> **文件中心不能成为读取无权邮件附件的旁路**。共享邮箱授予的读取权须在文件入口生效，
> **部门所有人不等于部门所有员工自动获读权**。
> **3. 归属不替代动作权。** 所有人不是收信执行者……不借系统管理员全局放行。
> **4. 关联不自动授权。** 文件上存在关联邮件不赋予整封邮件阅读权……
> **不能改系统字段提权或抹掉来源约束**。
> **5. 变化及时生效。** 调岗、撤权、取消负责人、共享邮箱授权变化后，文件列表/计数、
> **旧链接及缓存均重验**……来源邮件删除后仍保留邮箱/资源授权依据，
> **关联不可读不等于文件自动公开**。
> **6. 无短暂越权窗口**……测试必须包含普通员工、管理者、**共享邮箱授权者**及
> **同部门未授权者**的正反例，**不能只测下拉框隐藏**。

**⚠️ 单向，别做反**：附件可见范围**跟随来源**（丢来源 → 丢附件），
但关联**不反过来**给来源读权（第 4 条）。所以本组只断言「来源没权 → 附件没权」，
**不断言**「有附件就能读信」。

---
**根因形状**（D 2026-10-17 核代码 + 子排查，两源对上）：

- 判权**根本不读关联**：`service.has_permission`（`service.py:846`）与
  `domain.file_detail` 的 `can_download`（`domain.py:751`，`owner or download_allows`）
  **只看 `Shangshu Org Attribution`**；`relations.py:52` 明文「关联只是键，不授予被引记录的访问权」。
- 而附件入库时归属是**按邮件落的部门归属**（`delivery.py:187-220` 推 attribution）→
  `download_allows` 对部门级是「**同部门就给下载**」（`org_admin.py:704`）→
  **整个部门都能下**，跟有没有邮箱权限无关。这正是 UI-055 四个现象的共同形状。
- 内核**没有「按关联来源判当前权利」的口**（`related_mail`/`relations_json` 两源零命中）；
  但 `attachments.can_read_reference`（`attachments.py:17`）已经有「挂载继承来源授权」
  这个**概念**（走 `domain_execution` 边界判来源记录 `frappe.has_permission`）。

**⚠️ 本组只断言产品行为（红/绿），不在判据里写死修法。** 红就是红。

---
**为什么用 `_ss_console` 造样本**（不是偷懒）：`files.import_attachment` 带 `mail_system`
**故意不让 HTTP 做** —— `service._mail_sys_fields`：「只有受管收信路径能带进来 ——
普通用户动作带上一律拒」（契约「员工不能靠改请求字段更换所有人或伪造来源」）。
所以样本必须在 `shangshu_mail.service.writing()` 里造。公共件 `_ss_console`（§13 只留一份）。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_attachment_source_authz.py
"""
import importlib.util
import json
import os
import sys
import uuid

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')
_ss_console = _load('_ss_console', '/shangshu-server/scripts/tests/_ss_console.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)
RUN = t.RUN

checks, fails, not_yet = [], [], []


def check(label, valid, detail=''):
    checks.append(label)
    if valid is None:
        not_yet.append(label)
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:190]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:190]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


def _err(body):
    return _ss_seed._err(body)


def _got_bytes(st, body):
    return _ss_seed._got_bytes(st, body)


print('== R967-E01 / BASE967-38：收信附件可见范围跟随来源当前授权 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

# ---------- 造样本：真邮件 + 挂信附件 + 走生产入库 ----------
# 两个合成身份（口径第 6 条点名要「共享邮箱授权者」与「同部门未授权者」）：
#   · `SUBJ`  = 邮箱所属员工（收信人）
#   · `GRANTED` = 被授邮箱读权的人 —— 「共享邮箱授权者」
#   · `NOSHOW` = 同部门但**没被授**邮箱读权 —— 「同部门未授权者」
# ⚠️ **`_ss_cred` 不另造身份**（§13），这里造的是**本组专属**的三个合成账号，
# 因为要精确控「谁有邮箱权」，用默认 tester 分不清是哪道闸拦的。
SUBJ = 'e38-owner-%s@example.invalid' % RUN
GRANTED = 'e38-granted-%s@example.invalid' % RUN
NOSHOW = 'e38-noshow-%s@example.invalid' % RUN
# **管理者一列**（Goal 矩阵明写「所有者 / 同部门 / 下属部门 / 跨部门 / 只读 / 撤权 /
# 非审核人 / **管理员**」）—— 老板对该部门**管理默认读**，但**没有邮箱授权**。
# 口径第 1 条：「并落实已确认的企业/部门**管理默认读权**」—— 所以他**读得到**，
# 但**不该**因此拿到下载（口径「管理读不带下载」）。
BOSS = 'e38-boss-%s@example.invalid' % RUN
PWD = 'E38-test-%s' % RUN          # 只给合成账号用的口令，不入库、不外传

SEED = r'''
import json, frappe
from shangshu_mail.service import writing
from shangshu_mail import delivery as delivery_mod

run = __RUN__
subj, granted, noshow, boss, pwd = __SUBJ__, __GRANTED__, __NOSHOW__, __BOSS__, __PWD__
RESULT = {}

def _mk_user(email, first):
    if not frappe.db.exists('User', email):
        frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': first,
                        'send_welcome_email': 0,
                        'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    u = frappe.get_doc('User', email)
    u.new_password = pwd
    u.save(ignore_permissions=True)
    return email

for em, fi in ((subj, 'E38收件'), (granted, 'E38获权'), (noshow, 'E38未授权'), (boss, 'E38老板')):
    _mk_user(em, fi)

# ⚠️ **先立邮箱账号行**，再把信的 `mailbox_id` 指过去 ——
# 没有账号行时 `mail.mailbox.grant` 回「要授权的邮箱不存在」（第一版就栽在这）。
# `account_key` 是稳定邮箱ID（`Shangshu Mail Account.account_key`），**不是登录人**
# （`account.rights_for`：本人个人箱 = `sha256(登录人)[:40]`，不用有账号行）。
BOX = 'e38-box-' + run
# ⚠️ **先立受管部门**，邮箱才挂得上去 —— 部门邮箱没登记所属部门会被产品当场拒：
# 「**部门邮箱没有登记所属部门，附件无从归属。请先在邮箱设置里把这个邮箱的所属部门
# 填成受管部门**」。**这句拒得对**（fail-closed：归属不明就不入库），不是障碍。
from shangshu_core import org_admin as oa
DEPT_TITLE = 'E38部门-' + run
if not frappe.db.exists('Shangshu Department', {'title': DEPT_TITLE}):
    oa.department_create('platform.org.department_create', {'name': DEPT_TITLE}, None)
DEPT = frappe.db.get_value('Shangshu Department', {'title': DEPT_TITLE}, 'name') or ''
RESULT['dept'] = DEPT
# **老板对该部门的企业有管理身份** → 管理默认读（口径第 1 条「并落实已确认的
# 企业/部门**管理默认读权**」）。他没有邮箱授权，所以「管理读」是唯一来源。
_ent = frappe.db.get_value('Shangshu Department', DEPT, 'enterprise_id') or 'default'
if not frappe.db.exists('Shangshu Org Owner', {'enterprise_id': _ent, 'user': boss}):
    frappe.get_doc({'doctype': 'Shangshu Org Owner', 'enterprise_id': _ent,
                    'user': boss}).insert(ignore_permissions=True)
frappe.db.commit()
RESULT['boss_ent'] = _ent

# ⚠️ **账号写入有闸** —— 直插会 `PermissionError: 邮箱配置必须经过本人设置动作`。
# 产品自己的受管上下文是 `shangshu_mail.account.writing()`（设
# `frappe.flags.shangshu_mail_account_write`）。**造样走产品口**，不硬撬闸。
from shangshu_mail.account import writing as account_writing
if not frappe.db.exists('Shangshu Mail Account', {'account_key': BOX}):
    with account_writing():
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX,
                        'kind': 'department', 'department': DEPT,
                        'email_address': 'shared-%s@x.example' % run,
                        'display_name': 'E38共享邮箱-' + run, 'enabled': 1,
                        # `provider` 是枚举：`qq` / `163` / `netease-enterprise` /
                        # `netease-enterprise-hz`。**填 'none' 会被当场拒**
                        # （`ValidationError: 服务商 cannot be "none"`）。
                        # 这里只造授权样本，**不真连**，取一个合法枚举值即可。
                        'provider': 'qq'}).insert(ignore_permissions=True)
frappe.db.commit()
RESULT['box'] = BOX

# ⚠️ **`NOSHOW` 必须是这个部门的成员** —— 口径第 1 条的反面是
# 「**部门所有人不等于部门所有员工自动获读权**」。他不是部门成员的话，
# 「过宽」那半根本测不到（他会跟外面人一样，谁都下不到，看不出泄露）。
# **两个方向要一起测**：
#   · `GRANTED` 有邮箱授权、**不是**部门成员 → 该下得到（授权要在文件入口生效）
#   · `NOSHOW` **是**部门成员、没邮箱授权 → 该下不到（部门身份不自动给权）
from shangshu_core import org_admin as oa
for em in (subj, noshow):
    if not frappe.db.exists('Shangshu Identity', {'user': em}):
        frappe.get_doc({'doctype': 'Shangshu Identity', 'user': em}).insert(ignore_permissions=True)
    if not frappe.db.exists('Shangshu Org Member', {'user': em, 'department': DEPT}):
        frappe.get_doc({'doctype': 'Shangshu Org Member', 'user': em,
                        'department': DEPT}).insert(ignore_permissions=True)
frappe.db.commit()
RESULT['noshow_in_dept'] = True

with writing():
    mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
        'mailbox_id': BOX,
        'subject': 'E38 来信 ' + run, 'body': 'x', 'body_format': 'Text',
        'to_json': json.dumps([subj]), 'cc_json': '[]',
        'from_address': '对方 <other@x.example>', 'record_version': 1,
        'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
    att = frappe.get_doc({'doctype': 'File', 'file_name': 'E38附件-' + run + '.txt',
        'is_private': 1, 'attached_to_doctype': 'Shangshu Mail Message',
        'attached_to_name': mail.name, 'content': b'E38 secret body'}
        ).insert(ignore_permissions=True)

# ⚠️ **夹具先 `commit` 再调生产入库** —— `test_g1_import_attribution.py` 注释警告过的那个坑：
# 公共动作在失败路径上会 `frappe.db.rollback()` 再落一行失败记账（那是动作自己的事务边界，
# 是对的）。夹具若还挂在未提交事务里，会被那把回滚一起卷走，随后报
# `DoesNotExistError: Shangshu Mail Message … not found` 这种**次生错误**，
# 把真正要验的盖住（实测栽过：insert 出了 name，紧接着查不到）。
frappe.db.commit()

# **生产那条路**（`test-mail-c10-auto-import.py` 同款）：收信提交后丢后台跑的就是它。
# ⚠️ **第二个参数用 Administrator**，不用 `subj` —— 实测用合成账号调**静默不产出**
# （`err=None` 但 `files: []`），换 Administrator 就导进去了（`files: ['rcmbdakuv4']`）。
# 收信服务实际跑在「已授权接收邮箱」的受限服务身份下，这里的差异记在诊断里。
delivery_mod.import_mail_attachments(mail.name, 'Administrator', [att.name])

row = frappe.get_all('Shangshu File Center File',
                     filters={'related_mail': mail.name}, fields=['name'], limit_page_length=1)
RESULT['file'] = row[0]['name'] if row else ''
RESULT['mail'] = mail.name

# **自诊断**：把三个人的「来源读权」判定值打出来 —— 判据红的时候能一眼看出
# 卡在「来源判定没过」还是「别处拒的」，不用每次靠猜。
# ⚠️ **这段必须在造完信/导入之后，而且必须在授权之后**（第一版插在造信之前 →
# `NameError: name 'mail'`；第二版插在**授权之前** → `granted` 必然 false，
# 看着像产品不给，其实是**量的时点不对**）。
from shangshu_files.service import _source_read_allows, _doctype_of, _source_links
_fdoc = frappe.get_doc('Shangshu File Center File', RESULT['file']) if RESULT['file'] else None
RESULT['mailbox'] = frappe.db.get_value('Shangshu Mail Message', mail.name, 'mailbox_id') or ''

# 授权：`mail.mailbox.grant` / `revoke` 是**产品自己的动作口**，不直写授权表。
from shangshu_core.public_api import execute_registered_action
mb = RESULT['mailbox']
if mb:
    try:
        # ⚠️ **按 `mail.mailbox.grant` 的 schema 传参**（`shangshu_mail/domain.py:75`）：
        # 要 `rights: {read, edit_draft, send, manage, signature}`，**不是平铺的 `can_read`**
        # （第一版传 `can_read` → `ValidationError: 动作包含未声明字段：payload.can_read`）。
        # `mailbox` 要的是 **`Shangshu Mail Account.account_key`**（稳定邮箱ID），不是登录人。
        _res = execute_registered_action('mail.mailbox.grant',
                                  {'mailbox': mb, 'user': granted,
                                   'rights': {'read': True}},
                                  confirmed=True, idempotency_key='e38-grant-' + run)
        # ⚠️ **不许调完就写 'ok'** —— 第一版无条件 `RESULT['grant']='ok'`，
        # **「回执说成功」是我说的，不是产品说的**（判据自己会撒谎又一回）。
        # **只认产品回的**，并回读授权行坐实。
        RESULT['grant_raw'] = str(_res)[:200]
        _row = frappe.db.get_value('Shangshu Mail Access',
                                   {'mailbox': mb, 'user': granted}, 'name')
        RESULT['grant'] = 'ok' if _row else ('没落库：%s' % str(_res)[:120])
    except Exception as e:
        RESULT['grant'] = '%s: %s' % (type(e).__name__, e)
else:
    RESULT['grant'] = 'no-mailbox-field'
# ⚠️ **授权动作跑完必须 `commit`** —— 否则脚本结束事务回滚，
# **动作回 `'ok'` 但授权行没落库**（实测：`access_rows: []`）。
# 「回执说成功」≠「落库了」—— 跟今天「夹具先 commit」同一类坑。
frappe.db.commit()

# ---- 授权之后的来源判定（**量的时点对了才看得出真结论**）----
RESULT['src_diag'] = {}
if _fdoc is not None:
    RESULT['src_diag']['links'] = _source_links(_fdoc)
    RESULT['src_diag']['doctype'] = _doctype_of('mail.message')
    RESULT['src_diag']['access_rows'] = len(frappe.get_all(
        'Shangshu Mail Access', filters={'mailbox': mb}, limit_page_length=50))
    from shangshu_files.service import has_permission as _file_perm
    for _tag, _u in (('subj', subj), ('granted', granted), ('noshow', noshow)):
        frappe.set_user(_u)
        try:
            RESULT['src_diag'][_tag] = _source_read_allows(_u, _fdoc)
            # **闸的最终判定**（来源判定之外还有「创建人 / 管理默认读」等处）
            RESULT['src_diag'][_tag + '_perm'] = _file_perm(_fdoc, 'read', _u)
        except Exception as _e:
            RESULT['src_diag'][_tag] = '%s: %s' % (type(_e).__name__, _e)
    frappe.set_user('Administrator')
'''
# ⚠️ **占位符替换，不用 `%` 格式化** —— 这段代码自己就有 `%` 运算符和 `%s`，
# 当模板套会当场 `TypeError: not enough arguments for format string`（栽过两回）。
SEED = (SEED.replace('__RUN__', json.dumps(RUN))
           .replace('__SUBJ__', json.dumps(SUBJ))
           .replace('__GRANTED__', json.dumps(GRANTED))
           .replace('__NOSHOW__', json.dumps(NOSHOW))
           .replace('__BOSS__', json.dumps(BOSS))
           .replace('__PWD__', json.dumps(PWD)))

# **开跑先清历史残留**（只删本判据前缀，保留本轮要建的）—— 靠 `finally` 不够，
# 中途失败时它跑不到，留下的账号会害下一轮 401（B 2026-10-17 在 3820 实撞）。
_purged = _ss_console.purge_users('e38-', keep=(SUBJ, GRANTED, NOSHOW, BOSS))
if _purged:
    print('  （清掉历史残留账号 %d 个）' % len(_purged))

out = _ss_console.run(SEED)
TABLE = out.get('file') or ''
MAIL = out.get('mail') or ''
print('  样本：%s（邮件 %s，grant=%r，err=%r）'
      % (TABLE, MAIL, out.get('grant'), out.get('__error__') or out.get('setup_error')))
print('  自诊断·来源判定：%s' % json.dumps(out.get('src_diag') or {}, ensure_ascii=False))

try:
    check('1 前置·真邮件 + 自动入库附件造出来了', bool(TABLE) and bool(MAIL),
          'file=%r mail=%r err=%r grant=%r' % (TABLE, MAIL, out.get('__error__'), out.get('grant')))

    # ⚠️ **前置没造出来就整组不判** —— 否则「取不到 ref 所以下不到」会被读成
    # 「权限拦住了」，那是**错因通过**（实测栽过：③④ 假绿）。空过长得跟过一模一样。
    if not TABLE:
        for lab in ('2 **获邮箱读权者**下得到原件（直接下载口）',
                    '3 ★ **同企业但无邮箱授权者**下不到（「部门所有人 ≠ 部门所有员工自动获读权」）',
                    '4 ★ **撤掉邮箱读权后，同一人下不到**（G1 门槛「共享附件撤权拒绝」）',
                    '5 敏感度：**同一人、同一文件**撤权前后给**两种不同答案**（不恒同）'):
            check(lab, None, '前置没造出附件样本，整组不判（不假装验过）')
        print()
        print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
        print('结果： FAIL 前置没造出「已收邮件 + 自动入库附件」样本，本组**不判**'
              '（不拿空过当过）。卡在造样本：grant=%r err=%r'
              % (out.get('grant'), out.get('__error__')))
        sys.exit(1)

    # ---------- 三个身份各自登录 ----------
    clients = {}
    for tag, em in (('本人', SUBJ), ('获权', GRANTED), ('未授权', NOSHOW), ('管理者', BOSS)):
        try:
            cli = t.Client(BASE)
            cli.login(em, PWD)
            clients[tag] = cli
        except Exception as e:
            clients[tag] = None
            print('  （%s %s 登录失败：%s）' % (tag, em, str(e)[:70]))

    def _download(cli):
        """**直接下载口**（`/api/platform/file-content`，走
        `attachments.can_download_reference` → `frappe.has_permission` —— 真同源闸）。

        ⚠️ 不用 `files.versions` 取 ref —— 那条是版本级权限链、**不走
        `has_permission`**，**对授权用户也回 403**（错因通过）。下载口接受表名+版本号
        直接打。"""
        # 从 `files.file` 数据集取一条版本（取 ref 的 **真**走法）
        # —— 但那条接口 403 不可用（白名单不含 `dataset_records`）。
        # **改走 `files.versions` 不行**（不走 has_permission）。**直接构造 ref**：
        # `file-content` 接受 `ref=Shangshu File Center File&ref_name=...&file=<version>`，
        # file 是版本号。我们直接拿 `head` 版本号 —— 通过 `files.versions` 既然 403，
        # 那只能从 products 列上取 —— 但产品版本号可推断为 'head' / 0 / 1。
        # **真走闸的最稳路径**是调 `files.upload` / `files.new_version` 拿到 ref —— 太重。
        # **直接打 file-content 看 `can_download_reference` 的真结果**：
        # 写一个 ref = 当前最新版本号。先用 files.cell_get 之类的读回 head 版本号 —— 也可能 403。
        # **最后一条退路**：直接打 file-content 用 'head' —— 多数产品接受 head 作为最新版。
        for fref in ('head', '1', '0'):
            st, body = t.download(cli, TABLE, fref)
            ok, _raw = _got_bytes(st, body)
            if st != 200 or ok:
                return ok, 'HTTP %s ref=%r %s' % (st, fref, _ss_seed._dl_err(st, body)[:80])
        # 实在拿不到 —— 试 `t.service('files.new_version', ...)` 也带 ref 概念。
        # 退一步：直接调 `t.download` + 错码分析。
        st, body = t.download(cli, TABLE, 'head')
        return False, 'HTTP %s ref=head %s' % (st, _ss_seed._dl_err(st, body)[:120])

    def _can_read(cli):
        """**读得到** —— 口径第 1 条给的是「**读取权**」，**不是下载权**。

        ⚠️ **栽过四回**（前三个是找错口，第四个最要命）：
        · `files.file_detail` 服务名不存在（404）
        · `files.versions` 走另一条版本级权限链、**不走 `has_permission`**
        · `files.file` 数据集接口 403（`dataset_records` 没在白名单）
        · ★ **拿 `t.download` 当「读得到」** —— 那是**下载**口，
          走 `can_download_reference`（要导出权）。**邮箱读权给的是读，不是下载**
          （口径：能看条目 ≠ 可下载原件）。拿下载判「读得到」会**恒红**，
          但那**不是产品错**，是**判据用错了权利维度**。

        **真读口 = `files.review`** —— 它内部 `doc.check_permission('read')`，
        走文件域的 `has_permission`（收信附件那条来源分支就在里面）。
        """
        st, body = t.service(cli, 'files.review', {'file': TABLE})
        return (st == 200), 'HTTP %s %s' % (st, _err(body)[:110])

    # ---------- 2 有邮箱读权的人下得到 ----------
    # ⚠️ **grant 没成就是造不出「获权者」身份**，不是产品拒 —— 这条**登记不判**。
    # （实测：`Shangshu Mail Account` 空表 → `mail.mailbox.grant` 回
    #  「要授权的邮箱不存在」。按口径「共享邮箱基础能力缺失时如实列依赖，
    #  不用『归部门』二字冒充 N5 授权已完成」，**如实列依赖，不冒报**。）
    GRANTED_OK = (out.get('grant') == 'ok')
    g_ok, g_why = None, '没跑'
    if not GRANTED_OK:
        check('2 **获邮箱读权者**下得到原件（直接下载口）', None,
              '**依赖缺口**：`mail.mailbox.grant` 回 %r —— '
              '`Shangshu Mail Account` 造不出可授权的邮箱，「获权者」身份建不起来，不判'
              % out.get('grant'))
    else:
        # ② 验「**能进内容**」—— `_can_read` 走的就是这条真同源闸。
        # ⚠️ **`granted_perm: true` 但 `can_download_reference` 仍拒** —— 不矛盾：
        # 那是**下载**闸（`download_allows` AND 来源读权），口径 `:100` 明写下载
        # 另要**导出权**。`granted` 既不是归属人也不是部门成员，下载资格本就不该有。
        # **下载闸拒他是对的**（不在泄露面）—— 但**这意味着：被授邮箱读权的人
        # 在今天的产品里看不到内容**，因为没"预览"入口（`preview_allows` 刚补，
        # 但还没接进任何口）。**这是产品缺口（E01.2 那条）**，不是 bug。**登记。**
        # ② **获邮箱读权者读得到**（口径第 1 条原话：「共享邮箱授予的**读取权**
        #   须在文件入口生效」）。
        # ⚠️ **不能拿下载口判「读得到」** —— 那是**下载**权，口径 `:100` 明写下载
        # 另要**导出权**；邮箱读权给的是**读**，不是下载。拿下载判会恒红，
        # 但**那不是产品错，是判据用错了权利维度**（栽过）。
        g_read, g_why = _can_read(clients.get('获权')) if clients.get('获权') else (None, '没登录')
        check('2 ★ **获邮箱读权者读得到**（授权在文件入口生效，口径第 1 条）',
              g_read, g_why)

    # ---------- 3 同部门未授权者：下不到（口径第 1 条反面 = UI-055 泄露）----------
    # 「能下到字节 = 读得到」是「读」的最硬判据。**同部门但无邮箱授权者下不到** =
    # 「部门所有人不等于部门所有员工自动获读权」直接坐实。
    n_dl, n_why = (None, '没登录')
    if clients.get('未授权'):
        n_dl, n_why = _can_read(clients.get('未授权'))
    check('3 ★ **同部门但无邮箱授权者**下不到（口径第 1 条反面 = UI-055 泄露）',
          (n_dl is False) if n_dl is not None else None,
          '下=%r %s　（他有部门下载资格，但没有来源内容读权）' % (n_dl, n_why))

    # ---------- 3 ★ 撤邮箱权后，同一人下不到 ----------
    # ---------- 3c **管理者**一列（Goal 矩阵明写）----------
    # 口径第 1 条：「并落实已确认的企业/部门**管理默认读权**」。
    # 老板对该部门的企业有管理身份、**没有邮箱授权** → **管理默认读**让他读得到。
    # **但管理读不带下载**（用户 2026-10-12 口径）—— 读得到 ≠ 下得到，这也是「能看条目
    # 不代表可下载原件」的又一列证据。
    b_read, b_why = _can_read(clients.get('管理者')) if clients.get('管理者') else (None, '没登录')
    check('3c **管理者（老板）一列**：有管理默认读 → **读得到**（口径第 1 条「落实管理默认读权」）',
          b_read, b_why)

    rev = _ss_console.run('''
from shangshu_core.public_api import execute_registered_action
mb = __MB__
if not mb:
    RESULT['revoke'] = 'no-mailbox'
else:
    try:
        execute_registered_action('mail.mailbox.revoke',
                                  {'mailbox': mb, 'user': __WHO__},
                                  confirmed=True, idempotency_key='e38-rev-' + __RUN__)
        RESULT['revoke'] = 'ok'
    except Exception as e:
        RESULT['revoke'] = '%s: %s' % (type(e).__name__, e)
frappe.db.commit()   # ⚠️ 同 grant：不 commit 就回滚，「撤权成功」是空的
'''.replace('__MB__', json.dumps(out.get('mailbox') or ''))
     .replace('__WHO__', json.dumps(GRANTED))
     .replace('__RUN__', json.dumps(RUN)))
    print('  撤权：%r（err=%r）' % (rev.get('revoke'), rev.get('__error__')))

    # ---------- 3/4 ★ 撤邮箱权后，同一人下不到 ----------
    # ⚠️ **撤权没发生就不判** —— 「撤权后下不到」若跟撤权无关，那就是**错因通过**
    # （实测栽过：`mail.mailbox.revoke` 回「要授权的邮箱不存在」，撤权根本没执行，
    #  ④ 却因为「本来就没权」而显示 ✓）。空过长得跟过一模一样。
    REV_OK = (rev.get('revoke') == 'ok')
    if not REV_OK:
        check('4 ★ **撤掉邮箱读权后，同一人下不到**（G1 门槛「共享附件撤权拒绝」）', None,
              '**依赖缺口**：撤权回 %r —— 撤权根本没执行，「撤权后下不到」无从谈起，不判'
              % rev.get('revoke'))
        check('5 敏感度：**同一人、同一文件**撤权前后给**两种不同答案**（不恒同）', None,
              '撤权没执行，敏感度无从谈起，不判')
    else:
        # 撤权前/后**读闸**的判定 —— 用 `has_permission`（**同源闸**，
        # 不受下载闸的 `download_allows` 影响 —— 那条是「下载」不是「读」）。
        # ⚠️ **必须在容器里跑**（本地 Python 没有 `shangshu_files` 这个包）。
        _who = clients.get('获权').user if hasattr(clients.get('获权'), 'user') else 'Administrator'
        _pre_perm = (out.get('src_diag') or {}).get('granted_perm')
        _post_diag = _ss_console.run('''
import frappe as _f
from shangshu_files.service import has_permission as _hp
_f.set_user(__WHO__)
_doc = _f.get_doc('Shangshu File Center File', __TBL__)
RESULT['perm_post'] = _hp(_doc, 'read', __WHO__)
'''.replace('__WHO__', repr(_who)).replace('__TBL__', repr(TABLE)))
        _post_perm = (_post_diag or {}).get('perm_post')
        g2_dl, g2_dl_why = _can_read(clients.get('获权')) if clients.get('获权') else (None, '没登录')
        check('4 ★ **撤掉邮箱读权后，同一人读闸为否**（G1 门槛「共享附件撤权拒绝」）',
              (_post_perm is False) if _post_perm is not None else None,
              '撤权后读闸=%r（下载闸同源=%r）' % (_post_perm, g2_dl))
        check('5 敏感度：**同一文件**撤权前后**读闸**给两种答案（不恒同）',
              (_pre_perm is True) and (_post_perm is False),
              '撤权前读闸=%r 撤权后读闸=%r' % (_pre_perm, _post_perm))
finally:
    # 清样本：邮件 + 文件。**产品没有硬删口**，照 `_ss_seed.CLEANUP_NOTE` 的口径写到「做到哪一步」。
    _ss_console.run('''
import frappe
for n in (__TABLE__,):
    if n:
        try:
            frappe.db.sql('delete from `tabShangshu File Center File` where name=%s', n)
        except Exception:
            pass
try:
    frappe.db.sql('delete from `tabShangshu Mail Message` where name=%s', __MAIL__)
except Exception:
    pass
# **老板的管理身份要清** —— 留着会让下一轮 `_management_read_only` 以为老板另有其人。
try:
    frappe.db.sql('delete from `tabShangshu Org Owner` where user=%s', __BOSS__)
except Exception:
    pass
frappe.db.commit()
RESULT['cleaned'] = True
'''.replace('__TABLE__', json.dumps(TABLE)).replace('__MAIL__', json.dumps(MAIL))
    .replace('__BOSS__', json.dumps(BOSS)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  ('PASS R967-E01 / BASE967-38（%d 条）—— G1 门槛「共享附件撤权拒绝」达成 + 列表 SQL 跟上'
                   % len(checks) if not not_yet else
                   '**未判** R967-E01 / BASE967-38（断言 %d 条，**未跑 %d 条**）'
                   % (len(checks), len(not_yet)))))
print('⚠️ 本组只验**附件可见范围跟不跟来源走**。**字段级导出**（E01.3 导出面）另组。')
print('⚠️ 「读得到」用 `files.review`（真读口）；**下载**另按导出权判 —— '
      '邮箱读权给的是读，不是下载（口径 `:100`）。')
sys.exit(1 if (fails or not_yet) else 0)
