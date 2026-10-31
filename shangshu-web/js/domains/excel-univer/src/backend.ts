import {attachCompanionTable} from './companion-table';
import {platformObjectList,platformObjectDefinition,platformTableResource} from './platform-catalog';
import {editableFormula} from './formula-values';
import {personalColumnOrder,requestColumnValues,requestPersonalView,type ColumnValues,type PersonalView,type PersonalViewResult} from './personal-view';
/**
 * 统一的「一张表」后端：数据库业务表和真实 xlsx 各一个实现，接到同一套前端。
 *
 * 复用表格卡片、编辑器和保存反馈；入口标明「业务数据」或「文件工作簿」。
 * 两种事实分别走原公共对象动作或文件动作，不把上传工作簿自动转换为业务库。
 *
 * 两边的行标识、列标识都归一到同一套键上，前端其余部分因此不用分叉：
 *   行标识  数据库表 = name（服务端发号，排序/翻页/重开不换号）
 *           xlsx     = row_id（服务端按位置发号并持久化，跨保存/重开/翻页不变）
 *           两边都**不是可视行号**，前端一律当 `row.name` 用。
 *   列标识  数据库表 = 字段 id
 *           xlsx     = 表头文本（人和 assistant agent 都按表头说话，不暴露物理列）
 *
 * 版本号两边含义不同，但都是「写之前要带、写之后要更新」的并发闸：
 *   数据库表 = expected_revision + expected_modified（记录级）
 *   xlsx     = expected_content_version + expected_structure_version（表级）
 *
 * 全链路 0 次 LLM 调用。只走既有公开口，不另造平行写口。
 */
import {
  fetchRecords,
  coerceObjectValue,
  updateRecord,
  type ObjectField,
  type ObjectInfo,
  type RecordRow,
} from './api';
import {
  applyPaste,
  displayCellValue,
  isColumnWritable,
  planPaste,
  type PasteRow,
} from './db-capabilities';
import { xlsxSource, decodeSheetView, type BulkEditResult, type CellValue, type TableMeta, type TableRow } from './adapter';
import type { GridColumn } from './sheet';
import type {CellFontStyle,FontStylePatch,StyleTarget,StyleWriteResult} from './font-style';
import type {ExcelCellCandidateAction} from './row-behaviors';

/** 成包编辑的调用参数：载荷 + 操作编号（幂等键 / 撤回定位用）。 */
export interface BulkEditOptions {
  payload: Record<string, unknown>;
  opId: string;
  expectedContentVersion?: number;
  expectedStructureVersion?: number;
}

/** 前端统一的行：`name` 是稳定行标识，其余键是列标识 → 显示值。 */
export type UnifiedRow = RecordRow;
/** 行显示元数据随原记录对象保存，不占用用户的字段名。 */
const rowViewMetadata = new WeakMap<RecordRow, { types: Record<string, string>; formulas?:Record<string,string|undefined>;pendingFormulas?:string[];sourceModified?:string; rowIndex?: number;styles?:Record<string,CellFontStyle> }>();
export const getRowViewMetadata = (row: RecordRow) => rowViewMetadata.get(row);
export function setRowFontStyle(row:RecordRow,header:string,style:CellFontStyle){const meta=rowViewMetadata.get(row);if(meta){meta.styles??={};meta.styles[header]={...style};}}

export interface WriteRequest {
  /** 稳定行标识（数据库 name / xlsx row_id）。 */
  rowId: string;
  /** 列标识（数据库字段 id / xlsx 表头）。 */
  fieldId: string;
  /** 列类型，用来把格子文本转成服务端要的类型化值。 */
  fieldType: string;
  /** 提交给服务端的值：数值列是 number，其余是 string。 */
  value: string | number | null;
  /** 格子里的原文（xlsx 发类型化值时用它，前导零因此不丢）。 */
  text: string;
  /** 幂等操作编号由调用方持有；回执丢失用同一把键重试。 */
  idempotencyKey: string;
  /** 数据库表的记录级并发闸（改前 modified）。xlsx 不用。 */
  expectedModified?: string;
  /**
   * **领域确认动作**（可选）：这一格的值不由通用层直接写，
   * 而是由**域的公开写动作**确认（域自己重核事实、自己带上版本闸再落盘）。
   *
   * ⚠️ **不许因此另造一条写管线**：这一笔**照样**走原保存队列、
   *   **同一把幂等键**、**同一份版本回执** —— 域动作的成败照样决定
   *   这一格算不算写成（失败就留在格子里让人再点一次）。
   */
  domainAction?: ExcelCellCandidateAction;
}

export interface WriteResult {
  /** A failed write retains its rejection receipt; callers must not report success. */
  kind?: 'success' | 'rejected';
  reason?: string;
  idempotent?: boolean;
  /** 数据库表回记录级 modified；xlsx 回表级 content_version。 */
  modified?: string;
  contentVersion?: number;
  /** xlsx 的结构版本。保存可能触发「备注」列新增（structure_version +1）。 */
  structureVersion?: number;
  /** 操作编号（B5 撤回按它定位）。单格写回包也带。 */
  opId?: string;
  /** 改前值快照（服务端自记，撤回栈展示用）。 */
  before?: string;
  /** 改后值快照。 */
  after?: string;
  /** 落盘后的列宽（0 起列序号 → 像素）。自动算宽时是服务端算出来的值。 */
  columnWidths?: Record<number, number>;
  /**
   * PKG-004 统一编辑：服务端仅值回填，格式未动。
   * true → 前端只调 setRowValue，不重建格式不重渲染。
   * 由 D 的 files.sheet_cells_write 回包携带；前端不自造。
   */
  formatUntouched?: boolean;
  refreshLoaded?:boolean;
  undoSupported?:boolean;
  undoAction?:'companion';
  hasFormulas?:boolean;
  /**
   * PKG-004 统一编辑：值来源。'db' = 已晋升列经数据库规则保存；
   * 'file' = 普通列走文件写入。界面上**不区分**，仅供诊断/撤回链。
   */
  valueSource?: 'db' | 'file';
}

/**
 * **领域确认动作的写入**（2026-10-29 案号采用走这条路）。
 *
 * ⚠️ **它不是「另造一条写管线」**：
 * · 调用方（表格层）把它当**一次普通写入**排进**同一条保存队列**；
 * · **同一把幂等键**带下去（回执丢了重试用同一把键 ⇒ 服务端只落一次）；
 * · 回执里的**版本**（表级 content/structure、记录级 record_version）
 *   照样回到调用方 ⇒ 客户端的版本闩照旧更新 ⇒ 下一笔不会撞自己。
 *
 * ⚠️ **为什么走域的公开动作，而不是通用层直接写那一格**：
 *   案号是**业务事实** —— 候选值要按**正式值 + 当前北京年 + 当年最大流水**重核，
 *   两行同时确认不能拿到同一个号。通用层写不了这个判断 ⇒ 归域。
 *   通用层只负责**把这一笔排进队列、把幂等键和版本回执接好**。
 */
export interface DomainWriteOutcome extends WriteResult {
  /** 域动作回包原文（版本字段在它里面）。 */
  raw?: Record<string, unknown>;
}

export async function runDomainWrite(
  action: ExcelCellCandidateAction,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<DomainWriteOutcome> {
  const response = await fetch(
    '/api/platform/actions/' + encodeURIComponent(action.actionId) + '/execute',
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: action.payload || {},
        confirmed: true,
        idempotency_key: idempotencyKey,
        source: 'user',
      }),
      signal,
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    const reason = body?.error || body?.message || `保存失败（HTTP ${response.status}）`;
    return { kind: 'rejected', reason: String(reason) };
  }
  const raw = (body?.result || {}) as Record<string, unknown>;
  const contentVersion = typeof raw.content_version === 'number' ? raw.content_version : undefined;
  const structureVersion = typeof raw.structure_version === 'number' ? raw.structure_version : undefined;
  const recordVersion = typeof raw.record_version === 'string' && raw.record_version ? raw.record_version : undefined;
  return {
    kind: 'success',
    idempotent: !!body.idempotent,
    modified: recordVersion,
    contentVersion,
    structureVersion,
    raw,
  };
}

