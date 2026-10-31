/**
 * 公式编辑态的**区间选择**（FIX-15 / A14）。
 *
 * 用户原话：「公式无法向 excel 一样能够选择 xxx：xxx」——
 * 写 `=SUM(` 的时候想用鼠标框一个范围，而不是手打 A2:B10。
 *
 * **坐标口径与后端公式引擎同一把尺子**（不能各算各的）：
 *   · 表头占第 1 行 → 第一个**数据行**是第 2 行；
 *   · A 列是第一个**数据列**。
 * 依据：后端 `shangshu_files/formulas.py` 里 `r<2` 判引用非法（162 行）、
 * 取值用 `row-2`（244 行）。前端多算/少算一行，公式就会静默算错。
 *
 * 这里只放**纯函数**：地址换算、选区地址、命中判定、光标插入。
 * 交互（在画布上按下/拖动/松开）留在 sheet.ts 的公式编辑器里。
 */

export interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CellPoint {
  row: number;
  col: number;
}

/** 列序号（0 起）→ Excel 列字母：0→A，25→Z，26→AA。 */
export function excelColumnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw Error('列序号无效');
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** 网格坐标（行 0 起、列 0 起）→ Excel 地址。第一个数据行是第 2 行。 */
export function excelAddress(row: number, col: number): string {
  if (!Number.isInteger(row) || row < 0) throw Error('行序号无效');
  return excelColumnLetter(col) + String(row + 2);
}

/**
 * 一段选区的地址：单格给 `A2`，多格给 `A2:B10`。
 * 起止**归一化**（用户从右下往左上框也要给出同一个区间）。
 */
export function rangeAddress(anchor: CellPoint, focus: CellPoint): string {
  const startRow = Math.min(anchor.row, focus.row);
  const endRow = Math.max(anchor.row, focus.row);
  const startCol = Math.min(anchor.col, focus.col);
  const endCol = Math.max(anchor.col, focus.col);
  const start = excelAddress(startRow, startCol);
  if (startRow === endRow && startCol === endCol) return start;
  return start + ':' + excelAddress(endRow, endCol);
}

/**
 * 命中判定：点落在哪一格（host 相对坐标）。
 * 落在格线上的算**左边/上边**那一格（半开区间，不重叠）。
 * 没落在任何一格上 → null（不猜）。
 */
export function hitCell(
  cells: Array<CellPoint & { rect: CellRect }>,
  x: number,
  y: number,
): CellPoint | null {
  for (const cell of cells) {
    const { rect } = cell;
    if (x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height) {
      return { row: cell.row, col: cell.col };
    }
  }
  return null;
}

/** 在光标处插入一段引用，返回新文本与新光标位置。 */
export function insertAtCaret(text: string, caret: number, insertion: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  return { text: text.slice(0, at) + insertion + text.slice(at), caret: at + insertion.length };
}

/**
 * 尾巴上的一段**引用**（如 `B2`、`B2:B10`）。
 *
 * 只认「独立的一个」：前后不能再连着字母/数字/下划线，
 * 否则 `RATE1`（定义名）、`A1B2`（乱写的）会被误当成引用改掉。
 */
const REFERENCE_TAIL = /(\$?[A-Za-z]{1,3}\$?\d+)(:\$?[A-Za-z]{1,3}\$?\d+)?$/;
/** 词的组成字符：出现在引用前面就说明它不是独立的一个引用。 */
const TOKEN_CHARACTER = /[A-Za-z0-9_$.]/;

/**
 * 在光标处放一段引用：**光标处已经有一个引用，就把它换掉**。
 *
 * 为什么不是直接往后插：活站实测（3870，A14 临时表）
 * 「=SUM( → 点数量第一行 → =SUM(B2) → 再拖数量第二行到第三行」
 * 得到的是 **=SUM(B2B3:B4)** —— 中间的 `B2B3` 不是一个合法引用，
 * 存进去是「公式语法不完整」，算不出数。
 *
 * Excel 的做法是：新框的引用**替换**光标处那个引用。
 * 框错了再框一次是写公式时最常见的动作 —— 这条不通，区间选择就等于不好用。
 *
 * 光标处**没有**引用（末尾是运算符、或还没开始写）→ 照插，不动用户写的字。
 */
