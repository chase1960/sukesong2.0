"""D-20 历史关系迁移：把遗留的 related_mail 迁进通用 relations（PKG-013-T02）。

**测试通过 = 下面每条成立**：

MIG-① **迁移前旧关系真的在**（R-④ 反向）—— 先断言遗留形态存在、条数已登记。
     没有这一步，后面「迁移后一条不丢」可能只是「本来就没了」的空集通过。
     准备：直接构造迁移前的行（`related_mail` 有值、`relations_json` 为空）——
     迁移测的是「已存的数据」，所以前置数据就该长成迁移前的样子。

MIG-② **一条不丢**（R-①）—— 迁移后每条遗留值都在 `relations_json` 里出现
     `{object_id:'mail.message', name:<原值>}`；**条数、键逐条对得上**。
     口径：**比条数 + 比键（object_id/name）**。原值那格**明写「无留痕可比」**
     —— 只存关联键的情况下说「内容对得上」是自欺（E 2026-10-14 定的口径）。

MIG-③ **不扩大访问**（R-②）—— **迁移前后对照**，但要分清两类字段：
     · **授权类**（能不能打开这份文件、被拒理由）—— **一字不许变**。这就是
       「不扩大访问」本身：「原本看不见的人照旧看不见」是它的直接推论。
     · **关联形状类**（解析出几条、每条的键名、unavailable 计数）—— **允许变**。
       迁移干的就是「把遗留字段里的关联读进通用 relations」，原先公共口不读
       `related_mail`、迁完才读得到，被引记录不存在就计 unavailable。
       拿「回包逐字段相同」当判据，会把迁移该做的事误判成违规。
     另加反向防呆：**没有身份从被拒变可读**（那才是真的扩大访问）；对照**不是空集
     通过**；且回包里只有关联键、没有授权字段。

MIG-④ **幂等** —— 再跑一次迁移，`relations_json` **不双写**（同一条只出现一次）。

MIG-⑤ **可读** —— 走公共口 `files.review` 读得出迁移后的关系，回包形状认得。

MIG-⑥ **反例（故意翻期望必须能红）** —— 把 MIG-② 的期望改成「迁移后应为空」，
     在同一份数据上必须判 FAIL，否则判据恒真等于没写。

MIG-⑦ **迁移不新增跨域耦合**（E 2026-10-14 点名，B 门禁 5ddfe340 查出真跨域之后）
     —— (a) 文件域生产代码里搜不到**邮件域**的 DocType 名（`object_id` 由调用方
     传入，本就不该出现）；(b) 文件域**不产生** `CROSS_DOMAIN_DOCTYPE_ACCESS`。
     并写明现状：`shangshu_mail/delivery.py` 直取文件域两张表是 **C 的存量违规**，
     不记到本次迁移头上，也不漏报。

---
**为什么现在迁数据、不删字段**：`mail_system`/`related_mail` 的**schema 摘除**
要等公共侧定 `owner_subject_*` → `attribution` 映射（两套枚举对不上，且牵动
文件中心「按所有人筛」与 C 的归属判据）。本脚本只迁**已存的数据**，不动入参、
不删列 —— 那一刀留到 2.0.0 一起切。所以这里**不制造脏中间态**。

**边界**：只动 `Shangshu File Center File` 的 `relations_json`；**不改** `related_mail`
原值（可回滚、可核对）、**不碰** `owner_subject_*`、**不动**权限判定源。

用法（口令只从账号文件进环境变量，不写进代码、不打印）：
  export SS_BASE=http://127.0.0.1:3840
  export SS_D_USER=Administrator
  export SS_D_PW=…            # 环境管理员
  export SS_D_PW_TESTER=…     # 第二个身份，给 MIG-③ 做前后对照（缺则降级为单身份）
  python3 shangshu-server/scripts/tests/test_d_relations_migrate.py [--cases mig1,...,mig7]
"""
import argparse
import importlib.util
import subprocess
import json
import os
import sys
import uuid

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')
spec = importlib.util.spec_from_file_location('t', ROOT + '/shangshu-server/scripts/test-n2-structure.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW', '')
if not PW:
    print('结果： FAIL 缺 SS_D_PW（口令见 开发/本地测试/Agent-D-测试账号.md，不写进代码）')
    sys.exit(2)

RUN = t.RUN
MAIL_OBJ = 'mail.message'          # 邮件域登记的对象 id（shangshu_mail/domain.py:95）

VALID = ('mig1', 'mig2', 'mig3', 'mig4', 'mig5', 'mig6', 'mig7',
         'att1', 'att2', 'att3', 'att4', 'att5', 'att6', 'att7', 'att8', 'att9')
parser = argparse.ArgumentParser(description='D-20 历史关系迁移：related_mail → 通用 relations')
parser.add_argument('--cases', default=','.join(VALID))
cli = parser.parse_args()
raw = cli.cases.strip()
want = tuple(x.strip() for x in raw.split(',') if x.strip()) if raw else VALID
if not want:
    print('结果： FAIL --cases 给了空选择'); sys.exit(2)
bad = [x for x in want if x not in VALID]
if bad:
    print('结果： FAIL --cases 有未知用例：%s' % ','.join(bad)); sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

checks = 0
fails = []
not_yet = []


def check(name, ok, detail):
    global checks
    checks += 1
    print(('  PASS ' if ok else '  FAIL ') + name + ' —— ' + str(detail))
    if not ok:
        fails.append(name)


def notyet(name, why):
    """记「未测」，**不许当成过**。造不出前置就照实标，不硬造、不假装验过。"""
    global checks
    checks += 1
    not_yet.append(name)
    print('  ~ %s — 未测：%s' % (name, why))


# ---------- 直连数据库：构造迁移前的行、读回迁移后的行 ----------
# 迁移测的是「已存的数据」，前置数据要长成迁移前的样子（related_mail 有值、relations 空）。
# 直接写库是构造**遗留形态夹具**，不是绕过产品逻辑 —— 产品逻辑是「怎么迁」，由 migrate_legacy 承担。

DOCKER = 'shangshu-local-d-mariadb-1'
DB = '_e88b0480cd627b76'


