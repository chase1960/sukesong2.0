#!/usr/bin/env python3
"""保存路径净化器 —— 测**真的** `service.html_body`，不是它的副本。

为什么单独一条：`test-mail-save-sanitize.py` 为了让宿主能跑，镜像了一份净化语义。
副本会跟真身漂移 —— 真身的 bleach 白名单漏了 `background`/`white-space`/`bgcolor`
时，副本照样绿。用户 2026-10-13：「表头颜色发不出去」就卡在这一层。

测试通过 = 下面全部成立（走**生产** `service.html_body`）：

 1. 表头底色两种写法存得下来：`style="background:#12263f"` 与 `bgcolor="#12263f"`。
 2. 回复引用用的 `style="white-space:pre-wrap"` 存得下来（被剥就又把换行压成一段）。
 3. `<font color>` 着色存得下来（接收端保留，保存端原来把它剥了）。
 4. 表格居中、单元格不换行/高度这些常用排版属性存得下来。
 5. 危险的东西照样剥：script / 事件 / 外链图 / url() CSS。

跑在容器里（service.py 依赖 frappe）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … python /tmp/…
"""
import sys
from pathlib import Path

_roots = [Path('/home/frappe/frappe-bench/apps'), Path.cwd()]
try:
    _roots.append(Path.cwd().parents[2])
except IndexError:
    pass
for _a in ('shangshu_mail', 'shangshu_core'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
from shangshu_mail.service import html_body

frappe.init(site='shangshu.localhost', sites_path='/home/frappe/frappe-bench/sites')
frappe.connect()

def kept(label, src, *needles):
    out = html_body(src)
    for n in needles:
        require(f'{label}：{n} 存得下来', n in out, f'只剩 {out!r}')


# 裸 <td> 不在 <table> 里是无效 HTML，解析规范本身就会丢掉那个标签 ——
# 样本一律按真实邮件的写法包进表格，别拿无效样本测出假红。
def row(cell):
    return f'<table><tr>{cell}</tr></table>'


print('=== 1 表头底色两种写法 ===')
kept('1a style=background', row('<td style="background:#12263f;color:#fff">表头</td>'),
     'background:#12263f', 'color:#fff')
kept('1b bgcolor', row('<td bgcolor="#12263f">表头</td>'), 'bgcolor="#12263f"')

print('\n=== 2 回复引用的 white-space ===')
kept('2 white-space', '<div style="white-space:pre-wrap">a\nb</div>', 'white-space:pre-wrap')

print('\n=== 3 <font> 着色 ===')
kept('3 font', '<font color="red">红字</font>', '<font', 'color="red"', '红字')

print('\n=== 4 常用排版属性 ===')
kept('4a 表格居中', '<table align="center" width="600"><tr><td>x</td></tr></table>', 'align="center"')
kept('4b 单元格不换行/高度', row('<td nowrap height="40">表头</td>'), 'nowrap', 'height="40"')

print('\n=== 5 危险的照样剥 ===')
out = html_body('<script>alert(1)</script><p>正文</p>')
require('5a script 剥掉', 'alert(1)' not in out and '正文' in out, f'只剩 {out!r}')
out = html_body('<img src="https://evil.example.com/x.png"><p>正文</p>')
require('5b 外链图剥掉', 'evil.example.com' not in out and '正文' in out, f'只剩 {out!r}')
out = html_body(row('<td style="background:url(https://evil.example.com/x.png)">x</td>'))
require('5c url() CSS 剥掉', 'evil.example.com' not in out, f'只剩 {out!r}')
out = html_body('<p onclick="alert(1)">正文</p>')
require('5d 事件属性剥掉', 'onclick' not in out and '正文' in out, f'只剩 {out!r}')

print('\n=== 6 没闭合的危险标签不许把源码当正文留在信里 ===')
# 删危险标签原来用**成对正则** `<script>…</script>`，没闭合的删不掉 →
# 交给 bleach 剥标签后，**脚本源码当成普通文字留在正文里**，对端看到的就是这些字。
for label, src, leak in (
    ('script 没闭合', '<script>alert(1)<p>正文</p>', 'alert(1)'),
    ('style 没闭合', '<style>.a{color:red}<p>正文</p>', '.a{color:red}'),
    ('iframe 没闭合', '<iframe src="https://evil.example.com"><p>正文</p>', 'evil.example.com'),
):
    out = html_body(src)
    require(f'6 {label}：不漏源码', leak not in out, f'漏出来了：{out!r}')

print(f"\n{'='*60}")
print(f"通过 {len(PASS)} 条，失败 {len(FAIL)} 条")
if FAIL:
    for f in FAIL:
        print(f'  - {f}')
frappe.db.rollback()
sys.exit(1 if FAIL else 0)
