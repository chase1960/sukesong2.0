import {formulaDisplay} from './formula-values';
/**
 * 表格数据访问的适配层：把「数据库业务表」和「真实 xlsx」两种存储接到同一套前端。
 *
 * 为什么要有这一层：界面不许让人选择「这是 xlsx 还是数据库」（契约 §1「员工看到相同的
 * 表格卡片、列头、编辑器和保存反馈，不展示 xlsx 列 / 数据库列」）。所以打开、翻页、
 * 改单格、查回执、下载都走同一个接口，底下两个实现各自对接自己的后端。
 *
 * 接口口径按 `fde/_归档/首日并行任务-2026-10-10/B-交付.md` §1–§9（B 的 v1 约定）。
 * 凡已有公开 ID 一律沿用，不另造平行写口。全链路 0 次 LLM 调用。
 *
 * 三态（B 约定 §0）：
 *   成功 = HTTP 200 且 ok:true      → 用 result 里的生效版本/值
 *   失败 = HTTP 4xx/5xx + 业务原因   → 展示原因，不换编号
 *   未知 = 超时/断网/回执丢失        → 按**原编号**查回执；**禁止**换新编号重发
 */

import { exportCurrentTable } from './export-helper';
import {validateFontPatch,validateStyleReceipt,type CellFontStyle,type FontStylePatch,type StyleTarget,type StyleWriteResult} from './font-style';

// —— 与 B 约定一致的形状 ————————————————————————————————————————

/** 单元格的类型化值。00123 回 text 不转数字；18 位长编号同样回 text。 */
export type CellValue = (
  | { type: 'text' | 'number' | 'date' | 'boolean' | 'empty'; value: string | number | boolean | null }
  /** 公式格今日只读：写入会明确拒绝，不悄悄抹公式。 */
  | { type: 'formula'; formula: string; value: string | number | null;result_version?:number;calculation_pending?:boolean }
  | {type:'hidden';hidden:true;value:null}) & {hidden?:boolean};

export interface SheetReadResult {
  /** 逻辑表 ID（xlsx 表 = 文件中心资源名，如 FILE-00012）。界面不区分存储类型。 */
  table: string;
  table_title: string;
  has_formulas?:boolean;
  /** 工作表固定身份（生成时定，重命名不变）。 */
  sheet: string;
  sheet_title: string;
  /** 内容版本。每次保存 +1，并发检查靠它。 */
  content_version: number;
  /** 结构版本。表头不变时不动；写请求必须带期望值。 */
  structure_version: number;
  headers: string[];
  /**
   * **整表的默认样式**（2026-10-30 性能：逐格 styles 只带「和默认不一样」的格
   *   ⇒ 默认样式**整表只发一次**，前端拿它当回落值 ⇒ 语义不变、体积大降）。
   */
  default_style?: CellFontStyle;
  writable: boolean;
  /** BASE967-22：能否下载原件（B 的 3cc18178 加的）。undefined = 后端未给，按钮按 fail-closed 隐藏。 */
  can_download?: boolean;
  /** E 2026-10-17：结构权（新投影 my_access.structure 或旧的 can_structure）。 */
  can_structure?: boolean;
  /** E 2026-10-17：六键权限投影（read/preview/download/write/review/structure）。 */
  my_access?: { structure?: boolean } & Record<string, unknown>;
  readonly_columns: string[];
  rows: Array<{ row_id: string; row_index?: number; source_modified?:string;
    /** PKG-004-T03 第 2 步：**受管记录的版本**（这一行背后是受管记录时的版本戳）。
     *  客户端写回来时带上 ⇒ 服务端能拒陈旧写（不是后写覆盖先写）。没有受管绑定就没有它。 */
    record_version?:string;
    values: Record<string, CellValue>;
    /**
     * 逐格显示格式（表头 → 格式视图）。
     * 合并说明：ours 这边按 CellFontStyle 读；fast 那边写的是宽松的
     * Record<string,unknown> —— **服务端的样式视图字段与 CellFontStyle 一一对应**
     * （font_size/font_color/bold/number_format/wrap_text/border/…），统一按
     * CellFontStyle 读，两边都保住了这份数据。
     */
    styles?:Record<string,CellFontStyle> }>;
  row_heights?:Record<string,number>;
  /** 列宽：键是**列序号（1 起）字符串**，单位 excel-char。只列有自定义宽度的列。 */
  column_widths: Record<string, number>;
  column_width_unit: 'excel-char';
  /** 有 search 时 = **命中数**；无 search 时 = 全表行数。分页在这上面翻。 */
  total_rows: number;
  /** B 多给：每列既有值的主导类型（服务端也用它拒「文本写进金额列」）。 */
  column_types?: Record<string, string | null>;
  /**
   * **列的取值清单**（下拉框／可搜索下拉的选项来源）。
   * 键＝表头；值＝那一列的标准项与「能不能填清单以外的值」。
   * ⚠️ **没声明清单的列不出现在这里**（不猜、不编）⇒ 前端只给出现在这里的列画下拉。
   */
  column_options?: Record<string, {
    options: string[];
    /**
     * **显示名**（存储值 ⇒ 给人看的那句话）（2026-10-29 用户口径）。
     * ⚠️ **显示名与存储值分开**：案号那两列的值是 `DD`／`F` 这种码 ⇒ 显示给中文，
     * **存进去的仍然是码**（算法按码表判）。
     */
    option_labels?: Record<string, string>;
    allow_custom?: boolean;
    custom_label?: string;
    source?: string;
  }>;
  /** 搜索词回显（有 search 时才有）。 */
  search?: string | null;
  /**
   * 保存前提示（只读表为 null）。
   * B 契约 §7.1.3：外链/自定义 XML 会被剔除、外链公式固化成当时的数、
   * 便签提取进「备注」列。保存前给用户看。
   */
  strip_notice?: string | null;
  file_operations?: { structure?: boolean; sort?: boolean; style?: boolean };
}

