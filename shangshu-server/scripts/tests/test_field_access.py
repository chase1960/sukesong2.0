"""字段级有效权限判定源（PKG-001-T09 公共部分）的判据。

**任务归属**：001-T09 的 **B 半** —— 字段级**判定这个公共机制**（通用，不绑文件域）。
另一半「组织/公共空间权限的落实与页面接入」归 A，**不在此重复做**。
D 的 F 族判据（金额可读不可改 / 客户意见可读可改 / 受限备注不可读 /
有导出资格但缺一字段读权 → 拒整文件）等这个口。

**为什么单独成文件、不并进 test_org_matrix.py**：那边是走 HTTP 的集成矩阵
（M1~M11，要起 3820、要造七个身份），而这条是**纯判定规则**——
和 `replay_guard.py` / `test_guard_dispatch.py` 同一个载体：
「单独成模块是为了能脱离 frappe 运行时直接测这条派发约定本身」。
公共工具（登录/造样本/解析）在这里一次都没重建。

**测试通过 = 下面每条都成立**：

FA-01 金额类字段「可读不可改」：`read_roles` 有角色、`write_roles` **显式写 `[]`** →
       **读权过、写权拒**。反例：换一个标了 `write_roles` 的字段必须能写，
       否则是「一律拒写」的空判据。
FA-02 客户意见类字段「可读可改」：read/write 都标了且角色在内 → **读写都过**。
FA-03 受限备注类字段「不可读」：`read_roles` 里没有该角色 → **读权拒**，
       且理由里点名是**哪个字段**（不是泛泛一句没权限，否则无从定位）。
FA-04 下载是**独立维度**：有读权不等于有下载权 —— `download_roles` 显式写 `[]`
       的字段，有导出资格的人也**下不了**（用户 2026-10-12「不因可见就可导出」）。
FA-05 缺一字段读权 → **报出缺口**：`field_gaps` 必须回**具体缺哪几个字段**，
       不是回 true/false —— D 要拿这份名单在报错里点名，用户才看得懂。
FA-06 未声明规则的字段**不限制**（与既有 `model_records._fields` 语义一字一致，
       不是新发明的默认）；反例：声明了就按声明判，证明不是「永远放行」。
       ⚠️ **要拒就显式写 `[]`，漏写 = 不限** —— 这是既有约定，本模块不改它
       （改了会把存量单边声明的字段当场锁死，实测 3820 上就有一条）。
FA-07 System Manager 照旧旁路（既有语义，不改）。
FA-08 判定**按次算、不缓存**：同一字段同一人，两次传不同角色集结果不同 ——
       这就是「撤权后立即失效」的机制保证（角色每次由调用方现取现传）。
FA-09 `need` 只认 read/write/download 三种，别的明确拒（不静默当成 read）。
FA-10 **配置期体检**揪单边声明：只写了 `read_roles` 没写 `write_roles`（或反过来）→
       报出来。因为「漏写 = 不限」是既有约定，漏写就是**脚枪**（漏 `write_roles`
       = 人人可改）。实测 3820 上 11 个字段里就有 1 个单边的（`jiaoyan` 只有 write）。
FA-11 **行级读作用域服务端强制**（F12）：`facts.py` 用 `frappe.get_all` 绕过行级 ACL，
       以前授权边界只活在**注释里对调用方的口头约定**（「调用方必须已经把 actor_user
       圈进 filters」）—— 调用方忘一圈，整张审计表就漏出去。判据钉的是**不靠调用方自觉**：
       - ① `scope='self'` 时**强制** `actor_user=本人`，**覆盖**调用方塞的别人
       - ② `scope='all'` 只有管理员可用，非管理员明确拒
       - ③ scope 只认 self/all，别的明确拒（不静默当成 self）
       - ④ 反例：管理员 `scope='all'` 确实是全部（证明强制不是「一律只看自己」）

先红后绿：`shangshu_core/field_access.py` 尚不存在时应红（import 失败），
不许先实现再补测。
"""
import importlib.util
import os
import sys
import traceback

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
MOD_PATH = os.path.join(ROOT, 'frappe_apps', 'shangshu_core', 'shangshu_core', 'field_access.py')

checks_run = 0
failed = []


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


def notyet(label, why):
    global checks_run
    checks_run += 1
    print('  - %s　—　未测：%s' % (label, why))


print('== 字段级有效权限判定源（001-T09 公共部分）==')
print('模块：%s' % MOD_PATH)

try:
    spec = importlib.util.spec_from_file_location('shangshu_field_access', MOD_PATH)
    fa = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fa)
except Exception as e:
    print('  ✗ 模块加载失败：%s' % e)
    traceback.print_exc()
    print('结果： FAIL 字段级有效权限判定源（模块不存在或加载不了，先红后绿应当如此）')
    sys.exit(1)

allows = getattr(fa, 'field_allows_roles', None)
gaps = getattr(fa, 'field_gaps', None)
check('公共口导出 field_allows_roles / field_gaps', callable(allows) and callable(gaps),
      '拿到 %r / %r' % (allows, gaps))
if not (callable(allows) and callable(gaps)):
    print('结果： FAIL 字段级有效权限判定源')
    sys.exit(1)

# 字段声明形状：与既有 model_records 的 compiled["fields"] 元素同构 ——
# {id, read_roles?, write_roles?, download_roles?}。未出现的规则 = 不限制。
MONEY = {'id': '金额', 'read_roles': ['财务', '业务'], 'write_roles': []}   # 显式 [] = 无人可改
OPINION = {'id': '客户意见', 'read_roles': ['业务'], 'write_roles': ['业务']}
SECRET = {'id': '受限备注', 'read_roles': ['法务']}
VISIBLE = {'id': '摘要', 'read_roles': ['业务'], 'download_roles': []}   # 显式 [] = 不可下载
ALL_FIELDS = [MONEY, OPINION, SECRET, VISIBLE]

BIZ = ['Desk User', '业务']      # 业务员
LEGAL = ['Desk User', '法务']    # 法务

# ---------- FA-01 金额：可读不可改 ----------
print('\n== FA-01 金额「可读不可改」==')
check('FA-01 ① 业务员读金额 → 放行', allows(MONEY, BIZ, 'read') is True, '')
check('FA-01 ② 业务员改金额 → 拒（没标 write_roles）',
      allows(MONEY, BIZ, 'write') is False, '')
# 反例自检：换一个标了 write_roles 的字段必须能写 —— 否则是「一律拒写」的空判据
check('FA-01 ③ 反例自检：标了 write_roles 的字段能写（不是一律拒写）',
      allows(OPINION, BIZ, 'write') is True, '')

# ---------- FA-02 客户意见：可读可改 ----------
print('\n== FA-02 客户意见「可读可改」==')
check('FA-02 ① 业务员读客户意见 → 放行', allows(OPINION, BIZ, 'read') is True, '')
check('FA-02 ② 业务员改客户意见 → 放行', allows(OPINION, BIZ, 'write') is True, '')

# ---------- FA-03 受限备注：不可读 ----------
print('\n== FA-03 受限备注「不可读」==')
ok3 = allows(SECRET, BIZ, 'read') is False
check('FA-03 ① 业务员读受限备注 → 拒', ok3, '')
# 理由要点名字段，不是泛泛一句「没权限」——否则用户无从定位
reason = str(fa.deny_reason(SECRET['id'], 'read'))
check('FA-03 ② 拒绝理由点名是哪个字段', '受限备注' in reason, '理由=%r' % reason)
# 反例自检：法务读得到 —— 否则是「一律拒读」的空判据
check('FA-03 ③ 反例自检：法务读得受限备注（不是一律拒读）',
      allows(SECRET, LEGAL, 'read') is True, '')

# ---------- FA-04 下载是独立维度 ----------
print('\n== FA-04 下载是独立维度（有读权 ≠ 有下载权）==')
check('FA-04 ① 业务员读摘要 → 放行', allows(VISIBLE, BIZ, 'read') is True, '')
check('FA-04 ② 业务员下载摘要 → 拒（没标 download_roles）',
      allows(VISIBLE, BIZ, 'download') is False, '')
