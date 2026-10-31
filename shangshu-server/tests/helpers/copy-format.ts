/*
 A 侧接缝的**真字节装载** + 形状对照样本 —— **公共工具只留一份**（§13）。

 契约：`fde/开发/验收/T01-复制格式验收-2026-10-15.md`（A 交 f189768d，13/13）。
 A 的 `copyData()` 把 `text/html` 产出成紧凑格式（H3：标签间零空白）：
   <table style="border-collapse:collapse;"><tr><td style="border:1px solid #ccc;padding:4px 8px;">值</td>…</tr>…</table>
 H6 转义（& < > " 不裸出）、H7 格内换行变 <br>、H8–H11 行列数一致。

 ## 真字节从哪来（2026-10-15 05:37 A 交了）

 `loadABytes()` 读 **A 进程里跑出来的 clipboardData 夹具**，不是我构造的：
   - 交接：`fde/开发/验收/T01-联测接缝交接-2026-10-15.md`（A，2433 字节）
   - 原件：`fde/开发/验收/t01-clipboard-fixture.json`（982 字节，落盘 05:35）
   - 仓库副本：`shangshu-server/tests/fixtures/t01-clipboard-fixture.json`
   - **两份逐字节同一**：shasum-256 `279eee7c24ead2d2d35890b3bd31ed8a9fb16fd50140ffdbd1b51b634e592525`
   - 来源：真实表 `9ad7c85d…` 2×2 选区，`copyVersion: pkg-002-t13-v2`

 **为什么两处都找**：`fde/` 下这份是未跟踪文件，git 不带进工作树 —— 只认 fde 那条路，
 在工作树/CI 里就找不到。只认仓库副本，又跟 A 的交接原件脱钩。所以**两处都找、
 硬找不到就抛错**，**绝不 skip**（skip 长得跟过一模一样，是「空过」的一种）。

 ## 合成样本降级为「形状回归对照」（不是接缝）

 A 的真夹具是干净的 2×2 —— **没有特殊字符、没有格内换行**，盖不到 H6/H7。
 所以下面 `copyHtml`/`COPY_SAMPLE*`/`assertCopyShape` 保留，但**身份降级**：
 只做「形状回归对照」，钉 H6/H7 这两条真夹具够不着的边。
 **三条腿的输入一律用 `loadABytes()`，不许用合成样本冒充接缝。**

 业务用例只写「准备什么、做什么、应该发生什么」，别在用例里重写这份生成逻辑。
*/
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** A 交的真字节。三条腿的输入用这个。 */
export interface ABytes {
  /** A 的 text/html —— 真 `<table style="border-collapse:collapse;">` 紧凑串 */
  html: string;
  /** A 的 text/plain —— 真 TSV（制表符分隔） */
  plain: string;
  /** 选区行列（A 的 range 字段） */
  range: {startRow: number; startCol: number; endRow: number; endCol: number};
  /** 二维单元格值（A 的 rows 字段） */
  rows: string[][];
  copyVersion: string;
  source: string;
}

/**
 * 读 A 的真 clipboardData 夹具。
 * 两处都找，硬找不到就抛 —— **不 skip**。
 */
