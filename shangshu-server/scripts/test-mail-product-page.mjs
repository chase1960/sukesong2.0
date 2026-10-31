#!/usr/bin/env node
/*
  产品页真实浏览器验收：起真实 Chrome，走 DevTools 协议驱动【真实产品页】。
  口令由本脚本从环境文件读，直接提交登录 —— 一次都不打印。
  输出只有 PASS/FAIL 结果行。

  测试通过 = 下面全部成立（真实 Chrome + 真实产品页 http://127.0.0.1:3830/index.html#/mail）：
  1. 登录后产品页真的挂起来（不是夹具页）。
  2. 写信窗口的收件人/抄送是胶囊，回车/点+ 加人、点× 删人生效。
  3. 写信窗口工具栏按钮真的能插表、增删行列、合并拆分（点真实按钮）。
  4. 点开样例里带表格的信，阅读区渲染出带框线表格、合并格、内嵌图。
*/
import {spawn} from 'node:child_process';
import {readFileSync, rmSync} from 'node:fs';

const BASE = 'http://127.0.0.1:3830';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = '/tmp/cdp-agent-c-visual';
const ENV = process.env.SHANGSHU_ENV || '/path/to/workspace';

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
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
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

    // —— 1. 登录（口令只在这里用，不回显）——
    await nav(`${BASE}/login.html`);
    // 会话可能已存在（上次残留）；能拿到真实身份就算登录成功，不必非要看到登录框。
    const already = await evalJs(`(async () => {
      const r = await fetch('/api/platform/session');
      const j = await r.json().catch(() => ({}));
      return (j.user_name === 'Administrator' || j.identity_id) ? 'in' : 'out';
    })()`);
    const ready = await evalJs(`document.querySelector('#un') ? 'ok' : 'no-form'`);
    if (already === 'out' && ready !== 'ok') {
      say('L0-登录页', false, `登录框没出来且未登录：${await evalJs('document.title')}`);
      throw new Error('stop');
    }
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
    say('L1-登录产品页', loggedIn === true, loggedIn ? '已拿到真实身份' : '登录失败');
    if (loggedIn !== true) throw new Error('stop');

    // —— 2. 进产品页邮箱 ——
    await nav(`${BASE}/index.html#/mail`);
    await sleep(2500);
    const shell = await evalJs(`({
      hasMail: !!document.querySelector('.mail-center-page, #mail-rows, #compose'),
      compose: !!document.querySelector('#compose'),
      title: (document.querySelector('h1')||{}).textContent || '',
    })`);
    say('P1-产品页挂起', shell.hasMail && shell.compose,
        `邮箱区块=${shell.hasMail} 写信按钮=${shell.compose} 标题「${shell.title}」`);

    // —— 3. 进交互样例 ——
    await evalJs(`(async () => {
      const b = document.querySelector('#examples-toggle') || document.querySelector('[data-mail-examples]');
      if (b) b.click();
      await new Promise(r => setTimeout(r, 800));
      return document.querySelectorAll('[data-mail]').length;
    })()`);
    const sampleCount = await evalJs(`document.querySelectorAll('[data-mail]').length`);
    say('P2-样例列表', sampleCount > 0, `样例 ${sampleCount} 封`);

    // —— 4. 点开带表格的那封 ——
    const readSample = await evalJs(`(async () => {
      const items = [...document.querySelectorAll('[data-mail]')];
      for (const it of items) {
        it.click();
        await new Promise(r => setTimeout(r, 700));
        const f = document.querySelector('iframe.mail-body-preview, iframe[title="邮件正文预览"]');
        if (!f) continue;
        const doc = f.getAttribute('srcdoc') || '';
        if (!/<table/i.test(doc)) continue;
        return {found: true, border: /border\\s*:\\s*(?!none|0)[^;\"']+/i.test(doc),
                merge: /colspan|rowspan/i.test(doc), cid: /cid:/i.test(doc),
                amount: /1,234,567\\.89/.test(doc), date: /2026-10-24/.test(doc)};
      }
      return {found: false};
    })()`);
    say('R1-阅读带表格的信', readSample.found, readSample.found ? '找到并点开了' : '列表里没有带表格的信');
    if (readSample.found) {
      say('R2-表格框线', readSample.border, readSample.border ? '渲染内容里有可见框线' : '框线丢了');
      say('R3-合并格', readSample.merge, readSample.merge ? '横/纵向合并在' : '合并信息丢了');
      say('R4-内嵌图', readSample.cid, readSample.cid ? '受管 cid 引用在，未外联' : '内嵌图丢了');
      say('R5-金额日期', readSample.amount && readSample.date, `金额=${readSample.amount} 日期=${readSample.date}`);
    }

    // —— 5. 写信窗口：胶囊 + 工具栏（点真实按钮）——
    await evalJs(`(async () => {
      const b = document.querySelector('#compose'); if (b) b.click();
      await new Promise(r => setTimeout(r, 900));
      return true;
    })()`);
    const compose = await evalJs(`({
      chipsHost: !!document.querySelector('#c-to-chips .chip-input, #c-to-chips'),
      ccHost: !!document.querySelector('#c-cc-chips .chip-input, #c-cc-chips'),
      toolbar: !!document.querySelector('.mail-editor-toolbar, [role="toolbar"]'),
      editor: !!document.querySelector('.mail-body-editor'),
    })`);
    say('W1-写信窗挂起', compose.editor, `编辑区=${compose.editor} 工具栏=${compose.toolbar}`);
    say('W2-收件人是胶囊', compose.chipsHost && compose.ccHost,
        `收件人=${compose.chipsHost} 抄送=${compose.ccHost}`);

    const chips = await evalJs(`(async () => {
      const host = document.querySelector('#c-to-chips');
      const field = host && host.querySelector('input');
      const add = host && host.querySelector('[data-chip-add]');
      if (!field) return {ok: false, why: '找不到胶囊输入框'};
      field.value = '张三 <a@qq.com>';
      field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
      await new Promise(r => setTimeout(r, 300));
      const afterEnter = host.querySelectorAll('[data-chip]').length;
      field.value = '李四 <b@qq.com>';
      if (add) add.click();
      await new Promise(r => setTimeout(r, 300));
      const afterAdd = host.querySelectorAll('[data-chip]').length;
      const x = host.querySelector('[data-chip-remove]');
      if (x) x.click();
      await new Promise(r => setTimeout(r, 300));
      const afterDel = host.querySelectorAll('[data-chip]').length;
      return {ok: true, afterEnter, afterAdd, afterDel};
    })()`);
    say('W3-胶囊加人删人', chips.ok && chips.afterEnter === 1 && chips.afterAdd === 2 && chips.afterDel === 1,
        chips.ok ? `回车后=${chips.afterEnter} 点+后=${chips.afterAdd} 点×后=${chips.afterDel}` : (chips.why || '失败'));

    const table = await evalJs(`(async () => {
      const bar = document.querySelector('.mail-editor-toolbar, [role="toolbar"]');
      const ed = document.querySelector('.mail-body-editor');
      if (!bar || !ed) return {ok: false, why: '缺工具栏或编辑区'};
      const by = t => [...bar.querySelectorAll('button')].find(b => (b.title || '') === t);
      const click = t => { const b = by(t); if (b) b.click(); return !!b; };
      const rows = () => ed.querySelectorAll('table tr').length;
      const cols = () => (ed.querySelector('table tr') ? ed.querySelector('table tr').querySelectorAll('td,th').length : 0);
      const ok = {};
      ok.insert = click('插入表格') && ed.querySelector('table') && rows() === 2 && cols() === 2;
      const cell = ed.querySelector('td');
      if (cell) { const r = document.createRange(); r.selectNodeContents(cell); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      click('在下方增行'); ok.addRow = rows() === 3;
      click('删本行'); ok.delRow = rows() === 2;
      click('在右侧增列'); ok.addCol = cols() === 3;
      click('删本列'); ok.delCol = cols() === 2;
      click('合并选中的两个单元格'); ok.merge = !!ed.querySelector('[colspan="2"]');
      click('拆分单元格'); ok.split = !ed.querySelector('[colspan="2"]');
      return {ok: true, ...ok};
    })()`);
    if (table.ok) {
      say('W4-插表', table.insert, `插入2x2=${table.insert}`);
      say('W5-增删行列', table.addRow && table.delRow && table.addCol && table.delCol,
          `+行=${table.addRow} -行=${table.delRow} +列=${table.addCol} -列=${table.delCol}`);
      say('W6-合并拆分', table.merge && table.split, `合并=${table.merge} 拆分=${table.split}`);
    } else {
      say('W4-表格按钮', false, table.why || '失败');
    }
    // —— 6. 未保存修改不被静默丢弃（最低验收第 3 条）——
    const guard = await evalJs(`(async () => {
      const ed = document.querySelector('.mail-body-editor');
      const subject = document.querySelector('#c-subject');
      if (!ed || !subject) return {ok: false, why: '写信窗没起来'};
      subject.value = '未保存的改动';
      subject.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise(r => setTimeout(r, 300));
      const dirtyNote = document.querySelector('#dirty-note');
      const dirty = dirtyNote && !dirtyNote.hidden;
      const cancel = document.querySelector('#c-cancel');
      if (cancel) cancel.click();
      await new Promise(r => setTimeout(r, 300));
      // 点「关闭」后不该直接关掉：要么仍在写信窗且出现二次确认，要么弹确认
      const stillOpen = !!document.querySelector('#c-subject');
      const confirmed = /确认关闭|未保存修改将丢弃/.test(cancel ? cancel.textContent : '');
      return {ok: true, dirty, stillOpen, confirmed, label: cancel ? cancel.textContent : ''};
    })()`);
    say('W7-未保存不被静默丢弃', guard.ok && guard.dirty && guard.stillOpen,
        guard.ok ? `脏标记=${guard.dirty} 仍开着=${guard.stillOpen} 按钮「${guard.label}」` : (guard.why || '失败'));

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