export interface UnifiedTable {
  /** 本次已授权读取的对象定义，仅供当前表工作面复用。 */
  objectInfo?: ObjectInfo;
  resourceId?:string;
  companionUndoRequest?(opId:string):{path:string;payload:Record<string,unknown>};
  /** 打开时用的 ID：数据库对象 ID / 文件中心资源名（FILE-xxxxx）。 */
  key: string;
  title: string;
  /** 当前工作表的真名（文件表才有；助手要知道人在看哪张工作表）。 */
  sheetTitle?: string;
  /**
   * 入口展示事实类型；共用交互不合并存储。
   * （fast 那边已把它显示在入口清单的行内角标上 ⇒ 不再是「只供内部诊断」；
   *   ours 的「只供内部诊断」注释与 fast 的展示行为冲突，合并后取 fast 的说法。）
   */
  kind: 'db' | 'xlsx';
  /** 这张表能不能写。false = 只读（如含宏/外链的工作簿，产品设计如此）。 */
  writable: boolean;
  /** 只读原因（writable=false 时给用户看的说明）。 */
  readonlyReason?: string;
  /** 保存前提示（外链/自定义XML 剔除等）。null = 不用提示。 */
  stripNotice: string | null;
  /** 当前结构版本（保存可能触发「备注」列新增，+1）。 */
  readonly structureVersion: number;
  readonly contentVersion?: number;
  writeStyle?(opts:{cells:StyleTarget[];style:FontStylePatch;opId:string;expectedContentVersion:number;expectedStructureVersion:number}):Promise<StyleWriteResult>;
  columns: GridColumn[];
  totalRows: number;
  /** 各列列宽（**像素**，0 起列序号）。后端没存布局时是空对象。 */
  columnWidths: Record<number, number>;
  /**
   * PKG-004 统一编辑：已晋升列的表头名集合。
   * 有值 → 这列经数据库规则保存；空/undefined → 普通列走文件写入。
   * 界面上**不区分**哪列是数据库的、哪列是普通的。
   */
  promotedColumns?: Set<string>;
  /**
   * 能否下载/导出（A-d 前端腿）。B 语义：管理读不带导出；企业/个人级单列；部门级默认可下载。
   * **fail-closed（E 2026-10-17）**：只有 true 才显示导出；false/undefined 一律隐藏。
   */
  canDownload?: boolean;
  /** 结构权（my_access.structure / can_structure）。fail-closed：只有 true 才显示结构入口。 */
  canStructure?: boolean;
  deletedRows?:Array<{rowId:string;rowIndex:number}>;
  /**
   * BASE967-50 服务端排序（`files.sheet_sort`）。
   *
   * **为什么不排客户端**：本表是**服务端分页**的（`main.ts` PAGE_LENGTH=100），
   * 客户端排序只排得动当前装填的那 100 行 —— 万行表排完看着像全排了，实际只动了 1%，
   * 是**静默给错结果**，比功能缺失更坏。且本构建的 bundle 里根本没有 sort 插件。
   *
   * **排序后行序会变**，而写请求按 `rowId` 定位单元格。所以排序回包必须带着
   * **排好序的行标识**（`orderedRowIds`）或至少保证下一页取回来的 `rows[].name`
   * 已经是排后的顺序 —— 前端 `rowIds` 就是从这里推的，不能自己按位置重编号。
   *
   * 排序失败**不静默降级成「没排」**：抛出去让界面说清「排序没成功」，
   * 否则用户以为排好了其实没排（又是静默给错）。
   */
  sort?(spec: { column: string; direction: 'asc' | 'desc' }): Promise<{
    orderedRowIds: string[];
    totalRows: number;
  }>;
  personalView?:PersonalViewResult;
  loadPersonalView?():Promise<PersonalViewResult>;
  savePersonalView?(view:PersonalView):Promise<PersonalViewResult>;
  /**
   * 某一列**整列**的去重值（列头筛选面板的「值清单」）。
   * 只有文件表有（值清单走 `files.sheet_column_values` 这个只读服务）。
   */
  columnValues?(column:string):Promise<ColumnValues>;
  /**
   * **服务端**筛选条件（业务表用）。
   *
   * 条件进 `GET /api/platform/objects/:id/records` 的 `filters` ——
   * **不许只筛当前装填的那一页**（那是「静默给错结果」，比功能缺失更坏）。
   */
  setFilters?(filters:Record<string,unknown>):void;
  /** 当前生效的服务端筛选条件。 */
  filters?():Record<string,unknown>;
  clearSort?(): Promise<{orderedRowIds:string[];totalRows:number}>;
  rowHeights?:Record<number,number>;
  writeRowHeights?(heights:Record<number,number>,opId:string):Promise<void>;
  loadPage(page: number, pageLength: number): Promise<{ rows: UnifiedRow[]; total: number; meta?:TableMeta }>;
  /**
   * 找出某一行落在第几页（1 起），找不到回 -1。
   * **排序口径两边不同，所以定位也必须各自实现**：
   *   数据库表按 name 升序稳定排序，行标识可字典序比较 → 二分；
   *   xlsx 的 row_id 是服务端按位置发的号，**不可按字典序比较**，二分会跳错页 → 按页顺序找。
   */
  findRowPage(rowId: string, pageLength: number): Promise<number>;
  /** 服务端全表搜索（不是只搜已装填行）。page 从 1 起，返回该页命中行。 */
  search(term: string, limit: number, page?: number, querySignal?: AbortSignal): Promise<{ rows: UnifiedRow[]; total: number }>;
  writeCell(req: WriteRequest): Promise<WriteResult>;
  /**
   * 批量写多格（B 的 `files.sheet_cells_write`）。一次粘贴 = 一个包 = 一个请求。
   * 全成或全不成：任何一格无效整批零生效。回包带每格 before/after 快照（撤回栈用）。
   * **不许循环调 writeCell** —— 那会版本 +N、历史 N 条。
   */
  writeCells(reqs: WriteRequest[], idempotencyKey: string): Promise<WriteResult & {
    applied?: number;
    cellResults?: Array<{ rowId: string; header: string; before: unknown; after: unknown }>;
  }>;
  /**
   * 越界粘贴一次成包（B 的 `files.sheet_paste_apply`）。
   * 扩展+写值服务端一次做完、全成或全不成、失败零残留。
   * 容量 20000 格。只可改值者带结构的包 → 403 整包零写。
   */
  inputWrite?: UnifiedTable['pasteApply'];
  pasteApply?(opts: {
    startRow: number;
    startCol: number;
    matrix: string[][];
    matrixTypes?: string[][];
    headerRow?: boolean;
    extend?: boolean;
    opId: string;
    /**
     * 全局行序 → 稳定行标识 + 记录版本（`null` = 那一行是新的）。
     * 数据库业务表由前端持有行身份（行序是显示概念、行标识是身份概念），
     * 没有它就没法分清「改这一行」和「新建一行」，也带不上记录级版本闸。
     */
    rowRefs?: Array<{ rowId: string | null; modified?: string } | undefined>;
    /**
     * 粘贴范围内每一格**改之前的值**（行 × 列）。
     * 撤回要靠它把旧值写回去；没有它，撤回就会把格子清空而不是还原。
     */
    beforeValues?: string[][];
    expectedContentVersion?:number;
    expectedStructureVersion?:number;
  }): Promise<{
    actionCount: number;
    idempotent?: boolean;
    refreshLoaded?:boolean;
  undoSupported?:boolean;
  undoAction?:'companion';
  hasFormulas?:boolean;
    savedView?:{rows:UnifiedRow[];total:number;meta:TableMeta};
    rowsAdded: number;
    colsAdded: number;
    rowIds: string[];
    headers: string[];
    cells: Array<{ rowId: string; header: string; before: unknown; after: unknown; created?: boolean }>;
    contentVersion: number;
    structureVersion: number;
    /** 业务表：这一格是**新建**行的（撤回不碰它 —— 删记录没有公开口）。 */
    created?: boolean;
  }>;
  /**
   * 把列宽写回后端（用户要的「拖了刷新还在」）。只并入给出的列，未提到的不动。
   * 后端不存布局（数据库业务表）时是空操作，仍回成功——界面行为一致，不提示「存不了」。
   * 幂等键 `opId` 由调用方持有；回执丢失用同一把键重试。
   */
  writeLayout(columnWidths: Record<number, number>, opId: string, autoFitColumns?: number[]): Promise<WriteResult>;

  // —— 成包编辑（第四批）———————————————————————————————————————
  // 查找替换 / 填充序列 / 选择性粘贴：三个都是「一次请求写一包、一次落盘、一步撤回」。
  // 数据库业务表没有这三条动作 —— 调用会抛「不支持」，不暗中降级成逐格写。
  findReplace?(opts: BulkEditOptions): Promise<BulkEditResult>;
  fillSeries?(opts: BulkEditOptions): Promise<BulkEditResult>;
  pasteSpecial?(opts: BulkEditOptions): Promise<BulkEditResult>;

  // —— 结构动作（N2-A1）—————————————————————————————————
  // 这四个只对 xlsx 表有效（B 的 files.sheet_* 公共 Action）。
  // 数据库业务表没有对应的 Action，调用会抛「不支持」。
  /** 末尾加行。返回服务器发的稳定行 ID。 */
  appendRows(count: number, opId: string): Promise<{ rowIds: string[] }>;
  /** 末尾加列。空/重名表头由服务端拒（417）。 */
  appendColumn(header: string, opId: string): Promise<void>;
  /** 改表头。列定位按表头名。 */
  renameHeader(fromHeader: string, toHeader: string, opId: string, expected?:{contentVersion:number;structureVersion:number}): Promise<void>;
  /** 改表名（表标题）。只动标题，不动版本。 */
  renameTable(title: string, opId: string): Promise<void>;
  // BASE967-19：插/删行列（受管结构操作）
  /** 在 beforeRowId 前插 count 行（null=末尾）。 */
  /**
   * 结构动作（**只管行**）：行移动／行恢复／结构撤回。
   *
   * ⚠️ **「挪列」不在这儿**（2026-10-29 撤掉那条自造管线）：
   *   原来这里有 `'column_move'` ⇒ 走 `files.sheet_column_move` ⇒ **物理改写 xlsx 的列**
   *   ⇒ **全表 everybody sees**（用户原话：「你拖了别人也跟着变」）。
   *   ⇒ 现在挪列**只写个人视图**（`savePersonalView`，按人隔离，**不碰文件本身**）。
   *   ⇒ 「插列／删列」**仍是结构动作**（那两件事真的要改表结构，留在 `insertColumn`/`deleteColumn`）。
   */
  structureAction(kind: 'row_move'|'row_restore'|'structure_undo', target: string, opId: string, before?: string): Promise<void>;
  insertRows(beforeRowId: string | null, count: number, opId: string): Promise<{ rowIds: string[] }>;
  /** 在 beforeHeader 前插一列（null=末尾）。新列 promoted:false。 */
  insertColumn(beforeHeader: string | null, header: string, opId: string): Promise<void>;
  /** 删行（软删除：DB 正式值保留）。 */
  deleteRow(rowId: string, opId: string): Promise<void>;
  /** 删列（已晋升的拒）。 */
  deleteColumn(header: string, opId: string): Promise<void>;
  /** 结构动作后刷新列定义和版本号（重新读一页拿 meta）。 */
  refreshMeta(): Promise<void>;
  /** 接收已确认动作的新版本；仅推进本工作面的下一次写入期望值。 */
  adoptVersions?(versions: { contentVersion: number; structureVersion?: number }): void;
  /**
   * **收下「撤回之后」那几行新的受管记录版本**（行 id → 版本）。
   *
   * ⚠️ **为什么要有**（2026-10-29 站上实测）：撤回是**逆向写入** ⇒ 值回到上一版、
   * **版本也回到上一版**（受管记录的版本栈）⇒ 客户端手里那份版本**当场变新**
   * ⇒ 下一笔会被自己的旧版本拒（「记录已被修改，请刷新后重试」）⇒ 不收下就必然撞。
   */
  adoptRecordVersions?(versions: Record<string, string>): void;
  cellStyle?(rowId:string,header:string):CellFontStyle|undefined;
  fileOperation?(action:'structure'|'sort'|'style',payload:Record<string,unknown>,key:string):Promise<void>;
}

/**
 * 这个表 ID 是不是 xlsx。
 *
 * **不能按 ID 形状猜**：B 文档里的例子是 `FILE-00012`，但实测上传 xlsx 回的是短 id
 * （`e7gjttmv2o`），跟业务表 ID 长得一样。猜错就整条路走歪——A2 曾因此报
 * 「没有找到这张表」。所以按**它在不在业务表清单里**判，不看长相。
 */
export function isXlsxTable(key: string, objectIds: ReadonlySet<string>): boolean {
  return !objectIds.has(key);
}

// —— 数据库业务表 ——————————————————————————————————————————————

