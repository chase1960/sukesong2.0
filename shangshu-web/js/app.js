/* ==========================================================================
   尚书 · 工作台前端内核
   会话/角色 → 侧栏注册 → 模块分发。模块文件通过 RENDER[id] 注册渲染函数，
   内核不随功能增长（与后端 registry / registerTable 同一哲学）。
   UI/动效严格沿用 frontend-template/shangshu-os（workbench.css）。
   ========================================================================== */

/* ============ 基础工具 ============ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ic = (p, s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  /* —— template erp 图标库（描边 · currentColor）—— */
  user: ic('<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c1.3-3.5 3.9-5 6.5-5s5.2 1.5 6.5 5"/>'),
  tag: ic('<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="9" cy="9" r="1.5"/>'),
  truck: ic('<path d="M2.5 6h11v9.5h-11z"/><path d="M13.5 9.5h4.5l3 3v3h-7.5z"/><circle cx="6.5" cy="17.8" r="1.7"/><circle cx="17" cy="17.8" r="1.7"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  money: ic('<circle cx="12" cy="12" r="9"/><path d="M8.6 7.4L12 11.4l3.4-4M12 11.4V17M9.2 13.6h5.6M9.2 16h5.6"/>'),
  box: ic('<path d="M12 2.8l8.5 4.2v10L12 21.2 3.5 17V7z"/><path d="M3.5 7L12 11.2 20.5 7M12 11.2v10"/>'),
  cart: ic('<path d="M3 4.5h2.2L7.6 15h9.6l2.3-7H6.2"/><circle cx="9.5" cy="19.3" r="1.5"/><circle cx="16.5" cy="19.3" r="1.5"/>'),
  receipt: ic('<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 12h6"/>'),
  exchange: ic('<path d="M7 4v11.5M4 12.5l3 3 3-3M17 20V8.5M14 11.5l3-3 3 3"/>'),
  doc: ic('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12.5h6M9 16.5h6"/>'),
  folder: ic('<path d="M3 6.5h6.5l2 2.5H21V19H3z"/>'),
  bolt: ic('<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>'),
  robot: ic('<rect x="5" y="8.5" width="14" height="10" rx="1.5"/><path d="M12 8.5V4.5M9 21h6"/><circle cx="9.5" cy="13.5" r="1.1"/><circle cx="14.5" cy="13.5" r="1.1"/>'),
  cal: ic('<rect x="3" y="4.5" width="18" height="16" rx="1.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M7 14h3M14 14h3M7 17.5h3"/>'),
  image: ic('<rect x="3" y="3.5" width="18" height="17" rx="1.5"/><circle cx="8.5" cy="9" r="2.2"/><path d="M21 16l-5-5-4 4-3-3-6 6"/>'),
  globe: ic('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18M12 3a17 17 0 0 0 0 18"/>'),
  chart: ic('<path d="M4 20V10l4-3 4 5 4-7 4 4v11z"/><path d="M4 20h16"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  refresh: ic('<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>'),
  bell: ic('<path d="M10 17a2 2 0 0 0 4 0M14.5 4.5a5 5 0 0 0-5 0C6.9 6 5.5 9 5.5 12v3l-1.5 1.5h16L18.5 15v-3c0-3-1.4-6-4-7.5z"/>'),
  wand: ic('<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12 8l-1-6M12 8l1-6M4 20l4.6-4.6M4 20l-2-2"/>'),
  chat: ic('<path d="M4 4.5h16V15H9.5L4 19.5z"/><path d="M8 8.5h8M8 12h5"/>'),
  users: ic('<circle cx="8" cy="7" r="3"/><path d="M2 19c1.3-3 3.8-4.5 6-4.5s4.7 1.5 6 4.5"/><circle cx="17" cy="7.5" r="2.5"/><path d="M19 19c1-2 2.5-3.2 4-3.5"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  /* —— 真实功能页补充 —— */
  home: ic('<path d="M3.5 10.5L12 3.5l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-6h5v6"/>'),
  apps: ic('<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><circle cx="17" cy="17" r="3.5"/>'),
  inbox: ic('<path d="M4 5h16v14H4z"/><path d="M4 14h4l2 3h4l2-3h4"/><path d="M9 9.5l2 2 4-4"/>'),
  tasklist: ic('<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 8l1.5 1.5L13 7M9 13l1.5 1.5L13 12M14.5 8.5H16M14.5 13.5H16"/>'),
  grid: ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  back: ic('<path d="M15 18l-6-6 6-6"/>'),
  check: ic('<path d="M5 12l5 5L20 6"/>'),
  template: ic('<rect x="3" y="3" width="18" height="20" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/>'),
  gantt: ic('<path d="M3 5h8M7 10h10M5 15h12M9 20h8"/><path d="M3 3v18"/>'),
  book: ic('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
  spark: ic('<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/><path d="M19 15l.9 2.6L22.5 18.5l-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z"/>'),
  flow: ic('<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.5 6h9M6 8.2l4.5 7.3M18 8.2l-4.5 7.3"/>'),
  /* —— mock 占位标记（侧栏名字右边的小扳手） —— */
  wrench: ic('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>'),
  /* —— 侧栏账号菜单 —— */
  caret: ic('<path d="M6 15l6-6 6 6"/>', 12),
  grip: ic('<path d="M9 6h1.5M9 10h1.5M9 14h1.5M13.5 6H15M13.5 10H15M13.5 14H15"/>', 12),
  logout: ic('<path d="M15 4.5H19a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-4"/><path d="M10 8l-4 4 4 4M6 12h9"/>'),
  /* —— 建设中工作面 —— */
  mail: ic('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.8 7.6 8.2 5.6 8.2-5.6"/>'),
  sheet: ic('<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 9.5h17M9.5 9.5v11M15.5 9.5v11"/>'),
};
const money = (n) => '¥ ' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = (s) => s ? s.replace('T', ' ').slice(0, 16) : '—';
const day = (s) => s ? s.slice(0, 10) : '—';
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeHtml(s) { return esc(s); }
const fmt = (n) => '¥ ' + n.toLocaleString('zh-CN');

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401) { location.href = 'login.html'; throw new Error('未登录'); }
  // 403 + 会话不是当前页面账号 = 同浏览器开了两个账号标签页互相顶号（cookie 按域名共享）
  if (r.status === 403) {
    const j = await r.json().catch(() => ({}));
    const err = String(j?.error || '');
    if (/需要|无权限/.test(err)) {
      const me = currentUserInfo?.username || '';
      if (me && me !== 'admin') {
        toast('会话已切换', '这个浏览器里另一个标签页登录了别的账号（cookie 互相顶掉）。演示请用两个浏览器：一个登财务、一个登老板。');
      }
    }
    throw new Error(err || `HTTP ${r.status}`);
  }
  return r;
}
const apiJSON = (p, o) => api(p, o).then(r => r.json());

// —— 确认口统一收口（PKG-014-T05）——
// 新通用审核口（B 06f2fe4c）：不按表筛、不背删除债。
// 旧口 /api/confirmations 复用同一 handler 过渡期不断，最后一批删。
const CONFIRM_LIST_URL = 'api/platform/action-proposals';
const CONFIRM_RESOLVE_URL = 'api/platform/action-proposals/';
async function fetchPendingConfirmations() {
  // 纯 Node 模式没有 Frappe 的 action-proposals 路由（会 404）：走 Node 自带的 /api/confirmations。
  const node = !(typeof isPlatformManaged === 'function' && isPlatformManaged());
  return apiJSON(node ? 'api/confirmations' : CONFIRM_LIST_URL);
}
async function resolveConfirmation(id, decision) {
  const node = !(typeof isPlatformManaged === 'function' && isPlatformManaged());
  const path = node ? 'api/confirmations/' : CONFIRM_RESOLVE_URL;
  return api(path + id, { method: 'POST', body: JSON.stringify({ decision }) }).then(r => r.json());
}

async function logout() { await fetch('api/logout', { method: 'POST', credentials: 'include' }); location.href = 'login.html'; }

/* toast 已抽成独立公共件 js/toast.js（window.toast）。
   用户 2026-10-12：「notice 是有一个独立的公共组件的」—— 全局只许有一份实现，
   这里不再自带一份。下面的 toast(...) 调用走 window.toast。 */
// 全局 JS 错误兜底：布局引擎告警不打扰用户；真实异常带来源便于反馈。
window.addEventListener('error', (e) => {
  const msg = e.message || '未知错误';
  if (/ResizeObserver loop/i.test(msg)) {
    console.debug('[layout]', msg);
    return;
  }
  const file = String(e.filename || '').split('/').pop();
  const source = file ? ` · ${file}${e.lineno ? ':' + e.lineno : ''}` : '';
  try { toast('页面运行异常', (msg + source).slice(0, 160), 'error'); } catch { /* 忽略 */ }
  console.error('[page]', e.error || e.message);
});
let senseTimer = null;
function aiSense(detail) {
  clearTimeout(senseTimer);
  senseTimer = setTimeout(() => toast('AI 已感知你的修改', (detail || '内容') + ' · 已同步状态数据库'), 900);
}

/* ============ 会话与角色 ============ */
let currentUserInfo = null;                    // { username, role, display_name }
let currentPlatformInfo = null;                // Frappe 平台会话；legacy 模式为 null
const ROLE_LABEL = { admin: '管理员', finance: '会计', manager: '项目负责人', staff: '员工' };
// template mock 数据按 staff/prod/boss 三种演示角色组织；真实角色映射到演示角色取数
const DEMO_ROLE_MAP = { admin: 'boss', manager: 'prod', finance: 'staff', staff: 'staff' };
let DEMO_ROLE = 'staff';
let IS_BOSS = false;

/* ============ 侧栏（常驻 + 工作面；对话靠右侧/悬浮 AI，不进侧栏） ============ */
// 2026-08-20：小微内部运营切片——无客户/订单/进销存；侧栏不放「对话」。
const CORE_ITEMS = [];
// 默认产品面以“应用”为业务主入口；全局数据目录保留为兼容/高级入口，
// 流程中心只汇总跨应用事项。应用设计和应用管理仅管理员可见。
// 发票、记账等专用页继续作为迁移期兼容模块存在，但不再定义默认信息架构。
const ROLE_PRESET = {
  // 日常工作入口只导航，文件/邮件域仍可独立启停并执行原权限。
  // 「审核中心」是平台的一道**公共闸门**（审核中心归内核，域只挂声明）——
  // 四个岗位都要能用，所以四份预设都列它。**漏列 ⇒ 默认侧栏里就没有它 ⇒ 用户点不到**
  // （2026-10-22 站上实测：按地址能打开、页也对，侧栏里却找不到那一项）。
  admin: ['dash', 'im', 'flowdesign', 'applications', 'file-center', 'mail', 'review-center'],
  finance: ['dash', 'im', 'flowdesign', 'applications', 'file-center', 'mail', 'review-center'],
  manager: ['dash', 'im', 'flowdesign', 'applications', 'file-center', 'mail', 'review-center'],
  staff: ['dash', 'im', 'flowdesign', 'applications', 'file-center', 'mail', 'review-center'],
};
const GROUPS = [
  { sec: '工作', items: [
    { id: 'dash', name: '工作台', ico: 'home' },
    { id: 'im', name: '消息', ico: 'chat', bdg: 'im' },
    { id: 'flowdesign', name: '待办', ico: 'inbox', autoPin: true, bdg: 'work' },
    { id: 'mail', name: '邮箱', ico: 'mail', autoPin: true },
    { id: 'file-center', name: '文件中心', ico: 'folder', autoPin: true },
    { id: 'review-center', name: '审核中心', ico: 'check' },
    { id: 'task-mgmt', name: '协作任务', ico: 'tasklist', sidebarHidden: true },
  ]},
  { sec: '业务', items: [
    { id: 'applications', name: '应用', ico: 'apps', autoPin: true },
    { id: 'application', name: '应用首页', ico: 'grid', sidebarHidden: true },
    { id: 'objects', name: '数据', ico: 'grid', sidebarHidden: true },
  ]},
  { sec: '兼容业务', items: [
    { id: 'review', name: '发票审核', ico: 'receipt', bdg: 'review', roles: ['finance'], sidebarHidden: true },
    { id: 'accounting', name: '记账', ico: 'book', roles: ['finance'], sidebarHidden: true },
    { id: 'payables', name: '应收应付', ico: 'exchange', roles: ['finance', 'manager'], sidebarHidden: true },
  ]},
  { sec: '沟通', items: [
    { id: 'im-ref', name: '消息参考', ico: 'chat' },
  ]},
  { sec: '日程', items: [
    { id: 'calendar', name: '日历', ico: 'cal' },
  ]},
  { sec: '销售', items: [
    { id: 'customers', name: '客户', ico: 'user' },
    { id: 'orders', name: '报价与订单', ico: 'tag' },
    { id: 'delivery', name: '发货与回款', ico: 'truck' },
  ]},
  { sec: '供应链', items: [
    { id: 'production', name: '生产工单', ico: 'gear', roles: ['manager'] },
    { id: 'inventory', name: '库存', ico: 'box', roles: ['manager'] },
    { id: 'purchase', name: '采购', ico: 'cart', roles: ['manager'] },
  ]},
  { sec: '财务', items: [
    { id: 'expense', name: '发票报销', ico: 'money' },
  ]},
  { sec: '工作', items: [
    { id: 'projects', name: '项目管理', ico: 'chart', roles: ['manager', 'finance'] },
    { id: 'topics', name: '话题集', ico: 'chat' },
    { id: 'sop', name: 'SOP 协作', ico: 'flow', roles: ['manager'] },
    { id: 'kanban', name: '看板', ico: 'chart', roles: ['admin', 'manager'] },
    { id: 'chat', name: '对话（全屏）', ico: 'spark', sidebarHidden: true },
  ]},
  { sec: '文件', items: [
    { id: 'docs', name: '文档', ico: 'doc' },
    { id: 'files', name: '文件库', ico: 'folder' },
  ]},
  { sec: '管理', items: [
    { id: 'app-design', name: '应用设计', ico: 'wand', roles: ['admin'], sidebarHidden: true },
    { id: 'apps', name: '应用管理', ico: 'grid', roles: ['admin'], sidebarHidden: true },
    { id: 'skills', name: 'Skill 管理', ico: 'bolt', roles: ['manager'] },
    { id: 'agents', name: '数字员工', ico: 'robot', bdg: 'agents', roles: ['manager'] },
  ]},
  { sec: '工具', items: [
    { id: 'tools-logo', name: 'Logo 简化器', ico: 'wand', roles: ['manager'] },
    { id: 'tools-crawl', name: '行业情报', ico: 'globe' },
    { id: 'tools-site', name: '独立站管理', ico: 'chart' },
    { id: 'tools-img', name: '商品图生成', ico: 'image' },
  ]},
  { sec: '自动化', items: [
    { id: 'tasks', name: '定时任务', ico: 'clock', roles: ['manager'] },
  ]},
  { sec: '能力', items: [
    { id: 'skill-sync', name: 'Skill 同步', ico: 'refresh', roles: ['manager'] },
    { id: 'doc-templates', name: '模板管理', ico: 'template' },
    { id: 'doc-gen', name: '文档生成', ico: 'doc' },
  ]},
  { sec: '定制 · 官网', items: [
    { id: 'appr', name: '待审批', ico: 'check', bdg: 'appr', roles: ['manager'] },
    { id: 'website', name: '官网后台', ico: 'globe', roles: ['manager'] },
  ]},
  { sec: '工具', items: [
    { id: 'sheets', name: '表格', ico: 'sheet', sidebarHidden: true },
  ]},
  { sec: '系统', items: [
    { id: 'personal-settings', name: '个人设置', ico: 'user', sidebarHidden: true, accountMenu: true },
    { id: 'accounts', name: '账号管理', ico: 'users', roles: ['admin'], sidebarHidden: true },
    { id: 'users', name: '用户管理', ico: 'users', roles: ['admin'], sidebarHidden: true },
    { id: 'modules', name: '模块管理', ico: 'grid', roles: ['admin'], sidebarHidden: true },
    { id: 'ai-tools', name: 'AI 工具', ico: 'spark', roles: ['admin'], sidebarHidden: true },
    { id: 'config', name: '系统配置', ico: 'gear', roles: ['admin'], sidebarHidden: true },
  ]},
];
/* —— 前端领域注册点（2026-09-24）：业务域侧栏入口动态注册，新域不改本文件 ——
   域 JS 经 js/domains/<域>/domain-entry.json 自动加载后调用：
     shangshuRegisterNav([{ id: 'my-page', name: '我的页面', ico: 'grid', sec: '业务', roles: ['staff'] }])
   注册即入侧栏（domainEntry 项默认可见，用户仍可用模块管理隐藏）；
   重复 ID 拒绝，两个域不抢同一入口。 */
window.shangshuRegisterNav = (items) => {
  if (!Array.isArray(items)) return { ok: false, reason: '导航项必须是数组' };
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
    const sec = typeof item.sec === 'string' && item.sec ? item.sec : '业务';
    // 路由 ID 全局唯一：任何分区已有同 ID 都拒绝（go(id) 不区分分区）。
    if (GROUPS.some(g => g.items.some(m => m.id === item.id))) return { ok: false, reason: '导航 ID 已存在：' + item.id };
    let group = GROUPS.find(g => g.sec === sec);
    if (!group) { group = { sec, items: [] }; GROUPS.push(group); }
    group.items.push({
      id: item.id, name: item.name, ico: item.ico || 'grid', domainEntry: true,
      ...(item.roles ? { roles: item.roles } : {}),
      ...(item.sidebarHidden ? { sidebarHidden: true } : {}),
      ...(item.accountMenu === true ? { accountMenu: true } : {}),
    });
  }
  if (typeof renderChrome === 'function') renderChrome();
  return { ok: true };
};

