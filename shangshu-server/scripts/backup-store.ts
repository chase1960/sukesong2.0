import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {SqliteStore} from '../src/core/storage/sqlite.ts';
const args=process.argv.slice(2);
if(!args.includes('--source') || !args.includes('--output')) throw new Error('用法：npm run backup:store -- --source /数据目录/state.sqlite --output /备份目录/backup.sqlite');
const source=resolve(args[args.indexOf('--source')+1]);
const output=resolve(args[args.indexOf('--output')+1]);
if(!existsSync(source)) throw new Error('来源主库不存在');
if(existsSync(output)) throw new Error('备份目标已存在，拒绝覆盖');
const store=new SqliteStore(source);
try {await store.backup(output);console.log(`一致性备份已生成：${output}`);}
finally {await store.close();}
