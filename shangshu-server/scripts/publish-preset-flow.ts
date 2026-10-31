// 显式发布某个预置流程到 meta_registry（代码升级带新预置/修订后用）：npx tsx scripts/publish-preset-flow.ts <flowId>
import { getRuntimeStore } from '../src/core/store.ts';
import { registerPresetWorkflows, getPresetWorkflows } from '../src/flows/presets.ts';
import { registerObjectTools } from '../src/capabilities/object-tools.ts';
import { upsertMetaEntry, bootstrapMetadata } from '../src/core/meta-store.ts';
const flowId = process.argv[2];
if (!flowId) throw new Error('用法: npx tsx scripts/publish-preset-flow.ts <flowId>');
registerObjectTools();
registerPresetWorkflows();
const store = getRuntimeStore();
if (!store.guarantees?.transactions) throw new Error('请先完成 SQLite 主库迁移');
await bootstrapMetadata(store);
const tpl = getPresetWorkflows().find(t => t.id === flowId);
if (!tpl) throw new Error(`预置流程不存在: ${flowId}`);
const [active] = await store.query('cognition', 'meta_registry', { kind: 'flow', key: flowId });
await upsertMetaEntry(store, 'flow', flowId, tpl, active?.version || 0);
console.log(`已发布 ${flowId} → v${(active?.version || 0) + 1}`);
