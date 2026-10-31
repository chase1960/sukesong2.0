"""R967-E · UI-022：**公共客户主表 / 跨表引用配置** —— 当前**没有**该入口（负向断言）。

**为什么是负向断言**：主控 2026-10-17 确认 —— 产品当前没有「公共客户主表」和
「跨表引用配置」入口，**「证明没有」就是这一项现在的正确判据**；等产品补能力再换成正向。

**测试通过 = 下面每条成立**：

1. **对象注册表里没有「公共客户主表」类对象** —— 扫描 `list_object_definitions()`，
   没有 id/名称命中 `customer` / `客户` / `client`（作为**主表**）；
2. **文件域没有「引用配置」动作或服务** —— 扫描 `com.shangshu.files` 的
   actions/services/datasets，没有 id 命中 `reference_config` / `relation_config` /
   `关联配置`；
3. **没有全局「可互相关联的对象类型」白名单** —— 注册表里不存在该条目；
4. **扫描面要可审计** —— 打印扫了多少对象/动作/服务，**证明不是「没看」**。

**⚠️ 边界**：本判据**不判断**「该不该有」—— 那是产品决策。它只回答
「**现在有没有**」，并在有朝一日补上时**转红**，提醒把它换成正向断言。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_ui022_no_reference_config.py
"""
import importlib.util
import os
import sys


ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ss_console = _load('_ss_console', '/shangshu-server/scripts/tests/_ss_console.py')

checks, fails, not_yet = [], [], []


def check(label, valid, detail=''):
    checks.append(label)
    if valid is None:
        not_yet.append(label)
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:200]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:200]) if detail else ''))
    return bool(valid)


print('== R967-E / UI-022：当前没有「公共客户主表 / 引用配置」（负向断言）==')

out = _ss_console.run(r'''
import frappe, json, re
from shangshu_core import objects as _objects

RESULT = {}
objs = _objects.list_object_definitions() or []
RESULT['object_count'] = len(objs)
RESULT['object_ids'] = [o.get('id') or o.get('object_id') or '' for o in objs]

row = frappe.db.get_value('Shangshu Domain', {'domain_id': 'com.shangshu.files'},
                          'contribution_json')
d = json.loads(row or '{}')
RESULT['actions'] = [a.get('id') for a in (d.get('actions') or [])]
RESULT['services'] = [s.get('id') for s in (d.get('services') or [])]
RESULT['datasets'] = [x.get('id') for x in (d.get('datasets') or [])]
RESULT['domain_objects'] = [o.get('id') for o in (d.get('objects') or [])]
''')

print('  扫描：对象 %r　文件域 actions %d / services %d / datasets %d'
      % (out.get('object_count'), len(out.get('actions') or []),
         len(out.get('services') or []), len(out.get('datasets') or [])))
print('  err=%r' % (out.get('__error__'),))

objs = [str(x) for x in (out.get('object_ids') or [])]
actions = [str(x) for x in (out.get('actions') or [])]
services = [str(x) for x in (out.get('services') or [])]
datasets = [str(x) for x in (out.get('datasets') or [])]
dom_objs = [str(x) for x in (out.get('domain_objects') or [])]
name_blob = ' '.join(objs + dom_objs).lower()

# ---- 1 没有「公共客户主表」类对象 ----
cust = [x for x in (objs + dom_objs)
        if ('customer' in x.lower() or 'client' in x.lower())]
check('1 **对象注册表里没有「公共客户主表」类对象**',
      out.get('__error__') is None and not cust,
      '扫描 %d 个对象（含文件域 %d）；命中 customer/client = %r'
      % (len(objs), len(dom_objs), cust))

# ---- 2 文件域没有「引用配置」动作/服务 ----
pat = ('reference_config', 'relation_config', 'referenceconfig', '关联配置')
hits2 = [x for x in (actions + services + datasets) if any(p in x.lower() for p in pat)]
check('2 **文件域没有「引用配置」动作/服务/数据集**',
      out.get('__error__') is None and not hits2,
      '扫 %d actions + %d services + %d datasets；命中 = %r'
      % (len(actions), len(services), len(datasets), hits2))

# ---- 3 没有全局「可互相关联的对象类型」白名单 ----
# 判法：文件域贡献里不应出现 `relation_types` / `allowed_relation` 这类配置键；
# 对象注册表里也不应有这样的条目。**只看注册表，不读源码**。
keys = ('relation_types', 'allowed_relations', 'relation_whitelist')
contribution_text = ' '.join(actions + services + datasets + dom_objs).lower()
hits3 = [k for k in keys if k in contribution_text]
check('3 **没有全局「可互相关联的对象类型」白名单**',
      out.get('__error__') is None and not hits3,
      '在文件域贡献 id 里找 %r；命中 = %r' % (list(keys), hits3))

# ---- 4 扫描面可审计 ----
check('4 **扫描面可审计**（证明不是「没看」）',
      (out.get('object_count') or 0) > 0
      and len(actions) + len(services) + len(datasets) > 0,
      '对象=%r（列表共 %d 个），文件域条目=%d'
      % (out.get('object_count'), len(objs), len(actions) + len(services) + len(datasets)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / UI-022 无「公共客户主表/引用配置」负向断言（%d 条）'
                    % len(checks)) if not not_yet else
                   ('**未判** R967-E / UI-022（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组是**负向断言**：只回答「现在有没有」，不判断「该不该有」。')
print('⚠️ 产品补上该能力后本组会转红 —— 那时请换成正向判据。')
sys.exit(1 if (fails or not_yet) else 0)
