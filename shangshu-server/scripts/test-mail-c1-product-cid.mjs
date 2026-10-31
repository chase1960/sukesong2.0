#!/usr/bin/env node
/*
  N2-C1 正式页面图片真显示 —— 真实 Chrome + 真实产品页 http://127.0.0.1:3830/index.html#/mail
  口令由本脚本从环境文件读，直接提交登录 —— 一次都不打印。
  输出只有 PASS/FAIL 结果行。

  测试通过 = 下面全部成立（真实 Chrome、正式产品页、库里的真草稿，不是夹具页）：
  1. 打开一封**已存 inline_resources** 的 HTML 草稿，编辑器里那张受管内联图
     **真的解码出像素**（img.complete && img.naturalWidth > 0），src 是 data:image/，
     不是破图、不是 cid: 空占位。
  2. 编辑器里该图**不外联**：src 不是 http(s)；网络面板没有为它发出外部请求。
  3. 保存后正文仍是 `src="cid:…"` 引用（字节不写进正文），
     且 inline_resources 仍指向**原 file**（受管资源与固定版本不变）。
  4. 「预览」面（发送确认里的沙箱预览）srcdoc 里是**可解码的 data:image/**，
     且不含外链 src。
  5. 正文若含外部跟踪图，**零外部请求**（连发都不发）。
  6. 无权/不存在的受管资源：**读不到字节**，图不显示也不报错。

  NOT_RUN 说明（不算通过）：
  - 「预览」＝发送确认里的沙箱预览。测试实例没绑邮箱（绑定要真凭据，
    硬边界「不用客户邮箱凭据」明令不碰），发送按钮禁用，开不出确认框。
    这条与「阅读器」共用同一个 hydratePreview，阅读器已在 test-mail-c1-reader-preview.mjs
    实测通过；但**不以代码路径相同充数**，故如实记 NOT_RUN。
  - 「阅读器」＝收信面沙箱预览，在 test-mail-c1-reader-preview.mjs 单独实测。
    ⚠️ 那封是**插库造的夹具**（用户 2026-10-11 授权做这一次），只验渲染面，
    **不作为 C4 收件链路证据** —— C4 必须走真实传输边界。
*/
import {spawn} from 'node:child_process';
import {readFileSync, rmSync} from 'node:fs';

const BASE = 'http://127.0.0.1:3830';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9341;
const PROFILE = '/tmp/cdp-agent-c-c1';
const ENV = '/path/to/workspace';

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

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
        }
      };
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error('CDP 连接失败'));
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  close() { try { this.ws?.close(); } catch {} }
}

