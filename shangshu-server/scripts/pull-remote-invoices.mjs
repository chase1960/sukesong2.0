#!/usr/bin/env node
// 从公网测试环境拉发票 + 记账 + 台账 + 原图 PDF 到本地 store（local 模式演示用）。
// 用法：BASE=... SS_USER=admin SS_PASS=admin123 node scripts/pull-remote-invoices.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const STORE = join(DATA, 'store.json');
const FILES = join(DATA, 'files');
const ATTACH = join(DATA, 'attachments.json');
const BASE = (process.env.BASE || 'https://shangshu-sys-test.dev.lingeringtek.cn').replace(/\/$/, '');
const USER = process.env.SS_USER || 'admin';
const PASS = process.env.SS_PASS || 'admin123';

async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`登录失败：${body.error || '未知'}`);
  const raw = res.headers.getSetCookie?.() || [];
  const cookie = raw.length
    ? raw.map(c => c.split(';')[0]).join('; ')
    : (res.headers.get('set-cookie') || '').split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
  if (!cookie) throw new Error('登录成功但未拿到 session cookie');
  return cookie;
}

async function api(path, cookie, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.arrayBuffer();
}

function readJson(p, fb) {
  if (!existsSync(p)) return fb;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fb; }
}

function backup(p) {
  if (!existsSync(p)) return;
  const bak = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(p, bak);
  console.log(`  备份 ${p} → ${bak.split('/').pop()}`);
}

async function main() {
  console.log(`拉取 ${BASE} …`);
  const jar = await login();

  const invoices = await api('/api/invoices', jar);
  const ledger = (await api('/api/ledger', jar)).list || [];
  const payables = (await api('/api/payables', jar)).list || [];
  const receivables = (await api('/api/receivables', jar)).list || [];
  console.log(`远端：发票 ${invoices.length} · 记账 ${ledger.length} · 应付 ${payables.length} · 应收 ${receivables.length}`);

  if (!existsSync(FILES)) mkdirSync(FILES, { recursive: true });
  backup(STORE);
  backup(ATTACH);

  const store = readJson(STORE, {});
  const attach = readJson(ATTACH, {});
  const byId = new Map((store['business.invoices'] || []).map(r => [r.id, r]));
  const remoteIds = new Set(invoices.map(i => i.id));

  let filesOk = 0, filesSkip = 0;
  for (const inv of invoices) {
    let localToken = inv.file_token;
    const entry = attach[inv.id];
    if (entry?.token && existsSync(join(FILES, entry.token))) {
      localToken = entry.token;
      filesSkip++;
    } else if (inv.file_token) {
      try {
        const buf = await api(`/api/files/${encodeURIComponent(inv.file_token)}`, jar);
        localToken = `${randomUUID()}.pdf`;
        writeFileSync(join(FILES, localToken), Buffer.from(buf));
        attach[inv.id] = {
          token: localToken,
          filename: `${inv.invoice_no || inv.id}.pdf`,
          mime: 'application/pdf',
          uploaded: false,
        };
        filesOk++;
      } catch (e) {
        console.warn(`  ⚠ 附件 ${inv.invoice_no}: ${e.message}`);
      }
    }
    byId.set(inv.id, { ...inv, file_token: localToken || inv.file_token || '' });
  }

  store['business.invoices'] = [...byId.values()];
  // 记账/台账以远端为准合并（按 id 去重，远端覆盖）
  const mergeById = (key, rows) => {
    const m = new Map((store[key] || []).filter(r => !remoteIds.has(r.invoice_id)).map(r => [r.id, r]));
    for (const r of rows) m.set(r.id, r);
    store[key] = [...m.values()];
  };
  mergeById('business.ledger', ledger);
  mergeById('business.payables', payables);
  mergeById('business.receivables', receivables);

  writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf-8');
  writeFileSync(ATTACH, JSON.stringify(attach, null, 2), 'utf-8');

  const final = store['business.invoices'] || [];
  const st = {};
  final.forEach(i => { st[i.status] = (st[i.status] || 0) + 1; });
  console.log(`✓ 本地 store：发票 ${final.length}（${JSON.stringify(st)}）`);
  console.log(`✓ 附件：新下载 ${filesOk} · 已有跳过 ${filesSkip}`);
  console.log(`✓ 记账 ${(store['business.ledger']||[]).length} · 应付 ${(store['business.payables']||[]).length} · 应收 ${(store['business.receivables']||[]).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
