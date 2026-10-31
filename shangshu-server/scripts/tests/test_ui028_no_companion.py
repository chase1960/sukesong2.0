"""R967-E · UI-028：**既有业务对象没有伴随 A / 普通列映射**（负向断言）。

**为什么是负向断言**：验收总表 UI-028 记 BLOCKED ——
「实际打开既有 `orders.order`，目录声明无伴随 A、`can_structure=false`，
未提供本用例要求的 E+伴随映射」。产品当前**没有**「业务对象 ↔ 文件中心伴随表」这层，
所以「证明没有」就是这一项现在的正确判据；补上后再换正向。

**测试通过 = 下面每条成立**：

1. **对象注册表里能查到业务对象**（至少 `orders.order` 或任一 `orders.*`），
   **并打印它的定义键** —— 证明不是「没看」；
2. **没有「伴随文件/伴随表」字段**：定义键里不出现
   `companion` / `attached_file` / `attached_sheet` / `sheet_file` 这类映射；
3. **没有「普通列 ↔ 业务记录」的声明字段**：定义键里不出现把普通列绑到业务对象的键；
4. **扫描面可审计**：打印对象数与被检查对象的键。

**⚠️ 边界**：本判据不判断「该不该有」—— 那是产品决策；只回答「现在有没有」。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_ui028_no_companion.py
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
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:220]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:220]) if detail else ''))
    return bool(valid)


print('== R967-E / UI-028：业务对象当前没有伴随 A / 普通列映射（负向断言）==')

out = _ss_console.run(r'''
import json, frappe
from shangshu_core import objects as _objects
RESULT = {}
objs = _objects.list_object_definitions() or []
RESULT['count'] = len(objs)
RESULT['ids'] = [o.get('id') or o.get('object_id') or '' for o in objs]
tgt = next((o for o in objs
            if str(o.get('id') or o.get('object_id') or '').startswith('orders.')),
           None)
RESULT['target'] = (tgt.get('id') or tgt.get('object_id')) if tgt else None
RESULT['keys'] = sorted(tgt.keys()) if isinstance(tgt, dict) else []
''')
print('  对象数=%r　目标对象=%r' % (out.get('count'), out.get('target')))
print('  目标定义键=%r' % (out.get('keys'),))
print('  err=%r' % (out.get('__error__'),))

objs = [str(x) for x in (out.get('ids') or [])]
keys = [str(k) for k in (out.get('keys') or [])]
blob = ' '.join(keys).lower()

check('1 **对象注册表里能查到业务对象**（打印定义键，证明不是「没看」）',
      bool(out.get('target')) and bool(keys),
      '对象数=%d 目标=%r 键=%r' % (len(objs), out.get('target'), keys[:12]))

comp = [k for k in keys if any(p in k.lower() for p in
        ('companion', 'attached_file', 'attached_sheet', 'sheet_file', 'file_companion'))]
check('2 **没有「伴随文件/伴随表」字段**（companion / attached_* / sheet_file 等）',
      out.get('__error__') is None and bool(keys) and not comp,
      '在 %d 个定义键里找；命中=%r' % (len(keys), comp))

colmap = [k for k in keys if any(p in k.lower() for p in
         ('column_map', 'column_binding', 'plain_columns', 'normal_columns'))]
check('3 **没有「普通列 ↔ 业务记录」的声明字段**',
      out.get('__error__') is None and bool(keys) and not colmap,
      '命中=%r' % (colmap,))

check('4 **扫描面可审计**（对象数 > 0）',
      (out.get('count') or 0) > 0,
      '对象数=%r' % (out.get('count'),))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / UI-028 无伴随映射负向断言（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / UI-028（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组是**负向断言**：只回答「现在有没有」，不判断「该不该有」。')
sys.exit(1 if (fails or not_yet) else 0)
