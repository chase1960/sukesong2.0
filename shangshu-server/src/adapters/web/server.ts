// web 适配器（spec §9.3）：express + single-admin 登录 + 静态托管 shangshu-web。
// 路由：login/session/config（含连接测试）/invoices/files/triggers/runs。
import express from 'express';
import { projectHistoryCards } from './chat-history-cards.ts';
import httpProxy from 'http-proxy';
import { existsSync, statSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, maskConfig, DEFAULT_CONFIG, DATA_DIR } from '../../core/config.ts';
import { localStore, createBitableStore } from '../../core/store.ts';
import { getLocalToken } from '../../core/attachments.ts';
import { getActionContract, checkAction } from '../../core/action-contracts.ts';
import { requireActor, authorize } from '../../core/actor.ts';
import { getDocType } from '../../core/doctypes.ts';
import {smeRouter} from './sme.ts';
import {cashSummary} from '../../capabilities/finance-domain.ts';
import { resolvePlatformMode } from '../../core/platform-mode.ts';
import { buildFlowGraph, FLOW_DOMAINS } from '../../core/flow-registry.ts';
import { listTriggers, updateTrigger, listCapabilities, listRoutes, listDashboardWidgets, getCapability } from '../../core/registry.ts';
import { listChatTools, runAgentLoop, loadHistory, type ChatAttachment } from '../../core/chat.ts';
import { chatEngine, chatEngines, defaultChatEngine } from '../../core/chat-engines.ts';
import { listMetadataOverview } from '../../core/meta-store.ts';
import { getWorkflowRun, listWorkflowRuns, runWorkflow, resumeWorkflow, listMyApprovals, decideFlowApproval } from '../../core/workflow-engine.ts';
import { runObjectQuery, proposeObjectWrite } from '../../capabilities/object-tools.ts';
import { runTrigger, listJobRuns } from '../../core/runner.ts';
import { applyTriggerPatch } from '../../core/scheduler.ts';
import { createFileStore } from '../../core/files.ts';
// 「当前上下文」是内核能力：白名单化、限长、权威份、内容核对都在内核那一个模块里。
import {
  checkContextContent, getCurrentContext, acceptCurrentContext, normalizeContextContent,
  type ChatUiContext,
} from '../../core/chat-context.ts';
import { createContextRefReader } from './chat-context-read.ts';
import { buildContext } from '../../core/context.ts';
import { createMailSource, agentlyStatus } from '../../core/infra/mail.ts';
import { downloadMedia } from '../../core/feishu.ts';
import { skillSyncRouter, skillKeyRouter } from '../../capabilities/skill-sync/api.ts';
import { findUser, verifyPassword, listUsers, createUser, updatePassword, setUserStatus, setUserGroup, updateRole, deleteUser, assertLastAdmin, ROLES, type Role } from '../../core/auth/users.ts';
import { createSession, destroySession } from '../../core/auth/session.ts';
import { currentUser, requireRole, requireAuth, parseCookies } from '../../core/auth/guard.ts';
import { audit } from '../../core/auth/audit.ts';
import { requestConfirmation, resolveConfirmation, listPendingConfirmations } from '../../core/confirm.ts';
import { enrichConfirmations } from '../../core/confirm-summary.ts';
import { upsertMetaEntry, getMetaRecord, createMetadataDraft, publishMetadataDraft, rollbackMetadata } from '../../core/meta-store.ts';
import { emptyFlowTemplate, proposeMetadataWrite } from '../../core/meta-authoring.ts';
import { getWorkflowTemplate, listWorkflowTemplates, type WorkflowTemplate } from '../../core/workflow-engine.ts';
import { verifyChain, resetChainCache } from '../../core/events.ts';
import { listChats, getOrCreateDm, createGroup, listMessages, markChatRead, renameChat, addMembers, removeMember, leaveChat, disbandChat, deleteDmChat, recallMessage, validateReply, setChatPreferences } from '../../core/im.ts';
import { atomic } from '../../core/storage/transaction.ts';
import { messageFingerprint } from '../../core/im.ts';
import {messagePage,normalizeMessageExtras,validateMessageExtras,memberChat,setFavorite,listFavorites,parseIm} from '../../core/im-workplace.ts';
import { aggregateBusiness } from '../../core/aggregate.ts';
import { generateDailyBrief, listBriefs } from '../../core/brief.ts';
import { scanAlerts } from '../../core/alerts.ts';
import { enabledWorkspaceIds, setEnabledWorkspaces, visibleWorkspaces, customWorkspaces } from '../../core/workspaces.ts';
import { registerAllActionHandlers } from '../../capabilities/actions.ts';
import { assertLlmUrl } from '../../core/infra/llm.ts';
import type { RuntimeConfig, ExternalServices, LlmSource } from '../../core/types.ts';
import { createPlatformChatBridge, platformRouter,readPlatformService,authorizedFileReaders } from './platform.ts';
import { collaborationPeople } from '../../core/auth/people.ts';
import { visibleTasks } from '../../capabilities/task-domain.ts';
import { platformLegacyGuard } from './platform-legacy-policy.ts';
import { resolveChatAttachments } from './chat-attachments.ts';
import { createWorkerProfile, dispatchWorker, handoffWorkerRun, listWorkerProfiles, listWorkerRuns, pauseWorkerRun, resumeWorkerRun } from '../../core/worker-runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// shangshu-web 在项目根的同级目录
const WEB_DIR = join(__dirname, '..', '..', '..', '..', 'shangshu-web');

const FRAPPE_HTTP_PREFIXES = [
  '/app',
  '/login',
  '/logout',
  '/assets',
  '/files',
  '/private/files',
  '/website_script.js',
  '/website_theme.css',
];

// Frappe Desk 只用于内核验证和内部运维，不作为尚书的用户界面。
// 对外始终回到已经定稿的 shangshu-web。Frappe 方法、资源和上传 API 不再公网直通；
// Node BFF 通过 FRAPPE_UPSTREAM 在服务端访问它们，浏览器只能使用尚书业务 API。
const SHANGSHU_UI_REDIRECTS: Record<string, string> = {
  '/app/shangshu-workbench': '/#/dash',
  '/app/shangshu-data-center': '/#/objects',
  '/app/shangshu-process-center': '/#/flowdesign',
  '/app/shangshu-workflow-studio': '/#/flowdesign',
};

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function proxyErrorHandler(label: string) {
  return (error: Error, _req: unknown, response: unknown): void => {
    console.error(`[frappe-proxy] ${label}:`, error.message);
    const res = response as { headersSent?: boolean; writeHead?: (code: number, headers: Record<string, string>) => void; end?: (body?: string) => void };
    if (!res.writeHead || res.headersSent) return;
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end?.(JSON.stringify({ error: '流程服务暂时不可用，请稍后重试' }));
  };
}

function attachFrappeProxy(app: express.Express): void {
  const webTarget = process.env.FRAPPE_UPSTREAM;
  if (!webTarget) return;

  const webProxy = httpProxy.createProxyServer({
    target: webTarget,
    changeOrigin: false,
    xfwd: true,
  });
  webProxy.on('error', proxyErrorHandler('web'));

  const socketTarget = process.env.FRAPPE_SOCKETIO_UPSTREAM;
  const socketProxy = socketTarget
    ? httpProxy.createProxyServer({ target: socketTarget, changeOrigin: false, xfwd: true, ws: true })
    : null;
  socketProxy?.on('error', proxyErrorHandler('socket.io'));

  app.locals.frappeSocketProxy = socketProxy;
  app.use((req, res, next) => {
	if (req.method === 'GET') {
		const productRoute = SHANGSHU_UI_REDIRECTS[req.path];
		if (productRoute) {
			res.redirect(302, productRoute);
			return;
		}
		if (req.path === '/login') {
			res.redirect(302, '/login.html');
			return;
		}
		if (matchesPrefix(req.path, '/app')) {
			res.redirect(302, '/index.html');
			return;
		}
	}
    if (socketProxy && matchesPrefix(req.path, '/socket.io')) {
      socketProxy.web(req, res);
      return;
    }
    if (!FRAPPE_HTTP_PREFIXES.some((prefix) => matchesPrefix(req.path, prefix))) return next();
    webProxy.web(req, res);
  });
}

// —— 静态资源 gzip（R0 2026-08-14）——
const GZIP_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
export function staticCacheControl(pathname: string, fingerprinted: boolean): string {
  // 版本参数语义（R3 2026-09-21）：
  // - ?h= 由服务端按文件内容指纹注入（见 rewriteIndexAssets），内容变 URL 必变 → JS/CSS 可安全 immutable，
  //   公网弱网下不再依赖每次重验证（此前 30+ 资源逐个条件请求，抖动即白页/缺脚本）。
  // - 手工 ?v= 或无版本仍每次重验证：漏 bump 时不能把旧脚本锁住。
  if (['.js', '.mjs', '.css'].includes(extname(pathname).toLowerCase())) {
    return fingerprinted ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';
  }
  return fingerprinted ? 'public, max-age=604800, immutable' : 'public, max-age=0, must-revalidate';
}
// —— index.html 资源指纹重写：吐页时把本地 js/css 引用改写为 ?h=<内容哈希> ——
export function assetFingerprint(content: Buffer | string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 10);
}
export function rewriteIndexAssets(html: string, resolve: (rel: string) => string | null): string {
  // 只改写本仓库内 js/css（含 vendor），已有手工 ?v= 一并归一为指纹；外链与缺失文件保持原样。
  return html.replace(/(\s(?:src|href)=")((?:js|css|vendor)\/[^"?]+?\.(?:js|css))(?:\?[^"]*)?"/g, (m, head: string, rel: string) => {
    const abs = resolve(rel);
    return abs ? `${head}${rel}?h=${assetFingerprint(readFileSync(abs))}"` : m;
  });
}
export function readIndexPage(webDir: string): string {
  // HTML 未改不代表依赖未改；入口重新取当前指纹，资源本身继续 immutable 缓存。
  return rewriteIndexAssets(injectDomainAssets(readFileSync(join(webDir, 'index.html'), 'utf8'), webDir), rel => {
    const path = join(webDir, rel);
    try { return statSync(path).isFile() ? path : null; } catch { return null; }
  });
}
// —— 前端领域注册点（2026-09-24）：各域自描述入口，业务域合并零共享文件冲突 ——
// 域前端放在 js/domains/<域>/，目录下 domain-entry.json 声明
// {"entry":["a.js"],"styles":["x.css"],"common":["chip-input.js"],"order":50}。吐入口页时按 order 注入
// <!-- domain-assets --> 占位。新域只新增自己的目录，不再改 index.html / page-registry / app.js。
// common 解析到 js/ 根，供「谁都能用」的公共组件（如胶囊输入）被需要它的域带进来，
// 而不是把公共实现复制进各域目录绕过边界；注入顺序排在本域 entry 之前，本域代码要用它。
export interface DomainEntryFile { entry?: string[]; styles?: string[]; common?: string[]; order?: number }
export function collectDomainEntries(webDir: string): { js: string[]; css: string[] } {
  const domainsDir = join(webDir, 'js', 'domains');
  const discovered: Array<{ order: number; js: string[]; css: string[] }> = [];
  let domainNames: string[] = [];
  try {
    domainNames = readdirSync(domainsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return { js: [], css: [] }; }
  for (const name of domainNames.sort()) {
    const entryPath = join(domainsDir, name, 'domain-entry.json');
    let parsed: DomainEntryFile;
    try { parsed = JSON.parse(readFileSync(entryPath, 'utf8')); } catch { continue; }
    // 入口名只允许普通文件名（禁 ../ 等越界）；声明的文件必须真实存在，缺一个整域跳过。
    const list = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((x): x is string => typeof x === 'string' && /^[a-z0-9][\w.-]*$/i.test(x))
      : [];
    const common = list(parsed.common).map(f => `js/${f}`);
    const js = list(parsed.entry).map(f => `js/domains/${name}/${f}`);
    const css = list(parsed.styles).map(f => `css/domains/${name}/${f}`);
    const all = [...common, ...js, ...css];
    if (!all.length || !all.every(rel => { try { return statSync(join(webDir, rel)).isFile(); } catch { return false; } })) continue;
    discovered.push({ order: Number.isFinite(parsed.order) ? Number(parsed.order) : 50, js: [...common, ...js], css });
  }
  discovered.sort((a, b) => a.order - b.order);
  return { js: discovered.flatMap(d => d.js), css: discovered.flatMap(d => d.css) };
}
function injectDomainAssets(html: string, webDir: string): string {
  const marker = '<!-- domain-assets -->';
  if (!html.includes(marker)) return html;
  const { js, css } = collectDomainEntries(webDir);
  const tags = [
    ...css.map(rel => `<link rel="stylesheet" href="${rel}">`),
    ...js.map(rel => `<script src="${rel}"></script>`),
  ].join('\n');
  return html.replace(marker, tags || '<!-- domain-assets:none -->');
}
function serveIndexPage(_req: express.Request, res: express.Response): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(readIndexPage(WEB_DIR));
}
const gzipCache = new Map<string, { mtimeMs: number; buf: Buffer }>();
const brotliCache = new Map<string, { mtimeMs: number; buf: Buffer }>();
/**
 * **按浏览器要的，挑最好的那档压缩**（2026-10-30 用户给的信息：
 * 「rotli 未配 —— 7.39MB 产物现在 gzip 1.97MB，上 brotli 大概能到 1.6MB 左右，
 * 　首开最重的那一刀」）。
 *
 * ⚠️ **顺序要紧**：浏览器**都**发 `accept-encoding: gzip, deflate, br`
 *   ⇒ **先判 br、再判 gzip** ⇒ 拿到最好的那档。
 * ⚠️ **判不出要哪档 ⇒ 原样发**（不压）——宁可大一点，也不能给一个解不开的包。
 * ⚠️ **ETag 要带上档位**：同一个 URL 可能给 br、也可能给 gzip
 *   ⇒ ETag 不同才不会被浏览器缓存搞错（配合 `Vary: Accept-Encoding`）。
 */
function staticGzip() {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (req.method !== 'GET') return next();
    const accepted = String(req.headers['accept-encoding'] || '');
    const wantsBrotli = accepted.includes('br');
    const wantsGzip = accepted.includes('gzip');
    if (!wantsBrotli && !wantsGzip) return next();
    const rel = decodeURIComponent((req.path || '').replace(/^\/+/, ''));
    if (!rel || rel.includes('..')) return next();
    const abs = join(WEB_DIR, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return next();
    const type = GZIP_TYPES[extname(abs).toLowerCase()];
    if (!type) return next();
    const st = statSync(abs);
    if (st.size < 1024) return next();   // 小文件不值得压缩
    const encoding = wantsBrotli ? 'br' : 'gzip';
    let entry: { mtimeMs: number; buf: Buffer } | undefined;
    if (encoding === 'br') {
      entry = brotliCache.get(abs);
      if (!entry || entry.mtimeMs !== st.mtimeMs) {
        entry = { mtimeMs: st.mtimeMs, buf: brotliCompressSync(readFileSync(abs)) };
        brotliCache.set(abs, entry);
      }
    } else {
      entry = gzipCache.get(abs);
      if (!entry || entry.mtimeMs !== st.mtimeMs) {
        entry = { mtimeMs: st.mtimeMs, buf: gzipSync(readFileSync(abs)) };
        gzipCache.set(abs, entry);
      }
    }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs / 1000).toString(16)}-${encoding}"`;
    res.setHeader('Cache-Control', staticCacheControl(req.path, req.query?.h !== undefined));
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Type', type);
    res.end(entry.buf);
  };
}

