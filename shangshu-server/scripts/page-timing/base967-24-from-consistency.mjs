/* BASE967-24 判据（Node 24 零依赖，源级核 + 语法）：发送核对里的 From 与 worker 实际 From 一致。
   req 3 原话：「**预览与 worker 实际 From 一致**」

   worker（`delivery.py:52`）：`From = {binding.display_name} <{binding.email_address}>`（有 display_name 时）。
   改之前前端：`{...ME, addr}` —— **name 永远是登录人姓名**；共享箱发信时预览显示登录人名、
   实际发出去是部门名 → 不一致。弹窗还只显示 `data.from.addr`（连名字都没有）。

   测试通过 = 三件都在且接线对：
     ① `sendableIdentities` 带 `display_name`
     ② `collect()` 的 `from.name` 取自**所选发件身份那个邮箱的 display_name**（不是 `{...ME}`）
     ③ 发送核对弹窗按 `name <addr>` 显示（跟 worker 同形）
   外加语法通过。 */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '../../../shangshu-web/js/mail-center.js');
const SRC = readFileSync(FILE, 'utf8');

const identsHasDisplayName = /sendableIdentities[\s\S]{0,400}?display_name:m\.display_name/.test(SRC);
const collectUsesBox = /_fromBox[\s\S]{0,200}?_fromBox\.display_name/.test(SRC);
const collectNotPlainME = !/return \{from: \{\.\.\.ME, addr:/.test(SRC);
const dialogShowsName = /data\.from\.name \? `\$\{data\.from\.name\} <\$\{data\.from\.addr\}>` : data\.from\.addr/.test(SRC);

let syntaxOk = true;
try { execFileSync(process.execPath, ['--check', FILE], {stdio: 'pipe'}); } catch { syntaxOk = false; }

console.log('  ① sendableIdentities 带 display_name？        ' + (identsHasDisplayName ? 'OK 是' : 'FAIL 否'));
console.log('  ② collect 的 from.name 取所选邮箱？           ' + (collectUsesBox ? 'OK 是' : 'FAIL 否'));
console.log('     不再是无条件 {...ME}？                      ' + (collectNotPlainME ? 'OK 是' : 'FAIL 否'));
console.log('  ③ 核对弹窗按 name <addr> 显示？               ' + (dialogShowsName ? 'OK 是' : 'FAIL 否'));
console.log('  语法通过？                                    ' + (syntaxOk ? 'OK 是' : 'FAIL 否'));

const ok = identsHasDisplayName && collectUsesBox && collectNotPlainME && dialogShowsName && syntaxOk;
console.log('');
console.log('预览与 worker From 一致？' + (ok ? 'OK 成立（源级）' : 'FAIL 不成立'));
process.exit(ok ? 0 : 1);