/* ============ 「这张表归哪一页管」——**域登记，壳照办** ============
 *
 * **为什么要有这个登记口**（用户 2026-10-25 原话）：
 *   「点击的时候侧栏不要跳回表格（他就是一个独立的页面）」。
 *   业务表切进 Excel 工作面时，**页 id 写死成实现页 `excel`** ⇒ 被点的那一项
 *   的身份被丢掉 ⇒ 公共壳按实现页认 ⇒ 侧栏亮的是「表格」那一项
 *   ⇒ 人点示例企业总表，却被扔回「表格」。
 * ⇒ **页 id 由登记的那一页说了算**（某个域把它的案件表登记在 `ip.<域>.cases`）。
 *
 * **壳不替域猜业务判断**：哪张表归哪一页，是**域的业务决定**；
 * 域登记（表 id → 页 id），壳只照办（跳那一页、保住它的身份）。
 *
 * ⚠️ **登记的是「表身份」不是「文件」**：同一张表在文件中心有投影、在域里有绑定，
 *   键用的是**同一个表 id**（受管对象 id / 文件 id 就是它自己）。
 */
const tablePageOwners = new Map();
window.shangshuRegisterTablePage = (tableId, pageId, meta) => {
  const table = String(tableId || '').trim();
  const page = String(pageId || '').trim();
  if (!table || !page) return { ok: false, reason: '登记要写清表 id 和页 id' };
  const previous = tablePageOwners.get(table);
  if (previous && previous.pageId !== page) {
    return { ok: false, reason: '这张表已经登记给另一页：' + previous.pageId };
  }
  tablePageOwners.set(table, {
    pageId: page,
    standalone: meta && meta.standalone === true,
  });
  return { ok: true };
};
/** 这张表归哪一页管（没登记 ⇒ 空字符串 ⇒ 用实现页）。 */
window.shangshuTablePage = (tableId) => {
  const hit = tablePageOwners.get(String(tableId || '').trim());
  return hit ? { ...hit } : null;
};

/* ============ 「平台的清单」——**一次读取、同一轮共用** ============
 *
 * **为什么要有这个口**（用户 2026-10-25 问：「为什么总是会把业务域重新加载一遍」）：
 *   域的**代码**并没有每次重装（域脚本整页加载时执行一次；后端域只在 migrate 时
 *   import 一次）—— 重的是域的**清单**：
 *   受管对象清单（`/api/platform/objects`）、动作清单（`/api/platform/actions`）、
 *   应用清单（`/api/platform/applications`）。
 *   实测开一张业务表（浏览器网络面板）：objects 拉 **2 遍**（域入口 ＋ 表格部件）、
 *   actions 拉 **3 遍**（excel 域每次挂载都问服务端「这个动作我能不能用」）、
 *   applications 拉 **2 遍** ⇒ 人看着像「业务域又装了一遍」。
 *
 * **规矩**：**同一轮里同一个清单只发一次请求**，大家共用那一份。
 *   · **在途的请求共用同一个 promise**（并发调用不排队）；
 *   · 读到的结果**短时间内复用**（同一轮内换表/换页都拿同一份）；
 *   · **失败不留坏缓存**（失败就清掉，下一次重新读）；
 *   · **权限/发布状态变了要能作废**（`invalidate`／`invalidateAll`）。
 *
 * ⚠️ **不能永久缓存**：动作能不能用会随角色权限、发布状态变 ⇒ 给 TTL ＋ 显式作废。
 */
window.shangshuPlatformCatalog = (() => {
  /* 清单只有这三个口（域的受管对象／域的动作／域的应用）。 */
  const PATHS = {
    actions: '/api/platform/actions',
    objects: '/api/platform/objects',
    applications: '/api/platform/applications?summary=1',
  };
  /* 同一份清单在**多久之内**算同一份（**按清单分别定**）。
     ⚠️ **应用清单是 0**：域装上／发布后**要马上看到**（判据
       `check-app-list-request-dedup.test.mjs` 明写「去重只限在途，不是不缓存」）
       ⇒ 它只做**在途共用**，不做复用。
     ⚠️ **受管对象／动作清单重**（开一张表要读好几遍）⇒ 给 30 秒复用。 */
  const TTL_MS = { actions: 30000, objects: 30000, applications: 0 };
  const cache = new Map();
  let catalogIdentity;

  function read(key) {
    const identity=typeof currentUserInfo==='undefined'?'':JSON.stringify(currentUserInfo);
    if(identity!==catalogIdentity){
      /* ⚠️ **身份从「还没有」变成「是谁」**（页面刚开，登录信息后到）⇒
         **那不是换人，是同一轮** ⇒ **不许把在途的那一次作废**。
         病根（站上实测 2026-10-28）：域脚本在登录信息到达前就重画了侧栏 ⇒
         清单口先被叫了一次（这时还不知道是谁）；登录信息一到，身份变了 ⇒
         老规矩「身份变了就清缓存」把**在途的那一次**丢了 ⇒ 同一轮里发了两次
         （应用清单每次 252KB，服务端排队 ⇒ 第三遍到 2.4 秒才回来）。
         ⇒ 只有「**已经是谁 → 换成另一个人**」才作废。 */
      const knownBefore=catalogIdentity!==undefined&&catalogIdentity!==''&&catalogIdentity!=='null';
      const knownNow=identity!==''&&identity!=='null';
      if(knownBefore&&knownNow)cache.clear();
      catalogIdentity=identity;
    }
    const hit = cache.get(key);
    const ttl = TTL_MS[key] === undefined ? 0 : TTL_MS[key];
    /* 在途 ⇒ 共用那一次；已读完且还在复用期内 ⇒ 共用那一份。 */
    if (hit && (!hit.settled || Date.now() - hit.at < ttl)) return hit.promise;
    const entry = { promise: null, at: Date.now(), settled: false };
    entry.promise = fetch(PATHS[key], { credentials: 'include' })
      .then(response => response.json().then(data => ({ ok: response.ok, data })))
      .then(result => {
        if (!result.ok || result.data?.ok === false) {
          throw new Error((result.data && result.data.error) || ('读不到清单：' + key));
        }
        return result.data;
      })
      .then(data => { entry.settled = true; return data; })
      .catch(error => { if(cache.get(key)===entry)cache.delete(key); throw error; });
    cache.set(key, entry);
    return entry.promise;
  }

  return {
    actions: () => read('actions'),
    objects: () => read('objects'),
    applications: () => read('applications'),
    /** 某个清单变了（新建/退役/发布/权限变）⇒ 叫它作废，下一次重新读。 */
    invalidate: (key) => { cache.delete(key); if(key==='applications')window.shangshuInvalidateApplicationNavigation?.(); },
    invalidateAll: () => { cache.clear();window.shangshuInvalidateApplicationNavigation?.(); },
  };
})();

