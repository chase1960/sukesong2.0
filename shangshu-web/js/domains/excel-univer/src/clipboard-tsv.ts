/** Excel/WPS 剪贴板的 TSV 值传输；不推断数字、日期或字段含义。 */
export function parseClipboardTsv(text: string): string[][] {
  if (text === '') return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let afterQuote = false;
  let endedWithRowBreak = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else value += ch;
      endedWithRowBreak = false;
      continue;
    }
    if (ch === '\t') {
      row.push(value); value = ''; afterQuote = false; endedWithRowBreak = false;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(value); rows.push(row);
      row = []; value = ''; afterQuote = false; endedWithRowBreak = true;
    } else if (afterQuote) {
      throw new Error('剪贴板单元格引号闭合后有多余字符，请重新复制');
    } else if (ch === '"' && value === '') {
      quoted = true; endedWithRowBreak = false;
    } else {
      value += ch; endedWithRowBreak = false;
    }
  }
  if (quoted) throw new Error('剪贴板单元格引号未闭合，请重新复制');
  // Excel 常在最后加行分隔符；只去掉这一个终止符的虚拟记录，不删实际空行。
  if (!endedWithRowBreak) { row.push(value); rows.push(row); }
  let width = 0;
  for (const item of rows) width = Math.max(width, item.length);
  for (const item of rows) while (item.length < width) item.push('');
  return rows;
}

/** 引号只保护特殊字符；矩形补空，空尾格及前导零仍是原始字符串。 */
export function serializeClipboardTsv(rows: readonly (readonly string[])[]): string {
  if (!rows.length) return '';
  let width = 1;
  for (const row of rows) width = Math.max(width, row.length);
  return rows.map((row) => Array.from({ length: width }, (_, column) => {
    const value = row[column] ?? '';
    // 单列空格要显式引用，才能与“没有剪贴板内容”区分并保留空行。
    return /[\t\r\n"]/.test(value) || (width === 1 && value === '')
      ? '"' + value.replace(/"/g, '""') + '"' : value;
  }).join('\t')).join('\r\n');
}
