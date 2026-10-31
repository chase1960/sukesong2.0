"""Excel 首批（B1）夹具：在真实 Frappe 测试站建账号、测试表与 1000×8 行，并生成夹具清单。

用法（在 bench 环境里跑，站点名必须是测试站）：
  <bench>/env/bin/python excel-b1-fixture.py \
      --site <test-site> --sites-path <bench>/sites \
      --manifest-out /path/excel-b1-manifest.json \
      --secrets-out /path/excel-b1-secrets.json \
      --admin-password <站点 Administrator 口令>

说明：
- 夹具是测试准备脚本，不是员工建表功能；表结构固定 8 个业务列 + 1 个隐藏列（测“隐藏字段不参与搜索”）。
- 口令只写 secrets 文件（仓库外），清单（manifest）不含任何口令。
- 已存在的夹具账号会被重设为新生成口令（仅限 excel-b1-* 夹具账号，不碰其他账号）。
"""
import argparse
import json
import os
import random
import sys
import string
from pathlib import Path

LONG_ID = 'ZZ2026EXCELFIRSTBATCH0000042'  # 28 个字符的文本编号
LONG_NOTE = ('第一段：这是首批长备注保真用例。\n'
             + '中段内容用于验证超过三百个中文字符的备注在保存与读取后不会被截断。' * 10
             + '\n末段结束。')
