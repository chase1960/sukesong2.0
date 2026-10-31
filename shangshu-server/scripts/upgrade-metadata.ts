// 明确升级内置元数据，默认只列计划。自定义对象/流程不覆盖；旧版本先保存到不可变历史。
import { createHash } from 'node:crypto';
import { getRuntimeStore } from '../src/core/store.ts';
import { getPresetObjectTypes, registerPresetObjects } from '../src/core/objects.ts';
import { getPresetDocTypes, registerPresetDocTypes } from '../src/core/doctypes.ts';
import { getPresetWorkflows } from '../src/flows/presets.ts';
import { registerInvoiceCapabilities } from '../src/capabilities/invoice.ts';
import { registerObjectTools } from '../src/capabilities/object-tools.ts';   // flow.note（图流程路标能力）随对象工具注册
import { registerDocExtractTools } from '../src/capabilities/doc-extract.ts';
import { upsertMetaEntry, type MetaKind } from '../src/core/meta-store.ts';
import { atomic } from '../src/core/storage/transaction.ts';
import {acquireInstanceLock} from '../src/core/infra/instance-lock.ts';
import {DATA_DIR} from '../src/core/config.ts';
const apply=process.argv.includes('--apply');
if(apply) process.once('exit',acquireInstanceLock(process.env._SS_DATA_DIR || DATA_DIR));
const store=getRuntimeStore();
if(!store.guarantees?.transactions) throw new Error('请先完成 SQLite 主库迁移并切换配置');
registerInvoiceCapabilities();registerDocExtractTools();registerObjectTools();registerPresetObjects();registerPresetDocTypes();
const entries=[...getPresetObjectTypes().map(payload=>({kind:'object' as MetaKind,payload})),...getPresetDocTypes().map(payload=>({kind:'doctype' as MetaKind,payload})),...getPresetWorkflows().map(payload=>({kind:'flow' as MetaKind,payload}))];
const planned=await Promise.all(entries.map(async entry=>({entry,active:(await store.query('cognition','meta_registry',{kind:entry.kind,key:entry.payload.id}))[0]})));
console.log(JSON.stringify({apply,plan:planned.map(({entry,active})=>({kind:entry.kind,key:entry.payload.id,from:active?.version || 0,to:(active?.version || 0)+1}))},null,2));
if(apply) {
  await atomic(store,async tx=>{
    // 所有既有条目保留基线；只替换下面明确列出的内置项。
    for(const row of await tx.query('cognition','meta_registry')) {
      const id=`${row.kind}:${row.key}:${row.version}`;
      if(!(await tx.query('cognition','meta_revisions',{id})).length) {
        const payload=JSON.parse(row.payload);
        await tx.insert('cognition','meta_revisions',{id,kind:row.kind,key:row.key,version:row.version,payload,hash:createHash('sha256').update(JSON.stringify(payload)).digest('hex')});
      }
    }
    for(const {entry,active} of planned) {
      await upsertMetaEntry(tx,entry.kind,entry.payload.id,entry.payload,active?.version || 0);
    }
  });
  console.log('预置元数据升级完成。自定义配置未替换；请重启应用并验收。');
}
