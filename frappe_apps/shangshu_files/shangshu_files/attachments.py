"""**文件 ↔ 文件附件绑定**的纯计算层（一个 `import frappe` 都没有 ⇒ 没有站点也能单测）。

**这一层解决的是契约 §8 第 13 项那个缺口**：
内核**没有**「附件绑定到某件但前端不显示」的口；`platform.object.companion_bind` 是
**受管对象 ↔ 伴随表**的绑定（且限 System Manager），**不是**文件 ↔ 文件的附件绑定。

**为什么放在文件域**（不是内核）：
· 「文件 ↔ 文件」是**文件自己的事**（文件域是保证长期存在的公共件）；
· 放进内核要动所有行业线共用的底座 ⇒ 代价大于收益（契约 §8 写的是「文件域**或**内核，
  后者走 CORE-CANDIDATE」⇒ 本笔选文件域）。

**父件侧零改动**（抄老项目 `example_xml_to_pdf.py:660-673` 的做法）：
老项目把血缘五元组登记在**派生件自己**的 `source_metadata_json` 上，按原件的 sha256
**反查**派生件 ⇒ 原件那一侧**一个字段都不用加**（不用 bench migrate）。
本层沿用同一形状：**关系记在附件侧**，父件只被反查。

**五元组**（抄老项目 `ArtifactDerivation` 字段字典，一个字不差）：
`sources[]`（原件字节摘要）／`output_ref`（派生件字节摘要）／`rule_version`（规则版本）／
`action_ref`（哪个动作产出的）／`order`（第几份派生，顺序进幂等键）。

**顺序为什么进键**：同一份原件转两次会出两份派生件（规则变了）⇒ 顺序不同 ⇒ 键不同
⇒ 两份都留着（老项目同一口径）。
"""
import hashlib
import json

# 附件关系种类（**既有词表**的延伸，不新造一堆词）：
# · `attachment` —— 普通附件（就是这个文件挂在那个文件下面）；
# · `derived`    —— **派生件**（原件转出来的那个，如 xml → pdf 收据）。
RELATION_ATTACHMENT = 'attachment'
RELATION_DERIVED = 'derived'
RELATIONS = (RELATION_ATTACHMENT, RELATION_DERIVED)

# 绑定动作名（登记处在 `domain.py` 的动作表；这里只作同名字面量）。
BIND_ACTION = 'files.attachment.bind'
LIST_ACTION = 'files.attachment.list'


def _fail(message):
    raise ValueError(message)


def check_relation(relation):
    """关系种类校验 —— 认不出就说认不出，不猜。"""
    value = str(relation or RELATION_ATTACHMENT).strip() or RELATION_ATTACHMENT
    if value not in RELATIONS:
        _fail('附件关系种类不认识：%s（合法的只有 %s）' % (value, '、'.join(RELATIONS)))
    return value


def build_derivation(sources, output_ref, rule_version, action_ref, order=1):
    """血缘五元组（**只装事实**，不含任何「要不要」结论）。

    `sources` ＝ 原件字节摘要的列表（通常一件；多件是「合成的」）。
    """
    source_list = [str(item or '').strip() for item in (sources or []) if str(item or '').strip()]
    if not source_list:
        _fail('派生件必须说清它是从哪份字节派生的（sources 至少一条）')
    return {
        'sources': source_list,
        'output_ref': str(output_ref or '').strip(),
        'rule_version': str(rule_version or '').strip(),
        'action_ref': str(action_ref or '').strip(),
        'order': int(order or 1),
    }


def derivation_json(derivation):
    """五元组 → JSON 文本（**键序固定** ⇒ 同一份派生件序列化后逐字节一样 ⇒ 幂等能靠它比）。"""
    return json.dumps(derivation or {}, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'))


def idempotency_key(parent_file, child_file, relation, order=1):
    """绑定幂等键（**按父子两件 + 关系 + 顺序**算）。

    ⚠️ 为什么不是按「父件」算：同一个父件可以挂多件附件（每件一个键）；
    同一对父子**重复绑**（重放）⇒ 同一把键 ⇒ **不重复绑**。
    """
    blob = "%s|%s|%s|%s" % (parent_file, child_file, relation, int(order or 1))
    return "files:attachment:%s" % hashlib.sha256(blob.encode("utf-8")).hexdigest()[:40]


def derivation_idempotency_key(parent_file, rule_version, order=1):
    """**派生件**的幂等键（按父件 + 规则版本 + 顺序算）。

    为什么派生件要单独一把键：同一个原件**用同一个规则**再转一次 ⇒
    出来的字节**一样**（老项目口径：输出不含时间戳 ⇒ 字节级幂等）⇒
    不该产生第二份派生件 ⇒ 键得**只看父件 + 规则 + 顺序**，不看子件。
    """
    blob = "%s|%s|%s" % (parent_file, rule_version, int(order or 1))
    return "files:derived:%s" % hashlib.sha256(blob.encode("utf-8")).hexdigest()[:40]


def matches_derivation(stored_json, wanted):
    """已登记的血缘**是不是**要的那一份（逐字段比，五元组一个不差）。

    ⚠️ 为什么逐字段比而不是「包含就算」：老项目那边用的是 SQL `like` 匹配
    （`'"sources": ["<sha>"'`）⇒ 那条 SQL 会被别的行蹭到。
    本层改成**逐字段精确比** ⇒ 蹭不到。
    """
    try:
        stored = json.loads(stored_json or "{}") or {}
    except (TypeError, ValueError):
        return False
    if not isinstance(stored, dict):
        return False
    wanted = wanted or {}
    return (list(stored.get('sources') or []) == list(wanted.get('sources') or [])
            and str(stored.get('output_ref') or '') == str(wanted.get('output_ref') or '')
            and str(stored.get('rule_version') or '') == str(wanted.get('rule_version') or '')
            and str(stored.get('action_ref') or '') == str(wanted.get('action_ref') or '')
            and int(stored.get('order') or 0) == int(wanted.get('order') or 0))
