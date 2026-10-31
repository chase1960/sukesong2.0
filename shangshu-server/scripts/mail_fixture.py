"""邮件测试**公共夹具** —— 「公共工具只留一份」的那份。

为什么单开这个文件：
  仓里 **47** 个 `test-mail-*.py` 里，**28 个**各自抄了 `require` / `ensure_user` /
  `hard_delete` 里的一样或几样，共 **57 份**函数副本
  （`require` 28 份、`ensure_user` 16 份、`hard_delete` 13 份）。
  另 19 个压根没抄过 —— 不属迁移面。再造压测脚本再抄一遍就是第 58 份。
  **这里只留一份**，和 `shangshu-server/tests/helpers/copy-format.ts` 同一个做法。

  ⚠️ 2026-10-15 纠一个我写错的框法：这里原先写「约 45 个 … 各抄了一份」——
     括号里三个数是对的，但「45」是估的、且「各抄一份」是错的
     （有的文件抄两样、有的三样，所以份数 57 > 文件数 28）。
     真实迁移面按 `git show 780d293b^` 逐文件数出来的：**28 个文件 / 57 份副本**。

怎么用（容器里跑，脚本从 stdin 喂，没法 `import` 兄弟模块，所以**连着喂两份**）：

    cd <仓库根>
    cat shangshu-server/scripts/mail_fixture.py \
        shangshu-server/scripts/test-mail-list-perf.py \
      | docker exec -i shangshu-local-c-frappe-1 sh -lc \\
          'cd /home/frappe/frappe-bench && ./env/bin/python -'

规矩（照抄产品侧，一条不绕）：
  · **信表**受管写入是 `service.writing()`，**账表**是 `account.writing()` ——
    用错不生效（`test-mail-unread-count-consistency.py:104` 点名过）
  · 插信前必须 `frappe.set_user(owner)`，否则 owner 记成插入者
  · 授权走真实动作 `mail.mailbox.grant`，不绕闸
  · 账号 doctype 不许直接删（`on_trash` 挡着）—— 先撤授权再删账号行
  · **造 Received 当夹具**是仓里允许的做法（测的是筛选/权限/性能，不是收信链路）；
    要验收信链路就不许插库，只能走 `FakeImap` 传输边界
"""
import sys
from pathlib import Path

_roots = [Path('/home/frappe/frappe-bench/apps'), Path.cwd()]
try:
    _roots.append(Path.cwd().parents[2])
except IndexError:
    pass