# 反例自检：标了 download_roles 的能下载
withdl = {'id': '公开表头', 'read_roles': ['业务'], 'download_roles': ['业务']}
check('FA-04 ③ 反例自检：标了 download_roles 的能下载',
      allows(withdl, BIZ, 'download') is True, '')
# 2026-10-15 用户拍板 (c)「零声明即拒」：download 未声明 = 拒，**不回落 read_roles**。
# 先前这里写「回落 read_roles（读不到就下不了）」，读侧挡住了导出侧也挡住了 —— 但那是
# **靠读权顺带挡的**，不是下载自己拒。现在下载自己拒，读权不再被拿来当下载的替身。
check('FA-04 ④ 未声明 download_roles → 下载**拒**（零声明即拒，不回落）',
      allows(SECRET, BIZ, 'download') is False, '')
check('FA-04 ⑤ 能读的人也**不能**下（2026-10-15 拍板：读不自动带出下载）',
      allows(SECRET, LEGAL, 'download') is False,
      '先前这里期望 True（回落 read_roles，能读就能量下）。拍板后改成 False —— '
      '用户 2026-10-12「不因可见就可导出」说的是读不自动带出导出')

# ---------- FA-05 缺口名单 ----------
print('\n== FA-05 缺一字段读权 → 报出具体缺哪几个 ==')
g = gaps(ALL_FIELDS, BIZ, 'read')
check('FA-05 ① 业务员的读缺口点名「受限备注」',
      isinstance(g, list) and '受限备注' in g, '缺口=%r' % (g,))
check('FA-05 ② 缺口不夹带有权字段（金额/客户意见不在内）',
      all(x not in g for x in ('金额', '客户意见')), '缺口=%r' % (g,))
gw = gaps(ALL_FIELDS, BIZ, 'write')
check('FA-05 ③ 写缺口含「金额」（可读不可改）',
      isinstance(gw, list) and '金额' in gw, '缺口=%r' % (gw,))
# 「摘要」只限制**下载**、没限制写（没写 write_roles）→ 不该进写缺口。
# 这条是空判据自检：把「每个限制都算进每一种权」当成期望，就等于没验维度分工。
check('FA-05 ④ 空判据自检：只限下载的字段不进写缺口（维度要分开算）',
      '摘要' not in gw, '写缺口=%r' % (gw,))
gd = gaps(ALL_FIELDS, BIZ, 'download')
check('FA-05 ⑤ 下载缺口点名「摘要」和「受限备注」（受限字段自然也下不了）',
      '摘要' in gd and '受限备注' in gd, '下载缺口=%r' % (gd,))

# ---------- FA-06 未声明规则：read/write 不限，download 拒 ----------
# **两句话分开记**（2026-10-15 用户各拍了一条，别混）：
#   B1「漏写即拒」—— 用户说 **「不该」**，read/write **保持漏写=不限**，不动。
#   B2 零声明 download —— 用户选 **(c) 零声明即拒**，download **漏写=拒**。
print('\n== FA-06 未声明规则：read/write 不限、download 拒 ==')
plain = {'id': '普通列'}
check('FA-06 ① 未声明任何规则 → 读写不限（B1 用户说「不该」改）、下载拒（B2 选 (c)）',
      allows(plain, BIZ, 'read') is True and allows(plain, BIZ, 'write') is True
      and allows(plain, BIZ, 'download') is False, '')
check('FA-06 ② 反例自检：声明了就按声明判（不是永远放行）',
      allows(SECRET, BIZ, 'read') is False, '')

# ---------- FA-07 System Manager 旁路 ----------
print('\n== FA-07 System Manager 照旧旁路 ==')
admin = ['System Manager']
check('FA-07 管理员读受限备注 / 改金额 / 下载摘要 → 都放行',
      allows(SECRET, admin, 'read') is True and allows(MONEY, admin, 'write') is True
      and allows(VISIBLE, admin, 'download') is True, '')

# ---------- FA-08 按次算、不缓存（撤权后立即失效的机制保证）----------
print('\n== FA-08 判定按次算、不缓存 ==')
first = allows(SECRET, LEGAL, 'read')
second = allows(SECRET, BIZ, 'read')   # 同一字段，换成没权的角色
check('FA-08 同一字段换角色集，结果跟着变（不缓存上次的答案）',
      first is True and second is False, '法务=%r 业务=%r' % (first, second))

# ---------- FA-09 need 只认三种 ----------
print('\n== FA-09 need 只认 read/write/download ==')
try:
    allows(VISIBLE, BIZ, 'delete')
    check('FA-09 ① 未知 need 明确拒', False, '居然放行了')
except Exception as e:
    check('FA-09 ① 未知 need 明确拒', True, '拒因=%s' % e)
check('FA-09 ② 反例自检：三种合法 need 都能算',
      all(allows(VISIBLE, BIZ, n) in (True, False) for n in ('read', 'write', 'download')), '')

# ---------- FA-10 配置期体检：揪单边声明（漏写 = 不限，漏写就是脚枪）----------
print('\n== FA-10 配置期体检揪单边声明 ==')
lint = getattr(fa, 'declare_gaps', None)
if not callable(lint):
    check('FA-10 公共口导出 declare_gaps', False, '拿到 %r' % (lint,))
else:
    one_sided = [
        {'id': '只有读', 'read_roles': ['业务']},        # 🔴 危险方向：人人可改
        {'id': '只有写', 'write_roles': ['业务']},        # ✅ 正当设计：人人可读、特定角色可改
        {'id': '两边都有', 'read_roles': ['业务'], 'write_roles': ['业务']},
        {'id': '什么都没声明'},
    ]
    report = lint(one_sided)
    check('FA-10 ① 只写 read_roles 的揪出来（危险方向：人人可改）',
          any('只有读' in str(x) for x in report), '报告=%r' % (report,))
    # **两个方向不等价** —— 只写 write_roles 是「人人可读、特定角色可改」，正当设计。
    # 一刀切会把好配置判死（实测 3820 的 `jiaoyan` 就是这个形状）。
    check('FA-10 ② 只写 write_roles 的**不当错**（那是正当设计，不是脚枪）',
          not any('只有写' in str(x) for x in report), '报告=%r' % (report,))
    check('FA-10 ③ 两边都有 / 什么都不写的不误报',
          not any('两边都有' in str(x) or '什么都没声明' in str(x) for x in report), '报告=%r' % (report,))

# ---------- FA-11 行级读作用域服务端强制（F12）----------
print('\n== FA-11 行级读作用域服务端强制（不靠调用方自觉）==')
scope_fn = getattr(fa, 'enforced_row_scope', None)
if not callable(scope_fn):
    check('FA-11 公共口导出 enforced_row_scope', False, '拿到 %r' % (scope_fn,))
else:
    ME = 'me@example.invalid'
    OTHER = 'other@example.invalid'

    # ① self 强制覆盖：调用方塞了别人，服务端照样圈成自己
    forced = scope_fn({'actor_user': OTHER, 'action_id': 'x'}, 'self', ME, False)
    check('FA-11 ① scope=self 强制 actor_user=本人，覆盖调用方塞的别人',
          forced.get('actor_user') == ME, '结果=%r' % (forced,))

    # ② 非管理员不许用 all
    try:
        scope_fn({}, 'all', ME, False)
        check('FA-11 ② 非管理员 scope=all 明确拒', False, '居然放行了')
    except Exception as e:
        check('FA-11 ② 非管理员 scope=all 明确拒', True, '拒因=%s' % e)

    # ③ scope 只认 self/all
    try:
        scope_fn({}, 'everyone', ME, True)
        check('FA-11 ③ 未知 scope 明确拒（不静默当成 self）', False, '居然放行了')
    except Exception as e:
        check('FA-11 ③ 未知 scope 明确拒（不静默当成 self）', True, '拒因=%s' % e)

    # ④ 反例：管理员 all 确实是全部 —— 强制不是「一律只看自己」
    whole = scope_fn({'action_id': 'x'}, 'all', ME, True)
    check('FA-11 ④ 反例自检：管理员 scope=all 不强塞 actor_user（确实是全部）',
          'actor_user' not in whole, '结果=%r' % (whole,))

