/**
 * 成包编辑（查找替换 / 填充序列 / 选择性粘贴）的前端纯逻辑。
 *
 * 这一层只回答「要发什么」：范围怎么算、载荷长什么样。
 * **落盘在服务端**（`files.sheet_find_replace` / `sheet_fill_series` / `sheet_paste_special`），
 * 前端不自己改数据 —— 与其它写入口同一个口径。
 */

/** 网格选区（行、列都是 0 基；行 0 是第一条数据行）。 */
export interface GridRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export type SeriesType = 'linear' | 'date' | 'list' | 'copy';
export type PasteSpecialMode = 'values' | 'formulas' | 'formats';

export interface FindReplaceOptions {
  find: string;
  replace: string;
  matchCase: boolean;
  wholeCell: boolean;
}

export interface FillSeriesOptions {
  seriesType: SeriesType;
  step?: number;
  unit: 'day' | 'week' | 'month' | 'year';
  stopValue?: string;
  values?: string[];
}

export interface PasteSpecialOptions {
  mode: PasteSpecialMode;
  skipEmpty: boolean;
}

export function rangeRows(range: GridRange): number {
  return Math.max(0, range.endRow - range.startRow + 1);
}

export function rangeCols(range: GridRange): number {
  return Math.max(0, range.endCol - range.startCol + 1);
}

/**
 * 填充只支持「一列」或「一行」。
 * 跨多行多列的选区没法用一条序列说清（Excel 那是「每列各填各的」，
 * 那是另一条规则），这里说清楚比悄悄按第一列填好。
 */
export function isSingleLine(range: GridRange): boolean {
  const rows = rangeRows(range);
  const cols = rangeCols(range);
  return rows === 1 || cols === 1;
}

/** 填充方向：一行就往右，一列就往下。 */
export function fillDirection(range: GridRange): 'down' | 'right' {
  return rangeRows(range) > 1 ? 'down' : 'right';
}

/** 0 → A，25 → Z，26 → AA（Excel 的列名规则）。 */
export function columnLabel(index: number): string {
  let n = Math.floor(index) + 1;
  let label = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    label = String.fromCharCode(65 + rest) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** 区域的人话标签：A1、B2:C4（用户看得懂的写法）。 */
export function describeRange(range: GridRange): string {
  const start = `${columnLabel(range.startCol)}${range.startRow + 1}`;
  if (rangeRows(range) === 1 && rangeCols(range) === 1) return start;
  return `${start}:${columnLabel(range.endCol)}${range.endRow + 1}`;
}

export function buildFindReplacePayload(options: FindReplaceOptions): Record<string, unknown> {
  if (!options.find) throw Error('请填写要查找的内容');
  return {
    find: options.find,
    replace: options.replace ?? '',
    match_case: !!options.matchCase,
    whole_cell: !!options.wholeCell,
  };
}

export function buildFillSeriesPayload(
  range: GridRange,
  options: FillSeriesOptions,
): Record<string, unknown> {
  if (!isSingleLine(range)) throw Error('请选择一列或一行来填充（当前选区跨了多行多列）');
  const payload: Record<string, unknown> = {
    start_row: range.startRow,
    start_col: range.startCol,
    end_row: range.endRow,
    end_col: range.endCol,
    series_type: options.seriesType,
  };
  if (options.step !== undefined && options.step !== null && !Number.isNaN(options.step)) {
    payload.step = options.step;
  }
  if (options.seriesType === 'date') payload.unit = options.unit || 'day';
  if (options.stopValue !== undefined && options.stopValue !== '') payload.stop_value = options.stopValue;
  if (options.seriesType === 'list') payload.values = options.values ?? [];
  return payload;
}

export function buildPasteSpecialPayload(
  source: GridRange,
  target: GridRange,
  options: PasteSpecialOptions,
): Record<string, unknown> {
  return {
    source_row: source.startRow,
    source_col: source.startCol,
    source_rows: rangeRows(source),
    source_cols: rangeCols(source),
    target_row: target.startRow,
    target_col: target.startCol,
    mode: options.mode,
    skip_empty: !!options.skipEmpty,
  };
}
