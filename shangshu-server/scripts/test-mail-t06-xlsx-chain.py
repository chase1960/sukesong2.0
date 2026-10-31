#!/usr/bin/env python3
"""T06 的 xlsx 条：**xlsx 附件仍去 Excel 入口**（后端半边）。

执行计划 §T06 原话：「共享邮箱新收附件自动入库，归部门、关联实际邮件……
**xlsx 仍去 Excel 入口。**」

A 查实的口径（`shangshu_files/domain.py` 的 `scope` 两分）：
  `scope='sheet'` → 只取 xlsx（Excel 工作面）
  `scope='all'`   → 文件中心列表
⚠️ **口径 2026-10-20 变更（用户 12:57「文件中心也列表格」＋ 13:05
「xlsx 从文件中心点击就直接进入 excel 部分打开了……excel 部分是文件中心的一部分，
但由于 excel 处理的内容太多了，所以给他留了个新的页面和交互」）**：
  `scope='all'` **不再排除 xlsx** —— 表格**和普通文件混在一起列**，
  **不单独分类**（附件选择器 `scope='attachable'` 本来就这样）。
  Excel 工作面（`scope='sheet'`）**仍只列表格** —— 那是 Excel 自己的页面。
⚠️ 早前这里钉的是「**不**出现在普通文件列表」（当时的旧口径，
   依据是用户 10-13 在**附件选择器**里的批注「我上传的是 excel，所以应该去 excel 部分」
   —— 那条针对的是**附件选择器**，不是文件中心列表）。
   **2026-10-20 用户改了口径**，本条按新口径改。

**A 如实说过**：他验的是 Excel 列表页 → 选中表 → 打开，那些表是从 Excel 工作面
新建/上传的；**「邮件附件 → 自动入库 → Excel 打开」这条完整链他没点过**。
这一份把**后端半边**钉住（前端那一击由 A 在真实页面上补）。

测试通过 = 下面全部成立：

 1. **共享箱来信的 xlsx 附件自动入库** —— 不打开邮件、不点保存
 2. **出现在 Excel 工作面** —— `scope='sheet'` 筛得到它
 3. **`files.sheet_read` 打得开** —— 有表头、有行（不只是「记录存在」）
 4. **出现在文件中心列表里、且不单独分类** —— `scope='all'` 筛得到它，
    而且它**跟普通文件混在一起列**（不另开一个「表格」分类）。
    ⚠️ 口径 2026-10-20 变更：早前是「**不**出现在普通文件列表」，
    依据的是用户 10-13 在**附件选择器**里的批注（那针对附件选择器，不是文件中心列表）；
    用户 12:57/13:05 明确「文件中心也列表格」「Excel 是文件中心的一部分」⇒ 改成新口径。
    Excel 工作面（`scope='sheet'`）**仍只列表格** —— 那两分不变。
 5. **「所有人」是部门**，不是点同步的那个人

跑在容器里（依赖 frappe + openpyxl）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … python /tmp/…
"""
import io
import sys
from pathlib import Path

_roots = [Path('/home/frappe/frappe-bench/apps'), Path.cwd()]
try:
    _roots.append(Path.cwd().parents[2])
except IndexError:
    pass