export type WriteOutcome =
  | {
      kind: 'success';
      rowId: string;
      header: string;
      value: CellValue | null;
      contentVersion: number;
      structureVersion: number;
      applied: boolean;
      idempotent: boolean;
      /** PKG-004：值来源。'db' = 晋升列经数据库规则保存；'file' = 普通列走文件写入。 */
      valueSource?: 'db' | 'file';
      /** 落盘后的列宽（0 起列序号 → 像素）。自动算宽时用服务端算出来的值。 */
      columnWidths?: Record<number, number>;
    }
  | { kind: 'rejected'; reason: string }
  /** 未知：回执丢失。必须按原编号查回执，不许换新编号重发。 */
  | { kind: 'unknown'; opId: string; reason: string };

export type ReceiptStatus = 'Succeeded' | 'Failed' | 'Running' | 'NotFound';

export interface ReceiptResult {
  status: ReceiptStatus;
  /** B 的今日补丁：Failed 回执带失败原因。 */
  failure_reason?: string;
  audit?: string;
}

/** 列。名字用表头（人和 assistant agent 都按表头说话），不暴露物理列名。 */
export interface TableColumn {
  header: string;
  /** 后端字段 id（数据库业务表才有；xlsx 列没有产品层固定列 ID）。 */
  fieldId?: string;
  type: 'text' | 'integer' | 'decimal' | 'date' | 'long_text' | string;
  readOnly: boolean;
  /**
   * **这一列的取值清单**（有清单 ⇒ 双击那格给下拉／可搜索下拉）。
   * ⚠️ 没有清单的列**不给**这个键 ⇒ 前端照旧自由填写。
   */
  options?: string[];
  /** 能不能填清单以外的值（**没写 = 能**；写 false 才是硬拦）。 */
  allowCustom?: boolean;
  /** 「自己填一个」那个口的文案（没写就不给这个口）。 */
  customLabel?: string;
}

export interface TableRow {
  /** 服务端发号的稳定行 ID，**不是可视行号**。排序/翻页/重开都不换号。 */
  rowId: string;
  values: Record<string, string | number | null>;
  typed?: Record<string, CellValue>;
  /**
   * 逐格显示格式（表头 → 格式视图）。
   * 合并说明：ours 这边按 CellFontStyle 读；fast 那边写的是宽松的
   * Record<string,unknown> —— 服务端的样式视图字段与 CellFontStyle 一一对应，
   * 统一按 CellFontStyle 读（fast 侧用它填 Univer 样式的那套字段也都在里面）。
   */
  styles?: Record<string,CellFontStyle>;
  rowIndex?: number;
  sourceModified?:string;
  /** **受管记录的版本**（PKG-004-T03 第 2 步）：写这一行时带回去。 */
  recordVersion?:string;
}

/** 成包编辑（第四批）的一次请求。载荷字段名与服务端动作 schema 一一对应。 */
export interface BulkActionArgs {
  tableId: string;
  sheetId: string;
  expectedContentVersion: number;
  expectedStructureVersion: number;
  /** 幂等键 / 撤回定位用的操作编号（同一次操作重试必须用同一把）。 */
  opId: string;
  payload: Record<string, unknown>;
}

/** 成包编辑的回执。`cells` 是逐格 before/after（撤回栈用）。 */
export interface BulkEditResult {
  applied: number;
  /** 命中的格数（查找替换用；其它动作与 applied 相同）。 */
  matched: number;
  /** 没写进去的格与原因（如实报，不静默）。 */
  skipped: Array<{ row_id?: string; header?: string; reason?: string }>;
  cells: Array<{ rowId: string; header: string; before: unknown; after: unknown }>;
  contentVersion: number;
  structureVersion: number;
  /** 'style' = 这次改的是格式（撤回按样式号回退）。 */
  kind?: string;
}

export interface TableMeta {
  tableId: string;
  sheetId: string;
  /** 工作表**真名**（人看的那个，如「库存」）。表头之外，助手也要知道在看哪张工作表。 */
  sheetTitle?: string;
  displayName: string;
  deletedRows?:Array<{rowId:string;rowIndex:number}>;
  hasFormulas?:boolean;
  contentVersion: number;
  structureVersion: number;
  columns: TableColumn[];
  totalRows: number;
  writable: boolean;
  /** 保存前提示（外链/自定义XML 会被剔除等）。null = 不用提示。 */
  stripNotice: string | null;
  /** 各列列宽（**像素**，已从 excel-char 换算）。键是列序号（0 起）。 */
  columnWidths: Record<number, number>;
  rowHeights?:Record<number,number>;
  /** BASE967-22：能否下载原件（B 的 sheet_read 回 can_download）。undefined = 不知道 → 按钮隐藏（fail-closed）。 */
  canDownload?: boolean;
  /** E 2026-10-17：结构权。undefined = 不知道 → 结构入口隐藏（fail-closed）。 */
  canStructure?: boolean;
  /** fast 那边加的：服务端支持哪些文件操作（结构/排序/格式）。没有就不提供这些动作。 */
  fileOperations?: SheetReadResult['file_operations'];
}

