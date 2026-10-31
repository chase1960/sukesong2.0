// 尚书 shangshu-server 入口。
// 注册能力/skill/触发器 → 起外部服务 → 武装定时 → 起 web。
import { registerInvoiceCapabilities } from './capabilities/invoice.ts';
import { registerInvoiceSkill } from './skills/invoice-collect.ts';
import { registerChatTools } from './capabilities/chat-tools.ts';
import { registerObjectTools } from './capabilities/object-tools.ts';
import { registerDocExtractTools } from './capabilities/doc-extract.ts';
import { registerWorkflowTools } from './capabilities/workflow-tools.ts';
import { registerMetadataTools } from './capabilities/metadata-tools.ts';
import { registerPlatformTools } from './capabilities/platform-tools.ts';
import { registerPresetWorkflows } from './flows/presets.ts';
import { bootstrapMetadata } from './core/meta-store.ts';
import { getRuntimeStore } from './core/store.ts';
import { registerDailyBriefSkill } from './skills/daily-brief.ts';
import { registerAlertsCheckSkill } from './skills/alerts-check.ts';
import { registerYinlingWebsite } from './custom/yinling-website/register.ts';
import { registerDocGen } from './capabilities/doc-gen/register.ts';
import { registerRecruitment } from './capabilities/recruitment/register.ts';
import { seedYinlingTemplates } from './capabilities/doc-gen/seed.ts';
import { buildContext } from './core/context.ts';
import { registerTrigger } from './core/registry.ts';
import { rescheduleAll, setExternalServices } from './core/scheduler.ts';
import { loadConfig } from './core/config.ts';
import { buildApp } from './adapters/web/server.ts';
import { ExternalServiceManager } from './core/infra/external.ts';
import { ensureBootstrap, verifyPassword } from './core/auth/users.ts';
import { localStore, createBitableStore } from './core/store.ts';
import {DATA_DIR} from './core/config.ts';
import {mkdirSync} from 'node:fs';
import {acquireInstanceLock} from './core/infra/instance-lock.ts';

// 防御：未捕获的 promise rejection 不杀进程（飞书调用等异步错误由 handler 返回错误响应，不应崩溃整个 server）
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e as Error)?.stack || e));

registerInvoiceCapabilities();
registerChatTools();
registerObjectTools();
registerDocExtractTools();
registerWorkflowTools();
registerMetadataTools();
registerPlatformTools();
registerInvoiceSkill();
registerDailyBriefSkill();
registerAlertsCheckSkill();
registerYinlingWebsite();

const cfg = loadConfig();
if(cfg.file.provider!=='local') throw new Error('当前文件存储仅支持 local；请先迁移附件，不能使用未实现的云盘适配器');
const instanceDir=process.env._SS_DATA_DIR || DATA_DIR;
mkdirSync(instanceDir,{recursive:true,mode:0o700});
const releaseInstance=acquireInstanceLock(instanceDir);
process.once('exit',releaseInstance);
// SIGKILL/断电会保留锁，管理员核对 PID 后清理，避免误删其他实例的锁。
process.once('SIGTERM',()=>process.exit(0));
process.once('SIGINT',()=>process.exit(0));
if (!getRuntimeStore().guarantees?.transactions) throw new Error('必须先将业务主库迁移到 SQLite；bitable 只保留为外部适配器');
await getRuntimeStore().query('cognition','users');
await bootstrapMetadata(getRuntimeStore());
const external = new ExternalServiceManager(cfg);
await external.start();
process.once('exit',()=>external.stop());
setExternalServices(external);

registerDocGen(external);
// 招聘演示域（纯 Node 演示赛道）：REST + 事件审计 + AI 提案/人确认，含幂等演示种子。
registerRecruitment(external);