# ---------- FA-12/13 「漏写 = 人人可做」的两道闸（E 的 ①②）----------
print('\n== FA-12/13 漏写 = 人人可做，要闸住、要看得见 ==')
assert_decl = getattr(fa, 'assert_well_declared', None)
open_list = getattr(fa, 'open_by_default', None)
if not callable(assert_decl) or not callable(open_list):
    check('FA-12 公共口导出 assert_well_declared / open_by_default', False,
          '拿到 %r / %r' % (assert_decl, open_list))
else:
    # ① 单边声明 = **硬闸拒启动**（不是提示）
    try:
        assert_decl([{'id': '只有读', 'read_roles': ['业务']}])
        check('FA-12 ① 单边声明 → 硬闸当场拒（不是打印一句提示）', False, '居然放行了')
    except Exception as e:
        check('FA-12 ① 单边声明 → 硬闸当场拒（不是打印一句提示）', True, '拒因=%s' % e)
    # 反例：两边都写 / 什么都没写 / **只写 write_roles**（正当设计）→ 不该被这个闸拦。
    # 闸只管危险方向（read 声明了却漏 write = 人人可改）。
    try:
        assert_decl([{'id': '两边都有', 'read_roles': ['业务'], 'write_roles': ['业务']},
                     {'id': '什么都没写'},
                     {'id': '只有写', 'write_roles': ['业务']}])
        check('FA-12 ② 反例自检：完整声明 / 零声明 / 只写 write_roles（正当）都不被拦', True, '')
    except Exception as e:
        check('FA-12 ② 反例自检：完整声明 / 零声明 / 只写 write_roles（正当）都不被拦', False, '误伤了：%s' % e)

    # ② 「默认开放」清单 —— 人人可做的必须**看得见、数得出来**
    inv = open_list([
        {'id': '全开放列'},
        {'id': '受限列', 'read_roles': ['业务'], 'write_roles': []},
        {'id': '半开放列', 'read_roles': ['业务']},   # 单边：写维度默认开放
    ])
    check('FA-13 ① 零声明字段进「默认开放」清单',
          any('全开放列' in str(x) for x in inv), '清单=%r' % (inv,))
    check('FA-13 ② 单边声明的开放维度也进清单（漏 write_roles = 写维度人人可做）',
          any('半开放列' in str(x) for x in inv), '清单=%r' % (inv,))
    check('FA-13 ③ 完整声明的不进清单（不是一律报）',
          not any('受限列' in str(x) for x in inv), '清单=%r' % (inv,))

# ---------- FA-14 混版报错点名哪一侧旧（PKG-013-T05）----------
print('\n== FA-14 混版报错点名哪一侧旧 ==')
note = getattr(fa, 'version_conflict_note', None)
if not callable(note):
    check('FA-14 公共口导出 version_conflict_note', False, '拿到 %r' % (note,))
else:
    # ① 同键不同版本：要点名**哪一侧旧**，不许只说「版本不同」
    m = str(note('files.action_fact', '1.0.0', '1.1.0'))
    check('FA-14 ① 点名库里那份是旧的（1.0.0 < 1.1.0）', '1.0.0' in m and ('旧' in m or '更早' in m),
          '理由=%r' % m)
    m2 = str(note('files.action_fact', '1.1.0', '1.0.0'))
    check('FA-14 ② 反过来也点名：调用方那份是旧的', '1.0.0' in m2 and ('旧' in m2 or '更早' in m2),
          '理由=%r' % m2)
    check('FA-14 ③ 两侧版本号都要在理由里（不然排查还是两头翻账）',
          '1.0.0' in m and '1.1.0' in m, '理由=%r' % m)
    # ④ 同版本号不同定义（今天踩了两次的那条）—— 没法判谁旧，但要说是「没升版本」
    m3 = str(note('files.import_attachment', '1.2.0', '1.2.0'))
    check('FA-14 ④ 同版本号不硬说谁旧，改成点名「定义变了却没升版本」',
          '升' in m3 or '没升' in m3 or '不一致' in m3, '理由=%r' % m3)
    # 查的是「谎称某侧旧」那种句式（「…那份 比 …那份 **旧**」），不是单个「旧」字 ——
    # 「别覆盖旧定义」里的旧不构成谎称。判据糙了会把正确的报因也判红。
    check('FA-14 ⑤ 反例自检：同版本号的不谎称某侧旧（不出现「…那份 比 …」的句式）',
          '那份' not in m3 and '比' not in m3, '理由=%r' % m3)

# ---------- FA-15 闸必须**装在加载路径上**（不是留个函数等人手动调）----------
print('\n== FA-15 闸装在加载路径上（没接线就红）==')
# 为什么必须有这条：FA-12/13 测的是「闸喂进坏输入会不会红」，**测不出闸有没有装上**。
# 实测踩过：assert_well_declared / open_by_default 全库没有调用方 ——
# 闸函数存在，但没门框；手动调一次 = 又变回提示，只是提示的形状变了。
# 所以这条查**加载路径上真的调了它**，把调用摘掉就必须红。
MODEL_RECORDS = os.path.join(ROOT, 'frappe_apps', 'shangshu_core', 'shangshu_core', 'model_records.py')
src = open(MODEL_RECORDS, encoding='utf-8').read()
load_src = src.split('def design_capabilities')[0]   # 只看 _load 那半边
check('FA-15 ① 配置加载路径上调了 assert_well_declared（摘掉就红）',
      'assert_well_declared' in load_src,
      'model_records._load 里没找到 assert_well_declared 调用')
check('FA-15 ② 调用在 `_load` 函数体内，不是飘在 import 层',
      '_load' in load_src and load_src.index('assert_well_declared') > load_src.index('def _load'),
      '')
check('FA-15 ③ 「默认开放」清单落在对外可核的落点（design_capabilities）',
      'open_by_default' in src.split('def design_capabilities')[1]
      if 'def design_capabilities' in src else False,
      '')
# 反例自检：判据确实查的是「调用」不是「定义」—— 只有定义没有调用要红
check('FA-15 ④ 反例自检：光有定义、加载路径没调 → 判红',
      not ('def assert_well_declared' in load_src and 'assert_well_declared(' not in load_src.replace('def assert_well_declared', '')),
      '')

# ---------- FA-16 下载维度：四种声明形状（2026-10-15 用户拍板后）----------
print('\n== FA-16 download 维度四种声明形状（零声明即拒）==')
# **改之前**（2026-10-14 及以前）：download 未声明 → 回落 read_roles；
#   只写 write_roles 或零声明的字段落到 `return True` —— **挡住写的同时把全表下载敞开了**。
# **2026-10-15 用户拍板选 (c)「零声明即拒」**（E 转达原话）：
#   没声明「谁能下载」的字段一律不给下载，不回落、不默认开、不跟着读走。
# 所以下面期望值全改了 —— **别只改实现不改判据**，这条注释就是提醒那个。
SPECS = [
    ('三维都声明', {'id': 'F1', 'read_roles': ['业务'], 'write_roles': ['业务'], 'download_roles': ['业务']}, '业务', True),
    ('只 read_roles', {'id': 'F2', 'read_roles': ['业务'], 'write_roles': []}, '业务', False),
    ('只 write_roles', {'id': 'F3', 'write_roles': ['业务']}, '业务', False),
    ('零声明', {'id': 'F4'}, '业务', False),
]
for label, spec, who, expect in SPECS:
    got = allows(spec, ['Desk User', who], 'download')
    check('FA-16 %s → download=%s（期望 %s）' % (label, got, expect), got is expect, '声明=%r' % (spec,))
