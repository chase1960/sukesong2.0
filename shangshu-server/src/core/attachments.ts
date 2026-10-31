// 附件关联是受管状态，和收票一起提交；旧 attachments.json 只作迁移读取。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { getRuntimeStore } from './store.ts';
import type { StateStore } from './types.ts';
interface Entry { token:string; filename:string; mime:string; uploaded:boolean }
export async function attachLocal(recordId:string,info:{token:string;filename:string;mime:string},store:StateStore):Promise<void> {
  const [old]=await store.query('cognition','attachments',{id:recordId});
  if(old) await store.update('cognition','attachments',recordId,info);
  else await store.insert('cognition','attachments',{id:recordId,...info,uploaded:false});
}
export async function getLocalToken(recordId:string,store=getRuntimeStore()):Promise<string|undefined> {
  const [record]=await store.query('cognition','attachments',{id:recordId});
  if(record) return record.token;
  const path=join(process.env._SS_DATA_DIR || DATA_DIR,'attachments.json');
  if(!existsSync(path)) return undefined;
  // 解析失败必须显式报错，不能把损坏数据伪装成空库。
  return (JSON.parse(readFileSync(path,'utf8')) as Record<string,Entry>)[recordId]?.token;
}
