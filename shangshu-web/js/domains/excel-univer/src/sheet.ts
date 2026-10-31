/**
 * Univer 网格封装：只把「改一格」交给上层，其余一律不放开。
 *
 * 为什么不放开别的：本批只接通了单格修改这一条公共动作。加行删行、加列改表头、
 * 粘贴、填充、格式、本地 undo 都没有对应动作——放开了，本地 workbook 会自己变掉
 * 并看起来像已保存。所以按白名单放行，其余在命令执行前取消（event.cancel）。
 */
import { createUniver, defaultTheme, LocaleType, merge } from '@univerjs/presets';
import { VerticalAlign,CellValueType,Plugin,Injector,Inject,UniverInstanceType,type Workbook,type IStyleData } from '@univerjs/core';
import {IRenderManagerService,Vector2,type IRender} from '@univerjs/engine-render';
import type {CandidateOverlayFrame} from './candidate-overlay';
import {fontStyleToUniver,type CellFontStyle} from './font-style';
import {formulaRangeHint,formulaSeed,hitCell,rangeAddress,replaceReferenceAtCaret,shouldTakeFormulaShortcut,type CellPoint,type CellRect} from './formula-range';
import {installFlatHeaderChrome,type HeaderChromeDiag} from './header-chrome';
import {columnHeaderCfg} from './managed-header-style';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import { IEditorBridgeService, SetCellEditVisibleOperation, ScrollCommand, type IScrollState } from '@univerjs/sheets-ui';
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
// Univer 的样式是各包独立的 lib/index.css，JS 入口不引它们。少了这些，
// univer-h-full / univer-flex-col 这些工具类全不生效，整个网格会塌成一行字高。
// 与 bundle 同版本同发，所以内联进来而不是单独挂 link。
import univerDesignCss from '@univerjs/design/lib/index.css?inline';
import univerUiCss from '@univerjs/ui/lib/index.css?inline';
import univerSheetsUiCss from '@univerjs/sheets-ui/lib/index.css?inline';
import univerSheetsCoreCss from '@univerjs/preset-sheets-core/lib/index.css?inline';
import {selectionRange} from './selection';
import {openValueDropdown} from './cell-dropdown';
import {REQUIRED_EMPTY_HIGHLIGHT} from './required-marks';
import {createShapeLayer} from './shape-layer';
import {frameThrottle} from './frame-throttle';
import {openDatePicker,openTriState} from './cell-picker';

const UNIVER_STYLE_ID = 'excel-univer-vendor-css';

