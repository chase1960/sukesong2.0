"""判据：**邮件域的外链图不再自己存字节**（收口文件中心契约那处限期豁免 · PKG-036-T03）。

**测试通过 = 什么成立**（一句话）：

「**来信里的外链图，字节由文件域放** —— 邮件域的代码里**没有**自己建 `File` 塞内容；
　外链图在**受管原件**之外，还**绑定**在这封信上（读信面按这封信取字节、正文 `cid:` 照旧解析得出图）；
　存失败的**不换引用**（图不丢）；契约里那处**限期豁免不再是例外**。」

逐条落地：
1. **源码级**：`external_assets.py` 里没有自己建 `File` 塞内容的写法；
2. 它走**文件域的 `files.upload`**（字节由文件域放）＋ 邮件域自己的 **`mail.attachment.bind`**（绑引用）；
3. **`mail.attachment.bind` 已登记**（域贡献的动作清单 ＋ 版本 ＋ manifest 的 actions 段，三处齐）；
4. **manifest**：版本与域贡献一致 ＋ 声明了**自己那块路径** ＋ 文件域仍是**可选**依赖（不装文件中心时邮件照常用）；
5. **域贡献**里也有同一份路径声明（两处一致）；
6. **契约里外链图那一条不再是「限期豁免」**（改成「已收口」）；
7. **机器检查器**（`scripts/check-file-center-bypass.mjs`）在当前仓**不再报外链图这一处**。

跑法（仓库根，**不需要站点**）：

    python3 -m unittest discover -s frappe_apps/shangshu_mail -p "test_mail_asset_file_center.py" -t frappe_apps/shangshu_mail
"""
import json
import re
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]      # frappe_apps/shangshu_mail
PKG_ROOT = APP_ROOT / "shangshu_mail"
REPO_ROOT = APP_ROOT.parents[1]                      # 仓库根
ASSETS_SRC = (PKG_ROOT / "external_assets.py").read_text(encoding="utf-8")
DOMAIN_SRC = (PKG_ROOT / "domain.py").read_text(encoding="utf-8")
SERVICE_SRC = (PKG_ROOT / "service.py").read_text(encoding="utf-8")
MANIFEST_SRC = (APP_ROOT / "shangshu-plugin.yml").read_text(encoding="utf-8")
CONTRACT_PATH = REPO_ROOT / "frappe_apps" / "shangshu_core" / "shangshu_core" / "contracts" / "file-center-v1.json"


class TestMailAssetFileCenter(unittest.TestCase):
    # ---------- ① 不自己存字节 ----------

    def test_external_assets_no_longer_builds_its_own_file(self):
        self.assertNotIn("'doctype': 'File'", ASSETS_SRC,
                         "外链图还在自己建 File（doctype: File）⇒ 违反「所有进尚书的文件都进文件中心」")
        self.assertNotIn("'doctype':'File'", ASSETS_SRC,
                         "外链图还在自己建 File（doctype:File）⇒ 违反「所有进尚书的文件都进文件中心」")

    def test_external_assets_places_bytes_through_the_file_domain(self):
        self.assertIn("'files.upload'", ASSETS_SRC, "外链图没有走文件域的 files.upload")
        self.assertIn("'mail.attachment.bind'", ASSETS_SRC,
                      "外链图没有把受管原件绑回这封信上（读信面与 cid: 会取不到字节）")

    def test_failed_storage_does_not_break_the_image(self):
        """存失败的**不要**把正文引用换成 `cid:`（换了就丢图）。"""
        self.assertIn("stored_ids", ASSETS_SRC,
                      "外链图入库失败时仍会把引用换成 cid: ⇒ 图会丢")
        self.assertIn("rewrite_external_to_cids", ASSETS_SRC)

    # ---------- ② 新动作已登记（三处齐） ----------

    def test_the_bind_action_is_registered_in_the_contribution(self):
        self.assertIn("'mail.attachment.bind'", DOMAIN_SRC, "域贡献里没有登记 mail.attachment.bind 这个动作")
        self.assertIn("'mail.attachment.bind': '1.0.0'", DOMAIN_SRC, "mail.attachment.bind 没有登记版本号")

    def test_the_bind_action_is_listed_in_the_manifest(self):
        self.assertIn("- mail.attachment.bind", MANIFEST_SRC,
                      "manifest 的 actions 段少了 mail.attachment.bind（内核会拒装）")

    def test_the_bind_action_has_an_implementation(self):
        self.assertIn("def bind_managed_attachments(", SERVICE_SRC, "动作没有实现")
        self.assertIn("bind_record_attachments", SERVICE_SRC,
                      "实现里没有用内核的 bind_record_attachments（那是「同一份字节、两个身份」的正路）")

    # ---------- ③ manifest ----------

    def test_manifest_version_matches_the_contribution(self):
        manifest_version = re.search(r"^version:\s*(\S+)", MANIFEST_SRC, re.M).group(1)
        after = DOMAIN_SRC.split("'owner_app':'shangshu_mail'", 1)[-1]
        contribution_version = re.search(r"'version':\s*'([0-9.]+)'", after).group(1)
        self.assertEqual(manifest_version, contribution_version,
                         "manifest 的版本与域贡献不一致 ⇒ 内核启用域时当场拒")

    def test_manifest_declares_its_own_path_in_the_file_center(self):
        self.assertIn("/com.shangshu.mail/", MANIFEST_SRC,
                      "manifest 没声明自己在文件中心的那块路径")

    def test_file_center_stays_an_optional_integration(self):
        """文件域对邮件域**仍是可选**（不装文件中心时邮件照样收发读）。"""
        optional = MANIFEST_SRC.split("optional_dependencies:", 1)[-1].split("exports:", 1)[0]
        self.assertIn("com.shangshu.files", optional,
                      "文件域不在 optional_dependencies 里 ⇒ 不装文件中心就装不了邮件域")

    # ---------- ④ 域贡献里同一份路径 ----------

    def test_contribution_declares_the_same_path(self):
        self.assertIn("'file_paths'", DOMAIN_SRC, "域贡献里没有 file_paths（自己那块路径）")
        self.assertIn("/com.shangshu.mail/", DOMAIN_SRC, "域贡献里声明的路径与 manifest 不是同一块")

    # ---------- ⑤ 契约里不再是例外 ----------

    def test_the_contract_no_longer_lists_it_as_an_exemption(self):
        contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        entries = contract.get("exemptions", {}).get("entries") or []
        assets = [item for item in entries
                  if "external_assets" in str(item.get("where") or "")]
        self.assertEqual(len(assets), 1,
                         "契约里外链图那一条应当**恰好一条**（收口记录），现在是 %d 条" % len(assets))
        kind = str(assets[0].get("kind") or "")
        self.assertIn("已收口", kind,
                      "契约里外链图那一条还标着「%s」⇒ 收口了就不该再算例外" % kind)
        self.assertNotIn("限期豁免", kind, "收口了就不该再是限期豁免")

    # ---------- ⑥ 机器检查器不再报这一处 ----------

    def test_the_bypass_checker_no_longer_reports_this_site(self):
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
        hits = [item for item in (data.get("registered") or []) + (data.get("unregistered") or [])
                if "external_assets" in str(item)]
        self.assertEqual(hits, [],
                         "外链图那一处还出现在检查器的清单里：%s" % hits)


if __name__ == "__main__":
    unittest.main()
