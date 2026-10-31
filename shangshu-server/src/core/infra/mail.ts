// MailSource —— spec §5.3。邮件数据管道的可换缝。
// folder 实现：把 data/inbox 下的文件当成「带一个附件的邮件」，演示用。
// agently 实现：subprocess 调 agently-cli（Tencent Agent Mail，OAuth device-flow 鉴权）。
//   - list：message +list（未读+带附件）→ message +read 取附件列表
//   - fetch：attachment +download 落地临时目录后读字节
//   - markRead：agently-cli 无独立「标已读」命令，改用本地 processed-set 记录已处理邮件，
//     下次 listUnread 跳过；失败路径不 markRead → 下次轮询重试。
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, mkdirSync, existsSync, readFileSync, renameSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import type { MailSource, IncomingMail, Attachment } from '../types.ts';

const execFileAsync = promisify(execFile);

// 收取的发票附件类型：发票一般为 PDF（用户要求）。需要图片发票时改回 /\.(pdf|jpg|jpeg|png|webp|bmp)$/i
const ACCEPTED = /\.(pdf)$/i;
const mimeOf = (name: string): string => {
  const e = name.toLowerCase().split('.').pop() || '';
  return ({
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', bmp: 'image/bmp',
  } as Record<string, string>)[e] || 'application/octet-stream';
};

// —— folder 实现：inbox 文件夹里的文件 = 一封带附件的邮件 ——
function makeFolderSource(folder: string): MailSource {
  const processed = join(folder, 'processed');
  return {
    async listUnread() {
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
      if (!existsSync(processed)) mkdirSync(processed, { recursive: true });
      const files = readdirSync(folder).filter((f) => ACCEPTED.test(f));
      return files.map((filename) => ({
        id: filename, attachment_id: filename,
        from: 'folder-mock@example.com',
        subject: filename,
        received_at: new Date().toISOString(),
      }));
    },
    async fetchAttachment(mailId) {
      const bytes = readFileSync(join(folder, mailId));
      return { filename: mailId, mime: mimeOf(mailId), bytes };
    },
    async markRead(mailId) {
      // 移到 processed，避免下次重复收
      try {
        if (existsSync(join(folder, mailId))) renameSync(join(folder, mailId), join(processed, mailId));
      } catch { /* 忽略，幂等 */ }
    },
    async deleteMail(mailId) {
      // folder 模式：清理 = 移到 processed（与 markRead 同义，本地文件不真删）
      try {
        if (existsSync(join(folder, mailId))) renameSync(join(folder, mailId), join(processed, mailId));
      } catch { /* 忽略，幂等 */ }
    },
  };
}

