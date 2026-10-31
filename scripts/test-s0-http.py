"""隔离站实际 WSGI 登录/CSRF/HTTP 测试，不开公网端口。"""
import json
import os
from pathlib import Path
import secrets
import sys

root = Path(sys.argv[1]).resolve()
site = "employee-probe.localhost"
if root.parent != Path("/private/tmp") or not root.name.startswith("shangshu-agent-probe."):
    raise SystemExit("仅限专用隔离目录")
config = json.loads((root / "sites" / site / "site_config.json").read_text())
if config.get("db_socket") != str(root / "db.sock") or config.get("db_name") != "employee_probe":
    raise SystemExit("拒绝非隔离数据库")
os.chdir(root / "sites")
import frappe
from frappe.app import application
from werkzeug.test import Client
from werkzeug.wrappers import Response


def connect():
    frappe.init(site=site)
    frappe.connect()
    frappe.set_user("Administrator")


connect()
from shangshu_core.public_api import create_process_definition, save_process_draft, publish_portal_definition
suffix = frappe.generate_hash(length=12)
users = []
definition = create_process_definition("S0 隔离 HTTP " + suffix)
definition_id = definition["definition_id"]
graph = definition.get("graph") or frappe.parse_json(frappe.get_doc("Shangshu Process Definition", definition_id).graph_json)
for node in graph["nodes"]:
    if node.get("start"):
        node["allowed_roles"] = ["System Manager"]
saved = save_process_draft(definition_id, graph, 1)
publish_portal_definition(definition_id, saved["draft_revision"])
for role in ("System Manager", "Desk User"):
    email = f"s0-http-{len(users)}-{suffix}@example.invalid"
    password = secrets.token_urlsafe(24)
    frappe.get_doc({"doctype": "User", "email": email, "first_name": "S0 HTTP",
                    "user_type": "System User", "send_welcome_email": 0, "new_password": password,
                    "roles": [{"role": role}]}).insert(ignore_permissions=True)
    users.append((email, password))
frappe.db.commit()
frappe.destroy()


def call(client, method, data=None, csrf=None):
    return client.open("/api/method/" + method, method="POST" if data is not None else "GET",
                       base_url="http://" + site, json=data,
                       headers={"X-Frappe-Site-Name": site, **({"X-Frappe-CSRF-Token": csrf} if csrf else {})})


try:
    for index, (email, password) in enumerate(users):
        client = Client(application, Response)
        login = call(client, "login", {"usr": email, "pwd": password})
        assert login.status_code == 200, login.status_code
        token = call(client, "shangshu_core.public_api.http.csrf").get_json()["message"]["csrf_token"]
        for legacy in ("shangshu_core.public_api.http.process_start", "shangshu_core.api.start_process_instance"):
            response = call(client, legacy, {"definition_id": definition_id}, token)
            assert response.status_code == 403, (legacy, response.status_code)
        endpoint = "shangshu_core.public_api.http_v2.process_start"
        payload = {"definition_id": definition_id, "values": {}, "idempotency_key": "http-" + suffix, "confirmed": True}
        if index == 0:
            denied = call(client, endpoint, {**payload, "confirmed": False}, token)
            assert denied.status_code >= 400
            first = call(client, endpoint, payload, token)
            assert first.status_code == 200, first.get_json()
            second = call(client, endpoint, payload, token)
            assert second.status_code == 200 and second.get_json()["message"]["idempotent"]
            assert first.get_json()["message"]["name"] == second.get_json()["message"]["name"]
        else:
            denied = call(client, endpoint, payload, token)
            assert denied.status_code == 403, denied.status_code
    guest = call(Client(application, Response), "shangshu_core.public_api.http_v2.process_start", payload)
    assert guest.status_code in (401, 403)
    connect()
    assert frappe.db.count("Shangshu Process Instance", {"definition_id": definition_id}) == 1
    print("PASS actual WSGI login+CSRF: legacy denied / unconfirmed denied / role denied / guest denied / v2 exact retry")
finally:
    frappe.destroy()
    # 临时身份已形成流程审计引用，保留在隔离站而不强删关联事实；不用于正式安装。