function createDbTable(info: ObjectInfo, signal?: AbortSignal): UnifiedTable {
  // input_schema 是服务端按「当前用户可写字段」建的，它的键就是可写字段名单。
  // 不在名单里的列就是只读列（夹具里的校验标记只给 System Manager 写）。
  const writable = new Set(Object.keys(info.input_schema?.properties || {}));
  /**
   * 对象版本号：写动作的版本闸要用。
   *
   * 原生（native）对象里，只读数据集**没有** `revision`（它们压根不写）⇒ 归零，
   * 免得载荷里出现 `undefined`（服务端那层要的是数字；真要写时服务端会拿版本对不上拒掉）。
   */
  if (typeof info.revision !== 'number') info.revision = 0;
  /** 每个可写字段的**输入规则类型**（string／integer／array…）—— 判禁写要用。 */
  const schemaTypes = new Map<string, string | undefined>(
    Object.entries(info.input_schema?.properties || {}).map(([key, spec]) => [
      key,
      (spec as { type?: string } | undefined)?.type,
    ]),
  );
  /** 关联列：服务端另给 `_display`（人认识的名字）⇒ 界面上显示名字，不是内部 ID。 */
  const referenceColumns = (info.fields || [])
    .filter((field: ObjectField) => field.type === 'reference')
    .map((field: ObjectField) => field.id);
  /**
   * **金额列**（原生 native 对象才有）：字段类型 `money`，或者列名以 `_cents` 结尾（单位是分）。
   *
   * 界面上按「元」显示（跟数据页那套口径一样：`¥ 123.45`）——
   * native 表切到 Excel 以后，数据页那套按元显示的规矩得在这儿接上，
   * 不然用户在 Excel 里看到的是 `12345`（分）。
   *
   * ⚠️ **只格式化只读列**：可写列的格值要**原样**写回去
   * （格式化过的 `¥ 123.45` 写回整数列会把正式数据写坏）。
   */
  const isCentsColumn = (field: ObjectField) => field.id.endsWith('_cents');
  const moneyColumns = new Set<string>(
    (info.fields || [])
      .filter((field: ObjectField) => !field.deprecated && (field.type === 'money' || isCentsColumn(field)))
      .filter((field: ObjectField) => !writable.has(field.id))
      .map((field: ObjectField) => field.id),
  );
  /** 一个金额列该显示成什么样（`_cents` 是分 ⇒ 换算成元）。 */
  function formatMoney(fieldId: string, value: unknown): string {
    if (value === null || value === undefined || value === '') return '';
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    const yuan = isCentsColumn({ id: fieldId } as ObjectField) ? number / 100 : number;
    return `¥ ${yuan.toFixed(2)}`;
  }
  const columns: GridColumn[] = (info.fields || [])
    .filter((field: ObjectField) => !field.deprecated)
    .map((field: ObjectField) => ({
      fieldId: field.id,
      // 原生（native）对象的字段**没有 label**（只有 id 和类型）⇒ 退回字段 id，
      // 不让列头空着（空列头用户看不出这是哪一列）。
      // ⚠️ `_cents` 列（单位是分）⇒ 列头写「（元）」，跟数据页那套口径一样。
      label: moneyColumns.has(field.id) && isCentsColumn(field)
        ? String(field.label || field.id).replace(/（分）$/, '').replace(/（元）$/, '') + '（元）'
        : (field.label || field.id),
      type: field.type,
      // 禁写口径与表格中心一致：不在可写名单里、或类型是关联/明细/数组/对象 ⇒ 只读。
      // ⚠️ 少了这一层，`coerceObjectValue` 会把关联列的**显示名**当文本写进正式数据（静默写坏）。
      readOnly:
        !writable.has(field.id) ||
        !isColumnWritable({ id: field.id, type: field.type }, schemaTypes.get(field.id)),
    }));
  /** 字段类型表（粘贴按它把文本转成类型化值）。 */
  const fieldTypes = new Map<string, string>(
    (info.fields || []).map((field: ObjectField) => [field.id, field.type]),
  );
  /** 当前生效的**服务端**筛选条件（进 GET 的 filters，不是只筛已装填的那几行）。 */
  let dbFilters: Record<string, unknown> = {};
  /** 把关联列的值换成 `_display` 里的名字（只读列，写不回去，所以换得安全）。 */
  function decorateRow(row: RecordRow): RecordRow {
    const target = row as Record<string, unknown>;
    /* 金额列按「元」显示（只读列才换；可写列的值要原样写回去）。 */
    for (const fieldId of moneyColumns) {
      if (target[fieldId] === undefined || target[fieldId] === null) continue;
      target[fieldId] = formatMoney(fieldId, target[fieldId]);
    }
    if (!referenceColumns.length) return row;
    const display = (row as Record<string, unknown>)._display as Record<string, unknown> | undefined;
    if (!display) return row;
    for (const fieldId of referenceColumns) {
      if (display[fieldId] === undefined || display[fieldId] === null) continue;
      (row as Record<string, unknown>)[fieldId] = displayCellValue(row as Record<string, unknown>, fieldId);
    }
    return row;
  }

  const table: UnifiedTable = {
    key: info.id,
    objectInfo: info,
    // 受管对象有 `title`；原生（native）对象只有 `name`（中文名）⇒ 依次退。
    title: info.title || info.name || info.id,
    kind: 'db',
    writable: true,   // 数据库业务表的写权限在列级别（readOnly），表级别都是可写的
    stripNotice: null,
    structureVersion: 0,
    columns,
    totalRows: 0,
    columnWidths: {},

    async loadPage(page, pageLength) {
      const fields = columns.map(column=>column.fieldId);
      const result = await fetchRecords(info.id, {
        page,
        pageLength,
        fields,readScope:{mode:'query',purpose:'interactive',fields},includeDefinition:false,
        // 筛选条件进**服务端**：dbFilters 是用户设的条件，$sort/$direction 是行序闸。
        filters: { $sort: 'name', $direction: 'asc', ...dbFilters },
      }, signal);
      table.totalRows = result.total;
      return { rows: result.rows.map(decorateRow), total: result.total };
    },

    /** 换筛选条件：条件本身进服务端（下一页 loadPage 带着它去查）。 */
    setFilters(filters) {
      dbFilters = { ...(filters || {}) };
    },
    filters() {
      return { ...dbFilters };
    },

    /**
     * 这一列的取值清单（列头筛选面板的「值清单」）。
     *
     * ⚠️ 服务端**没有**「整列去重值」这个口 ⇒ 这里取**当前筛选条件下**的第一页，
     * 收集页里出现过的值；取不到全量就在 `truncated` 里说清楚。
     * （值清单只是**挑值用的**；筛选本身仍是服务端精确等值，不受这里影响。）
     */
    async columnValues(column) {
      const result = await fetchRecords(info.id, {
        page: 1,
        pageLength: 100,
        fields:[column],readScope:{mode:'query',purpose:'interactive',fields:[column]},includeDefinition:false,
        filters: { ...dbFilters },
      }, signal);
      const values: string[] = [];
      let hasBlank = false;
      for (const row of result.rows) {
        const value = displayCellValue(row as Record<string, unknown>, column);
        if (value === '') { hasBlank = true; continue; }
        if (!values.includes(value)) values.push(value);
      }
      return { column, values, has_blank: hasBlank, total: values.length, truncated: result.total > result.rows.length };
    },

    async findRowPage(rowId, pageLength) {
      // 行序固定 name 升序，name 不可变，所以能二分。
      const pages = Math.max(1, Math.ceil(table.totalRows / pageLength));
      let lo = 1;
      let hi = pages;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const { rows } = await table.loadPage(mid, pageLength);
        if (!rows.length) return -1;
        const hit = rows.findIndex((r) => r.name === rowId);
        if (hit >= 0) return mid;
        const first = String(rows[0].name);
        const last = String(rows[rows.length - 1].name);
        if (rowId < first) hi = mid - 1;
        else if (rowId > last) lo = mid + 1;
        else return -1;
      }
      return -1;
    },

    async search(term, limit, page = 1, querySignal) {
      const fields = columns.map(column=>column.fieldId);
      const result = await fetchRecords(info.id, {
        page,
        pageLength: limit,
        fields,readScope:{mode:'query',purpose:'interactive',fields},includeDefinition:false,
        filters: { $search: term, $sort: 'name', $direction: 'asc' },
      }, querySignal ?? signal);
      return { rows: result.rows, total: result.total };
    },

    async writeCell(req) {
      // —— **领域确认动作**（业务事实的确认归域）：走域的公开写动作，
      //   **同一把幂等键、同一份版本回执** ⇒ 仍受本表这条保存队列管。
      if (req.domainAction) {
        const outcome = await runDomainWrite(req.domainAction, req.idempotencyKey, signal);
        if (outcome.kind === 'rejected') return outcome;
        const raw = outcome.raw || {};
        if (typeof raw.revision === 'number') info.revision = raw.revision;
        return {
          kind: 'success',
          idempotent: outcome.idempotent,
          modified: typeof raw.record_version === 'string' ? raw.record_version : undefined,
        };
      }
      /* 写保护（防御）：关联列／明细列／数组与对象类型的列**一律不写**。
         界面把它们设成只读了，但这里再挡一道 ——
         `coerceObjectValue` 只认 integer/decimal/boolean/date，
         其余原样当文本发出去 ⇒ 关联列的**显示名**会被写进正式数据（静默写坏）。 */
      const fieldType=fieldTypes.get(req.fieldId)??'';
      if(!isColumnWritable({id:req.fieldId,type:fieldType},schemaTypes.get(req.fieldId))){
        throw new Error(`「${req.fieldId}」是${fieldType==='reference'?'关联列':fieldType==='detail'?'明细列':'这一列'}，不能写入`);
      }
      const result = await updateRecord({
        objectId: info.id,
        name: req.rowId,
        expectedRevision: info.revision,
        expectedModified: req.expectedModified ?? '',
        values: { [req.fieldId]: coerceObjectValue(req.fieldType,req.text) },
        idempotencyKey: req.idempotencyKey,
      }, signal);
      const updated = (result as { result?: { modified?: string; revision?: number } })?.result;
      if (typeof updated?.revision === 'number') info.revision = updated.revision;
      return {
        idempotent: !!result.idempotent,
        modified: typeof updated?.modified === 'string' ? updated.modified : undefined,
      };
    },

    async writeLayout() {
      // 数据库业务表不存布局（B1 契约里没有列宽字段），列宽只在本次会话里生效。
      // 仍回成功：界面行为和 xlsx 一致，不给用户一个「存不了」的假失败。
      return {};
    },

    // 批量写与粘贴共用能力：受管既有行成包提交，其他对象沿原逐行路径。
    async writeCells(reqs, idempotencyKey) {
      const byRow = new Map<string, WriteRequest[]>();
      for (const req of reqs) {
        const list = byRow.get(req.rowId) || [];
        list.push(req);
        byRow.set(req.rowId, list);
      }
      const rows: PasteRow[] = [...byRow.entries()].map(([rowId, list]) => ({
        rowId,
        modified: list[0]?.expectedModified,
        cells: list.map(req => ({ fieldId: req.fieldId, text: req.text })),
      }));
      const fieldTypes: Record<string, { type?: string; label?: string; schemaType?: string }> = {};
      for (const req of reqs) {
        fieldTypes[req.fieldId] = { type: req.fieldType, label: req.fieldId, schemaType: schemaTypes.get(req.fieldId) };
      }
      const result = await applyPaste(
        (url, init) => fetch(url, { credentials: 'include', signal, ...(init || {}) }),
        {
          objectId: info.id,
          source: info.source,
          expectedRevision: info.revision,
          plan: planPaste(rows),
          fields: fieldTypes,
          idempotencyKey,
        },
      );
      const cellResults = reqs.map(req => ({
        rowId: req.rowId,
        header: req.fieldId,
        before: null,
        after: req.text,
      }));
      return { contentVersion: 0, applied: result.created + result.updated, cellResults, idempotent:result.idempotent };
    },
    // 全为受管既有行才调用 update_many；原生对象和含新增行的计划保留原路径。
    async pasteApply(opts) {
      const { startCol, matrix, opId } = opts;
      const rowRefs = opts.rowRefs || [];
      const beforeValues = opts.beforeValues || [];
      const rows: PasteRow[] = matrix.map((line, offset) => ({
        rowId: rowRefs[offset]?.rowId ?? null,
        modified: rowRefs[offset]?.modified,
        cells: line.map((text, index) => ({
          fieldId: columns[startCol + index]?.fieldId ?? '',
          text: String(text ?? ''),
        })).filter(cell => cell.fieldId !== ''),
      }));
      const plan = planPaste(rows);
      const result = await applyPaste(
        (url, init) => fetch(url, { credentials: 'include', signal, ...(init || {}) }),
        {
          objectId: info.id,
          source: info.source,
          expectedRevision: info.revision,
          plan,
          fields: Object.fromEntries(
            columns.map(column => [
              column.fieldId,
              { type: fieldTypes.get(column.fieldId), label: column.label, schemaType: schemaTypes.get(column.fieldId) },
            ]),
          ),
          idempotencyKey: opId,
        },
      );
      // 回包给上层的「改了哪些格」：**改前的值**取自粘贴范围（撤回要靠它写回旧值），
      // 新建的行没有改前的值 ⇒ 标 `created`（撤回不碰它：删记录没有公开口）。
      const cells: Array<{ rowId: string; header: string; before: unknown; after: unknown; created?: boolean }> = [];
      plan.rows.forEach((row, rowIndex) => {
        const name = result.names[rowIndex] ?? row.rowId ?? '';
        const isCreate = !row.rowId;
        row.cells.forEach(cell => {
          cells.push({
            rowId: name,
            header: cell.fieldId,
            before: beforeValues[row.index ?? rowIndex]?.[cell.index ?? 0] ?? '',
            after: cell.text,
            ...(isCreate ? { created: true } : {}),
          });
        });
      });
      return {
        actionCount: result.actionCount,
        idempotent: result.idempotent,
        refreshLoaded: true,
        undoSupported: true,
        hasFormulas: false,
        savedView: undefined,
        rowsAdded: result.created,
        colsAdded: 0,
        rowIds: result.names,
        headers: columns.map(column => column.fieldId),
        cells,
        contentVersion: 0,
        structureVersion: 0,
      };
    },
    // 成包编辑（第四批）是 xlsx 专属：数据库业务表没有这三条动作。
    // 明确拒绝并零写，不暗中降级成逐格写（D 2026-10-14 确认的口径）。
    async findReplace() {
      throw new Error('查找替换暂不支持此表类型（数据库业务表）');
    },
    async fillSeries() {
      throw new Error('按序列填充暂不支持此表类型（数据库业务表）');
    },
    async pasteSpecial() {
      throw new Error('选择性粘贴暂不支持此表类型（数据库业务表）');
    },
    // 结构动作是 xlsx 专属（B 的 files.sheet_* Action），数据库业务表不支持。
    async appendRows() {
      throw new Error('数据库业务表不支持此操作');
    },
    async appendColumn() {
      throw new Error('数据库业务表不支持此操作');
    },
    async renameHeader() {
      throw new Error('数据库业务表不支持此操作');
    },
    async renameTable() {
      throw new Error('数据库业务表不支持此操作');
    },
    // BASE967-19：数据库业务表不支持插/删行列（xlsx 专属）
    async structureAction() { throw new Error('此对象尚未绑定表格'); },
    async insertRows() { throw new Error('数据库业务表不支持此操作'); },
    async insertColumn() { throw new Error('数据库业务表不支持此操作'); },
    async deleteRow() { throw new Error('数据库业务表不支持此操作'); },
    async deleteColumn() { throw new Error('数据库业务表不支持此操作'); },
    async refreshMeta() {
      // 数据库表的列定义来自 object schema，不会因为行/列操作变化。
    },
  };
  return table;
}