// 内置种子：银聆法律文书模板集（幂等，已有则跳过）。启动期失败仅告警，不阻断 web 服务。
// bitable 模式下跳过：doc-gen 的多表 bitable 存储尚未实装，种子会把 template_sets/document_types 混进发票库。
const seedCtx = buildContext(console.log, { external });
try {
  if (cfg.store.provider === 'bitable') {
    console.log('[seed] bitable 模式：跳过 doc-gen 种子（多表存储待实装，避免污染发票库）');
  } else {
    await seedYinlingTemplates(seedCtx);
  }
} catch (e) {
  console.warn('[seed] 种子失败，跳过（不阻断启动）:', (e as Error).message);
}

registerTrigger({
  id: 'trigger.invoice-poll',
  name: '发票收集',
  description: '定时查邮箱收取发票，OCR 抽取后待审入库',
  schedule: cfg.poll.cron,
  skill: 'skill.invoice-collect',
  enabled: true,
  params: { mailbox: cfg.poll.mailbox },
  last_run_at: null,
  next_run_at: null,
});
// 每日经营简报（A3）：早上 8 点聚合经营数据生成简报（数字与看板一致）。
registerTrigger({
  id: 'trigger.daily-brief',
  name: '每日经营简报',
  description: '定时聚合订单/应收/应付/库存/毛利生成简报',
  schedule: '0 8 * * *',
  skill: 'skill.daily-brief',
  enabled: true,
  params: {},
  last_run_at: null,
  next_run_at: null,
});
// 主动提醒（A4）：早上 8:30 扫描应收逾期/库存预警。
registerTrigger({
  id: 'trigger.daily-check',
  name: '主动提醒',
  description: '扫描应收逾期与库存预警生成提醒',
  schedule: '30 8 * * *',
  skill: 'skill.alerts-check',
  enabled: true,
  params: {},
  last_run_at: null,
  next_run_at: null,
});
// 元数据/身份初始化成功后再启动定时任务。

// 身份体系 bootstrap：cognition.users / execution.operation_logs 不存在则自动建表（bitable），
// 无任何用户时建默认 admin/admin。失败只告警不阻断（local 模式 / 凭证未配时 web 仍可登录演示）。
try {
  const authStore = cfg.store.provider === 'bitable' ? createBitableStore(cfg.feishu) : localStore;
  await ensureBootstrap(authStore);
  // R0：默认密码上线检查——公网曾实测 admin/admin 可登录。启动即扫描，防止带默认密码上线。
  try {
    const users = await authStore.query('cognition', 'users');
    const weak = users
      .filter((u: any) => u.password_hash && verifyPassword('admin', u.password_hash))
      .map((u: any) => u.username);
    if (weak.length) {
      console.warn(`[安全] 以下用户仍在使用默认密码 admin：${weak.join('、')} —— 上线前必须通过用户管理或 PATCH /api/users/:id/password 修改`);
    }
  } catch { /* 扫描失败不阻断 */ }
  if (cfg.server.admin_password === 'admin') {
    console.warn('[安全] 兜底 admin_password 仍是默认值 admin（仅用户表为空时生效）——上线前请在系统配置修改');
  }
} catch (e) {
  external.stop();
  throw new Error(`身份初始化失败，拒绝启动: ${(e as Error).message}`);
}

rescheduleAll();

const app = buildApp(external);
const server = app.listen(cfg.server.port, process.env.HOST || '0.0.0.0', () => {
  console.log('┌─────────────────────────────────────────────────');
  console.log('│ 尚书 · 发票收集  shangshu-server 已启动');
  console.log(`│   入口：http://127.0.0.1:${cfg.server.port}`);
  console.log('│   登录：使用已配置账号（密码不写日志）');
  console.log(`│   OCR 服务：由 core/infra/ocr.ts 管理（端口 ${cfg.ocr?.port ?? 8001}）`);
  console.log(`│   邮件源：${cfg.mail.provider}（folder = 把 ${cfg.mail.folder} 下的文件当发票）`);
  console.log('└─────────────────────────────────────────────────');
});

server.on('upgrade', (req, socket, head) => {
  const proxy = app.locals.frappeSocketProxy;
  if (proxy && req.url?.startsWith('/socket.io')) {
    proxy.ws(req, socket, head);
    return;
  }
  socket.destroy();
});