# 反例自检：三种「未声明」形状**结果必须和「声明了」不同** —— 否则是「一律拒下载」的空判据
check('FA-16 ⑤ 反例自检：声明了 download_roles 的能下、未声明的不能（两半都得成立）',
      allows({'id': 'F5', 'download_roles': ['业务']}, ['Desk User', '业务'], 'download') is True
      and allows({'id': 'F5b', 'read_roles': ['业务']}, ['Desk User', '业务'], 'download') is False,
      '')
# 关键的那条：**只 write_roles 的下载也拒** —— 先前是「不限」，那正是拍板的那件事
check('FA-16 ⑥ 只 write_roles 的字段，download **拒**（2026-10-15 拍板，先前是不限）',
      allows({'id': 'F6', 'write_roles': ['业务']}, ['Desk User', '随便谁'], 'download') is False,
      '先前这里是 True（挡住写却敞开下载）。拍板后改期望 —— 判据和实现一起动')

# ---------- FA-17 edited_value 多字段按名改写（邮件草稿主题+正文）----------
print('\n== FA-17 edited_value 多字段按名改写 ==')
# **为什么要有这条**：`mail.save_draft` 的载荷是多字段对象（subject/body/to/cc…），
# 而 `_apply_edited_value` 只认单值 —— 邮件审核人要把「主题」和「正文」**分别**改成
# 不同内容时没有口，逼得调用方自己拼 payload（那就绕回直写内核表的老路）。
# 扩的是**按字段名替换**，不是「猜要改哪一格」：字段名是调用方点名的，不猜。
patch = getattr(fa, 'patch_edited_value', None)
if not callable(patch):
    check('FA-17 公共口导出 patch_edited_value', False, '拿到 %r' % (patch,))
else:
    MAIL = {'subject': '原标题', 'body': '原正文', 'to': ['a@x.invalid'], 'body_format': 'Text'}

    # ① 多字段按名改写：两个都换
    out = patch(dict(MAIL), {'subject': {'type': 'text', 'value': '新标题'},
                             'body': {'type': 'text', 'value': '新正文'}})
    check('FA-17 ① 多字段按名改写：主题和正文都换掉',
          out.get('subject') == {'type': 'text', 'value': '新标题'}
          and out.get('body') == {'type': 'text', 'value': '新正文'},
          '结果=%r' % (out,))

    # ② 只改一个 → 其余**保持原样**（不是整份被覆盖）
    out2 = patch(dict(MAIL), {'subject': {'type': 'text', 'value': '只改标题'}})
    check('FA-17 ② 只改一个字段时其余保持原样（正文没被一起覆盖）',
          out2.get('subject') == {'type': 'text', 'value': '只改标题'}
          and out2.get('body') == '原正文' and out2.get('to') == ['a@x.invalid'],
          '结果=%r' % (out2,))
    # 反例自检：换的确实是那个字段，不是恒返回入参（空判据）
    check('FA-17 ② 反例自检：改的字段确实变了（不是恒回原载荷）',
          out2.get('subject') != '原标题', '结果=%r' % (out2,))

    # ③ 字段名不在载荷里 → 明确拒 + 点名那个字段（不静默忽略）
    try:
        patch(dict(MAIL), {'收件人抄送': {'type': 'text', 'value': 'x'}})
        check('FA-17 ③ 不存在的字段名明确拒', False, '居然放行了')
    except Exception as e:
        check('FA-17 ③ 不存在的字段名明确拒', True, '拒因=%s' % e)
    try:
        patch(dict(MAIL), {'收件人抄送': {'type': 'text', 'value': 'x'}})
        reason = ''
    except Exception as e:
        reason = str(e)
    check('FA-17 ③ 理由点名是哪个字段', '收件人抄送' in reason, '理由=%r' % reason)

    # ④ 反例自检：单值形状对**多字段载荷**照旧明确拒（不猜要改哪个字段）
    #    —— 扩展多字段不许把「多格/多字段不猜」这条旧规矩弄松。
    try:
        patch(dict(MAIL), {'type': 'text', 'value': '想改某处'})
        check('FA-17 ④ 单值形状对多字段载荷仍明确拒（不猜）', False, '居然放行了')
    except Exception as e:
        check('FA-17 ④ 单值形状对多字段载荷仍明确拒（不猜）', True, '拒因=%s' % e)

    # ⑤ 混形状（既有 type/value 又夹字段映射）→ 明确拒，不猜是哪种
    try:
        patch(dict(MAIL), {'type': 'text', 'value': 'x', 'body': {'type': 'text', 'value': 'y'}})
        check('FA-17 ⑤ 混形状明确拒（不猜是单值还是字段映射）', False, '居然放行了')
    except Exception as e:
        check('FA-17 ⑤ 混形状明确拒（不猜是单值还是字段映射）', True, '拒因=%s' % e)

    # ⑥ 空 / 非 dict / 值不是带 type 的对象 → 明确拒
    bad_inputs = [({}, '空 dict'), (None, 'None'), ('裸字符串', '裸字符串'),
                  ({'subject': '裸值'}, '值不是带 type 的对象')]
    for bad, label in bad_inputs:
        try:
            patch(dict(MAIL), bad)
            check('FA-17 ⑥ %s 明确拒' % label, False, '居然放行了')
        except Exception as e:
            check('FA-17 ⑥ %s 明确拒' % label, True, '拒因=%s' % e)

    # ⑦ 反例自检：单值形状对**单值载荷**照旧工作（不因扩展把旧的弄坏）
    ok = patch({'value': {'type': 'text', 'value': '原'}}, {'type': 'text', 'value': '新'})
    check('FA-17 ⑦ 单值形状对 value 载荷照旧工作', ok.get('value') == {'type': 'text', 'value': '新'},
          '结果=%r' % (ok,))
    ok2 = patch({'cells': [{'value': {'type': 'text', 'value': '原'}}]},
                {'type': 'text', 'value': '新'})
    check('FA-17 ⑦ 单值形状对单格 cells 载荷照旧工作',
          ok2['cells'][0]['value'] == {'type': 'text', 'value': '新'}, '结果=%r' % (ok2,))
    # 多格照旧拒（那是「猜哪一格」，跟多字段按名不是一回事）
    try:
        patch({'cells': [{'value': 1}, {'value': 2}]}, {'type': 'text', 'value': '新'})
        check('FA-17 ⑦ 多格仍明确拒（按名替换不解除「不猜哪一格」）', False, '居然放行了')
    except Exception as e:
        check('FA-17 ⑦ 多格仍明确拒（按名替换不解除「不猜哪一格」）', True, '拒因=%s' % e)

# ---------- FA-17⑧ 闸必须**装在执行路径上**（没接线就红）----------
print('\n== FA-17⑧ patch_edited_value 装在执行路径上（没接线就红）==')
# 同 FA-15 的道理：光有纯函数、`_apply_edited_value` 没调它 = 又回到「闸函数存在没门框」。
ACTIONS_PY = os.path.join(ROOT, 'frappe_apps', 'shangshu_core', 'shangshu_core', 'actions.py')
asrc = open(ACTIONS_PY, encoding='utf-8').read()
apply_body = asrc.split('def _apply_edited_value')[1].split('\ndef ')[0] if 'def _apply_edited_value' in asrc else ''
check('FA-17⑧ ① _apply_edited_value 调了 patch_edited_value（摘掉就红）',
      'patch_edited_value' in apply_body, 'actions.py 的 _apply_edited_value 里没找到调用')
check('FA-17⑧ ② 反例自检：纯函数有定义但执行路径没调 → 判红',
      not ('def patch_edited_value' in apply_body), '')

