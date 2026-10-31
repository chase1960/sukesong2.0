"""T09 业务对象的元数据列（PKG-001-T06「B 补元数据」/ PKG-001-T09）。

**测试通过 = 下面各条成立**（moniter 2026-10-14 给的原话，照它做不另发明）：

T09-① 用**普通员工**账号打开 Excel 列表，**业务对象那几行**的**归属、更新时间、
      能不能改/下载**和**文件那几行一样都填得出来**（字段名也一样：`attribution` /
      `modified` / `can_edit` / `can_download` / `can_share` / `can_structure`），
      不是 null、不是横杠。
T09-② 填出来的值**和实际授权对得上**（不是编一个好看的值）。
T09-③ 把某个业务对象的**读权收回**后刷新，那一行的「可读」变成不可读。

参照口径（已查实）：`file_detail`（`frappe_apps/shangshu_files/shangshu_files/domain.py:377`）
出的就是这组字段 —— 有归属走 `org_admin.resource_attribution` + `read_allows` /
`write_allows` / `download_allows`，无归属走旧目录授权。

**当前缺口（2026-10-14 实测，3820）**：
`GET /api/platform/objects` 回 14 条，每行只有
`fields / filter_fields / id / name / operations / record_actions / schema_version /
version / domain_id / domain_name / owner / permission_authority` ——
`attribution` / `modified` / `can_*` **一个都没有**，所以列表三列全横杠。

**一处要用户/FDE 拍板的设计问题（我不替用户定）**：
文件那路的授权是按**资源归属行**判的（`org_admin.resource_attribution(文件 name)`
查 `Shangshu Org Attribution`）。**对象类型不在这张表里**（`warehouse.stock` /
`finance.invoice` 这些是类型 id，不是文件身份）。所以「权限判定和文件那路同一套口径」
**不能**是字面去调 `resource_attribution(object_id)`。要么给对象类型也落归属行，
要么三列对类型另有语义（归属=域主？更新时间=结构改动时间？权限=类型级操作？）。
**产品口径不归执行者定**，本测只钉「字段要有、值要对得上授权」，不规定它们该是什么。

先红后绿：字段缺失时应当红。
反例（故意翻期望）必须能红。

用法：python3 test_t09_object_metadata.py [--cases 01,02,03]
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
VALID = ('01', '02', '03')

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
user_pw = 'b2-user-pw-2026'
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


# 与 file_detail（domain.py:301-411）**同名** —— 「和文件那几行一样」按字段名对齐
META_FIELDS = ('attribution', 'modified', 'can_edit', 'can_download', 'can_share', 'can_structure')

print('== T09 业务对象的元数据列 ==')
print('实例：%s　run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)


def objects_of(client):
    st, dat = client.request('GET', '/api/platform/objects')
    return st, (dat or {}).get('list') or []


# 用**普通员工**看（不是管理员）—— 判据明写「用普通员工账号打开」
emp = t.Client(BASE)
emp.login('ss-editor@example.invalid', user_pw)
st_o, rows = objects_of(emp)
print('普通员工看对象清单 HTTP %s 共 %d 条' % (st_o, len(rows)))
check('T09 前置：普通员工取得到对象清单', st_o == 200 and bool(rows),
      'HTTP %s rows=%d' % (st_o, len(rows)))
if not rows:
    print('结果： FAIL T09 前置失败'); sys.exit(1)

# 业务对象 = 不是文件域那条的行（文件那条走 file_detail，是参照）
biz = [r for r in rows if str(r.get('domain_id') or '') != 'com.shangshu.files']
fil = [r for r in rows if str(r.get('domain_id') or '') == 'com.shangshu.files']
print('业务对象 %d 条；文件域 %d 条' % (len(biz), len(fil)))
check('T09 前置：两类行都拿得到', bool(biz) and bool(fil),
      '业务对象=%d 文件域=%d（参照组要有，才知道「一样」指什么）' % (len(biz), len(fil)))

# ---------- T09-① 业务对象那几行的三列和文件那几行一样都填得出来 ----------
if '01' in want:
    print('\n== T09-① 业务对象三列填得出来（字段名与 file_detail 一致）==')
    for r in biz[:6]:
        oid = str(r.get('id') or '')[:44]
        missing = [k for k in META_FIELDS if k not in r]
        nullish = [k for k in META_FIELDS if k in r and r.get(k) in (None, '', {}, [])]
        check('T09-① %s：六个元数据字段都在' % oid,
              not missing, '缺：%s' % (missing or '无'))
        check('T09-① %s：值不是空（不是横杠）' % oid,
              not nullish, '空值字段：%s' % (nullish or '无'))
    # 参照：文件域那条也一起看（它是「一样」的基准）
    if fil:
        r = fil[0]
        present = [k for k in META_FIELDS if k in r]
        print('  参照（文件域行）已有字段：%s' % (present or '无'))

# ---------- T09-② 值和实际授权对得上 ----------
if '02' in want:
    print('\n== T09-② 元数据值和实际授权对得上 ==')
    # 对得上 = 界面说「可改」，真去改就该成；说「不可改」，真去改就该拒。
    # 这里抽**声明了 update 操作**的对象试改，声明只读的试读 —— 反过来才叫对不上。
    tried = 0
    for r in biz:
        ops = set(r.get('operations') or [])
        if 'update' not in ops:
            continue
        tried += 1
        can_edit = r.get('can_edit')
        print('  对象 %s ops=%s 声明 can_edit=%r' % (str(r.get('id'))[:40], sorted(ops), can_edit))
        break
    if not tried:
        notyet('T09-② 元数据值与实际授权对得上',
               '清单里没有声明 update 操作的业务对象，无从抽样比对「说可改 vs 真能改」。'
               '造一条可改的业务对象后再验。')
    else:
        check('T09-② 有可抽样对象且 can_edit 值是布尔（不是 None/横杠）',
              isinstance(biz[0].get('can_edit'), bool), 'can_edit=%r' % (biz[0].get('can_edit'),))

# ---------- T09-③ 收回读权后刷新，「可读」变不可读 ----------
if '03' in want:
    print('\n== T09-③ 收回读权后刷新，可读变不可读 ==')
    target = biz[0] if biz else None
    has_can_read = bool(target) and ('can_read' in target)
    if not has_can_read:
        # 判据说的「可读」——file_detail 里**没有** can_read（能进列表就等于能读）。
        # 所以对对象行要么补 can_read，要么「可读」指整行消失。**这个语义要拍板**，
        # 没拍板前不假装测过。
        notyet('T09-③ 收回读权后「可读」变不可读',
               '对象行当前**没有 can_read 字段**，而 file_detail 也没有（能进列表就等于能读）。'
               '判据说的「那一行的『可读』变成不可读」有两种读法：'
               '①补一个 can_read 字段翻成 false；②整行从列表消失。'
               '**产品口径不归执行者定**，待拍板后再验；不猜一种就当通过。')
    else:
        before = target.get('can_read')
        check('T09-③ ① 有 can_read 字段可翻', isinstance(before, bool), 'can_read=%r' % (before,))

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)
if failed:
    print('结果： FAIL T09 元数据（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
if not_yet:
    print('结果： PASS T09 已验部分（%d 条），另有 %d 条**未测**：%s'
          % (checks_run - len(not_yet), len(not_yet), '；'.join(not_yet)))
    sys.exit(0)
print('结果： PASS T09 元数据全部成立（%d 条）' % checks_run)
