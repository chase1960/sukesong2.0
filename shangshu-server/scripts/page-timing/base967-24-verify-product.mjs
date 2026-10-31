import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, '../../../shangshu-web/js/domains/mail/mail-editor.js'), 'utf8');

/* 抽真实的 ensureTableBorders（连同它依赖的两个常量） */
const start = src.indexOf('const INVISIBLE_BORDER');
const end = src.indexOf('/* 受管地址：文件库的下载口');
if (start < 0 || end < 0) { console.error('抽不到'); process.exit(2); }
const code = src.slice(start, end);

/* 假 DOM：够 ensureTableBorders 用 */
function mkCell(style = '') {
  return { _style: style, getAttribute(k) { return k === 'style' ? (this._style || null) : null; },
           setAttribute(k, v) { if (k === 'style') this._style = v; } };
}
function mkTable(cells, style = '') {
  return { _style: style, getAttribute(k) { return k === 'style' ? (this._style || null) : null; },
           setAttribute(k, v) { if (k === 'style') this._style = v; },
           querySelectorAll: (sel) => (sel === 'td,th' ? cells : []) };
}
function mkRoot(tables) { return {querySelectorAll: (sel) => (sel === 'table' ? tables : [])}; }

const fn = new Function(code + '\nreturn ensureTableBorders;')();
const D_RE = /border:1px solid #d0d5dd/g;

/* 场景 A：空 style 的格子，连续跑 5 次（模拟连续保存） */
const cellsA = [mkCell('')];
const tableA = mkTable(cellsA);
for (let i = 1; i <= 5; i++) {
  fn(mkRoot([tableA]));
  const n = (cellsA[0]._style.match(D_RE) || []).length;
  console.log(`  A 第 ${i} 次：${n} 份 border / ${cellsA[0]._style.length} 字符`);
}

/* 场景 B：源带 #ccc，验 J5 契约（前置 + 后者胜） */
const cellsB = [mkCell('border:1px solid #ccc;padding:4px 8px')];
const tableB = mkTable(cellsB);
fn(mkRoot([tableB]));
fn(mkRoot([tableB]));   // 存第二次
fn(mkRoot([tableB]));   // 存第三次
const sB = cellsB[0]._style;
console.log(`  B 连存 3 次后：${(sB.match(D_RE) || []).length} 份 border / ${sB.length} 字符`);
console.log(`  B 保住 J5？${sB.includes('#d0d5dd') && sB.includes('#ccc') && sB.indexOf('#d0d5dd') < sB.indexOf('#ccc') ? 'OK 是' : 'FAIL 否'}`);

/* 场景 C（req 4）：1000 格表格 —— 连续保存 5 次后，正文长度必须**稳定**且
   稳稳低于写信窗的 100000 上限。这是「不可单纯调大长度掩盖重复膨胀」的正面判据：
   靠幂等把长度压住，不是靠放宽上限。 */
const CELL_N = 1000, PER_ROW = 20;
const cellsC = Array.from({length: CELL_N}, () => mkCell(''));
const tableC = mkTable(cellsC);
const lengths = [];
for (let i = 1; i <= 5; i++) {
  fn(mkRoot([tableC]));
  const rows = [];
  for (let r = 0; r < CELL_N / PER_ROW; r++) {
    rows.push('<tr>' + cellsC.slice(r * PER_ROW, (r + 1) * PER_ROW)
      .map(c => `<td style="${c._style}">A001</td>`).join('') + '</tr>');
  }
  lengths.push(('<table><tbody>' + rows.join('') + '</tbody></table>').length);
}
const stable = new Set(lengths).size === 1;
const underLimit = lengths[lengths.length - 1] < 100000;
console.log(`  C 1000 格连存 5 次：正文 ${lengths.join(' → ')} 字符`);
console.log(`  C 长度稳定？${stable ? 'OK 是' : 'FAIL 否'}；低于 100000 上限？${underLimit ? 'OK 是' : 'FAIL 否'}`);

/* 判定 */
const aFinal = (cellsA[0]._style.match(D_RE) || []).length;
const bFinal = (sB.match(D_RE) || []).length;
const ok = aFinal === 1 && bFinal === 1 && stable && underLimit;
console.log('');
console.log(`产品代码幂等？${ok ? 'OK 是（A/B 恒 1 份；1000 格长度稳定且低于上限）'
  : 'FAIL 否（A=' + aFinal + ' B=' + bFinal + ' stable=' + stable + ' under=' + underLimit + '）'}`);
process.exit(ok ? 0 : 1);