export interface TableSource {
  ready: boolean;
  writeStyle(args:{tableId:string;expectedContentVersion:number;expectedStructureVersion:number;opId:string;cells:StyleTarget[];style:FontStylePatch},signal?:AbortSignal):Promise<StyleWriteResult>;
  /**
   * 成包编辑（第四批）：查找替换 / 填充序列 / 选择性粘贴。
   * 三个都是「一次请求写一包、一次落盘、一步撤回」，回包带逐格 before/after。
   */
  findReplace(args:BulkActionArgs,signal?:AbortSignal):Promise<BulkEditResult>;
  fillSeries(args:BulkActionArgs,signal?:AbortSignal):Promise<BulkEditResult>;
  pasteSpecial(args:BulkActionArgs,signal?:AbortSignal):Promise<BulkEditResult>;
  open(tableId: string, signal?: AbortSignal): Promise<TableMeta>;
  readPage(
    tableId: string,
    options: { page: number; pageLength: number; search?: string; rowIds?: string[];headers?:string[] },
    signal?: AbortSignal,
  ): Promise<{ rows: TableRow[]; total: number; meta: TableMeta; defaultStyle?: CellFontStyle }>;
  writeCell(args: {
    tableId: string;
    sheetId: string;
    rowId: string;
    header: string;
    expectedContentVersion: number;
    expectedStructureVersion: number;
    value: CellValue;
    /** 幂等操作编号由调用方持有；回执丢失用同一把键重试。 */
    opId: string;
  }, signal?: AbortSignal): Promise<WriteOutcome>;
  /** 列宽写（用户要的「拖了刷新还在」）。只并入给出的列，未提到的不动。 */
  writeLayout(args: {
    tableId: string;
    sheetId: string;
    expectedContentVersion: number;
    expectedStructureVersion: number;
    /** 列序号（0 起）→ 像素。内部换算成 excel-char 再发。 */
    columnWidths: Record<number, number>;
  rowHeights?:Record<number,number>;
    opId: string;
    /** FIX-18 自动适应尺寸：按内容自动算宽的列（0 起）。服务端算完并进同一条 layout 写入口。 */
    autoFitColumns?: number[];
  }, signal?: AbortSignal): Promise<WriteOutcome>;
  receipt(opId: string, signal?: AbortSignal): Promise<ReceiptResult>;
  /** 下载真实文件字节，给独立解析核对用。 */
  download(tableId: string, signal?: AbortSignal): Promise<ArrayBuffer>;

  // —— 结构动作（N2-A1）—————————————————————————————————
  /**
   * 末尾加行。返回服务器发的稳定行 ID（`r-%06d`），前端不自造。
   * 加行只推 content_version，不动 structure_version。
   */
  appendRows(args: {
    tableId: string; sheetId: string;
    expectedContentVersion: number; expectedStructureVersion: number;
    count: number; opId: string;
  }, signal?: AbortSignal): Promise<{ rowIds: string[]; contentVersion: number; structureVersion: number }>;

  /**
   * 末尾加列。空表头 / 重名表头由服务端拒绝（417）。
   * 加列推 content_version + structure_version（结构变了）。
   */
  appendColumn(args: {
    tableId: string; sheetId: string;
    expectedContentVersion: number; expectedStructureVersion: number;
    header: string; opId: string;
  }, signal?: AbortSignal): Promise<{ contentVersion: number; structureVersion: number }>;

  /**
   * 改表头。列定位按表头名（from_header），不按列序号。
   * 改表头推 content_version + structure_version。
   */
  renameHeader(args: {
    tableId: string; sheetId: string;
    expectedContentVersion: number; expectedStructureVersion: number;
    fromHeader: string; toHeader: string; opId: string;
  }, signal?: AbortSignal): Promise<{ contentVersion: number; structureVersion: number }>;

  /**
   * 改表名（表标题）。只动 table_title，内容/结构版本都不动。
   */
  renameTable(args: {
    tableId: string; sheetId: string;
    expectedContentVersion: number; expectedStructureVersion: number;
    title: string; opId: string;
  }, signal?: AbortSignal): Promise<{ tableTitle: string }>;

  /**
   * 结构动作（**只管行**）。
   *
   * ⚠️ **「挪列」不在这里**（2026-10-29 撤掉那条自造管线）：
   *   原来有 `'column_move'` ⇒ 载荷带 `header`/`before_header` ⇒ 物理改写 xlsx 的列
   *   ⇒ **改的是全表**（用户原话：「你拖了别人也跟着变」）。
   *   ⇒ 现在挪列写**个人视图**（`files.sheet_view_save`，按人隔离，**不碰文件本身**）。
   */
  structureAction(args: { tableId: string; sheetId: string; expectedContentVersion: number; expectedStructureVersion: number; kind: 'row_move'|'row_restore'|'structure_undo'; target: string; before?: string; opId: string }, signal?: AbortSignal): Promise<{contentVersion:number;structureVersion:number}>;