/**
 * **这张受管表属于哪个应用**（受管对象 ⇒ 有；别的表 ⇒ 没有）。
 *
 * 受管对象的 id 是**内核**定的：`<应用 id>.object.<哈希>`
 * （见 `frappe_apps/shangshu_core/shangshu_core/model_changes.py` 的
 * `target_object_id = application_id + ".object." + key[:32]`）⇒ 应用 id 就是第一段。
 *
 * @param {string} tableId 表 id
 * @returns {string} 应用 id（没有就空字符串）
 */
function managedTableAppId(tableId) {
  const id = String(tableId || '').trim();
  const marker = id.indexOf('.object.');
  return marker > 0 ? id.slice(0, marker) : '';
}

/**
 * **这张受管表归侧栏哪一项管**（侧栏上**此刻**有没有那一项）。
 *
 * **为什么问这个**（用户 2026-10-25 原话：「还是邮件模版时侧边栏高亮的还是表格！」）：
 *   从「全部数据」那张表列表里点开一张业务表时，侧栏**一项都没亮着**
 *   ⇒ 「开表」那一跳不知道该亮谁 ⇒ 退回亮实现页「表格」
 *   ⇒ 人点某个域的「邮件模板」却被侧栏说成「表格」。
 *
 * ⚠️ **应用项是异步到的**（应用清单晚于页面到达）⇒ 开表那一刻侧栏上
 *   **可能还没有那一项** ⇒ 这里问不到是正常的；那一项到了以后由
 *   `shangshuSyncTableNavHighlight()` 补亮。
 *
 * @param {string} tableId 受管对象 id
 * @returns {string|null} 侧栏那一项的 `data-mod`（空 ⇒ 此刻侧栏上没有）
 */
function managedTableNavMod(tableId) {
  const appId = managedTableAppId(tableId);
  if (!appId) return null;
  const appMod = 'application:' + appId;
  try {
    return document.querySelector('#side .side-item[data-mod="' + appMod + '"]') ? appMod : null;
  } catch (error) {
    return null;
  }
}

/**
 * **把侧栏该亮的那一项亮起来**（**应用项晚到时补亮**）。
 *
 * ⚠️ **为什么要有这一步**：应用清单是**异步到达**的 ⇒ 开表那一刻侧栏上
 *   **可能还没有**那个应用的入口 ⇒ 那时只能先亮实现页「表格」；
 *   等那一项到了 ⇒ 立刻换成它（用户要的是「邮件模板就亮邮件模板」）。
 *
 * @returns {boolean} 有没有换成那一项
 */
window.shangshuSyncTableNavHighlight = () => {
  /* 不在表格工作面上 ⇒ 没有「现在开着哪张表」这回事。 */
  if (typeof curMod === 'undefined' || curMod !== 'excel') return false;
  const table = new URLSearchParams(location.search).get('object') || '';
  const appId = managedTableAppId(table);
  if (!appId) return false;
  const appMod = 'application:' + appId;
  /* 那个应用**没有在侧栏露出来** ⇒ 不亮（照旧亮实现页）。 */
  if (!document.querySelector('#side .side-item[data-mod="' + appMod + '"]')) return false;
  if (typeof selectApplicationNavigation === 'function') selectApplicationNavigation(appId);
  return true;
};

/**
 * **在 Excel 工作面里打开一张表**（业务表 → Excel 交互的统一入口）。
 *
 * **为什么不许整页跳转**（用户 2026-10-25 两条实测）：
 *  · 整页跳转 ⇒ **全站重载** ⇒ 侧栏重画；而侧栏条目来自**异步到达**的域/应用清单
 *    ⇒ 重载后先按手上有的画一遍（**少好多个选项**）⇒ 清单到齐再补
 *    ⇒ 「点击示例企业总表的时候会出现短暂的侧栏应用重载」（用户原话）。
 *  · 整页跳转 ⇒ 地址里的 **页 id 写死成实现页** ⇒ 被点那一项的身份被丢掉
 *    ⇒ 侧栏亮的是「表格」⇒ 「示例企业总表应该是单独的页面，不应该又回到表格」。
 *
 * ⇒ 改成**同页换页**（`go()`）：侧栏不重画（清单还在手上）、页 id 是被点那项自己的。
 *
 * @param {string} tableId   要打开的表（受管对象 id / 文件 id）
 * @param {object} options
 *   · pageId     这一项自己的页 id（没给 ⇒ 问登记口 ⇒ 再退回实现页 `excel`）
 *   · recordName 定位到某一条记录（可选）
 *   · standalone 独立页（不给「返回列表」）
 *   · source     已知来源 db / xlsx（不按表号猜测）
 */
/**
 * **壳把「当前页」露给域**（2026-10-30 用户 11:2x 拍板：「真要省，得让壳把『当前页』露给域」）。
 *
 * **为什么需要**：开机那一趟，壳**先把邮件页挂上**再换到目标页 ⇒ 域的 `MutationObserver`
 * 看见「邮件页 DOM 出现了」⇒ 域以为自己在邮件页 ⇒ 把邮件审核队列那份清单拉了
 * ⇒ 表格页**根本用不着它** ⇒ 白花开销。
 * ⚠️ 域自己**判不出**（它只看见 DOM，看不见壳换到了哪一页）⇒ 得壳告诉它。
 *
 * **给域什么**（两样都给，别让域自己猜）：
 * · `page` ＝ **被请求的**页 id（别名页就是它自己，如 `ip.<域>.cases`）⇒ 域认得自己那一页；
 * · `impl` ＝ **实现页**（`ip.<域>.cases` ⇒ `excel`）⇒ 域挂在实现页上的东西也对得上；
 * · `hash` ＝ 地址栏里那一段（`#/<页 id>`）⇒ 域原来自己读的那个值，现在由壳给。
 *
 * ⚠️ **还没进任何页时**（`curMod` 与 `curPageId` 都空）⇒ 返回 `null`
 *   —— 「判不出」就明说判不出，**不许猜一个页**（域那边据此照旧拉，宁可多拉一次）。
 * ⚠️ **开机那一趟**（`go()` 还没跑、但 `curPageId` 已记上「要去哪一页」）
 *   ⇒ **给得出值**（`impl` 那时还是空）⇒ 域判得出「这不是我要的那一页」⇒ 不白拉。
 */
window.shangshuCurrentPage = () => {
  if (!curMod && !curPageId) return null;
  return {
    page: curPageId || curMod || null,
    impl: curMod || null,
    hash: (location.hash || '').replace(/^#\//, '') || null,
  };
};

window.shangshuOpenTable = (tableId, options = {}) => {
  const table = String(tableId || '').trim();
  if (!table) return { ok: false, reason: '没给表 id' };
  const owner = window.shangshuTablePage(table);
  /* 页 id：**被点那一项自己的** ⇒ 侧栏亮它自己，不亮「表格」。
     登记口没有 ⇒ 用调用方给的 ⇒ 都没有 ⇒ 退回实现页（普通业务表没有自己的页）。
     ⚠️ **认不出的页 id 一律退回实现页**（用户 2026-10-25 探针）：
     `go()` 拿到认不出的 id ⇒ 它退回 `go('dash')` ⇒ 人点业务表却掉回工作台
     ⇒ 这里先验一道（页面注册表认得的才是页）。 */
  const requested = String(options.pageId || (owner && owner.pageId) || 'excel').trim();
  const pageId = resolvePage(requested) ? requested : 'excel';
  const standalone = options.standalone === true || !!(owner && owner.standalone === true);
  const url = new URL(location.href);
  url.searchParams.delete('dataset');
  url.searchParams.delete('application');
  if (options.source === 'db' || options.source === 'xlsx') url.searchParams.set('table_source', options.source);
  else if (url.searchParams.get('object') !== table) url.searchParams.delete('table_source');
  url.searchParams.set('object', table);
  if (options.recordName) url.searchParams.set('record', String(options.recordName));
  else url.searchParams.delete('record');
  if (standalone) url.searchParams.set('standalone', '1');
  else url.searchParams.delete('standalone');
  url.hash = '#/' + pageId;
  /* ⚠️ **先写地址再换页**：Excel 页的 boot() 读的是地址里的 `object` 参数
     ⇒ 换页前写好，它一挂载就能开这张表（原来靠整页跳转天然带上，现在要自己写）。 */
  history.replaceState(null, '', url.toString());
  openingTable = true;
  /* ⚠️ **这张表归侧栏哪一项管**（用户 2026-10-25 原话：「还是邮件模版时侧边栏高亮的还是表格！」）：
     从「全部数据」那张表列表里点开业务表时，侧栏**一项都没亮着**
     ⇒ 「开表」这一跳不知道该亮谁 ⇒ 退回亮实现页「表格」。
     ⇒ 这里先问出来（问不到就空 ⇒ 照旧亮实现页）。 */
  openingTableNavMod = managedTableNavMod(table);
  try {
    go(pageId);
  } finally {
    openingTable = false;
    openingTableNavMod = null;
  }
  return { ok: true, pageId };
};
let curMod = null;
/* 「当前这一页是**被请求的**哪个页 id」（别名页亮自己那一项时就是它自己）。
   ⚠️ 与 `curMod`（解析后的**实现页**）不是一回事：
   · `curMod` ＝ 实现页（别名页 `ip.<域>.cases` ⇒ `excel`）；
   · `curPageId` ＝ 地址栏里那个（`ip.<域>.cases`）⇒ **域认得自己那一页**。
   ⇒ 壳把「当前页」露给域时**两个都给**（见 `window.shangshuCurrentPage`）。 */
let curPageId = null;
let lastBusinessMod = 'dash';
/* 「这一跳是去开某张表」的标记（见 shangshuOpenTable）。
   用途：换页时**别把地址里的表号清掉** —— 清了 Excel 页就开不出这张表。
   ⚠️ 只在**这一跳**期间为真（同步设、同步清）。 */
let openingTable = false;
/* 「这一跳开的那张表归侧栏哪一项管」（见 shangshuOpenTable 的 `managedTableNavMod`）。
   ⚠️ 同样**只在这一跳期间**为真（同步设、同步清）。 */
let openingTableNavMod = null;
const RENDER = {};
const canSee = (m) => !m.roles || (currentUserInfo && (currentUserInfo.role === 'admin' || m.roles.includes(currentUserInfo.role)));
const isPlatformManaged = () => currentPlatformInfo?.mode === 'frappe';
function resolvePage(id) {
  if (!isPlatformManaged()) return RENDER[id] ? id : null;
  return typeof shangshuResolvePlatformPage === 'function'
    ? shangshuResolvePlatformPage(id, currentUserInfo?.role || 'staff')
    : null;
}
function pageAvailable(id) {
  // 退役别名只用于把旧收藏/直链安全降级到新页面，绝不能因此重新进入
  // 侧栏、模块库或工作区；正式可配置入口必须以请求页本身的声明为准。
  if (isPlatformManaged()) {
    const requested = pageMeta(id);
    if (!requested?.platform || !['implemented', 'compatibility'].includes(requested.status)) return false;
  }
  const resolved = resolvePage(id);
  return !!(resolved && RENDER[resolved]);
}
function pageMeta(id) {
  return typeof shangshuPageDefinition === 'function' ? shangshuPageDefinition(id) : null;
}
let sidebarFavorites = [];
let flowShortcuts = [];
function sidebarKey(name) {
  return `shangshu.sidebar.${currentUserInfo?.username || 'guest'}.${name}`;
}
function loadSidebarPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(sidebarKey('favorites')) || '[]');
    sidebarFavorites = Array.isArray(saved) ? saved.filter(x => typeof x === 'string') : [];
  } catch { sidebarFavorites = []; }
  try {
    const sc = JSON.parse(localStorage.getItem(sidebarKey('flow-shortcuts')) || '[]');
    flowShortcuts = Array.isArray(sc) ? sc.filter(x => x && x.key && x.page) : [];
  } catch { flowShortcuts = []; }
}
function flowShortcutId(flowId, stepId) { return `${flowId}:${stepId}`; }
function isFlowShortcut(flowId, stepId) {
  return flowShortcuts.some(s => s.key === flowShortcutId(flowId, stepId));
}
function registerFlowShortcut(entry) {
  const key = flowShortcutId(entry.flowId, entry.stepId);
  if (!entry.page || !pageAvailable(entry.page)) {
    toast('无法添加入口', '该步骤没有可跳转的业务页');
    return false;
  }
  if (flowShortcuts.some(s => s.key === key)) {
    toast('已在快速入口', entry.label);
    return true;
  }
  flowShortcuts = [...flowShortcuts, { ...entry, key }];
  localStorage.setItem(sidebarKey('flow-shortcuts'), JSON.stringify(flowShortcuts));
  const scrollTop = sideScrollEl()?.scrollTop || 0;
  renderChrome();
  sideScrollEl().scrollTop = scrollTop;
  toast('已加入快速入口', `${entry.flowName} · ${entry.label}`);
  if (typeof refreshFlowDetailPanel === 'function') refreshFlowDetailPanel();
  return true;
}
function removeFlowShortcut(key) {
  flowShortcuts = flowShortcuts.filter(s => s.key !== key);
  localStorage.setItem(sidebarKey('flow-shortcuts'), JSON.stringify(flowShortcuts));
  const scrollTop = sideScrollEl()?.scrollTop || 0;
  renderChrome();
  sideScrollEl().scrollTop = scrollTop;
  if (typeof refreshFlowDetailPanel === 'function') refreshFlowDetailPanel();
}
function goFlowShortcut(key) {
  const s = flowShortcuts.find(x => x.key === key);
  if (!s?.page || !pageAvailable(s.page)) return;
  go(s.page);
}
function sideScrollEl() { return $('#side-scroll') || $('#side'); }

