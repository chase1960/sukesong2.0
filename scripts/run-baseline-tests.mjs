// One inventory, serial execution, bounded per-file runs. Live-site scripts are listed, never auto-run.
import {readdirSync,readFileSync,mkdirSync,mkdtempSync,writeFileSync,openSync,closeSync,rmSync,existsSync} from 'node:fs';
import {resolve,relative,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isSymbolicLink()?[]:e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);

/**
 * 域的判据目录是**发现的**，不是写死的（2026-10-24 15:1x 实测撞出来的）。
 *
 * **为什么**：原来那行目录数组**写死**了每个域的判据目录 ⇒ 域被拆走／没装 ⇒
 * 跑批**自己在装载期就炸**（`ENOENT … scandir '…/domains/<域>/tests'`）
 * ⇒ 加域要改跑批工具、拆域跑批直接崩。
 * ⇒ 现在按 `shangshu-web/js/domains/<域>/tests` **发现**：
 * 域目录在就收进来，不在就**跳过**（不崩）；**少一个域不许少跑别的域的判据**。
 */
export function domainTestDirs(base=root){
  const domainsRoot=join(base,'shangshu-web/js/domains');
  if(!existsSync(domainsRoot))return [];
  return readdirSync(domainsRoot,{withFileTypes:true})
    .filter(entry=>entry.isDirectory())
    .map(entry=>relative(base,join(domainsRoot,entry.name,'tests')))
    .filter(rel=>existsSync(join(base,rel)))
    .sort();
}

/**
 * **域判据**（`frappe_apps/<域>/<域>/tests/`）的目录也是**发现的**，不是写死的。
 *
 * **为什么**（2026-10-25 实测撞出来的）：整趟基线原来把 `frappe_apps/**` 下的判据
 * **整包**归成「须装 Frappe 站点」⇒ **一条都没进整趟基线**。
 * 而实测：152 个域判据文件里 **97 个离线就能真跑**（814 条真断言），
 * 只有 **54 个**真的要真站点 ⇒ 「163 个全须上站」这句话**是错的**。
 * ⇒ 域判据要**进清单**、**逐个文件真跑**；跑不动的**如实标成须上站**（写明缺什么）。
 */
export function frappeDomainTestDirs(base=root){
  const appsRoot=join(base,'frappe_apps');
  if(!existsSync(appsRoot))return [];
  const dirs=[];
  for(const app of readdirSync(appsRoot,{withFileTypes:true})){
    if(!app.isDirectory())continue;
    const appRoot=join(appsRoot,app.name);
    for(const sub of readdirSync(appRoot,{withFileTypes:true})){
      if(!sub.isDirectory())continue;
      const rel=relative(base,join(appRoot,sub.name,'tests'));
      if(existsSync(join(base,rel)))dirs.push(rel);
    }
  }
  return dirs.sort();
}

/**
 * 一个域判据文件**怎么跑**。
 *
 * ⚠️ **必须是 `python3 -m unittest <模块>`，不是 `python3 <文件>`**（2026-10-25 实测）：
 * 152 个域判据里只有 **104 个**带 `unittest.main()`，其余 **48 个**直跑会
 * **空跑装绿**（进程退出 0、**一条断言没跑**）⇒ 那叫假绿，不叫通过。
 * ⇒ 用模块名跑：一个文件一个独立进程（cwd＝域根），unittest 自己收集用例。
 */
export function domainTestModule(file){
  const parts=file.split('/');
  const app=parts[1],pkg=parts[2];
  const stem=parts[parts.length-1].replace(/\.py$/,'');
  const module=`${pkg}.tests.${stem}`;
  return {app,module,cwd:`frappe_apps/${app}`,args:['-m','unittest',module]};
}

/** 缺 frappe 的两种说法（`frappe` 本身 / `frappe.utils` 等子模块）。 */
const MISSING_FRAPPE=/No module named 'frappe(?:\.[A-Za-z0-9_.]+)?'/;
/** 「模块在**导入期**就炸了」—— 只有导入期缺 frappe 才算「须上站」。 */
const IMPORT_FAILED=/Failed to import test module|unittest\.loader\._FailedTest/;

/**
 * 域判据跑完之后**怎么判**（2026-10-25）。
 *
 * **三条不许**：
 * ① **跑到 0 条用例 ⇒ 判红**（不许装绿 —— 那是假绿）；
 * ② **真跑了用例且有错 ⇒ 判红**（不许把真缺陷当「须上站」放过）；
 * ③ **只有「导入期缺 frappe」才算「须上站」**，并且**写明缺什么、站上怎么跑**
 *    （不许含糊成一句「浏览器脚本」—— 那会把真缺陷藏起来）。
 */