  // BASE967-19：插/删行列（B 的 f32563d4）
  /** 在 before_row_id 前插 count 行（null=末尾）。返回新行 ID。 */
  insertRows(args: {
    tableId: string; sheetId: string;
    expectedContentVersion: number; expectedStructureVersion: number;
    beforeRowId: string | null; count: number; opId: string;
  }, signal?: AbortSignal): Promise<{ rowIds: string[]; contentVersion: number; structureVersion: number }>;
  /** 在 before_header 前插一列（null=末尾）。新列 promoted:false，不自动 DDL。 */
  insertColumn(args: {
    tableId: string; sheetId: string;
    expectedContentVersion: number; expectedStructureVersion: number;
    beforeHeader: string | null; header: string; opId: string;
  }, signal?: AbortSignal): Promise<{ header: string; contentVersion: number; structureVersion: number }>;
  /** 删行（软删除：DB 正式值保留，xlsx 隐藏行）。 */
  deleteRow(args: {
    tableId: string; sheetId: string;
    expectedContentVersion: number; expectedStructureVersion: number;
    rowId: string; opId: string;
  }, signal?: AbortSignal): Promise<{ deleted: boolean; contentVersion: number; structureVersion: number }>;
  /** 删列（已晋升的拒：「该列已晋升，请先撤晋升再删」）。 */
  deleteColumn(args: {
    tableId: string; sheetId: string;
    expectedContentVersion: number; expectedStructureVersion: number;
    header: string; opId: string;
  }, signal?: AbortSignal): Promise<{ deleted: boolean; contentVersion: number; structureVersion: number }>;
}

// —— 列宽单位换算（excel-char ↔ 像素）———————————————————————————

/**
 * B 给的列宽单位是 `excel-char`（Excel「字符」宽，openpyxl/Excel 原生单位），不是像素。
 * Excel 的定义是「默认字体下数字 0 的宽度」；Calibri 11 的标准换算是 px = chars*7 + 5。
 * 用它的原因：**往返稳定**（整数像素都精确还原），不会拖几次就漂。
 *   px=88 → (88-5)/7 = 11.857 → 11.857*7+5 = 88  ✓
 *   px=128 → (128-5)/7 = 17.571 → 17.571*7+5 = 128 ✓
 */
const CHAR_PX = 7;
const CHAR_PAD = 5;

export function pxToExcelChar(px: number): number {
  return Math.round(((px - CHAR_PAD) / CHAR_PX) * 100) / 100;
}

export function excelCharToPx(chars: number): number {
  return Math.round(chars * CHAR_PX + CHAR_PAD);
}

// —— 通用请求 ————————————————————————————————————————————————————

export class ApiError extends Error {
  status: number;
  code: string;
  /**
   * 服务端给的**排查编号**（trace id）。
   *
   * 为什么要有（2026-10-21 用户实测）：页面上**不许**贴英文原始错误
   * （`Not allowed via controller permission check<br><strong>…`），
   * 但用户要能把这事交给管理员 ⇒ 给一个**可复制的编号**，
   * 管理员拿它去服务端日志里查得到真正原因。
   */
  traceId?: string;
  constructor(status: number, code: string, message: string, traceId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (traceId) this.traceId = traceId;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'include',
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      ...init,
    });
  } catch (error) {
    // 网络层失败（断网、超时）属于「未知」，不是「失败」——调用方按原编号查回执。
    throw new ApiError(0, 'NETWORK', (error as Error)?.message || '网络请求未送达');
  }
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || (body && body.ok === false)) {
    throw new ApiError(response.status, body?.code || String(response.status),
      body?.error || body?.message || `请求失败（HTTP ${response.status}）`,
      typeof body?.trace_id === 'string' ? body.trace_id : undefined);
  }
  // 合并说明：ours 这边把回执里的 result 提到外层（body.receipt.result → body.result）；
  // fast 那边加的是「回执读不出来 ⇒ 不许当成功」（body 为 null 时抛 INVALID_RECEIPT）。
  // 两条都留：先提 result，再判空。
  if (body && body.result === undefined && body.receipt?.result !== undefined) body.result = body.receipt.result;
  if(body===null)throw new ApiError(0,'INVALID_RECEIPT','回执无法读取，请按原编号核实');
  return body as T;
}

/** 断线、超时与上游5xx都可能发生在提交之后，须原编号核实。 */
function isUnknown(error: unknown): boolean {
  const err = error as ApiError;
  return err?.status === 0 || err?.status === 408 || err?.status >= 500;
}

// —— xlsx 数据源（B 的 files.sheet_* 三件套）———————————————————————

const SVC_READ = '/api/platform/services/files.sheet_read/invoke';
const ACT_CELL_WRITE = '/api/platform/actions/files.sheet_cell_write/execute';
// BASE967-19：插/删行列（B 的 f32563d4 实现）
const ACT_ROW_INSERT = '/api/platform/actions/files.sheet_row_insert/execute';
const ACT_COL_INSERT = '/api/platform/actions/files.sheet_column_insert/execute';
const ACT_ROW_DELETE = '/api/platform/actions/files.sheet_row_delete/execute';
const ACT_COL_DELETE = '/api/platform/actions/files.sheet_column_delete/execute';
const ACT_LAYOUT = '/api/platform/actions/files.sheet_layout_update/execute';
// 结构动作（N2-A1）——B 契约 v1.1 的四个公共 Action
const ACT_ROW_APPEND = '/api/platform/actions/files.sheet_row_append/execute';
const ACT_COL_APPEND = '/api/platform/actions/files.sheet_column_append/execute';
const ACT_HEADER_RENAME = '/api/platform/actions/files.sheet_header_rename/execute';
const ACT_TABLE_RENAME = '/api/platform/actions/files.sheet_rename/execute';
const RECEIPT = (opId: string) => `/api/platform/action-requests/${encodeURIComponent(opId)}`;

