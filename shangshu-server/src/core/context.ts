// 执行上下文构造：每次运行按当前 runtime_config 重新解析三缝实现。
// 这让「系统配置页改 provider/key 后立即生效」成立——换实现不用重启。
import { loadConfig } from './config.ts';
import { localStore, createBitableStore } from './store.ts';
import { createFileStore } from './files.ts';
import { ExternalServiceManager } from './infra/external.ts';
import type { Context, StateStore, ExternalServices } from './types.ts';
import { currentActor } from './actor.ts';
import { createToolSelector } from './infra/tool-selector.ts';

export function buildContext(log: (msg: string) => void, deps?: { external?: ExternalServices }): Context {
  const cfg = loadConfig();
  const store: StateStore = cfg.store.provider === 'bitable' ? createBitableStore(cfg.feishu) : localStore;
  const external = deps?.external ?? new ExternalServiceManager(cfg);
  const file = createFileStore(cfg.file);
  return { store, file, external, config: cfg, log, actor: currentActor(), selectTool:createToolSelector(cfg.llm) };
}
