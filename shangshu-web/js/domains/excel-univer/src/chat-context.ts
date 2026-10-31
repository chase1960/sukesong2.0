/**
 * Excel 页 → 助手：把「用户当前正在看哪张表」说清楚。
 *
 * 为什么必须有（2026-10-19 FIX-03，A16 实测）：
 * 助手答「这张表里金额是 88.88」，而界面网格显示的是 10.5。根因不是助手算错，
 * 是**它根本不知道用户开着哪张表** —— Excel 域**从不发**上下文，
 * 助手只能从目录里猜一张（测试夹具里每张表内容一样，于是答了另一张表的值）。
 *
 * 这里只做两件事：
 * ① 开表时把**表身份**（表 ID、表名、工作表、当前选区）报上去；
 * ② 回清单时把上下文**换成清单级**（别让人回到列表还拿着上一张表的身份）。
 *
 * **不替助手读表** —— 事实仍旧由助手用工具重查（读口走**合并读**，
 * 晋升列以数据库正式值为准，见后端 `read_merge`）。
 */

/** 一张表的身份（只取页面上真有的字段，不编）。 */
export interface ExcelTableRef {
  /** 表身份：xlsx 是文件编号，业务表是对象编号。 */
  key: string;
  /** 表名（人看的名字）。 */
  title?: string;
  /** 存储类型：'db' 业务表 / 'xlsx' 文件表。 */
  kind?: 'db' | 'xlsx';
  /** 当前工作表名（文件表才有）。 */
  sheet?: string;
}

/** 发给助手的上下文（字段名与产品壳其余页面一致）。 */
export interface ExcelChatContext {
  module: string;
  view: string;
  entity_type: string;
  entity_id: string;
  label: string;
  sheet?: string;
  selection?: string;
  editable_scope: string;
  /** 当前选区里**用户屏幕上看得见**的那部分（行名 · 列名 · 值）。 */
  content?: ExcelChatContent;
}

/** 内容段（**通用键**，与内核那套一致）。 */
export interface ExcelChatContent {
  kind: string;
  text: string;
  truncated: boolean;
  items: string[];
  refs: Array<{ via: 'record' | 'service'; entity_type?: string; entity_id?: string; service_id?: string; payload?: Record<string, unknown> }>;
}

/** 选区里的一格：**行名**（业务标识）、**列名**（表头）、**值**（正式值）。 */
export interface ExcelSelectionCell {
  /** 行名：那一行的业务标识；拿不到就不给（**不许编**）。 */
  rowName?: string;
  /** 列名：选中格的表头。 */
  columnName?: string;
  /** 格子的值（按当前用户看得见的正式值）。 */
  value?: string;
}

/** 内容段正文上限（字符）—— 够看几行，不许把整张表倒进提示词。 */
export const MAX_SELECTION_CONTENT_CHARS = 1200;
/** 最多报几行（每行一条记录出处，出处条数有上限）。 */
export const MAX_SELECTION_CONTENT_ROWS = 8;
/** 最多报几列。 */
export const MAX_SELECTION_CONTENT_COLS = 5;

/** 表类型的对外说法：业务表是平台对象，文件表是文件。 */
function entityTypeFor(table: ExcelTableRef): string {
  return table.kind === 'db' ? 'object' : 'files.file';
}

/**
 * 开着表时的上下文。
 *
 * `entity_id` 给的是**表 ID**（助手读表时要拿它当表身份传），
 * `label` 给的是**表名**（人话，助手复述时用得上）。
 * `editable_scope` 里再把表 ID 说一遍 —— 助手只知道「这张表」时，
 * 容易去目录里猜同名表；写操作一律要确认，助手自己别改表。
 */
export function buildTableContext(
  table: ExcelTableRef | null,
  options: { selection?: string; content?: ExcelChatContent } = {},
): ExcelChatContext | null {
  if (!table || !table.key) return null;
  const id = String(table.key);
  const title = String(table.title || '').trim() || id;
  const context: ExcelChatContext = {
    module: 'excel',
    view: 'table',
    entity_type: entityTypeFor(table),
    entity_id: id,
    label: title,
    editable_scope:
      `当前打开的是这张表：${title}（表 ID：${id}）。`
      + `回答表格内容时按这个表 ID 读，读到的值以数据库正式值为准；`
      + `写操作必须先给确认提案，不得直接改表。`,
  };
  if (table.sheet) context.sheet = String(table.sheet);
  if (options.selection) context.selection = String(options.selection);
  if (options.content) context.content = options.content;
  return context;
}

