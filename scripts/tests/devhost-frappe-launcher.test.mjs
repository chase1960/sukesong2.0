// 测试通过 = 在 DevHost 那种「mariadbd / redis-server 只存在于项目自带目录 .frappe-deploy/bin」的环境里，
// 启动器 ops/devhost-frappe/start.mjs 起的 mariadb / redis 子进程能找到那两个可执行文件（不再 spawn ENOENT）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
const launcher=join(repoRoot,'ops','devhost-frappe','start.mjs');

function writeScript(path,body){
  writeFileSync(path,body);
  chmodSync(path,0o755);
}

test('启动器在项目自带 bin 目录里找 mariadbd / redis-server',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'devhost-launcher-'));
  const binDir=join(dir,'.frappe-deploy','bin');
  const benchDir=join(dir,'.frappe-deploy','frappe-bench');
  mkdirSync(binDir,{recursive:true});
  mkdirSync(benchDir,{recursive:true});
  const marker=join(dir,'started.log');

  // 假二进制：把「自己叫什么 + 看到的 PATH」记下来。环境里真装了同名程序也不会写这个标记。
  writeScript(join(binDir,'mariadbd'),`#!/bin/sh\necho "mariadbd $PATH" >> ${JSON.stringify(marker)}\nsleep 30\n`);
  writeScript(join(binDir,'redis-server'),`#!/bin/sh\necho "redis-server $PATH" >> ${JSON.stringify(marker)}\nsleep 30\n`);
  writeScript(join(dir,'.frappe-deploy','fake-bench'),'#!/bin/sh\nsleep 30\n');
  writeFileSync(join(dir,'.frappe-deploy','mariadb.cnf'),'');
  writeFileSync(join(dir,'.frappe-deploy','runtime.json'),JSON.stringify({
    bench_dir:'.frappe-deploy/frappe-bench',
    mariadb_config:'.frappe-deploy/mariadb.cnf',
    bench_executable:'.frappe-deploy/fake-bench',
    runtime_bin_dir:'.frappe-deploy/bin',
    web_port:18099,
    socketio_port:19099,
  }));
  mkdirSync(join(dir,'shangshu-server'),{recursive:true});
  writeFileSync(join(dir,'shangshu-server','package.json'),JSON.stringify({
    name:'launcher-sandbox',version:'0.0.0',scripts:{start:'node -e "setTimeout(()=>{},30000)"'},
  }));

  const child=spawn(process.execPath,[launcher],{cwd:dir,stdio:['ignore','pipe','pipe'],detached:true});
  let output='';
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{output+=chunk;});
  try{
    const deadline=Date.now()+15000;
    let text='';
    while(Date.now()<deadline){
      if(existsSync(marker)){
        text=readFileSync(marker,'utf8');
        if(text.includes('mariadbd')&&text.includes('redis-server'))break;
      }
      await new Promise(done=>setTimeout(done,100));
    }
    assert.match(text,/mariadbd /,`mariadb 子进程没被启动起来。启动器输出：\n${output}`);
    assert.match(text,/redis-server /,`redis 子进程没被启动起来。启动器输出：\n${output}`);
    assert.ok(text.includes(binDir),`子进程 PATH 里没有项目自带 bin 目录 ${binDir}：\n${text}`);
  }finally{
    try{process.kill(-child.pid,'SIGKILL');}catch{}
    rmSync(dir,{recursive:true,force:true});
  }
});