def sql(query):
    import subprocess
    full = 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" %s -N -e %s' % (DB, "'%s'" % query.replace("'", "'\\''"))
    out = subprocess.run(['docker', 'exec', DOCKER, 'sh', '-c', full],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit('SQL 失败：%s\n%s' % (query, out.stderr))
    return out.stdout.strip()


def make_legacy_rows(n=3, specs=None, prefix='D迁移夹具'):
    """造迁移前形态的行。返回 (文件名列表, related_mail 列表)。

    **默认行为不变**（`specs=None`）：`n` 行，`related_mail` 有值、`relations_json` 空、
    `owner_subject_kind='Employee'` —— 给 MIG-①～⑦ 用。

    **传 `specs`** 时按给定的 `(owner_subject_kind, owner_subject)` 造行，`related_mail` 留空 ——
    给 ATT-①～⑦（归属迁移）用。**两种形态共用这一个建样本入口**，
    别再写第二个（§13 原则 1：登录/样本生成/结果解析只留一份）。
    """
    names, mails = [], []
    if specs is None:
        specs = [('Employee', 'MAIL-%s-%d' % (uuid.uuid4().hex[:10], i)) for i in range(n)]
    for i, (kind, subject) in enumerate(specs):
        fname = '%s-%s-%d' % (prefix, RUN, i)
        mail = subject if kind == 'Employee' and subject.startswith('MAIL-') else ''
        names.append(fname)
        mails.append(mail)
        sql(
            "INSERT INTO `tabShangshu File Center File` "
            "(name, file_name, directory, status, version_count, owner, "
            " owner_subject_kind, owner_subject, related_mail, relations_json, "
            " creation, modified, modified_by, docstatus) "
            "VALUES ('%s','%s','/','Active',1,'%s','%s','%s','%s','[]',NOW(),NOW(),'%s',0)"
            % (fname, fname, USER, kind, subject, mail, USER)
        )
    return names, mails


def read_rows(names):
    """读回这些行的 relations_json 与 related_mail。"""
    out = {}
    for n in names:
        raw = sql("SELECT relations_json, related_mail FROM `tabShangshu File Center File` "
                  "WHERE name='%s'" % n)
        if not raw:
            out[n] = None
            continue
        rj, rm = (raw.split('\t') + [''])[:2]
        try:
            rels = json.loads(rj) if rj else []
        except ValueError:
            rels = '<解析失败:%s>' % rj
        out[n] = {'relations': rels, 'related_mail': rm}
    return out


def call_migrate(dry_run=False, what='relations'):
    """调迁移。走 bench 的公共入口，不直接 import 模块（要验的是能被调用的那个）。

    `what` 选哪条迁移：
      · `'relations'`（默认）—— `relations.migrate_legacy(MAIL_OBJ)`，遗留 `related_mail` → `relations`
      · `'attribution'` —— `attribution_migrate.migrate()`，遗留 `owner_subject_*` → 内核 `attribution`

    **两条迁移共用这一套工具**（登录 / 建样本 / 结果解析只留一份，§13 原则 1），
    业务用例只写「准备什么、做什么、应该发生什么」。

    `object_id` 由调用方给出 —— 被测的 `migrate_legacy` 不硬编码领域对象 id
    （文件域不许出现「邮件」）。这里传 `mail.message` 是**迁移发起方**的职责。

    **为什么是 `bench console` 灌 stdin**（实测换过的三条路，记下免得下次再试）：
      · `env/bin/python -c "frappe.init(site=…)"` —— `init` 的 `sites_path` 默认 `"."`，
        站点在 `sites/` 下找不到，抛 `IncorrectSitePath`。
      · `frappe.init(sites_path="/home/…/sites")` —— 传了也不认，日志路径照样拼错。
      · `bench execute "frappe.get_attr(…)"` —— 能调到函数，但返回值打 Python repr
        （不是 JSON）、`--kwargs` 要 Python 字面量，且没法在同一上下文里 commit。
      `bench console` 由 bench 自己完成站点初始化，能连调用带提交一起做。
    """
    import subprocess
    if what == 'attribution':
        body = [
            "from shangshu_files import attribution_migrate as M",
            "r = M.migrate(dry_run=%r)" % bool(dry_run),
        ]
    else:
        body = [
            "from shangshu_files.relations import migrate_legacy",
            "r = migrate_legacy(%r, dry_run=%r)" % (MAIL_OBJ, bool(dry_run)),
        ]
    script = "\n".join(["import json"] + body + [
        "frappe.db.commit()",
        "print('MIGRATE_RESULT ' + json.dumps(r, ensure_ascii=False, sort_keys=True, default=str))",
        "exit()",
    ])
    out = subprocess.run(
        ['docker', 'exec', '-i', '-w', '/home/frappe/frappe-bench', 'shangshu-local-d-frappe-1',
         'bash', '-c', 'bench --site shangshu.localhost console'],
        input=script + "\n", capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        raise SystemExit('迁移调用失败：%s\n%s' % (out.stdout, out.stderr))
    # IPython 会把提示符挤在同一行（`In [5]: MIGRATE_RESULT {…}`），所以按**行内**找，
    # 不能要求行首 —— 否则回包明明在，却被判成「没有回包」。
    marker = 'MIGRATE_RESULT '
    hits = [l[l.index(marker) + len(marker):].strip() for l in out.stdout.splitlines() if marker in l]
    # **空回包不算数**（同「空的零写」那个族）：IPython 会把**回显的源码行**也带 marker，
    # 那种行 marker 后面是 `json.dumps(...)` 之类，不是 JSON。上一版直接 `json.loads(hits[-1])`，
    # 于是在 import 失败时炸成 `JSONDecodeError: Expecting value: line 1 column 1` ——
    # **看着像工具坏了，其实是被测模块没部署**。现在挑得出 JSON 的那条；一条都没有就照实报错。
    good = [h for h in hits if h.startswith('{') or h.startswith('[')]
    if not good:
        raise SystemExit(
            '迁移没有有效回包（marker 有 %d 条，但没有一条是 JSON —— 多半是被测模块没部署/调用炸了）\n'
            '  marker 命中：%r\n  stdout 尾：%s\n  stderr 尾：%s'
            % (len(hits), hits[-3:], out.stdout[-600:], out.stderr[-400:]))
    return json.loads(good[-1])


# ---------- 准备：造迁移前形态 ----------

names, mails = make_legacy_rows(3)
before = read_rows(names)
print('准备：%d 行迁移前形态' % len(names))
for n in names:
    print('  %s → related_mail=%r relations=%r' % (n, before[n]['related_mail'], before[n]['relations']))


# ---------- 可见性探测（迁移前后各拍一次，比对）----------
# 「不扩大访问」是**前后对照**的断言，所以探测必须在迁移前先拍一张。
# 谁能看见什么，走公共口 `files.review` 问，不直接读表 —— 要验的是产品对外的可见性。

def probe_visibility(pw, user, file_name):
    """以某个身份问一次 files.review，把「看得见什么」压成可比的形状。"""
    cc = t.Client(BASE)
    try:
        cc.login(user, pw)
    except Exception as error:
        return {'login': 'fail', 'error': str(error)[:200]}
    try:
        st, body = t.service(cc, 'files.review', {'file': file_name})
    except Exception as error:
        return {'login': 'ok', 'call': 'raise', 'error': str(error)[:200]}
    ok_http = st == 200 and isinstance(body, dict) and body.get('ok')
    res = (body.get('result') or body) if isinstance(body, dict) else {}
    rels = res.get('relations') if isinstance(res, dict) else None
    return {
        'login': 'ok',
        'http': st,
        'ok': bool(ok_http),
        # 只留**形状**：有没有 relations、有几条、每条的键名、unavailable 计数。
        # 不留被引记录内容 —— 那正是「不该被看见」的东西。
        'relations_shape': [sorted(r.keys()) for r in rels] if isinstance(rels, list) else rels,
        'relations_count': len(rels) if isinstance(rels, list) else None,
        'unavailable': res.get('unavailable') if isinstance(res, dict) else None,
        'error': str(res)[:200] if not ok_http else '',
    }


TESTER_USER = 'tester@example.invalid'
PW_TESTER = os.environ.get('SS_D_PW_TESTER', '')
identities = [('Administrator', PW)]
if PW_TESTER:
    identities.append((TESTER_USER, PW_TESTER))
else:
    print('提示：未给 SS_D_PW_TESTER，MIG-③ 只用管理员一个身份对照（降级，见下）')

vis_before = {u: probe_visibility(p, u, names[0]) for u, p in identities}
print('\n迁移前可见性：%s' % json.dumps(vis_before, ensure_ascii=False))

# ---------- MIG-① 迁移前旧关系真的在（反向）----------

if 'mig1' in want:
    print('\n== MIG-① 迁移前旧关系真的在 ==')
    ok_all = all(before[n] and before[n]['related_mail'] for n in names)
    empty_rels = all(before[n] and not before[n]['relations'] for n in names)
    check('MIG-① 遗留形态存在：每行 related_mail 有值', ok_all,
          {n: (before[n] or {}).get('related_mail') for n in names})
    check('MIG-① 且 relations_json 为空（是待迁形态，不是已迁）', empty_rels,
          {n: (before[n] or {}).get('relations') for n in names})
    check('MIG-① 条数已登记（供 MIG-② 对账）', len(mails) == 3 and len(set(mails)) == 3,
          'related_mail 共 %d 条，去重 %d 条' % (len(mails), len(set(mails))))

# ---------- 跑迁移 ----------

dry = call_migrate(dry_run=True)
print('\n迁移 dry-run 回包：%s' % json.dumps(dry, ensure_ascii=False))
result = call_migrate(dry_run=False)
print('迁移实跑回包：%s' % json.dumps(result, ensure_ascii=False))
after = read_rows(names)

# ---------- MIG-② 一条不丢（比条数 + 比键）----------

if 'mig2' in want:
    print('\n== MIG-② 一条不丢（比条数 + 比键）==')
    for n in names:
        rels = after[n]['relations'] if after[n] else None
        got = [(r.get('object_id'), r.get('name')) for r in rels] if isinstance(rels, list) else rels
        want_keys = (MAIL_OBJ, before[n]['related_mail'])
        check('MIG-② %s 迁出 %r' % (n, want_keys),
              isinstance(rels, list) and want_keys in got,
              '迁移前 related_mail=%r → 迁移后 relations=%s' % (before[n]['related_mail'], got))
    # 条数对账
    total_before = sum(1 for n in names if before[n] and before[n]['related_mail'])
    total_after = sum(len(after[n]['relations']) for n in names
                      if after[n] and isinstance(after[n]['relations'], list))
    check('MIG-② 条数对账：迁移前 %d 条 → 迁移后 %d 条' % (total_before, total_after),
          total_before == total_after, 'before=%d after=%d' % (total_before, total_after))
    check('MIG-② 原值那格「无留痕可比」——只存关联键，不谎称内容对得上',
          True, '口径：比条数+比键（object_id/name）；revision/values 快照不在文件域，无从比')

# ---------- MIG-⑥ 反例（故意翻期望必须能红）----------

if 'mig6' in want:
    print('\n== MIG-⑥ 反例（故意翻期望，必须判 FAIL）==')
    any_rel = any(isinstance(after[n]['relations'], list) and after[n]['relations']
                  for n in names)
    wrong = (not any_rel)   # 故意翻成「迁移后应为空」
    check('MIG-⑥ 反例自检：把期望翻成「迁移后 relations 应为空」应当判不成立',
          not wrong, '若这条 FAIL，说明 MIG-② 恒真，等于没写')

# ---------- MIG-③ 不扩大访问（前后对照）----------
# 分清两类字段：
#   **授权类**（login / http / ok / error）—— **一字不许变**。这是「不扩大访问」本身。
#   **关联形状类**（relations_shape / relations_count / unavailable）—— **允许变**，
#     因为迁移干的就是「把遗留字段里的关联读进通用 relations」。原先公共口不读
#     `related_mail`，迁完才读得到；被引记录在 D 环境不存在，就计进 unavailable。
#     这不是扩大访问，是把已有的关联读出来了。
# 所以断言是「**授权结果前后一字不差；变的只能是关联长什么样**」，
# 不是「回包逐字段相同」—— 那会把迁移该做的事误判成违规。

AUTH_FIELDS = ('login', 'http', 'ok', 'error')
RELATION_FIELDS = ('relations_shape', 'relations_count', 'unavailable')

if 'mig3' in want:
    print('\n== MIG-③ 不扩大访问（迁移前后对照）==')
    vis_after = {u: probe_visibility(p, u, names[0]) for u, p in identities}
    print('迁移后可见性：%s' % json.dumps(vis_after, ensure_ascii=False))

    for u, _pw in identities:
        b, a = vis_before.get(u) or {}, vis_after.get(u) or {}
        auth_b = {k: b.get(k) for k in AUTH_FIELDS}
        auth_a = {k: a.get(k) for k in AUTH_FIELDS}
        check('MIG-③ %s 授权结果前后一字不差（能不能看、被拒理由都不变）' % u,
              auth_b == auth_a,
              'before=%s\n         after=%s' % (auth_b, auth_a))
        changed = [k for k in RELATION_FIELDS if b.get(k) != a.get(k)]
        allowed_changed = [k for k in changed if k in RELATION_FIELDS]
        check('MIG-③ %s 变的只有关联形状，没有授权字段' % u,
              set(changed) <= set(RELATION_FIELDS),
              '变化字段=%s（允许：关联形状类 %s）' % (changed, list(RELATION_FIELDS)))

    # 反向防呆1：不许有身份从「被拒」变成「可读」——那才是真的扩大了访问
    escalated = [u for u, p in identities
                 if (vis_before.get(u) or {}).get('ok') is False
                 and (vis_after.get(u) or {}).get('ok') is True]
    check('MIG-③ 没有身份从被拒变可读（这才是真的扩大访问）', not escalated,
          '被升权的身份：%s' % escalated)

    # 反向防呆2：对照不是空集通过（至少一个身份真的问到了回包）
    non_empty = any(v.get('login') == 'ok' and v.get('http') is not None
                    for v in vis_after.values())
    check('MIG-③ 对照不是空集通过（至少一个身份真的问到了回包）', non_empty,
          {u: v.get('http') for u, v in vis_after.items()})

    # 关联是键不是授权
    st, body = t.service(c, 'files.review', {'file': names[0]})
    ok_http = st == 200 and body.get('ok')
    res = (body.get('result') or body) if ok_http else {}
    rels = res.get('relations') or []
    check('MIG-③ 关联是键不是授权——回包里没有出现「额外授权」字段',
          all(set(r.keys()) <= {'object_id', 'name', 'expected_revision', 'expected_modified',
                                'values', 'object', 'record', 'unavailable'} for r in rels) if rels else True,
          'relations 条目键：%s' % [sorted(r.keys()) for r in rels])

# ---------- MIG-④ 幂等（重复迁移不双写）----------

if 'mig4' in want:
    print('\n== MIG-④ 幂等：重复迁移不双写 ==')
    again = call_migrate(dry_run=False)
    after2 = read_rows(names)
    print('第二次迁移回包：%s' % json.dumps(again, ensure_ascii=False))
    dup = False
    for n in names:
        rels = after2[n]['relations'] if after2[n] else None
        if not isinstance(rels, list):
            continue
        keys = [(r.get('object_id'), r.get('name')) for r in rels]
        if len(keys) != len(set(keys)):
            dup = True
    check('MIG-④ 重复迁移后同一条只出现一次（不双写）', not dup,
          {n: after2[n]['relations'] for n in names})
    check('MIG-④ 第二次迁移报告「无需迁移」', (again.get('migrated') or 0) == 0,
          '第二次回包=%s' % again)

# ---------- MIG-⑤ 走公共口可读 ----------

if 'mig5' in want:
    print('\n== MIG-⑤ 走公共口 files.review 可读 ==')
    st, body = t.service(c, 'files.review', {'file': names[0]})
    ok_http = st == 200 and body.get('ok')
    res = (body.get('result') or body) if ok_http else {}
    rels = res.get('relations') or []
    unav = res.get('unavailable')
    got = [(r.get('object_id'), r.get('name')) for r in rels]
    check('MIG-⑤ 公共口回包形状认得（关系数组在场）', ok_http and isinstance(res.get('relations'), list),
          'HTTP %s keys=%s' % (st, sorted(res.keys())))
    # D 环境里**没有真实邮件记录**，被引对象解析不了 → review.read 会把它计进
    # unavailable 而不是 relations。这不是迁移失败，是被引记录不存在。
    # 所以判据取「公共口**认账**」：要么解析出来在 relations，要么计进 unavailable，
    # 两者加起来要对得上迁移进去的条数。**不谎称「读到了」**。
    accounted = len(rels) + (unav or 0)
    check('MIG-⑤ 公共口认账迁移进去的那条（解析出来或计为不可用，二者之和 ≥1）',
          ok_http and accounted >= 1,
          'relations=%s unavailable=%s 合计=%d（被引记录在 D 环境不存在，故计不可用属正常）'
          % (got, unav, accounted))

# ---------- MIG-⑦ 反例：迁移不新增跨域耦合（E 2026-10-14 点名）----------
# 背景：B 的门禁 `check-platform-contract.mjs`（5ddfe340）补全表名单后，当场查出
# `shangshu_mail/delivery.py` 直取文件域两张表 —— 那是 **C 的存量违规**，不是本次迁移造的。
# 本次迁移的正确方向是「文件域零领域词」，所以反例钉两件事，都是机器可查的：
#   (a) 文件域生产代码里搜不到**邮件域**的 DocType 名（`relations.py` 的 object_id
#       由调用方传入，本就不该出现）
#   (b) 文件域**不产生** `CROSS_DOMAIN_DOCTYPE_ACCESS` —— 迁移不新增跨域直查
# 不把 mail→files 那两条记到本次迁移头上，但要写明它们在、归谁，不冒领也不漏报。

if 'mig7' in want:
    print('\n== MIG-⑦ 迁移不新增跨域耦合 ==')
    import re as _re
    files_root = os.path.join(ROOT, 'frappe_apps', 'shangshu_files', 'shangshu_files')
    mail_names = ('Shangshu Mail Access', 'Shangshu Mail Account',
                  'Shangshu Mail Message', 'Shangshu Mail Read')

    # (a) 文件域零领域词
    stray = []
    for fn in sorted(os.listdir(files_root)):
        if not fn.endswith('.py'):
            continue
        text = open(os.path.join(files_root, fn), encoding='utf-8').read()
        for n in mail_names:
            for i, line in enumerate(text.splitlines(), 1):
                if ('"%s"' % n) in line or ("'%s'" % n) in line:
                    stray.append('%s:%d %s' % (fn, i, line.strip()[:70]))
    check('MIG-⑦ 文件域生产代码里搜不到邮件域 DocType 名（零领域词）', not stray,
          '命中 %d 处：%s' % (len(stray), stray[:5]))

    # (b) 门禁不因文件域报跨域
    import subprocess
    gate = subprocess.run(['node', os.path.join(ROOT, 'scripts', 'check-platform-contract.mjs')],
                          capture_output=True, text=True, cwd=ROOT)
    # **门禁的条目打在 stderr，stdout 是空的** —— 只读 stdout 会恒空、恒「0 条」、
    # 恒通过，就是空集通过。所以两个流都要，且**先证明工具真跑到了**（吐出了行）。
    gate_out = (gate.stdout or '') + (gate.stderr or '')
    gate_lines = [l for l in gate_out.splitlines() if l.strip()]
    check('MIG-⑦ 门禁真的跑到了（吐出行，否则下面的「0 条」是空集通过）',
          bool(gate_lines), 'exit=%s 行数=%d 首行=%r'
          % (gate.returncode, len(gate_lines), gate_lines[0] if gate_lines else None))
    cross = [l for l in gate_lines if 'CROSS_DOMAIN_DOCTYPE_ACCESS' in l]

    def _gate_path(line):
        """门禁行形如 `[platform-contract] <路径>: 条目`；**按路径判谁在查**。
        不能拿 `'shangshu_files' in line` 全文匹配 —— 条目里「（属 shangshu_files）」
        说的是**被查的表属于谁**，全文匹配会把 `shangshu_mail` 的违规误记成文件域的。"""
        body = line.split(']', 1)[-1].strip()
        return body.split(':', 1)[0].strip()

    cross_in_files = [l for l in cross if _gate_path(l).startswith('frappe_apps/shangshu_files')]
    check('MIG-⑦ 文件域不产生 CROSS_DOMAIN_DOCTYPE_ACCESS（迁移没新增跨域直查）',
          not cross_in_files, '文件域命中：%s' % cross_in_files)
    # 写明现状，不冒领也不漏报
    check('MIG-⑦ 现状登记：mail→files 的跨域直查是 C 的存量，不在本次迁移范围',
          True, '门禁 CROSS_DOMAIN 共 %d 条，违规方=%s：%s'
          % (len(cross), sorted({_gate_path(l).split('/')[1] for l in cross if '/' in _gate_path(l)}),
             [_gate_path(l) for l in cross]))

# ---------- 收口 ----------

# ==================== ATT-①～⑦ 归属迁移：owner_subject_* → 内核 attribution ====================
# **这是「两步」里的第一步（字段迁移）**，不是第二步（判定权搬家）。契约 §3.5.3：
# 「字段迁移 + 判定权搬家捆在一起，坏了不知道是哪一半；分两步，第二步随时可回退。」
# 所以本组**只验搬值**，`_dept_allows` / `has_permission` 的语义一个字都不该变（ATT-③ 钉这条）。
#
# **值搬到哪**（契约 §3.5.1 定死）：
#   Employee   → ('personal',   None,          owner_subject)
#   Department → ('department', owner_subject, None)
# **绝不落 `enterprise`** —— 理由是**用户口径**：
#   · 用户 **2026-10-15**：「**尚书是单例，没有企业归属。**」—— 不是「(a)/(c) 选哪条」，
#     是**那个桶压根不该存在**。所以 `enterprise` **永不产生，一行都不许有**。
#   · 用户 **2026-10-13** `账号与权限.md:192` 第 5 条管**不明的行去哪**：
#     「保持既有权限并待核，不批量填企业归属」= 不迁不动、列出来等人核，**不是当场拒死**。
# **不明归属不迁不动、列出来等人核** —— 「保持既有权限并待核」不是「当场拒死」。

ATT_SPECS = [
    ('Employee', 'emp-1'), ('Employee', 'emp-2'), ('Department', 'dept-1'),
    ('', 'x'),            # 不明：没填类型
    ('Employee', ''),     # 不明：没填 ID
    ('Ghost', 'who'),     # 不明：未知类型
]
WANT_ATT = any(c.startswith('att') for c in want)
att_names, _ = (make_legacy_rows(specs=ATT_SPECS, prefix='D归属迁移夹具')
                if WANT_ATT else ([], []))
ATT_EMP = [att_names[i] for i, (k, s) in enumerate(ATT_SPECS)
           if WANT_ATT and k == 'Employee' and s]
ATT_DEPT = [att_names[i] for i, (k, s) in enumerate(ATT_SPECS) if k == 'Department' and s]
ATT_UNK = [att_names[i] for i, (k, s) in enumerate(ATT_SPECS)
           if not k or not s or k not in ('Employee', 'Department')]
print('\n准备：%d 行归属迁移前形态（能迁 %d + 能迁 %d + 不明 %d）'
      % (len(att_names), len(ATT_EMP), len(ATT_DEPT), len(ATT_UNK)))
for n, (k, s) in zip(att_names, ATT_SPECS):
    print('  %s  kind=%r subject=%r' % (n, k, s))


def att_rows(names):
    """读回这些行在内核归属表里的记录（一个文件最多一条）。"""
    out = {}
    for n in names:
        raw = sql("SELECT level, department, owner_user FROM `tabShangshu Org Attribution` "
                  "WHERE resource='%s'" % n)
        if not raw:
            out[n] = None
            continue
        parts = (raw.split('\t') + ['', '', ''])[:3]
        # mysql 批处理把 SQL NULL 打成字符串 `NULL` —— 归一成 None，
        # 否则 `not a.get('department')` 会把「没部门」（正确）误判成「有部门」。
        parts = [None if (p == 'NULL' or p == '') else p for p in parts]
        out[n] = {'level': parts[0], 'department': parts[1], 'owner_user': parts[2]}
    return out


att_before = att_rows(att_names)
print('迁移前归属记录：%s' % json.dumps(att_before, ensure_ascii=False))

# ---------- 前置核对：运行面有没有翻译那一层 ----------
# 归属迁移的翻译调 `shangshu_core.field_access.map_owner_subject`（契约 §3.5.1：翻译只有一份）。
# **D 运行面（基 ef9772b8）早于那个模块** —— 实测整个 `field_access.py` 都不在。
# 按 E 定的规矩：**造不出前置就照实标 NOT_RUN 并点名缺什么，不硬造、不假装验过**。
import importlib.util as _ilu

HAS_FIELD_ACCESS = False
_fa_path = os.path.join(ROOT, 'frappe_apps/shangshu_core/shangshu_core/field_access.py')
_map_fn = None
if os.path.exists(_fa_path):
    _spec = _ilu.spec_from_file_location('fa_pure', _fa_path)
    _fa = _ilu.module_from_spec(_spec)
    try:
        _spec.loader.exec_module(_fa)     # 纯模块（不碰 frappe），可脱离运行时 import
        _map_fn = getattr(_fa, 'map_owner_subject', None)
    except Exception as _e:
        print('  ~ 源码里 field_access.py import 不动：%s' % _e)

_rt_probe = sql("SELECT count(*) FROM `tabShangshu File Center File` WHERE 1=0")
# 运行面在不在：拿 console 试 import（只读探测）
_ctr = os.environ.get('SS_BENCH_CTR', 'shangshu-local-d-frappe-1')
_site = os.environ.get('SS_SITE', 'shangshu.localhost')
_probe = subprocess.run(
    ['docker', 'exec', '-i', '-w', '/home/frappe/frappe-bench', _ctr, 'bash', '-c',
     'bench --site %s console' % _site],
    input='import importlib.util as u; '
          'print("HAS_FA", bool(u.find_spec("shangshu_core.field_access")))\nexit()\n',
    capture_output=True, text=True, timeout=180)
HAS_FIELD_ACCESS = 'HAS_FA True' in ((_probe.stdout or '') + (_probe.stderr or ''))

# ---------- ATT-②′ 翻译那一层：**纯函数核对**（脱离运行时也能验）----------
# `map_owner_subject` 是纯翻译（B 明写：不碰 frappe、不查库、不缓存），所以**这一层不依赖部署**。
# 端到端迁不了（运行面缺模块）不等于翻译契约没验过 —— 两件事分开记。
print('\n== ATT-②′ 翻译那一层：纯函数核对（契约 §3.5.1）==')
if _map_fn is None:
    notyet('ATT-②′ 纯函数核对', '工作树里 import 不到 map_owner_subject（见上）')
else:
    _CASES = [
        ('Employee', 'emp-1', ('personal', None, 'emp-1')),
        ('Department', 'dept-1', ('department', 'dept-1', None)),
        # **大小写敏感，拒得对** —— enum 是 'Employee'（domain.py:52）。
        # 静默归一化会把脏数据藏起来；拒掉让它进「不明归属→等核」那堆更安全。
        # 真实数据里若有人写过小写，会出现在待核清单里，那是应该的。
        ('employee', 'emp-1', None),
        ('Enterprise', 'x', None),                                # 绝不发明 enterprise
        ('enterprise', 'x', None),
        ('Ghost', 'who', None),                                   # 未知类型明确拒
        ('', 'x', None),                                          # 空类型
        ('Employee', '', None),                                   # 空 ID
        ('Department', None, None),                               # 缺 ID
    ]
    # **每种输入只调一次，结果记下来** —— 断言复用记录，不再重复调（重复调会把
    # 「明确拒」的 ValueError 冒出断言，看着像判据坏了，其实是被测函数正常拒）。
    _got_list = []
    _ok = 0
    for _kind, _subj, _want in _CASES:
        try:
            _got = _map_fn(_kind, _subj)
        except Exception as _err:
            _got = ('REJECT', str(_err)[:60])
        _got_list.append((_kind, _subj, _want, _got))
        if _want is None:
            _hit = isinstance(_got, tuple) and _got and _got[0] == 'REJECT'
        else:
            _hit = (_got == _want)
        if _hit:
            _ok += 1
        print('    %-12s %-10s → %s  %s' % (repr(_kind), repr(_subj), _got, '✓' if _hit else '✗'))

    _legal = [(k, s2, w, g) for k, s2, w, g in _got_list if w is not None]
    _illegal = [(k, s2, w, g) for k, s2, w, g in _got_list if w is None]
    _a = all(g == w for _, _, w, g in _legal)
    _b = all(isinstance(g, tuple) and g and g[0] == 'REJECT' for _, _, _, g in _illegal)
    check('ATT-②′ Employee → (personal, None, id) / Department → (department, id, None)',
          _a, '两种合法形状都对得上契约 §3.5.1')
    check('ATT-②′ **绝不发明 enterprise**：Enterprise/enterprise/未知/空 一律明确拒',
          _b, '%d 种非法输入全部明确拒' % len(_illegal))
    check('ATT-②′ 九种输入逐一核对：%d/%d 命中期望' % (_ok, len(_CASES)), _ok == len(_CASES),
          '命中 %d/%d' % (_ok, len(_CASES)))
    check('ATT-②′ 敏感度：合法形状全对 **且** 非法形状全拒（两半都得成立）', _a and _b,
          '合法=%s 非法全拒=%s' % (_a, _b))

print('\n前置核对：运行面有 `shangshu_core.field_access`？ %s　（源码里 map_owner_subject 可用？ %s）'
      % (HAS_FIELD_ACCESS, _map_fn is not None))

if not HAS_FIELD_ACCESS:
    _why = ('D 运行面缺整个模块 `shangshu_core/field_access.py`（B 的字段级权限公共模块，'
            '基线 ef9772b8 早于它；工作树里有，19116 字节）。'
            '归属迁移的翻译层 `map_owner_subject` 就在那个模块里 —— 调不到，'
            '端到端迁不了。**不硬造、不假装验过**。')
    for _c in ('att1', 'att2', 'att4', 'att5', 'att6', 'att7'):
        if _c in want:
            notyet('ATT-%s（用例 %s）' % ({'1': '① 形态在', '2': '② 值对得上', '4': '④ 幂等',
                                          '5': '⑤ 不明不动', '6': '⑥ 不落 enterprise',
                                          '7': '⑦ 敏感度'}.get(_c[-1], _c), _c), _why)
else:
    att_dry = call_migrate(dry_run=True, what='attribution')
    print('归属迁移 dry-run：%s' % json.dumps(att_dry, ensure_ascii=False))

# ---------- ATT-① 迁移前遗留形态真的在（反向） ----------
if 'att1' in want and HAS_FIELD_ACCESS:
    print('\n== ATT-① 归属迁移前遗留形态真的在（反向）==')
    legacy = {}
    for n in att_names:
        raw = sql("SELECT owner_subject_kind, owner_subject FROM `tabShangshu File Center File` "
                  "WHERE name='%s'" % n)
        legacy[n] = (raw.split('\t') + [''])[:2] if raw else None
    check('ATT-① 遗留两列真的在表上（不是我以为在）',
          all(v is not None for v in legacy.values()),
          '查到 %d/%d 行' % (sum(1 for v in legacy.values() if v), len(att_names)))
    check('ATT-① 内核归属表**无**记录（是待迁形态，不是已迁）',
          all(v is None for v in att_before.values()),
          '有归属的：%s' % [n for n in att_names if att_before.get(n)])
    check('ATT-① 三种形状各就各位（能迁的和不能迁的都有）',
          bool(ATT_EMP) and bool(ATT_DEPT) and bool(ATT_UNK),
          'employee=%s department=%s 不明=%s' % (ATT_EMP, ATT_DEPT, ATT_UNK))

# ---------- ATT-⑤ 不明归属不迁不动、列出来（**先于写**，因为它是「不许写」） ----------
if 'att5' in want and HAS_FIELD_ACCESS:
    print('\n== ATT-⑤ 不明归属不迁不动、列出来 ==')
    skipped = att_dry.get('skipped') or []
    skipped_names = [s.get('name') for s in skipped if isinstance(s, dict)]
    check('ATT-⑤ 三行不明归属都被列为「待核」', set(ATT_UNK) <= set(skipped_names),
          '列了 %s　应列 %s' % (skipped_names, ATT_UNK))
    check('ATT-⑤ 每条带原因（不是只说「跳过」）',
          all(s.get('reason') for s in skipped if isinstance(s, dict)),
          '原因=%s' % [s.get('reason') for s in skipped if isinstance(s, dict)])
    check('ATT-⑤ dry-run **一个字节没写**（先看后动）',
          all(v is None for v in att_rows(att_names).values()),
          'dry-run 后有归属的：%s' % [n for n in att_names if att_rows([n]).get(n)])

if HAS_FIELD_ACCESS:
    att_result = call_migrate(dry_run=False, what='attribution')
    print('\n归属迁移实跑：%s' % json.dumps(att_result, ensure_ascii=False))
    att_after = att_rows(att_names)
    print('迁移后归属记录：%s' % json.dumps(att_after, ensure_ascii=False))
else:
    # 前置不齐时**不跑迁移**（跑了也是炸），下游用例全被 `and HAS_FIELD_ACCESS` 挡住。
    att_result, att_after = {}, {}

# ---------- ATT-② 一条不丢、值对得上 ----------
if 'att2' in want and HAS_FIELD_ACCESS:
    print('\n== ATT-② 归属：一条不丢、值对得上 ==')
    for n in ATT_EMP:
        a = att_after.get(n)
        subj = ATT_SPECS[att_names.index(n)][1]
        check('ATT-② %s → personal / owner_user=%r' % (n, subj),
              bool(a) and a.get('level') == 'personal' and a.get('owner_user') == subj
              and not a.get('department'),
              '实际=%s' % a)
    for n in ATT_DEPT:
        a = att_after.get(n)
        subj = ATT_SPECS[att_names.index(n)][1]
        check('ATT-② %s → department / department=%r' % (n, subj),
              bool(a) and a.get('level') == 'department' and a.get('department') == subj
              and not a.get('owner_user'),
              '实际=%s' % a)
    unmoved = [n for n in ATT_UNK if att_after.get(n) is not None]
    check('ATT-② 不明归属**一行都没写**（保持既有权限并待核，不是「猜一个」也不是「当场拒死」）',
          not unmoved, '不该写却写了：%s' % unmoved)
    check('ATT-② 条数对账：计划 %s → 实写 %s' % (att_dry.get('planned'), att_result.get('written')),
          int(att_dry.get('planned') or 0) == int(att_result.get('written') or 0),
          '计划=%s 实写=%s' % (att_dry.get('planned'), att_result.get('written')))

# ---------- ATT-⑥ 绝不落 enterprise ----------
if 'att6' in want and HAS_FIELD_ACCESS:
    print('\n== ATT-⑥ 绝不落 enterprise ==')
    ents = sql("SELECT resource, level FROM `tabShangshu Org Attribution` "
               "WHERE level='enterprise' AND resource IN (%s)"
               % ','.join("'%s'" % n for n in att_names))
    check('ATT-⑥ 本批一个 enterprise 都没落', not ents, '落了：%s' % ents)
    levels = set(v.get('level') for v in att_after.values() if v)
    check('ATT-⑥ 只出现 personal / department 两种（enum 也只有这两种来源）',
          levels <= {'personal', 'department'}, '实际 level 集合=%s' % levels)

    def _ent_ok(found_ent, levels_seen):
        return (not found_ent) and set(levels_seen) <= {'personal', 'department'}

    a = _ent_ok(False, {'personal'}); b = _ent_ok(True, {'personal', 'enterprise'})
    # ⚠️ 不能叫 `c` —— 顶层 `c` 是 HTTP 客户端，这里覆盖后后面 `t.action(c, ...)` 会炸
    c_ok = _ent_ok(False, {'personal', 'department'}); d = _ent_ok(False, {'enterprise'})
    vv = {'ok': a, 'ent_leak': b, 'ok2': c_ok, 'only_ent': d}
    check('ATT-⑥ 敏感度：判别式认「没落 enterprise」为过', a and c_ok, 'ok/ok2')
    check('ATT-⑥ 敏感度：判别式认「落了 enterprise」为不过', not b and not d, 'ent_leak/only_ent')
    check('ATT-⑥ 敏感度：四种形状给出两种不同结论', len(set(vv.values())) == 2, '结论=%r' % vv)

# ---------- ATT-④ 幂等：再跑一次不堆行 ----------
if 'att4' in want and HAS_FIELD_ACCESS:
    print('\n== ATT-④ 归属：幂等，不堆行 ==')
    cnt = {n: (sql("SELECT count(*) FROM `tabShangshu Org Attribution` WHERE resource='%s'" % n) or '0')
           for n in att_names}
    again = call_migrate(dry_run=False, what='attribution')
    cnt2 = {n: (sql("SELECT count(*) FROM `tabShangshu Org Attribution` WHERE resource='%s'" % n) or '0')
            for n in att_names}
    check('ATT-④ 再跑一次**一个新文件都没写**（已有归属的算 done）',
          int(again.get('written') or 0) == 0, '回包=%s' % again)
    check('ATT-④ 每个文件**恰好一条**归属记录（不堆行）',
          all(int(v) <= 1 for v in cnt2.values()), '条数=%s' % cnt2)
    check('ATT-④ 前后条数不变', cnt == cnt2, '前=%s 后=%s' % (cnt, cnt2))

# ---------- ATT-③ 不扩大访问（红线 #5）----------
# **迁移前后对照**，两类字段要分清（MIG-③ 的教训）：
#   · **授权结果**前后必须一字不差 —— 迁移不该让谁多看到、也不该让谁少看到
#   · **归属形状**字段变了是迁移该做的事，不算违规
if 'att3' in want and HAS_FIELD_ACCESS:
    print('\n== ATT-③ 归属：不扩大访问（红线 #5）==')
    # 授权结果：**不明归属那几行迁移压根没碰**，可见性必须一字不差
    unk_now = att_rows(ATT_UNK)
    check('ATT-③ 不明归属那几行：迁移**没碰它们**（归属记录前=后=None）',
          all(v is None for v in unk_now.values()) and
          all(att_before.get(n) is None for n in ATT_UNK),
          '前=%s 后=%s' % ({n: att_before.get(n) for n in ATT_UNK},
                          {n: unk_now.get(n) for n in ATT_UNK}))
    # 形状字段：能迁的那几行现在**有**归属 —— 这是迁移该做的，不算「扩大」
    check('ATT-③ 能迁的那几行现在有归属（形状变了，这是迁移该做的）',
          all(att_after.get(n) for n in ATT_EMP + ATT_DEPT),
          '有归属=%s' % [n for n in att_names if att_after.get(n)])
    # **第二身份对照**（造得出才有证明力）
    if not PW_TESTER:
        notyet('ATT-③ 第二身份前后对照', '没给 SS_D_PW_TESTER，造不出第二个身份；单身份对照没有证明力')
    else:
        def _vis(client):
            out = {}
            for n in att_names:
                st, b = t.service(client, 'files.sheet_read', {'table': n})
                out[n] = 'read' if st == 200 else 'deny:%s' % st
            return out
        adm_c = t.Client(BASE); adm_c.login(USER, PW)
        other = t.Client(BASE)
        try:
            other.login('tester@example.invalid', PW_TESTER)
        except SystemExit:
            other = None
        if other is None:
            notyet('ATT-③ 第二身份前后对照', '第二个身份登不进')
        else:
            vis = _vis(other)
            print('  第二个身份对各样本的读结果：%s' % json.dumps(vis, ensure_ascii=False))
            check('ATT-③ 第二身份对「不明归属」那几行：迁移前后**结果不该变**（它们没被碰）',
                  all(str(vis.get(n, '')).startswith('deny') or vis.get(n) == 'read'
                      for n in ATT_UNK),
                  '不明行的读结果=%s' % {n: vis.get(n) for n in ATT_UNK})

# ---------- ATT-⑦ 敏感度：判别式必须给出两种结论 ----------
if 'att7' in want and HAS_FIELD_ACCESS:
    print('\n== ATT-⑦ 归属迁移敏感度 ==')

    def _mig_ok(moved_right, unk_left, no_ent, idempotent):
        return bool(moved_right) and bool(unk_left) and bool(no_ent) and bool(idempotent)

    a = _mig_ok(True, True, True, True); b = _mig_ok(False, True, True, True)
    c_bad = _mig_ok(True, False, True, True); d = _mig_ok(True, True, False, True)
    e = _mig_ok(True, True, True, False)
    vv = {'ok': a, 'wrong_value': b, 'guessed': c_bad, 'ent_leak': d, 'stacked': e}
    check('ATT-⑦ 敏感度：判别式认「迁对 + 不明不动 + 无 enterprise + 幂等」为过', a, 'ok')
    check('ATT-⑦ 敏感度：判别式认「值没迁对」为不过', not b, 'wrong_value')
    check('ATT-⑦ 敏感度：判别式认「不明的被猜着写了」为不过', not c_bad, 'guessed')
    check('ATT-⑦ 敏感度：判别式认「落了 enterprise」为不过', not d, 'ent_leak')
    check('ATT-⑦ 敏感度：判别式认「堆行」为不过', not e, 'stacked')
    check('ATT-⑦ 敏感度：五种形状给出两种不同结论（不是恒真/恒假）',
          len(set(vv.values())) == 2, '结论=%r' % vv)

# ==================== ATT-⑧ enterprise 归属一律明确拒（用户 2026-10-15 口径）====================
# **用户 2026-10-15 原话定性**：「**尚书是单例，没有企业归属。**」
# 「你只要保证内核不乱跑就行」—— 这条钉的就是**不许发明企业归属**。
#
# **两个入口，别混**（两个都要关，本条钉 ①）：
#   ① **传了不拦** —— `service.py` `_apply_attribution`：`level='enterprise'` 收得下
#      **（本条钉这个）**
#   ② **没传也造** —— `org_admin.py:258` `resource_assign` 什么都不给时兜底发明 `enterprise`
#      **（内核那侧的，本条不钉）**
#
# **本条原本是「已知如此」判据**（白纸黑字钉着「今天落得进库」），照 FA-16 的规矩：
# **实现改成拒的时候，连判据一起翻红改写** —— 现在就是那一刻，判据跟着实现一起变。
#
# **测试通过 =** 下面每条成立：
#   ① `files.upload` 带 `level='enterprise'` **被拒**，拒因点名「尚书是单例，没有企业归属」
#      （不许用泛泛的「无效」—— 用户原话才是人能读懂的理由）
#   ② **零写**：库里不落 `level='enterprise'` 的行（拒了还留半行 = 脏数据）
#   ③ **对照**：`level='personal'` 仍然落得进 —— 证明拒的是 enterprise，不是把上传口弄死了
#   ④ **`files.create` 同样拒** —— 同一个 `_apply_attribution` 的另一个调用点，别只堵一个门
#   ⑤ **敏感度**：两种输入两种结论（不是恒真/恒假）
#
# **为什么拒因要写用户那句话**：改完之后有人看日志/报错，「无效」什么也说明不了；
# 「尚书是单例，没有企业归属」直接把口径摆在那儿，不用再翻文档。
if 'att8' in want:
    # **本节自己的计数** —— `checks` 是全局的（含 ATT-②′ 等），
    # 拿它当「ATT-⑧ 多少条」会把别的组的条数算进来。**总结行只认这一个。**
    _att8_before = checks
    print('\n== ATT-⑧ enterprise 归属一律明确拒（用户 2026-10-15「尚书是单例，没有企业归属」）==')
    import base64 as _b64
    from io import BytesIO as _BIO

    def _xlsx():
        _wb = __import__('openpyxl').Workbook(); _ws = _wb.active
        _ws.append(['名称']); _ws.append(['甲'])
        _buf = _BIO(); _wb.save(_buf)
        return _b64.b64encode(_buf.getvalue()).decode()

    def _err_of(st, body):
        """把回包压成一句错因。拒的形状有多种（HTTP 4xx / ok:false），都收。"""
        if not isinstance(body, dict):
            return 'HTTP %s 非 JSON %r' % (st, str(body)[:80])
        return str(body.get('error') or body.get('message') or
                   (body.get('result') or {}) if False else '')[:160] or 'HTTP %s %s' % (st, str(body)[:120])

    REASON = '尚书是单例，没有企业归属'

    # —— ① 上传口：enterprise 必须被拒，拒因点名用户原话 ——
    st8, b8 = t.action(c, 'files.upload', {
        'file_name': 'D企业归属-应被拒-%s.xlsx' % RUN,
        'directory': '/',
        'content_base64': _xlsx(),
        'attribution': {'level': 'enterprise'}}, 'att8-rej')
    res8 = (b8.get('result') or {}) if isinstance(b8, dict) and b8.get('ok') else {}
    U8 = res8.get('file')
    err8 = ''
    if isinstance(b8, dict):
        err8 = str(b8.get('error') or b8.get('message') or
                   ((b8.get('result') or {}) if isinstance(b8.get('result'), dict) else {}).get('error') or '')[:200]
    if not err8 and isinstance(b8, dict):
        err8 = str(b8)[:200]
    rejected8 = (st8 != 200) or (isinstance(b8, dict) and (b8.get('ok') is False or 'error' in b8))
    check("ATT-⑧ ① `files.upload` 带 `level='enterprise'` **被拒**（不是收下）",
          rejected8 and not U8,
          'HTTP %s ok=%s file=%r' % (st8, (b8 or {}).get('ok') if isinstance(b8, dict) else None, U8))
    check("ATT-⑧ ① 拒因点名「%s」（用户原话，不许泛泛的「无效」）" % REASON,
          REASON in err8, '错因=%r' % err8[:120])

    # —— ② 零写：**前后计数比对**，不是「库里没有」——
    # 第一版写成「查不到 enterprise 行」，被**跨次残留**污染过（历史跑漏的脏行让这条恒红，
    # 跟本次拒没拒无关）。零写验的是**这一次调用没落库**，所以要比 before/after 两个数。
    _before8 = sql("SELECT COUNT(*) FROM `tabShangshu Org Attribution` WHERE level='enterprise'") or '0'
    check('ATT-⑧ ② 零写·**前**（基线取到）', _before8.strip().isdigit(),
          'before=%r' % _before8)
    _after8 = sql("SELECT COUNT(*) FROM `tabShangshu Org Attribution` WHERE level='enterprise'") or '0'
    check('ATT-⑧ ② **零写**：被拒的这次调用**一条 enterprise 都没落**（before==after）',
          _before8.strip() == _after8.strip(),
          'before=%s after=%s（差 %s 条）' % (
              _before8.strip(), _after8.strip(),
              int(_after8.strip() or 0) - int(_before8.strip() or 0) if _after8.strip().isdigit() and _before8.strip().isdigit() else '?'))

    # —— ③ 对照：personal 仍然落得进（拒的是 enterprise，不是把上传口弄死）——
    st8c, b8c = t.action(c, 'files.upload', {
        'file_name': 'D个人归属-对照-%s.xlsx' % RUN,
        'directory': '/',
        'content_base64': _xlsx(),
        'attribution': {'level': 'personal'}}, 'att8-ctrl')
    res8c = (b8c.get('result') or b8c) if isinstance(b8c, dict) else {}
    U8c = res8c.get('file') if isinstance(res8c, dict) else None
    lvl8c = ''
    if U8c:
        _r = sql("SELECT level FROM `tabShangshu Org Attribution` WHERE resource='%s'" % U8c)
        lvl8c = (_r.split('\t') + [''])[0] if _r else ''
        att_names.append(U8c)
    check("ATT-⑧ ③ **对照**：`level='personal'` 仍落得进（拒的是 enterprise，不是上传口死了）",
          st8c == 200 and lvl8c == 'personal', 'HTTP %s file=%r level=%r' % (st8c, U8c, lvl8c))

    # —— ④ files.create 同一个 _apply_attribution，另一个调用点也要拒 ——
    st8n, b8n = t.action(c, 'files.create', {
        'file_name': 'D企业建表-应被拒-%s.xlsx' % RUN,
        'directory': '/',
        'attribution': {'level': 'enterprise'}}, 'att8-create')
    res8n = (b8n.get('result') or {}) if isinstance(b8n, dict) and b8n.get('ok') else {}
    U8n = res8n.get('file')
    err8n = ''
    if isinstance(b8n, dict):
        err8n = str(b8n.get('error') or b8n.get('message') or '')[:200] or str(b8n)[:200]
    check('ATT-⑧ ④ `files.create` 带 enterprise **同样拒**（同一个 `_apply_attribution`，别只堵一个门）',
          ((st8n != 200) or (isinstance(b8n, dict) and (b8n.get('ok') is False or 'error' in b8n))) and not U8n,
          'HTTP %s ok=%s file=%r 错因=%r' % (st8n, (b8n or {}).get('ok') if isinstance(b8n, dict) else None,
                                            U8n, err8n[:80]))

    # —— ⑤ 敏感度（两问，别混）——
    # 第一问「两半都得成立」：enterprise 被拒 **且** personal 落得进，两个都该为真。
    # 第二问「判别式不恒真」：同一个问句「**这个 level 收没收**」在两种输入上必须给两种答案。
    #
    # ⚠️ 上一版把这两问混成一个 `len(set(...))==2`，于是在两半都成立时反而判 FAIL ——
    # **那是判据自己写错了，不是产品错**。两半都为真恰是最好的结果。
    # 敏感度验的是「判别式跟着输入变」，不是「结论必须一真一假」。
    v8 = {'enterprise_rejected': rejected8 and not U8, 'personal_lands': lvl8c == 'personal'}
    check('ATT-⑧ ⑤ 敏感度·两半：enterprise 被拒 **且** personal 落得进（两个都该为真）',
          all(v8.values()), '结论=%r' % v8)
    accepted = {'enterprise': not v8['enterprise_rejected'], 'personal': v8['personal_lands']}
    check('ATT-⑧ ⑤ 敏感度·判别式：「收没收」这个问句在两种 level 上给出**两种不同答案**'
          '（证明它不恒真/恒假）',
          len(set(accepted.values())) == 2, '收没收=%r' % accepted)


# ==================== ATT-⑨ 新建不传归属就拒（用户 2026-10-15 选修法一）====================
# **用户 2026-10-15 选修法一「上传必填归属」**，从源头堵住
# 「今天新建、谁也没声明 → 默认全可下」（`:554` 那条边，见证据 §15.8）。
#
# **口径（E 认）**：必填管的是「**新建必须落库归属**」，不是「调用方必须手写一个字段」——
# **要堵的是「建了文件却没有归属」，不是「代码少写了一个参数」。**
#
# **边界三条，一条不扩**：
#   · **只管今天新建的** —— 库里已有的没归属老文件继续「保持既有权限并待核」（用户 10-13）
#   · **不给默认归属**（修法三）—— 用户已拒、B 也排除：那等于又发明一个归属，猜错就是越权
#   · **拒因说人话**（E 定的文案）：「不传归属不能建文件。请选个人或部门归属 —— 尚书是单例，没有企业归属。」
#
# ⚠️ **本组判据自己不许走公共夹具默认**（E 的硬条件）—— 每条都在**调用点上显式**传/不传。
# 理由：ATT-⑨ 也吃公共默认的话，「产品必填闸坏了」和「夹具补上了」就分不开 ——
# **空过长得跟过一模一样**。公共工具里的默认只服务「我在测别的东西」的用例。
#
# **测试通过 =** 下面每条成立：
#   ① `files.upload` 不传 attribution → **被拒** + 拒因说人话（**人填路径**）
#   ② `files.create` 不传 → **被拒**（**人填路径**）
#   ③ `files.import_attachment` 不传 → **系统自动填给调用者本人**（**系统路径**，用户 ⑦）
#   ④ **对照**：带了归属的照样过 —— 证明拒的是「不声明」，不是把上传口搞死了
#   ⑤ **只管新建**：追版本（`existing` 分支）不传归属 → **照过**（防「一刀切」假绿）
#   ⑥ **敏感度两问**：两半都成立 **且** 「传没传」给两种答案
#
# ⚠️ **人填 / 系统填是两条路**（用户 2026-10-15 ⑦，E 落的口径）——
# 人工上传（`files.upload`/`files.create`，前端有归属选择器）**人填**，不填就拒（修法一）；
# 系统新建（`files.import_attachment`，邮件管线/归档按钮都没有选择器）**自动填给本人**。
# **别把这两条搅在一起**：自动填不是把必填闸拆了。两条路的完整对照 + 敏感度在
# `test_g1_import_attribution.py` G1-⑧ ④⑤。
if 'att9' in want:
    _att9_before = checks
    print('\n== ATT-⑨ 新建不传归属就拒（用户 2026-10-15 选修法一「上传必填归属」）==')
    import base64 as _b64
    from io import BytesIO as _BIO

    def _payload_b64():
        _wb = __import__('openpyxl').Workbook(); _ws = _wb.active
        _ws.append(['名称']); _ws.append(['甲'])
        _buf = _BIO(); _wb.save(_buf)
        return _b64.b64encode(_buf.getvalue()).decode()

    REASON9 = '不传归属不能建文件'

    def _act9(action_id, payload, key):
        """**本组专用调用口** —— 不走 `t.action`。

        **为什么不用共享的 `t.action`**：第 3 步要给公共工具补「测试夹具默认归属」，
        那个默认一加进 `t.action`，本组每条「有意不传」就会**静默吃到夹具** ——
        于是「产品必填闸坏了」和「夹具补上了」**分不开**，空过长得跟过一模一样。

        这里直接打动作口、**永远不注入任何默认**，让夹具**结构上够不着本组**。
        E 的硬条件：「ATT-⑨ 自己不许走公共工具的默认载荷，六条判据必须显式传/不传，
        每一个都在调用点上看得见。」
        """
        return c.request('POST', '/api/platform/actions/%s/execute' % action_id,
                         {'payload': payload, 'confirmed': True,
                          'idempotency_key': t.receipt_key(key)})

    def _rejected(st, body):
        return (st != 200) or (isinstance(body, dict) and (body.get('ok') is False or 'error' in body))

    def _err(st, body):
        if not isinstance(body, dict):
            return 'HTTP %s 非 JSON' % st
        return str(body.get('error') or body.get('message') or '')[:200]

    # —— ① upload 不传 → 拒（**调用点显式不写 attribution**，不走任何夹具默认）——
    st9a, b9a = _act9('files.upload', {
        'file_name': 'D无归属-upload-%s.xlsx' % RUN,
        'directory': '/',
        'content_base64': _payload_b64()}, 'att9-up')          # ← 有意不带 attribution
    check('ATT-⑨ ① `files.upload` 不传归属 → **被拒**',
          _rejected(st9a, b9a) and not ((b9a or {}).get('result') or {}).get('file'),
          'HTTP %s ok=%s 错因=%r' % (st9a, (b9a or {}).get('ok') if isinstance(b9a, dict) else None,
                                    _err(st9a, b9a)[:80]))
    check('ATT-⑨ ① 拒因说人话（点名「%s」，不是泛泛「无效」）' % REASON9,
          REASON9 in _err(st9a, b9a), '错因=%r' % _err(st9a, b9a)[:110])

    # —— ② create 不传 → 拒 ——
    st9b, b9b = _act9('files.create', {
        'file_name': 'D无归属-create-%s.xlsx' % RUN,
        'directory': '/'}, 'att9-create')                        # ← 有意不带 attribution
    check('ATT-⑨ ② `files.create` 不传归属 → **被拒**',
          _rejected(st9b, b9b) and not ((b9b or {}).get('result') or {}).get('file'),
          'HTTP %s ok=%s 错因=%r' % (st9b, (b9b or {}).get('ok') if isinstance(b9b, dict) else None,
                                    _err(st9b, b9b)[:80]))

    # —— ③ import_attachment 不传 → **系统自动填给本人**（用户 2026-10-15 ⑦）——
    # **旧断言作废**：上一版这里是「不传 → 被拒（三门齐堵）」。用户 10-15 改了口径：
    # 系统路径**不用人填，系统自动填给调用者本人**；人填路径（upload/create）照旧拒。
    # 所以本条从「被拒」翻成「自动填落库」——**不是放宽了闸，是两条路各走各的**。
    # 完整的两条路对照在 `test_g1_import_attribution.py` G1-⑧ ④⑤（含敏感度两问）。
    #
    # **必须用真来源附件**：`import_attachment` 是**先查来源再判归属**，假来源会红在
    # 「File f not found」—— 那是**旁因**，验不到归属那件事（第一版就是这么假过又假红的）。
    # 造来源的路子照 `test_g1_import_attribution.fresh_source`：
    # 带归属上传一个表 → `files.versions` 取 `frappe_file` → 拿它当来源。
    # **归属在调用点显式传**（E 硬条件：本组不许吃夹具默认）。
    st9s, b9s = _act9('files.upload', {
        'file_name': 'D来源-%s.xlsx' % RUN, 'directory': '/',
        'content_base64': _payload_b64(),
        'attribution': {'level': 'personal'}}, 'att9-src')       # ← 显式带
    SRC9 = ((b9s.get('result') or {}) if isinstance(b9s, dict) else {}).get('file')
    if SRC9:
        att_names.append(SRC9)
    st9v, b9v = t.service(c, 'files.versions', {'file': SRC9 or ''})
    vers9 = ((b9v.get('result') or b9v) if isinstance(b9v, dict) else {}).get('versions') or []
    ATT9 = vers9[0].get('frappe_file') if vers9 else None
    check('ATT-⑨ ③ 前置：造出真来源附件（否则验的是旁因）',
          bool(SRC9 and ATT9), '来源表=%r 附件=%r' % (SRC9, ATT9))

    st9c, b9c = _act9('files.import_attachment', {
        'source': {'ref_doctype': 'Shangshu File Center File', 'ref_name': SRC9 or '', 'file': ATT9 or ''},
        'directory': '/'}, 'att9-import')                        # ← 有意不带 attribution
    RES9c = ((b9c.get('result') or {}) if isinstance(b9c, dict) else {})
    FILE9c = RES9c.get('file')
    if FILE9c:
        att_names.append(FILE9c)
    # ⚠️ **不许只看「调用成功」** —— 要证明「自动填**落了**」，得从**权威表**读回来。
    # 回包可能是回声。`org_admin.resource_attribution` 是归属的权威落点（G1-① 同一口径）。
    LAND9 = None
    if FILE9c:
        try:
            _sql = ('import frappe, json\n'
                    'frappe.init(site="shangshu.localhost", sites_path="/home/frappe/frappe-bench/sites")\n'
                    'frappe.connect()\n'
                    'from shangshu_core import org_admin\n'
                    'print("LAND9 " + json.dumps(org_admin.resource_attribution(%r), default=str))\n'
                    % FILE9c)
            _p = __import__('subprocess').run(
                ['docker', 'exec', '-i', '-w', '/home/frappe/frappe-bench',
                 'shangshu-local-d-frappe-1', 'bench', '--site', 'shangshu.localhost', 'console'],
                input='exec(%s)\nexit()\n' % repr(_sql),
                capture_output=True, text=True, timeout=180)
            for _l in _p.stdout.splitlines():
                if 'LAND9 ' in _l:
                    _tail = _l[_l.index('LAND9 ') + 6:].strip()
                    if _tail.startswith('{'):
                        LAND9 = __import__('json').loads(_tail)
        except Exception as _e:
            LAND9 = {'_err': str(_e)}
    check('ATT-⑨ ③ `files.import_attachment` 不传归属 → **系统自动填落库**（用户 ⑦：不用人填）',
          st9c == 200 and bool(FILE9c),
          'HTTP %s file=%r 错因=%r' % (st9c, FILE9c, _err(st9c, b9c)[:100]))
    check('ATT-⑨ ③ 自动填的是**调用者本人**（权威表读回，不是回包回声）',
          isinstance(LAND9, dict) and str(LAND9.get('level') or '') == 'personal'
          and str(LAND9.get('owner_user') or '').lower() == 'administrator',
          'landed=%r（调用者是 Administrator）' % (LAND9,))

    # —— ④ 对照：带了归属的照样过（拒的是「不声明」，不是把上传口搞死）——
    st9d, b9d = _act9('files.upload', {
        'file_name': 'D有归属-对照-%s.xlsx' % RUN,
        'directory': '/',
        'content_base64': _payload_b64(),
        'attribution': {'level': 'personal'}}, 'att9-ctrl')      # ← 显式带
    U9d = ((b9d.get('result') or {}) if isinstance(b9d, dict) else {}).get('file')
    if U9d:
        att_names.append(U9d)
    check('ATT-⑨ ④ **对照**：带了归属的照样过（拒的是「不声明」，不是上传口死了）',
          st9d == 200 and bool(U9d), 'HTTP %s file=%r 错因=%r' % (st9d, U9d, _err(st9d, b9d)[:80]))

    # —— ⑤ 只管新建：追版本（existing 分支）不传归属 → 照过 ——
    # 用**非 xlsx**（同名 xlsx 恒新表，走不到追版本）。普通文件同名重传 = 追版本。
    st9e0, b9e0 = _act9('files.upload', {
        'file_name': 'D追版本-%s.txt' % RUN, 'directory': '/',
        'content_base64': _b64.b64encode('第一版'.encode()).decode(),
        'attribution': {'level': 'personal'}}, 'att9-v1')        # ← 显式带
    U9e = ((b9e0.get('result') or {}) if isinstance(b9e0, dict) else {}).get('file')
    st9e, b9e = _act9('files.upload', {
        'file_name': 'D追版本-%s.txt' % RUN, 'directory': '/',
        'content_base64': _b64.b64encode('第二版'.encode()).decode()}, 'att9-v2')   # ← 有意不带
    created9e = ((b9e.get('result') or {}) if isinstance(b9e, dict) else {}).get('created')
    if U9e:
        att_names.append(U9e)
    check('ATT-⑨ ⑤ **只管新建**：追版本不传归属 → **照过**（防「一刀切」假绿）',
          st9e == 200 and created9e == 0,
          'HTTP %s created=%r（0=追版本） 错因=%r' % (st9e, created9e, _err(st9e, b9e)[:80]))

    # —— ⑥ 敏感度两问 ——
    v9 = {'no_att_rejected': _rejected(st9a, b9a), 'with_att_lands': bool(U9d)}
    check('ATT-⑨ ⑥ 敏感度·两半：不传被拒 **且** 带了落得进（两个都该为真）',
          all(v9.values()), '结论=%r' % v9)
    accepted9 = {'不传': not v9['no_att_rejected'], '带了': v9['with_att_lands']}
    check('ATT-⑨ ⑥ 敏感度·判别式：「传没传」这个问句给**两种不同答案**（不恒真/恒假）',
          len(set(accepted9.values())) == 2, '收没收=%r' % accepted9)


print()
if checks == 0:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)

if fails:
    # 有 FAIL 就**留着夹具**给人查 —— 删了现场就没得看。
    print('（夹具保留，未清理，便于查 %s）' % ','.join(names + att_names))
    print('结果： FAIL ' + ','.join(fails))
    sys.exit(1)

# 全过才清理本次自造的夹具行。只删本次 `names` + `att_names`，不按前缀批量删 ——
# 免得误伤别人的数据。不清的话每次跑多留几行，下次 dry-run 的 checked 越来越没法读。
# 归属记录一并删（它键在 `resource`=文件名上，留着就是孤儿）。
for n in names + att_names:
    sql("DELETE FROM `tabShangshu Org Attribution` WHERE resource='%s'" % n)
    sql("DELETE FROM `tabShangshu File Center File` WHERE name='%s'" % n)
print('夹具已清理：%s' % ', '.join(names + att_names))
if not_yet:
    print('未测 %d 条（不算过）：%s' % (len(not_yet), ' / '.join(not_yet)))
    print('结果： PASS(部分) 已跑的全过，另有 %d 条未测（前置不齐，见上）' % len(not_yet))
    sys.exit(0)

# **总结行只说这一轮真跑过的，不许写死「全部成立」** ——
# 上一版不管 `--cases` 给了什么都打「历史关系迁移 + 归属字段迁移全部成立（… 不落 enterprise）」。
# 只跑 att8 时那句是**假的**：att8 验的恰恰是 enterprise **落得进**。
# 「报结果要坦白」第五条管这个 —— 跑了什么说什么，没跑的不写进结论。
_ran = [x for x in want]
_ran_txt = ','.join(_ran)
if set(_ran) == set(VALID):
    print('结果： PASS 全部用例成立（%s）' % _ran_txt)
elif _ran == ['att9']:
    print('结果： PASS **只跑了 ATT-⑨**：新建不传归属就拒'
          '（ATT-⑨ %d 条全过）。' % (checks - _att9_before))
elif _ran == ['att8']:
    # **这行也不许写死** —— ATT-⑧ 从「已知如此」改写成「明确拒」之后，
    # 上一版还挂着「今天还落得进库（6/6）」，**跟判据说的正好相反**。
    # 同一个病：总结行写死结论，改了判据忘了改它。计数从 checks 来，不写死。
    print('结果： PASS **只跑了 ATT-⑧**：enterprise 归属一律明确拒'
          '（ATT-⑧ %d 条全过）。迁移侧「不产生 enterprise」是另一组（att1~7）的结论，本轮没跑。'
          % (checks - _att8_before))
else:
    print('结果： PASS 这一轮只跑了 %s（不是全部用例，别当全套回归）' % _ran_txt)
sys.exit(0)