# ---------- FA-18 清单要**吐得出来**，而且「没有」和「吐不出」必须分得开 ----------
print('\n== FA-18 open_by_default 回 list，不是 None（没有默认开放 ≠ 吐不出清单）==')
# **为什么要有这条**：FA-15 查的是「源码里有调用」，**没查运行时真吐东西**。
# 今天实撞：`open_by_default` 装进了 `design_capabilities`，FA-15 照绿，
# 但跑起来 `caps.get('open_by_default')` 是 **None**、键根本不在回包里 ——
# 因为**部署没到位**（`cp` 进 /srv/shangshu 不是 Python 读的那份，中间要跑 sync-apps.sh）。
# 纯判据跨不过「部署」那道线，但**能钉形状**：回 list 不回 None，
# 且「查完了确实没有默认开放」（空 list）和「根本没吐清单」（None）**必须分得开**。
open_fn = getattr(fa, 'open_by_default', None)
if not callable(open_fn):
    check('FA-18 公共口导出 open_by_default', False, '拿到 %r' % (open_fn,))
else:
    out = open_fn([
        {'id': '全开放列'},
        {'id': '受限列', 'read_roles': ['业务'], 'write_roles': [], 'download_roles': []},
    ])
    check('FA-18 ① 回的是 list（不是 None / 不是 dict）', isinstance(out, list),
          '实际类型=%r 值=%r' % (type(out).__name__, out))
    check('FA-18 ② 有默认开放时清单非空（确实数得出条目）', len(out) > 0, '清单=%r' % (out,))
    # **关键反例**：全部声明死的字段集 → 回**空 list**，不是 None。
    # 今天撞见的 None 是「没吐清单」，跟「查了、确实没有」是两回事 ——
    # 混成一个值，配置方就分不出「这个模型很干净」和「这个模型压根没体检」。
    clean = open_fn([{'id': '甲', 'read_roles': ['业务'], 'write_roles': [], 'download_roles': []}])
    check('FA-18 ③ 全收住的字段集回**空 list**（不是 None）',
          isinstance(clean, list) and clean == [], '实际=%r 类型=%r' % (clean, type(clean).__name__))
    check('FA-18 ④ 空 list 与 None 分得开（「没有默认开放」≠「吐不出清单」）',
          clean is not None and clean == [], '实际=%r' % (clean,))
    # 形状自检：清单条目是**人看得懂的话**，不是裸字段名/裸字典 ——
    # FA-13 只查「名字在不在里面」，没查条目长什么样。配置方要照着对账，得读得懂。
    check('FA-18 ⑤ 清单条目是可读的话（含字段名和维度）',
          all(isinstance(x, str) and '列' in x for x in out),
          '条目=%r' % (out,))
    # 反例自检：不是「永远回空」—— FA-18②⑤ 已经证明有内容时非空，
    # 这里再钉一次「换输入换输出」，防它变成常量
    check('FA-18 ⑥ 反例自检：换输入换输出（不是恒回同一份清单）',
          open_fn([{'id': '另一个'}]) != out, '')

# ---------- FA-19 归属映射：owner_subject_* → attribution（公共一份，C/D 共用）----------
print('\n== FA-19 归属映射（谁是谁，值填哪；不发明用户没定的）==')
# **为什么要公共一份**：文件域（`owner_subject_kind`/`owner_subject`）和邮件域都要翻译成
# 内核归属三元组。各写一份 = 各说各的「Employee 算什么」，早晚分叉。
# 判定口径在契约 §3.5，**依据是用户已定的，不是猜的**：
#   · `账号与权限.md` §3 第 7 条（2026-10-10）：老板=全企业、负责人=辖内、个人级不向管理者保密
#   · 同文件 :192 第 5 条（2026-10-13）：**「历史不明归属保持既有权限并待核，不批量填企业归属」**
#     —— 这条把「落一个默认 enterprise」(b) 直接排掉了，**不许映射发明 enterprise**。
mapfn = getattr(fa, 'map_owner_subject', None)
if not callable(mapfn):
    check('FA-19 公共口导出 map_owner_subject', False, '拿到 %r' % (mapfn,))
else:
    # ① Employee → personal（owner_subject 填 owner_user）
    lv, dept, own = mapfn('Employee', 'emp-001')
    check('FA-19 ① Employee → personal，owner_subject 进 owner_user',
          lv == 'personal' and dept in (None, '') and own == 'emp-001',
          '结果=%r' % ((lv, dept, own),))

    # ② Department → department（owner_subject 填 department）
    lv, dept, own = mapfn('Department', 'dept-9')
    check('FA-19 ② Department → department，owner_subject 进 department',
          lv == 'department' and dept == 'dept-9' and own in (None, ''),
          '结果=%r' % ((lv, dept, own),))

    # ③ **绝不发明 enterprise** —— 用户 2026-10-13「不批量填企业归属」
    #    （`账号与权限.md:192` 第 5 条）。文件域那套里 enterprise **没有来源**，
    #    映射不许凭空造一个。
    for bad_kind, label in [(None, '空类型'), ('', '空串类型'), ('Enterprise', '企业类型'),
                            ('enterprise', '小写企业'), ('Team', '没定义的类型')]:
        try:
            mapfn(bad_kind, 'whatever')
            check('FA-19 ③ %s 明确拒（不发明 enterprise）' % label, False, '居然放行了')
        except Exception as e:
            check('FA-19 ③ %s 明确拒（不发明 enterprise）' % label, True, '拒因=%s' % e)

    # ④ 缺 ID 明确拒（Employee/Department 都要有归属对象，不猜一个）
    for kind in ('Employee', 'Department'):
        for empty in (None, '', '   '):
            try:
                mapfn(kind, empty)
                check('FA-19 ④ %s 缺 ID 明确拒（收到 %r）' % (kind, empty), False, '居然放行了')
            except Exception as e:
                check('FA-19 ④ %s 缺 ID 明确拒（收到 %r）' % (kind, empty), True, '拒因=%s' % e)

    # ⑤ **反例自检**：两种合法类型的结果**不相同**（不是恒回一个值）
    a = mapfn('Employee', 'x')
    b = mapfn('Department', 'x')
    check('FA-19 ⑤ 反例自检：Employee / Department 结果不同（不是恒回同一个）', a != b,
          'Employee=%r Department=%r' % (a, b))

    # ⑥ ID 保留原样（不改大小写、不猜格式）—— 归属人 ID 要跟权威表对得上，改了就串人
    lv, dept, own = mapfn('Employee', 'Staff.One@Example.COM')
    check('FA-19 ⑥ ID 原样保留（不改大小写、不 trim 语义）', own == 'Staff.One@Example.COM',
          '结果=%r' % (own,))

# ---------- FA-19⑦ 映射**不改判定口径**：撤权判当前权限，不判入库时归属 ----------
print('\n== FA-19⑦ 撤权判「当前权限」，不判「入库时归属」==')
# **用户已定**（`账号与权限.md` 多处，E 核过六条原文）：
#   :40  有效性 = **当前**授权、资源归属与记录状态；权限撤销、人员调动、提案过期…
#   :137 调岗或撤权后…**不能携旧授权继续写**；已经完成的历史事实保留
#   :154 人员调岗、取消负责人、删除共享后确认旧提案 → **当前读取与写入权失效**
# 所以答案是**两条不是二选一**：动手时判当前权限，做完的事保留但不作放行依据。
#
# 这条钉的是**映射模块里不许有「入库时快照」的缓存/常量** ——
# 映射只负责「字段怎么对应」，判定权不在它这。谁在这里加缓存谁就把撤权弄没了
# （同 FA-08 的道理：判定按次算、不缓存）。
import inspect as _inspect
_mapsrc = _inspect.getsource(mapfn) if callable(mapfn) else ''
# ⚠️ **先判源码非空**：函数不存在时 `_mapsrc` 是空串，`not any(...)` 恒真 ——
# 那是「绿得没信息量」（今天踩过多次的那族）。空判据必须自己先堵掉。
_has_src = callable(mapfn) and bool(_mapsrc.strip())
_cache_words = [k for k in ('_CACHE', 'lru_cache', 'memoize', 'snapshot', 'cached') if k in _mapsrc]
_touches_runtime = [k for k in ('frappe.', 'db.') if k in _mapsrc]
check('FA-19⑦ ⓪ 先确认真拿到源码（不然下面两条恒真）',
      _has_src, '源码长度=%d 字节（0 = 空判据）' % len(_mapsrc))
