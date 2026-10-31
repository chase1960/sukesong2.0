"""域在文件中心的那块路径：**各域自己声明，文件中心照办**（谁都不许知道谁）。

用户 2026-10-22 15:52 原话：「要设计一个契约，每一个新业务域的注册都要注册一个新的路径……
然后直接把这几个域的文件都放进这一块来管理，**这个方法就可以一劳永逸了**」。

**「一劳永逸」的前提是「谁都不许知道谁」**（`contracts/file-center-v1.json` `domain_paths.decoupling`）：
· **文件中心不许硬编码任何域 id**（不许出现别的域 id 的字面量清单）——
  它只认「域声明了什么路径就建什么路径」，**不知道也不关心**那是哪个域；
· **不许按域 id 分支**（不许 `if domain == ...`）；
· **不许维护一张「域 ⇒ 路径」的中央清单** —— 路径由各域自己声明，文件中心只负责照办；
· **域也不许知道别的域的路径**（邮件域不该知道 example 的路径长什么样）。

**路径的形状由文件中心定，内容由域定**：文件中心只要求
「**以域 id 开头的一段 ＋ 域自己挑的子目录**」（例：`/<域 id>/<域自己的子目录>`）；
剩下那一段由域自己说。

**声明在两处，内容必须一样**（不一致当场报错，不留「两套说法」）：
· **域的贡献**（`get_contribution()['file_paths']`）—— 机器读的那份（注册表里存的就是它）；
· **域的 `shangshu-plugin.yml`**（`file_paths:`）—— 人读的那份。
"""
import frappe

from shangshu_files.domain import DOMAIN as FILE_CENTER_DOMAIN

# 路径的形状：**以声明者的域 id 开头**（第一段就是域 id），后面是域自己挑的子目录。
# 根目录（`/`）只有**文件域本体**用（它就是根）—— 这不是「硬编码别的域」，
# 是文件中心认**自己**（FC-01 的解耦检查也放行 `com.shangshu.files`）。
ROOT_PATH = "/"


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def _manifest_paths(owner_app):
    """域的 `shangshu-plugin.yml` 里声明的路径（人读的那份；读不到就当没声明）。"""
    if not owner_app:
        return []
    try:
        import yaml
        from pathlib import Path

        path = Path(frappe.get_app_path(owner_app)).parent / "shangshu-plugin.yml"
        if not path.is_file():
            return []
        manifest = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:  # noqa: BLE001 —— 读不到 manifest 不拦「照办声明」这件事
        return []
    return [str(item).strip() for item in (manifest.get("file_paths") or []) if str(item).strip()]


def validate_declared_path(domain_id, path):
    """**路径的形状由文件中心定**（内容由域定）。

    · 必须以 `/` 开头；
    · 第一段必须是**声明者自己的域 id**（⇒ 域之间不撞）；
    · 根目录 `/` 只有文件域本体能用。
    """
    value = str(path or "").strip()
    if not value.startswith("/"):
        _fail("域「%s」声明的文件路径必须以 / 开头：%s" % (domain_id, value))
    if value == ROOT_PATH:
        if domain_id != FILE_CENTER_DOMAIN:
            _fail("域「%s」不能声明文件中心的根目录（根目录是文件中心本体自己的）" % domain_id)
        return value
    first = value.strip("/").split("/", 1)[0]
    if first != domain_id:
        _fail("域「%s」声明的文件路径必须以自己的域 id 开头（%s）：%s"
              % (domain_id, domain_id, value))
    return value


def declared_paths():
    """**各域自己声明**的那块路径（从注册表里读出来，不是文件中心自己编的清单）。"""
    from shangshu_core.public_api import list_domains

    result = []
    for domain in list_domains(include_disabled=True):
        contribution = domain.get("contribution") or {}
        owner_app = domain.get("owner_app") or contribution.get("owner_app")
        for raw in contribution.get("file_paths") or []:
            raw = raw if isinstance(raw, dict) else {"path": raw}
            path = str(raw.get("path") or "").strip()
            if not path:
                continue
            validate_declared_path(domain["id"], path)
            result.append({"domain_id": domain["id"], "path": path,
                           "note": str(raw.get("note") or "")})
    return result


def ensure_declared_paths():
    """**文件中心在域注册/安装时确保该路径存在**（幂等）。

    · 先刷新注册表（域刚装上/刚注册时，它的声明这时才在表里）；
    · 再逐条把声明的路径建出来（已存在就是不动它）。
    """
    from shangshu_core.public_api import ensure_registered_domains
    from shangshu_files import directories

    ensure_registered_domains()
    ensured = []
    for item in declared_paths():
        manifest = _manifest_paths(_owner_app(item["domain_id"]))
        if manifest and item["path"] not in manifest:
            _fail("域「%s」的两处路径声明不一致（贡献说 %s，manifest 说 %s）"
                  % (item["domain_id"], item["path"], "、".join(manifest)))
        directories.ensure_path(item["path"])
        ensured.append(item)
    return ensured


def _owner_app(domain_id):
    from shangshu_core.public_api import list_domains

    for domain in list_domains(include_disabled=True):
        if domain.get("id") == domain_id:
            contribution = domain.get("contribution") or {}
            return domain.get("owner_app") or contribution.get("owner_app")
    return ""
