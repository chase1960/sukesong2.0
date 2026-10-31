"""`files.action_fact` **前端那条链**能不能落账（T08 的缺口，2026-10-14）。

**任务归属**：PKG-001-T08 的**前端半边**。T08 的 23/23 全是**服务端**判据，
前端 `reportActionFact()` 一次都没成功过 —— 每次回 417「动作缺少必填字段：payload.op_id」，
被 `catch {}` 吞了。所以**产品里的动作事实台账对最终用户是空的**，而 T08 看起来是绿的。

**测试通过 = 下面各条成立**：

FA-① **前端源码真会带 `op_id`，且 `op_id` 与 `idempotency_key` 分开**
      （`facts.py` 开头写死的口径：前者管业务对账/审计/撤回，后者管技术去重）。
      `reportActionFact` 的形参 **`opId` 是必填**（不许兜底生成 —— 兜底会让「同一笔操作」
      的重试变成两个不同的业务号，对账就断了）；`cell.save` 那处传 `op.key`
      （**和 undo 的幂等键同源的稳定操作号**）。
      *为什么静态查源码*：这是「前端到底发什么」的唯一权威 —— 浏览器里跑一遍不稳定，
      而源码是可复核的外部路径（契约文件 diff 同理）。
FA-② **反例：不带 `op_id` 的旧报法仍被拒** → HTTP **417**「动作缺少必填字段：payload.op_id」。
      **这条是 FA-① 的命根子** —— 没它，「源码里写了 op_id」和「服务端根本不要这字段」
      是同一个现象，判据恒真。
FA-③ **按前端实际形状发一条 → 落账**：`payload.op_id/action/target/detail/client_timestamp`
      + 信封 `confirmed/source/idempotency_key` → HTTP 200，回包 `op_id` 对得上。
      ⚠️ **顺带钉住第二个字段名坑**：客户端时间的字段名是 **`client_timestamp`**，
      不是 `timestamp`（服务端 schema 只声明前者，`additionalProperties: False`）。
      发 `timestamp` 会 417「动作包含未声明字段：payload.timestamp」——
      **补完 op_id 也照样落不了账**。所以 FA-③ 也验「旧字段名 timestamp 仍被拒」。
FA-④ **落得进、查得出（阳性对照）**：用刚写的 `op_id` 走 `files.action_fact_query` → **命中 1 条**。
      ⚠️ **没有这条就不能下「账是空的」结论** —— 查询坏了和账空了是同一个现象。
FA-⑤ **重试/补报都不制造第二条**（两种形状都要验，缺一条判据就虚）：
      ⑤-a **同 op_id + 同 idempotency_key + 同载荷**（立刻重发）
            → HTTP 200 + 顶层 `idempotent: true`（走 `actions.py:152` 的 `action_requests.replay`）。
      ⑤-b **同 op_id + 新 idempotency_key**（事后补报 —— `flushPendingActionFacts` 就是这么发的）
            → HTTP 200，handler 按 `op_id` 去重回 prior（`facts.py` 的 `_find_by_op`）。
      **两种形状之后账里都只有一条** —— 这才是「不制造第二条」的完整含义。
      ⚠️ 还有一条**反面**：同 idempotency_key 但**载荷变了**（比如客户端时间重新生成）
      → 409「幂等键已被不同请求使用」。这解释了**为什么补报必须换新键** ——
      不换键的补报根本发不出去（2026-10-14 踩过，照那样写判据会红在产品是对的上）。
FA-⑥ **四条上报线都有 `op_id` 来源，且失败不吞**：
      每个 `reportActionFact(` 调用点都**显式传 `opId`**（必填，无兜底）；
      被拒/失败要留**可见痕迹**（`console.warn` + 补报队列），不许裸 `catch {}` ——
      裸 catch 正是这个 bug 藏了一整版的原因。

---
**边界**：只改 `shangshu-web/js/domains/excel-univer/src/main.ts`（**`js/domains/` 之下，
不是内核**，见 `fde-commit-policy.json` 的 special_paths）+ 重建被跟踪的构建产物
`excel-univer-entry.js`。**不动** `frappe_apps/shangshu_files/shangshu_files/facts.py`
（服务端是对的，是前端没照契约发）。

**先红后绿**：`main.ts` 里没有 `op_id` 时 FA-①⑥ 应红。
**反例（故意翻期望）必须能红**，否则判据恒真。

用法：python3 test_action_fact_frontend.py [--cases 01,...,06]
"""
import importlib.util
import json
import os
import re
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
RUN = '%s-%d' % (t.RUN, int(time.time() * 1e6) % 100000000)
VALID = ('01', '02', '03', '04', '05', '06')
MAIN_TS = os.path.join(ROOT, 'shangshu-web', 'js', 'domains', 'excel-univer', 'src', 'main.ts')

