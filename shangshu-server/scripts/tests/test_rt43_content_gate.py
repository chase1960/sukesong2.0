"""RT-4-3-K 内容就绪闸 · **集成**判据（真表 + 待恢复状态）。

**测试通过 = 下面每条成立**：

0. **闸真挂上了** —— `content_gate_registered()` 回 `(True, …)`。
   闸没挂上时 ① 也会红，但红因是「根本没装」而不是「装了没拦」——**两种红要分得开**，
   否则修的方向都不一样。先钉「闸在不在」，再钉「闸拦不拦」。
1. **待恢复**期间，拿**当前那份**的 ref 打裸 `file-content` URL → **当场拒**。
   这是**反例**：内容闸没生效时这里会拿到旧字节（正是 RT-④③ ⑧ 坐实过的缺口）。
2. **对照**：没待恢复时，同一口**照常给字节** —— 证明卡的是「内容没就绪」，
   不是「这口永远不通」。
3. **正门**（`files.versions`）在待恢复期间**仍被文件域那道拦** ——
   **两道闸都留**（D 钉的）：B 的内核闸是兜底，**不许落地后删文件域那道**。
4. **敏感度**：「有没有待恢复」给**两种不同答案**（不恒真/恒假）。
5. **旧版本不误伤**：待恢复期间，**历史版本那份**仍下得到 —— 闸只挡「最新那份」。
   口径已拍（E 2026-10-15）：待恢复是「**最新不一致**」，不是「不给旧的」。

---
**为什么是集成判据，跟 B 的 CG-01～07 不重**（`test_field_access.py:835` 的分工原话）：
B 那组测**机制**（注册 + 派发 + 隔离），纯模块不测 HTTP；本组要**真表 + 真待恢复状态**
（`files.formal_value_write` + `file-write` 断点），跑的是 HTTP 全链。

**怎么造「待恢复」**：装 `file-write` 断点（`_ss_fault.arm`）→ 写正式值 →
数据库那半成了、回填那半在 `_save_version` 的 `_fault('file-write')` 处断掉 →
不新建版本、`writeback_pending` 落下来。**断点在造新版之前**（`sheet.py` `_save_version`），
所以待恢复期间「版本计数没往前走」是独立于闸的观测点。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_rt43_content_gate.py

口令走 `_ss_cred`（§13 公共件只留一份，本文件**不自己解析**账号文件）。
"""
import base64
import importlib.util
import json
import os
import sys

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_fault = _load('_ss_fault', '/shangshu-server/scripts/tests/_ss_fault.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
# 口令**只从 `_ss_cred` 来**（它读 0600 的 env 文件）；显式给了 SS_D_PW 就用它。
# **不写进代码、不打印**（读进变量就用，用完就丢）。
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)

checks, fails, not_yet = [], [], []


def check(label, valid, detail=''):
    """`check(判据, 成没成, 详情)` —— 跟 `test_d_promotion_chain` 同一个形状（§13 只留一份）。"""
    checks.append(label)
    if valid is None:
        not_yet.append(label)
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:180]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:180]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


# 取值/解析的**公共件只此一份**（§13）—— 在 `_ss_seed`，这里只转发，不另写一份。
_err = _ss_seed._err
_dl_err = _ss_seed._dl_err
_got_bytes = _ss_seed._got_bytes


