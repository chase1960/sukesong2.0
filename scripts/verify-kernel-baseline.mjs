#!/usr/bin/env node

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argsOf(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

export function testOutputFailed(output) {
  const text = String(output || '');
  return /(^|\n)(?:FAILED\b|ERROR:\s|Traceback \(most recent call last\):|Testing is disabled for the site!)/m.test(text);
}

function tail(text, lines = 16) {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 || (options.test && testOutputFailed(output))) {
    throw new Error(`${basename(command)} ${commandArgs.join(' ')} 失败\n${tail(output, 60)}`);
  }
  if (options.summary) console.log(`[kernel-gate] ${options.summary}\n${tail(output)}`);
  return output;
}

function assertSafeRunId(value) {
  if (!/^[a-z0-9][a-z0-9-]{2,30}$/.test(value)) throw new Error('run-id 只能使用 3-31 位小写字母、数字和连字符');
  return value;
}

function newest(path, suffix) {
  const candidates = readdirSync(path)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(path, name))
    .sort();
  if (!candidates.length) throw new Error(`备份产物缺失：${suffix}`);
  return candidates.at(-1);
}

export function runGate(argv = process.argv.slice(2)) {
  const args = argsOf(argv);
  const benchDir = resolve(args['bench-dir'] || process.env.FRAPPE_BENCH_DIR || join(ROOT, '.frappe-runtime', 'frappe-bench'));
  const bench = resolve(args.bench || join(benchDir, '..', 'bench-venv', 'bin', 'bench'));
  const rootUser = args['db-root-username'] || process.env.FRAPPE_DB_ROOT_USERNAME;
  const rootPassword = process.env.FRAPPE_DB_ROOT_PASSWORD;
  const runId = assertSafeRunId(args['run-id'] || `local-${process.pid}`);
  const keepSites = Boolean(args['keep-sites']);
  if (!existsSync(bench) || !existsSync(benchDir)) throw new Error('Frappe bench 路径不存在');
  if (!rootUser || rootPassword === undefined) {
    throw new Error('必须设置 FRAPPE_DB_ROOT_USERNAME 与 FRAPPE_DB_ROOT_PASSWORD；密码不接受命令行参数');
  }
  for (const app of ['shangshu_core', 'shangshu_finance']) {
    if (!existsSync(join(benchDir, 'apps', app))) throw new Error(`bench 缺少待验证 App：${app}`);
  }
  const combinations = [
    { id: 'core', apps: ['shangshu_core'] },
    { id: 'finance', apps: ['shangshu_core', 'shangshu_finance'] },
  ];
  const created = [];
  const dbArgs = ['--db-root-username', rootUser, '--db-root-password', rootPassword];
  const benchRun = (items, options) => run(bench, items, { cwd: benchDir, ...options });

  try {
    for (const combo of combinations) {
      const site = `k3-${runId}-${combo.id}.localhost`;
      if (existsSync(join(benchDir, 'sites', site))) throw new Error(`拒绝覆盖已存在站点：${site}`);
      benchRun(['new-site', site, ...dbArgs, '--admin-password', 'k3-ephemeral-only', '--mariadb-user-host-login-scope', 'localhost']);
      created.push(site);
      for (const app of combo.apps) benchRun(['--site', site, 'install-app', app]);
      benchRun(['--site', site, 'migrate']);
      benchRun(['--site', site, 'migrate']);
      benchRun([
        '--site', site, 'execute', 'shangshu_core.release.verify_kernel_baseline',
        '--kwargs', JSON.stringify({ expected_apps: JSON.stringify(combo.apps) }),
      ], { summary: `${combo.id}：全新安装 + 重复 migrate 通过` });
    }

    const both = `k3-${runId}-finance.localhost`;
    benchRun(['--site', both, 'set-config', 'allow_tests', '1', '--parse']);
    benchRun(['--site', both, 'run-tests', '--app', 'shangshu_core'], { test: true, summary: 'finance + IP：core 回归通过' });
    benchRun(['--site', both, 'run-tests', '--app', 'shangshu_finance'], { test: true, summary: 'finance + IP：finance 回归通过' });

    const backupDir = mkdtempSync(join(tmpdir(), 'shangshu-k3-backup-'));
    try {
      benchRun(['--site', both, 'backup', '--with-files', '--backup-path', backupDir]);
      const database = newest(backupDir, '.sql.gz');
      const publicFiles = newest(backupDir, '-files.tar');
      const privateFiles = newest(backupDir, '-private-files.tar');
      benchRun([
        '--site', both, 'restore', database, '--force', ...dbArgs,
        '--with-public-files', publicFiles, '--with-private-files', privateFiles,
      ]);
      benchRun(['--site', both, 'migrate']);
      benchRun(['--site', both, 'clear-cache']);
      benchRun([
        '--site', both, 'execute', 'shangshu_core.release.verify_kernel_baseline',
        '--kwargs', JSON.stringify({ expected_apps: JSON.stringify(combinations.at(-1).apps) }),
      ], { summary: '备份恢复 + 新进程健康检查通过' });
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
    }

    console.log(`[kernel-gate] 通过：${combinations.length} 种组合、重复迁移、双域回归、备份恢复和重启后健康检查`);
  } finally {
    if (!keepSites) {
      for (const site of created.reverse()) {
        benchRun(['drop-site', site, '--force', '--no-backup', ...dbArgs]);
      }
    } else if (created.length) {
      console.log(`[kernel-gate] 保留临时站点：${created.join(', ')}`);
    }
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    runGate();
  } catch (error) {
    console.error(`[kernel-gate] 未通过：${error.message}`);
    process.exitCode = 1;
  }
}
