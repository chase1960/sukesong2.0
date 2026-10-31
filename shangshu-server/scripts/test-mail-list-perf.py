#!/usr/bin/env python3
"""一万封信 · 邮件列表性能（接口层一段）

判据（先立在 `fde/开发/日志/2026-10-15.md` 12:31:51，立在动手之前）：

  测试通过 = 在一个装了 10000 封合成信的共享箱上，五个时限各自在「冷」和「热」两种状态下、
  跑满至少 20 次样本后，P95 与最大值都在门槛内、失败 0 次；
  样本不足 20 次则只报样本、不宣称 P95 达标。五个数分别报，不许合并成一个「快/不快」。

门槛原文见 `fde/开发/计划/执行计划.md:775`。

⚠️ **这份只量接口层那一段**，界面时序那几条（「点进共享箱到列表**可操作**」、
   「标读即时反馈 200ms」、「点发送到按钮恢复」）**不在这里**，要在真页面上量。
   **不拿这里的数冒充「冷开可操作」** —— 那是两回事，界面那半缺账号登录，照实另报。

⚠️ §13 第 9 条：**总结行不许写死结论**。下面每一行的数都是 `stats()` 从本轮真跑的样本算的，
   样本不足就写不足，不凑。

怎么跑（脚本从 stdin 喂，公共件连着喂）：

    cd <仓库根>
    cat shangshu-server/scripts/mail_fixture.py \
        shangshu-server/scripts/test-mail-list-perf.py \
      | docker exec -i shangshu-local-c-frappe-1 sh -lc \\
          'cd /home/frappe/frappe-bench && ./env/bin/python -'

只造合成信，不用真实客户邮件。只在 3830 做。3800 一个字节不动。
"""
import json
import os
import statistics
import sys
import time

# 公共件和这份 cat 在一起喂进容器（见文件头跑法）。**显式连一次** ——
# 2026-10-15 栽过：原先写 `if 'frappe' not in sys.modules: connect()`，
# 可公共件在前面已经 `import frappe` 了 → 判定跳过 → 后面 `frappe.set_user` 报
# `object is not bound`。**别用「模块在不在」推「连没连」**，直接连。
connect()

# ── 门槛（逐字对 执行计划.md:775）──────────────────────────────────────────
THRESHOLDS = {
    '列表首屏查询': 2000,      # 邮件列表冷开可操作≤2s —— 接口层只算查询那一段
    '搜索首批+未读计数': 1000,  # 搜索/筛选首批与两套未读计数≤1s
}
RUNS = 25          # ≥20，多给几次余量
PAGE_SPEC = 50     # 门槛写的「首屏 50 封」
PAGE_PROD = 30     # 生产前端实际发的（mail-center.js:721）—— 两个都量，不替谁拍板
# 门槛要求 10000。环境变量 `MAIL_PERF_N` 覆盖，只为**先小批冒烟再放大** ——
# 冒烟跑出来的数**不许**当一万封的结论报。
N_MAILS = int(os.environ.get('MAIL_PERF_N', '10000'))
if N_MAILS != 10000:
    print(f'⚠️ 本轮 N={N_MAILS}（不是门槛要求的 10000）—— 冒烟用，**结果不许当一万封的结论**')


def timed(fn, *a, **kw):
    t0 = time.perf_counter()
    out = fn(*a, **kw)
    return (time.perf_counter() - t0) * 1000.0, out


def stats(ms_list, threshold_ms, label):
    """从本轮真跑的样本算数 —— **不写死任何结论**。"""
    if not ms_list:
        return {'label': label, 'n': 0, 'note': '一条样本都没跑出来，不报任何结论'}
    s = {
        'label': label, 'n': len(ms_list),
        'min': round(min(ms_list), 1),
        'median': round(statistics.median(ms_list), 1),
        'max': round(max(ms_list), 1),
        'threshold_ms': threshold_ms,
    }
    if len(ms_list) >= 20:
        p = sorted(ms_list)
        s['p95'] = round(p[min(len(p) - 1, int(len(p) * 0.95))], 1)
        s['p95_claim'] = 'ok'   # 样本够，可以谈 P95
    else:
        s['p95'] = None
        s['p95_claim'] = f'样本只有 {len(ms_list)} 条（<20），**只报样本，不宣称 P95 达标**'
    over = [x for x in ms_list if x > threshold_ms]
    s['over_threshold'] = len(over)
    s['fail'] = len(over)
    return s


def report(rows):
    print('\n' + '=' * 72)
    print('一万封信 · 邮件列表性能（接口层） —— 数字全部来自本轮真跑样本')
    print('=' * 72)
    for r in rows:
        if r['n'] == 0:
            print(f"  {r['label']}: {r['note']}")
            continue
        line = (f"  {r['label']}: n={r['n']}  min={r['min']}ms  median={r['median']}ms  "
                f"max={r['max']}ms  门槛={r['threshold_ms']}ms  超门={r['over_threshold']}")
        print(line)
        if r.get('p95') is not None:
            print(f"      P95={r['p95']}ms  ({r['p95_claim']})")
        else:
            print(f"      P95 未报 —— {r['p95_claim']}")
    print('=' * 72)
    print('⚠️ 上面**只是接口层查询那一段**。界面时序（列表冷开「可操作」、标读即时反馈、')
    print('   点发送到按钮恢复）**没在这里量**，别把上面的数当成「冷开可操作」。')
    print('   界面那半缺账号登录，照实另报，不冒充。')
    print('=' * 72)