// —— agently-cli 调用基础设施 ——
// 容器里 agently-cli 装在 nvm 下，只有登录 shell 的 PATH 才有。改为 lazy 解析：首次 agently() 调用时
// 才跑 bash -lc（provider=folder 时永不调用，不阻塞 server 启动，也不再让登录 shell profile 污染每次启动）；
// 解析结果缓存，之后直接 spawn。解析失败回退裸名，靠 server 进程 PATH 兜底。
let _agentlyBin: string | null = null;
function agentlyBin(): string {
  if (_agentlyBin !== null) return _agentlyBin;
  try {
    const p = execFileSync('bash', ['-lc', 'command -v agently-cli'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    _agentlyBin = p || 'agently-cli';
  } catch { _agentlyBin = 'agently-cli'; /* 靠 server 进程 PATH 兜底 */ }
  return _agentlyBin;
}

const AGENTLY_TIMEOUT_MS = 30_000;

// 调 agently-cli，返回解析后的 stdout JSON。CLI 把结构化结果打到 stdout（首个 {...} 对象），
// 提示/调试走 stderr；这里防御性提取首个完整 JSON 对象，过滤掉登录 shell profile echo 之类的干扰。
async function agently(args: string[], opts: { cwd?: string } = {}): Promise<any> {
  let stdout = '', stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync(agentlyBin(), args, {
      ...opts, timeout: AGENTLY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (e: any) {
    if (e.killed) throw new Error(`agently-cli 超时（${AGENTLY_TIMEOUT_MS}ms）：${args.join(' ')}`);
    const es = (e.stderr || '').toString().trim();
    throw new Error(`agently-cli 失败 [${args.join(' ')}]：${(e.message || '').split('\n')[0]}${es ? ` | ${es.slice(0, 300)}` : ''}`);
  }
  const out = stdout.trim();
  const s = out.indexOf('{'), t = out.lastIndexOf('}');
  if (s === -1 || t === -1 || t < s) {
    throw new Error(`agently-cli 无 JSON 输出 [${args.join(' ')}]：${(out || stderr).slice(0, 200)}`);
  }
  const json = JSON.parse(out.slice(s, t + 1));
  if (json.ok === false) throw new Error(`agently-cli 业务失败 [${args.join(' ')}]：${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json;
}

// 供「连接测试」用：查 agently-cli 本地授权态（不碰邮箱 API）。
export async function agentlyStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const j = await agently(['auth', 'status']);
    const d: any = j?.data || {};
    // agently-cli auth status 的返回形状随版本变化（logged_in / status / email 等），逐个兜底，
    // 避免硬断言某个字段名导致「已授权却显示未授权」的假阴性。
    const loggedIn = !!(d.logged_in || d.status === 'authorized' || d.status === 'ok' || d.email);
    return {
      ok: loggedIn,
      detail: loggedIn ? `agently-cli 已授权：${d.email || '(邮箱)'}` : 'agently-cli 未授权（需 agently-cli auth login）',
    };
  } catch (e) {
    return { ok: false, detail: `agently-cli 不可用：${(e as Error).message}` };
  }
}

// 本地已处理邮件集合（message_id）—— agently-cli 无 mark-read 命令时的去重源。
// 落在 data/agently-processed.json（gitignored）。失败路径不写入 → 下次重试。
const PROCESSED_PATH = join(DATA_DIR, 'agently-processed.json');
function loadProcessed(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(PROCESSED_PATH, 'utf8'));
    // 必须是字符串数组：文件被 truncate 成 "{}"/"null" 等非数组时，new Set({}) 会抛 TypeError；
    // 旧实现靠 catch 静默吞掉 → processed 变空 → 下次轮询重读全部已处理邮件（重复 OCR/入库）。
    // 显式校验 + 告警，损坏时不再静默。
    if (!Array.isArray(parsed)) {
      console.error(`[mail] agently-processed.json 非数组（忽略并视为空），类型: ${typeof parsed}`);
      return new Set();
    }
    return new Set<string>(parsed.filter((x): x is string => typeof x === 'string'));
  } catch (e) {
    console.error(`[mail] agently-processed.json 解析失败（忽略并视为空）：${(e as Error).message}`);
    return new Set();
  }
}
function saveProcessed(set: Set<string>) {
  try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(PROCESSED_PATH, JSON.stringify([...set])); }
  catch { /* best-effort：写不进不影响本次轮询，下次重算 */ }
}

// mailId 编码 `${message_id}::${attachment_id}`。统一解析，避免 fetchAttachment/markRead/deleteMail 各 split 一份、行为不一致。
function parseMailId(mailId: string): { mid: string; attId: string } {
  const sep = mailId.indexOf('::');
  return sep >= 0 ? { mid: mailId.slice(0, sep), attId: mailId.slice(sep + 2) } : { mid: mailId, attId: '' };
}

// —— agently 实现 ——
// 多附件拍平：一封邮件的每个发票类附件 → 一条 IncomingMail，id 编码 `${message_id}::${attachment_id}`。
function makeAgentlySource(_mailbox: string, keywords: string[] = []): MailSource {
  const processed = loadProcessed();

  return {
    async listUnread(_since?: string): Promise<IncomingMail[]> {
      const out: IncomingMail[] = [];
      let cursor: string | undefined;
      // 最多翻 5 页（每页 50），防止极端积压把单次轮询拉爆。
      for (let page = 0; page < 5; page++) {
        // 不用 --is-unread：message +read 会顺带标已读，靠邮箱已读态去重不可靠；
        // 改为列出所有带附件的收件箱邮件，去重完全交给本地 processed-set（更稳，失败可重试）。
        const j = await agently([
          'message', '+list', '--dir', 'inbox', '--has-attachments',
          '--limit', '50', ...(cursor ? ['--cursor', cursor] : []),
        ]);
        const items: any[] = j?.data?.data ?? [];
        const pg = j?.data?.pagination ?? {};
        for (const it of items) {
          const mid: string | undefined = it.message_id;
          if (!mid) continue;
          if (processed.has(mid)) continue; // 本地已处理，跳过（不依赖邮箱已读态）
          // 预筛：主题/摘要/发件人 任一含关键词（OR）。空关键词=不过滤（兼容）。
          // 命不中→不像发票，标记跳过避免下次重复 +read。
          if (keywords.length > 0) {
            const hay = `${it.subject || ''} ${it.snippet || ''} ${it.from?.name || ''} ${it.from?.email || ''}`.toLowerCase();
            // 命不中关键字只本次跳过，不持久化拉黑：用户后续补关键字还能捞回。
            // 代价仅下次轮询对这类邮件多看一遍 +list 元数据（关键字检查在 +read 之前，不会重复读附件）。
            if (!keywords.some((k) => k && hay.includes(k.toLowerCase()))) continue;
          }
          // 读详情拿附件清单（+read 可能顺带标已读，但去重靠本地 set，故无妨）。
          let detail: any;
          try { detail = await agently(['message', '+read', '--id', mid]); }
          catch { continue; /* 单封失败不阻断其余 */ }
          const d = detail?.data ?? {};
          const usable = (d.attachments ?? []).filter((a: any) => a.attachment_id && ACCEPTED.test(a.filename || ''));
          for (const a of usable) {
            out.push({
              id: `${mid}::${a.attachment_id}`,
              attachment_id: a.attachment_id,
              from: d.from?.email || it.from?.email || '',
              subject: d.subject || it.subject || '',
              received_at: d.created_at || it.created_at || new Date().toISOString(),
            });
          }
          // 无可用附件的邮件（纯文本/非发票）：标记已处理，避免下次重复 +read 骚扰。
          if (usable.length === 0) processed.add(mid);
        }
        if (!pg.has_more || !pg.next_cursor) break;
        cursor = pg.next_cursor;
      }
      saveProcessed(processed);
      return out;
    },

    async fetchAttachment(mailId: string): Promise<Attachment> {
      const { mid, attId } = parseMailId(mailId);
      if (!mid || !attId) throw new Error(`非法 mailId（缺 attachment_id）：${mailId}`);
      const tmp = mkdtempSync(join(DATA_DIR, 'agently-dl-'));
      try {
        await agently(['attachment', '+download', '--msg', mid, '--att', attId, '--output', '.'], { cwd: tmp });
        // saved_to 路径格式不定，直接读 tmp 里落地的唯一文件最稳。
        const files = readdirSync(tmp).filter((f) => !f.startsWith('.'));
        if (!files.length) throw new Error(`附件下载为空：${mailId}`);
        const filename = files[0];
        const bytes = readFileSync(join(tmp, filename));
        return { filename, mime: mimeOf(filename), bytes };
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
      }
    },

    async markRead(mailId: string): Promise<void> {
      // 无独立 mark-read 命令：记入本地 processed-set，下次 listUnread 跳过。
      // 调用方仅在「整封所有附件处理成功」后调（失败不调 → 该邮件下次重试）。
      const { mid } = parseMailId(mailId);
      if (mid) { processed.add(mid); saveProcessed(processed); }
    },

    async deleteMail(mailId: string): Promise<void> {
      // 删除邮件腾空间（agently-cli 仅提供 +trash 软删，30 天后永久清除）。
      // 两阶段确认：第一次返回 confirmation_token，第二次带 token 才真删。
      const { mid } = parseMailId(mailId);
      if (!mid) return;
      const j1 = await agently(['message', '+trash', '--id', mid]);
      const token = j1?.data?.confirmation_token;
      if (!token) return; // 无需确认（可能已删）
      await agently(['message', '+trash', '--id', mid, '--confirmation-token', token]);
      processed.delete(mid); // 已删，移出本地去重表
      saveProcessed(processed);
    },
  };
}

export function createMailSource(cfg: { provider: string; folder: string; agently_mailbox: string; collect_keywords: string[] }): MailSource {
  return cfg.provider === 'agently'
    ? makeAgentlySource(cfg.agently_mailbox, cfg.collect_keywords)
    : makeFolderSource(cfg.folder);
}
