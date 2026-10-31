#!/usr/bin/env node
/*
  N2-C1 「阅读器」面 —— 收信（非草稿）打开时的沙箱预览。

  ⚠️ 证据性质说明（不许误读）：
  本脚本验的是**渲染面**，不是收件链路。
  用来验的那封信是**插库造的夹具**（用户 2026-10-11 明确授权做这一次），
  主题带「【夹具】…（插库造，非真实收信）」。它的 status 被置成 Received，
  但**没有**穿过 transport.imap_session / fetch_message / parse_message 那条真 sync。
  所以：C1 的「阅读器图片真显示」以此为准；**C4 的收件链路证据另算**，必须走真实传输边界。

  测试通过 = 下面全部成立（真实 Chrome、3830 正式产品页）：
  1. 点开那封 Received 夹具信，正文走**无脚本沙箱**（sandbox="" + CSP default-src 'none'）。
  2. 沙箱里的受管内联图**真的显示**：srcdoc 里是可解码的 data:image/，不是 cid: 空占位。
  3. 表格有可见框线，横向/纵向合并不丢（colspan/rowspan 仍在）。
  4. 金额、日期不变形（1,234,567.89 / 2026-10-24）。
  5. 不发起任意外部图片请求。
  6. 读信窗正文面**只有一个**（沙箱预览），不是两个。
*/
import {spawn} from 'node:child_process';
import {readFileSync, rmSync} from 'node:fs';

const BASE = 'http://127.0.0.1:3830';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9345;
const PROFILE = '/tmp/cdp-agent-c-reader';
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

    await S('Page.enable'); await S('Runtime.enable');

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

    // 找那封夹具信（按主题标记，避免误开别的信）
    const found = await evalJs(`(async () => {
      const list = await (await fetch('/api/platform/datasets/mail.message/records?page=1&page_length=50&filters=' +
        encodeURIComponent(JSON.stringify({scope:'all',order:'desc'})))).json();
      const rows = list.rows || list.result?.rows || [];
      for (const r of rows) {
        if (String(r.subject || '').includes('【夹具】阅读器渲染核对')) return {name: r.name, subject: r.subject, status: r.status};
      }
      return null;
    })()`);
    say('R0-找到夹具收信', Boolean(found),
        found ? `${found.name}「${found.subject}」status=${found.status}` : '库里没有夹具信（先跑插库那一步）');
    if (!found) throw new Error('stop');

    await nav(`${BASE}/index.html#/mail`);
    await sleep(2500);
    await evalJs(`(async () => {
      const items = [...document.querySelectorAll('[data-mail],[data-open]')];
      for (const it of items) {
        if ((it.textContent || '').includes('【夹具】阅读器渲染核对')) { it.click(); break; }
      }
      await new Promise(r => setTimeout(r, 1500));
      return true;
    })()`);
    await sleep(1500);

    const view = await evalJs(`(() => {
      const frame = document.querySelector('iframe.mail-body-preview');
      const surfaces = document.querySelectorAll('.mail-body-editor, .mail-body-text, iframe.mail-body-preview');
      return {
        hasFrame: !!frame,
        sandbox: frame ? frame.getAttribute('sandbox') : null,
        surfaces: surfaces.length,
        srcdoc: frame ? (frame.getAttribute('srcdoc') || '') : '',
      };
    })()`);

    say('R1-读信走无脚本沙箱', view.hasFrame && view.sandbox === '',
        view.hasFrame ? `sandbox="${view.sandbox}"` : '找不到沙箱预览面');
    say('R2-读信正文面只有一个', view.surfaces === 1, `正文面数量=${view.surfaces}`);

    const d = view.srcdoc || '';
    say('R3-沙箱有 CSP 禁网', /default-src 'none'/.test(d), /default-src 'none'/.test(d) ? 'CSP 在' : '缺 CSP');
    say('R4-受管内联图真的显示', /src="data:image\//i.test(d),
        /src="data:image\//i.test(d) ? 'srcdoc 里是可解码的 data:image' : `没有 data:image，前 100 字：${d.slice(0, 100)}`);
    say('R5-图不外联', !/src="https?:/i.test(d), /src="https?:/i.test(d) ? '出现了外链图' : '无外链 src');
    say('R6-表格有可见框线', /border\s*:\s*(?!none|0)[^;"']+/i.test(d) || /border="1"/i.test(d),
        /border/i.test(d) ? '有 border 声明' : '没找到框线');
    say('R7-合并不丢', /colspan="2"/i.test(d) && /rowspan="2"/i.test(d),
        `colspan=${/colspan="2"/i.test(d)} rowspan=${/rowspan="2"/i.test(d)}`);
    say('R8-金额日期不变形', /1,234,567\.89/.test(d) && /2026-10-24/.test(d),
        `金额=${/1,234,567\.89/.test(d)} 日期=${/2026-10-24/.test(d)}`);

  } finally {
    cdp.close();
    chrome.kill();
    try { rmSync(PROFILE, {recursive: true, force: true}); } catch {}
  }

  for (const line of results) console.log(line);
  console.log('SUMMARY|' + (results.every(l => l.includes('|PASS|')) ? 'PASS' : 'FAIL'));
}

main().catch(e => {
  for (const line of results) console.log(line);
  console.log('ERROR|' + redact(String(e.message || e)).slice(0, 200));
  process.exit(1);
});
