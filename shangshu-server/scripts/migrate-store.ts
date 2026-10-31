// 离线迁移：默认只校验；--apply 才生成新主库。不改来源文件和 runtime_config。
import { readFileSync, existsSync, linkSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { SqliteStore } from '../src/core/storage/sqlite.ts';
import {acquireInstanceLock} from '../src/core/infra/instance-lock.ts';
const args=process.argv.slice(2);
const option=(name:string)=>args[args.indexOf(name)+1];
if(!args.includes('--source') || !args.includes('--target-dir')) throw new Error('用法：npm run migrate:store -- --source snapshot.json --target-dir /绝对数据目录 [--apply]');
const source=resolve(option('--source')); const dir=resolve(option('--target-dir'));
const raw=JSON.parse(readFileSync(source,'utf8'));
const snapshot=raw.tables || raw;
if(!snapshot || typeof snapshot!=='object' || Array.isArray(snapshot) || !Object.keys(snapshot).length) throw new Error('快照必须包含至少一张具名表');
if(raw.checksum && raw.checksum!==createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')) throw new Error('快照校验和错误');
let total=0;
for(const [name,rows] of Object.entries(snapshot)) {
  if(!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name) || !Array.isArray(rows)) throw new Error(`无效表快照: ${name}`);
  const ids=new Set();
  for(const row of rows) {
    if(!row || typeof row.id!=='string' || !row.id || ids.has(row.id)) throw new Error(`记录 ID 缺失或重复: ${name}`);
    ids.add(row.id);
  }
  total+=rows.length;
}
console.log(JSON.stringify({source,tables:Object.keys(snapshot).length,records:total,apply:args.includes('--apply')}));
if(args.includes('--apply')) {
  const target=join(dir,'state.sqlite');
  if(existsSync(target)) throw new Error('目标主库已存在，拒绝覆盖');
  mkdirSync(dir,{recursive:true});
  process.once('exit',acquireInstanceLock(dir));
  const stage=join(dir,`state.sqlite.migrate-${randomUUID()}`);
  const store=new SqliteStore(stage);
  try {
    await store.transaction(async tx=>{
      for(const [name,rows] of Object.entries(snapshot)) {
        const [layer,table]=name.split('.');
        for(const row of rows as any[]) await tx.insert(layer,table,row);
        const actual=await tx.query(layer,table);
        if(actual.length!==(rows as any[]).length) throw new Error(`迁移计数不一致: ${name}`);
        for(let i=0;i<actual.length;i++) {
          const {_version:ignored,...expected}=(rows as any[])[i];
          const {_version:version,...value}=actual[i];
          if(JSON.stringify(value)!==JSON.stringify(expected)) throw new Error(`迁移内容不一致: ${name}/${expected.id}`);
        }
      }
    });
    await store.close();
    // 同文件系统排他发布，不覆盖并发创建的目标文件。
    linkSync(stage,target); unlinkSync(stage);
    console.log('迁移完成，原数据未修改。核验业务数据与备份后，人工将 provider 切换为 sqlite。');
  } catch(error) {
    try { await store.close(); } catch {}
    console.error(`迁移未发布，诊断文件保留于 ${stage}`);
    throw error;
  }
}
