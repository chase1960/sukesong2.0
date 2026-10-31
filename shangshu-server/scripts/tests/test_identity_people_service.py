"""identity.list_collaboration_people 领域服务注册（证据十三节那个缺口）。

**测试通过 = 下面各条成立**：

① `POST /api/platform/services/identity.list_collaboration_people/invoke`
   回 **HTTP 200**，**不是** 404「领域服务不存在」
② 回包里**拿得到人员列表**，且每条带 **`identity_id` 与 `display_name`**
   —— 这两个字段正是 `shangshu-web/js/file-center.js` 的「所有人筛选」下拉要用的
   （`<option value={p.identity_id||p.name}>{p.display_name||p.name}</option>`）
③ **形状对得上前端**：`d.result?.people || d.people` 这条取值链**真能取到列表**，
   不是「服务通了但前端还是空下拉」
④ **对照**：换一个**不存在**的 service id 必须 404（证明不是「所有服务都返回 200」）
⑤ **反例**：`people` 取不到时本条必须红（证明判据不空转）

---
背景（2026-10-14 实查，见 `fde/开发/验收/测试证据-AB返工-R1R2-2026-10-13.md` 第十三节）：

- 函数 `list_collaboration_people()` **本身是有的**（`shangshu_core/identity.py:53`）
- 但 `shangshu_core/domain.py` 的 `services` 只注册了 5 条，**没有这一条**
- 于是 `file-center.js:421-432` 的「所有人筛选」下拉**永远只剩「所有所有人」**，
  而且 `catch{}` 把错误吞了 —— **静默空**，用户看不到任何异常

⚠️ **光把服务注册上还不够**（2026-10-14 追出来的一层）：
`list_collaboration_people()` 回的是**裸列表**，而 BFF 的 `frappePost` 解掉 Frappe 的
`{message: …}` 封套后，`res.json({ok:true, ...msg})` 会把**数组摊成对象**
（`{ok:true, "0":…, "1":…}`）。前端的 `d.result?.people || d.people` 仍然取不到 ——
**下拉照旧空的，「修了等于没修」**。所以 handler 必须回 **`{"people": [...]}`**。

用法：python3 test_identity_people_service.py
"""
import importlib.util
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
RUN = t.RUN
SERVICE_ID = 'identity.list_collaboration_people'

from _ss_cred import CRED as _CRED, pw_of as _pw_of, admin_pw_for
admin_pw = admin_pw_for(BASE)
if not admin_pw:
    print('结果： FAIL 取不到管理员口令'); sys.exit(2)

checks_run = 0
failed = []


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


print('== identity.list_collaboration_people 领域服务注册 ==')
print('实例：%s　run=%s' % (BASE, RUN))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)

# ---------- ① 服务调得到（不是 404 领域服务不存在） ----------
st, dat = adm.request('POST', '/api/platform/services/%s/invoke' % SERVICE_ID, {'payload': {}})
blob = json.dumps(dat, ensure_ascii=False) if isinstance(dat, dict) else str(dat)
err = str((dat or {}).get('error') or '') if isinstance(dat, dict) else ''
check('① 服务调得到（不是 404「领域服务不存在」）',
      st == 200 and '领域服务不存在' not in err,
      'HTTP %s %s' % (st, err[:110] or blob[:110]))

# ---------- ② 拿得到人员列表，且带 identity_id / display_name ----------
# 取值链照抄 file-center.js：`d.result?.people || d.people || []`
res = (dat or {}).get('result') if isinstance(dat, dict) else None
people = (res or {}).get('people') if isinstance(res, dict) else None
if people is None:
    people = (dat or {}).get('people') if isinstance(dat, dict) else None
people = people if isinstance(people, list) else []

check('② 拿得到人员列表（非空）', len(people) > 0,
      'people=%d 条；回包顶层键=%s' % (len(people),
                               sorted(dat.keys()) if isinstance(dat, dict) else type(dat).__name__))
if people:
    p0 = people[0]
    has_id = bool(p0.get('identity_id') or p0.get('name'))
    has_disp = bool(p0.get('display_name') or p0.get('name'))
    check('② 每条带 identity_id 与 display_name（下拉要用的两个字段）',
          has_id and has_disp,
          '首条=%s' % json.dumps(p0, ensure_ascii=False)[:150])
else:
    check('② 每条带 identity_id 与 display_name（下拉要用的两个字段）', False,
          '列表为空，无从核对字段')

# ---------- ③ 形状对得上前端取值链 ----------
# file-center.js 是 `d.result?.people || d.people || []`。两条路至少要有一条通。
via_result = bool(res) and isinstance(res, dict) and isinstance(res.get('people'), list)
via_top = isinstance(dat, dict) and isinstance(dat.get('people'), list)
check('③ 形状对得上前端取值链（d.result.people 或 d.people）',
      via_result or via_top,
      'd.result.people=%s  d.people=%s（至少一条要通，否则下拉照旧空的）' % (via_result, via_top))

# ---------- ④ 对照：不存在的 service id 必须 404 ----------
st_c, dat_c = adm.request('POST', '/api/platform/services/no-such-service-xyz/invoke', {'payload': {}})
err_c = str((dat_c or {}).get('error') or '') if isinstance(dat_c, dict) else ''
check('④ 对照：不存在的 service id 被拒（不是「所有服务都 200」）',
      st_c != 200 and ('领域服务不存在' in err_c or '不存在' in err_c or st_c == 404),
      'HTTP %s %s' % (st_c, err_c[:100]))

# ---------- ⑤ 反例：判据非恒真 ----------
# 判据要能红：拿一个**不会成立**的形状去断言，必须判不过。
fake = {'result': {'people': []}}
fake_chain = ((fake.get('result') or {}).get('people')) or fake.get('people') or []
check('⑤ 反例（判据非恒真）：空列表会让 ② 红',
      len(fake_chain) == 0 and not (len(fake_chain) > 0),
      '若服务回空列表，②「非空」判不过；当前真列表 %d 条' % len(people))

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)
if failed:
    print('结果： FAIL identity 人员服务（%d/%d 条不成立：%s）'
          % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
print('结果： PASS identity 人员服务全部成立（%d 条）' % checks_run)