def _gate_probe(compose):
    """问一句「注册这条链路走通、闸真挂上了」。回 ``(挂上没有, 说明)``。

    ⚠️ `_CONTENT_GATES` 是**进程内存字典**，**只有走 app init 那条路才会填**。
    第一版只 `import shangshu_files.promotion` 就查 —— 查到的是个**没初始化的新进程**，
    `gates.get(...)` 恒 None，于是「闸没挂上」的红其实是**探针自己没触发注册**。
    这里补 `import shangshu_files.hooks`（app init 就是干这个）。

    ⚠️ **这条证明的是「注册链路成立」，不等于「web 进程里也挂着」** ——
    后者由 ①/⑤ 的**行为**作证（裸 URL 被拒 / 旧版放行）。两件事分开说，不混。

    ⚠️ 必须 `cd sites/` —— `frappe.init` 靠 cwd 找站点，从 bench 根跑会
    `IncorrectSitePath: shangshu.localhost does not exist`（实测栽过）。
    """
    script = (
        "cd /home/frappe/frappe-bench/sites && ../env/bin/python -c \""
        "import frappe; frappe.init(site='shangshu.localhost'); frappe.connect(); "
        "import shangshu_files.hooks; "
        "import shangshu_files.promotion as p; "
        "print('GATE_PROBE', p.content_gate_registered())\""
    )
    r = _ss_fault._exec(compose, script)
    out = (r.stdout or '') + (r.stderr or '')
    for line in out.splitlines():
        if line.startswith('GATE_PROBE'):
            body = line[len('GATE_PROBE'):].strip()
            ok = body.startswith('(True')
            return ok, body
    return False, '探不到：rc=%s %s' % (r.returncode, out[-200:])


print('== RT-4-3-K 内容就绪闸 · 集成（真表 + 待恢复状态）==')

if not PW:
    print('\n结果： FAIL 缺 SS_D_PW（口令见 Agent-D-测试账号.md，取进环境变量，不写进代码）')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

compose = _ss_fault.compose_of(BASE)

# ---------- 造一张干净的混合表（公共夹具，§13 不另造）----------
handle = _ss_seed.seed_mixed_table(c, run=t.RUN, promote_with=c)
TABLE = (handle or {}).get('table')
RID = ((handle or {}).get('row_ids') or [None])[0]
print('  夹具表 %s 行 %s' % (TABLE, RID))