for _a in ('shangshu_mail', 'shangshu_core'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
from shangshu_mail import account, service
from shangshu_mail.service import writing

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'

# 夹具标记 —— 清理只删带这个标记的，不做模糊匹配
FIXTURE_TAG = 'PERF-10K'

# 判分账 —— `require()` 往这两列里记。**共用一份**，
# 各测试不再各建一份 PASS/FAIL（那是「公共工具只留一份」的另一半）。
PASS, FAIL = [], []


def connect(site=SITE, sites_path=SITES_PATH):
    """连库。**可以重复调** —— 两份脚本 cat 在一起喂进容器时，
    谁先谁后都会走到这里，别让它第二次就炸。"""
    try:
        frappe.db.sql('select 1')      # 已经连上了就直接用
        return
    except Exception:
        pass
    frappe.init(site=site, sites_path=sites_path)
    frappe.connect()


# ── 判分与清理：「公共工具只留一份」的另外两件 ──────────────────────────────
#
# ⚠️ 收编前先说清一件事：**这些函数在仓里已经各自走样了**，不是一份抄了 N 遍。
#    2026-10-15 逐个抽函数体比哈希的结果：
#
#      require      5 种写法 —— 25 个输出**逐字一致**可合；3 个**签名就不同**，不能合
#      hard_delete  2 种写法 —— 代码**逐字一致**（第二种只多一段注释），可合
#      ensure_user  4 种写法 —— **行为真不同**（见下），不能机械合
#
#    所以这里只收**行为一致**的那部分。走样的那几个**不在这收**，
#    合了就是改行为，正好是「别为了迁移去改测试」那条不许干的。
#
# `require` 取的是 B 那种（`('' if ok else f'  ← {detail}')`，8 个文件）。
#
#   ⚠️ **2026-10-15 修正**：这里原先写着「与 A 那种（`f"  ← {detail}" if (detail and not ok) else ''`，
#   11 个文件）打印输出逐字一致」—— **那句是假的**，当场跑四种 (ok, detail) 组合证伪了：
#
#       ok=True  任意 detail     两边都 `  ✔ L`                一致
#       ok=False detail='D'     两边都 `  ✖ L  ← D`           一致
#       ok=False detail=''      A `  ✖ L`  vs  B `  ✖ L  ← `  ★不一致
#
#   差异**只在「失败且没给 detail」那条尾巴上**（B 多一个悬空的 `  ←`）。
#   PASS/FAIL 计数两边一样，测试的成立判据不受影响；绿路输出逐字相同。
#
#   为什么公共件取 B 不取 A（A 更多，11 个）：第 1、2 批已经迁的 5 个文件**原本就是 B**，
#   取 B 让它们绿路红路都零差异；换 A 会反过来动它们的失败行。
#   后续迁 A 类文件时，失败行会多一个悬空 `  ←` —— **只在检查没过时看得见**，
#   记在这里，不假装没这回事。
#
#   **没有收编的三种**（各 1 个文件，签名不同，一合就要改调用处）：
#     · `require(cond, msg)` 两参，走 `passed()`/`failed()`          —— test-mail-c1-inline-mount.py
#     · `require(label, ok, detail='')` 走 `check()` **并返回 bool**  —— test-mail-c4-receive.py
#     · `require(condition, message)` 走 `fail()`                     —— test-mail-sample-chain.py
#
# `hard_delete` 取 `[cfa3e529]`（12 个）。`[4e7f6636]`（test-mail-t06-dept-key.py）
#   代码逐字相同、只多一段说明注释 —— 合并时把那段注释留下了，写在下面函数里。
def require(label, ok, detail=''):
    """判一条过没过。**只是记账 + 打印，不是断言** —— 断言是各测试自己的事。

    「测试通过 = 什么成立」写在各测试文件头，这里只负责把结果数出来。
    """
    (PASS if ok else FAIL).append(label)
    print(('  ✔ ' if ok else '  ✖ ') + label + ('' if ok else f'  ← {detail}'))


def hard_delete(doctype, name):
    """夹具清理：产品 doctype 的 `on_trash` 不许直接删（配置历史 / 邮件回收站那几道闸），
    走 `db.delete` 兜底。**只在测试夹具里用**，产品路径不这么绕。"""
    try:
        frappe.delete_doc(doctype, name, ignore_permissions=True, force=True)
    except Exception:
        frappe.db.delete(doctype, {'name': name})


def ensure_user(email, first_name=None, *, commit='on_create',
                as_admin=False, collaboration_group=None):
    """确保测试用户在。**参数化覆盖仓里那 4 种写法**，默认值跟最常见那处（11 个文件）一致 ——
    调用方不传关键字就得到它原来那个行为，**迁移不改任何测试的行为**。

    为什么不是「统一成一种」：用户 2026-10-15 原话「**建账号尽可能覆盖所有情况**」。
    那 4 种不是谁抄错了，是各自场景要的东西不同，硬合就是改行为。

    ── 四种差异，各自怎么覆盖 ──────────────────────────────────────────
    commit        'on_create' 只在新建时提交（11 个文件那版，默认）
                  'always'    每次都提交（2 个 + 公共件那版）
                  'never'     不提交，调用方自己交（3 个文件那版）
    as_admin      True  先 `frappe.set_user('Administrator')` 再建（公共件那版）
                  False 不切换用户（其余三版）
    collaboration_group
                  None  不碰协作组（多数）
                  给了  就写到 Shangshu Identity 的 collaboration_group 上
                        （2 个文件那版 —— 那是**另一件事**，不只是建账号）

    ── 两个坑，写下来免得再踩 ─────────────────────────────────────────
    ⚠️ **第二位置参数只收 `first_name`**，协作组一律走关键字。
       仓里有一版是 `ensure_user(email, group)` 两个位置参数、第二个是**协作组** ——
       那跟 `ensure_user(email, first_name)` **撞车**，一个函数收不下两种含义。
       所以那 2 个文件的调用处要改成 `ensure_user(email, collaboration_group=group)`。
       **行为一字不变**，改的只是参数写法。
    ⚠️ `roles` 一律内联 `{'role': 'Desk User'}`，不走 `add_roles` ——
       四种写法里三种是内联的，`add_roles` 那一种是后加的，取多数。
       **只建普通用户，不建管理员** —— 建管理员身份属权限授予，只在用户。
    """
    created = not frappe.db.exists('User', email)
    if created:
        if as_admin:
            frappe.set_user('Administrator')
        doc = frappe.get_doc({'doctype': 'User', 'email': email,
                              'first_name': first_name or email.split('@')[0],
                              'send_welcome_email': 0,
                              'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
        if commit == 'on_create':
            frappe.db.commit()
    if collaboration_group is not None:
        ident = frappe.db.get_value('Shangshu Identity', {'user': email}, 'name')
        if ident:
            frappe.db.set_value('Shangshu Identity', ident,
                                'collaboration_group', collaboration_group)
    if commit == 'always':
        frappe.db.commit()
    return email

def make_department_box(manager, dept_display, account_key=None):
    """造一个部门箱。**账号键用随机稳定串**，不按登录人拼（N5-1）。
    `account_key` 传进来是为了好清理 —— 留空就随机一个。"""
    key = account_key or ('perf-' + frappe.generate_hash(length=16))
    # **幂等** —— 上一轮留下的箱直接复用。不加这句会 `DuplicateEntryError`
    # （2026-10-15 栽过：冒烟跑了一半崩掉，箱没清，第二轮建同名箱就炸）。
    if frappe.db.exists('Shangshu Mail Account', {'account_key': key}):
        return key
    frappe.set_user(manager)
    with account.writing():
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                        'kind': 'department', 'department': dept_display,
                        'provider': 'qq', 'email_address': f'{key}@shangshu.local',
                        'display_name': dept_display, 'enabled': 1,
                        'connection_status': 'connected',
                        'binding_generation': 'gen-perf-fixture'}).insert(ignore_permissions=True)
    return key


def bulk_grant(mailbox, grants):
    """批量授权。`grants` = [{'user':..., 'rights': {'read':True,...}}, ...]
    走真实动作 `mail.mailbox.grant`（`account.py:290` execute / `:163` grant），不绕闸。"""
    for g in grants:
        frappe.set_user('Administrator')
        account.execute('mail.mailbox.grant',
                        {'mailbox': mailbox, 'user': g['user'], 'rights': g['rights']},
                        {'source': 'user'})


def seed_mails(owner, mailbox_id, n, prefix=FIXTURE_TAG, batch=100, attach_every=0, unread_every=0, on_progress=None):
    """造 n 封挂在某个邮箱上的合成信。**走产品受管写入，不绕闸。**

    `attach_every` —— 每 N 封带一次附件（`attachment_ids_json` 填一个引用），
                      门槛里的「带附件」筛选要靠它出数
    `unread_every` —— 不需要：「未读」按人记在 `Shangshu Mail Read`，没记就是没读，
                      新造的信天然全未读
    `on_progress`  —— 每批回调，好报进度（造一万封要几分钟，不吭声像卡死）

    为什么走 `get_doc().insert()` 而不是多行 INSERT：
      直接写库会**绕过受管写入闸**。夹具也守规矩 ——
      造一万封慢一点没关系，绕闸省下的时间不算数。
    """
    frappe.set_user(owner)
    made = []
    with writing():
        for i in range(n):
            fields = {
                'doctype': 'Shangshu Mail Message', 'status': 'Received',
                'subject': f'{prefix} 合成信 {i:05d}',
                'body': f'这是压测用的合成正文 {i:05d}。' * 3,
                'body_format': 'Text',
                'to_json': '["我们 <perf@shangshu.local>"]', 'cc_json': '[]',
                'from_address': f'对方{i % 50} <sender{i % 50}@x.example>',
                'record_version': 1, 'mailbox_id': mailbox_id,
                'received_at': frappe.utils.now_datetime(),
            }
            if attach_every and i % attach_every == 0:
                fields['attachment_ids_json'] = '["att-perf-%05d"]' % i
            doc = frappe.get_doc(fields).insert(ignore_permissions=True)
            made.append(doc.name)
            if (i + 1) % batch == 0:
                frappe.db.commit()
                if on_progress:
                    on_progress(i + 1, n)
        frappe.db.commit()
    if on_progress:
        on_progress(n, n)
    return made


def seed_cleanup(mailbox_key, prefix=FIXTURE_TAG):
    """清夹具：先撤授权，再删信，最后删账号行。**只删写死的键和前缀，不做模糊匹配。**

    账号 doctype 的 `on_trash` 不许直接删（「请解除邮箱绑定，不能直接删除配置历史」）——
    那是给**客户真实绑定**留的保护。这里清的是几分钟前造的测试夹具。
    """
    frappe.set_user('Administrator')
    with account.access_writing():
        for name in frappe.get_all('Shangshu Mail Access',
                                   filters={'mailbox': mailbox_key}, pluck='name'):
            frappe.get_doc('Shangshu Mail Access', name).delete(ignore_permissions=True)
    with writing():
        for name in frappe.get_all('Shangshu Mail Message',
                                   filters={'subject': ['like', prefix + '%']}, pluck='name'):
            frappe.delete_doc('Shangshu Mail Message', name,
                              ignore_permissions=True, force=True)
    frappe.db.delete('Shangshu Mail Account', {'account_key': mailbox_key})
    frappe.db.commit()
    left_msgs = frappe.get_all('Shangshu Mail Message',
                               filters={'subject': ['like', prefix + '%']}, pluck='name')
    left_box = frappe.db.exists('Shangshu Mail Account', {'account_key': mailbox_key})
    left_acl = frappe.get_all('Shangshu Mail Access',
                              filters={'mailbox': mailbox_key}, pluck='name')
    return {'messages_left': left_msgs, 'account_left': bool(left_box), 'access_left': left_acl}