// —— 真实 xlsx ————————————————————————————————————————————————

/**
 * 把适配层回的行接到前端统一行上。
 * `adapter.readPage` 已经把类型化值摊成显示值了（公式格取**缓存值**，不把公式文本当值），
 * 这里只补前端要的 `name` 键：它就是稳定行标识（xlsx 的 row_id），不是可视行号。
 */
function toUnifiedRow(row: TableRow, headers: string[]): UnifiedRow {
  const out: UnifiedRow = { name: row.rowId, modified: '' };
  for (const header of headers) out[header] = row.values[header] ?? '';
  rowViewMetadata.set(out, { rowIndex: row.rowIndex,sourceModified:row.sourceModified,styles:row.styles,pendingFormulas:Object.entries(row.typed||{}).filter(([,cell])=>cell.type==='formula'&&cell.calculation_pending).map(([header])=>header),formulas:Object.fromEntries(Object.entries(row.typed||{}).map(([header,cell])=>[header,editableFormula(cell)])),
    types: Object.fromEntries(Object.entries(row.typed || {}).map(([header, cell]) => [header, cell.type])) });
  return out;
}

/**
 * 按列类型把格子文本转成 B 要的类型化值。
 * 00123、18 位长编号一律按 text 走不转数字（前导零不能丢）；
 * 数值列（column_types 里是 number）才转 number。
 *
 * ★ 合并说明：fast 那边把本函数**导出**了（供别处复用），ours 这边加了
 *   CR/CRLF→LF 归一和公式分支 —— 两边都留：保留 ours 的归一/公式逻辑，
 *   同时把 fast 的 `export` 加上。
 */
export function toTypedValue(fieldType: string, text: string): CellValue {
  // BASE967-51：Univer Alt+Enter 插入 \r（CR），后端校验期望 \n（LF）。
  // 归一 CR/CRLF → LF，保证显示/复制/存储/导出一致（契约口径：类型归一在前端做）。
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 清空一格发契约正解 type:'empty'（不是空字符串）。
  // 现状：B 的手术快路径校验 _node_typed 把「无值的 <c/>」读成 {type:'number',value:''}，
  // 或 text:'' 被 openpyxl 丢格后按 empty 比对 —— 两种都 417「目标值不符」（2026-10-17 实证，
  // 已报 B，建议其在 _node_typed 无 <v>/<f> 时回 empty、并把 text:'' 归一成 empty）。
  // B 修好后这条即通过；在此之前清空会明确报「保存失败」，不会假绿。
  if (normalized === '') {
    return { type: 'empty', value: null };
  }
  // BASE967-21：公式（`=` 开头）发 type:'formula' —— B 的 _serialize_value 已认，写 <f> 元素。
  // 文本/数值列的公式都走这个分支（公式是「值形状」，不是字段类型）。
  // CellValue 的 formula 形状：{ type: 'formula', formula: string, value: 缓存值|null }
  if (normalized.startsWith('=')) {
    return { type: 'formula', formula: normalized, value: null };
  }
  if (fieldType === 'integer' || fieldType === 'decimal') {
    if(!Number.isFinite(Number(text)))throw Error('请输入有效数字');
    return { type: 'number', value: Number(text) };
  }
  if (fieldType === 'date') {
    return { type: 'date', value: normalized };
  }
  // ⚠️ **2026-10-27（PKG-126-T05）**：布尔列提交**真布尔**。
  // 服务端要的是 Python bool（`sheet.py` 的「布尔值无效」那一条：`if not isinstance(rawv, bool)`）
  // ⇒ 界面上的「是／否」在这里翻过去；**认不出来的写法当场拒**（不替人挑一个）。
  if (fieldType === 'boolean') {
    const token = normalized.trim();
    const lower = token.toLowerCase();
    if (lower === '是' || lower === 'true' || lower === '1') return { type: 'boolean', value: true };
    if (lower === '否' || lower === 'false' || lower === '0') return { type: 'boolean', value: false };
    throw Error('布尔列请选择「是」或「否」');
  }
  return { type: 'text', value: normalized };
}

/* ★ 合并说明：fast 那边加的 `pasteValueTypes`（批量粘贴时按列类型推 matrix_types）
   和两个缓存表（stylesByRow / operationBodies）都保留；ours 这边的
   `initialPage`（首屏已读好的那页，直接回填、免二次请求）也保留。
   fast 的 `export` 也加上（它那边是导出的）。 */
export function pasteValueTypes(matrix:string[][],startCol:number,columns:Array<{type:string}>):string[][]{
  return matrix.map(row=>row.map((value,index)=>{
    if(value==='')return 'empty';
    const type=columns[startCol+index]?.type;
    return type==='integer'||type==='decimal'?'number':type==='boolean'?'boolean':type==='date'?'date':'text';
  }));
}