for _a in ('shangshu_mail', 'shangshu_core', 'shangshu_files'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
from openpyxl import Workbook

from shangshu_mail import account as account_mod
from shangshu_mail.delivery import import_mail_attachments
from shangshu_files.domain import query as files_query

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

USER_A = 't06x-a@shangshu.local'
USER_B = 't06x-b@shangshu.local'
DEPT = 'T06X 市场部'
BOX = 't06x-box-dept'
TAG = 'T06X'
SHEET_FILE = f'{TAG}-费用表.xlsx'


def xlsx_bytes():
    wb = Workbook()
    ws = wb.active
    ws.title = '费用'
    ws.append(['日期', '项目', '金额'])
    ws.append(['2026-10-01', '差旅', 1280])
    ws.append(['2026-10-02', '餐费', 86])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        row = frappe.db.get_value('Shangshu Mail Account', {'account_key': BOX}, 'name')
        if row:
            hard_delete('Shangshu Mail Account', row)
    for row in frappe.get_all('Shangshu Mail Message', filters={'subject': ('like', f'{TAG}%')}, pluck='name'):
        hard_delete('Shangshu Mail Message', row)
    for row in frappe.get_all('Shangshu File Center File', filters={'file_name': ('like', f'{TAG}%')}, pluck='name'):
        hard_delete('Shangshu File Center File', row)
    for row in frappe.get_all('File', filters={'file_name': ('like', f'{TAG}%')}, pluck='name'):
        hard_delete('File', row)
    for row in frappe.get_all('Shangshu Mail Access', filters={'user': ('in', [USER_A, USER_B])}, pluck='name'):
        hard_delete('Shangshu Mail Access', row)
    frappe.db.commit()


ensure_user(USER_A)
ensure_user(USER_B)
cleanup()

print('夹具：一个部门箱 + 一封带 xlsx 附件的来信（附件由 USER_B 点同步导入）')
frappe.set_user(USER_A)
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX, 'kind': 'department',
                    'department': DEPT, 'provider': 'qq', 'email_address': 't06x-dept@shangshu.local',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': f'gen-{BOX}'}).insert(ignore_permissions=True)
frappe.db.commit()
# 两个员工都授权，好验「谁点同步不影响归属」
frappe.set_user(USER_A)
account_mod.execute('mail.mailbox.grant', {'mailbox': BOX, 'user': USER_A,
                                           'rights': {'read': True, 'send': True}}, {'source': 'user'})
account_mod.execute('mail.mailbox.grant', {'mailbox': BOX, 'user': USER_B,
                                           'rights': {'read': True, 'send': True}}, {'source': 'user'})
frappe.db.commit()

from shangshu_mail.service import writing
frappe.set_user(USER_B)          # ← **由 USER_B 点同步**，归属不该跟着他走
with writing():
    mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                           'subject': f'{TAG} 费用表来信', 'body': '见附件', 'body_format': 'Text',
                           'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
                           'from_address': '对方 <other@x.example>', 'record_version': 1,
                           'mailbox_id': BOX, 'owner': USER_B,
                           'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
    att = frappe.get_doc({'doctype': 'File', 'file_name': SHEET_FILE, 'is_private': 1,
                          'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': mail.name,
                          'content': xlsx_bytes()}).insert(ignore_permissions=True)
frappe.db.commit()
print(f'  信 {mail.name} / 附件 {att.name}\n')

print('【1】收信后 xlsx 附件自动入库（不打开邮件、不点保存）')
import_mail_attachments(mail.name, USER_B, [att.name])
frappe.db.commit()
row = frappe.db.get_value('Shangshu File Center File', {'file_name': SHEET_FILE},
                          ['name', 'file_kind', 'owner_subject_kind', 'owner_subject'], as_dict=True)
require('1 xlsx 附件自动入库', bool(row), f'查不到 {SHEET_FILE!r}')
if not row:
    print('\n' + '=' * 50)
    print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
    cleanup()
    sys.exit(1)

print()
print('【2～4】两个 scope 各筛一遍（Excel 工作面 vs 文件中心列表）')
sheet_rows = files_query('files.file', {'scope': 'sheet'}, page=1, page_length=200)
all_rows = files_query('files.file', {'scope': 'all'}, page=1, page_length=200)
sheet_names = {r.get('name') for r in (sheet_rows.get('rows') or sheet_rows.get('list') or [])}
all_names = {r.get('name') for r in (all_rows.get('rows') or all_rows.get('list') or [])}
print(f'      scope=sheet 共 {len(sheet_names)} 条；scope=all 共 {len(all_names)} 条')
require('2 出现在 Excel 工作面（scope=sheet）', row.name in sheet_names,
        f'{row.name} 不在 sheet 列表里；实际 {sorted(sheet_names)[:5]}')
require('4 出现在文件中心列表（scope=all），且不单独分类 —— 2026-10-20 新口径',
        row.name in all_names,
        f'{row.name} 不在 all 列表里 —— 文件中心应当也列表格（用户 12:57/13:05 的口径）')

print()
print('【3】files.sheet_read 打得开（有表头、有行）')
frappe.set_user(USER_B)
try:
    from shangshu_files.sheet import read_payload
    payload = read_payload(None, {'table': row.name}, None)
    headers = payload.get('headers') or []
    rows = payload.get('rows') or []
    require('3 files.sheet_read 打得开', bool(headers) and len(rows) >= 2,
            f'headers={headers!r} 行数={len(rows)}')
    if headers:
        print(f'      表头 = {headers}')
        print(f'      首行 = {rows[0] if rows else None}')
except Exception as error:                       # noqa: BLE001
    require('3 files.sheet_read 打得开', False, f'{type(error).__name__}: {error}')

print()
print('【5】「所有人」是部门，不是点同步的 USER_B')
require('5 所有人是部门',
        row.owner_subject_kind == 'Department' and row.owner_subject == DEPT
        and row.owner_subject != USER_B,
        f'实际 kind={row.owner_subject_kind!r} subject={row.owner_subject!r}'
        f'（期望 Department/{DEPT!r}；点同步的是 {USER_B}）')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
