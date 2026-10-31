import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SqliteStore} from '../../src/core/storage/sqlite.ts';
import {acquireInstanceLock} from '../../src/core/infra/instance-lock.ts';
it('本地初始化→带附件整实例备份→校验→新目录恢复；拒绝运行中备份、覆盖和篡改',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ss-instance-')),source=join(root,'source'),backup=join(root,'backup'),target=join(root,'restored');
  const cli=(...args:string[])=>spawnSync(process.execPath,['--import','tsx','scripts/instance.ts',...args],{cwd:new URL('../../',import.meta.url),encoding:'utf8',env:{...process.env,SS_INITIAL_ADMIN_PASSWORD:'isolated-test-password'}});
  const setup=cli('setup','--data-dir',source);assert.equal(setup.status,0,setup.stderr);assert.ok(!setup.stdout.includes('isolated-test-password'));
  assert.notEqual(cli('setup','--data-dir',source).status,0);
  writeFileSync(join(source,'files','receipt.txt'),'原始单据');
  const store=new SqliteStore(join(source,'state.sqlite'));await store.insert('business','ledger',{id:'e1',total_amount:10});await store.close();
  const release=acquireInstanceLock(source);try{assert.notEqual(cli('backup','--data-dir',source,'--output',backup).status,0);}finally{release();}
  const saved=cli('backup','--data-dir',source,'--output',backup);assert.equal(saved.status,0,saved.stderr);
  assert.equal(cli('restore','--source',backup,'--data-dir',target).status,0);assert.equal(existsSync(target),false);
  const restored=cli('restore','--source',backup,'--data-dir',target,'--apply');assert.equal(restored.status,0,restored.stderr);
  assert.equal(readFileSync(join(target,'files','receipt.txt'),'utf8'),'原始单据');
  assert.equal(JSON.parse(readFileSync(join(target,'runtime_config.json'),'utf8')).file.local_dir,join(target,'files'));
  const copy=new SqliteStore(join(target,'state.sqlite'));assert.equal((await copy.query('business','ledger'))[0].total_amount,10);assert.equal((await copy.query('cognition','users'))[0].username,'admin');await copy.close();
  assert.notEqual(cli('restore','--source',backup,'--data-dir',target,'--apply').status,0);
  writeFileSync(join(backup,'files','receipt.txt'),'篡改');assert.notEqual(cli('restore','--source',backup,'--data-dir',join(root,'bad'),'--apply').status,0);assert.equal(existsSync(join(root,'bad')),false);
});
