"""R967-B01 第 1 条：**所有**写已绑定值的入口都过正式字段规则（不能只补一个入口）。

**测试通过 = 下面每条成立**：

1. **前置·造出绑定列**：一张有字段列（`min` 规则）的混合表。
2. **单格写**喂非法值 → **明确拒**（对照，本来就有）。
3. **批量写**（`sheet_cells_write`）喂非法值 → **明确拒**（对照，本来就有）。
4. ★ **粘贴包**（`sheet_paste_apply`）喂非法值 → **明确拒**（**E 点名的 paste 入口**）。
5. ★ **撤回**（`sheet_cells_undo`）在**规则收紧后**写回旧值 → **明确拒**（说清「旧值现在不符合规则」）。
6. **敏感度**：合法值写得进、非法值进不去（不恒真/恒假）。

---
**为什么有这条**（B01 第 1 条原文）：
> 盘点 `sheet_input_write`、`paste`、`sheet_cells_write`、撤回、Assistant、代码调用，
> **所有已绑定值必须经过正式字段规则 / 权限检查，不能只补一个入口**。

**盘点结果**（D 2026-10-17 核代码）：
| 入口 | 字段规则 | 状态 |
|---|---|---|
| `write_cell`（单格）| ✅ `require_field_rules_ok`（`sheet.py:1677`）| |
| `write_cells`（批量）| ✅ `require_fields_ok_for_targets`（`sheet.py:1749`）| |
| `formal_write`（正式值）| ✅ `_check_rules`（`promotion.py:523`）| |
| **`paste_apply`** | ✅ `require_batch_no_field_targets` + `require_fields_ok_for_targets`（先验后写）| |
| **`undo_cells`（撤回）** | ✅ 快慢两条路都过 `require_fields_ok_for_targets`（2026-10-17 修）| |
| `header_rename` | 不写值 + `_check_renameable` 保身份 | ✅（B01-4 达成）|
| `sheet_input_write` | **两源零命中**（`frappe_apps/shangshu_files/` + `shangshu-server/`）| **入口不存在** —— E 点名的这个名字**没搜到**，按规矩只说「这两源没搜到」 |

**⚠️ `undo_cells` 的 `restore=True` 跳过的是「列类型检查」，不是「字段规则」**（`_apply_value` 的注释：
「撤回是把格子里原来就有的值放回去，本来合法，不许被列的多数类型拒掉」）——
**两回事**。列类型是「这列多数是什么类型」，字段规则是「这个字段值域」（`min`/`max`）。
**规则收紧后**（`min` 从 0 改成 100），撤回会写出**现在非法**的值。

**⚠️ 撤回该不该拒**：B01-1 字面「所有已绑定值必须经过字段规则检查」——**该过**。
**但拒因要说清**「旧值现在不符合规则（规则已收紧），撤不回」——
**比静默写出非法值好**。**不要**假装「撤回不该过规则」。

**⚠️ 不重复验**：`test_d_promotion_chain.py` emp 组 **⑦ 条**已覆盖**单格/批量**的字段规则（含 009 边界），本文件**只补 paste / undo 两个入口**（那两条 emp 没覆盖）。公共件 `_rejected` 在 `_ss_seed`（§13 只留一份）。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_b01_field_rule_all_entries.py
"""
import importlib.util
import json
import os
import sys
import uuid

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)

checks, fails = [], []


def check(label, valid, detail=''):
    checks.append(label)
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:190]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


def _err(body):
    return _ss_seed._err(body)


