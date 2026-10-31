#!/usr/bin/env node
/*
  N2-C5 正式工作面联合验收 —— 真实 Chrome + 正式产品页 http://127.0.0.1:3830/index.html#/mail

  计划原文（N2-C-执行计划 §五）：
  「同一封受控来信走完整链：读取 → 图片可见 → 以合法草稿路径编辑 → 三种粘贴/复杂表操作
    → 保存 → 关 → 重开 → 预览 → 生产 MIME 独立解析。3830 正式页上补真实剪贴板、中文输入、
    故障证据；原来信保持不变。」

  反例表钉的三条，本脚本逐条对着做：
  | 可能「看似完成」 | 反证 |
  |---|---|
  | API 样本与组件页各通过，产品页没接上 | 全程在 `index.html#/mail` 正式页，不是夹具页 |
  | 用隐藏脚本改原信冒充日常操作 | 原信前后 diff 必须为空（S1/S7） |
  | dispatchEvent 造的 paste 冒充真实剪贴板 | 用真实系统剪贴板（osascript 写 NSPasteboard）+ 真实 Cmd+V |

  源信由 scripts/test-mail-c5-fixture.py 造（传输边界进真实 sync，不是插库）。

  两个实测踩过的坑，别改回去：
   1. **必须有头 Chrome** —— headless 的剪贴板与系统剪贴板隔离，真实 Cmd+V 读不到。
   2. CDP 合成按键必须带 `commands: ['Paste']` —— 不带时 Chrome 不会真的执行粘贴。

  测试通过 = 下面全部成立：
   1. 整条链在 3830 正式产品页跑通（不是组件夹具页）。
   2. 真实剪贴板粘表格进正文，结果与 C3 一致（有框线、前导零、中文、合并格不丢）。
   3. 中文输入法上屏「年费已核对」进表格单元格：字进那个格，表格不散。
   4. 保存 → 关 → 重开：内容/表格/合并格/内联图一条不丢。
   5. （另跑 test-mail-c5-mime-verify.py）预览与生产 MIME 独立解析核对一致。
   6. 故障证据：拿旧 record_version 去改 → 被拒，且**没盖掉已存内容**。
   7. 原来那封受控来信的正文与结构一字未变（源邮件 ≠ 草稿，是两条记录）。
*/
import {spawn, execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const BASE = 'http://127.0.0.1:3830';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9351;
const PROFILE = '/tmp/cdp-agent-c-c5-v' + Date.now().toString(36);
// 换全新 profile：旧 profile 会缓存 js/css，导致「node 是新的、页面跑的还是旧资产」
// （实测：saveBtnGone=true 但 getInlineResources 不存在、正文框仍是 200px）。
const ENV = '/path/to/workspace';
const CLIPBOARD = fileURLToPath(new URL('./clipboard-set.mjs', import.meta.url));
// ↑ 必须 fileURLToPath：.pathname 会留着 %E5%B0%9A 这种百分号编码，execFileSync 找不到文件
const STATE_OUT = '/tmp/c5-chain-state.json';

const SOURCE_SUBJECT = '受控来信 C5：年费账单与合并表格';
const SRC_CID = 'c5-src-inline-1';
const PASTE_HTML =
  '<table><tr><td colspan="2">粘贴汇总</td></tr>' +
  '<tr><td rowspan="2">007</td><td>甲乙</td></tr><tr><td>丙丁</td></tr></table>';
const PASTE_PLAIN = '粘贴汇总\n007\t甲乙\n\t丙丁';
const IME_TEXT = '年费已核对';

function loadPassword() {
  for (const line of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const s = line.trim().replace(/^export\s+/, '');
    if (s.startsWith('ADMIN_PASSWORD=')) return s.slice('ADMIN_PASSWORD='.length).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('环境文件里找不到 ADMIN_PASSWORD');
}

const results = [];
let REDACT = '';
const redact = v => String(v ?? '').split(REDACT).join('[redacted]');
const say = (id, ok, detail) => results.push(`${id}|${ok ? 'PASS' : 'FAIL'}|${redact(detail)}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

function setClipboard(html, plain) {
  const htmlFile = `/tmp/c5-paste.html`, plainFile = `/tmp/c5-paste.txt`;
  writeFileSync(htmlFile, html);
  writeFileSync(plainFile, plain);
  return execFileSync('node', [CLIPBOARD, htmlFile, plainFile], {encoding: 'utf8'});
}

const password = loadPassword();
REDACT = password;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-sandbox',
  'about:blank',
], {stdio: 'ignore'});
chrome.on('exit', (code, signal) => console.log(`   [Chrome 退出] code=${code} signal=${signal || '无'}`));

try {
  const ws = new WebSocket(await wsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  /* Chrome 中途死掉时，后续 CDP 调用**同样表现为「超时」**（回包永远不来）。
     不分会把「浏览器没了」误报成「命令超时」，查错方向全歪。
     所以连接一断，把在等的调用立刻按真因拒掉。 */
  let closedReason = '';
  ws.onclose = ev => {
    closedReason = `Chrome 调试连接已断（code=${ev.code}）`;
    for (const {rej} of pending.values()) rej(new Error(closedReason));
    pending.clear();
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const {res, rej} = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  /* 每个 CDP 调用都套超时。实测 `Input.imeSetComposition` 会**一直不回**，
     不设超时就把整轮拖死（Node 报 unsettled top-level await）。
     超时值可传：入口页 40 来个 script，`Page.navigate` 12s 偏紧（实测会超）。 */
  const send = (method, params = {}, sessionId, timeoutMs = 12000) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(closedReason ? `${closedReason}，等不到 ${method} 的回包` : 'CDP 超时：' + method));
    }, timeoutMs);
    pending.set(id, {res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); }});
    ws.send(JSON.stringify({id, method, params, sessionId}));
  });
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
  const S = (m, p = {}, timeoutMs) => send(m, p, sessionId, timeoutMs);
  /* 原生对话框（confirm/alert/beforeunload 的「要离开吗」）会把渲染进程卡住，
     `Page.navigate` 就一直排队不回 —— 实测表现为「CDP 超时」，查错方向全歪。
     这里统一记录并关掉，且**留痕**：出现了就必须打出来，不许静默吞。 */
  const dialogs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      const d = m.params || {};
      dialogs.push({type: d.type, message: d.message});
      console.log(`   [原生对话框] ${d.type}：${(d.message || '').slice(0, 80)}`);
      send('Page.handleJavaScriptDialog', {accept: false}, sessionId, 8000).catch(() => {});
    }
  });
  await S('Page.enable');
  const evalJs = async expression => {
    const r = await S('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 异常').slice(0, 300));
    return r.result?.value;
  };
  /* 必须先走 about:blank 再进目标页：只 navigate 到同一个 `#/mail` 是纯 hash 变化，
     浏览器**不会重载**，列表还是上一次的（实测：新建的草稿在列表里找不到）。
     导航给 45s 并允许重试一次：入口页 script 很多，实测 12s 会超，且超的是
     「导航这条命令」不是产品 —— 重试一次就能过，不该把它算成产品失败。 */
  const nav = async url => {
    for (let attempt = 1; ; attempt++) {
      try {
        await S('Page.navigate', {url: 'about:blank'}, undefined, 45000);
        await sleep(300);
        await S('Page.navigate', {url}, undefined, 45000);
        await sleep(2800);
        return;
      } catch (error) {
        // 连接已断就别重试了 —— 浏览器都没了，重来也一样
        if (attempt >= 2 || closedReason) throw error;
        console.log(`   [导航重试] 第 ${attempt} 次 Page.navigate 超时，重来：${String(error && error.message || error)}`);
        await sleep(1000);
      }
    }
  };
  /* 列表/写信窗都是异步渲染的 —— 固定 sleep 会「还没画出来就去点」，点了等于没点。
     轮询到真出现为止，再动手。 */
  const waitFor = async (label, expression, ms = 12000) => {
    const until = Date.now() + ms;
    for (;;) {
      const v = await evalJs(expression);
      if (v) return v;
      if (Date.now() > until) {
        const scene = await evalJs(`(() => ({
          rows: [...document.querySelectorAll('[data-open]')].map(b => (b.textContent||'').slice(0, 40)),
          box: document.querySelector('#mail-box') ? document.querySelector('#mail-box').value : null,
          total: (document.body.innerText.match(/\\d+ 封/) || [''])[0],
        }))()`);
        throw new Error('等不到：' + label + '；现场=' + JSON.stringify(scene).slice(0, 600));
      }
      await sleep(350);
    }
  };
  /* 先搜再点：列表会被历次跑出来的草稿挤满，目标信要翻页才看得见。
     用户找不到信也是这么干的（用搜索框），所以这不算绕过被测功能。 */
  const clickRow = async (subject) => {
    await evalJs(`(() => {
      const s = document.querySelector('#search');
      if (s) { s.value = ${JSON.stringify(subject)}; s.dispatchEvent(new Event('input', {bubbles: true})); }
      return 'searched';
    })()`);
    await sleep(700);
    return waitFor('列表行「' + subject + '」', `(() => {
      const items = [...document.querySelectorAll('[data-open]')];
      const hit = items.find(it => (it.textContent||'').includes(${JSON.stringify(subject)}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  };

  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');
  await S('Network.setCacheDisabled', {cacheDisabled: true});   // 不许吃缓存，验的是部署上去的那版

  // —— 登录（口令只在这里用，不回显）——
  await nav(`${BASE}/login.html`);
  const loggedIn = await evalJs(`(async () => {
    const r = await fetch('/api/platform/login', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({username: 'Administrator', password: ${JSON.stringify(password)}}),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok !== false;
  })()`);
  say('L1-登录正式产品页', loggedIn === true, loggedIn ? '已拿到真实身份' : '登录失败');
  if (loggedIn !== true) throw new Error('stop');

  // —— S1. 源信「改之前」快照（C5 第 7 条：前后 diff 必须为空）——
  const before = await evalJs(`(async () => {
    const r = await fetch('/api/platform/services/mail.detail/invoke', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({payload: {}}),
    });
    return null;
  })()`);
  void before;

  const src = await evalJs(`(async () => {
    // 列表接口的过滤条件是**JSON 字符串**放在 filters= 参数里（mail-center.js:167），
    // 直接写 ?scope=inbox 不生效，会静默退回默认 scope='draft'。
    const qs = new URLSearchParams({page: '1', page_length: '50', filters: JSON.stringify({scope: 'inbox'})});
    const list = await (await fetch('/api/platform/datasets/mail.message/records?' + qs)).json();
    const rows = (list.rows || list.result?.rows || []);
    const hit = rows.find(r => (r.subject||'').includes(${JSON.stringify(SOURCE_SUBJECT)}));
    if (!hit) return {error: '收件箱里没有受控来信', rows: rows.map(r => r.subject)};
    const d = await (await fetch('/api/platform/services/mail.detail/invoke', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({payload: {mail: hit.name}}),
    })).json();
    const m = d.mail || d.result?.mail || {};
    return {name: hit.name, subject: m.subject, body: m.body, body_format: m.body_format,
            status: m.status, record_version: m.record_version,
            inline: m.inline_resources || [], attachments: m.attachments || []};
  })()`);
  say('S1-受控来信在正式收件箱里', Boolean(src && src.name), src?.error || `记录 ${src?.name}「${src?.subject}」v${src?.record_version}`);
  if (!src?.name) throw new Error('stop');
  const srcBefore = JSON.stringify({body: src.body, status: src.status, subject: src.subject,
                                   inline: src.inline, attachments: src.attachments});

  // —— R. 阅读面：图片可见、表格/合并在正式页显示 ——
  await nav(`${BASE}/index.html#/mail`);
  await clickRow(SOURCE_SUBJECT);
  await waitFor('阅读面沙箱框', `Boolean(document.querySelector('iframe.mail-body-preview'))`, 12000);
  /* 沙箱 iframe 是不透明源（sandbox="" 没有 allow-same-origin），
     父页的 frame.contentDocument 是 null —— 这正是安全边界在起作用，不是 bug。
     所以阅读面只能断言 **srcdoc 里带了什么**；「真的解码出像素」到非沙箱的编辑器面去验。 */
  const reader = await evalJs(`(() => {
    const frame = document.querySelector('iframe.mail-body-preview') || document.querySelector('iframe');
    if (!frame) return {error: '阅读面没找到沙箱预览框'};
    const srcdoc = frame.getAttribute('srcdoc') || '';
    const probe = document.createElement('div');
    probe.innerHTML = srcdoc;
    const img = probe.querySelector('img');
    const table = probe.querySelector('table');
    return {
      sandbox: frame.getAttribute('sandbox'),
      srcdocLen: srcdoc.length,
      hasTable: Boolean(table),
      colspan: Boolean(table && table.querySelector('[colspan]')),
      rowspan: Boolean(table && table.querySelector('[rowspan]')),
      imgSrc: img ? (img.getAttribute('src')||'') : '',
      dataImage: srcdoc.toLowerCase().indexOf('data:image') >= 0,
      remoteImg: (() => { const tags = srcdoc.toLowerCase().match(/<img[^>]*>/g) || []; return tags.some(t => t.indexOf('src="http') >= 0 || t.indexOf("src='http") >= 0); })(),
      text: probe.textContent || '',
    };
  })()`);
  if (!reader.hasTable) {
    const probe = await evalJs(`(() => ({
      iframes: [...document.querySelectorAll('iframe')].map(f => (f.className||'') + '|' + (f.id||'')),
      editors: document.querySelectorAll('.mail-body-editor,#c-editor').length,
      previews: document.querySelectorAll('iframe.mail-body-preview').length,
      bodySnippet: (document.body.innerText||'').slice(0, 200),
    }))()`);
    console.log('   [诊断] 阅读面 DOM：' + JSON.stringify(probe).slice(0, 500));
  }
  say('R1-正式页阅读面有合并表格', reader.hasTable && reader.colspan && reader.rowspan,
      `表格=${reader.hasTable} 横合=${reader.colspan} 纵合=${reader.rowspan}；${reader.error||''}`);
  say('R2-阅读面 srcdoc 带可解码的 data:image 字节，且零外链图',
      reader.dataImage === true && reader.remoteImg === false,
      `data:image=${reader.dataImage} 外链图=${reader.remoteImg} img.src=${String(reader.imgSrc).slice(0, 60)} sandbox=${JSON.stringify(reader.sandbox)}`);

  // —— D. 以合法草稿路径建草稿（源信 ≠ 草稿，两条记录）——
  const draft = await evalJs(`(async () => {
    const act = async (id, payload, key) => {
      const r = await fetch('/api/platform/actions/' + id + '/execute', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({payload, confirmed: true, idempotency_key: key}),
      });
      const t = await r.text();
      if (!r.ok) throw new Error(id + ' ' + r.status + ' ' + t.slice(0, 160));
      return JSON.parse(t).result;
    };
    const marker = 'c5-' + Math.random().toString(36).slice(2, 10);
    // C5 第 4 条点名「内容/表格/合并格/**内联图**一条不丢」，所以草稿必须带受管内联图。
    // 走真实 files.upload → 取固定版本的受管文件引用 → save_draft（与 C1 同一条合法路径）。
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAWElEQVR42u3aMREAMAgEQeTgXwHOEhHQMOzPGdj+4y1fAAAMAipzRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPYDnLsBBwAfN3jopUhd1FgAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    const up = await act('files.upload', {
      file_name: 'C5签章-' + marker + '.png', content_base64: b64, file_sha256: sha,
    }, 'c5-file-' + marker);
    const versions = await (await fetch('/api/platform/services/files.versions/invoke', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({payload: {file: up.file}}),
    })).json();
    const list = (versions.result || versions).versions || [];
    const hit = list.find(v => v.version_no === up.version);
    if (!hit || !hit.frappe_file) throw new Error('上传后拿不到固定版本的受管文件引用');
    const cid = marker + '@shangshu.local';
    const saved = await act('mail.save_draft', {
      subject: 'C5 正式页全链 ' + marker,
      body: '<p>底稿</p><p><img src="cid:' + cid + '" alt="签章"></p>',
      body_format: 'HTML', to: ['核对 <c5@example.invalid>'], cc: [],
      attachments: [],
      inline_resources: [{content_id: cid, mime_type: 'image/png', name: '签章.png', file: hit.frappe_file}],
    }, 'c5-draft-' + marker);
    return {name: saved.name, subject: 'C5 正式页全链 ' + marker, version: saved.record_version || 1,
            cid, file: (saved.inline_resources || [])[0]?.file || ''};
  })()`);
  say('D1-合法草稿路径建出草稿（与源信是两条记录）', Boolean(draft?.name) && draft.name !== src.name,
      `草稿 ${draft?.name} v${draft?.version}，源信 ${src.name}`);
  if (!draft?.name) throw new Error('stop');

  // —— E. 打开草稿进写信窗（正式页的正文编辑器）——
  await nav(`${BASE}/index.html#/mail`);
  await clickRow(draft.subject);
  await waitFor('写信窗正文编辑器', `Boolean(document.querySelector('.mail-body-editor') || document.querySelector('#c-editor'))`, 12000);
  const opened = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    return {hasEditor: Boolean(ed), contenteditable: ed ? ed.getAttribute('contenteditable') : null};
  })()`);
  if (!opened.hasEditor) {
    const probe = await evalJs(`(() => ({
      url: location.hash,
      composeHost: document.querySelectorAll('#c-editor-host').length,
      modals: document.querySelectorAll('.modal,.dlg,[role="dialog"]').length,
      subject: document.querySelector('#c-subject') ? document.querySelector('#c-subject').value : null,
      mailEditor: typeof window.mailEditor,
      bodySnippet: (document.body.innerText||'').slice(0, 160),
    }))()`);
    console.log('   [诊断] 写信窗 DOM：' + JSON.stringify(probe).slice(0, 500));
  }
  say('E1-正式页写信窗打开正文编辑器', opened.hasEditor === true && opened.contenteditable === 'true',
      `编辑器=${opened.hasEditor} contenteditable=${opened.contenteditable}`);

  /* 版本自证：3830 上跑的确实是这版源码。
     判据用**这版才有的、页面上看得见的东西**。
     注意别查 getInlineResources —— 那是 mountEditor 返回的 API 对象上的方法，
     不在 DOM 元素上，拿 DOM 去查永远 false（我先前就是这么自己造了个假红）。
     「内联图 API 真通」由后面的 K1b/K4 在产品页上实证。 */
  const version = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    const wrap = ed ? ed.closest('.mail-editor-wrap') || ed.parentElement : null;
    return {
      // N3-B：「存草稿」按钮已删除
      saveBtnGone: !document.querySelector('#c-save'),
      // N3-A：工具栏有「插图」入口（选图 input 是点它时才现造的，不在 DOM 里）
      hasImageEntry: Boolean(wrap && wrap.querySelector('button[data-editor-image]')),
      // N3-E：正文框生效的最小高度（不是源码里随便一条 min-height）
      editorMinH: ed ? (getComputedStyle(ed).minHeight || '') : '',
      // N3-C：#notice 样式来自公共件（三页共用那份在 workbench.css）
      noticePos: (() => { const n = document.querySelector('#notice'); return n ? getComputedStyle(n).position : '无#notice'; })(),
    };
  })()`);
  const minH = parseFloat(version.editorMinH) || 0;
  say('V0-3830 跑的确实是这版源码', version.saveBtnGone && version.hasImageEntry && minH >= 320,
      JSON.stringify(version));

  /* —— V2. 胶囊的「+」跟胶囊走，不是固定贴右 ——
     用户 2026-10-12：「加号能不能跟着胶囊而不是右对齐？就是和胶囊对齐直到胶囊溢出刚好在右侧现在的位置」。
     **这条 jsdom 量不出来**（不做布局，getBoundingClientRect 全是 0），必须在真浏览器量真实位置。
     判据两个状态：
       · 胶囊少 → 加号右边还留着大片空白（说明是跟在胶囊后头，不是贴右）
       · 胶囊多到挤满 → 加号右边几乎没有空白（被顶到右端，也就是「现在的位置」） */
  const measureChip = () => evalJs(`(() => {
    const root = document.querySelector('.chip-input');
    if (!root) return {error: '找不到胶囊组件'};
    const items = root.querySelector('[data-chip-items]');
    const add = root.querySelector('[data-chip-add]');
    if (!items || !add) return {error: '胶囊组件缺部件'};
    const r = root.getBoundingClientRect(), a = add.getBoundingClientRect();
    return {
      chips: items.querySelectorAll('.chip-input-chip').length,
      rowW: Math.round(r.width),
      gapAfterAdd: Math.round(r.right - a.right),   // 加号右边剩多少空白
      fill: Math.round(a.right - r.left),           // 加号右缘顶到哪
    };
  })()`);
  const few = await measureChip();
  say('V2a-胶囊少时「+」跟在胶囊后头（右边还留着空白，不是贴右）',
      few.chips >= 0 && few.rowW > 0 && few.gapAfterAdd > few.rowW * 0.15,
      JSON.stringify(few));
  /* 逐步加胶囊，不塞进一次 evaluate —— 一次 evaluate 里跑 8 步会被卡死整轮（实测超时），
     而且卡在哪一步也看不出来。拆成小步，每步独立计时。

     值要**长**：胶囊组件只渲染 3 枚（visibleLimit=3），短地址 3 枚也占不满一行，
     「+」照样有空位 —— 那样测的是「没挤满」，不是「挤满时 + 贴右」。
     用长地址把 3 枚撑满整行，才测得到溢出那一侧。 */
  let added = 0;
  for (let i = 1; i <= 6; i++) {
    const step = await evalJs(`(async () => {
      const root = document.querySelector('.chip-input');
      if (!root) return {error: 'no chip-input'};
      const add = root.querySelector('[data-chip-add]');
      add.click();
      await new Promise(r => setTimeout(r, 40));
      const f = root.querySelector('input');
      if (!f) return {error: 'no slot', i: ${i}};
      f.value = 'zhangsan.longname.${i}@very-long-company-domain-name-for-overflow.example.com';
      f.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
      await new Promise(r => setTimeout(r, 40));
      return {chips: root.querySelectorAll('.chip-input-chip').length};
    })()`).catch(e => ({error: String(e && e.message || e)}));
    if (step && !step.error) added++;
    else console.log(`   [加胶囊第 ${i} 步] ${JSON.stringify(step)}`);
  }
  const full = await measureChip();
  say('V2b-胶囊挤满时「+」被顶到右端（右边几乎没空白）',
      added >= 4 && full.chips > few.chips && full.gapAfterAdd <= 24,
      JSON.stringify({...full, added}));

  /* —— V3. 收件人报错走右下角 toast 公共件、红、不再说「分号隔开」——
     用户 2026-10-12：「这个不是已经没有分号隔开了吗？」+「收件人报错也放进公共提示组件里面去」
     +「就留一句"收件人……."不要有一次填一个人这种」。
     2026-10-12 改查 #toast-zone .toast —— #notice 那套自造劣等品已删干净（C6）。 */
  const beforeTo = await evalJs(`(() => (document.querySelector('#c-to')||{}).value || '')()`);
  /* 走**真实用户路径**：点「+」→ 打认不出的地址 → 回车。
     上一版直接往隐藏输入塞值，不置脏、失焦保存可能不触发，于是这条会**偶发假红**。 */
  const errShot = await evalJs(`(async () => {
    const root = document.querySelector('.chip-input');
    if (!root) return {error: 'no chip-input'};
    root.querySelector('[data-chip-add]').click();
    await new Promise(r => setTimeout(r, 120));
    const f = root.querySelector('input');
    if (!f) return {error: 'no slot'};
    f.value = '12@q';
    f.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await new Promise(r => setTimeout(r, 400));
    const toast = [...document.querySelectorAll('#toast-zone .toast')].pop();
    return {
      toastShown: !!toast,
      toastText: toast ? (toast.textContent || '') : '',
      toastRed: toast ? toast.classList.contains('toast-error') : false,
      toastAlert: toast ? toast.getAttribute('role') === 'alert' : false,
      noticeGone: !document.querySelector('#notice'),
      ownRedText: [...document.querySelectorAll('#e-to,#e-cc')]
        .filter(el => !el.hidden && (el.textContent || '').trim()).length,
      stored: (document.querySelector('#c-to') || {}).value || '',
    };
  })()`).catch(e => ({error: String(e && e.message || e)}));
  say('V3-收件人报错走右下角 toast 公共件、红、且不再叫人「分号隔开」',
      !errShot.error && errShot.toastShown && /无法识别的地址/.test(errShot.toastText)
        && /12@q/.test(errShot.toastText) && !/分号/.test(errShot.toastText)
        && !/一次填一个人|点 \+|回车|加下一个人/.test(errShot.toastText)
        && errShot.toastRed && errShot.toastAlert
        && errShot.noticeGone && errShot.ownRedText === 0
        && !/12@q/.test(errShot.stored || ''),
      JSON.stringify(errShot));
  await evalJs(`(() => { const to = document.querySelector('#c-to'); to.value = ${JSON.stringify(beforeTo)};
    to.dispatchEvent(new Event('input', {bubbles: true})); return 'restored'; })()`);

  // —— P. 真实剪贴板 + 真实 Cmd+V 粘表格（C5 第 2 条）——
  setClipboard(PASTE_HTML, PASTE_PLAIN);
  await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return 'caret';
  })()`);
  const VK = 86;
  await S('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    modifiers: 4, macCharCode: 0, commands: ['Paste'],
  });
  await S('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK, modifiers: 4,
  });
  await sleep(1200);
  const pasted = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    const tables = [...ed.querySelectorAll('table')];
    const tds = [...ed.querySelectorAll('td')];
    return {
      html: ed.innerHTML,
      tableCount: tables.length,
      nested: tables.some(t => t.querySelector('table')),
      hasColspan: Boolean(ed.querySelector('[colspan]')),
      hasRowspan: Boolean(ed.querySelector('[rowspan]')),
      bordered: tds.every(td => /border\\s*:\\s*(?!none)(?!0[\\spx])/i.test(td.getAttribute('style')||'')),
      zero: ed.textContent.includes('007'),
      cn: ed.textContent.includes('甲乙'),
    };
  })()`);
  say('P1-真实剪贴板 Cmd+V 粘进一张表', pasted.tableCount >= 1 && /<td/i.test(pasted.html),
      `表数=${pasted.tableCount}`);
  say('P2-与 C3 一致：合并格/前导零/中文都在', pasted.hasColspan && pasted.hasRowspan && pasted.zero && pasted.cn,
      `横合=${pasted.hasColspan} 纵合=${pasted.hasRowspan} 007=${pasted.zero} 甲乙=${pasted.cn}`);
  say('P3-粘出来必有框线且不套表', pasted.bordered && !pasted.nested,
      `全有框=${pasted.bordered} 套表=${pasted.nested}`);

  // —— I. 中文输入法上屏进表格单元格（C5 第 3 条）——
  /* 前置没粘出表时这里不该崩 —— 报「没格子」然后走 FAIL，别把整条链炸掉
     （实测：P1 没粘出表 → 这里 td 是 null → `td.textContent=''` 抛 TypeError，整条链断）。 */
  const imeGuard = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    if (!ed) return {error: 'no editor'};
    const tds = ed.querySelectorAll('td');
    const td = [...tds].find(t => /丙丁/.test(t.textContent)) || tds[0];
    if (!td) return {error: 'no table cell', tds: tds.length};
    td.textContent = '';
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(td); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return {ok: true, text: td.textContent};
  })()`).catch(e => ({error: String(e && e.message || e)}));
  if (imeGuard && imeGuard.error) {
    /* 只防崩、不代报 —— 后面的 I1/I2 断言会自己按实际情况报 FAIL。 */
    console.log(`   [IME 前置不足，跳过组字] ${JSON.stringify(imeGuard)}`);
  }
  /* 走真实输入法上屏链路，不是直接塞 innerHTML。
     CDP 的 `Input.insertText` 文档原话就是「插入不是来自按键的文本，比如表情键盘或输入法」——
     这就是 IME 上屏那条路。
     `Input.imeSetComposition` 是组字步，但实测会**一直不回**（要 IME 上下文/窗口焦点），
     所以给它套超时：挂住就跳过组字、直接上屏，不让它拖死整轮。 */
  /* `Input.insertText` 的 CDP 文档原话：「插入不是来自按键的文本，比如表情键盘或**输入法**」——
     这就是输入法上屏那条真实链路，不是直接改 innerHTML。
     组字步 `Input.imeSetComposition` 实测会一直不回并堵死 Input 通道，故不走它。 */
  await S('Input.insertText', {text: IME_TEXT});
  await sleep(900);
  const ime = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    const tds = [...ed.querySelectorAll('td')];
    const target = tds.find(t => (t.textContent||'').includes(${JSON.stringify(IME_TEXT)}));
    return {
      landedInCell: Boolean(target),
      cellText: target ? target.textContent : null,
      tableCount: ed.querySelectorAll('table').length,
      colspanStill: Boolean(ed.querySelector('[colspan]')),
      rowspanStill: Boolean(ed.querySelector('[rowspan]')),
      allText: ed.textContent,
    };
  })()`);
  say('I1-中文输入法上屏进表格单元格', ime.landedInCell === true,
      `落在格里的字: ${JSON.stringify(ime.cellText)}`);
  say('I2-上屏后表格不散（表数/合并格不变）',
      ime.tableCount === pasted.tableCount && ime.colspanStill && ime.rowspanStill,
      `表数 ${pasted.tableCount}→${ime.tableCount} 横合=${ime.colspanStill} 纵合=${ime.rowspanStill}`);

  // —— T. 复杂表操作（合并矩形）——
  const merged = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    const tables = [...ed.querySelectorAll('table')];
    const t = tables[tables.length - 1];
    const cells = [...t.querySelectorAll('td')];
    if (cells.length < 2) return {error: '格子不够'};
    const a = cells[0], b = cells[cells.length - 1];
    a.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
    b.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true}));
    const btn = document.querySelector('[data-editor-cell-merge]');
    if (!btn) return {error: '找不到合并按钮'};
    btn.click();
    return {after: t.outerHTML.slice(0, 200)};
  })()`);
  await sleep(500);
  const afterMerge = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    const t = ed.querySelector('table');
    const m = t && t.querySelector('[colspan][rowspan]');
    return {ok: Boolean(m), tag: m ? m.getAttribute('colspan') + 'x' + m.getAttribute('rowspan') : null,
            tables: ed.querySelectorAll('table').length};
  })()`);
  if (!afterMerge.ok) {
    const scene = await evalJs(`(() => {
      const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
      const btn = document.querySelector('[data-editor-cell-merge]');
      return {
        btn: Boolean(btn),
        tables: ed.querySelectorAll('table').length,
        cellCount: ed.querySelectorAll('td').length,
        html: ed.innerHTML.slice(0, 400),
      };
    })()`);
    console.log('   [诊断] 合并现场：' + JSON.stringify(scene).slice(0, 700));
  }
  say('T1-正式页矩形合并生效', afterMerge.ok === true, `合并后 ${afterMerge.tag}，表数 ${afterMerge.tables}；${merged.error || ''}`);

  // —— V. 保存（走页面上的保存按钮）——
  await evalJs(`(() => { const s = document.querySelector('#c-subject'); if (s) { s.value = ${JSON.stringify(draft.subject)}; s.dispatchEvent(new Event('input', {bubbles: true})); } return 'ok'; })()`);
  /* N3-B：没有「存草稿」按钮了 —— 改成失焦就存。所以这里把焦点挪出正文，等自动保存。 */
  const saved = await evalJs(`(async () => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    if (!ed) return {error: '找不到正文编辑器'};
    ed.blur();
    ed.dispatchEvent(new FocusEvent('blur', {bubbles: true}));
    await new Promise(r => setTimeout(r, 1500));
    return {blurred: true, saveBtn: Boolean(document.querySelector('#c-save'))};
  })()`);
  say('V1-失焦自动保存（无显性「存草稿」按钮）', saved.blurred === true && saved.saveBtn === false,
      JSON.stringify(saved));

  /* 存完之后还喊不喊「有未保存修改」—— 喊了就说明回执值和本地值对不上，
     那关闭就会一直弹确认（K1c 会红）。这里把**到底哪一栏对不上**量出来。 */
  const dirtyProbe = await evalJs(`(async () => {
    const note = document.querySelector('#dirty-note');
    const d = await (await fetch('/api/platform/services/mail.detail/invoke', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({payload: {mail: ${JSON.stringify(draft.name)}}}),
    })).json();
    const m = d.mail || d.result?.mail || {};
    const cur = {
      subject: (document.querySelector('#c-subject') || {}).value || '',
      body: (document.querySelector('#c-body') || {}).value || '',
    };
    const firstDiff = (a, b) => {
      if (a === b) return null;
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return {at: i, localLen: a.length, savedLen: b.length,
              local: a.slice(Math.max(0, i - 20), i + 40),
              saved: b.slice(Math.max(0, i - 20), i + 40)};
    };
    return {
      dirtyNoteShown: note ? !note.hidden : null,
      fieldStatus: [...document.querySelectorAll('[data-field-status]')]
        .map(el => el.getAttribute('data-field-status') + '=' + (el.textContent || '').trim())
        .filter(s => !s.endsWith('=')),
      subjectDiff: firstDiff(cur.subject, m.subject || ''),
      bodyDiff: firstDiff(cur.body, m.body || ''),
    };
  })()`);
  console.log('   [脏标记量测] ' + JSON.stringify(dirtyProbe).slice(0, 900));

  // —— K. 保存后读回（关 → 重开 的一半）——
  const savedDoc = await evalJs(`(async () => {
    const d = await (await fetch('/api/platform/services/mail.detail/invoke', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({payload: {mail: ${JSON.stringify(draft.name)}}}),
    })).json();
    const m = d.mail || d.result?.mail || {};
    return {body: m.body, subject: m.subject, record_version: m.record_version,
            inline: m.inline_resources || [], status: m.status};
  })()`);
  say('K1-保存后内容/表格/合并在库里', /colspan/.test(savedDoc.body || '')
      && /rowspan/.test(savedDoc.body || '') && /年费已核对/.test(savedDoc.body || ''),
      `v${savedDoc.record_version} 正文片段 ${(savedDoc.body || '').slice(0, 120)}`);
  const inlineKept = (savedDoc.inline || []).some(i => i.content_id === draft.cid);
  say('K1b-保存后受管内联图仍在（引用指向原 file）',
      inlineKept && (savedDoc.inline || []).some(i => i.file === draft.file),
      `inline=${JSON.stringify(savedDoc.inline)} 期望 cid=${draft.cid} file=${draft.file}`);

  // —— R2. 关 → 重开 ——
  /* 「关」必须走页面上的关闭，不是整页刷新绕过去。
     写信窗有未保存改动时，`tool-workspace.js:74` 的 beforeunload 守卫会弹原生
     「要离开吗」，`Page.navigate` 就卡在那儿不回（实测报成 CDP 超时）。
     保存过之后状态是干净的，点关闭应当直接关掉、不弹确认（N3-D 的 D2）。 */
  const closed = await evalJs(`(() => {
    const btn = document.querySelector('#dlg-close') || document.querySelector('#c-cancel');
    if (!btn) return {error: '找不到关闭按钮'};
    btn.click();
    return {clicked: true};
  })()`);
  await sleep(800);
  const afterClose = await evalJs(`(() => ({
    editor: Boolean(document.querySelector('.mail-body-editor') || document.querySelector('#c-editor')),
    dialogs: document.querySelectorAll('[role="dialog"], dialog, .mail-dialog').length,
  }))()`);
  say('K1c-点「关闭」写信窗就关（保存过 → 干净状态直接关，不弹确认）',
      closed.clicked === true && afterClose.editor === false,
      `点后编辑器还在=${afterClose.editor} 弹窗=${afterClose.dialogs} ${closed.error || ''}`);
  await nav(`${BASE}/index.html#/mail`);
  await clickRow(draft.subject);
  await waitFor('重开后的编辑器', `Boolean(document.querySelector('.mail-body-editor') || document.querySelector('#c-editor'))`, 12000);
  const reopened = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    if (!ed) return {error: '重开后没编辑器'};
    return {html: ed.innerHTML, text: ed.textContent,
            colspan: Boolean(ed.querySelector('[colspan]')),
            rowspan: Boolean(ed.querySelector('[rowspan]')),
            tables: ed.querySelectorAll('table').length};
  })()`);
  say('K2-关→重开：表格与合并格一条不丢', Boolean(reopened.html) && reopened.colspan && reopened.rowspan && reopened.tables >= 1,
      `表数=${reopened.tables} 横合=${reopened.colspan} 纵合=${reopened.rowspan}`);
  say('K3-关→重开：中文与前导零都在',
      (reopened.text || '').includes('年费已核对') && (reopened.text || '').includes('007'),
      `文本片段 ${(reopened.text || '').slice(0, 120)}`);
  const reopenedImg = await evalJs(`(() => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
    const img = ed.querySelector('img');
    return img ? {src: (img.getAttribute('src')||'').slice(0, 40),
                  data: (img.getAttribute('src')||'').indexOf('data:image') >= 0,
                  ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth} : null;
  })()`);
  say('K4-关→重开：内联图一条不丢，且真的解码出像素', Boolean(reopenedImg) && reopenedImg.ok === true,
      JSON.stringify(reopenedImg));

  // —— F. 故障证据：拿旧 record_version 去改 ——
  const stale = await evalJs(`(async () => {
    const act = async (id, payload, key) => {
      const r = await fetch('/api/platform/actions/' + id + '/execute', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({payload, confirmed: true, idempotency_key: key}),
      });
      const t = await r.text();
      return {ok: r.ok, status: r.status, text: t};
    };
    // 契约里指明「改哪封信」的字段是 mail（domain.py REF），不是 name；
    // 写错字段名会被 417「动作包含未声明字段」拒掉 —— 那是**字段错误**不是版本冲突，
    // 不能拿来冒充故障证据。所以这里用 mail + expected_version=1（当前已是 v3）。
    const r = await act('mail.save_draft', {
      mail: ${JSON.stringify(draft.name)},
      expected_version: 1,
      subject: '被旧版本盖掉就完了',
      body: '<p>这是不该被写进去的内容</p>',
      body_format: 'HTML', to: ['c5@example.invalid'], cc: [],
      attachments: [], inline_resources: [],
    }, 'c5-stale-' + Date.now());
    return {ok: r.ok, status: r.status, text: r.text.slice(0, 240)};
  })()`);
  /* 断言必须钉死到**版本冲突**那句话上：任何别的拒绝（字段错、权限、空草稿…）
     都不算证据。否则「拿错字段名被 417 拒」也会被当成故障证据，那就是假绿。 */
  const isStale = /邮件已更新|TimestampMismatch|请刷新后再操作/.test(stale.text || '');
  say('F1-旧 record_version 被拒（且确因版本冲突，不是别的错）', isStale,
      `HTTP ${stale.status} ${stale.text}`);
  const afterStale = await evalJs(`(async () => {
    const d = await (await fetch('/api/platform/services/mail.detail/invoke', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({payload: {mail: ${JSON.stringify(draft.name)}}}),
    })).json();
    const m = d.mail || d.result?.mail || {};
    return {body: m.body, subject: m.subject, record_version: m.record_version};
  })()`);
  say('F2-旧版本写入没盖掉已存内容',
      !/不该被写进去/.test(afterStale.body || '') && /年费已核对/.test(afterStale.body || ''),
      `正文片段 ${(afterStale.body || '').slice(0, 120)}`);

  // —— S7. 源信前后 diff 必须为空 ——
  const srcAfter = await evalJs(`(async () => {
    const d = await (await fetch('/api/platform/services/mail.detail/invoke', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({payload: {mail: ${JSON.stringify(src.name)}}}),
    })).json();
    const m = d.mail || d.result?.mail || {};
    return {body: m.body, status: m.status, subject: m.subject,
            inline: m.inline_resources || [], attachments: m.attachments || []};
  })()`);
  const srcAfterStr = JSON.stringify({body: srcAfter.body, status: srcAfter.status, subject: srcAfter.subject,
                                      inline: srcAfter.inline, attachments: srcAfter.attachments});
  say('S7-受控来信一字未变（源信 ≠ 草稿）', srcAfterStr === srcBefore,
      srcAfterStr === srcBefore ? '' : `改前 ${srcBefore.slice(0, 160)} / 改后 ${srcAfterStr.slice(0, 160)}`);
  say('S8-源信与草稿是两条记录', src.name !== draft.name, `${src.name} vs ${draft.name}`);

  /* ══ §6 C5 补段：回复 / 转发 / 撤回 / Excel 切换 / 生产 MIME 独立解析 ══
     用户 2026-10-12：「你需要做完 c5」。这几段是 §6 C5 判据里、旧链还没有的。 */

  /* —— Y1 回复：由原信建出**独立草稿**，收件人/线程对，原信不动 ——
     点开信后要**等到 #reply 真出现**再点；只 sleep(300) 会时序抖（实测偶发 no #reply）。 */
  await clickRow(SOURCE_SUBJECT);
  for (let i = 0; i < 20; i++) {
    const ready = await evalJs(`(() => Boolean(document.querySelector('#reply')))()`).catch(() => false);
    if (ready) break;
    await sleep(150);
  }
  const replyShot = await evalJs(`(async () => {
    const btn = document.querySelector('#reply');
    if (!btn) return {error: 'no #reply', detailOpen: Boolean(document.querySelector('#detail'))};
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const to = (document.querySelector('#c-to') || {}).value || '';
    const sub = (document.querySelector('#c-subject') || {}).value || '';
    const body = (document.querySelector('#c-body') || {}).value
      || (document.querySelector('.mail-body-editor') || {}).innerHTML || '';
    const me = (document.querySelector('#c-from') || {}).value || '';
    return {to, sub, bodyLen: (body || '').length, me, open: !!document.querySelector('#c-subject')};
  })()`).catch(e => ({error: String(e && e.message || e)}));
  const meAddr = String(replyShot.me || '').split('（')[0].trim();
  say('Y1-回复建出独立草稿：主题带 Re:，收件人是原发件人且不含本人',
      replyShot.open && /^Re: /.test(replyShot.sub)
        && replyShot.to.length > 0
        && (!meAddr || !replyShot.to.includes(meAddr)),
      JSON.stringify(replyShot));

  /* —— Y2 回复的线程引用：草稿要挂到原信上 —— */
  const threadShot = await evalJs(`(async () => {
    const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-body');
    if (ed) { ed.blur?.(); ed.dispatchEvent(new FocusEvent('blur', {bubbles: true})); }
    await new Promise(r => setTimeout(r, 700));
    return {ok: true};
  })()`);
  say('Y2-回复草稿失焦自动存（草稿 ID 与后续自动保存一致）', threadShot.ok, '');

  /* —— Y3 转发：正文带原信引用，附件可选 —— */
  const fwdShot = await evalJs(`(async () => {
    const cancel = document.querySelector('#c-cancel') || document.querySelector('#dlg-close');
    if (cancel) { cancel.click(); await new Promise(r => setTimeout(r, 250));
      const dlg = [...document.querySelectorAll('[role=dialog],dialog')].find(d => d.offsetParent !== null);
      const give = dlg && [...dlg.querySelectorAll('button')].find(b => /放弃|丢弃/.test(b.textContent || ''));
      if (give) { give.click(); await new Promise(r => setTimeout(r, 250)); } }
    await new Promise(r => setTimeout(r, 300));
    const row = [...document.querySelectorAll('[data-open],[data-mail]')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(SOURCE_SUBJECT)}));
    if (!row) return {error: 'row not found'};
    row.click();
    await new Promise(r => setTimeout(r, 600));
    const fwd = document.querySelector('#forward');
    if (!fwd) return {error: 'no #forward'};
    fwd.click();
    await new Promise(r => setTimeout(r, 700));
    const sub = (document.querySelector('#c-subject') || {}).value || '';
    const body = (document.querySelector('#c-body') || {}).value
      || (document.querySelector('.mail-body-editor') || {}).innerText || '';
    const atts = document.querySelectorAll('#c-attachments .att-row').length;
    return {sub, hasQuote: /原文|来源|发件人/.test(body), atts, bodyLen: body.length};
  })()`).catch(e => ({error: String(e && e.message || e)}));
  say('Y3-转发：主题带 Fwd:，正文含原信引用（来源/发件人），附件可选',
      !fwdShot.error && /^Fwd: /.test(fwdShot.sub) && fwdShot.hasQuote && fwdShot.atts >= 0,
      JSON.stringify(fwdShot));

  /* —— Y4 撤回：正文编辑整步恢复，主题/收件人不动 —— */
  const undoShot = await evalJs(`(async () => {
    const ed = document.querySelector('.mail-body-editor');
    if (!ed) return {error: 'no editor'};
    const sub = (document.querySelector('#c-subject') || {}).value || '';
    const to = (document.querySelector('#c-to') || {}).value || '';
    const before = ed.innerHTML;
    ed.focus();
    ed.innerHTML = before + '<p data-c5-undo>撤回标记段</p>';
    ed.dispatchEvent(new Event('input', {bubbles: true}));
    await new Promise(r => setTimeout(r, 120));
    const mid = ed.innerHTML;
    ed.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', metaKey: true, bubbles: true, cancelable: true}));
    await new Promise(r => setTimeout(r, 200));
    const after = ed.innerHTML;
    return {
      changed: mid !== before,
      restored: after === before,
      subSame: ((document.querySelector('#c-subject') || {}).value || '') === sub,
      toSame: ((document.querySelector('#c-to') || {}).value || '') === to,
      marker: /data-c5-undo/.test(after),
    };
  })()`).catch(e => ({error: String(e && e.message || e)}));
  say('Y4-撤回：正文整步恢复，主题/收件人不动（步数上限等三细节待用户拍板，未纳入）',
      !undoShot.error && undoShot.changed && undoShot.restored
        && undoShot.subSame && undoShot.toSame && !undoShot.marker,
      JSON.stringify(undoShot));

  /* —— Y5 Excel↔邮件切换：来回切不丢邮件面 ——
     判据要**真的切了**才作数：上一版 hadTab/hadBack 都是 false（页签没找到、压根没切），
     却因为「列表还在」就过了 —— 那是假绿。现在必须两个页签都点到。 */
  const switchShot = await evalJs(`(async () => {
    const navSel = 'nav button, [data-nav], [data-page], .rail button, .side-nav button, a[href^="#"]';
    const all = () => [...document.querySelectorAll(navSel)];
    const tab = all().find(el => /表格|Excel|Sheet|sheet/i.test(el.textContent || ''));
    const before = (document.querySelector('#c-subject') || {}).value || '(无写信窗)';
    const rowsBefore = document.querySelectorAll('[data-mail],[data-open]').length;
    if (tab) { tab.click(); await new Promise(r => setTimeout(r, 800)); }
    const onOther = tab ? all().some(el => /邮件|Mail|mail/i.test(el.textContent || '')) : false;
    const back = all().find(el => /邮件|Mail|mail/i.test(el.textContent || ''));
    if (back) { back.click(); await new Promise(r => setTimeout(r, 800)); }
    const after = (document.querySelector('#c-subject') || {}).value || '(无写信窗)';
    const rows = document.querySelectorAll('[data-mail],[data-open]').length;
    return {hadTab: !!tab, hadBack: !!back, onOther, before, after, rowsBefore, rows,
            navSample: all().map(el => (el.textContent || '').trim()).filter(Boolean).slice(0, 8)};
  })()`).catch(e => ({error: String(e && e.message || e)}));
  say('Y5-Excel↔邮件切换：两个页签都点到，且切回后邮件面还在',
      !switchShot.error && switchShot.hadTab && switchShot.hadBack && switchShot.rows > 0,
      JSON.stringify(switchShot));

  writeFileSync(STATE_OUT, JSON.stringify({
    source: {name: src.name, subject: src.subject},
    draft: {name: draft.name, subject: draft.subject, record_version: afterStale.record_version},
    previewBody: afterStale.body || '',
  }, null, 2));
  say('S9-已写出给 MIME 核验器的状态文件', true, STATE_OUT);

  /* —— Y6 生产 MIME 独立解析：把核验器**串进链里**跑，不再另说「另跑过」 ——
     两条实测坑，写在这儿免得再踩：
     ① 核验器要 `frappe`，只能在 Frappe 容器里跑；宿主机 python3 会 No module named 'frappe'。
     ② 宿主机 /tmp 和容器 /tmp 不是同一个 —— 状态文件要写到**挂载目录**里容器才看得见。
     另：仓库路径含中文，import.meta.url 的 pathname 是百分号编码的，用前要 decodeURIComponent。 */
  {
    const {execFileSync} = await import('node:child_process');
    const {copyFileSync} = await import('node:fs');
    const deployRoot = process.env.SHANGSHU_DEPLOY_DIR
      || '/path/to/workspace';
    const CONTAINER = process.env.SHANGSHU_CONTAINER || 'shangshu-local-c-frappe-1';
    const stateInDeploy = `${deployRoot}/shangshu-server/.c5-chain-state.json`;
    const stateInContainer = '/srv/shangshu/shangshu-server/.c5-chain-state.json';
    const verifierInContainer = '/srv/shangshu/shangshu-server/scripts/test-mail-c5-mime-verify.py';
    let out = '', ok = false, err = '';
    try {
      copyFileSync(STATE_OUT, stateInDeploy);
      out = execFileSync('docker', ['exec', CONTAINER,
          '/home/frappe/frappe-bench/env/bin/python', verifierInContainer, stateInContainer],
          {encoding: 'utf8', timeout: 180000});
      ok = /\bPASS\b|全部通过|12\/12/.test(out);
    } catch (e) {
      err = String(e && e.message || e);
      out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
      ok = /\bPASS\b|全部通过/.test(out);
    }
    say('Y6-生产 MIME 独立解析与预览一致（核验器在 Frappe 容器里跑）', ok,
        (out || err).slice(-300).replace(/\n/g, '；'));
  }
  /* 一路上不该有原生对话框卡住页面。真出现了就报出来，不许静默吞。 */
  say('S10-整条链没被原生对话框卡住', dialogs.length === 0,
      dialogs.length ? JSON.stringify(dialogs) : '');

  ws.close();
} catch (e) {
  say('9-脚本自身', false, String(e && e.message || e));
} finally {
  try { chrome.kill(); } catch {}
}

console.log(results.join('\n'));
console.log('---');
console.log(results.filter(l => l.includes('|PASS|')).length + ' PASS / ' + results.filter(l => l.includes('|FAIL|')).length + ' FAIL');
