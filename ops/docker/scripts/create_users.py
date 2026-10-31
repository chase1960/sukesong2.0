"""建测试身份（本地 Docker 模板用；口令从参数进，不进仓库）。

建四个：
  <prefix>-owner   Desk User + Sheet Structure Editor —— 上传/编辑人（可改值+可改结构）
  <prefix>-editor  Desk User —— 仅改值身份（上传人但无结构授权）
  <prefix>-reader  Desk User —— 第二有权身份（读回一致验证）
  <prefix>-outsider Desk User —— 无权身份（权限拒绝验证）
Administrator 已由 bench new-site 建好（System Manager 天然可改结构）。
测试夹具的结构授权 ≠ 产品默认授权：Sheet Structure Editor 只发给 ss-owner，不默认发给员工。
"""
import os
import sys

import frappe

STRUCTURE_ROLE = "Sheet Structure Editor"


def main(site, password):
    if os.environ.get('SS_ACCEPTANCE_ONLY') == '1':
        print('[users] ACCEPTANCE_ONLY: 不创建自动回归身份，保留建站管理员')
        return
    frappe.init(site=site, sites_path='sites')
    # bench 外直跑时这几个日志目录还不存在，Frappe 一连库就要写日志，先补上
    bench = os.getcwd()
    for path in (os.path.join(bench, site, 'logs'),
                 os.path.join(bench, 'sites', site, 'logs'),
                 os.path.join(os.path.dirname(bench), 'logs')):
        os.makedirs(path, exist_ok=True)
    frappe.connect()
    frappe.set_user("Administrator")
    if not frappe.db.exists("Role", STRUCTURE_ROLE):
        frappe.get_doc({
            "doctype": "Role", "role_name": STRUCTURE_ROLE, "desk_access": 1,
        }).insert(ignore_permissions=True)
        print(f"[roles] 建好 {STRUCTURE_ROLE}")
    else:
        print(f"[roles] 已存在 {STRUCTURE_ROLE}")
    users = [
        ("ss-owner@example.invalid", "SS", "Owner", [STRUCTURE_ROLE]),
        ("ss-editor@example.invalid", "SS", "Editor", []),
        ("ss-reader@example.invalid", "SS", "Reader", []),
        ("ss-outsider@example.invalid", "SS", "Outsider", []),
    ]
    for email, first, last, extra_roles in users:
        role_rows = [{"role": "Desk User"}] + [{"role": r} for r in extra_roles]
        if frappe.db.exists("User", email):
            # 幂等补角色：老用户重跑也能拿到应有的角色（比如新加的结构授权）
            user = frappe.get_doc("User", email)
            have = {r.role for r in user.roles}
            for role_row in role_rows:
                if role_row["role"] not in have:
                    user.append("roles", {"role": role_row["role"]})
                    print(f"[users] {email} 补角色 {role_row['role']}")
            user.save(ignore_permissions=True)
            print(f"[users] 已存在 {email}")
            continue
        doc = frappe.get_doc({
            "doctype": "User",
            "email": email,
            "first_name": first,
            "last_name": last,
            "user_type": "System User",
            "send_welcome_email": 0,
            "new_password": password,
            "roles": role_rows,
        }).insert(ignore_permissions=True)
        doc.enabled = 1
        doc.save(ignore_permissions=True)
        print(f"[users] 建好 {email}（角色：{', '.join(r['role'] for r in role_rows)}）")
    frappe.db.commit()
    frappe.destroy()


if __name__ == "__main__":
    if os.environ.get("SS_ACCEPTANCE_ONLY") == "1":
        print("[users] ACCEPTANCE_ONLY: 不创建自动回归身份，保留建站管理员")
    else:
        main(sys.argv[1], sys.argv[2])
