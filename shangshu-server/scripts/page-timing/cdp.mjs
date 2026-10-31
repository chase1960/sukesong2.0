// 极简 CDP 客户端 —— 只为 S1 页面计时用，不引第三方依赖。
//
// ⚠️ DevTools 绑在哪，**随 Chrome 版本翻**：
//   · Chrome 154 绑 IPv6 `[::1]:9222` —— 当时这里写死 family:6，curl 打 127.0.0.1 会 404
//   · Chrome 155（2026-10-15 实测）绑 IPv4 `127.0.0.1:9222` —— lsof 看到的是 IPv4 LISTEN
// 所以**两头都试**，不写死。这是测具自己的坑，不是产品的。
import http from 'node:http';

const PORT = 9222;
const HOSTS = [{host: '127.0.0.1', family: 4}, {host: '::1', family: 6}];

function get(path) {
  return new Promise((resolve, reject) => {
    let lastErr = null;
    const tryNext = (i) => {
      if (i >= HOSTS.length) return reject(lastErr || new Error('CDP 两头都连不上：' + PORT));
      const {host, family} = HOSTS[i];
      http.get({host, port: PORT, path, family}, res => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => resolve(b));
      }).on('error', (e) => { lastErr = e; tryNext(i + 1); });
    };
    tryNext(0);
  });
}

export async function browserWsUrl() {
  const v = JSON.parse(await get('/json/version'));
  return v.webSocketDebuggerUrl;
}

export async function newPage(url = 'about:blank') {
  const list = JSON.parse(await get('/json/new?' + encodeURIComponent(url), 'PUT'));
  return list;
}

export async function listTargets() {
  return JSON.parse(await get('/json/list'));
}

/** 连上某个 target 的 WS，返回带 id 自增的 send()。 */
export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
    }, 30000);
  });
  const open = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = e => rej(new Error('WS 连不上: ' + (e.message || e)));
  });
  return {ws, send, open, events};
}

/** 开一个新标签页并附着上去，返回该页专用的 sendS（带 sessionId）。 */
export async function openPage(send, ws, url) {
  const t = await send('Target.createTarget', {url});
  const {sessionId} = await send('Target.attachToTarget', {targetId: t.targetId, flatten: true});
  let seq = 1e9;
  const pending = new Map();
  const onMsg = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  ws.addEventListener('message', onMsg);
  const sendS = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params, sessionId}));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
    }, 30000);
  });
  await sendS('Page.enable');
  await sendS('Runtime.enable');
  return {targetId: t.targetId, sessionId, sendS};
}

/** 在页面里跑一段 JS，拿回值。 */
export async function evalIn(sendS, expression) {
  const r = await sendS('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面脚本报错: ' +
      (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

/** 在页面里跑一段 JS，拿回 JSON 可序列化的结果。 */
export async function evaluate(send, expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面脚本报错: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}