/** 把 B 回包的一行，摊成前端要的「表头 → 显示值」。 */
function flattenRow(
  row: SheetReadResult['rows'][number],
  headers: string[],
  // 合并说明：ours 这边要 contentVersion（公式结果的版本对不上要标「待算」）；
  // fast 那边把返回类型写死了 —— 合并后用统一的 TableRow（ours 的形状更全，多了
  // rowIndex / sourceModified / recordVersion / typed）。
  contentVersion?:number,
): TableRow {
  const values: Record<string, string | number | null> = {};
  const typed={...row.values};
  for (const h of headers) {
    let cell = typed[h];
    if(cell?.type==='formula'&&cell.result_version!==undefined&&cell.result_version!==contentVersion)cell=typed[h]={...cell,value:null,calculation_pending:true};
    if (cell && (cell as CellValue & {hidden?:boolean}).hidden === true) { values[h] = "无权查看"; continue; }
    if (!cell) {
      values[h] = '';
      continue;
    }
    // 公式格显示缓存值，不把公式文本当值显示。
    /* ⚠️ **类型里留着 `boolean`**（2026-10-27 · PKG-126-T05）：布尔列服务端回的是真布尔，
       前面那个 `as string | number | null` 会把布尔**抹掉** ⇒ 下面判不了「是／否／未填」。 */
    let shown = formulaDisplay(cell) as string | number | boolean | null;
    // 日期显示归一：xlsx 的日期是「零点 datetime」，B 回 '2026-10-17T00:00:00'。
    // 显示/复制/导出都应一致成 2026-10-17（导出文件里是序列号 + yyyy-mm-dd 格式）。
    if (cell.type === 'date' && typeof shown === 'string') {
      const m = /^(\d{4}-\d{2}-\d{2})T00:00:00/.exec(shown);
      if (m) shown = m[1];
    }
    // ⚠️ **2026-10-27（PKG-126-T05）**：布尔列显示**是／否／空**。
    // 服务端回的是真布尔（true/false/null）⇒ 这里翻成界面上的字；
    // **空就是空**（未填）—— 不拿「否」顶替（那正是这一条要修的事）。
    if (cell.type === 'boolean') {
      values[h] = shown === true ? '是' : shown === false ? '否' : '';
      continue;
    }
    values[h] = shown as string | number | null;
  }
  // 合并说明：ours 这边多带回 rowIndex（行定位）/ sourceModified（源版本）/ recordVersion（受管记录版本）
  // / typed（类型化值）；fast 那边多了 styles 的兜底 `|| {}`（没有样式时给空对象）。
  // 两条都留。
  return { rowId: row.row_id, sourceModified:row.source_modified, recordVersion:row.record_version, values, typed, styles:row.styles||{},
    rowIndex: Number.isInteger(row.row_index) && row.row_index! >= 2 ? row.row_index! - 2 : undefined };
}

/**
 * 把 B 的列类型映射成前端 coerce() 认的类型。
 * B 回的是 `cell_typed` 的 type：text | number | date | boolean | empty | formula。
 * 前端 coerce() 认 integer/decimal 走数字，其余走文本，所以 number → decimal。
 * **不硬编码成 text**：那样金额列会被当文本提交，服务端拒「金额须为数字」，
 * 而且用户输错类型时前端给不出对的提示。
 */
function mapColumnType(raw: string | null | undefined): string {
  switch (raw) {
    case 'number': return 'decimal';   // coerce() 认 decimal → 提交成 number
    case 'date': return 'date';
    // ⚠️ **2026-10-27（PKG-126-T05）**：布尔列**不再当自由文本**。
    // 原来写的是「今日不做布尔特化」⇒ 人分不出「未填」和「否」，而且写「是」会被服务端
    // 按「开关列请使用 TRUE/FALSE 或 0/1」拒掉。
    // ⇒ 列类型给 'boolean' ⇒ 网格用**三态选择件**（未填／是／否），
    //   提交时由 `toTypedValue` 翻成真正的布尔值（服务端要的是 Python bool）。
    case 'boolean': return 'boolean';
    case 'formula': return 'text';     // 公式格只读，写由后端明确拒绝
    default: return 'text';
  }
}

export function decodeSheetView(data:SheetReadResult){
  return {rows:(data.rows||[]).map(row=>flattenRow(row,data.headers||[],data.content_version)),total:data.total_rows,meta:toMeta(data)};
}