try:
    # ---------- 第 0 条：闸真挂上了 ----------
    gate_ok, gate_why = _gate_probe(compose)
    check('0 闸**真挂上了**（content_gate_registered 回 True）—— 否则下面的红会分不清是没装还是没拦',
          gate_ok, gate_why)

    # ---------- 先做出「有旧版本」：正常回填一次 = 新建一版 ----------
    st_v0, b_v0 = t.service(c, 'files.versions', {'file': TABLE})
    v0 = result_of(st_v0, b_v0)
    v0 = v0 if isinstance(v0, list) else (v0.get('versions') or [])
    n0 = len(v0)

    # ⚠️ **写格不会建版本行**：`working_file.save_current` 原地覆盖同一个 working File
    # （设计如此，历史版本只由上传/新版本动作产生）。所以要造「历史那份」，
    # 必须走产品自己的 `files.new_version`，不能拿 `formal_value_write` 冒充。
    st_dl0, b_dl0 = t.download(c, TABLE, ((v0[0].get('source') or {}).get('file') if v0 else None))
    _ok0, _raw0 = _got_bytes(st_dl0, b_dl0)
    _b64v = base64.b64encode(_raw0).decode() if _ok0 and _raw0 else ''
    st_w0, b_w0 = t.action(c, 'files.new_version', {
        'file': TABLE, 'content_base64': _b64v}, 'rt43k-warm')
    _nv_err = _err(b_w0)
    _nv_blocked = ('外部文件不能覆盖已有表' in _nv_err)
    check('前置：用 `files.new_version` 造出第 2 版（历史那份，⑤ 要用）',
          True if (st_w0 == 200 and _b64v) else (None if _nv_blocked else False),
          ('HTTP %s 取到原字节=%r %s' % (st_w0, bool(_b64v), _nv_err[:110]))
          if not _nv_blocked else
          '**产品明确拒绝**：`files.new_version` 对表返回「表格请在表内修改，外部文件不能覆盖已有表」'
          ' —— 表**没有**「上传新版本」通道，⑤ 的前置造不出来（未判）')

    st_v1, b_v1 = t.service(c, 'files.versions', {'file': TABLE})
    v1 = result_of(st_v1, b_v1)
    v1 = v1 if isinstance(v1, list) else (v1.get('versions') or [])
    n1 = len(v1)
    # `files.versions` 是 `order_by='version_no desc'` → `[0]` 最新、越往后越旧
    CUR_REF = ((v1[0].get('source') or {}).get('file')) if v1 else None
    OLD_REF = ((v1[-1].get('source') or {}).get('file')) if len(v1) >= 2 else None
    _CAN_HAVE_HISTORY = (n1 >= 2 and bool(OLD_REF) and OLD_REF != CUR_REF)
    check('前置：版本 ≥2（有「当前那份」也有「历史那份」，⑤ 才有得测）',
          True if _CAN_HAVE_HISTORY else None,
          '版本 %d→%d 当前=%r 历史=%r' % (n0, n1, CUR_REF, OLD_REF)
          if _CAN_HAVE_HISTORY else
          ('**表的「历史版本」通道不存在**：`working_file.save_current` 原地覆盖工作文件**不建版本行**；'
           '`files.new_version` 又明确拒「外部文件覆盖已有表」。**⑤ 的前置产品上造不出来** —— 本组未判，'
           '不冒充通过、也不当失败。版本 %d→%d' % (n0, n1)))

    # ---------- ② 对照先行：没待恢复时照常过 ----------
    st_ok, b_ok = t.download(c, TABLE, CUR_REF)
    ok_ok, raw_ok = _got_bytes(st_ok, b_ok)
    check('② **对照**：没待恢复时，裸 file-content URL **照常给字节**（不是这口永远不通）',
          ok_ok, 'HTTP %s %d 字节' % (st_ok, len(raw_ok or b'')))

    # ---------- 制造待恢复 ----------
    armed, why_arm = _ss_fault.arm(compose, 'file-write')
    check('前置：断点装上了（装不上后面的结论不可信）', armed, why_arm)
    st_f, b_f, res_f = None, None, {}
    try:
        st_f, b_f = t.action(c, 'files.formal_value_write', {
            'table': TABLE, 'row_id': RID, 'values': {'amount': 999.75}}, 'rt43k-fail')
        res_f = result_of(st_f, b_f) or {}
    finally:
        _ss_fault.clear(compose)

    pending = res_f.get('pending') is True and res_f.get('sheet_written') is False
    check('前置：待恢复状态**造出来了**（`sheet_written` 假 + `pending` 真）',
          st_f == 200 and pending,
          'HTTP %s sheet_written=%r pending=%r' % (st_f, res_f.get('sheet_written'),
                                                   res_f.get('pending')))
    st_va, b_va = t.service(c, 'files.versions', {'file': TABLE})
    if st_va != 200:
        # 正门自己就拒了 —— 那「版本计数」这一项从产品口读不到，**如实说**，
        # 不硬凑一个 0 冒充「没往前走」（第一版就这么假红过：`result_of` 把错误吞成 `{}`，
        # `len([])==0` 看着像「0 版」，其实是「问都没问到」）。
        n_after = '正门已拒，读不到（③ 那条单独验）'
    else:
        va = result_of(st_va, b_va)
        va = va if isinstance(va, list) else (va.get('versions') or [])
        n_after = len(va)
    check('前置·旁证：待恢复期间**版本计数没往前走**（断点在造新版之前，`_save_version`）',
          n_after == '正门已拒，读不到（③ 那条单独验）' or n_after == n1,
          '版本数 %s（写失败前 %s）' % (n_after, n1))

    # ---------- ① 裸 URL 当场拒（反例）----------
    st_raw, b_raw = t.download(c, TABLE, CUR_REF)
    got_cur, raw_cur = _got_bytes(st_raw, b_raw)
    err1 = _dl_err(st_raw, b_raw)
    check('① 待恢复期间，裸 URL 下**当前那份** → **当场拒**（反例：闸不生效时这里拿到旧字节）',
          not got_cur, 'HTTP %s 拿到内容=%s 有 %d 字节' % (st_raw, got_cur, len(raw_cur or b'')))
    check('① 拒因说人话、点名「回填/待恢复」（不是泛泛「失败」，也不是权限话术）',
          ('回填' in err1) or ('待恢复' in err1),
          'err=%r' % (err1[:150],))

    # ---------- ③ 正门仍被文件域那道拦 ----------
    st_front, b_front = t.service(c, 'files.versions', {'file': TABLE})
    err3 = _err(b_front)
    check('③ **正门**（files.versions）待恢复期间**仍被文件域那道拦**（两道闸都留，不许删掉早拒那道）',
          st_front != 200 or not result_of(st_front, b_front),
          'HTTP %s err=%r' % (st_front, err3[:130]))
    check('③ 正门拒因同样点名「回填/待恢复」（两道闸说的是同一件事）',
          ('回填' in err3) or ('待恢复' in err3) or st_front == 200,
          'err=%r' % (err3[:130],))

    # ---------- ⑤ 旧版本不误伤 ----------
    st_old, b_old = t.download(c, TABLE, OLD_REF)
    got_old, raw_old = _got_bytes(st_old, b_old)
    err5 = _dl_err(st_old, b_old)
    check('⑤ **旧版本不误伤**：待恢复期间，**历史版本那份仍下得到**（闸只挡「最新那份」）',
          True if got_old else (None if not _CAN_HAVE_HISTORY else False),
          ('HTTP %s 拿到内容=%s 有 %d 字节 err=%r' % (st_old, got_old, len(raw_old or b''), err5[:90]))
          if _CAN_HAVE_HISTORY else
          '**无历史版本可测**（表没有版本历史通道，见前置说明）—— 未判')

    # ---------- ④ 敏感度：两种答案 ----------
    # 同一个口、同一个 ref，只差「有没有待恢复」—— 两次结论必须不同
    ans = {'没待恢复': ok_ok, '有待恢复': got_cur}
    check('④ **敏感度·两半**：对照给字节 **且** 待恢复被拒（两个都该为真）',
          ok_ok and not got_cur, '结论=%r' % ans)
    check('④ **敏感度·判别式**：「有没有待恢复」给**两种不同答案**（不恒真/恒假）',
          len(set(ans.values())) == 2, '结论=%r' % ans)

    # ---------- 恢复后照常（收尾对照）----------
    st_rec, b_rec = t.action(c, 'files.formal_value_write', {
        'table': TABLE, 'row_id': RID, 'values': {'amount': 777.5}}, 'rt43k-recover')
    st_dl2, b_dl2 = t.download(c, TABLE, CUR_REF)
    got2, raw2 = _got_bytes(st_dl2, b_dl2)
    check('⑥ **收尾对照**：重试保存后待恢复清掉、当前那份又下得到（卡的是「内容没就绪」，不是永久不通）',
          st_rec == 200 and got2,
          '重试 HTTP %s / 下载 HTTP %s 拿到内容=%s' % (st_rec, st_dl2, got2))
finally:
    _ss_fault.clear(compose)
    receipt = _ss_seed.seed_cleanup(c, handle)

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet and not fails:
    print('未测 %d 条（不算过）：' % len(not_yet))
    for _n in not_yet:
        print('  · ' + _n)
if fails:
    print('结果： FAIL ' + '; '.join(fails))
elif not_yet:
    print('结果： **未判** RT-4-3-K（断言 %d 条，**其中 %d 条未判**：%s）—— '
          '已过的部分：待恢复挡当前那份、对照放行、正门仍在、敏感度分开'
          % (len(checks), len(not_yet), '、'.join(not_yet)))
else:
    print('结果： PASS RT-4-3-K（%d 条）—— 内容闸集成：待恢复挡当前那份、'
          '对照放行、正门仍在、旧版本不误伤、敏感度分开' % len(checks))
sys.exit(1 if (fails or not_yet) else 0)
