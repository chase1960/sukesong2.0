// 种子：消息测试账号（幂等，已存在则重置密码）。密码统一 123。
// 与 mock 演示人设对齐：陈晓(销售)/王强(生产主管)/李婷(销售)/王芳(财务)。
// 存储按当前配置选择（bitable 模式写入飞书 users 表，local 模式写本地）。
import { localStore, createBitableStore } from './core/store.ts';
import { loadConfig } from './core/config.ts';
import { ensureBootstrap, createUser, findUser, hashPassword } from './core/auth/users.ts';

const cfg = loadConfig();
const store = cfg.store.provider === 'bitable' ? createBitableStore(cfg.feishu) : localStore;
console.log(`[seed] store.provider = ${cfg.store.provider}`);

const ACCOUNTS = [
  { username: 'chen', password: '123', role: 'staff', display_name: '陈晓' },
  { username: 'wang', password: '123', role: 'manager', display_name: '王强' },
  { username: 'li', password: '123', role: 'staff', display_name: '李婷' },
  { username: 'fang', password: '123', role: 'finance', display_name: '王芳' },
];

await ensureBootstrap(store);
for (const a of ACCOUNTS) {
  const exist = await findUser(store, a.username).catch(() => null);
  if (exist) {
    await store.update('cognition', 'users', exist.id, { password_hash: hashPassword(a.password) });
    console.log(`[seed] 已重置密码：${a.username}（${a.display_name}）→ 123`);
    continue;
  }
  await createUser(store, a as any);
  console.log(`[seed] 已创建测试账号：${a.username}（${a.display_name} · ${a.role}）密码 123`);
}
console.log('[seed] 消息测试账号就绪：chen/wang/li/fang，密码 123');
