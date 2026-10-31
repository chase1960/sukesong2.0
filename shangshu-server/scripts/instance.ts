// 本地交付 CLI。拒绝覆盖、显式停机备份、校验后恢复到新目录。
import {mkdirSync,existsSync,readFileSync,writeFileSync,readdirSync,lstatSync,copyFileSync,chmodSync,renameSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '../src/core/storage/sqlite.ts';
import {acquireInstanceLock} from '../src/core/infra/instance-lock.ts';
const args=process.argv.slice(2),command=args[0];
function arg(name:string):string {const i=args.indexOf(name);if(i<0 || !args[i+1] || args[i+1].startsWith('--')) throw new Error('缺少参数 '+name);return resolve(args[i+1]);}
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
function list(dir:string,prefix=''):string[] {
  return readdirSync(join(dir,prefix)).flatMap(name=>{
    const rel=join(prefix,name),st=lstatSync(join(dir,rel));
    if(st.isSymbolicLink()) throw new Error('备份不允许符号链接：'+rel);
    if(st.isDirectory()) return list(dir,rel);
    if(!st.isFile()) throw new Error('不支持的文件类型：'+rel);return [rel];
  });
}
function within(parent:string,path:string):boolean {const rel=relative(parent,path);return !rel || (!rel.startsWith('..') && !isAbsolute(rel));}
function publishDir(target:string,fn:(staging:string)=>Promise<void>) {
  if(existsSync(target)) throw new Error('目标目录已存在，拒绝覆盖：'+target);
  const stage=target+'.staging-'+randomUUID();mkdirSync(stage,{recursive:true,mode:0o700});
  return fn(stage).then(()=>{if(existsSync(target)) throw new Error('目标目录已存在');renameSync(stage,target);}).catch(error=>{rmSync(stage,{recursive:true,force:true});throw error;});
}
if(command==='setup') {
  const target=arg('--data-dir'),password=process.env.SS_INITIAL_ADMIN_PASSWORD || '';
  if(password.length<12 || password==='admin') throw new Error('请通过环境变量 SS_INITIAL_ADMIN_PASSWORD 设置至少 12 位初始密码；不要放进命令参数');
  process.env._SS_DATA_DIR=target;
  const {DEFAULT_CONFIG}=await import('../src/core/config.ts');
  const {createUser}=await import('../src/core/auth/users.ts');
  await publishDir(target,async stage=>{
    for(const name of ['files','inbox']) mkdirSync(join(stage,name),{mode:0o700});
    const cfg=structuredClone(DEFAULT_CONFIG);cfg.store.provider='sqlite';cfg.file.local_dir=join(target,'files');cfg.mail.folder=join(target,'inbox');cfg.llm.base_url='http://127.0.0.1:11434/v1';cfg.website.base_url='';cfg.server.admin_password='';cfg.ocr.confidence_auto_book=0;
    writeFileSync(join(stage,'runtime_config.json'),JSON.stringify(cfg,null,2),{mode:0o600});
    const store=new SqliteStore(join(stage,'state.sqlite'));try{await createUser(store,{username:'admin',password,role:'admin',display_name:'管理员'});}finally{await store.close();}
    chmodSync(join(stage,'state.sqlite'),0o600);
  });
  console.log('本地实例已初始化。OCR 仍为 mock，需配置与样本验收；未启动服务。');
} else if(command==='backup') {
  const source=arg('--data-dir'),target=arg('--output');
  if(within(source,target)) throw new Error('备份目录必须在数据目录之外');
  const unlock=acquireInstanceLock(source);
  try {
    const cfg=JSON.parse(readFileSync(join(source,'runtime_config.json'),'utf8'));
    if(!['local','sqlite'].includes(cfg.store?.provider) || cfg.file?.provider!=='local' || resolve(cfg.file.local_dir)!==join(source,'files') || cfg.mail?.provider!=='folder' || resolve(cfg.mail.folder)!==join(source,'inbox')) throw new Error('整实例备份要求本地 SQLite、files 和 inbox 标准目录；其他适配器请另行制定备份方案');
    if(!existsSync(join(source,'state.sqlite'))) throw new Error('主库不存在');
    await publishDir(target,async stage=>{
      const store=new SqliteStore(join(source,'state.sqlite'));try{await store.backup(join(stage,'state.sqlite'));}finally{await store.close();}
      for(const rel of list(source).filter(p=>p.split(/[\\/]/)[0]!=='.instance-lock' && !['state.sqlite','state.sqlite-wal','state.sqlite-shm'].includes(p))) {
        const dst=join(stage,rel);mkdirSync(resolve(dst,'..'),{recursive:true,mode:0o700});copyFileSync(join(source,rel),dst);chmodSync(dst,0o600);
      }
      const files=Object.fromEntries(list(stage).map(p=>[p,hash(join(stage,p))]));
      writeFileSync(join(stage,'manifest.json'),JSON.stringify({version:1,created_at:new Date().toISOString(),files},null,2),{mode:0o600});
      chmodSync(join(stage,'state.sqlite'),0o600);
    });console.log('停机整实例备份完成（含附件与配置密钥，请离机加密保管）。');
  } finally {unlock();}
} else if(command==='restore') {
  const source=arg('--source'),target=arg('--data-dir');
  if(within(source,target) || within(target,source)) throw new Error('恢复来源和目标不能互相包含');
  if(existsSync(target)) throw new Error('恢复目标必须是新目录');
  const manifest=JSON.parse(readFileSync(join(source,'manifest.json'),'utf8'));
  if(manifest.version!==1 || !manifest.files?.['state.sqlite'] || !manifest.files?.['runtime_config.json']) throw new Error('备份清单无效');
  const actual=list(source).filter(p=>p!=='manifest.json').sort();
  if(JSON.stringify(actual)!==JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('文件清单不匹配');
  for(const [rel,expected] of Object.entries(manifest.files)) {const path=resolve(source,rel);if(!within(source,path) || hash(path)!==expected) throw new Error('文件校验失败：'+rel);}
  const db=new DatabaseSync(join(source,'state.sqlite'),{readOnly:true});try{const check=db.prepare('PRAGMA integrity_check').get() as any;if(check.integrity_check!=='ok') throw new Error('数据库完整性检查失败');}finally{db.close();}
  if(!args.includes('--apply')) {console.log('校验通过，dry-run 未写入；添加 --apply 恢复到新目录。');}
  else await publishDir(target,async stage=>{
    for(const rel of actual) {const dst=join(stage,rel);mkdirSync(resolve(dst,'..'),{recursive:true,mode:0o700});copyFileSync(join(source,rel),dst);chmodSync(dst,0o600);}
    for(const name of ['files','inbox']) mkdirSync(join(stage,name),{recursive:true,mode:0o700});
    const path=join(stage,'runtime_config.json'),cfg=JSON.parse(readFileSync(path,'utf8'));cfg.file.local_dir=join(target,'files');cfg.mail.folder=join(target,'inbox');
    writeFileSync(path,JSON.stringify(cfg,null,2),{mode:0o600});console.log('恢复完成；请用新目录启动并核对数据，不会自动切换旧实例。');
  });
} else if(command==='doctor') {
  process.env._SS_DATA_DIR=arg('--data-dir');
  const {getRuntimeStore}=await import('../src/core/store.ts');const {instanceHealth}=await import('../src/core/infra/instance-health.ts');
  const path=join(process.env._SS_DATA_DIR,'state.sqlite');if(!existsSync(path)) throw new Error('数据库不存在；请先初始化或迁移');
  const store=getRuntimeStore();const result=await instanceHealth(store);console.log(JSON.stringify(result,null,2));await (store as any).close?.();if(!result.ok) process.exitCode=2;
} else throw new Error('用法：instance.ts setup|doctor|backup|restore；详见本地交付文档');
