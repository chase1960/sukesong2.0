#!/usr/bin/env python3
"""审核中心预览页截图（改前／改后各跑一次）。

用法：python3 tools/review_center_shot.py <输出前缀> <标签> [页签]
   例：python3 tools/review_center_shot.py docs/reports/.../review-center-dialog-after-20261023 改后
   例：python3 tools/review_center_shot.py docs/reports/.../rc-two-save-modes 两种保存方式 2

  第三个参数 **页签**（可省）：
    省略 → 摆第一张卡（老用法）；
    给序号（1、2…）→ 切到那一档页签再摆卡；
    给 key 片段（如 `partial-save`）→ 按 `data-review-tab` 匹配那一档页签。
  ⚠️ 预览页的页签是**按声明一页一个** ⇒ 切页签＝换一种保存方式看。

只读：不往站上写任何业务数据。
"""
import sys
import time

from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:3850'
USER = 'Administrator'
PASSWORD = 'lingeringtek2026'
PAGE = BASE + '/review-center-preview.html'

out = sys.argv[1]
label = sys.argv[2] if len(sys.argv) > 2 else out
tab = sys.argv[3] if len(sys.argv) > 3 else ''

with sync_playwright() as p:
    # ⚠️ 通道：**Chrome**。2026-10-23 实测 `channel='msedge'` 在这台机上
    #   `page.screenshot()` 会**卡到超时**（连登录页都截不出来）⇒ 换 Chrome。
    browser = p.chromium.launch(channel='chrome')
    ctx = browser.new_context(viewport={'width': 1500, 'height': 980})
    page = ctx.new_page()

    login = page.request.post(BASE + '/api/login',
                              data={'username': USER, 'password': PASSWORD})
    print('login ->', login.status)

    failed = []
    page.on('response', lambda r: failed.append((r.status, r.url)) if r.status >= 400 else None)

    page.goto(PAGE, wait_until='networkidle')
    time.sleep(1.5)

    # ⓿ 页签清单（预览页的页签是**按声明一页一个** ⇒ 切页签＝换一种保存方式看）
    tabs = page.query_selector_all('[data-review-tab]')
    print('tabs ->', [(t.get_attribute('data-review-tab') or '').strip() for t in tabs])

    # ⓿⓿ 要切页签 ⇒ 先把预览页**自动摆出来的那扇弹窗**关掉（模态弹窗挡着点不到页签）
    if tab:
        page.keyboard.press('Escape')
        time.sleep(0.6)

    # ⓿⓿⓿ 页签那一行单独截一张（证明**两种保存方式摆在一页上**）
    nav = page.query_selector('.review-tabs')
    if nav:
        nav.screenshot(path=out + '-tabs.png')
        print('tabs shot ->', out + '-tabs.png')

    # ① 弹窗**背后**的那一页（页头 / 工具条 / 卡片列表）
    page.screenshot(path=out + '-behind.png')
    print('behind ->', out + '-behind.png')

    # ①⓿ 切到要的那一档页签（给了页签才切）
    if tab:
        target = None
        if tab.isdigit():
            idx = int(tab) - 1
            target = tabs[idx] if 0 <= idx < len(tabs) else None
        else:
            for t in tabs:
                if tab in (t.get_attribute('data-review-tab') or ''):
                    target = t
                    break
        if target is None:
            print('!! 找不到那一档页签：', tab)
        else:
            target.click()
            time.sleep(1.5)
            print('switched to tab ->', target.get_attribute('data-review-tab'))

    # ② 那扇左右分栏大弹窗 —— 预览页自己会把第一张卡摆出来
    # ⚠️ 判「弹窗在不在」不能只看元素在不在（Escape 关掉后元素还在 DOM 里，只是没打开）
    #    ⇒ 看它**是不是开着**（`<dialog>` 的 `open` 属性），没开就点「打开核对」。
    dialog_el = page.query_selector('[data-review-split]')
    is_open = bool(dialog_el) and bool(dialog_el.evaluate('(el) => !!el.open'))
    if not is_open and page.query_selector('[data-review-card-open]'):
        page.click('[data-review-card-open]')
    time.sleep(4)
    page.screenshot(path=out + '-full.png')
    print('full ->', out + '-full.png')

    dialog = page.query_selector('[data-review-split]')
    if dialog:
        # ⚠️ 单独截弹窗这一件有时会**卡到超时**（弹窗里有 iframe ＋ blob 地址，等不到「稳定」）
        #    ⇒ 这一张**不致命**：`-full.png`（整屏）已经把这扇弹窗拍进去了。
        try:
            dialog.screenshot(path=out + '-dialog.png', timeout=8000)
            print('dialog ->', out + '-dialog.png')
        except Exception as exc:                      # noqa: BLE001 —— 这一张可有可无
            print('dialog shot skipped ->', type(exc).__name__)
        box = dialog.bounding_box()
        print('dialog box ->', box)
    else:
        print('!! 没找到弹窗')

    # ③ 底栏那几个数（留白、按钮高度）—— 报告里要用
    info = page.evaluate('''() => {
      const d = document.querySelector('[data-review-split]');
      if (!d) return null;
      const cs = getComputedStyle(d);
      const foot = d.querySelector('.review-split-foot') || d.querySelector('footer');
      const fs = foot ? getComputedStyle(foot) : null;
      const btn = d.querySelector('[data-review-save]');
      const bs = btn ? getComputedStyle(btn) : null;
      /* —— PKG-056：弹窗本体与两栏的**实际几何**（对齐旧项目那档要看的数）——
       * `gridTemplateColumns` 是**算出来的**两栏宽（浏览器把 fr 摊开后的 px），
       * 不是 CSS 里写的那串 ⇒ 拿它对旧项目的 280～328px 才算数。 */
      const body = d.querySelector('.review-split-body');
      const left = d.querySelector('[data-review-slot="left"]');
      const right = d.querySelector('[data-review-slot="right"]');
      const rect = d.getBoundingClientRect();
      return {
        dialogClass: d.className,
        dialogFont: cs.fontFamily,
        dialogRadius: cs.borderRadius,
        dialogBg: cs.backgroundColor,
        dialogBorder: cs.borderWidth + ' ' + cs.borderStyle,
        dialogWidth: rect.width,
        dialogHeight: rect.height,
        gridColumns: body ? getComputedStyle(body).gridTemplateColumns : null,
        leftColumnWidth: left ? left.getBoundingClientRect().width : null,
        rightColumnWidth: right ? right.getBoundingClientRect().width : null,
        headTitleFont: (() => {
          const h = d.querySelector('.review-split-head h2');
          return h ? getComputedStyle(h).fontSize : null;
        })(),
        footPadding: fs ? fs.padding : null,
        footHeight: foot ? foot.getBoundingClientRect().height : null,
        btnClass: btn ? btn.className : null,
        btnText: btn ? String(btn.textContent || '').trim() : null,
        btnHeight: btn ? btn.getBoundingClientRect().height : null,
        btnFont: bs ? bs.fontSize : null,
        backdrop: cs.getPropertyValue('--none'),
        iframe: !!d.querySelector('iframe'),
      };
    }''')
    print('metrics ->', info)
    print('failed ->', failed[:6])
    print('iframe src ->', page.evaluate(
        "() => { const f = document.querySelector('[data-review-split] iframe'); return f ? f.getAttribute('src') : null; }"))

    browser.close()