function toMeta(data: SheetReadResult): TableMeta {
  const readonly = new Set(data.readonly_columns || []);
  const columnWidths: Record<number, number> = {};
  for (const [key, chars] of Object.entries(data.column_widths || {})) {
    // B 给的键是 1 起的列序号字符串，前端用 0 起。
    const oneBased = Number(key);
    if (Number.isFinite(oneBased) && oneBased >= 1) {
      columnWidths[oneBased - 1] = excelCharToPx(Number(chars));
    }
  }
  const types = data.column_types || {};
  const domains = data.column_options || {};
  return {
    tableId: data.table,
    sheetId: data.sheet,
    sheetTitle: data.sheet_title || data.sheet,
    displayName: data.table_title || data.table,
    deletedRows:((data as any).deleted_rows||[]).map((r:any)=>({rowId:r.row_id,rowIndex:r.row_index})),
    hasFormulas:data.has_formulas,
    contentVersion: data.content_version,
    structureVersion: data.structure_version,
    columns: (data.headers || []).map((header) => ({
      header,
      type: mapColumnType(types[header]),
      readOnly: !data.writable || readonly.has(header),
      // **这一列的取值清单**（服务端按晋升定义给的）。没声明清单的列**不给**这几个键
      // ⇒ 前端照旧自由填写（不猜、不编）。
      ...(domains[header] && Array.isArray(domains[header].options) && domains[header].options.length
        ? {
          options: domains[header].options.map(item => String(item)),
          // —— **显示名**（码 ⇒ 中文名；没有就不给 ⇒ 照旧显示它自己）——
          optionLabels: (domains[header].option_labels && typeof domains[header].option_labels === 'object')
            ? Object.fromEntries(Object.entries(domains[header].option_labels).map(([k, v]) => [String(k), String(v)]))
            : {},
          allowCustom: domains[header].allow_custom === undefined ? true : !!domains[header].allow_custom,
          customLabel: domains[header].custom_label ? String(domains[header].custom_label) : '',
        }
        : {}),
    })),
    totalRows: data.total_rows,
    writable: !!data.writable,
    stripNotice: data.strip_notice || null,
    columnWidths,
    rowHeights:Object.fromEntries(Object.entries(data.row_heights||{}).filter(([row])=>Number(row)>=2).map(([row,points])=>[Number(row)-2,Number(points)/.75])),
    // BASE967-22：B 的 sheet_read 回 can_download（3cc18178）
    canDownload: data.can_download === undefined ? undefined : !!data.can_download,
    // E 2026-10-17：结构权只认服务端给的布尔位；缺字段 = undefined（前端 fail-closed 隐藏入口）
    canStructure: (() => {
      const raw = data.my_access?.structure ?? data.can_structure;
      return raw === undefined ? undefined : !!raw;
    })(),
    // ★ fast 那边加的：服务端支持哪些文件操作（结构/排序/格式）。
    fileOperations: data.file_operations,
  };
}

/**
 * 成包编辑的统一发法：一个动作 id + 一份载荷 → 一次落盘。
 *
 * 回执里没有 content_version 就当「没核实」（抛错，让调用方按**原编号**查回执）——
 * 拿旧版本号当成功，是把「不知道」说成「成了」。
 */
async function bulkAction(actionId: string, args: BulkActionArgs, signal?: AbortSignal): Promise<BulkEditResult> {
  const body = await request<{ ok: true; result?: any; idempotent?: boolean }>(
    `/api/platform/actions/${actionId}/execute`, {
      method: 'POST', credentials: 'include', signal,
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          op_id: args.opId,
          ...args.payload,
        },
        confirmed: true, idempotency_key: args.opId, source: 'user',
      }),
    });
  const result = body?.result || {};
  if (typeof result.content_version !== 'number') throw new Error('保存回执不完整，请重试原操作');
  return {
    applied: Number(result.applied || 0),
    matched: Number(result.matched ?? result.applied ?? 0),
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
    cells: (result.cells || []).map((cell: any) => ({
      rowId: String(cell.row_id || ''),
      header: String(cell.header || ''),
      before: cell.before,
      after: cell.after,
    })),
    contentVersion: result.content_version,
    structureVersion: Number(result.structure_version || 0),
    kind: result.kind,
  };
}

