"""归属字段迁移：遗留 `owner_subject_*` → 内核 `attribution`。

**这是「两步」里的第一步（字段迁移）**，不是第二步（判定权搬家）。
契约 §3.5.3：「字段迁移 + 判定权搬家捆在一起，坏了不知道是哪一半；分两步，第二步随时可回退。」
所以**本模块只搬值，不改任何读权判定** —— `_dept_allows` / `has_permission` 一个字都不动。
谁顺手在这里改判定语义，谁就把两步捆回去了。

**值搬到哪**（契约 §3.5.1，定死）：

    owner_subject_kind='Employee'   →  ('personal',   None,            owner_subject)
    owner_subject_kind='Department' →  ('department', owner_subject,   None)

**翻译只有一份** —— 调 `shangshu_core.field_access.map_owner_subject`，**不在这里再写一遍**。
契约原话：「各写一份 = 各说各的『Employee 算什么』，而归属决定谁看得到，**分叉就是权限不一致**」。

**绝不落 `enterprise`** —— **理由是用户口径，不是我们推的**：

  · 用户 **2026-10-15** 一句话定了：「**尚书是单例，没有企业归属。**」
    这比「(a)/(c) 选哪条」更根本 —— **不是选哪条，是那个桶压根不该存在**。
    所以 `enterprise` **永不产生，一行都不许有**（不是「尽量别有」）。
  · 用户 **2026-10-13** `账号与权限.md:192` 第 5 条同时管着**不明归属怎么办**：
    「**历史不明归属保持既有权限并待核，不批量填企业归属**」——
    **不迁不动、列出来等人核**，不是「当场拒死」。

**两句话管两件事**：10-15 管「enterprise 这层不存在」，10-13 管「不明的行去哪」。
文件域 enum 也只允许 `Employee`/`Department`（`domain.py:52`），所以 `enterprise` **没有来源** ——
想产生也产生不了，这里是**第二道**。
所以**不明归属的行不迁不动，只列出来等人核** —— 不猜、不兜底、不发明第三种归属。

**翻译 ≠ 授权**（B 的提醒）：`map_owner_subject` 是纯翻译，**不判谁有权调**。
本模块也不判。「谁能改归属」是另一件事（`resource_assign` / `_share_caller_can_grant` 那侧），
**这里留口，不写死角色**。

**批量迁移动作要授权**：`migrate()` 会**写内核归属表**（动真实数据）。
调用方（FDE 工程入口）负责拿授权；`dry_run=True` 是默认推荐的第一步，只读不写。
"""
import frappe

from shangshu_core.public_api import map_owner_subject

FILE = 'Shangshu File Center File'


def _subject_of(doc):
    """取遗留的「所有人」两列。空/缺一律当不明，不当 Employee。"""
    kind = str(doc.get('owner_subject_kind') or '').strip()
    subject = str(doc.get('owner_subject') or '').strip()
    return kind, subject


def classify(doc):
    """把一行分到三类之一，**只读不写**。

    返回 ``(kind, payload)``：
      · ``('migrate', {'level':…, 'department':…, 'owner_user':…})`` —— 能干净迁移
      · ``('skip',    原因)``                                        —— 不明归属，不迁不动、列出来等人核
      · ``('done',    None)``                                        —— 已经有归属了，不重复写

    **为什么分类和迁移分开**：迁移前必须能先把「会动哪些、不动哪些」列给人看。
    一上来就写，出了事说不清当时看见了什么。
    """
    name = doc.get('name')
    # 已经有归属了就不重复写 —— 重复 `attribution_record` 会堆行（G1-⑥～⑨ 钉过「不堆行，有闸」）
    from shangshu_core import org_admin
    if org_admin.resource_attribution(name):
        return 'done', None

    kind, subject = _subject_of(doc)
    if not kind:
        return 'skip', '没填所有人类型（owner_subject_kind 是空的）'
    if not subject:
        return 'skip', '填了所有人类型但没填所有人 ID（owner_subject 是空的）'

    try:
        level, department, owner_user = map_owner_subject(kind, subject)
    except Exception as error:
        # `map_owner_subject` 对未知类型/空 ID **明确拒** —— 拒得对，就该进「等核」那堆，
        # 不是把整批迁移炸掉。别的异常照样冒上去（那才是真出事了）。
        return 'skip', '映射明确拒：%s' % error

    return 'migrate', {'level': level, 'department': department, 'owner_user': owner_user}


def plan(limit=None):
    """**只读**列出这一批会动哪些、不动哪些。迁移前先看这个。

    返回 ``{'migrate': [...], 'skip': [...], 'done': [...]}``，每项是
    ``{'name': 文件名, 'reason'/'attribution': …}``。
    """
    out = {'migrate': [], 'skip': [], 'done': []}
    rows = frappe.get_all(
        FILE, filters={'status': 'Active'},
        fields=['name', 'owner_subject_kind', 'owner_subject'],
        order_by='modified asc', limit=int(limit) if limit else 100000)
    for row in rows:
        doc = row if hasattr(row, 'get') else dict(row)
        kind, where = classify(doc)
        item = {'name': doc.get('name')}
        if kind == 'migrate':
            item['attribution'] = where
        else:
            item['reason'] = where
        out[kind].append(item)
    return out


def migrate(limit=None, dry_run=True):
    """把遗留 `owner_subject_*` 迁成内核 `attribution`。

    **一批文件要么迁要么不迁，不留脏中间态**（「步」和「批」是两回事：
    字段迁移和判定权搬家分两步，但**字段迁移内部不半做**）。

    ``dry_run=True``（默认）**只算不写**。要真写得显式 ``dry_run=False``，
    而且那一步是**动真实数据**，调用方负责拿授权。

    **不迁的行原样留着**，在 ``skipped`` 里带原因列出来等人核 —— 这就是
    「保持既有权限并待核」的动作口径，不是「当场拒死」。
    """
    summary = plan(limit)
    result = {
        'dry_run': bool(dry_run),
        'planned': len(summary['migrate']),
        'skipped': summary['skip'],
        'already': len(summary['done']),
        'written': 0,
    }
    if dry_run:
        return result

    from shangshu_core import org_admin
    # **逐条容错** —— ⚠️ 第一版写成「一批一起提交、半路炸整批回滚」，
    # 实测**第一条就抛 `LinkValidationError`**（`Could not find 归属部门: dept-1`）→
    # 整批中断、一条没迁。
    # **根因**：遗留字段里的 `owner_subject` 值多半是**假 ID**（`emp-1`/`dept-1`/`who`），
    # **对不上内核的 `Shangshu Department`/员工表**（真实 ID 是 `2ba5190aca20` 那种哈希）。
    # **那正是「不明归属」** —— B 的口径「**历史不明归属保持既有权限并待核，
    # 不批量填企业归属**」= **不迁不动、列出来等人核**。
    # 所以**跳过是对的**，不该整批回滚（回滚会让「一条脏数据卡住全部」）。
    #
    # **仍然不落 `enterprise`**；**成功的一起 commit**（不留「写了一半没提交」）。
    for item in summary['migrate']:
        att = item['attribution']
        try:
            org_admin.attribution_record(
                item['name'], att['level'], att.get('department'), att.get('owner_user'))
            result['written'] += 1
        except Exception as error:
            # **ID 对不上内核表 / 其它落库失败 → 归「待核」**，不猜、不兜底、不硬塞。
            result.setdefault('failed', []).append({
                'name': item['name'], 'attribution': att,
                'reason': '%s: %s' % (type(error).__name__, str(error)[:120])})
    frappe.db.commit()
    result['failed_count'] = len(result.get('failed') or [])
    return result