check('FA-19⑦ ① 映射函数里没有缓存/快照（不钉入库时归属）',
      _has_src and not _cache_words, '命中的缓存/快照字样=%r（空=干净）' % (_cache_words,))
check('FA-19⑦ ② 映射是纯翻译（不读 frappe，不查库）',
      _has_src and not _touches_runtime, '命中的运行时/库字样=%r（空=干净）' % (_touches_runtime,))

# ---------- FA-20 零声明 download = 拒（用户 2026-10-15 选 (c)）----------
print('\n== FA-20 零声明 download 即拒（不再回落 read_roles）==')
# **用户 2026-10-15 原话选 (c)「零声明即拒」**（E 转达）：
#   没声明「谁能下载」的字段，一律不给下载。
# **改之前的语义**：download 未声明 → 回落 read_roles（读得到就下得了）。
# **改之后**：download 未声明 → **拒**，不回落、不默认开。
# 边界（E 补）：「部门级表默认部门内有下载资格」那句**仍成立，但只在有声明时**；
# 零声明就是拒。**read/write 不动** —— B1 用户说「不该」改成漏写即拒，保持现状。
#
# 这几条**先红**：当前实现还在回落，跑起来就是 FAIL。产品改完才绿。
_fa20_declared_none = {'id': '零声明下载', 'read_roles': ['业务']}          # 有 read 没 download
_fa20_plain = {'id': '啥也没写', 'id2': None}                              # 完全没声明
_fa20_declared = {'id': '写了下载', 'read_roles': ['业务'], 'download_roles': ['业务']}

check('FA-20 ① 未声明 download_roles（但有 read_roles）→ 下载**拒**，不回落',
      allows(_fa20_declared_none, BIZ, 'download') is False,
      '当前=%r（True 就说明还在回落）' % allows(_fa20_declared_none, BIZ, 'download'))
check('FA-20 ② 反例自检：声明了 download_roles 的能下载（不是一律拒下载）',
      allows(_fa20_declared, BIZ, 'download') is True,
      '当前=%r（False 就说明改成了恒拒，那是空判据）' % allows(_fa20_declared, BIZ, 'download'))
check('FA-20 ③ 完全没声明 → download 也拒（零声明即拒）',
      allows(_fa20_plain, BIZ, 'download') is False,
      '当前=%r' % allows(_fa20_plain, BIZ, 'download'))
check('FA-20 ④ read 不受影响（B1 用户说「不该」改，保持漏写=不限）',
      allows(_fa20_declared_none, BIZ, 'read') is True,
      '当前=%r（False 就说明把 read 也收紧了，越界了）' % allows(_fa20_declared_none, BIZ, 'read'))
check('FA-20 ⑤ write 不受影响（同 B1）',
      allows(_fa20_declared_none, BIZ, 'write') is True,
      '当前=%r' % allows(_fa20_declared_none, BIZ, 'write'))
check('FA-20 ⑥ System Manager 旁路照旧（不是把旁路也关了）',
      allows(_fa20_plain, ['System Manager'], 'download') is True,
      '当前=%r' % allows(_fa20_plain, ['System Manager'], 'download'))

# ---------- FA-21 归属层级只认 personal / department（用户 2026-10-15）----------
print('\n== FA-21 归属层级：只认 personal / department，绝不发明 enterprise ==')
# **用户 2026-10-15 原话**（E 转达）：「**尚书是单例，没有企业归属。**」
#   不是「(a)/(c) 选哪条」，是**那个桶压根不该存在**。
#
# **但要改的不止「显式传」那条** —— `org_admin.py:255-257` 有条兜底：
#   level 没给 → department 在场就 department、owner_user 在场就 personal、**否则 `else "enterprise"`**。
# **那条 else 就是「落一个默认 enterprise」**，用户明令禁止的。3820 库里那 9 行
# （department/owner_user 全 NULL）形状对得上，是它造的，不是谁故意传的。
#
# **前置查过**（动它之前必做）：兜底前两条（department/personal 推断）**有测试依赖**
# （`test_b1_org.py:123`/`:163` 不传 level 只给 department），
# **`else "enterprise"` 那条没有任何东西依赖** —— 所以只删 else，前两条留着。
#
# **纯函数**（同 `map_owner_subject` 的路子：不碰 frappe、能脱离运行时测）。
# **先红**：函数还不存在，跑起来就是 FAIL。
_lvl = getattr(fa, 'attribution_level', None)

check('FA-21 ⓪ 先确认函数真在（不在的话下面全空判据）',
      callable(_lvl), 'attribution_level=%r（None=还没写，下面必然全红）' % (_lvl,))

if callable(_lvl):
    # 两种合法层级
    check('FA-21 ① personal 原样过', _lvl('personal') == 'personal', '')
    check('FA-21 ② department 原样过', _lvl('department') == 'department', '')
    # 反例自检：两种结果不同（不是恒回同一个）
    check('FA-21 ③ 反例自检：两种合法层级结果不同',
          _lvl('personal') != _lvl('department'), '')
    # ⛔ 绝不发明 enterprise —— 显式传也拒
    for _bad in ('enterprise', 'Enterprise', 'ENTERPRISE', '团队', 'Team', 'org', ''):
        try:
            _got = _lvl(_bad)
            _rej = False
        except Exception as _e:
            _got = 'REJECT:%s' % str(_e)[:50]
            _rej = True
        check('FA-21 ④ 显式传 %r → 明确拒' % (_bad,), _rej, '实得=%r' % (_got,))
    # ⛔ 没给 level 时的兜底：前两条推断要留着（test_b1_org 依赖），else 必须拒
    check('FA-21 ⑤ 没给 level、给了 department → 推断成 department（留着，有测试依赖）',
          _lvl(None, department='d1') == 'department', '')
    check('FA-21 ⑥ 没给 level、给了 owner_user → 推断成 personal（同上）',
          _lvl(None, owner_user='u1') == 'personal', '')
    try:
        _got = _lvl(None)
        _rej = False
    except Exception as _e:
        _got = 'REJECT:%s' % str(_e)[:50]
        _rej = True
    check('FA-21 ⑦ **什么都没给 → 明确拒，绝不落 enterprise**（根因那条 else）',
          _rej, '实得=%r（若=\'enterprise\' 就是兜底还在）' % (_got,))
    # 拒因要点名是「企业归属」这层不存在，不是泛泛一句
    try:
        _lvl('enterprise')
        _why = '(没拒)'
    except Exception as _e:
        _why = str(_e)
    check('FA-21 ⑧ 拒因点名「没有企业归属」（不是泛泛「无效」）',
          ('企业' in _why or 'enterprise' in _why.lower()), '拒因=%r' % _why[:80])
else:
    for _i in range(8):
        check('FA-21 ①～⑧（函数不在，跳过）', False, 'attribution_level 还没写')

# ---------- FA-21 ⑨⑩⑪ 接线：闸装上没（不是「函数存在」就算）----------
# **「闸函数存在 ≠ 闸装上」** —— 同 FA-15 / B6-07 的道理。
# 函数写好了没人调，等于没改。查的是**两个写入口真调了它**。
print('\n== FA-21 ⑨⑩⑪ 两个写入口真调了 attribution_level ==')
_org_path = os.path.join(ROOT, 'frappe_apps', 'shangshu_core', 'shangshu_core', 'org_admin.py')
_org_src = open(_org_path, encoding='utf-8').read()


def _code_only(src):
    """剥掉 `#` 注释再判 —— **自己写的注释会绊倒自己写的判据**。

    实测踩过：我给 `resource_assign` 写的解释注释里带着旧代码的字面
    `else "enterprise"`（「改之前这里是 …」），⑨ 的子串判据当场当成真代码。
    「自己写进契约的字污染日后的搜索」在判据里的版本就是这个。
    所以判「还有没有那个兜底」只看**代码**，不看注释。
    """
    return "\n".join(line.split('#', 1)[0] for line in src.splitlines())


