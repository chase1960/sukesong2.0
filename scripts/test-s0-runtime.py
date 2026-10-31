"""只连接既有隔离探针站；验证 S0 动作事务、完整结果与真实并发。

bench env/bin/python scripts/test-s0-runtime.py /private/tmp/shangshu-agent-probe.<id>
不会读取项目业务站点配置；保留隔离测试记录供复核。
"""
import json
from datetime import datetime
from decimal import Decimal
import os
from pathlib import Path
import subprocess
import sys
import time
from unittest.mock import patch


root = Path(sys.argv[1]).resolve()
if root.parent != Path("/private/tmp") or not root.name.startswith("shangshu-agent-probe."):
    raise SystemExit("只允许专用隔离目录")
site = "employee-probe.localhost"
config = json.loads((root / "sites" / site / "site_config.json").read_text())
if config.get("db_socket") != str(root / "db.sock") or config.get("db_name") != "employee_probe":
    raise SystemExit("拒绝非隔离数据库")
os.chdir(root / "sites")
import frappe
frappe.init(site=site)
frappe.connect()
frappe.set_user("Administrator")
from shangshu_core import actions, action_requests
from shangshu_core.runtime import register_action

ACTION = "platform.s0.probe"
original_resource = actions.raw_resource
original_get_attr = frappe.get_attr


def resource(section, name):
    if section == "actions" and name == ACTION:
        return {"id": "com.shangshu.core"}, {"handler": "s0.isolated.handler"}
    return original_resource(section, name)


def handler(action_id, payload, context):
    assert action_id == ACTION
    doc = frappe.get_doc({"doctype": "ToDo", "description": payload["marker"]}).insert(ignore_permissions=True)
    time.sleep(0.2)  # 使两个独立连接稳定重叠，不靠单进程 mock 推断并发。
    if payload.get("fail"):
        raise ValueError("isolated-handler-failure")
    return {"name": doc.name, "text": "x" * 900, "items": list(range(80)), "token": "s0-test-only-sensitive",
            "date": datetime(2026, 9, 10, 12, 0), "amount": Decimal("12.30")}


def execute(key, payload):
    with patch.object(actions, "raw_resource", side_effect=resource), patch.object(
        frappe, "get_attr", side_effect=lambda name: handler if name == "s0.isolated.handler" else original_get_attr(name)
    ):
        return actions.execute_registered_action(ACTION, payload, True, key)


try:
    if len(sys.argv) > 2 and sys.argv[2] == "--worker":
        key = sys.argv[3]
        result = execute(key, {"marker": key})
        frappe.db.commit()
        print(json.dumps({"audit": result["audit"], "idempotent": result["idempotent"], "name": result["result"]["name"]}))
    else:
        frappe.reload_doc("shangshu_core", "doctype", "shangshu_action_request", force=True)
        register_action(ACTION, "1.0.0", "隔离事务测试", "write", "required", ["System Manager"],
                        {"type": "object", "required": ["marker"], "properties": {
                            "marker": {"type": "string"}, "fail": {"type": "boolean"}}}, {}, 30, "none")
        frappe.db.commit()
        suffix = frappe.generate_hash(length=16)
        key = "s0-full-" + suffix
        first = execute(key, {"marker": key})
        frappe.db.commit()
        second = execute(key, {"marker": key})
        assert second["idempotent"] and first["result"] == second["result"]
        assert first["result"]["date"] == "2026-09-10 12:00:00" and first["result"]["amount"] == 12.3
        from shangshu_core.public_api import get_action_request_status
        status = get_action_request_status(key)
        assert status["replay_available"] and not status["legacy"]
        assert "result" not in status and "result_ciphertext" not in status
        # 模拟升级前只有审计的已完成动作，不伪造请求指纹回填。
        audit = frappe.get_doc("Shangshu Action Execution Audit", first["audit"])
        legacy_key = "s0-legacy-" + suffix
        fields = ("action_id", "action_version", "actor_identity", "actor_user", "input_summary_json",
                  "result_summary_json", "confirmed", "confirmation_text", "status", "duration_ms")
        legacy = frappe.get_doc({"doctype": audit.doctype, **{name: audit.get(name) for name in fields},
                                 "idempotency_key": legacy_key, "reference_doctype": "ToDo",
                                 "reference_name": first["result"]["name"]}).insert(ignore_permissions=True)
        frappe.db.commit()
        status = get_action_request_status(legacy_key)
        assert status["legacy"] and not status["replay_available"] and status["audit"] == legacy.name
        assert status["reference"]["name"] == first["result"]["name"]
        try:
            execute(legacy_key, {"marker": legacy_key})
            raise AssertionError("旧审计不可当成完整请求重放")
        except frappe.ValidationError:
            pass
        assert action_requests.find_request(legacy_key) is None
        assert frappe.db.count("ToDo", {"description": legacy_key}) == 0
        request = action_requests.find_request(key)
        assert "s0-test-only-sensitive" not in request.result_ciphertext
        assert frappe.db.count("ToDo", {"description": key}) == 1
        try:
            execute(key, {"marker": key, "fail": True})
            raise AssertionError("不同内容不应重放")
        except frappe.DuplicateEntryError:
            pass
        frappe.db.commit()
        # 元数据升级后，既有请求重放仍绑定旧版本，不重新执行新 handler。
        register_action(ACTION, f"1.{time.time_ns()}.0", "隔离事务测试", "write", "required", ["System Manager"],
                        {"type": "object", "required": ["marker"]}, {}, 30, "none")
        frappe.db.commit()
        pinned = execute(key, {"marker": key})
        assert pinned["action_version"] == first["action_version"] and pinned["result"] == first["result"]
        frappe.db.commit()
        failed_key = "s0-fail-" + suffix
        try:
            execute(failed_key, {"marker": failed_key, "fail": True})
            raise AssertionError("handler 应失败")
        except ValueError as error:
            assert str(error) == "isolated-handler-failure"
        frappe.db.commit()  # 模拟调用者捕获后仍提交，不能留下半笔业务。
        assert frappe.db.count("ToDo", {"description": failed_key}) == 0
        assert action_requests.find_request(failed_key) is None
        print("PASS full-result / changed-input / encrypted-storage / caught-failure-rollback / legacy-receipt-read-only", flush=True)
        concurrent_key = "s0-concurrent-" + suffix
        command = [sys.executable, str(Path(__file__).resolve()), str(root), "--worker", concurrent_key]
        workers = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        results = []
        for worker in workers:
            output, error = worker.communicate(timeout=45)
            assert worker.returncode == 0, error
            results.append(json.loads(output.strip().splitlines()[-1]))
        frappe.db.rollback()  # 刷新当前连接事务快照。
        assert sorted(row["idempotent"] for row in results) == [False, True], results
        assert results[0]["audit"] == results[1]["audit"]
        assert results[0]["name"] == results[1]["name"]
        assert frappe.db.count("ToDo", {"description": concurrent_key}) == 1
        print("PASS two-process concurrent request executes handler once", flush=True)
finally:
    frappe.destroy()