export function createXlsxTable(meta: TableMeta, signal?: AbortSignal, initialPage?: Awaited<ReturnType<typeof xlsxSource.readPage>>): UnifiedTable {
  const stylesByRow=new Map<string,Record<string,CellFontStyle>>();
  /** **整表默认样式**（服务端只发一次；逐格没给样式的就回落成它）。 */
  let tableDefaultStyle:CellFontStyle|undefined;
  const operationBodies=new Map<string,string>();
  /* ★ fast 那边加的：粘贴请求体**按 opId 冻结** ——
     回执丢了要按「原编号」补交时，发出去的必须是**同一份**载荷；
     载荷变了服务端会按「同一操作编号」拒（companion 那条判据就是这个口径）。 */
  const frozenBodies=new Map<string,string>();
  // 列标识直接用表头：findHit / applyRow / onCommit 全部按 fieldId 取值，不用分叉。
  // 列定义是**可变的**——加列/改表头后要刷新，不能锁在闭包里。
  const gridColumn=(column:TableMeta['columns'][number]):GridColumn=>({...column,fieldId:column.header,label:column.header});
  let physicalColumns=meta.columns.map(gridColumn);
  let columnMetaVersion=meta.structureVersion;
  const physicalColumnWidths={...meta.columnWidths};
  // Keep the array identity: an already-mounted grid must see the adopted view.
  const columns:GridColumn[]=[...physicalColumns];
  // PKG-004-T03 第 2 步：**行 ID → 受管记录版本**。
  // 读表时服务端把这一行背后那条受管记录的版本带回来（`record_version`），
  // 写这一格时**原样带回去** ⇒ 服务端能拒陈旧写（两个人改同一格，后写的那次被拒）。
  const recordVersions = new Map<string,string>();
  const rememberVersions = (rows:TableRow[]) => {
    for (const row of rows) {
      if (row.recordVersion) recordVersions.set(row.rowId, row.recordVersion);
      else recordVersions.delete(row.rowId);
    }
  };
  let headers = meta.columns.map((c) => c.header);
  // 表级并发闸，写前带出、写后更新。B 的口径：回包的 content_version 就是**下一次**该带的期望值。
  let contentVersion = meta.contentVersion;
  // 结构版本：加列/改表头后会 +1，不能锁死在开表那一刻（否则旧结构写不会被拒）。
  let structureVersion = meta.structureVersion;
  let sortedRowIds: string[] | null = null;
  let sortedPhysicalRows = new Map<string, number>();
  let sourceTotalRows=meta.totalRows;
  const physicalRowHeights={...meta.rowHeights};
  function projectColumns(){
    const current=table.personalView;
    const requested=current?.structure_version===columnMetaVersion
      ? current.columns??current.view.columns??[]
      : (current?.view.columns??[]).filter(header=>headers.includes(header));
    const order=personalColumnOrder(headers,requested);
    const byHeader=new Map(physicalColumns.map(column=>[column.fieldId,column]));
    columns.splice(0,columns.length,...order.map(header=>({...byHeader.get(header)!})));
    table.columnWidths=Object.fromEntries(order.flatMap((header,index)=>{
      const width=physicalColumnWidths[headers.indexOf(header)];return width===undefined?[]:[[index,width]];
    }));
  }
  function adoptPhysicalMeta(fresh:TableMeta){
    physicalColumns=fresh.columns.map(gridColumn);headers=fresh.columns.map(column=>column.header);columnMetaVersion=fresh.structureVersion;
    for(const key of Object.keys(physicalColumnWidths))delete physicalColumnWidths[Number(key)];
    Object.assign(physicalColumnWidths,fresh.columnWidths);projectColumns();
  }
  function displayMeta(fresh:TableMeta):TableMeta{
    const byHeader=new Map(fresh.columns.map(column=>[column.header,column]));
    return {...fresh,columns:columns.map(column=>({...byHeader.get(column.fieldId)!})),columnWidths:{...table.columnWidths}};
  }
  function physicalColumn(index:number){
    if(!Number.isInteger(index)||index<0)throw Error('列位置无效');
    if(index>=columns.length)return index;
    const physical=headers.indexOf(columns[index].fieldId);if(physical<0)throw Error('目标列已变化，请重新打开');return physical;
  }
  function physicalRows(start:number,count:number){
    return Array.from({length:count},(_,offset)=>{
      if(!sortedRowIds)return start+offset;
      const id=sortedRowIds[start+offset],physical=id?sortedPhysicalRows.get(id):undefined;
      if(physical===undefined)throw Error('选区行身份尚未核实，请先重新打开');return physical-2;
    });
  }
  function contiguousRange(values:number[],label:string){
    if(!values.length||values.some((value,index)=>value!==values[0]+index))throw Error(`${label}在当前个人视图中不是连续原位置；本次未保存，请使用普通粘贴或恢复视图后操作`);
    return values[0];
  }
  function projectBulkRange(payload:Record<string,unknown>){
    const sr=Number(payload.start_row),er=Number(payload.end_row),sc=Number(payload.start_col),ec=Number(payload.end_col);
    const row=contiguousRange(physicalRows(sr,er-sr+1),'填充行');
    const col=contiguousRange(Array.from({length:ec-sc+1},(_,offset)=>physicalColumn(sc+offset)),'填充列');
    return {...payload,start_row:row,end_row:row+er-sr,start_col:col,end_col:col+ec-sc};
  }
  function projectSpecialRange(payload:Record<string,unknown>){
    const rowCount=Number(payload.source_rows),colCount=Number(payload.source_cols);
    const sr=contiguousRange(physicalRows(Number(payload.source_row),rowCount),'复制源行');
    const tr=contiguousRange(physicalRows(Number(payload.target_row),rowCount),'粘贴目标行');
    const sc=contiguousRange(Array.from({length:colCount},(_,offset)=>physicalColumn(Number(payload.source_col)+offset)),'复制源列');
    const tc=contiguousRange(Array.from({length:colCount},(_,offset)=>physicalColumn(Number(payload.target_col)+offset)),'粘贴目标列');
    return {...payload,source_row:sr,target_row:tr,source_col:sc,target_col:tc};
  }
  function adoptView(result:PersonalViewResult){
    table.personalView=result;sourceTotalRows=result.source_total_rows;contentVersion=result.content_version;structureVersion=result.structure_version;
    sortedRowIds=result.rows.map(row=>row.row_id);sortedPhysicalRows=new Map(result.rows.map(row=>[row.row_id,row.row_index]));
    table.rowHeights=Object.fromEntries(result.rows.map((row,index)=>[index,physicalRowHeights[row.row_index-2]]).filter(([,height])=>height!==undefined));
    // 默认个人视图仍可能与开表首页完全一致；是否复用交给 loadPage 校验版本和行身份。
    table.totalRows=result.total_rows;projectColumns();return result;
  }

  async function sendRange(input: boolean, opts: {
      startRow: number;
      startCol: number;
      matrix: string[][];
      matrixTypes?: string[][];
      headerRow?: boolean;
      extend?: boolean;
      opId: string;
    expectedContentVersion?:number;
    expectedStructureVersion?:number;
    }) {
      const mappedTargets = sortedRowIds ? opts.matrix.map((_,r)=>sortedRowIds![opts.startRow+r]??null) : undefined;
      // ⚠️ **单格输入：起点在表的末尾之后 ⇒ 夹到末尾**（用户 2026-10-29 14:3x 口径「A：打字才建行」）。
      //   网格会一直渲染到几十行 ⇒ 人「在末尾下面」打字时，网格行号可能比表的行数大很多
      //   ⇒ 不夹就会**一路补出几十行空行**（Excel 只补**一行**）。
      // ⚠️ **粘贴那条路不夹**：越界粘贴的语义就是**把中间补齐**（Excel 也这样）。
      const totalRowsNow = table.totalRows ?? 0;
      const startRow = (input && !sortedRowIds && opts.startRow >= totalRowsNow) ? totalRowsNow : opts.startRow;
      const sortedExistingRange = sortedRowIds && opts.startRow + opts.matrix.length <= sortedRowIds.length
        && opts.startCol + Math.max(...opts.matrix.map(row=>row.length)) <= headers.length;
      if (sortedExistingRange) {
        if (opts.headerRow) throw new Error('表头操作不能混用排序行身份');
        if ((opts.expectedContentVersion !== undefined && opts.expectedContentVersion !== contentVersion)
            || (opts.expectedStructureVersion !== undefined && opts.expectedStructureVersion !== structureVersion)) {
          throw new Error('编辑对应的表格版本已变化，请重新核对');
        }
        const reqs = opts.matrix.flatMap((row, r) => row.map((text, c) => ({
          rowId:sortedRowIds![opts.startRow+r], fieldId:columns[opts.startCol+c].fieldId,
          fieldType:opts.matrixTypes?.[r]?.[c]==='number'?'decimal':opts.matrixTypes?.[r]?.[c]??'text',
          text, value:text, idempotencyKey:opts.opId,
        })));
        const result = await table.writeCells(reqs, opts.opId);
        return {hasFormulas:result.hasFormulas,savedView:undefined, actionCount:1, idempotent:false, rowsAdded:0, colsAdded:0,
          rowIds:sortedRowIds!.slice(opts.startRow,opts.startRow+opts.matrix.length), headers:columns.map(column=>column.fieldId),
          cells:result.cellResults??[], contentVersion, structureVersion};
      }
      const reorderedColumns=columns.some((column,index)=>column.fieldId!==headers[index]);
      const targetHeaders=reorderedColumns?Array.from({length:Math.max(...opts.matrix.map(row=>row.length))},(_,offset)=>columns[opts.startCol+offset]?.fieldId??null):undefined;
      if(targetHeaders&&opts.headerRow)throw Error('个人列序下请通过列名编辑器修改表头');
      const actionUrl=`/api/platform/actions/${input?'files.sheet_input_write':'files.sheet_paste_apply'}/execute`;
      const buildBody=()=>JSON.stringify({
          payload: {
            table: meta.tableId,
            sheet: meta.sheetId,
            expected_content_version: opts.expectedContentVersion??contentVersion,
            expected_structure_version: opts.expectedStructureVersion??structureVersion,
            op_id: opts.opId,
            ...(mappedTargets ? {target_row_ids:mappedTargets,...(table.personalView?.view.filters.length?{append_at_end:true}:{})} : {}),
            start_row: startRow,
            start_col: opts.startCol,
            ...(targetHeaders?{target_headers:targetHeaders}:{}),
            ...(input ? {value:opts.matrix[0][0].startsWith('=')?{type:'formula',formula:opts.matrix[0][0],value:null}:{type:opts.matrixTypes?.[0]?.[0]??'text',value:opts.matrix[0][0]}} : {
              matrix:opts.matrix,
              // ★ fast 那边加的：调用方没给类型时，按**列定义**推一份（编号列不转数字）。
              matrix_types:opts.matrixTypes??pasteValueTypes(opts.matrix,opts.startCol,columns),
              ...(opts.headerRow?{header_row:true}:{}),
              ...(opts.extend!==undefined?{extend:opts.extend}:{}),
            }),
          },
          confirmed: true,
          idempotency_key: opts.opId,
          source: 'user',
        });
      /* ★ fast 那边加的：同一 opId 重试时发**完全一样**的载荷（请求体按 opId 冻结）——
         回执丢了要按「原编号」补交时，载荷不能变（变了服务端会当成新操作）。
         ⚠️ 只冻结**粘贴**这一路：单格输入那一路每次按当次给的期望版本重建
           （上层 FIX-05 的「按原操作重试」要带着当次的版本走）。 */
      const requestBody=input?buildBody():(frozenBodies.get(opts.opId)??(frozenBodies.set(opts.opId,buildBody()),frozenBodies.get(opts.opId))!);
      let response:Response;
      try{
        response=await fetch(actionUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
          signal,
        });
      }catch(error){
        // 单格输入：原样抛（上层按 status 判断「结果不明」，要留着原操作让用户核实）。
        if(input)throw error;
        throw Error('粘贴结果未知，请按原编号核实');
      }
      let body:any;
      try{body=await response.json();}
      catch(error){
        if(input)throw error;
        throw Error('粘贴回执不完整，请按原编号核实');
      }
      // ★ fast 那边加的：5xx/408 = 服务端可能已经写进去了 ⇒ 结果**未知**，不能当失败重发。
      if(!input&&(response.status>=500||response.status===408))throw Error('粘贴结果未知，请按原编号核实');
      if (!response.ok || body?.ok === false) {
        const msg = body?.error || body?.message || `${input?'保存':'粘贴'}失败（HTTP ${response.status}）`;
        throw Object.assign(new Error(msg),{status:response.status});
      }
      const result = body?.result || {};
      // ★ fast 那边加的：粘贴回执必须**完整**（表对得上、版本是整数、有逐格回包），
      //   否则这一笔算「没核实」，不能让上层当成功。
      if(!input&&(result.table!==meta.tableId||!Number.isInteger(result.content_version)||!Number.isInteger(result.structure_version)||!Array.isArray(result.cells)))
        throw Error('粘贴回执不完整，请按原编号核实');
      if (typeof result.content_version === 'number') contentVersion = result.content_version;
      if (typeof result.structure_version === 'number') structureVersion = result.structure_version;
      // ⚠️ **写完/粘完要把「这几行新的受管记录版本」存下来**（理由见上面 `writeCell` 那段注释）：
      //   不存 ⇒ 客户端手里的版本变旧 ⇒ 下一笔被自己的旧版本拒（「记录已被修改，请刷新后重试」）
      //   ⇒ 那笔卡在输入队列队首 ⇒ 整队停 ⇒ 页面永远「有未保存」⇒ 列宽／拖列／撤回全被禁。
      // ⚠️ **粘贴这条路也必须存** —— 粘贴会新建行、也会改已有行 ⇒ 一样把版本顶掉。
      for (const [rowId, version] of Object.entries((result.record_versions || {}) as Record<string, string>)) {
        if (rowId && typeof version === 'string' && version) recordVersions.set(rowId, version);
      }
      if (sortedRowIds && Array.isArray(result.row_ids) && result.rows_added) {
        const physicalStart = sourceTotalRows + 2;
        sourceTotalRows+=result.rows_added;
        result.row_ids.forEach((id:string,i:number)=>sortedPhysicalRows.set(id,physicalStart+i));
        sortedRowIds.push(...result.row_ids);
      }
      if (Array.isArray(result.headers)) headers=[...result.headers];
      // saved_view follows physical order; sorted view reloads by stable IDs instead.
      const view=!sortedRowIds && result.saved_view?decodeSheetView(result.saved_view):undefined;
      if(view)headers=view.meta.columns.map(column=>column.header);
      return {
        savedView:view?{...view,rows:view.rows.map(row=>toUnifiedRow(row,headers))}:undefined,
        hasFormulas:result.has_formulas,
        actionCount: result.action_count ?? 1,
        idempotent:!!body.idempotent,
        rowsAdded: result.rows_added ?? 0,
        colsAdded: result.cols_added ?? 0,
        rowIds: result.row_ids ?? [],
        headers: Array.isArray(result.headers)?personalColumnOrder(result.headers,columns.map(column=>column.fieldId).filter(header=>result.headers.includes(header))):columns.map(column=>column.fieldId),
        cells: (result.cells || []).map((c: Record<string, unknown>) => ({
          rowId: String(c.row_id || ''),
          header: String(c.header || ''),
          before: c.before,
          after: c.after,
        })),
        contentVersion,
        structureVersion,
      };
    }

  const table: UnifiedTable = {
    key: meta.tableId,
    title: meta.displayName,
    sheetTitle: meta.sheetTitle,
    kind: 'xlsx',
    writable: meta.writable,
    // E 2026-10-17 fail-closed：把服务端的权限布尔位带到 table 上；
    // 缺字段就不设（undefined），页面按 fail-closed 隐藏导出/结构入口。
    ...(meta.canDownload !== undefined ? { canDownload: meta.canDownload } : {}),
    ...(meta.canStructure !== undefined ? { canStructure: meta.canStructure } : {}),
    // 只读原因：B 的「读写双闸」——复杂特性表读得到、看得了、搜得出、下载得了，不能改。
    readonlyReason: meta.writable ? undefined : '该工作簿含不支持的特性（宏/图表/外链/图片等），已只读保留原样，不能编辑',
    stripNotice: meta.stripNotice,
    get deletedRows(){return meta.deletedRows||[];},
    get structureVersion() { return structureVersion; },
    get contentVersion(){return contentVersion;},
    async writeStyle(opts){
      const result=await xlsxSource.writeStyle({tableId:meta.tableId,cells:opts.cells,style:opts.style,opId:opts.opId,
        expectedContentVersion:opts.expectedContentVersion,expectedStructureVersion:opts.expectedStructureVersion},signal);
      contentVersion=result.content_version;structureVersion=result.structure_version;return result;
    },
    // 成包编辑（第四批）：一次请求写一包、一次落盘、一步撤回。
    async findReplace(opts){
      const result=await xlsxSource.findReplace({tableId:meta.tableId,sheetId:meta.sheetId,opId:opts.opId,payload:opts.payload,
        expectedContentVersion:opts.expectedContentVersion??contentVersion,
        expectedStructureVersion:opts.expectedStructureVersion??structureVersion},signal);
      contentVersion=result.contentVersion;structureVersion=result.structureVersion;return result;
    },
    async fillSeries(opts){
      const result=await xlsxSource.fillSeries({tableId:meta.tableId,sheetId:meta.sheetId,opId:opts.opId,payload:projectBulkRange(opts.payload),
        expectedContentVersion:opts.expectedContentVersion??contentVersion,
        expectedStructureVersion:opts.expectedStructureVersion??structureVersion},signal);
      contentVersion=result.contentVersion;structureVersion=result.structureVersion;return result;
    },
    async pasteSpecial(opts){
      const result=await xlsxSource.pasteSpecial({tableId:meta.tableId,sheetId:meta.sheetId,opId:opts.opId,payload:projectSpecialRange(opts.payload),
        expectedContentVersion:opts.expectedContentVersion??contentVersion,
        expectedStructureVersion:opts.expectedStructureVersion??structureVersion},signal);
      contentVersion=result.contentVersion;structureVersion=result.structureVersion;return result;
    },
    columns,
    totalRows: meta.totalRows,
    columnWidths: meta.columnWidths,
    // 来源：024a7544；8523d76f 整份替换时丢失。
    // 撤回回执已推进服务端版本；这里同步到本工作面，下一次写入/粘贴才带新期望值。
    adoptVersions(versions: { contentVersion: number; structureVersion?: number }) {
      contentVersion = versions.contentVersion;
      if (typeof versions.structureVersion === 'number') structureVersion = versions.structureVersion;
    },
    // ⚠️ **收下「撤回之后」那几行新的受管记录版本**（撤回是另一个动作，版本要往前退一格）。
    //   不收下 ⇒ 客户端手里那份变新 ⇒ 下一笔被自己的旧版本拒（「记录已被修改，请刷新后重试」）。
    adoptRecordVersions(versions: Record<string, string>) {
      for (const [rowId, version] of Object.entries(versions || {})) {
        if (rowId && typeof version === 'string' && version) recordVersions.set(rowId, version);
      }
    },

    // 服务端排序只改变个人视图，不移动文件行。回包必须携带稳定行身份和版本。
    async loadPersonalView(){return adoptView(await requestPersonalView(meta.tableId,signal));},
    async columnValues(column){return requestColumnValues(meta.tableId,column,signal);},
    async savePersonalView(view){return adoptView(await requestPersonalView(meta.tableId,signal,{view,revision:table.personalView?.revision??0,structureVersion}));},
    async sort(spec) {
      if(table.personalView){const result=await table.savePersonalView!({...table.personalView.view,sort:spec});return {orderedRowIds:result.rows.map(row=>row.row_id),totalRows:result.total_rows};}
      const response = await fetch('/api/platform/actions/files.sheet_sort/execute', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: {
            table: meta.tableId,
            column: spec.column, direction: spec.direction, identity_only: true,
            expected_content_version: contentVersion,
            expected_structure_version: structureVersion,
          },
          confirmed: true,
          idempotency_key: 'sheet-sort-' + Date.now().toString(36),
          source: 'user',
        }),
        signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || `排序未成功（HTTP ${response.status}）`);
      }
      const r = body?.result || {};
      // **真实契约（候选 87f2d3fd）**：服务端回 `rows[]`（整表排好的行），每行带 `row_id`。
      // 之前我猜的 `ordered_row_ids[]` 是错的契约，每条排序都会触发 `if (!ids.length) throw`，
      // 用户看到「排序没成功」但服务端其实成功了 —— **静默给错结果**。
      // 结构版本防御：服务端排序期间结构变化 row_id 映射就废了，所以**结构前进会拒**
      // （内容变化不拒，因为行没移动）。回包里带最新版号，下游写请求必须用新号。
      const rows = Array.isArray(r.rows) ? r.rows : [];
      const ids = rows.map((row: {row_id?: unknown}) => String(row?.row_id ?? ''));
      if (!Array.isArray(r.rows) || ids.some((id: string) => !id) || new Set(ids).size !== ids.length || r.total_rows !== ids.length) throw new Error('排序回包行标识不完整，请重新加载');
      if (typeof r.content_version === 'number') contentVersion = r.content_version;
      if (typeof r.structure_version === 'number') structureVersion = r.structure_version;
      sortedPhysicalRows = new Map(rows.map((row: {row_id:string;row_index:number}) => [row.row_id,row.row_index]));
      sortedRowIds = ids;
      initialPage = undefined;
      return {
        orderedRowIds: ids,
        totalRows: typeof r.total_rows === 'number' ? r.total_rows : table.totalRows,
      };
    },
    async clearSort() {
      if(table.personalView){const {sort,...view}=table.personalView.view;const result=await table.savePersonalView!(view);return {orderedRowIds:result.rows.map(row=>row.row_id),totalRows:result.total_rows};}
      const ids = sortedRowIds ? [...sortedRowIds].sort((a,b)=>(sortedPhysicalRows.get(a)??0)-(sortedPhysicalRows.get(b)??0)) : [];
      sortedRowIds=null; sortedPhysicalRows.clear(); initialPage=undefined;
      return {orderedRowIds:ids,totalRows:table.totalRows};
    },
    rowHeights:meta.rowHeights||{},
    async writeRowHeights(heights,opId){
      const physicalHeights = Object.fromEntries(Object.entries(heights).map(([row,pixels]) => {
        const physical = sortedRowIds ? sortedPhysicalRows.get(sortedRowIds[Number(row)]) : Number(row)+2;
        if (!Number.isInteger(physical) || physical! < 2) throw new Error('行高目标不存在，请重新加载');
        return [physical!, pixels*.75];
      }));
      const body=JSON.stringify({payload:{table:meta.tableId,sheet:meta.sheetId,
        expected_content_version:contentVersion,expected_structure_version:structureVersion,
        row_heights:physicalHeights},
        confirmed:true,idempotency_key:opId,source:'user'});
      const response=await fetch('/api/platform/actions/files.sheet_row_heights_write/execute',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body,signal});
      const data=await response.json();if(!response.ok||data?.ok===false)throw Error(data?.error||data?.message||'行高保存失败');
      const result=data.result;if(!result?.applied||typeof result.content_version!=='number')throw Error('行高保存回执未核实');
      contentVersion=result.content_version;structureVersion=result.structure_version;
      for(const [physical,points] of Object.entries(physicalHeights))physicalRowHeights[Number(physical)-2]=Number(points)/.75;
      table.rowHeights={...table.rowHeights,...heights};
    },

    async loadPage(page, pageLength) {
      // 开表首页只可消费一次。个人视图的冻结设置不影响行；筛选、排序、版本或总数变化都重读。
      const first = initialPage;
      initialPage = undefined;
      const reusableFirst = first && page === 1 && pageLength === 100
        && first.meta.contentVersion === contentVersion && first.meta.structureVersion === structureVersion
        && (!table.personalView || (!table.personalView.view.sort && !table.personalView.view.filters.length
          && first.total === table.totalRows && first.total === sourceTotalRows)) ? first : undefined;
      if (sortedRowIds) {
        const wanted = sortedRowIds.slice((page - 1) * pageLength, page * pageLength);
        if (!wanted.length) return { rows: [], total: sortedRowIds.length };
        // 即使没有筛选/排序，也核对服务端视图中的稳定行 ID 和物理位置，不能把旧行映射带进新视图。
        const cached = reusableFirst && reusableFirst.rows.length === wanted.length
          && reusableFirst.rows.every((row, index) => row.rowId === wanted[index]
            && row.rowIndex !== undefined && row.rowIndex + 2 === sortedPhysicalRows.get(row.rowId))
          ? reusableFirst : undefined;
        // 服务端 row_ids 读口按物理行返回；显示顺序由已校验的排序身份序列决定。
        const result = cached ?? await xlsxSource.readPage(meta.tableId, {page:1, pageLength, rowIds:wanted}, signal);
        const byId = new Map(result.rows.map(row => [row.rowId, row]));
        if (wanted.some(id => !byId.has(id))) throw new Error('排序后行结构已变化，请重新排序');
        adoptPhysicalMeta(result.meta);
        contentVersion = result.meta.contentVersion;
        structureVersion = result.meta.structureVersion;
        rememberVersions(result.rows);
        result.rows.forEach(row=>stylesByRow.set(row.rowId,row.styles||{}));
        if(result.defaultStyle)tableDefaultStyle=result.defaultStyle;
        return { rows:wanted.map(id => toUnifiedRow(byId.get(id)!, headers)), total:sortedRowIds.length, meta:displayMeta(result.meta) };
      }
      const result = reusableFirst ?? await xlsxSource.readPage(meta.tableId, { page, pageLength }, signal);
      result.rows.forEach(row=>stylesByRow.set(row.rowId,row.styles||{}));
      if(result.defaultStyle)tableDefaultStyle=result.defaultStyle;
      table.totalRows = result.total;
      adoptPhysicalMeta(result.meta);
      contentVersion = result.meta.contentVersion;
      rememberVersions(result.rows);
      return { rows: result.rows.map((row) => toUnifiedRow(row, headers)), total: result.total,meta:displayMeta(result.meta) };
    },

    async findRowPage(rowId, pageLength) {
      if (sortedRowIds) { const index=sortedRowIds.indexOf(rowId); return index<0?-1:Math.floor(index/pageLength)+1; }
      // xlsx 的 row_id 是服务端按**位置**发的号，不保证字典序，二分会跳错页。
      // 按页顺序找：命中即停。表很大时是线性，但正确性优先——跳错行比慢更糟。
      const pages = Math.max(1, Math.ceil(table.totalRows / pageLength));
      for (let page = 1; page <= pages; page++) {
        const { rows } = await table.loadPage(page, pageLength);
        if (rows.some((r) => r.name === rowId)) return page;
      }
      return -1;
    },

    async search(term, limit, page = 1, querySignal) {
      const result = await xlsxSource.readPage(meta.tableId, { page, pageLength: limit, search: term }, querySignal ?? signal);
      // 有 search 时 total 是**真实命中行数**（不是本页条数），分页在这上面翻。
      rememberVersions(result.rows);
      return { rows: result.rows.map((row) => toUnifiedRow(row, headers)), total: result.total };
    },

    async writeCell(req) {
      // —— **领域确认动作**（2026-10-29 案号采用）：这一格的值由域的公开写动作确认
      //   （域自己重核正式值、北京年、当年最大流水，再带上版本闸落盘）。
      //   ⚠️ **仍走同一条保存队列、同一把幂等键、同一份版本回执** ⇒ 不是绕过保存状态的旁路。
      if (req.domainAction) {
        const outcome = await runDomainWrite(req.domainAction, req.idempotencyKey, signal);
        if (outcome.kind === 'rejected') return outcome;
        const raw = outcome.raw || {};
        if (typeof outcome.contentVersion === 'number') contentVersion = outcome.contentVersion;
        if (typeof outcome.structureVersion === 'number') structureVersion = outcome.structureVersion;
        const recordVersion = typeof raw.record_version === 'string' && raw.record_version ? raw.record_version : '';
        // 写完把**这一行新的受管记录版本**存下来（理由见下面 writeCell 那段注释）：
        // 不存 ⇒ 客户端手里的版本变旧 ⇒ 下一笔被自己的旧版本拒 ⇒ 整队停。
        if (recordVersion) recordVersions.set(req.rowId, recordVersion);
        return {
          kind: 'success',
          idempotent: outcome.idempotent,
          modified: recordVersion || undefined,
          contentVersion,
          structureVersion,
          value: req.text,
          applied: true,
          valueSource: raw.routed === 'database' ? 'db' : 'file',
        };
      }
      // PKG-004 路由分流：晋升列走 files.cell_write（过 DB 规则），普通列走 files.sheet_cell_write。
      // E 2026-10-15：header 是表头名（不是字段 ID）；回包 routed: 'database'|'sheet'。
      const isPromoted = this.promotedColumns?.has(req.fieldId) ?? false;
      const endpoint = isPromoted
        ? '/api/platform/actions/files.cell_write/execute'
        : '/api/platform/actions/files.sheet_cell_write/execute';
      const payload: Record<string, unknown> = {
        table: meta.tableId,
        // `sheet` 只有 files.sheet_cell_write 收：files.cell_write 的 schema 里没这一项，
        // 带上会被动作闸以「动作包含未声明字段：payload.sheet」417 拒掉（004C ① 实测踩到）。
        ...(isPromoted ? {} : { sheet: meta.sheetId }),
        row_id: req.rowId,
        header: req.fieldId,
        expected_content_version: contentVersion,
        expected_structure_version: structureVersion,
        // PKG-004-T03 第 2 步：**带这一行背后那条受管记录的版本**。
        // 服务端拿它当版本闸 ⇒ 别人改过这一格时，这次写**当场被拒**（不是后写覆盖先写）。
        // 普通列没有受管记录 ⇒ 不带这个键（带了空值也会被动作闸拒）。
        ...(recordVersions.get(req.rowId) ? { expected_record_version: recordVersions.get(req.rowId) } : {}),
        value: toTypedValue(req.fieldType, req.text),
      };
      try {
        const response = await fetch(endpoint, {
          method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload, confirmed: true, idempotency_key: req.idempotencyKey, source: 'user' }),
          signal,
        });
        const body = await response.json();
        if (!response.ok || body?.ok === false) {
          const msg = body?.error || body?.message || `保存失败（HTTP ${response.status}）`;
          return { kind: 'rejected', reason: msg };
        }
        const r = body?.result || {};
        // PKG-004：晋升分支（files.cell_write）的 content_version 嵌在 result.sheet 里，
        // 普通分支（files.sheet_cell_write）在顶层。回执不一致（B 2026-10-15 确认，待 D 对齐）。
        // 临时多处找，D 对齐后只读顶层即可。
        const cv = (typeof r.content_version === 'number') ? r.content_version
          : (typeof r.sheet?.content_version === 'number') ? r.sheet.content_version
          : (typeof r.sheet?.contentVersion === 'number') ? r.sheet.contentVersion
          : undefined;
        if (typeof cv === 'number') contentVersion = cv;
        const sv = (typeof r.structure_version === 'number') ? r.structure_version
          : (typeof r.sheet?.structure_version === 'number') ? r.sheet.structure_version
          : undefined;
        if (typeof sv === 'number') structureVersion = sv;
        // ⚠️ **写完要把「这一行新的受管记录版本」存下来**（2026-10-29 站上实测的连锁故障）：
        //   客户端手里那份版本**只在读的时候更新** ⇒ 自己写完一格，版本就旧了
        //   ⇒ **下一笔被内核的乐观锁拒**（「记录已被修改，请刷新后重试」）
        //   ⇒ 那笔失败卡在**输入队列队首** ⇒ 整队停 ⇒ 页面永远「有未保存」
        //   ⇒ 列宽／拖列／撤回／导出**全被禁** ⇒ 人以为那些功能坏了。
        // ⇒ **服务端写完回带新版本，这里存下来** ⇒ 下一次写带的是**最新**那份 ⇒ 不会撞自己。
        if (typeof r.record_version === 'string' && r.record_version) {
          recordVersions.set(req.rowId, r.record_version);
        }
        return {
          kind: 'success',
          hasFormulas:r.has_formulas??r.sheet?.has_formulas,
          rowId: r.row_id || req.rowId,
          header: r.header || req.fieldId,
          value: r.value ?? null,
          contentVersion: r.content_version ?? contentVersion,
          structureVersion: r.structure_version ?? structureVersion,
          applied: !!r.applied,
          idempotent: !!body.idempotent,
          // E 2026-10-15 纠正：后端回 routed: 'database'|'sheet'，不是 value_source
          valueSource: r.routed === 'database' ? 'db' : 'file',
        };
      } catch (error) {
        const err = error as Error;
        return { kind: 'rejected', reason: err.message };
      }
    },

    async writeCells(reqs, idempotencyKey) {
      // B 的 files.sheet_cells_write：一次请求写 N 格，全成或全不成。
      // 一个包 = 一个幂等键 = content_version 恰 +1（回包一次性覆盖本地闩）。
      const cells = reqs.map((req) => ({
        row_id: req.rowId,
        header: req.fieldId,
        value: toTypedValue(req.fieldType, req.text),
      }));
      // PKG-004-T03 第 5 批：**逐行受管记录版本**——这一包里涉及的行的版本带回去
      // ⇒ 那一行被别人改过 ⇒ 服务端**整包拒**（不是后写覆盖先写）。
      // **不带也不影响**（老客户端照旧能写；表级 content_version 闸仍在）。
      const expectedRecordVersions: Record<string, string> = {};
      for (const req of reqs) {
        const version = recordVersions.get(req.rowId);
        if (version) expectedRecordVersions[req.rowId] = version;
      }
      const response = await fetch('/api/platform/actions/files.sheet_cells_write/execute', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: {
            table: meta.tableId,
            sheet: meta.sheetId,
            expected_content_version: contentVersion,
            expected_structure_version: structureVersion,
            op_id: idempotencyKey,
            ...(Object.keys(expectedRecordVersions).length
              ? { expected_record_versions: expectedRecordVersions }
              : {}),
            cells,
          },
          confirmed: true,
          idempotency_key: idempotencyKey,
          source: 'user',
        }),
        signal,
      });
      const body = await response.json();
      if (!response.ok || body?.ok === false) {
        const msg = body?.error || body?.message || `批量写入失败（HTTP ${response.status}）`;
        throw new Error(msg);
      }
      const result = body?.result || {};
      // B 口径：回包的 content_version 就是下一次该带的期望值，一次性覆盖本地闩
      if (typeof result.content_version === 'number') contentVersion = result.content_version;
      if (typeof result.structure_version === 'number') structureVersion = result.structure_version;
      // ⚠️ **写完要把「这几行新的受管记录版本」存下来**（理由见上面 `writeCell` 那段注释）：
      //   不存 ⇒ 客户端手里的版本变旧 ⇒ 下一笔被自己的旧版本拒（「记录已被修改，请刷新后重试」）
      //   ⇒ 那笔卡在输入队列队首 ⇒ 整队停 ⇒ 页面永远「有未保存」⇒ 列宽／拖列／撤回全被禁。
      for (const [rowId, version] of Object.entries((result.record_versions || {}) as Record<string, string>)) {
        if (rowId && typeof version === 'string' && version) recordVersions.set(rowId, version);
      }
      return {
        hasFormulas:result.has_formulas,
        contentVersion: contentVersion,
        structureVersion: structureVersion,
        applied: result.applied ?? reqs.length,
        cellResults: (result.cells || []).map((c: Record<string, unknown>) => ({
          rowId: String(c.row_id || ''),
          header: String(c.header || ''),
          before: c.before,
          after: c.after,
        })),
      };
    },

    // PKG-003-T03: 越界粘贴一次成包（B 的 files.sheet_paste_apply）
    // 扩展+写值服务端一次做完、全成或全不成、失败零残留。
    // PKG-003-T03: 越界粘贴一次成包（B 的 files.sheet_paste_apply）
    // 扩展+写值服务端一次做完、全成或全不成、失败零残留。
    //
    // ★ 合并说明（ours + theirs 两边都在）：
    //  · ours：inputWrite（单格输入）与 pasteApply（成包粘贴）**共用** sendRange ——
    //    个人视图（排序后的行身份 target_row_ids）、saved_view 回读、expected*Version 都在那儿。
    //  · theirs：粘贴这一路额外保证三件事 ——
    //    ① 同一 opId 重试发**完全一样**的载荷（请求体按 opId 冻结）；
    //    ② 调用方没给 matrix_types 时按列定义推一份；
    //    ③ 回执不完整/5xx/408 一律当「结果未知」，让用户按原编号核实。
    //    → 这三条已折进 sendRange（见上面），所以这里仍走同一个 sendRange。
    async inputWrite(opts) { return sendRange(true,opts); },
    async pasteApply(opts) { return sendRange(false,opts); },

    async writeLayout(widths, opId, autoFitColumns) {
      const physicalWidths=Object.fromEntries(Object.entries(widths).map(([index,width])=>[physicalColumn(Number(index)),width]));
      const outcome = await xlsxSource.writeLayout({
        tableId: meta.tableId,
        sheetId: meta.sheetId,
        expectedContentVersion: contentVersion,
        expectedStructureVersion: structureVersion,
        columnWidths: physicalWidths,
        opId,
        ...(autoFitColumns && autoFitColumns.length ? { autoFitColumns:autoFitColumns.map(physicalColumn) } : {}),
      }, signal);
      if (outcome.kind === 'success') {
        contentVersion = outcome.contentVersion;
        for (const [index, px] of Object.entries(physicalWidths)) physicalColumnWidths[Number(index)] = px;
        // 自动算宽：服务端算出来的列宽要落进本地表，宽才真的变。
        for (const [index, px] of Object.entries(outcome.columnWidths || {})) physicalColumnWidths[Number(index)] = px;
        projectColumns();
        return { idempotent: outcome.idempotent, contentVersion: outcome.contentVersion,
                 columnWidths: { ...table.columnWidths } };
      }
      if (outcome.kind === 'unknown') {
        const receipt = await xlsxSource.receipt(outcome.opId, signal);
        if (receipt.status === 'Succeeded') return { idempotent: true, contentVersion };
        if (receipt.status === 'Failed') throw new Error(receipt.failure_reason || '列宽保存失败（服务端已拒绝）');
        throw new Error('列宽保存结果未知，可点「重试原操作」用原编号补交');
      }
      throw new Error(outcome.reason);
    },

    // —— 结构动作（N2-A1）—————————————————————————————————

    async appendRows(count, opId) {
      const r = await xlsxSource.appendRows({
        tableId: meta.tableId, sheetId: meta.sheetId,
        expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
        count, opId,
      }, signal);
      contentVersion = r.contentVersion;
      structureVersion = r.structureVersion;
      return { rowIds: r.rowIds };
    },

    async appendColumn(header, opId) {
      const r = await xlsxSource.appendColumn({
        tableId: meta.tableId, sheetId: meta.sheetId,
        expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
        header, opId,
      }, signal);
      contentVersion = r.contentVersion;
      structureVersion = r.structureVersion;
    },

    async renameHeader(fromHeader, toHeader, opId,expected) {
      const r = await xlsxSource.renameHeader({
        tableId: meta.tableId, sheetId: meta.sheetId,
        expectedContentVersion: expected?.contentVersion??contentVersion, expectedStructureVersion: expected?.structureVersion??structureVersion,
        fromHeader, toHeader, opId,
      }, signal);
      contentVersion = r.contentVersion;
      structureVersion = r.structureVersion;
    },

    async renameTable(title, opId) {
      const r = await xlsxSource.renameTable({
        tableId: meta.tableId, sheetId: meta.sheetId,
        expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
        title, opId,
      }, signal);
      table.title = r.tableTitle;
    },

    // BASE967-19：插/删行列
    async structureAction(kind, target, opId, before) {
      const r = await xlsxSource.structureAction({tableId:meta.tableId,sheetId:meta.sheetId,expectedContentVersion:contentVersion,expectedStructureVersion:structureVersion,kind,target,opId,before},signal);
      contentVersion=r.contentVersion;structureVersion=r.structureVersion;
    },
    async insertRows(beforeRowId, count, opId) {
      // B 的 schema 要 before_row_id 必填 string（null 被 417 拒）—— null = 末尾插走 appendRows
      if (beforeRowId == null) {
        const r2 = await xlsxSource.appendRows({
          tableId: meta.tableId, sheetId: meta.sheetId,
          expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
          count, opId,
        }, signal);
        contentVersion = r2.contentVersion;
        structureVersion = r2.structureVersion;
        return { rowIds: r2.rowIds };
      }
      const r = await xlsxSource.insertRows({
        tableId: meta.tableId, sheetId: meta.sheetId,
        expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
        beforeRowId, count, opId,
      }, signal);
      contentVersion = r.contentVersion;
      structureVersion = r.structureVersion;
      return { rowIds: r.rowIds };
    },

    async insertColumn(beforeHeader, header, opId) {
      // 同 insertRows：before_header null = 末尾插走 appendColumn
      if (beforeHeader == null) {
        const r2 = await xlsxSource.appendColumn({
          tableId: meta.tableId, sheetId: meta.sheetId,
          expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
          header, opId,
        }, signal);
        contentVersion = r2.contentVersion;
        structureVersion = r2.structureVersion;
        return;
      }
      const r = await xlsxSource.insertColumn({
        tableId: meta.tableId, sheetId: meta.sheetId,
        expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
        beforeHeader, header, opId,
      }, signal);
      contentVersion = r.contentVersion;
      structureVersion = r.structureVersion;
    },

    async deleteRow(rowId, opId) {
      const r = await xlsxSource.deleteRow({
        tableId: meta.tableId, sheetId: meta.sheetId,
        expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
        rowId, opId,
      }, signal);
      contentVersion = r.contentVersion;
      structureVersion = r.structureVersion;
    },

    async deleteColumn(header, opId) {
      const r = await xlsxSource.deleteColumn({
        tableId: meta.tableId, sheetId: meta.sheetId,
        expectedContentVersion: contentVersion, expectedStructureVersion: structureVersion,
        header, opId,
      }, signal);
      contentVersion = r.contentVersion;
      structureVersion = r.structureVersion;
    },

    async refreshMeta() {
      const fresh = await xlsxSource.open(meta.tableId, signal);
      // 更新列定义和版本号。行数据不在这儿刷新——上层会重新 loadPage。
      adoptPhysicalMeta(fresh);
      contentVersion = fresh.contentVersion;
      structureVersion = fresh.structureVersion;
      table.columns = columns;
      table.totalRows = fresh.totalRows;
      table.writable=fresh.writable;table.canDownload=fresh.canDownload;table.canStructure=fresh.canStructure;
      table.title = fresh.displayName;
    },
  };
  if (meta.fileOperations) {
    // —— **回落整表默认样式**（2026-10-30 性能：服务端逐格 styles 只带「和默认不一样」的格
    //   ⇒ 没给的那格**回落成默认** ⇒ 与改动前渲染**完全一样**）。
    table.cellStyle=(rowId,header)=>stylesByRow.get(rowId)?.[header]??tableDefaultStyle;
    table.fileOperation=async (action,payload,key)=>{
      if (!meta.fileOperations?.[action]) throw Error('服务器尚未提供该文件操作，请升级后使用');
      let body=operationBodies.get(key);
      if (!body) {
        body=JSON.stringify({payload:{...payload,table:meta.tableId,
          expected_content_version:contentVersion,expected_structure_version:structureVersion},
          confirmed:true,idempotency_key:key,source:'user'});
        operationBodies.set(key,body);
      }
      let response:Response;
      try { response=await fetch(`/api/platform/actions/files.sheet_${action}/execute`,{
        method:'POST',credentials:'include',headers:{'content-type':'application/json'},body,signal}); }
      catch {throw Error('操作结果未知，请按原编号核实，不要重新操作');}
      let data:any;
      try{data=await response.json();}catch{throw Error('操作回执不完整，请按原编号核实');}
      if(response.status>=500||response.status===408)throw Error('操作结果未知，请按原编号核实');
      if (!response.ok||data?.ok===false) throw Error(data.error||data.message||'文件操作被拒绝');
      const result=data.result;
      if (result?.table!==meta.tableId||!Number.isInteger(result.content_version)||!Number.isInteger(result.structure_version))
        throw Error('操作回执不完整，请按原编号核实');
      contentVersion=result.content_version;structureVersion=result.structure_version;
    };
  }
  return table;
}

