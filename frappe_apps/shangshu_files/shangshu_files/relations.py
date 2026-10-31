"""通用关系：文件 ↔ 业务记录的**关联键**，不带任何领域词。

**这里不出现「邮件」两个字**（T02 / PKG-013-T02 的要求：不把领域概念种进文件域）。
关联只存 `object_id`（对象 id）+ `name`（记录 id）两个键；正式业务值仍经
`files.review` 的 `values` 走公共对象动作写入，不在文件域留第二份。

**为什么单独一个模块**：`review.py` 管「整份文件审核」那件事（读+写关联）；
本模块管**关系本身的存在形式**与**历史遗留迁移**。两者分开，将来摘掉遗留桥接时
只删本模块的 `migrate_legacy`，不影响审核。
"""
import json

import frappe

FILE = 'Shangshu File Center File'


def links(doc):
    """读关系键列表。空/坏 JSON 一律当空列表，不抛 —— 读侧不该因为历史脏数据整份失败。"""
    raw = doc.get('relations_json') if hasattr(doc, 'get') else (doc.relations_json or '[]')
    try:
        values = json.loads(raw or '[]')
    except (ValueError, TypeError):
        return []
    return values if isinstance(values, list) else []


def has_link(relations, object_id, name):
    """这条关联键在不在（按 object_id + name 两个键比，不比其它）。"""
    return any(r.get('object_id') == object_id and r.get('name') == name for r in relations)


def migrate_legacy(object_id, dry_run=False):
    """把遗留的 `related_mail` 值迁进通用 `relations`。

    **`object_id` 由调用方传入** —— 本模块不硬编码任何领域对象 id。
    遗留字段叫什么、属于哪个业务对象，只有**迁移发起方**知道；文件域只负责
    「把这些值按你给的 object_id 收进通用关联」。将来摘掉遗留字段时，
    调用方与本函数一起删，文件域不留领域残余。

    测试通过 = MIG-①～⑥（`test_d_relations_migrate.py`）：
      ① 迁移前旧关系真的在（反向，防空集通过）
      ② 一条不丢：条数 + 键（object_id/name）逐条对得上
      ③ 不扩大访问：原本看不见的人照旧看不见
      ④ 幂等：重复迁移不双写
      ⑤ 公共口读得到
      ⑥ 反例（故意翻期望必红）

    **边界**：
      · **不改** `related_mail` 原值 —— 可回滚、可核对；那一列的删除留到 2.0.0 一起切
      · **不碰** `owner_subject_*` —— 归属映射待公共侧定，不在本次范围
      · **不动** 权限判定源 —— 关联只是键，不授予被引记录的访问权
      · `update_modified=False` —— 迁移**不是**一次用户修改，不许改表的「更新时间」
        （T09 口径：「文件回填不是另一次用户修改」）
    """
    if not object_id:
        frappe.throw('migrate_legacy 需要 object_id（由调用方给出领域对象 id）', frappe.ValidationError)

    rows = frappe.get_all(FILE, filters=[['related_mail', 'is', 'set']],
                          fields=['name', 'related_mail', 'relations_json'])
    migrated = unchanged = 0
    details = []
    for row in rows:
        value = str(row.related_mail or '').strip()
        if not value:
            unchanged += 1
            continue
        relations = links({'relations_json': row.relations_json})
        key = {'object_id': object_id, 'name': value}
        if has_link(relations, object_id, value):
            unchanged += 1          # 已迁过 —— 幂等，不双写
            continue
        if dry_run:
            migrated += 1
            details.append({'name': row.name, 'add': key})
            continue
        relations = list(relations) + [key]
        frappe.db.set_value(FILE, row.name, 'relations_json',
                            json.dumps(relations, ensure_ascii=False),
                            update_modified=False)
        migrated += 1
        details.append({'name': row.name, 'add': key})

    return {'object_id': object_id, 'checked': len(rows), 'migrated': migrated,
            'unchanged': unchanged, 'dry_run': bool(dry_run), 'details': details}