_rsrc = _org_src.split('def resource_assign')[1].split('\ndef ')[0] if 'def resource_assign' in _org_src else ''
_arec = _org_src.split('def attribution_record')[1].split('\ndef ')[0] if 'def attribution_record' in _org_src else ''
_rsrc_code = _code_only(_rsrc)
_fallback_left = ('else "enterprise"' in _rsrc_code) or ("else 'enterprise'" in _rsrc_code)
check('FA-21 ⑨ resource_assign 走 attribution_level（不是自己兜底）',
      'attribution_level' in _rsrc and not _fallback_left,
      'resource_assign 里调用=%s / 还有 else enterprise 兜底=%s'
      % ('attribution_level' in _rsrc, _fallback_left))
check('FA-21 ⑩ attribution_record 写入前也校验（下游兜底，不是只靠上游）',
      'attribution_level' in _arec,
      'attribution_record 里调用=%s —— 只靠上游就是「上游不产生≠下游不收」那个洞'
      % ('attribution_level' in _arec,))
# 反例自检：查的是**函数体里**，不是「文件里出现过」（同 B6-07 ③）
check('FA-21 ⑪ 反例自检：查的是函数体里调用，不是文件里出现过',
      'attribution_level' in _rsrc and 'attribution_level' in _arec
      and _org_src.count('attribution_level') >= 2,
      '全文件出现次数=%d（≥2 = 两个函数体各一处）' % _org_src.count('attribution_level'))

# ---------- FA-21 ⑫⑬ 另两道闸也得关（不止 org_admin 一个口）----------
# **「上游不产生 ≠ 下游不收」** —— 同一个下游有两个门：
#   · DocType 自己的 `validate` —— 第三道闸，先前还把 enterprise 当合法写在白名单里
#   · `install.py` 的 action schema `level` enum —— schema 层的口，先前也带着 enterprise
# 两处都是「贴假标」：文案写着「没有企业归属」，闸却还放。所以文案跟行为一起改。
print('\n== FA-21 ⑫⑬ DocType validate 与 install.py schema 两道闸也关上 ==')
_dt_path = os.path.join(ROOT, 'frappe_apps', 'shangshu_core', 'shangshu_core', 'shangshu_core',
                        'doctype', 'shangshu_org_attribution', 'shangshu_org_attribution.py')
_dt_src = open(_dt_path, encoding='utf-8').read()
_dt_code = _code_only(_dt_src)
check('FA-21 ⑫ DocType validate 走 attribution_level（不是自己列三元组）',
      'attribution_level' in _dt_src
      and not ('"personal", "enterprise", "department"' in _dt_code
               or "'personal', 'enterprise', 'department'" in _dt_code),
      'validate 调用=%s / 自己列的旧三元组还在=%s'
      % ('attribution_level' in _dt_src,
         ('"personal", "enterprise", "department"' in _dt_code
          or "'personal', 'enterprise', 'department'" in _dt_code)))
_ins_path = os.path.join(ROOT, 'frappe_apps', 'shangshu_core', 'shangshu_core', 'install.py')
_ins_src = open(_ins_path, encoding='utf-8').read()
_ins_code = _code_only(_ins_src)
_ins_block = _ins_code.split("register_action('platform.org.resource_assign'")[1].split('register_action(')[0] \
    if "register_action('platform.org.resource_assign'" in _ins_code else ''
# 约束**两种合法形态都认**：enum 只含 personal/department，或 description 承载口径
# （后者是 D 的取舍：写 enum 会被 schema_validation 通用文案先拦掉，用户口径到不了眼前）。
# 只查「不含 enterprise」不够 —— 约束删光了也绿。所以**约束得在**：两个合法层级得点名。
_no_ent = ("'enterprise'" not in _ins_block) and ('"enterprise"' not in _ins_block)
_names_both = ('personal' in _ins_block) and ('department' in _ins_block)
_has_constraint = ('enum' in _ins_block) or ('description' in _ins_block)
check('FA-21 ⑬ install.py 的 resource_assign schema：level 不收 enterprise、且约束真在',
      _no_ent and _names_both and _has_constraint,
      '不含 enterprise=%s / 点名两级=%s / 有约束=%s —— 缺任一条=闸没关严'
      % (_no_ent, _names_both, _has_constraint))
check('FA-21 ⑬′ 反例自检：version 升到 2.0.0（删原本合法值=破坏兼容=大版本，D 2026-10-15）',
      "'2.0.0'" in _ins_block or '"2.0.0"' in _ins_block,
      '版本号该是 2.0.0 —— 1.2.0 传「老的照旧能用」的假信号')

# ---------- FA-22 逐列有效能力（G2 / 接口契约 :430）----------
# **契约原文**（`接口契约.md:430`）：「打开表/范围读取返回当前用户可读的值和执行操作
# 所必需的**逐列有效能力/限制**……前端据此呈现只读/可编辑/部分可编辑」。
# **`:431`**：「元数据、读接口、写动作及导出**复用同一受管权限来源**；后端不信客户端
# 提交的权限结果」。
#
# **现状缺口**（探子 2026-10-15 核出，G2）：`files.sheet_read` 的 output_schema 只有
# `table/headers/rows`，**没有任何能力键**。前端不知道哪列能改，只能全当可编辑或全当只读。
#
# **D 的 F 族也等这个**（F-① 同表不同字段权限 / F-② 导出闸 / F-④ 部分撤权整拒）——
# 但 F 族是**消费方适配**（D 的文件域接线），本条先交**公共判定源**。
#
# **测试通过 =** 下面每条成立：
#   ⓪ 函数真在（不在的话下面全空判据）
#   ① 回逐列能力，字段 id 能查到 read/write/download 三个布尔
#   ② **正例**：有权的列该给 True（不是一律拒）
#   ③ **反例**：无权的列该给 False + 能点名理由（不是一律放行）
#   ④ 同表不同字段给不同结论（F-①：不是整表一刀切）
#   ⑤ download 独立于 read（零声明 download=拒，但 read 照旧 —— 10-15 拍板）
#   ⑥ **反例自检**：两种角色集给出不同结论（不是恒真/恒假）
#   ⑦ 模块 docstring 不许再写「download 回落 read_roles」（贴假标债 —— 行为早改成零声明即拒）
print('\n== FA-22 逐列有效能力（契约 :430，D/A 的消费面）==')
_caps = getattr(fa, 'field_capabilities', None)
check('FA-22 ⓪ 先确认函数真在（不在的话下面全空判据）',
      callable(_caps), 'field_capabilities=%r（None=还没写，下面必然全红）' % (_caps,))

