#!/usr/bin/env python3
"""附件权限**整条面**逐格验 —— 不只验「单条能不能读」。

计划对权限的要求原话（权限与筛选那一段）：

  「按权限契约在服务端确定当前可见集合，再做所有人/关联邮件筛选与分页。
    字段是判断依据，不是只在浏览器隐藏其他文件。
    **列表、计数、筛选选项、搜索、预览、下载、关联标签/跳转、Excel及工具均一致**；
    缓存重验当前权限」
  「撤权、调岗、旧页面、直接详情/下载/关联跳转及筛选计数**不泄漏**」

先前只改了 `has_permission`（单条）和 `permission_query`（列表），
**没把整条面逐个验**。这一份补上 —— 每个入口都过一遍。

测试通过 = 下面全部成立（同一个人，各入口**一致**）：

 1. **列表** —— 本部门的人看得到，别的部门看不到
 2. **计数** —— 计数和列表一致，不多不少
 3. **筛选** —— 按「所有人」筛，只筛出有权看的
 4. **搜索** —— 按文件名搜，只搜出有权看的
 5. **详情** —— 单条读判定一致
 6. **下载** —— 下载口一致，拿不到字节
 7. **版本** —— 版本口一致
 8. **★ 撤权后全部不泄漏** —— 把他调离本部门，上面 7 个入口**一个都不漏**
    （这一条是「不泄漏」的反例，没有它前面都是恒真）

跑在容器里（依赖 frappe）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … python /tmp/…
"""
import json
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
from shangshu_files import service as files_service
from shangshu_files import domain as files_domain

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

TAG = 'APERM'
DEPT = 'APERM 市场部'
OTHER = 'APERM 别的部'
USER_IN = 'aperm-in@shangshu.local'
USER_OUT = 'aperm-out@shangshu.local'


def cleanup():
    frappe.set_user('Administrator')
    for doctype, filt in (('Shangshu File Center File', {'file_name': ('like', f'{TAG}%')}),
                          ('Shangshu File Directory', {'title': ('like', f'{TAG}%')}),
                          ('File', {'file_name': ('like', f'{TAG}%')})):
        for row in frappe.get_all(doctype, filters=filt, pluck='name'):
            hard_delete(doctype, row)
    frappe.db.commit()


def make_file(dept):
    """造一个部门归属的文件，放在**受限**目录里（谁都不在白名单）——
    放开放目录的话谁都能读，测的就变成目录的门、不是部门规则。"""
    from shangshu_core.public_api import execute_registered_action
    frappe.set_user('Administrator')
    suffix = frappe.generate_hash(length=6)
    out = execute_registered_action('files.directory_create',
                                    {'parent': 'files-root', 'title': f'{TAG}-{suffix}'},
                                    confirmed=True, source='user',
                                    idempotency_key='aperm-dir-' + suffix)
    body = (out or {}).get('result') if isinstance(out, dict) and 'result' in (out or {}) else out
    path = (body or {}).get('path') or f'/{TAG}-{suffix}'
    row = frappe.db.get_value('Shangshu File Directory', {'path': path}, 'name')
    for field, value in (('access_mode', 'restricted'),
                         ('allowed_identities_json', '[]'), ('allowed_groups_json', '[]')):
        frappe.db.set_value('Shangshu File Directory', row, field, value)
    frappe.db.commit()
    doc = frappe.get_doc({'doctype': 'Shangshu File Center File',
                          'file_name': f'{TAG}-{suffix}.txt', 'directory_id': row,
                          'status': 'Active', 'file_kind': '文档',
                          'owner_subject_kind': 'Department', 'owner_subject': dept})
    doc.insert(ignore_permissions=True)
    frappe.db.commit()
    return doc.name


cleanup()
ensure_user(USER_IN, collaboration_group=DEPT, commit='always')
ensure_user(USER_OUT, collaboration_group=OTHER, commit='always')
fid = make_file(DEPT)
fname = frappe.db.get_value('Shangshu File Center File', fid, 'file_name')
print(f'夹具：文件={fid}  文件名={fname}  归属={DEPT}')