ROLE_NAME = 'Excel 测试用户'
ACCOUNTS = {
    'a': ('excel-b1-a@excel-b1.local', '测试员工A'),
    'b': ('excel-b1-b@excel-b1.local', '测试员工B'),
    'c': ('excel-b1-c@excel-b1.local', '无权员工C'),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--sites-path', required=True)
    ap.add_argument('--manifest-out', required=True)
    ap.add_argument('--secrets-out', required=True)
    ap.add_argument('--admin-password', required=True)
    ap.add_argument('--rows', type=int, default=1000)
    args = ap.parse_args()

    # 安全闸：夹具绝不进生产站。判据取「永不可能是生产站」的名，不是随便放行：
    #   · 名字含 -test —— 约定的测试站命名
    #   · 名字以 .localhost 结尾 —— RFC 6761 保留域名，公网永不解析
    #     （本地 Docker 交付环境的站就叫 shangshu.localhost）
    # 两者都不是就照旧拒绝。**没有跳过这道闸的开关。**
    if '-test' not in args.site and not args.site.endswith('.localhost'):
        raise SystemExit('拒绝：夹具只能建在测试站（站点名须含 -test，或以 .localhost 结尾）')
    args.sites_path = str(Path(args.sites_path).resolve())

    repo = Path(__file__).resolve().parents[2]
    for app in ('shangshu_core',):
        sys.path.insert(0, str(repo / 'frappe_apps' / app))
    os.chdir(args.sites_path)

    import frappe  # noqa: E402
    from shangshu_core.public_api import (  # noqa: E402
        create_application_definition, prepare_object_change, execute_object_change,
        execute_registered_action, publish_application_definition, get_application_definition,
        save_application_draft,
    )

    frappe.init(site=args.site, sites_path=args.sites_path)
    frappe.connect()
    frappe.set_user('Administrator')

    from shangshu_core.domains import ensure_registered_domains
    ensure_registered_domains()
    from shangshu_core.install import ensure_foundation
    ensure_foundation(install_triggers=False)
    frappe.db.commit()

    # ---- 角色与账号（环境准备；不改动其他既有账号） ----
    if not frappe.db.exists('Role', ROLE_NAME):
        frappe.get_doc({'doctype': 'Role', 'role_name': ROLE_NAME, 'desk_access': 0}).insert(ignore_permissions=True)
        frappe.db.commit()

    def password():
        return ''.join(random.choices(string.ascii_letters + string.digits, k=16)) + '!aA1'

    secrets = {'admin': args.admin_password}
    for key, (email, full_name) in ACCOUNTS.items():
        pw = password()
        secrets[key] = pw
        roles = ['Desk User'] + ([ROLE_NAME] if key in ('a', 'b') else [])
        if frappe.db.exists('User', email):
            user = frappe.get_doc('User', email)
            user.enabled = 1
            user.append_roles(*roles) if hasattr(user, 'append_roles') else None
            user.new_password = pw
            user.save(ignore_permissions=True)
        else:
            frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': full_name,
                            'send_welcome_email': 0, 'new_password': pw,
                            'roles': [{'role': r} for r in roles]}).insert(ignore_permissions=True)
        frappe.db.commit()

    # ---- 应用与对象 ----
    app = create_application_definition('Excel 首批测试应用', 'excel-b1-app-' + frappe.generate_hash(length=12))
    app_id = app['id']
    access = {'read_roles': [ROLE_NAME], 'write_roles': [ROLE_NAME], 'record_scope': 'all'}
    main_def = {'schema_version': 1, 'title': 'Excel 首批测试表', 'kind': 'record',
                'fields': [
                    {'id': 'bianhao', 'label': '编号', 'type': 'text'},
                    {'id': 'mingcheng', 'label': '名称', 'type': 'text'},
                    {'id': 'kehu', 'label': '客户', 'type': 'text'},
                    {'id': 'jine', 'label': '金额', 'type': 'decimal'},
                    {'id': 'riqi', 'label': '日期', 'type': 'date'},
                    {'id': 'zhuangtai', 'label': '状态', 'type': 'text'},
                    {'id': 'beizhu', 'label': '备注', 'type': 'long_text'},
                    {'id': 'jiaoyan', 'label': '校验标记', 'type': 'text',
                     'write_roles': ['System Manager']},
                    {'id': 'neibu', 'label': '内部隐藏备注', 'type': 'text',
                     'read_roles': ['System Manager'], 'write_roles': ['System Manager']},
                ],
                'access': access}
    probe_def = {'schema_version': 1, 'title': '结构版本探针', 'kind': 'record',
                 'fields': [
                     {'id': 'title', 'label': '标题', 'type': 'text'},
                     {'id': 'note', 'label': '备注', 'type': 'text'},
                 ],
                 'access': access}

    def build_table(definition):
        change = prepare_object_change(app_id, definition, 'excel-b1-schema-' + frappe.generate_hash(length=12))
        frappe.db.commit()  # DDL 独立事务
        applied = execute_object_change(change['id'], True)
        frappe.db.commit()
        assert applied['status'] == 'Applied', applied
        return change['object_id']

    object_id = build_table(main_def)
    probe_object_id = build_table(probe_def)

    app = get_application_definition(app_id)
    app = save_application_draft(app_id, {
        'schema_version': 1, 'title': 'Excel 首批测试应用', 'description': '',
        'allowed_roles': ['Desk User'],
        'bindings': [
            {'kind': 'objects', 'resource_id': object_id, 'owner_domain': app_id, 'version': '1'},
            {'kind': 'objects', 'resource_id': probe_object_id, 'owner_domain': app_id, 'version': '1'},
        ]}, app['draft_revision'])
    publish_application_definition(app_id, app['draft_revision'])
    frappe.db.commit()

    # ---- 行数据（固定行号语义：第 i 次创建即 row_no=i） ----
    def create(values, tag):
        result = execute_registered_action(
            'platform.object.create',
            {'object_id': object_id, 'expected_revision': 1, 'values': values},
            True, 'excel-b1-row-' + tag + '-' + frappe.generate_hash(length=8))
        return result['result']['name']

    names = {}
    total = args.rows
    for i in range(1, total + 1):
        values = {
            'bianhao': '00123' if i == 7 else (LONG_ID if i == 8 else f'BH-{i:05d}'),
            'mingcheng': ('重名品-甲' if i in (12, 345, 890) else
                          '寻踪-7A3F' if i == 917 else f'测试品-{i:04d}'),
            'kehu': ('首屏词-1B' if i == 995 else
                     f'共词-乙-{i:04d}' if 200 <= i <= 499 else f'客户-{i % 50:02d}'),
            'jine': 1234.56 if i == 15 else round(i * 1.5, 2),
            'riqi': '2026-10-09' if i == 16 else f'2026-{1 + (i % 12):02d}-{1 + (i % 28):02d}',
            'zhuangtai': f'状态-{i % 4}',
            'beizhu': (LONG_NOTE if i == 9 else
                       f'含稀词-丙的备注-{i:04d}' if i in (601, 602) else f'备注内容-{i:04d}'),
            'jiaoyan': f'fixed-{i:04d}',
            'neibu': '隐藏词-秘' if i == 5 else f'内部-{i:04d}',
        }
        names[i] = create(values, str(i))
        if i % 50 == 0:
            frappe.db.commit()
            print(f'  已建 {i}/{total} 行…')
    frappe.db.commit()

    probe_name = execute_registered_action(
        'platform.object.create',
        {'object_id': probe_object_id, 'expected_revision': 1,
         'values': {'title': '探针行', 'note': '用于结构版本验证'}},
        True, 'excel-b1-probe-' + frappe.generate_hash(length=8))['result']['name']
    frappe.db.commit()

    manifest = {
        'site': args.site,
        'app_id': app_id,
        'object_id': object_id,
        'probe_object_id': probe_object_id,
        'probe_revision': 1,
        'revision': 1,
        'rows_total': total,
        'accounts': {'a': ACCOUNTS['a'][0], 'b': ACCOUNTS['b'][0],
                     'c': ACCOUNTS['c'][0], 'admin': 'Administrator'},
        'columns': [
            {'id': 'bianhao', 'label': '编号', 'type': 'text'},
            {'id': 'mingcheng', 'label': '名称', 'type': 'text'},
            {'id': 'kehu', 'label': '客户', 'type': 'text'},
            {'id': 'jine', 'label': '金额', 'type': 'decimal'},
            {'id': 'riqi', 'label': '日期', 'type': 'date'},
            {'id': 'zhuangtai', 'label': '状态', 'type': 'text'},
            {'id': 'beizhu', 'label': '备注', 'type': 'long_text'},
            {'id': 'jiaoyan', 'label': '校验标记', 'type': 'text', 'read_only': True},
            {'id': 'neibu', 'label': '内部隐藏备注', 'type': 'text', 'hidden': True},
        ],
        'probe_row': probe_name,
        'probe_definition': probe_def,
        'special': {
            'first_page_probe': {'name': names[total], 'row_no': total},
            'leading_zero': {'name': names[7], 'bianhao': '00123', 'row_no': 7},
            'long_id': {'name': names[8], 'bianhao': LONG_ID, 'row_no': 8},
            'long_note': {'name': names[9], 'beizhu': LONG_NOTE, 'row_no': 9},
            'money_row': {'name': names[15], 'jine': 1234.56, 'row_no': 15},
            'date_row': {'name': names[16], 'riqi': '2026-10-09', 'row_no': 16},
            'update_target': {'name': names[20], 'row_no': 20},
            'dup_name': {'keyword': '重名品-甲', 'row_nos': [12, 345, 890],
                         'names': [names[12], names[345], names[890]]},
            'hit_outside': {'keyword': '寻踪-7A3F', 'name': names[917], 'row_no': 917},
            'hit_inside': {'keyword': '首屏词-1B', 'name': names[995], 'row_no': 995},
            'many_match': {'keyword': '共词-乙', 'count': 300},
            'few_match': {'keyword': '稀词-丙', 'count': 2,
                          'names': [names[601], names[602]]},
            'no_match': {'keyword': '绝无词-Ω9'},
            'hidden_field_keyword': {'keyword': '隐藏词-秘', 'value_in': 'neibu'},
        },
    }
    Path(args.manifest_out).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    Path(args.secrets_out).write_text(json.dumps(secrets, ensure_ascii=False, indent=2), encoding='utf-8')
    os.chmod(args.secrets_out, 0o600)
    print(f'夹具完成：object_id={object_id} 行数={total}')
    print(f'清单：{args.manifest_out}')
    print(f'口令：{args.secrets_out}（仓库外，勿提交）')
    frappe.destroy()


if __name__ == '__main__':
    main()
