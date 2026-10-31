// 更新时先核对官方 release 和 npm integrity；只提取浏览器阅读所需静态资源。
import {readFileSync,mkdtempSync,mkdirSync,cpSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const version='6.4.299',integrity='AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==';
const archive=process.argv[2];
if(!archive||createHash('sha512').update(readFileSync(archive)).digest('base64')!==integrity)throw Error('PDF.js官方包SHA512不符');
const root=new URL('../shangshu-web/vendor/pdfjs-'+version+'/',import.meta.url),stage=mkdtempSync(join(tmpdir(),'shangshu-pdfjs-'));
if(existsSync(root))throw Error('目标已存在；不可静默覆盖已锁定版本');
const paths=['legacy/build/pdf.min.mjs','legacy/build/pdf.worker.min.mjs','cmaps','standard_fonts','wasm','LICENSE'];
execFileSync('tar',['-xzf',archive,'-C',stage,...paths.map(p=>'package/'+p)]);
mkdirSync(root,{recursive:true});
for(const path of paths)cpSync(join(stage,'package',path),new URL(path.startsWith('legacy/')?path.split('/').at(-1):path,root),{recursive:true});
console.log('PDF.js '+version+' SHA512 verified; static assets copied. Temporary extraction: '+stage);
