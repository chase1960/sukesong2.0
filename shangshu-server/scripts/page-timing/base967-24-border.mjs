/* BASE967-24 判据（Node 24 零依赖）：**归一化 HTML 幂等**，重复 border 不膨胀。
   req 4 原话：「归一化 HTML 幂等，消除重复 border 样式膨胀…不可单纯调大长度掩盖重复膨胀」

   测试反馈原文：「normalizeMarkup **每格重复前置** 25 字符 border 声明，**累计** 25000」
   —— 不是「1000 格各一份」，是**同一格每保存一次就多一份**。

   测试通过 = 同一格连续保存 N 次后，完整 border 声明**始终 1 份**、style 字符串**不再增长**。 */

const INVISIBLE_BORDER_RE = /^(?:none|0|0px|0em|0rem|0pt)(?:\s|$)/i;
const FORCED_BORDER = 'border:1px solid #d0d5dd';
const D_RE = /border:1px solid #d0d5dd/g;

/** 抽出公共的「摘取消框线 + 补 padding」那半 */
function cleanDecls(s) {
  const decls = s.split(';').map(x => x.trim()).filter(Boolean);
  const kept = decls.filter(d => {
    const cut = d.indexOf(':');
    if (cut < 0) return true;
    const prop = d.slice(0, cut).trim().toLowerCase();
    if (!/^border(?:-|$)/.test(prop)) return true;
    return !INVISIBLE_BORDER_RE.test(d.slice(cut + 1).trim());
  });
  const hasP = kept.some(d => /^padding/i.test(d.slice(0, d.indexOf(':')).trim()));
  if (!hasP) kept.push('padding:6px');
  return kept;
}

/** v1（现状 mail-editor.js:75）：无条件前置 FORCED_BORDER —— **不幂等** */
function ensureV1(s) {
  return [FORCED_BORDER, ...cleanDecls(s)].join(';');
}

/** v3（修法）：**已经有一模一样的 FORCED_BORDER 就不再前置** —— 幂等 */
function ensureV3(s) {
  const kept = cleanDecls(s);
  const norm = (d) => d.replace(/\s+/g, '').toLowerCase();
  const hasForced = kept.some(d => norm(d) === norm(FORCED_BORDER));
  return (hasForced ? kept : [FORCED_BORDER, ...kept]).join(';');
}

function runN(fn, n, seed = '') {
  let s = seed;
  const trail = [];
  for (let i = 1; i <= n; i++) {
    s = fn(s);
    trail.push({i, decls: (s.match(D_RE) || []).length, len: s.length});
  }
  return {final: s, trail};
}

console.log('=== 场景 A：空 style 的格子，连续保存 5 次 ===');
const a1 = runN(ensureV1, 5);
const a3 = runN(ensureV3, 5);
console.log('  v1（现状）：' + a1.trail.map(t => t.decls + '份/' + t.len + '字').join(' → '));
console.log('  v3（修法）：' + a3.trail.map(t => t.decls + '份/' + t.len + '字').join(' → '));

console.log('=== 场景 B：源带 border:1px solid #ccc（J5 契约：前置 + 后者胜）===');
const b1 = runN(ensureV1, 3, 'border:1px solid #ccc;padding:4px 8px');
const b3 = runN(ensureV3, 3, 'border:1px solid #ccc;padding:4px 8px');
console.log('  v1（现状）：' + b1.trail.map(t => t.decls + '份/' + t.len + '字').join(' → '));
console.log('  v3（修法）：' + b3.trail.map(t => t.decls + '份/' + t.len + '字').join(' → '));
const j5ok = (s) => s.includes('#d0d5dd') && s.includes('#ccc') && s.indexOf('#d0d5dd') < s.indexOf('#ccc');
console.log('  v3 仍保住 J5 契约（#d0d5dd 在前、#ccc 在后、两者都在）？' + (j5ok(b3.final) ? 'OK 是' : 'FAIL 否'));

console.log('=== 场景 C：1000 格 × 5 次保存（反馈里的真实规模）===');
let v1total = 0, v3total = 0;
for (let i = 0; i < 1000; i++) {
  v1total += runN(ensureV1, 5).final.length;
  v3total += runN(ensureV3, 5).final.length;
}
console.log('  v1（现状）1000 格 × 5 次 = ' + v1total + ' 字符');
console.log('  v3（修法）1000 格 × 5 次 = ' + v3total + ' 字符');
console.log('  省下 ' + (v1total - v3total) + ' 字符（' + (100 - v3total * 100 / v1total).toFixed(1) + '%）');

const v1_not_idempotent = a1.trail[4].decls > a1.trail[0].decls;
const v3_idempotent = a3.trail.every(t => t.decls === 1 && t.len === a3.trail[0].len);
const v3_j5 = j5ok(b3.final) && b3.trail.every(t => t.decls === 1);
const v3_saves = v3total < v1total;

console.log('');
console.log('v1 真不幂等？' + (v1_not_idempotent ? 'OK 是（5 次 → ' + a1.trail[4].decls + ' 份）' : 'FAIL 否'));
console.log('v3 真幂等？' + (v3_idempotent ? 'OK 是（始终 1 份、长度不变）' : 'FAIL 否'));
console.log('v3 保住 J5 契约？' + (v3_j5 ? 'OK 是' : 'FAIL 否'));
console.log('v3 真省字符？' + (v3_saves ? 'OK 是' : 'FAIL 否'));

if (!v1_not_idempotent || !v3_idempotent || !v3_j5 || !v3_saves) {
  console.error('BASE967-24 判据失败');
  process.exit(1);
}
