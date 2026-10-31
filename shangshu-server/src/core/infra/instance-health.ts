import {accessSync,constants,existsSync} from 'node:fs';
import {join} from 'node:path';
import {loadConfig,DATA_DIR} from '../config.ts';
import type {StateStore} from '../types.ts';
import {verifyPassword} from '../auth/users.ts';
export async function instanceHealth(store:StateStore) {
  const cfg=loadConfig(),checks:{name:string;ok:boolean;detail:string}[]=[];
  checks.push({name:'本企业资料',ok:!!cfg.enterprise?.name?.trim(),detail:cfg.enterprise?.name?.trim()?'已设置企业名称，仅用于复核提示':'尚未设置企业名称，请在系统配置填写'});
  let users:any[]=[];
  try {users=await store.query('cognition','users');checks.push({name:'事务主库',ok:!!store.guarantees?.transactions,detail:store.guarantees?.transactions?'可读；支持原子事务':'不支持事务，请迁移'});}
  catch(error){checks.push({name:'事务主库',ok:false,detail:(error as Error).message});}
  try {accessSync(cfg.file.local_dir,constants.R_OK|constants.W_OK);checks.push({name:'附件目录',ok:cfg.file.provider==='local',detail:'本地目录可读写'});}
  catch {checks.push({name:'附件目录',ok:false,detail:'目录不存在或无读写权限'});}
  const weak=users.filter(u=>verifyPassword('admin',u.password_hash || ''));
  checks.push({name:'管理员账号',ok:users.some(u=>u.role==='admin' && u.status==='启用') && !weak.length,detail:weak.length?'存在默认密码，请在用户管理修改':'检查启用的管理员与默认密码；不代表完整密码强度审计'});
  checks.push({name:'OCR',ok:cfg.ocr.provider!=='mock',detail:cfg.ocr.provider==='mock'?'仍为模拟抽取，不能用于正式单据':'已配置 '+cfg.ocr.provider+'；需单独执行真实样本验收'});
  checks.push({name:'模型与隐私',ok:!!cfg.llm.base_url && !!cfg.llm.model,detail:'仅检查配置，未调用模型；外部地址可能发送业务数据，需确认客户授权'});
  const dataDir=process.env._SS_DATA_DIR || DATA_DIR;
  checks.push({name:'运行配置',ok:existsSync(join(dataDir,'runtime_config.json')),detail:'正式交付应保存配置并建立外部备份计划'});
  return {ok:checks.every(c=>c.ok),scope:'配置与本地依赖检查；不代替模型连通、恢复演练或业务验收',checks};
}
