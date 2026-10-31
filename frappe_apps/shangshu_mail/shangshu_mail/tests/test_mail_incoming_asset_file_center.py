"""判据：**来信附件／内联图的字节由文件域放**（收口文件中心契约那处限期豁免 · PKG-036-T04）。

**测试通过 = 什么成立**（一句话）：

「**收进来一封信，附件与内联图的字节由文件域放** ——
　邮件域的代码里**没有**自己建 `File` 塞内容；走的是文件域的公开动作 `files.upload_attached`
　（放字节 ＋ **挂到那封信上**）⇒ **读信面按这封信取字节照旧、正文 `cid:` 照旧解析得出图**、
　**字节仍然只有一份**；契约里那处**限期豁免不再是例外**。」

逐条落地：
1. **源码级**：`delivery.py` 里没有自己建 `File` 塞内容的写法；
2. 它走**文件域的 `files.upload_attached`**，并把那个 File 行**挂到那封信上**（`attach_to`）；
3. **文件域那边**：`files.upload_attached` 这个动作**三处齐**（域贡献 ＋ manifest ＋ 实现）
   ＋ **manifest 版本与域贡献一致**；
4. **契约里收信附件那一条不再是「限期豁免」**（改成「已收口」）；
5. **机器检查器**（`scripts/check-file-center-bypass.mjs`）在当前仓**一处都没报**
   （收信附件那一处也没了）⇒ 「所有进尚书的文件都进文件中心」这句话**站住了**。

跑法（仓库根，**不需要站点**）：

    python3 -m unittest discover -s frappe_apps/shangshu_mail -p "test_mail_incoming_asset_file_center.py" -t frappe_apps/shangshu_mail
"""
import json
import re
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]      # frappe_apps/shangshu_mail
PKG_ROOT = APP_ROOT / "shangshu_mail"
REPO_ROOT = APP_ROOT.parents[1]                      # 仓库根
DELIVERY_SRC = (PKG_ROOT / "delivery.py").read_text(encoding="utf-8")
MAIL_MANIFEST = (APP_ROOT / "shangshu-plugin.yml").read_text(encoding="utf-8")
FILES_ROOT = REPO_ROOT / "frappe_apps" / "shangshu_files"
FILES_DOMAIN_SRC = (FILES_ROOT / "shangshu_files" / "domain.py").read_text(encoding="utf-8")
FILES_SERVICE_SRC = (FILES_ROOT / "shangshu_files" / "service.py").read_text(encoding="utf-8")
FILES_MANIFEST = (FILES_ROOT / "shangshu-plugin.yml").read_text(encoding="utf-8")
CONTRACT_PATH = REPO_ROOT / "frappe_apps" / "shangshu_core" / "shangshu_core" / "contracts" / "file-center-v1.json"


class TestMailIncomingAssetFileCenter(unittest.TestCase):
    # ---------- ① 不自己建 File ----------

    def test_the_intake_chain_no_longer_builds_its_own_file(self):
        self.assertNotIn("'doctype':'File'", DELIVERY_SRC,
                         "收信链还在自己建 File（doctype:File）⇒ 违反「所有进尚书的文件都进文件中心」")
        self.assertNotIn("'doctype': 'File'", DELIVERY_SRC,
                         "收信链还在自己建 File（doctype: File）⇒ 违反「所有进尚书的文件都进文件中心」")

    def test_the_intake_chain_places_bytes_through_the_file_domain(self):
        self.assertIn("'files.upload_attached'", DELIVERY_SRC, "收信链没有走文件域的 files.upload_attached")
        self.assertIn("'attach_to'", DELIVERY_SRC,
                      "收信链没有说清挂在谁身上 ⇒ 读信面按这封信取字节会取不到")

    # ---------- ② 文件域那边：动作三处齐 ----------

    def test_the_file_domain_declares_the_action(self):
        self.assertIn("'files.upload_attached'", FILES_DOMAIN_SRC, "文件域的域贡献里没有登记 files.upload_attached")
        self.assertIn("- files.upload_attached", FILES_MANIFEST,
                      "文件域 manifest 的 actions 段少了 files.upload_attached（内核会拒装）")
        self.assertIn("def upload_attached(", FILES_SERVICE_SRC, "文件域没有实现 files.upload_attached")
        self.assertIn("'files.upload_attached': upload_attached", FILES_SERVICE_SRC,
                      "文件域的处理器表里没有登记 files.upload_attached")

    def test_the_file_domain_checks_the_permission_on_the_target_record(self):
        self.assertIn("can_read_reference", FILES_SERVICE_SRC,
                      "挂到别人记录上之前没有核读权（把字节送到他眼前）")

    def test_files_manifest_version_matches_the_contribution(self):
        manifest_version = re.search(r"^version:\s*(\S+)", FILES_MANIFEST, re.M).group(1)
        source_version = re.search(
            r"'owner_app':\s*'shangshu_files',\s*'version':\s*'([0-9.]+)'", FILES_DOMAIN_SRC).group(1)
        self.assertEqual(manifest_version, source_version,
                         "文件域 manifest 的版本与域贡献不一致 ⇒ 内核启用域时当场拒")

    # ---------- ③ 契约里不再是例外 ----------

    def test_the_contract_no_longer_lists_it_as_an_exemption(self):
        contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        entries = contract.get("exemptions", {}).get("entries") or []
        delivery = [item for item in entries
                    if "shangshu_mail/shangshu_mail/delivery.py" in str(item.get("where") or "")]
        self.assertEqual(len(delivery), 1,
                         "契约里收信附件那一条应当**恰好一条**（收口记录），现在是 %d 条" % len(delivery))
        kind = str(delivery[0].get("kind") or "")
        self.assertIn("已收口", kind,
                      "契约里收信附件那一条还标着「%s」⇒ 收口了就不该再算例外" % kind)
        self.assertNotIn("限期豁免", kind, "收口了就不该再是限期豁免")

    # ---------- ④ 机器检查器一处都没报 ----------

    def test_the_bypass_checker_reports_nothing(self):
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("本机没有 node，跳过（检查器自己那侧的判据仍在跑）")
        checker = REPO_ROOT / "scripts" / "check-file-center-bypass.mjs"
        outcome = subprocess.run([node, str(checker), "--json"], cwd=str(REPO_ROOT),
                                 capture_output=True, text=True, timeout=120)
        self.assertEqual(outcome.returncode, 0,
                         "机器检查器报出了没登记的绕过：%s" % outcome.stdout[:800])
        data = json.loads(outcome.stdout or "{}")
        self.assertEqual(data.get("unregistered") or [], [],
                         "还有域自己放字节、没在契约里登记的地方")
        # **还成立的限期豁免一处都不该有**了（三处都收口了）。
        self.assertEqual(data.get("stale") or [], [],
                         "契约登记了限期豁免、代码里却找不到了：%s" % (data.get("stale") or []))


if __name__ == "__main__":
    unittest.main()
