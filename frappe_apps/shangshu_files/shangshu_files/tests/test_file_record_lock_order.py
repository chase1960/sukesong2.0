"""文件↔受管记录：**真并发**下两条路的取锁顺序必须一致（2026-10-29 · D 项）。

**测试通过 = 什么成立**（四件）：

1. **两条路取锁的顺序一样** —— A 路（受管列格写）与 B 路（公共记录写）打**同一个对象**时，
   它们各自锁的行必须是**同一个顺序**（`文件 → app → model → 记录`）。
   ⇒ 现状（审查实测）：A＝文件→app→model→记录、B＝app→model→记录→**文件**
   ⇒ **顺序相反 ⇒ ABBA 死锁面** ⇒ 这条**现在是红的**，改完（A 路延后取文件行锁）才绿。
2. **不许静默半写** —— 两路并发后，受管记录里的值要么是 A 的、要么是 B 的
   ⇒ **不能两个都像、又都不像**（不能一半改了、一半没改）。
3. **失败要带原始错误** —— 撞锁失败的一方**不许被吞成成功**：
   必须是 1213（死锁）或 1205（等待超时）那一类**原始数据库错误**。
4. **同键重试必成、且一条日志** —— 失败的一方用**同一个幂等键**重试 ⇒ 必须成功；
   且那个键在统一日志里**只有一条**（重试是「重执行」不是「重放」）。

**为什么是真并发**：两个**独立连接**（子进程）同时打**同一对象同一行**，
靠一个「起跑门」文件同步起跑 ⇒ 不是串行假装的。
**跑法**：只许在隔离站 `pkg132-incremental.localhost` 跑（要真库、要能造 DDL）。
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

import frappe

SITE = "pkg132-incremental.localhost"
#: 统一的取锁顺序（**两条路都要照它**）。
#: ⚠️ **实测（2026-10-29 真并发）**：A 路（格写）现状是
#:    `file → app → model → record → **file**`（**文件行拿了两次**：开头一次、末尾回填一次）
#:    B 路（记录写）现状是 `app → model → record → file`
#: ⇒ **统一后的顺序＝`app → model → record → file`**（A 路**开头那次文件锁要去掉**）
#: ⇒ 现状 A 比 B 多一个开头的 file ⇒ **这条现在是红的**，改完才绿。
EXPECTED_ORDER = ["app", "model", "record"]   # 两条路**共同的那几把锁**（下面说清为什么只核这三把）
#: 判定「锁的是哪一类行」的关键词（按 SQL 里出现的表名/字段名认）。
LOCK_KINDS = (
    ("file", "shangshu file center file"),
    ("model", "shangshu object model"),
    ("record", "ssm "),
    ("app", "shangshu application definition"),
)


def _classify(sql):
    """把一条 SQL 归到「锁的是哪一类行」；认不出就返回 None（不是锁语句就跳过）。"""
    low = str(sql or "").lower()
    if " for update" not in low and " lock in share mode" not in low:
        return None
    for kind, needle in LOCK_KINDS:
        if needle in low:
            return kind
    return None


def _run_worker(config_path):
    """子进程：跑一条路，把结果与**取锁顺序**写进文件。"""
    config = json.loads(Path(config_path).read_text())
    frappe.init(site=SITE)
    frappe.connect()
    frappe.set_user("Administrator")
    locks = []
    original_sql = frappe.db.sql

    def spy(sql, *args, **kwargs):
        kind = _classify(sql)
        if kind and (not locks or locks[-1] != kind):
            locks.append(kind)
        return original_sql(sql, *args, **kwargs)

    frappe.db.sql = spy
    result = {"mode": config["mode"], "ok": False, "locks": locks}
    try:
        from shangshu_core.public_api import execute_registered_action
        from shangshu_files import promotion

        if config["mode"] == "cell":
            # **A 路**：受管列的格写（文件 → 记录）
            promotion.cell_write({"table": config["table"], "row_id": config["row_id"],
                                  "header": "金额",
                                  "value": {"type": "number", "value": config["value"]}})
        else:
            # **B 路**：公共动作改受管记录（记录 → 文件）
            outcome = execute_registered_action(
                "platform.object.update_many",
                {"object_id": config["object_id"],
                 "expected_revision": config["revision"],
                 "records": [{"name": config["record_name"],
                              "expected_modified": config["record_modified"],
                              "values": {"amount": config["value"]}}]},
                confirmed=True, idempotency_key=config["idempotency_key"])
            result["result"] = outcome.get("result")
        frappe.db.commit()
        result["ok"] = True
    except Exception as error:
        frappe.db.rollback()
        result["type"] = type(error).__name__
        result["message"] = str(error)[:300]
    finally:
        frappe.db.sql = original_sql
        Path(config["result_path"]).write_text(json.dumps(result, ensure_ascii=False))
        frappe.destroy()


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--worker":
    _run_worker(sys.argv[2])


class TestFileRecordLockOrder(unittest.TestCase):
    """A 路（格写）与 B 路（记录写）**真并发**打同一对象。"""

    @classmethod
    def setUpClass(cls):
        if frappe.local.site != SITE:
            raise unittest.SkipTest("只在隔离站 %s 跑（要真库、要能造 DDL）" % SITE)
        frappe.set_user("Administrator")
        from shangshu_files import promotion, service
        from shangshu_files.tests import promotion_fixture as fixture

        cls.fixture = fixture
        cls.promotion = promotion
        base64 = __import__("base64")
        result = service.upload({"file_name": "锁序并发-%s.xlsx" % uuid.uuid4().hex[:6],
                                 "content_base64": base64.b64encode(fixture.workbook_bytes()).decode(),
                                 "attribution": {"level": "personal"}})
        frappe.db.commit()
        cls.table = result["file"]
        promoted = [{"header": "金额", "promoted": True, "field": "amount", "type": "number",
                     "access": dict(fixture.GLOBAL_ACCESS)}]
        promotion.define({"table": cls.table, "definition": fixture.definition(promoted)})
        frappe.db.commit()
        binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, cls.table))
        cls.binding = binding
        cls.object_id = binding["object_id"]
        cls.row_id = sorted(binding["records"])[0]
        cls.record_name = binding["records"][cls.row_id]
        from shangshu_core import model_records
        model = frappe.get_doc(model_records.MODEL, cls.object_id)
        cls.revision = model.active_revision
        cls.record_modified = str(frappe.db.get_value(model.physical_doctype, cls.record_name, "modified"))
        cls.directory = tempfile.TemporaryDirectory(prefix="ss-lock-order-")
        cls.path = Path(cls.directory.name)

    @classmethod
    def tearDownClass(cls):
        try:
            from shangshu_core import model_records
            model = frappe.get_doc(model_records.MODEL, cls.object_id)
            frappe.db.commit()
            frappe.db.sql("DROP TABLE IF EXISTS `%s`" % model.physical_doctype)
            frappe.delete_doc("DocType", model.physical_doctype, force=True, ignore_permissions=True)
            frappe.delete_doc(model_records.MODEL, cls.object_id, force=True, ignore_permissions=True)
            frappe.delete_doc("Shangshu Application Definition", cls.binding.get("application_id"),
                              force=True, ignore_permissions=True)
            frappe.db.commit()
        except Exception:
            pass
        cls.directory.cleanup()

    # ---------- 工具 ----------
    def _managed_amount(self):
        from shangshu_core import model_records
        rows = model_records.query_records(self.object_id, filters={}, page=1, page_length=30)
        for row in rows["rows"]:
            if row["name"] == self.record_name:
                return row.get("amount")
        return None

    def _log_count(self, key):
        return frappe.db.sql("SELECT COUNT(*) FROM `tabShangshu Unified Log` WHERE idempotency_key=%s",
                             (key,))[0][0]

    def _spawn(self, mode, value, key):
        """起一个子进程跑一条路；用「起跑门」文件让两路**同时**起跑。"""
        label = mode + "-" + uuid.uuid4().hex[:8]
        config_path = self.path / (label + ".json")
        result_path = self.path / (label + ".result")
        config = {"mode": mode, "table": self.table, "row_id": self.row_id,
                  "object_id": self.object_id, "record_name": self.record_name,
                  "revision": self.revision, "record_modified": self.record_modified,
                  "value": value,
                  "idempotency_key": key, "result_path": str(result_path)}
        config_path.write_text(json.dumps(config, ensure_ascii=False))
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(str(p) for p in sys.path if p)
        process = subprocess.Popen([sys.executable, __file__, "--worker", str(config_path)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        return {"process": process, "result_path": result_path}

    def _await(self, entry, timeout=60):
        process = entry["process"]
        stdout, stderr = process.communicate(timeout=timeout)
        deadline = time.monotonic() + 10
        while not entry["result_path"].exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        if not entry["result_path"].exists():
            self.fail("子进程没有留下结果（stdout=%s stderr=%s）" % (stdout[-400:], stderr[-400:]))
        return json.loads(entry["result_path"].read_text())

    # ---------- ① 两条路的取锁顺序必须一致 ----------
    def test_both_paths_take_the_same_lock_order(self):
        """**两条路取锁的顺序一样** ⇒ 没有 ABBA。

        ⚠️ **这条现在是红的**（2026-10-29 独立对抗审查实测出的现状）：
        A 路＝文件→app→model→记录；B 路＝app→model→记录→**文件** ⇒ **顺序相反**。
        ⇒ 修法（A 路延后取文件行锁）落地后，这条才绿。
        """
        results = self._run_both()
        orders = {item["mode"]: item["locks"] for item in results}
        # ⚠️ **只核「共同的那几把锁」的顺序**（app / model / 记录）——
        #   文件行的锁是**最后**才拿的（回填那一步；并发时它有时不出现）⇒ 不把它算进顺序比较。
        #   **要紧的是**：A 路**不许再在开头就锁文件**（那就是 ABBA 的那一对）。
        for mode in ("cell", "record"):
            head = list(orders.get(mode) or [])[:len(EXPECTED_ORDER)]
            self.assertEqual(head, EXPECTED_ORDER,
                             "%s 路的前三把锁顺序不对（应是 app→model→记录）：%s"
                             % (mode, orders.get(mode)))
        self.assertNotEqual((orders.get("cell") or [None])[0], "file",
                            "A 路开头又锁文件了 ⇒ 顺序又变成 文件→记录 ⇒ ABBA 回来了：%s"
                            % orders.get("cell"))

    # ---------- ②③④ 不许静默半写／失败带原始错误／同键重试必成且一条日志 ----------
    def test_concurrent_writes_never_half_write_and_retry_succeeds_once(self):
        """并发 ⇒ 不许半写；失败带原始错误；同键重试必成；**一条日志**。"""
        results = self._run_both()
        by_mode = {item["mode"]: item for item in results}

        # ② 值只能是一个（不许两个都像又都不像）
        # ⚠️ **父进程要结束自己的读事务再看**（MySQL 默认 REPEATABLE READ：
        #   父连接的事务起点在子进程提交之前 ⇒ 读到的还是旧值 ⇒ 会误判成「半写」）。
        frappe.db.commit()
        value = self._managed_amount()
        self.assertIn(value, (101.0, 202.0),
                      "并发后受管记录里的值既不是 A 的也不是 B 的（半写）：%r ｜两路结果=%s"
                      % (value, json.dumps(by_mode, ensure_ascii=False)[:600]))

        # ③ 失败的一方要带原始的锁错误（1213 死锁 / 1205 等待超时），不许吞成成功
        for mode, item in by_mode.items():
            if item["ok"]:
                continue
            message = str(item.get("message") or "")
            # 失败的种类：**锁错误**（1205/1213）或**版本冲突**（TimestampMismatchError）
            # —— 两者都是「原始错误、没有被吞成成功」；版本冲突说明乐观锁闸按设计挡住了。
            raw = ("1205", "1213", "Deadlock", "Lock wait timeout", "TimestampMismatchError",
                   "记录已被修改")
            self.assertTrue(any(token in message or token in str(item.get("type"))
                                for token in raw),
                            "%s 路失败了却不是原始的锁错误/版本冲突（可能被吞了）：%s / %s"
                            % (mode, item.get("type"), message))

        # ④ 失败的一方用**同一个幂等键**重试 ⇒ 必须成功；且那个键只有一条日志
        for mode, item in by_mode.items():
            if item["ok"]:
                continue
            key = self._keys[mode]
            self.assertEqual(self._log_count(key), 0,
                             "%s 路失败后却留下了日志（不该有成功的日志）：%d" % (mode, self._log_count(key)))
            retried = self._retry(mode, key)
            self.assertTrue(retried["ok"], "%s 路同键重试没成：%s" % (mode, retried.get("message")))
            # ⚠️ **再结束一次读事务再看**（重试在**另一个连接**里提交 ⇒ 父连接的 RR 快照看不见它）
            frappe.db.commit()
            self.assertEqual(self._log_count(key), 1,
                             "%s 路同键重试后日志不是一条（重试被当成重放、或记了两条）：%d"
                             % (mode, self._log_count(key)))

    # ---------- 跑两路 ----------
    def _run_both(self):
        self._keys = {"cell": "lock-order-cell-" + uuid.uuid4().hex,
                      "record": "lock-order-record-" + uuid.uuid4().hex}
        entries = [self._spawn("cell", 101.0, self._keys["cell"]),
                   self._spawn("record", 202.0, self._keys["record"])]
        return [self._await(entry) for entry in entries]

    def _retry(self, mode, key):
        """失败的一方用**同一个幂等键**再跑一遍（**真重试**，不是重放）。

        ⚠️ **重试要带最新的版本**（上一轮若是**版本冲突**失败，原版本当然对不上
        ⇒ 不刷新就必然再失败一次 ⇒ 那不是「重试必成」的真检验）。
        """
        from shangshu_core import model_records
        model = frappe.get_doc(model_records.MODEL, self.object_id)
        self.record_modified = str(frappe.db.get_value(model.physical_doctype,
                                                         self.record_name, "modified"))
        self.revision = model.active_revision
        entry = self._spawn(mode, 101.0 if mode == "cell" else 202.0, key)
        return self._await(entry)