/**
 * 选区 → 内容段（**用户屏幕上已经看得到的那部分**）。
 *
 * 每格带**行名 · 列名 · 值**（用户 2026-10-21 的原话：行名、列名、格子的值）。
 * · 行名拿不到就写「（没有行名）」—— **不许编**；
 * · 值取**正式值**（不是显示格式），服务端核对才对得上；
 * · 出处（refs）让服务端**按当前身份重读**这些行/这些格：读不到 ⇒ 整段丢弃。
 */
export function buildSelectionContent(
  cells: ExcelSelectionCell[],
  options: {
    /** 业务表：对象类型编号（读一条记录用）；文件表：'files.file'。 */
    entityType: string;
    /** 业务表：对象编号；文件表：文件编号。 */
    entityId: string;
    /** 文件表：读表用的表身份（resourceId ?? key）。 */
    readTable?: string;
    /** 存储类型（决定出处是「读记录」还是「读表」）。 */
    storageKind?: 'db' | 'xlsx';
  },
): ExcelChatContent | undefined {
  const list = (cells || []).filter(cell => cell && String(cell.value ?? '') !== '');
  if (!list.length) return undefined;
  const lines = list.map(cell => `行「${cell.rowName || '（没有行名）'}」· 列「${cell.columnName || '（没有列名）'}」= ${cell.value}`);
  let text = lines.join('\n');
  let truncated = false;
  if (text.length > MAX_SELECTION_CONTENT_CHARS) {
    text = text.slice(0, MAX_SELECTION_CONTENT_CHARS);
    truncated = true;
  }
  const items = list.map(cell => String(cell.value)).filter(value => value.length > 0).slice(0, 100);
  // 出处：**每一行**都要能被服务端按当前身份重读到（业务表读记录、文件表读表）。
  const rowNames = [...new Set(list.map(cell => String(cell.rowName || '')).filter(name => name.length > 0))];
  const refs: ExcelChatContent['refs'] = options.storageKind === 'db'
    ? rowNames.slice(0, MAX_SELECTION_CONTENT_ROWS).map(rowName => ({
      via: 'record' as const, entity_type: options.entityType, entity_id: rowName,
    }))
    : [{
      via: 'service' as const,
      service_id: 'files.sheet_read',
      entity_type: options.entityType,
      entity_id: options.entityId,
      payload: { table: options.readTable || options.entityId, row_ids: rowNames.slice(0, MAX_SELECTION_CONTENT_ROWS) },
    }];
  if (!refs.length) return undefined;
  return { kind: 'cells', text, truncated, items, refs };
}

/** 回到清单时的上下文：**没打开任何表**，助手不许猜是哪张表。 */
export function buildListContext(): ExcelChatContext {
  return {
    module: 'excel',
    view: 'file-list',
    entity_type: 'page',
    entity_id: 'excel',
    label: 'Excel 表格列表',
    editable_scope:
      '当前在表格清单页，用户没有打开具体表格。'
      + '问「这张表」时先请用户说明是哪张，或列出他有权看的表让他选；不要自己挑一张。',
  };
}

/** 列号 → 列字母（0 基 → A、Z、AA…）。 */
export function columnLetter(index: number): string {
  let n = Math.floor(index) + 1;
  let out = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * 选区 → 单元格说法（'B2' / 'B2:D5'）。
 *
 * 行号**加 2**：表格第 1 行是表头，第 1 行数据在表里是第 2 行 —— 与服务端
 * `row_index`（表头=1，首个数据行=2）同一把尺子。
 */
export function selectionLabel(
  range: { startRow: number; startCol: number; endRow: number; endCol: number } | null | undefined,
): string {
  if (!range) return '';
  const start = `${columnLetter(range.startCol)}${range.startRow + 2}`;
  const end = `${columnLetter(range.endCol)}${range.endRow + 2}`;
  return start === end ? start : `${start}:${end}`;
}