// —— 打开一张表 ————————————————————————————————————————————————

/**
 * 明确来源直接读取目标；目录/创建/上传入口传来源，不按 ID 外形猜测。
 * 旧链接没有来源时经公共表身份解析器精确定位；读失败不换存储重试。
 */
export async function openTable(key: string, signal?: AbortSignal, source?: 'db'|'xlsx'): Promise<UnifiedTable> {
  let chosen: ObjectInfo | undefined;
  if(!source)source=await platformTableResource(key,signal);
  if (source === 'db') chosen = await platformObjectDefinition(key, signal);
  if (chosen?.companion) {
    const first = await xlsxSource.readPage(chosen.companion.file_id, {page:1,pageLength:100}, signal);
    const table = attachCompanionTable(createXlsxTable(first.meta,signal,first),chosen,signal);
    table.objectInfo = chosen;
    return table;
  }
  if (chosen) return createDbTable(chosen, signal);
  const firstPage = await xlsxSource.readPage(key, {page:1,pageLength:100}, signal);
  return createXlsxTable(firstPage.meta, signal, firstPage);
}

// —— 统一入口的列表 ————————————————————————————————————————————

export interface TableEntry {
  key: string;
  title: string;
  /** 只用来画图标/分组，**不写进表卡正文**。 */
  kind: 'db' | 'xlsx';
  /** 归属（企业/部门/个人）。B 的接口给，没有则 undefined → 显示「—」。 */
  ownership?: string;
  /** 更新时间（人看得懂的格式）。B 的接口给，没有则 undefined → 显示「—」。 */
  updatedAt?: string;
  /** 本人可用权限（可读/可编辑/…）。B 的接口给，没有则 undefined → 显示「—」。 */
  permission?: string;
  /** 能否改结构（加行/加列/改表头/改表名）。按钮显隐用。 */
  canStructure?: boolean;
  /** 能否下载/导出。B 语义：管理读不带导出；企业/个人级单列；部门级默认可下载。 */
  canDownload?: boolean;
  /** 能否转授共享。B 语义：只有归属人为 true。 */
  canShare?: boolean;
  canAssign?: boolean;
}

