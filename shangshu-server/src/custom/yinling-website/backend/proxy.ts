// 官网后台反代（定制层）：门禁 key 服务端注入、HTML 注入尚书皮肤与路径钩子、剥禁嵌头。
import { Router } from 'express';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../core/config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_FILE = join(__dirname, '..', 'theme', 'website-admin-theme.css');

// 路径钩子：页面里的 /api、/uploads 路径改走尚书反代。
// 官网后台 admin.html 用 `window.location.origin + '/api/...'` 拼同源绝对 URL（嵌入 iframe 里 origin 是尚书），
// 必须先剥 origin 前缀再改写，否则 /^\/api\// 匹配不到带 origin 的绝对 URL，请求直打尚书 → 404。
// 导出以便单测；HOOK_JS 内联同一函数源码（.toString()）保证浏览器端与 Node 端逻辑一致。
export function rewriteUrl(u: unknown, origin: string): unknown {
  if (typeof u !== 'string') return u;
  let s = u;
  if (s.startsWith(origin)) s = s.slice(origin.length);
  return s.replace(/^\/api\//, '/website-api/').replace(/^\/uploads\//, '/website-uploads/');
}

// 注入的路径钩子(改写 /api /uploads 到尚书反代)。带 per-response nonce，配合下面的 CSP：
// 只放行本注入脚本(nonce) + 上游域 script，挡掉上游页面里其他 inline/外域恶意脚本(防被篡改/MITM 后同源窃 token)。
function hookJs(nonce: string): string {
  return `<script nonce="${nonce}">(function(){
  var rw=${rewriteUrl.toString()};
  var of=window.fetch; window.fetch=function(i,n){ i=rw(i,window.location.origin); return of.call(this,i,n); };
  var oo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){ var a=[].slice.call(arguments); a[1]=rw(u,window.location.origin); return oo.apply(this,a); };
})();</script>`;
}

// 不再剥 content-security-policy：rewriteHtml 分支会设我们自己的严格 CSP(用 nonce 放行注入脚本 + 上游域，
// 挡上游 inline/外域恶意脚本)。x-frame-options 仍需剥(iframe 嵌入需要)。
const STRIP_HEADERS = ['x-frame-options', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'];

async function pipe(req: Request, res: Response, url: string, extraHeaders: Record<string, string>, rewriteHtml: boolean): Promise<void> {
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  const hasJson = req.is('application/json') && req.body;
  const up = await fetch(url, {
    method: req.method,
    headers: { ...extraHeaders, ...(hasJson ? { 'Content-Type': 'application/json' } : {}) },
    // 非 JSON 请求(表单/文件上传)暂不转发 body：express.json 只解 JSON，原始 body 已被消费，
    // 直接传 req 对象会被 fetch toString 成 '[object Object]'。需要转发 form/multipart 时，
    // 应给 express 加 urlencoded/multipart 中间件，并在此按 content-type 重组 body。
    body: isGet ? undefined : hasJson ? JSON.stringify(req.body) : undefined,
    // @ts-expect-error node fetch 需要 duplex
    duplex: 'half',
  });
  for (const [k, v] of up.headers.entries()) if (!STRIP_HEADERS.includes(k)) res.setHeader(k, v);
  const buf = Buffer.from(await up.arrayBuffer());
  const ctype = up.headers.get('content-type') || '';
  if (rewriteHtml && ctype.includes('text/html')) {
    let html = buf.toString('utf-8');
    const nonce = randomBytes(16).toString('base64');
    const inject = `<link rel="stylesheet" href="/website-admin/theme.css">${hookJs(nonce)}`;
    html = html.includes('</head>') ? html.replace('</head>', inject + '</head>') : inject + html;
    // 设严格 CSP：script 只允许 nonce(我们的钩子) + 上游域(官网后台自有 bundle) + 'strict-dynamic'；
    // 挡掉上游页面里其他 inline/外域脚本(防被篡改/MITM 后同源窃 token)。上游域取自当前 url。
    let upstreamOrigin = '';
    try { upstreamOrigin = new URL(url).origin; } catch { /* ignore */ }
    res.setHeader('Content-Security-Policy',
      `default-src 'self' ${upstreamOrigin}; ` +
      `script-src 'self' ${upstreamOrigin} 'nonce-${nonce}' 'strict-dynamic'; ` +
      `style-src 'self' 'unsafe-inline' ${upstreamOrigin}; ` +
      `img-src 'self' data: https: http:; ` +
      `font-src 'self' https: data:; ` +
      `connect-src 'self'; ` +
      `frame-ancestors 'self'`);
    // 注入 HTML 含动态钩子（HOOK_JS 随 proxy.ts 演进），必须禁缓存：剥上游 etag/last-modified 并设 no-store，
    // 否则浏览器命中 304 永远用旧页面，钩子更新后不生效（嵌入后台登录 404 即此踩坑）
    res.removeHeader('content-length');
    res.removeHeader('etag');
    res.removeHeader('last-modified');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(up.status).type('html').send(html);
    return;
  }
  res.status(up.status).send(buf);
}

function cfg() { return loadConfig().website; }

export function websiteAdminProxy(): Router {
  const r = Router();
  r.get('/theme.css', (_req, res) => res.type('text/css').send(readFileSync(THEME_FILE, 'utf-8')));
  r.use('/', async (req, res) => {
    try {
      const w = cfg();
      if (!w?.base_url || !w?.panel_key) return res.status(503).send('未配置官网 base_url / panel_key（系统配置页）');
      const q = new URLSearchParams(req.query as Record<string, string>);
      q.set('key', w.panel_key); // 门禁 key 只出现在服务端→上游
      const url = `${w.base_url.replace(/\/+$/, '')}/${w.panel_path}${req.path}?${q}`;
      await pipe(req, res, url, {}, true);
    } catch { res.status(503).send('官网不可达，稍后重试'); }
  });
  return r;
}

export function websiteApiProxy(): Router {
  const r = Router();
  r.use('/', async (req, res) => {
    try {
      const w = cfg();
      if (!w?.base_url || !w?.api_key) return res.status(503).json({ error: '未配置官网 api_key' });
      const url = `${w.base_url.replace(/\/+$/, '')}/api${req.path}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
      await pipe(req, res, url, { 'x-api-key': w.api_key }, false);
    } catch { res.status(503).json({ error: '官网不可达' }); }
  });
  return r;
}

export function websiteUploadsProxy(): Router {
  const r = Router();
  r.get('/*', async (req, res) => {
    try {
      const w = cfg();
      if (!w?.base_url) return res.status(503).end();
      await pipe(req, res, `${w.base_url.replace(/\/+$/, '')}/uploads${req.path}`, {}, false);
    } catch { res.status(503).end(); }
  });
  return r;
}
