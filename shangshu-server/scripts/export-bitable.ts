// 只读导出：不经会自动建表/补列的旧适配器；未知表必须显式映射，禁止静默丢表。
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/core/config.ts';
import { listTables, listRecords } from '../src/core/feishu.ts';
import { decodeBitableRecord } from '../src/core/store.ts';
const args=process.argv.slice(2);
const option=(name:string)=>args[args.indexOf(name)+1];
if(!args.includes('--output')) throw new Error('用法：tsx scripts/export-bitable.ts --output /绝对路径/snapshot.json [--table-map mappings.json]');
const cfg=loadConfig();
if(!cfg.feishu.bitable_app_token) throw new Error('缺少来源飞书配置');
const mapping:Record<string,string>=args.includes('--table-map') ? JSON.parse(readFileSync(option('--table-map'),'utf8')) : {};
const tables:Record<string,any[]>={}; const raw_tables:Record<string,unknown>={};
for(const table of await listTables(cfg.feishu)) {
  const logical=mapping[table.table_id] || (table.table_id===cfg.feishu.invoices_table_id ? 'business.invoices' : table.table_id===cfg.feishu.ledger_table_id ? 'business.ledger' : table.name.replace('__','.'));
  if(!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(logical)) throw new Error(`表 ${table.name} 缺少明确映射，请配置 --table-map`);
  if(tables[logical]) throw new Error(`多个来源表映射到 ${logical}，须先人工核对`);
  const [layer,entity]=logical.split('.');
  const records=await listRecords(cfg.feishu,table.table_id);
  raw_tables[table.table_id]={name:table.name,records};
  tables[logical]=records.map(row=>decodeBitableRecord(layer,entity,row));
}
const snapshot={format:1,exported_at:new Date().toISOString(),tables,raw_tables,checksum:createHash('sha256').update(JSON.stringify(tables)).digest('hex')};
writeFileSync(option('--output'),JSON.stringify(snapshot,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({tables:Object.keys(tables).length,records:Object.values(tables).reduce((n,rows)=>n+rows.length,0),output:option('--output')}));