function authed(req: express.Request): boolean {
  return !!currentUser(req);
}

// 发票路由按当前配置选 store：bitable 模式直读写飞书多维表格，local 模式读写 store.json。
// 与 buildContext 同源逻辑，保证「改 provider 后审核页与触发器看到同一份数据」。
function getStore() {
  const cfg = loadConfig();
  return cfg.store.provider === 'bitable' ? createBitableStore(cfg.feishu) : localStore;
}

// 入账幂等锁：同一发票的入账请求串行化。双击/网络重试下，两个并发请求可能都读到「已入库」、都过校验、
// 都往飞书记账表 append（append-only 无法去重）→ 一张发票两条记账记录。进程内 per-invoice Mutex + 锁内重读二次确认。
// （多进程部署还需 ledger 侧带 invoice_id 幂等键，此处覆盖最常见的单进程双击/重试场景。）
const ledgerLocks = new Map<string, Promise<void>>();
async function withLedgerLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = ledgerLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const chained = prev.then(() => next, () => next);
  ledgerLocks.set(id, chained);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // 无人排队时清掉条目（此前 Map 永不清理，长期运行按发票 id 无界增长）
    queueMicrotask(() => { if (ledgerLocks.get(id) === chained) ledgerLocks.delete(id); });
  }
}

// SSRF 防护：校验 admin 可设、且会被服务端 fetch 的 URL（ocr.endpoint_url / website.base_url / llm.base_url）。
// 2026-08-28 收紧：纯字符串前缀匹配可被 [::ffff:169.254.x]/十进制IP/尾点主机名/DNS rebinding 绕过，
// 这里先做 hostname 规范化（IPv6 括号、::ffff: 映射、非十进制编码、尾点），再按 IP 段判断；fetch 一律 redirect:'error'。
const PRIVATE_V4 = [
  { name: '本机环回', test: (b: number[]) => b[0] === 127 || (b[0] === 0 && b[1] === 0) },
  { name: '云元数据/链路本地', test: (b: number[]) => b[0] === 169 && b[1] === 254 },
  { name: '内网A段', test: (b: number[]) => b[0] === 10 },
  { name: '内网B段', test: (b: number[]) => b[0] === 172 && b[1] >= 16 && b[1] <= 31 },
  { name: '内网C段', test: (b: number[]) => b[0] === 192 && b[1] === 168 },
  { name: '保留段', test: (b: number[]) => b[0] === 100 && b[1] >= 64 && b[1] <= 127 },
];
function v4FromHost(h: string): number[] | null {
  // 十进制整数（2852039166）、0x/八进制点分等统一折叠为点分四段
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    let v: number;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p, 8);
    else if (/^\d{1,3}$/.test(p)) v = Number(p);
    else return null;
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    bytes.push(v);
  }
  return bytes;
}
function isPrivateHostname(rawHost: string): { bad: boolean; why?: string } {
  let h = rawHost.trim().toLowerCase().replace(/\.$/, '');          // 尾点（localhost.）
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);      // IPv6 括号
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return { bad: true, why: '本地主机名' };
  if (h === 'metadata.google.internal') return { bad: true, why: '云元数据' };
  // IPv4 / IPv4-mapped IPv6 / 非十进制编码
  let mapped = h;
  if (mapped.startsWith('::ffff:')) mapped = mapped.slice(7);
  const v4 = v4FromHost(mapped);
  if (v4) {
    for (const r of PRIVATE_V4) if (r.test(v4)) return { bad: true, why: r.name };
    return { bad: false };
  }
  // IPv6：环回/链路本地/唯一本地/未指定
  if (h.includes(':')) {
    if (h === '::' || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return { bad: true, why: 'IPv6 内网/环回' };
  }
  return { bad: false };   // 域名：此处不做 DNS 解析判定（部署在内网时由网络层隔离兜底）
}
function assertFetchUrl(raw: string, opts: { localOk?: boolean; httpsOnly?: boolean } = {}): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('URL 格式非法'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`协议非法：${u.protocol}`);
  if (opts.httpsOnly && u.protocol !== 'https:') throw new Error('官网 base_url 必须为 https');
  const hit = isPrivateHostname(u.hostname);
  if (!hit.bad && !opts.localOk) {
    // non-local 场景（website）：域名字符串判不了内网解析，靠 fetch redirect:'error' + 部署网络隔离兜底
  }
  if (hit.bad && !opts.localOk) throw new Error(`禁止访问内网/保留地址（${hit.why}）`);
  if (hit.bad && opts.localOk && hit.why === '云元数据/链路本地') throw new Error('禁止访问云元数据地址（169.254.*）');
  if (hit.bad && opts.localOk && (hit.why === '保留段')) throw new Error('禁止访问保留地址段');
}

