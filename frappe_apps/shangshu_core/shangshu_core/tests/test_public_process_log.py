"""PKG-041-T01：域往统一日志库写过程记录 —— **只许走公开口**（域不许 import 内核内部模块）。

**测试通过 = 什么成立**（一句话）：

「**域能通过 `shangshu_core.public_api` 写自己的过程记录**（`what_kind='process'`）：
  通用字段齐全、`domain_id` 是那个域、业务记录两列指向它自己那条记录；
  **域专属字段落在那个域自己的扩展表**里（换域读不到别域的字段）；
  **平台服务 `platform.log.record` 走的是同一条路** —— 它在**域贡献的服务段里注册着**
  （助手与别的域按服务找它）、**真能被分发到**（走 `invoke_domain_service`，不是直接调处理函数）；
  契约 `unified-log-v1.json` 的 `domain_process_records.known` 里**有邮件域**，
  版本**已进位**（不再是 1.0.0）。」

为什么要有这个公开口（§8 第 11／12 项）：
- 契约 `contracts/unified-log-v1.json` 写着「**新域要往日志库里记过程 ⇒ 走同一张表 ＋
  自己的扩展字段，不另开日志表**」—— 但**写口一直是内核内部的**（`shangshu_core.unified_log.write_log`），
  域按规矩**只能依赖 `shangshu_core.public_api`** ⇒ **域想记过程记录就没有路**。
- 机制其实**早就在**（`write_log`／`declare_extension_fields`／按域分表／域被拔掉字段随之拔掉），
  只是**没有公开出口**，也**没有任何域在用** ⇒ 这一笔把它开出来。

跑法（装了这个 App 的站点上）：

    bench --site <test-site> run-tests --module shangshu_core.tests.test_public_process_log --skip-test-records
"""
import json
from importlib import resources

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import unified_log
from shangshu_core.public_api import (
    API_VERSION,
    declare_process_log_fields,
    write_process_record,
)
from shangshu_core.unified_log import LOG_DOCTYPE

#: 每一行都得有值的那些（**业务对象两列**在「这次操作没碰受管记录」时留空 —— 不硬凑；
#: `actor_identity` 同理：没取到身份就留空）。
ALWAYS_FILLED = ("log_no", "occurred_at", "actor_user", "trigger_source", "domain_id",
                 "what_kind", "what_id", "result", "detail_json")

#: 判据专用的两个域（**不是真域**）—— 一个写，一个用来验证「换域读不到」。
WRITER_DOMAIN = "com.shangshu.test.proc"
OTHER_DOMAIN = "com.shangshu.test.proc.other"