export function loadABytes(): ABytes {
  const candidates = [
    // ① A 的交接原件（主检出里那份，未跟踪 → 工作树常没有）
    new URL('../../../fde/开发/验收/t01-clipboard-fixture.json', import.meta.url),
    // ② 仓库内副本（工作树 / CI —— 与原件逐字节同一，shasum 见模块头）
    new URL('../fixtures/t01-clipboard-fixture.json', import.meta.url),
  ];
  let raw: string | null = null;
  const tried: string[] = [];
  for (const url of candidates) {
    const p = fileURLToPath(url);
    tried.push(p);
    try {
      raw = readFileSync(p, 'utf8');
      break;
    } catch { /* 换下一个 */ }
  }
  if (raw === null) {
    throw new Error(
      `找不到 A 的 clipboardData 夹具（两处都没有，不许 skip）—— 试过：\n  ${tried.join('\n  ')}`);
  }
  const f = JSON.parse(raw);
  const cd = f.clipboardData || {};
  if (!cd['text/html'] || !cd['text/plain']) {
    throw new Error('A 的夹具缺 clipboardData["text/html"] 或 ["text/plain"] —— 接缝契约对不上');
  }
  if (!Array.isArray(f.rows) || !f.rows.length || !f.rows[0]?.length) {
    // ★这条是「空过」的闸：rows 为空时，「每个值都要进」那个循环会**空转过关**。
    // 长得跟过一模一样，比红更坏。所以在这儿硬拦。
    throw new Error('A 的夹具 rows 是空的 —— 三腿的值断言会空过，不许拿空夹具测');
  }
  // ★身份闸：钉住「载的就是 A 那份」。
  // 为什么非钉不可 —— 三腿的值断言是「a.rows 里每个值都进正文」，而 a.rows 和 a.html
  // **来自同一份夹具**，改夹具两边一起改，那条断言永远成立。它测的是「粘贴不毁字」，
  // **测不出「载的是不是 A 那份」**。2026-10-15 证伪时真踩到过：把夹具里
  // `测试品-0001` 改成 `测试品-XXX`，三腿照样全绿。所以身份在这里钉死。
  if (f.copyVersion !== 'pkg-002-t13-v2') {
    throw new Error(`夹具不是 A 交的那份：copyVersion=${JSON.stringify(f.copyVersion)}，应为 "pkg-002-t13-v2"`);
  }
  if (!String(f.source || '').includes('9ad7c85d')) {
    throw new Error(`夹具来源不对，不是 A 那张真实表的 2×2 选区：source=${JSON.stringify(f.source)}`);
  }
  // 结构交叉核：html 里的格数要跟 rows 对得上（防 json 内部自相矛盾）
  const wantTd = f.rows.length * f.rows[0].length;
  const gotTd = (cd['text/html'].match(/<td /g) || []).length;
  if (gotTd !== wantTd) {
    throw new Error(`夹具内部自相矛盾：html 里 ${gotTd} 格，rows 是 ${f.rows.length}×${f.rows[0].length}=${wantTd}`);
  }
  return {
    html: cd['text/html'],
    plain: cd['text/plain'],
    range: f.range,
    rows: f.rows,
    copyVersion: f.copyVersion,
    source: f.source,
  };
}
// ── 以下是「形状回归对照」，不是接缝 ────────────────────────────────────────
// A 的真夹具是干净 2×2，盖不到 H6 转义 / H7 格内换行。<br>
// 这一套只钉那两条边。**不许拿它冒充接缝** —— 三条腿的输入用 loadABytes()。

/** 照 A 契约 §3 的 H6 转义（& < > " 不裸出）。对照用。 */
export function escapeText(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 照 A 契约 §3 产出 text/html（H1–H11）。 */
export function copyHtml(rows: string[][]): string {
  const tdStyle = 'border:1px solid #ccc;padding:4px 8px;';
  const body = rows
    .map(r => '<tr>' + r
      .map(v => `<td style="${tdStyle}">${escapeText(v).replace(/\n/g, '<br>')}</td>`)
      .join('') + '</tr>')
    .join('');
  return `<table style="border-collapse:collapse;">${body}</table>`;
}

/** A 的 TSV（text/plain，T1–T5）。粘贴时 html 优先，这里只为双格式齐全。 */
export function copyTsv(rows: string[][]): string {
  return rows.map(r => r.join('\t')).join('\n');
}

/** 标准 2×2 样本：含中文、金额语义。 */
export const COPY_SAMPLE: string[][] = [
  ['案件汇总', '金额'],
  ['A001', '年费已核对'],
];

/** 会踩 H6/H7 的样本：特殊字符 + 格内换行。 */
export const COPY_SAMPLE_ESC: string[][] = [
  ['含<尖>与&号', '引"号'],
  ['多行\n第二行', '尾格'],
];

/** 自证样本本身符合契约 —— 不然是拿假样本去测（「空过」的一种）。 */
export function assertCopyShape(rows: string[][], html: string, ok: (c: boolean, m: string) => void): void {
  const total = rows.length * (rows[0]?.length || 0);
  ok(html.startsWith('<table') && html.endsWith('</table>'), 'H1 唯一 table 根');
  ok(html.includes('border-collapse:collapse'), 'H2 border-collapse');
  ok(!/>\s+</.test(html), 'H3 标签间无多余空白（紧凑）');
  ok((html.match(/border:1px solid #ccc;padding:4px 8px;/g) || []).length === total, 'H4/H5 每格 style 一致且次数 = 行×列');
  ok(!/&(?!amp;|lt;|gt;|quot;)/.test(html), 'H6 转义不裸出');
  ok((html.match(/<tr>/g) || []).length === rows.length, 'H8/H9 tr 数 = 行数');
  ok((html.match(/<td /g) || []).length === total, 'H10/H11 td 数 = 行×列');
}

/**
 * 把 A 的 clipboardData 双格式塞进一次真实 paste 事件，派给编辑区。
 * jsdom 没有 DataTransfer 构造器，用与剪贴板同形的对象（getData/types）。
 * **粘贴手法只留这一份**，业务用例别各自抄。
 */
export function pasteClipboard(w: any, editor: any, html: string, plain = ''): any {
  const dt = {
    types: ['text/html', 'text/plain'],
    getData: (t: string) => (t === 'text/html' ? html : t === 'text/plain' ? plain : ''),
  };
  const ev = new w.Event('paste', {bubbles: true, cancelable: true});
  Object.defineProperty(ev, 'clipboardData', {value: dt});
  editor.dispatchEvent(ev);
  return ev;
}