export const xlsxSource: TableSource = {
  ready: true,
  async writeStyle(args,signal){
    const body=await request<{result:StyleWriteResult}>('/api/platform/actions/files.sheet_style_write/execute',{
      method:'POST',credentials:'include',signal,
      body:JSON.stringify({payload:{table:args.tableId,expected_content_version:args.expectedContentVersion,
        expected_structure_version:args.expectedStructureVersion,op_id:args.opId,cells:args.cells,style:validateFontPatch(args.style)},
        confirmed:true,idempotency_key:args.opId,source:'user'}),
    });
    return validateStyleReceipt(body?.result,args.tableId,args.opId,args.cells);
  },

  // 成包编辑（第四批）：三个动作同一套发法 —— 一个请求写一包、一次落盘、一步撤回。
  async findReplace(args,signal){ return bulkAction('files.sheet_find_replace',args,signal); },
  async fillSeries(args,signal){ return bulkAction('files.sheet_fill_series',args,signal); },
  async pasteSpecial(args,signal){ return bulkAction('files.sheet_paste_special',args,signal); },



  async open(tableId, signal) {
    const query=new URLSearchParams({payload:JSON.stringify({table:tableId,page:1,page_length:1})});
    const body = await request<{ ok: true } & SheetReadResult>(SVC_READ+'?'+query, {signal});
    return toMeta(body);
  },

  async readPage(tableId, options, signal) {
    const query=new URLSearchParams({payload:JSON.stringify({
          table: tableId,
          page: options.page,
          page_length: options.pageLength,
          ...(options.search ? { search: options.search } : {}),
          ...(options.rowIds ? { row_ids: options.rowIds } : {}),
          ...(options.headers ? {headers:options.headers} : {}),
    })});
    const body = await request<{ ok: true } & SheetReadResult>(SVC_READ+'?'+query, {signal});
    const headers = body.headers || [];
    return {
      rows: (body.rows || []).map((row) => flattenRow(row, headers,body.content_version)),
      total: body.total_rows,
      meta: toMeta(body),
      // —— **默认样式**（服务端整表只发一次）⇒ 前端拿它当没单独给样式的格的回落值 ——
      defaultStyle: body.default_style,
    };
  },

  async writeCell(args, signal) {
    try {
      const body = await request<{ ok: true; result: any; idempotent?: boolean }>(ACT_CELL_WRITE, {
        method: 'POST',
        body: JSON.stringify({
          payload: {
            table: args.tableId,
            sheet: args.sheetId,
            row_id: args.rowId,
            header: args.header,
            expected_content_version: args.expectedContentVersion,
            expected_structure_version: args.expectedStructureVersion,
            value: args.value,
          },
          confirmed: true,
          idempotency_key: args.opId,
          source: 'user',
        }),
        signal,
      });
      const r = body.result || {};
      if(r.table!==args.tableId||r.row_id!==args.rowId||r.header!==args.header||!Number.isInteger(r.content_version)||!Number.isInteger(r.structure_version))
        throw new ApiError(0,'INVALID_RECEIPT','保存回执不完整，请按原编号核实');
      return {
        kind: 'success',
        rowId: r.row_id,
        header: r.header,
        value: r.value ?? null,
        contentVersion: r.content_version,
        structureVersion: r.structure_version,
        applied: !!r.applied,
        idempotent: !!body.idempotent,
        // E 2026-10-15 纠正：后端回的是 routed: 'database'|'sheet'，不是 value_source
        valueSource: r.routed === 'database' ? 'db' : 'file',
      };
    } catch (error) {
      const err = error as ApiError;
      if (isUnknown(error)) {
        return { kind: 'unknown', opId: args.opId, reason: err.message };
      }
      return { kind: 'rejected', reason: err.message };
    }
  },

  async writeLayout(args, signal) {
    // 只并入给出的列，键换算成 B 要的 1 起 + excel-char。
    const columnWidths: Record<string, number> = {};
    for (const [index, px] of Object.entries(args.columnWidths)) {
      const zeroBased = Number(index);
      if (!Number.isFinite(zeroBased) || zeroBased < 0) continue;
      columnWidths[String(zeroBased + 1)] = pxToExcelChar(Number(px));
    }
    // 自动算宽：列序号同样按 1 起发；服务端按内容算完并进同一条写入口。
    const autoFitColumns = (args.autoFitColumns || []).filter(index => Number.isFinite(index) && index >= 0)
      .map(index => index + 1);
    try {
      const body = await request<{ ok: true; result: any; idempotent?: boolean }>(ACT_LAYOUT, {
        method: 'POST',
        body: JSON.stringify({
          payload: {
            table: args.tableId,
            sheet: args.sheetId,
            expected_content_version: args.expectedContentVersion,
            expected_structure_version: args.expectedStructureVersion,
            column_widths: columnWidths,
            ...(autoFitColumns.length ? { auto_fit_columns: autoFitColumns } : {}),
          },
          confirmed: true,
          idempotency_key: args.opId,
          source: 'user',
        }),
        signal,
      });
      const r = body.result || {};
      // 合并说明：ours 这边把服务端回的「落盘后的列宽」算成像素给前端；
      // fast 那边加的是「回执不完整 ⇒ 不许当成功」。两条都留：先校验回执，再算列宽。
      if(r.table!==args.tableId||!Number.isInteger(r.content_version)||!Number.isInteger(r.structure_version))
        throw new ApiError(0,'INVALID_RECEIPT','列宽回执不完整，请按原编号核实');
      // 服务端回「落盘后的列宽」（自动算宽时是算出来的值），前端照它更新网格。
      const applied: Record<number, number> = {};
      for (const [key, chars] of Object.entries(r.column_widths || {})) {
        const oneBased = Number(key);
        if (Number.isFinite(oneBased) && oneBased >= 1) applied[oneBased - 1] = excelCharToPx(Number(chars));
      }
      return {
        kind: 'success',
        rowId: '',
        header: '',
        value: null,
        contentVersion: r.content_version,
        structureVersion: r.structure_version,
        applied: r.applied !== false,
        idempotent: !!body.idempotent,
        columnWidths: applied,
      };
    } catch (error) {
      const err = error as ApiError;
      if (isUnknown(error)) {
        return { kind: 'unknown', opId: args.opId, reason: err.message };
      }
      return { kind: 'rejected', reason: err.message };
    }
  },

  async receipt(opId, signal) {
    try {
      const body = await request<any>(RECEIPT(opId), { signal });
      return { status: body.status, failure_reason: body.failure_reason, audit: body.audit };
    } catch {
      // 查回执本身失败，当 NotFound 处理会让调用方误以为能重发。
      // 保守返回 Running：宁可让上层再查一次，也不能双写。
      return { status: 'Running' };
    }
  },

  async download(tableId, signal) {
    // 合并说明：fast 那边在下载前显式核对「下载权 + 固定文件引用」两道闸
    //   （没有下载权 / 引用不完整 ⇒ 明确拒，不许先下后判）。
    // ours 这边走**公共导出通道** exportCurrentTable —— 那条通道里已经有这两道闸，而且更严：
    //   ① readExportCapabilities 先核对资源名、固定文件引用与 can_download（没有就不发字节请求）；
    //   ② 取完字节**再复核一次**版本与权限（下载期间撤权/换版 ⇒ 不交旧内容）。
    // 所以这里不再单独调一次 files.versions（那是同一份元数据读两遍，还会多发一次请求）。
    return (await exportCurrentTable(tableId, 'xlsx', { signal })).bytes;
  },

  // —— 结构动作（N2-A1）—————————————————————————————————

  async appendRows(args, signal) {
    const body = await request<{ ok: true; result: any }>(ACT_ROW_APPEND, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          count: args.count,
        },
        confirmed: true,
        idempotency_key: args.opId,
        source: 'user',
      }),
      signal,
    });
    const r = body.result || {};
    return {
      rowIds: r.row_ids || [],
      contentVersion: r.content_version,
      structureVersion: r.structure_version,
    };
  },

  async appendColumn(args, signal) {
    const body = await request<{ ok: true; result: any }>(ACT_COL_APPEND, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          header: args.header,
        },
        confirmed: true,
        idempotency_key: args.opId,
        source: 'user',
      }),
      signal,
    });
    const r = body.result || {};
    return { contentVersion: r.content_version, structureVersion: r.structure_version };
  },

  async renameHeader(args, signal) {
    const body = await request<{ ok: true; result: any }>(ACT_HEADER_RENAME, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          from_header: args.fromHeader,
          to_header: args.toHeader,
        },
        confirmed: true,
        idempotency_key: args.opId,
        source: 'user',
      }),
      signal,
    });
    const r = body.result || {};
    return { contentVersion: r.content_version, structureVersion: r.structure_version };
  },

  async renameTable(args, signal) {
    const body = await request<{ ok: true; result: any }>(ACT_TABLE_RENAME, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          title: args.title,
        },
        confirmed: true,
        idempotency_key: args.opId,
        source: 'user',
      }),
      signal,
    });
    const r = body.result || {};
    return { tableTitle: r.table_title || args.title };
  },

  // BASE967-19：插/删行列（**只管行**；挪列走个人视图，不在这里）
  async structureAction(args, signal) {
    const targetKey = args.kind === 'structure_undo' ? 'undo_of' : 'row_id';
    const payload: Record<string, unknown> = {table:args.tableId, expected_content_version:args.expectedContentVersion, expected_structure_version:args.expectedStructureVersion, [targetKey]:args.target, op_id:args.opId};
    if (args.kind !== 'structure_undo') payload.sheet = args.sheetId;
    if (args.before) payload.before_row_id = args.before;
    const body = await request<any>('/api/platform/actions/files.sheet_'+args.kind+'/execute', {method:'POST', body:JSON.stringify({payload,confirmed:true,idempotency_key:args.opId,source:'user'}),signal});
    return {contentVersion:body.result.content_version,structureVersion:body.result.structure_version};
  },

  async insertRows(args, signal) {
    const body = await request<{ ok: true; result: any }>(ACT_ROW_INSERT, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          before_row_id: args.beforeRowId,
          count: args.count,
        },
        confirmed: true,
        idempotency_key: args.opId,
        source: 'user',
      }),
      signal,
    });
    const r = body.result || {};
    return {
      rowIds: Array.isArray(r.row_ids) ? r.row_ids : [],
      contentVersion: r.content_version,
      structureVersion: r.structure_version,
    };
  },

  async insertColumn(args, signal) {
    const body = await request<{ ok: true; result: any }>(ACT_COL_INSERT, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          before_header: args.beforeHeader,
          header: args.header,
        },
        confirmed: true,
        idempotency_key: args.opId,
        source: 'user',
      }),
      signal,
    });
    const r = body.result || {};
    return {
      header: r.header || args.header,
      contentVersion: r.content_version,
      structureVersion: r.structure_version,
    };
  },

  async deleteRow(args, signal) {
    const body = await request<{ ok: true; result: any }>(ACT_ROW_DELETE, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          row_id: args.rowId,
        },
        confirmed: true,
        idempotency_key: args.opId,
        source: 'user',
      }),
      signal,
    });
    const r = body.result || {};
    return {
      deleted: r.deleted === true,
      contentVersion: r.content_version,
      structureVersion: r.structure_version,
    };
  },

  async deleteColumn(args, signal) {
    const body = await request<{ ok: true; result: any }>(ACT_COL_DELETE, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          table: args.tableId,
          sheet: args.sheetId,
          expected_content_version: args.expectedContentVersion,
          expected_structure_version: args.expectedStructureVersion,
          header: args.header,
        },
        confirmed: true,
        idempotency_key: args.opId,
        source: 'user',
      }),
      signal,
    });
    const r = body.result || {};
    return {
      deleted: r.deleted === true,
      contentVersion: r.content_version,
      structureVersion: r.structure_version,
    };
  },
};

// —— 数据源分流 ————————————————————————————————————————————————

/**
 * 真正的分流在 `backend.ts` 的 `openTable()`：**先查业务表清单，在就走业务表，
 * 不在就当 xlsx 开**。这里不按 ID 长相猜——xlsx 的表 ID 实测是短 id（`e7gjttmv2o`），
 * 跟业务表 ID 一样，猜必错（A2 曾因此报「没有找到这张表」）。
 * 这里只保留 xlsx 实现本身。
 */
export const xlsxTableSource: TableSource = xlsxSource;