def surface(user):
    """把 7 个入口各打一次，回来一张 {入口: 看没看到} 的表。"""
    frappe.set_user(user)
    out = {}
    # 1 列表
    try:
        rows = files_domain.query('files.file', {}, 1, 50)
        rows = (rows or {}).get('records') or (rows or {}).get('rows') or (rows or {}).get('data') or []
        ids = [r.get('name') or r.get('id') for r in rows if isinstance(r, dict)]
        out['list'] = fid in ids
    except Exception as error:
        out['list'] = f'抛错 {error}'
    # 2 计数
    try:
        rows = files_domain.query('files.file', {}, 1, 50)
        total = (rows or {}).get('total')
        if total is None:
            total = len((rows or {}).get('records') or (rows or {}).get('rows') or (rows or {}).get('data') or [])
        out['count'] = int(total) >= 1 if out.get('list') is True else int(total) == 0
    except Exception as error:
        out['count'] = f'抛错 {error}'
    # 3 筛选（按所有人筛）
    try:
        rows = files_domain.query('files.file', {'owner_subject': dept_of_file()}, 1, 50)
        rows = (rows or {}).get('records') or (rows or {}).get('rows') or (rows or {}).get('data') or []
        ids = [r.get('name') or r.get('id') for r in rows if isinstance(r, dict)]
        out['filter'] = fid in ids
    except Exception as error:
        out['filter'] = f'抛错 {error}'
    # 4 搜索（按文件名搜）
    try:
        rows = files_domain.query('files.file', {'q': fname}, 1, 50)
        rows = (rows or {}).get('records') or (rows or {}).get('rows') or (rows or {}).get('data') or []
        ids = [r.get('name') or r.get('id') for r in rows if isinstance(r, dict)]
        out['search'] = fid in ids
    except Exception as error:
        out['search'] = f'抛错 {error}'
    # 5 详情 / 单条读
    try:
        out['detail'] = files_service.has_permission(
            frappe.get_doc('Shangshu File Center File', fid), 'read', user) is True
    except Exception as error:
        out['detail'] = f'抛错 {error}'
    # 6 下载（走内核的附件读判定，就是受管链接那一层）
    try:
        from shangshu_core.attachments import can_read_reference
        out['download'] = can_read_reference('Shangshu File Center File', fid) is True
    except Exception as error:
        out['download'] = f'抛错 {error}'
    # 7 版本 —— 必须走**真入口** `files.versions`（domain.py:315 的 check_permission('read')）。
    #    改之前这里直查表 + 写死 True，等于第七处**从来没判过权**，
    #    于是「七处一致」实为六处 —— 正是本条判据要抓的那类泄漏。
    try:
        from shangshu_core.public_api import invoke_domain_service
        reply = invoke_domain_service('files.versions', {'file': fid}) or {}
        rows = reply.get('versions') or reply.get('items') or reply.get('list') or []
        out['version'] = bool(rows) or bool(reply)
    except frappe.PermissionError as error:
        out['version'] = False          # 无权被拒 = 该看不到
    except Exception as error:
        out['version'] = f'抛错 {error}'
    return out


def dept_of_file():
    return frappe.db.get_value('Shangshu File Center File', fid, 'owner_subject')


print()
print('【1～7】本部门的人 —— 七个入口应当一致「看得到」')
in_surface = surface(USER_IN)
for key in ('list', 'count', 'filter', 'search', 'detail', 'download', 'version'):
    require(f'1-7 本部门 · {key}',
            in_surface.get(key) is True, f'结果={in_surface.get(key)!r}')

print()
print('【1～7】别的部门的人 —— 七个入口应当一致「看不到」')
out_surface = surface(USER_OUT)
for key in ('list', 'count', 'filter', 'search', 'detail', 'download', 'version'):
    require(f'1-7 别的部门 · {key}',
            out_surface.get(key) is False, f'结果={out_surface.get(key)!r}')

print()
print('【8】★ 撤权后全部不泄漏（反例）')
# 把他调离本部门 —— 就是「调岗」
ident = frappe.db.get_value('Shangshu Identity', {'user': USER_IN}, 'name')
frappe.set_user('Administrator')
frappe.db.set_value('Shangshu Identity', ident, 'collaboration_group', OTHER)
frappe.db.commit()
after = surface(USER_IN)
for key in ('list', 'count', 'filter', 'search', 'detail', 'download', 'version'):
    require(f'8 调岗后 · {key} 不泄漏',
            after.get(key) is False, f'结果={after.get(key)!r}（调岗前是 {in_surface.get(key)!r}）')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
