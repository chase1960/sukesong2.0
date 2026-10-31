/** 选区复制只有这一份载荷；按钮、系统 copy 事件与诊断共享它。 */
export interface ClipboardRange {
  startRow: number; startCol: number; endRow: number; endCol: number;
}
export interface ClipboardPayload {
  tsv: string; html: string; rows: string[][]; range: ClipboardRange;
}
export function buildClipboardPayload(options: {
  range: ClipboardRange;
  getCellText(row: number, col: number): string | null;
  isRowLoaded(row: number): boolean;
  serializeTsv(rows: readonly (readonly string[])[]): string;
}): ClipboardPayload {
  const { range } = options;
  if (![range.startRow, range.startCol, range.endRow, range.endCol].every(n => Number.isInteger(n) && n >= 0)
      || range.endRow < range.startRow || range.endCol < range.startCol) throw Error('请先选择要复制的单元格');
  const cells = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  if (cells > 100000) throw Error('选区超过十万格，请缩小选区，或导出整张表');
  for (let row = range.startRow; row <= range.endRow; row++) {
    if (!options.isRowLoaded(row)) throw Error('选区包含尚未加载的行，请先打开这些行，或缩小选区');
  }
  const rows: string[][] = [];
  for (let row = range.startRow; row <= range.endRow; row++) {
    const values: string[] = [];
    for (let col = range.startCol; col <= range.endCol; col++) values.push(options.getCellText(row, col) ?? '');
    rows.push(values);
  }
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r\n|\r|\n/g, '<br>');
  const html = '<table style="border-collapse:collapse;">' + rows.map(row => '<tr>'
    + row.map(value => `<td style="border:1px solid #ccc;padding:4px 8px;">${escape(value)}</td>`).join('')
    + '</tr>').join('') + '</table>';
  return { rows, range: { ...range }, tsv: options.serializeTsv(rows), html };
}

export async function writeSelectionClipboard(payload: ClipboardPayload, clipboard: Pick<Clipboard, 'write' | 'writeText'>,
  Item: typeof ClipboardItem | undefined): Promise<'rich' | 'text'> {
  if (clipboard?.write && Item) {
    await clipboard.write([new Item({
      'text/plain': new Blob([payload.tsv], { type: 'text/plain' }),
      'text/html': new Blob([payload.html], { type: 'text/html' }),
    })]);
    return 'rich';
  }
  if (!clipboard?.writeText) throw Error('浏览器不支持按钮复制，请在选区按 Cmd/Ctrl+C');
  await clipboard.writeText(payload.tsv);
  return 'text';
}

export async function readSelectionClipboard(clipboard: Pick<Clipboard, 'readText'> | undefined): Promise<string> {
  if (!clipboard?.readText) throw Error('浏览器不支持读取剪贴板，请在选区按 Cmd/Ctrl+V');
  return clipboard.readText();
}

/**
 * 复制源和粘贴目标**必须同一张表**。
 *
 * 为什么是硬要求：服务端 files.sheet_paste_special 的载荷里只有坐标
 * （source_row / source_col / source_rows / source_cols），**没有表身份** ——
 * 它按坐标从「当前这张表」取源（源码 paste_special 写着「源区域与目标区域都在这张表里」）。
 * 所以跨表粘贴**不会报错**，只会把当前表里同一坐标的数据悄悄粘过去。
 *
 * 口径：源表未知（null）时**不拦下** —— 宁可不拦，也不要把正常用法堵死。
 */
export function copiedSourceMatchesTable(sourceTableKey: string | null, currentTableKey: string | null): boolean {
  if (sourceTableKey == null || currentTableKey == null) return true;
  return sourceTableKey === currentTableKey;
}

/** 普通输入框保留自己的快捷键；工作面卸载后不能吞掉其他页面的键。 */
export function workbookShortcutAllowed(event: KeyboardEvent, host: HTMLElement, editingGrid: boolean, gridSelected = false): boolean {
  const canvasFocus = gridSelected && event.target === host.ownerDocument?.body;
  if (!host.isConnected || (!host.contains(event.target as Node) && !canvasFocus)) return false;
  const target = event.target as Element | null;
  return editingGrid || !target?.closest?.('input,textarea,[contenteditable="true"]');
}