print('== R967-B01-1：所有写已绑定值的入口都过字段规则 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

# 造一张有字段列（min 规则）的混合表 —— 夹具 `MIXED_COLUMNS` 里「金额」有 `min: 0`
handle = _ss_seed.seed_mixed_table(c, run=t.RUN, promote_with=c)
TABLE, RID = (handle or {}).get('table'), ((handle or {}).get('row_ids') or [None])[0]
print('  夹具表 %s（金额列 min:0）' % TABLE)


def _cv_sv():
    rr = result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    return rr.get('content_version'), rr.get('structure_version')


def _bad_value():
    """非法值：金额列有 `min: 0`，喂负数。"""
    return {'type': 'number', 'value': -7}


def _good_value():
    return {'type': 'number', 'value': 42.5}


# **公共件只此一份**（§13）—— `_rejected` 在 `_ss_seed`，这里转发不另写。
_rejected = _ss_seed.rejected


try:
    # ---------- 1 前置 ----------
    check('1 前置·造出绑定列（金额列有 `min:0`）', bool(TABLE) and bool(RID),
          'table=%r rid=%r' % (TABLE, RID))

    # ---------- 2 单格写（对照，本来就有）----------
    cv, sv = _cv_sv()
    st2, b2 = t.action(c, 'files.cell_write', {
        'table': TABLE, 'row_id': RID, 'header': '金额',
        'value': _bad_value(),
        'expected_content_version': cv, 'expected_structure_version': sv}, 'b01-cell')
    rej2, msg2 = _rejected(st2, b2)
    check('2 对照·**单格写**喂非法值 → 明确拒（本来就有）', rej2, 'HTTP %s %s' % (st2, msg2))

    # ---------- 3 批量写（对照，本来就有）----------
    cv, sv = _cv_sv()
    st3, b3 = t.action(c, 'files.sheet_cells_write', {
        'table': TABLE, 'cells': [{'row_id': RID, 'header': '金额', 'value': _bad_value()}],
        'expected_content_version': cv, 'expected_structure_version': sv}, 'b01-batch')
    rej3, msg3 = _rejected(st3, b3)
    check('3 对照·**批量写**喂非法值 → 明确拒（本来就有）', rej3, 'HTTP %s %s' % (st3, msg3))

    # ---------- 4 ★ 粘贴包（E 点名的 paste 入口）----------
    cv, sv = _cv_sv()
    # ⚠️ **按 `domain.py` 的 schema 传参**（第 17 次判据自己会撒谎）：
    # 键是 `matrix`/`start_row`/`start_col`，**且 `op_id` 必填**。
    # 第一版传 `data`/`target_row`/`target_col` → schema 拒「缺 op_id」→
    # **红因跟产品无关**（错因通过）。
    st4, b4 = t.action(c, 'files.sheet_paste_apply', {
        'table': TABLE, 'matrix': [[_bad_value()['value']]], 'matrix_types': [['number']],
        'start_row': 0, 'start_col': 1, 'op_id': 'b01-paste-%s' % t.RUN,
        'expected_content_version': cv, 'expected_structure_version': sv}, 'b01-paste')
    rej4, msg4 = _rejected(st4, b4)
    # ⚠️ **要区分「字段规则拒」和「schema 拒」** —— 后者是判据传参错，不是产品。
    # 字段规则的拒因会点名「不能小于 / 须为 / 无效」这类值域话术。
    rule_rej4 = any(w in msg4 for w in ('不能小于', '不能大于', '须为', '无效', '不支持', '规则'))
    check('4 ★ **粘贴包**喂非法值 → **字段规则**明确拒（不是 schema 拒）',
          rej4 and rule_rej4, 'HTTP %s %s' % (st4, msg4))

    # ---------- 5 ★ 撤回（规则收紧后写回旧值）----------
    # 先写一个**合法**值（会进台账），再**收紧规则**（重定晋升定义 min:100），
    # 然后撤回那个旧值（42.5 < 100）→ 该拒。
    cv, sv = _cv_sv()
    st_ok, b_ok = t.action(c, 'files.cell_write', {
        'table': TABLE, 'row_id': RID, 'header': '金额', 'value': _good_value(),
        'expected_content_version': cv, 'expected_structure_version': sv,
        # 主控 2026-10-18 定位：cell_write 只接 payload.op_id，不接 run 标签；缺它则台账
        # 记录的 op_id 是空串，undo 用空串查命中其它不相关写。
        'op_id': 'b01-undo-target'}, 'b01-seed-ok')
    op_id = (result_of(st_ok, b_ok) or {}).get('op_id') or 'b01-undo-target'
    # 收紧规则：min 从 0 → 100
    st_pd, b_pd = t.service(c, 'files.promotion_definition', {'table': TABLE})
    cur = result_of(st_pd, b_pd)
    cols = json.loads(json.dumps(_ss_seed.MIXED_COLUMNS))
    for col in cols:
        if col.get('header') == '金额':
            col['rules'] = {'min': 100}
    st_p, b_p = t.action(c, 'files.promotion_define', {
        'table': TABLE,
        'expected_structure_version': int(cur.get('structure_version') or 1),
        'definition': {'definition_version': 1, 'columns': cols}}, 'b01-tighten')
    cv2, sv2 = _cv_sv()
    # ⚠️ **`sheet_cells_undo` 的 schema 只要 `table`/`sheet`/`op_id`** ——
    # **不带版本闩**（`domain.py:147-149`）。第一版传了
    # `expected_content_version` → schema 拒「未声明字段」→ **红因跟产品无关**。
    st5, b5 = t.action(c, 'files.sheet_cells_undo', {
        'table': TABLE, 'op_id': op_id}, 'b01-undo')
    rej5, msg5 = _rejected(st5, b5)
    rule_rej5 = any(w in msg5 for w in ('不能小于', '不能大于', '须为', '无效', '规则', '不符合'))
    check('5 ★ **撤回**在规则收紧后写回旧值 → **字段规则**明确拒（说清「旧值现在不符合规则」）',
          rej5 and rule_rej5, 'HTTP %s %s（op_id=%r）' % (st5, msg5, op_id))

    # ---------- 6 敏感度 ----------
    cv, sv = _cv_sv()
    st6, b6 = t.action(c, 'files.cell_write', {
        'table': TABLE, 'row_id': RID, 'header': '金额',
        'value': {'type': 'number', 'value': 150},
        'expected_content_version': cv, 'expected_structure_version': sv}, 'b01-good')
    rej6, _ = _rejected(st6, b6)
    check('6 敏感度：合法值写得进、非法值进不去（不恒真/恒假）',
          (not rej6) and rej2, '合法值被拒=%r 非法值被拒=%r' % (rej6, rej2))
    # ---------- 7 ★ 清空已绑定列：空值是合法形状（无 required 就放行） ----------
    # A 2026-10-17 实测：前端清空已绑定列时发 `type:'empty'`，被
    # `_check_rules` 当类型错拒（「必须是文字（你打了 None）」）。
    # 测试通过 = 清空成功（200）且读回是 empty；有 `required` 才该拒。
    cv, sv = _cv_sv()
    st7, b7 = t.action(c, 'files.cell_write', {
        'table': TABLE, 'row_id': RID, 'header': '金额',
        'value': {'type': 'empty', 'value': None},
        'expected_content_version': cv, 'expected_structure_version': sv}, 'b01-clear')
    rej7, msg7 = _rejected(st7, b7)
    rr7 = result_of(*t.service(c, 'files.sheet_read', {'table': TABLE, 'row_ids': [RID]}))
    got7 = (((rr7.get('rows') or [{}])[0].get('values') or {}).get('金额')) or {}
    check('7 ★ **清空已绑定列** → 200 且读回为空（空值是合法形状）',
          (not rej7) and got7.get('type') == 'empty',
          'HTTP %s %s 读回=%r' % (st7, msg7, got7))
finally:
    receipt = _ss_seed.seed_cleanup(c, handle)

print()
if not checks:
    print('结果： FAIL 零条检查被断言')
    sys.exit(1)
# ⚠️ **结果行要说准**（判据自己会撒谎第 23 次）——
# 第一版写「粘贴包/撤回都过字段规则」，但 **⑤ 撤回是登记（没验）**，说「都过」是**假的**。
_verbs = []
if not fails:
    _verbs.append('粘贴包过检查（009 边界拦）')
    _verbs.append('撤回在规则收紧后明确拒（快慢两条路都已过字段规则）')
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  'PASS R967-B01-1（%d 条）—— %s' % (len(checks), '；'.join(_verbs))))
print('⚠️ 本组只验**字段规则/009 边界**。**权限检查**（谁能写）是另一条线（行 E）。')
sys.exit(1 if fails else 0)