raw = ''
for i, a in enumerate(sys.argv):
    if a == '--cases' and i + 1 < len(sys.argv):
        raw = sys.argv[i + 1]
want = tuple(x.strip() for x in raw.split(',') if x.strip()) if raw else VALID
if raw and not want:
    print('结果： FAIL --cases 给了空选择'); sys.exit(2)
bad = [x for x in want if x not in VALID]
if bad:
    print('结果： FAIL --cases 有未知用例：%s' % ','.join(bad)); sys.exit(2)

from _ss_cred import CRED as _CRED, pw_of as _pw_of, admin_pw_for
admin_pw = admin_pw_for(BASE)
if not admin_pw:
    print('结果： FAIL 取不到管理员口令'); sys.exit(2)

checks_run = 0
failed = []
not_yet = []


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


def notyet(label, why):
    global checks_run
    checks_run += 1
    not_yet.append(label)
    print('  ~ %s — 未测：%s' % (label, why))


def act(c, action, payload, key):
    try:
        st, body = t.action(c, action, payload, key)
    except Exception as e:
        return None, '调用异常:%s' % e
    return (st, body), ('ok' if st == 200 else 'HTTP %s %s' % (st, json.dumps(body, ensure_ascii=False)[:160]))


print('== files.action_fact 前端链路 ==')
print('实例：%s　run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

src = ''
if os.path.exists(MAIN_TS):
    src = open(MAIN_TS, encoding='utf8').read()
else:
    print('  ✗ 找不到 %s' % MAIN_TS)


def _fn_body():
    """抓 `reportActionFact` 的**函数体**，到第 0 列的 `}` 为止。
    **不能用 `[\s\S]*?\n\}`** —— 形参类型字面量的收尾 `}) {` 也长这样，
    会抓到 182 字节的假函数体，`op_id:` 一次都匹配不上（2026-10-14 踩过）。"""
    i = src.find('async function reportActionFact')
    if i < 0:
        return ''
    tail = src[i:]
    j = tail.find('\n}\n')          # 第 0 列的 `}` 才是函数收尾
    return tail[:j + 3] if j >= 0 else tail


body = _fn_body()

# ========================= FA-① 源码真会带 op_id =========================
if '01' in want:
    print('\n== FA-① 前端源码真会带 op_id ==')
    # **只认「请求体里的 op_id 键」**，不认注释里的字样 —— 注释写了等于没写。
    check('FA-① ① 抓得到 reportActionFact 函数体', bool(body) and len(body) > 200,
          '源码 %d 字节，函数体 %d 字节' % (len(src), len(body)))
    check('FA-① ② 请求体里有 op_id 键', bool(re.search(r'\bop_id\s*:', body)),
          '函数体内 op_id: 出现 %d 次' % len(re.findall(r'\bop_id\s*:', body)))
    check('FA-① ③ op_id 取自 opId 形参（不是写死一个常量）',
          bool(re.search(r'\bop_id\s*:\s*(event\.)?opId\b', body)),
          '匹配 op_id: [event.]opId → %s' % bool(re.search(r'\bop_id\s*:\s*(event\.)?opId\b', body)))
    # **opId 必填** —— 兜底生成会让「同一笔操作」的重试变成两个业务号，对账断掉
    check('FA-① ④ opId 是必填形参（不许兜底生成）',
          bool(re.search(r'\bopId\s*:', body)) and not re.search(r'\bopId\?\s*:', body),
          'opId: %s　opId?: %s' % (bool(re.search(r'\bopId\s*:', body)),
                                   bool(re.search(r'\bopId\?\s*:', body))))
    # **cell.save 必须传 op.key** —— 那是和 undo 幂等键同源的稳定号
    save_line = [l for l in src.splitlines() if "action: 'cell.save'" in l]
    check('FA-① ⑤ cell.save 那处传的是 op.key（稳定号，不是随机数）',
          bool(save_line) and 'opId: op.key' in save_line[0],
          ('命中行：%s' % save_line[0].strip()[:120]) if save_line else '没找到 cell.save 调用点')
    # **op_id 与 idempotency_key 分开**（`facts.py` 开头写死的硬口径）
    check('FA-① ⑥ idempotency_key 与 op_id 分开（不是同一个值）',
          bool(re.search(r'\bidempotency_key\s*:\s*idempotencyKey\b', body))
          and not re.search(r'\bidempotency_key\s*:\s*(opId|event\.opId)\b', body),
          'idempotency_key: idempotencyKey → %s' %
          bool(re.search(r'\bidempotency_key\s*:\s*idempotencyKey\b', body)))
    # **字段名对齐**：客户端时间是 `client_timestamp`，不是 `timestamp`
    check('FA-① ⑦ 客户端时间字段名是 client_timestamp（不是 timestamp）',
          bool(re.search(r'\bclient_timestamp\s*:', body)) and not re.search(r'\btimestamp\s*:', body),
          'client_timestamp: %s　timestamp: %s' % (
              bool(re.search(r'\bclient_timestamp\s*:', body)),
              bool(re.search(r'\btimestamp\s*:', body))))

# ========================= FA-② 反例：旧报法仍被拒 =========================
if '02' in want:
    print('\n== FA-② 反例：不带 op_id 的旧报法仍被拒 ==')
    c = t.Client(BASE)
    c.login('Administrator', admin_pw)
    # **故意抽掉 op_id** —— 就是修之前前端发的那个形状
    # （`act()` 回 `((st, body), why)`，别把 why 当 body）
    res, _why = act(c, 'files.action_fact', {
        'action': 'cell.save', 'target': 'F1',
        'detail': {'rowId': 'r-1'}, 'client_timestamp': int(time.time() * 1000),
    }, 'fa-neg-%s' % RUN)
    st, dat = res if res else (0, {})
    err = str((dat or {}).get('error') or '') if isinstance(dat, dict) else str(dat)
    ok = (st != 200) and ('payload.op_id' in err)
    check('FA-② 不带 op_id → 被拒，且错因是缺 payload.op_id（不是别的）', ok,
          'HTTP %s  err=%s' % (st, err.strip()[:140]))
    check('FA-② 反例自检：错因确实点名 payload.op_id',
          'payload.op_id' in err, 'err=%s' % err.strip()[:140])

# ========================= FA-③ 按前端实际形状发 → 落账 =========================
if '03' in want:
    print('\n== FA-③ 按前端实际形状发 → 落账 ==')
    c = t.Client(BASE)
    c.login('Administrator', admin_pw)
    OP = 'fa-save-%s' % RUN
    # **形状照抄 `reportActionFact` 发的那个**：payload.op_id / action / target / detail /
    # client_timestamp + 信封 confirmed / source / idempotency_key
    res, _why = act(c, 'files.action_fact', {
        'op_id': OP, 'action': 'cell.save', 'target': 'F1',
        'detail': {'rowId': 'r-000001', 'idempotent': False},
        'client_timestamp': int(time.time() * 1000),
    }, OP)  # idempotency_key 与 op_id 同值（前端就是这么发的）
    st, dat = res if res else (0, {})
    got = (dat or {}).get('result') if isinstance(dat, dict) else None
    got = got if isinstance(got, dict) else (dat if isinstance(dat, dict) else {})
    check('FA-③ ① 按前端形状发 → HTTP 200', st == 200,
          'HTTP %s %s' % (st, str(dat)[:140]))
    check('FA-③ ② 回包 op_id 对得上（不是回声以外的别的号）',
          isinstance(got, dict) and got.get('op_id') == OP,
          '回包 op_id=%r 期望=%r' % (got.get('op_id') if isinstance(got, dict) else got, OP))
    check('FA-③ ③ 回包有服务端认定的 server_time / summary（不是回声）',
          isinstance(got, dict) and bool(got.get('server_time')) and bool(got.get('summary')),
          'server_time=%r summary=%r' % (
              (got.get('server_time') if isinstance(got, dict) else None),
              str(got.get('summary') if isinstance(got, dict) else '')[:60]))
    # **第二个字段名坑的反例**：旧字段名 `timestamp` 必须仍被拒
    # —— 否则「client_timestamp 才对」这句话没法证伪，判据恒真。
    res2, _w2 = act(c, 'files.action_fact', {
        'op_id': 'fa-ts-neg-%s' % RUN, 'action': 'cell.save', 'target': 'F1',
        'detail': {}, 'timestamp': int(time.time() * 1000),
    }, 'fa-ts-neg-%s' % RUN)
    st2, dat2 = res2 if res2 else (0, {})
    err2 = str((dat2 or {}).get('error') or '') if isinstance(dat2, dict) else str(dat2)
    check('FA-③ ④ 反例：旧字段名 timestamp 仍被拒（证明 client_timestamp 才是真名）',
          st2 != 200 and 'timestamp' in err2,
          'HTTP %s  err=%s' % (st2, err2.strip()[:140]))

# ========================= FA-④ 阳性对照：落得进查得出 =========================
if '04' in want:
    print('\n== FA-④ 阳性对照：落得进、查得出 ==')
    c = t.Client(BASE)
    c.login('Administrator', admin_pw)
    OP = 'fa-save-%s' % RUN
    # **先确保有一条已知事实**（FA-③ 没跑时这里自己写一条）
    act(c, 'files.action_fact', {
        'op_id': OP, 'action': 'cell.save', 'target': 'F1',
        'detail': {'rowId': 'r-000001', 'idempotent': False},
        'timestamp': int(time.time() * 1000),
    }, OP)
    st, dat = t.action(c, 'files.action_fact_query', {'op_id': OP}, 'fa-q-%s' % RUN)
    body = dat if isinstance(dat, dict) else {}
    facts = (body.get('result') or {}).get('facts') if isinstance(body.get('result'), dict) else None
    if facts is None:
        facts = body.get('facts')
    hit = isinstance(facts, list) and [f for f in facts if f.get('op_id') == OP]
    check('FA-④ ① 用已知 op_id 查得到（阳性对照命中 —— 查询是好的）', bool(hit),
          'HTTP %s  命中 %s 条' % (st, len(hit) if isinstance(hit, list) else facts))
    if hit:
        f = hit[0]
        check('FA-④ ② 命中那条的动作名/目标对得上',
              f.get('action') == 'cell.save' and f.get('target') == 'F1',
              'action=%r target=%r' % (f.get('action'), f.get('target')))
    # **反例自检**：查一个不存在的 op_id 应当 0 条，且**不许因此判「查询坏了」**
    st2, dat2 = t.action(c, 'files.action_fact_query', {'op_id': 'fa-nope-%s' % RUN}, 'fa-q2-%s' % RUN)
    body2 = dat2 if isinstance(dat2, dict) else {}
    facts2 = (body2.get('result') or {}).get('facts') if isinstance(body2.get('result'), dict) else None
    if facts2 is None:
        facts2 = body2.get('facts')
    check('FA-④ ③ 反例自检：查不存在的 op_id 回 0 条（不是报错、不是全量）',
          isinstance(facts2, list) and len(facts2) == 0,
          'HTTP %s  facts=%s' % (st2, '空列表' if facts2 == [] else str(facts2)[:80]))

# ========================= FA-⑤ 重试/补报不制造第二条 =========================
if '05' in want:
    print('\n== FA-⑤ 重试/补报不制造第二条（三种形状）==')
    c = t.Client(BASE)
    c.login('Administrator', admin_pw)
    OP = 'fa-retry-%s' % RUN
    PAYLOAD = {'op_id': OP, 'action': 'paste.batch', 'target': '3x4',
               'detail': {'actionCount': 12}, 'client_timestamp': 1791949000000}
    KEY = 'fact-key-%s' % RUN

    def _count():
        stq, dq = t.action(c, 'files.action_fact_query', {'op_id': OP}, 'fa-q-%s-%d' % (RUN, _count.n))
        _count.n += 1
        q = dq if isinstance(dq, dict) else {}
        f = (q.get('result') or {}).get('facts') if isinstance(q.get('result'), dict) else None
        if f is None:
            f = q.get('facts')
        return f if isinstance(f, list) else None
    _count.n = 0

    # ---- 形状 a：同 op_id + 同 idempotency_key + 同载荷（立刻重发）----
    act(c, 'files.action_fact', dict(PAYLOAD), KEY)
    _r2, _ = act(c, 'files.action_fact', dict(PAYLOAD), KEY)     # 一模一样
    st2, d2 = _r2 if _r2 else (0, {})
    # ⚠️ `idempotent` 在**回包顶层**（`action_requests.replay` 的返回），
    #    不在 `result` 里 —— `result` 是 handler 的业务回包，没有这个键。
    top2 = d2 if isinstance(d2, dict) else {}
    check('FA-⑤ ① 形状a：同键同载荷重发 → 200 + 顶层 idempotent:true',
          st2 == 200 and top2.get('idempotent') is True,
          'HTTP %s idempotent=%r 顶层键=%s' % (st2, top2.get('idempotent'), sorted(top2.keys())[:8]))

    # ---- 形状 b：同 op_id + 新 idempotency_key（事后补报）----
    _r3, _ = act(c, 'files.action_fact', dict(PAYLOAD), 'fact-key2-%s' % RUN)
    st3, d3 = _r3 if _r3 else (0, {})
    g3 = (d3 or {}).get('result') if isinstance(d3, dict) else None
    g3 = g3 if isinstance(g3, dict) else {}
    check('FA-⑤ ② 形状b：同 op_id 换新键补报 → 200（handler 按 op_id 去重）',
          st3 == 200, 'HTTP %s %s' % (st3, str(d3)[:120]))
    check('FA-⑤ ③ 形状b 命中 op_id 去重（回 idempotent/action_count=0）',
          st3 == 200 and (g3.get('idempotent') is True or g3.get('action_count') == 0),
          'idempotent=%r action_count=%r' % (g3.get('idempotent'), g3.get('action_count')))

    # ---- 反面：同 idempotency_key 但载荷变了 → 409（所以补报必须换键）----
    PAYLOAD_B = dict(PAYLOAD)
    PAYLOAD_B['client_timestamp'] = 1791949000001
    _r4, _ = act(c, 'files.action_fact', PAYLOAD_B, KEY)         # 复用形状 a 的键
    st4, d4 = _r4 if _r4 else (0, {})
    err4 = str((d4 or {}).get('error') or '') if isinstance(d4, dict) else str(d4)
    check('FA-⑤ ④ 反面：同键但载荷变了 → 409（所以补报必须换新键）',
          st4 == 409 and '幂等键' in err4, 'HTTP %s err=%s' % (st4, err4.strip()[:120]))

    # ---- 三种形状之后账里都只有一条 ----
    f = _count()
    check('FA-⑤ ⑤ 三种形状之后账里仍只有一条',
          isinstance(f, list) and len(f) == 1,
          '账里 %s 条' % (len(f) if isinstance(f, list) else f))

# ========================= FA-⑥ 四条上报线都有 op_id，且失败不吞 =========================
if '06' in want:
    print('\n== FA-⑥ 四条上报线都有 op_id，且失败不吞 ==')
    sites = re.findall(r"reportActionFact\(\{[\s\S]*?\}\)", src)
    check('FA-⑥ ① 找得到 reportActionFact 调用点', len(sites) >= 4,
          '调用点 %d 处（期望 ≥4：cell.save / paste.batch / retry.fact / table.open）' % len(sites))
    named = re.findall(r"reportActionFact\(\{\s*opId:[^,]+,\s*action:\s*'([^']+)'", src)
    need = {'cell.save', 'paste.batch', 'retry.fact', 'table.open'}
    check('FA-⑥ ② 四条线都在，且都显式传 opId（必填无兜底）',
          need.issubset(set(named)),
          '显式带 opId 的 %s　缺 %s' % (sorted(set(named)), sorted(need - set(named))))
    # **不许有漏传 opId 的调用点** —— 少一处那条线就静默空
    missing = [m[:60] for m in sites if 'opId' not in m]
    check('FA-⑥ ③ 没有漏传 opId 的调用点', not missing, '漏传 %d 处：%s' % (len(missing), missing))
    # **失败不吞**：要留可见痕迹（控制台警告）+ 补报队列，不许裸 catch
    fn = _fn_body()
    check('FA-⑥ ④ 被拒/失败留可见痕迹（console.warn，不吞）',
          fn.count('console.warn') >= 2 and '上报被拒' in fn and '上报失败' in fn,
          'console.warn %d 次；上报被拒=%s 上报失败=%s' % (
              fn.count('console.warn'), '上报被拒' in fn, '上报失败' in fn))
    check('FA-⑥ ⑤ 有补报队列 _pendingActionFacts（不是报完就丢）',
          '_pendingActionFacts' in src and 'flushPendingActionFacts' in src,
          '队列=%s 补报函数=%s' % ('_pendingActionFacts' in src, 'flushPendingActionFacts' in src))
    check('FA-⑥ ⑥ 打开表时顺手补报（flushPendingActionFacts 有被调用）',
          bool(re.search(r'flushPendingActionFacts\(\)', src.split('function flushPendingActionFacts')[-1])),
          '调用点 %d 处' % len(re.findall(r'void flushPendingActionFacts\(\)', src)))
    check('FA-⑥ ⑦ 补报换新 idempotency_key（同 op_id）—— 否则发不出去',
          'fact-${item.opId}-r${item.retries}' in src.replace('`', ''),
          '新键模板含 op_id + 重试序号 → %s' % ('fact-${item.opId}-r' in src.replace('`', '')))

print('\n结果： %s  共 %d 条检查，失败 %d 条，未测 %d 条' %
      ('PASS' if not failed else 'FAIL', checks_run, len(failed), len(not_yet)))
for f in failed:
    print('  失败： %s' % f)
for n in not_yet:
    print('  未测： %s' % n)
sys.exit(1 if failed else 0)
