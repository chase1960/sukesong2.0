#!/usr/bin/env python3
"""邮件域重放守卫 —— 撤权后旧回执不能换出带正文的结果（B5 缺口）。

B 在受管撤回那边发现并堵了一个真安全漏洞，提交信息点名
「公共组合块建议：邮件/订单域的带值动作结果建议同样挂 `replay_guard`」。

**洞在哪**（查实 `shangshu_core/actions.py:137-139`）：

    request, created = action_requests.reserve(key, identity, ...)
    if not created:
        return action_requests.replay(request)      # ← 解密旧结果原样返回

`action_requests.replay()` 把**首次执行的完整结果**解密吐回，中间**不复核资源级权限**。
角色是复核过的（`_assert_action_role` 每次都跑），跨人重放也被挡
（`assert_binding` 比对 `actor_identity`）。所以洞是：

    **同一个人，在对这封信的权限被撤之后，拿同一幂等键重放，照样把正文换出来。**

邮件域的 `mail.save_draft` / `mail.recycle` / `mail.restore` 回的都是
`projection(doc, True)` —— **带正文、附件、内联图**。撤权只拦新执行，拦不住重放。

**怎么看**（跟 B 那条同构的具体案例）：

    改之前：A 存草稿拿到带正文的回包；把这封草稿改归别人（A 的读权没了）之后，
            A 用同一幂等键重发同一请求 —— **回 200，正文原样回来**。
    改之后：同样操作 —— **回权限错，整请求拒，回包里没有正文**。

测试通过 = 下面全部成立：

  A. `mail.save_draft` 首次执行回包**带正文**（这是正常能力，不是问题）
  B. 草稿改归别人之后，同一幂等键重放 **`mail.save_draft`** → 权限错，回包无正文
  C. 同样对 **`mail.recycle`** 成立（它回的也是带正文的投影）
  D. 没被撤权的人，同一幂等键重放**照常**拿到结果（守卫不误伤正常重试）
  E. 跨人重放仍然被挡（原有 `assert_binding` 不被削弱）

反例（= 没做）：撤权后重放回 200 且带正文。

跑法：
  docker exec -i shangshu-local-c-frappe-1 sh -lc \\
    'cd /home/frappe/frappe-bench && ./env/bin/python -' < scripts/test-mail-replay-guard.py
"""
import sys
import traceback
from pathlib import Path

for _app in ('shangshu_mail', 'shangshu_core'):
    for _root in (Path.cwd(), Path('/home/frappe/frappe-bench/apps')):
        _p = _root / _app
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe  # noqa: E402

SITES_PATH = '/home/frappe/frappe-bench/sites'
if not Path(SITES_PATH).exists():
    SITES_PATH = str(Path(__file__).resolve().parents[2] / 'sites')
frappe.init(site='shangshu.localhost', sites_path=SITES_PATH)
frappe.connect()

from shangshu_core.public_api import execute_registered_action  # noqa: E402
from shangshu_mail.domain import DOCTYPE  # noqa: E402

USER = 'Administrator'
OTHER = 'guest'          # 用来「把信改归别人」，模拟读权被撤
ADDRESS = 'replay-guard@speed.invalid'
BODY_SECRET = '这是撤权后不该再被换出来的正文 SEKRIT-7f3a'

PASS = []


def check(label, ok, detail=''):
    PASS.append((label, ok, detail))
    print(f"  {'✓' if ok else '✗'} {label}" + (f" —— {detail}" if detail else ''))
    return ok


def run(action, payload, key, as_user=None):
    """走真实公共入口。回 (结果 or None, 错误信息 or None)。

    `as_user` 不传时用**当前**登录人 —— 第一版这里写死 `set_user(USER)`，
    结果跨人那组压根没切成别人，E1/E2 误红（是测试的 bug，不是产品的）。"""
    if as_user:
        frappe.set_user(as_user)
    try:
        out = execute_registered_action(action, payload, True, key)
        return (out or {}).get('result') or out, None
    except Exception as err:
        return None, f'{type(err).__name__}: {err}'


def has_body(result):
    """结果里到底有没有那截正文 —— 只看结果本身，不看错误文案。"""
    if not isinstance(result, dict):
        return False
    blob = str(result.get('body') or '')
    return 'SEKRIT-7f3a' in blob


def setup():
    # 传输/连接闸门：这条测试不发信、不连网
    from shangshu_mail import account as account_mod, transport
    account_mod._test = lambda *a, **k: None
    transport.send_message = lambda *a, **k: (_ for _ in ()).throw(
        RuntimeError('本测试不发信'))

    from shangshu_mail import account as acc
    frappe.set_user(USER)
    execute_registered_action('mail.account.configure', {
        'email': ADDRESS, 'provider': 'netease-enterprise', 'display_name': '重放守卫',
        'password': 'synthetic-auth-code-not-real', 'enabled': True,
    }, True, frappe.generate_hash(length=24))
    frappe.set_user(USER)


def new_draft(key, subject):
    res, err = run('mail.save_draft', {
        'to': [ADDRESS], 'cc': [], 'subject': subject,
        'body': BODY_SECRET, 'body_format': 'Text',
    }, key)
    if err:
        raise AssertionError(f'建草稿没成功：{err}')
    name = res.get('name')
    assert name, f'回执里没有草稿编号：{res}'
    return name, res