if callable(_caps):
    _f22_fields = [
        {'id': '金额', 'read_roles': ['财务'], 'write_roles': ['财务'], 'download_roles': ['财务']},
        {'id': '客户意见', 'read_roles': ['客服'], 'write_roles': ['客服']},
        {'id': '内部备注', 'read_roles': [], 'write_roles': []},
    ]
    _c22 = _caps(_f22_fields, ['财务'])
    check('FA-22 ① 回逐列能力，字段 id 查得到 read/write/download 三个布尔',
          isinstance(_c22, dict) and set(_c22) == {'金额', '客户意见', '内部备注'}
          and all(set(v) == {'read', 'write', 'download'}
                  and all(isinstance(v[k], bool) for k in v) for v in _c22.values()),
          '实得=%r' % (_c22,))
    # 正例：财务对「金额」三个维度都有权
    check('FA-22 ② **正例**：有权的列给 True（金额/财务 三维都有声明且含该角色）',
          _c22.get('金额') == {'read': True, 'write': True, 'download': True},
          '金额实得=%r' % (_c22.get('金额'),))
    # 反例：财务对「内部备注」（read_roles: []）无权
    check('FA-22 ③ **反例**：无权的列给 False（内部备注 read_roles=[] 显式拒）',
          _c22.get('内部备注') == {'read': False, 'write': False, 'download': False},
          '内部备注实得=%r' % (_c22.get('内部备注'),))
    # F-①：同表不同字段给不同结论 —— 一刀切会全 True 或全 False
    _vals = [tuple(sorted(v.items())) for v in _c22.values()]
    check('FA-22 ④ 同表**不同字段给不同结论**（F-①，不是整表一刀切）',
          len(set(_vals)) >= 2, '三种字段的结论集合=%d 种：%r' % (len(set(_vals)), _vals))
    # ⑤ download 独立于 read —— 拿**客服**那组查「客户意见」（read/write 声明了客服，
    # download_roles **漏写**）。**角色集要对**：拿财务查客服列三维全 False，验不到东西。
    _op = _caps(_f22_fields, ['客服']).get('客户意见', {})
    check('FA-22 ⑤ **download 独立于 read**（客户意见漏写 download_roles → 下载拒、读照旧）',
          _op.get('read') is True and _op.get('write') is True and _op.get('download') is False,
          '客户意见/客服实得=%r —— 若 download 跟着 read=True 就是回落没关掉' % (_op,))
    # ⑥ 反例自检：两种角色集结论不同
    _c22b = _caps(_f22_fields, ['客服'])
    check('FA-22 ⑥ **反例自检**：两种角色集给出不同结论（不是恒真/恒假）',
          _c22 != _c22b and _c22.get('金额', {}).get('read') is True
          and _c22b.get('金额', {}).get('read') is False,
          '财务=%r / 客服=%r' % (_c22.get('金额'), _c22b.get('金额')))
else:
    for _i in range(6):
        check('FA-22 ①～⑥（函数不在，跳过）', False, 'field_capabilities 还没写')

# ⑦ 贴假标债：docstring 不许再写「回落 read_roles」—— 行为 10-15 已改成零声明即拒
_f_src = open(MOD_PATH, encoding='utf-8').read()
_f_doc = _f_src.split('"""')[1] if '"""' in _f_src else ''
check('FA-22 ⑦ 模块 docstring 不许再写「download 回落 read_roles」（贴假标债）',
      '回落 `read_roles`' not in _f_doc and '回落 read_roles' not in _f_doc,
      'docstring 里还有旧口径 —— 行为是零声明即拒（FA-16/FA-20），注释得跟上')

# ---------- CG 内容就绪闸（D 契约 §17 内核半）----------
# **D 出契约与判据，B 实现**（§十四「共享底层一次一个负责人」）。
# 闸装 `file_content`（`http.py` 拿到 file_doc 之后、回内容之前）—— **裸 URL 绕过**
# 文件域那道闸的兜底。形状是**可注册钩子**（`_CONTENT_GATES`）：
# 别的域将来也有「内容没就绪」（附件归档中/转码中），钩子形状支持即可。
#
# **口径已拍（E 2026-10-15）**：旧版本照旧能下，**闸只挡「最新那份」**（待恢复是
# 「最新不一致」不是「不给旧的」）。拒因说人话 + 标「N 处待恢复」（状态问题不是权限）。
#
# **两道闸都留**（D 钉的）：内核兜底 + 文件域早拒，**不许 B 的闸落地后删文件域那道**。
#
# **纯判据不测 HTTP**：`file_content` 是 frappe HTTP 口，跑它要起服务。这里测**机制**
# （注册 + 派发）；D 的 RT-4-3-K ①～⑤ 是**集成**判据（要真表 + 待恢复状态），归联调。
#
# **测试通过 =** CG-01 注册得上 / CG-02 无钩子默认过 / CG-03 钩子抛就抛（拒因原样）/
# CG-04 按 doctype 隔离 / CG-05 反例自检 / CG-06 钩子签名三参。
# 函数在 `field_access.py`（纯模块，`fa` 已载入）—— `attachments.py` 有 frappe import
# 脱离运行时加载不了，所以闸的纯逻辑放 `field_access.py`（跟 `replay_guard.py` 同理）。
print('\n== CG 内容就绪闸（D 契约 §17 内核半）==')
_reg = getattr(fa, 'register_content_gate', None)
_chk = getattr(fa, 'check_content_ready', None)

check('CG-00 先确认两个函数真在（不在的话下面全空判据）',
      callable(_reg) and callable(_chk),
      'register_content_gate=%r / check_content_ready=%r（None=还没写，下面必然全红）'
      % (_reg, _chk))

if callable(_reg) and callable(_chk):
    _called = []

    def _gate_a(doctype, name, file):
        _called.append((doctype, name, file))
    _reg('Test Doctype A', _gate_a)
    _chk('Test Doctype A', 'rec-1', 'file-1')
    check('CG-01 注册得上（check_content_ready 真调到钩子）',
          _called == [('Test Doctype A', 'rec-1', 'file-1')], '钩子被调=%r' % (_called,))

    try:
        _chk('Test Doctype Unregistered', 'rec-2', 'file-2')
        _ok2, _why2 = True, '没钩子放行 ✅'
    except Exception as _e:
        _ok2, _why2 = False, '没钩子却抛了：%s' % _e
    check('CG-02 无钩子**默认过**（没人注册就放行，不是「没钩子就拒」）', _ok2, _why2)

    _REASON = '这份表有 2 处正式值已写进数据库、但还没回写进 Excel（行 r-xxx），处于「待恢复」。'

    def _gate_reject(doctype, name, file):
        raise ValueError(_REASON)
    _reg('Test Doctype Reject', _gate_reject)
    try:
        _chk('Test Doctype Reject', 'rec-3', 'file-3')
        _ok3, _why3 = False, '钩子抛了但 check_content_ready 吞了'
    except ValueError as _e:
        _ok3 = _REASON in str(_e)
        _why3 = '拒因原样传出=%s' % _ok3
    except Exception as _e:
        _ok3, _why3 = False, '抛了别的异常：%r' % _e
    check('CG-03 钩子抛就抛（拒因原样传出，不吞不转错误码）', _ok3, _why3)

    try:
        _chk('Test Doctype A', 'rec-4', 'file-4')
        _ok4, _why4 = True, 'A 的钩子不抛 → 放行'
    except Exception as _e:
        _ok4, _why4 = False, 'A 的钩子不该抛：%s' % _e
    _n_before = len(_called)
    _chk('Test Doctype A', 'rec-5', 'file-5')
    check('CG-04 按 doctype **隔离**（A 的钩子不影响 B、也不误伤 A 自己）',
          _ok4 and len(_called) == _n_before + 1, _why4 + ' / A 钩子又调了 1 次')

    check('CG-05 **反例自检**：「有钩子拒」vs「无钩子放行」两种结论（不恒真/恒假）',
          _ok2 and _ok3, '无钩子放行=%s / 有钩子拒=%s' % (_ok2, _ok3))

    check('CG-06 钩子签名收到 (doctype, name, file) 三参（D 契约 §17.2 建议形状）',
          bool(_called) and _called[0] == ('Test Doctype A', 'rec-1', 'file-1'),
          '首调入参=%r' % (_called[0] if _called else None,))

    # CG-07 钩子可选返回 version_label（D 契约 §17.4 附条：下载时版本号标清楚）
    def _gate_version(doctype, name, file):
        return {'version_label': 'v3'}
    _reg('Test Doctype Ver', _gate_version)
    _v = _chk('Test Doctype Ver', 'rec-6', 'file-6')
    check('CG-07 钩子可选返回 version_label（下载时版本号标清楚，D 契约 §17.4 附条）',
          isinstance(_v, dict) and _v.get('version_label') == 'v3',
          '钩子返回=%r（应含 version_label=v3）' % (_v,))
else:
    for _i in range(7):
        check('CG-01～07（函数不在，跳过）', False, 'register_content_gate / check_content_ready 还没写')

print('\n结果： %s  共 %d 条检查，失败 %d 条' % ('PASS' if not failed else 'FAIL', checks_run, len(failed)))
for f in failed:
    print('  失败： %s' % f)
sys.exit(1 if failed else 0)
