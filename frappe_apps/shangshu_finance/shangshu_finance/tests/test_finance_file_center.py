"""判据：**财务域自己不放字节**（收口文件中心契约那处限期豁免 · PKG-036-T02）。

**测试通过 = 什么成立**（一句话）：

「**上传一张发票，字节由文件域放** ——
　财务域的代码里**没有**自己存字节的写法，走的是文件域的公开动作 `files.upload`；
　解析记录指向**受管文件的固定版本**（受管编号 ＋ 版本号都记着）；
　财务域声明了**对文件域的依赖**（跨域调用必须声明）与**自己在文件中心的那块路径**；
　契约里那处**限期豁免已经删掉**（收口了就不再是例外）。」

逐条落地：
1. **源码级**：`service.py` 里没有 `save_file(`（自己放字节的写法）⇒ 并且走的是 `files.upload`；
2. **解析记录**的 doctype 里有 `managed_file`（受管文件编号）与 `managed_version`（固定版本）两栏；
3. **manifest**：声明了**对文件域的依赖** ＋ 版本与域贡献**一致** ＋ 声明了**自己那块路径**；
4. **域贡献**里也有同一份路径声明（两处必须一致）；
5. **契约里那处限期豁免已经删掉**（`file-center-v1.json` 的 `exemptions` 里不再有财务域那一条）；
6. **机器检查器**（`scripts/check-file-center-bypass.mjs`）在当前仓**不再报财务域这一处**。

跑法（仓库根，**不需要站点**）：

    python3 -m unittest discover -s frappe_apps/shangshu_finance -p "test_finance_file_center.py" -t frappe_apps/shangshu_finance
"""
import json
import re
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]      # frappe_apps/shangshu_finance
PKG_ROOT = APP_ROOT / "shangshu_finance"
REPO_ROOT = APP_ROOT.parents[1]                      # 仓库根
SERVICE_SRC = (PKG_ROOT / "service.py").read_text(encoding="utf-8")
DOMAIN_SRC = (PKG_ROOT / "domain.py").read_text(encoding="utf-8")
MANIFEST_SRC = (APP_ROOT / "shangshu-plugin.yml").read_text(encoding="utf-8")
CONTRACT_PATH = REPO_ROOT / "frappe_apps" / "shangshu_core" / "shangshu_core" / "contracts" / "file-center-v1.json"


