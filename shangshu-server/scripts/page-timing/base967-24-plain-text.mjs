/* BASE967-24 纯文本阅读入口判据（Node 24 零依赖，源级核 + 语法检查）。
   req 4 原话：「**纯文本阅读入口按原计划补**」

   现状缺口：`bodyView` 只在 `bodyFormat!=='HTML'` 时给 `<pre>` ——
   **HTML 信没有切纯文本的入口**（宽表挤成一坨、复制带格式）。

   测试通过 = 产品里三件都在且接线对：
     ① `plainFromHtml` 存在，且**表格按行展开**（`tr` → 一格一行、格间制表符）
     ② 详情页有「纯文本」按钮（`#toggle-plain-text`），且**只对 HTML 信出现**
     ③ 按钮有 onclick，切换 `#mail-body-plain` 与 iframe 的 `hidden`
   外加：`mail-center.js` **语法通过**（`node --check`）。

   ⚠️ **这是源级核，不是行为验证** —— 沙箱跑不了 jsdom、也起不了浏览器。
      真实点击效果（按钮显不显示、切换对不对）**待真页面**。 */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '../../../shangshu-web/js/mail-center.js');
const SRC = readFileSync(FILE, 'utf8');

const hasPlainFn = /function plainFromHtml\(html\)\{/.test(SRC);
const tableRowExpands = /querySelectorAll\('tr'\)/.test(SRC)
  && /cells\.join\('\\t'\)/.test(SRC);
const hasButton = /id="toggle-plain-text"/.test(SRC);
const buttonOnlyHtml = /m\.bodyFormat==='HTML'\?'<button[^>]*id="toggle-plain-text"/.test(SRC);
const hasPre = /id="mail-body-plain"/.test(SRC);
const hasHandler = /if\(\$\('#toggle-plain-text'\)\)\{[\s\S]{0,400}?\.onclick=/.test(SRC);
const togglesHidden = /plain\.hidden=!showPlain/.test(SRC) && /frame\.hidden=showPlain/.test(SRC);

let syntaxOk = true;
try { execFileSync(process.execPath, ['--check', FILE], {stdio: 'pipe'}); }
catch { syntaxOk = false; }

console.log('  ① plainFromHtml 存在？                    ' + (hasPlainFn ? 'OK 是' : 'FAIL 否'));
console.log('     表格按行展开（tr → 制表符分隔）？       ' + (tableRowExpands ? 'OK 是' : 'FAIL 否'));
console.log('  ② #toggle-plain-text 按钮存在？           ' + (hasButton ? 'OK 是' : 'FAIL 否'));
console.log('     只对 HTML 信出现？                     ' + (buttonOnlyHtml ? 'OK 是' : 'FAIL 否'));
console.log('     #mail-body-plain <pre> 存在？          ' + (hasPre ? 'OK 是' : 'FAIL 否'));
console.log('  ③ 按钮有 onclick？                       ' + (hasHandler ? 'OK 是' : 'FAIL 否'));
console.log('     onclick 真的切 hidden？                ' + (togglesHidden ? 'OK 是' : 'FAIL 否'));
console.log('  语法通过（node --check）？                ' + (syntaxOk ? 'OK 是' : 'FAIL 否'));

const ok = hasPlainFn && tableRowExpands && hasButton && buttonOnlyHtml && hasPre && hasHandler && togglesHidden && syntaxOk;
console.log('');
console.log('纯文本阅读入口？' + (ok ? 'OK 成立（源级）' : 'FAIL 不成立'));
process.exit(ok ? 0 : 1);
