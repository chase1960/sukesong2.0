"""A 阶段浏览器测试宿主：仅绑定回环地址，只连接专用临时库。"""
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
site = "employee-probe.localhost"
if root.parent != Path("/private/tmp") or not root.name.startswith("shangshu-agent-probe."):
    raise SystemExit("仅允许专用临时目录")
config = json.loads((root/"sites"/site/"site_config.json").read_text())
if config.get("db_socket") != str(root/"db.sock") or config.get("db_name") != "employee_probe":
    raise SystemExit("拒绝连接业务库")
os.chdir(root/"sites")
import frappe
from frappe.app import application
from werkzeug.serving import run_simple

frappe.init(site=site); frappe.connect(); frappe.set_user("Administrator")
for name in ("shangshu_object_model","shangshu_schema_change"):
    frappe.reload_doc("shangshu_core","doctype",name,force=True)
frappe.clear_cache()
from shangshu_core.install import ensure_foundation
ensure_foundation(install_triggers=False)
email = "a-browser-20260911@example.invalid"
if not frappe.db.exists("User",email):
    # 仅隔离站固定演练账号，绝不在安装/迁移钩子创建。
    frappe.get_doc({"doctype":"User","email":email,"first_name":"A 阶段验收",
        "user_type":"System User","send_welcome_email":0,"new_password":"probe-only-A-20260911",
        "roles":[{"role":"System Manager"},{"role":"Desk User"}]}).insert(ignore_permissions=True)
frappe.db.commit(); frappe.destroy()

def isolated(environ, start_response):
    environ["HTTP_X_FRAPPE_SITE_NAME"] = site
    return application(environ,start_response)

if __name__ == "__main__":
    run_simple("127.0.0.1",18741,isolated,use_reloader=False,threaded=True)