/**
 * 表目录走公共对象摘要分页和文件表目录分页；搜索、归属条件下推到各自读口。
 * 混合目录先排数据库表，再排 xlsx；后者的页偏移由数据库表总数确定。
 * 无显式页码的关联候选最多读 FETCH_CAP 个摘要；不取全表字段定义。
 */
export interface TableListResult {
  /** 某一来源失败时保留成功侧，并明确列表不完整。 */
  errors?: string[];
  entries: TableEntry[];
  /** 服务端真总数。被 FETCH_CAP 截断时大于 entries.length。 */
  total: number;
  /** 是否被截断（还有没装进来的）。 */
  truncated: boolean;
}

const PAGE_SIZE = 100;
/** 一次最多装进清单的张数。再多就该搜，不该肉眼扫。 */
const FETCH_CAP = 500;

export async function listTables(
  signal?: AbortSignal,
  opts: { search?: string; page?: number; pageLength?: number; attributionLevel?: string } = {},
): Promise<TableListResult> {
  const term=(opts.search||'').trim(),out:TableEntry[]=[],errors:string[]=[];
  const paged=typeof opts.page==='number'&&opts.page>0;
  const pageLength=Math.max(1,Math.min(100,opts.pageLength||PAGE_SIZE));
  const uiPage=paged?opts.page!:1;
  const readObjects=(page:number,length:number)=>platformObjectList(signal,{
    search:term,page,pageLength:length,summary:true,attributionLevel:opts.attributionLevel,
  }).catch(error=>{errors.push('业务数据：'+(error instanceof Error?error.message:String(error)));return null;});
  const readFiles=async(page:number,length:number)=>{
    const filters:Record<string,string>={scope:'sheet',order:'desc'};
    if(term)filters.q=term;
    if(opts.attributionLevel)filters.attribution_level=opts.attributionLevel;
    const query=new URLSearchParams({filters:JSON.stringify(filters),page:String(page),page_length:String(length)});
    try{
      const response=await fetch('/api/platform/datasets/files.file/records?'+query,{credentials:'include',signal});
      const body=await response.json();
      if(!response.ok||body?.ok===false)throw Error(body?.error||'读取文件工作簿列表失败');
      return body;
    }catch(error){errors.push('文件工作簿：'+(error instanceof Error?error.message:String(error)));return null;}
  };
  const addObject=(entry:ObjectInfo)=>{
    const attr=entry.attribution;
    out.push({key:entry.id,title:entry.title||entry.name||entry.id.split('.').pop()||entry.id,kind:'db',
      ownership:attr?.level==='personal'?'个人':attr?.level==='department'?(attr.department_title||'部门'):attr?.level,
      updatedAt:entry.modified?.replace('T',' ').slice(0,16),permission:entry.can_edit===undefined?undefined:entry.can_edit?'可编辑':'只读',
      canStructure:entry.can_structure===true,canDownload:entry.can_download===true,canShare:entry.can_share===true});
  };
  let dbTotal=0,fileTotal=0;
  if(paged){
    // 对象目录已经是服务端摘要分页，不读取全部定义再切片。
    const objectPage=await readObjects(uiPage,pageLength);
    dbTotal=Number(objectPage?.total??0);
    for(const entry of (objectPage?.list||[]) as ObjectInfo[])addObject(entry);
    const start=Math.max(0,(uiPage-1)*pageLength-dbTotal),end=Math.max(0,uiPage*pageLength-dbTotal);
    // 文件偏移依赖对象总数；只并发真正属于当前页的1～2个文件页。
    const first=Math.floor(start/pageLength)+1,last=Math.floor(Math.max(start,end-1)/pageLength)+1;
    const pages=end>start?Array.from({length:last-first+1},(_,index)=>first+index):[1];
    const length=end>start?pageLength:1;
    const bodies=await Promise.all(pages.map(page=>readFiles(page,length)));
    bodies.forEach((body,index)=>{
      if(!body)return;
      fileTotal=Number(body.total??0);
      if(end<=start)return; // 本页全是对象；文件侧只取总数所需的最小页。
      const rows=(body.rows||body.records||[]) as Record<string,unknown>[];
      rows.forEach((row,offset)=>{const position=(pages[index]-1)*pageLength+offset;if(position>=start&&position<end)out.push(_fileEntry(row));});
    });
  }else{
    // 显式关系候选读取：仍有500项上限，但只读取摘要，不取每张表的字段定义。
    const [firstObjects,firstFiles]=await Promise.all([readObjects(1,100),readFiles(1,PAGE_SIZE)]);
    dbTotal=Number(firstObjects?.total??0);
    for(let page=1;firstObjects&&out.length<FETCH_CAP;page++){
      const body=page===1?firstObjects:await readObjects(page,100);
      if(!body)break;
      const rows=(body.list||[]) as ObjectInfo[];
      for(const row of rows.slice(0,FETCH_CAP-out.length))addObject(row);
      if(rows.length<100||page*100>=dbTotal)break;
    }
    if(firstFiles){
      fileTotal=Number(firstFiles.total??0);
      for(let page=1;out.length<FETCH_CAP;page++){
        const body=page===1?firstFiles:await readFiles(page,PAGE_SIZE);
        if(!body)break;
        const rows=(body.rows||body.records||[]) as Record<string,unknown>[];
        for(const row of rows.slice(0,FETCH_CAP-out.length))out.push(_fileEntry(row));
        if(rows.length<PAGE_SIZE||page*PAGE_SIZE>=fileTotal)break;
      }
    }
  }
  const total=dbTotal+fileTotal;
  return {entries:out,total,truncated:errors.length>0||(!paged&&out.length<total),...(errors.length?{errors}:{})};
}

