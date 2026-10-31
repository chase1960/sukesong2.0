/* BASE967-24 宽表横向浏览判据（Node 24 零依赖，源级核）。
   req 4 原话：「**宽表用可横向浏览方案，不强行压成不可读**」
   UI-042 实测：「inline width1600px 但 computed max-width100%、呈现宽 655px 且
   body scrollWidth=clientWidth 655，**无法按原宽横向查看**」

   2026-10-19 补完：原来只核**阅读面**（previewSrcdoc 的内联样式），**编辑面漏了** ——
   mail-center.css 里 `.mail-body-editor table{max-width:100%}` 把宽表在写信/签名/
   审核编辑面压扁。判据现在核三处，且三处口径必须一致。

   测试通过 = 三处各自：
     · table 不再被 max-width:100% 硬压（压成不可读的那条）
     · table 保持自然宽（width:max-content + max-width:none）
     · 窄表照旧铺满（min-width:100%）
     · 编辑面可横向滚（.mail-body-editor 有 overflow-x/overflow:auto）
     · 首列冻结（首格 position:sticky;left:0）—— 横着看时不丢行首
   ⚠ 这是**源级**核：真实像素（不压缩、列宽可读）要真浏览器看，属 3850 真页面/F07 那一层。 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../../../shangshu-web/js/domains/mail/mail-editor.js'), 'utf8');
const CSS = readFileSync(resolve(HERE, '../../../shangshu-web/css/mail-center.css'), 'utf8');

const checks = [];
const check = (label, ok) => { checks.push(ok); console.log(`  ${label} ${ok ? 'OK' : 'FAIL'}`); };

/* ── ① 阅读面（previewSrcdoc 的内联样式）────────────────────────────── */
const m = SRC.match(/const style = 'body\{([^']*)\}'\s*\n\s*\+ 'table\{([^']*)\}'\s*\n\s*\+ 'td,th\{([^']*)\}'/);
if (!m) { console.error('抽不到 previewSrcdoc 的样式串（产品改了结构？）'); process.exit(2); }
const [, bodyCss, tableCss] = m;
console.log('【阅读面 srcdoc】');
check('table 不再有 max-width:100%（宽表被硬压）', !/max-width\s*:\s*100%/.test(tableCss));
check('table 保持自然宽 width:max-content', /width\s*:\s*max-content/.test(tableCss));
check('table max-width:none（不设上限）', /max-width\s*:\s*none/.test(tableCss));
check('body 可横向滚 overflow-x:auto', /overflow-x\s*:\s*auto/.test(bodyCss));

/* ── ② 写信编辑面 + ③ 审核/签名弹窗编辑面 ──────────────────────────── */
const surfaces = [
  ['写信编辑面', /\.mail-center-page \.mail-body-editor table\{([^}]*)\}/],
  ['审核/签名弹窗编辑面', /:is\(\.mail-review-dialog,\.mail-signature-dialog\) \.mail-body-editor table\{([^}]*)\}/],
];
for (const [name, re] of surfaces) {
  const hit = CSS.match(re);
  console.log(`【${name}】`);
  if (!hit) { check('找得到编辑面表格规则（产品改了选择器？）', false); continue; }
  const css = hit[1];
  check('table 不再有 max-width:100%（宽表被压成不可读）', !/max-width\s*:\s*100%/.test(css));
  check('table 保持自然宽 width:max-content', /width\s*:\s*max-content/.test(css));
  check('table max-width:none（不设上限）', /max-width\s*:\s*none/.test(css));
  check('窄表照旧铺满 min-width:100%', /min-width\s*:\s*100%/.test(css));
}

/* 编辑面能横向滚 + 首列冻结（两个弹窗面共用同一套 body-editor 规则） */
console.log('【编辑面可读性】');
const editorRule = CSS.match(/\.mail-center-page \.mail-body-editor\{([^}]*)\}/);
check('写信编辑面有横向滚动（overflow 含 x/auto）',
  Boolean(editorRule && /overflow(-x)?\s*:\s*auto/.test(editorRule[1])));
const dialogEditorRule = CSS.match(/:is\(\.mail-review-dialog,\.mail-signature-dialog\) \.mail-body-editor\{([^}]*)\}/);
check('弹窗编辑面有横向滚动',
  Boolean(dialogEditorRule && /overflow(-x)?\s*:\s*auto/.test(dialogEditorRule[1])));
check('首列冻结（首格 sticky + left:0）',
  /\.mail-body-editor table :is\(td,th\):first-child\{[^}]*position:sticky/.test(CSS) && /left\s*:\s*0/.test(CSS));
check('首列冻结有不透明底色（横滚时不透字）',
  /\.mail-body-editor table td:first-child\{[^}]*background/.test(CSS));

const ok = checks.every(Boolean);
console.log('');
console.log('宽表可横向浏览（三处口径一致）？' + (ok ? 'OK 成立' : 'FAIL 不成立'));
console.log('（真实像素：窄视口不压缩、列宽可读 —— 属真浏览器那一层，3850/F07）');
process.exit(ok ? 0 : 1);