export function replaceReferenceAtCaret(text: string, caret: number, address: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const match = before.match(REFERENCE_TAIL);
  if (!match || match.index === undefined) return insertAtCaret(text, caret, address);
  const start = match.index;
  const previous = start > 0 ? before[start - 1] : '';
  /* 前面还连着别的词（名字、乱写的串）→ 那不是引用，照插。 */
  if (previous && TOKEN_CHARACTER.test(previous)) return insertAtCaret(text, caret, address);
  return { text: text.slice(0, start) + address + text.slice(at), caret: start + address.length };
}

/**
 * 公式编辑器的提示语。
 * 说清三件事：怎么框范围、怎么保存、怎么取消 —— 不用图标让人猜。
 */
export function formulaRangeHint(): string {
  return '在表格上按住拖选可插入范围（如 A2:B10）· Enter 保存 · Esc 取消';
}

/**
 * 公式编辑器的**初值**。
 *
 * 活站实测踩过的坑：接管 '=' 快捷键时 `preventDefault()` 把 "=" 这个字符**吃掉了**，
 * 而编辑器初值是「该格已有的公式」（空表就是空串）——
 * 于是用户接着写的 "SUM(B2)" 少了开头的 "="，后端按普通文本存，公式不生效。
 * 所以：该格**没有公式**时初值预填 "="（用户接着写 SUM(… 就行）；
 * **已有公式**时原样显示（不覆盖用户正在改的公式）。
 */
export function formulaSeed(existingFormula: string | undefined | null): string {
  return existingFormula ? existingFormula : '=';
}

/** 事件目标里我们关心的那几个属性。 */
export interface ShortcutTarget {
  tagName?: string;
  id?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

/**
 * 这是不是 Univer 自己的**内部编辑器**。
 *
 * 网格的键盘输入落在一个隐藏的 contenteditable div 上
 * （`#__editor___INTERNAL_EDITOR__…`，z-index:-2、文字透明）——
 * 也就是说**网格里按下的每一个键，target 都是 contenteditable**。
 */
export function isUniverInternalEditor(target: ShortcutTarget | null | undefined): boolean {
  if (!target) return false;
  if ((target.id || '').startsWith('__editor___INTERNAL_EDITOR__')) return true;
  return (target.getAttribute?.('data-u-comp') || '') === 'editor';
}

/** 这是不是**人用的**可编辑控件（表单输入框 / 富文本）。 */
function isUserEditableField(target: ShortcutTarget | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return target.isContentEditable === true;
}

/**
 * 「在网格上按 '=' 打开本域公式编辑器」的**接管判定**。
 *
 * 为什么要有这条（活站实测踩过的坑）：Univer 的网格键盘输入目标**就是**一个
 * contenteditable div。早前按「target 是可编辑元素就不接管」来避让人用的输入框，
 * 结果**网格里的 = 永远接不到** —— '=' 落进 Univer 原生编辑器（没有区间选择、
 * 选区地址还与后端差一行）。所以只避让**人用的**输入框，Univer 内部编辑器照接管。
 */
export function shouldTakeFormulaShortcut(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target: ShortcutTarget | null | undefined;
  /** Univer 原生编辑器此刻是不是开着（开着就说明用户正在改格内容）。 */
  editorVisible: boolean;
  /** 有没有一个可改的当前格（没有、或该列只读 → 不接管）。 */
  hasEditableCell: boolean;
}): boolean {
  if (input.key !== '=') return false;
  if (input.ctrlKey || input.metaKey || input.altKey || input.shiftKey) return false;
  if (input.editorVisible) return false;
  if (!input.hasEditableCell) return false;
  if (isUserEditableField(input.target) && !isUniverInternalEditor(input.target)) return false;
  return true;
}