def revoke(name):
    """把这封信改归别人 —— 模拟「读权被撤」。这是管理员改归属，不是删信。"""
    frappe.db.set_value(DOCTYPE, name, 'owner', OTHER, update_modified=False)
    frappe.db.commit()
    doc = frappe.get_doc(DOCTYPE, name)
    assert doc.owner == OTHER, f'归属没改成别人，还是 {doc.owner}'


def main():
    print('== 邮件域重放守卫（B5 缺口）==')
    print('判据：撤权后用同一幂等键重放 → 权限错整请求拒，回包无正文。')
    setup()

    # ---------- A. 首次执行回包带正文（正常能力）----------
    print('-- A. 首次执行回包带正文')
    k1 = frappe.generate_hash(length=24)
    name1, res1 = new_draft(k1, '重放守卫-保存')
    check('A1 首次 save_draft 回包含正文', has_body(res1),
          f'草稿 {name1}')

    # ---------- B. 撤权后重放 save_draft ----------
    print('-- B. 撤权后重放 mail.save_draft')
    revoke(name1)
    res, err = run('mail.save_draft', {
        'to': [ADDRESS], 'cc': [], 'subject': '重放守卫-保存',
        'body': BODY_SECRET, 'body_format': 'Text',
    }, k1)
    rejected = err is not None
    no_body = not has_body(res)
    check('B1 撤权后重放被拒（不是回 200）', rejected,
          err or f'回了结果：{str(res)[:80]}')
    check('B2 回包里没有正文', no_body,
          '' if no_body else f'正文被换出来了：{str(res)[:120]}')
    check('B3 报的是权限类错误', bool(err and ('无权' in err or '自己的邮件' in err
                                              or 'PermissionError' in err)),
          err or '(没报错)')

    # ---------- C. 撤权后重放 mail.recycle ----------
    print('-- C. 撤权后重放 mail.recycle')
    k2 = frappe.generate_hash(length=24)
    name2, res2 = new_draft(k2, '重放守卫-回收')
    check('C0 recycle 前回包也带正文', has_body(res2), f'草稿 {name2}')
    revoke(name2)
    res, err = run('mail.recycle', {
        'mail': name2, 'expected_version': res2.get('record_version'),
    }, frappe.generate_hash(length=24))
    # 先用**新键**真回收一次是不可能的（已不归我们）；这里要的是
    # 「同一幂等键重放」——所以先用 k2 存过，再用 k2 重放 recycle 是不对的
    # （键必须与动作指纹一致）。改成：存草稿用 k2，回收用 k3，撤权后重放 k3。
    k3 = frappe.generate_hash(length=24)
    k4 = frappe.generate_hash(length=24)
    name3, res3 = new_draft(k3, '重放守卫-回收2')
    # 用 k4 真回收一次（此时还归我们），拿到带正文的回包
    frappe.db.set_value(DOCTYPE, name3, 'owner', USER, update_modified=False)
    frappe.db.commit()
    res, err = run('mail.recycle', {
        'mail': name3, 'expected_version': res3.get('record_version'),
    }, k4)
    check('C1 首次 recycle 回包含正文', has_body(res), err or '')
    revoke(name3)
    res, err = run('mail.recycle', {
        'mail': name3, 'expected_version': res3.get('record_version'),
    }, k4)
    check('C2 撤权后重放 recycle 被拒', err is not None,
          err or f'回了结果：{str(res)[:80]}')
    check('C3 重放 recycle 回包无正文', not has_body(res),
          '' if not has_body(res) else f'正文被换出来了：{str(res)[:120]}')

    # ---------- D. 没撤权的人重放照常（不误伤正常重试）----------
    print('-- D. 未撤权时重放照常')
    k5 = frappe.generate_hash(length=24)
    name5, res5 = new_draft(k5, '重放守卫-正常重试')
    res, err = run('mail.save_draft', {
        'to': [ADDRESS], 'cc': [], 'subject': '重放守卫-正常重试',
        'body': BODY_SECRET, 'body_format': 'Text',
    }, k5)
    check('D1 未撤权重放仍拿到结果', err is None and res is not None,
          err or f'草稿 {name5}')
    check('D2 是幂等重放（同一封，没另建）', (res or {}).get('name') == name5,
          f"回执 name={(res or {}).get('name')} vs 首次 {name5}")
    check('D3 未撤权重放仍带正文（正常能力）', has_body(res), '')

    # ---------- E. 跨人重放仍被挡（原约束不被削弱）----------
    print('-- E. 跨人重放仍被挡')
    k6 = frappe.generate_hash(length=24)
    name6, res6 = new_draft(k6, '重放守卫-跨人')
    res, err = run('mail.save_draft', {
        'to': [ADDRESS], 'cc': [], 'subject': '重放守卫-跨人',
        'body': BODY_SECRET, 'body_format': 'Text',
    }, k6, as_user=OTHER)
    check('E1 跨人重放被挡', err is not None,
          err or f'回了结果：{str(res)[:80]}')
    check('E2 跨人重放回包无正文', not has_body(res), '')
    frappe.set_user(USER)

    print()
    ok = sum(1 for _, passed, _ in PASS if passed)
    print(f'== {ok}/{len(PASS)} 通过 ==')
    for label, passed, detail in PASS:
        if not passed:
            print(f'  ✗ {label} {detail}')
    if ok != len(PASS):
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        frappe.db.rollback()
        sys.exit(1)