class TestPublicProcessLog(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        frappe.set_user("Administrator")

    @classmethod
    def tearDownClass(cls):
        # **判据自己造的扩展表要收干净**（不然会给同站点的别的判据留残留）。
        for domain in (WRITER_DOMAIN, OTHER_DOMAIN):
            try:
                unified_log.remove_domain_extension(domain)
            except Exception:
                pass
        frappe.db.commit()
        super().tearDownClass()

    def test_public_api_exports_the_process_log_writer(self):
        """公开口**在** public_api 上（域只能引这一个模块）。"""
        self.assertTrue(callable(write_process_record))
        self.assertTrue(callable(declare_process_log_fields))
        # 平台 API 版本进位了（新增公开口 ⇒ 版本要动，否则域声明的 platform_api 约束看不出差别）。
        self.assertNotEqual(API_VERSION, "1.11.0",
            "平台 API 版本还停在 1.11.0 ⇒ 新增公开口没有进位")
        # **公开面清单里也得有**（`__all__`＝这个模块对外声明的那一份）。
        # 漏登记的后果：`from shangshu_core.public_api import *` **拿不到**它们，
        # 而那份清单正是「哪些是公开口」的**唯一成文清单** ⇒ 漏一条＝这个口**没登记**。
        import shangshu_core.public_api as public_api
        for name in ("write_process_record", "declare_process_log_fields"):
            self.assertIn(name, public_api.__all__,
                "公开口 %s 没登记进 public_api.__all__ ⇒ 它没进那份公开面清单" % name)

    def test_process_record_carries_the_common_fields(self):
        """写出来的那一行：**通用字段齐全**、类别是 `process`、业务记录两列指向它自己那条。"""
        row = write_process_record(
            "mail.draft.saved",
            domain_id=WRITER_DOMAIN,
            business_object_id="MAIL-1",
            business_name="MAIL-1",
            result="Succeeded",
            trigger_source="user",
            detail={"subject": "受理通知书"},
        )
        self.assertEqual(row.what_kind, "process")
        self.assertEqual(row.domain_id, WRITER_DOMAIN)
        self.assertEqual(row.what_id, "mail.draft.saved")
        self.assertEqual(row.business_object_id, "MAIL-1")
        self.assertEqual(row.business_name, "MAIL-1")
        self.assertEqual(row.result, "Succeeded")
        self.assertEqual(row.trigger_source, "user")
        for field in ALWAYS_FILLED:
            self.assertTrue(row.get(field), "通用字段 %s 是空的" % field)
        # 九个通用字段的形状要能读回来（读口是给人看的那一列）。
        read = unified_log.read_log(row.log_no)
        self.assertEqual(read["what_kind"], "process")
        self.assertEqual(read["detail"].get("subject"), "受理通知书")
        frappe.db.delete(LOG_DOCTYPE, {"name": row.name})
        frappe.db.commit()

    def test_domain_fields_land_in_own_table_and_do_not_leak(self):
        """域专属字段落在**那个域自己的扩展表**里；换域读不到别域的字段。"""
        declare_process_log_fields(WRITER_DOMAIN, [
            {"name": "case_ref", "label": "关联案件", "type": "Data"},
        ])
        self.assertTrue(unified_log.extension_table_exists(WRITER_DOMAIN))
        self.assertFalse(unified_log.extension_table_exists(OTHER_DOMAIN))
        row = write_process_record(
            "mail.sent",
            domain_id=WRITER_DOMAIN,
            business_object_id="MAIL-2",
            extension_values={"case_ref": "CASE-001"},
        )
        extension = unified_log.read_extension(row.log_no)
        self.assertEqual((extension or {}).get("case_ref"), "CASE-001")
        # **别的域的表里没有这一行**（换域不污染）。
        other_table = unified_log.extension_doctype(OTHER_DOMAIN)
        if frappe.db.exists("DocType", other_table):
            self.assertFalse(frappe.get_all(other_table, filters={"log_no": row.log_no}))
        frappe.db.delete(LOG_DOCTYPE, {"name": row.name})
        frappe.db.commit()

    def test_platform_service_writes_through_the_same_path(self):
        """平台服务 `platform.log.record` **真能被调到**（助手与别的域走的那个通道）。

        这一条走的是**真分发**（`invoke_domain_service`）—— 不是直接调处理函数：
        服务必须**在域的贡献里注册着**（助手/别的域才找得到它），
        且**能被分发到**，才算数。
        """
        from shangshu_core.domains import ensure_registered_domains, invoke_domain_service, raw_resource

        # **先把域贡献刷新进登记**（域的贡献存在 `Shangshu Domain` 的 contribution_json 里
        # —— 新加的服务不刷新就查不到；真站上 migrate 走的是同一条路）。
        ensure_registered_domains()
        frappe.db.commit()

        # ① 它**在服务这一段**（助手/别的域按服务找它）。
        domain_row, service = raw_resource("services", "platform.log.record")
        self.assertTrue(service, "platform.log.record 没在域贡献的服务段里注册 ⇒ 助手与别的域找不到它")
        self.assertTrue(domain_row and domain_row.get("id"), "服务没归属到任何域")
        self.assertTrue(service.get("handler"), "服务没写处理函数")

        # ② 真分发一次 ⇒ 落一行 `process` 记录（**走的是同一条路**）。
        out = invoke_domain_service("platform.log.record", {
            "what_id": "mail.draft.confirmed",
            "domain_id": WRITER_DOMAIN,
            "business_object_id": "MAIL-3",
            "result": "Succeeded",
        })
        log_no = (out or {}).get("log_no")
        self.assertTrue(log_no, "平台服务没回日志编号：%r" % (out,))
        row = frappe.get_doc(LOG_DOCTYPE, log_no)
        self.assertEqual(row.what_kind, "process")
        self.assertEqual(row.domain_id, WRITER_DOMAIN)
        self.assertEqual(row.business_object_id, "MAIL-3")
        # ③ 服务**不是**动作通道上的那个（动作通道要额外登记、还要确认卡 ⇒ 助手用不了）。
        _, as_action = raw_resource("actions", "platform.log.record")
        self.assertIsNone(as_action, "它还在动作段里 ⇒ 助手走服务通道时找不到它")
        frappe.db.delete(LOG_DOCTYPE, {"name": row.name})
        frappe.db.commit()

    def test_process_record_is_scoped_and_readable_by_the_public_read(self):
        """过程记录**读得回来**（公开读口）＋ **带得出身份**（日志授权靠它缩小范围）。

        为什么身份这一条要紧：日志读口的授权是
        「**按业务标识缩小范围不放宽权限**」—— 授权过滤落在 `actor_identity` 上。
        写的时候**不填身份** ⇒ 那几行**谁都看不见**（过滤条件 `actor_identity in [...]`
        匹配不上空值）⇒ 写进去了**等于没写**。
        """
        from shangshu_core.public_api import query_process_records

        row = write_process_record(
            "mail.draft.saved",
            domain_id=WRITER_DOMAIN,
            business_object_id="MAIL-READ",
            business_name="MAIL-READ",
            result="Succeeded",
            trigger_source="user",
            detail={"subject": "受理通知书"},
        )
        # ① **身份落了**（授权要靠它）。
        self.assertTrue(row.get("actor_identity"),
            "这一行没记 actor_identity ⇒ 日志授权过滤不到它 ⇒ 写进去等于没写")
        # ② **公开读口读得回来**（按受管记录取）。
        out = query_process_records("MAIL-READ")
        items = (out or {}).get("items") or []
        mine = [item for item in items if item.get("log_no") == row.log_no]
        self.assertTrue(mine, "公开读口没读到刚写的那一行：%r" % (out,))
        self.assertEqual(mine[0].get("what_kind"), "process")
        self.assertEqual(mine[0].get("domain_id"), WRITER_DOMAIN)
        self.assertEqual((mine[0].get("detail") or {}).get("subject"), "受理通知书")
        # ③ 域专属字段**跟着读口出来**（扩展表那一层接上了）。
        self.assertIsInstance(mine[0].get("domain_fields"), dict)
        frappe.db.delete(LOG_DOCTYPE, {"name": row.name})
        frappe.db.commit()


    def test_read_page_stable_ties_expand_only_page_extensions(self):
        """真实库：同发生时间按唯一name稳定补序，扩展详情只读取当前页。"""
        from unittest.mock import patch
        from shangshu_core.public_api import query_process_records

        object_id = "PROC-PAGE-" + frappe.generate_hash(length=10)
        rows = []
        try:
            for number in range(7):
                rows.append(write_process_record(
                    "page.fixture", domain_id=WRITER_DOMAIN,
                    business_object_id=object_id, business_name="only-record",
                    occurred_at="2026-01-01 12:00:00", detail={"number": number},
                ))
            expected = sorted((row.log_no for row in rows), reverse=True)[2:4]
            with patch.object(unified_log, "read_extension", wraps=unified_log.read_extension) as extension:
                result = query_process_records(object_id, "only-record", page=2, page_length=2)
            self.assertEqual([item["log_no"] for item in result["items"]], expected)
            self.assertEqual([call.args[0] for call in extension.call_args_list], expected)
            with patch.object(unified_log, "read_extension", wraps=unified_log.read_extension) as extension:
                result = query_process_records(object_id, "only-record", page=99, page_length=2)
            self.assertEqual(result["items"], [])
            extension.assert_not_called()
        finally:
            for row in rows:
                frappe.db.delete(LOG_DOCTYPE, {"name": row.name})
            frappe.db.commit()

    def test_contract_lists_the_mail_domain_and_version_moved(self):
        """契约 `unified-log-v1.json`：**邮件域进了 known**，版本**已进位**（§8 第 12 项）。"""
        raw = resources.files("shangshu_core").joinpath("contracts/unified-log-v1.json")
        contract = json.loads(raw.read_text(encoding="utf-8"))
        self.assertNotEqual(contract.get("version"), "1.0.0",
            "契约版本还停在 1.0.0 ⇒ 加了邮件域没进位")
        known = contract["carries"]["domain_process_records"]["known"]
        domains = [item.get("domain") for item in known]
        self.assertIn("com.shangshu.mail", domains,
            "统一日志库契约的 known 里**没有邮件域** ⇒ §8 第 12 项没做")