class TestFinanceFileCenter(unittest.TestCase):
    # ---------- ① 字节由文件域放 ----------

    def test_finance_domain_no_longer_stores_bytes_itself(self):
        self.assertNotIn("save_file(", SERVICE_SRC,
                         "财务域还在自己存字节（save_file）⇒ 违反「所有进尚书的文件都进文件中心」")
        self.assertIn('"files.upload"', SERVICE_SRC,
                      "财务域没有走文件域的公开动作 files.upload ⇒ 原件仍是财务域自己放的")

    # ---------- ② 解析记录指向受管文件的固定版本 ----------

    def test_extraction_record_keeps_the_managed_reference(self):
        # Frappe 的 doctype 目录在 `<app>/<app>/doctype/`（两��同名目录）⇒ 路径要跟着。
        doctype = json.loads(
            (PKG_ROOT / "shangshu_finance" / "doctype" / "shangshu_document_extraction"
             / "shangshu_document_extraction.json").read_text(encoding="utf-8"))
        names = [field.get("fieldname") for field in doctype.get("fields") or []]
        self.assertIn("managed_file", names, "解析记录没有记受管文件编号 ⇒ 看不出原件在文件中心的哪一条")
        self.assertIn("managed_version", names, "解析记录没有记受管文件版本 ⇒ 不是「固定版本」")

    # ---------- ③ manifest ----------

    def test_manifest_declares_the_file_domain_dependency(self):
        self.assertIn("com.shangshu.files", MANIFEST_SRC,
                      "manifest 没声明对文件域的依赖 ⇒ 跨域调 files.upload 会被内核拒")

    def test_manifest_version_matches_the_contribution(self):
        manifest_version = re.search(r"^version:\s*(\S+)", MANIFEST_SRC, re.M).group(1)
        # 只取**域自己**那个版本（域贡献里还有一堆对象的版本号，别取错）：
        # 找到 `"owner_app": "shangshu_finance"` 之后**紧接着**的那个 version。
        after = DOMAIN_SRC.split('"owner_app": "shangshu_finance"', 1)[-1]
        contribution_version = re.search(r'"version":\s*"([0-9.]+)"', after).group(1)
        self.assertEqual(manifest_version, contribution_version,
                         "manifest 的版本与域贡献不一致 ⇒ 内核启用域时当场拒")

    def test_manifest_declares_its_own_path_in_the_file_center(self):
        self.assertIn("/com.shangshu.finance/", MANIFEST_SRC,
                      "manifest 没声明自己在文件中心的那块路径")

    # ---------- ④ 域贡献 ----------

    def test_contribution_declares_the_same_path(self):
        self.assertIn('"file_paths"', DOMAIN_SRC, "域贡献里没有 file_paths（自己那块路径）")
        self.assertIn("/com.shangshu.finance/", DOMAIN_SRC,
                      "域贡献里声明的路径与 manifest 不是同一块")

    # ---------- ⑤ 契约里那处限期豁免已经删掉 ----------

    def test_the_contract_no_longer_lists_it_as_an_exemption(self):
        """契约里那一条**不再是例外**（改成「已收口」）——它还留着，但**不再豁免**。

        ⚠️ 为什么不是直接删掉：**留着并标「已收口」**，那个域万一又自己放字节，
        检查器照样会报出来（已收口的条目**不算例外**）⇒ 复发要看得见，
        而历史（「这一处曾经是例外、什么时候收的、怎么收的」）也留在表里。
        """
        contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        entries = contract.get("exemptions", {}).get("entries") or []
        finance = [item for item in entries
                   if "shangshu_finance" in str(item.get("where") or "")]
        self.assertEqual(len(finance), 1,
                         "契约里财务域那一条应当**恰好一条**（收口记录），现在是 %d 条" % len(finance))
        kind = str(finance[0].get("kind") or "")
        self.assertIn("已收口", kind,
                      "契约里财务域那一条还标着「%s」⇒ 收口了就不该再算例外" % kind)
        self.assertNotIn("限期豁免", kind, "收口了就不该再是限期豁免")
        # **还成立的限期豁免里不该再有财务域**（收口一处 ⇒ 数目少一处 ⇒ 判据跟着改）。
        limited = [item for item in entries
                   if "限期豁免" in str(item.get("kind") or "")]
        self.assertFalse([item for item in limited if "shangshu_finance" in str(item.get("where") or "")],
                         "财务域已经收口了，不该再出现在「还成立的限期豁免」里")
        for item in limited:
            self.assertTrue(item.get("to_collect_when"),
                            "还成立的限期豁免「%s」没写 to_collect_when" % item.get("where"))

    # ---------- ⑥ 机器检查器不再报这一处 ----------

    def test_the_bypass_checker_no_longer_reports_the_finance_site(self):
        """**机器检查器**（node 那支）在这个仓里跑一遍：财务域一处都不该再出现。

        ⚠️ 用 `node --json` 跑，不在 python 里 import 那个 .mjs（ESM，python 导不进来）；
        本机没有 node 就跳过 —— 机器检查器自己那侧另有判据（`scripts/tests/check-file-center-bypass.test.mjs`）。
        """
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
        finance = [item for item in (data.get("registered") or []) + (data.get("unregistered") or [])
                   if "shangshu_finance" in str(item)]
        self.assertEqual(finance, [],
                         "财务域还出现在检查器的清单里（要么还有自己放字节的地方，要么豁免没从契约里删掉）：%s"
                         % finance)


if __name__ == "__main__":
    unittest.main()
