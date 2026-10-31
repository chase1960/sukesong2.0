"""`files.action_proposals` / `files.action_proposal_resolve` —— A 的审核面板在等的两个服务口。

**为什么要有这两个**：A 的 `loadProposals()` 要按**表**取待审提案，而现有内核口
`/api/confirmations` 是**全库按状态**取的，且不在 `files.` 命名空间。A 调
`files.action_proposals` 回 404「领域服务不存在」，PKG-010 的 5 条判据全卡在这。

**回包形状必须对得上前端取值链**（identity 那单的教训）：
前端取 `d.result?.proposals || d.proposals`。BFF 的 `frappePost` 解掉 Frappe 的
`{message:…}` 封套后 `res.json({ok:true, ...msg})` —— handler 若回**裸数组**，
会被摊成 `{ok:true,"0":…,"1":…}`，前端照样取不到，**「服务通了但列表照旧空」，
修了等于没修**。所以这里一律回 `{proposals: [...]}`。
"""
import frappe

from shangshu_files.sheet import _load_meta, _writable
from shangshu_files.working_file import content_revision


def _current_versions(doc):
    """表当前的内容版本与结构版本（判断提案过期用）。"""
    meta = _load_meta(doc)
    content = content_revision(doc)
    structure = int(meta.get('structure_version') or 1)
    return content, structure


def _proposal_row(p, cur_content, cur_structure):
    """把一条内核提案投影成 A 要的形状，并算出过期标识。

    `content_version` / `structure_version` 取**提案创建时**钉住的版本
    （payload 里的 `expected_*_version`）；`expired` = 与当前版本对不上。
    """
    payload = p.get('payload') if isinstance(p.get('payload'), dict) else {}
    p_content = payload.get('expected_content_version')
    p_structure = payload.get('expected_structure_version')
    expired = False
    if p_content is not None:
        expired = expired or int(p_content) != int(cur_content)
    if p_structure is not None:
        expired = expired or int(p_structure) != int(cur_structure)
    return {
        'id': p.get('id'),
        'capability': p.get('capability'),
        'payload': payload,
        'content_version': p_content,
        'structure_version': p_structure,
        'expired': bool(expired),
        'status': p.get('status'),
        'created_via': p.get('created_via'),
        'summary': p.get('summary'),
        # 合并说明（来自 fast 那版）：这条提案能不能走逐项审核（内核 _proposal_public 给的）。
        'review_supported': bool(p.get('review_supported')),
    }


def listing(_service, payload, _context):
    """`files.action_proposals`：按表列待审提案。回 `{proposals:[…]}`。

    **表不存在要明确报错，不回空数组** —— 空数组会被读成「这张表没有待审」，
    和「过滤后没有」是同一个现象，用户无从分辨。判据 P-⑤ 就是钉这条。
    """
    table = str(payload.get('table') or '').strip()
    if not table:
        frappe.throw('table 必填', frappe.ValidationError)
    if not frappe.db.exists('Shangshu File Center File', table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)

    doc = frappe.get_doc('Shangshu File Center File', table)
    doc.check_permission('read')
    cur_content, cur_structure = _current_versions(doc)

    # 复用内核的列取（含企业隔离 + 角色过滤），不在这里重造一套权限
    from shangshu_core.public_api import list_action_proposals
    rows = list_action_proposals(status='Proposed')
    # ⚠️ **内核这个口有先后两种形状**（D 2026-10-17 实测）：
    #   · 旧：**裸 list**（`[{...}, ...]`）
    #   · 新：**`{items: [...], next_cursor, has_more}`**（BASE44 游标分页）
    # 本模块原先只按裸 list 写（`for p in rows`），**遇到新形状会遍历字典的键（字符串）**
    # `isinstance(p, dict)` 恒假 → **提案列表恒空**，看着像「这张表没有待审」。
    # 「取值按回包真实形状」——两种都认，别猜是哪一版。
    if isinstance(rows, dict):
        rows = rows.get('items') or []

    mine = []
    for p in rows:
        if not isinstance(p, dict):
            continue
        pl = p.get('payload') if isinstance(p.get('payload'), dict) else {}
        # **按表过滤**：只有载荷里指向这张表的才回
        if str(pl.get('table') or '') != table:
            continue
        mine.append(_proposal_row(p, cur_content, cur_structure))
    return {'proposals': mine, 'table': table,
            'content_version': cur_content, 'structure_version': cur_structure}


def resolve(_service, payload, _context):
    """`files.action_proposal_resolve`：批/驳一条提案，可带 `edited_value` 改进建议值。

    **`edited_value` 的语义**（改要同步改 `test_files_action_proposals.py` P-⑨）：
    带类型值 `{type, value}`。确认时**先把提案里的目标格值换成编辑后的值**再执行 ——
    payload 有 `value` 键就换它；没有但 `cells` 恰好一条就换 `cells[0].value`；
    **多格提案不支持逐格编辑，明确拒绝**（不猜要改哪一格）。裸值也明确拒绝。

    **2026-10-14 起领域模块不再直写内核提案表**（契约 010-⑤）：改值与裁决一并收进内核口
    `resolve_action_proposal(proposal_id, decision, edited_value)`，在权限检查下改。
    原先这里直接 `frappe.get_doc(<内核提案表>, …)` + `doc.payload_json = …`
    + `doc.save(ignore_permissions=True)` 是**领域直写内核表 + 关权限检查**（红线），已撤。
    语义由内核 `_apply_edited_value` 一字不变承接。

    **内核一律走 `public_api`，不引 `shangshu_core.actions`** —— 那是内核私有模块，
    门禁 `PRIVATE_CORE_IMPORT` 会拦。上一版我改对了「不直写内核表」却把 import 写成了
    `shangshu_core.actions`，等于从一种违规换另一种；`public_api` 本来就导出这个函数。
    """
    proposal_id = str(payload.get('proposal_id') or '').strip()
    decision = str(payload.get('decision') or '').strip()
    if not proposal_id:
        frappe.throw('proposal_id 必填', frappe.ValidationError)
    if decision not in ('confirmed', 'rejected'):
        frappe.throw('decision 必须是 confirmed 或 rejected', frappe.ValidationError)

    edited = payload.get('edited_value')
    from shangshu_core.public_api import resolve_action_proposal
    result = resolve_action_proposal(proposal_id, decision, edited)
    return {'proposal': result, 'decision': decision,
            'edited': edited is not None}