function ensureUniverStyles(): void {
  if (document.getElementById(UNIVER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = UNIVER_STYLE_ID;
  style.textContent = [univerDesignCss, univerUiCss, univerSheetsUiCss, univerSheetsCoreCss].join('\n');
  document.head.appendChild(style);
}

export interface GridColumn {
  fieldId: string;
  label: string;
  type: string;
  readOnly: boolean;
  /**
   * **这一列的取值清单**（有清单 ⇒ 双击那格给下拉／可搜索下拉）。
   * ⚠️ 没有清单的列**不给**这个键 ⇒ 那一格照旧自由填写。
   */
  options?: string[];
  /**
   * **显示名**（存储值 ⇒ 给人看的那句话）（2026-10-29 用户口径）。
   * ⚠️ **显示名与存储值分开**：案号那两列的值是 `DD`／`F` 这种码 ⇒ 显示给中文，
   * **存进去的仍然是码**（算法按码表判，填了中文就白填）。
   */
  optionLabels?: Record<string, string>;
  /** 能不能填清单以外的值（**没写 = 能**）。 */
  allowCustom?: boolean;
  /** 「自己填一个」那个口的文案。 */
  customLabel?: string;
  /**
   * **这一列是必填**（2026-10-29 用户口径：「把案号所需要的列列成必填，不允许空着」）。
   * ⚠️ **后端已经把这件事挂上来了**（`files.promotion_definition` 的 `columns[].rules.required`）
   *   ⇒ 前端只**认**它，不自己编一份「哪几列必填」。
   * ⚠️ 认了之后 ⇒ **列头上有看得见的必填标记**（末尾一颗星，见 `managed-header-style.ts`）。
   */
  required?: boolean;
}

export interface CommitEvent {
  rowIndex: number;
  colIndex: number;
  fieldId: string;
  value: string;
  before: string;
  /** 字段类型（integer/decimal/long_text/…）；上层据此决定提交成数字还是字符串。 */
  type: string;
}

export interface GridDiag {
  /** ours：列头画布（扁平表头）的就绪情况。 */
  headerChrome:HeaderChromeDiag;
  /** fast：是不是正在单元格里打字（编辑中）。 */
  editing: boolean;
  visibleRows: [number, number];
  rowHeights: Record<number, number>;
  rowHeightState: Record<number, { h?: number; ah?: number; ia?: number }>;
  defaultRowHeight: number;
  wrapColumns: string[];
  highlight: { rowIndex: number; colIndex: number } | null;
  /** **渲染层形状**：几组、几个格子（2026-10-30：格上的效果都走形状层）。 */
  shapes: { groups: number; cells: number };
  /** **受管列清单**（列头白字绿底的那几列；按列的**表头名**）。 */
  managedHeaders: string[];
  /** 各列当前列宽（像素）。拖列宽后这里会变，给页面侧测试断言用。 */
  columnWidths: Record<number, number>;
  /**
   * 列表头实际设置的文字（字段名）。
   *
   * 为什么要有：表头画在 canvas 上，DOM 里读不到，页面侧测试没法直接断言。
   * 这里回报**我们设进去的**文字，配合截图证据核对。
   * 用户 2026-10-11「我找不到该名称这个选项」——表头原先显示 A/B/C 字母，
   * 那里根本没有中文，所以「名称」这一列在表头上找不到。
   */
  headerLabels: string[];
  /**
   * 设表头时的真因回报。**不许静默吞异常**——
   * 2026-10-11 就是 `catch {}` 把「Render component not found」吃掉了，
   * 诊断口回报「已设」而 canvas 仍画 A/B/C，测试假绿。
   * 这里存的是 `customizeColumnHeader` 抛出的原始信息；`''` 表示没抛。
   */
  headerLabelError: string;
  /**
   * 设表头还在重试中的次数。`> 0` = 渲染单元还没就绪、正在等（**不是失败**）；
   * `0` 且 `headerLabelError` 为空 = 已设上；`0` 且 error 非空 = 真失败。
   * 把「等」和「失败」分开，测试才不会把等待误判成缺陷、也不会把失败误判成通过。
   */
  headerLabelPending: number;
  /** 传给 customizeColumnHeader 的 cfg 原样，用来核对形状对不对。 */
  headerCfgSent: Record<number, string> | null;
  /**
   * 最近几笔单格提交的 before / after。
   * 撤回要写回 before，before 一旦是过期值就会撤错格 —— 而这件事从界面上完全看不出来
   * （值变了，看不出「变回的是不是该变回的那个」）。所以留个流水给测试核。
   */
  recentCommits: Array<{ rowIndex: number; fieldId: string; before: string; next: string }>;
}

export interface GridRowInput {
  rowIndex:number;
  values:Array<string|number|null>;
  cellTypes?:Array<string|undefined>;
  formulas?:Array<string|undefined>;
  cellStyles?:Array<CellFontStyle|undefined>;
}

export interface GridViewState {range:{startRow:number;startCol:number;endRow:number;endCol:number}|null;scroll:IScrollState|null}

export interface GridHandle {
  getViewState():GridViewState;
  restoreViewState(state:GridViewState,selection?:boolean):void;
  /** 一次装填一页，避免逐行触发网格命令、骨架和审核层重绘。 */
  setRows(rows:GridRowInput[]):void;
  setFreeze(rows:number,columns:number):void;
  setColumnWidths(widths:Array<{colIndex:number;width:number}>):void;
  setRowHeights(heights:Record<number,number>):void;
  onRowHeight(handler:(heights:Record<number,number>,before:Record<number,number>)=>void):void;
  /**
   * 装填一行。
   * 合并说明：ours 这边是 (values, cellTypes, cellStyles) 三个参数；
   * fast 那边是 (values, styles) 两个参数（styles 是逐格格式视图）。
   * 合并后保留 ours 的三参签名，并把 fast 的 styles 落到**第三个参数**上 ——
   * 上层调用方（main.ts）两边都改成走这一条，避免两套装填口径。
   */
  setRow(rowIndex: number, values: Array<string | number | null>, cellTypes?: Array<string | undefined>,cellStyles?:Array<CellFontStyle|undefined>): void;
  getCellStyle(rowIndex:number,fieldId:string):CellFontStyle|undefined;
  setCellStyle(rowIndex:number,fieldId:string,style:CellFontStyle):void;
  setCellStyles(cells:Array<{rowIndex:number;fieldId:string;style:CellFontStyle}>):void;
  getRowValue(rowIndex: number, fieldId: string): string;
  /** 更新单格显示值（批量写后刷新用，不触发保存链）。 */
  setRowValue(rowIndex: number, fieldId: string, value: string | number | null, cellType?: string): void;
  /** 让 Univer 按内容 + 当前列宽自动重算所有行高（初始加载后兜底用）。 */
  recalcAutoHeights(startRow?: number, count?: number): void;
  /**
   * **恢复自动行高**（2026-10-29 用户口径：「再点一次自动行高」的回头路）。
   *
   * ⚠️ 人手拖高过的行 ⇒ 自动行高不再接管它 ⇒ 得有一条**能退回去**的路。
   * ⚠️ **纯画布，不发请求**（持久化由上层另走 `files.sheet_row_heights_write`）。
   */
  resetAutoRowHeights(rows: number[]): void;
  /** 当前选中格（粘贴起始位置用）。 */
  getSelection(): { rowIndex: number; colIndex: number } | null;
  /** 完整选区范围（复制用：起止行列）。 */
  getSelectionRange(): { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  selectCell(rowIndex: number, colIndex: number): void;
  /** 真的把那一行滚进可视区。注意 activate() 不滚屏，必须用 scrollToCell。 */
  scrollToRow(rowIndex: number, colIndex?: number): void;
  /** 在某格画高亮（纯渲染层，不改数据不走命令）。返回摘除函数。 */
  highlightCell(rowIndex: number, colIndex: number, source?: string): () => void;
  markReviewCells(cells: Array<{rowIndex: number; colIndex: number; kind: string}>): () => void;
  /** 给某列开文本折行（行高会自动撑开）。 */
  wrapColumn(colIndex: number): void;
  /** 设列宽（像素）。走 set-worksheet-col-width，和拖拽是同一件事的另一个入口。 */
  setColumnWidth(colIndex: number, width: number): void;
  /**
   * 把所有列当前宽度记成基线：之后只有真的变了的列才算「改动」（防拖一次报 22 列）。
   * （fast 那边同一件事的说法是「开表完成后记录全部列的真实宽度」——同一件事。）
   */
  snapshotColumnWidths(): void;
  /**
   * 把列表头换成**字段名**（不是 Univer 默认的 A/B/C 列字母）。
   *
   * 走官方 facade `FWorksheet.customizeColumnHeader({ columnsCfg })`，
   * 文字画在 canvas 的列头区，跟着列宽和横向滚动走，不用自己同步。
   * 任务书原话「表头是字段名」；用户 2026-10-11 就是因为表头只有字母才找不到「名称」。
   */
  setColumnHeaders(labels: string[]): void;
  /**
   * **哪些列是受管列**（按表头名）⇒ 受管列的列头**变绿**（2026-10-29 用户口径）。
   *
   * ⚠️ **为什么单独一个口**：受管列清单是**异步**拿到的（`files.promotion_definition`），
   *   常常**晚于**列头第一次设上 ⇒ 得能**再设一次**列头（样式才生效）。
   */
  setManagedColumns(labels: string[]): void;
  /**
   * **哪些列是必填列**（按表头名）⇒ 那些列的列头**带必填标记**（末尾一颗星）。
   *
   * ⚠️ **为什么单独一个口**（与 `setManagedColumns` 同一条道理）：
   *   必填列清单也是**异步**拿到的（`files.promotion_definition` 的 `rules.required`）
   *   ⇒ 常常**晚于**列头第一次设上 ⇒ 得能**再设一次**列头（标记才生效）。
   *   ⚠️ **「再设一次」时必填集合必须一起带上** —— 否则标记只对第一帧有效。
   */
  setRequiredColumns(labels: string[]): void;
  /**
   * **把「空的必填格」框红**（2026-10-30 用户口径：「如果空了就**把必填列给框起来用红色**」）。
   *
   * ⚠️ **纯渲染层**（用 Univer 的 `highlight`）：**不改数据、不执行命令**
   *   ⇒ 不会存进文件、不会触发保存链（这是「提醒」，不是「格式」）。
   *   ⚠️ **每刷新一次要再调一次**（用户口径：「**每一次刷新都自检一下**……
   *   没有被填入就**用红色继续框和提醒**」）⇒ 调它之前**先把上一次的摘掉**。
   */
  setRequiredEmptyMarks(delta:{added:Array<{rowIndex:number;fieldId:string}>;removed:string[]}): void;
  /**
   * **格上的装饰**（2026-10-30 用户口径：「这个自动化能不能也走渲染层的样式呢？」）。
   *
   * ⚠️ **走 Univer 原生的渲染层形状** ⇒ **被网格裁剪** ⇒ **不会溢出格子**
   *   （DOM 浮层会盖住格线、也会溢出 ⇒ 看着「格子都不对了」）。
   *
   * @param group 这一组的名字（**各效果各一组** ⇒ 改哪组只动哪组）
   * @param cells 要装饰的格（**列号**，不是字段 id）
   * @param style  Univer 高亮的样式（`fill` / `stroke` / `strokeWidth`）
   */
  decorateCells(group:string, cells:Array<{row:number;col:number}>, style:{fill:string;stroke?:string;strokeWidth?:number}): void;
  adoptColumns(next:GridColumn[]):boolean;
  onCommit(handler: (event: CommitEvent) => void): void;
  onSelection(handler:()=>void):void;
  /** Public renderer coordinates, including viewport scroll/zoom; null means no safe mapping yet. */
  getReviewFrame():CandidateOverlayFrame|null;
  getHeaderAtPoint(clientX:number,clientY:number):{colIndex:number;rect:{left:number;top:number;width:number;height:number}}|null;
  /**
   * 某一列**列头**在宿主坐标里的矩形（画列头小图标用）。
   *
   * 与 `getHeaderAtPoint` 同一套算法：列头的横坐标取**当前可见行**那一行的格矩形
   * （这样冻结列、横向滚动都对），纵坐标取画布顶到主视口顶之间那条列头带。
   * 那一列不在可视区就回 null（不画）。
   */
  getHeaderRect(colIndex:number):{left:number;top:number;width:number;height:number}|null;
  onLayout(handler:()=>void):void;
  /**
   * 是不是正在单元格里打字（有未提交的输入）。
   * 撤回要分两件事：在打字时 Cmd+Z 是「丢掉这句没发出去的输入」，
   * 没在打字时才是「撤回刚才那一格」。靠活动元素认，不猜 Univer 内部状态。
   */
  isEditing(): boolean;
  /** 放弃当前单元格里未提交的输入（回到格子原来的值）。**不发任何请求。** */
  cancelEdit(): void;
  onBlockedCommand(handler: (commandId: string) => void): void;
  /** 只读列被编辑时通知上层（显示提示 + 恢复原值）。 */
  onReadOnlyEdit(handler: (info: { rowIndex: number; colIndex: number; label: string }) => void): void;
  onScroll(handler: () => void): void;
  /** 列宽被拖拽/输入改掉之后通知上层去写回后端。给的是**像素**宽和 0 起列序号。 */
  onColumnWidth(handler: (colIndex: number, widthPx: number) => void): void;
  getDiag(): GridDiag;
  /** 只读：取某一格当前显示的文本（给诊断口用，不改任何行为）。 */
  getCellText(rowIndex: number, colIndex: number): string | null;
  dispose(): void;
}

const ALLOWED_VALUE_COMMAND = 'sheet.command.set-range-values';

/**
 * Delete / Backspace 清空选中格时 Univer 发的命令。
 * 它内部直接执行 SetRangeValuesMutation（不经过 set-range-values 命令），
 * 所以放行它不会走保存链 —— 必须在这里拦下，翻译成一笔「写空值」的提交。
 */
const CLEAR_CONTENT_COMMAND = 'sheet.command.clear-selection-content';

/** 建表用的默认行高；诊断口也要用它做基准，两处必须一致。 */
const DEFAULT_ROW_HEIGHT = 24;

/** WrapStrategy.WRAP 的实际数值（UNSPECIFIED=0 OVERFLOW=1 CLIP=2 WRAP=3）。 */
const WRAP_VALUE = 3;

/** 本批没有公共动作支撑的修改类命令，一律在执行前取消。 */
const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  /^sheet\.command\.(insert|delete|append)-/,
  /^sheet\.command\.paste/,
  /^sheet\.command\.optional-paste/,
  /^sheet\.command\.auto-fill$/,
  /^sheet\.command\.copy-(down|right)$/,
  /^sheet\.command\.move-range/,
  /^sheet\.command\.clear-selection-/,
  /^sheet\.command\.auto-clear-content$/,
  /^sheet\.command\.(add|remove)-worksheet-merge/,
  /^sheet\.command\.split-text-to-columns$/,
  /^sheet\.command\.set-range-(bold|italic|underline|strikethrough|fontsize|font-family|font-increase|font-decrease|text-color|background|border|stroke|hor|ver|wrap|shrink|rotation|subscript|superscript|custom-metadata)/,
  // set-worksheet-* 整族拦掉，但**放过 col-width 与 row-height**：
  //   · 右键「列宽」输入走的是 set-worksheet-col-width，跟拖拽是同一件事的另一个入口；
  //   · **行高手拖**走的是 set-worksheet-row-height（用户 2026-10-29 13:5x 口径：
  //     「**手拖过就以手拖为准，自动撑高不再覆盖它**」——那道闸在 `manualHeights` 里，
  //     早就在，只是**等不到手拖**（命令被这条白名单拦着）⇒ 现在放行）。
  //   其余（改表名/加删行列/冻结/保护/隐藏…）本批都没有动作支撑，继续拦。
  /^sheet\.command\.set-worksheet-(?!(?:col-width|row-height)$)/,
  /^sheet\.command\.(set|cancel)-frozen/,
  /^sheet\.command\.(insert|delete|set)-defined-name/,
  /^sheet\.command\.sort/,
  /^sheet\.command\.(hide|show|unhide)-(row|col)/,
  /^sheet\.command\.set-(col|rows?)-hidden$/,
  /^sheet\.command\.set-(col-visible-on-cols|selected-cols-visible|specific-rows-visible|selected-rows-visible)$/,
  /^sheet\.command\.numfmt\./,
  /^sheet\.command\.set-range-protection/,
  /^(undo|redo)\./,
  /^sheet\.command\.(undo|redo)$/,
  // Univer 的撤销/重做命令是 `univer.command.undo` / `univer.command.redo`（不是
  // `sheet.command.*`）。2026-10-11 漏拦它，Cmd+Z 走了**本地撤销**：画布上的值
  // 回去了，可一笔写请求都没发，文件里还是新值 —— 典型假成功（A21 就这么红的）。
  // 撤回必须走我们自己那条带幂等键 + 版本号的保存链，所以本地撤销一律拦死。
  /^univer\.command\.(undo|redo)$/,
  /^sheet\.command\.cut$/,
];

function isBlocked(id: string): boolean {
  return BLOCKED_COMMAND_PATTERNS.some((re) => re.test(id));
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value !== null && 'v' in value) return toText((value as { v: unknown }).v);
  return String(value);
}

/** 完整午夜 ISO 值在工作面省略时间；非零时间和其他文本保持原样。 */
function displayCellText(value: unknown, cellType?: string): string {
  const text = toText(value);
  return cellType === 'date' && /^\d{4}-\d{2}-\d{2}[T ]00:00:00(?:\.0+)?$/.test(text)
    ? text.slice(0, 10) : text;
}

// CellValueType：1=STRING 2=NUMBER 3=BOOLEAN 4=FORCE_STRING。
// 不标类型时 Univer 按 General 解析，"00123" 会变成数字 123，前导零就没了；
// 普通 STRING + @ 文本格式保留编号；FORCE_STRING 会在原生编辑器显示额外单引号。
const CELL_STRING = CellValueType.STRING;
const CELL_NUMBER = CellValueType.NUMBER;

/** 通过公开插件/渲染服务接Scene，不访问Univer私有injector或修改vendor。 */
class FlatIdleHeaderChromePlugin extends Plugin {
  static override pluginName='shangshu.flat-idle-header';
  static override packageName='shangshu-excel-univer';
  static override version='1.0.3';
  static override type=UniverInstanceType.UNIVER_SHEET;
  protected _injector:Injector;
  private readonly config:{color:string;report(diag:HeaderChromeDiag):void;ready?(render:IRender|null):void};
  constructor(config:{color:string;report(diag:HeaderChromeDiag):void;ready?(render:IRender|null):void},injector:Injector){super();this.config=config;this._injector=injector;}
  override onRendered(){
    const manager=this._injector.get(IRenderManagerService);
    const handles=new Map<string,{dispose():void}>();
    const attach=(render:IRender)=>{
      if(render.type!==UniverInstanceType.UNIVER_SHEET||handles.has(render.unitId)||render.isDisposed())return;
      const book=render.getRenderContext?.()?.unit as Workbook|undefined;
      handles.set(render.unitId,installFlatHeaderChrome(render.scene,()=>book?.getActiveSheet()?.getSnapshot().freeze,this.config.color,this.config.report));
      this.config.ready?.(render);
    };
    const created=manager.created$.subscribe(attach),disposed=manager.disposed$.subscribe(id=>{handles.get(id)?.dispose();handles.delete(id);this.config.ready?.(null);});
    manager.getRenderAll().forEach(attach);
    this.disposeWithMe({dispose(){created.unsubscribe();disposed.unsubscribe();handles.forEach(handle=>handle.dispose());handles.clear();}});
  }
}
Inject(Injector)(FlatIdleHeaderChromePlugin,undefined,1);

/**
 * **「按来源分颜色」那一份**（2026-10-30 用户 11:5x 口径：
 * 「agent 提出的对于表格的候选也走这个样式，只不过是绿底哈」）。
 *
 * ⚠️ **为什么只有一处**：这套颜色**有两处**要用 ——
 *   · `highlightCell`（拖动时高亮那一格）；
 *   · `markReviewCells`（审核链候选按来源各一组）。
 *   两处各写一遍 ⇒ 改一处漏一处 ⇒ 就会出现「描边是绿的、底色是白的」这种半截样子
 *   （那正是 2026-10-30 之前的样子：形状层 `fill:'transparent'` ＋ DOM 层白底 ⇒ **没有底色**）。
 *
 * **颜色口径**（与案号候选那套一致）：
 * · `automation`（代码/自动化提出）⇒ **蓝**（与案号候选同一个蓝）；
 * · `assistant`（**agent 提出**）⇒ **绿**；
 * · `unknown`（来源不明）⇒ **灰**。
 */
const REVIEW_SOURCE_COLORS = {
  automation: { stroke: '#3877d6', fill: 'rgba(56,119,214,0.12)' },
  assistant: { stroke: '#10B981', fill: 'rgba(16,185,129,0.12)' },
  unknown: { stroke: '#8b94a3', fill: 'rgba(139,148,163,0.10)' },
} as const;

type ReviewSourceKind = keyof typeof REVIEW_SOURCE_COLORS;

/** 来源名 → 那一档（不认识的一律当「来源不明」⇒ 灰，不许混进别的档）。 */
function reviewSourceKind(kind: unknown): ReviewSourceKind {
  return kind === 'automation' ? 'automation' : kind === 'assistant' ? 'assistant' : 'unknown';
}

export { REVIEW_SOURCE_COLORS };

export function createGrid(host: HTMLElement, columns: GridColumn[], rowCount: number, extraCol = 0): GridHandle {
  ensureUniverStyles();
  // Univer mounts a React root asynchronously. It must own only this inner node:
  // review/header overlays are siblings in host and must survive the first React commit.
  const renderHost=document.createElement('div');renderHost.className='excel-univer-mount';host.appendChild(renderHost);
  // 只设这次工作面的默认显示；不把样式写回文件，也不更改任何格子的值/数字格式。
  const tokens = getComputedStyle(host);
  const token = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback;
  const textColor = token('--fg2', '#374151');
  const fontFamily = token('--sans', '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif');
  let headerChrome:HeaderChromeDiag={status:'unavailable',matched:0,reason:'表头画布尚未就绪'};
  let publicRender:IRender|null=null;
  const layoutHandlers:Array<()=>void>=[];
  const layoutChanged=()=>layoutHandlers.forEach(handler=>handler());
  const theme = merge({}, defaultTheme, {
    primary: {
      ...defaultTheme.green,
      500: token('--green', '#10b981'),
      600: token('--green2', '#0ea372'),
      700: token('--green-ink', '#0a6e4c'),
    },
    gray: { 900: textColor },
  });
  const defaultStyle: IStyleData = {
    ff: fontFamily,
    // IStyleData.fs 的单位是 pt；引擎 ptToPixel 用 0.75 换算，9.75pt = 13 CSS px。
    fs: 9.75,
    cl: { rgb: textColor },
    vt: VerticalAlign.BOTTOM,
  };
  // extraCol：末尾多留的空白列数（Excel 式直接打字加列用）。
  const columnCount = Math.max(1, columns.length + extraCol);
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: merge({}, sheetsCoreZhCN) },
    theme,
    plugins:[[FlatIdleHeaderChromePlugin,{color:token('--line','#e5e7eb'),report:(diag:HeaderChromeDiag)=>{headerChrome=diag;},ready:(render:IRender|null)=>{publicRender=render;layoutChanged();}}]],
    presets: [
      UniverSheetsCorePreset({
        container: renderHost,
        header: false,
        toolbar: false,
        contextMenu: false, // Native menu exposes commands without a managed save path.
        formulaBar: false,
        footer: false,
        // 编号强制保留文本是产品要求，不能提示用户转数字（会丢前导零）。
        // 仅关闭官方的“数值按文本保存”提示；保存、权限和真正校验错误仍走原 toast。
        sheets: { disableForceStringAlert: true, disableForceStringMark: true },
        disableTextFormatAlert: true,
        disableTextFormatMark: true,
        // 不能设 disableAutoFocus：它会置 DISABLE_AUTO_FOCUS 上下文，
        // 单元格编辑器因此不接管键盘输入，敲进去的字会被静默丢掉。
      }),
    ],
  });

  const workbookId = 'workbook-b1';
  const sheetId = 'sheet-b1';
  // IWorkbookData 的 styles / sheetOrder / locale 是必填；工作表快照也要给全
  // rowData、columnData、rowHeader 等。缺了 sheetOrder，表进不了序列，
  // 渲染出来就是一格。
  univer.createUnit(univerAPI.Enum.UniverInstanceType.UNIVER_SHEET, {
    id: workbookId,
    name: '表',
    appVersion: '1.0.3',
    locale: LocaleType.ZH_CN,
    styles: {},
    defaultStyle,
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: '表',
        tabColor: '',
        hidden: 0,
        rowCount: Math.max(1, rowCount),
        columnCount,
        cellData: {},
        rowData: {},
        // Only uncreated extra columns: align editor parsing with the existing new-column text save contract.
        columnData: Object.fromEntries(Array.from({length:Math.max(0,extraCol)},(_,offset)=>[columns.length+offset,{s:{...defaultStyle,n:{pattern:'@'}}}])),
        mergeData: [],
        defaultStyle,
        zoomRatio: 1,
        scrollTop: 0,
        scrollLeft: 0,
        defaultColumnWidth: 88,
        defaultRowHeight: DEFAULT_ROW_HEIGHT,
        rowHeader: { width: 46, hidden: 0 },
        columnHeader: { height: 28, hidden: 0 },
        showGridlines: 1,
        rightToLeft: 0,
        freeze: { startRow: -1, startColumn: -1, xSplit: 0, ySplit: 0 },
      },
    },
  });

  /** rowIndex -> fieldId -> 原值；显示日期可以缩短，但编辑 before 不能被截断。 */
  const known = new Map<number, Map<string, string>>();
  const knownTypes = new Map<number, Map<string, string>>();
  const knownStyles = new Map<number,Map<string,CellFontStyle>>();
  const commitHandlers: Array<(e: CommitEvent) => void> = [];
  const selectionHandlers:Array<()=>void>=[];
  const blockedHandlers: Array<(id: string) => void> = [];
  const readOnlyHandlers: Array<(info: { rowIndex: number; colIndex: number; label: string }) => void> = [];
  const scrollHandlers: Array<() => void> = [];
  const widthHandlers: Array<(colIndex: number, widthPx: number) => void> = [];
  /** 上次已知的各列宽（像素），用来只报**变了**的那几列。 */
  const lastWidths = new Map<number, number>();
  /** 程序化更新标志：setRowValue/setRow 调 setValues 时不触发 commitHandlers */
  let isProgrammaticUpdate = false;
  /**
   * 程序在套用后端给的列宽时置位。
   * 不挡的话，`setColumnWidth()` 内部也会发 `set-worksheet-col-width`，
   * 于是**每次开表都会白写一笔列宽**、把内容版本顶上去——并发的人接着就被冲突拦住。
   */
  let applyingWidths = 0;
  let applyingPersonalView=false;
  let widthHeightTimer:ReturnType<typeof setTimeout>|null=null;
  const disposables: Array<{ dispose(): void }> = [];
  // 来源：8523d76f^ 的旧 sheet.ts（8523d76f 整份替换时丢失）。
  // General 格式的空格会在 CommandExecuted 前把 00123 解析成数字；必须在编辑器结束时
  // 捕获原文，提交 set-range-values 时按 FORCE_STRING 写回，前导零才不丢。
  /** 已开折行的列（记 fieldId，便于诊断口回报）。 */
  const wrapped = new Set<string>();
  /** 列表头实际设置的文字（字段名），给诊断口回报。 */
  let headerLabels: string[] = [];
  /**
   * **哪些列是受管列**（按**表头名**）—— 受管列的列头**变绿**（2026-10-29 用户口径）。
   * ⚠️ **为什么不用那个 svg 浮层**：浮层的位置是**算出来的** ⇒ 拖列/滚动/换表时就对不上
   *   ⇒ 用户看到「锁图案跟着鼠标走到别的位置」⇒ **列头样式画在画布上，跟着列走**。
   */
  let managedHeaderLabels = new Set<string>();
  /**
   * **哪些列是必填列**（按**表头名**）—— 那些列的列头**带必填标记**（2026-10-29 用户口径）。
   * ⚠️ **为什么单独记一份**：必填清单也是**异步**来的（`files.promotion_definition` 的
   *   `rules.required`）⇒ 常常**晚于**列头第一次设上 ⇒ 得能**再设一次**列头（标记才生效）。
   */
  let requiredHeaderLabels = new Set<string>();
  /**
   * **渲染层「形状」管理器**（2026-10-30 用户口径：「把所有特效放进这个里面，
   *   让速度更快，不用每次都计算一次」）。
   * ⚠️ **必填空的红底、审核标记、拖动高亮**都走它 ⇒
   *   **成批画**（一次重画）、**没变就不动**（不重算）。
   */
  //   ⚠️ **惰性取**：`worksheet` 在下面才声明 ⇒ 这里不能直接把它求值。
  const shapeLayer = createShapeLayer({worksheet: () => worksheet()});
  /**
   * **当前标记着的那几格**（key → 那一格）。
   * ⚠️ **规则送来的只是「增量」**（加了几格、撤了几格）⇒ 这里**攒起来**，
   *   画的时候按**看得见的那一窗**取（外面那些先不画 ⇒ 形状总数有界）。
   */
  const requiredEmptyCells = new Map<string,{rowIndex:number;fieldId:string}>();
  let requiredEmptyPaintTimer:ReturnType<typeof setTimeout>|null=null;
  /**
   * 一次最多画多少格（**只管超大表**）。
   * ⚠️ **为什么要有上限**：Univer 每加一个形状都要把**全部形状**重算一遍
   *   ⇒ 形状越多、每次重画越贵 ⇒ **形状总数必须有界**。
   */
  const REQUIRED_EMPTY_MAX_CELLS = 1500;
  /** 可见行上下各留多少行（**翻页后前面页的框还在** ⇒ 窗口要比一页（100 行）大）。 */
  const REQUIRED_EMPTY_WINDOW_ROWS = 200;
  /**
   * 窗口**按块对齐**（每 100 行一块）。
   * ⚠️ **为什么**：不按块的话，**每滚一行**窗口边界就变 ⇒ 整批红底重画一次
   *   ⇒ 一次滚动几十次重画 ⇒ **卡**。按块对齐 ⇒ **滚一小段不重画**。
   */
  const REQUIRED_EMPTY_BLOCK_ROWS = 100;
  function requiredMarkKey(item:{rowIndex:number;fieldId:string}){
    return `${item.rowIndex}\u0000${item.fieldId}`;
  }
  function scheduleRequiredEmptyPaint(){
    if(requiredEmptyPaintTimer!==null)return;
    const idle=(globalThis as any).requestIdleCallback;
    const run=()=>{ requiredEmptyPaintTimer=null; paintRequiredEmptyMarks(); };
    if(typeof idle==='function'){ requiredEmptyPaintTimer=idle(run,{timeout:200}); return; }
    requiredEmptyPaintTimer=setTimeout(run,16);
  }
  /**
   * **把「空的必填格」画上去**（**增量**）。
   *
   * ⚠️ **三件事必须同时成立**：
   * ① **不清空已有的**（除非那一格已经不需要了）⇒ **翻页/滚动不丢前面页的框**；
   * ② **没变化就不重画**（滚动时清单没变 ⇒ 一次重画都不做 ⇒ 不卡）；
   * ③ **成批画**（Univer 的 `highlight` **一格一次重画**、一格约 70ms；
   *    批量口 `highlightRanges` **一次重画画一整批**）⇒ 几十格也是一次重画。
   *
   * ⚠️ **为什么这一步不许挡住「打开到能编辑」**：
   *   画框是**提醒**（锦上添花）⇒ 一律**空闲时**画，且**只画看得见的那一窗**。
   */
  function paintRequiredEmptyMarks(){
    try{
      const ws=worksheet();
      if(!ws)return;              // 网格已销毁 ⇒ 什么都不用画
      const visible=ws.getVisibleRange?.();
      const first=visible?Math.max(0,Number(visible.startRow??0)):0;
      const last=visible?Number(visible.endRow??first):first;
      // —— **窗口按块对齐**（滚一小段 ⇒ 窗口不变 ⇒ **不重画**）——
      const blockFirst=Math.floor(first/REQUIRED_EMPTY_BLOCK_ROWS)*REQUIRED_EMPTY_BLOCK_ROWS;
      const blockLast=Math.ceil((last+1)/REQUIRED_EMPTY_BLOCK_ROWS)*REQUIRED_EMPTY_BLOCK_ROWS-1;
      const windowStart=Math.max(0,blockFirst-REQUIRED_EMPTY_WINDOW_ROWS);
      const windowEnd=blockLast+REQUIRED_EMPTY_WINDOW_ROWS;
      // —— **要画哪些**：可见行上下各留一窗（**翻页后前面页的框还在**）——
      const window:Array<{rowIndex:number;fieldId:string}>=[];
      for(const item of requiredEmptyCells.values()){
        if(item.rowIndex>=windowStart&&item.rowIndex<=windowEnd)window.push(item);
      }
      // —— 超大表才裁到「只看得到的那些行」（正常表全部都画）——
      const target=window.length>REQUIRED_EMPTY_MAX_CELLS
        ? window.filter(item=>item.rowIndex>=first&&item.rowIndex<=last)
        : window;
      const paintable:Array<{key:string;range:any}>=[];
      for(const item of target){
        const col=columns.findIndex((c)=>c.fieldId===item.fieldId);
        if(col<0)continue;
        const range=ws.getRange(item.rowIndex,col,1,1);
        if(!range)continue;
        paintable.push({key:requiredMarkKey(item),range});
      }
      // —— **交给形状层**：内容没变 ⇒ 一个形状都不动；变了 ⇒ **一次**重画 ——
      shapeLayer.setGroup('required-empty',REQUIRED_EMPTY_HIGHLIGHT,paintable);
    }catch{ /* 画不上就拉倒（不许把人锁住）。 */ }
  }
  /**
   * **拖动时那格的高亮**：**一帧最多重画一次**。
   * ⚠️ **为什么**：Univer 每加一个形状都要把**全部形状**重算一遍 ⇒
   *   拖动时每个鼠标移动都重画 ⇒ 一次拖动几十次全量重算 ⇒ **拖起来卡**。
   */
  const applyDropHighlight=frameThrottle((pending:{key:string;range:any;style:any})=>{
    try{ shapeLayer.setGroup('drop',pending.style,[{key:pending.key,range:pending.range}]); }
    catch{ /* 画不上就拉倒。 */ }
  });
  function scheduleDropHighlight(pending:{key:string;range:any;style:any}){
    applyDropHighlight(pending);
  }
  function cancelDropHighlight(){
    try{ shapeLayer.dropGroup('drop'); }catch{ /* 忽略。 */ }
  }
  /** 设表头时抛出的真因；空串 = 没抛。不许静默吞。 */
  let headerLabelError = '';

  // 只重算实际装填过的行。对整张表设置样式/自动行高会把空白格物化，
  // 大表每翻一页都重复几十万格命令，堵住浏览器主线程。
  const appliedHeights=new Map<number,number>();
  const manualHeights=new Map<number,number>();
  const rowHeightHandlers:Array<(heights:Record<number,number>,before:Record<number,number>)=>void>=[];
  let applyingHeights=0;
  function recalcLoadedHeights(startRow?: number, count?: number) {
    const ws = worksheet();
    if (!ws) return;
    const visible = startRow === undefined ? ws.getVisibleRange?.() : undefined;
    const first = startRow ?? (visible ? Math.max(0, Number(visible.startRow) - 100) : 0);
    const last = count !== undefined ? first + count - 1
      : visible ? Number(visible.endRow) + 100 : Math.max(0, ...known.keys());
    const rows = [...known.keys()].filter(r => r >= first && r <= last).sort((a, b) => a - b);
    if (!rows.length) return;
    // skeleton 尚未ready时官方autoHeight只设置ia而不生成ah，最终仍回落24px。
    // 用浏览器真实13px字形测量，写入h/ia=0；仅加载范围，不对空白表重算。
    const painter = document.createElement('canvas').getContext('2d');
    if (!painter) return;
    painter.font = `13px ${fontFamily}`;
    const widthCache = new Map<string, number>();
    const widthOf = (text: string) => {
      const key=painter.font+'\0'+text;
      let width = widthCache.get(key);
      if (width === undefined) { width = painter.measureText(text).width; widthCache.set(key, width); }
      return width;
    };
    const widths = columns.map((_, index) => {
      try { return ws.getColumnWidth(index) || 88; } catch { return 88; }
    });
    const lineCount = (text: string, available: number) => {
      let count = 0;
      for (const paragraph of text.replace(/\r\n|\r/g, '\n').split('\n')) {
        count += 1;
        let used = 0;
        // 英文词保持在同一行，超长编号逐字折；中文按实际字宽折。
        for (const token of paragraph.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/gu) || []) {
          const tokenWidth = widthOf(token);
          if (tokenWidth <= available) {
            if (used && used + tokenWidth > available) { count++; used = 0; }
            used += tokenWidth;
          } else {
            for (const glyph of token) {
              const glyphWidth = widthOf(glyph);
              if (used && used + glyphWidth > available) { count++; used = 0; }
              used += glyphWidth;
            }
          }
        }
      }
      return count;
    };
    let groupStart = -1, groupEnd = -1, groupHeight = 0;
    const flush = () => {
      if (groupStart >= 0) {
        ws.setRowHeightsForced(groupStart, groupEnd - groupStart + 1, groupHeight);
        for(let row=groupStart;row<=groupEnd;row++)appliedHeights.set(row,groupHeight);
      }
    };
    for (const row of rows) {
      if(manualHeights.has(row)){flush();groupStart=groupEnd=-1;continue;}
      let height = DEFAULT_ROW_HEIGHT;
      const values = known.get(row)!;
      columns.forEach((column, index) => {
        const font=knownStyles.get(row)?.get(column.fieldId);
        const pixels=(font?.font_size??9.75)/0.75;
        painter.font=`${font?.bold?'600 ':''}${pixels}px ${fontFamily}`;
        const text = displayCellText(values.get(column.fieldId), knownTypes.get(row)?.get(column.fieldId));
        const lines=(font?.wrap_text??wrapped.has(column.fieldId))?lineCount(text,Math.max(1,widths[index]-20)):text.split(/\r\n|\r|\n/).length;
        height=Math.max(height,lines*Math.max(20,pixels*1.4)+4);
      });
      if((appliedHeights.get(row)??DEFAULT_ROW_HEIGHT)===height){flush();groupStart=groupEnd=-1;continue;}
      if (groupStart >= 0 && row === groupEnd + 1 && groupHeight === height) groupEnd = row;
      else { flush(); groupStart = groupEnd = row; groupHeight = height; }
    }
    flush();
  }

  /**
   * **恢复自动行高**（2026-10-29 用户口径：「再点一次自动行高」——
   * 人手动拖高过的行，应该能**再点一次恢复自动行高**）。
   *
   * ⚠️ **为什么要有这条回头路**：手拖过行高 ⇒ 那一行进 `manualHeights`
   *   ⇒ 自动行高**再也不接管它**（冲突时手动赢，这条规矩是对的）⇒
   *   而原来**没有任何地方**把 `manualHeights` 里的行拿掉 ⇒ **拖高了就回不去**。
   *
   * ⚠️ **纯画布，不发请求**：这里只把画布与那本「谁说了算」的账改回来；
   *   **持久化**（写回文件 ⇒ 全表共享）由上层另走 `files.sheet_row_heights_write`。
   */
  function resetAutoRowHeights(rows: number[]): void {
    const targets = (rows || []).filter((row) => Number.isInteger(row) && row >= 0 && row < rowCount);
    if (!targets.length) return;
    for (const row of targets) {
      manualHeights.delete(row);   // 自动行高重新接管这一行
      appliedHeights.delete(row);  // 别拿旧的手动高当「这一行已经算过」
    }
    const ws = worksheet();
    // 先把 Univer 那边的**强制高**撤掉（交回自动行高）……
    for (const row of targets) {
      try { ws?.setRowAutoHeight(row, 1); } catch { /* 取不到就跳过（重算那步还会再试一次） */ }
    }
    // ……再按内容算一次（**我们自己量算的那套** ⇒ 与平时的自动行高同一口径）。
    const first = Math.min(...targets);
    const last = Math.max(...targets);
    recalcLoadedHeights(first, last - first + 1);
    layoutChanged();
  }

  function cellFor(raw: string | number | null | undefined, column: GridColumn, cellType?: string,font?:CellFontStyle) {
    const style: Record<string, unknown> = {...defaultStyle,...fontStyleToUniver(font)};
    if (font?.wrap_text===undefined&&wrapped.has(column.fieldId)) style.tb = WRAP_VALUE;
    // 混合列里文本编号仍然是文本。整列的主类型不能强制 Number('00123')。
    if (typeof raw === 'number') return { v: raw, t: CELL_NUMBER, s: style };
    // Date values stay canonical in the adapter/cache; only the engine cell uses Excel serials.
    if((cellType??column.type)==='date'&&typeof raw==='string'){
      const match=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
      if(match){const stamp=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4]||0),Number(match[5]||0),Number(match[6]||0));
        if(Number.isFinite(stamp)){style.n={pattern:font?.number_format&&font.number_format!=='General'?font.number_format:(Number(match[4]||0)||Number(match[5]||0)||Number(match[6]||0)?'yyyy-mm-dd hh:mm:ss':'yyyy-mm-dd')};return {v:(stamp-Date.UTC(1899,11,30))/86400000,t:CELL_NUMBER,s:style};}}
    }
    style.n = { pattern: '@' };
    return { v: displayCellText(raw, cellType), t: CELL_STRING, s: style };
  }
  // General-format empty cells may parse identifiers before CommandExecuted.
  // Capture the public editor's raw text before that conversion; formatting a
  // virtual column alone does not preserve 00123/long IDs in native typing.
  const formulas=new Map<number,Map<string,string>>();
  let formulaEditor:HTMLInputElement|null=null;
  let formulaHint:HTMLDivElement|null=null;
  let cancelFormulaEditor:(()=>void)|null=null;
  function endFormulaEditor(){cancelFormulaEditor?.();cancelFormulaEditor=null;formulaEditor?.remove();formulaEditor=null;formulaHint?.remove();formulaHint=null;}
  disposables.push({dispose:endFormulaEditor});
  function editFormula(row:number,col:number,formula:string,seed?:string){
    endFormulaEditor();const column=columns[col],rect=reviewFrame()?.rect(row,col);if(!rect||!column)return;
    const input=host.ownerDocument.createElement('input');formulaEditor=input;
    /* 初值：已有公式原样显示；空表预填 "="（快捷键把 "=" 吃掉了，不预填用户写的公式就少了开头）。 */
    input.value=formula||seed||'';
    input.setAttribute('aria-label','编辑公式');input.dataset.formulaEditor='true';
    Object.assign(input.style,{position:'absolute',left:rect.left+'px',top:rect.top+'px',width:Math.max(240,rect.width)+'px',height:Math.max(28,rect.height)+'px',zIndex:'100',background:'#fff',border:'2px solid #10b981',font:'14px monospace',boxSizing:'border-box'});
    /* FIX-15（A14）：公式编辑态能像 Excel 一样**用鼠标框范围**。
       在表格上按住拖选 → 把 A2:B10 这样的引用插到光标处；
       编辑期间**不切格、不提交**（区分「编辑公式」与「普通切格」）。
       地址口径与后端公式引擎同一把尺子（表头占第 1 行 → 首个数据行是第 2 行）。 */
    const hint=host.ownerDocument.createElement('div');formulaHint=hint;hint.dataset.formulaRangeHint='true';
    Object.assign(hint.style,{position:'absolute',left:rect.left+'px',top:(rect.top+Math.max(28,rect.height))+'px',zIndex:'100',background:'#0f172a',color:'#fff',font:'12px/1.6 system-ui,sans-serif',padding:'4px 8px',borderRadius:'4px',pointerEvents:'none',whiteSpace:'nowrap'});
    hint.textContent=formulaRangeHint();
    host.append(input);host.append(hint);input.focus();input.setSelectionRange(input.value.length,input.value.length);
    let done=false;
    let anchor:CellPoint|null=null,focusCell:CellPoint|null=null,cache:Array<CellPoint&{rect:CellRect}>=[];
    const buildCache=():Array<CellPoint&{rect:CellRect}>=>{
      const frame=reviewFrame();if(!frame)return [];
      const cells:Array<CellPoint&{rect:CellRect}>=[];
      /* 只算可见范围，且封顶 —— 每格一次取位，拖动时不能整表扫。 */
      const lastRow=Math.min(frame.visible.endRow,frame.visible.startRow+400);
      const lastCol=Math.min(frame.visible.endCol,frame.visible.startCol+60);
      for(let r=frame.visible.startRow;r<=lastRow;r++)for(let c=frame.visible.startCol;c<=lastCol;c++){
        const cellRect=frame.rect(r,c);if(cellRect)cells.push({row:r,col:c,rect:cellRect});
      }
      return cells;
    };
    const pointAt=(event:{clientX:number;clientY:number})=>{
      const box=host.getBoundingClientRect();
      return hitCell(cache,event.clientX-box.left,event.clientY-box.top);
    };
    const onDown=(event:Event)=>{
      const pointer=event as PointerEvent;
      if(pointer.target===input)return;
      cache=buildCache();
      const cell=pointAt(pointer);if(!cell)return;
      /* 编辑公式时点表格：插入引用，**不切格、不提交**。 */
      event.preventDefault();event.stopPropagation();
      anchor=cell;focusCell=cell;
      hint.textContent=rangeAddress(anchor,focusCell);
      input.focus();
    };
    const onMove=(event:Event)=>{
      if(!anchor)return;
      const cell=pointAt(event as PointerEvent);if(!cell)return;
      focusCell=cell;hint.textContent=rangeAddress(anchor,focusCell);
    };
    const onUp=(event:Event)=>{
      if(!anchor||!focusCell)return;
      event.preventDefault();event.stopPropagation();
      const address=rangeAddress(anchor,focusCell);
      const caret=input.selectionStart??input.value.length;
      /* FIX-15 第五批：框第二次时**替换**光标处那个引用（Excel 的做法）。
         原来是无脑往后插，框两次就拼成 =SUM(B2:B3B2:B4) —— 公式直接存不进去。 */
      const next=replaceReferenceAtCaret(input.value,caret,address);
      input.value=next.text;input.focus();input.setSelectionRange(next.caret,next.caret);
      hint.textContent=formulaRangeHint();
      anchor=null;focusCell=null;
    };
    host.addEventListener('pointerdown',onDown,true);
    host.addEventListener('pointermove',onMove,true);
    host.addEventListener('pointerup',onUp,true);
    const finish=(save:boolean)=>{
      if(done)return;done=true;
      host.removeEventListener('pointerdown',onDown,true);
      host.removeEventListener('pointermove',onMove,true);
      host.removeEventListener('pointerup',onUp,true);
      const value=input.value;endFormulaEditor();
      if(save&&value!==formula)commitHandlers.forEach(fn=>fn({rowIndex:row,colIndex:col,fieldId:column.fieldId,value,before:formula,type:column.type}));
    };
    cancelFormulaEditor=()=>{done=true;};
    input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();finish(true);}else if(event.key==='Escape'){event.preventDefault();finish(false);}});
    input.addEventListener('blur',()=>finish(true));
  }
  let identifierEdit:{row:number;column:number;text:string}|null=null;
  disposables.push(
    univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart,event=>{
      const editRect=reviewFrame()?.rect(event.row,event.column);
      if(editRect)host.style.setProperty("--excel-cell-editor-width",editRect.width+"px");
      else host.style.removeProperty("--excel-cell-editor-width");
      identifierEdit=null;
      const column=columns[event.column];
      const formula=column&&formulas.get(event.row)?.get(column.fieldId);
      if(formula){event.cancel=true;if(!column.readOnly)editFormula(event.row,event.column,formula);return;}
      // ⚠️ **2026-10-27（PKG-126-T04／T05）**：**布尔列给三态选择件、日期列给日历**。
      // · 布尔：人分不出「未填」和「否」，写「是」还会被服务端拒 ⇒ 给**未填／是／否**三态；
      // · 日期：示例企业总表里 6 个受管日期列（申请日／发文日期／发案日期／导入年费监控列表／初稿日期／定稿日期）
      //   原来只能手打 ⇒ 给**日历**（外加一个自己写日期的框，记得住确切日期时直接敲更快）。
      // ⚠️ **拿得到那一格的位置才接管** —— 拿不到就照旧给原生编辑器（不能把人锁在这一格改不了）。
      if(column&&!column.readOnly&&(column.type==='boolean'||column.type==='date')){
        const rect=reviewFrame()?.rect(event.row,event.column);
        if(rect){
          event.cancel=true;
          const hostRect=host.getBoundingClientRect();
          const anchor={left:rect.left+hostRect.left,top:rect.top+hostRect.top,width:rect.width,height:rect.height};
          const current=known.get(event.row)?.get(column.fieldId)??'';
          if(column.type==='boolean'){
            openTriState(host,{anchor,current,onPick:value=>commitCellValue(event.row,event.column,column,value)});
          }else{
            openDatePicker(host,{anchor,current,onPick:value=>commitCellValue(event.row,event.column,column,value)});
          }
        }
        return;
      }
      // ★ 这一列**有取值清单** ⇒ 不给原生编辑器，改成自绘下拉（选项多时带搜索框）。
      // ⚠️ **拿得到那一格的位置才接管** —— 拿不到就照旧给原生编辑器，
      // 不能把人锁在这一格改不了。
      if(column&&!column.readOnly&&column.options&&column.options.length){
        const rect=reviewFrame()?.rect(event.row,event.column);
        if(rect){
          event.cancel=true;
          const hostRect=host.getBoundingClientRect();
          openValueDropdown(host,{
            options:column.options,
            // —— **显示名**（码 ⇒ 中文名；2026-10-29 用户口径）——
            optionLabels:column.optionLabels,
            allowCustom:column.allowCustom!==false,
            customLabel:column.customLabel,
            current:known.get(event.row)?.get(column.fieldId)??'',
            // `reviewFrame` 给的是**宿主坐标**；浮层用 fixed 定位 ⇒ 要换成视口坐标。
            anchor:{left:rect.left+hostRect.left,top:rect.top+hostRect.top,width:rect.width,height:rect.height},
            onPick:value=>commitCellValue(event.row,event.column,column,value),
          });
        }
      }
    }),
    univerAPI.addEvent(univerAPI.Event.BeforeSheetEditEnd,(event)=>{
      identifierEdit=null;
      if(!event.isConfirm||event.workbook.id!==workbookId||event.worksheet.getSheetId()!==sheetId)return;
      const type=columns[event.column]?.type??'text';
      if(type==='integer'||type==='decimal')return;
      const text=event.value.toPlainText();
      if(type==='date'||/^(?:0\d+|[+-]?\d{16,})$/.test(text))identifierEdit={row:event.row,column:event.column,text};
    }),
  );

  /**
   * 写一格的值（**走同一条提交链**）。
   *
   * 顺序有讲究：`known` **先**记成新值 ⇒ 随后画布那次 `setValue` 触发的命令处理
   * 读到 `before === next` ⇒ **不会重复提交**（否则一笔保存发两次）。
   *
   * 画布没改成功也照样提交（重开以服务端为准）—— 跟清空那条路同一个口径。
   */
  function commitCellValue(row: number, col: number, column: GridColumn, next: string): void {
    const before = known.get(row)?.get(column.fieldId) ?? '';
    if (before === next) return;
    const map = known.get(row) ?? new Map<string, string>();
    map.set(column.fieldId, next);
    known.set(row, map);
    recentCommits.push({rowIndex: row, fieldId: column.fieldId, before, next});
    if (recentCommits.length > 5) recentCommits.shift();
    try {
      worksheet()?.getRange(row, col, 1, 1).setValue(next);
    } catch { /* 画布没改成功也照样提交 */ }
    commitHandlers.forEach((fn) => fn({
      rowIndex: row, colIndex: col, fieldId: column.fieldId, value: next, before, type: column.type,
    }));
    recalcLoadedHeights(row, 1);
  }
  /** 设表头还在重试中的次数（渲染单元未就绪）；0 = 不在等。 */
  let headerLabelPending = 0;
  /** 传给 customizeColumnHeader 的 cfg 原样。 */
  let headerCfgSent: Record<number, string> | null = null;
  /** 最近几笔单格提交的 before/after 流水，给测试核 before 有没有过期。 */
  const recentCommits: Array<{ rowIndex: number; fieldId: string; before: string; next: string }> = [];
  /** 当前命中标记，移动前必须先摘掉。 */
  let highlightAt: { rowIndex: number; colIndex: number } | null = null;
  let cellEditing=false;
  for(const eventName of ['SheetEditStarted','SheetEditChanging','SheetEditEnded'] as const){
    disposables.push(univerAPI.addEvent(univerAPI.Event[eventName],(event:any)=>{
      if(event.workbook?.getId()===workbookId)cellEditing=eventName!=='SheetEditEnded';
    }));
  }

  // 不用 getActiveWorkbook()：本页关掉了自动聚焦，工作簿未必是「活动」那一个，
  // 取出来是 null，写格子会被静默丢掉——界面上却还显示「已加载 N 行」。
  // 按 ID 取是确定的，与焦点无关。
  const worksheet = () => univerAPI.getWorkbook(workbookId)?.getSheetBySheetId(sheetId) ?? null;
  const activeCellPosition=()=>{
    try{const range=worksheet()?.getActiveCell()?.getRange();if(range)return {rowIndex:Number(range.startRow),colIndex:Number(range.startColumn)};}catch{/* 初始画布可先有轮廓，primary活动格稍后才建立。 */}
    return null;
  };
  function reviewFrame():CandidateOverlayFrame|null{
    try{
      const ws=worksheet(),render=publicRender;if(!ws||!render||render.isDisposed())return null;
      const viewport=render.scene.getMainViewport(),visible=ws.getVisibleRange();if(!viewport||!visible)return null;
      const bounds=viewport.calcViewportInfo().viewPortPosition,canvas=render.engine.getCanvasElement().getBoundingClientRect(),hostRect=host.getBoundingClientRect();
      if(!canvas.width||!canvas.height||!render.engine.width||!render.engine.height)return null;
      const sx=canvas.width/render.engine.width,sy=canvas.height/render.engine.height,ox=canvas.left-hostRect.left,oy=canvas.top-hostRect.top;
      const clip={left:ox+bounds.left*sx,top:oy+bounds.top*sy,width:(bounds.right-bounds.left)*sx,height:(bounds.bottom-bounds.top)*sy};
      if(clip.width<=0||clip.height<=0)return null;
      return {clip,visible:{startRow:visible.startRow,endRow:visible.endRow,startCol:visible.startColumn,endCol:visible.endColumn},rect(row,col){
        const cell=ws.getRange(row,col,1,1).getCell();if(!cell)return null;
        const start=viewport.getAbsoluteVector(new Vector2(cell.startX,cell.startY)),end=viewport.getAbsoluteVector(new Vector2(cell.endX,cell.endY));
        return {left:ox+start.x*sx,top:oy+start.y*sy,width:(end.x-start.x)*sx,height:(end.y-start.y)*sy};
      }};
    }catch{return null;}
  }
  function applyFontStyles(cells:Array<{rowIndex:number;fieldId:string;style:CellFontStyle}>){
    const ws=worksheet();if(!ws)throw Error('表格尚未就绪');
    const matrix:Record<number,Record<number,{s:Record<string,unknown>}>>={};
    for(const cell of cells){const col=columns.findIndex(c=>c.fieldId===cell.fieldId);if(col<0||!known.has(cell.rowIndex))throw Error('格式目标尚未加载');(matrix[cell.rowIndex]??={})[col]={s:fontStyleToUniver(cell.style)};}
    if(!cells.length)return;
    isProgrammaticUpdate=true;
    try{ws.getRange(0,0,1,1).setValues(matrix);}finally{isProgrammaticUpdate=false;}
    for(const cell of cells){const styles=knownStyles.get(cell.rowIndex)??new Map<string,CellFontStyle>();styles.set(cell.fieldId,{...cell.style});knownStyles.set(cell.rowIndex,styles);}
  }

  /**
   * 公共选区模块（fast 侧 selection.ts）算出来的范围。
   * **取不到就回 null，不许把异常带出去** —— 取不到时由调用方走 ours 的直读兜底，
   * 不能因为公共模块这一下就把直读也跳过（那样选区会整个读不出来）。
   */
  function sharedSelectionRange():{startRow:number;endRow:number;startCol:number;endCol:number}|null{
    try { return selectionRange(worksheet()?.getSelection()); } catch { return null; }
  }

  /**
   * 当前选区（起止行列，已归一成 start ≤ end）。取不到回 null。
   *
   * 合并说明：fast 那边把「从 Univer facade 选区对象取范围」抽成了公共模块
   * `selection.ts`（selectionRange(selection)）；ours 这边原本在本地闭包里写了一份。
   * 两条都留：公共模块优先（fast 那份更严 —— 多选区或取不到就回 null，绝不默认 A1），
   * ours 这份留作兜底（读不到 Univer 对象时的宽松读法）。
   */
  function fallbackSelectionRange() {
    const shared = sharedSelectionRange();
    if (shared) return shared;
    try {
      const ws = worksheet();
      const raw = ws?.getSelection();
      const selections = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Record<string, unknown>>;
      const sel = selections[0];
      if (!sel) return null;
      const nested = sel.range as Record<string, number> | undefined;
      const sr = Number(sel.startRow ?? nested?.startRow ?? 0);
      const sc = Number(sel.startColumn ?? nested?.startColumn ?? 0);
      const er = Number(sel.endRow ?? nested?.endRow ?? sr);
      const ec = Number(sel.endColumn ?? nested?.endColumn ?? sc);
      return { startRow: Math.min(sr, er), startCol: Math.min(sc, ec),
               endRow: Math.max(sr, er), endCol: Math.max(sc, ec) };
    } catch { /* 取不到回 null */ }
    return null;
  }

  disposables.push(
    univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event: any) => {
      const id = String(event?.id || '');
      if (!id) return;
      if(applyingPersonalView&&/^sheet\.command\.(set|cancel)-.*frozen/.test(id))return;
      // Engine synthesizes header double-click from pointerup before DOM dblclick.
      // Renaming owns that gesture. Never let a native auto-width write race the captured version.
      if(id==='sheet.command.set-col-auto-width'){event.cancel=true;return;}
      if (id === ALLOWED_VALUE_COMMAND) {
        // set-range-values 同时承载值与样式；本批只接值。
        // 样式就地剥掉，不整条取消——整条取消会把正常的单元格写入一起丢掉
        // （编辑器提交时会带上原样式），而格式化命令本身已被下面的黑名单拦住。
        const params = event?.params || {};
        const range=params.range;
        const formula=typeof params.value?.f==='string'?params.value.f:typeof params.value==='string'&&params.value.startsWith('=')?params.value:typeof params.value?.v==='string'&&params.value.v.startsWith('=')?params.value.v:null;
        if(!isProgrammaticUpdate&&formula&&range&&range.startRow===(range.endRow??range.startRow)&&range.startColumn===(range.endColumn??range.startColumn)){
          event.cancel=true;const row=range.startRow,col=range.startColumn,column=columns[col]??{fieldId:`__extra_${col}`,label:'',type:'text',readOnly:false};
          if(column&&!column.readOnly)commitHandlers.forEach(fn=>fn({rowIndex:row,colIndex:col,fieldId:column.fieldId,value:formula,before:formulas.get(row)?.get(column.fieldId)??known.get(row)?.get(column.fieldId)??'',type:column.type}));
          return;
        }
        if(!isProgrammaticUpdate&&identifierEdit&&range?.startRow===identifierEdit.row&&(range.endRow??range.startRow)===identifierEdit.row
            &&range?.startColumn===identifierEdit.column&&(range.endColumn??range.startColumn)===identifierEdit.column){
          const cell=typeof params.value==='object'&&params.value!==null?params.value:{};
          params.value={...cell,v:identifierEdit.text,t:CELL_STRING,p:null};
          identifierEdit=null;
        }
        if (params.style !== undefined || params.styles !== undefined) {
          delete params.style;
          delete params.styles;
          blockedHandlers.forEach((fn) => fn(id + '#style'));
        }
        return;
      }
      if (id === CLEAR_CONTENT_COMMAND) {
        // Delete/Backspace 清空：Univer 原生命令直接改内存、**不走保存链**（实测清完重开还是旧值）。
        // 一律拦下，单格翻译成一笔「写空值」的提交；多格本批没有批量写口，如实提示而不是无声吞掉。
        event.cancel = true;
        const params = event?.params || {};
        const ranges = Array.isArray(params.ranges) ? params.ranges : null;
        // 选区要取「带 primary 的那一个」（getActiveRange），不能取 selections[0]：
        // 后者可能是上一次的旧选区 —— 实测清空写到了上一格（A2），本格没动。
        let range: { startRow: number; startCol: number; endRow: number; endCol: number } | null = null;
        if (ranges && ranges.length === 1) {
          range = {
            startRow: Number(ranges[0].startRow ?? 0),
            startCol: Number(ranges[0].startColumn ?? 0),
            endRow: Number(ranges[0].endRow ?? ranges[0].startRow ?? 0),
            endCol: Number(ranges[0].endColumn ?? ranges[0].startColumn ?? 0),
          };
        } else if (!ranges || ranges.length === 0) {
          try {
            const active = worksheet()?.getActiveRange?.();
            const r = active?.getRange?.();
            if (r) {
              const sr = Number(r.startRow ?? 0);
              const sc = Number(r.startColumn ?? 0);
              const er = Number(r.endRow ?? sr);
              const ec = Number(r.endColumn ?? sc);
              range = { startRow: Math.min(sr, er), startCol: Math.min(sc, ec),
                        endRow: Math.max(sr, er), endCol: Math.max(sc, ec) };
            }
          } catch { /* 取不到退回 fallbackSelectionRange */ }
          if (!range) range = fallbackSelectionRange();
        }
        const single = range && range.startRow === range.endRow && range.startCol === range.endCol;
        if (single) {
          const rowIndex = range!.startRow;
          const colIndex = range!.startCol;
          const column = columns[colIndex];
          if (column?.readOnly) {
            readOnlyHandlers.forEach((fn) => fn({
              rowIndex, colIndex, label: column.label || column.fieldId,
            }));
            return;
          }
          if (column) {
            const before = known.get(rowIndex)?.get(column.fieldId) ?? '';
            // 先把 known 记成空，再动画布：setValue 内部会发 set-range-values，
            // 让 commit 监听看到 before === next 而不重复提交（真正的提交由下面这一笔发）。
            const map = known.get(rowIndex) ?? new Map<string, string>();
            map.set(column.fieldId, '');
            known.set(rowIndex, map);
            recentCommits.push({ rowIndex, fieldId: column.fieldId, before, next: '' });
            if (recentCommits.length > 5) recentCommits.shift();
            // 延后一拍再动画布：此刻还在 BeforeCommandExecute 里，同步发命令可能被命令服务拒掉。
            // known 已先记成空，deferred setValue 触发的 commit 看到 before === next，不会重复提交。
            setTimeout(() => {
              try {
                // setValue('') 而不是 null：Univer 类型不接受 null；对显示都是清空。
                worksheet()?.getRange(rowIndex, colIndex, 1, 1).setValue('');
              } catch { /* 画布清空失败也照样提交，重开以服务端为准 */ }
            }, 0);
            if (before === '' || isProgrammaticUpdate) return;
            commitHandlers.forEach((fn) => fn({
              rowIndex, colIndex, fieldId: column.fieldId, value: '', before, type: column.type,
            }));
          }
          return;
        }
        blockedHandlers.forEach((fn) => fn(CLEAR_CONTENT_COMMAND + '#multi'));
        return;
      }
      if (isBlocked(id)) {
        event.cancel = true;
        blockedHandlers.forEach((fn) => fn(id));
      }
    }),
  );

  // 来源：8523d76f^ 的旧 sheet.ts。只移植原文捕获，不搬旧版的 editAnchor。
  // 文本列（含空/普通字符串列）在编辑器确认时记下原文；数值/日期列不拦。
  disposables.push(
    univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, () => { identifierEdit = null; }),
    univerAPI.addEvent(univerAPI.Event.BeforeSheetEditEnd, (event: any) => {
      identifierEdit = null;
      if (!event?.isConfirm
          || event.workbook?.id !== workbookId
          || event.worksheet?.getSheetId() !== sheetId) return;
      const type = columns[event.column]?.type ?? 'text';
      if (type === 'integer' || type === 'decimal') return;
      const text = event.value?.toPlainText?.() ?? '';
      // 前导零编号与 16 位以上长号：General 会把它们解析成数字，必须按原文写回。
      if (type === 'date' || /^(?:0\d+|[+-]?\d{16,})$/.test(text)) {
        identifierEdit = { row: event.row, column: event.column, text };
      }
    }),
  );

  // Pointing elsewhere commits through Univer's native end-edit operation,
  // before the pointer changes the active cell. No custom editor or reverse write.
  const endEditOnPointerDown=(event:MouseEvent)=>{
    const active=document.activeElement;
    if(!(active instanceof HTMLElement)||!host.contains(active)||!active.matches('input,textarea,[contenteditable="true"]'))return;
    if(event.target instanceof Node&&(event.target===active||active.contains(event.target)))return;
    const nativeEditor=host.querySelector<HTMLElement>('[data-u-comp="editor"].univer-absolute');
    if(!nativeEditor)return;
    const rect=nativeEditor.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0||getComputedStyle(nativeEditor).visibility==='hidden')return;
    // Text is drawn on a canvas beside the hidden contenteditable. Clicking
    // that canvas places the caret inside the same editor, not a blur.
    if(event.target instanceof Node&&nativeEditor.contains(event.target))return;
    univerAPI.syncExecuteCommand(SetCellEditVisibleOperation.id,{visible:false,eventType:1,unitId:workbookId});
  };
  document.addEventListener('mousedown',endEditOnPointerDown,true);
  disposables.push({dispose:()=>document.removeEventListener('mousedown',endEditOnPointerDown,true)});

  /** Univer 原生编辑器此刻是不是开着（用来区分「已在编辑」与「刚开始编辑」）。 */
  function editorIsVisible():boolean{
    try{
      const injector=(univer as unknown as {__getInjector?:()=>{get<T>(token:unknown):T}}).__getInjector?.();
      if(!injector)return false;
      const bridge=injector.get<{isVisible():{visible?:boolean}}>(IEditorBridgeService);
      return Boolean(bridge?.isVisible?.().visible);
    }catch{return false;}
  }

  /* FIX-15（A14）：在网格上按 '=' → 走**本域的公式编辑器**。
     为什么不让 Univer 原生编辑器接管：
       ① 原生编辑器没有区间选择（用户原话「公式无法向 excel 一样能够选择 xxx：xxx」）；
       ② 它的选区地址按网格行号算（首个数据行是 A1），而后端公式引擎按**文件**行号算
          （表头占第 1 行 → 首个数据行是 A2）—— 差一行，公式会静默算错；
       ③ 编辑期间点表格会直接提交，区分不了「编辑公式」与「普通切格」。
     本域的编辑器三件事都对：能框范围、地址口径与后端一致、点表格不提交。 */
  const onFormulaShortcut=(event:KeyboardEvent)=>{
    const target=event.target as HTMLElement|null;
    const position=activeCellPosition();
    const column=position?columns[position.colIndex]:null;
    /* 判定表在 formula-range.ts（可单测）：网格里的 '=' 要接管，
       人用的输入框与「已经在改格内容」不接管。 */
    if(!shouldTakeFormulaShortcut({
      key:event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey,
      target,editorVisible:editorIsVisible(),hasEditableCell:Boolean(position&&column&&!column.readOnly),
    }))return;
    event.preventDefault();event.stopPropagation();
    editFormula(position!.rowIndex,position!.colIndex,formulas.get(position!.rowIndex)?.get(column!.fieldId)??'',formulaSeed(''));
  };
  host.addEventListener('keydown',onFormulaShortcut,true);
  disposables.push({dispose:()=>host.removeEventListener('keydown',onFormulaShortcut,true)});

  /**
   * 列宽改动后报给上层去写回后端。
   * 两个入口都看：拖拽松手发 `delta-column-width`，右键「列宽」输入发 `set-worksheet-col-width`。
   * 不去解析命令参数（两种参数形状不同），统一**读结果**再和上次比，只报变了的列。
   */
  function reportWidthChanges() {
    if (applyingWidths > 0) return;
    const ws = worksheet();
    if (!ws || !widthHandlers.length) return;
    for (let c = 0; c < columnCount; c++) {
      let width: number | undefined;
      try {
        width = ws.getColumnWidth(c);
      } catch {
        continue;
      }
      if (typeof width !== 'number') continue;
      // 首次见到这一列：只建基线，不算改动 —— 否则拖一次列宽会把所有「没记过宽度」的
      // 空白列都当成变了（实测一次拖动报 22 列、22 笔请求，且互相版本冲突）。
      if (!lastWidths.has(c)) { lastWidths.set(c, width); continue; }
      if (lastWidths.get(c) === width) continue;
      lastWidths.set(c, width);
      widthHandlers.forEach((fn) => fn(c, width));
    }
  }

  disposables.push(
    univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event: any) => {
      const id = String(event?.id || '');
      if((id==='sheet.command.delta-row-height'||id==='sheet.command.set-worksheet-row-height')&&!applyingHeights){
        const ws=worksheet();const states=ws?.getSheet()?.getSnapshot().rowData||{};
        const heights:Record<number,number>={},before:Record<number,number>={};
        for(const key of Object.keys(states)){
          const row=Number(key),height=ws?.getRowHeight(row);
          if(typeof height!=='number'||height===(appliedHeights.get(row)??DEFAULT_ROW_HEIGHT))continue;
          before[row]=appliedHeights.get(row)??DEFAULT_ROW_HEIGHT;heights[row]=height;
          manualHeights.set(row,height);appliedHeights.set(row,height);
        }
        if(Object.keys(heights).length)rowHeightHandlers.forEach(handler=>handler(heights,before));
        layoutChanged();return;
      }
      if (id === 'sheet.command.delta-column-width' || id === 'sheet.command.set-worksheet-col-width') {
        // Initial width installation already recalculates once at batch end.
        if(applyingWidths>0)return;
        reportWidthChanges();
        // D2: 列宽变了让 Univer 自动重算行高（不设强制高，否则 auto-height 被挡）。
        if(widthHeightTimer!==null)clearTimeout(widthHeightTimer);
        widthHeightTimer=setTimeout(() => {
          widthHeightTimer=null;
          try {
            const ws = worksheet();
            if (ws && wrapped.size) recalcLoadedHeights();
          } catch { /* 忽略 */ }
        }, 250);
        return;
      }
      if (id !== ALLOWED_VALUE_COMMAND || isProgrammaticUpdate) return;
      const params = event?.params || {};
      const range = params.range;
      if (!range || params.value === undefined) return;
      const startRow = Number(range.startRow ?? 0);
      const startCol = Number(range.startColumn ?? 0);
      const endRow = Number(range.endRow ?? startRow);
      const endCol = Number(range.endColumn ?? startCol);
      // 只接受单格：批量写本批没有动作支撑（粘贴/填充已被取消）。
      if (startRow !== endRow || startCol !== endCol) return;
      // 末尾空白列（extraCol）：columns 里没有它，但打字要能触发 onCommit（Excel 式加列）。
      const column = columns[startCol] ?? (startCol >= columns.length
        ? { fieldId: `__extra_${startCol}`, label: '', type: 'text', readOnly: false }
        : undefined);
      if (!column) return;
      // 只读列：不能假装保存。通知上层显示提示，值恢复原样。
      // 用户原话："可以只读，但是如果只读就需要你不能默认'保存'，不能让我认为是保存了的"
      if (column.readOnly) {
        // 恢复格子原值（Univer 已经改了显示，要拨回去）
        const beforeVal = known.get(startRow)?.get(column.fieldId) ?? '';
        try {
          const w = worksheet();
          if (w) w.getRange(startRow, startCol, startRow, startCol).setValue(beforeVal);
        } catch { /* 恢复失败就算了，关键是不假装保存 */ }
        readOnlyHandlers.forEach((fn) => fn({
          rowIndex: startRow, colIndex: startCol, label: column.label || column.fieldId,
        }));
        return;
      }
      const next = toText(params.value);
      const before = known.get(startRow)?.get(column.fieldId) ?? '';
      if (before === next) return;
      // 先把新值记进 known：**提交后不记，下一次编辑读到的 before 就是上上次的值**。
      // 2026-10-11 A21 就这么拿到过期 before 的——撤回会写回错的那一格。
      const map = known.get(startRow) ?? new Map<string, string>();
      map.set(column.fieldId, next);
      known.set(startRow, map);
      recentCommits.push({ rowIndex: startRow, fieldId: column.fieldId, before, next });
      if (recentCommits.length > 5) recentCommits.shift();
      // 程序化更新（setRowValue/setRow）不触发 commitHandlers，否则会推多余 undo entry
      if (isProgrammaticUpdate) return;
      commitHandlers.forEach((fn) => fn({
        rowIndex: startRow, colIndex: startCol, fieldId: column.fieldId, value: next, before, type: column.type,
      }));
      recalcLoadedHeights(startRow, 1);
    }),
  );

  // Univer 网格是 canvas 虚拟滚动：DOM 的原生 scroll 事件永远不会来，
  // 必须订阅它自己的 Scroll 事件，懒加载才有触发点。
  disposables.push(
    univerAPI.addEvent(univerAPI.Event.SelectionChanged, (event) => {
      if(event.workbook.id!==workbookId||event.worksheet.getSheetId()!==sheetId)return;
      selectionHandlers.forEach(handler=>handler());
    }),
    univerAPI.addEvent(univerAPI.Event.Scroll, () => {
      scrollHandlers.forEach((fn) => fn());
      layoutChanged();
      // —— 滚到新的一段 ⇒ **补画那一段的空必填格**（画框是提醒 ⇒ 滚到哪画到哪）
      //   ⚠️ **不清掉已有的** ⇒ **前面页的框还在**（增量，2026-10-30 用户点名的缺陷）。
      scheduleRequiredEmptyPaint();
    }),
    univerAPI.addEvent(univerAPI.Event.SheetSkeletonChanged,layoutChanged),
    univerAPI.addEvent(univerAPI.Event.SheetZoomChanged,layoutChanged),
  );

  function setRows(rows:GridRowInput[]) {
    if(!rows.length)return;
    const ws=worksheet();
    if(!ws)throw new Error('表格尚未就绪，无法装填行');
    // 稀疏绝对坐标矩阵只装填本批真实行，不物化中间的空白区。
    const matrix:Record<number,Record<number,ReturnType<typeof cellFor>|Record<string,never>>>={};
    const staged:Array<{rowIndex:number;map:Map<string,string>;types:Map<string,string>;styles:Map<string,CellFontStyle>;formulas:Map<string,string>}>=[];
    for(const {rowIndex,values,cellTypes,cellStyles,formulas:rowFormulas} of rows){
      const rowFormulaMap=new Map(columns.flatMap((column,index)=>rowFormulas?.[index]?[[column.fieldId,rowFormulas[index]!] as [string,string]]:[]));
      if(!Number.isInteger(rowIndex)||rowIndex<0||rowIndex>=Math.max(1,rowCount))throw new Error('装填行超出表格范围');
      const map = new Map(known.get(rowIndex));
      const types = new Map(knownTypes.get(rowIndex));
      const styles=new Map(knownStyles.get(rowIndex));
      const cells = columns.map((column, index) => {
        const raw = values[index];
        const type = cellTypes?.[index] ?? column.type;
        map.set(column.fieldId, toText(raw));
        types.set(column.fieldId, type);
        // ★ fast 那边在 setRow 里加的「按格套显示格式」在这里保住了：
        //   服务端回的每格格式（number_format/bold/font_size/font_color/wrap_text/border…）
        //   由 cellStyles 带进来，cellFor 统一翻译成 Univer 样式（fontStyleToUniver）。
        //   两边同源：格式视图字段与 CellFontStyle 一一对应。
        const font=cellStyles?cellStyles[index]:styles.get(column.fieldId);
        if(font)styles.set(column.fieldId,{...font});else if(cellStyles)styles.delete(column.fieldId);
        return cellFor(raw, column, type,font);
      });

      matrix[rowIndex]=Object.fromEntries(Array.from({length:columnCount},(_,index)=>[index,cells[index]??{}]));
      staged.push({rowIndex,map,types,styles,formulas:rowFormulaMap});
    }
    isProgrammaticUpdate=true;
    try{ws.getRange(0,0,1,1).setValues(matrix);}finally{isProgrammaticUpdate=false;}
    // 成功装填才更新撤回/编辑的原值缓存。
    for(const row of staged){known.set(row.rowIndex,row.map);knownTypes.set(row.rowIndex,row.types);knownStyles.set(row.rowIndex,row.styles);formulas.set(row.rowIndex,row.formulas);}
    const active=activeCellPosition();
    if(active&&matrix[active.rowIndex])selectionHandlers.forEach(handler=>handler());
  }

  function setColumnWidths(widths:Array<{colIndex:number;width:number}>){
    const ws=worksheet();if(!ws)return;
    const changed=widths.filter(({colIndex,width})=>Number.isInteger(colIndex)&&colIndex>=0&&colIndex<columnCount&&Number.isFinite(width)&&width>0&&lastWidths.get(colIndex)!==width).sort((a,b)=>a.colIndex-b.colIndex);
    if(!changed.length)return;
    applyingWidths++;
    try{
      for(let i=0;i<changed.length;){
        const first=changed[i];let end=i;
        while(end+1<changed.length&&changed[end+1].colIndex===changed[end].colIndex+1&&changed[end+1].width===first.width)end++;
        ws.setColumnWidths(first.colIndex,end-i+1,first.width);
        for(let j=i;j<=end;j++)lastWidths.set(changed[j].colIndex,changed[j].width);
        i=end+1;
      }
      recalcLoadedHeights();
    }finally{applyingWidths--;}
  }

  /**
   * **设列头**的重试代数（每次重设 +1）—— 旧的异步重试**自动作废**。
   */
  let headerApplyGeneration=0;
  /**
   * **当前的「必填列名」集合** ＝ 后端给的必填清单 ∪ **列自己带的** `required` 标记。
   *
   * ⚠️ **为什么两个来源取并集**：后端那份是**异步**来的（可能还没到），
   *   而列自己带的 `required`（`GridColumn.required`）**开表就在** ⇒ 早到的那份先用上。
   */
  function requiredLabels(): Set<string> {
    const set = new Set(requiredHeaderLabels);
    for (const column of columns) if (column?.required) set.add(column.label || column.fieldId);
    return set;
  }
  /**
   * **设列头**（把列表头从 Univer 默认的 A/B/C 换成字段名 ＋ 受管列的白字绿底
   * ＋ 必填列末尾那颗星）。
   *
   * ⚠️ **必填集合是参数**（不是闭包里的变量）：受管清单与必填清单**都是异步**来的
   *   ⇒ 每次重设列头都得把**当下**的必填集合带上 ⇒ 放在参数里，调用方给什么就设什么。
   *
   * ⚠️ **为什么是内部函数**（2026-10-29 实测踩到）：返回对象里的
   *   `setColumnHeaders` 与 `setManagedColumns` **是两个方法** ⇒
   *   后者**调不到**前者（运行时报 `setColumnHeaders is not defined`）⇒
   *   **抽成内部函数**，几处共用一份。
   *
   * ⚠️ **为什么走官方 facade**（2026-10-11 定）：文字画在 canvas 的列头区，
   *   跟着列宽和横向滚动走，不用自己同步位置。
   * ⚠️ **渲染单元是异步注册的** ⇒ 拿不到就**下一帧再试**（有界重试，不无限等），
   *   「等」与「失败」分开报（`headerLabelPending` / `headerLabelError`）。
   */
  function applyColumnHeaders(labels: string[], required?: Set<string>): void {
    const generation=++headerApplyGeneration;
    headerLabels = labels.slice();
    // —— **受管列的列头样式**（2026-10-29 用户口径：白字绿底）——
    //   **画在画布上**（跟着列走）⇒ 不会再出现「锁图案跑到别的列上」。
    // —— **必填列的列头标记**（末尾那颗星）——
    //   ⚠️ **必填集合必须一起带上**（`required`）⇒ 异步到货后**再设一次**列头，标记才在。
    const columnsCfg = columnHeaderCfg(
      labels, managedHeaderLabels,
      { fontFamily, fontColor: textColor, fontSize: 12,
        backgroundColor: 'gray.50', borderColor: 'gray.200', textBaseline: 'middle' },
      required);
    // —— **记下「我们设进去的」**：受管列那几格是**带样式的对象**，普通列是纯文字 ——
    headerCfgSent = {};
    labels.forEach((text, index) => {
      const cfg = columnsCfg[index];
      (headerCfgSent as Record<number, unknown>)[index] =
        typeof cfg === 'string' ? cfg : cfg.text;
    });
    headerLabelError = '';
    headerLabelPending = 0;

    const MAX_TRIES = 60; // 约 1 秒（每帧一试）；超了就如实报失败，不无限等
    const tryOnce = (attempt: number): boolean => {
      const ws = worksheet();
      const facade = ws
        ? (ws as unknown as { customizeColumnHeader?: (cfg: unknown) => void })
        : null;
      if (facade && typeof facade.customizeColumnHeader === 'function') {
        facade.customizeColumnHeader({
          columnsCfg,
          headerStyle: {
            fontFamily,
            fontColor: textColor,
            fontSize: 12, // 表头 fontSize 是 Canvas px，与正文 fs 的 pt 单位不同。
            backgroundColor: 'gray.50',
            borderColor: 'gray.200',
            textBaseline: 'middle',
          },
        });
        return true; // facade 抛了就让它抛，由外层 catch 记
      }
      throw new Error('customizeColumnHeader 方法不在 FWorksheet 上');
    };

    const attempt = () => {
      if(generation!==headerApplyGeneration)return;
      try {
        if (tryOnce(headerLabelPending)) {
          headerLabelPending = 0;
          headerLabelError = '';
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        headerLabelPending += 1;
        if (headerLabelPending < MAX_TRIES) {
          // 渲染单元还没就绪——下一帧再试。此时 headerLabelError 留空、
          // headerLabelPending > 0，诊断口能看出「还在等」而不是「失败」。
          headerLabelError = '';
          requestAnimationFrame(attempt);
          return;
        }
        // 重试用尽：如实报失败。绝不回报「已设」。
        headerLabelError = `设表头失败（试了 ${MAX_TRIES} 次）：${message}`;
        headerLabelPending = 0;
      }
    };
    attempt();
  }

  return {
    setRows,
    setFreeze(rows,columns){applyingPersonalView=true;try{const ws=worksheet();ws?.setFrozenRows(rows);ws?.setFrozenColumns(columns);}finally{applyingPersonalView=false;}layoutChanged();},
    setColumnWidths,
    setRow(rowIndex,values,cellTypes,cellStyles){setRows([{rowIndex,values,cellTypes,cellStyles}]);},
    setRowHeights(heights){
      applyingHeights++;
      try{
        const ws=worksheet();
        for(const [key,height] of Object.entries(heights)){
          const row=Number(key);
          if(row<0||row>=rowCount||!Number.isFinite(height))continue;
          if(height<=0){
            // **0 ＝ 恢复自动行高**（后端用 0 表示「这一行不写固定高」）。
            // ⚠️ 原来这里会 `setRowHeightsForced(row,1,0)` ⇒ **那一行高度变成 0**（整行看不见了）。
            manualHeights.delete(row);appliedHeights.delete(row);
            ws?.setRowAutoHeight(row,1);
            continue;
          }
          manualHeights.set(row,height);appliedHeights.set(row,height);ws?.setRowHeightsForced(row,1,height);
        }
      }finally{applyingHeights--;}
      layoutChanged();
    },
    onRowHeight(handler){rowHeightHandlers.push(handler);},
    getRowValue(rowIndex, fieldId) {
      return known.get(rowIndex)?.get(fieldId) ?? '';
    },
    getCellStyle(rowIndex,fieldId){const style=knownStyles.get(rowIndex)?.get(fieldId);return style?{...style}:undefined;},
    setCellStyle(rowIndex,fieldId,style){
      applyFontStyles([{rowIndex,fieldId,style}]);
    },
    setCellStyles(cells){applyFontStyles(cells);},
    setRowValue(rowIndex, fieldId, value, cellType) {
      try {
        const map = known.get(rowIndex);
        if (map) map.set(fieldId, toText(value));
        const definedCol = columns.findIndex((c) => c.fieldId === fieldId);
        const extra = /^__extra_(\d+)$/.exec(fieldId);
        const colIdx = definedCol>=0?definedCol:extra&&Number(extra[1])>=columns.length&&Number(extra[1])<columnCount?Number(extra[1]):-1;
        if (colIdx >= 0) {
          const column=columns[colIdx]??{fieldId,label:'',type:'text',readOnly:false};
          const type = cellType ?? knownTypes.get(rowIndex)?.get(fieldId) ?? column.type;
          knownTypes.get(rowIndex)?.set(fieldId, type);
          const ws = worksheet();
          if (ws) {
            isProgrammaticUpdate = true;
            try { ws.getRange(rowIndex, colIdx, 1, 1).setValues([[cellFor(value, column, type,knownStyles.get(rowIndex)?.get(fieldId))]]); }
            finally { isProgrammaticUpdate = false; }
          }
        }
      } catch { /* 行号越界忽略 */ }
    },
    recalcAutoHeights(startRow, count) {
      try {
        recalcLoadedHeights(startRow, count);
      } catch { /* 忽略 */ }
    },
    resetAutoRowHeights,
    getSelection() {
      // 返回 Univer 实际选区（不是 highlightAt，那只是高亮标记）
      const primary=activeCellPosition();if(primary)return primary;
      try {
        // 合并说明：ours 这边直接读 getActiveRange().getRange()，读不到退回高亮位置；
        // fast 那边走公共模块 selectionRange（多选区就回 null，绝不默认 A1）。
        // 两条都留：先走公共模块（更严），再走 ours 的直读，最后退回高亮位置。
        const range=sharedSelectionRange();
        if(range)return {rowIndex:range.startRow,colIndex:range.startCol};
        const ws = worksheet();
        const sel = ws?.getSelection()?.getActiveRange()?.getRange();
        if (sel) {
          return {
            rowIndex: Number(sel.startRow ?? 0),
            colIndex: Number(sel.startColumn ?? 0),
          };
        }
      } catch { /* 取不到就回退到 highlightAt */ }
      return highlightAt ? { ...highlightAt } : null;
    },
    getSelectionRange() {
      // 完整选区范围（复制用）：从 Univer 选区对象取起止行列
      try {
        // 合并说明：公共模块（fast）优先，取不到再走 ours 的直读（见上）。
        const shared=sharedSelectionRange();
        if(shared)return shared;
        const ws = worksheet();
        const sel = ws?.getSelection()?.getActiveRange()?.getRange();
        if (sel) {
          const sr = Number(sel.startRow ?? 0);
          const sc = Number(sel.startColumn ?? 0);
          const er = Number(sel.endRow ?? sr);
          const ec = Number(sel.endColumn ?? sc);
          return { startRow: Math.min(sr, er), startCol: Math.min(sc, ec),
                   endRow: Math.max(sr, er), endCol: Math.max(sc, ec) };
        }
      } catch { /* 取不到回 null */ }
      return null;
    },
    selectCell(rowIndex, colIndex) {
      try {
        // getRange 的后两个参数是「行数/列数」，不是终点行列号。
        const range = worksheet()?.getRange(rowIndex, colIndex, 1, 1);
        range?.activateAsCurrentCell();
        // 原位点击只改变选区。滚动会让候选在双击的两次点击间移位，误触单击确认。
        // 搜索和提案定位由调用方显式 scrollToRow，不能在此隐式移动视口。
        selectionHandlers.forEach(handler=>handler());
      } catch {
        /* 行号超出当前行数时忽略；调用方先确保行已装填。 */
      }
    },
    getViewState(){
      const range=sharedSelectionRange();
      let scroll:IScrollState|null=null;
      try{const state=worksheet()?.getScrollState();if(state)scroll={...state};}catch{/* 首帧尚未建立视口。 */}
      return {range,scroll};
    },
    restoreViewState(state,selection=true){
      const ws=worksheet();if(!ws)return;
      if(selection&&state.range){const r=state.range;ws.getRange(r.startRow,r.startCol,r.endRow-r.startRow+1,r.endCol-r.startCol+1).activate();}
      if(state.scroll){
        const current=ws.getScrollState();
        if(!current||['sheetViewStartRow','sheetViewStartColumn','offsetX','offsetY'].some(key=>current[key as keyof IScrollState]!==state.scroll![key as keyof IScrollState])){
          univerAPI.syncExecuteCommand(ScrollCommand.id,{...state.scroll,unitId:workbookId,sheetId,duration:0});
        }
      }
    },
    scrollToRow(rowIndex, colIndex = 0) {
      // 关键：activate() / activateAsCurrentCell() 只改选区，**不滚屏**
      // （它们走 SetSelectionsOperation 且不带 reveal:true，而 Univer 只在
      // 带 reveal 时才滚）。要真的滚过去必须用 scrollToCell。
      try {
        worksheet()?.scrollToCell(rowIndex, colIndex);
      } catch {
        /* 行号超出当前行数时忽略。 */
      }
    },
    highlightCell(rowIndex, colIndex, source) {
      // 纯渲染层高亮：不改数据、不执行命令，所以黑名单够不着。
      try {
        highlightAt = null;
        const range = worksheet()?.getRange(rowIndex, colIndex, 1, 1);
        if (!range) return () => {};
        // primary 要整段 IRange 形状，这里不需要——只描这一格的边。
        // ⚠️ **颜色只有那一份**（`REVIEW_SOURCE_COLORS`）⇒ 不许在这里另写一遍。
        const colors = REVIEW_SOURCE_COLORS[reviewSourceKind(source)];
        const style = { stroke: colors.stroke, strokeWidth: 2, fill: colors.fill };
        // —— **走形状层**（2026-10-30 用户口径：格上的效果都放一层里）——
        //   同一格再来一次 ⇒ **不重画**（不重算）。
        // ⚠️ **一帧最多重画一次**（2026-10-30 装饰层性能）：
        //   拖动时**每个鼠标移动**都来一次 ⇒ 不节流 ⇒ 一次拖动几十次重画 ⇒ **卡**。
        scheduleDropHighlight({ key: `${rowIndex}:${colIndex}`, range, style });
        highlightAt = { rowIndex, colIndex };
        return () => {
          cancelDropHighlight();
          highlightAt = null;
        };
      } catch {
        return () => {};
      }
    },
    markReviewCells(cells) {
      // —— **按来源分组，走形状层**（2026-10-30 用户口径：「所有格上的效果放一层」）：
      //   以前是**一格一次 `highlight`** ⇒ N 格 = **N 次重画**（每���重画会把
      //   已有的全部形状重算一遍）⇒ 提案一多就卡。
      //   现在：**每种来源一次重画**；**提案没变 ⇒ 一次都不重画**。
      const ws = worksheet();
      if (!ws) return () => {};
      const groups = new Map<string, { style: object; cells: Array<{ key: string; range: any }> }>();
      const seen = new Set<string>();
      for (const cell of (cells || []).slice(0, 200)) {
        const key = `${cell.rowIndex}:${cell.colIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const kind = reviewSourceKind(cell.kind);
        try {
          const range = ws.getRange(cell.rowIndex, cell.colIndex, 1, 1);
          if (!range) continue;   /* Proposal text/identity remains visible when an offscreen range cannot be marked. */
          /* —— **底色跟案号候选一个做法**（2026-10-30 用户 11:5x：
             「agent 提出的对于表格的候选也走这个样式，只不过是绿底哈」）。
             ⚠️ 以前这里是 `fill:'transparent'` ⇒ **只有描边、没有底**
               ⇒ 再加上 DOM 文字层是白底 ⇒ 看起来就是「白底绿字」。
             ⇒ 现在**底色画在形状层**，DOM 文字层改成透明底（见 CSS）。 */
          const colors = REVIEW_SOURCE_COLORS[kind];
          const group = groups.get(kind) ?? { style: { stroke: colors.stroke, strokeWidth: 2, fill: colors.fill }, cells: [] };
          group.cells.push({ key, range });
          groups.set(kind, group);
        } catch { /* 画不上就拉倒（提议文字还在，不影响人读）。 */ }
      }
      shapeLayer.setGroupSet('review', [...groups].map(([name, group]) => ({ name, style: group.style, cells: group.cells })));
      return () => {
        for (const name of shapeLayer.names()) if (name.startsWith('review:')) shapeLayer.dropGroup(name);
      };
    },
    wrapColumn(colIndex) {
      const column = columns[colIndex];
      if (!column || wrapped.has(column.fieldId)) return;
      wrapped.add(column.fieldId);
      // 新装填的格由 cellFor 写 tb；仅对已经加载的旧格补样式，不触及空白行。
      const ws = worksheet();
      if (!ws) return;
      const rows = [...known.keys()].sort((a, b) => a - b);
      let start = -1, end = -1;
      const flush = () => { if (start >= 0) ws.getRange(start, colIndex, end - start + 1, 1).setWrapStrategy(WRAP_VALUE); };
      for (const row of rows) {
        if (start >= 0 && row === end + 1) end = row;
        else { flush(); start = end = row; }
      }
      flush();
    },
    setColumnWidth(colIndex,width){setColumnWidths([{colIndex,width}]);},
    adoptColumns(next) {
      if(next.length>columnCount)return false;
      columns.splice(0,columns.length,...next);
      return true;
    },
    snapshotColumnWidths() {
      const ws = worksheet();
      if (!ws) return;
      for (let c = 0; c < columnCount; c++) {
        try {
          const w = ws.getColumnWidth(c);
          if (typeof w === 'number') lastWidths.set(c, w);
        } catch { /* 个别列取不到就跳过 */ }
      }
    },
    setColumnHeaders(labels) {
      applyColumnHeaders(labels, requiredLabels());
    },
    setManagedColumns(labels) {
      // —— **受管列清单是异步来的**（`files.promotion_definition`）⇒ 常常**晚于**列头第一次设上
      //   ⇒ 这里**再设一次列头**（样式才生效）⇒ 受管列的列头白字绿底。
      managedHeaderLabels = new Set(labels || []);
      if (headerLabels.length) applyColumnHeaders(headerLabels, requiredLabels());
    },
    setRequiredColumns(labels) {
      // —— **必填列清单也是异步来的**（同一份 `files.promotion_definition` 的 `rules.required`）
      //   ⇒ 常常**晚于**列头第一次设上 ⇒ 这里**再设一次列头**（必填标记才生效）。
      //   ⚠️ **重设时必填集合必须一起带上**（`requiredLabels()`）⇒ 否则标记只对第一帧有效。
      requiredHeaderLabels = new Set(labels || []);
      if (headerLabels.length) applyColumnHeaders(headerLabels, requiredLabels());
    },
    /**
     * **把「空的必填格」框红**（2026-10-30 用户口径）。
     *
     * ⚠️ **给过来的清单是「累积」的**（主控那边是本子累积账 ⇒ 翻页不会覆盖前面页）
     *   ⇒ 这里**整份替换**即可 ⇒ **翻页后前面页的框不会消失**。
     * ⚠️ **纯渲染层**：`highlight` 不改数据、不执行命令 ⇒ 不会存进文件。
     */
    setRequiredEmptyMarks(delta) {
      // ⚠️ **规则那边只送「增量」**（加了几格、撤了几格）——
      //   这条通道**不再每次传全量清单**（大表上就是几万项）⇒ 装饰层不用从头比一遍。
      const add=delta?.added||[], remove=delta?.removed||[];
      if(!add.length&&!remove.length)return;   // 没变化 ⇒ 一个字都不改
      for(const mark of add)requiredEmptyCells.set(requiredMarkKey(mark),{rowIndex:mark.rowIndex,fieldId:mark.fieldId});
      for(const key of remove)requiredEmptyCells.delete(key);
      // ⚠️ **只「记下」要画的」，**不在这里画**（2026-10-30 用户要求：
      //   「进去就能编辑，**无论表格大小**」—— 昨晚还是能进去就编辑的）。
      //   ⇒ 真正的绘制走 `paintRequiredEmptyMarks`：**空闲时**、**成批画**、
      //   **只画看得见的那一窗**。
      scheduleRequiredEmptyPaint();
    },
    decorateCells(group, cells, style) {
      // —— **成批走形状层**：一次重画画一整批；**没变就不重画** ——
      const ws=worksheet();
      if(!ws)return;
      const paintable:Array<{key:string;range:any}>=[];
      for(const cell of cells||[]){
        if(!cell||!columns[cell.col])continue;
        const range=ws.getRange(cell.row,cell.col,1,1);
        if(!range)continue;
        paintable.push({key:`${cell.row}\u0000${cell.col}`,range});
      }
      shapeLayer.setGroup(group,style as unknown as object,paintable);
    },
    onCommit(handler) {
      commitHandlers.push(handler);
    },
    onSelection(handler) {
      selectionHandlers.push(handler);
      if(worksheet()?.getSelection()?.getActiveRange())handler();
    },
    getReviewFrame:reviewFrame,
    getHeaderAtPoint(clientX,clientY){
      const frame=reviewFrame();if(!frame||!publicRender)return null;
      const hostRect=host.getBoundingClientRect(),canvas=publicRender.engine.getCanvasElement().getBoundingClientRect();
      const x=clientX-hostRect.left,y=clientY-hostRect.top,top=canvas.top-hostRect.top;
      if(y<top||y>=frame.clip.top||x<frame.clip.left||x>=frame.clip.left+frame.clip.width)return null;
      for(let col=frame.visible.startCol;col<=Math.min(columns.length-1,frame.visible.endCol);col++){
        const rect=frame.rect(Math.max(0,frame.visible.startRow),col);if(rect&&x>=rect.left&&x<rect.left+rect.width)return {colIndex:col,rect:{left:Math.max(frame.clip.left,rect.left),top,width:Math.min(rect.left+rect.width,frame.clip.left+frame.clip.width)-Math.max(frame.clip.left,rect.left),height:frame.clip.top-top}};
      }
      return null;
    },
    getHeaderRect(colIndex){
      const frame=reviewFrame();if(!frame||!publicRender)return null;
      if(colIndex<frame.visible.startCol||colIndex>frame.visible.endCol)return null;
      const hostRect=host.getBoundingClientRect(),canvas=publicRender.engine.getCanvasElement().getBoundingClientRect();
      const top=canvas.top-hostRect.top;
      if(top>=frame.clip.top)return null;
      const rect=frame.rect(Math.max(0,frame.visible.startRow),colIndex);if(!rect)return null;
      const left=Math.max(frame.clip.left,rect.left),right=Math.min(rect.left+rect.width,frame.clip.left+frame.clip.width);
      if(right<=left)return null;
      return {left,top,width:right-left,height:frame.clip.top-top};
    },
    onLayout(handler){layoutHandlers.push(handler);},
    isEditing() {
      // 合并说明：ours 这边问 Univer 的 isCellEditing()；fast 那边用「活动元素是不是
      //   看得见的可编辑控件」来判断（因为提交后焦点还留在那个控件上，Univer 的标志会漂）。
      // 两条都留：先问 Univer（权威），再走 fast 的看得见判定。
      if(formulaEditor)return true;
      // Cancelled native edit flags can outlive the visible editor and block copying.
      const nativeEditor=host.querySelector<HTMLElement>('[data-u-comp="editor"].univer-absolute');
      if(nativeEditor){const rect=nativeEditor.getBoundingClientRect();if(rect.width>0&&rect.height>0&&getComputedStyle(nativeEditor).visibility!=='hidden')return true;}
      // Univer 的单元格编辑器是浮在网格里的可编辑元素。认活动元素即可，
      // 不去猜它内部的编辑态标志（那是内部实现，版本一变就漂）。
      //
      // 但光认「是不是可编辑控件」不够：提交完之后焦点往往还留在那个控件上，
      // 于是每次都误判成「正在编辑」，Cmd+Z 全走成「丢弃输入」，撤回一次都没跑
      // （2026-10-11 A21 就这么红的）。所以还要看它**真的看得见**。
      const ae = document.activeElement;
      if (!ae || ae === document.body) return false;
      if (!(ae instanceof HTMLElement)) return false;
      if (!host.contains(ae)) return false;
      const editable = ae instanceof HTMLInputElement
        || ae instanceof HTMLTextAreaElement
        || ae.isContentEditable;
      if (!editable) return false;
      const rect = ae.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0
        && ae.offsetParent !== null
        && getComputedStyle(ae).visibility !== 'hidden'
        && getComputedStyle(ae).display !== 'none';
      return visible;
    },
    cancelEdit() {
      // Esc 是 Univer 单元格编辑器的「放弃输入」。比自己改值稳：
      // 它会把编辑浮层一并收掉，不留半开的编辑态。
      try {
        const ae = document.activeElement;
        if (ae instanceof HTMLElement && host.contains(ae)) {
          ae.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch { /* 没有活动元素就当作本来没在编辑。 */ }
    },
    onBlockedCommand(handler) {
      blockedHandlers.push(handler);
    },
    onReadOnlyEdit(handler) {
      readOnlyHandlers.push(handler);
    },
    onScroll(handler) {
      scrollHandlers.push(handler);
    },
    // ★ 合并说明：ours 与 fast 各有一份 snapshotColumnWidths（这里保留 ours 的那份，
    //   带 try/catch —— 个别列取不到宽度就跳过，不让一次异常打断整次快照）。
    onColumnWidth(handler) {
      widthHandlers.push(handler);
    },
    getCellText(rowIndex, colIndex) {
      const field=columns[colIndex]?.fieldId;
      // Clipboard carries canonical values, never thousands separators/date serials introduced only for display.
      if(field&&known.get(rowIndex)?.has(field))return displayCellText(known.get(rowIndex)?.get(field),knownTypes.get(rowIndex)?.get(field));
      try {
        const range = worksheet()?.getRange(rowIndex, colIndex, 1, 1);
        if (!range) return null;
        const val = range.getDisplayValue();
        // getDisplayValue 可能返回 CellValue 对象（有 v/vt 等属性），提取实际值
        if (val == null) return null;
        if (typeof val === 'string') return val;
        if (typeof val === 'object' && 'v' in val) return String((val as any).v ?? '');
        return String(val);
      } catch {
        return null;
      }
    },

    getDiag() {
      const ws = worksheet();
      let visibleRows: [number, number] = [-1, -1];
      let defaultRowHeight = DEFAULT_ROW_HEIGHT;
      const rowHeights: Record<number, number> = {};
      const rowHeightState: GridDiag['rowHeightState'] = {};
      try {
        const visible = ws?.getVisibleRange();
        if (visible) visibleRows = [Number(visible.startRow ?? -1), Number(visible.endRow ?? -1)];
      } catch { /* 取不到就留 -1，调用方当失败处理。 */ }
      // 建表快照里 defaultRowHeight 就是 24；facade 没有读它的接口，直接用建表值。
      defaultRowHeight = DEFAULT_ROW_HEIGHT;
      // 只读可视区附近若干行的行高，避免整表量一遍。
      const [a, b] = visibleRows;
      if (a >= 0 && b >= a) {
        for (let r = Math.max(0, a - 2); r <= Math.min(rowCount - 1, b + 2); r++) {
          try {
            const h = ws?.getRowHeight?.(r);
            if (typeof h === 'number') rowHeights[r] = h;
            const state = ws?.getSheet()?.getSnapshot().rowData[r];
            if (state) rowHeightState[r] = { h: state.h, ah: state.ah, ia: state.ia };
          } catch { /* 个别行取不到就跳过。 */ }
        }
      }
      // 列宽只有这么多列，全量读一遍。
      // 注意：宽度等于默认值时 Univer 会把 w 键整个删掉，getColumnWidth 已经回退到默认列宽，
      // 所以这里拿到的一定是实际生效值，不是 undefined。
      const columnWidths: Record<number, number> = {};
      for (let c = 0; c < columnCount; c++) {
        try {
          const w = ws?.getColumnWidth?.(c);
          if (typeof w === 'number') columnWidths[c] = w;
        } catch { /* 个别列取不到就跳过。 */ }
      }
      return {
        editing:cellEditing,
        visibleRows,
        rowHeights,
        rowHeightState,
        defaultRowHeight,
        wrapColumns: [...wrapped],
        highlight: highlightAt,
        // —— **形状层现在有几组、几个格子**（诊断口：判据要能核「真的画上了几个」）——
        shapes: shapeLayer.stats(),
        // —— **受管列清单**（诊断口：判据核「对象的每一列都受管」）——
        managedHeaders: [...managedHeaderLabels],
        columnWidths,
        headerLabels: headerLabels.slice(),
        headerLabelError,
        headerLabelPending,
        headerCfgSent: headerCfgSent ? { ...headerCfgSent } : null,
        recentCommits: recentCommits.slice(),
        headerChrome:{...headerChrome},
      };
    },
    dispose() {
      if(widthHeightTimer!==null)clearTimeout(widthHeightTimer);
      selectionHandlers.length=0;
      layoutHandlers.length=0;publicRender=null;
      // —— **形状层全部摘掉**（网格没了 ⇒ 那些形状也不该留着）——
      try {
        shapeLayer.dispose();
      } catch { /* 已摘除则忽略。 */ }
      highlightAt = null;
      disposables.forEach((d) => {
        try {
          d.dispose();
        } catch {
          /* 已释放则忽略。 */
        }
      });
      try {
        univer.dispose();
      } catch {
        /* 重复释放忽略。 */
      }
      renderHost.remove();
    },
  };
}