function flowShortcutItemHtml(s, i) {
  const active = s.page === curMod;
  return `<div class="side-item workspace-item flow-shortcut-item ${active ? 'on' : ''}" data-flow-shortcut="${esc(s.key)}"
    onclick="goFlowShortcut('${esc(s.key)}')" style="animation-delay:${i * .035}s">
    <span class="flow-shortcut-dot" style="--lane:${esc(s.color || '#64748B')}"></span>
    <span class="side-label"><span class="flow-shortcut-name">${esc(s.label)}</span><em class="flow-shortcut-sub">${esc(s.flowName)}</em></span>
    <button class="side-star on flow-shortcut-rm" title="移除快速入口" aria-label="移除"
      onclick="event.preventDefault();event.stopPropagation();removeFlowShortcut('${esc(s.key)}');toast('已移除','${esc(s.label)}')">×</button>
  </div>`;
}
function visibleGroups() {
  return GROUPS.map(g => ({
    ...g,
    items: g.items
      .filter(canSee)
      .filter(m => pageAvailable(m.id))
      .filter(m => !m.sidebarHidden),
  })).filter(g => g.items.length);
}
function findWorkspaceItem(id) {
  return GROUPS.flatMap(g => g.items).find(m => m.id === id);
}

function currentRole() { return currentUserInfo?.role || 'staff'; }