export function buildApp(external?: ExternalServices) {
  const app = express();
  const platformMode = resolvePlatformMode();
  // DevHost 共用域名时，Node 保持公网入口；Frappe 路由在任何 body parser 和 Node /api 守卫前转发。
  attachFrappeProxy(app);
  // R4：业务写操作 handler 注册（从本文件拆出到 capabilities/actions.ts）
  registerAllActionHandlers();

  // 20MiB原件编码后约26.7MiB；只为平台动作封包留余量，原件限额仍由各域校验。
  if (platformMode === 'frappe') app.use('/api/platform/actions/:id/execute', express.json({ limit: '32mb' }));
  app.use(express.json({ limit: '20mb' }));
  app.use(((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ok:false,code:'REQUEST_TOO_LARGE',error:'请求内容过大，未提交；请减少附件或导入文件大小。'});
      return;
    }
    next(error);
  }) as express.ErrorRequestHandler);
  // 手动上传发票：前端以 application/octet-stream 逐文件 POST 字节流（只解析该类型，不影响 json）
  app.use(express.raw({ type: 'application/octet-stream', limit: '300mb' }));

  // fast 平台线：Frappe 是身份与业务事实权威；原登录页和新增流程/财务页面统一走同源 BFF。
  // 放在旧 Node 登录与 /api 守卫之前，命中后不会再验证 cognition.users 的第二套密码。
  // 平台模式必须显式声明；frappe 模式缺少 upstream 会在启动时 fail closed，绝不回退 Node 身份。
  // legacy 仅服务独立 node 分支与尚未迁移的兼容环境。
  if (platformMode === 'frappe') app.use(platformRouter(external));

  // RC3：平台模式只保留明确批准的 Node 兼容面。任何未由 platformRouter 命中的
  // /api 请求必须经过 allowlist，防止旧用户、ERP、流程、调度和工具目录绕过
  // Frappe 领域启停与 public_api 再次成为第二套业务内核。
  if (platformMode === 'frappe') app.use('/api', (req, res, next) => {
    const policy = platformLegacyGuard(req.path);
    if (policy.allowed) return next();
    res.status(410).json({ ok: false, code: policy.code, error: policy.message });
  });

  // —— 登录（账号 + 密码，用户存 cognition.users）——
  app.post('/api/login', async (req, res) => {
    // 兼容旧前端：只传 password 视为 admin 账号
    const username = String(req.body?.username || 'admin').trim();
    const password = String(req.body?.password || '');
    const store = getStore();
    let u = await findUser(store, username).catch(() => null);
    if (!u) {
      // 迁移兼容：用户表为空 + admin + 旧管理密码 → 自动落第一个 admin 用户（之后走用户体系）
      const anyUser = await store.query('cognition', 'users').catch(() => []);
      if (username === 'admin' && anyUser.length === 0 && password === loadConfig().server.admin_password) {
        const { createUser } = await import('../../core/auth/users.ts');
        await createUser(store, { username: 'admin', password, role: 'admin', display_name: '管理员' }).catch(() => {});
        u = await findUser(store, username).catch(() => null);
      }
    }
    if (!u || u.status === '停用' || !verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ ok: false, error: '用户名或密码错误' });
    }
    const s = createSession({ username: u.username, role: u.role, display_name: u.display_name || u.username });
    // Secure 仅在 SS_COOKIE_SECURE=1 时附加：生产 https 部署应开启（防 cookie 在明文链路被嗅探）；
    // 开发 http 下加 Secure 会导致浏览器拒绝存储 cookie、登录失效，故默认不开。
    const cookieSecure = process.env.SS_COOKIE_SECURE === '1' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `shangshu_token=${s.token}; HttpOnly; Path=/; SameSite=Lax${cookieSecure}`);
    // R0：审计不挡登录响应——appendEvent 在 bitable 上是一次全表拉取+写入（秒级）。
    // audit 内部已有 try/catch（audit.ts），失败只告警不阻断主流程。
    audit(getStore(), s, 'login', username);
    res.json({ ok: true, user: { username: s.username, role: s.role, display_name: s.display_name } });
  });
  app.post('/api/logout', (req, res) => {
    destroySession(parseCookies(req.headers.cookie).shangshu_token);
    res.setHeader('Set-Cookie', 'shangshu_token=; Max-Age=0; Path=/');
    res.json({ ok: true });
  });
  app.get('/api/session', (req, res) => {
    const u = currentUser(req);
    res.json(u ? { authed: true, user: { username: u.username, role: u.role, display_name: u.display_name } } : { authed: false });
  });

  // —— 用户管理（admin）——
  app.get('/api/users', requireRole('admin'), async (_req, res) => {
    res.json(await listUsers(getStore()));
  });
  app.post('/api/users', requireRole('admin'), async (req, res) => {
    try {
      const id = await createUser(getStore(), {
        username: String(req.body?.username || '').trim(),
        password: String(req.body?.password || ''),
        role: req.body?.role as Role,
        display_name: req.body?.display_name,
        collaboration_group: req.body?.collaboration_group,
      });
      await audit(getStore(), currentUser(req), 'user.create', String(req.body?.username));
      res.json({ ok: true, id });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
  // 协作分组（2026-09-16）：管理员配置每人的分组（留空=不收窄）；只影响任务选人与可见性
  app.patch('/api/users/:id/group', requireRole('admin'), async (req, res) => {
    try {
      await setUserGroup(getStore(), String(req.params.id), req.body?.group);
      await audit(getStore(), currentUser(req), 'user.group', `${req.params.id}→${String(req.body?.group || '') || '未分组'}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
  app.get('/api/roles', (_req, res) => res.json(ROLES));

  // —— 改密（R0）：admin 代改任意用户（含自己）。之前没有任何改密接口，公网 admin/admin 无法远程修复。——
  app.patch('/api/users/:id/password', requireRole('admin'), async (req, res) => {
    const pwd = String(req.body?.password || '');
    if (pwd.length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' });
    try {
      await updatePassword(getStore(), String(req.params.id), pwd);
      await audit(getStore(), currentUser(req), 'user.password', String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // —— 账号管理（2026-08-27）：停用/启用、改角色、删除。护栏：不能对自己停用/删除；保底一个启用 admin ——
  app.patch('/api/users/:id/status', requireRole('admin'), async (req, res) => {
    const id = String(req.params.id);
    const status = String(req.body?.status || '');
    try {
      const me = currentUser(req);
      const rows = await getStore().query('cognition', 'users', { id });
      if (!rows.length) throw new Error('用户不存在');
      if (rows[0].username === me?.username && status === '停用') throw new Error('不能停用自己的账号');
      if (status === '停用' && rows[0].role === 'admin') await assertLastAdmin(getStore(), id);
      await setUserStatus(getStore(), id, status as '启用' | '停用');
      await audit(getStore(), me, 'user.status', `${rows[0].username}→${status}`);
      // 停用契约（2026-09-16）：不自动改派/退回；返回其在途任务清单，由管理员手动改派（任务记录保留）
      if (status === '停用') {
        const tasks = await getStore().query('process', 'tasks', { assignee_id: String(rows[0].username || '') });
        const open = tasks.filter((t: any) => ['待办', '进行中', '待验收'].includes(String(t.status)))
          .map((t: any) => ({ id: t.id, title: t.title, status: t.status }));
        return res.json({ ok: true, open_tasks: open });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
  app.patch('/api/users/:id/role', requireRole('admin'), async (req, res) => {
    const id = String(req.params.id);
    try {
      const rows = await getStore().query('cognition', 'users', { id });
      if (!rows.length) throw new Error('用户不存在');
      const role = String(req.body?.role || '') as Role;
      if (rows[0].role === 'admin' && role !== 'admin') await assertLastAdmin(getStore(), id);
      await updateRole(getStore(), id, role);
      await audit(getStore(), currentUser(req), 'user.role', `${rows[0].username}→${role}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
  app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
    const id = String(req.params.id);
    try {
      const me = currentUser(req);
      const rows = await getStore().query('cognition', 'users', { id });
      if (!rows.length) throw new Error('用户不存在');
      if (rows[0].username === me?.username) throw new Error('不能删除自己的账号');
      if (rows[0].role === 'admin') await assertLastAdmin(getStore(), id);
      await deleteUser(getStore(), id);
      await audit(getStore(), me, 'user.delete', rows[0].username);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // —— skill 同步 ——
  app.use('/api', skillSyncRouter());

  // 其余 /api/* 需登录
  app.use('/api', (req, res, next) => {
    if (req.path === '/login' || req.path === '/logout' || req.path === '/session') return next();
    if (!authed(req)) return res.status(401).json({ error: '未登录' });
    next();
  });

  // skill 密钥管理需要管理员登录（2026-08-28 修复：此前挂在 requireRole 之前且路由内无角色校验，staff 可铸/吊销密钥）。
  // 只对 /api/skill-keys 前缀生效——直接 app.use('/api', requireRole('admin')) 会把整条 /api 都拦成 admin-only。
  app.use('/api/skill-keys', (req, res, next) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    next();
  }, skillKeyRouter());

  // —— 角色守卫（admin 在 requireRole 里默认放行一切）——
  app.use('/api/config', requireRole('admin'));
  app.use('/api/users', requireRole('admin'));
  app.use('/api', requireAuth);
  app.use('/api',smeRouter());
  app.use('/api/invoices/upload', requireAuth);   // 上传=文件进来待审：登录即可（员工拍照传票）；入库/入账的 finance 门槛在下方 /api/invoices 守卫
  app.use('/api/triggers', (req, res, next) => {
    if (req.method === 'GET') return next();   // 查看触发器全员可读
    return requireRole('manager')(req, res, next);  // 改计划/手动运行要 manager+
  });
  app.use('/api/invoices', (req, res, next) => {
    if (req.method === 'GET' || req.path === '/upload') return next();   // 查看全员可读；上传在前置守卫已放行（登录即可）
    return requireRole('finance')(req, res, next);  // 审核/入账要 finance+
  });

  // —— 通用层：定制模块注册的路由（/api 前缀走上面的登录鉴权；其余自带登录检查）——
  for (const { path, router } of listRoutes()) {
    if (path.startsWith('/api')) app.use(path, router);
    else app.use(path, (req, res, next) => authed(req) ? next() : res.status(401).json({ error: '未登录' }), router);
  }

  // —— 可插入 Dashboard ——
  app.get('/api/dashboard/widgets', (_req, res) => res.json(listDashboardWidgets()));

  // —— 系统配置 ——
  app.get('/api/config', (_req, res) => res.json(maskConfig(loadConfig())));
  app.put('/api/config', async (req, res) => {
    const cfg = loadConfig();
    const body = req.body as Partial<RuntimeConfig>;
    if(body.enterprise) {
      if(typeof body.enterprise.name!=='string' || body.enterprise.name.length>200) return res.status(400).json({ok:false,error:'企业名称必须是 200 字以内文本'});
      cfg.enterprise={name:body.enterprise.name.trim()};
    }
    // 合并（密钥若为脱敏占位则保留原值）
    const keepOrSet = (oldV: string, newV: any) =>
      (newV == null || newV === '' || (typeof newV === 'string' && newV.includes('••••'))) ? oldV : newV;
    cfg.server = { ...cfg.server, port: body.server?.port ?? cfg.server.port, admin_password: keepOrSet(cfg.server.admin_password, body.server?.admin_password) };
    cfg.poll = { ...cfg.poll, ...body.poll };
    if (body.store?.provider && body.store.provider !== cfg.store.provider && !(cfg.store.provider==='local' && body.store.provider==='sqlite')) return res.status(409).json({ok:false,error:'数据源不能在线切换；请使用离线迁移和维护窗口'});
    cfg.store = { ...cfg.store, ...body.store };
    cfg.mail = { ...cfg.mail, ...body.mail };
    if (body.file?.provider && body.file.provider !== 'local') return res.status(400).json({ok:false,error:'当前仅支持本地文件存储；云盘尚未实现'});
    if (body.file?.local_dir && body.file.local_dir !== cfg.file.local_dir) return res.status(409).json({ok:false,error:'附件目录不能在线切换；请在维护窗口迁移'});
    cfg.file = { ...cfg.file, ...body.file };
    cfg.feishu = {
      ...cfg.feishu,
      app_id: body.feishu?.app_id ?? cfg.feishu.app_id,
      app_secret: keepOrSet(cfg.feishu.app_secret, body.feishu?.app_secret),
      bitable_app_token: body.feishu?.bitable_app_token ?? cfg.feishu.bitable_app_token,
      invoices_table_id: body.feishu?.invoices_table_id ?? cfg.feishu.invoices_table_id,
      ledger_table_id: body.feishu?.ledger_table_id ?? cfg.feishu.ledger_table_id,
    };
    // SSRF 防护：服务端会 fetch 的 URL 写入前校验（website 强制 https+禁内网；ocr 允许本地但禁云元数据；llm 允许本地/内网但禁云元数据）
    const newEndpoint = body.ocr?.endpoint_url ?? cfg.ocr.endpoint_url;
    const newWebBase = body.website?.base_url ?? cfg.website.base_url;
    const newLlmBase = body.llm?.base_url ?? cfg.llm.base_url;
    try {
      if (newEndpoint) assertFetchUrl(newEndpoint, { localOk: true });
      if (newWebBase) assertFetchUrl(newWebBase, { httpsOnly: true });
      if (newLlmBase) assertLlmUrl(newLlmBase);
    } catch (e) {
      return res.status(400).json({ ok: false, error: `配置校验失败：${(e as Error).message}` });
    }
    cfg.ocr = {
      ...cfg.ocr,
      endpoint_url: body.ocr?.endpoint_url ?? cfg.ocr.endpoint_url,
      provider: body.ocr?.provider ?? cfg.ocr.provider,
      base_url: body.ocr?.base_url ?? cfg.ocr.base_url,
      model: body.ocr?.model ?? cfg.ocr.model,
      api_key: keepOrSet(cfg.ocr.api_key, body.ocr?.api_key),
    };
    cfg.llm = {
      ...cfg.llm,
      provider: body.llm?.provider ?? cfg.llm.provider,
      base_url: body.llm?.base_url ?? cfg.llm.base_url,
      model: body.llm?.model ?? cfg.llm.model,
      api_key: keepOrSet(cfg.llm.api_key, body.llm?.api_key),
    };
    cfg.website = {
      ...cfg.website,
      base_url: body.website?.base_url ?? cfg.website.base_url,
      api_key: keepOrSet(cfg.website.api_key, body.website?.api_key),
      panel_path: body.website?.panel_path ?? cfg.website.panel_path,
      panel_key: keepOrSet(cfg.website.panel_key, body.website?.panel_key),
    };
    cfg.alerts = { ...cfg.alerts, ...body.alerts };
    if (Array.isArray(body.workspaces)) cfg.workspaces = body.workspaces;
    saveConfig(cfg);
    await audit(getStore(), currentUser(req), 'config.update', 'runtime_config');
    res.json({ ok: true, config: maskConfig(cfg) });
  });

  // —— 模型来源：多条可保存的通道，各自带密钥；切换时整条套用，避免只换地址不换密钥 ——
  const keepSecret = (oldV: string, newV: any) =>
    (newV == null || newV === '' || (typeof newV === 'string' && newV.includes('••••'))) ? oldV : newV;
  app.put('/api/config/llm/sources', async (req, res) => {
    const cfg = loadConfig();
    const body = req.body as { sources?: unknown };
    if (!Array.isArray(body.sources)) return res.status(400).json({ ok: false, error: 'sources 必须是数组' });
    const oldKeys = new Map((cfg.llm_sources || []).map(s => [s.id, s.api_key]));
    const sources: LlmSource[] = [];
    for (const raw of body.sources as Record<string, unknown>[]) {
      const id = String(raw?.id ?? '').trim();
      const name = String(raw?.name ?? '').trim();
      const provider = String(raw?.provider ?? '');
      const base_url = String(raw?.base_url ?? '').trim();
      const model = String(raw?.model ?? '').trim();
      if (!id || !name || !base_url || !model) return res.status(400).json({ ok: false, error: '来源需要 id、名称、地址和模型' });
      if (!['ollama', 'dashscope', 'deepseek'].includes(provider)) return res.status(400).json({ ok: false, error: `来源 ${name} 的 provider 未知` });
      try { assertLlmUrl(base_url); } catch (e) { return res.status(400).json({ ok: false, error: `来源 ${name} 地址非法：${(e as Error).message}` }); }
      sources.push({
        id, name,
        desc: String(raw?.desc ?? ''),
        provider: provider as LlmSource['provider'],
        base_url, model,
        api_key: keepSecret(oldKeys.get(id) ?? '', raw?.api_key),
      });
    }
    cfg.llm_sources = sources;
    saveConfig(cfg);
    await audit(getStore(), currentUser(req), 'config.update', 'llm_sources');
    res.json({ ok: true, config: maskConfig(cfg) });
  });
  app.post('/api/config/llm/apply', async (req, res) => {
    const cfg = loadConfig();
    const id = String((req.body as { id?: unknown })?.id ?? '');
    const src = (cfg.llm_sources || []).find(s => s.id === id);
    if (!src) return res.status(404).json({ ok: false, error: '未找到该模型来源' });
    cfg.llm = { provider: src.provider, base_url: src.base_url, model: src.model, api_key: src.api_key };
    saveConfig(cfg);
    await audit(getStore(), currentUser(req), 'config.update', `llm.apply:${src.id}`);
    res.json({ ok: true, config: maskConfig(cfg) });
  });

  // —— 连接测试 ——
  app.post('/api/config/test/:service', async (req, res) => {
    const cfg = loadConfig();
    try {
      if (req.params.service === 'ocr') {
        const r = await fetch(cfg.ocr.endpoint_url.replace(/\/$/, '') + '/health', { redirect: 'error', signal: AbortSignal.timeout(4000) });
        return res.json({ ok: r.ok, detail: `ocr-service /health → ${r.status}` });
      }
      if (req.params.service === 'mail') {
        if (cfg.mail.provider === 'folder') {
          const ok = existsSync(cfg.mail.folder);
          return res.json({ ok, detail: ok ? `文件夹就绪：${cfg.mail.folder}` : `文件夹不存在：${cfg.mail.folder}` });
        }
        // agently：查 agently-cli 本地授权态（+me 会碰邮箱 API，用 auth status 更轻）
        const s = await agentlyStatus();
        return res.json(s);
      }
      if (req.params.service === 'llm') {
        // 真实推理测试：/models 只证明端点可达（Ollama 无鉴权坏 key 也 200）。
        // 发一条 1-token 最小对话，key/模型名/推理任何一环坏了都红。
        // 可带 {id} 测指定来源；不带则测当前生效配置。
        const probeBody = (req.body ?? {}) as { id?: unknown };
        const source = probeBody.id ? (cfg.llm_sources || []).find(s => s.id === String(probeBody.id)) : undefined;
        const target = source ?? cfg.llm;
        assertLlmUrl(target.base_url);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (target.api_key) headers.Authorization = `Bearer ${target.api_key}`;
        const r = await fetch(target.base_url.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', redirect: 'error', headers,
          body: JSON.stringify({ model: target.model, messages: [{ role: 'user', content: '回复：好' }], max_tokens: 8, stream: false, temperature: 0 }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          return res.json({ ok: false, detail: `LLM ${r.status}：${detail.slice(0, 180) || '请求失败'}` });
        }
        const j: any = await r.json().catch(() => null);
        const replied = !!j?.choices?.length || (j?.usage?.total_tokens ?? 0) > 0;
        return res.json(replied
          ? { ok: true, detail: `推理正常（${target.model}）` }
          : { ok: false, detail: '端点可达但未返回推理结果，请检查模型名' });
      }
      if (req.params.service === 'feishu') {
        const filled = !!(cfg.feishu.app_id && cfg.feishu.app_secret);
        if (!filled) return res.json({ ok: false, detail: 'app_id/app_secret 未填' });
        // 真实凭证校验：向飞书换 tenant_access_token（只读鉴权，不碰业务数据）
        const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: cfg.feishu.app_id, app_secret: cfg.feishu.app_secret }),
          signal: AbortSignal.timeout(8000),
        });
        const j: any = await r.json().catch(() => null);
        return res.json(j?.code === 0
          ? { ok: true, detail: '飞书凭证有效' }
          : { ok: false, detail: `飞书返回 code=${j?.code ?? r.status}：${j?.msg || '无法获取 tenant_access_token'}` });
      }
      res.json({ ok: false, detail: '未知测试项' });
    } catch (e) {
      res.json({ ok: false, detail: (e as Error).message });
    }
  });

  // —— 发票 ——
  app.get('/api/invoices', async (req, res) => {
    const filter = req.query.status ? { status: req.query.status as string } : undefined;
    const rows = (await getStore().query('business', 'invoices', filter as any)).filter(row=>currentUser(req)!.role!=='staff' || row.submitted_by===currentUser(req)!.username);
    // 注入本地附件 token 供审核页本地预览（bitable 记录本身不带 file_token）
    res.json(await Promise.all(rows.map(async (r: any) => ({ ...r, file_token: await getLocalToken(r.id) || r.file_token || '' }))));
  });
  app.get('/api/invoices/:id', async (req, res) => {
    const rows = await getStore().query('business', 'invoices');
    const inv = rows.find((r) => r.id === req.params.id);
    if (!inv) return res.status(404).json({ error: '未找到' });
    if(currentUser(req)!.role==='staff' && inv.submitted_by!==currentUser(req)!.username) return res.status(403).json({error:'仅可查看本人提交的发票'});
    res.json({ ...inv, file_token: await getLocalToken(inv.id) || inv.file_token || '' });
  });
  app.patch('/api/invoices/:id', async (req, res) => {
    const store = getStore();
    const rows = await store.query('business', 'invoices');
    const inv = rows.find((r) => r.id === req.params.id);
    if (!inv) return res.status(404).json({ error: '未找到' });

    // —— 入账：先 append-only 写飞书【记账表】，成功才翻状态。加 per-invoice 锁 + 锁内重读二次确认，
    //    防双击/重试导致同一发票 append 两条记账记录（append-only 无法去重）。
    if (req.body?.status === '已入账') {
      return await withLedgerLock(req.params.id, async () => {
        // 锁内重读最新状态（另一并发请求可能已把它翻成「已入账」）
        const rows2 = await store.query('business', 'invoices');
        const cur = rows2.find((r) => r.id === req.params.id);
        if (!cur) return res.status(404).json({ error: '未找到' });
        if (cur.status === '已入账') return res.status(409).json({ ok: false, error: '该发票已入账，不可重复入账' });
        if (cur.status !== '已入库') return res.status(400).json({ ok: false, error: `仅「已入库」发票可入账，当前为「${cur.status}」` });
        // 事件写总线（P1）：入账 = 提案（proposed）→ 本次点击即人确认（confirmed）→ handler 更新投影。
        // 确认/拒绝永不改写原事件；错误时 handler 抛错 → 500，发票状态不变。
        try {
          const reviewer = currentUser(req)?.display_name || currentUser(req)?.username || 'unknown';
          const eid = await requestConfirmation(store, {
            capability: 'invoice.book', entity_type: 'invoice', entity_id: req.params.id,
            // R1：透传审核页选定的客户/项目/供应商 → handler 按方向联动应收/应付
            payload: {
              invoice_id: req.params.id, amount: cur.total_amount, invoice_no: cur.invoice_no, seller_name: cur.seller_name,
              customer_id: req.body?.customer_id || '', project_id: req.body?.project_id || '', supplier: req.body?.supplier || '',
            },
            initiator: 'user',
          });
          await resolveConfirmation(store, eid, 'confirmed', reviewer);
          const inv2 = (await store.query('business', 'invoices', { id: req.params.id }))[0];
          return res.json({ ok: true, posted: true, ledger_record_id: inv2?.ledger_record_id || '', note: '已入账（事件写总线）' });
        } catch (e) {
          return res.status(500).json({ ok: false, error: `入账失败：${(e as Error).message}` });
        }
      });
    }

    const patch: any = { ...req.body };
    if (patch.status === '已入库') {
      if ((inv as any).status !== '待审') {
        return res.status(400).json({ ok: false, error: `仅「待审」发票可入库，当前为「${(inv as any).status}」` });
      }
      // 字段修正先写入（不含 status），再走确认卡入库
      const fieldPatch = { ...patch };
      delete fieldPatch.status;
      try {
        const reviewer = currentUser(req)?.display_name || currentUser(req)?.username || 'unknown';
        const cur = { ...inv, ...fieldPatch };
        const eid = await requestConfirmation(store, {
          capability: 'invoice.approve', entity_type: 'invoice', entity_id: req.params.id,
          payload: {
            invoice_id: req.params.id, fields: fieldPatch,
            invoice_no: cur.invoice_no,
            seller_name: cur.seller_name,
            amount: cur.total_amount,
          },
          initiator: 'user',
        });
        await resolveConfirmation(store, eid, 'confirmed', reviewer);
        const attachment = { storage: 'local', available: !!await getLocalToken(req.params.id,store) };
        await audit(getStore(), currentUser(req), 'invoice.review', req.params.id, JSON.stringify({ status: '已入库' }));
        return res.json({ ok: true, attachment });
      } catch (e) {
        return res.status(500).json({ ok: false, error: `入库失败：${(e as Error).message}` });
      }
    }
    if (patch.status === '已拒绝') {
      if (!['待审', '已入库'].includes(String((inv as any).status))) {
        return res.status(400).json({ ok: false, error: `当前状态不可拒票：${(inv as any).status}` });
      }
      try {
        const reviewer = currentUser(req)?.display_name || currentUser(req)?.username || 'unknown';
        const eid = await requestConfirmation(store, {
          capability: 'invoice.reject', entity_type: 'invoice', entity_id: req.params.id,
          payload: { invoice_id: req.params.id, invoice_no: (inv as any).invoice_no, reason: patch.review_note || '' },
          initiator: 'user',
        });
        await resolveConfirmation(store, eid, 'confirmed', reviewer);
        await audit(getStore(), currentUser(req), 'invoice.review', req.params.id, JSON.stringify({ status: '已拒绝' }));
        return res.json({ ok: true });
      } catch (e) {
        return res.status(500).json({ ok: false, error: `拒票失败：${(e as Error).message}` });
      }
    }
    try {
      const eid = await requestConfirmation(store,{capability:'invoice.edit',entity_type:'invoice',entity_id:req.params.id,payload:{invoice_id:req.params.id,fields:patch},initiator:currentUser(req)!.username});
      await resolveConfirmation(store,eid,'confirmed',currentUser(req)!.username);
      res.json({ok:true});
    } catch(error) { res.status(400).json({ok:false,error:(error as Error).message}); }
  });

  // —— 确认卡（P1）：待确认写操作列表 + 同意/拒绝。AI 低置信写操作 → proposed 提案 → 人确认 → handler 更新投影 ——
  app.get('/api/confirmations', requireAuth, async (_req, res) => {
    const allowed=(await listPendingConfirmations(getStore())).filter(event=>{
      if(requireActor().role==='admin') return true;
      try {checkAction(getActionContract(event.capability),requireActor());return true;} catch {return false;}
    });
    const list = enrichConfirmations(allowed);
    res.json({ list });
  });
  // 帖子类确认卡（老板派活）manager 可自行拍板；其余写操作仍 admin/finance 把关
  app.post('/api/confirmations/:id', requireAuth, async (req, res) => {
    const decision = req.body?.decision;
    if (decision !== 'confirmed' && decision !== 'rejected') {
      return res.status(400).json({ ok: false, error: 'decision 必须是 confirmed 或 rejected' });
    }
    const me = currentUser(req);
    try {
      const evtRows = await getStore().query('execution', 'events', { id: req.params.id });
      const cap = String((evtRows[0] as any)?.capability || '');
      // 仅财务专属类（发票审核/入账/记账/红冲）manager 不能批；建订单/回款/派活等业务操作老板自己拍板
      try { if(!(decision==='rejected' && requireActor().role==='admin')) checkAction(getActionContract(cap),requireActor()); }
      catch (error) { return res.status(403).json({ok:false,error:(error as Error).message}); }
      const reviewer = me?.display_name || me?.username || 'unknown';
      await resolveConfirmation(getStore(), String(req.params.id), decision, reviewer);
      // 回执带 id/status：与 Frappe /resolve 口径一致，前端 real-chat 的回执校验（r.id===confirm.id）可直接复用。
      res.json({ ok: true, id: String(req.params.id), status: decision });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // —— 业务仪表盘（P2）：工作台 = 真实业务数据聚合（发票/确认卡/记账/事件链健康度）——
  app.get('/api/dashboard/business', requireRole('admin','finance','manager'), async (_req, res) => {
    const store = getStore();
    // R0：一次并行拉齐——同一请求内各表只拉一次飞书（store 层 in-flight 去重 + TTL 兜底）。
    // 原实现串行拉 4 次 events（pendingConfirmations / 直接 query / verifyChain / aggregate 各一遍），
    // bitable 单次全表拉取 1.2~2.7s，是「打开工作台 9.3s」的最大构成。
    const [invoices, ledger, cards, events, biz] = await Promise.all([
      store.query('business', 'invoices'),
      store.query('business', 'ledger'),
      listPendingConfirmations(store),
      store.query('execution', 'events'),
      aggregateBusiness(store),
    ]);
    // R0：verifyChain 复用上面已拉取的事件行（零额外请求）；链健康展示保留（演示「不可篡改」叙事）
    const breaks = await verifyChain(store, events);
    const recent = [...events]
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 8)
      .map((e: any) => ({ id: e.id, capability: e.capability, entity_type: e.entity_type, entity_id: e.entity_id, status: e.status, initiator: e.initiator, created_at: e.created_at }));
    res.json({
      pending_invoices: invoices.filter((i: any) => i.status === '待审').length,
      cash:await cashSummary(store),
      booked: invoices.filter((i: any) => i.status === '已入账').length,
      pending_cards: cards.length,
      ledger_count: ledger.length,
      events_total: events.length,
      chain_broken: breaks.length,
      recent_events: recent,
      // 进销存（与每日简报共用聚合）
      order_count: biz.order_count,
      order_pending: biz.order_pending,
      order_confirmed: biz.order_confirmed,
      order_completed: biz.order_completed,
      inventory_sku: biz.inventory_sku,
      receivable_balance: biz.receivable_balance,
      payable_balance: biz.payable_balance,
      gross_profit: biz.gross_profit,
    });
  });
  // —— 每日经营简报（A3）：最近简报列表 + 手动生成（触发器 run 也可触发） ——
  app.get('/api/briefs', requireRole('admin','finance','manager'), async (_req, res) => {
    res.json({ list: await listBriefs(getStore(), 5) });
  });
  app.post('/api/briefs/generate', requireRole('admin', 'finance'), async (_req, res) => {
    try {
      const content = await generateDailyBrief(getStore(), loadConfig());
      res.json({ ok: true, content });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  // —— 主动提醒（A4）：待处理提醒列表 + 手动扫描 + 标记已处理 ——
  app.get('/api/alerts', async (req, res) => {
    const store = getStore();
    const rows = await store.query('execution', 'alerts');
    const onlyOpen = String(req.query.status || '') !== 'all';
    const list = [...rows]
      .filter((a: any) => !onlyOpen || a.status === '待处理')
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ list });
  });
  app.post('/api/alerts/scan', requireRole('admin', 'finance'), async (_req, res) => {
    try {
      const { added } = await scanAlerts(getStore(), loadConfig());
      res.json({ ok: true, added });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  app.patch('/api/alerts/:id', requireRole('admin', 'finance'), async (req, res) => {
    try {
      await getStore().update('execution', 'alerts', String(req.params.id), { status: '已处理' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  // —— 演示数据重置（仅本地演示库）：把 seed-snapshot 拷回 store/attachments，事件链尾缓存一并清掉 ——
  app.post('/api/demo/reset', requireRole('admin'), (_req,res) => {
    res.status(410).json({ok:false,error:'已退役 JSON 覆盖式重置；请通过隔离数据库备份恢复。冻结 demo 不受本分支影响。'});
  });
  // —— 工作区（2026-08-10）：模板列表 + 我的启用 + admin 编辑模板 ——
  app.get('/api/workspaces', async (req, res) => {
    const me = currentUser(req);
    const cfg = loadConfig();
    const store = getStore();
    const view = await visibleWorkspaces(store, cfg.workspaces, me?.username || '', me?.role || 'staff');
    const custom = await customWorkspaces(store, me?.username || '');
    res.json({ ...view, custom });
  });
  app.patch('/api/me/workspaces', async (req, res) => {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ ok: false, error: '未登录' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const cfg = loadConfig();
    const valid = new Set(cfg.workspaces.map((w) => w.id));
    if (ids.some((i: string) => !valid.has(i))) return res.status(400).json({ ok: false, error: '包含未知工作区' });
    // 个人自定义工作区 [{id,name,modules}]（私有，不共享）
    let custom: any = undefined;
    if (Array.isArray(req.body?.custom)) {
      custom = req.body.custom.map((w: any) => ({ id: String(w.id), name: String(w.name || '我的工作区'), desc: '个人自定义', roles: [], modules: Array.isArray(w.modules) ? w.modules.map(String) : [], preset: false }));
    }
    await setEnabledWorkspaces(getStore(), me.username, ids, custom);
    res.json({ ok: true, ids, custom });
  });
  app.put('/api/workspaces', requireRole('admin'), async (req, res) => {
    const list = req.body?.workspaces;
    if (!Array.isArray(list)) return res.status(400).json({ ok: false, error: 'workspaces 必须是数组' });
    // 校验结构：id/name/modules 必填
    for (const w of list) {
      if (!w.id || !w.name || !Array.isArray(w.modules)) return res.status(400).json({ ok: false, error: `工作区 ${w.id || '?'} 缺 id/name/modules` });
    }
    const cfg = loadConfig();
    cfg.workspaces = list;
    saveConfig(cfg);
    await audit(getStore(), currentUser(req), 'workspace.update', 'workspaces');
    res.json({ ok: true, workspaces: list });
  });

  // —— 记账（P2 切真）：流水查询 + 人工记一笔（走事件写总线：提案 → 确认 → 投影）——
  // R4：财务读接口按角色收敛（UI 侧栏有过滤、API 原来没有——staff 可直连读财务数据）
  app.get('/api/ledger', requireRole('admin', 'finance', 'manager'), async (_req, res) => {
    const rows = await getStore().query('business', 'ledger');
    const sorted = [...rows].sort((a: any, b: any) =>
      String(b.posted_at ?? b.created_at ?? '').localeCompare(String(a.posted_at ?? a.created_at ?? '')));
    res.json({ list: sorted });
  });
  app.post('/api/ledger', requireRole('admin', 'finance'), async (req, res) => {
    const entry = req.body?.entry;
    if (!entry || typeof entry !== 'object') return res.status(400).json({ ok: false, error: 'entry 不能为空' });
    const reviewer = currentUser(req)?.display_name || currentUser(req)?.username || 'unknown';
    try {
      const eid = await requestConfirmation(getStore(), {
        capability: 'ledger.post', entity_type: 'ledger', entity_id: 'manual:' + Date.now(),
        payload: entry, initiator: 'user',
      });
      await resolveConfirmation(getStore(), eid, 'confirmed', reviewer);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });
  // 渐进吸收（2026-08-19）：记账页「照旧？」小字提示数据源——只读推荐，阈值可配（habit.min_count）。
  app.get('/api/habits/ledger-suggest', requireRole('admin', 'finance'), async (req, res) => {
    const { suggestLedgerHabit, HABIT_MIN_COUNT_DEFAULT } = await import('../../core/erp-ops.ts');
    const minCount = Number(loadConfig().habit?.min_count) || HABIT_MIN_COUNT_DEFAULT;
    const h = await suggestLedgerHabit(getStore(), String(req.query.counterparty || ''), minCount);
    res.json(h ? { found: true, ...h, min_count: minCount } : { found: false, min_count: minCount });
  });

  // —— 客户 / 产品主档（M1 进销存）：GET 全员可读；写操作走事件总线（用户即确认） ——
  // userConfirmed：表单提交 = proposed → 立即 confirmed（留痕且不占用待确认列表；AI 发起的提案才挂起）
  const userConfirmed = async (req: express.Request, cap: string, entityType: string, payload: Record<string, any>) => {
    const store = getStore();
    const reviewer = currentUser(req)?.display_name || currentUser(req)?.username || 'unknown';
    const eid = await requestConfirmation(store, {
      capability: cap, entity_type: entityType, entity_id: 'manual:' + Date.now(),
      payload, initiator: 'user',
    });
    await resolveConfirmation(store, eid, 'confirmed', reviewer);
  };
  app.get('/api/customers', async (_req, res) => {
    res.json({ list: await getStore().query('business', 'customers') });
  });
  app.post('/api/customers', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: '客户名称不能为空' });
    try {
      await userConfirmed(req, 'customer.create', 'customer', { ...req.body, name: String(name).trim() });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  app.patch('/api/customers/:id', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    try {
      await userConfirmed(req, 'customer.update', 'customer', { id: req.params.id, ...req.body });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  app.get('/api/products', async (_req, res) => {
    res.json({ list: await getStore().query('business', 'products') });
  });
  app.post('/api/products', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    const { sku, name } = req.body || {};
    if (!sku || !String(sku).trim() || !name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: 'SKU 与产品名称不能为空' });
    }
    try {
      await userConfirmed(req, 'product.create', 'product', { ...req.body, sku: String(sku).trim(), name: String(name).trim() });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  app.patch('/api/products/:id', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    try {
      await userConfirmed(req, 'product.update', 'product', { id: req.params.id, ...req.body });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  // —— 项目（R1）：列表全员可读；创建走事件总线（用户即确认）——
  app.get('/api/projects', async (_req, res) => {
    res.json({ list: await getStore().query('business', 'projects') });
  });
  app.post('/api/projects', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: '项目名称不能为空' });
    try {
      await userConfirmed(req, 'project.create', 'project', { ...req.body, name: String(name).trim() });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  // —— 任务（W11 2026-08-20）：任务广场真表——列表全员可读；增/改走事件总线（用户即确认） ——
  app.get('/api/tasks', async (req, res) => {
    const user=currentUser(req)!;
    const rows = await visibleTasks(getStore(),requireActor());
    const people = await collaborationPeople(getStore());
    const names = new Map(people.map(person => [person.username, person.display_name]));
    const visible = rows;
    visible.sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
    res.json({ list: visible.map(row => ({...row, assignee:names.get(row.assignee_id)||row.assignee})) });
  });
  app.post('/api/tasks', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    const { title } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ ok: false, error: '任务标题不能为空' });
    try {
      await userConfirmed(req, 'task.create', 'task', { ...req.body, title: String(title).trim() });
      res.json({ ok: true });
    } catch (e) { const error=(e as Error).message;res.status(error.includes('无权限')?403:error.includes('版本')?409:400).json({ok:false,error}); }
  });
  app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
    try {
      await userConfirmed(req, 'task.update', 'task', { ...req.body,id: req.params.id });
      res.json({ ok: true });
    } catch (e) { const error=(e as Error).message;res.status(error.includes('无权限')?403:error.includes('版本')?409:400).json({ok:false,error}); }
  });

  // —— 帖子广场（2026-08-20）：老板派活 / AI 预警抛帖，员工认领+回复进度；读全员，写走事件总线 ——
  app.get('/api/posts', async (_req, res) => {
    const posts = await getStore().query('process', 'posts');
    posts.sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
    const replies = await getStore().query('process', 'post_replies');
    replies.sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
    res.json({
      list: posts.map((p: any) => ({ ...p, replies: replies.filter((r: any) => r.post_id === p.id) })),
    });
  });
  app.post('/api/posts', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    const { content } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ ok: false, error: '帖子内容不能为空' });
    try {
      const me = currentUser(req);
      await userConfirmed(req, 'post.create', 'post', {
        content: String(content).trim(),
        author: me?.display_name || me?.username || 'unknown',
        author_role: me?.role || 'staff',
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  app.post('/api/posts/:id/claim', requireRole('admin', 'manager', 'finance', 'staff'), async (req, res) => {
    try {
      const me = currentUser(req);
      await userConfirmed(req, 'post.claim', 'post', {
        id: req.params.id, assignee: me?.display_name || me?.username || 'unknown',
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  app.post('/api/posts/:id/replies', async (req, res) => {
    const { content } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ ok: false, error: '回复内容不能为空' });
    try {
      const me = currentUser(req);
      await getStore().insert('process', 'post_replies', {
        post_id: req.params.id,
        author: me?.display_name || me?.username || 'unknown',
        content: String(content).trim(),
        created_at: new Date().toISOString(),
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  // —— 订单（M2）：列表/详情/创建/确认/完成/取消。确认 → 应收台账（事件链留痕） ——
  const orderAction = (cap: string, guard: (order: any) => void) => async (req: express.Request, res: express.Response) => {
    try {
      const store = getStore();
      const orders = await store.query('business', 'orders', { id: req.params.id });
      if (!orders.length) return res.status(404).json({ ok: false, error: '订单不存在' });
      guard(orders[0]);
      await userConfirmed(req, cap, 'order', { order_id: req.params.id });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  };
  app.get('/api/orders', async (_req, res) => {
    const store = getStore();
    const rows = await store.query('business', 'orders');
    const sorted = [...rows].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ list: sorted });
  });
  app.get('/api/orders/:id', async (req, res) => {
    const store = getStore();
    const rows = await store.query('business', 'orders', { id: req.params.id });
    if (!rows.length) return res.status(404).json({ error: '订单不存在' });
    const items = await store.query('business', 'order_items', { order_id: req.params.id });
    res.json({ order: rows[0], items });
  });
  app.post('/api/orders', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    const { customer_id, items, note } = req.body || {};
    if (!customer_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: '订单需客户与至少一条明细' });
    }
    for (const it of items) {
      if (!it.product_id || !(Number(it.qty) > 0)) return res.status(400).json({ ok: false, error: '明细需产品与数量>0' });
    }
    try {
      await userConfirmed(req, 'order.create', 'order', { customer_id, items, note });
      const created = await getStore().query('business', 'orders');
      const id = created.sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0]?.id || '';
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  app.post('/api/orders/:id/confirm', requireRole('admin', 'manager', 'finance'), orderAction('order.confirm', (o) => {
    if (o.status !== '草稿') throw new Error(`仅草稿订单可确认，当前 ${o.status}`);
  }));
  app.post('/api/orders/:id/cancel', requireRole('admin', 'manager', 'finance'), orderAction('order.cancel', (o) => {
    if (o.status === '已完成') throw new Error('已完成订单不可取消');
    if (o.status === '已取消') throw new Error('订单已取消');
  }));
  app.post('/api/orders/:id/complete', requireRole('admin', 'manager', 'finance'), orderAction('order.complete', (o) => {
    if (o.status !== '已确认') throw new Error(`仅已确认订单可完成，当前 ${o.status}`);
  }));

  // —— 应收台账（M2 生成 / M5 深度使用）：订单确认 → 应收；回款登记在 M5 接入 ——
  app.get('/api/receivables', requireRole('admin', 'finance', 'manager'), async (req, res) => {
    const store = getStore();
    const rows = await store.query('business', 'receivables');
    const q = String(req.query.customer_id || '');
    const filtered = q ? rows.filter((r: any) => r.customer_id === q) : rows;
    res.json({ list: filtered });
  });

  // —— 应付台账（M3 生成 / M5 深度使用）：采购收货 → 应付；付款登记在 M5 接入 ——
  app.get('/api/payables', requireRole('admin', 'finance', 'manager'), async (req, res) => {
    const store = getStore();
    const rows = await store.query('business', 'payables');
    const q = String(req.query.supplier || '');
    const filtered = q ? rows.filter((r: any) => r.supplier === q) : rows;
    res.json({ list: filtered });
  });

  // —— 财务登记（M5）：回款 / 付款 → 事件总线 → 台账状态迁移（余额校验）——
  const payAction = (cap: string) => async (req: express.Request, res: express.Response) => {
    const amount = Number(req.body?.amount) || 0;
    try {
      await userConfirmed(req, cap, cap.split('.')[0], {occurred_on:req.body?.occurred_on,account:req.body?.account,note:req.body?.note, [cap.split('.')[0] + '_id']: req.params.id, amount });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  };
  app.post('/api/receivables/:id/pay', requireRole('admin', 'finance', 'manager'), payAction('receivable.pay'));
  app.post('/api/payables/:id/pay', requireRole('admin', 'finance', 'manager'), payAction('payable.pay'));

  // —— 发货出库（A1）：人触发 = userConfirmed('order.ship') 一次授权 → shipOrder 编排执行（与 AI 工具共用）——
  app.post('/api/orders/:id/ship', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    try {
      const rows = await getStore().query('business', 'orders', { id: req.params.id });
      if (!rows.length) return res.status(404).json({ ok: false, error: '订单不存在' });
      await userConfirmed(req, 'order.ship', 'order', { order_id: req.params.id });
      res.json({ ok: true, shipped: 1 });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  });

  // —— 采购（M3）+ 库存（M4）：写路径走事件总线；收货入库联动 ——
  const purchaseAction = (cap: string, guard: (p: any) => void) => async (req: express.Request, res: express.Response) => {
    try {
      const store = getStore();
      const rows = await store.query('business', 'purchases', { id: req.params.id });
      if (!rows.length) return res.status(404).json({ ok: false, error: '采购单不存在' });
      guard(rows[0]);
      await userConfirmed(req, cap, 'purchase', { purchase_id: req.params.id });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  };
  app.get('/api/purchases', async (_req, res) => {
    const rows = await getStore().query('business', 'purchases');
    const sorted = [...rows].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ list: sorted });
  });
  app.get('/api/purchases/:id', async (req, res) => {
    const store = getStore();
    const rows = await store.query('business', 'purchases', { id: req.params.id });
    if (!rows.length) return res.status(404).json({ error: '采购单不存在' });
    const items = await store.query('business', 'purchase_items', { purchase_id: req.params.id });
    res.json({ purchase: rows[0], items });
  });
  app.post('/api/purchases', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    const { supplier, type, items, note, order_id } = req.body || {};
    if (!supplier || !String(supplier).trim() || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: '采购单需供应商与至少一条明细' });
    }
    for (const it of items) {
      if (!it.product_id || !(Number(it.qty) > 0)) return res.status(400).json({ ok: false, error: '明细需产品与数量>0' });
    }
    try {
      await userConfirmed(req, 'purchase.create', 'purchase', { supplier, type, items, note, order_id });
      const created = await getStore().query('business', 'purchases');
      const id = created.sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0]?.id || '';
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
  app.post('/api/purchases/:id/confirm', requireRole('admin', 'manager', 'finance'), purchaseAction('purchase.confirm', (p) => {
    if (p.status !== '草稿') throw new Error(`仅草稿采购单可确认，当前 ${p.status}`);
  }));
  app.post('/api/purchases/:id/receive', requireRole('admin', 'manager', 'finance'), purchaseAction('purchase.receive', (p) => {
    if (p.status !== '已确认') throw new Error(`仅已确认采购单可收货，当前 ${p.status}`);
  }));
  app.post('/api/purchases/:id/complete', requireRole('admin', 'manager', 'finance'), purchaseAction('purchase.complete', (p) => {
    if (p.status !== '已收货') throw new Error(`仅已收货采购单可完成，当前 ${p.status}`);
  }));
  // 库存：当前量 + 流水 + 出库动作（发货/领用）
  app.get('/api/inventory', async (_req, res) => {
    const store = getStore();
    const rows = await store.query('business', 'inventory');
    const moves = await store.query('business', 'inventory_movements');
    const sortedMoves = [...moves].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 100);
    res.json({ list: rows, moves: sortedMoves });
  });
  app.post('/api/inventory/move', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    const { product_id, qty, ref_type, ref_id } = req.body || {};
    try {
      await userConfirmed(req, 'inventory.move', 'inventory', { product_id, qty, ref_type, ref_id });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  });

  // —— 消息（真实 IM）：会话/消息/未读；写路径 = im.send 事件 → messages 投影 ——
  const myName = (req: express.Request): string =>
    currentUser(req)?.username || currentUser(req)?.display_name || 'unknown';
  app.get('/api/im/users', async (_req, res) => {
    const rows = await collaborationPeople(getStore());
    const me = currentUser(_req)?.username || '';
    res.json({ list: rows
      .filter((u: any) => u.username !== me)
      .map((u: any) => ({ username: u.username, display_name: u.display_name || u.username, role: u.role })) });
  });
  app.get('/api/im/chats', async (_req, res) => {
    res.json({ list: await listChats(getStore(), myName(_req)) });
  });
  app.post('/api/im/chats', async (req, res) => {
    const me = myName(req);
    const { type, peer_id, name, member_ids } = req.body || {};
    try {
      // 2026-08-28 修复：私聊对象/群成员必须是存在的启用账号（与 addMembers 同一护栏，防幻影成员）
      const rawIds = type === 'dm' ? [String(peer_id || '')] : (Array.isArray(member_ids) ? member_ids.map(String) : []);
      if (rawIds.some((x) => !x.trim())) return res.status(400).json({ ok: false, error: '缺少会话对象/成员' });
      const users = await collaborationPeople(getStore());
      const valid = new Set(users.map(u => u.username));
      const bad = rawIds.filter((x: string) => !valid.has(x));
      if (bad.length) return res.status(400).json({ ok: false, error: `账号不存在或已停用：${bad.join('、')}` });
      const id = type === 'dm'
        ? await getOrCreateDm(getStore(), me, String(peer_id || ''))
        : await createGroup(getStore(), me, String(name || ''), Array.isArray(member_ids) ? member_ids : []);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });
  app.get('/api/im/chats/:id/messages', async (req, res) => {
    try{res.json(req.query.page==='1'?await messagePage(getStore(),String(req.params.id),myName(req),req.query):{list:await listMessages(getStore(),String(req.params.id),myName(req))});}
    catch(e){res.status(400).json({ok:false,error:(e as Error).message});}
  });
  app.get('/api/im/favorites',async(req,res)=>{res.json({list:await listFavorites(getStore(),myName(req))});});
  app.post('/api/im/chats/:id/messages/:mid/favorite',async(req,res)=>{
    try{if(typeof req.body?.favorite!=='boolean')throw Error('收藏参数无效');await setFavorite(getStore(),String(req.params.id),String(req.params.mid),myName(req),req.body.favorite);res.json({ok:true});}
    catch(e){res.status(400).json({ok:false,error:(e as Error).message});}
  });
  const checkMessageFiles=async(req:express.Request,files:{ref_name:string;file:string}[])=>{
    for(const ref of files){const result=await readPlatformService(req,'files.versions',{attachment:ref.file});if(result.file?.name!==ref.ref_name||!result.versions?.some((v:any)=>v.source?.file===ref.file))throw Error('文件版本不可用');}
  };
  app.post('/api/im/chats/:id/messages/:mid/forward',async(req,res)=>{
    const me=myName(req),target=String(req.body?.target_chat_id||''),source=String(req.params.id),mid=String(req.params.mid),key=String(req.body?.client_msg_id||'').slice(0,80),origin=JSON.stringify([source,mid]);
    try{
      if(!key||req.body?.confirmed!==true)throw Error('请确认转发目标与副本说明');
      await memberChat(getStore(),source,me);await memberChat(getStore(),target,me);
      const [original]=await getStore().query('im','messages',{id:mid});
      if(!original||original.chat_id!==source)throw Error('原消息不可用');
      // 已有回执不再依赖文件域在线；仍在事务里复核成员、来源与幂等键。
      const [prior]=await getStore().query('im','messages',{chat_id:target,sender_id:me,client_msg_id:key});
      const files=parseIm<any[]>(original.file_refs,[]);if(!prior&&!original.recalled)await checkMessageFiles(req,files);
      await atomic(getStore(),async tx=>{
        await memberChat(tx,source,me);await memberChat(tx,target,me);
        const [dup]=await tx.query('im','messages',{chat_id:target,sender_id:me,client_msg_id:key});
        if(dup){if(dup.forward_origin!==origin)throw Error('发送编号冲突');return;}
        const [now]=await tx.query('im','messages',{id:mid});if(!now||now.recalled||now.chat_id!==source)throw Error('原消息已撤回或不可用');
        const eid=await requestConfirmation(tx,{capability:'im.send',entity_type:'chat',entity_id:target,payload:{chat_id:target,sender_id:me,text:String(now.text||''),files,mentions:[],forwarded:true,forward_origin:origin,client_msg_id:key},initiator:'user'});
        await resolveConfirmation(tx,eid,'confirmed',me);
      });res.json({ok:true});
    }catch(e){res.status(400).json({ok:false,error:(e as Error).message});}
  });
  // 显式已读：按消息 ID 推进游标（读取列表不再自动标记），查看会话时由前端提交最后一条消息
  app.post('/api/im/chats/:id/read', async (req, res) => {
    try {
      await markChatRead(getStore(), String(req.params.id), myName(req), String(req.body?.message_id || ''));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
  app.post('/api/im/chats/:id/messages', async (req, res) => {
    const chatId = String(req.params.id);
    const text = String(req.body?.text || '').trim();
    let extras;try{extras=normalizeMessageExtras(req.body);if(text.length>20000||(!text&&!extras.files.length))throw Error('消息须有正文或文件，正文最多20000字');}
    catch(e){return res.status(400).json({ok:false,error:(e as Error).message});}
    const me = myName(req);
    // 客户端幂等键：断网/超时后用同一 client_msg_id 重试不重复发送；旧客户端不带键则保持原行为
    const clientId = String(req.body?.client_msg_id || '').trim().slice(0, 80);
    const replyTo = String(req.body?.reply_to || '').trim();
    try {
      try{await memberChat(getStore(),chatId,me);}catch{return res.status(403).json({ok:false,error:'不在该会话中，无法发言'});}
      const prior=clientId?await getStore().query('im','messages',{chat_id:chatId,sender_id:me,client_msg_id:clientId}):[];
      if(!prior.length)try{await checkMessageFiles(req,extras.files);}catch{return res.status(400).json({ok:false,error:'文件版本不可用或无权读取，请在文件中心核对'});}
      const result = await atomic(getStore(), async store => {
      // 2026-08-28 修复：仅会话成员可发言（此前任意登录用户可向任意会话注入消息）
      const chatRows = await store.query('im', 'chats', { id: chatId });
      if (!chatRows.length) return {status:404,body:{ok:false,error:'会话不存在'}};
      const members = JSON.parse(String(chatRows[0].member_ids || '[]')) as string[];
      if (!members.includes(me)) return {status:403,body:{ok:false,error:'不在该会话中，无法发言'}};
      if (clientId) {
        const dup = await store.query('im', 'messages', { chat_id: chatId, sender_id:me, client_msg_id: clientId });
        if (dup.length) {
          const same = dup[0].payload_hash ? dup[0].payload_hash===messageFingerprint(text,replyTo,extras) : !extras.mentions.length&&!extras.files.length&&!dup[0].recalled && dup[0].text===text && String(dup[0].reply_to||'')===replyTo;
          if (!same) return {status:409,body:{ok:false,error:'此发送编号已用于另一条内容，请勿重复使用'}};
          return {status:200,body:{ok:true,duplicate:true}};
        }
      }
      try { await validateReply(store,chatId,replyTo);await validateMessageExtras(store,chatId,extras); }
      catch(error) { return {status:400,body:{ok:false,error:(error as Error).message}}; }
      const eid = await requestConfirmation(store, {
        capability: 'im.send', entity_type: 'chat', entity_id: chatId,
        payload: { chat_id: chatId, sender_id: me, text, client_msg_id: clientId, reply_to:replyTo,...extras }, initiator: 'user',
      });
      await resolveConfirmation(store, eid, 'confirmed', me);
      return {status:200,body:{ok:true}};
      });
      res.status(result.status).json(result.body);
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // —— IM 管理（2026-08-27）：群改名/加人/移人/退群/解散、私聊删会话、消息撤回 ——
  const isAdminReq = (req: express.Request): boolean => currentUser(req)?.role === 'admin';
  app.patch('/api/im/chats/:id', async (req, res) => {
    try {
      if(req.body?.preferences !== undefined) {
        if(Object.keys(req.body).some(k=>k!=='preferences'))throw new Error('个人设置不能与群资料混合提交');
        await setChatPreferences(getStore(),String(req.params.id),myName(req),req.body.preferences);
        return res.json({ok:true});
      }
      await renameChat(getStore(), String(req.params.id), String(req.body?.name || ''), myName(req), isAdminReq(req));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  });
  app.post('/api/im/chats/:id/members', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(String) : [];
      // 成员必须是存在的启用账号，防止拉入幻影成员
      const users = await collaborationPeople(getStore());
      const valid = new Set(users.map(u => u.username));
      const bad = ids.filter((x: string) => !valid.has(x));
      if (bad.length) throw new Error(`账号不存在或已停用：${bad.join('、')}`);
      await addMembers(getStore(), String(req.params.id), ids, myName(req));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  });
  app.delete('/api/im/chats/:id/members/:uid', async (req, res) => {
    try {
      await removeMember(getStore(), String(req.params.id), String(req.params.uid), myName(req), isAdminReq(req));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  });
  app.post('/api/im/chats/:id/leave', async (req, res) => {
    try {
      await leaveChat(getStore(), String(req.params.id), myName(req));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  });
  // 删除会话：群=解散（群主/管理员），私聊=整个删除（参与人/管理员）
  app.delete('/api/im/chats/:id', async (req, res) => {
    try {
      const rows = await getStore().query('im', 'chats', { id: String(req.params.id) });
      if (!rows.length) throw new Error('会话不存在');
      if (rows[0].type === 'group') await disbandChat(getStore(), String(req.params.id), myName(req), isAdminReq(req));
      else await deleteDmChat(getStore(), String(req.params.id), myName(req), isAdminReq(req));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  });
  app.post('/api/im/chats/:id/messages/:mid/recall', async (req, res) => {
    try {
      await recallMessage(getStore(), String(req.params.id), String(req.params.mid), myName(req));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: (e as Error).message }); }
  });

  // —— AI 对话（P4）：SSE 流式 + 能力调用 + 写操作确认卡 ——
  // 事件流：event: text（文本增量）/ tool（工具卡）/ confirm（确认卡提案）/ done（结束）。
  // 会话按用户维度（conversation_id = username）；对话记录存 execution.chat_messages。
  const sse = (res: express.Response, event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const chatToolModule: Record<string, string> = {
    invoice_query: 'review',
    invoice_book: 'review',
    ledger_query: 'accounting',
    ledger_post: 'accounting',
    customer_query: 'customers',
    customer_create: 'customers',
    product_query: 'inventory',
    product_create: 'inventory',
    inventory_query: 'inventory',
    order_query: 'orders',
    order_create: 'orders',
    order_confirm: 'orders',
    order_ship: 'delivery',
    purchase_create: 'purchase',
    purchase_receive: 'purchase',
    receivable_query: 'payables',
    receivable_pay: 'payables',
    payable_query: 'payables',
    payable_pay: 'payables',
    brief_query: 'dash',
    alert_query: 'dash',
    audit_query: 'dash',
  };
  app.get('/api/chat/engines', (_req, res) => res.json({ ok: true, engines: chatEngines(), default_engine:defaultChatEngine(), model:loadConfig().llm?.model || '' }));
  /**
   * 白名单化一段界面上下文（**内核能力**，2026-10-21）。
   *
   * 白名单之外的键**一律不收**（不是透传，是丢掉）——
   * 这条边界从头到尾没松过：多了一个「有上限的内容段」，不是「随便什么都能塞」。
   * 内容段由内核模块按**硬上限**截断并标 `truncated`。
   */
  function readUiContext(rawUi: any): ChatUiContext | undefined {
    if (!rawUi || typeof rawUi !== 'object' || Array.isArray(rawUi)) return undefined;
    const context: ChatUiContext = {
      record_name: String(rawUi.record_name || '').slice(0,140),
      module: String(rawUi.module || '').slice(0, 60),
      entity_type: String(rawUi.entity_type || '').slice(0, 80),
      entity_id: String(rawUi.entity_id || '').slice(0, 120),
      label: String(rawUi.label || '').slice(0, 160),
      view: String(rawUi.view || '').slice(0, 60),
      // 表格页专用（2026-10-19 FIX-03）：用户在看哪张工作表、当前选区是哪儿。
      // 只带**短字符串**（表名/单元格坐标），不带表格内容 —— 内容仍旧由工具重查。
      sheet: String(rawUi.sheet || '').slice(0, 140),
      selection: String(rawUi.selection || '').slice(0, 60),
      metadata_kind: String(rawUi.metadata_kind || '').slice(0, 30),
      metadata_key: String(rawUi.metadata_key || '').slice(0, 120),
      metadata_revision: Number.isInteger(rawUi.metadata_revision) ? Number(rawUi.metadata_revision) : undefined,
      selected_node_id: String(rawUi.selected_node_id || '').slice(0, 120),
      editable_scope: String(rawUi.editable_scope || '').slice(0, 120),
      // 这一份上下文是**什么时候**产生的（前端打的时间戳）：
      // 服务端靠它判「后来的那份才覆盖先来的」—— 免得一份**旧**的推送晚到把新的盖掉。
      updated_at: Number.isFinite(Number(rawUi.updated_at)) ? Number(rawUi.updated_at) : 0,
    };
    // 内容段：只有内核白名单认的那几个键进来，且按硬上限截断。
    const content = normalizeContextContent(rawUi.content);
    if (content) context.content = content;
    return context;
  }

  /**
   * 「当前上下文」的上报通道（2026-10-21）。
   *
   * 前端**每次切页 / 切信 / 改选区**都推一份过来（前端那边有节流合并，不是高频洪水）；
   * 服务端存成**这个会话的唯一一份** —— 后到的覆盖先到的，不会出现两份打架的当前上下文。
   *
   * ⚠️ 这里**不核读权**：读权在**用的时候**（下一轮对话）按**当前身份**核 ——
   * 提前核会变成「上报时能读、发消息时已经不能读」却照样带进去。
   */
  app.post('/api/chat/context', (req, res) => {
    const me = currentUser(req)?.username || 'unknown';
    const uiContext = readUiContext(req.body?.ui_context);
    if (!uiContext) return res.status(400).json({ ok: false, error: 'ui_context 不能为空' });
    const reqCid = req.body?.conversation_id ? String(req.body.conversation_id).slice(0, 64) : '';
    const conversationId = reqCid ? (reqCid.startsWith(me + ':') ? reqCid : `${me}:${reqCid}`) : me;
    const accepted = acceptCurrentContext(me, conversationId, uiContext);
    res.json({ ok: true, applied: accepted });
  });

  app.post('/api/chat', async (req, res) => {
    const text = String(req.body?.message || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'message 不能为空' });
    let engine: 'classic' | 'pi';
    try { engine = chatEngine(req.body?.engine); }
    catch (error) { return res.status(400).json({ ok: false, error: (error as Error).message }); }
    // 前端分栏把当前业务对象作为弱上下文传入。这里只接收短字符串；
    // 它帮助理解“这张/这笔”，但 core/chat 仍要求用工具重查事实，不能据此直接写数据。
    // ⚠️ 内容段（用户屏幕上正在看的那部分正文/单元格）**不在这里收** ——
    //   它由 `POST /api/chat/context` 那条**活**通道收，核过读权才进提示词。
    const rawUi = req.body?.ui_context;
    const uiContext = readUiContext(rawUi);
    const me = currentUser(req)?.username || 'unknown';
    // 会话隔离（修复）：前端按真实会话传 conversation_id（新建会话=新 id → 历史为空），
    // 不再整个用户共用一个永不重置的 conversation_id=username，避免旧上下文污染新会话。
    // 幂等拼接：若前端传的是完整 me:session（续聊回传），不再二次拼 me:，避免 me:me:xxx 失忆。
    const reqCid = req.body?.conversation_id ? String(req.body.conversation_id).slice(0, 64) : '';
    const conversationId = reqCid ? (reqCid.startsWith(me + ':') ? reqCid : `${me}:${reqCid}`) : me;
    // ——「当前上下文」的**权威份在服务端**（2026-10-21）：
    //   前端每次切页/切信/改选区都往 `POST /api/chat/context` 推一份（后到的覆盖先到的）；
    //   这一轮**用服务端存的那份**，不是发消息那一刻的快照。
    //   请求体里那份 `ui_context` 是前端**当前**的上下文（带 updated_at）：
    //   比服务端那份**新**才更新它（旧的不许盖新的），更新完仍然**用服务端那份**。
    if (uiContext) acceptCurrentContext(me, conversationId, uiContext);
    const authoritative = getCurrentContext(me, conversationId);
    // 内容段：**按当前身份再核一遍**出处 —— 核不过就丢弃内容（一个字都不进提示词），并说明原因。
    let effectiveContext = authoritative;
    let contentDropped = '';
    if (authoritative?.content) {
      const checked = await checkContextContent(authoritative, createContextRefReader(req, platformMode));
      effectiveContext = checked.context;
      if (checked.dropped) contentDropped = checked.dropped.reason;
    }
    const ctx = buildContext(console.log, { external });
    // —— 附件（PKG-024-T01）：把前端报上来的**文件引用**按**当前身份的读权**读回来 ——
    //   图片 ⇒ 字节（模型自己看像素）；其它文件 ⇒ **只留引用**（内容不进提示词，由工具去读）。
    //   读不到的**明说哪一份没进来** —— 不许模型顺着「你看这张图」的话往下编。
    let chatAttachments: ChatAttachment[] = [];
    let attachmentsDropped = '';
    if (req.body?.attachments) {
      if (platformMode === 'frappe') {
        const resolved = await resolveChatAttachments(req.body.attachments, { readFile: authorizedFileReaders(req, external).readFile });
        chatAttachments = resolved.attachments;
        attachmentsDropped = resolved.dropped.map(item => `「${item.name}」（${item.reason}）`).join('、');
      } else {
        attachmentsDropped = '附件（当前接入方式暂不支持从对话里读附件）';
      }
    }
    let platformChatBridge: Awaited<ReturnType<typeof createPlatformChatBridge>> | undefined;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    if (platformMode === 'frappe') {
      try {
        platformChatBridge = await createPlatformChatBridge(req, external,
          effectiveContext?.record_name&&effectiveContext.entity_type?{object_id:effectiveContext.entity_type,name:effectiveContext.record_name,controller:ac}:undefined);
      } catch (error) {
        return res.status(503).json({ ok: false, code: 'PLATFORM_UNAVAILABLE', error: (error as Error).message });
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(':ok\n\n');

    // 客户端终止（点停止/关页）→ abort 信号传入 agent 循环：断 LLM 拉取、停止工具循环、不落兜底文案。
    // 必须监听 res 的 close：POST body 已被 express.json 消费，req 流早已完成、不会再发 close；
    // res close 在底层连接断开时触发（writableEnded 排除正常走完的情形）。

    try {
      const { reply, reasoning } = await runAgentLoop(ctx.store, ctx, {
        engine,
        conversationId,
        auditActorKey: me,
        actorRole: currentUser(req)?.role,
        userText: text,
        uiContext: effectiveContext,
        // 内容被丢弃时**明说原因**（模型据此不假装看过那段内容）。
        contentDropped,
        // 附件（PKG-024-T01）：图片带字节给模型看；其它只带引用。
        attachments: chatAttachments,
        attachmentsDropped,
        // Frappe 模式只暴露按用户/领域裁剪后的 public_api Tool 投影；不会回退 Node StateStore。
        toolDefs: platformChatBridge?.toolDefs,
        toolExecutor: platformChatBridge?.toolExecutor,
        signal: ac.signal,
        hooks: {
          onText: (delta) => sse(res, 'text', { delta }),
          onTool: (tool) => {
            sse(res, 'tool', tool);
            const module = chatToolModule[tool.name];
            if (module) sse(res, 'ui_navigate', { module, label: `AI 正在查看：${tool.name}` });
          },
          onConfirm: (confirm) => {
            sse(res, 'confirm', confirm);
            const module = chatToolModule[confirm.capability.replace(/\./g, '_')];
            if (module) sse(res, 'ui_navigate', {
              module,
              entity_type: confirm.entity_type,
              entity_id: confirm.entity_id,
              label: `${confirm.capability} · 待确认`,
            });
          },
          onPhase: (phase) => sse(res, 'phase', phase),
          // R967-D01（BASE967-11/12/28）：结构化执行卡——由真实工具回执驱动，前端按此渲染
          onStatus: (status) => sse(res, 'status', status),
        },
      });
      if (!ac.signal.aborted) sse(res, 'done', { reply, reasoning });
      res.end();
    } catch (e) {
      // 客户端主动终止（AbortError）不是错误：socket 已关，只记日志不回写
      if (ac.signal.aborted) console.log('[chat] 请求已终止：', (e as Error).message?.slice(0, 60) || 'client closed');
      else sse(res, 'error', { message: (e as Error).message });
      res.end();
    }finally{
      try{await platformChatBridge?.close();}catch(error){console.warn('[chat] 执行租约结束未核实：',(error as Error).message);}
    }
  });
  // 对话历史（前端刷新/回来看历史；created_at 透出供前端按时间分组会话）
  // 性能：不带 filter 查询 + 云端 sort/limit 下沉 —— 只拉最近 200 条再内存过滤本会话，避免 bitable 全表拉取
  app.get('/api/chat/history', async (req, res) => {
    const me = currentUser(req)?.username || 'unknown';
    // 2026-08-28 修复：先过滤本用户（含 me:会话 前缀）再截断——此前「先取全局最新 200 条再过滤」，
    // 多用户活跃时本用户历史会被整体挤出窗口，刷新后会话列表凭空丢失。
    const all = await getStore().query('execution', 'chat_messages');
    const list = all
      .filter((r: any) => r.conversation_id === me || String(r.conversation_id || '').startsWith(me + ':'))
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 50)
      // user/assistant 可能同毫秒落表；只按 created_at 会由 provider 返回顺序决定，
      // 偶发出现 assistant 在 user 前。相同时间固定 user → assistant。
      .sort((a: any, b: any) => {
        const byTime = String(a.created_at).localeCompare(String(b.created_at));
        if (byTime) return byTime;
        return (a.role === 'user' ? 0 : 1) - (b.role === 'user' ? 0 : 1);
      })
      .map((r: any) => ({
        role: r.role === 'user' ? 'user' : 'assistant',
        content: String(r.content || ''),
        reasoning: r.role === 'assistant' ? String(r.reasoning || '') : '',
        created_at: r.created_at,
        conversation_id: r.conversation_id || '',
        // R967-D01（BASE967-30）：卡片绑定（提案/工具/执行状态）随历史回传，供原对话恢复按当前权限投影
        cards: projectHistoryCards(r.cards),
      }));
    res.json({ list });
  });
  // 删除会话（2026-08-28）：物理删除该会话全部消息（chat_messages 不在 append-only 名单）。
  // id 幂等归一：前端新会话传短 id（cxxx）、历史续聊传完整 me:xxx，统一补 me: 前缀——
  // 归属由归一化本身保证（永远落在 me: 命名空间内，别人的 id 会被拼成 me:别人:xxx 而查不到任何行）。
  app.delete('/api/chat/conversation/:cid', async (req, res) => {
    const me = currentUser(req)?.username || 'unknown';
    const raw = String(req.params.cid || '');
    const cid = raw === me || raw.startsWith(me + ':') ? raw : `${me}:${raw}`;
    const store = getStore();
    const msgs = await store.query('execution', 'chat_messages', { conversation_id: cid });
    for (const m of msgs) await store.delete('execution', 'chat_messages', m.id);
    const arch = (await store.query('execution', 'chat_archived', { conversation_id: cid })).filter((r: any) => r.username === me);
    for (const r of arch) await store.delete('execution', 'chat_archived', r.id);
    res.json({ ok: true, deleted: msgs.length });
  });
  // —— 事件链查询（A2）：按实体/能力查责任链（谁发起/谁确认/时间/hash），对话追溯与前端回执共用 ——
  app.get('/api/events', requireRole('admin', 'finance', 'manager'), async (req, res) => {
    const store = getStore();
    const rows = await store.query('execution', 'events');
    const entityType = String(req.query.entity_type || '');
    const entityId = String(req.query.entity_id || '');
    const capability = String(req.query.capability || '');
    let list = rows;
    if (entityType) list = list.filter((e: any) => e.entity_type === entityType);
    if (entityId) list = list.filter((e: any) => e.entity_id === entityId);
    if (capability) list = list.filter((e: any) => e.capability === capability);
    const sorted = [...list].sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
    res.json({ list: sorted.map((e: any) => ({
      id: e.id, capability: e.capability, entity_type: e.entity_type, entity_id: e.entity_id,
      status: e.status, initiator: e.initiator, reviewer: e.reviewer, executor: e.executor,
      hash: String(e.hash || '').slice(0, 8), created_at: e.created_at,
    })) });
  });

  // —— 手动上传发票（批量）：前端逐文件 octet-stream POST → 存 FileStore → OCR → 查重 → 待审入库 ——
  app.post(['/api/invoices/upload','/api/documents/upload'], async (req, res) => {
    if (!external) return res.status(500).json({ ok: false, status: 'failed', error: '外部服务未就绪' });
    try {
      const doctypeId = String(req.query.doctype || (req.path === '/api/invoices/upload' ? 'invoice_cn_vat' : ''));
      const doctype = getDocType(doctypeId);
      if (!doctype) throw new Error('请指定已发布的 doctype');
      // Express/qs 已对 req.query 解码一次，这里不再二次 decodeURIComponent（含 % 的文件名会抛 URIError）
      const filename = String(req.query.name || 'upload.pdf');
      const bytes = req.body as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return res.status(400).json({ ok: false, status: 'failed', error: '空文件' });
      }
      const ext = filename.toLowerCase().split('.').pop() || '';
      const mime = ({pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'} as Record<string,string>)[ext] || 'application/octet-stream';
      if (doctype.accept?.length && !doctype.accept.includes(mime)) throw new Error('该单据模板不接受此文件类型');
      const ctx = buildContext(console.log, { external });
      const { token } = await ctx.file.upload(filename, bytes, mime);
      const item = {
        mail_id: 'upload:' + token,
        file_token: token,
        filename,
        mime,
        sender_email: '',
        email_subject: '手动上传',
        received_at: new Date().toISOString(),
        source: 'upload',
      };
      const run = await runWorkflow(getStore(), doctype.intakeFlowId, {
        file_token: token,
        doctype: doctypeId,
        item,
        initiator: 'user',
      }, ctx, { initiator: 'user' });
      if (req.path === '/api/documents/upload') return res.json({ok:true,doctype:doctypeId,flow_run_id:run.id,status:run.status,result:run.result,steps:run.steps});
      const fileResult = (run.result || {}) as Record<string, unknown>;
      const fields = (fileResult.fields || {}) as Record<string, unknown>;
      let invoice_status = '';
      const invoiceId = String(fileResult.invoice_id || '');
      if (invoiceId) {
        const inv = await getStore().query('business', 'invoices', { id: invoiceId });
        invoice_status = String((inv[0] as any)?.status || '');
      }
      res.json({
        ok: true,
        status: fileResult.status || run.status,
        invoice_id: invoiceId || undefined,
        flow_run_id: run.id,
        filename,
        invoice_no: fields.invoice_no || '',
        seller_name: fields.seller_name || '',
        buyer_name: fields.buyer_name || '',
        issued_at: fields.issued_at || '',
        total_amount: fields.total_amount || 0,
        extraction_path: fileResult.extraction_path || '',
        tool_used: fileResult.tool_used || '',
        flow_steps: run.steps.map((s) => ({
          name: s.name,
          attribution: s.attribution,
          warnings: s.warnings,
        })),
        invoice_status,
        // 兼容旧前端；新 UI 优先 extraction_path
        confidence: 0,
      });
    } catch (e) {
      res.status(400).json({ ok: false, status: 'failed', error: (e as Error).message });
    }
  });

  // —— 文件预览（发票原图/PDF）——
  // 本地 FileStore 优先（新收集/手动上传的发票）；找不到时回退飞书云空间下载（历史记录存 bitable 附件列的 file_token）。
  app.get('/api/files/:token', async (req, res) => {
    try {
      const user=currentUser(req)!;
      if(user.role==='staff') {
        const own=await getStore().query('business','invoices',{file_token:req.params.token,submitted_by:user.username});
        if(!own.length) return res.status(404).json({error:'文件不存在或无权访问'});
      }
      const cfg = loadConfig();
      let f: { bytes: Buffer; mime: string; name: string };
      try {
        f = await createFileStore(cfg.file).read(req.params.token);
      } catch {
        const historical=await getStore().query('business','invoices',{file_token:req.params.token});
        if (historical.length && cfg.feishu.app_id && cfg.feishu.app_secret) {
          authorize(['admin','finance','manager']);
          f = await downloadMedia(cfg.feishu, req.params.token);
        } else {
          return res.status(404).json({ error: '原图不存在：本地无文件，也没有可读取的历史附件引用' });
        }
      }
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.end(f.bytes);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // —— 触发器 + 运行历史 ——
  app.get('/api/triggers', (_req, res) => res.json(listTriggers()));
  app.post('/api/triggers/:id/run', async (req, res) => {
    try { res.json(await runTrigger(req.params.id)); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.patch('/api/triggers/:id', (req, res) => {
    const cfg = loadConfig();
    const body = req.body as { schedule?: string; enabled?: boolean; params?: any };
    applyTriggerPatch(req.params.id, body);
    // 持久化到 config.poll（重启后保持）
    const t = listTriggers().find((x) => x.id === req.params.id);
    if (t) {
      cfg.poll.cron = t.schedule;
      cfg.poll.mailbox = t.params?.mailbox ?? cfg.poll.mailbox;
      saveConfig(cfg);
    }
    res.json({ ok: true, trigger: t });
  });
  app.get('/api/triggers/:id/runs', async (req, res) => res.json(await listJobRuns(req.params.id)));
  app.get('/api/capabilities', (_req, res) => res.json(listCapabilities()));
  // AI 工具管理页：对话可调工具清单（只读）。旧 Node 设计背景见 docs/research/legacy-ai-tools-and-workflows.md
  app.get('/api/ai-tools', requireRole('admin'), (_req, res) => {
    const tools = listChatTools();
    const sme = tools.filter((t) => t.surface === 'sme');
    res.json({
      ok: true,
      tools,
      summary: {
        total: tools.length,
        sme: sme.length,
        legacy: tools.length - sme.length,
        query: tools.filter((t) => t.kind === 'query').length,
        confirm: tools.filter((t) => t.kind === 'confirm').length,
      },
      note: '小微对话默认只用 surface=sme（object_* / metadata_* / doc_extract / flow_run 等）。legacy=进销存/旧专用名，清单可见但不进模型。元数据来源：cognition.meta_registry。',
    });
  });
  // 办事流程（M3）：模板清单 + 运行轨迹
  app.get('/api/workflows', requireAuth, (_req, res) => {
    const meta = listMetadataOverview();
    res.json({ ok: true, flows: meta.flows, doctypes: meta.doctypes, source: meta.source });
  });
  // 图流程审批（2026-08-28）：我的待审 + 决定（串行逐 slot / any 首个决定生效；决定后流程沿 success/rejected 边推进）
  app.get('/api/workflows/approvals', requireAuth, async (req, res) => {
    try {
      const ctx = buildContext(console.log, { external });
      if (!ctx.actor) return res.status(401).json({ ok: false, error: '缺少执行者上下文' });
      res.json({ ok: true, list: await listMyApprovals(getStore(), ctx.actor) });
    } catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });
  app.post('/api/workflows/approvals/:id', requireAuth, async (req, res) => {
    const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
    try {
      const ctx = buildContext(console.log, { external });
      const run = await decideFlowApproval(getStore(), String(req.params.id), decision, ctx);
      res.json({ ok: true, run });
    } catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });
  // 起跑流程（2026-08-28）：图流程要有独立触发入口（此前只能经单据 intake 隐式触发）。
  // input 由引擎按模板 inputSchema 校验；审批节点会转 waiting 等人。
  app.post('/api/workflows/:id/run', requireRole('admin', 'finance', 'manager', 'staff'), async (req, res) => {
    try {
      const ctx = buildContext(console.log, { external });
      const run = await runWorkflow(getStore(), String(req.params.id), req.body?.input || {}, ctx);
      res.json({ ok: true, run });
    } catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });
  app.get('/api/workflows/runs', requireRole('admin', 'finance', 'manager'), async (req, res) => {
    const flowId = String(req.query.flow_id || '');
    const runs = await listWorkflowRuns(getStore(), flowId || undefined, 30);
    res.json({ ok: true, runs });
  });
  app.post('/api/workflows', requireRole('admin'), async (req, res) => {
    try {
      const payload = emptyFlowTemplate({
        id: String(req.body?.id || ''),
        name: String(req.body?.name || ''),
        description: String(req.body?.description || ''),
      });
      await upsertMetaEntry(getStore(), 'flow', payload.id, payload, 0);
      const rec = await getMetaRecord(getStore(), 'flow', payload.id);
      await audit(getStore(), currentUser(req), 'workflow.create', payload.id, payload.name);
      res.json({ ok: true, flow: rec?.payload, version: rec?.version || 1 });
    } catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });
  app.get('/api/workflows/:id', requireAuth, async (req, res) => {
    const id = req.params.id;
    const rec = await getMetaRecord(getStore(), 'flow', id);
    if (rec) return res.json({ ok: true, flow: rec.payload, version: rec.version });
    const tpl = getWorkflowTemplate(id);
    if (!tpl) return res.status(404).json({ ok: false, error: '未找到流程' });
    res.json({ ok: true, flow: tpl, version: tpl.revision || 0 });
  });
  app.patch('/api/workflows/:id', requireRole('admin'), async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const rec = await getMetaRecord(getStore(), 'flow', id);
    const existing = rec?.payload || getWorkflowTemplate(id);
    if (!existing) return res.status(404).json({ ok: false, error: '未找到流程' });
    const next: WorkflowTemplate = {
      ...(existing as WorkflowTemplate),
      name: String(body.name || (existing as any).name || id),
      description: String(body.description ?? (existing as any).description ?? ''),
      doctype: body.doctype ?? (existing as any).doctype,
      steps: Array.isArray(body.steps) ? body.steps : ((existing as any).steps || []),
      graph: body.graph && typeof body.graph === 'object' ? body.graph : (existing as any).graph,
    };
    if (!next.graph?.nodes?.length && !next.steps?.length) return res.status(400).json({ ok: false, error: 'graph.nodes 或 steps 不能都为空' });
    if (!Number.isInteger(body.expected_revision)) return res.status(409).json({ok:false,error:'保存流程必须携带 expected_revision'});
    try { await upsertMetaEntry(getStore(), 'flow', id, next, body.expected_revision); }
    catch(error) { return res.status(409).json({ok:false,error:(error as Error).message}); }
    await audit(getStore(), currentUser(req), 'workflow.update', id, JSON.stringify({ nodes: next.graph?.nodes?.length || next.steps.length }));
    const published = await getMetaRecord(getStore(), 'flow', id);
    res.json({ ok: true, flow: published?.payload || getWorkflowTemplate(id), version: published?.version, note: '已发布新版本，新运行的流程实例立即生效' });
  });
  app.get('/api/workflows/runs/:id', requireRole('admin', 'finance', 'manager'), async (req, res) => {
    const run = await getWorkflowRun(getStore(), req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: '未找到运行记录' });
    res.json({ ok: true, run });
  });

  // 对象元数据清单（M1 只读）+ 查询/提案（M2）
  app.post('/api/workflows/runs/:id/resume',requireAuth,async(req,res)=>{
    try {res.json({ok:true,run:await resumeWorkflow(getStore(),req.params.id,buildContext(console.log,{external}))});}
    catch(error){res.status(409).json({ok:false,error:(error as Error).message});}
  });
  // 数字员工最小运行时：复用 workflow/approval/action/event，不新增业务执行通道。
  app.get('/api/workers', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    try {
      const store = getStore();
      res.json({ ok: true, profiles: await listWorkerProfiles(store), runs: await listWorkerRuns(store, typeof req.query.profile_id === 'string' ? req.query.profile_id : undefined) });
    } catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });
  app.post('/api/workers', requireRole('admin'), async (req, res) => {
    try {
      const profile = await createWorkerProfile(getStore(), {
        id: String(req.body?.id || ''), name: String(req.body?.name || ''), responsibility: String(req.body?.responsibility || ''),
        flow_id: String(req.body?.flow_id || ''), allowed_tools: Array.isArray(req.body?.allowed_tools) ? req.body.allowed_tools : undefined,
      }, requireActor());
      res.status(201).json({ ok: true, profile });
    } catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });
  app.post('/api/workers/:id/runs', requireRole('admin', 'manager', 'finance', 'staff'), async (req, res) => {
    try { res.status(201).json({ ok: true, run: await dispatchWorker(getStore(), req.params.id, req.body?.input && typeof req.body.input === 'object' ? req.body.input : {}, buildContext(console.log, { external })) }); }
    catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });
  app.get('/api/worker-runs', requireRole('admin', 'manager', 'finance'), async (req, res) => {
    try { res.json({ ok: true, runs: await listWorkerRuns(getStore(), typeof req.query.profile_id === 'string' ? req.query.profile_id : undefined) }); }
    catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });
  app.post('/api/worker-runs/:id/pause', requireAuth, async (req, res) => {
    try { res.json({ ok: true, run: await pauseWorkerRun(getStore(), req.params.id, String(req.body?.reason || ''), requireActor()) }); }
    catch (error) { res.status(409).json({ ok: false, error: (error as Error).message }); }
  });
  app.post('/api/worker-runs/:id/handoff', requireAuth, async (req, res) => {
    try {
      const target = await findUser(getStore(), String(req.body?.to || '').trim());
      if (!target || target.status !== '启用') return res.status(400).json({ ok: false, error: '交接对象不存在或已停用' });
      res.json({ ok: true, run: await handoffWorkerRun(getStore(), req.params.id, { id: target.username, role: target.role, kind: 'human', channel: 'web' }, requireActor()) });
    }
    catch (error) { res.status(409).json({ ok: false, error: (error as Error).message }); }
  });
  app.post('/api/worker-runs/:id/resume', requireAuth, async (req, res) => {
    try { res.json({ ok: true, run: await resumeWorkerRun(getStore(), req.params.id, buildContext(console.log, { external })) }); }
    catch (error) { res.status(409).json({ ok: false, error: (error as Error).message }); }
  });
  app.get('/api/metadata', requireRole('admin', 'finance', 'manager'), (_req, res) => {
    res.json({ ok: true, ...listMetadataOverview() });
  });
  app.get('/api/metadata/:kind/:key',requireRole('admin','finance','manager'),async(req,res)=>{
    const rec=await getMetaRecord(getStore(),req.params.kind as any,req.params.key);
    if(!rec) return res.status(404).json({ok:false,error:'未找到元数据'});
    res.json({ok:true,...rec,entry:rec});
  });
  app.post('/api/metadata/propose',requireRole('admin'),async(req,res)=>{
    try {
      const proposed=await proposeMetadataWrite(getStore(),{
        kind:req.body.kind,key:String(req.body.key||''),payload:req.body.payload||{},
        expected_revision:req.body.expected_revision,
      });
      await audit(getStore(),currentUser(req),'metadata.propose',proposed.entity_id,JSON.stringify({kind:req.body.kind}));
      res.json(proposed);
    } catch(error){res.status(400).json({ok:false,error:(error as Error).message});}
  });
  app.post('/api/metadata/drafts',requireRole('admin'),async(req,res)=>{
    try {const id=await createMetadataDraft(getStore(),req.body.kind,req.body.key,req.body.payload);res.json({ok:true,id});}
    catch(error){res.status(400).json({ok:false,error:(error as Error).message});}
  });
  app.post('/api/metadata/drafts/:id/publish',requireRole('admin'),async(req,res)=>{
    if(!Number.isInteger(req.body.expected_revision)) return res.status(409).json({error:'缺少 expected_revision'});
    try {const revision=await publishMetadataDraft(getStore(),req.params.id,req.body.expected_revision);res.json({ok:true,revision});}
    catch(error){res.status(409).json({ok:false,error:(error as Error).message});}
  });
  app.post('/api/metadata/:kind/:key/rollback',requireRole('admin'),async(req,res)=>{
    if(!Number.isInteger(req.body.expected_revision) || !Number.isInteger(req.body.revision)) return res.status(409).json({error:'缺少 revision/expected_revision'});
    try {await rollbackMetadata(getStore(),req.params.kind as any,req.params.key,req.body.revision,req.body.expected_revision);res.json({ok:true});}
    catch(error){res.status(409).json({ok:false,error:(error as Error).message});}
  });
  app.get('/api/objects', requireAuth, (_req, res) => {
    const meta = listMetadataOverview();
    res.json({
      ok: true,
      objects: meta.objects,
      summary: { total: meta.objects.length },
      source: meta.source,
      note: '查：POST /api/objects/query；写：POST /api/objects/propose → 确认卡。',
    });
  });
  app.post('/api/objects/query', requireAuth, async (req, res) => {
    try {
      const result = await runObjectQuery(getStore(), req.body || {});
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
  app.post('/api/objects/propose', requireAuth, async (req, res) => {
    try {
      const u = currentUser(req);
      const body = req.body || {};
      const proposed = await proposeObjectWrite(getStore(), {
        object: String(body.object || ''),
        action: String(body.action || ''),
        data: body.data && typeof body.data === 'object' ? body.data : body,
        initiator: 'manual',
        actorRole: u?.role || '',
      });
      await audit(getStore(), u, 'object.propose', proposed.capability, JSON.stringify({ id: proposed.id, object: body.object }));
      res.json({ ...proposed, ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
  // 链路图谱：设计态 registry + 运行态 event 统计（近 7 天 confirmed / 待确认 proposed）
  app.get('/api/flows', requireRole('admin', 'finance', 'manager'), async (_req, res) => {
    const graph = buildFlowGraph();
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const events = await getStore().query('execution', 'events');
    const stats: Record<string, { confirmed_7d: number; pending: number; last_at: string | null }> = {};
    for (const e of events) {
      const cap = String((e as any).capability || '');
      if (!cap) continue;
      if (!stats[cap]) stats[cap] = { confirmed_7d: 0, pending: 0, last_at: null };
      const st = stats[cap];
      const at = String((e as any).created_at || '');
      if ((e as any).status === 'confirmed' && at >= since) st.confirmed_7d++;
      if ((e as any).status === 'proposed') st.pending++;
      if (at && (!st.last_at || at > st.last_at)) st.last_at = at;
    }
    res.json({ ...graph, domains: FLOW_DOMAINS, stats });
  });

  // —— 静态前端 shangshu-web ——
  app.get('/', (_req, res) => res.redirect('/index.html'));
  if (existsSync(WEB_DIR)) {
    // R3：入口页按文件内容指纹重写资源 URL（?h=），弱网下资源命中本地缓存，不再逐个重验证。
    app.get('/index.html', serveIndexPage);
    // R0：静态资源 gzip（express.static 默认不压缩；公网首屏 292K JS + 84K CSS 无 gzip 约省 1~2s）。
    // 零依赖：node:zlib 按 文件路径+mtime 压缩一次并缓存；只处理可压缩类型；带 Vary/ETag/Cache-Control。
    app.use(staticGzip());
    // 仅 ?h= 指纹资源长缓存；手工 ?v= 不能保证脚本/样式内容不变，保持每次重验证。
    app.use(express.static(WEB_DIR, {
      extensions: ['html'],
      setHeaders: (res, path) => {
        res.setHeader('Cache-Control', staticCacheControl(path, (res.req as express.Request | undefined)?.query?.h !== undefined));
      },
    }));
  }

  return app;
}