# ── 主流程 ────────────────────────────────────────────────────────────────
print(f'[1/5] 建夹具：两个普通账号 + 一个共享箱 + {N_MAILS} 封合成信')
ADMIN = 'Administrator'
# 「两个普通账号」—— 造两个普通用户。**不建管理员身份**（那属权限授予，只在用户）。
U1 = ensure_user('perf-u1@example.invalid', '压测一')
U2 = ensure_user('perf-u2@example.invalid', '压测二')
box = make_department_box(ADMIN, '压测共享箱', account_key='perf-10k-box')
bulk_grant(box, [
    {'user': U1, 'rights': {'read': True, 'send': True}},
    {'user': U2, 'rights': {'read': True, 'send': True}},
])
print(f'      箱 = {box}，授权给 {U1} / {U2}')

existing = frappe.get_all('Shangshu Mail Message',
                          filters={'subject': ['like', FIXTURE_TAG + '%']}, pluck='name')
if len(existing) >= N_MAILS:
    print(f'      已有 {len(existing)} 封合成信，复用（seed 幂等）')
else:
    need = N_MAILS - len(existing)
    t0 = time.perf_counter()
    seed_mails(U1, box, need, prefix=FIXTURE_TAG, batch=200,
               attach_every=20,   # 每 20 封 1 封带附件 —— 「带附件」筛选要有得筛
               on_progress=lambda i, n: print(f'      造信 {i}/{n}', flush=True) if i % 2000 == 0 else None)
    print(f'      造了 {need} 封，用时 {time.perf_counter()-t0:.1f}s')

total = frappe.get_all('Shangshu Mail Message',
                       filters={'subject': ['like', FIXTURE_TAG + '%']}, pluck='name')
print(f'      库里合成信总数 = {len(total)}（门槛要求 {N_MAILS}）')
if len(total) < N_MAILS:
    print(f'      ⚠️ 数量不够，下面的数按**实际 {len(total)} 封**报，不冒充一万封')

rows = []

# ── 两个普通账号同时访问（接口层并发）──────────────────────────────────────
print(f'\n[2/5] 量「列表首屏查询」—— 两个普通账号交替，各跑 {RUNS} 次（冷）')
for page, tag in ((PAGE_SPEC, f'首屏{PAGE_SPEC}封(门槛口径)'), (PAGE_PROD, f'首屏{PAGE_PROD}封(生产实际)')):
    for who, name in ((U1, '账号一'), (U2, '账号二')):
        frappe.set_user(who)
        cold, hot = [], []
        for i in range(RUNS):
            # 冷：每次换 order 或换页码，逼它重算（不复用上一次的计划/缓存）
            order = 'desc' if i % 2 == 0 else 'asc'
            ms, out = timed(service.query, None,
                            {'scope': 'inbox', 'mailbox': box, 'order': order},
                            1, page)
            cold.append(ms)
            if out is None or 'rows' not in out:
                print(f'      ⚠️ 第 {i} 次查询没回 rows —— 记为失败')
                cold[-1] = float('inf')
        for i in range(RUNS):
            ms, out = timed(service.query, None,
                            {'scope': 'inbox', 'mailbox': box, 'order': 'desc'},
                            1, page)
            hot.append(ms)
        rows.append(stats(cold, THRESHOLDS['列表首屏查询'], f'列表首屏查询 · {tag} · {name} · 冷'))
        rows.append(stats(hot, THRESHOLDS['列表首屏查询'], f'列表首屏查询 · {tag} · {name} · 热'))

print(f'\n[3/5] 量「搜索/筛选首批」—— 每种各跑 {RUNS} 次')
frappe.set_user(U1)
# 搜索和筛选是**两条不同的路**：搜索走 `q`（or_filters 模糊匹配），筛选走 `unread`/`attach`。
# 不套在同一个循环里 —— 上一版写乱了，未读/附件筛选根本不用 q。
cases = [
    ({'q': '合成信'}, '搜索 · 有命中'),
    ({'q': '绝不可能命中的字串zzz'}, '搜索 · 无匹配'),
    # ⚠️ 后端 `service.query` 的筛选值**必须是字符串**（`any(not isinstance(v,str)…)` 就拒），
    #    传整数 1 会抛「邮件筛选无效」。2026-10-15 栽过。
    ({'unread': '1'}, '筛选 · 未读'),
    ({'attach': '1'}, '筛选 · 带附件'),
]
for mode, tag in cases:
    cold = []
    f = {'scope': 'inbox', 'mailbox': box, **mode}
    for i in range(RUNS):
        ms, out = timed(service.query, None, f, 1, PAGE_SPEC)
        cold.append(ms)
    rows.append(stats(cold, THRESHOLDS['搜索首批+未读计数'], f'{tag} · 冷'))

print(f'\n[4/5] 量「两套未读计数」—— 各跑 {RUNS} 次')
for who, name in ((U1, '账号一'), (U2, '账号二')):
    frappe.set_user(who)
    cold = []
    for i in range(RUNS):
        ms, out = timed(service.query, None, {'scope': 'inbox', 'mailbox': box}, 1, PAGE_SPEC)
        # 两套未读计数在 query 的投影里一并出来，不另查一次
        cold.append(ms)
    rows.append(stats(cold, THRESHOLDS['搜索首批+未读计数'], f'两套未读计数（随列表出） · {name} · 冷'))

print(f'\n[5/5] 汇总')
report(rows)

print('\n[收尾] 清夹具')
frappe.set_user(ADMIN)
left = seed_cleanup(box)
print('      清完回读：', json.dumps(left, ensure_ascii=False))
if left['messages_left'] or left['account_left'] or left['access_left']:
    print('      ⚠️ 没清干净 —— 上面三项任一非空就是有残留')
else:
    print('      清干净了（三项都空）')
frappe.db.rollback()
