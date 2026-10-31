"""`files.imported_of`：按**来源附件**反查已入库的受管文件（合并门禁：跨域不直摸）。

**为什么要有这个口**：邮件侧有 4 处 `frappe.db.exists('Shangshu File Center Version',
{'source_file': …})` 这种**直查文件域内部表**的跨域耦合。改成走本口，耦合就从
「读对方的表」变成「调对方公开声明的只读服务」—— 后者能被 `assert_declared_call`
和插件依赖声明管住，前者管不住。

**为什么只有批量读需要这个口**（别把耦合面越补越大）：
  · 幂等判断、图片重接取受管文件 id —— `files.import_attachment` 的**回包**本来就带
    `file`（受管文件 id）和 `already_imported`，改用回包即可，**不需要查询口**，
    顺带消掉按 `file_name` 全库匹配取 id 的隐患（回包给的是稳定 id）。
  · 只有「列表投影里给每个附件算已入库标记」是**批量读**，导入动作答不了 —— 那才用本口。

**`known` 与 `imported` 是两件事，不许合并**：
  · 来源附件**根本不存在** → `known: false`。**不许回 `imported: false` 充当「没入库」** ——
    「查不到」和「没入库」是同一个现象，会被读成「这附件还没进」。
  · 来源附件存在但没导过 → `known: true, imported: false`。
  · 导过 → `known: true, imported: true, file_center_id: <受管文件 id>`。

**同名不同来源不许串号**：查询按 `source_file` 这个稳定身份走，**不按文件名匹配**。
按文件名全库匹配正是 `shangshu_mail/delivery.py` 取 id 的隐患 —— 同名文件会取错。

**「已入库」认两条路，少一条就判错**：
  · `source_file` —— 这个附件被 `files.import_attachment` **导入过**。
  · `frappe_file` —— 这个附件**本来就是**某个受管版本的固定附件
    （用户从文件中心选件当附件用，`file-reference-picker.js` 推的就是这个 id）。
  只认前一条，从文件中心选来的附件会被判成「没入库」，界面多出一个「存入」按钮，
  点下去再导一遍。**这是语义缺口，不是边界情况。**

**无权不泄**：调用者对受管文件无读权时，`imported` 仍如实是 true（不撒谎说没入库），
但 `file_center_id` 置空并标 `restricted: true`。

普通读取**零 LLM 调用**。
"""
import frappe

VERSION = 'Shangshu File Center Version'
FILE = 'Shangshu File Center File'


def _row_for(source_file):
    """一个来源附件 → 受管文件。**两条路都认**；多命中取最新一次，不猜不合并。
    返回 `(file_center_id, found)`。
    """
    # 路 1：这个附件被导入过
    rows = frappe.get_all(VERSION, filters={'source_file': source_file},
                          fields=['file', 'uploaded_at', 'version_no'],
                          order_by='uploaded_at desc, version_no desc', limit_page_length=20)
    # 路 2：这个附件本来就是某个受管版本的固定附件（从文件中心选来的）
    if not rows:
        rows = frappe.get_all(VERSION, filters={'frappe_file': source_file},
                              fields=['file', 'uploaded_at', 'version_no'],
                              order_by='uploaded_at desc, version_no desc', limit_page_length=20)
    if not rows:
        return None, False
    return rows[0]['file'], True


def _visible(file_center_id):
    """调用者读得到这个受管文件吗。复用领域自己的权限口径，不另判一套。"""
    if not file_center_id or not frappe.db.exists(FILE, file_center_id):
        return False
    doc = frappe.get_doc(FILE, file_center_id)
    try:
        doc.check_permission('read')
        return True
    except Exception:
        return False


def imported_of(_service, payload, _context):
    """`files.imported_of`：按来源附件（Frappe File id）批量反查已入库的受管文件。

    回 `{items: [{source_file, known, imported, file_center_id, restricted}, …]}` ——
    **回对象不回裸数组**：BFF 的 `res.json({ok:true,...msg})` 会把裸数组摊成
    `{ok:true,"0":…}`，前端 `d.result?.items || d.items` 取不到，**口通了但列表照旧空**。
    """
    raw = payload.get('source_files') if isinstance(payload, dict) else None
    if not isinstance(raw, list) or not raw:
        frappe.throw('source_files 必填且是非空数组', frappe.ValidationError)
    if len(raw) > 100:
        frappe.throw('source_files 一次最多 100 个', frappe.ValidationError)

    items = []
    for one in raw:
        sid = str(one or '').strip()
        if not sid:
            frappe.throw('source_files 里不许有空编号', frappe.ValidationError)
        # **known 与 imported 分开**：先认来源附件在不在，再认进没进
        known = bool(frappe.db.exists('File', sid))
        if not known:
            items.append({'source_file': sid, 'known': False, 'imported': False,
                          'file_center_id': None, 'restricted': False})
            continue
        fid, found = _row_for(sid)
        if not found:
            items.append({'source_file': sid, 'known': True, 'imported': False,
                          'file_center_id': None, 'restricted': False})
            continue
        if _visible(fid):
            items.append({'source_file': sid, 'known': True, 'imported': True,
                          'file_center_id': fid, 'restricted': False})
        else:
            # **imported 如实是 true**（不撒谎说没入库），只是不把 id 交出来
            items.append({'source_file': sid, 'known': True, 'imported': True,
                          'file_center_id': None, 'restricted': True})
    return {'items': items, 'count': len(items)}