/** 一行文件记录 ⇒ 目录里的一项（**两处共用**：分页与全量同一份口径）。 */
function _fileEntry(row: Record<string, unknown>): TableEntry {
  const key = String(row.name || '');
  const title = String(row.file_name || row.name || '');
  // A1: B 契约 §7.1.4 —— 目录元数据（归属/权限/更新时间）
  const attr = (row.attribution || {}) as Record<string, string>;
  // BASE967-31 消费侧：level 只有 personal/department（用户 10-15「单例无企业归属」）
  const levelLabels: Record<string, string> = {
    personal: '个人', department: attr.department_title || '部门',
  };
  const ownership = attr.level ? (levelLabels[attr.level] || attr.level) : undefined;
  // BASE967-31：modified 三字段，modified 用服务端算好的（content_modified / structure_modified 中较晚者）
  const modified = row.modified ? String(row.modified).replace('T', ' ').slice(0, 16) : undefined;
  // BASE967-31 消费侧：my_access 六键（read/preview/download/write/review/structure），暂缺即 false
  const ma = (row.my_access || {}) as Record<string, boolean | undefined>;
  const permission = ma.write !== undefined
    ? (ma.write ? '可编辑' : '只读')
    : (row.can_edit !== undefined ? (row.can_edit ? '可编辑' : '只读') : undefined);
  return {
    key, title: title || key, kind: 'xlsx', ownership, updatedAt: modified, permission,
    canStructure: row.can_structure === true || row.can_structure === 1,
    canDownload: row.can_download === true || row.can_download === 1,
    canShare: row.can_share === true || row.can_share === 1,
    canAssign: row.can_assign === true || row.can_assign === 1,
  };
}