function adminHiddenModules() {
  try {
    const saved = JSON.parse(localStorage.getItem(sidebarKey('hidden-modules')) || '[]');
    return Array.isArray(saved) ? saved.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
function saveAdminHiddenModules(list) {
  localStorage.setItem(sidebarKey('hidden-modules'), JSON.stringify([...new Set(list)]));
}

/** 侧栏是否显示该模块：以用户自定义布局为准（localStorage sidebar-layout） */
function isSidebarModuleOn(m) {
  if (!pageAvailable(m.id)) return false;
  return sidebarLayoutGroups().some(g => g.items.includes(m.id));
}

function presetModuleIds() {
  const role = currentRole();
  return new Set(ROLE_PRESET[role] || ROLE_PRESET.staff || []);
}
function isSidebarModLocked(id) { return presetModuleIds().has(id); }

function defaultSidebarLayoutGroups() {
  const role = currentRole();
  const preset = ROLE_PRESET[role] || ROLE_PRESET.staff || [];
  const extra = extraModules();
  return GROUPS.map(g => ({
    sec: g.sec,
    items: g.items
      .filter(canSee)
      // 所有角色（含 admin）默认只显示预设；更多入口经模块管理写入 extra；
      // 域注册入口（domainEntry）注册即默认可见，用户可用模块管理隐藏。
      // 预设也不能绕过正式页面注册表，否则退役页面仍会被旧 localStorage 复活。
      .filter(m => pageAvailable(m.id) && (preset.includes(m.id) || extra.includes(m.id) || m.domainEntry))
      .map(m => m.id),
  })).filter(g => g.items.length);
}

function availableSidebarSections() {
  return GROUPS
    .filter(g => g.items.some(m => canSee(m) && pageAvailable(m.id)))
    .map(g => g.sec);
}

function sanitizeSidebarLayoutGroups(groups) {
  const allowed = new Set(GROUPS.flatMap(g => g.items).filter(m => canSee(m) && pageAvailable(m.id)).map(m => m.id));
  const locked = presetModuleIds();
  const seen = new Set();
  const out = [];
  (Array.isArray(groups) ? groups : []).forEach(g => {
    if (!g || typeof g.sec !== 'string') return;
    const items = (Array.isArray(g.items) ? g.items : [])
      .filter(id => typeof id === 'string' && allowed.has(id) && !seen.has(id));
    items.forEach(id => seen.add(id));
    out.push({ sec: g.sec, items });
  });
  // 岗位预设模块必须保留在布局中
  locked.forEach(id => {
    if (!allowed.has(id) || seen.has(id)) return;
    const origin = GROUPS.find(x => x.items.some(m => m.id === id));
    const sec = origin?.sec;
    if (!sec) return;
    let grp = out.find(x => x.sec === sec);
    if (!grp) { grp = { sec, items: [] }; out.push(grp); }
    grp.items.push(id);
    seen.add(id);
  });
  return out.filter(g => g.items.length || availableSidebarSections().includes(g.sec));
}

function loadSidebarLayoutRaw() {
  try {
    const raw = localStorage.getItem(sidebarKey('sidebar-layout'));
    if (!raw) return null;
    const data = JSON.parse(raw);
    // v2：内部运营切片后重置旧布局，避免还显示客户/订单等
    if (data?.v !== 4 || !Array.isArray(data.groups)) return null;
    const groups = sanitizeSidebarLayoutGroups(data.groups);
    // autoPin 模块（如流程设计）：老布局自动补钉到所属分组，只增不改其余顺序
    for (const m of GROUPS.flatMap(g => g.items).filter(x => x.autoPin)) {
      if (!canSee(m) || !pageAvailable(m.id)) continue;
      const homeSec = (GROUPS.find(g => g.items.some(i => i.id === m.id)) || {}).sec;
      const cur = groups.find(g => g.items.includes(m.id));
      if (cur && cur.sec === homeSec) continue;                    // 已在规范分区
      if (cur) cur.items = cur.items.filter(x => x !== m.id);      // 钉错分区的挪回规范分区
      let grp = groups.find(g => g.sec === homeSec);
      if (!grp) { grp = { sec: homeSec, items: [] }; groups.push(grp); }
      grp.items.push(m.id);
    }
    return groups;
  } catch { return null; }
}

function sidebarLayoutGroups() {
  return normalizePrimaryNavigation(loadSidebarLayoutRaw() || defaultSidebarLayoutGroups());
}

function normalizePrimaryNavigation(groups) {
  // 只归拢已有入口，不启用已停域，不清除收藏、宽度和扩展偏好。
  const primary = ['dash', 'im', 'flowdesign', 'mail', 'file-center', 'applications'];
  const enabled = new Set(groups.flatMap(g => g.items));
  const result = [
    {sec:'工作',items:primary.slice(0,5).filter(id=>enabled.has(id))},
    {sec:'业务',items:primary.slice(5).filter(id=>enabled.has(id))},
  ];
  for (const group of groups) {
    const items=group.items.filter(id=>!primary.includes(id)&&id!=='task-mgmt');
    if (!items.length) continue;
    const existing=result.find(g=>g.sec===group.sec);
    if (existing) existing.items.push(...items);
    else result.push({...group,items});
  }
  return result.filter(g=>g.items.length);
}

function syncLegacyModuleKeysFromLayout(groups) {
  const enabled = new Set(groups.flatMap(g => g.items));
  const role = currentRole();
  const preset = ROLE_PRESET[role] || ROLE_PRESET.staff || [];
  // admin 与普通角色同一套：预设外的算 extra；不再维护「隐藏全部模块」清单为主路径
  saveExtraModules([...enabled].filter(id => !preset.includes(id)));
  if (role === 'admin') {
    const all = GROUPS.flatMap(g => g.items).filter(m => pageAvailable(m.id)).map(m => m.id);
    saveAdminHiddenModules(all.filter(id => !enabled.has(id)));
  }
}

function saveSidebarLayoutGroups(groups, { silent = false } = {}) {
  const clean = sanitizeSidebarLayoutGroups(groups);
  localStorage.setItem(sidebarKey('sidebar-layout'), JSON.stringify({ v: 4, groups: clean }));
  syncLegacyModuleKeysFromLayout(clean);
  renderChrome();
  if (!silent && typeof renderSidebarEditor === 'function' && $('#sb-ed-root')) renderSidebarEditor();
}

function resetSidebarLayout({ silent = false } = {}) {
  localStorage.removeItem(sidebarKey('sidebar-layout'));
  syncLegacyModuleKeysFromLayout(defaultSidebarLayoutGroups());
  renderChrome();
  if (!silent && typeof renderSidebarEditor === 'function' && $('#sb-ed-root')) renderSidebarEditor();
  if (!silent) toast('已恢复', '侧栏布局已重置为岗位默认');
}

function sidebarEditorGroups() {
  const layoutMap = Object.fromEntries(sidebarLayoutGroups().map(g => [g.sec, g.items]));
  const secs = [...sidebarLayoutGroups().map(g => g.sec)];
  availableSidebarSections().forEach(sec => { if (!secs.includes(sec)) secs.push(sec); });
  return secs.map(sec => ({
    sec,
    items: (layoutMap[sec] || []).filter(id => findWorkspaceItem(id) && canSee(findWorkspaceItem(id)) && pageAvailable(id)),
  }));
}

function sidebarLibraryModules() {
  const inLayout = new Set(sidebarLayoutGroups().flatMap(g => g.items));
  return GROUPS.flatMap(g => g.items)
    .filter(m => canSee(m) && pageAvailable(m.id) && !inLayout.has(m.id));
}

function sidebarLayoutMoveMod(modId, toSec, toIndex) {
  if (!findWorkspaceItem(modId) || !pageAvailable(modId)) return;
  let groups = sidebarEditorGroups().map(g => ({ sec: g.sec, items: [...g.items] }));
  groups = groups.map(g => ({ ...g, items: g.items.filter(id => id !== modId) }));
  if (!groups.some(g => g.sec === toSec)) groups.push({ sec: toSec, items: [] });
  groups = groups.map(g => {
    if (g.sec !== toSec) return g;
    const items = [...g.items];
    const idx = Math.max(0, Math.min(toIndex, items.length));
    items.splice(idx, 0, modId);
    return { ...g, items };
  });
  saveSidebarLayoutGroups(groups);
}

function sidebarLayoutRemoveMod(modId) {
  if (isSidebarModLocked(modId)) { toast('岗位预设', '该模块为岗位默认，不可移除'); return; }
  const groups = sidebarEditorGroups().map(g => ({
    sec: g.sec,
    items: g.items.filter(id => id !== modId),
  }));
  saveSidebarLayoutGroups(groups);
  toast('已移出侧栏', findWorkspaceItem(modId)?.name || modId);
}

// 点按添加（拖拽的兜底操作）：模块库「＋」→ 加回它原本所属的分区末尾
function sidebarLayoutAddMod(modId) {
  const m = findWorkspaceItem(modId);
  if (!m || !canSee(m) || !pageAvailable(modId)) return;
  const groups = sidebarEditorGroups().map(g => ({ sec: g.sec, items: [...g.items] }));
  if (groups.some(g => g.items.includes(modId))) return;
  const originSec = GROUPS.find(g => g.items.some(x => x.id === modId))?.sec;
  let grp = (originSec && groups.find(g => g.sec === originSec)) || groups[0];
  if (!grp) { grp = { sec: originSec || '工作', items: [] }; groups.push(grp); }
  grp.items.push(modId);
  saveSidebarLayoutGroups(groups);
  toast('已加入侧栏', m.name);
}

function sidebarLayoutReorderGroup(fromSec, toSec) {
  if (fromSec === toSec) return;
  const groups = sidebarEditorGroups().map(g => ({ sec: g.sec, items: [...g.items] }));
  const fromIdx = groups.findIndex(g => g.sec === fromSec);
  const toIdx = groups.findIndex(g => g.sec === toSec);
  if (fromIdx < 0 || toIdx < 0) return;
  const [row] = groups.splice(fromIdx, 1);
  groups.splice(toIdx, 0, row);
  saveSidebarLayoutGroups(groups);
}

// 窄侧栏条目少：分组只做分区标题，不折叠。
function revealSideGroupFor(mod) {
  requestAnimationFrame(() => {
    document.querySelector(`.side-item[data-mod="${mod}"]`)?.scrollIntoView({ block: 'nearest' });
    updateSideGlass();
  });
}

/* 徽标：review=待审发票（真）· appr=官网待审批（真）· im=未读消息（真）· work=未读工作提醒（真）· agents=演示数据 */
let invPendingCount = 0, apprCount = 0, imUnreadCount = 0, workUnreadCount = 0;
function badgeHtml(kind) {
  if (kind === 'review') return `<span class="bdg" data-badge="review" style="${invPendingCount ? '' : 'display:none'}">${invPendingCount}</span>`;
  if (kind === 'appr') return `<span class="bdg" data-badge="appr" style="${apprCount ? '' : 'display:none'}">${apprCount}</span>`;
  if (kind === 'im') return imUnreadCount ? `<span class="bdg" data-badge="im" style="${imUnreadCount ? '' : 'display:none'}">${imUnreadCount}</span>` : '';
  if (kind === 'work') return workUnreadCount ? `<span class="bdg" data-badge="work" style="${workUnreadCount ? '' : 'display:none'}">${workUnreadCount}</span>` : '';
  if (kind === 'agents' && typeof agentPendingCount === 'function') { const n = agentPendingCount(); return n ? `<span class="bdg">${n}</span>` : ''; }
  return '';
}
function sidebarItemHtml(m, { favorite = false, core = false, delay = 0 } = {}) {
  const active = !m.href && m.id === curMod;
  const tag = m.href ? 'a' : 'div';
  const attrs = m.applicationId
    ? `role="button" tabindex="0" aria-label="${esc(m.name)}" data-side-application="${esc(m.applicationId)}"`
    : m.href
    ? `href="${m.href}"`
    : `onclick="go('${m.id}')"`;
  const star = core ? '' : `<button class="side-star ${favorite ? 'on' : ''}" title="${favorite ? '取消收藏' : '收藏到顶部'}" aria-label="${favorite ? '取消收藏' : '收藏'}" onclick="event.preventDefault();event.stopPropagation();toggleFavorite('${m.id}')">${favorite ? '★' : '☆'}</button>`;
  // mock 占位：名字右边小扳手图标（不实装的分组不留「演示区」标签，图标即边界）
  const mockIco = (!core && pageMeta(m.id)?.status === 'mock')
    ? `<span class="side-mock" title="演示占位 · 实装后替换">${ICONS.wrench}</span>` : '';
  // data-name 供 rail（56px 图标列）悬停名牌使用，见 sidebar.js
  /* ⚠️ `data-nav-page`：**这一项自己的页 id**（别名页就是它自己的 id，不是实现页）。
     数据页跳 Excel 工作面时靠它保住「被点那一项」的身份 ——
     写实现页 `excel` ⇒ 侧栏亮的是「表格」⇒ 人点示例企业总表却被扔回「表格」
     （用户 2026-10-25 原话：「点击的时候侧栏不要跳回表格」）。
     ⚠️ **应用项不给这个属性**：**应用不是页**（`application:…` 在页面注册表里查不到）
     ⇒ 给了它，跳表时会拿着一个认不出的页 id ⇒ `go()` 退回 dash ⇒ 人点业务表却掉回工作台
     （用户 2026-10-25 探针：`resolvePage('application:…')` 返回 null）。 */
  const navPage = m.applicationId ? '' : ` data-nav-page="${m.id}"`;
  return `<${tag} class="side-item ${core ? 'core-item' : 'workspace-item'} ${favorite ? 'favorite-item' : ''} ${active ? 'on' : ''}" data-mod="${m.id}"${navPage} data-name="${esc(m.name)}" style="animation-delay:${delay}s" ${attrs}>
    <span class="ico">${m.applicationId ? esc(m.mark) : ICONS[m.ico]}</span><span class="side-label">${esc(m.name)}</span>${mockIco}${star}${m.bdg ? badgeHtml(m.bdg) : ''}
  </${tag}>`;
}
function renderBrand() {
  // rail 态品牌位只剩这一个按钮：静止显示印章，鼠标移上去（或键盘聚焦）才换成展开箭头。
  // ≤768 抽屉态没有「折叠成图标列」的中间态：此时按钮唯一正确的语义是收起抽屉，
  // 调 sidebarLayout.toggle() 只会翻转一个看不见的 rail 类（用户看到「点了只轻微位移」）。
  return `
    <div class="side-brand">
      <img src="brand-mark.png" alt="尚书" class="side-brand-img">
      <button class="side-toggle" onclick="window.innerWidth<=768?closeSideDrawer():window.sidebarLayout?.toggle()" title="收起/展开侧栏" aria-label="折叠侧栏">
        <img src="brand-seal.png" alt="" class="side-toggle-seal" aria-hidden="true">
        <span class="side-toggle-chev" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5l-7 7 7 7"/></svg>
        </span>
      </button>
    </div>`;
}
/* —— 账号区：点「管理员」向上展开菜单（用户管理 / 系统配置 / 登出） —— */
function accountMenuModules() {
  // 个人设置由领域注册；系统入口仍按角色、领域状态和页面准入过滤。
  return [...(currentRole() === 'admin' ? [findWorkspaceItem('apps')] : []),
    ...GROUPS.flatMap(g => g.items).filter(m => m.accountMenu)]
    .filter(m => m && canSee(m) && pageAvailable(m.id))
    .map(m=>m.id==='apps'?({...m,name:'管理后台',ico:'gear'}):m);
}
/* —— 管理后台那几页的**页签条**（2026-10-21）——
   管理后台 / 账号管理 / AI 工具 / 导航设置 / 跨应用数据 / 系统设置。
   放在 app.js：这六页分属 real-apps / real-users / real-ai-tools / real-config / real-objects
   五个文件，各写一套页签条一定会漂（哪天加页就漏一处）⇒ 公共壳一份实现，各页共用。
   **当前页标 aria-current="page"** —— 原来那排是纯文字，看不出自己人在哪一页。 */
window.shangshuBindAdminDestinations = (host) => {
  const root = host || document;
  root.querySelectorAll('.admin-destinations [data-route]').forEach(button => {
    button.onclick = () => go(button.dataset.route);
  });
};
/**
 * 各管理页调一次：把 `[data-admin-destinations]` 那个空位换成页签条。
 * **列表归管理后台那页**（real-apps.js 的 ADMIN_DESTINATIONS）——
 * 加管理页时只改那一处；这里只管「画出来 + 标当前 + 绑跳转」。
 */
window.shangshuRenderAdminDestinations = (host, current) => {
  const holder = (host || document).querySelector('[data-admin-destinations]');
  if (!holder || typeof window.shangshuAdminDestinations !== 'function') return;
  /* —— **那排页签是管理后台的页面切换条**（用户 2026-10-24 22:2x 站上批注：
     「然后我不知道我**为什么**这个一直出现在这里？？？」—— 指着**业务受管表页**上那排
     「管理后台／账号管理／AI 工具／导航设置／跨应用数据／系统设置」）——
     病根有两层：
       ① `window.shangshuAdminDestinations` 是**固定六项**，**一个字都不看当前身份**
          ⇒ 连**普通员工**都能看见管理后台的页签；
       ② `#/objects` 这**一个路由兼着两件事** —— 管理后台的「跨应用数据」目录（管理员用）
          ＋ 业务应用的**受管表页**（URL 带 `?application=`）⇒ 在业务表页上凭空多出一排
          管理后台的页签。
     ⇒ **两条都堵**：
       · **不是管理员 ⇒ 不画**（管理后台是管理员的地方）；
       · **业务受管表页**（URL 带 `?application=`）⇒ **不画**（那一支是业务表页）。
     ⚠️ **管理员在管理后台自己那几页照旧画**（不许把管理员的路也堵了）。
     ⚠️ 不画的时候**把那个空位拿走**（页面模板里它是写死的 `<nav>`）——
        留个空 `<nav>` 在那儿，页面上就是一条空白条。 —— */
  if (currentRole() !== 'admin') { drop(); return; }
  if (new URLSearchParams(location.search).has('application')) { drop(); return; }
  holder.outerHTML = window.shangshuAdminDestinations(current);
  window.shangshuBindAdminDestinations(host || document);

  /** 不画那排页签 ⇒ **把页面里那个空位拿走**（不许留一条空白条在页面上）。 */
  function drop() {
    if (typeof holder.remove === 'function') { holder.remove(); return; }
    holder.outerHTML = '';
  }
};
function renderUserFoot() {
  const me = currentUserInfo;
  const myName = (me?.display_name || me?.username || '·');
  const myRole = ROLE_LABEL[me?.role || 'staff'] || me?.role || '';
  const myRoleSub = myName === myRole ? '' : esc(myRole);
  const mods = accountMenuModules().map(m => `
          <button class="side-account-item" role="menuitem" onclick="closeAccountMenu();go('${m.id}')">
            <span class="ico">${ICONS[m.ico]}</span>${m.name}
          </button>`).join('');
  return `
    <div class="side-foot">
      <div class="side-account" id="side-account">
        <div class="side-account-menu" id="side-account-menu" role="menu" hidden>
          ${mods}
          <button class="side-account-item danger" role="menuitem" onclick="logout()">
            <span class="ico">${ICONS.logout}</span>登出
          </button>
        </div>
        <button class="side-user" id="side-user" onclick="toggleAccountMenu(event)"
                aria-haspopup="menu" aria-expanded="false" title="账号">
          <span class="side-avatar">${esc(myName.slice(0, 1))}</span>
          <span class="side-user-name">${esc(myName)}<em>${myRoleSub}</em></span>
          <span class="side-user-caret">${ICONS.caret}</span>
        </button>
      </div>
    </div>`;
}
let accountMenuOpen = false;
function setAccountMenu(open) {
  const menu = $('#side-account-menu'), btn = $('#side-user');
  if (!menu || !btn) return;
  accountMenuOpen = !!open;
  if (accountMenuOpen) {
    // 挂到 body，避免折叠栏的宽度、overflow 和移动端 transform 裁掉菜单。
    document.body.appendChild(menu);
    menu.classList.add('floating');
    const rect = btn.getBoundingClientRect();
    const width = Math.min(216, Math.max(0, window.innerWidth - 16));
    // 定位消费实际布局；控制器脚本加载失败也不能阻断账号菜单和退出入口。
    const collapsed = window.sidebarLayout?.collapsed ?? $('#side')?.classList.contains('rail');
    const anchor = collapsed && window.innerWidth > 768 ? rect.right + 8 : rect.left;
    menu.style.width = width + 'px';
    menu.style.left = Math.max(8, Math.min(anchor, window.innerWidth - width - 8)) + 'px';
    menu.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + 'px';
  } else {
    $('#side-account')?.insertBefore(menu, btn);
    menu.classList.remove('floating');
    menu.style.removeProperty('width');
    menu.style.removeProperty('left');
    menu.style.removeProperty('bottom');
  }
  menu.hidden = !accountMenuOpen;
  btn.setAttribute('aria-expanded', accountMenuOpen ? 'true' : 'false');
}
function closeAccountMenu() { setAccountMenu(false); }
function toggleAccountMenu(e) {
  if (e) e.stopPropagation();
  setAccountMenu(!accountMenuOpen);
}
document.addEventListener('click', (e) => {
  if (accountMenuOpen && !e.target.closest('#side-account, #side-account-menu')) closeAccountMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && accountMenuOpen) { closeAccountMenu(); $('#side-user')?.focus(); }
});
window.addEventListener('resize', closeAccountMenu);
function renderChrome() {
  closeAccountMenu();
  const groups = visibleGroups();
  const visibleItems = groups.flatMap(g => g.items);
  const favorites = sidebarFavorites
    .map(findWorkspaceItem)
    .filter(Boolean)
    .filter(m => visibleItems.some(v => v.id === m.id));
  const core = CORE_ITEMS.filter(canSee).map((m, i) => sidebarItemHtml(m, { core: true, delay: i * .035 })).join('');

  const layoutMap = Object.fromEntries(sidebarLayoutGroups().map(g => [g.sec, new Set(g.items)]));
  const mainGroups = groups
    .map(g => ({ ...g, items: g.items.filter(m => layoutMap[g.sec]?.has(m.id)) }))
    .filter(g => g.items.length);
  // 按用户自定义的分组顺序排列
  const order = sidebarLayoutGroups().map(g => g.sec);
  mainGroups.sort((a, b) => {
    const ia = order.indexOf(a.sec), ib = order.indexOf(b.sec);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  mainGroups.forEach(g => {
    const seq = sidebarLayoutGroups().find(x => x.sec === g.sec)?.items || [];
    g.items.sort((a, b) => {
      const ia = seq.indexOf(a.id), ib = seq.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  });
  const mainHtml = mainGroups.map(g => `
    <div class="workspace-group open ${g.sec === '业务' ? 'business-nav-group' : ''}" data-sec="${esc(g.sec)}">
      <div class="side-sec">${esc(g.sec)}</div>
      <div class="workspace-body">${g.items.map((m, i) => sidebarItemHtml(m, { favorite: sidebarFavorites.includes(m.id), delay: i * .025 })).join('')}</div>
    </div>`).join('');

  const favoriteHtml = favorites.length ? `
    <div class="side-favorites">
      <div class="side-sec">收藏</div>
      ${favorites.map((m, i) => sidebarItemHtml(m, { favorite: true, delay: i * .035 })).join('')}
    </div>` : '';
  const shortcutHtml = flowShortcuts.length ? `
    <div class="side-favorites side-shortcuts">
      <div class="side-sec">快速入口</div>
      ${flowShortcuts.map((s, i) => flowShortcutItemHtml(s, i)).join('')}
    </div>` : '';

  $('#side').innerHTML = `
    <div id="side-glass"></div>
    <div class="side-resizer col-resizer" title="拖拽调整侧栏宽度"></div>
    ${renderBrand()}
    <div class="side-scroll" id="side-scroll">
      ${core ? `<div class="side-core">${core}</div>` : ''}
      ${favoriteHtml}
      ${shortcutHtml}
      <div class="side-main">${mainHtml}</div>
    </div>
    ${renderUserFoot()}`;
  /* ⚠️ **侧栏顶部那个「待核对」入口撤掉了**（用户 2026-10-22 17:48 批注「这个去掉吧」）：
     审核中心**已经有自己的页**（页面注册 ＋ 路由 ＋ 它自己分组里的侧栏项），
     顶部再挂一个「待核对」按钮就是**重复项** —— 那是弹窗时代的遗留（那时审核中心没自己的页）。
     ⇒ 连同那块宿主（`#side-review-entry`）一起**整体撤掉**，不是「留着不挂」。
     ⇒ 计数不丢：各档的待核对数现在显示在**审核中心页自己的 tab 上**。 */
  glassHoverItem = null;   // innerHTML 重建后旧 hover 引用失效，重置
  if (typeof refreshApplicationNavigation === 'function') refreshApplicationNavigation(undefined,{reuse:true});
  updateSideGlass();
  scheduleSideGlassSettle();   // 重建触发 rise 重放，落定后校正玻璃
}
function toggleFavorite(id) {
  const m = findWorkspaceItem(id);
  if (!m || !canSee(m)) return;
  const exists = sidebarFavorites.includes(id);
  sidebarFavorites = exists ? sidebarFavorites.filter(x => x !== id) : [...sidebarFavorites, id];
  localStorage.setItem(sidebarKey('favorites'), JSON.stringify(sidebarFavorites));
  const scrollTop = sideScrollEl()?.scrollTop || 0;
  renderChrome();
  sideScrollEl().scrollTop = scrollTop;
  toast(exists ? '已取消收藏' : '已收藏到顶部', m.name);
}

/* —— 模块开关（2026-08-15）：预设之外的模块统一在「系统配置 → 模块管理」里启用，侧栏不再有折叠区 —— */
function extraModules() {
  try {
    const saved = JSON.parse(localStorage.getItem(sidebarKey('extra-modules')) || '[]');
    return Array.isArray(saved) ? saved.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
function saveExtraModules(list) {
  localStorage.setItem(sidebarKey('extra-modules'), JSON.stringify([...new Set(list)]));
}
// 设置页调用：开关侧栏模块（兼容旧逻辑；推荐用拖拽编辑器）
function toggleModule(id) {
  const m = findWorkspaceItem(id);
  if (!m || !canSee(m) || !pageAvailable(m.id)) return false;
  if (isSidebarModLocked(id)) { toast('岗位预设', '该模块为岗位默认，请在编辑器中调整顺序'); return false; }
  const inLayout = sidebarLayoutGroups().some(g => g.items.includes(id));
  if (inLayout) sidebarLayoutRemoveMod(id);
  else {
    const sec = GROUPS.find(g => g.items.some(x => x.id === id))?.sec || '工作';
    sidebarLayoutMoveMod(id, sec, 999);
    toast('已加入侧栏', m.name);
  }
  return true;
}
// 设置页：返回全部可见模块（分组 + 开关状态）
function moduleCatalog() {
  const layoutSet = new Set(sidebarLayoutGroups().flatMap(g => g.items));
  const preset = presetModuleIds();
  return GROUPS
    .map(g => ({
      sec: g.sec,
      items: g.items
        .filter(canSee)
        .filter(m => pageAvailable(m.id))
        // sidebarHidden：只隐藏侧栏入口，但“模块管理”不应再列出它们，避免出现“点了也不会在侧栏出现”的错觉
        .filter(m => !m.sidebarHidden)
        .map(m => ({
          id: m.id, name: m.name, ico: m.ico, real: pageMeta(m.id)?.status === 'implemented' || pageMeta(m.id)?.status === 'compatibility',
          preset: preset.has(m.id),
          on: layoutSet.has(m.id),
        })),
    }))
    .filter(g => g.items.length);
}
// —— 滑动液态玻璃指示条：跟随当前选中项（.side-item.on）平滑滑动；hover 菜单项时预览滑动，离开回到选中项 ——
let glassHoverItem = null;
// 入场动画（rise .25s + 逐项 delay）和分组展开（max-height .28s）期间量到的 rect 是中间帧，
// 玻璃会停在歪的位置直到下次 hover/scroll 才自愈——首屏即歪的老 bug 根源。
// 渲染后按动画时长补两次校正（~动画中段不适用，只在落定后校正）。
let glassSettleTimers = [];
function scheduleSideGlassSettle() {
  glassSettleTimers.forEach(clearTimeout);
  glassSettleTimers = [420, 950].map(ms => setTimeout(() => updateSideGlass(glassHoverItem), ms));
}
function updateSideGlass(target) {
  const side = $('#side'), g = $('#side-glass');
  if (!side || !g) return;
  // rail 态同样显示：56px 列里指示块由 CSS 收成 44px 居中小方块的同一视觉语言
  const hovered = !!target && target !== side.querySelector('.side-item.on');
  const on = hovered ? target : side.querySelector('.side-item.on');
  if (!on) { g.classList.remove('show'); return; }
  g.classList.toggle('hover', hovered);
  g.classList.add('show');
  const sideRect = side.getBoundingClientRect();
  const onRect = on.getBoundingClientRect();
  // 水平位置与宽度由 CSS 按侧栏容器实时计算；若在这里写死像素，
  // 56↔宽栏动画起点量到的 44px 会在动画结束后继续残留。
  g.style.transform = `translateY(${onRect.top - sideRect.top}px)`;
  g.style.height = `${on.offsetHeight}px`;
}

/* —— 品牌区金雨（canvas 方案已废弃，改为纯 CSS background-clip:text 多层斜线，见 deepseek.css） —— */
// 委托 mouseover/mouseout：移入菜单项 → 玻璃滑过去（半透明预览）；移出 → 延迟确认后滑回选中项
function attachSideGlassHover() {
  const side = $('#side');
  if (!side) return;
  let leaveTimer = null;
  side.addEventListener('mouseover', (e) => {
    const item = e.target.closest('.side-item');
    if (item && item !== glassHoverItem) {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }   // 进入新项，取消回跳
      glassHoverItem = item; updateSideGlass(item);
    }
  });
  side.addEventListener('mouseout', (e) => {
    const item = e.target.closest('.side-item');
    if (item && item === glassHoverItem) {
      // 150ms 缓冲：慢速滑动跨 item 间隙（分组标题/间距）时不会误回跳，避免玻璃「跳来跳去」
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        if (glassHoverItem && !glassHoverItem.matches(':hover')) {
          glassHoverItem = null; updateSideGlass();
        }
        leaveTimer = null;
      }, 150);
    }
  });
}
// 拖拽调宽：右缘隐形条（.side-resizer）pointer 拖拽，宽度走 sidebarLayout.setWidth（clamp 200~420）
function attachSideResize() {
  const side = $('#side');
  if (!side || side.dataset.resizeBound) return;
  side.dataset.resizeBound = '1';
  let dragging = false, startX = 0, startW = 0;
  side.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.side-resizer');
    if (!handle) return;
    dragging = true; startX = e.clientX; startW = sidebarLayout.width;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    sidebarLayout.setWidth(startW + (e.clientX - startX));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    side.querySelector('.side-resizer')?.classList.remove('dragging');
    document.body.style.userSelect = ''; document.body.style.cursor = '';
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}
// 原地更新徽标，不重建侧栏（否则 side-item 会重播进场动画）
function updateBadge(n) {
  invPendingCount = n;
  $$('[data-badge="review"]').forEach(b => { b.textContent = n; b.style.display = n ? '' : 'none'; });
}
function updateApprBadge(n) {
  apprCount = n;
  $$('[data-badge="appr"]').forEach(b => { b.textContent = n; b.style.display = n ? '' : 'none'; });
}
function updateImBadge(n) {
  imUnreadCount = n;
  $$('[data-badge="im"]').forEach(b => { b.textContent = n; b.style.display = n ? '' : 'none'; });
}
function updateWorkBadge(n) {
  workUnreadCount = n;
  $$('[data-badge="work"]').forEach(b => { b.textContent = n; b.style.display = n ? '' : 'none'; });
}
let pageRenderGeneration = 0;
let activePageController = null;
let activePageUrl = null;
/** 上一页交回来的清理函数（disposer）—— 换页时必须真的执行它（PKG-128-T02 · R07）。 */
let activePageDisposer = null;
/** 首屏那次 go() 之后置 true ⇒ 用来区分「按地址进这一页」与「用户换页」。 */
let appBooted = false;
/**
 * 执行上一页交回来的清理函数。
 *
 * **为什么必须有这一步**（审查报告 R07 · PKG-128-T02）：
 *   页面渲染函数（`RENDER[mod]`）可以返回一个**清理函数**（disposer）——
 *   `review-center.js` 的 `mountPage` 就返回一个把 `state.pageHost` 清掉的函数，
 *   `file-center.js` / `sheet-center.js` 返回 `createToolWorkspace` 的 `dispose`。
 *   ⇒ 原来 `go()` 只把渲染结果丢给 `Promise.resolve(rendered).finally(…)`，
 *   **这个清理函数从头到尾没人调用** ⇒ 离页后：
 *     · 审核中心的 `pageHost` 仍非空 ⇒ 缓存一到期，审核事件会**再读一遍全部卡片**；
 *     · 不监听 `page.signal` 的页（real-applications／real-dashboard／real-objects／
 *       review-batch）离页后**什么都不释放**（定时器、观察器、在飞请求都留着）。
 *   ⇒ 现在换页时真的执行它 ⇒ 离页就收摊。
 *
 * **为什么放在 `beginPageRender` 里**：那儿正是「换页」的起点，
 *   而它已经在做 `activePageController?.abort()`（中止上一页的读请求）——
 *   两件事是同一件事的两半：**停掉上一页**（取消请求 ＋ 释放页面资源）。
 *
 * ⚠️ **清理失败不许挡住换页**：页面已经离开了，清理只是收尾 ⇒ 记一条警告，继续换。
 */
function disposeActivePage() {
  const disposer = activePageDisposer;
  activePageDisposer = null;
  if (typeof disposer !== 'function') return;
  try {
    disposer();
  } catch (error) {
    console.warn('上一页的清理没成功', error);
  }
}
function beginPageRender(mod) {
  disposeActivePage();
  activePageController?.abort();
  activePageController = new AbortController();
  const generation = ++pageRenderGeneration;
  const main = $('#main');
  main.replaceChildren();
  const host = document.createElement('div');
  host.className = 'main-scroll';
  host.dataset.page = mod;
  main.appendChild(host);
  return {
    mod,
    host,
    signal: activePageController.signal,
    isActive: () => generation === pageRenderGeneration && host.isConnected && curMod === mod,
  };
}

/**
 * **侧栏亮哪一项**（别名页要亮**自己那一项**，不许亮到实现页那一项去）。
 *
 * ⚠️ **为什么有这一档**：域可以把一个侧栏条目登记成**另一个页面的别名**
 *   （某个域侧栏的「案件表」＝ `ip.<域>.cases`，`alias: 'excel'` 指向实现页）
 *   ⇒ 公共壳按**实现页**高亮 ⇒ **点「示例企业总表」侧栏亮的是「表格」**
 *   （用户 2026-10-25 原话：「点击的时候侧栏不要跳回表格（他就是一个独立的页面）」——
 *     示例企业总表是**独立页**，侧栏不该跳到别的那一项）。
 * ⇒ **亮被点的那一项**（它自己在侧栏有条目时）；**没有条目就照旧亮实现页**
 *   （域登记的页，如 `ip.<域>.mail-rules`，本来就没有侧栏条目 ⇒ 行为一个字不变）。
 */
function activeNavId(requestedMod, mod) {
  if (requestedMod && requestedMod !== mod
      && document.querySelector(`.side-item[data-mod="${requestedMod}"]`)) return requestedMod;
  return mod;
}

/**
 * **「去开某张表」这一跳，侧栏该亮哪一项？**（纯计算，好判）
 *
 * ⚠️ **亮实现页（`表格`）＝ 把人丢回通用表格入口**（用户 2026-10-25 原话：
 * 「还是邮件模板时侧边栏高亮的还是表格」）⇒ **沿用原来亮着的那一项**
 * （应用项——受管对象露出来的入口——或页项）。
 *
 * @param {string} requestedMod 这一跳要去的页 id（别名页就是它自己的 id）
 * @param {string} mod          解析后的实现页 id
 * @param {string|null} litNow  现在亮着的那一项的 `data-mod`（没有就空）
 * @param {string|null} ownerNav **这张表归侧栏哪一项管**（没有就空）
 * @returns {string|null} 该亮哪一项的 `data-mod`（null ＝ 照常由换页逻辑定）
 */
function openingTableNav(requestedMod, mod, litNow, ownerNav) {
  // 别名页 ⇒ 亮**它自己**（换页逻辑本来就这么做：`activeNavId`）。
  if (requestedMod !== mod) return null;
  /* 这张表归侧栏某一项管（受管表 ⇒ 它所属应用的那一项）⇒ 亮那一项。
     ⚠️ 放在别名页**之后**：别名页有自己登记的身份 ⇒ 它优先。 */
  if (ownerNav) return ownerNav;
  // 没有亮着的项 ⇒ 照常（亮实现页）。
  if (!litNow) return null;
  // 实现页 ⇒ 沿用原来亮着的那一项（应用项／页项）。
  return litNow;
}

/** 现在侧栏亮着的那一项的 `data-mod`（没有就空）。 */
function litNavMod() {
  const item = document.querySelector('#side .side-item.on');
  return item && item.dataset ? (item.dataset.mod || null) : null;
}

function go(requestedMod) {
  // 必须在改选中项、地址参数或中止旧页面前询问，含同页重绘与浏览器后退。
  if (!window.dispatchEvent(new Event('shangshu:before-page-change', {cancelable:true}))) {
    if (activePageUrl && location.href !== activePageUrl) history.replaceState(null, '', activePageUrl);
    return Promise.resolve(false);
  }
  if (requestedMod === 'task-mgmt') {
    sessionStorage.setItem('shangshu.work.view', 'tasks');
    requestedMod = 'flowdesign';
  }
  const mod = resolvePage(requestedMod);
  if (!mod || !RENDER[mod]) {
    if (requestedMod !== 'dash') return go('dash');
    return Promise.resolve();
  }
  curMod = mod;
  /* 「当前页」露给域的那个口（`window.shangshuCurrentPage`）用这两个值：
   * `curMod` ＝ 实现页；`curPageId` ＝ 被请求的那一页（**别名页亮自己那一项时就是它自己**）。
   * ⚠️ 这里记的是**被请求的** `requestedMod`，不是解析后的 `mod`
   *   —— 否则别名页（`ip.<域>.cases` ⇒ `excel`）在域那边会变成「表格页」，
   *   域挂在自己那一页上的东西就认不出来了。 */
  curPageId = String(requestedMod || mod);
  /* 侧栏亮哪一项：**别名页亮自己那一项**（见 activeNavId 的注释）。
   * ⚠️ 这一句要在改高亮/改地址之前算好 —— 后面高亮、分组展开、地址栏都用它。 */
  const navId = activeNavId(requestedMod, mod);
  /* ⚠️ **「去开某张表」这一跳**：侧栏亮**被点的那一项自己** ——
     亮实现页（`表格`）＝ 把人丢回通用表格入口（用户 2026-10-25 原话：
     「还是邮件模板时侧边栏高亮的还是表格」）⇒ **沿用原来亮着的那一项**。 */
  const keepNav = openingTable ? openingTableNav(requestedMod, mod, litNavMod(), openingTableNavMod) : null;
  if (typeof selectApplicationNavigation === 'function'
      && !(keepNav && String(keepNav).startsWith('application:'))) {
    selectApplicationNavigation(null);
  }
  // 应用数据范围随 URL 保存，刷新可恢复；离开数据页不污染其他入口。
  if (mod !== 'objects' && (new URLSearchParams(location.search).has('application') || new URLSearchParams(location.search).has('dataset'))) {
    const url = new URL(location.href);
    url.searchParams.delete('application');url.searchParams.delete('dataset');
    history.replaceState(null, '', url);
  }
  if(mod!=='file-center'&&(new URLSearchParams(location.search).has('related_object')||new URLSearchParams(location.search).has('related_record'))){
    const url=new URL(location.href);url.searchParams.delete('related_object');url.searchParams.delete('related_record');history.replaceState(null,'',url);
  }
  /* 表号与独立模式参数**用户换页时**要清（2026-10-22 14:57 用户实测）：
     独立模式打开示例企业总表时地址是 `?object=<表id>&standalone=1`；
     这两个参数留着 ⇒ 点侧栏「表格」时 Excel 页又按那个表号直接开表（还是独立模式），
     看起来就是「点了表格跳转不回去」。
     ⇒ **跳到表格页时清掉**（表清单页自己会挑表，不需要地址里带着表号），
       但**在表格页内部换表**时不清（那是 Excel 自己的事，它自己管 URL）。
     ⚠️ **首屏那次 go() 不算**（那是「按地址进这一页」，不是换页）⇒ 用 `appBooted` 区分：
       否则从地址直接打开示例企业总表时，参数会在进页前就被清掉 ⇒ 表打不开。
     ⚠️ **「去开某张表」的那一跳也不算**（见 shangshuOpenTable）：那一跳正是要带着表号进去的
       ⇒ 清了表号，Excel 页就开不出这张表。 */
  if(appBooted&&!openingTable&&mod==='excel'&&(new URLSearchParams(location.search).has('object')||new URLSearchParams(location.search).has('standalone'))){
    const url=new URL(location.href);url.searchParams.delete('object');url.searchParams.delete('standalone');history.replaceState(null,'',url);
  }
  if (mod !== 'chat') lastBusinessMod = mod;
  if (mod !== 'chat' && typeof chatRevealBusiness === 'function') chatRevealBusiness();
  $$('.side-item').forEach(el => el.classList.toggle('on', el.dataset.mod === (keepNav || navId)));
  /* 应用项的高亮归 `selectApplicationNavigation`（它还管 `aria-current`）⇒ 亮应用项时叫它一声。 */
  if (keepNav && String(keepNav).startsWith('application:') && typeof selectApplicationNavigation === 'function') {
    selectApplicationNavigation(String(keepNav).slice('application:'.length));
  } else if (openingTable) {
    /* 「开表」这一跳：那张表所属的应用项**可能晚到**（应用清单是异步到的）
       ⇒ 晚到时补亮（见 `shangshuSyncTableNavHighlight`）。 */
    window.shangshuSyncTableNavHighlight?.();
  }
  revealSideGroupFor(navId);
  // 对话已经提升为全局协作层，不再把 #main 覆盖成独立模块页。
  $('.main').classList.remove('chat-page');
  $('.main').classList.toggle('flows-page', mod === 'flows');
  const page = beginPageRender(mod);
  // 先同步规范化 hash；停用、Mock 和旧页面不会保留在地址栏里制造可用错觉。
  // ⚠️ 用 **navId**（别名页亮自己那一项时就是它自己）而不是解析后的页 id：
  //   写解析后的 id ⇒ **别名身份在地址栏里被抹掉** ⇒ 刷新一次就变回实现页
  //   ⇒ 侧栏又亮成「表格」（用户 2026-10-25 反馈的那件事）。
  if (location.hash !== '#/' + navId) location.hash = '#/' + navId;
  activePageUrl = location.href;
  const rendered = RENDER[mod](page);
  /* ⚠️ **接住页面交回来的清理函数**（PKG-128-T02 · R07）：
   *   页面渲染函数可以返回一个清理函数（disposer），换页时必须真的执行它。
   *   ⇒ 它可能是**同步函数**，也可能是**一个 promise**（`mountPage` 是 async），
   *     所以两种都要接住：同步的直接收；promise 的等它落地再收。
   *   ⚠️ **人已经走了就别收**（`page.isActive()` 为假）—— 那时清理由 `beginPageRender`
   *     里那次 `disposeActivePage()` 负责，避免同一份清理跑两遍。
   */
  const keepDisposer = value => {
    if (typeof value !== 'function') return;
    if (!page.isActive()) { try { value(); } catch (error) { console.warn('上一页的清理没成功', error); } return; }
    activePageDisposer = value;
  };
  if (rendered && typeof rendered.then === 'function') {
    Promise.resolve(rendered).then(keepDisposer, () => {});
  } else {
    keepDisposer(rendered);
  }
  if (mod !== 'chat') {
    Promise.resolve(rendered).finally(() => {
      if (!page.isActive()) return;
      ensureAiBusinessLayer();
      if (typeof chatRefreshContext === 'function') chatRefreshContext();
    });
  }
  /* ⚠️ **新页挂上了 ⇒ 告诉那些跨页的公共件**（PKG-128-T02 · R07）。
   *   全站有些公共件**不属于任何一页**（`review-batch.js` 的「全部确认」工具条就是一个）——
   *   它们要跟着当前页走：离页时收摊、换页时重新接上。
   *   ⇒ 这里派发 `shangshu:page-mounted`（**新页挂上之后**），
   *     离页那一侧由 `go()` 开头的 `shangshu:before-page-change` 负责。
   *   ⚠️ 两个事件**分的是两头**：before-page-change＝要走了（收），page-mounted＝新页来了（接）。
   */
  if (window.dispatchEvent && typeof window.Event === 'function') {
    window.dispatchEvent(new window.Event('shangshu:page-mounted'));
  }
  page.host.scrollTop = 0;
  glassHoverItem = null;   // 切换模块后玻璃回选中项
  updateSideGlass();
  scheduleSideGlassSettle();   // 入场/展开动画落定后校正玻璃位置
  // 移动端：导航后自动收回侧栏抽屉
  if (window.innerWidth <= 768) closeSideDrawer();
  // 返回渲染 promise：调用方（如 AI 闭环追溯）要等页面画完才能定位/高亮记录
  return Promise.resolve(rendered);
}

/* #main 外壳保圆角（overflow:hidden），页面内容渲染进内部滚动容器 .main-scroll；
   模块渲染一律写 mainBox()，滚动条随内层走且被外壳圆角裁剪。 */
function mainBox() {
  const main = $('#main');
  let box = main.querySelector('.main-scroll');
  if (!box) {
    box = document.createElement('div');
    box.className = 'main-scroll';
    main.appendChild(box);
  }
  return box;
}

/* 业务面板仅挂载原件追溯／高亮层；操作确认卡统一留在原右侧对话流。 */
function ensureAiBusinessLayer() {
  const main = $('#main');
  if (!main || curMod === 'chat') return null;
  let layer = $('#ai-business-layer');
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = 'ai-business-layer';
  layer.className = 'ai-business-layer';
  const hd = main.querySelector('.page-hd');
  if (hd) hd.insertAdjacentElement('afterend', layer);
  else mainBox().prepend(layer);
  if (typeof chatRestoreBusinessDrafts === 'function') chatRestoreBusinessDrafts(layer);
  return layer;
}
// 移动端侧栏抽屉（汉堡）：滑出 + 遮罩
function toggleSideDrawer() {
  const side = $('#side');
  const open = side.classList.toggle('drawer-open');
  let mask = $('.side-mask');
  if (!mask) {
    mask = document.createElement('div');
    mask.className = 'side-mask';
    mask.onclick = closeSideDrawer;
    document.body.appendChild(mask);
  }
  mask.classList.toggle('show', open);
}
function closeSideDrawer() {
  $('#side')?.classList.remove('drawer-open');
  $('.side-mask')?.classList.remove('show');
}
// 模块 id → hash：支持 #/kanban 直达
window.addEventListener('hashchange', () => {
  const m = (location.hash || '').replace(/^#\//, '');
  const resolved = resolvePage(m);
  if (m && (!resolved || resolved !== curMod)) go(m);
});

/* mock 页标注：h1 加 mock 徽标 + 页头下加说明条（写明实装接哪张表/哪个里程碑） */
function markMock(note) {
  const h1 = $('#main .page-hd h1');
  if (h1 && !h1.querySelector('.tag')) h1.insertAdjacentHTML('beforeend', ' <span class="tag am">mock</span>');
  const hd = $('#main .page-hd');
  if (hd && note) hd.insertAdjacentHTML('afterend', `<div class="mock-note">${note}</div>`);
}

/* ============ 启动 ============ */
// 对话页产物卡跳转：?art=quote → 报价与订单 等
const ART_MAP = { quote: 'orders', invoice: 'expense', weekly: 'docs', profile: 'customers', production: 'production', inventory: 'inventory' };

document.addEventListener('DOMContentLoaded', async () => {
  const r = await fetch('api/session', { credentials: 'include' });
  const j = await r.json();
  if (!j.authed) {
    const next = /^#\/[a-z0-9-]+$/i.test(location.hash) ? location.hash : '#/dash';
    location.href = `login.html?next=${encodeURIComponent(next)}`;
    return;
  }
  currentUserInfo = j.user || null;
  currentPlatformInfo = j.platform || null;
  const role = currentUserInfo?.role || 'staff';
  DEMO_ROLE = DEMO_ROLE_MAP[role] || 'staff';
  IS_BOSS = role === 'admin';
  const name = currentUserInfo?.display_name || currentUserInfo?.username || '·';
  loadSidebarPrefs();
  renderChrome();
  // 折叠/宽度控制器：同步 rail 类 + 宽度到 #side，订阅变化（折叠归布局层，渲染层只消费）
  const syncRail = (s) => {
    const side = $('#side');
    if (!side) return;
    side.classList.toggle('rail', s.collapsed);
    side.style.setProperty('--side-w', (s.collapsed ? sidebarLayout.RAIL : s.width) + 'px');
    const toggle = side.querySelector('.side-toggle');
    if (toggle) {
      const label = s.collapsed ? '展开侧栏' : '折叠侧栏';
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('title', label);
    }
    closeAccountMenu();   // 布局改变时关闭旧锚点浮层；折叠态仍可再次打开。
    updateSideGlass();
    // 类切换后的下一帧再确认纵向位置；水平尺寸由 CSS 全程跟随容器。
    requestAnimationFrame(() => updateSideGlass(glassHoverItem));
  };
  if (window.sidebarLayout) {
    syncRail({ collapsed: sidebarLayout.collapsed, width: sidebarLayout.width });
    sidebarLayout.onChange(syncRail);
    sidebarLayout.onViewport(window.innerWidth);   // 初始视口：<1024 自动收 rail
    window.addEventListener('resize', () => sidebarLayout.onViewport(window.innerWidth));
    attachSideResize();
  } else {
    // 保留默认布局并继续加载业务页，不因非关键布局能力缺失中断整个启动链。
    toast('侧栏布局未加载', '可继续使用页面和账号菜单；请刷新后重试折叠与调宽。', 'error');
    console.error('[page] sidebar controller unavailable');
  }
  updateSideGlass();
  scheduleSideGlassSettle();   // 首屏：rise 入场动画期间量的位置是歪的，落定后校正
  attachSideGlassHover();
  const scrollHost = () => sideScrollEl();
  scrollHost()?.addEventListener('scroll', () => updateSideGlass(glassHoverItem));
  $('#side')?.addEventListener('scroll', () => updateSideGlass(glassHoverItem));
  const q = new URLSearchParams(location.search);
  const art = ART_MAP[q.get('art')];
  const visible = GROUPS.flatMap(g => g.items).filter(canSee).filter(m => pageAvailable(m.id)).map(m => m.id);
  // 初始模块：hash 直达（#/kanban）> ?art= 产物跳转 > 工作台/首个可见模块
  const allMods = [...CORE_ITEMS, ...GROUPS.flatMap(g => g.items)];
  const modOk = (m) => {
    const resolved = resolvePage(m);
    if (!resolved || !RENDER[resolved]) return false;
    const item = allMods.find(x => x.id === resolved);
    if (item) return canSee(item);
    /* 域登记的页（**从受管对象入口进**的那页，如某个域的「邮件规则表」）**没有侧栏条目**
       —— 域的 `managedNav` 只声明受管对象，那一页是「点那个入口进去」的，**故意不单列侧栏项**。
       ⇒ **不许因此判它「进不去」**：网址直达 / 刷新都要能落到那一页
       （2026-10-24 夜班巡站抓到：在那一页按刷新 ⇒ 地址从 `#/ip.<域>.mail-rules`
         变成 `#/dash` ⇒ 人被甩回工作台）。
       ⚠️ **角色那一道没有松**：注册表的 roles 由 `resolvePage` 把（平台注册表那一道），
         侧栏条目的 roles 由上面的 `canSee` 把；这里只放行「注册表说进得去、且确实有渲染函数」的页。
       ⚠️ **只在平台模式放行**（平台注册表才是那一道的权威）；**兼容模式的老规矩一个字没动**。 */
    return isPlatformManaged();
  };
  const hashMod = (location.hash || '').replace(/^#\//, '');
  // ⚠️ **首屏交给 go() 的必须是「地址里那个页 id」本身（hashMod），不是解析后的页 id**：
  //   别名页（如某个域侧栏的「案件表」＝ `ip.<域>.cases` → `alias:'excel'`）
  //   先解析再传 ⇒ **别名身份在进页前就没了** ⇒ 侧栏亮成「表格」、
  //   地址栏也被改写成 `#/excel`（刷新一次就变回去）。
  const initial = modOk(hashMod) ? hashMod : (art && visible.includes(art) ? art : (visible.includes('dash') ? 'dash' : visible[0]));
  /* —— **开机这一趟就把「要去哪一页」告诉域**（2026-10-30 用户授权「连开机那趟也省」）。
     邮件审核队列那类域**在脚本加载时**就挂了一次（壳的 `go()` 还没跑）
     ⇒ 那时壳的「当前页」是**空的** ⇒ 域**判不出**「这不是我要的那一页」
     ⇒ 照拉那份待审清单 ⇒ **表格页白花开销**（表格页根本用不着邮件的清单）。
     ⇒ 这里**先把 `initial` 记上**（壳已经算出来了）⇒ 域问得到「要去哪一页」
     ⇒ 不是自己那一页就不拉。
     ⚠️ `go()` 里会按**被请求的**页再记一次（`requestedMod`）⇒ 两处一致。 */
  curPageId = String(initial || '');
  /* 首屏这一次 go() **不是**「用户换页」⇒ 别在这里清地址参数
     （独立模式打开示例企业总表就是靠 `?object=<表id>&standalone=1` 进的表）。
     ⚠️ `appBooted` 必须在 go() **之后**才置 true —— 置早了这次首屏也会被当成换页。 */
  go(initial);
  appBooted = true;
  /* ⚠️ **所有脚本加载完，再画一次侧栏**（2026-10-22 站上实测出来的）：
     侧栏那一项能不能出现，除了「岗位预设里列了它」，还看**画侧栏的那一刻**
     `RENDER` 里有没有这一页的渲染函数（`pageAvailable()`：`!!(resolved && RENDER[resolved])`）。
     若某一页的渲染函数是在 app.js 之后才挂上的（`index.html` 里排在 `js/app.js` 后面），
     启动时画的那一次侧栏里就没有它 ⇒ 被 `pageAvailable` 滤掉 ⇒ **之后没人重画侧栏** ⇒ 点不到。
     ⇒ 修法：`load` 事件（所有脚本都执行完了）之后**重画一次** ⇒ 晚挂的页也能进侧栏。
     ⇒ 这是**通用**修法：以后再有核心页晚挂，也不会再漏。
     ⚠️ **但它不是「审核中心」缺项的原因**（2026-10-22 复核）：那一项缺在**岗位预设**
     （`ROLE_PRESET` 四份都没列它）⇒ 这段兜底上线后侧栏仍然缺 ⇒ 真原因见 `ROLE_PRESET` 处的注释。 */
  window.addEventListener('load', () => {
    if (typeof renderChrome === 'function') renderChrome();
  });
  if (typeof refreshPlatformChatTools === 'function') refreshPlatformChatTools().catch(() => {});
  // legacy 独立 Node 模式才读取旧发票/官网徽标；平台模式由应用贡献提供业务入口。
  if (!isPlatformManaged()) {
    apiJSON('api/invoices').then(all => updateBadge(all.filter(x => x.status === '待审').length)).catch(() => {});
    apiJSON('/api/website/submissions').then(subs => { if (Array.isArray(subs)) updateApprBadge(subs.filter(s => s.status === 'pending').length); }).catch(() => {});
  }
});
