import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const runtimeConfigPath = resolve(root, '.frappe-deploy', 'runtime.json');

function runNodeOnly() {
  const child = spawn('npm', ['--prefix', 'shangshu-server', 'start'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (!existsSync(runtimeConfigPath)) {
  runNodeOnly();
} else {
  const config = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'));
  const benchDir = resolve(root, config.bench_dir || '.frappe-deploy/frappe-bench');
  const mariadbConfig = resolve(root, config.mariadb_config || '.frappe-deploy/mariadb.cnf');
  const webPort = Number(config.web_port || 18000);
  const socketioPort = Number(config.socketio_port || 19000);
  const bench = resolve(root, config.bench_executable || '.frappe-deploy/bench-tools/bin/bench');
  const nodeBinDir = config.node_bin_dir ? resolve(root, config.node_bin_dir) : '';
  const nodeEnv = nodeBinDir
    ? { PATH: `${nodeBinDir}:${process.env.PATH || ''}` }
    : {};
  // DevHost 上 mariadbd / redis-server 只随项目分发（.frappe-deploy/bin 里的软链），不在系统 PATH 上；
  // 不把它们挂进 PATH，mariadb / redis 子进程一律 spawn ENOENT，整站起不来。
  const runtimeBinDir = resolve(root, config.runtime_bin_dir || '.frappe-deploy/bin');
  const runtimeEnv = {
    PATH: [runtimeBinDir, nodeBinDir, process.env.PATH || ''].filter(Boolean).join(':'),
  };
  const children = new Map();
  let stopping = false;

  function start(name, command, args, options = {}) {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    });
    children.set(name, child);
    child.on('error', (error) => {
      console.error(`[devhost-frappe] ${name} 启动失败：${error.message}`);
      shutdown(1);
    });
    child.on('exit', (code, signal) => {
      children.delete(name);
      if (stopping) return;
      console.error(`[devhost-frappe] ${name} 意外退出（code=${code}, signal=${signal || '-'}）`);
      shutdown(code || 1);
    });
    return child;
  }

  function shutdown(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) child.kill('SIGTERM');
    const deadline = setTimeout(() => process.exit(exitCode), 8000);
    deadline.unref();
    Promise.allSettled([...children.values()].map((child) => new Promise((done) => child.once('exit', done))))
      .finally(() => process.exit(exitCode));
  }

  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));

  start('mariadb', 'mariadbd', [`--defaults-file=${mariadbConfig}`], { env: runtimeEnv });
  start('redis-cache', 'redis-server', ['config/redis_cache.conf'], { cwd: benchDir, env: runtimeEnv });
  start('redis-queue', 'redis-server', ['config/redis_queue.conf'], { cwd: benchDir, env: runtimeEnv });
  start('socket.io', bench, ['socketio'], { cwd: benchDir, env: runtimeEnv });
  start('frappe-web', bench, ['serve', '--port', String(webPort), '--noreload'], { cwd: benchDir, env: runtimeEnv });
  // 领域定时任务（hooks.scheduler_events）需要调度器入队 + worker 执行；缺任一进程则任务永不触发。
  start('frappe-schedule', bench, ['schedule'], { cwd: benchDir, env: runtimeEnv });
  start('frappe-worker', bench, ['worker', '--queue', 'short,default,long'], { cwd: benchDir, env: runtimeEnv });
  start('shangshu-node', 'npm', ['--prefix', 'shangshu-server', 'start'], {
    cwd: root,
    env: {
      ...nodeEnv,
      SHANGSHU_PLATFORM_MODE: 'frappe',
      FRAPPE_UPSTREAM: `http://127.0.0.1:${webPort}`,
      FRAPPE_SOCKETIO_UPSTREAM: `http://127.0.0.1:${socketioPort}`,
    },
  });
}