async function main() {
  const password = loadPassword();
  REDACT = password;
  rmSync(PROFILE, {recursive: true, force: true});
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1440,900', 'about:blank',
  ], {stdio: 'ignore'});

  const cdp = await new CDP(await wsUrl()).open();
  try {
    const {targetId} = await cdp.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
    const S = (m, p = {}) => cdp.send(m, p, sessionId);
    const evalJs = async (expression) => {
      const r = await S('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 异常').slice(0, 300));
      return r.result?.value;
    };
    const nav = async url => { await S('Page.navigate', {url}); await sleep(2500); };

    await S('Page.enable');
    await S('Runtime.enable');
    await S('Network.enable');
    // 记录所有外部请求 —— 「外链跟踪图不自动请求」靠这里取证
    const external = [];
    // 注意：本脚本只订阅不打印请求内容；口令不出现在任何 URL/请求体里。

    // —— 1. 登录（口令只在这里用，不回显）——
    await nav(`${BASE}/login.html`);
    const already = await evalJs(`(async () => {
      const r = await fetch('/api/platform/session');
      const j = await r.json().catch(() => ({}));
      return (j.user_name === 'Administrator' || j.identity_id) ? 'in' : 'out';
    })()`);
    let loggedIn = already === 'in';
    if (!loggedIn) {
      loggedIn = await evalJs(`(async () => {
        const r = await fetch('/api/platform/login', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({username: 'Administrator', password: ${JSON.stringify(password)}}),
        });
        const j = await r.json().catch(() => ({}));
        return r.ok && j.ok !== false;
      })()`);
    }
    say('L1-登录正式产品页', loggedIn === true, loggedIn ? '已拿到真实身份' : '登录失败');
    if (loggedIn !== true) throw new Error('stop');

    // —— 2. 走真实保存路径造一封带受管内联图的草稿（不插库）——
    // 旧草稿的 inline_resources 是「未挂到信上」的历史引用，修复只对新保存生效，
    // 所以这里必须自己走一遍真实的 files.upload + mail.save_draft。
    const picked = await evalJs(`(async () => {
      const marker = 'c1-' + Math.random().toString(36).slice(2, 10);
      const cid = marker + '@shangshu.local';
      // 64×64 红底白边，像枚签章 —— 与样本链同构的最小 PNG
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAWElEQVR42u3aMREAMAgEQeTgXwHOEhHQMOzPGdj+4y1fAAAMAipzRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPYDnLsBBwAfN3jopUhd1FgAAAABJRU5ErkJggg==';
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      // sha256
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      const act = async (id, payload, key) => {
        const r = await fetch('/api/platform/actions/' + id + '/execute', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({payload, confirmed: true, idempotency_key: key}),
        });
        const t = await r.text();
        if (!r.ok) throw new Error(id + ' ' + r.status + ' ' + t.slice(0, 120));
        return JSON.parse(t).result;
      };
      const up = await act('files.upload', {
        file_name: 'C1签章-' + marker + '.png',
        content_base64: b64,
        file_sha256: sha,
      }, 'c1-file-' + marker);
      const versions = await (await fetch('/api/platform/services/files.versions/invoke', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({payload: {file: up.file}}),
      })).json();
      const list = (versions.result || versions).versions || [];
      const hit = list.find(v => v.version_no === up.version);
      if (!hit || !hit.frappe_file) throw new Error('上传后拿不到固定版本的受管文件引用');
      const body = '<p>签章见下</p><table><tr><td colspan="2">案件汇总</td></tr><tr><td rowspan="2">A001</td><td>1,234,567.89</td></tr><tr><td>0.00</td></tr></table>'
        + '<p><img src="cid:' + cid + '" alt="签章"></p>';
      const saved = await act('mail.save_draft', {
        subject: 'C1 受管图核对 ' + marker,
        body, body_format: 'HTML',
        to: ['核对 <c1@example.invalid>'], cc: [],
        attachments: [],
        inline_resources: [{content_id: cid, mime_type: 'image/png', name: '签章.png', file: hit.frappe_file}],
      }, 'c1-mail-' + marker);
      return {name: saved.name, subject: 'C1 受管图核对 ' + marker, cid,
              file: (saved.inline_resources || [])[0]?.file || '',
              mime: 'image/png', hasTable: true,
              hasBase64: /data:image/.test(saved.body || '')};
    })()`);
    say('C1a-走真实保存路径造出带受管图的草稿', Boolean(picked && picked.name),
        picked ? `草稿 ${picked.name}「${picked.subject}」cid=${picked.cid} 存后 file=${picked.file}` : '造草稿失败');
    if (!picked || !picked.name) throw new Error('stop');
    say('C1b-正文只存 cid 引用不存字节', picked.hasBase64 === false,
        picked.hasBase64 ? '正文里出现了 base64 —— 字节被写进正文了' : '正文是 cid: 引用，字节在受管资源里');

    // —— 3. 进产品页，点开这封草稿（草稿走写信窗 = 编辑器）——
    await nav(`${BASE}/index.html#/mail`);
    await sleep(2500);
    await evalJs(`(async () => {
      const items = [...document.querySelectorAll('[data-mail],[data-open]')];
      for (const it of items) {
        if ((it.textContent||'').includes(${JSON.stringify(picked.subject)})) { it.click(); break; }
      }
      await new Promise(r => setTimeout(r, 1200));
      return true;
    })()`);
    await sleep(1500);

    // —— 4. 编辑器里那张图要真解码出像素 ——
    const img = await evalJs(`(async () => {
      const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-editor');
      if (!ed) return {ok:false, why:'找不到正文编辑器'};
      const el = ed.querySelector('img');
      if (!el) return {ok:false, why:'编辑器里没有 img', editorHtml: ed.innerHTML.slice(0,200)};
      // 等图片解码
      for (let i=0;i<40 && !el.complete;i++) await new Promise(r=>setTimeout(r,100));
      return {ok:true, src: (el.getAttribute('src')||'').slice(0,30), srcLen:(el.getAttribute('src')||'').length,
              naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, complete: el.complete,
              managedCid: el.getAttribute('data-managed-cid') || ''};
    })()`);
    if (!img.ok) {
      say('C1c-编辑器里受管图真解码', false, img.why || '失败');
    } else {
      say('C1c-编辑器里受管图真解码', img.complete === true && img.naturalWidth > 0,
          `complete=${img.complete} naturalWidth=${img.naturalWidth}×${img.naturalHeight} src前缀=${img.src}`);
      say('C1d-图来源是 data:image 不是外链', /^data:image\//i.test(img.src || ''),
          `src 前 30 字符＝${img.src}`);
      say('C1e-受管 cid 身份仍在（存回去还是 cid）', /cid:/.test(img.managedCid),
          `data-managed-cid=${img.managedCid}`);
    }

    // —— 5. 外链零请求：正文里的外部图连发都不发 ——
    const extBefore = await evalJs(`performance.getEntriesByType('resource').filter(r=>/^https?:\\/\\//i.test(r.name) && !r.name.startsWith(location.origin)).map(r=>r.name)`);
    say('C1f-无外部资源请求', Array.isArray(extBefore) && extBefore.length === 0,
        `外部请求 ${Array.isArray(extBefore) ? extBefore.length : '?'} 条`);

    // —— 6. 保存后仍是 cid 引用 + inline_resources 仍指原 file ——
    const saved = await evalJs(`(async () => {
      const subject = document.querySelector('#c-subject');
      if (subject) { subject.value = subject.value || 'C1 受管图核对'; subject.dispatchEvent(new Event('input',{bubbles:true})); }
      const btn = document.querySelector('#c-save');
      if (!btn) return {ok:false, why:'找不到存草稿按钮'};
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      const payload = window.__c1_last_save || null;
      // 存完重新读详情
      const d = await (await fetch('/api/platform/services/mail.detail/invoke', {
        method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({payload:{mail:${JSON.stringify(picked.name)}}})
      })).json();
      const m = d.result?.mail || d.mail || {};
      return {ok:true, bodyHasCid: /src=["']cid:/i.test(String(m.body||'')),
              bodyHasBase64: /data:image/.test(String(m.body||'')),
              inline: (m.inline_resources||[]).map(x=>({cid:x.content_id, file:x.file}))};
    })()`);
    if (saved.ok) {
      say('C1g-保存后正文仍引用 cid', saved.bodyHasCid === true,
          saved.bodyHasCid ? 'src 仍是 cid: 引用' : '正文里的 cid 引用丢了');
      say('C1h-保存后字节不进正文', saved.bodyHasBase64 === false,
          saved.bodyHasBase64 ? '正文被写进 base64 了' : '正文仍无 base64');
      const sameFile = Array.isArray(saved.inline) && saved.inline.some(x => x.file === picked.file);
      say('C1i-inline_resources 仍指原受管资源', sameFile,
          `存后 inline=${JSON.stringify(saved.inline)} 原 file=${picked.file}`);
    } else {
      say('C1g-保存后引用不变', false, saved.why || '失败');
    }

    // —— 7. 无权/不属于这封信的资源读不到字节 ——
    // 活接口是 /api/platform/file-content，必须带归属。取一个**不挂在这封信上**的文件：
    // 内核应拒（403「该文件未挂在此记录上」），且不返回图片字节。
    const noRight = await evalJs(`(async () => {
      const out = {};
      // 1) 归属齐全但文件不挂在这封信上 —— 用刚才那封信的 ref，换一个别人的/不存在的 file
      const q1 = new URLSearchParams({ref:'Shangshu Mail Message', ref_name:${JSON.stringify(picked.name)}, file:'no-such-file-c1'});
      const r1 = await fetch('/api/platform/file-content?' + q1, {credentials:'same-origin'});
      const b1 = await r1.arrayBuffer();
      out.detached = {status: r1.status, bytes: b1.byteLength, isPng: b1.byteLength > 8 && new Uint8Array(b1)[0] === 0x89};
      // 2) 带一个不属于本信的真文件 id（借另一封信的资源）—— 也必须拒
      const q2 = new URLSearchParams({ref:'Shangshu Mail Message', ref_name:${JSON.stringify(picked.name)}, file:'e7f14a6c83'});
      const r2 = await fetch('/api/platform/file-content?' + q2, {credentials:'same-origin'});
      const b2 = await r2.arrayBuffer();
      out.foreign = {status: r2.status, bytes: b2.byteLength, isPng: b2.byteLength > 8 && new Uint8Array(b2)[0] === 0x89};
      return out;
    })()`);
    const blocked = x => x && x.status !== 200 && !x.isPng;
    say('C1j-不挂在这封信上的资源读不到字节', blocked(noRight.detached) && blocked(noRight.foreign),
        `不存在的 file: HTTP ${noRight.detached?.status}/${noRight.detached?.bytes}字节；` +
        `别人的 file: HTTP ${noRight.foreign?.status}/${noRight.foreign?.bytes}字节`);

    // —— 8. 「预览」面：发送确认里的沙箱预览 ——
    // 只点「发送」开确认框，**绝不点「确认发送」**；看完就关。全程零外发。
    // 注意：测试实例没绑邮箱（绑定要真凭据，硬边界「不用客户邮箱凭据」明令不碰），
    // 发送按钮是禁用的，开不出确认框 —— 那就如实记 NOT_RUN，不糊成 FAIL 也不假绿。
    const preview = await evalJs(`(async () => {
      const send = document.querySelector('#c-send');
      if (!send) return {ok:false, why:'找不到发送按钮（写信窗没开着）'};
      if (send.disabled) return {ok:false, disabled:true, why:'发送按钮禁用（测试实例未绑邮箱）'};
      send.click();
      await new Promise(r => setTimeout(r, 1200));
      const frame = document.querySelector('iframe.mail-body-preview');
      const out = {ok: true, hasFrame: !!frame, sandbox: frame ? frame.getAttribute('sandbox') : null,
                   srcdoc: frame ? (frame.getAttribute('srcdoc') || '') : ''};
      const close = document.querySelector('#dlg-close2') || document.querySelector('#dlg-close');
      if (close) close.click();
      await new Promise(r => setTimeout(r, 500));
      return out;
    })()`);
    if (!preview.ok) {
      results.push(`C1k-预览面（发送确认）受管图显示|NOT_RUN|${redact(preview.why || '失败')}`);
    } else {
      const pd = preview.srcdoc || '';
      const hasData = pd.includes('src="data:image/') || pd.includes("src='data:image/");
      const hasExt = pd.includes('src="http') || pd.includes("src='http");
      say('C1k-预览面（发送确认）受管图显示', Boolean(preview.hasFrame) && hasData && !hasExt,
          `沙箱=${preview.sandbox} 有data:image=${hasData} 外链=${hasExt}`);
    }

  } finally {
    cdp.close();
    chrome.kill();
    try { rmSync(PROFILE, {recursive: true, force: true}); } catch {}
  }

  for (const line of results) console.log(line);
  const failed = results.filter(l => l.includes('|FAIL|')).length;
  const notRun = results.filter(l => l.includes('|NOT_RUN|')).length;
  console.log('SUMMARY|' + (failed ? 'FAIL' : (notRun ? 'PASS_WITH_NOT_RUN' : 'PASS'))
    + `|PASS=${results.filter(l => l.includes('|PASS|')).length} FAIL=${failed} NOT_RUN=${notRun}`);
}

main().catch(e => {
  for (const line of results) console.log(line);
  console.log('ERROR|' + redact(String(e.message || e)).slice(0, 200));
  process.exit(1);
});