export function classifyDomainTestResult(result,output,context={}){
  if(result.status==='TIMEOUT'||result.status==='BLOCKED')return result;
  const text=String(output||'');
  const ran=(text.match(/^Ran (\d+) tests?/m)||[])[1];
  const ranCount=ran?Number(ran):0;
  if(MISSING_FRAPPE.test(text)&&IMPORT_FAILED.test(text)){
    return {...result,status:'NEEDS_SITE',ran:ranCount,
      reason:`缺真 frappe（离线跑不了）—— 站上跑法：scripts/run-frappe-baseline.py（容器内隔离站 baseline-auto-*.localhost，bench --site <站> run-tests --module ${context.module||'?'}）`};
  }
  if(ranCount===0)
    return {...result,status:'FAIL',ran:0,reason:'跑到 0 条用例，不许算绿（断言一条都没跑）'};
  if(/^OK/m.test(text))
    return {...result,status:'PASS',ran:ranCount};
  const line=text.split('\n').find(l=>/^FAILED/.test(l))||'判据红';
  return {...result,status:'FAIL',ran:ranCount,reason:line.trim().slice(0,300)};
}

export function inventory(){
  const tracked=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'});
  if(tracked.status!==0)throw Error('Cannot identify tracked test inventory');
  const files=new Set(tracked.stdout.split('\0').filter(Boolean));
  // Include newly added runner tests before commit, but never traverse dependencies.
  for(const dir of ['scripts/tests','shangshu-server/tests','shangshu-web/js/tests',...domainTestDirs(),...frappeDomainTestDirs()])
    for(const file of walk(join(root,dir)))files.add(relative(root,file));
  return [...files].filter(f=>/\.(?:[cm]?js|ts|py|sh)$/.test(f)&&(/(?:^|\/)(?:test[_-]|[^/]+\.test\.)/.test(f)||/\/tests\//.test(f)))
    .map(file=>{
      let group='manual';
      if(file.startsWith('shangshu-server/tests/')&&/\.test\.(?:ts|[cm]?js)$/.test(file))group='server';
      else if(file.startsWith('scripts/tests/')&&/\.test\.mjs$/.test(file))group='gates';
      else if(/^scripts\/tests\/test_.*\.py$/.test(file))group='python';
      else if(/^shangshu-web\/js\/domains\/excel-univer\/tests\/.*\.test\.(?:ts|mjs)$/.test(file))group='excel';
      /* —— **域里的 TS 判据也要进清单**（2026-10-29 案号迁移撞出来的）：
       *   原来这一条只认 `.test.mjs` ⇒ 域里新写的 `.test.ts`（example-domain 案号那一组）
       *   分组落到 manual ⇒ **一条都不跑**（「清单里没有」不是「跑过了」）。
       *   ⇒ 域判据一律 `.test.ts` / `.test.mjs` 都收进来。 */
      else if(/^shangshu-web\/js\/domains\/[^/]+\/tests\/.*\.test\.(?:ts|mjs)$/.test(file))group='webdomain';
      else if(/^shangshu-web\/js\/tests\/.*\.test\.mjs$/.test(file))group='webshell';
      else if(file==='scripts/tests/test-review-navigation.cjs')group='navigation';
      /* —— **域判据**（`frappe_apps/<域>/<域>/tests/test_*.py`）⇒ **进清单、真跑**。
       *   原来它们**整包**被归 manual（「须装 Frappe 站点」）⇒ 一条都没进过整趟基线；
       *   实测 152 个里 **97 个离线就能真跑** ⇒ 那句理由是错的（2026-10-25，PKG-109）。 */
      else if(/^frappe_apps\/[^/]+\/[^/]+\/tests\/test_.*\.py$/.test(file))group='domaintests';
      const installedRuntimeOnly=file==='scripts/tests/test_model_capabilities.py';
      if(installedRuntimeOnly)group='manual';
      /* —— 磁盘上**已经不在**的文件（域被拆走／删了没 git rm）⇒ **不跑**，但**写明为什么**。
       *   原来这里会一路走到 `readFileSync` 抛错 ⇒ **整趟跑批在装载期就崩**。 */
      if(!existsSync(join(root,file)))
        return {file,group:'manual',reason:'Tracked file is missing on disk (removed without git rm?) — skipped, not run'};
      const reason=installedRuntimeOnly?'Requires installed Frappe runtime; no database connection; execute separately with bench Python':group!=='manual'?null:file.startsWith('frappe_apps/')?'域判据的助手件（不是判据文件本身，不单独跑）':
        file.startsWith('shangshu-server/scripts/')?'Review site, credentials and fixture effects before execution':
        'Browser/site script or helper; not an automatic local test';
      return {file,group,reason};
    }).sort((a,b)=>a.file.localeCompare(b.file));
}

export async function execute(command,args,{cwd,env,log,timeoutMs}){
  const fd=openSync(log,'w');const started=Date.now();let timedOut=false,launchError=null;
  const child=spawn(command,args,{cwd,env,stdio:['ignore',fd,fd],detached:process.platform!=='win32'});
  const kill=()=>{timedOut=true;try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(kill,timeoutMs);
  child.on('error',error=>{launchError=error.message;});
  const [code,signal]=await new Promise(done=>child.on('close',(code,signal)=>done([code,signal])));
  clearTimeout(timer);closeSync(fd);
  return {status:timedOut?'TIMEOUT':launchError?'BLOCKED':code===0?'PASS':'FAIL',code,signal,launchError,durationMs:Date.now()-started};
}

export function classifyTestResult(result,output){
  // Node's own test deadline fires before our process-group deadline.
  return result.status==='FAIL' && /^\s*failureType: ['"]testTimeoutFailure['"]\s*$/m.test(output)
    ? {...result,status:'TIMEOUT'} : result;
}

// 「没跑成」与「测挂了」分开记（2026-10-24 12:3x，PKG-085）。
// 为什么：第一次全量跑批里 27 条红，有 8 条是**模块解析在装载期就炸了**
// （Excel 域的依赖在那棵工作树上没接上）⇒ **一条用例都没跑**，
// 可报告把它们记成了 FAIL ⇒ 读报告的人以为「27 条判据坏了」。
// ⇒ 装载失败单独记 LOAD_FAILED（并写清为什么）；**真的跑了用例才记 FAIL**。
// ⚠️ 两种都仍然让整趟跑批算失败（`status!=='PASS'` ⇒ 退出码 1）——
//    「不是判据红」不等于「没问题」。
const LOAD_FAILURE_SIGNATURES=[
  /ERR_MODULE_NOT_FOUND/,
  /ERR_PACKAGE_PATH_NOT_EXPORTED/,
  /Cannot find package '/,
  /Cannot find module '/,
  /does not provide an export named/,
];
export function classifyLoadFailure(result,output){
  if(result.status!=='FAIL')return result;
  const text=String(output||'');
  const hit=LOAD_FAILURE_SIGNATURES.find(pattern=>pattern.test(text));
  if(!hit)return result;
  const line=text.split('\n').find(l=>hit.test(l))||hit.source;
  return {...result,status:'LOAD_FAILED',reason:line.trim().slice(0,300)};
}

// R967-F03：一个角色一条快速命令。--only 可重复，取并集，这样一条命令能圈住一组文件，
// 不必每次改一行就跑全量。空选中仍然拒绝 —— 不能变成「跑了 0 条所以全绿」。
export function selectTests(all,groups,onlyList){
  const only=(onlyList||[]).filter(Boolean);
  const selected=all.filter(x=>groups.includes(x.group)&&
    (!only.length||only.some(pattern=>x.file.includes(pattern))));
  if(!selected.length)throw Error('No matching tests; refusing an empty green run');
  return selected;
}

export async function main(defaultGroups){
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Node 22.13+ required (node:sqlite)');
  const argv=process.argv.slice(2);const value=name=>{const i=argv.indexOf(name);if(i<0)return undefined;if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error(name+' requires a value');return argv[i+1];};
  const values=name=>{const out=[];for(let i=0;i<argv.length;i++)if(argv[i]===name){if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error(name+' requires a value');out.push(argv[i+1]);}return out;};
  const known=new Set(['--list','--groups','--only','--timeout','--out']);
  for(let i=0;i<argv.length;i++){if(!known.has(argv[i]))throw Error('Unknown option '+argv[i]);if(argv[i]!=='--list')i++;}
  const groups=(value('--groups')||defaultGroups||'server,gates,python,excel,webdomain,webshell,navigation,domaintests').split(',');
  if(groups.some(g=>!['server','gates','python','excel','webdomain','webshell','navigation','domaintests'].includes(g)))throw Error('Unknown group');
  const timeoutMs=Number(value('--timeout')||60)*1000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<1000)throw Error('Timeout must be at least 1 second');
  const all=inventory();
  const selected=selectTests(all,groups,values('--only'));
  if(argv.includes('--list')){console.log(JSON.stringify({selected,deferred:all.filter(x=>!selected.includes(x))},null,2));return;}
  const out=value('--out')?resolve(value('--out')):mkdtempSync(join(tmpdir(),'shangshu-baseline-'));
  if(value('--out'))mkdirSync(out,{recursive:false}); // Never overwrite previous evidence.
  const report={sourceCommit:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),
    sourceDiffSha256:createHash('sha256').update(spawnSync('git',['diff','HEAD','--binary'],{cwd:root}).stdout).digest('hex'),
    sourceStatus:spawnSync('git',['status','--short','--untracked-files=no'],{cwd:root,encoding:'utf8'}).stdout.trim(),
    startedAt:new Date().toISOString(),node:process.version,scope:'Local tests only; does not certify live-site or browser acceptance',
    selected:selected.map(x=>({...x,sha256:createHash('sha256').update(readFileSync(join(root,x.file))).digest('hex')})),
    deferred:all.filter(x=>!selected.includes(x)).map(x=>({...x,status:'NOT_RUN',reason:x.reason||'Not selected in this run'})),results:[]};
  const save=()=>writeFileSync(join(out,'results.json'),JSON.stringify(report,null,2));save();
  console.log('Evidence: '+out);
  for(const [index,test] of selected.entries()){
    const state=mkdtempSync(join(out,'state-'));const log=join(out,String(index+1).padStart(3,'0')+'.log');
    let cwd=root,command=process.execPath,args;
    if(test.group==='python'){command=process.env.PYTHON||'python3';args=[test.file];}
    else if(test.group==='navigation'){args=[test.file];}
    else if(test.group==='domaintests'){
      /* 域判据：**一个文件一个独立进程**（域判据之间会互相污染 sys.modules），
       * 跑法固定 `python3 -m unittest <模块>`（直跑文件有 48 个会空跑装绿）。 */
      const probe=domainTestModule(test.file);
      command=process.env.PYTHON||'python3';args=probe.args;cwd=join(root,probe.cwd);
    }
    else {
      cwd=join(root,'shangshu-server');
      args=['--import','tsx','--test','--test-concurrency=1','--test-timeout='+timeoutMs,relative(cwd,join(root,test.file))];
    }
    let result=await execute(command,args,{cwd,env:{...process.env,_SS_DATA_DIR:state},log,timeoutMs:timeoutMs+2000});
    const output=readFileSync(log,'utf8');
    if(test.group!=='python'&&test.group!=='navigation')result=classifyTestResult(result,output);
    if(test.group==='domaintests')result=classifyDomainTestResult(result,output,{module:domainTestModule(test.file).module});
    result=classifyLoadFailure(result,output);
    const count=output.match(/# tests (\d+)/);const skipped=output.match(/# skipped (\d+)/);
    const pyRan=output.match(/^Ran (\d+) tests?/m);
    const pySkipped=output.match(/skipped=(\d+)/);
    report.results.push({...test,...result,log:relative(out,log),tests:count?Number(count[1]):(pyRan?Number(pyRan[1]):null),skipped:skipped?Number(skipped[1]):(pySkipped?Number(pySkipped[1]):null)});
    if(result.status==='PASS')rmSync(state,{recursive:true,force:true});
    save();console.log(`[${index+1}/${selected.length}] ${result.status} ${test.file} (${result.durationMs}ms)${result.status==='LOAD_FAILED'||result.status==='NEEDS_SITE'||result.status==='FAIL'?` —— ${result.reason||''}`:''}`);
  }
  report.finishedAt=new Date().toISOString();report.counts=report.results.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{});
  report.sourceChangedDuringRun=report.sourceCommit!==spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim()
    ||report.sourceDiffSha256!==createHash('sha256').update(spawnSync('git',['diff','HEAD','--binary'],{cwd:root}).stdout).digest('hex');save();
  console.log(JSON.stringify(report.counts));console.log('Deferred scripts/helpers: '+report.deferred.length+'; browser checklist remains separate.');
  /* —— 域判据那一档**单独说一遍**（2026-10-25，PKG-109）：
   *   「离线真跑了多少／须上站多少」是这档最要紧的两个数 ——
   *   少了会以为「域判据都测过了」，多了会以为「全都没测」。 */
  const domain=report.results.filter(r=>r.group==='domaintests');
  if(domain.length){
    const passed=domain.filter(r=>r.status==='PASS').length;
    const needsSite=domain.filter(r=>r.status==='NEEDS_SITE').length;
    const red=domain.length-passed-needsSite;
    const cases=domain.filter(r=>r.status==='PASS').reduce((a,r)=>a+(r.tests||0),0);
    console.log(`Domain criteria: ${domain.length} files — ${passed} ran offline (${cases} cases), ${needsSite} need a real Frappe site, ${red} red.`);
  }
  /* 「须上站」**不是红**（那 55 个文件本来就跑不了离线，跑不了是事实、不是缺陷）——
   * 但**红是真红**（真跑了用例且有错）⇒ 整趟照旧失败。 */
  const failed=report.results.some(r=>['FAIL','TIMEOUT','BLOCKED','LOAD_FAILED'].includes(r.status));
  process.exitCode=report.sourceChangedDuringRun||failed?1:0;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});
