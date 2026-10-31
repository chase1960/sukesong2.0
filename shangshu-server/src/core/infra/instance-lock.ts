// 单实例维护锁：备份/恢复时不允许同一目录上的服务同时运行。
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
export function acquireInstanceLock(dataDir:string):()=>void {
  const path=join(resolve(dataDir),'.instance-lock');
  try {mkdirSync(path,{mode:0o700});}
  catch {throw new Error(`实例目录已锁定：${path}。先停服务；若上次异常退出，请核对 owner.json 的 PID 已结束后人工移除锁目录。`);}
  const owner=JSON.stringify({pid:process.pid,started_at:new Date().toISOString()});
  writeFileSync(join(path,'owner.json'),owner,{mode:0o600});let released=false;
  return ()=>{if(released) return;released=true;try{if(readFileSync(join(path,'owner.json'),'utf8')===owner) rmSync(path,{recursive:true});}catch{}};
}
