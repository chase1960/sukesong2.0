import {needsFormulaRefresh,wroteFormula} from './formula-values';
import {normalizeTriState} from './cell-picker';
import {editPersonalView} from './personal-view-dialog';
import {mergeColumnFilter,mountColumnFilterOverlay,openColumnFilterPanel,type ColumnFilterAnchor,type ColumnFilterPanelHandle} from './column-filter';
import {explainOpenFailure} from './open-failure';
import {standaloneFromSearch} from './standalone';
import {editTableRelation} from './table-relation-dialog';
import {relationTargetChoices} from './table-relations';
import {type PersonalView,emptyPersonalView} from './personal-view';
/**
 * 尚书 Excel 表格页。
 *
 * 数据库业务表走 platform.object.update；xlsx 走文件域受管单格/范围/结构动作。
 * 搜索、读取、回执走公共接口；文件操作不会新建业务字段或业务表。
 * 本链路全程 0 次 LLM 调用。
 *
 * 入口标明事实类型，复用表卡、列头、编辑器和保存反馈；后端适配器严格分流。
 *
 * 行标识两边都是服务端发号的稳定键（数据库 name / xlsx row_id），**不是可视行号**，
 * 翻页、搜索定位、并发编辑后都不会串行。页大小 100（接口上限）。
 */
import {editStructure,type StructureChoice} from './structure-dialog';
import {editFieldPermissions,editTablePermissions} from './field-permissions';
import { ViewportReadScheduler } from './read-scheduler';
import {retrySave} from './save-retry';
import { createGrid, type CommitEvent, type GridColumn, type GridHandle } from './sheet';
import {
  ApiError,
  newIdempotencyKey,
  type RecordRow,
} from './api';
import { listTables, openTable, getRowViewMetadata, setRowFontStyle, type UnifiedTable } from './backend';
import {createLatestRead} from '../../../lib/latest-read.mjs';
import type {BulkEditResult} from './adapter';
import {
  buildFillSeriesPayload,
  buildFindReplacePayload,
  buildPasteSpecialPayload,
  describeRange,
  fillDirection,
  isSingleLine,
  rangeCols,
  rangeRows,
  type FillSeriesOptions,
  type FindReplaceOptions,
  type GridRange,
  type PasteSpecialMode,
} from './sheet-ops';
import { parseClipboardTsv, serializeClipboardTsv } from './clipboard-tsv';
import { buildClipboardPayload, copiedSourceMatchesTable, workbookShortcutAllowed, type ClipboardRange } from './clipboard-toolbar';
import {buildStyleTargets,validateFontPatch,validateFontState,type BorderPreset,type CellFontStyle,type FontStylePatch,type StyleTarget} from './font-style';
import {createDropdown,closeDropdowns,hasOpenDropdown,openPopupMenu} from './dropdown';
import {hitRegion,menuItemsFor,resolveRowInsertAnchor,COLUMN_FIELD_PERMISSIONS_ITEM,ROW_AUTO_HEIGHT_ITEM,type HitRegion} from './structure-menu';
import {decideExtendWrite} from './write-gate';
import {decideLeaveTable} from './save-guard';
import {emptyRequiredCells,requiredReminderText,RequiredEmptyLedger,type RequiredColumn} from './required-marks';
import { readExportCapabilities, exportCurrentTable, type ExportCapabilities } from './export-helper';
import { mountDirectory, type DirectoryState } from './directory';
import { proposalCells, editedProposalValue, type Proposal } from './proposal-view';
import {fetchReviewDescriptor,createInlineReviewController,reviewValuesEqual,proposalSupportsInlineReview,proposalTargetTable,resolveCandidateCell,type InlineReviewController,type ReviewDescriptor,type ReviewUnit,type ReviewValue} from './inline-review';
import {mountCandidateOverlay,mountReviewBar,type CandidateOverlayItem,type ReviewBarEntry} from './candidate-overlay';
import {frameThrottle} from './frame-throttle';
import {mountHeaderRename} from './header-rename';
import {mountColumnDrag,reorderByMove} from './column-drag';
import {mountExcelRowBehaviors,type ExcelRowBehaviorHandle,type ExcelCellCandidateAction} from './row-behaviors';
import {buildListContext,buildTableContext,buildSelectionContent,selectionLabel,MAX_SELECTION_CONTENT_COLS,MAX_SELECTION_CONTENT_ROWS,type ExcelSelectionCell} from './chat-context';
import {mountDbCapabilities,type DbCapabilityHandle} from './db-capability-ui';
import {mountExcelDomainActions} from './domain-actions';
// ★ fast 那边加的：保存队列（串行化写入，避免并发写互相顶掉版本）。
import { ManagedSaveQueue } from './save-queue';

declare const RENDER: Record<string, (page: { mod: string; host: HTMLElement; signal: AbortSignal }) => unknown>;

const PAGE_LENGTH = 100;

// T08 动作事实上报：观察到的 UI 事件上报给 B 的权威日志。
// 来源由 B 认证，这里只报事实，不自建日志表、不判来源。
// 信封按 B 的约定：op_id（业务对账）+ idempotency_key（技术去重）分开。
// 失败留可见痕迹（控制台警告 + 内存待重报队列），不静默吞掉。
const _pendingActionFacts: Array<{ opId: string; idempotencyKey: string; body: string; retries: number }> = [];

async function reportActionFact(event: {
  opId: string;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
}) {
  // op_id 管业务对账（一次操作一个）；idempotency_key 管技术去重（一次上报尝试一个）。
  // 同一次操作重试（立刻重发）→ 同 op_id + 同 idempotency_key
  // 同一次操作补报（事后发现没报上）→ 同 op_id + 新 idempotency_key
  const idempotencyKey = `fact-${event.opId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const body = JSON.stringify({
    payload: {
      op_id: event.opId,
      action: event.action,
      target: event.target || '',
      detail: event.detail || {},
      client_timestamp: Date.now(),
    },
    confirmed: true,
    idempotency_key: idempotencyKey,
    source: 'user',
  });
  try {
    const r = await fetch('/api/platform/actions/files.action_fact/execute', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.warn(`[action_fact] 上报被拒 op_id=${event.opId} action=${event.action} HTTP ${r.status}: ${text.slice(0, 200)}`);
      _pendingActionFacts.push({ opId: event.opId, idempotencyKey, body, retries: 0 });
    }
  } catch (error) {
    // 业务流程照常走，但失败要留可见痕迹
    console.warn(`[action_fact] 上报失败 op_id=${event.opId} action=${event.action}: ${(error as Error).message || error}`);
    _pendingActionFacts.push({ opId: event.opId, idempotencyKey, body, retries: 0 });
  }
}

/** 补报积压的 action_fact（打开表/切表时顺手调一次）。最多重试 3 次，超了丢弃并警告。
 *  补报换新 idempotency_key（同 op_id），否则平台以为已处理直接跳过。 */
async function flushPendingActionFacts() {
  while (_pendingActionFacts.length) {
    const item = _pendingActionFacts[0];
    if (item.retries >= 3) {
      console.warn(`[action_fact] 重报超限丢弃 op_id=${item.opId}（${item.retries} 次）`);
      _pendingActionFacts.shift();
      continue;
    }
    item.retries++;
    // 补报换新 idempotency_key（同 op_id）
    const newKey = `fact-${item.opId}-r${item.retries}-${Date.now().toString(36)}`;
    const rebody = item.body.replace(/"idempotency_key":"[^"]*"/, `"idempotency_key":"${newKey}"`);
    try {
      const r = await fetch('/api/platform/actions/files.action_fact/execute', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: rebody,
      });
      if (r.ok) {
        _pendingActionFacts.shift();
      } else {
        break;  // 还是拒，下次再试
      }
    } catch {
      break;  // 网络不通，下次再试
    }
  }
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'conflict';

interface PendingOp {
  key: string;
  name: string;
  rowIndex: number;
  fieldId: string;
  fieldLabel: string;
  /** 列类型：决定提交成 number 还是 string，也决定 xlsx 发什么类型化值。 */
  fieldType: string;
  /** 提交给服务端的值：数值列是 number，其余是 string。 */
  value: string | number | null;
  /** 格子里显示用的文本。 */
  text: string;
  before: string;
  expectedModified: string;
  state: SaveState;
  message: string;
  /** 未收到可信回执时不可直接放弃；先用原编号核实。 */
  uncertain?: boolean;
  /** Optional domain-owned confirmation action, executed by the same save queue. */
  domainAction?:ExcelCellCandidateAction;
  /**
   * 这笔是**撤回产生的保存**。
   * 撤回本身存完不能再变成新的撤回目标 —— 否则再按一次 Cmd+Z 就成了「重做」，
   * 「只撤一步」当场破功（2026-10-11 A21 就这么红的）。
   */
  isUndo?: boolean;
  /**
   * 在途保存被撤回时置位。等 runSave **落地后**再写反向值。
   * 不能只拨画布 —— 在途请求会照常落盘，屏幕显示旧值、服务器存新值，是假成功。
   */
  undoAfterSave?: boolean;
}

interface SearchHit {
  name: string;
  rowIndex: number;
  fieldId: string;
  fieldLabel: string;
  snippet: string;
}

const g = globalThis as unknown as {
  createToolWorkspace?: (host: HTMLElement, opts: { signal?: AbortSignal }) => any;
  shangshuRegisterPages?: (ids: string[], meta: Record<string, unknown>) => unknown;
  shangshuRegisterNav?: (items: Record<string, unknown>[]) => unknown;
  /** 工作台全局通知（app.js:89），右下角绿/红 toast。 */
  toast?: (title: string, sub?: string, kind?: string) => void;
  /**
   * 产品壳的助手上下文（real-chat.js）。
   * **Excel 域以前一个都没发** —— 助手不知道用户开着哪张表，只能自己猜
   * （2026-10-19 A16：答了另一张同内容的表的旧值）。这里把表身份报上去。
   */
  chatSetBusinessContext?: (context: Record<string, unknown>) => void;
  chatClearContext?: () => void;
};


/**
 * 找出命中落在哪一列。找不到也**不能把整条丢掉**——
 * 服务端说有就是有，丢掉会让用户以为「无匹配」。
 */
/**
 * 找出一行里**所有**命中的格（不是只挑一个）。
 * 同一行有 3 处命中就该跳 3 次 —— 2026-10-11 moniter 复审「一行只挑一个」。
 */
function findAllHits(row: RecordRow, term: string, columns: GridColumn[]) {
  const needle = term.toLowerCase();
  const hits: Array<{ fieldId: string; fieldLabel: string; snippet: string }> = [];
  for (const column of columns) {
    const text = String(row[column.fieldId] ?? '');
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const from = Math.max(0, at - 8);
    const to = at + needle.length + 16;
    hits.push({
      fieldId: column.fieldId,
      fieldLabel: column.label,
      snippet: (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : ''),
    });
  }
  return hits;
}

function mountExcelPage(host: HTMLElement, signal: AbortSignal): void {
  const ui = g.createToolWorkspace ? g.createToolWorkspace(host, { signal }) : null;

  /**
   * 唯一的弹出提示通道：工作台右下角 toast。
   *
   * 以前还留着 `ui.notify` 兜底 —— 它写的是 `#notice` 节点，**本页根本没建这个节点**，
   * 于是兜底永远静默，等于一条假的第二通道。用户 2026-10-11 明确「所有的提示都放到
   * toast 里面」，就把它删掉：本页只此一处弹出提示区，不留第二套。
   * 注意：toast() 只认 kind==='error'，传别的（包括 'err'）一律渲染成绿色成功。
   */

  const notify = (message: string, kind: 'info' | 'error' | 'success' = 'info') => {
    const isError = kind === 'error';
    if (typeof g.toast === 'function') {
      g.toast(isError ? '出错了' : '提示', message, isError ? 'error' : 'success');
    } else if (isError) {
      // toast 不可用时至少别把错误吞掉（本页实际总有 toast，这里是极端兜底）。
      console.error(message);
    }
  };

  /**
   * D8: 按失败原因给不同的通知文案，不许几种原因共用同一条。
   * 用户 2026-10-12「现在把几个不同的原因导致的同一个后果用同一个通知显现出来了」。
   */
  function describeError(text: string): string {
    if (/只能撤回本人|撤回本人发起/i.test(text)) {
      return '只能撤回本人发起的操作。如需纠正他人的值，直接修改即可';
    }
    // BASE967-31 消费侧：403 拒因原文不许翻译 ——「字段『amount』没有写权限」比「无权限」更能定位
    // 不再统一翻译成「这个账号没有这张表的结构管理权」，保留原文
    if (/只读|readonly|read-only/i.test(text)) {
      return '这张表是只读的，不能修改';
    }
    // B6: 并发写冲突回 417「文件已被其他操作修改」（以前假 404 已修死）
    if (/已被.*修改|字段定义已变化|内容版本|结构版本|冲突|conflict|417/i.test(text)) {
      return `版本冲突：${text}。请刷新后重试，你输入的内容已保留`;
    }
    if (/无组织归属|先.*补归属|不能按组织共享/i.test(text)) {
      return `${text}。需先通过受管入口补归属，再进行共享操作`;
    }
    if (/表头已存在|表头不能为空/i.test(text)) {
      return text;   // 已经是具体原因，不用再包一层
    }
    if (/网络|超时|timeout|network|fetch/i.test(text)) {
      return `网络问题：${text}。输入已保留，请检查网络连接`;
    }
    return text;
  }

  host.classList.add('excel-page');
  const icon = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  host.innerHTML = `
    <header class="excel-bar">
      <button type="button" class="btn btn-ghost excel-back" data-back hidden title="返回表列表（保留搜索和筛选）">${icon('<path d="m10 6-6 6 6 6M4 12h16"/>')}<span>返回列表</span></button>
      <h1 class="excel-title" data-title title="点击改表名">Excel 表格</h1>
      <input class="excel-title-input" data-title-input hidden placeholder="输入新表名…">
      <div class="excel-toolrow" role="toolbar" aria-label="表格常用操作">
      <div class="excel-toolgroup" role="group" aria-label="编辑">
        <button type="button" class="btn excel-undo" data-undo title="撤回本人最近一步（本次打开最多三步，Cmd/Ctrl+Z）">${icon('<path d="M9 5 4 10l5 5M4 10h9a6 6 0 0 1 0 12"/>')}<span>撤回</span></button>
        <button type="button" class="btn" data-find-replace title="在整张表里查找并替换内容：可区分大小写，可只替换整格一致的">${icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>')}<span>查找替换</span></button>
        <div class="excel-toolmenu" data-edit-menu>
          <button type="button" class="btn excel-toolmenu-toggle" data-edit-toggle aria-haspopup="true" aria-expanded="false" title="更多编辑操作：选择性粘贴、填充序列">${icon('<path d="M4 6h16M4 12h16M4 18h16"/>')}<span>编辑</span></button>
          <div class="excel-toolmenu-dropdown" data-edit-dropdown role="menu" hidden>
            <button type="button" role="menuitem" data-paste-special title="粘贴时只贴值、只贴公式或只贴格式（源是你刚复制的那块区域）">选择性粘贴</button>
            <button type="button" role="menuitem" data-fill-series title="按等差、日期、列表或复制，填充选中的一列或一行">填充序列</button>
          </div>
        </div>
      </div>
      <div class="excel-toolgroup excel-font-group" data-font-group role="group" aria-label="选区字体">
        <label class="excel-font-size-label"><span class="sr-only">字号（磅）</span><select data-font-size aria-label="字号（磅）" title="字号（磅），修改选中单元格"></select></label>
        <label class="excel-font-color-label" title="字体颜色"><span aria-hidden="true">A</span><input type="color" data-font-color value="#374151" aria-label="字体颜色"></label>
        <button type="button" class="btn excel-font-bold" data-font-bold aria-label="加粗" aria-pressed="false" title="加粗选中单元格">B</button>
        <button type="button" class="btn excel-font-italic" data-font-italic aria-label="斜体" aria-pressed="false" title="斜体选中单元格"><em>I</em></button>
        <button type="button" class="btn excel-font-underline" data-font-underline aria-label="下划线" aria-pressed="false" title="给选中单元格加下划线"><u>U</u></button>
      </div>
      <div class="excel-toolgroup" role="group" aria-label="结构">
        <button type="button" class="btn" data-structure title="插入、移动、删除行列；删除的行可以恢复">${icon('<path d="M3 6h18M3 12h18M3 18h18M9 3v18"/>')}<span>行列</span></button>
        <button type="button" class="btn" data-auto-fit title="按这一列的内容自动算宽度（适合宽度）">${icon('<path d="M4 4v16M8 4v10M12 4v13M16 4v8M20 4v16"/>')}<span>适应列宽</span></button>
        <div class="excel-toolmenu" data-structure-menu>
          <button type="button" class="btn excel-toolmenu-toggle" data-structure-toggle aria-haspopup="true" aria-expanded="false" title="更多表格操作：字段权限">${icon('<path d="M5 12h14M13 6l6 6-6 6"/>')}<span>表格</span></button>
          <div class="excel-toolmenu-dropdown" data-structure-dropdown role="menu" hidden>
            <button type="button" role="menuitem" data-field-permissions title="设置哪些角色能读这一列、能改这一列、能下载这一列">字段权限</button>
            <button type="button" role="menuitem" data-table-permissions title="设置整张表谁能读、能改、能下载（全局／部门／个人）">表权限</button>
          </div>
        </div>
      </div>
      <!--
        ★ fast 那边加的「文件操作」下拉（走 files.sheet_structure / sheet_sort / sheet_style
          三个受管动作：插删行列、整表排序、选区格式）。
        ⚠️ 属性名用 data-fileops-*，**不叫 data-structure-menu** ——
          「表格」下拉已经占了 data-structure-menu/data-structure-dropdown（ours 侧 FIX-37 的工具栏改版），
          同名会让 querySelector 取错元素、点外面关菜单也关错。
          这组按钮的 data-file-operation 名沿用 fast 那边（脚本 office-manual-browser.mjs 按它点）。
      -->
      <div class="excel-toolmenu" data-fileops-menu>
        <button type="button" class="btn excel-toolmenu-toggle" data-fileops-toggle aria-haspopup="true" aria-expanded="false" title="文件操作：插入/删除行列、整表排序、选区格式">文件操作 ▾</button>
        <div class="excel-toolmenu-dropdown" data-fileops-dropdown role="menu" hidden>
          <button type="button" role="menuitem" data-file-operation="insert-row">在当前行前插入</button>
          <button type="button" role="menuitem" data-file-operation="delete-rows">删除选中行…</button>
          <button type="button" role="menuitem" data-file-operation="insert-column">在当前列前插入…</button>
          <button type="button" role="menuitem" data-file-operation="delete-columns">删除选中列…</button>
          <button type="button" role="menuitem" data-file-operation="sort-asc">当前列升序（整表）</button>
          <button type="button" role="menuitem" data-file-operation="sort-desc">当前列降序（整表）</button>
          <button type="button" role="menuitem" data-file-operation="bold">选区加粗</button>
          <button type="button" role="menuitem" data-file-operation="normal">取消选区加粗</button>
          <button type="button" role="menuitem" data-file-operation="number">选区金额格式</button>
          <button type="button" role="menuitem" data-file-operation="date">选区日期格式</button>
          <button type="button" role="menuitem" data-file-operation="wrap">选区自动换行</button>
          <button type="button" role="menuitem" data-file-operation="border">选区全部边框</button>
        </div>
      </div>
      <div class="excel-toolgroup" role="group" aria-label="格式">
        <select data-number-format aria-label="数字或日期显示格式"><option value="">选择显示格式</option><option value="General">常规</option><option value="0">整数</option><option value="0.00">两位小数</option><option value="#,##0">千分位整数</option><option value="#,##0.00">金额（两位小数）</option><option value="0%">百分比</option><option value="0.00%">百分比（两位）</option><option value="yyyy-mm-dd">日期</option><option value="yyyy-mm-dd hh:mm:ss">日期与时间</option></select>
        <button type="button" class="btn" data-wrap-text title="切换选区自动换行并保存">${icon('<path d="M3 6h18M3 12h13M3 18h9M16 9l3 3-3 3"/>')}<span>自动换行</span></button>
        <button type="button" class="btn" data-border-open title="给选区加边框：外框、内框、单边，可选线型与颜色">${icon('<path d="M4 4h16v16H4z"/><path d="M4 10h16M10 4v16"/>')}<span>边框</span></button>
        <button type="button" class="btn" data-style-more title="更多格式：填充色、文字对齐、清除格式">${icon('<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>')}<span>更多格式</span></button>
      </div>
      <div class="excel-toolgroup" role="group" aria-label="数据">
        <button type="button" class="btn" data-relation title="把本表某一列与另一张表关联起来">${icon('<path d="M9 15l6-6M10.5 6.5 12 5a4 4 0 0 1 5.7 5.7l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-5.7-5.7l1.5-1.5"/>')}<span>关联</span></button>
        <button type="button" class="btn excel-column-filter-tool" data-column-filter title="给选中的这一列加筛选：列头会出现一个小漏斗，点它打开筛选面板">${icon('<path d="M3 5h18l-7 8v6l-4 2v-8z"/>')}<span>筛选</span></button>
        <div class="excel-toolmenu" data-data-menu>
          <button type="button" class="btn excel-toolmenu-toggle" data-data-toggle aria-haspopup="true" aria-expanded="false" title="更多数据操作：个人视图、排序">${icon('<path d="M3 5h18l-7 8v6l-4 2v-8z"/>')}<span>数据</span></button>
          <div class="excel-toolmenu-dropdown" data-data-dropdown role="menu" hidden>
            <button type="button" role="menuitem" data-personal-view title="设置这张表的个人筛选与冻结">我的表格视图</button>
            <button type="button" role="menuitem" data-sort-asc title="按选中列升序（本次查看）">升序</button>
            <button type="button" role="menuitem" data-sort-desc title="按选中列降序（本次查看）">降序</button>
            <button type="button" role="menuitem" data-sort-reset title="恢复文件原行顺序">原顺序</button>
          </div>
        </div>
      </div>
      <div class="excel-search" role="search">
        ${icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>')}
        <input type="search" data-search-input placeholder="在本表内搜索" aria-label="在本表内搜索">
        <button type="button" data-search-prev title="上一个命中（Shift+Enter）" aria-label="上一个命中" disabled hidden>${icon('<path d="m6 14 6-6 6 6"/>')}</button>
        <button type="button" data-search-next title="下一个命中（Enter）" aria-label="下一个命中" disabled hidden>${icon('<path d="m6 10 6 6 6-6"/>')}</button>
        <span class="excel-search-count" data-search-count></span>
        <button type="button" data-search-clear hidden title="关闭查找（Esc）" aria-label="关闭查找">${icon('<path d="m6 6 12 12M18 6 6 18"/>')}</button>
      </div>
      <button type="button" class="btn excel-export" data-export hidden title="导出这张表的当前已保存内容">${icon('<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>')}<span>导出</span></button>
      <!--
        ★ 「全部确认」审核条的落点（用户 2026-10-26 决议①：暂存只是暂时存，
          正式值还没改 ⇒ 必须有一个**一眼看得见**的「全部确认」入口）。
          放在工具条这一行的**最右端**（margin-left:auto 靠右对齐）——
          与公共壳 review-batch.js 的「右上角 全部确认」一个位置感，
          但**这一份是域内的**（公共壳那份的能力白名单不含那个域自己的
          example.notice.project_to_case ⇒ 那条提案在公共壳里没有这个入口）。
          mountReviewBar 自己往里画（一条提案一组），这里只留个空壳。
      -->
      <div data-review-bar style="margin-left:auto"></div>
      </div>
    </header>
    <div class="excel-body">
      <div class="excel-picker" data-picker hidden></div>
      <div class="excel-grid" data-grid></div>
      <div class="excel-loading" data-open-loading hidden>
        <p class="excel-loading-status" role="status" aria-live="polite">正在加载表格…</p>
        <div class="excel-loading-sheet" aria-hidden="true">
          <div class="excel-loading-headers" data-loading-headers><span></span>${Array.from({length:8},()=>'<span><i></i></span>').join('')}</div>
          <div class="excel-loading-grid" data-loading-grid>${Array.from({length:8},()=>'<div><span></span>'+Array.from({length:8},()=>'<span></span>').join('')+'</div>').join('')}</div>
        </div>
      </div>
    </div>
    <div class="excel-save-state" data-save-state hidden>
      <span class="excel-scope-text" data-scope hidden></span>
      <span role="status" data-foot></span>
      <button type="button" class="btn" data-retry hidden>重试原操作</button>
      <button type="button" class="btn" data-open-retry hidden>重新加载</button>
      <button type="button" class="btn btn-ghost" data-discard hidden>放弃修改</button>
    </div>
    <!-- D1: 保存遮罩 + 进度条 -->
    <div class="excel-save-overlay" data-save-overlay hidden>
      <div class="excel-save-overlay-content">
        <div class="excel-save-progress" data-save-progress></div>
        <div class="excel-save-overlay-text" data-save-overlay-text>保存中…</div>
      </div>
    </div>
  `;

  const el = {
    structure:host.querySelector('[data-structure]') as HTMLButtonElement,
    // ★ 合并说明：fast 那边的「文件操作」下拉原本叫 data-structure-menu/-toggle/-dropdown，
    //   但 ours 的 FIX-37 工具栏改版已经把「表格」下拉占了那三个名字 ⇒ 这里改用 data-fileops-*，
    //   免得两个下拉互相取错元素。菜单里的按钮属性名 data-file-operation 沿用 fast 原样
    //   （scripts/office-manual-browser.mjs 按它点）。
    fileopsMenu:host.querySelector('[data-fileops-menu]') as HTMLElement,
    fileopsToggle:host.querySelector('[data-fileops-toggle]') as HTMLButtonElement,
    fileopsDropdown:host.querySelector('[data-fileops-dropdown]') as HTMLElement,
    borderOpen:host.querySelector('[data-border-open]') as HTMLButtonElement,
    fieldPermissions:host.querySelector('[data-field-permissions]') as HTMLButtonElement,
    tablePermissions:host.querySelector('[data-table-permissions]') as HTMLButtonElement,
    personalView:host.querySelector('[data-personal-view]') as HTMLButtonElement,
    columnFilter:host.querySelector('[data-column-filter]') as HTMLButtonElement,
    sortAsc: host.querySelector('[data-sort-asc]') as HTMLButtonElement,
    sortDesc: host.querySelector('[data-sort-desc]') as HTMLButtonElement,
    sortReset: host.querySelector('[data-sort-reset]') as HTMLButtonElement,
    back: host.querySelector('[data-back]') as HTMLButtonElement,
    undo: host.querySelector('[data-undo]') as HTMLButtonElement,
    fontGroup: host.querySelector('[data-font-group]') as HTMLElement,
    fontSize: host.querySelector('[data-font-size]') as HTMLSelectElement,
    fontColor: host.querySelector('[data-font-color]') as HTMLInputElement,
    fontBold: host.querySelector('[data-font-bold]') as HTMLButtonElement,
    fontItalic: host.querySelector('[data-font-italic]') as HTMLButtonElement,
    fontUnderline: host.querySelector('[data-font-underline]') as HTMLButtonElement,
    styleMore: host.querySelector('[data-style-more]') as HTMLButtonElement,
    autoFit: host.querySelector('[data-auto-fit]') as HTMLButtonElement,
    findReplace: host.querySelector('[data-find-replace]') as HTMLButtonElement,
    pasteSpecial: host.querySelector('[data-paste-special]') as HTMLButtonElement,
    fillSeries: host.querySelector('[data-fill-series]') as HTMLButtonElement,
    export: host.querySelector('[data-export]') as HTMLButtonElement,
    title: host.querySelector('[data-title]') as HTMLElement,
    searchInput: host.querySelector('[data-search-input]') as HTMLInputElement,
    searchPrev: host.querySelector('[data-search-prev]') as HTMLButtonElement,
    searchNext: host.querySelector('[data-search-next]') as HTMLButtonElement,
    searchCount: host.querySelector('[data-search-count]') as HTMLElement,
    searchClear: host.querySelector('[data-search-clear]') as HTMLButtonElement,
    grid: host.querySelector('[data-grid]') as HTMLElement,
    loading: host.querySelector('[data-open-loading]') as HTMLElement,
    openRetry: host.querySelector('[data-open-retry]') as HTMLButtonElement,
    picker: host.querySelector('[data-picker]') as HTMLElement,
    saveState: host.querySelector('[data-save-state]') as HTMLElement,
    scope: host.querySelector('[data-scope]') as HTMLElement,
    foot: host.querySelector('[data-foot]') as HTMLElement,
    retry: host.querySelector('[data-retry]') as HTMLButtonElement,
    discard: host.querySelector('[data-discard]') as HTMLButtonElement,
    titleInput: host.querySelector('[data-title-input]') as HTMLInputElement,
    searchBar: host.querySelector('.excel-search') as HTMLElement,
    saveOverlay: host.querySelector('[data-save-overlay]') as HTMLElement,
    saveOverlayText: host.querySelector('[data-save-overlay-text]') as HTMLElement,
    reviewBar: host.querySelector('[data-review-bar]') as HTMLElement,
  };

  // 只表达加载状态，不创建假行/字段；到首屏真实值装入后才让位给网格。
  function setOpenLoading(loading:boolean) {
    host.setAttribute('aria-busy', String(loading));
    el.loading.hidden = !loading;
    if (loading) {
      el.openRetry.hidden = true;
      el.foot.classList.remove('excel-state-error');
      el.foot.textContent = '';
    }
  }
  setOpenLoading(false);

  /**
   * 「全部确认」审核条（用户 2026-10-26 决议①）。
   *
   * 落在**工具条最右端**（模板里那个空壳）—— 一眼看得见，不藏在右键里。
   * 条里一条提案一组：**待审 / 暂存 / 已核对**三个计数 ＋「全部确认」按钮。
   */
  const reviewBar = el.reviewBar ? mountReviewBar(el.reviewBar) : null;

  // 字号下拉框的常用档位（Excel 的做法：常用字号直接选，不用打数字）。
  // 后面 `updateToolbar` 会把当前格的字号补进去（不在常用档位时也能原样显示）。
  {
    const doc=el.fontSize?.ownerDocument;
    if(doc)for(const size of [8,9,9.75,10,11,12,14,16,18,20,22,24,28,36,48,72]){
      const o=doc.createElement('option');
      o.value=String(size);o.textContent=String(size);
      el.fontSize.append(o);
    }
  }

  let disposed = signal.aborted;
  /**
   * 独立模式（?standalone=1）：这张表**有自己的入口**（人从侧栏直接点进来），
   * 所以不渲染「返回列表」——清单页跟这次打开无关。
   *
   * 为什么不是「这张表不要返回口」而是「这次打开不要返回口」：
   * 「表格」入口是清单页 → 人从清单进表，回得去才合理（搜索和筛选要带回去）。
   * 两种打开方式共用同一个工作面 ⇒ 用地址参数区分，不改清单页的行为。
   */
  const standaloneMode = standaloneFromSearch(location.search);
  let grid: GridHandle | null = null;
  let gridRowCapacity=0;
  let table: UnifiedTable | null = null;
  /**
   * 受管对象（业务表）的八项能力（新增／导出／历史／回收站／导入／粘贴／筛选／建表）。
   *
   * 业务表的交互已经换成 Excel ⇒ 表格中心独有的能力必须在**这一页**补齐。
   * 批量粘贴在 `backend.ts` 的业务表后端里（它要行身份）；其余在这里。
   */
  let dbCapabilities:DbCapabilityHandle|null=null;
  /** 当前这张业务表的**服务端**元数据（能力闸的来源；换表要换）。 */
  let dbObjectMeta:unknown=null;
  /**
   * 业务表（db）的**服务端**筛选条件。
   *
   * 为什么存在页面这边（不在后端表对象里）：重开同一张表（写完刷新、结构动作后）
   * 会**换一个新的表对象** ⇒ 条件放在表对象里会丢 ⇒ 用户筛完改一格，条件就没了。
   * 换表（key 变了）才清空。
   */
  let dbFilters:Record<string,unknown>={};
  /** 已经定位过的记录（重开同一张表不用再定位一次、也不用再报一次）。 */
  let recordLocated:string|null=null;
  /**
   * 清单当前状态：搜过的词 + 铺开了几张。
   *
   * 为什么要有：开表是整页导航到 `?object=…`（F5 要能回到同一张表，这个不能丢），
   * 页一换，「搜过什么、翻到第几屏」就没了。用户 2026-10-11 原话
   * 「我点开一张表就回不去了」——他说的不只是没有返回键，回去了也是一张空白清单。
   * 所以开表时把这两样一起写进 URL 带过去，返回时再带回来。
   */
  let directory: ReturnType<typeof mountDirectory> | undefined;
  let columns: GridColumn[] = [];
  let totalRows = 0;
  /** PKG-004：已晋升列的表头名集合（从 promotion_definition 填充）。 */
  let promotedColumns: Set<string> = new Set();
  /**
   * **受管列的列头样式待办**（2026-10-29 用户口径：白字绿底）。
   * ⚠️ **为什么要单独记一份**：受管列清单是**异步**来的（`files.promotion_definition`），
   *   常常**早于**网格建好（`createGrid`）⇒ 那时调 `setManagedColumns` 是**空操作**
   *   ⇒ 记下来，**网格建好之后**再设一次（样式才真的生效）。
   */
  let pendingManagedHeaders: string[] = [];
  /**
   * **必填列的列头待办**（2026-10-29 用户口径：「把要用的列列成必填，不允许空着」
   * ⇒ 那一列的**列头上要有看得见的必填标记**）。
   * ⚠️ **为什么要单独记一份**：跟受管列一样 —— 必填清单是**异步**来的
   *   （`files.promotion_definition`），常常**早于**网格建好 ⇒ 那时调是**空操作**
   *   ⇒ 记下来，**开表之后**再设一次（标记才真的生效）。
   * ⚠️ **后端已经挂好了**（`columns[].rules.required`）⇒ 这里只**认**它，不自己编一份。
   */
  let pendingRequiredHeaders: string[] = [];
  /**
   * **必填列的身份**（表头名 ＋ 字段 id）（2026-10-30 用户口径：「空的必填格要框红」）。
   * ⚠️ **表头名与字段 id 不是一回事**（受管列的字段 id 是 `case_direction` 这种）
   *   ⇒ 画框按**字段 id**（网格样式就是按它设的）⇒ 这里两个都记着。
   */
  let requiredColumns: RequiredColumn[] = [];
  /** PKG-004：最近一次写入的值来源（'db' | 'file'），diag 暴露给测试。 */
  let lastWriteSource: 'db' | 'file' | null = null;
  /** PKG-004：promotion_definition fetch 调试信息。 */
  let promoDebug: string = 'not-called';
  /** BASE967-50：当前排序列 + 方向。null = 未排序（按原始行序）。 */
  let tableSort: { column: string; direction: 'asc' | 'desc' } | null = null;
  /**
   * BASE967-50：服务端排序**接通且成功过一次**才置 true。
   * 「有 sort 方法」不等于「服务端认这个动作」——B 的接口没交时调用会 417，
   * 那时若已经标 editable，诊断口就是在骗人（同 ⑨ 结构入口那次的教训）。
   * 所以判据放在**真实成功**之后：editable ⟺ 服务端真的回过行标识。
   */
  let tableSortWired = false;
  let sorting = false;

  /**
   * 选区里的格 → 内容段要带的「行名 · 列名 · 值」（2026-10-21）。
   *
   * · **行名**：那一行的业务标识（记录名/行号）；拿不到就写「（没有行名）」——**不许编**；
   * · **列名**：选中格的表头（列名不是秘密，但**值要按读权裁**）；
   * · **值**：取**正式值**（不是显示格式）——服务端按当前身份重读时才对得上。
   *
   * 只报**当前用户屏幕上看得见**的格：没加载的行、空格子一律不带。
   */
  function readSelectionCells() {
    const range = grid?.getSelectionRange();
    if (!range) return [];
    const cells: ExcelSelectionCell[] = [];
    const endRow = Math.min(range.endRow, range.startRow + MAX_SELECTION_CONTENT_ROWS - 1);
    const endCol = Math.min(range.endCol, range.startCol + MAX_SELECTION_CONTENT_COLS - 1);
    for (let row = range.startRow; row <= endRow; row++) {
      const rowName = String(indexToName.get(row) || '');
      for (let col = range.startCol; col <= endCol; col++) {
        const column = columns[col];
        if (!column) continue;
        const value = cellValueAt(row, col);
        if (value === '') continue;               // 空格子屏幕上也是空的 ⇒ 不带
        cells.push({ rowName, columnName: String(column.label || ''), value });
      }
    }
    return cells;
  }
  /** 一格的**正式值**（页面缓存里那一行的那个字段；没这行就当没有）。 */
  function cellValueAt(rowIndex: number, colIndex: number): string {
    const column = columns[colIndex];
    if (!column) return '';
    const page = pageCache.get(Math.floor(rowIndex / PAGE_LENGTH) + 1);
    const name = indexToName.get(rowIndex);
    const row = page?.find(item => item.name === name);
    if (!row) return '';
    return String((row as Record<string, unknown>)[column.fieldId] ?? '');
  }

  /**
   * Excel 页 → 助手：报出「用户现在看着哪张表」。
   *
   * 以前 Excel 域**从不发**上下文（`chatSetBusinessContext` 全仓零调用），
   * 助手不知道用户开着哪张表，只能自己挑一张 —— 2026-10-19 A16 实测：
   * 界面显示 10.5，助手答 88.88（那是另一张同内容表的旧值）。
   *
   * 这里报**身份**（表 ID、表名、工作表、当前选区）**＋当前选区里那几格的内容**
   * （行名 · 列名 · 值，2026-10-21）——**不替助手读表**：
   * 事实仍旧由助手用工具重查（读口走合并读，晋升列以数据库正式值为准）。
   *
   * 回清单时换成**清单级**上下文：用户没打开表，助手就不许自己挑一张。
   */
  function syncChatContext(mode?: 'list' | 'table') {
    if (typeof g.chatSetBusinessContext !== 'function') return;
    if (mode === 'list' || !table) {
      g.chatSetBusinessContext(buildListContext() as unknown as Record<string, unknown>);
      return;
    }
    const selection = grid?.getSelectionRange() || null;
    const context = buildTableContext({
      key: table.key,
      title: table.title,
      kind: table.kind,
      sheet: table.sheetTitle,
    }, {
      selection: selectionLabel(selection),
      // 内容段：**当前选区里看得见的那几格**（行名 · 列名 · 值）。
      content: buildSelectionContent(readSelectionCells(), {
        entityType: table.kind === 'db' ? String(table.key) : 'files.file',
        entityId: String(table.key),
        readTable: String((table as { resourceId?: string }).resourceId || table.key),
        storageKind: table.kind,
      }),
    });
    if (context) g.chatSetBusinessContext(context as unknown as Record<string, unknown>);
  }

  /**
   * BASE967-50 排序驱动。**排完必须把可见行序映射回稳定行**，否则写请求会写错行。
   *
   * 做法：服务端回**排好序的全表行标识**，据此重建 `indexToName`。
   * **不按当前页位置重编号** —— 位置是显示概念，row_id 是身份概念，
   * 拿位置当身份等于凭空造了一堆不存在的行（计划 §五 A.5）。
   *
   * 排完要重画当前页：pageCache 里存的是「取数时那页的行」，排序后位置全变了，
   * 旧 cache 不清会把排前的行画到排后的位置上。
   */
  async function applyServerSort(column: string, direction: 'asc' | 'desc' | null) {
    if (!table || sorting) return;
    if (hasUnsaved() || grid?.isEditing()) { notify('请先完成当前编辑再排序','info'); return; }
    const destination=table;
    if (typeof table.sort !== 'function') {
      notify('排序还没接上服务端，不能只在当前页排（会漏掉没加载的行）', 'error');
      return;
    }
    sorting=true; el.grid.inert=true; updateToolbar();
    try {
      el.scope.textContent = `按「${column}」${direction === 'asc' ? '升序' : '降序'}排序中…`;
      const result = direction ? await table.sort({ column, direction }) : await table.clearSort!();
      if (disposed || destination!==table) return;
      pageGeneration++;
      grid?.setRows([...filled].map(rowIndex=>({rowIndex,values:columns.map(()=>''),cellTypes:columns.map(()=>'empty'),cellStyles:columns.map(()=>undefined)})));
      // 行身份映射：排后第 i 行 = 服务端给的第 i 个 row_id。
      indexToName.clear();
      nameToIndex.clear();
      result.orderedRowIds.forEach((id, i) => {
        indexToName.set(i, id);
        nameToIndex.set(id, i);
      });
      table.totalRows = result.totalRows;totalRows=result.totalRows;
      tableSort = direction ? { column, direction } : null;
      tableSortWired = true;
      // 旧页码不再对应当前行序，清掉重画，否则排前的行会留在排后的位置。
      pageCache.clear();
      loadingPages.clear();
      filled.clear();
      // —— 排序 ⇒ 行序全变 ⇒ **框红的那本账也要清**（否则旧行序的框留在新行序上）——
      requiredEmptyLedger.clear();
      await loadPage(1);
      grid?.scrollToRow(0,0);
      grid?.selectCell(0,Math.max(0,columns.findIndex(c=>c.fieldId===column)));
    } catch (error) {
      // 排序失败**不静默**：说清没排成功，也不改 tableSortWired（能力仍未证实接通）
      notify(`排序没成功：${(error as Error).message}`, 'error');
    } finally {
      sorting=false; el.grid.inert=false; updateToolbar();
      renderScope();
    }
  }
  /**
   * 保存一份**个人视图**（筛选 / 排序 / 冻结），然后按它重画这张表。
   *
   * 「我的表格视图」弹窗和列头筛选面板**共用这一条** ——
   * 两边存的是同一份 view（`files.sheet_view_save`），行为必须一致。
   */
  async function applyPersonalView(view: PersonalView) {
    if (!table?.savePersonalView) throw Error('这张表不支持个人视图');
    const destination = table;
    sorting = true; el.grid.inert = true; updateToolbar();
    try {
      const result = await destination.savePersonalView!(view);
      if (disposed || table !== destination) return;
      pageGeneration++;
      grid?.setRows([...filled].map(rowIndex => ({rowIndex, values: columns.map(()=>''), cellTypes: columns.map(()=>'empty'), cellStyles: columns.map(()=>undefined)})));
      indexToName.clear(); nameToIndex.clear();
      result.rows.forEach((row, i) => { indexToName.set(i, row.row_id); nameToIndex.set(row.row_id, i); });
      tableSort = result.view.sort || null; totalRows = result.total_rows;
      pageCache.clear(); loadingPages.clear(); filled.clear(); requiredEmptyLedger.clear();
      await loadPage(1);
      grid?.setFreeze(result.view.freeze.rows, result.view.freeze.columns);
      grid?.scrollToRow(0, 0);
    } finally {
      sorting = false; el.grid.inert = false; updateToolbar(); renderScope();
      columnFilterOverlay?.refresh();
    }
  }
  /** 已装填的行号；未装填的行就是「当前未加载记录」。 */
  const filled = new Set<number>();
  const nameToIndex = new Map<string, number>();
  const indexToName = new Map<number, string>();
  const pageCache = new Map<number, RecordRow[]>();
  const loadingPages = new Map<number, Promise<RecordRow[]>>();
  /**
   * 业务表的八项能力挂上去（工具栏里那一组「业务表」按钮）。
   *
   * 能力闸 fail-closed：服务端说不支持 ⇒ 按钮置灰并把原因写在 title 里，
   * 不做成「按钮在、点了报不支持」。
   */
  try{
    dbCapabilities=mountDbCapabilities({
      host,
      ui,
      signal,
      table:()=>{const current=table;return current?{key:current.key,title:current.title,kind:current.kind,columnValues:current.columnValues?column=>current.columnValues!(column):undefined}:null;},
      meta:()=>dbObjectMeta as never,
      isAdmin:()=>typeof (globalThis as any).currentRole==='function'&&(globalThis as any).currentRole()==='admin',
      selectedRowId:()=>{const selection=grid?.getSelection();return selection?(indexToName.get(selection.rowIndex)??null):null;},
      notify:(message,kind)=>notify(message,kind==='error'?'error':kind==='success'?'success':'info'),
      reload:async()=>{await rebuildAfterStructure();},
      filters:()=>dbFilters,
      setFilters:(next)=>{dbFilters=next;table?.setFilters?.(next);},
    });
  }catch(error){
    /* 挂不上就把话**说出来**（不静默）—— 少了这八项能力，用户得知道。 */
    console.error('[excel] 业务表能力挂载失败', error);
    notify(`业务表能力挂载失败：${(error as Error).message}`,'error');
  }
  let pageGeneration = 0;
  const viewportReads = new ViewportReadScheduler(loadPage, error => {
    if (!disposed) notify(`表格加载失败：${(error as Error).message}。请重新滚动重试。`, 'error');
  });
  const pending = new Map<string, PendingOp>();
  const pendingFileOperations=new Map<string,{state:SaveState;message:string;uncertain:boolean;run:()=>Promise<void>}>();
  /**
   * A3: 三步值撤回栈 —— 最多存 3 笔**成功保存**的单格修改，Cmd+Z 撤最近的。
   *
   * 四次连续成功修改只能撤最近三次（第 4 笔被挤出栈底）。
   * 保存不清栈；关闭/刷新/切表清栈。Assistant/自动化/撤回自身不进栈。
   * 保存失败的**不进这里** —— 失败的那笔走「重试原操作」，不是撤回。
   */
  let undoStack: Array<{
    kind?: 'style'|'structure';
    undoAction?:'companion';
    name: string;
    rowIndex: number;
    fieldId: string;
    fieldLabel: string;
    fieldType: string;
    /** 改之前的值 —— 显示用。B5 撤回走服务端，不传这个值。 */
    before: string;
    /** 改之后的值。 */
    after: string;
    /** 操作编号（= 写入的 idempotency_key）。B5 撤回按它定位。 */
    opId: string;
    /** G5 批量操作信息：自动扩展的行/列数。撤回时一并移除。 */
    batchExpand?: {
      rowsAdded: number;
      colsAdded: number;
      /** 粘贴时写入的全部格子（恢复用） */
      cells: Array<{ rowId: string; header: string; before: string }>;
    };
  }> = [];
  let undoing = false;
  let structuring = false;
  /**
   * Cmd+Z 的三个计数，给诊断口看 —— 判断「按键到底有没有走到我们这里」，
   * 不靠猜。少了它们，「按了没反应」和「没接到键盘事件」看起来一模一样。
   */
  let undoKeyPresses = 0;
  let undoEditDiscards = 0;
  let undoRuns = 0;
  /** 没有撤回目标时按下的次数 —— 用来分清「我们没动」和「别的东西动了那格」。 */
  let undoNoTarget = 0;
  /**
   * 列宽写回的在途操作。和单元格写同一条三态口径、同一个「重试原操作」按钮——
   * 用户点的是一次「保存」，不该分两条队列各说各话。
   */
  const pendingWidths = new Map<string, { key: string; colIndex: number; widthPx: number; state: SaveState; message: string }>();
  /**
   * BASE08 保存队列 —— 按用户动作顺序串行执行 runSave。
   * 不串行的话，连续两格快打字：A 和 B 同时读到 contentVersion=1，
   * A 先成功（version→2），B 后到 expected_content_version=1 被 417 拒。
   * 用户看到的现象是「打第二个字报冲突」，实际是并发竞态。
   */
  /**
   * 合并说明：ours 这边用 promise 链串行保存；fast 那边用 ManagedSaveQueue
   *   （同一把操作编号只排一次；失败/未知时**暂停**后续保存，重试同一闭包和编号后才继续）。
   * 两条都留：用队列做串行与去重，用 promise 让调用方能 await 到这一笔落定。
   */
  // 保存队列与 enqueueSave 只保留**一处**实现（见本文件后面 runSave 上方那份）：
  // 那里同时装了 fast 的 ManagedSaveQueue 语义（去重、结果不明时暂停）
  // 和 ours 的保存链语义（await 到这一笔落定、已放弃的笔不再写）。
  const inlineControllers=new Map<string,InlineReviewController>();
  let candidateOverlay:ReturnType<typeof mountCandidateOverlay>|null=null;
  let headerRename:ReturnType<typeof mountHeaderRename>|null=null;
  /** **长按列头拖动挪位置**（2026-10-29 用户口径）—— 与「双击改列名」各走各的。 */
  let columnDrag:ReturnType<typeof mountColumnDrag>|null=null;
  /**
   * **候选**（2026-10-29 用户口径）：候选为空的那几行 ⇒ 算出的候选**盖在那一格原处**、
   * **变蓝**、**点一下就写进去**（**只确认一次**）。
   * ⚠️ **只读表不挂**（挂了也点不动 —— 挂着只会让人以为能确认）。
   */
  let rowBehaviors:ExcelRowBehaviorHandle|null=null;
  /** 列头筛选的小漏斗浮层（FIX-49）。 */
  let columnFilterOverlay:ReturnType<typeof mountColumnFilterOverlay>|null=null;
  /** 受管列的**常驻角标**（PKG-004-T03 第 4 步）：列头左端标出「这一列背后是受管记录」。 */
  /** 用户点过「筛选」的列 ⇒ 列头给它画小漏斗。 */
  const filterColumns=new Set<string>();
  let exportCapabilities: ExportCapabilities | null = null;
  /** 「结果未明的文件操作」要**二次确认**才真放弃（免得手滑丢一笔）。 */
  let discardFileOpsConfirmed=false;
  /**
   * 「能不能改这张表的结构」——**问表自己**（`sheet_read` 回的 `my_access.structure`，
   * **开表那一刻就有了**），**不问「导出能力探测」**。
   *
   * ⚠️ 为什么（用户 2026-10-29 14:5x：「粘贴也要行，输入也要行」）：
   *   `exportCapabilities` 是**异步**探的（`files.versions`），而且**失败时错误被吞掉**
   *   （`.catch(()=>{})`）⇒ 它可以一直是空 ⇒ 拿它当闸 ⇒
   *   **开表后手一快，拖列/改列名/越界写入就是死的**，
   *   而人看到的是「没有结构编辑权限」——**说错了原因**（权限其实有）。
   * ⚠️ **业务表（db）没有「结构」这套东西** ⇒ 一律不给。
   */
  const canChangeStructure=()=>table?.kind==='xlsx'&&table.canStructure===true;

  /**
   * —— **挪列的预览**（2026-10-29 15:0x 用户口径：「以前那种挪动就很自然」）——
   *
   * 拖动的时候**画布上先挪给用户看**（那一列跟着鼠标走到新位置），
   * 松手才落库。⚠️ **落点按「按下那一刻」的列序算**（画布上的顺序在变，
   * 用变了的顺序算落点会越拖越乱）。
   */
  let columnDragOrder: GridColumn[]|null=null;
  /** 预览前的列序（取消时挪回来）。 */
  let columnPreviewBackup: GridColumn[]|null=null;
  /** 预览中（这一段时间不许写格子：格子按列序找字段，预览的顺序会写错行）。 */
  let columnPreviewing=false;

  /** 按新的列序把**已装填的行**重画一遍（只重画，不重算候选、不重新取数）。 */
  function repaintColumnOrder(){
    grid?.adoptColumns(columns.map(c=>({...c})));
    grid?.setColumnHeaders([...columns.map(c=>c.label),...Array(20).fill('')]);
    for(const [page,rows] of pageCache){
      const base=(page-1)*PAGE_LENGTH;
      grid?.setRows(rows.map((row,i)=>{
        const fallback=columns.map(column=>table?.cellStyle?.(row.name,column.fieldId));
        return {
          rowIndex:base+i,
          values:columns.map(column=>{const raw=row[column.fieldId];return raw===null||raw===undefined?'':raw as string|number;}),
          cellTypes:columns.map(column=>getRowViewMetadata(row)?.types[column.fieldId]),
          formulas:columns.map(column=>getRowViewMetadata(row)?.formulas?.[column.fieldId]),
          cellStyles:columns.map((column,index)=>getRowViewMetadata(row)?.styles?.[column.fieldId]??fallback[index]),
        };
      }));
    }
  }

  /** 预览：把那一列挪到新位置（画布上先挪给用户看，还没落库）。 */
  function previewColumnOrder(header:string,beforeHeader:string){
    const base=columnDragOrder??columns;
    const order=base.map(c=>c.fieldId);
    const nextIds=reorderByMove(order,header,beforeHeader);
    if(nextIds.length!==order.length||nextIds.every((id,i)=>id===order[i]))return;
    const next=nextIds;
    const byId=new Map(base.map(c=>[c.fieldId,c]));
    const nextColumns=next.map(id=>byId.get(id)).filter(Boolean) as GridColumn[];
    if(nextColumns.length!==base.length)return;
    if(nextColumns.every((c,i)=>c.fieldId===base[i].fieldId))return;   // 跟原来一样 ⇒ 不用重画
    columnPreviewBackup??=columns.slice();
    columnPreviewing=true;
    columns=nextColumns;
    repaintColumnOrder();
  }

  async function moveColumnInPersonalView(header:string,before:string){
    const destination=table;
    if(!destination?.savePersonalView)throw Error('这张表不支持个人视图');
    const base=(columnDragOrder??columnPreviewBackup??columns).map(column=>column.fieldId);
    const order=reorderByMove(base,header,before);
    const view=grid?.getViewState();
    sorting=true;el.grid.inert=true;updateToolbar();
    try{
      await destination.savePersonalView!({...destination.personalView?.view??emptyPersonalView(),columns:order.filter(id=>!unreadableColumns().has(id))});
      if(disposed||table!==destination)return;
      columnPreviewBackup=null;columnPreviewing=false;columnDragOrder=null;
      columns=destination.columns;
      await rebuildAfterStructure();
      if(view)grid?.restoreViewState(view);
      notify('列顺序已保存到个人视图','success');
    }catch(error){
      // The save may have committed before its receipt was lost. Read the
      // official view instead of replaying with a new key or restoring old order.
      if(!disposed&&table===destination&&destination.loadPersonalView){
        try{
          await destination.loadPersonalView();
          columnPreviewBackup=null;columnPreviewing=false;columnDragOrder=null;
          columns=destination.columns;
          const recovered=columns.map(column=>column.fieldId);
          await rebuildAfterStructure();
          if(view)grid?.restoreViewState(view);
          if(recovered.length===order.length&&recovered.every((id,index)=>id===order[index])){
            notify('列顺序已保存到个人视图','success');return;
          }
        }catch{ /* Preserve the original error if the read is also unavailable. */ }
      }
      restoreColumnOrder();throw error;
    }
    finally{sorting=false;el.grid.inert=false;updateToolbar();}
  }

  /**
   * 预览作废（按 Esc／拖完没挪）⇒ 把画布上的预览挪回原位，**并且状态一律复位**。
   *
   * ⚠️ **为什么「一律」复位**（真事故：2026-10-29 15:2x）：
   *   预览期间 `hasUnsaved()` 是真的（页面以为有未保存修改）⇒
   *   不复位的话，**挪完列之后整张表写不进去**：粘贴被拒（「还有未保存修改」）、
   *   打字被拒、下拉选了没反应 ⇒ 人看着就是「怎么都不行」，刷新一下又好了。
   */
  function restoreColumnOrder(){
    if(columnPreviewBackup){
      columns=columnPreviewBackup;
      repaintColumnOrder();
    }
    columnPreviewBackup=null;
    columnPreviewing=false;
    columnDragOrder=null;
  }
  let canManageFieldPermissions = false;
  /**
   * 表级权限的管理权（PKG-117-T01）。
   *
   * ⚠️ 与 `canManageFieldPermissions` **分开**：表级不必依赖「有已晋升列」
   * （还没晋升任何列的表也能先把整张表的权限定下来）。
   */
  let canManageTablePermissions = false;
  let pasteApplying = false, exporting = false, openingTable = false;
  let tableOpenGeneration = 0;
  let openRetryTarget: {key:string;source?:'db'|'xlsx'} | null = null;
  type InputOp={matrix:string[][];row:number;col:number;fieldId:string;before:string;rowId?:string;dispatched?:boolean;attempted?:boolean;uncertain?:boolean;discardable?:boolean;discardConfirmed?:boolean;key:string;state:SaveState;message:string;target:UnifiedTable;expectedContentVersion?:number;expectedStructureVersion:number};
  let pendingInput:InputOp|null=null;
  const inputQueue:InputOp[]=[];
  let inputDraining=false;
  /**
   * **「明确没写进去」的最后一笔**（2026-10-30 · PKG-133 · 浏览器走查撞出来的缺陷③）。
   *
   * ⚠️ **为什么单独记一份**：
   *   「结果确定没写进去」的失败**当场从队列里拿掉**（`drainInputs` 里 `op.discardable` 那条）
   *   —— 那个改动是对的：它**不堵着后面那几笔**（队首是 failed ⇒ 整队停下 ⇒
   *   列宽／拖列／撤回／导出全被禁 ⇒ 人以为那些功能坏了）。
   *   ⚠️ **但它把「放弃修改」这个出口一起拿掉了**：按钮只认**队列里**的 `pendingInput`
   *   ⇒ 那一笔不在队列里 ⇒ **按钮不出现** ⇒ 人**既不能重试、也不能放弃**
   *   ⇒ 提示条却说「后续输入已保留，请重试原操作」（实际没保留、也没有按钮可点）
   *   ⇒ 格子里还留着那个**没存进去**的值（输入这条路既不重读正式值、也不登记未完成操作）。
   * ⇒ 现在：**不占队列**（继续不堵后面几笔），但**记一份在这儿**
   *   ⇒ 「放弃修改」按钮照旧出现、点了照旧重读正式值、撤回栈照旧不涨。
   */
  let lastDiscardableFailure:InputOp|null=null;
  type PendingStyle = {key:string;cells:StyleTarget[];style:FontStylePatch;target:UnifiedTable;expectedContentVersion:number;expectedStructureVersion:number;state:SaveState;message:string};
  let pendingStyle:PendingStyle|null=null;
  let savingRowHeights=false;
  const downloadUrls = new Set<string>();
  signal.addEventListener('abort', () => {
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
  }, { once: true });
  const hasUnsaved = () => structuring || sorting || savingRowHeights || columnPreviewing || pending.size > 0 || pendingWidths.size > 0 || pasteApplying || undoing || pendingStyle !== null || pendingInput !== null || !!headerRename?.isBusy() || [...inlineControllers.values()].some(controller=>controller.busy);
  /**
   * 这一列在**已加载的行**里有没有值。
   * 关联列必须是空白列（后端会拒「请使用空白列配置关联」），
   * 这里先把能查到的部分查出来，让界面提前拦住，而不是等保存时才被拒。
   */
  function columnHasValues(fieldId:string):boolean{
    for(const rows of pageCache.values())for(const row of rows){
      const value=(row as Record<string,unknown>)[fieldId];
      if(value!==null&&value!==undefined&&String(value)!=='')return true;
    }
    return false;
  }
  /**
   * 工具栏下拉菜单（FIX-37）。
   * Excel 的交互逻辑：低频操作收进一个下拉，**点外面关掉、按 Esc 关掉**——
   * 下拉是浮在界面上的，不关掉就会挡住下面的表格。
   */
  const toolMenus:HTMLElement[]=[];
  function closeToolMenus(){
    for(const menu of toolMenus){
      const dropdown=menu.querySelector<HTMLElement>('[data-edit-dropdown],[data-structure-dropdown],[data-data-dropdown],[data-fileops-dropdown]');
      const toggle=menu.querySelector<HTMLElement>('.excel-toolmenu-toggle');
      if(dropdown)dropdown.hidden=true;
      if(toggle)toggle.setAttribute('aria-expanded','false');
    }
  }
  function openToolMenu(menu:HTMLElement){
    const wasOpen=!menu.querySelector<HTMLElement>('.excel-toolmenu-dropdown')?.hidden;
    closeToolMenus();
    if(wasOpen)return;
    const dropdown=menu.querySelector<HTMLElement>('.excel-toolmenu-dropdown');
    const toggle=menu.querySelector<HTMLElement>('.excel-toolmenu-toggle');
    if(dropdown)dropdown.hidden=false;
    if(toggle)toggle.setAttribute('aria-expanded','true');
  }
  for(const key of ['edit','structure','data','fileops']){
    const menu=host.querySelector<HTMLElement>(`[data-${key}-menu]`);
    if(!menu)continue;
    toolMenus.push(menu);
    const toggle=menu.querySelector<HTMLElement>('.excel-toolmenu-toggle');
    toggle?.addEventListener('click',event=>{event.stopPropagation();openToolMenu(menu);},{signal});
    /* 点菜单里的某一项 ⇒ 关掉菜单，再做那件事 */
    menu.querySelector('.excel-toolmenu-dropdown')?.addEventListener('click',event=>{
      if((event.target as HTMLElement).closest('button'))closeToolMenus();
    },{signal});
  }
  /* 点外面 ⇒ 全部关掉 */
  host.addEventListener('click',event=>{
    if(!(event.target as HTMLElement).closest('.excel-toolmenu'))closeToolMenus();
  },{signal});
  /* Esc ⇒ 全部关掉 */
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){closeToolMenus();closeDropdowns();}
  },{signal});
  /* FIX-38：弹窗里的自绘下拉 —— 点外面也关掉。
     弹窗在 top-layer（原生 <dialog>），事件照样冒泡到 document。 */
  document.addEventListener('click',event=>{
    if(!(event.target as HTMLElement).closest('.excel-dropdown'))closeDropdowns();
  },{signal});

  /**
   * 当前选中的那一列（列头筛选用）。
   * 没有选区就**按第一列**算 —— 与旁边的「升序 / 降序」同一个口径
   * （`selectedSortColumn` 也是没有选区就取第 0 列），别让两个入口行为不一致。
   */
  function selectedColumnId(): string | undefined {
    const selected = grid?.getSelection();
    return columns[selected ? selected.colIndex : 0]?.fieldId;
  }
  /**
   * 当前用户**读不到**的列（被升列成受字段 ACL 保护的正式字段）。
   * 不可读的格在数据里显示成「无权查看」（adapter 的 flattenRow），据此判断。
   * FIX-47：不可读的列**不该出现在筛选选项里** —— 让用户选一个自己都看不到的列、
   * 白跑一趟保存，是白让人添堵。
   */
  function unreadableColumns(): Set<string> {
    const unreadable = new Set<string>();
    for (const rows of pageCache.values()) for (const row of rows) for (const column of columns) {
      if (row[column.fieldId] === '无权查看') unreadable.add(column.fieldId);
    }
    return unreadable;
  }
  function updateToolbar() {
    const ready = !!table && !!grid && !openingTable;
    // FIX-37：这两项现在收在下拉菜单里。下拉里的条目**不整项消失** ——
    // 消失了用户就以为没这个功能；改成置灰 ＋ 标题写清楚为什么，
    // 用户才知道「有这个功能，只是我没权限/这张表没开」。
    el.fieldPermissions.disabled=!canManageFieldPermissions||!ready||hasUnsaved();
    el.fieldPermissions.title=!canManageFieldPermissions?'没有管理字段权限的角色':!ready?'这张表还没打开':'设置每一列谁能看、能改、能下载（全局／部门／个人）';
    // 表权限（PKG-117-T01）：整张表的权限 —— **不必有已晋升列**才能设。
    // ⚠️ 两道守卫（与下面「业务表能力」那条同规矩）：`updateToolbar` 这条函数
    //    **会被单独抽出来**在判据沙箱里跑 ⇒ 沙箱里没有这个按钮、也没有这个能力变量
    //    ⇒ 不许让整条判据炸在 ReferenceError 上。
    if(el.tablePermissions){
      const canTablePermissions=typeof canManageTablePermissions!=='undefined'&&canManageTablePermissions;
      el.tablePermissions.disabled=!canTablePermissions||!ready||hasUnsaved();
      el.tablePermissions.title=!canTablePermissions?'没有管理字段权限的角色':!ready?'这张表还没打开':'设置整张表谁能看、能改、能下载（全局／部门／个人）';
    }
    // 行列入口**常驻**：以前没结构权就直接藏起来，用户以为这功能不存在。
    // 现在照样显示，点下去会说明为什么不能改（而不是让人猜）。
    el.structure.hidden=false;el.structure.disabled=!ready||hasUnsaved();
    el.structure.title=!table?.canStructure?'这张表暂未开放行列调整（需要表结构修改权限）':'插入、移动、删除行列；删除的行可以恢复';
    el.personalView.disabled=!table?.savePersonalView||!ready||hasUnsaved();
    el.personalView.title=!table?.savePersonalView?'这张表不支持保存个人筛选与冻结':!ready?'这张表还没打开':'设置这张表的个人筛选与冻结';
    // 列头筛选（FIX-49）：要有个人视图能力（筛选存个人视图）。
    // 没选区就按**第一列**算（与旁边的升序/降序同一口径）⇒ 这里不按选区开关。
    // ⚠️ 业务表（db）走的是**服务端**筛选（条件进 GET 的 filters），
    //    不存个人视图 ⇒ 这里要放行，让它能开（闸由 db-capability-ui 那边把关）。
    const dbTable=table?.kind==='db';
    el.columnFilter.disabled=dbTable?!ready||hasUnsaved():!table?.savePersonalView||!ready||hasUnsaved();
    el.columnFilter.title=dbTable
      ?(!ready?'这张表还没打开':'按这一列精确筛选（服务端按整表算，不是只筛已加载的那几行）')
      :(!table?.savePersonalView?'这张表不支持个人筛选（筛选结果存在个人视图里）':!ready?'这张表还没打开':'给选中的这一列加筛选：列头会出现一个小漏斗，点它打开筛选面板');
    // FIX-37：排序按钮收进「数据」下拉了，但**下拉里那几项还要按状态开关**：
    // 没排序能力就不给看（原来靠整组 hidden），没保存能力就禁用。
    el.sortAsc.hidden=el.sortDesc.hidden=!table?.sort;
    el.sortAsc.disabled=el.sortDesc.disabled=!ready||hasUnsaved();
    el.sortReset.disabled=!ready||hasUnsaved()||!tableSort;
    el.undo.disabled = !ready || !undoStack.length || undoing || hasUnsaved();
    el.export.hidden = !exportCapabilities?.available;
    el.export.disabled = !ready || exporting || hasUnsaved();
    el.export.title = hasUnsaved() ? '还有未保存修改，请先保存或处理失败' : '导出这张表的当前已保存内容';
    el.export.querySelector('span')!.textContent = exporting ? '导出中…' : '导出';
    const canStyle=ready && table?.writable && !!table.writeStyle;
    el.fontSize.disabled=el.fontColor.disabled=el.fontBold.disabled=!canStyle || hasUnsaved();
    el.fontItalic.disabled=el.fontUnderline.disabled=el.styleMore.disabled=!canStyle || hasUnsaved();
    el.styleMore.title=canStyle?'填充色、文字对齐、清除格式':'此表暂未接入可保存的单元格格式';
    el.autoFit.disabled=!ready||hasUnsaved()||!table?.writeLayout;
    el.autoFit.title=table?.writeLayout?'按选中列的内容自动算宽度':'此表暂不支持自动算列宽';
    el.borderOpen.disabled=!canStyle || hasUnsaved();
    el.borderOpen.title=canStyle?'给选区加边框：外框、内框、单边，可选线型与颜色':'此表暂未接入可保存的单元格格式';
    el.fontGroup.title=canStyle?'修改选区字体；一次操作可撤回':'此表暂未接入可保存的单元格格式';
    el.title.classList.toggle('can-rename', canChangeStructure());
    el.title.title = canChangeStructure() ? '双击修改表名' : '表名';
    /* 业务表的八项能力按钮（新增/导出/导入/历史/回收站/建表/筛选）——
       闸在 db-capability-ui 里按服务端元数据判，这里只刷新显示状态。
       ⚠️ `typeof` 守卫：`updateToolbar` 这条函数**会被单独抽出来**在判据沙箱里跑
       （shangshu-server/tests/website/excel-toolbar-ux.test.ts）⇒ 那个沙箱里
       没有「业务表能力」这一项 ⇒ 不许让整条判据炸在 ReferenceError 上。 */
    if(typeof dbCapabilities!=='undefined')dbCapabilities?.update();
  }
  let searchSeq = 0;
  /** 当前命中序列与游标；空数组表示没在查找。 */
  let hits: SearchHit[] = [];
  let hitIndex = -1;
  let searchTerm = '';
  let searchPage = 0;
  let searchTotalRows = 0;
  let searchLoadedRows = 0;
  let searchLoading = false;
  /** strip_notice 是否已显示过（每次开表只提示一次）。 */
  let stripNoticeShown = false;
  let dropHighlight: (() => void) | null = null;

  function renderScope() {
    if (!table) { el.scope.textContent = '加载中…'; return; }
    /* 业务表（db）的筛选条件在**服务端** ⇒ 有条件时说「筛选显示」，
       让人知道看到的是筛出来的那些，不是全表。 */
    const dbFilterCount=Object.keys(dbFilters).filter(key=>!key.startsWith('$')).length;
    const filtered=table.personalView?.view.filters.length?true:dbFilterCount>0;
    el.scope.textContent=`${filtered?"筛选显示":"共"} ${totalRows} 行${table.personalView?.view.filters.length?" / 全表 "+table.personalView.source_total_rows+" 行":""} · 已加载 ${filled.size} 行 · 搜索范围：全表有权列`;
  }

  /** Pending input stays visible until its original operation is resolved. */
  function renderSaveBar() {
    // 合并说明：ours 这边显示「输入队列」状态（单格输入待核实/保存中）；
    // fast 那边把所有待办（保存/列宽/文件操作）按状态分色汇总。
    // 两条都留：先看输入队列（更细），没有输入队列时看汇总。
    const paused=!!pendingInput&&['failed','conflict'].includes(pendingInput.state);
    // ⚠️ **「明确没写进去」的那一笔不在队列里**（它被拿掉了，免得堵着后面几笔）
    //   ⇒ 但**「放弃修改」的出口要留着**（2026-10-30 · PKG-133 · 缺陷③）：
    //   人改完那一格之后如果发现**没存进去**，得有个地方能把它**放弃掉**（重读正式值）。
    //   ⚠️ **结果不明的**（`uncertain`）**不给**这个出口 —— 那一笔可能已经写进库里了
    //   ⇒ 放弃＝丢数据 ⇒ 只给「重试原操作」（同一把幂等键，服务端去重，天然是「核实」）。
    //   ⚠️ **`discardable` 本身就是「结果确定没写进去」那一位**（写失败那处算的，
    //   里面有 4xx／未尝试的判定）⇒ **这里不要再自己加条件**（加了就等于把这个出口藏起来）。
    const discardableFailure=lastDiscardableFailure&&!lastDiscardableFailure.uncertain
      ?lastDiscardableFailure:null;
    el.saveState.hidden=inputQueue.length===0&&!discardableFailure&&pending.size+pendingWidths.size+pendingFileOperations.size===0;
    if(inputQueue.length){
      el.foot.textContent=paused?`有 ${inputQueue.length} 笔输入待核实：${pendingInput?.message}`:`正在保存 ${inputQueue.length} 笔输入…`;
      el.retry.hidden=!paused;el.discard.hidden=!(paused&&pendingInput?.discardable);
      el.discard.textContent=pendingInput?.discardConfirmed?'确认放弃这些未保存输入':'放弃被拒的输入';
    }else if(discardableFailure){
      // —— 队列空了，但有「明确没写进去」的那一笔 ⇒ 状态条**只说这一件事**（不装作没事）。
      el.foot.textContent=`刚才那笔输入没有存进去：${discardableFailure.message||'服务端拒了'}。可以放弃它、按正式值重读。`;
      el.retry.hidden=true;
      el.discard.hidden=false;
      el.discard.textContent=discardableFailure.discardConfirmed?'确认放弃':'放弃被拒的输入';
    }else{
      const allOps = [...pending.values(), ...pendingWidths.values(), ...pendingFileOperations.values()];
      const saving = allOps.filter((op) => op.state === 'saving').length;
      const conflicts = allOps.filter((op) => op.state === 'conflict').length;
      const failed = allOps.filter((op) => op.state === 'failed').length;
      const total = allOps.length;
      const stuckCount = conflicts + failed;
      // A4: 分状态显示——在途黄、冲突橙、失败红，让用户知道哪类卡住了
      const parts: string[] = [];
      if (saving) parts.push(`<span class="excel-state-saving">${saving} 笔保存中</span>`);
      if (conflicts) parts.push(`<span class="excel-state-conflict">${conflicts} 笔版本冲突</span>`);
      if (failed) parts.push(`<span class="excel-state-failed">${failed} 笔保存失败</span>`);
      el.foot.innerHTML = total
        ? `有 ${total} 笔未完成操作：${parts.join('、')}${stuckCount ? '。<button type="button" class="btn btn-link" data-retry-inline>重试原操作</button>' : '。'}`
        : '';
      el.retry.hidden = stuckCount === 0;
      el.discard.hidden = stuckCount === 0;
      // 内联重试按钮（在状态文字里）也接上
      el.foot.querySelector('[data-retry-inline]')?.addEventListener('click', () => el.retry.click());
    }
    ui?.guardLeave?.(()=>{
      /* ⚠️ **只在「确实还有东西在飞」时才拦人**（用户 2026-10-29 15:4x 现场：
         「刷新页面也不能，显示有东西未完成」⇒ **连刷新都被拦，人被锁死在里面**）。
         · **在飞**（saving）的那几笔 ⇒ 拦（它可能正在写进去）。
         · **失败／冲突**的那几笔 ⇒ **没写进去**（重开以服务端正式值为准）⇒
           **不许拦人**：它们只会把人困住，工作本身没丢（服务端有操作编号可核）。
         · 输入队列同理：**还在飞的那笔拦，已经被拒的不拦**。 */
      const decision=decideLeaveTable({
        inputStates:inputQueue.map(op=>op.state),
        pendingStates:[...pending.values()].map(op=>op.state),
        pendingWidthStates:[...pendingWidths.values()].map(op=>op.state),
        pendingFileOpStates:[...pendingFileOperations.values()].map(op=>op.state),
        editing:!!grid?.isEditing(),
      });
      if(decision.allow)return true;
      notify('还有未保存的修改，请先保存或重试。','error');
      return false;
    });
  }

  /**
   * D3 静默保存：不在顶栏显示「已保存/未修改/保存中」状态字。
   * 成功 = 什么都不弹；失败 = 弹一次说清原因（由调用方 notify）。
   * 状态写在 foot 的 data 属性上（不显示），供测试检测保存完成。
   */
  function setSaveState(state: SaveState, message: string) {
    el.foot.dataset.saveState = state;
    el.foot.dataset.saveMsg = message;
    renderSaveBar();
    updateToolbar();
  }

  /**
   * **「空的必填格」自检 ＋ 框红**（2026-10-30 用户口径）。
   *
   * ⚠️ **每一次刷新都要重算一次**（用户原话：「**每一次刷新都自检一下**必填列有没有被填入，
   *   没有被填入就**用红色继续框和提醒**」）⇒ 所以它**跟着读表走**（`applyRows` 之后）。
   * ⚠️ **纯渲染**（`grid.setRequiredEmptyMarks` 走 Univer 的 `highlight`）⇒
   *   **不改数据、不执行命令** ⇒ 不会存进文件、不会触发保存链。
   *
   * @param rows 刚装填的那几行（`applyRows` 手上的）
   */
  /** 当前框着红的那些格（给诊断口/判据核）—— **现算**，不在这儿存全量清单。 */
  /**
   * **要框红的那本「累积账」**（2026-10-30 用户点名的**正确性缺陷**：
   *   「翻页后前面页的红框会消失」）。
   *
   * ⚠️ **为什么不能每次覆盖**：表格中心是**按页装填**的 ——
   *   装填第 2 页时，主控手上只有**第 2 页那些行** ⇒
   *   一覆盖，第 1 页那些空的必填格就**从清单里没了** ⇒ **那些红框被摘掉**。
   * ⇒ 这本账**只进不出**：新一页并进来、填上的就地改、换表才清空。
   */
  const requiredEmptyLedger = new RequiredEmptyLedger();
  /**
   * **受管列 ＋ 必填列的清单**（从服务端那份列定义里认，**不自己编**）。
   */
  interface PromotionDefinition{
    /** 已晋升的列（表头名）。 */
    promoted: string[];
    /** 必填列（表头名 ＝ 字段 id，见下面那处注释）。 */
    required: Array<{label:string;fieldId:string}>;
  }
  /**
   * **清单缓存**（2026-10-30 用户口径：「**提前存住某处**」，
   *   保证「打开到能修改」不被装饰拖慢）。
   *
   * ⚠️ **缓存只用来「先顶上」**：晋升规则会变 ⇒ 后台**同时**拉一份新的回来
   *   ⇒ 旧清单只是**先到**，不是**最终**（新的到了就替换）。
   * ⚠️ **为什么不拿它当准**：拿它当准 ⇒ 改了晋升规则重开表还按老的画 ⇒ 会错。
   */
  const promotionDefinitionCache = new Map<string,PromotionDefinition>();
  /** 从服务端那份列清单里认出「受管列」与「必填列」。 */
  function promotionDefinitionOf(cols:any[]):PromotionDefinition{
    return {
      promoted: cols.filter((col:any)=>col.promoted===true&&!!col.header).map((col:any)=>String(col.header)),
      //   ⚠️ **fieldId 用表头名**（不是受管字段 id `case_direction`）——
      //   网格那一侧的列 `fieldId` **就是表头名**（`backend.ts` 的 `gridColumn`）
      //   ⇒ 用受管字段 id 会**找不到那一列** ⇒ 红框**画不到格子上**
      //   （而诊断口却会说「框了」—— 那是假绿）。
      required: cols.filter((col:any)=>col.promoted===true&&!!col.header&&col.rules?.required===true)
        .map((col:any)=>({label:String(col.header),fieldId:String(col.header)})),
    };
  }
  /** **把这份清单用上**：受管列绿底 ＋ 必填列星号 ＋ 空必填格框红。 */
  function applyPromotionDefinition(definition:PromotionDefinition){
    promotedColumns = new Set(definition.promoted);
    if(table)table.promotedColumns = promotedColumns;
    requiredColumns = definition.required;
    const requiredLabels = definition.required.map(item=>item.label);
    for (const column of columns) {
      if (requiredLabels.includes(column.label||column.fieldId)) column.required = true;
    }
    pendingManagedHeaders = [...definition.promoted];
    pendingRequiredHeaders = requiredLabels;
    grid?.setManagedColumns(pendingManagedHeaders);
    grid?.setRequiredColumns(pendingRequiredHeaders);
    // —— 必填清单到了 ⇒ 得**重跑一次自检**（否则第一次框红要等到下一次刷新）——
    refreshRequiredEmptyMarks(loadedRequiredValues());
  }
  /** **纯取数**（不改界面）——「受管/必填列清单」。 */
  async function fetchPromotionDefinition(tableId:string):Promise<{
    definition:PromotionDefinition; canManageFields:boolean; canManageTable:boolean; status:number;
  }|null>{
    try{
      promoDebug='fetching:'+tableId;
      const promoQuery=new URLSearchParams({payload:JSON.stringify({table:tableId})});
      const promoRes=await fetch('/api/platform/services/files.promotion_definition/invoke?'+promoQuery,{credentials:'include',signal});
      const promoBody=await promoRes.json().catch(()=>({}));
      const promoDef=promoBody?.result||promoBody||{};
      const cols=promoDef?.columns||[];
      return {
        definition:promotionDefinitionOf(cols),
        canManageFields:promoRes.ok&&promoDef.can_manage_field_permissions===true&&cols.some((c:any)=>c.promoted===true),
        canManageTable:promoRes.ok&&promoDef.can_manage_field_permissions===true,
        status:promoRes.status,
      };
    }catch(e){
      promoDebug='error:'+(e as Error).message;
      return null;
    }
  }
  function requiredEmptyMarksSnapshot():Array<{rowIndex:number;fieldId:string}> {
    return requiredEmptyLedger.marks().map(mark=>({rowIndex:mark.rowIndex,fieldId:mark.fieldId}));
  }
  function refreshRequiredEmptyMarks(rows?:Array<{rowIndex:number;values:Record<string,string>}>){
    if(!grid||!requiredColumns.length)return;
    // —— **并进来**，不是覆盖（这就是「增量」）——
    requiredEmptyLedger.merge(rows??[]);
    requiredEmptyLedger.setRequired(requiredColumns);
    // —— **只把「增量」交给装饰层**（规则与装饰层之间的通道不再每次传全量清单）——
    const delta=requiredEmptyLedger.takeDelta();
    // —— 快照**现算**（诊断口要读时才算）⇒ 不在这儿存全量清单。
    if((globalThis as any).__PERF_NO_RED_BOX)return;
    // ⚠️ **画框不许挡「能编辑」**（2026-10-30 用户要求：
    //   「进去就能编辑，**无论表格大小**」——昨晚还是能进去就编辑的 ⇒ **不许拖慢它**）。
    //   ⇒ 网格那一侧**自己分帧画**（`setRequiredEmptyMarks` 只记要画的，绘制走空闲+分帧）
    //   ⇒ 这里**只是交个清单**，不占主线程。
    grid.setRequiredEmptyMarks(delta);
  }
  /** 当前**已装填**的那些行的值（按必填列取）——自检与提醒共用这一份口径。 */
  /** 某一行的必填列取值（**只这一行**，不扫全表）。 */
  function rowRequiredValues(rowIndex:number):{rowIndex:number;values:Record<string,string>}{
    const values:Record<string,string>={};
    for(const column of requiredColumns){
      // ⚠️ **取值要安全**（拿不到就当空）：这是**提醒**（锦上添花）
      //   ⇒ 网格那一侧拿不到值时**不许把异常带出去**（否则一次读不到就把开表流程挂掉）。
      let raw:string|number|null|undefined=null;
      try{raw=grid?grid.getRowValue(rowIndex,column.fieldId):null;}catch{raw=null;}
      values[column.fieldId]=raw===null||raw===undefined?'':String(raw);
    }
    return {rowIndex,values};
  }
  function loadedRequiredValues():Array<{rowIndex:number;values:Record<string,string>}>{
    if(!grid)return[];
    const out:Array<{rowIndex:number;values:Record<string,string>}>=[];
    for(const index of filled){
      const values:Record<string,string>={};
      for(const column of requiredColumns){
        // ⚠️ **取值要安全**（拿不到就当空）：
        //   这一段是**提醒**（锦上添花）⇒ 网格那一侧拿不到值时**不许把异常带出去**
        //   —— 否则一次读不到 ⇒ 整个开表流程挂掉（**提醒功能把页面搞坏了**）。
        let raw:string|number|null|undefined=null;
        try{raw=grid.getRowValue(index,column.fieldId);}catch{raw=null;}
        values[column.fieldId]=raw===null||raw===undefined?'':String(raw);
      }
      out.push({rowIndex:index,values});
    }
    return out;
  }
  /**
   * **写保存之后的提醒**（用户口径：「在行写入保存的时候要 check 必填列是否为空，
   *   如果空了就……**toast 提醒**，但是**不强制不能保存**」）。
   *
   * ⚠️ **只提醒、不拦**：那一行**已经存进去了**（服务端那条闸已改成放行）
   *   ⇒ 提醒里要说清「可以先存，填完再补」⇒ 人不会以为存不进去。
   */
  function notifyRequiredMissing(rowIndex:number){
    if(!requiredColumns.length||!grid)return;
    const values:Record<string,string>={};
    for(const column of requiredColumns){
      let raw:string|number|null|undefined=null;
      try{raw=grid.getRowValue(rowIndex,column.fieldId);}catch{raw=null;}
      values[column.fieldId]=raw===null||raw===undefined?'':String(raw);
    }
    const missing=emptyRequiredCells([{rowIndex,values}],requiredColumns).map(mark=>mark.label);
    const text=requiredReminderText(missing);
    if(text)notify(text,'info');
  }

  function applyRows(rows:RecordRow[],startRow:number) {
    // 行身份**先**登记，再交给网格装填（2026-10-21）：
    // 装填会触发选区重报 ⇒ 助手上下文要在**这一刻**就能查到「这一行的名字与值」。
    // 原来顺序反着，助手看到的选区内容是空的（要等用户再点一下才有）。
    rows.forEach((row,i)=>{const index=startRow+i;filled.add(index);nameToIndex.set(row.name,index);indexToName.set(index,row.name);});
    grid?.setRows(rows.map((row,i)=>{
      // ★ 合并说明：ours 侧样式从**行元数据**（getRowViewMetadata）拿；
      //   fast 侧从 `table.cellStyle` 拿（后端 stylesByRow 缓存的那份）。两者指向同一份服务端样式，
      //   这里两条都留：行元数据优先，取不到再回落到 table.cellStyle。
      const fallback=columns.map(column=>table?.cellStyle?.(row.name,column.fieldId));
      return {
        rowIndex:startRow+i,
        values:columns.map(column=>{const raw=row[column.fieldId];return raw===null||raw===undefined?'':raw as string|number;}),
        cellTypes:columns.map(column=>getRowViewMetadata(row)?.types[column.fieldId]),
        formulas:columns.map(column=>getRowViewMetadata(row)?.formulas?.[column.fieldId]),
        cellStyles:columns.map((column,index)=>getRowViewMetadata(row)?.styles?.[column.fieldId]??fallback[index]),
      };
    }));
    paintPendingInputs();
    candidateOverlay?.refresh();
    // —— **候选**：新行装填进来 ⇒ 看得见的那些行算一次候选（已有值的行不算）。
    void rowBehaviors?.refresh();
    renderScope();
    // —— **空的必填格自检 ＋ 框红**（2026-10-30 用户口径：「每一次刷新都自检一下」）。
    refreshRequiredEmptyMarks(rows.map((row,i)=>{
      const values:Record<string,string>={};
      for(const column of requiredColumns){
        const raw=row[column.fieldId];
        values[column.fieldId]=raw===null||raw===undefined?'':String(raw);
      }
      return {rowIndex:startRow+i,values};
    }));
  }

  async function loadPage(pageNumber: number): Promise<RecordRow[]> {
    const cached = pageCache.get(pageNumber);
    if (cached) return cached;
    const inflight = loadingPages.get(pageNumber);
    if (inflight) return inflight;
    const destination=table, generation=pageGeneration;
    if(!destination || disposed)return [];
    const request=(async()=>{
      const result=await destination.loadPage(pageNumber,PAGE_LENGTH);
      if(disposed || destination!==table || generation!==pageGeneration)return [];
      pageCache.set(pageNumber,result.rows);
      totalRows=result.total;
      const base=(pageNumber-1)*PAGE_LENGTH;
      applyRows(result.rows,base);
      reapplyWrap(base,result.rows.length);
      renderProposals();
      return result.rows;
    })();
    loadingPages.set(pageNumber,request);
    try { return await request; }
    finally { if(loadingPages.get(pageNumber)===request)loadingPages.delete(pageNumber); }
  }

  /** Row-only extension can reuse the pre-laid grid, but only after one authoritative page proves its schema/rights. */
  async function refreshAppendedRows(startRow:number,endRow:number,expectedStructureVersion:number|undefined,savedView?:{rows:RecordRow[];total:number;meta:import('./adapter').TableMeta}):Promise<boolean>{
    if(!table||table.kind!=='xlsx'||!grid||endRow>=gridRowCapacity||Math.floor(startRow/PAGE_LENGTH)!==Math.floor(endRow/PAGE_LENGTH))return false;
    const destination=table,page=Math.floor(startRow/PAGE_LENGTH)+1;
    const fresh=savedView??await destination.loadPage(page,PAGE_LENGTH),meta=fresh.meta;
    if(disposed||table!==destination)return false;
    if(!meta||meta.tableId!==destination.key||meta.writable!==destination.writable||(expectedStructureVersion!==undefined&&meta.structureVersion!==expectedStructureVersion)||fresh.total>gridRowCapacity||meta.columns.length<columns.length||columns.some((column,index)=>(column.fieldId!==''&&meta.columns[index].header!==column.fieldId)||meta.columns[index].type!==column.type||meta.columns[index].readOnly!==column.readOnly)||JSON.stringify(meta.columnWidths)!==JSON.stringify(destination.columnWidths))return false;
    const view=grid.getViewState();
    const freshColumns=meta.columns.map(column=>({...columns.find(current=>current.fieldId===column.header),fieldId:column.header,label:column.header,type:column.type,readOnly:column.readOnly,options:column.options,allowCustom:column.allowCustom,customLabel:column.customLabel}));
    if(!grid.adoptColumns(freshColumns))return false;
    destination.columns=columns;
    grid.setColumnHeaders([...columns.map(column=>column.label),...Array(20).fill('')]);
    const oldTotal=totalRows;
    for(const cached of pageCache.keys())if(cached>=Math.floor(oldTotal/PAGE_LENGTH)+1)pageCache.delete(cached);
    pageCache.set(page,fresh.rows);totalRows=fresh.total;destination.totalRows=fresh.total;
    destination.adoptVersions?.({contentVersion:meta.contentVersion,structureVersion:meta.structureVersion});
    destination.title=meta.displayName;el.title.textContent=meta.displayName;
    const base=(page-1)*PAGE_LENGTH;applyRows(fresh.rows,base);reapplyWrap(base,fresh.rows.length);
    grid.restoreViewState(view);
    renderScope();renderProposals();return true;
  }

  /** 仅最新可见页优先；滑过的中间页不排队，不预取整段路径。 */
  function ensureLoadedAround(start: number, end: number) {
    if (!table) return;
    const lastPage=Math.max(1,Math.ceil(totalRows/PAGE_LENGTH));
    const first=Math.max(1,Math.floor(Math.max(0,start)/PAGE_LENGTH)+1);
    const last=Math.min(lastPage,Math.floor(Math.max(0,end)/PAGE_LENGTH)+1);
    const wanted:number[]=[];
    for(let page=first;page<=last;page++)if(!pageCache.has(page))wanted.push(page);
    viewportReads.schedule(wanted);
  }

  /**
   * 行号解析：已装填的直接给；否则问后端这一行在第几页（排序口径两边不同，
   * 二分还是顺序找由 backend 各自决定），再把那页装进来。
   */
  async function resolveIndex(name: string): Promise<number> {
    const known = nameToIndex.get(name);
    if (known !== undefined) return known;
    if (!table) return -1;
    if(table.kind==='xlsx' && !tableSort&&!table.personalView){
      const query=new URLSearchParams({payload:JSON.stringify({table:table.resourceId??table.key,row_ids:[name]})});
      const response=await fetch('/api/platform/services/files.sheet_read/invoke?'+query,{credentials:'include',signal});
      const body=await response.json();if(!response.ok||body?.ok===false)throw Error(body?.error||body?.message||'目标行定位失败');
      const row=(body?.result?.rows??body?.rows??[]).find((row:any)=>row.row_id===name);
      if(!row||!Number.isInteger(row.row_index)||row.row_index<2)return -1;
      const index=row.row_index-2;await loadPage(Math.floor(index/PAGE_LENGTH)+1);return nameToIndex.get(name)===index?index:-1;
    }
    const page = await table.findRowPage(name, PAGE_LENGTH);
    if (page < 0) return -1;
    const rows = await loadPage(page);
    const hit = rows.findIndex((r) => r.name === name);
    return hit >= 0 ? (page - 1) * PAGE_LENGTH + hit : -1;
  }

  const hasPending=()=>pending.size+pendingWidths.size+pendingFileOperations.size>0||!!grid?.isEditing();
  let reviewTarget:any=null;
  async function locateReviewTarget(){
    if(!table||reviewTarget?.table!==table.key||hasPending())return;
    const target=reviewTarget;reviewTarget=null;
    const row=await resolveIndex(target.unit?.row_id),col=columns.findIndex(c=>c.fieldId===target.unit?.header);
    if(disposed||row<0||col<0)return;
    grid?.selectCell(row,col);grid?.scrollToRow(row,col);dropHighlight?.();dropHighlight=grid?.highlightCell(row,col)??null;
  }
  window.addEventListener('shangshu:before-object-change',((event:CustomEvent)=>{
    if(event.detail?.object_id==='files.file'&&event.detail?.name===table?.key&&hasPending())event.preventDefault();
  }) as EventListener,{signal});
  window.addEventListener('shangshu:object-changed',((event:CustomEvent)=>{
    if(table&&event.detail?.object_id==='files.file'&&event.detail?.name===table.key&&!hasPending())void openTableByKey(table.key);
  }) as EventListener,{signal});
  window.addEventListener('shangshu:review-target',((event:CustomEvent)=>{
    if(event.detail?.module!=='excel')return;
    reviewTarget=event.detail;void locateReviewTarget();
  }) as EventListener,{signal});

  /**
   * 合并说明：ours 这边用 promise 链串行保存（BASE08：连续两格快打字不能并发写）；
   *   fast 那边用 ManagedSaveQueue —— 同一把操作编号只排一次，**结果不明**时暂停后续保存，
   *   重试同一闭包和编号后才继续。两条都留：
   *   · 队列负责串行与去重；
   *   · promise 让调用方（撤回那条反向写）能 await 到这一笔落定；
   *   · 结果不明 ⇒ 队列暂停，等用户按原编号核实/重试（fast 那边的口径）。
   */
  const saveQueue = new ManagedSaveQueue();
  /** 每一把操作编号对应的「落定」回调：重试同一把编号时也用它 resolve。 */
  const saveResolvers = new Map<string, () => void>();
  function enqueueSave(op: PendingOp): Promise<void> {
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => { settle = resolve; });
    // 同一把编号再排一次时（新的一次 enqueue），把旧回调也带上一并 resolve。
    const previous = saveResolvers.get(op.key);
    saveResolvers.set(op.key, () => { previous?.(); settle(); });
    saveQueue.add(op.key, async () => {
      try {
        // 这笔已经被放弃或顶替了（pending 里已经没有它）⇒ 不再写。
        // 没有这条保护，「放弃」按钮删掉 pending 之后队列重试会把这笔又写回去。
        if (!pending.has(op.key)) return true;
        await runSave(op);
      } finally {
        saveResolvers.get(op.key)?.();
        saveResolvers.delete(op.key);
      }
      // 结果不明 ⇒ 返回 false 让队列暂停（等「重试原操作」唤醒）；明确失败则继续下一笔。
      return !op.uncertain;
    });
    return done;
  }

  async function runSave(op: PendingOp) {
    if (disposed || !table) return;
    op.state = 'saving';
    setSaveState('saving', '保存中…');
    // D1/R4: 日常改单格不弹全屏遮罩（用户："是上传这一步有一个进度条不是改字段保存有进度条"）
    // 批量粘贴和上传才用遮罩。
    try {
      // 幂等键不换：回执丢了用同一把键重试，服务端只落一次写。
      // 合并说明：ours 这边用 retrySave 包住写入（回执丢了按原编号重试，不换编号）；
      // fast 那边先记下旧版本 previousModified（用于把同行的排队写入一起推到新版本）。两条都留。
      const destination=table;
      const previousModified = op.expectedModified;
      const result = await retrySave(()=>destination.writeCell({
        rowId: op.name,
        fieldId: op.fieldId,
        fieldType: op.fieldType,
        value: op.value,
        text: op.text,
        idempotencyKey: op.key,
        expectedModified: op.expectedModified,
        domainAction:op.domainAction,
      }),()=>!disposed&&table===destination);
      if (result.kind === 'rejected') throw new Error(result.reason || '保存被拒');
      if (typeof result.modified === 'string') {
        op.expectedModified = result.modified;
        for (const queued of pending.values()) {
          if (queued !== op && queued.name === op.name && queued.expectedModified === previousModified)
            queued.expectedModified = result.modified;
        }
        const pageRows = pageCache.get(Math.floor(op.rowIndex / PAGE_LENGTH) + 1);
        const row = pageRows?.find((r) => r.name === op.name);
        if (row) {
          row.modified = result.modified;
          // 把**保存成功的值**写回 pageCache。不写的话，任何一次重绘（懒加载重套行）
          // 都会拿旧值把画布盖回去 —— 2026-10-11 撤回就是这么「存对了却显示错」的：
          // 请求体里明明写回「A21基准值」，界面上还停在「A21要撤掉的值」。
          //
          // 键要用**扁平的 fieldId**：applyRow 读的是 `row[column.fieldId]`，
          // 不是 `row.values[...]`（backend 的 toUnifiedRow 就是拍平成顶层键的）。
          // 写进 row.values 等于写进一个没人读的口袋，重绘照样拿旧值。
          (row as Record<string, unknown>)[op.fieldId] = op.text;
        }
      }
      rowBehaviors?.cellsChanged([{rowIndex:op.rowIndex,fieldId:op.fieldId}],{saved:true});
      if(result.hasFormulas||result.refreshLoaded||wroteFormula([op.text]))await refreshLoadedFormulaValues();
      pending.delete(op.key);
      // 这一笔确实落定了 ⇒ 清掉「结果不明」的标记（否则重试成功后队列还停在暂停态）。
      op.uncertain = false;
      // PKG-004：记录值来源（'db' = 晋升列经数据库规则保存，'file' = 普通列走文件写入）
      lastWriteSource = result.valueSource ?? 'file';
      // PKG-004 仅值回填：formatUntouched=true 时只更新值（pageCache 已写），不重建格式不重渲染。
      // 否则按原逻辑检查结构版本（B 契约 §7.1.3：带便签的表首次保存会加「备注」列，structure_version +1）。
      if (result.formatUntouched) {
        // 仅值回填：setRowValue 等效的 pageCache 更新已完成，跳过 rebuildAfterStructure
      } else if (typeof result.structureVersion === 'number' && result.structureVersion !== table!.structureVersion) {
        void rebuildAfterStructure();
      }
      // A3: 记入撤回栈，最多 3 笔。失败的不记——失败走重试，不走撤回。
      // 撤回自己那笔也不记：记了再按一次就成了「重做」。
      if (!op.isUndo && !op.undoAfterSave && !undoStack.some(entry => entry.opId === op.key)) {
        undoStack.push({
          name: op.name,
          rowIndex: op.rowIndex,
          fieldId: op.fieldId,
          fieldLabel: op.fieldLabel,
          fieldType: op.fieldType,
          before: op.before,
          after: op.text,
          opId: op.key,
        });
        if (undoStack.length > 3) undoStack.shift();   // 四次连续修改只能撤最近三次
      }
      // 如果在途时被撤回了，这里补一笔反向写（等落地后再写，不和在途那笔打架）。
      if (op.undoAfterSave) {
        const reverse: PendingOp = {
          key: newIdempotencyKey(),
          name: op.name,
          rowIndex: op.rowIndex,
          fieldId: op.fieldId,
          fieldLabel: op.fieldLabel,
          fieldType: op.fieldType,
          value: op.before,   // writeCell 内部会走 toTypedValue 转类型
          text: op.before,
          before: op.text,
          expectedModified: (typeof result.modified === 'string' ? result.modified : op.expectedModified),
          state: 'saving',
          message: '',
          isUndo: true,
        };
        pending.set(reverse.key, reverse);
        // 画布拨回原值
        try {
          grid?.setRow(op.rowIndex, columns.map((c) => (
            c.fieldId === op.fieldId ? op.before : grid!.getRowValue(op.rowIndex, c.fieldId)
          )));
        } catch { /* 行未装填就跳过 */ }
        await enqueueSave(reverse);
        return;
      }
      setSaveState('saved', result.idempotent ? '已保存（原编号重试，未重复写入）' : '已保存');
      // ⚠️ **「必填列还空着」的提醒不在这里做**（2026-10-30）：
      //   这一条是**通用保存链**（普通列、格式、批量都走它）⇒ 在这里逐行自检
      //   ⇒ **每次保存都扫一遍全表**（大表上就是几千行）⇒ 把「保存」拖慢
      //   ⇒ 而且「必填」是**受管列**的事 ⇒ 该在**输入那条路**（`handleInput`）上做
      //   ⇒ 那里才知道「人正在一行一格一格填」。
      void rowBehaviors?.refresh();
      // The confirmed write Action already owns this operation's audit.
      // D3 静默保存：成功不弹提醒，只有失败才弹
    } catch (error) {
      const err = error as ApiError;
      const text = err?.message || String(error);
      const conflict = /已被修改|字段定义已变化|内容版本|结构版本/.test(text);
      op.state = conflict ? 'conflict' : 'failed';
      op.message = text;
      op.uncertain = /未知|核实|断网|网络|timeout|failed to fetch|NetworkError/i.test(text);
      setSaveState(op.state, conflict ? `冲突：${text}` : `保存失败：${text}`);
      pending.delete(op.key);
      if(!disposed){setSaveState('idle',text);grid?.setRowValue(op.rowIndex,op.fieldId,op.before);const page=Math.floor(op.rowIndex/PAGE_LENGTH)+1;pageCache.delete(page);void loadPage(page).catch(()=>{});notify(`该修改已停止，正在核对正式值：${describeError(text)}`,'error');}
    }
  }

  /**
   * 撤回刚才那一格。**只撤一步、只一格**。
   *
   * 做法是把 `undoStack` 最后一笔的 `before` 走**和普通改格同一条保存链**写回去
   * （新幂等键 + 当前版本号），不是 Univer 的本地撤销 —— 那个只改画布不落文件，
   * 值看起来回去了、文件里还是新的，是假成功。
   * 撤一笔弹一笔，最多撤三笔。
   */
  async function runUndo() {
    if (disposed || !table || undoing) return;
    if (hasUnsaved()) { notify('还有修改正在保存或未保存，请完成后再撤回', 'info'); return; }
    const target = undoStack[undoStack.length - 1];
    if (!target) {
      undoNoTarget += 1;
      notify('没有可撤回的操作。', 'info');
      return;
    }

    if(target.kind==='structure'){
      undoing=true;el.grid.inert=true;updateToolbar();
      try{await table.structureAction('structure_undo',target.opId,'struct-undo-'+target.opId);undoStack.pop();await rebuildAfterStructure();notify('结构操作已撤回','success');}
      catch(error){notify((error as Error).message,'error');}
      finally{undoing=false;el.grid.inert=false;updateToolbar();}return;
    }

    // xlsx 表统一走 B5 受管撤回（files.sheet_cells_undo）—— 单格、批量写、**粘贴成包**
    // 同一条路。用户 2026-10-14：「撤回动作要能留那个"会留下操作痕迹、会查「是不是本人操作」"」。
    // 以前粘贴成包绕开这条路（拿 paste_apply 回包的 before 值自己 writeCells 写回），
    // 是因为 sheet_cells_undo 不认 paste_apply 的 op_id —— 那个缺口 2026-10-14 已补
    // （paste_apply 落服务端操作台账 + 进 OP_ACTIONS，见 sheet.py），绕法不再需要。
    // 绕法不过审计、不查是不是本人，是拿前端绕后端缺口，不保留。
    // DB 表没有受管撤回面，回落到写回旧值（见下方）。
    if (table.kind === 'xlsx') {
      const undoTable = table;
      undoing = true;
      updateToolbar();
      try {
        const undoRequest=target.undoAction==='companion'?undoTable.companionUndoRequest?.(target.opId):{path:'/api/platform/actions/files.sheet_cells_undo/execute',payload:{table:undoTable.resourceId??undoTable.key,op_id:target.opId}};
        if(!undoRequest)throw Error('当前表撤回入口不可用');
        const response = await fetch(undoRequest.path, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            payload:undoRequest.payload,
            confirmed: true,
            idempotency_key: 'undo-' + target.opId,
            source: 'user',
          }),
          signal,
        });
        const body = await response.json();
        if (!response.ok || body?.ok === false) {
          const msg = body?.error || body?.message || `撤回失败（HTTP ${response.status}）`;
          notify(describeError(msg), 'error');
          return;
        }
        const result = body?.result || {};
        if (disposed || table !== undoTable) return;
        const applied: Array<{ row_id: string; header: string; before: unknown; after: unknown }> = result.cells || result.applied || [];
        const skipped: Array<{ row_id: string; header: string; reason: string }> = result.skipped || [];
        if (!Array.isArray(applied) || !Array.isArray(skipped)) throw new Error('撤回回执不完整，请重试原操作');
        if(target.kind==='style'){
          if(result.kind!=='style')throw Error('字体撤回回执类型不符，请核实原操作');
          for(const cell of applied)validateFontState(cell.after as CellFontStyle);
          grid?.setCellStyles(applied.flatMap(cell=>{const rowIndex=nameToIndex.get(cell.row_id);return rowIndex===undefined?[]:[{rowIndex,fieldId:cell.header,style:cell.after as CellFontStyle}];}));
        }
        if (typeof result.content_version === 'number') undoTable.adoptVersions?.({contentVersion: result.content_version, structureVersion: result.structure_version});
        // ⚠️ **撤回后要收下「退回来的那版受管记录版本」**（2026-10-29 站上实测）：
        //   撤回是**逆向写入** ⇒ 值回到上一版、**版本也回到上一版**（受管记录的版本栈）
        //   ⇒ 客户端手里那份版本**当场变新** ⇒ 下一笔会被自己的旧版本拒
        //   （人话：「记录已被修改，请刷新后重试」）⇒ 不收下就必然撞。
        if (result.record_versions) undoTable.adoptRecordVersions?.(result.record_versions);
        // 服务端确认后才消耗这一步；失败时保留原操作编号，重试使用同一幂等键。
        const undoIndex = undoStack.lastIndexOf(target);
        if (undoIndex >= 0) undoStack.splice(undoIndex, 1);
        for (const cell of applied) {
          const rowIndex = nameToIndex.get(cell.row_id);
          if (rowIndex !== undefined) {
            if(target.undoAction==='companion')continue;
            if(target.kind==='style'){
              const style=cell.after as CellFontStyle;
              const cached=pageCache.get(Math.floor(rowIndex/PAGE_LENGTH)+1)?.find(row=>row.name===cell.row_id);
              if(cached)setRowFontStyle(cached,cell.header,style);
              continue;
            }
            // 值撤回回执的 before 是已恢复值；字体撤回使用独立 after 契约。
            const raw = (cell as { before?: unknown }).before ?? cell.after;
            const typed = typeof raw === 'object' && raw !== null ? raw as { value?: string | number | null; type?: string } : undefined;
            const val = typed ? typed.value ?? '' : raw as string | number | null ?? '';
            const cached = pageCache.get(Math.floor(rowIndex / PAGE_LENGTH) + 1)?.find(row => row.name === cell.row_id);
            if (cached) cached[cell.header] = val;
            grid!.setRowValue(rowIndex, cell.header, val, typed?.type);
          }
        }
        if(target.undoAction==='companion'||needsFormulaRefresh(result.has_formulas,applied.flatMap(cell=>[cell.before,cell.after])))await refreshLoadedFormulaValues();
        grid?.recalcAutoHeights();
        for (const cell of skipped) {
          const reasons: Record<string, string> = { changed: '已被他人修改，不覆盖', already: '已是原值', missing: '行列已不存在' };
          notify(`${cell.header}：${reasons[cell.reason] || cell.reason}`, 'info');
        }
        // 粘贴成包带自动扩展时刷新显示。**扩展出来的空行/列保留** ——
        // 产品里没有删行/删列能力（A 2026-10-14 核过：rebuildAfterStructure 本来就只
        // 刷新显示、不删行列，注释写「移除自动扩展」不准确）。受管撤回只回退值。
        notify(applied.length > 0
          ? `已撤回 ${applied.length} 格${skipped.length ? `（${skipped.length} 格跳过）` : ''}`
          : '撤回无变化（可能已被他人修改或已是原值）', applied.length > 0 ? 'success' : 'info');
      } catch (error) {
        notify(describeError(String(error)), 'error');
      } finally {
        undoing = false;
        updateToolbar();
        if (!disposed) syncFontControls();
      }
      return;
    }

    // DB 表：回落到旧撤回 —— 把 before 值写回去（普通保存链）。
    /* ⚠️ **批量粘贴**（业务表）也要能撤：一批里每一格改前的值都在
       `batchExpand.cells` 里 ⇒ 逐格写回旧值（新建的行撤不了：删记录没有公开口，
       那种格子根本不该进撤回栈 —— 见下面 push 时的过滤）。 */
    if(target.fieldType==='batch'&&target.batchExpand?.cells?.length){
      undoStack.pop();
      const cells=target.batchExpand.cells;
      undoing=true;el.grid.inert=true;updateToolbar();
      try{
        const opKey='db-undo-'+target.opId;
        const reqs=cells.map(cell=>{
          const rowIndex=nameToIndex.get(cell.rowId);
          const cached=rowIndex===undefined?undefined:pageCache.get(Math.floor(rowIndex/PAGE_LENGTH)+1)?.find(row=>row.name===cell.rowId);
          return {
            rowId:cell.rowId,
            fieldId:cell.header,
            fieldType:columns.find(column=>column.fieldId===cell.header)?.type??'',
            value:String(cell.before??''),
            text:String(cell.before??''),
            idempotencyKey:opKey,
            expectedModified:cached?.modified??'',
          };
        });
        /* 业务表没有成包撤回口 ⇒ 按行分组，一行一个写（业务表后端会按行分组）。 */
        await table.writeCells(reqs,opKey);
        await rebuildAfterStructure();
        notify(`已撤回 ${cells.length} 格`,'success');
      }catch(error){
        notify(`撤回未提交：${(error as Error).message}`,'error');
      }finally{
        undoing=false;el.grid.inert=false;updateToolbar();
      }
      return;
    }
    undoStack.pop();
    const pendingOp = [...pending.values()].find(
      (p) => p.name === target.name && p.fieldId === target.fieldId && !p.isUndo,
    );
    if (pendingOp && pendingOp.state === 'saving') {
      pendingOp.undoAfterSave = true;
      try {
        grid?.setRow(target.rowIndex, columns.map((c) => (
          c.fieldId === target.fieldId ? target.before : grid!.getRowValue(target.rowIndex, c.fieldId)
        )));
      } catch { /* 行未装填就跳过 */ }
      notify(`正在撤回：${target.fieldLabel}（等保存落地后写回旧值）`, 'info');
      return;
    }
    if (pendingOp) {
      pending.delete(pendingOp.key);
      try {
        grid?.setRow(target.rowIndex, columns.map((c) => (
          c.fieldId === target.fieldId ? target.before : grid!.getRowValue(target.rowIndex, c.fieldId)
        )));
      } catch { /* 行未装填就跳过 */ }
      renderSaveBar();
      setSaveState('idle', '未修改');
      notify(`已撤回：${target.fieldLabel}`, 'success');
      return;
    }
    const pageRows = pageCache.get(Math.floor(target.rowIndex / PAGE_LENGTH) + 1) || [];
    const row = pageRows.find((r) => r.name === target.name);
    const coerced = coerce({
      rowIndex: target.rowIndex,
      colIndex: columns.findIndex((c) => c.fieldId === target.fieldId),
      fieldId: target.fieldId,
      value: target.before,
      before: target.after,
      type: target.fieldType,
    });
    if (!coerced.ok) {
      setSaveState('failed', `撤回失败：${target.fieldLabel}${coerced.reason}`);
      notify(`撤回未提交：${target.fieldLabel}${coerced.reason}`, 'error');
      return;
    }
    const op: PendingOp = {
      key: newIdempotencyKey(),
      name: target.name,
      rowIndex: target.rowIndex,
      fieldId: target.fieldId,
      fieldLabel: target.fieldLabel,
      fieldType: target.fieldType,
      value: coerced.value,
      text: target.before,
      before: target.after,
      expectedModified: row?.modified ?? '',
      state: 'saving',
      message: '',
      isUndo: true,
    };
    pending.set(op.key, op);
    // 值先在界面上回退，给人即时反馈；保存结果仍走 runSave 的三态口径。
    try {
      grid?.setRow(target.rowIndex, columns.map((c) => (
        c.fieldId === target.fieldId ? target.before : grid!.getRowValue(target.rowIndex, c.fieldId)
      )));
    } catch { /* 行未装填就跳过 */ }
    await enqueueSave(op);
  }

  /** 列宽写回。三态口径与单元格写一致：失败保留待提交、可按原编号重试。 */
  async function runWidthSave(op: { key: string; colIndex: number; widthPx: number; state: SaveState; message: string }) {
    if (disposed || !table) return;
    op.state = 'saving';
    setSaveState('saving', '保存中…');
    try {
      // 只发这一列的宽：后端按列并入，未提到的不动。
      const destination=table;
      const result = await retrySave(()=>destination.writeLayout({ [op.colIndex]: op.widthPx }, op.key),()=>!disposed&&table===destination);
      pendingWidths.delete(op.key);
      // 列宽保存成功**不弹提醒**。用户 2026-10-11 原话「列宽已经保存不要放进提示里」。
      // 顶部徽章只报状态（和改单格一样写「已保存」），不写「列宽已保存」——
      // 那是一次事件的播报，不是状态；他点的就是这个徽章，说的是别在这儿播报它。
      setSaveState('saved', result.idempotent ? '已保存（原编号重试，未重复写入）' : '已保存');
    } catch (error) {
      const text = (error as Error)?.message || String(error);
      const conflict = /内容版本|结构版本/.test(text);
      op.state = conflict ? 'conflict' : 'failed';
      op.message = text;
      setSaveState(op.state, conflict ? `冲突：${text}` : `列宽保存失败：${text}`);
      pendingWidths.delete(op.key);
      if(!disposed){setSaveState('idle',text);grid?.setColumnWidth(op.colIndex,table?.columnWidths[op.colIndex]??88);notify('列宽修改已停止：'+describeError(text),'error');}
    }
  }

  // BASE967-50：拖动一列宽会连续报宽度 —— 逐次发请求实测 1 次拖动 = 24 笔 layout_update。
  // 按列合并：拖动中只记最新宽度，停手 400ms 才发一笔；若上一笔还没回来，等它完成后再补最终一笔。
  // 判据：一次拖动 ≤2 笔（中途停顿一次算 2 笔也在此界内）。
  const widthDebounce = new Map<number, ReturnType<typeof setTimeout>>();
  const widthLatest = new Map<number, number>();
  const widthLastSent = new Map<number, number>();
  const widthFlushing = new Set<number>();
  async function flushColumnWidth(colIndex: number): Promise<void> {
    if (widthFlushing.has(colIndex)) return;   // 已有 worker 在跑，它会在每笔后自取最新值
    widthFlushing.add(colIndex);
    try {
      for (;;) {
        const widthPx = widthLatest.get(colIndex);
        if (widthPx === undefined || widthLastSent.get(colIndex) === widthPx) return;
        widthLastSent.set(colIndex, widthPx);
        const op = {
          key: newIdempotencyKey(), colIndex, widthPx,
          state: 'saving' as SaveState, message: '',
        };
        pendingWidths.set(op.key, op);
        await runWidthSave(op);
        // 保存期间宽度又变了 → 再发最后一笔；没变就收工
        if (widthLatest.get(colIndex) === widthPx) return;
      }
    } finally {
      widthFlushing.delete(colIndex);
    }
  }

  /** 把格子里的文本按列类型转成要提交的值。转不动就不发请求。 */
  function coerce(event: CommitEvent): { ok: true; value: string | number | null } | { ok: false; reason: string } {
    const text = event.value.trim();
    if (event.type === 'integer' || event.type === 'decimal') {
      if (text === '') return { ok: true, value: null };
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, reason: `${event.fieldId} 要填数字` };
      return { ok: true, value: n };
    }
    // ⚠️ **2026-10-27（PKG-126-T05）**：布尔列只认三态（未填／是／否）。
    // **认不出来就地拒**（不发请求）——服务端那条「开关列请使用 TRUE/FALSE 或 0/1」
    // 太技术，而且给了也只是一句「保存失败」。
    if (event.type === 'boolean') {
      const normalized = normalizeTriState(text);
      if (normalized === null) return { ok: false, reason: `${event.fieldId} 请选择「是」或「否」` };
      return { ok: true, value: normalized };
    }
    return { ok: true, value: event.value };
  }

  /**
   * ★ 合并说明（fast 那边 G2 的两个入口：末尾空白列打字 = 加列、空白行打字 = 加行）：
   *   fast 这边是**另起一条结构写路径**（appendColumn / appendRows 之后再补写一格），
   *   ours 这边的空白格输入统一走**受管粘贴**（handleInput → writeRange → pasteApply，
   *   一次原子完成扩展 + 写值，带幂等键、版本校验与一次受管撤回）。
   *   两条路径做同一件事（空白处打字 ⇒ 加行/加列并写入），但 ours 那条**只有一条**保存路径。
   *   所以这里**不接** fast 的两个函数（否则同一格会出现两条写路径），
   *   功能由 ours 的受管粘贴接管；列名/表头改名另有入口（「行列」弹窗、列头双击）。
   */
  /**
   * A2: 多格粘贴 —— 把剪贴板文本按「\n 分行、\t 分列」解析成矩阵，从当前选中格开始填入。
   * 只改目标值，不复制源权限/绑定/行 ID/格式。
   * 越界/只读目标：整个粘贴不生效（零生效），不写一半。
   */
  async function handlePaste(text:string,forcedStartRow?:number,forcedStartCol?:number){
    let matrix:string[][];
    try{matrix=parseClipboardTsv(text);}catch(error){notify(`粘贴失败：${(error as Error).message}`,'error');return;}
    await writeRange(matrix,forcedStartRow,forcedStartCol);
  }
  function paintPendingInputs(){
    for(const op of inputQueue){
      if(op.target.key!==table?.key||op.state==='saved')continue;
      const row=op.rowId?nameToIndex.get(op.rowId):op.row;
      const col=op.rowId?columns.findIndex(c=>c.fieldId===op.fieldId):op.col;
      if(row!==undefined&&col>=0)grid?.setRowValue(row,columns[col]?.fieldId??op.fieldId,op.matrix[0][0]);
    }
  }
  async function drainInputs(){
    if(inputDraining||disposed)return;inputDraining=true;
    try{while(inputQueue.length&&!disposed){
      const op=inputQueue[0];pendingInput=op;
      if(table?.key!==op.target.key||['failed','conflict'].includes(op.state))break;
      op.target=table;
      if(!op.dispatched){
        if(op.rowId){const row=nameToIndex.get(op.rowId),col=columns.findIndex(c=>c.fieldId===op.fieldId);
          if(row===undefined||col<0){op.state='conflict';op.message='输入目标已变化，请核对';op.discardable=!op.attempted;break;}op.row=row;op.col=col;}
        op.expectedContentVersion=table.contentVersion;op.expectedStructureVersion=table.structureVersion;op.dispatched=true;
      }
      await writeRange(op.matrix,op.row,op.col,op);
      if(op.state!=='saved'){
        // —— **失败/冲突的那笔若「结果确定没写进去」**（`discardable`）⇒ **把它从队列里拿掉**，
        //   别让它**堵着后面那几笔**（2026-10-29 站上实测的连锁故障）：
        //   队首是 failed/conflict ⇒ 整队停下 ⇒ `hasUnsaved()` 永远为真
        //   ⇒ **列宽／拖列／撤回／导出全被禁** ⇒ 人以为那些功能坏了（刷新一下又好了，更迷惑）。
        //   这一笔的值**已经退回原值**、页面**已经重读** ⇒ 它已经结束了 ⇒ 不该继续占着队首。
        // ⚠️ **结果不明**的（`uncertain`＝网络/超时 ⇒ 可能已经写进去了）**不许丢** ——
        //   丢了就找不回来 ⇒ 留在队列里等人核实（界面说清「先核实原操作」）。
        if(op.discardable){
          // —— **不占队列**（继续不堵后面那几笔），但**记一份**（2026-10-30 · PKG-133 · 缺陷③）
          //   ⇒ 「放弃修改」这个出口**还在**（人既不能重试、也不能放弃 ⇒ 那笔就卡在那儿了）。
          lastDiscardableFailure=op;
          inputQueue.shift();pendingInput=inputQueue[0]??null;paintPendingInputs();continue;
        }
        break;
      }
      inputQueue.shift();pendingInput=inputQueue[0]??null;paintPendingInputs();
    }}finally{inputDraining=false;renderSaveBar();updateToolbar();}
  }
  /**
   * FIX-05 / A06：同一格**又改了一次**时，前一笔失败怎么处理。
   *
   * 改之前：失败的输入留在队列**队首**，`drainInputs` 见到队首 failed/conflict 就 break。
   * 于是同一格的新输入既发不出去、也不报错 —— 格子里看着是新值，其实没存
   * （用户原话：「如果出错就会导致一个格子改不了」，输入 sum 又删掉后卡住）。
   *
   * 改之后：
   *  · 前一笔**结果确定未写入**（可放弃）→ 让新输入**顶替**它直接发出去
   *    （「输入无效内容→删掉改正→正常保存」这条路通了）；
   *  · 前一笔**结果不明**（网络/5xx/超时）→ **不顶替**：那笔可能已经写进库里了，
   *    丢掉就找不回来。新输入留在队列里等核实，界面说清「先核实原操作」。
   */
  function handleInput(event:CommitEvent){
    if(!table||openingTable||(hasUnsaved()&&!inputQueue.length)){grid?.setRowValue(event.rowIndex,event.fieldId,event.before);notify('请先处理未完成的保存','info');return;}
    const op:InputOp={matrix:[[event.value]],row:event.rowIndex,col:event.colIndex,fieldId:event.fieldId,rowId:columns[event.colIndex]?indexToName.get(event.rowIndex):undefined,before:event.before,key:'input-'+newIdempotencyKey(),state:'idle',message:'',target:table,expectedStructureVersion:table.structureVersion};
    /* FIX-05 / A06：同一格**又改了一次**时，前一笔失败怎么处理。
       改之前：失败的输入留在队列**队首**，`drainInputs` 见到队首 failed/conflict 就 break。
       于是同一格的新输入既发不出去、也不报错 —— 格子里看着是新值，其实没存
       （用户原话：「如果出错就会导致一个格子改不了」，输入 sum 又删掉后卡住）。
       改之后：
         · 前一笔**结果确定未写入**（可放弃）→ 让新输入**顶替**它直接发出去
           （「输入无效内容→删掉改正→正常保存」这条路通了）；
         · 前一笔**结果不明**（网络/5xx/超时）→ **不顶替**：那笔可能已经写进库里了，
           丢掉就找不回来。新输入留在队列里等核实，界面说清「先核实原操作」。 */
    const head=inputQueue[0];
    const superseded=head&&['failed','conflict'].includes(head.state)&&head.discardable&&head.row===op.row&&head.col===op.col?head:null;
    if(superseded){
      inputQueue.shift();
      if(pendingInput===superseded)pendingInput=inputQueue[0]??null;
      /* 撤回要恢复的是**正式值**，不是上一笔那个没写进去的值 ——
         画布上此刻显示的是待保存的失败值，直接拿它当 before 会让撤回恢复错。 */
      op.before=superseded.before;
    }
    inputQueue.push(op);pendingInput??=op;renderSaveBar();updateToolbar();
    if(superseded){paintPendingInputs();notify('上一笔未写入的输入已作废，这一笔直接保存','info');}
    void drainInputs();
  }
  /**
   * 业务表（db）粘贴时要的三样东西：**行身份**、**记录版本**、**改前的值**。
   *
   * · 行身份：全局行序 → 记录号（没有行号 ＝ 那一行是新的）；
   * · 记录版本：该行 `modified`（写之前要带的记录级并发闸）；
   * · 改前的值：撤回要靠它把旧值写回去（没有它，撤回会把格子清空而不是还原）。
   *
   * ⚠️ 行序是**显示**概念、行标识是**身份**概念 ⇒ 两者不许混用。
   */
  function dbPasteContext(startRow:number,startCol:number,rowCount:number,colCount:number){
    const rowRefs:Array<{rowId:string|null;modified?:string}>=[];
    const beforeValues:string[][]=[];
    for(let r=0;r<rowCount;r++){
      const rowIndex=startRow+r;
      const name=indexToName.get(rowIndex);
      const cached=name===undefined?undefined:pageCache.get(Math.floor(rowIndex/PAGE_LENGTH)+1)?.find(row=>row.name===name);
      rowRefs.push({rowId:name??null,modified:cached?.modified});
      const line:string[]=[];
      for(let c=0;c<colCount;c++){
        const column=columns[startCol+c];
        const value=cached&&column?(cached as Record<string,unknown>)[column.fieldId]:undefined;
        line.push(value===null||value===undefined?'':String(value));
      }
      beforeValues.push(line);
    }
    return {rowRefs,beforeValues};
  }
  async function writeRange(matrix:string[][], forcedStartRow?:number,forcedStartCol?:number,input?:InputOp, opKeyOverride?:string) {
    const failRange=(message:string,kind:'error'|'info'|'success'='error')=>{
      if(input){input.state='failed';input.message=message;input.discardable=!input.attempted;paintPendingInputs();setSaveState('failed',message);}
      notify(message,kind);
    };
    if (table && !table.pasteApply) { failRange('该表尚未接入批量粘贴，请使用已支持的单格编辑。', 'error'); return; }
    if (!table || disposed) return;
    // 合并说明：ours 这边拦「开表未完成 / 正在粘贴 / 有未保存修改」；
    // fast 那边拦「还有保存或文件操作没核实」。两条都留（互不替代）。
    if (openingTable) return;
    if (pasteApplying) return;
    if(pending.size||pendingWidths.size||pendingFileOperations.size){notify('请先完成或核实已有保存，再粘贴','error');return;}
    if (!input&&hasUnsaved()) { failRange('还有未保存修改，请完成保存后再粘贴', 'info'); return; }
    const pasteTable = table;
    const applyPaste = input?pasteTable.inputWrite:pasteTable.pasteApply;
    if (!applyPaste) { failRange('这张表暂不支持范围粘贴', 'info'); return; }
    if (!table.writable) {
      failRange(table.readonlyReason || '这张表是只读的，不能修改', 'error');
      return;
    }
    // ★ 合并说明：fast 那边的 writeRange **自己** parseClipboardTsv（它的签名收的是剪贴板文本）；
    //   ours 这边的 writeRange 收的是**已解析的矩阵**（handlePaste 里解析好再传进来）。
    //   解析留在 handlePaste（解析失败有提示），空矩阵拦截与 CRLF→LF 归一留在 writeRange。
    if (!matrix.length || !matrix[0].length) return;
    matrix=matrix.map(row=>row.map(value=>String(value).replace(/\r\n?/g,'\n')));

    // 当前选中格 = 粘贴起始位置（测试可传 forcedStartRow/Col 覆盖）
    const sel = grid?.getSelection();
    const startRow = forcedStartRow ?? sel?.rowIndex ?? 0;
    const startCol = forcedStartCol ?? sel?.colIndex ?? 0;
    const rows = matrix.length;
    const cols = Math.max(...matrix.map((r) => r.length));
    /* 业务表（db）越界的那几行 ＝ **新增记录**（走 platform.object.create），
       不是「没有结构权限所以不许贴」。xlsx 那边才是加行列（要结构权）。 */
    if(pasteTable.kind==='db'&&startRow+rows>totalRows){
      if(!dbObjectMeta||!(dbObjectMeta as {operations?:string[]}).operations?.includes('create')){
        failRange('这张表没有新增记录的权限，粘贴多出来的行未保存','error');return;
      }
    }else{
      /* ⚠️ **越界写入（加行/加列）这道闸问的是「表自己的结构权」**
         （`table.canStructure` ＝ `sheet_read` 回的 `my_access.structure`，**开表那一刻就有**），
         不是「导出能力探测」的结果 —— 那个是**异步**探的、失败时错误还被吞掉（一直是空）
         ⇒ 用它当闸 ⇒ **开表后手一快就越界写入**，人被一句**说错了原因**的话挡着
         （「没有结构编辑权限」，其实权限是有的，只是还没探到）。
         （用户 2026-10-29 14:5x：「粘贴也要行，输入也要行」。） */
      const decision=decideExtendWrite({
        kind:pasteTable.kind,
        outOfBounds:startRow+rows>totalRows||startCol+cols>columns.length,
        canStructure:pasteTable.canStructure,
      });
      if(!decision.allowed){failRange(decision.reason||'这次写入不能改这张表的行列；未保存');return;}
    }
    const hasUnloadedTargets=Array.from({length:rows},(_,offset)=>startRow+offset).some(row=>row<totalRows&&!filled.has(row));
    if(hasUnloadedTargets&&[...inlineControllers.values()].some(controller=>controller.descriptor.units.some(unit=>unit.status==='pending'&&!nameToIndex.has(unit.target.row_id)))){
      failRange('粘贴范围包含未加载行，尚不能排除待审候选；请先定位并核对目标范围，本次未保存','info');return;
    }
    const overlapsReview=[...inlineControllers.values()].some(controller=>controller.descriptor.units.some(unit=>{
      if(unit.status!=='pending')return false;const row=nameToIndex.get(unit.target.row_id),col=columns.findIndex(column=>column.fieldId===unit.target.header);
      return row!==undefined&&row>=startRow&&row<startRow+rows&&col>=startCol&&col<startCol+cols;
    }));
    if(overlapsReview){failRange('粘贴范围包含待审候选，请在原格双击编辑并确认；本次粘贴未保存','info');return;}

    // 预检：只读列整包拒绝（客户端先拦，服务端也拦）
    for (let c = 0; c < cols; c++) {
      const targetCol = startCol + c;
      if (targetCol < columns.length && columns[targetCol]?.readOnly) {
        failRange(`粘贴目标包含只读列「${columns[targetCol].label}」。整包未生效。`, 'error');
        return;
      }
    }

    // PKG-003-T03: 越界粘贴一次成包（B 的 files.sheet_paste_apply）
    // 扩展+写值服务端一次做完、全成或全不成、失败零残留。
    // 越界不报错——服务端自动加行加列（像 Excel）。
    // 合并说明：ours 这边的粘贴体（retrySave + 输入队列 input + 事实上报 + 撤回栈）
    // 比 fast 那边的 op 版本更全；fast 那边多的是「把粘贴登记成一笔未完成操作」
    // （结果不明时挡住后续编辑、可按原编号重试/放弃）—— 这条在这里补上。
    if(input){input.state='saving';setSaveState('saving','保存中…');}
    // 值写入静默保存；批量粘贴同样只用非模态进度，不遮挡表格。
    pasteApplying = true;
    updateToolbar();
    el.scope.textContent = input?'保存中…':'粘贴中…';
    let committed=false;
    // 操作编号：重试必须用同一把（换了编号服务端会当成新操作写第二次）。
    // 重试（未完成操作里的 run）时用回原来的编号。
    const opKey = opKeyOverride ?? input?.key??('paste-' + newIdempotencyKey());
    // ★ fast 那边的「未完成操作」登记：粘贴在途/结果不明时，保存栏看得见，
    //   且未核实前挡住后续编辑（与 fast 那边的 pendingFileOperations 同一口径）。
    if(!input)pendingFileOperations.set(opKey,{state:'saving',message:'',uncertain:false,run:async()=>{
      // 重试用**同一把操作编号**（opKey），载荷也冻结在服务端那一侧（backend 的 frozenBodies）。
      await writeRange(matrix,forcedStartRow,forcedStartCol,undefined,opKey);
    }});
    try {
      // 由目标列的定义决定类型，不能凭“看起来像数字”把编号/长号转成数值。
      const matrixTypes = matrix.map(row => row.map((value, c) => {
        const column = columns[startCol + c];
        if (value === '') return 'empty';
        if (value.startsWith('=')) return 'formula';
        if (column?.type === 'integer' || column?.type === 'decimal') {
          const number = Number(value);
          if (!value.trim() || !Number.isFinite(number)) throw new Error(`${column.label} 须为数字，本包未保存`);
          if (column.type === 'integer' && !Number.isInteger(number)) throw new Error(`${column.label} 须为整数，本包未保存`);
          const literal = value.trim();
          if (/^[+-]?0\d/.test(literal)) throw new Error(`${column.label} 是数值列，带前导零的文本不能在这里粘贴，本包未保存`);
          const mantissa = literal.split(/[eE]/)[0].replace(/^[+-]/, '');
          const significant = mantissa.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
          if (Math.abs(number) >= 1e15 || significant.length > 15) throw new Error(`${column.label} 数字超出安全精度，请保留为文本，本包未保存`);
          return 'number';
        }
        return column?.type === 'date' ? 'date' : 'text';
      }));
      // 不猜测剪贴板第一行含义：数据区第一行当数据写入
      /* 业务表（db）：粘贴要**行身份**（分清「改这一行」和「新建一行」）、
         要**记录版本**（记录级并发闸）、要**改前的值**（撤回要靠它写回旧值）。
         行序是显示概念、行标识是身份概念 ⇒ 这三样都由页面这边给。 */
      const dbPaste=pasteTable.kind==='db'?dbPasteContext(startRow,startCol,rows,cols):null;
      const result = await retrySave(async()=>{if(input)input.attempted=true;try{return await applyPaste.call(pasteTable, {
        startRow,
        startCol,
        matrix,
        matrixTypes,
        extend: pasteTable.kind === 'xlsx',  // 数据库表不扩展
        opId: opKey,
        ...(dbPaste?{rowRefs:dbPaste.rowRefs,beforeValues:dbPaste.beforeValues}:{}),
        ...(input?{expectedContentVersion:input.expectedContentVersion,expectedStructureVersion:input.expectedStructureVersion}:{}),
      });}catch(error){if(input){const status=(error as {status?:number}).status;if(!status||status<400||status>=500||[408,429].includes(status))input.uncertain=true;}throw error;}},()=>!disposed&&table===pasteTable);
      if (disposed || table !== pasteTable) return;
      committed=true;
      // 粘贴成功 ⇒ 这一笔「未完成操作」结清（fast 那边的口径）。
      if(!input)pendingFileOperations.delete(opKey);

      // G5 撤回：粘贴记为**一笔**（含自动扩展），不是每格一笔。
      if (result.cells.length > 0 && !undoStack.some(step=>step.opId===opKey)) {
        /* ⚠️ **新建的格子不进撤回栈** —— 删记录没有公开口，撤不回去；
           把它塞进去，撤回就会往一个不存在的格子上写旧值（空值）⇒ 反而写坏。
           xlsx 的粘贴没有这个区分（撤回是服务端成包的）。 */
        const cells = result.cells.filter(c=>!c.created).map((c) => ({
          rowId: c.rowId,
          header: c.header,
          // before 可能是 {value:...} 或原始字符串，兼容两种
          before: typeof c.before === 'object' && c.before !== null
            ? String((c.before as { value?: unknown }).value ?? '')
            : String(c.before ?? ''),
        }));
        if(cells.length>0)undoStack.push({
          name: cells[0]?.rowId || '',
          rowIndex: startRow,
          fieldId: cells[0]?.header || '',
          fieldLabel: input?'单元格输入':`粘贴 ${rows}×${cols} 格`,
          fieldType: 'batch',
          before: '',
          after: input?matrix[0][0]:`粘贴 ${rows}×${cols} 格`,
          opId: opKey,
          undoAction:result.undoAction,
          batchExpand: {
            rowsAdded: result.rowsAdded,
            colsAdded: result.colsAdded,
            cells,
          },
        });
        if (undoStack.length > 3) undoStack.splice(0, undoStack.length - 3);
      }

      const expanded=!!result.idempotent||result.rowsAdded>0||result.colsAdded>0||result.headers.length!==columns.length||result.headers.some((header,index)=>header!==columns[index]?.fieldId);
      // Reuse a row-only grid only when fresh metadata confirms the same columns and rights.
      if (expanded) {
        const reused=await refreshAppendedRows(startRow,startRow+rows-1,result.idempotent?undefined:result.structureVersion,result.idempotent?undefined:result.savedView);
        if(!reused){
          // Native Enter/Tab has already advanced while the request was pending.
          // Preserve that live selection across replacement, never force it back to the edited cell.
          const view=grid?.getViewState?.();
          const focus=input&&!view?grid?.getSelection():null;
          await rebuildAfterStructure();
          for(let page=Math.floor(startRow/PAGE_LENGTH)+1;page<=Math.floor((startRow+rows-1)/PAGE_LENGTH)+1;page++)await loadPage(page);
          if(view)grid?.restoreViewState(view);
          else if(focus){grid?.scrollToRow(focus.rowIndex,focus.colIndex);grid?.selectCell(focus.rowIndex,focus.colIndex);}
        }
      }

      let changedSinceCommit=false;
      // A formal read wins over the earlier POST reply; never paint its old after over a newer value.
      for (const c of result.cells) {
        const rowIndex = nameToIndex.get(c.rowId);
        const cached=rowIndex===undefined?undefined:pageCache.get(Math.floor(rowIndex/PAGE_LENGTH)+1)?.find(row=>row.name===c.rowId);
        if(expanded){
          const raw=c.after as ReviewValue,actualType=cached&&getRowViewMetadata(cached)?.types[c.header];
          if(!cached||!actualType||!raw||typeof raw!=='object'||!reviewValuesEqual({type:actualType,value:actualType==='empty'?null:cached[c.header]},raw))changedSinceCommit=true;
          continue;
        }
        if (rowIndex !== undefined) {
          const raw = c.after;
          const typed = typeof raw === 'object' && raw !== null ? raw as { value?: string | number | null; type?: string } : undefined;
          const afterVal = typed ? typed.value ?? '' : raw as string | number | null ?? '';
          if (cached) cached[c.header] = afterVal;
          if(!inputQueue.some(op=>op!==input&&op.target.key===pasteTable.key&&op.row===rowIndex&&op.col===columns.findIndex(column=>column.fieldId===c.header)))grid!.setRowValue(rowIndex, c.header, afterVal, typed?.type);
        }
      }

      /* FIX-15：写进公式后**必须重读公式值** ——
         服务端已算出缓存值（xlsx 里 <f>SUM(B2:B3)</f><v>1323.44</v>），
         不重读的话界面那格一直停在公式文本，用户看不到算出来的数。

         ⚠️ 顺序要紧：**先把输入标成已保存，再重读**。
         重读链路（loadPage → applyRows）末尾会重画「待保存输入」的本地回显；
         那时这笔输入若还挂在队列里（状态 saving），就会把刚读回来的计算值
         又盖回用户刚敲的公式文本 —— 活站实测就是这个现象（算对了但看不见）。

         重读失败不许把已写成功的输入说成「未核实」：写已经成功了，
         这里只提示「读回失败，请刷新核实」。 */
      if(input)input.state='saved';
      rowBehaviors?.cellsChanged(result.cells.flatMap(cell=>{
        const rowIndex=nameToIndex.get(cell.rowId);
        return rowIndex===undefined?[]:[{rowIndex,fieldId:cell.header}];
      }),{saved:true});
      if(result.refreshLoaded||needsFormulaRefresh(result.hasFormulas,[...result.cells.flatMap(cell=>[cell.before,cell.after]),...matrix.flat()])){
        try{await refreshLoadedFormulaValues();}
        catch(error){notify(`已保存，但重读公式值失败，请刷新核实：${(error as Error).message}`,'info');}
      }
      const liveView=grid?.getViewState?.();
      grid?.recalcAutoHeights(startRow, rows);
      if(liveView)grid?.restoreViewState(liveView,false);
      if(changedSinceCommit)notify('已提交，但部分当前值已变化或暂不能核对；页面保留正式读回值，请核实。','info');

      if(input){
        paintPendingInputs();setSaveState('saved','已保存');
        // —— **必填列还空着 ⇒ 提醒 ＋ 重画红框**（2026-10-30 用户口径：
        //   「在**行写入保存**的时候要 check 必填列是否为空……**toast 提醒**」）。
        //   ⚠️ **这条才是单格输入走的路**（回包里 `op_id` 是 `input-…` 那个）
        //   ⇒ 提醒要挂在这儿（挂在通用保存链上会**每次保存都扫全表** ⇒ 拖慢保存）。
        notifyRequiredMissing(input.row);
        // —— **只重算这一行**（不扫全表）⇒ 填上的那一格**不再红**。
        refreshRequiredEmptyMarks([rowRequiredValues(input.row)]);
      }
      void rowBehaviors?.refresh();
    } catch (error) {
      const msg = (error as Error).message || String(error);
      if(input){
        input.state='failed';input.message=msg;
        const status=(error as {status?:number}).status;
        input.discardable=!input.uncertain&&(!input.attempted||!!status&&status>=400&&status<500&&![408,429].includes(status));
        // ⚠️ **「明确没写进去」的那一笔要**单独记一份**（2026-10-30 · PKG-133 · 缺陷③）：
        //   它**不进队列**（`drainInputs` 会把它拿掉，免得堵着后面那几笔）
        //   ⇒ 队列里看不到它 ⇒ 「放弃修改」的出口会跟着消失
        //   ⇒ 人**既不能重试、也不能放弃** ⇒ 那笔就永远卡在那儿（格子里还留着没存进去的值）。
        // ⇒ 记一份在这儿 ⇒ 出口还在（点了照旧重读正式值、撤回栈照旧不涨）。
        //   ⚠️ **结果不明的**（`uncertain`）**不记** —— 那一笔可能已经写进库里了
        //   ⇒ 放弃＝丢数据 ⇒ 只给「重试原操作」（同一把幂等键，服务端去重，天然是「核实」）。
        if(input.discardable&&!input.uncertain)lastDiscardableFailure=input;
        paintPendingInputs();setSaveState('failed',msg);
        notify(input.discardable&&!input.uncertain
          ?'这一笔没有存进去：'+msg+'（可以点「放弃修改」按正式值重读）'
          :'输入尚未核实，后续输入已保留，请重试原操作：'+msg,'error');
        return;
      }
      // ★ fast 那边：粘贴失败也要在「未完成操作」里留一条（结果不明 ⇒ 标 uncertain），
      //   用户才能按原编号重试/放弃，不让它悄悄消失。
      if(!input&&!committed){
        const uncertain=/未知|核实|回执|网络|timeout/i.test(msg);
        pendingFileOperations.set(opKey,{state:'failed',message:msg,uncertain,run:async()=>{
          await writeRange(matrix,forcedStartRow,forcedStartCol,undefined,opKey);
        }});
      }
      if(committed){notify('粘贴已保存，但界面未能更新；请刷新核对，不要重新粘贴','error');return;}
      if(!disposed&&table===pasteTable){
        // Re-read formal values rather than issuing a reverse write: a lost
        // receipt may mean that the original operation already succeeded.
        pageCache.clear();filled.clear();requiredEmptyLedger.clear();
        for(let page=Math.floor(startRow/PAGE_LENGTH)+1;page<=Math.floor((startRow+rows-1)/PAGE_LENGTH)+1;page++)void loadPage(page).catch(()=>{});
        notify(describeError(committed?`内容已提交，页面读回失败；已停止重试，可继续其他工作：${msg}`:`该${input?'输入':'粘贴'}已停止，正在恢复正式值，可继续其他工作：${msg}`),'error');
      }
    } finally {
      pasteApplying = false;
      renderSaveBar();
      updateToolbar();
      el.scope.textContent = `共 ${totalRows} 行 · 已加载 ${filled.size} 行`;
      // No second "saved" fact request: the core write receipt is authoritative.
    }
  }

  function onCommit(event: CommitEvent) {
    // 合并说明：ours 这边拦「有格式保存/撤回中/粘贴中」；fast 那边拦「有未核实的文件操作」。
    // 两条都留。
    if(pendingStyle||undoing||(pasteApplying&&!pendingInput)){grid?.setRowValue(event.rowIndex,event.fieldId,event.before);notify('正在保存其他操作，请稍后再编辑','info');return;}
    if (pendingFileOperations.size) {
      grid?.setRowValue(event.rowIndex,event.fieldId,event.before);
      notify('请先核实未完成的文件操作，再继续编辑','error');return;
    }
    // 只读表（含宏/外链等）不能改 —— 拦住提交，说明原因，不发请求。
    if (table && !table.writable) {
      grid?.setRowValue(event.rowIndex,event.fieldId,event.before);
      notify(table.readonlyReason || '这张表是只读的，不能修改', 'error');
      return;
    }
    // Blank-grid input is one value at its original coordinate, never a header or a separate append.
    // 普通输入直接传值；由同一输入动作原子完成必要扩展，并保留一次受管撤回。
    if (event.colIndex >= columns.length || event.rowIndex >= totalRows) {
      handleInput(event);
      return;
    }
    const name = indexToName.get(event.rowIndex);
    const column = columns[event.colIndex];
    if (!name || !table || !column) {
      notify('该行尚未从服务端加载，无法保存。', 'error');
      return;
    }
    // A pending candidate is edited locally, never sent as an ordinary human write.
    const review=Array.from(inlineControllers.values()).flatMap(controller=>controller.descriptor.units.filter(unit=>unit.status==='pending'&&unit.target.row_id===name&&unit.target.header===event.fieldId).map(unit=>({controller,unit})))[0];
    if(review){
      const row=pageCache.get(Math.floor(event.rowIndex/PAGE_LENGTH)+1)?.find(row=>row.name===name);
      grid?.setRowValue(event.rowIndex,event.fieldId,(row?.[event.fieldId]??event.before) as string|number|null,getRowViewMetadata(row!)?.types[event.fieldId]);
      review.controller.setEdit(review.unit.unit_id,event.value);candidateOverlay?.edit(review.controller.id+':'+review.unit.unit_id);return;
    }
    // 列级只读：不能编辑、不发写请求、不假装保存。
    // 用户原话："可以只读，但是如果只读就需要你不能默认'保存'，不能让我认为是保存了的"
    if (column.readOnly) {
      notify(`「${column.label}」为只读列，不能修改`, 'error');
      return;
    }
    if(table.kind==='xlsx'&&event.value.startsWith('=')){handleInput(event);return;}
    const coerced = coerce(event);
    if (!coerced.ok) {
      // 数值列填了非数字：就地提示，不发请求——发了也只会被服务端拒。
      setSaveState('failed', `保存失败：${column.label}${coerced.reason.replace(event.fieldId, '')}`);
      notify(`${column.label}要填数字，改动未提交`, 'error');
      return;
    }
    if(table.kind==='xlsx'){handleInput(event);return;}
    const pageRows = pageCache.get(Math.floor(event.rowIndex / PAGE_LENGTH) + 1) || [];
    const row = pageRows.find((r) => r.name === name);
    const op: PendingOp = {
      key: newIdempotencyKey(),
      name,
      rowIndex: event.rowIndex,
      fieldId: event.fieldId,
      fieldLabel: column.label,
      fieldType: column.type,
      value: coerced.value,
      text: event.value,
      before: event.before,
      expectedModified: row?.modified ?? '',
      state: 'saving',
      message: '',
    };
    pending.set(op.key, op);
    // 保存前提示（B 契约 §7.1.3）：带外链/自定义XML 的表，保存时会剔除附属内容。
    // 每次开表只提示一次，不反复弹。
    if (table!.stripNotice && !stripNoticeShown) {
      stripNoticeShown = true;
      notify(table!.stripNotice, 'info');
    }
    // A3: 立即记入撤回栈，不等保存成功 —— 保存失败/还在路上时按 Cmd+Z
    // 也要能撤「刚才敲的那句」。
    undoStack.push({
      name: op.name,
      rowIndex: op.rowIndex,
      fieldId: op.fieldId,
      fieldLabel: op.fieldLabel,
      fieldType: op.fieldType,
      before: op.before,
      after: op.text,
      opId: op.key,
    });
    if (undoStack.length > 3) undoStack.shift();
    void enqueueSave(op);
  }

  /** Confirm a domain candidate through the regular save queue and version receipts. */
  async function adoptCellCandidate(rowIndex:number,colIndex:number,text:string,domainAction?:ExcelCellCandidateAction):Promise<boolean>{
    const name=indexToName.get(rowIndex);
    const column=columns[colIndex];
    if(!name||!table||!column){notify('这一行还没加载出来，不能写入','error');return false;}
    if(hasUnsaved()||pendingStyle||undoing||pasteApplying){notify('正在保存其他操作，请稍后再确认候选','info');return false;}
    if(pendingFileOperations.size){notify('请先核实未完成的文件操作，再确认候选','error');return false;}
    if(!table.writable){notify(table.readonlyReason||'这张表是只读的，不能修改','error');return false;}
    if(column.readOnly){notify(`「${column.label}」为只读列，不能修改`,'error');return false;}
    const pageRows=pageCache.get(Math.floor(rowIndex/PAGE_LENGTH)+1)||[];
    const cached=pageRows.find(row=>row.name===name);
    const op:PendingOp={
      key:newIdempotencyKey(),
      name,
      rowIndex,
      fieldId:column.fieldId,
      fieldLabel:column.label,
      fieldType:column.type,
      value:text,
      text,
      before:grid?.getRowValue(rowIndex,column.fieldId)??'',
      expectedModified:cached?.modified??'',
      state:'saving',
      message:'',
      domainAction,
    };
    pending.set(op.key,op);
    // Optimistic display is reconciled by the authoritative save result.
    grid?.setRowValue(rowIndex,column.fieldId,text);
    await enqueueSave(op);
    // —— 成没成的判据：`runSave` 成功时**不改** `op.state`（还是 'saving'）；
    //    被拒时它改成 'failed'／'conflict'。
    const written=op.state==='saving';
    if(written&&cached){
      // 工作簿表那条路**不带**记录版本 ⇒ 成功后的值**自己**写回本地行缓存
      // （不写回去 ⇒ 下一次重绘会拿旧值把画布盖回去）。
      (cached as Record<string,unknown>)[column.fieldId]=text;
    }
    return written;
  }

  let gridCopyListener: ((event: ClipboardEvent) => void) | undefined;
  let gridPasteListener: ((event: ClipboardEvent) => void) | undefined;
    // ★ fast 那边加的：Delete/Backspace 清空选区（走**粘贴**通道把空串写进去，
    //   所以清空也留受管痕迹、能撤回）。ours 这边没有这条交互，这里补上。
  let removeGridCopy: (() => void) | undefined;
  let gridFocused=false;
  window.addEventListener('pointerdown',event=>{gridFocused=el.grid.contains(event.target as Node);},{capture:true,signal});
  function clearSelection(){
    const range=grid?.getSelectionRange();
    if(!range||grid?.isEditing())return;
    const rows=range.endRow-range.startRow+1,cols=range.endCol-range.startCol+1;
    if(rows===1&&cols===1&&range.startRow<totalRows&&range.startCol<columns.length){
      const column=columns[range.startCol],before=grid?.getRowValue(range.startRow,column.fieldId)??'';
      if(before==='')return;
      onCommit({rowIndex:range.startRow,colIndex:range.startCol,fieldId:column.fieldId,type:column.type,before,value:''});
      return;
    }
    if(range.endRow>=totalRows||range.endCol>=columns.length||rows*cols>20000){notify('请选择两万格以内的既有数据区域清空','error');return;}
    void handlePaste(Array.from({length:rows},()=>Array(cols).fill('""').join('\t')).join('\r\n'),range.startRow,range.startCol);
  }
  window.addEventListener('keydown',event=>{
    if(!['Delete','Backspace'].includes(event.key)||event.ctrlKey||event.metaKey||event.altKey||!gridFocused||grid?.isEditing())return;
    const active=document.activeElement;
    if(active instanceof HTMLElement&&active!==document.body&&!el.grid.contains(active))return;
    if(ui?.modalCount)return;
    event.preventDefault();event.stopImmediatePropagation();clearSelection();
  },{capture:true,signal});
  function selectionClipboardPayload(optRange?: ClipboardRange) {
    if (!grid) throw Error('表格尚未就绪');
    const range = optRange ?? grid.getSelectionRange();
    if (!range) throw Error('请先选择要复制的单元格');
    return buildClipboardPayload({ range, getCellText: (row, col) => {const cached=pageCache.get(Math.floor(row/PAGE_LENGTH)+1)?.find(item=>item.name===indexToName.get(row));if(cached&&getRowViewMetadata(cached)?.pendingFormulas?.includes(columns[col]?.fieldId))throw Error('选区含待计算公式，请计算完成后复制');return grid!.getCellText(row,col);},
      isRowLoaded: row => row >= totalRows || filled.has(row), serializeTsv: serializeClipboardTsv });
  }
  function reportCopy(range: ClipboardRange, tableKey = table?.key) {
    void reportActionFact({ opId: 'copy-' + newIdempotencyKey(), action: 'copy.range', target: tableKey,
      detail: { ...range, cells: (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) } });
  }
  function syncFontControls(){
    if(hasUnsaved())return;
    const selection=grid?.getSelection();if(!selection)return;
    const field=columns[selection.colIndex]?.fieldId;if(!field)return;
    const style=grid?.getCellStyle(selection.rowIndex,field);
    // 字号是**下拉框**（Excel 的做法：常用字号直接选，不用打数字）。
    // 当前字号不在常用档位里时，把它补进选项 —— 不能被悄悄改成别的值。
    {
      const current=String(style?.font_size??9.75);
      const select=el.fontSize;
      const hasOption=select.options?[...select.options].some(o=>o.value===current):false;
      // 用控件自己的 ownerDocument 建 option（不依赖全局 document）——
      // 这样这段逻辑在页面里和在测试夹具里都对。
      const doc=select.ownerDocument;
      if(!hasOption&&doc){
        const o=doc.createElement('option');o.value=current;o.textContent=current;
        select.append(o);
      }
      select.value=current;
    }
    el.fontColor.value=style?.font_color&&/^#[0-9a-f]{6}$/i.test(style.font_color)?style.font_color:'#374151';
    el.fontColor.title=style?.font_color?'字体颜色 '+style.font_color:'自动或主题字体颜色（原设置保持不变）';
    el.fontBold.classList.toggle('is-on',style?.bold===true);el.fontBold.setAttribute('aria-pressed',String(style?.bold===true));
    el.fontItalic.classList.toggle('is-on',style?.italic===true);el.fontItalic.setAttribute('aria-pressed',String(style?.italic===true));
    el.fontUnderline.classList.toggle('is-on',style?.underline===true);el.fontUnderline.setAttribute('aria-pressed',String(style?.underline===true));
  }
  async function runStyleSave(op:PendingStyle){
    if(disposed||table!==op.target||!op.target.writeStyle||op.state==='saving')return;
    op.state='saving';setSaveState('saving','正在保存单元格格式');
    try{
      const result=await retrySave(()=>op.target.writeStyle!({cells:op.cells,style:op.style,opId:op.key,expectedContentVersion:op.expectedContentVersion,expectedStructureVersion:op.expectedStructureVersion}),()=>!disposed&&table===op.target);
      if(disposed||table!==op.target)return;
      grid?.setCellStyles(result.cells.flatMap(cell=>{const rowIndex=nameToIndex.get(cell.row_id);return rowIndex===undefined?[]:[{rowIndex,fieldId:cell.header,style:cell.after}];}));
      for(const cell of result.cells){
        const rowIndex=nameToIndex.get(cell.row_id);if(rowIndex===undefined)continue;
        const cached=pageCache.get(Math.floor(rowIndex/PAGE_LENGTH)+1)?.find(row=>row.name===cell.row_id);if(cached)setRowFontStyle(cached,cell.header,cell.after);
      }
      if(result.applied>0&&!undoStack.some(step=>step.opId===op.key)){
        undoStack.push({kind:'style',name:op.cells[0].row_id,rowIndex:nameToIndex.get(op.cells[0].row_id)??0,fieldId:op.cells[0].header,fieldLabel:'单元格格式',fieldType:'style',before:JSON.stringify(result.cells[0]?.before??{}),after:JSON.stringify(op.style),opId:op.key});
        if(undoStack.length>3)undoStack.shift();
      }
      pendingStyle=null;grid?.recalcAutoHeights();setSaveState('saved',result.applied?'单元格格式已保存':'单元格格式未变化，无需保存');syncFontControls();
      if(!result.applied)notify('所选单元格格式没有变化','info');
    }catch(error){pendingStyle=null;if(!disposed){const text=(error as Error).message||String(error);setSaveState('idle',text);notify('格式修改已停止，可继续其他工作：'+describeError(text),'error');}}
    finally{if(!disposed)updateToolbar();}
  }
  const BORDER_PRESET_ITEMS:Array<{preset:BorderPreset;label:string;hint:string}>=[
    {preset:'none',label:'无边框',hint:'去掉选区的全部边框'},
    {preset:'all',label:'全部边框',hint:'每一格都画出四边'},
    {preset:'outer',label:'外框',hint:'只画选区外围一圈'},
    {preset:'inner',label:'内框',hint:'只画选区内部的横竖线'},
    {preset:'top',label:'上边框',hint:'只画选区第一行的上边'},
    {preset:'bottom',label:'下边框',hint:'只画选区最后一行的下边'},
    {preset:'left',label:'左边框',hint:'只画选区第一列的左边'},
    {preset:'right',label:'右边框',hint:'只画选区最后一列的右边'},
  ];
  const BORDER_STYLE_ITEMS:Array<[string,string]>=[['thin','细线'],['medium','中粗'],['thick','粗线'],['dashed','虚线'],['dotted','点线'],['double','双线']];
  /**
   * 边框面板：预设 × 线型 × 颜色。
   * 走**公共弹窗** ui.dialog（产品的标准弹窗写法），不另造一套浮层。
   * 以前是一个只有「四边细线 / 无边框」两项的下拉，等于没给边框设置。
   */
  function openBorderPanel(){
    if(!ui)return;
    let preset:BorderPreset='outer';
    let style='thin';
    let color='#D1D5DB';
    const body=document.createElement('div');
    body.className='excel-border-panel';
    const note=document.createElement('p');
    note.className='excel-border-note';
    note.textContent='外框只画选区外围一圈，内框只画选区内部的横竖线；单边只落在选区的那一条边上。';
    const presets=document.createElement('div');
    presets.className='excel-border-presets';
    presets.setAttribute('role','radiogroup');
    presets.setAttribute('aria-label','边框样式');
    for(const item of BORDER_PRESET_ITEMS){
      const button=document.createElement('button');
      button.type='button';button.className='btn excel-border-preset';button.dataset.preset=item.preset;
      button.setAttribute('role','radio');button.title=item.hint;button.textContent=item.label;
      button.onclick=()=>{preset=item.preset;syncPresets();};
      presets.appendChild(button);
    }
    const options=document.createElement('div');
    options.className='excel-border-options';
    const styleLabel=document.createElement('label');
    styleLabel.append('线型');
    // FIX-38：原生 <select> 在 <dialog> 里展开会**向上弹**、盖住内容 ⇒ 用域内自绘下拉。
    const styleDropdown=createDropdown(
      BORDER_STYLE_ITEMS.map(([value,label])=>({value,label})),
      style,
      v=>{style=v;});
    styleDropdown.trigger.setAttribute('aria-label','边框线型');
    styleLabel.appendChild(styleDropdown.root);
    const colorLabel=document.createElement('label');
    colorLabel.append('颜色');
    const colorInput=document.createElement('input');
    colorInput.type='color';colorInput.value=color;colorInput.setAttribute('aria-label','边框颜色');
    colorLabel.appendChild(colorInput);
    options.append(styleLabel,colorLabel);
    const syncPresets=()=>{for(const button of presets.querySelectorAll('button'))button.setAttribute('aria-checked',String(button.dataset.preset===preset));};
    syncPresets();

    colorInput.addEventListener('change',()=>{color=colorInput.value;});
    body.append(note,presets,options);
    ui.dialog({
      title:'设置边框',
      // FIX-38：下拉展开时按 Esc **只收起下拉**，不把整个弹窗一起关掉。
      // 公共弹窗的 Esc 处理器在 document **捕获阶段**（`{capture:true}`），
      // 而且它**先注册**（页面初始化时就挂了）⇒ 同层同阶段按注册顺序，它先跑；
      // 它跑完会 `stopImmediatePropagation()` ⇒ 下拉自己的捕获器根本没机会跑。
      // ⇒ 这里在弹窗的 `onEscape` 钩子里**主动把下拉收掉**，再返回 true（表示「别关弹窗」）。
      onEscape: () => {
        if(!hasOpenDropdown())return false;   // 没有下拉开着 ⇒ 照常关弹窗
        closeDropdowns();
        return true;                          // 有下拉 ⇒ 只收下拉，弹窗留着
      },
      body,
      actions:[
        {label:'取消',onClick:()=>ui.closeModal()},
        {label:'应用',variant:'pri',onClick:()=>{ui.closeModal();applyFontPatch({border:{preset,style,color}});}},
      ],
    });
  }
  /**
   * 更多格式面板：填充色 + 文字对齐 + 清除格式。
   * 走**公共弹窗** ui.dialog（与边框面板同一件，不另造浮层）。
   * 打开时读当前格的样式当初始值；只有用户动过的项才提交，没动的不发。
   */
  const FILL_PRESETS=['#FFFFFF','#FFF3C4','#FFE08A','#D9F0D3','#CFE8FF','#E3D9FF','#FFD9DE','#E5E7EB'];
  /** 填充色的可读名字：下拉框里用户看的是名字，不是色值串。 */
  const FILL_PRESET_NAMES:Record<string,string>={
    '#FFFFFF':'白色','#FFF3C4':'浅黄','#FFE08A':'黄色','#D9F0D3':'浅绿',
    '#CFE8FF':'浅蓝','#E3D9FF':'浅紫','#FFD9DE':'浅红','#E5E7EB':'灰色',
  };
  function openMoreStylePanel(){
    if(!ui)return;
    const selected=grid?.getSelection();
    const field=selected&&columns[selected.colIndex]?.fieldId;
    const current=(selected&&field)?grid?.getCellStyle(selected.rowIndex,field):undefined;
    let fill=current?.fill_color??null;
    let horizontal=current?.horizontal_align??null;
    let vertical=current?.vertical_align??null;
    const touched=new Set<string>();
    const body=document.createElement('div');
    body.className='excel-style-panel';
    const section=(title:string)=>{
      const box=document.createElement('section');
      box.className='excel-style-section';
      const heading=document.createElement('h4');
      heading.textContent=title;
      box.appendChild(heading);
      body.appendChild(box);
      return box;
    };
    /**
     * 造一个「标签 + 下拉框」的行。
     * Excel 的做法：一个设定只有几个档位时，工具栏直接放按钮；
     * 但这里在一个弹窗里摆八档对齐按钮会挤成两行还看不出分组，
     * 所以收成**下拉框** —— 选什么一目了然，也不会点错。
     */
    const selectRow=(labelText:string,values:{value:string;label:string}[],active:string|null,onPick:(value:string)=>void)=>{
      const row=document.createElement('div');
      row.className='excel-style-row';
      const label=document.createElement('label');
      label.className='excel-style-row-label';
      label.textContent=labelText;
      // FIX-38：原生 <select> 的浮层是浏览器画的，在 <dialog> 里常**向上弹**、
      // 盖住上面整片内容，而那个方向**用 CSS 改不动** ⇒ 改用域内自绘的下拉菜单
      //（浮层 `top:100%` ⇒ 永远在下方）。
      const dropdown=createDropdown(
        values.map(item=>({value:item.value,label:item.label})),
        active??values[values.length-1]?.value??'',
        v=>onPick(v));
      dropdown.trigger.setAttribute('aria-label',labelText);
      label.appendChild(dropdown.root);
      row.appendChild(label);
      return {row,dropdown};
    };
    // 填充色：常用底色 + 自选 + 无填充，收成一个下拉框（原来是一排色块按钮）
    const fillBox=section('填充色');
    const fillField=document.createElement('div');
    fillField.className='excel-style-row';
    const fillLabel=document.createElement('label');
    fillLabel.className='excel-style-row-label';
    fillLabel.textContent='底色';
    const fillDropdown=createDropdown(
      [{value:'none',label:'无填充'},...FILL_PRESETS.map(color=>({value:color,label:FILL_PRESET_NAMES[color]??color,swatch:color}))],
      fill??'none',
      v=>{
        fill=v==='none'?null:v;
        touched.add('fill');
        syncFillPreview();
      });
    fillDropdown.trigger.setAttribute('aria-label','填充色');
    const fillPreview=document.createElement('span');
    fillPreview.className='excel-style-color-preview';
    fillPreview.setAttribute('aria-hidden','true');
    const syncFillPreview=()=>{
      fillPreview.style.background=fill??'transparent';
      fillPreview.classList.toggle('is-none',!fill);
    };
    const custom=document.createElement('input');
    custom.type='color';custom.value='#FFF3C4';custom.className='excel-style-custom';
    custom.setAttribute('aria-label','自选填充色');
    custom.addEventListener('change',()=>{
      fill=custom.value.toUpperCase();touched.add('fill');
      fillDropdown.set(FILL_PRESETS.includes(fill)?fill:'none');
      syncFillPreview();
    });
    fillLabel.append(fillPreview,fillDropdown.root);
    fillField.append(fillLabel,custom);
    fillBox.append(fillField);
    syncFillPreview();
    // 文字对齐：水平、垂直各一个下拉框（原来是八档按钮平铺，标签还会错位）
    // FIX-37 复验：两行竖排时，下拉展开只能向上弹、把上面的内容全遮住
    // ⇒ 水平/垂直**并排一行**，下面留出空间让浮层向下弹。
    const alignBox=section('文字对齐');
    const alignRow=document.createElement('div');
    alignRow.className='excel-style-align';
    const h=selectRow('水平',[{value:'left',label:'靠左'},{value:'center',label:'居中'},{value:'right',label:'靠右'},{value:'none',label:'默认'}],
      horizontal,v=>{horizontal=v;touched.add('horizontal');});
    const v=selectRow('垂直',[{value:'top',label:'靠上'},{value:'center',label:'居中'},{value:'bottom',label:'靠下'},{value:'none',label:'默认'}],
      vertical,v2=>{vertical=v2;touched.add('vertical');});
    alignRow.append(h.row,v.row);
    alignBox.append(alignRow);
    // 清除格式
    // FIX-37 复验：这段原本独占一大块（说明一段话 ＋ 按钮另起一行），
    // 把「垂直」下拉下方的空间占光 ⇒ 浮层只能向上弹、盖住上面的内容。
    // ⇒ 压成**一行**：按钮在左、说明在右。
    const clearBox=section('清除格式');
    const clearRow=document.createElement('div');
    clearRow.className='excel-style-row excel-style-clear-row';
    const clearButton=document.createElement('button');
    clearButton.type='button';clearButton.className='btn excel-style-clear';clearButton.textContent='清除格式';
    clearButton.title='把选区的字体、填充、对齐、边框、数字格式全部还原成默认（一次操作，可撤回）';
    clearButton.onclick=()=>{ui.closeModal();applyFontPatch({clear_format:true});};
    const clearNote=document.createElement('span');
    clearNote.className='excel-style-note';
    clearNote.textContent='还原字体、填充、对齐、边框、数字格式（可撤回）';
    clearRow.append(clearButton,clearNote);
    clearBox.append(clearRow);
    ui.dialog({
      title:'更多格式',
      // FIX-38：下拉展开时按 Esc **只收起下拉**，不把整个弹窗一起关掉。
      // 公共弹窗的 Esc 处理器在 document **捕获阶段**（`{capture:true}`），
      // 而且它**先注册**（页面初始化时就挂了）⇒ 同层同阶段按注册顺序，它先跑；
      // 它跑完会 `stopImmediatePropagation()` ⇒ 下拉自己的捕获器根本没机会跑。
      // ⇒ 这里在弹窗的 `onEscape` 钩子里**主动把下拉收掉**，再返回 true（表示「别关弹窗」）。
      onEscape: () => {
        if(!hasOpenDropdown())return false;   // 没有下拉开着 ⇒ 照常关弹窗
        closeDropdowns();
        return true;                          // 有下拉 ⇒ 只收下拉，弹窗留着
      },
      body,
      actions:[
        {label:'取消',onClick:()=>ui.closeModal()},
        {label:'应用',variant:'pri',onClick:()=>{
          ui.closeModal();
          const patch:FontStylePatch={};
          if(touched.has('fill'))patch.fill_color=fill??'none';
          if(touched.has('horizontal'))patch.horizontal_align=horizontal??'none';
          if(touched.has('vertical'))patch.vertical_align=vertical??'none';
          if(!Object.keys(patch).length){notify('没有改动要应用','info');return;}
          applyFontPatch(patch);
        }},
      ],
    });
  }
  function applyFontPatch(patch:FontStylePatch){
    if(!table||!grid||openingTable)return;
    if(!table.writable||!table.writeStyle||typeof table.contentVersion!=='number'){notify('这张表暂未接入可保存的单元格格式','info');return;}
    if(hasUnsaved()){notify('请先完成正在保存或未完成的操作，再设置格式','info');return;}
    try{
      const range=grid.getSelectionRange();if(!range)throw Error('请先选择要设置格式的单元格');
      const cells=buildStyleTargets({range,columns,rowId:index=>filled.has(index)?indexToName.get(index):undefined});
      const op:PendingStyle={key:'style-'+newIdempotencyKey(),cells,style:validateFontPatch(patch),target:table,expectedContentVersion:table.contentVersion,expectedStructureVersion:table.structureVersion,state:'idle',message:''};
      pendingStyle=op;void runStyleSave(op);
    }catch(error){notify((error as Error).message,'error');}
  }
  el.fontSize.addEventListener('change',()=>{const size=Number(el.fontSize.value);if(Number.isFinite(size)&&size>0)applyFontPatch({font_size:size});},{signal});
  el.fontColor.addEventListener('change',()=>applyFontPatch({font_color:el.fontColor.value}),{signal});
  el.fontBold.addEventListener('click',()=>{const selected=grid?.getSelection();const field=selected&&columns[selected.colIndex]?.fieldId;applyFontPatch({bold:!(selected&&field&&grid?.getCellStyle(selected.rowIndex,field)?.bold)});},{signal});
  el.fontItalic.addEventListener('click',()=>{const selected=grid?.getSelection();const field=selected&&columns[selected.colIndex]?.fieldId;applyFontPatch({italic:!(selected&&field&&grid?.getCellStyle(selected.rowIndex,field)?.italic)});},{signal});
  el.fontUnderline.addEventListener('click',()=>{const selected=grid?.getSelection();const field=selected&&columns[selected.colIndex]?.fieldId;applyFontPatch({underline:!(selected&&field&&grid?.getCellStyle(selected.rowIndex,field)?.underline)});},{signal});
  el.styleMore.addEventListener('click',()=>openMoreStylePanel(),{signal});
  /**
   * FIX-18「适应列宽」：按选中列的内容自动算宽度。
   *
   * 算宽在**服务端**做（它才有整张表的内容，前端只装了当前页），
   * 算完并进**同一条** layout 写入口落盘（不新开口子）。
   */
  async function autoFitSelectedColumns(){
    if(!table||!grid||hasUnsaved())return;
    const range=grid.getSelectionRange();
    if(!range){notify('请先选择要调整宽度的列','info');return;}
    const destination=table;
    const columns:number[]=[];
    for(let col=range.startCol;col<=range.endCol;col++)columns.push(col);
    const opKey='autofit-'+newIdempotencyKey();
    setSaveState('saving','正在按内容算列宽…');
    try{
      const result=await retrySave(()=>destination.writeLayout({},opKey,columns),()=>!disposed&&table===destination);
      const widths=result.columnWidths||{};
      let changed=0;
      for(const [index,px] of Object.entries(widths)){
        const col=Number(index);
        if(!Number.isFinite(col))continue;
        grid?.setColumnWidth(col,px);
        destination.columnWidths[col]=px;
        changed++;
      }
      setSaveState('saved','已保存');
      notify(changed?`已按内容调整 ${changed} 列的宽度`:'没有可调整的列','success');
    }catch(error){
      const text=(error as Error)?.message||String(error);
      setSaveState('failed','列宽调整失败：'+text);
      notify('列宽调整失败：'+text,'error');
    }
  }
  el.autoFit.addEventListener('click',()=>{void autoFitSelectedColumns();},{signal});

  /**
   * 第四批：成包编辑（查找替换 / 填充序列 / 选择性粘贴）。
   *
   * 三条都是「**一次成包写、一步撤回**」：服务端动作 files.sheet_find_replace /
   * sheet_fill_series / sheet_paste_special —— 一次落盘 = 内容版本 +1 = 撤回一步。
   * 面板都走**公共 ui.dialog**（与「更多格式」「边框」同一件），不另造浮层。
   */
  /** 最近一次复制的区域 —— 选择性粘贴的「源」。 */
  let lastCopiedRange: ClipboardRange | null = null;
  /**
   * 那个源**属于哪张表**。
   *
   * 为什么必须记：服务端 files.sheet_paste_special 只按坐标从「当前这张表」取源，
   * 载荷里没有表身份 ⇒ 源和目标不同表时**不报错**，直接粘错数据。
   * 换表时源要跟着失效（见 forgetCopiedSource），跨表时要拦下（见 openPasteSpecialPanel）。
   */
  let lastCopiedTableKey: string | null = null;

  /**
   * 换表了，「刚复制的那块」就不再算源。
   *
   * 同一张表重开（结构操作后重建）**不清** —— 那还是同一张表，源照样算数。
   */
  function forgetCopiedSource(sameTable: boolean) {
    if (sameTable) return;
    lastCopiedRange = null;
    lastCopiedTableKey = null;
  }

  // —— 面板零件：普通 DOM 元素 + 公共弹窗，不自造控件 ——
  function bulkSection(title:string){
    const box=document.createElement('section');
    box.className='excel-style-section';
    const heading=document.createElement('h4');
    heading.textContent=title;
    box.appendChild(heading);
    return box;
  }
  function bulkChoice(values:{value:string;label:string}[],active:string,onPick:(value:string)=>void){
    const row=document.createElement('div');
    row.className='excel-style-choices';
    row.setAttribute('role','radiogroup');
    for(const item of values){
      const button=document.createElement('button');
      button.type='button';button.className='btn excel-style-choice';button.textContent=item.label;
      button.dataset.value=item.value;
      button.setAttribute('role','radio');
      button.setAttribute('aria-checked',String(active===item.value));
      button.onclick=()=>{onPick(item.value);for(const other of row.querySelectorAll('button'))other.setAttribute('aria-checked',String(other===button));};
      row.appendChild(button);
    }
    return row;
  }
  function bulkField(label:string,type:string,placeholder?:string){
    const wrap=document.createElement('label');
    wrap.className='excel-style-field';
    const caption=document.createElement('span');
    caption.textContent=label;
    const input=document.createElement('input');
    input.type=type;input.className='excel-style-input';
    if(placeholder)input.placeholder=placeholder;
    wrap.append(caption,input);
    return {wrap,input};
  }
  function bulkSelect(label:string,options:{value:string;label:string}[]){
    const wrap=document.createElement('label');
    wrap.className='excel-style-field';
    const caption=document.createElement('span');
    caption.textContent=label;
    const select=document.createElement('select');
    select.className='excel-style-input';
    for(const item of options){
      const option=document.createElement('option');
      option.value=item.value;option.textContent=item.label;
      select.appendChild(option);
    }
    wrap.append(caption,select);
    return {wrap,select};
  }
  function bulkCheck(label:string){
    const wrap=document.createElement('label');
    wrap.className='excel-style-check';
    const input=document.createElement('input');
    input.type='checkbox';
    const caption=document.createElement('span');
    caption.textContent=label;
    wrap.append(input,caption);
    return {wrap,input};
  }
  function bulkNote(text:string){
    const note=document.createElement('p');
    note.className='excel-style-note';
    note.textContent=text;
    return note;
  }

  /** 成包写之后把回执里的格值画回网格（只画已装填的行；没装填的翻页时自然读到新值）。 */
  function paintBulkCells(cells:Array<{rowId:string;header:string;after:unknown}>){
    for(const cell of cells){
      const rowIndex=nameToIndex.get(cell.rowId);
      if(rowIndex===undefined)continue;
      const raw=cell.after;
      const typed=typeof raw==='object'&&raw!==null?raw as {value?:string|number|null;type?:string}:undefined;
      const value=typed?typed.value??'':(raw as string|number|null)??'';
      const cached=pageCache.get(Math.floor(rowIndex/PAGE_LENGTH)+1)?.find(row=>row.name===cell.rowId);
      if(cached)cached[cell.header]=value;
      grid?.setRowValue(rowIndex,cell.header,value,typed?.type);
    }
  }
  /** 格式改动（只贴格式）画不回网格 —— 样式在读回里：重读受影响的那几页。 */
  async function reloadRowRange(startRow:number,endRow:number){
    const first=Math.floor(startRow/PAGE_LENGTH)+1;
    const last=Math.floor(Math.max(startRow,endRow)/PAGE_LENGTH)+1;
    for(let page=first;page<=last;page++){pageCache.delete(page);await loadPage(page);}
  }
  /**
   * 成包写的统一收尾：记一步撤回、画回执、给用户一句话。
   * 没改成的格**如实报**（skipped 带原因），不静默吞掉。
   */
  async function finishBulkEdit(opKey:string,label:string,result:BulkEditResult,kind:'value'|'style',affected?:{startRow:number;endRow:number}){
    if(kind==='style'){if(affected)await reloadRowRange(affected.startRow,affected.endRow);}
    else paintBulkCells(result.cells);
    if(result.applied>0&&!undoStack.some(step=>step.opId===opKey)){
      undoStack.push({...(kind==='style'?{kind:'style' as const}:{}),
        name:result.cells[0]?.rowId||'',rowIndex:affected?.startRow??0,fieldId:result.cells[0]?.header||'',
        fieldLabel:label,fieldType:kind==='style'?'style':'batch',before:'',after:label,opId:opKey});
      if(undoStack.length>3)undoStack.shift();
    }
    grid?.recalcAutoHeights();
    setSaveState('saved','已保存');
    const skipped=result.skipped||[];
    if(result.applied>0){
      notify(`${label}：改了 ${result.applied} 格${skipped.length?`，另有 ${skipped.length} 格没改`:''}`,'success');
      for(const item of skipped.slice(0,5))notify(`${item.header??''}：${item.reason??'没改成'}`,'info');
    }else{
      notify(`${label}：没有找到要改的内容`,'info');
    }
  }

  /** 查找替换面板。 */
  function openFindReplacePanel(){
    if(!ui||!table)return;
    if(!table.writable){notify(table.readonlyReason||'这张表是只读的，不能修改','error');return;}
    if(hasUnsaved()){notify('请先完成正在保存或未完成的操作，再查找替换','info');return;}
    const body=document.createElement('div');
    body.className='excel-style-panel';
    const findField=bulkField('查找内容','text','要找到的字');
    const replaceField=bulkField('替换为','text','换成什么（留空=删掉命中内容）');
    const matchCase=bulkCheck('区分大小写');
    const wholeCell=bulkCheck('只替换整个单元格内容一致的');
    body.append(findField.wrap,replaceField.wrap,matchCase.wrap,wholeCell.wrap,
      bulkNote('在整张表里查找（不用先翻页）。数字与日期不参与文字替换。'));
    ui.dialog({
      title:'查找替换',
      // FIX-38：下拉展开时按 Esc **只收起下拉**，不把整个弹窗一起关掉。
      // 公共弹窗的 Esc 处理器在 document **捕获阶段**（`{capture:true}`），
      // 而且它**先注册**（页面初始化时就挂了）⇒ 同层同阶段按注册顺序，它先跑；
      // 它跑完会 `stopImmediatePropagation()` ⇒ 下拉自己的捕获器根本没机会跑。
      // ⇒ 这里在弹窗的 `onEscape` 钩子里**主动把下拉收掉**，再返回 true（表示「别关弹窗」）。
      onEscape: () => {
        if(!hasOpenDropdown())return false;   // 没有下拉开着 ⇒ 照常关弹窗
        closeDropdowns();
        return true;                          // 有下拉 ⇒ 只收下拉，弹窗留着
      },
      body,
      actions:[
        {label:'取消',onClick:()=>ui.closeModal()},
        {label:'替换',variant:'pri',onClick:()=>{
          ui.closeModal();
          void runFindReplace({find:findField.input.value,replace:replaceField.input.value,
            matchCase:matchCase.input.checked,wholeCell:wholeCell.input.checked});
        }},
      ],
    });
  }
  async function runFindReplace(options:FindReplaceOptions){
    if(!table||disposed)return;
    const destination=table;
    if(!destination.findReplace){notify('查找替换只支持 Excel 文件（数据库业务表暂不支持）','info');return;}
    const opKey='find-replace-'+newIdempotencyKey();
    setSaveState('saving','正在查找并替换…');
    try{
      const payload=buildFindReplacePayload(options);
      const result=await retrySave(()=>destination.findReplace!({payload,opId:opKey}),()=>!disposed&&table===destination);
      if(disposed||table!==destination)return;
      await finishBulkEdit(opKey,'查找替换',result,'value');
    }catch(error){
      const text=(error as Error).message||String(error);
      setSaveState('failed','查找替换失败');
      notify('查找替换失败：'+describeError(text),'error');
    }
  }

  /** 填充序列面板。 */
  function openFillSeriesPanel(){
    if(!ui||!table||!grid)return;
    if(!table.writable){notify(table.readonlyReason||'这张表是只读的，不能修改','error');return;}
    if(hasUnsaved()){notify('请先完成正在保存或未完成的操作，再填充','info');return;}
    const range=grid.getSelectionRange();
    if(!range){notify('请先选择要填充的一列或一行','info');return;}
    if(!isSingleLine(range)){notify('请选择一列或一行来填充（当前选区跨了多行多列）','info');return;}
    let seriesType:'linear'|'date'|'list'|'copy'='linear';
    const body=document.createElement('div');
    body.className='excel-style-panel';
    const typeBox=bulkSection('填充方式');
    const stepField=bulkField('步长','number','留空就从第二个格推算');
    const unitField=bulkSelect('步长单位',[{value:'day',label:'日'},{value:'week',label:'周'},{value:'month',label:'月'},{value:'year',label:'年'}]);
    const stopField=bulkField('终止值','text','到它为止（可留空）');
    const valuesField=bulkField('候选清单','text','用逗号隔开，循环使用');
    const syncFields=()=>{
      unitField.wrap.hidden=seriesType!=='date';
      valuesField.wrap.hidden=seriesType!=='list';
      stopField.wrap.hidden=seriesType==='copy';
      stepField.wrap.hidden=seriesType==='copy'||seriesType==='list';
      // 起始格是不是种子，**按方式说**：清单是内容（从第一格就铺），其余才是种子。
      note.textContent=seriesType==='list'
        ? `填充 ${describeRange(range)}（${rangeRows(range)} 行 × ${rangeCols(range)} 列，往${fillDirection(range)==='down'?'下':'右'}填）。清单从第一格开始铺，铺不满就循环。`
        : `填充 ${describeRange(range)}（${rangeRows(range)} 行 × ${rangeCols(range)} 列，往${fillDirection(range)==='down'?'下':'右'}填）。起始格是种子，它自己不改。`;
    };
    const note=bulkNote('');
    typeBox.appendChild(bulkChoice([
      {value:'linear',label:'等差（每次加一个数）'},
      {value:'date',label:'日期（按日/周/月/年）'},
      {value:'list',label:'列表（按清单循环）'},
      {value:'copy',label:'复制（每格都一样）'},
    ],seriesType,value=>{seriesType=value as typeof seriesType;syncFields();}));
    body.append(typeBox,stepField.wrap,unitField.wrap,stopField.wrap,valuesField.wrap,note);
    syncFields();
    ui.dialog({
      title:'填充序列',
      // FIX-38：下拉展开时按 Esc **只收起下拉**，不把整个弹窗一起关掉。
      // 公共弹窗的 Esc 处理器在 document **捕获阶段**（`{capture:true}`），
      // 而且它**先注册**（页面初始化时就挂了）⇒ 同层同阶段按注册顺序，它先跑；
      // 它跑完会 `stopImmediatePropagation()` ⇒ 下拉自己的捕获器根本没机会跑。
      // ⇒ 这里在弹窗的 `onEscape` 钩子里**主动把下拉收掉**，再返回 true（表示「别关弹窗」）。
      onEscape: () => {
        if(!hasOpenDropdown())return false;   // 没有下拉开着 ⇒ 照常关弹窗
        closeDropdowns();
        return true;                          // 有下拉 ⇒ 只收下拉，弹窗留着
      },
      body,
      actions:[
        {label:'取消',onClick:()=>ui.closeModal()},
        {label:'填充',variant:'pri',onClick:()=>{
          ui.closeModal();
          const step=stepField.input.value.trim()===''?undefined:Number(stepField.input.value);
          const options:FillSeriesOptions={seriesType,unit:unitField.select.value as FillSeriesOptions['unit'],
            step:step!==undefined&&Number.isFinite(step)?step:undefined,
            stopValue:stopField.input.value.trim()||undefined,
            values:valuesField.input.value.split(/[,，]/).map(item=>item.trim()).filter(Boolean)};
          void runFillSeries(range,options);
        }},
      ],
    });
  }
  async function runFillSeries(range:GridRange,options:FillSeriesOptions){
    if(!table||disposed)return;
    const destination=table;
    if(!destination.fillSeries){notify('填充序列只支持 Excel 文件（数据库业务表暂不支持）','info');return;}
    const opKey='fill-series-'+newIdempotencyKey();
    setSaveState('saving','正在填充…');
    try{
      const payload=buildFillSeriesPayload(range,options);
      const result=await retrySave(()=>destination.fillSeries!({payload,opId:opKey}),()=>!disposed&&table===destination);
      if(disposed||table!==destination)return;
      await finishBulkEdit(opKey,'填充序列',result,'value',{startRow:range.startRow,endRow:range.endRow});
    }catch(error){
      const text=(error as Error).message||String(error);
      setSaveState('failed','填充失败');
      notify('填充失败：'+describeError(text),'error');
    }
  }

  /** 选择性粘贴面板。 */
  function openPasteSpecialPanel(){
    if(!ui||!table||!grid)return;
    if(!table.writable){notify(table.readonlyReason||'这张表是只读的，不能修改','error');return;}
    if(hasUnsaved()){notify('请先完成正在保存或未完成的操作，再选择性粘贴','info');return;}
    if(!lastCopiedRange){notify('请先复制一块区域，再来选择性粘贴','info');return;}
    // 源和目标必须同一张表：服务端只按坐标从「当前这张表」取源，跨表会静默粘错数据。
    if(!copiedSourceMatchesTable(lastCopiedTableKey, table.key)){
      notify('你复制的区域在另一张表里，请回到那张表再选择性粘贴','info');return;
    }
    const target=grid.getSelectionRange();
    if(!target){notify('请先选择要粘贴到的位置','info');return;}
    const source=lastCopiedRange;
    let mode:PasteSpecialMode='values';
    const body=document.createElement('div');
    body.className='excel-style-panel';
    const modeBox=bulkSection('贴什么');
    modeBox.appendChild(bulkChoice([
      {value:'values',label:'只贴值'},
      {value:'formulas',label:'只贴公式'},
      {value:'formats',label:'只贴格式'},
    ],mode,value=>{mode=value as PasteSpecialMode;}));
    const skipEmpty=bulkCheck('跳过空（源格是空的不动目标格）');
    body.append(modeBox,skipEmpty.wrap,
      bulkNote(`源：${describeRange(source)}（你刚复制的那块）→ 目标：${describeRange(target)}。只贴格式时目标格的值一个不动。`));
    ui.dialog({
      title:'选择性粘贴',
      // FIX-38：下拉展开时按 Esc **只收起下拉**，不把整个弹窗一起关掉。
      // 公共弹窗的 Esc 处理器在 document **捕获阶段**（`{capture:true}`），
      // 而且它**先注册**（页面初始化时就挂了）⇒ 同层同阶段按注册顺序，它先跑；
      // 它跑完会 `stopImmediatePropagation()` ⇒ 下拉自己的捕获器根本没机会跑。
      // ⇒ 这里在弹窗的 `onEscape` 钩子里**主动把下拉收掉**，再返回 true（表示「别关弹窗」）。
      onEscape: () => {
        if(!hasOpenDropdown())return false;   // 没有下拉开着 ⇒ 照常关弹窗
        closeDropdowns();
        return true;                          // 有下拉 ⇒ 只收下拉，弹窗留着
      },
      body,
      actions:[
        {label:'取消',onClick:()=>ui.closeModal()},
        {label:'粘贴',variant:'pri',onClick:()=>{
          ui.closeModal();
          void runPasteSpecial(source,target,{mode,skipEmpty:skipEmpty.input.checked});
        }},
      ],
    });
  }
  async function runPasteSpecial(source:GridRange,target:GridRange,options:{mode:PasteSpecialMode;skipEmpty:boolean}){
    if(!table||disposed)return;
    const destination=table;
    if(!destination.pasteSpecial){notify('选择性粘贴只支持 Excel 文件（数据库业务表暂不支持）','info');return;}
    const opKey='paste-special-'+newIdempotencyKey();
    setSaveState('saving','正在粘贴…');
    try{
      const payload=buildPasteSpecialPayload(source,target,options);
      const result=await retrySave(()=>destination.pasteSpecial!({payload,opId:opKey}),()=>!disposed&&table===destination);
      if(disposed||table!==destination)return;
      const kind=result.kind==='style'?'style':'value';
      await finishBulkEdit(opKey,'选择性粘贴',result,kind,{startRow:target.startRow,endRow:target.endRow});
    }catch(error){
      const text=(error as Error).message||String(error);
      setSaveState('failed','选择性粘贴失败');
      notify('选择性粘贴失败：'+describeError(text),'error');
    }
  }
  el.findReplace.addEventListener('click',()=>openFindReplacePanel(),{signal});
  el.pasteSpecial.addEventListener('click',()=>{closeToolMenus();openPasteSpecialPanel();},{signal});
  el.fillSeries.addEventListener('click',()=>{closeToolMenus();openFillSeriesPanel();},{signal});
  const numberFormatControl=host.querySelector('[data-number-format]') as HTMLSelectElement;
  numberFormatControl.addEventListener('change',()=>{if(numberFormatControl.value)applyFontPatch({number_format:numberFormatControl.value});numberFormatControl.value='';},{signal});
  el.borderOpen.addEventListener('click',()=>openBorderPanel(),{signal});
  host.querySelector('[data-wrap-text]')!.addEventListener('click',()=>{const selected=grid?.getSelection(),field=selected&&columns[selected.colIndex]?.fieldId;applyFontPatch({wrap_text:!(selected&&field&&grid?.getCellStyle(selected.rowIndex,field)?.wrap_text)});},{signal});
  // 业务域在工具栏上的入口（域贡献；**不新开页面**）。
  // 上下文在**点击那一刻**才取（表、选中行的固定行 ID、选中列）——
  // 挂上的时候表可能还没打开，所以不能在这里求值。
  mountExcelDomainActions(host.querySelector('.excel-toolrow'),()=>{
    const selection=grid?.getSelection();
    return {
      table:table?.resourceId??table?.key??'',
      row_id:selection?(indexToName.get(selection.rowIndex)??''):'',
      header:selection?(columns[selection.colIndex]?.fieldId??''):'',
    };
  },signal);
  el.fieldPermissions.addEventListener('click',()=>{
    if(!ui||!table||!canManageFieldPermissions||hasUnsaved())return;
    const destination=table;
    void editFieldPermissions(ui,destination.resourceId??destination.key,{signal,
      active:()=>!disposed&&table===destination&&!hasUnsaved(),
      newKey:()=> 'field-permissions-'+newIdempotencyKey(),
      saved:async()=>{await rebuildAfterStructure();notify('字段权限已保存','success');},
    }).catch(error=>notify((error as Error).message,'error'));
  },{signal});
  /**
   * 表权限（PKG-117-T01，用户 2026-10-25 23:1x 原话：「要在表工具栏增加一个设置按钮
   * 用于设置整个表的权限（读／写／筛／下载／助手；全局、部门、个人）」）。
   *
   * ⚠️ 2026-10-26 用户拍定：**「助手」那一档整个去掉** ⇒ 现在是**四个操作**
   *    （读／写／筛／下载）；助手和人看到的一样 ⇒ 要禁就限「读」那一档。
   *
   * 与「字段权限」**分开的入口、分开的能力闸**：表级不必有已晋升列。
   */
  el.tablePermissions.addEventListener('click',()=>{
    if(!ui||!table||!canManageTablePermissions||hasUnsaved())return;
    const destination=table;
    void editTablePermissions(ui,destination.resourceId??destination.key,{signal,
      active:()=>!disposed&&table===destination&&!hasUnsaved(),
      newKey:()=> 'table-permissions-'+newIdempotencyKey(),
      saved:async()=>{await rebuildAfterStructure();notify('表权限已保存','success');},
    }).catch(error=>notify((error as Error).message,'error'));
  },{signal});
  function rememberStructure(opId:string,label:string){undoStack.push({kind:'structure',opId,name:'',rowIndex:0,fieldId:'',fieldLabel:label,fieldType:'structure',before:'',after:''});if(undoStack.length>3)undoStack.shift();}
  // FIX-40：「行列操作」弹窗与**右键菜单共用**同一套结构变更逻辑 ⇒
  // 这两个状态（待核实的操作、目标表）必须提到**函数作用域**，两边都用得上。
  let pendingStructure:{signature:string;key:string;confirmed?:boolean}|null=null;
  let destination:UnifiedTable|null=null;
  /**
   * 行列结构变更的**唯一入口**（FIX-40）。
   *
   * 改之前这段逻辑**长在「行列」按钮的 click 处理器里**（闭包），
   * 所以别的地方（右键菜单）用不了 —— 只能另写一份，或者把这段抠出来。
   * 现在抠成 `runStructure`：**「行列操作」弹窗与右键菜单共用同一套**，
   * 插入/删除/移动/恢复一个动作只有一份实现（也只走一条受管保存路径）。
   *
   * `anchor` 让调用方指定**插在哪**：不传就是「在当前选中行/列之前」，
   * 右键菜单传「下一行/下一列」就是「在下方/右侧插」。
   */
  /**
   * 按**显示序号**取那一行的固定身份；那一页还没加载 ⇒ 先把那一页拉下来。
   *
   * 为什么必须有它：**插行要拿「目标行的身份」当锚点** ——
   * 锚点错了，新行就插到别的地方去了（原来插到表的末尾）。
   */
  const rowAt=async(index:number)=>{if(index>=totalRows)return null;if(!indexToName.has(index))await loadPage(Math.floor(index/PAGE_LENGTH)+1);return indexToName.get(index)||null;};
  const runStructure=async(choice:StructureChoice,anchor?:{beforeRowId?:string|null;beforeHeader?:string|null})=>{
    if(!table||!grid)throw Error('表格还没打开');
    const destination=table;
    if(hasUnsaved())throw Error('表格已切换或仍有未保存修改');
    if([...inlineControllers.values()].some(c=>c.hasEdits()))throw Error('请先处理未确认的候选修改');
    const selected=grid.getSelection()||{rowIndex:0,colIndex:0};
    const header=columns[selected.colIndex]?.fieldId||'';
    if(choice.kind==='column_move'){if(!header)throw Error('请选择已有列');await moveColumnInPersonalView(header,choice.header||'');return;}
    const rid=await rowAt(selected.rowIndex),before=choice.position?await rowAt(choice.position-1):null;
    if(choice.kind==='column_insert'&&!choice.header)throw Error('请填写新列名');
    if(['row_move','row_delete'].includes(choice.kind)&&!rid)throw Error('请选择已有数据行');
    if(['column_move','column_delete'].includes(choice.kind)&&!header)throw Error('请选择已有列');
    if(choice.kind==='row_restore'&&!choice.restore)throw Error('请选择已删除行');
    const signature=JSON.stringify({choice,rid,before,header,anchor});
    if(pendingStructure&&pendingStructure.signature!==signature)throw Error('上次操作结果尚未核实，请保持原参数重试');
    pendingStructure??={signature,key:'structure-'+newIdempotencyKey()};
    const key=pendingStructure.key;structuring=true;el.grid.inert=true;updateToolbar();
    try{
      if(!pendingStructure.confirmed)await retrySave(async()=>{
      // 插入的锚点：默认「当前选中行/列之前」；右键菜单可指定「下一行/下一列」（＝在下方/右侧插）。
      const beforeRowId=anchor&&'beforeRowId' in anchor?(anchor.beforeRowId??null):rid;
      const beforeHeader=anchor&&'beforeHeader' in anchor?(anchor.beforeHeader??null):(header||null);
      if(choice.kind==='row_insert')await destination.insertRows(beforeRowId,choice.count,key);
      else if(choice.kind==='column_insert'){if(!choice.header)throw Error('请填写新列名');await destination.insertColumn(beforeHeader,choice.header,key);}
      else if(choice.kind==='row_move'){if(!rid)throw Error('请选择已有数据行');await destination.structureAction('row_move',rid,key,before||undefined);}
      else if(choice.kind==='row_restore'){if(!choice.restore)throw Error('请选择已删除行');await destination.structureAction('row_restore',choice.restore,key);}
      else if(choice.kind==='row_delete'){if(!rid)throw Error('请选择已有数据行');await destination.deleteRow(rid,key);}
      else{if(!header)throw Error('请选择已有列');await destination.deleteColumn(header,key);}
      },()=>!disposed&&table===destination);
      pendingStructure.confirmed=true;
      if(!undoStack.some(step=>step.opId===key))rememberStructure(key,'行列操作');await rebuildAfterStructure();pendingStructure=null;notify('行列操作已保存','success');
    }catch(error){if(error instanceof ApiError&&error.status>=400&&error.status<500&&error.status!==408)pendingStructure=null;throw error;
    }finally{structuring=false;el.grid.inert=false;updateToolbar();}
  };
  el.structure.addEventListener('click',()=>{
    if(!ui||!table||!grid||hasUnsaved())return;
    // 没有结构修改权时**说清楚为什么**，而不是让这个入口悄悄消失。
    if(!table.canStructure){notify('这张表暂未开放行列调整：需要表结构修改权限','info');return;}
    destination=table;
    const selected=grid.getSelection()||{rowIndex:0,colIndex:0},header=columns[selected.colIndex]?.fieldId||'';
    editStructure(ui,{row:selected.rowIndex,column:header},destination.deletedRows||[],async choice=>{
      await runStructure(choice);
    },()=>pendingStructure===null);
  },{signal});

  /**
   * 表格**右键菜单**（FIX-40）—— 用户 2026-10-20 11:35 原话：
   * 「右击还是没有办法在列中间新建列，行中间新建行」。
   *
   * 改之前 `sheet.ts` 里 `contextMenu: false`（Univer 原生右键菜单被关掉，
   * 因为它的命令**没有受管保存路径**）⇒ 右键什么也没有。
   *
   * 现在自己画一个菜单，**动作走 `runStructure`** —— 与「行列操作」弹窗**同一套**实现，
   * 所以插入/删除仍然只走一条受管保存路径（不会绕过幂等键、版本校验、撤回）。
   *
   * 菜单作用在哪一行/哪一列：用**当前选中**（点列头/行号时 Univer 原生会选中那列/那行）。
   */
  const gridHost=el.grid;
  gridHost.addEventListener('contextmenu',event=>{
    const menuEvent=event as MouseEvent;
    menuEvent.preventDefault();
    if(!table||!grid||hasUnsaved()||structuring)return;
    const rect=gridHost.getBoundingClientRect();
    const region:HitRegion|null=hitRegion(menuEvent.clientX,menuEvent.clientY,{x:rect.x,y:rect.y,width:rect.width,height:rect.height});
    if(!region)return;
    const selected=grid.getSelection();
    if(!selected){notify('请先选中一个单元格或一行一列','info');return;}
    const colHeader=columns[selected.colIndex]?.fieldId||'';
    const nextColHeader=columns[selected.colIndex+1]?.fieldId||null;
    const rowId=indexToName.get(selected.rowIndex)||null;
    const newColumnName=`列${selected.colIndex+1}`;
    /**
     * 「字段权限」这一项（PKG-117-T01）—— **只对已晋升的列出现**。
     *
     * ⚠️ **结构权 ≠ 权限管理权**：这一项**不**被 `canStructure` 挡着 ——
     * 有结构权没权限权的人看不见它；有权限权没结构权的人**照样**看得见（菜单里只剩这一项）。
     */
    const canOpenFieldPermissions=canManageFieldPermissions&&region==='column-header'&&!!colHeader&&promotedColumns.has(colHeader);
    // —— **恢复自动行高**这一项：跟**手拖行高**同一道闸（表可写 ＋ 这张表有行高动作）——
    //   ⚠️ **不归「结构权」管**：行高不是表结构（加列删列才是）⇒ 跟手拖那条路一样。
    const canResetRowHeight=!!table.writable&&!!table.writeRowHeights;
    const items=menuItemsFor(region,{canManageFieldPermissions,columnPromoted:promotedColumns.has(colHeader),canResetRowHeight});
    // 没有结构权 ⇒ 结构那几项不给看；「字段权限」不受这道闸管，「恢复自动行高」也不受。
    const visible=table.canStructure?items:items.filter(item=>item.id===COLUMN_FIELD_PERMISSIONS_ITEM||item.id===ROW_AUTO_HEIGHT_ITEM);
    if(!visible.length){notify('这张表暂未开放行列调整：需要表结构修改权限','info');return;}
    const permissionTable=table;
    openPopupMenu(menuEvent.clientX,menuEvent.clientY,visible,async id=>{
      try{
        if(id==='column_insert_left')await runStructure({kind:'column_insert',position:0,count:1,header:newColumnName,restore:''},{beforeHeader:colHeader||null});
        else if(id==='column_insert_right')await runStructure({kind:'column_insert',position:0,count:1,header:newColumnName,restore:''},{beforeHeader:nextColHeader});
        else if(id===COLUMN_FIELD_PERMISSIONS_ITEM){
          if(!ui||!canOpenFieldPermissions||!colHeader)return;
          const destination=permissionTable;
          void editFieldPermissions(ui,destination.resourceId??destination.key,{column:colHeader,signal,
            active:()=>!disposed&&table===destination&&!hasUnsaved(),
            newKey:()=> 'column-field-permissions-'+newIdempotencyKey(),
            saved:async()=>{await rebuildAfterStructure();notify('字段权限已保存','success');},
          }).catch(error=>notify((error as Error).message,'error'));
        }
        else if(id==='column_delete'){
          if(!colHeader)return;
          if(!globalThis.confirm(`删除「${colHeader}」这一列？列里的值会一起没掉。`))return;
          await runStructure({kind:'column_delete',position:0,count:1,header:'',restore:''});
        }
        else if(id==='row_insert_above'||id==='row_insert_below'){
          // **插到中间**（用户 2026-10-29 14:5x 口径：「也要能在中间加行」）。
          //
          // ⚠️ 原来这里是 `indexToName.get(那一行)` **直接**当锚点 ——
          //   那一行**没从服务器加载**时拿到的是**空**，
          //   而「插在空锚点前面」＝ **插到表的末尾** ⇒
          //   人点了「在第 5 行下面插一行」，新行跑到了表的最底下，**一声不响**。
          // ⇒ 现在：先把目标那一页加载出来 ⇒ 算出锚点 ⇒ 拿不到就**明确报错**。
          const direction=id==='row_insert_above'?'above':'below';
          const targetIndex=direction==='above'?selected.rowIndex:selected.rowIndex+1;
          if(targetIndex<totalRows&&!indexToName.has(targetIndex))await rowAt(targetIndex);
          const anchor=resolveRowInsertAnchor({direction,selectedIndex:selected.rowIndex,totalRows,idAt:index=>indexToName.get(index)});
          if(anchor.kind==='unknown'){notify('这一行还没加载出来，请先刷新页面再试','error');return;}
          await runStructure({kind:'row_insert',position:0,count:1,header:'',restore:''},{beforeRowId:anchor.kind==='end'?null:anchor.beforeRowId});
        }
        else if(id==='row_delete'){
          if(!rowId)return;
          if(!globalThis.confirm('删除这一行？行里的值会一起没掉。'))return;
          await runStructure({kind:'row_delete',position:0,count:1,header:'',restore:''});
        }
        else if(id===ROW_AUTO_HEIGHT_ITEM){
          // —— **恢复自动行高**（2026-10-29 用户口径：「再点一次自动行高」的回头路）——
          //   人手拖高过的行 ⇒ 自动行高不再接管它 ⇒ 这一项把那一行**退回去**。
          const target=table;
          if(!target?.writable||!target.writeRowHeights){notify('这张表暂不支持保存行高','info');return;}
          const range=grid?.getSelectionRange();
          const first=range?Math.max(0,range.startRow):selected.rowIndex;
          const last=range?Math.max(first,range.endRow):selected.rowIndex;
          const rows=Array.from({length:last-first+1},(_,index)=>first+index);
          if(!rows.length){notify('请先选中要恢复的行','info');return;}
          // ⚠️ **行高存在表文件里** ⇒ **全表共享** ⇒ 点之前就说清楚（不是个人视图）。
          const scope=first===last?`第 ${first+1} 行`:`第 ${first+1}～${last+1} 行`;
          if(!globalThis.confirm(`把${scope}恢复成自动行高？\n行高存在表文件里 ⇒ 影响本表所有人。`))return;
          // 先改画布（纯画布，不发请求）……
          grid?.resetAutoRowHeights(rows);
          // ……再写回文件（0 ＝ 恢复自动 ⇒ 后端不写 ht／customHeight）。
          const key='row-height-'+newIdempotencyKey();
          savingRowHeights=true;updateToolbar();
          void retrySave(()=>target.writeRowHeights!(Object.fromEntries(rows.map(row=>[row,0])),key),()=>!disposed&&table===target)
            .catch(error=>{if(!disposed&&table===target)notify('恢复自动行高没成功：'+describeError((error as Error).message),'error');})
            .finally(()=>{savingRowHeights=false;if(!disposed)updateToolbar();});
          notify('已恢复自动行高','success');
        }
      }catch(error){notify('操作失败：'+(error as Error).message,'error');}
    });
  },{signal});
  el.personalView.addEventListener('click',()=>{if(!ui||!table?.savePersonalView||hasUnsaved())return;const destination=table;
   // FIX-47：筛选项只给**可读**的列 —— 不可读的列（被升列成受 ACL 保护的正式字段）
   // 后端会拒「无权使用该列配置个人视图」，让它出现在下拉里只是让人白选一趟。
   const unreadable=unreadableColumns();
   editPersonalView(columns.map(c=>({id:c.fieldId,label:c.label,readable:!unreadable.has(c.fieldId)})),table.personalView?.view||emptyPersonalView(),async(view:PersonalView)=>{
    if(table!==destination||hasUnsaved())throw Error('工作表已切换或仍有未保存内容');
    await applyPersonalView(view);
  },ui);});
  /* ——————— 列头筛选（FIX-49/FIX-54）：Excel 的表现形式 ——————— */
  el.columnFilter.addEventListener('click',()=>{
    if(!table||hasUnsaved())return;
    const column=selectedColumnId();
    if(!column){notify('请先选中一列','info');return;}
    // 不可读的列不给开筛选（FIX-47 同一条闸）：后端会拒，用户白点一趟。
    if(unreadableColumns().has(column)){notify('这一列你看不到，不能拿它筛选','info');return;}
    // ④ 这一列的列头上出现小漏斗（点它才打开面板 —— 与 Excel 一致）。
    filterColumns.add(column);
    columnFilterOverlay?.refresh();
    /* 业务表（db）：筛选条件在服务端 ⇒ 开「按这一列精确筛选」的对话框。 */
    if(table.kind==='db'){dbCapabilities?.openFilter(column);return;}
    if(!ui||!table?.savePersonalView)return;
    // 面板是**贴在列头下面的小浮层**（FIX-54）—— 锚点（漏斗按钮的位置）由浮层自己算。
    columnFilterOverlay?.openPanel(column);
  },{signal});
  /**
   * 哪些列的列头要画小漏斗。
   * ＝ 用户点过「筛选」的列 ＋ **当前真有筛选条件**的列（像 Excel：筛过的列头上是实心漏斗）。
   */
  function markedFilterColumns():Set<string>{
    const marked=new Set<string>(filterColumns);
    for(const item of (table?.personalView?.view.filters||[]))marked.add(item.column);
    /* 业务表（db）的筛选条件在**服务端** filters 里 ⇒ 列头的小漏斗照画。 */
    for(const key of Object.keys(table?.filters?.()||{}))if(!key.startsWith('$'))marked.add(key);
    return marked;
  }
  /**
   * 打开某一列的筛选面板。
   *
   * 面板是**贴在列头下面的小浮层**（FIX-54：像 Excel，不像居中大弹窗）——
   * 锚点（那颗漏斗按钮的视口矩形）由浮层算好传进来。
   *
   * ⚠️ 业务表（db）走**另一条路**：它的筛选条件在服务端（`filters`），
   *    不存个人视图 ⇒ 浮层面板那套（值清单/多选/包含）用不上，
   *    改开「按这一列精确筛选」的对话框（服务端只认等值）。
   */
  function openColumnFilter(columnId:string,anchor:ColumnFilterAnchor,trigger:HTMLElement|null):ColumnFilterPanelHandle|null{
    if(table?.kind==='db'){
      if(hasUnsaved()){notify('还有未保存修改，请先完成再筛选','info');return null;}
      dbCapabilities?.openFilter(columnId);
      return null;
    }
    if(!ui||!table?.savePersonalView||hasUnsaved())return null;
    const destination=table;
    const column=columns.find(item=>item.fieldId===columnId);if(!column)return null;
    if(unreadableColumns().has(columnId)){notify('这一列你看不到，不能拿它筛选','info');return null;}
    const view=destination.personalView?.view||emptyPersonalView();
    return openColumnFilterPanel({
      column:{id:column.fieldId,label:column.label||column.fieldId,readable:true},
      view,
      sortDirection:view.sort?.column===columnId?view.sort.direction:null,
      loadValues:async()=>{
        if(!destination.columnValues)throw Error('这张表取不到列的值清单');
        return destination.columnValues(columnId);
      },
      // 存进**个人视图**（和「我的表格视图」同一份 view）⇒ 刷新还在、别人不受影响。
      applyFilter:async filter=>{
        const current=destination.personalView?.view||emptyPersonalView();
        await applyPersonalView(mergeColumnFilter(current,columnId,filter));
      },
      applySort:async direction=>{await applyServerSort(columnId,direction);},
      clearFilter:async()=>{
        const current=destination.personalView?.view||emptyPersonalView();
        await applyPersonalView(mergeColumnFilter(current,columnId,null));
      },
      anchor,trigger,
    });
  }
  host.querySelector('[data-relation]')!.addEventListener('click',async()=>{
    if(!ui||!table||hasUnsaved())return;
    const destination=table,selection=grid?.getSelection();
    const header=selection&&columns[selection.colIndex]?.fieldId;
    if(!header){notify('请先选择要关联的列','error');return;}
    const resource=destination.resourceId??(destination.kind==='xlsx'?destination.key:null);
    if(!resource){notify('请先为该表配置伴随工作簿','error');return;}
    try{
      const available=await listTables(signal);
      if(disposed||table!==destination)return;
      // FIX-17：目标表下拉只列**当前身份能访问、且真能当关联目标**的表（Excel 表格）。
      // 以前把业务对象也列进来，用户一点就撞上英文内部权限错误。
      await editTableRelation({table:resource,header,rowId:indexToName.get(selection!.rowIndex),structureVersion:destination.structureVersion,canStructure:destination.canStructure===true,
        targets:relationTargetChoices(available.entries),
        sourceColumnHasValues:columnHasValues(header),
        async loadTarget(id,query='',pageNumber=1){const target=await openTable(id);const page=query?await target.search(query,100,pageNumber):await target.loadPage(pageNumber,100);const targetResource=target.resourceId??(target.kind==='xlsx'?target.key:null);if(!targetResource)throw Error('Target workbook is not configured');return {resourceId:targetResource,total:page.total,columns:target.columns.map(c=>({id:c.fieldId,label:c.label||c.fieldId})),rows:page.rows.map(r=>({id:r.name,label:String(r[target.columns[0]?.fieldId]??r.name)+' · '+r.name}))};},
        async saved(){if(disposed||table!==destination)throw Error('表格已切换，请重新打开核对');await rebuildAfterStructure();},
      },ui);
    }catch(error){notify((error as Error).message,'error');}
  },{signal});
  const selectedSortColumn = () => columns[grid?.getSelection()?.colIndex??0]?.fieldId;
  el.sortAsc.addEventListener('click',()=>{const col=selectedSortColumn();if(col)void applyServerSort(col,'asc');});
  el.sortDesc.addEventListener('click',()=>{const col=selectedSortColumn();if(col)void applyServerSort(col,'desc');});
  el.sortReset.addEventListener('click',()=>{if(tableSort)void applyServerSort(tableSort.column,null);});
  el.export.addEventListener('click', async () => {
    if (disposed || !table || exporting) return;
    const destination = table;
    exporting = true; updateToolbar();
    try {
      const result = await exportCurrentTable(destination.resourceId??destination.key, destination.resourceId?'xlsx':destination.kind, { signal, hasUnsaved,
        stillCurrent: () => !disposed && table === destination });
      if (disposed || table !== destination) return;
      const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }));
      downloadUrls.add(url);
      const link = document.createElement('a'); link.href = url; link.download = result.filename;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
      notify('已开始下载当前已保存内容', 'success');
    } catch (error) { if (!disposed) notify(`导出失败：${(error as Error).message}`, 'error'); }
    finally { exporting = false; if (!disposed) updateToolbar(); }
  });

  function wireGrid() {
    removeGridCopy?.();
    grid!.onCommit(event=>{
      onCommit(event);
      rowBehaviors?.cellsChanged([{rowIndex:event.rowIndex,fieldId:event.fieldId}],{saved:false});
    });
    grid!.onSelection(syncFontControls);
    // 选区变了，助手那边的上下文也跟着变（FIX-03：用户问「这一格」时要能定位）。
    grid!.onSelection(syncChatContext);
    let hadPublicFrame=false;
    // —— **一帧最多做一次**（2026-10-30 装饰层性能）：
    //   Univer 每个动画帧都发 Layout ⇒ 不节流 ⇒ 一次滚动几十遍全量重算 ⇒ **卡**。
    grid!.onLayout(frameThrottle(()=>{candidateOverlay?.refresh();void rowBehaviors?.refresh();const available=!!grid?.getReviewFrame();if(available!==hadPublicFrame){hadPublicFrame=available;renderProposals();}}));
    // 合并说明：fast 那边把「清空选区」这个命令接到了 clearSelection（Delete/Backspace）；
    // ours 这边一律拦下并提示。两条都留：先接清空，其余命令仍提示未接入。
    grid!.onBlockedCommand((id) => {
      if(id==='sheet.command.auto-clear-content'){
        clearSelection();return;
      }
      notify(`本批未接入该命令（${id}），已停用。`, 'error');
    });
    // 只读列被编辑：明确告诉用户这是只读的，不能修改（不假装保存）。
    grid!.onReadOnlyEdit(({ label }) => {
      notify(`「${label}」为只读列，不能修改`, 'error');
    });
    // A2: 多格粘贴 —— 在 DOM 层拦截，走保存链逐格写入（B 的批量写接口到后换）。
    // 用 capture 阶段拦截，否则 Univer 自己的 paste 处理会先跑。
    if (gridPasteListener) el.grid.removeEventListener('paste', gridPasteListener, true);
    gridPasteListener = (event: ClipboardEvent) => {
      if (!table) return;
      if (openingTable) { event.preventDefault(); return; }
      if (grid?.isEditing()) return;
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      handlePaste(text);
    };
    el.grid.addEventListener('paste', gridPasteListener, { capture: true, signal });
    // PKG-002-T13: 复制出口 —— 显式设 HTML+TSV 到剪贴板（邮件编辑器可直接粘贴）。
    // Univer 的内置 copy 在 headless/受限环境下不设 clipboardData，这里手动拦截补上。
    // 挂在 document 上（capture），因为 Univer canvas 内部可能不冒泡到 el.grid。
    if (gridCopyListener) document.removeEventListener('copy', gridCopyListener, true);
    // 合并说明：ours 这边用 gridCopyListener 变量（换表时摘掉旧的）；
    // fast 那边叫 handleCopy。两条都留：函数叫 handleCopy，变量仍叫 gridCopyListener。
    const handleCopy = (event: ClipboardEvent) => {
      if (openingTable) { event.preventDefault(); return; }
      if (!table || !grid || grid.isEditing()) return;
      const focus = document.activeElement;
      // ★ fast 那边加的一条：焦点在输入框/文本域/可编辑元素里时**不许抢复制**
      //   （否则在别的输入框里按 Ctrl+C，表格这边把它拦了，用户复制不到自己的文字）。
      if (focus instanceof HTMLElement && !el.grid.contains(focus)
          && (focus.matches('input,textarea,[contenteditable="true"]') || focus.closest('[contenteditable="true"]'))) return;
      if (focus && focus !== document.body && !el.grid.contains(focus)) return;
      const textSelection = document.getSelection();
      if (textSelection?.toString() && !el.grid.contains(textSelection.anchorNode)) return;
      if (!event.clipboardData) return;
      try {
        const payload = selectionClipboardPayload();
        event.preventDefault(); event.stopImmediatePropagation();
        // 合并说明：fast 那边在复制时自己按行拼 TSV；ours 走公共的 buildClipboardPayload
        //   （同一份编码，粘贴侧也用它）。这里仍显式走一次 serializeClipboardTsv，
        //   保持「复制与粘贴共用同一个 TSV 编解码」这条契约一眼可见。
        const rows = payload.rows;
        const tsv = serializeClipboardTsv(rows);
        event.clipboardData.setData('text/plain', tsv);
        event.clipboardData.setData('text/html', payload.html);
        // 记下「刚复制的是哪一块、属于哪张表」—— 选择性粘贴的源区域靠它。
        lastCopiedRange={...payload.range};
        lastCopiedTableKey=table?.key??null;
        reportCopy(payload.range);
      } catch (error) {
        event.preventDefault();
        notify(`复制失败：${(error as Error).message}`, 'error');
      }
    };
    gridCopyListener = handleCopy;
    document.addEventListener('copy', gridCopyListener, { capture: true, signal });
    // ★ fast 那边的「换表时摘掉旧的 copy 监听」。
    removeGridCopy = () => document.removeEventListener('copy', handleCopy, true);
    // 列宽拖完/输入完写回后端，刷新重开才是拖完的样子。一列一个编号，重试按原编号补交。
    grid!.onColumnWidth((colIndex, widthPx) => {
      if(pendingStyle||undoing||pasteApplying){grid?.setColumnWidth(colIndex,table?.columnWidths[colIndex]??88);notify('正在保存其他操作，请稍后调整列宽','info');return;}
      // BASE967-50：拖动中连续报宽度，不逐次发请求 —— 停手 400ms 只发最终宽度；在途则合并成下一笔。
      widthLatest.set(colIndex, widthPx);
      const timer = widthDebounce.get(colIndex);
      if (timer) clearTimeout(timer);
      widthDebounce.set(colIndex, setTimeout(() => {
        widthDebounce.delete(colIndex);
        void flushColumnWidth(colIndex);
      }, 400));
    });
    grid!.onRowHeight((heights,before)=>{
      const target=table;
      if(!target?.writable||!target.writeRowHeights||hasUnsaved()){
        grid?.setRowHeights(before);notify(!target?.writeRowHeights?'这张表暂不支持保存行高':'当前不可修改行高，请稍后重试','info');return;
      }
      savingRowHeights=true;updateToolbar();const key='row-height-'+newIdempotencyKey();
      void retrySave(()=>target.writeRowHeights!(heights,key),()=>!disposed&&table===target)
        .catch(error=>{if(!disposed&&table===target){grid?.setRowHeights(before);notify('行高修改已停止：'+describeError((error as Error).message),'error');}})
        .finally(()=>{savingRowHeights=false;if(!disposed)updateToolbar();});
    });
    // 懒加载的唯一触发点：Univer 网格是 canvas 虚拟滚动，DOM 的 scroll 事件不会来。
    grid!.onScroll(() => {
      const d = grid?.getDiag();
      const [a, b] = d?.visibleRows ?? [-1, -1];
      // —— **滚到新的一段 ⇒ 把那一段的空必填格补画上**（2026-10-30 用户口径：
      //   「没有被填入就**用红色继续框和提醒**」）⇒ 框只画看得见的那些行 ⇒ 滚过去才画那一段。
      //   ⚠️ **网格那一侧自己分帧画**（这里只交清单，不占主线程）。
      // —— **网格那一侧自己补画**（滚动事件它自己订了 ⇒ 这里不重复交清单）。
      // —— **候选**：滚到新的一批行 ⇒ 把**看得见的**那些行算一次（不是全表）。
      void rowBehaviors?.refresh();
      if (a < 0 || b < 0) return;
      ensureLoadedAround(a, b);
    });
    // 长文本列开折行：tb 会触发自动行高，可见区立即算、视口外懒算。
    columns.forEach((column, index) => {
      // xlsx 的 text 列也要开折行 —— 用户 2026-10-11「拉窄回去不能折行」。
      // 只 wrap long_text 的话 xlsx 列全是 text，一根都不折。
      // wrap 只在「装不下」时折，短文本照样一行，开了一定没坏处。
      if (column.type === 'long_text' || column.type === 'text') grid!.wrapColumn(index);
    });
  }

  /**
   * 装完行之后补一次折行标记。
   * setValues 会整块替换单元格样式，先前设的 tb=WRAP 会被盖掉；
   * 只在建表时设一次不够，每装一页都要补回来，行高才会撑开。
   */
  function reapplyWrap(startRow?: number, count?: number) {
    // wrapColumn 在 wireGrid 标记一次，后续 setRow 自带折行样式。
    // 每页只重算本次加载的行，不能重放所有列的整表样式命令。
    grid?.recalcAutoHeights(startRow, count);
  }

  // —— 查找条（Excel 式：↑↓ 上一个/下一个，Enter/Shift+Enter/Esc）——
  function renderFindBar() {
    const has = hits.length > 0;
    const active = !!el.searchInput.value.trim();
    el.searchPrev.disabled = !has || searchLoading;
    el.searchNext.disabled = !has || searchLoading;
    // D7: ↑↓× 只在查找激活时出现，平时不常驻
    el.searchPrev.hidden = !active;
    el.searchNext.hidden = !active;
    el.searchClear.hidden = !active;
    // 无匹配/查询失败/查找中是 runSearch 写的消息，不能在这里被抹成空
    //（A9 实测：搜不到词时明明写了「无匹配」，随后 renderFindBar 又把它清掉，用户看不到）。
    if (has) el.searchCount.textContent = `命中 ${searchTotalRows} 行 · 已载 ${hits.length} 个命中 · 第 ${hitIndex + 1}/${hits.length} 个${searchLoadedRows < searchTotalRows ? "（分批加载）" : ""}`;
    else if (!active) el.searchCount.textContent = '';
  }

  async function goToHit(index: number) {
    const seq = searchSeq;
    const searchTable = table;
    if (searchLoading) return;
    // 后续命中按需取，不预先下载/渲染整张表，也不静默截断第 10,000 条以后。
    try {
    while (index >= hits.length && searchLoadedRows < searchTotalRows) {
      if (!await appendSearchPage(seq)) return;
      if (disposed || seq !== searchSeq || table !== searchTable) return;
    }
    if (!hits.length) return;
    hitIndex = (index + hits.length) % hits.length;
    const hit = hits[hitIndex];
      // xlsx 搜索回包已有原表 row_index。只有旧接口没带位置时才解析当前这一行。
      const rowIndex = hit.rowIndex >= 0 ? hit.rowIndex : await resolveIndex(hit.name);
      if (disposed || seq !== searchSeq || table !== searchTable) return;
      if (rowIndex < 0) {
        el.searchCount.textContent = '未能定位该行，请刷新后重试。';
        renderFindBar();
        return;
      }
      hit.rowIndex = rowIndex;
      const colIndex = Math.max(0, columns.findIndex((c) => c.fieldId === hit.fieldId));
      await loadPage(Math.floor(rowIndex / PAGE_LENGTH) + 1);
      if (disposed || seq !== searchSeq || table !== searchTable) return;
      grid?.scrollToRow(rowIndex, colIndex);
      grid?.selectCell(rowIndex, colIndex);
      dropHighlight?.();
      dropHighlight = grid?.highlightCell(rowIndex, colIndex) ?? null;
      el.searchCount.textContent = `命中 ${searchTotalRows} 行 · 第 ${hitIndex + 1}/${hits.length} 格${searchLoadedRows < searchTotalRows ? '（分批加载）' : ''}`;
    } catch (error) {
      if (seq === searchSeq) el.searchCount.textContent = `定位失败：${(error as Error).message}`;
    }
    renderFindBar();
  }

  function clearFind() {
    cancelSearchTimer();
    searchReads.cancel();
    searchSeq += 1;
    searchTerm = ''; searchPage = searchTotalRows = searchLoadedRows = 0; searchLoading = false;
    hits = [];
    hitIndex = -1;
    dropHighlight?.();
    dropHighlight = null;
    el.searchInput.value = '';
    el.searchCount.textContent = '';
    renderFindBar();
  }

  async function appendSearchPage(seq: number): Promise<boolean> {
    if (!table || searchLoading || seq !== searchSeq) return false;
    const searchTable = table;
    searchLoading = true;
    renderFindBar();
    try {
      const result = await searchTable.search(searchTerm, PAGE_LENGTH, searchPage + 1, searchTicket?.signal);
      if (disposed || seq !== searchSeq || table !== searchTable) return false;
      searchPage += 1;
      searchTotalRows = result.total;
      searchLoadedRows += result.rows.length;
      for (const row of result.rows) {
        const rowIndex = getRowViewMetadata(row)?.rowIndex ?? nameToIndex.get(row.name) ?? -1;
        for (const match of findAllHits(row, searchTerm, columns)) hits.push({ name: row.name, rowIndex, ...match });
      }
      // 不假称已下载全部。空回包却宣称还有更多时明确报告，避免无限空翻页。
      if (!result.rows.length && searchLoadedRows < searchTotalRows) throw new Error('命中分页返回空数据，请重试查询');
      return true;
    } finally {
      if (seq === searchSeq) { searchLoading = false; renderFindBar(); }
    }
  }

  async function runSearch(term: string) {
    cancelSearchTimer();
    const trimmed = term.trim();
    if (trimmed === searchTerm && searchLoading) return;
    const seq = ++searchSeq;
    if (!table) return;
    if (!trimmed) { clearFind(); return; }
    searchTicket = searchReads.begin();
    searchTerm = trimmed;
    searchPage = searchTotalRows = searchLoadedRows = 0;
    searchLoading = false;
    hits = []; hitIndex = -1;
    el.searchClear.hidden = false;
    el.searchCount.textContent = '查找中…';
    try {
      if (!await appendSearchPage(seq) || seq !== searchSeq || disposed) return;
      if (!searchTotalRows) {
        el.searchCount.textContent = '无匹配';
        dropHighlight?.(); dropHighlight = null;
      } else {
        el.searchCount.textContent = `命中 ${searchTotalRows} 行 · 已载 ${searchLoadedRows} 行`;
        if (hits.length) await goToHit(0);
      }
      renderFindBar();
    } catch (error) {
      if (seq !== searchSeq || disposed) return;
      el.searchCount.textContent = `查询失败：${(error as Error).message}`;
      hits = []; hitIndex = -1;
      renderFindBar();
    }
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const searchReads = createLatestRead(signal);
  let searchTicket: {signal: AbortSignal; isCurrent():boolean} | null = null;
  function cancelSearchTimer(){ clearTimeout(searchTimer);searchTimer=undefined; }
  function scheduleSearch(){
    cancelSearchTimer();
    searchReads.cancel();searchSeq++;searchLoading=false;
    if(!el.searchInput.value.trim()){clearFind();return;}
    searchTimer=setTimeout(()=>{searchTimer=undefined;void runSearch(el.searchInput.value);},250);
  }
  let composing = false;
  el.searchInput.addEventListener('compositionstart', () => {
    composing = true; cancelSearchTimer();searchReads.cancel();searchSeq++;searchLoading=false;
  });
  el.searchInput.addEventListener('compositionend', () => {
    composing = false;
    // 拼音上屏后才搜：组合期间搜会搜出一堆半截字母。
    scheduleSearch();
  });
  el.searchInput.addEventListener('input', () => {
    if (composing) return;
    // 打字即搜。以前只在清空时才搜、回车才搜，用户打了字在等，等来的是「无匹配」。
    scheduleSearch();
  });
  el.searchInput.addEventListener('keydown', (event) => {
    if (composing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!el.searchInput.value.trim()) return;
      cancelSearchTimer();
      if (searchLoading && searchTerm === el.searchInput.value.trim()) return;
      if (!hits.length || searchTerm !== el.searchInput.value.trim()) void runSearch(el.searchInput.value);
      else if (event.shiftKey) void goToHit(hitIndex - 1);
      else void goToHit(hitIndex + 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      clearFind();
    }
  });
  el.searchNext.addEventListener('click', () => void goToHit(hitIndex + 1));
  el.searchPrev.addEventListener('click', () => void goToHit(hitIndex - 1));
  el.searchClear.addEventListener('click', clearFind);
  el.back.addEventListener('click', backToList);
  el.undo.addEventListener('click', () => void runUndo());
  // Cmd/Ctrl+F 唤起查找条（N2-A2）。焦点落到搜索框，选中已有文字方便替换。
  // 在 window 捕获阶段拦：Univer 会抢键盘。
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (disposed || !host.isConnected || !table || (event.target !== document.body && !host.contains(event.target as Node))) return;
    if (event.key !== 'f' && event.key !== 'F') return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    el.searchInput.focus();
    el.searchInput.select();
  }, { capture: true, signal });

  // —— 结构动作（N2-A1）：末尾加行 / 加列 / 改表头 / 改表名 ——
  //
  // 四个都走 B 的公共 Action（`files.sheet_*`），不是前端自己改数据。
  // 每个动作成功后**刷新表元数据 + 重建网格**（列变了 / 行变了）。
  // 失败时把服务端的原因原样弹出来（空表头 / 重名 / 无权限），不静默吞。

  /** 结构动作后重建网格：清缓存、重开、画回来。 */
  async function rebuildAfterStructure() {
    if (!table) return;
    // —— **预览状态复位**：重建之后列序以服务端为准，预览那套状态一律清掉 ——
    columnPreviewBackup=null;columnPreviewing=false;columnDragOrder=null;
    const key = table.key;
    // 有未保存的修改先问一声 —— 重建会丢掉未提交的输入。
    const stuck = pending.size + pendingWidths.size;
    if (stuck > 0) {
      notify(`还有 ${stuck} 笔未完成修改，请先核实原操作；不会丢弃输入重建表格`,'error');return;
    }
    await openTableByKey(key,{internal:true});
  }

  /** 做一次结构动作，成功后刷新界面。失败弹原因。 */
  async function runStructureAction(action: () => Promise<void>, label: string) {
    if (!table) return;
    // 合并说明：ours 这边拦「有未保存修改 / 有未确认的候选修改」；
    // fast 那边拦「还有保存或文件操作没核实」。两条都留。
    if (hasUnsaved()) { notify('还有未保存修改，请处理后再改表格结构', 'info'); return; }
    if([...inlineControllers.values()].some(controller=>controller.hasEdits())){notify('还有未确认的候选修改，请先审核或取消修改，再改表结构','info');return;}
    if (pending.size || pendingWidths.size || pendingFileOperations.size) {
      notify('请先等待保存完成或核实原操作，再调整表格','error');return;
    }
    el.scope.textContent = `${label}中…`;
    try {
      const destination=table;
      await retrySave(action,()=>!disposed&&table===destination);
      await rebuildAfterStructure();
      notify(`${label}成功`, 'success');
    } catch (error) {
      const msg = (error as Error).message || String(error);
      notify(describeError(`${label}失败：${msg}`), 'error');
      el.scope.textContent = `${table.personalView?.view.filters.length?"筛选显示":"共"} ${totalRows} 行${table.personalView?.view.filters.length?" / 全表 "+table.personalView.source_total_rows+" 行":""} · 已加载 ${filled.size} 行 · 搜索范围：全表有权列`;
    }
  }

  /**
   * ★ 合并说明（fast 那边的「加一行 / 加一列 / 改表头」按钮与原位输入框）：
   *   fast 的工具栏上有 data-add-row / data-add-col / data-rename-header / data-inline-edit
   *   四个按钮和一个原位改名输入框；ours 的 FIX-37 工具栏改版把「行列」收进了
   *   「行列」按钮 + 右键菜单（mountHeaderRename 负责列头双击改名），
   *   工具栏上**不再有**这四个按钮（判据 excel-font-style.test.ts 也钉了这一点）。
   *   所以这里**不接按钮**，只保留功能入口：
   *     · 加一行 / 加一列 / 插列 / 删列 ⇒ 「行列」按钮（el.structure → editStructure 弹窗）
   *       与右键菜单（menuItemsFor），两者共用 runStructure 这一条受管保存路径；
   *     · 改表头 ⇒ 列头双击（mountHeaderRename）。
   *   fast 的文件操作下拉里「在当前列前插入…」要一个**列名**，
   *   那一条单独用 prompt 问（见下面的 askColumnName）。
   */
  function askColumnName(placeholder: string): string | null {
    const value = globalThis.prompt(placeholder);
    if (value === null) return null;
    const trimmed = value.trim();
    if (!trimmed) { notify('名称不能为空', 'error'); return null; }
    return trimmed;
  }

  // —— D6: 表名原位编辑 ——————————————————
  let titleEditOpen=false;
  el.title.addEventListener('dblclick', () => {
    if (!table || !canChangeStructure() || hasUnsaved()) return;
    titleEditOpen=true;
    el.title.hidden = true;
    el.titleInput.hidden = false;
    el.titleInput.value = table.title || '';
    el.titleInput.focus();
    el.titleInput.select();
  });

  function commitTitleEdit() {
    if(!titleEditOpen)return;
    const val = el.titleInput.value.trim();
    if(!val){notify('表名不能为空','error');return;}
    titleEditOpen=false;
    el.titleInput.hidden = true;
    el.title.hidden = false;
    if (!val || !table || val === table.title) return;
    const renameKey='struct-ren-'+newIdempotencyKey();
    const destination=table;
    void runStructureAction(async () => {
      await destination.renameTable(val, renameKey);
      el.title.textContent = val;
      syncChatContext();   // 表名改了，助手那边的上下文也得跟着改（FIX-03）
    }, '改表名');
  }
  el.titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); titleEditOpen=false;el.titleInput.hidden = true; el.title.hidden = false; }
  });
  el.titleInput.addEventListener('blur', commitTitleEdit);

  // D7: 文件操作菜单 —— 展开/收起与「点外面关闭」由上面的通用下拉机制（toolMenus）统一管，
  // 这里不再单独给 toggle 挂一套（fast 那边的 el.structureToggle 就是这个作用）。
  async function performFileOperation(action:'structure'|'sort'|'style',payload:Record<string,unknown>,label:string) {
    if (!table?.fileOperation) {notify('当前文件服务未提供该功能','error');return;}
    if (pending.size||pendingWidths.size||pendingFileOperations.size||grid?.isEditing()) {
      notify('请先完成当前编辑和保存，再执行文件操作','error');return;
    }
    const target=table,key=newIdempotencyKey();
    const op={state:'saving' as SaveState,message:'',uncertain:false,run:async()=>{
      op.state='saving';renderSaveBar();
      let committed=false;
      try {
        await target.fileOperation!(action,payload,key);
        committed=true;
        pendingFileOperations.delete(key);renderSaveBar();
        await rebuildAfterStructure();notify(`${label}已保存，可在文件历史中查看原版本`,'success');
      } catch(error) {
        if(committed){notify(`${label}已保存，但界面未能更新；请刷新核对`,'error');return;}
        op.state='failed';op.message=(error as Error).message;
        op.uncertain=/未知|核实|回执|网络|timeout/i.test(op.message);
        notify(op.message,'error');renderSaveBar();
      }
    }};
    pendingFileOperations.set(key,op);await op.run();
  }
  el.fileopsDropdown.addEventListener('click',event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-file-operation]');
    if (!button||!table?.fileOperation||!grid)return;
    el.fileopsDropdown.hidden=true;
    const range=grid.getSelectionRange();if(!range){notify('请先选择要操作的单元格','error');return;}
    const operation=button.dataset.fileOperation!,header=columns[range.startCol]?.fieldId;
    const row=indexToName.get(range.startRow);
    if (!header||!row){notify('请先选择已经加载的行列','error');return;}
    if (operation==='insert-column'){
      // 插列要一个**列名**：fast 那边是工具栏里的原位输入框，ours 的工具栏没有那个框
      // （FIX-37 改版后移除），这里改用系统输入框问一次。
      const name=askColumnName('新列名…');
      if(!name)return;
      void performFileOperation('structure',{operation:'column_insert',before_header:header,header:name},'插入列');
      return;
    }
    let action:'structure'|'sort'|'style'='structure',payload:Record<string,unknown>;
    if(operation==='insert-row')payload={operation:'row_insert',before_row_id:row};
    else if(operation==='delete-rows') {
      const ids=Array.from({length:range.endRow-range.startRow+1},(_,i)=>indexToName.get(range.startRow+i));
      if(ids.some(id=>!id)){notify('选区含未加载的行，请先加载后操作','error');return;}
      payload={operation:'row_delete',row_ids:ids};
    } else if(operation==='delete-columns')payload={operation:'column_delete',headers:columns.slice(range.startCol,range.endCol+1).map(col=>col.fieldId)};
    else if(operation.startsWith('sort-')){action='sort';payload={header,direction:operation.slice(5)};}
    else {
      action='style';const cells=[];
      if((range.endRow-range.startRow+1)*(range.endCol-range.startCol+1)>20000){notify('一次最多设置两万格格式','error');return;}
      for(let r=range.startRow;r<=range.endRow;r++)for(let c=range.startCol;c<=range.endCol;c++){
        const id=indexToName.get(r),column=columns[c];
        if(!id||!column||column.readOnly){notify('选区含未加载或只读单元格，未修改','error');return;}
        cells.push({row_id:id,header:column.fieldId});
      }
      const styles:Record<string,unknown>={bold:{bold:true},normal:{bold:false},number:{number_format:'#,##0.00'},
        date:{number_format:'yyyy-mm-dd'},wrap:{wrap_text:true},border:{border:'all'}};
      if(!styles[operation])return;
      payload={cells,style:styles[operation]};
    }
    const execute=()=>void performFileOperation(action,payload,button.textContent||'文件操作');
    if(operation.startsWith('delete-')){
      ui?.dialog({title:'删除选中的文件行列？',body:'<p>本次只修改当前文件，不删除业务记录。原文件版本保留。</p>',
        actions:[{label:'取消'},{label:'确认删除',variant:'pri',onClick:()=>{ui.closeModal();execute();}}]});
    } else execute();
  });
  /* 点到页面别处（host 之外）也把「文件操作」下拉收起来 ——
     ours 的通用下拉机制只管 host 内部的点击；这一条补上 host 之外的那一半。 */
  document.addEventListener('click', (e) => {
    if (!el.fileopsMenu.contains(e.target as Node)) {
      el.fileopsDropdown.hidden = true;
    }
  }, { signal });

  /**
   * Cmd+Z / Ctrl+Z 分两件事，别混：
   *   · **正在单元格里打字** —— 撤的是那句还没发出去的输入，丢掉即可，**不发请求**；
   *   · **没在打字** —— 撤的是刚才那一格，走正常保存链（带幂等键 + 版本号）。
   *
   * 必须拦住默认的 Cmd+Z：Univer 自带的 `univer.command.undo` 是**本地撤销**，
   * 只改画布不落文件 —— 值看起来回去了、文件里还是新的，是假成功。
   * 在打字那种情况放行，让编辑器处理它自己的文本撤销。
   *
   * 监听挂在 **window 的捕获阶段**：Univer 的快捷键服务自己也在拦截按键并
   * stopPropagation，挂在 host 的冒泡阶段根本收不到（2026-10-11 就这么漏的——
   * 点按钮能撤、按 Cmd+Z 不动）。捕获阶段抢在它前面，才轮得到我们说话。
   */
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (disposed || !workbookShortcutAllowed(event, host, !!grid?.isEditing(), !!grid?.getSelectionRange())) return;
    const key = (event.key || '').toLowerCase();
    if (key !== 'z' || event.shiftKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    undoKeyPresses += 1;
    if (grid?.isEditing()) {
      // 在编辑浮层里：丢掉当前输入（Esc），回到格子原来的值。不发请求。
      event.preventDefault();
      // stopImmediatePropagation：stopPropagation 只拦「往别的节点传」，
      // 同一个 window 上后注册的监听（Univer 的快捷键服务）照样跑 ——
      // 于是「只撤一步」被它那套本地撤销栈破掉。要连同节点上的后续监听一起掐。
      event.stopImmediatePropagation();
      undoEditDiscards += 1;
      grid.cancelEdit();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    undoRuns += 1;
    void runUndo();
  }, { capture: true, signal });

  // —— 失败重试 / 放弃（照 file-detail.js 的「重试原操作」条）——
  el.retry.addEventListener('click', () => {
    if(pendingFileOperations.size){for(const op of pendingFileOperations.values())if(op.state==='failed')void op.run();return;}
    const stuck = [...pending.values()].filter((op) => op.state === 'failed' || op.state === 'conflict');
    const stuckWidths = [...pendingWidths.values()].filter((op) => op.state === 'failed' || op.state === 'conflict');
    const stuckStyle=pendingStyle&&['failed','conflict'].includes(pendingStyle.state)?pendingStyle:null;
    const stuckInput=pendingInput&&['failed','conflict','idle'].includes(pendingInput.state)?pendingInput:null;
    if (!stuck.length && !stuckWidths.length && !stuckStyle && !stuckInput) return;
    if(stuckInput&&table?.key===stuckInput.target.key){stuckInput.state='idle';void drainInputs();}
    // T08: 上报重试事实
    // Retrying the same operation reuses its core receipt, not a new UI audit.
    // 合并说明：ours 这边逐笔重新入队；fast 那边入队后还要 retry() 一下 ——
    //   队列在「未知/失败」时会暂停，重试按钮要把它唤醒。
    stuck.forEach((op) => void enqueueSave(op));
    saveQueue.retry();
    stuckWidths.forEach((op) => void runWidthSave(op));
    if(stuckStyle)void runStyleSave(stuckStyle);
  });
  el.discard.addEventListener('click', () => {
    // 合并说明：ours 这边分别处理「输入队列」和「格式保存」；fast 那边处理「文件操作」。
    // 三条都留，顺序：输入队列 → 格式 → 文件操作。
    if(inputQueue.length){
      if(!pendingInput?.discardable||pendingInput.state==='saving'){notify('请先核实结果未知的原操作','info');return;}
      if(!pendingInput.discardConfirmed){pendingInput.discardConfirmed=true;renderSaveBar();return;}
      const key=table!.key;inputQueue.length=0;pendingInput=null;lastDiscardableFailure=null;setSaveState('idle','已放弃明确未写入的输入，重新读取正式值');void openTableByKey(key);return;
    }
    // ⚠️ **「明确没写进去」的那一笔已经不在队列里了**（2026-10-30 · PKG-133 · 缺陷③）
    //   ⇒ 这里要**认它**（`lastDiscardableFailure`）⇒ 不然点了「放弃」什么也不做
    //   ⇒ 人既不能重试、也不能放弃 ⇒ 那笔就永远卡在那儿。
    if(lastDiscardableFailure){
      if(lastDiscardableFailure.uncertain){notify('这一笔结果未明：请用「重试原操作」核实，不能放弃（放弃会丢数据）','info');return;}
      if(!lastDiscardableFailure.discardConfirmed){lastDiscardableFailure.discardConfirmed=true;renderSaveBar();return;}
      const key=table!.key;lastDiscardableFailure=null;pendingInput=null;setSaveState('idle','已放弃明确未写入的输入，重新读取正式值');void openTableByKey(key);return;
    }
    if(pendingStyle&&pendingStyle.state!=='saving'){
      const key=pendingStyle.target.key;pendingStyle=null;setSaveState('idle','重新读取正式格式');void openTableByKey(key);return;
    }
    if(pendingFileOperations.size){
      /* ⚠️ **「结果不明」的也许放弃**（要**二次确认**）———
         原来直接拒 ⇒ 人**被锁死**：离页保护拦着刷新、放弃又拒 ⇒ 出不去
         （用户 2026-10-29 15:4x：「刷新页面也不能」）。
         放弃**不等于丢数据**：那一笔在服务端有操作编号，可按编号核实；
         页面重开以**服务端正式值**为准。 */
      if([...pendingFileOperations.values()].some(op=>op.state==='saving')){notify('还有操作正在写入，请等它结束','info');return;}
      const uncertain=[...pendingFileOperations.values()].some(op=>op.uncertain);
      if(uncertain&&!discardFileOpsConfirmed){
        discardFileOpsConfirmed=true;
        renderSaveBar();
        notify('这些操作结果未明：放弃后以服务端正式值为准（操作编号仍可核对）。再点一次「放弃」确认。','info');
        return;
      }
      discardFileOpsConfirmed=false;
      pendingFileOperations.clear();renderSaveBar();return;
    }
    const stuck = [...pending.values()].filter((op) => op.state === 'failed' || op.state === 'conflict');
    const stuckWidths = [...pendingWidths.values()].filter((op) => op.state === 'failed' || op.state === 'conflict');
    if (stuck.some(op => op.uncertain)) {
      notify('保存结果尚未核实，请先点「重试原操作」；不能把可能已写入的操作当作未保存丢弃', 'error');
      return;
    }
    stuck.forEach((op) => {
      pending.delete(op.key);
      if (![...pending.values()].some(other => other.name === op.name && other.fieldId === op.fieldId))
        grid?.setRowValue(op.rowIndex, op.fieldId, op.before);
      undoStack = undoStack.filter(item => item.opId !== op.key);
    });
    stuckWidths.forEach((op) => pendingWidths.delete(op.key));
    saveQueue.retry();
    setSaveState('idle', '未修改');
    notify(`已放弃 ${stuck.length + stuckWidths.length} 笔明确未完成操作`, 'info');
  });
  window.addEventListener('beforeunload',event=>{if(inputQueue.length){event.preventDefault();event.returnValue='';}},{signal});
  // 网络恢复时把重试按钮亮出来：断网期间失败的那些该能补交了。
  window.addEventListener('online', () => {
    const stuck = [...pending.values()].some((op) => op.state === 'failed' || op.state === 'conflict')
      || [...pendingWidths.values()].some((op) => op.state === 'failed' || op.state === 'conflict') || !!pendingStyle&&['failed','conflict'].includes(pendingStyle.state);
    if (stuck) {
      renderSaveBar();
      notify('网络已恢复，未保存输入仍保留', 'info');
    }
  }, { signal });

  /** 打开一张表并铺满网格。业务表和 xlsx 走同一个口，界面不显示存储类型。 */
  async function openTableByKey(key: string,options:{internal?:boolean;source?:'db'|'xlsx'}={}) {
    const internal=options.internal===true&&table?.key===key;
    if(!internal&&inputQueue.length){notify('输入尚未保存，请先核实原操作后切表','info');return;}
    const openGeneration = ++tableOpenGeneration;
    clearInlineReviews(internal);headerRename?.dispose();headerRename=null;columnDrag?.dispose();columnDrag=null;
    // 换表 ⇒ 上一张表的小漏斗标记作废（列名都可能不一样了）。
    columnFilterOverlay?.dispose();columnFilterOverlay=null;filterColumns.clear();
    openingTable = true;
    setOpenLoading(true);
    try {
    updateToolbar();
    el.picker.hidden = true;
    host.classList.remove('file-center-page');   // 表打开态用编辑器样式
    el.grid.hidden = true;
    el.back.hidden = standaloneMode ? true : false;
    // 表打开态才有返回口；清单态是自己，不显示。
    // 独立模式（?standalone=1）：这张表有自己的入口（侧栏直接点进来）⇒ 没有「返回列表」——
    // 清单页跟这次打开无关（返回口只做清单页的事：清 object、带搜索词回去）。
    // 表打开态恢复编辑器顶栏和底部提示行
    const editorBar = host.querySelector('.excel-bar') as HTMLElement;
    if (editorBar) editorBar.hidden = false;
    const toolRow = host.querySelector('.excel-toolrow') as HTMLElement;
    if (toolRow) toolRow.hidden = false;
    const saveStateBar = host.querySelector('.excel-save-state') as HTMLElement;
    if (saveStateBar) saveStateBar.hidden = true;
    el.title.textContent = 'Excel 表格';
    el.scope.textContent = '加载中…';
    // 只在**换表**时清残留（旧行会串到新表上）和撤回栈（不许跨表撤）。
    // **同一张表的重建**（结构操作后）不清 undoStack —— 加了一行不等于
    // 「刚才那一格的修改就不在了」。
    const isSameTable = table?.key === key;
    /* 换表 ⇒ 服务端筛选条件清空（条件是「这张表的」条件，不是全局的）。 */
    if(!isSameTable)dbFilters={};
    pageGeneration++; viewportReads.reset(); cancelSearchTimer();searchReads.cancel();
    pageCache.clear();
    loadingPages.clear();
    filled.clear();
    // —— **换表／重画这张表** ⇒ 框红的那本账清空重来（**旧表的框不许跟到新表上**）——
    requiredEmptyLedger.clear();
    nameToIndex.clear();
    indexToName.clear();
    pending.clear();
    if (!isSameTable) undoStack = [];
    // 换表了，「刚复制的那块」就不再算源 —— 源和目标必须同一张表。
    forgetCopiedSource(isSameTable);
    stripNoticeShown = false;   // 换表/重开后重新提示一次
    pendingWidths.clear();
    // 换表/重开：丢掉还没发出的列宽合并任务（否则会拿旧表的宽度写到新表）
    widthDebounce.forEach((t) => clearTimeout(t));
    widthDebounce.clear();
    widthLatest.clear();
    widthLastSent.clear();
    searchSeq += 1; searchLoading = false;
    searchTerm = ''; searchPage = searchTotalRows = searchLoadedRows = 0;
    hits = [];
    hitIndex = -1;
    dropHighlight?.();
    dropHighlight = null;

    const targetUrl = new URL(location.href);
    const routeSource = targetUrl.searchParams.get('object') === key ? targetUrl.searchParams.get('table_source') : null;
    const source = options.source ?? (table?.key === key ? (table.resourceId ? 'db' : table.kind)
      : routeSource === 'db' || routeSource === 'xlsx' ? routeSource : undefined);
    openRetryTarget = {key, source};
    // —— **并行**（2026-10-30 用户口径：「最好是并行或者提前存住某处」）：
    //   「受管/必填列清单」**不等读表完**就去拉 —— xlsx 表的 key 就是文件 id
    //   ⇒ 星号与红底能**早几百毫秒**上屏（而开表→能编辑**一点不受影响**）。
    const earlySource = source ?? (routeSource==='db'||routeSource==='xlsx'?routeSource:'');
    const earlyPromotion = earlySource==='xlsx'?fetchPromotionDefinition(key):null;
    const resolvedTable = await openTable(key, signal, source);
    if (disposed || openGeneration !== tableOpenGeneration) return;
    table = resolvedTable;
    openRetryTarget = {key, source:table.objectInfo?'db':table.kind};
    // 旧链接首次成功识别后记下明确来源；刷新继续读取目标，不再扫对象目录。
    if(targetUrl.searchParams.get('object')===key){targetUrl.searchParams.set('table_source',table.objectInfo?'db':table.kind);window.history.replaceState(window.history.state,'',targetUrl.toString());}
    tableSort = null;
    tableSortWired = false;
    if (disposed) return;
    /* 重开同一张表（写完刷新、结构动作后）⇒ 把服务端的筛选条件**放回去**
       （表对象是新的，条件放在表对象里会丢）。 */
    if(table.kind==='db'&&Object.keys(dbFilters).length)table.setFilters?.(dbFilters);
    exportCapabilities = null;
    const openedTable = table;
    void readExportCapabilities(table.resourceId??key, table.resourceId?'xlsx':table.kind, { signal }).then(capability => {
      if (disposed || table !== openedTable) return;
      exportCapabilities = capability;
      updateToolbar();
    }).catch(() => { if (!disposed && table === openedTable) updateToolbar(); });
    columns = table.columns;
    // PKG-004：开表时从 promotion_definition 填 promotedColumns（晋升列集合）。
    // 只填集合，界面上不区分哪列是晋升的——A-a 判据。
    // 非阻塞：不挡 renderScope，API 慢也不影响开表。
    promotedColumns = new Set();
    canManageFieldPermissions = false;
    canManageTablePermissions = false;
    table.promotedColumns = promotedColumns;
    // ⚠️ **这套规则只管「Excel 网格形式」的页面**（2026-10-30 用户口径）：
    //   「像邮件、通知书助手、example 邮件规则表、文件中心这种**由业务域根据数据库
    //     重新造出来的页面**（**不以 excel 形式交互的**），就不需要这种规则」。
    //   ⇒ 那些页面**自己按数据库造**（DOM）⇒ 不经过这张网格 ⇒ 天然不套
    //     （绿底列头／必填红底／晋升定义都是**这张网格**上的东西）。
    //   ⇒ 这里管的是**表格页**（Excel 工作面）：xlsx 表按晋升定义、对象表按「字段＝受管」。
    //
    // —— **对象的每一列都是受管列**（2026-10-30 用户口径：
    //   「所有的对象 —— 它的每一列直接就是对象的字段（title/customer/sku/quantity）
    //   都是受管列，就是说**字段＝受管＝对象＝晋升，不论如何**」）。
    //   ⇒ **纯对象表**（db 表，没有配套的 xlsx）⇒ 列**就是**对象的字段 ⇒ **全部受管**
    //   ⇒ 列头**白字绿底**。
    //   ⚠️ **对象不一定有对应的 xlsx** ⇒ 这一条**只管「这一列归系统管」这个语义**，
    //   不牵涉「绑到哪个文件」（那是 xlsx 晋升那条路的事）。
    //   ⚠️ **有配套 xlsx 的表**（companion）⇒ 列来自 xlsx ⇒ 受管列仍按**晋升定义**算。
    if (openedTable.kind === 'db' && !openedTable.objectInfo?.companion) {
      promotedColumns = new Set(columns.map(column => column.fieldId));
      table.promotedColumns = promotedColumns;
      // —— **列头样式按「表头名」匹配**（`columnHeaderCfg` 用 `managed.has(label)`）
      //   ⇒ 这里必须给**表头名**（xlsx 那条路字段 id 恰好＝表头名，所以一直对得上；
      //   db 表字段 id ≠ 表头名 ⇒ 给错了就**匹配不上 ⇒ 绿底出不来**）。
      pendingManagedHeaders = columns.map(column => column.label || column.fieldId);
    }
    const promotionTableId = openedTable.resourceId ?? key;
    // —— **提前存住的那份先顶上**（2026-10-30 用户口径：「提前存住某处」）：
    //   这张表上一轮开过 ⇒ 清单**已经在手上** ⇒ 星号与红底**立刻**就有；
    //   后台再拉一份新的来替换（**旧清单只是先到，不是最终**）。
    // —— **只有「xlsx 支撑的表」才拉晋升定义**（2026-10-30 用户口径：
    //   「所有的对象 —— 它的每一列直接就是对象的字段 ⇒ 都是受管列」）
    //   ⇒ **纯对象表**的受管列**就是它自己的全部列** ⇒ 拉晋升定义既没用（回包里没有受管列）
    //   又会**把上面设好的全绿覆盖成空**（2026-10-30 用户报的「别的表绿顶没有更新」）。
    const isXlsxBacked = openedTable.kind === 'xlsx';
    const cachedDefinition = isXlsxBacked ? promotionDefinitionCache.get(promotionTableId) : null;
    if (cachedDefinition) applyPromotionDefinition(cachedDefinition);
    /* —— **取数**：**复用并行那份**（xlsx）；缓存里有就用缓存；
       都没有（db 表的资源 id 要等读表完）⇒ 现在拉。
       ⚠️ **不许再发起一遍**（2026-10-30 实测：开表那趟这个接口被打了两遍 ——
         +774ms 一次、+1772ms 一次 ⇒ 同一个接口白打一趟，晋升定义是算出来的，不便宜）。
       ⇒ 这里**只等那个已经在跑的 promise**，不再 new 一个。
       ⚠️ **复用前先对一下表 id**：并行那份是拿 `key` 发的，
         这里要的是 `promotionTableId`（`resourceId ?? key`）⇒
         **两者不是同一个**时**不许复用**（否则拿的是另一张表的清单）。 */
    const sameTableAsEarly = earlyPromotion ? (promotionTableId === key) : false;
    const promotionPromise = sameTableAsEarly
      ? earlyPromotion
      : (cachedDefinition ? Promise.resolve(null) : (isXlsxBacked ? fetchPromotionDefinition(promotionTableId) : null));
    if (promotionPromise) void promotionPromise.then(result => {
      if (!result || disposed || table !== openedTable) return;
      canManageFieldPermissions = result.canManageFields;
      // 表级权限（PKG-117-T01）：**不必有已晋升列** —— 有管理权就能定整张表的权限。
      canManageTablePermissions = result.canManageTable;
      updateToolbar();
      promoDebug = `ok:${result.status}:cols=${result.definition.promoted.length}:promoted=${result.definition.promoted.length}`;
      promotionDefinitionCache.set(promotionTableId, result.definition);
      applyPromotionDefinition(result.definition);
    });
    el.title.textContent = table.title;
    /* 业务表（db）：取那份服务端元数据 —— 八项能力的闸全靠它
       （export.available／import.available／history／lifecycle／operations／query）。
       取不到就把闸全关掉（fail-closed），不猜。 */
    dbObjectMeta=openedTable.kind==='db'?(openedTable.objectInfo??null):null;
    updateToolbar();
    // ★ fast 那边的规则：文件操作（插删行列/整表排序/选区格式）只对**可写的 xlsx 表**开放。
    //   ours 的 FIX-37 是「不整项消失、置灰并说清原因」，但这条是**能力闸**不是权限 ——
    //   DB 表根本没有文件服务这套动作，摆出来点了只会报错，所以整个菜单收起。
    //   （ours 自己的「表格」下拉里只有「字段权限」，按 ours 的规矩照常显示。）
    el.fileopsMenu.hidden = table.kind !== 'xlsx' || !table.writable || !table.fileOperation;
    host.querySelectorAll<HTMLButtonElement>('[data-file-operation]').forEach(button=>button.hidden=!table?.fileOperation);
    // 只读表给个说明 —— 不是 bug，是「读写双闸」设计：防改坏原件。
    if (!table.writable && table.readonlyReason) {
      notify(table.readonlyReason, 'info');
    }
    // 搜索条只在表打开时显示（表内搜）；清单态隐藏。
    el.searchBar.hidden = false;

    if(openedTable.loadPersonalView){const view=await openedTable.loadPersonalView();if(disposed||openGeneration!==tableOpenGeneration)return;tableSort=view.view.sort||null;if(view.invalid_reason)notify(view.invalid_reason,'info');}
    const probe = await openedTable.loadPage(1, PAGE_LENGTH);
    if (disposed || openGeneration !== tableOpenGeneration) return;
    totalRows = probe.total;
    grid?.dispose();
    // Switching tables disposes all contributions owned by the previous table.
    rowBehaviors?.dispose();rowBehaviors=null;
    el.grid.hidden = false;
    // G1 预铺空白网格：像 Excel 一样，已填区域右侧和下方就有连续空白格。
    // xlsx 表多留 20 列空白列 —— 用户直接打字就能加列（像 Excel）。
    // 业务表不加空白列（加列 = 改数据库结构，那是另一件事）。
    // 所有表都多留 50 行空白行 —— 用户直接打字就能加行。
    const extraCol = table.kind === 'xlsx' ? 20 : 0;
    const extraRow = 50;
    gridRowCapacity=Math.max(totalRows,table.personalView?.source_total_rows||0,1)+extraRow;
    grid = createGrid(el.grid, columns, gridRowCapacity, extraCol);
    candidateOverlay=mountCandidateOverlay(el.grid,{frame:()=>grid?.getReviewFrame()??null,select:(row,col)=>grid?.selectCell(row,col)});
    rowBehaviors=table.writable?mountExcelRowBehaviors(el.grid,{
      frame:()=>{
        const frame=grid?.getReviewFrame();
        return frame?{...frame,fontSize:(row:number,col:number)=>(grid?.getCellStyle(row,columns[col]?.fieldId??'')?.font_size??9.75)/0.75}:null;
      },
      // 现在开着的是哪张表（域用它判断「这张表是不是我的表」）。
      table:()=>table?{key:table.key,kind:table.kind,resourceId:table.resourceId}:null,
      columns:()=>columns,
      cellText:(rowIndex,colIndex)=>grid?.getRowValue(rowIndex,columns[colIndex]?.fieldId??'')??'',
      isRowLoaded:rowIndex=>filled.has(rowIndex),
      rowIdentity:rowIndex=>{const row_id=indexToName.get(rowIndex);return row_id&&table?{table:table.resourceId??table.key,row_id}:null;},
      accept:adoptCellCandidate,
      // —— **格上的装饰**（2026-10-30 用户口径）：域把格交给宿主 ⇒ 宿主走渲染层画
      //   （Univer 原生形状 ⇒ 被网格裁剪 ⇒ 不会溢出格子、不会盖住格线）。
      decorate:(group,cells,style)=>{ grid?.decorateCells(group,cells,style); },
      notify,
    }):null;
    // 列头筛选的小漏斗（FIX-49）：画在**域内自己的浮层**上，不动 Univer 的列头。
    columnFilterOverlay=mountColumnFilterOverlay(el.grid,{
      frame:()=>{const current=grid?.getReviewFrame();if(!current)return null;return {clip:current.clip,headerRect:index=>grid?.getHeaderRect(index)??null};},
      columns:()=>columns.map(column=>({id:column.fieldId,label:column.label})),
      marked:()=>markedFilterColumns(),
      panel:(columnId,anchor,trigger)=>openColumnFilter(columnId,anchor,trigger),
    });
    grid.onLayout(()=>columnFilterOverlay?.refresh());
    headerRename=mountHeaderRename(el.grid,{
      locate(x,y){const hit=grid?.getHeaderAtPoint(x,y);if(!hit||!table||typeof table.contentVersion!=='number'||!columns[hit.colIndex])return null;return {...hit,header:columns[hit.colIndex].label,contentVersion:table.contentVersion,structureVersion:table.structureVersion};},
      allowed:()=>!!table?.writable&&canChangeStructure()&&!hasUnsaved()&&![...inlineControllers.values()].some(controller=>controller.hasEdits()),
      headers:()=>columns.map(column=>column.label),newKey:()=> 'header-'+newIdempotencyKey(),
      blocked:()=>notify(hasUnsaved()?'请先完成当前保存，再修改列名':'当前无法修改表头，请检查结构权限或待审修改','error'),
      async save(target,value,opId){const current=table;if(!current)throw Error('表格已关闭');updateToolbar();await retrySave(()=>current.renameHeader(target.header,value,opId,{contentVersion:target.contentVersion,structureVersion:target.structureVersion}),()=>!disposed&&table===current);if(disposed||table!==current)return;rememberStructure(opId,'修改列名');await rebuildAfterStructure();notify('列名已保存','success');},
    });
    // —— **长按列头 ⇒ 拖动 ⇒ 把那一列挪到某个位置**（2026-10-29 用户口径）——
    //   原来挪一列只有「行列操作」那个弹窗（要**填目标列名**）⇒ 挪一次开一次窗
    //   ⇒ 要把一批列挪到前头，人做不动。
    //   ⇒ 这里给一条直观的路：**按住列头 ⇒ 拖 ⇒ 松手**（落点＝插到那一列前面）。
    //   ⚠️ **跟「双击改列名」不打架**：那个走 `dblclick`，这个要**按住 ≥ 阈值**才动。
    columnDrag=mountColumnDrag(el.grid,{
      locate(x,y){const hit=grid?.getHeaderAtPoint(x,y);if(!hit||!columns[hit.colIndex])return null;return {colIndex:hit.colIndex,rect:hit.rect};},
      headerAt(colIndex){const rect=grid?.getHeaderRect(colIndex);return rect?{colIndex,rect}:null;},
      // ⚠️ **拖动期间列序必须是「按下那一刻」的**（画布上会先挪给用户看）
      //   ⇒ 落点要按**原始顺序**算，否则会越拖越乱。
      headers:()=> (columnDragOrder??columns).map(column=>column.label),
      canDrag:()=>!!table?.savePersonalView&&!hasUnsaved()&&![...inlineControllers.values()].some(controller=>controller.hasEdits()),
      newKey:()=>'colmove-'+newIdempotencyKey(),
      onDragStart:()=>{columnDragOrder=columns.slice();},
      onPreview:(header,before)=>previewColumnOrder(header,before),
      onCancel:()=>restoreColumnOrder(),
      // —— **拖到左右边缘 ⇒ 表自己横向滑**（用户 2026-10-29 15:3x：
      //   「我把我司案号拖到最左列，但它在最右边，就会导致拖不过来」）——
      //   滑到指针指着的那一列的**下一列**（往哪边拖就往哪边露）。
      onEdgeScroll:(direction,hovered)=>{
        const row=grid?.getSelection()?.rowIndex??0;
        grid?.scrollToRow(row,Math.max(0,hovered+direction));
      },
      onMove:(header,before)=>moveColumnInPersonalView(header,before),
    });
    wireGrid();
    // 表开好了，助手才知道用户在看哪张表（FIX-03）。
    // 放在 wireGrid 之后：选区要等网格起来才问得到。
    syncChatContext();
    // T08: 上报打开表事实
    if(!internal)reportActionFact({ opId: 'open-' + Date.now().toString(36), action: 'table.open', target: key, detail: { title: table.title, totalRows } });
    // 顺手补报积压的 action_fact
    if(!internal)void flushPendingActionFacts();
    // T07: 加载助手提案
    if(!internal)void loadProposals();
    // 列表头显示**字段名**，不是 Univer 默认的 A/B/C 列字母。
    // 任务书原话「表头是字段名」；用户 2026-10-11「我找不到该名称这个选项」——
    // 他要在表头上找「名称」，可那里只有字母，没有中文。
    // 末尾空白列的表头留空 —— 打字就建列。
    grid.setColumnHeaders([...columns.map((c) => c.label), ...Array(extraCol).fill('')]);
    // —— **受管列的列头样式**（白字绿底）—— **网格建好之后**才设得上
    //   （受管清单是异步来的，可能早于网格建好 ⇒ 那时调是空操作）。
    if (pendingManagedHeaders.length) grid.setManagedColumns(pendingManagedHeaders);
    // —— **必填列的列头标记**（末尾那颗星）—— 同上：清单异步来 ⇒ 网格建好之后再设一次。
    if (pendingRequiredHeaders.length) grid.setRequiredColumns(pendingRequiredHeaders);
    // 后端存的列宽画回去。不画的话「拖了刷新还在」无从谈起——宽读到了却丢在半路。
    // 合并说明：ours 这边用 setColumnWidths 批量设列宽（顺带设行高、冻结）；
    // fast 那边逐列 setColumnWidth。批量那条把逐列那条覆盖了（同一批列宽），
    // 但 fast 那边「逐列设」的口径留在这里作为等价路径的说明。
    grid.setColumnWidths(Object.entries(table.columnWidths).map(([index,px])=>({colIndex:Number(index),width:Number(px)})));
    grid.setRowHeights(table.rowHeights||{});
    if(table.personalView)grid.setFreeze(table.personalView.view.freeze.rows,table.personalView.view.freeze.columns);
    grid.snapshotColumnWidths();
    pageCache.set(1, probe.rows);
    applyRows(probe.rows,0);
    setOpenLoading(false);
    // 初始加载后兜底：让 Univer 按内容 + 列宽自动算行高（折行列要撑高）。
    // 延迟一帧等 Univer 把 setValues 渲染完，否则 auto-height 算不准。
    setTimeout(() => grid?.recalcAutoHeights(), 200);
    reapplyWrap(0, probe.rows.length);
    renderScope();
    openingTable = false;
    setSaveState('idle', '未修改');
    // 初次打开明确建立真实A1主选区；Univer可先画默认轮廓，却尚无带primary的活动选区。
    if(!grid.getSelection())grid.selectCell(0,0);
    syncFontControls();
    renderProposals();
    // ★ fast 那边：开表后按「评审目标」定位（聊天里点了某条建议 → 表格滚到那一格）。
    void locateReviewTarget();
    /* 待办点一条受管记录 ⇒ 地址里带着 `?record=<记录号>` ⇒ 定位到那一行。
       （业务表已经换成 Excel 交互，这条链接的落点也得跟着换。） */
    void locateRecordFromUrl();
    } catch (error) {
      if (disposed || openGeneration !== tableOpenGeneration) return;
      setOpenLoading(false);
      openingTable = false;
      throw error;
    }
  }

  /** 地址里的 `?record=<记录号>` ⇒ 找到那一行、滚过去、选中它。 */
  async function locateRecordFromUrl() {
    if (!table) return;
    const wanted = new URLSearchParams(location.search).get('record');
    if (!wanted || recordLocated===wanted) return;
    recordLocated=wanted;
    const destination = table;
    try {
      const page = await destination.findRowPage(wanted, PAGE_LENGTH);
      if (disposed || table !== destination) return;
      if (page < 1) {
        notify(`没找到记录 ${wanted}（可能已被回收或不在当前筛选范围内）`, 'info');
        return;
      }
      if (page > 1) await loadPage(page);
      if (disposed || table !== destination) return;
      const rowIndex = nameToIndex.get(wanted);
      if (rowIndex === undefined) {
        notify(`没找到记录 ${wanted}`, 'info');
        return;
      }
      grid?.scrollToRow(rowIndex, 0);
      grid?.selectCell(rowIndex, 0);
      notify(`已定位到记录 ${wanted}`, 'success');
    } catch (error) {
      if (!disposed) notify(`定位记录失败：${(error as Error).message}`, 'error');
    }
  }

  /**
   * 统一入口：业务表和真实 xlsx 列在同一张清单里，点哪个开哪个。
   * 界面不区分存储类型——两张表卡长得一样，进去是同一套编辑器。
   */
  /**
   * 从 Excel 入口上传一张真实 xlsx，传完直接打开。
   * 走的是既有 `files.upload`（计划要求「不另造写 API」），同名上传由服务端做**恒新资源**，
   * 不覆盖已有表。上传只是把文件放进文件中心，之后和别的表一样从统一入口打开。
   */
  /**
   * R3: 新建一张空表并打开。走 B 的创建接口（files.create 或类似），
   * 没有该接口时明确报错，不假装创建成功。
   */
  async function createAndOpen(name: string, attribution: { level: 'personal' | 'department'; department?: string }, idempotencyKey?: string, extra?: { headers?: string[]; placeholder?: string }) {
    if (!name.trim()) { notify('请输入表名', 'error'); return; }
    el.scope.textContent = `正在创建「${name}」…`;
    try {
      const payload: Record<string, unknown> = {
        file_name: name.trim().endsWith('.xlsx') ? name.trim() : name.trim() + '.xlsx',
        directory: '/',
        // 归属必填（2026-10-15 用户拍板）：personal 不带 department，department 级带部门 ID
        attribution: {
          level: attribution.level,
          ...(attribution.level === 'department' && attribution.department ? { department: attribution.department } : {}),
        },
      };
      // 2026-10-21（agent 建表一线）：**人和 agent 走同一个动作** ——
      // 表头（headers）与占位提示（placeholder）是 `files.create` 的**可选**入参，
      // 人工这边填了就带上，agent 那边也带 ⇒ 产物是同一种表，不是两条路。
      if (extra?.headers?.length) payload.headers = extra.headers;
      if (extra?.placeholder) payload.placeholder = extra.placeholder;
      // B 的创建接口（待 B 交付）：files.create 或 files.sheet_create
      const response = await fetch('/api/platform/actions/files.create/execute', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload,
          confirmed: true,
          idempotency_key: idempotencyKey || 'excel-new-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
          source: 'user',
        }),
        signal,
      });
      const body = await response.json();
      if (!response.ok || body?.ok === false) {
        throw Object.assign(new Error(body?.error || body?.message || `创建失败（HTTP ${response.status}）`),{status:response.status});
      }
      const newId = body?.result?.file || body?.result?.file_id || body?.result?.id || body?.result?.table_id;
      if (!newId) throw new Error('创建成功但未返回表 ID');
      notify(`已创建「${name}」`, 'success');
      // 打开新表
      const url = new URL(location.href);
      url.searchParams.set('object', newId);
      url.searchParams.set('table_source', 'xlsx');
      location.href = url.toString();
      return {ok:true};
    } catch (error) {
      const msg = (error as Error).message || String(error);
      if (/404|not found|不存在/i.test(msg)) {
        notify('创建接口尚未就绪（需要后端提供 files.create），请联系管理员', 'error');
      } else {
        notify(`创建失败：${msg}`, 'error');
      }
      el.scope.textContent = '';
      const status=(error as Error & {status?:number}).status;
      return {ok:false,uncertain:!status||status>=500,error:msg};
    }
  }

  async function uploadAndOpen(file: File, attribution: { level: 'personal' | 'department'; department?: string }) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      notify('只支持 .xlsx 文件', 'error');
      return;
    }
    const uploadStatus = el.picker.querySelector<HTMLElement>('[data-upload-status]') || el.scope;
    uploadStatus.hidden = false;
    const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
    uploadStatus.textContent = `正在读取 ${file.name}（${fileSizeMB} MB）…`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      // 合并说明：ours 这边归属**必填**（2026-10-15：personal 不带 department）；
      // fast 那边归属可空、另带 `new_resource:true`（新建资源，不复用同名文件）。
      // 两条都留：归属必填 + new_resource 标记。
      const payload: Record<string, unknown> = {
        file_name: file.name,
        content_base64: btoa(bin),
        directory: '/',
        new_resource: true,
        attribution: {
          level: attribution.level,
          ...(attribution.level === 'department' && attribution.department ? { department: attribution.department } : {}),
        },
      };
      const bodyStr = JSON.stringify({
        payload,
        confirmed: true,
        idempotency_key: 'excel-up-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
        source: 'user',
      });

      // R4: 用 XHR 拿真实上传字节进度（fetch 不支持 upload progress）
      const body = await new Promise<{ ok?: boolean; error?: string; message?: string;
        result?: { file?: string; upload_timing?: Record<string, number> } }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/platform/actions/files.upload/execute', true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('content-type', 'application/json');
        // 真实上传进度（能测字节才显示百分比）
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && e.total > 0) {
            const pct = Math.round((e.loaded / e.total) * 100);
            uploadStatus.textContent = `正在上传 ${file.name}：${pct}%（${(e.loaded / 1024 / 1024).toFixed(1)}/${fileSizeMB} MB）`;
          } else {
            uploadStatus.textContent = `正在上传 ${file.name}…`;
          }
        });
        xhr.upload.addEventListener('load', () => {
          uploadStatus.textContent = `上传字节已完成，服务器正在处理 ${file.name}…`;
        });
        xhr.addEventListener('load', () => {
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('响应解析失败')); }
        });
        xhr.addEventListener('error', () => reject(new Error('网络错误')));
        xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
        xhr.send(bodyStr);
      });

      // 上传字节完成 → 服务器处理阶段
      uploadStatus.textContent = `正在处理 ${file.name}…`;

      // B 侧 upload_timing 分段计时：区分「上传字节/服务器处理」
      // 注意 clean_warm = clean + warm 的合计，不能混用（B 2026-10-13 指正）
      const result = body?.result as Record<string, unknown> | undefined;
      const timing = result?.upload_timing as Record<string, number> | undefined;
      if (timing) {
        uploadStatus.textContent = `正在处理 ${file.name}（解析 ${timing.zip_scan}ms / 清洗 ${timing.clean_warm}ms）…`;
      }

      const created = result?.file;
      if (body?.ok === false || !created) {
        throw new Error(String(body?.error || body?.message || '上传失败'));
      }
      // 显示上传分段耗时（诊断用，不常驻）
      if (timing) {
        console.log(`[upload_timing] read=${timing.read}ms meta=${timing.meta}ms zip_scan=${timing.zip_scan}ms clean=${timing.clean}ms warm=${timing.warm}ms total=${timing.total_ms}ms`);
      }
      notify(`已上传「${file.name}」，正在打开`, 'success');
      // 传完直接进这张表——计划要的「上传后打开」
      const url = new URL(location.href);
      url.searchParams.set('object', String(created));
      url.searchParams.set('table_source', 'xlsx');
      location.href = url.toString();
    } catch (error) {
      uploadStatus.textContent = `上传失败：${(error as Error).message}。可重新选择文件重试。`;
      notify(`上传失败：${(error as Error).message}`, 'error');
    }
  }

  async function showPicker() {
    tableOpenGeneration++;
    openRetryTarget = null;
    setOpenLoading(false);
    el.grid.hidden = true;
    el.picker.hidden = false;
    host.classList.add('file-center-page');
    el.back.hidden = true;
    el.searchBar.hidden = true;
    el.title.textContent = 'Excel';
    (host.querySelector('.excel-bar') as HTMLElement).hidden = true;
    (host.querySelector('.excel-save-state') as HTMLElement).hidden = true;
    // 清单页：没打开任何表 —— 助手不许自己挑一张（FIX-03）。
    syncChatContext('list');
    let initial: Partial<DirectoryState> = {};
    try { initial = JSON.parse(sessionStorage.getItem('excel-directory-state') || '{}'); } catch { /* 旧会话状态不影响打开 */ }
    initial.term = new URLSearchParams(location.search).get('q') ?? '';
    directory?.dispose();
    directory = mountDirectory(el.picker, {
      initial,
      /* 归属弹窗跟本页共用同一个工作面（同一个模态栈）—— Esc 只关最上层那扇。 */
      ui,
      // ⚠️ **页码决定实际读取范围**（R11）：把页码与归属层级交给服务端。
      load: (term, page, attributionLevel, querySignal) => listTables(querySignal ?? signal, { search: term, page, pageLength: 20, attributionLevel }),
      upload: (file, attribution) => { void uploadAndOpen(file, attribution); },
      create: (name, attribution, key, extra) => createAndOpen(name, attribution, key, extra),
      open: (key, state, source) => {
        sessionStorage.setItem('excel-directory-state', JSON.stringify(state));
        const url = new URL(location.href);
        url.searchParams.set('object', key);
        url.searchParams.set('table_source', source);
        if (state.term) url.searchParams.set('q', state.term);
        else url.searchParams.delete('q');
        url.searchParams.delete('shown');
        location.href = url.toString();
      },
    });
    signal.addEventListener('abort', () => directory?.dispose(), { once: true });
    await directory.ready;
  }

  /**
   * 从 URL 读「开表时带过来的」清单状态。
   *
   * 为什么不能用 pickerState：开表是整页导航，页面一重载 pickerState 就归零了，
   * 而状态本来就写在 URL 上。返回时从 URL 读，才是那份真的「刚才」。
   */
  function readCarriedPickerState(): { term: string; shown: number } {
    const params = new URLSearchParams(location.search);
    return {
      term: params.get('q') ?? '',
      shown: Math.max(0, Number(sessionStorage.getItem('excel-picker-shown') ?? '0') || 0),
    };
  }

  /**
   * 返回清单。搜过的词走 URL，已加载条数走 sessionStorage（D7：内部状态不进网址）。
   * 不用 history.back()：那会退回开表前那一次导航，但状态没在 URL 里就还原不出来；
   * 而且人从清单点进来再后退，语义上「回列表」比「回上一页」准。
   */
  function backToList() {
    if(inputQueue.length){notify('输入尚未保存，请先核实原操作后返回列表','info');return;}
    const carried = readCarriedPickerState();
    const url = new URL(location.href);
    url.searchParams.delete('object');
    url.searchParams.delete('table_source');
    if (carried.term) url.searchParams.set('q', carried.term);
    else url.searchParams.delete('q');
    // shown 进 sessionStorage，不进 URL（D7）
    sessionStorage.setItem('excel-picker-shown', String(carried.shown));
    // 从 URL 清掉可能残留的旧 shown 参数
    url.searchParams.delete('shown');
    location.href = url.toString();
  }

  async function boot() {
    try {
      const wanted = new URLSearchParams(location.search).get('object');
      if (wanted) {
        await openTableByKey(wanted);
        return;
      }
      // 没指定表就给统一清单，不替用户猜开哪张。
      await showPicker();
    } catch (error) {
      if (disposed) return;
      // 打开失败要能查：控制台给完整栈（拼成字符串，便于远程抓取）。
      const err = error as Error;
      console.error('[excel] 打开失败 ' + (err?.stack || String(error)));
      // 2026-10-21：**不许再给一片空白** —— 改前只把服务端那句英文塞进一行小字，
      // 下面是一大片空网格，用户看不出是「表没了」「没权限」还是「服务器坏了」。
      // 现在给一个说清原因的面板（原因 + 下一步 + 重试 + 返回表格清单）。
      showOpenFailure(error);
    }
  }
  el.openRetry.addEventListener('click', () => {
    if (disposed || openingTable) return;
    if (!openRetryTarget) {void boot();return;}
    const target = openRetryTarget;
    void openTableByKey(target.key,{source:target.source}).catch(error=>{if(!disposed)showOpenFailure(error);});
  }, {signal});

  /**
   * 把「打不开」画成一个面板（不是一行小字、不是空白）。
   * 失败原因由 explainOpenFailure 翻译（按服务端 status/code，不猜）。
   *
   * ⚠️ 2026-10-21 用户实测（trial-jia 点示例企业总表）：
   *   页面上曾露出 `打开失败：Not allowed via controller permission check<br><strong>…</strong>`
   *   —— 英文内部错误 ＋ HTML 标签直接漏给人看。
   * ⇒ **页面上只留人话**：原始错误**只进控制台**；
   *   要给管理员查的线索，给一个**可复制的编号**（服务端 trace id，没有就用表身份）。
   */
  function showOpenFailure(error: unknown) {
    setOpenLoading(false);
    openingTable = false;
    const failure = explainOpenFailure(error);
    el.openRetry.hidden = !failure.retryable;
    /* 排查编号：**有服务端的 trace id 才叫排查编号**；没有就写「表号」。
     * ⚠️ **为什么分清**（2026-10-30 用户实测）：服务端没回 trace id 时（例：服务在重启、
     *   请求根本没到服务端）⇒ 老写法把**表号**顶上去当「排查编号」
     *   ⇒ 人把那串表号当报错编号交给管理员 ⇒ **查错了地方**。
     *   ⇒ 现在：trace id ⇒ 「排查编号 xxx」；只有表号 ⇒ 「表号 xxx（服务端没回排查编号）」。 */
    const reference = failure.traceId
      ? `排查编号 ${failure.traceId}`
      : (tableIdentityFromUrl() ? `表号 ${tableIdentityFromUrl()}（服务端没回排查编号）` : '');
    /* —— **不再摆那个大面板**（用户 2026-10-24 22:30 站上：「这个是不是太窄了，
       干脆放到 toast 里面去」）——
       改前：正文区一块大面板（原因 + 排查编号 + 重试 + 返回表格清单），
             又窄又高，用户说「干脆放到 toast 里面去」。
       改后：
         · 失败信息走**公共 toast**（右下角、3.2 秒自动消失的那个公共件）：
           toast 标题＝出了什么事，toast 小字＝**下一步怎么办**；
         · **页头标题留人话**（toast 一会儿就没了 ⇒ 标题得留在页面上，
           否则又回到「一片空白」）；
         · **底部状态条留一行人话**（原因 + 可复制的排查编号）——
           ⚠️ 这里只写人话，**原始错误一个字都不许留**（那正是漏给人看的地方）；
         · **页头给「返回列表」这个出路**（面板没了 ⇒ 原来那个「返回表格清单」
           按钮也没了 ⇒ 不能把人困在打不开的表上；独立页模式除外，那里没有清单）；
         · 网格继续藏着（不许拿一片空网格冒充表），工具栏也藏起来
           （没打开表，那些工具按了也没用）。 */
    const toastFn = (globalThis as any).toast;
    if (typeof toastFn === 'function') toastFn(failure.title, failure.hint || failure.reason, 'error');
    /* 页头标题：`<h1 data-title>`，页面上真正看得见的那行大字。 */
    if (el.title) el.title.textContent = failure.title;
    /* 底部状态条：`[data-foot]`（role=status）。原来失败时整条藏掉，
       现在留着这一行人话 —— toast 消失后，人还能自己复制排查编号给管理员。 */
    if (el.foot) {
      el.foot.textContent = [failure.reason, reference].filter(Boolean).join(' · ');
      el.foot.classList.add('excel-state-error');
    }
    if (el.saveState) el.saveState.hidden = false;
    el.grid.hidden = true;
    el.picker.hidden = true;
    /* 出路：页头「返回列表」按钮（独立页模式没有清单可回 ⇒ 不给这个口）。 */
    el.back.hidden = standaloneMode;
    /* 没打开表 ⇒ 那一排表格工具（撤回/查找替换/字体/格式/数据）按了也没用，藏起来。 */
    const toolRow = host.querySelector('.excel-toolrow') as HTMLElement | null;
    if (toolRow) toolRow.hidden = true;
  }

  /** 用户想打开的那张表的身份（URL 里的 object 参数）—— 排查编号的兜底。 */
  function tableIdentityFromUrl(): string {
    try {
      return String(new URLSearchParams(location.search).get('object') || '').trim();
    } catch {
      return '';
    }
  }

  /**
   * 只读诊断口，给页面侧测试用。
   * 要断言的是「真的滚过去」「行高真的撑开」「那一格显示的是不是真值」这类只发生在画布里的事，
   * 外部看不见，只能让页面自己如实报出来。只读，不改任何行为。
   *
   * probe 可指定要看哪一格（不给就是 0,0）；probeValue 是它当前**显示**的文本。
   * rowIds 是已装填各行的稳定标识（服务端发号，不是可视行号）。
   */
  /**
   * BASE967-27 提案重验徽标的 reason → 中文标签映射。
   * 真实契约：promotion.py REVALIDATION_REASONS = ('permission_changed','attribution_changed',
   *   'field_acl_changed','definition_advanced','unknown')。
   * **不出现英文 reason 串给用户**——直接露底。`unknown` 走 fail-closed 兜底文案。
   * **公开挂出**到 window，理由：a) 测试 T10 不引 ESM 内部符号；b) 助手工具若需要按 reason 渲染提示也能取。
   */
  const REVALIDATION_REASON_LABELS: Record<string, string> = {
    permission_changed: '权限变了',
    attribution_changed: '归属变了',
    field_acl_changed: '列权限变了',
    definition_advanced: '定义前进了',
    unknown: '需重新检查',
  };
  (globalThis as any).__revalidationMap = REVALIDATION_REASON_LABELS;

  (globalThis as any).excelPageDiag = (probe?: { row?: number; col?: number }) => {
    const row = Number.isFinite(probe?.row) ? Number(probe!.row) : 0;
    const col = Number.isFinite(probe?.col) ? Number(probe!.col) : 0;
    // 测试用：直接选中某格（不用方向键慢慢走）
    if (probe?.row !== undefined && probe?.col !== undefined && grid) {
      try { grid.selectCell(row, col); } catch { /* 选不中就算了 */ }
    }
    return {
      // 测试用：直接调用 handlePaste（Univer 拦截了 paste 事件，测试无法通过事件触发）
      paste: (text: string, startRow?: number, startCol?: number) => {
        handlePaste(text, startRow, startCol);
        return true;
      },
      // PKG-002-T13: 复制出口 —— 生成 HTML+TSV（headless 下 copy 事件无 clipboardData，测试直调）
      _copyVersion: 'pkg-002-t13-v2',
      copyData: (optRange?: { startRow: number; startCol: number; endRow: number; endCol: number }) => {
        try { return selectionClipboardPayload(optRange); }
        catch (error) { return { error: (error as Error).message }; }
      },
      tableKey: table?.key ?? null,
      columns: columns.map((c) => ({ id: c.fieldId, label: c.label, type: c.type, readOnly: c.readOnly })),
      totalRows,
      loadedRows: filled.size,
      proposalPage:{hasMore:proposalsHasMore,summary:proposalSummary},
      rowIds: [...indexToName.entries()].sort((a, b) => a[0] - b[0]).map(([, name]) => name),
      // BASE967-50：当前排序态 + 触发口。㉑ 判据靠这两项判「排了但映射不回去」。
      tableSort,
      sortBy: (column: string, direction: 'asc' | 'desc') => applyServerSort(column, direction),
      probeCell: { row, col },
      probeValue: grid?.getCellText(row, col) ?? null,
      hits: { total: hits.length, index: hitIndex },
      // —— **当前框着红的「空的必填格」**（2026-10-30 用户口径）。
      //   ⚠️ 红框画在 **canvas** 上（DOM 里看不见）⇒ 要有个可观测点，
      //   否则「框红了没有」这件事**外部核不了**（只能靠肉眼看截图）。
      requiredEmptyMarks:requiredEmptyMarksSnapshot(),
      // —— **形状层现在画了几个**（2026-10-30：判据要核「滚动后前面页的框还在」
      //   ⇒ 光看「要框哪些」不够 ⇒ 还要看「真的画上了几个」）——
      shapeStats:grid?.getDiag()?.shapes??null,
      // —— **测试口**：让格上装饰走渲染层（域也用这个口 —— 2026-10-30 用户口径：
      //   「这个自动化能不能也走渲染层的样式呢？」）——
      decorate:(group:string,cells:Array<{row:number;col:number}>,style:{fill:string;stroke?:string;strokeWidth?:number})=>{
        grid?.decorateCells(group,cells,style);
        return grid?.getDiag()?.shapes??null;
      },
      // —— **当前格子的屏幕矩形**（双击坐标靠它算准）——
      //   ⚠️ **为什么要有这个口**：Univer 网格画在 canvas 上 ⇒ 「双击哪一格」靠肉眼算不准
      //   ⇒ 判据/实测只能靠这个矩形 ⇒ 否则会点到别的格去，**量出来的数是假的**。
      getReviewFrame:()=>grid?.getReviewFrame()??null,
      inputQueue:inputQueue.map(op=>({key:op.key,state:op.state,row:op.row,col:op.col,text:op.matrix[0][0],message:op.message,discardable:op.discardable,uncertain:op.uncertain,attempted:op.attempted})),
      pending: [...pending.keys()],
      undo: {
        keyPresses: undoKeyPresses,
        editDiscards: undoEditDiscards,
        runs: undoRuns,
        noTarget: undoNoTarget,
        stackSize: undoStack.length,
        target: undoStack.length > 0
          ? { fieldLabel: undoStack[undoStack.length - 1].fieldLabel, before: undoStack[undoStack.length - 1].before }
          : null,
      },
      pendingWidths: [...pendingWidths.values()].map((w) => ({ key: w.key, col: w.colIndex, px: w.widthPx, state: w.state })),
      // PKG-004：晋升列集合 + 最近写入值来源
      promotedColumns: [...promotedColumns],
      // —— **受管列清单**（列头绿底的那几列）——
      //   判据要能核「对象的每一列都受管」（2026-10-30 用户口径）——
      managedColumns: [...(grid?.getDiag()?.managedHeaders??[])],
      lastWriteSource,
      _promoDebug: promoDebug,
      // PKG-008-T01: 排版操作支持状态清单
      // status: 'editable' | 'readonly-preserved' | 'unsupported'
      // essential: 日常办公硬需求（不能关验收）
      formattingSupport: {
        columnWidth: { status: 'editable', essential: true, view: 'shared', storage: 'xlsx-file', entry: '拖拽列头分隔线 / 右键列宽输入', note: '写 xlsx 共享；DB 表 writeLayout 假成功不存盘；「适合宽度」不触发保存' },
        // 合并说明：ours 这边走**受管动作**（writeStyle / 个人视图 / 结构动作）；
        // fast 那边走**结构菜单的文件操作**（table.fileOperation：整表排序、选区格式）。
        // 两条能力现在**都还在**（文件操作菜单已并入工具栏），所以按「能不能做」如实写，
        // 并把两条入口都写进 entry/note —— 不让任何一条能力在清单上凭空消失。
        rowHeight: { status: 'editable', essential: true, view: 'shared', storage: 'xlsx', entry: '行高拖动及自动换行 / 结构菜单', note: '显式行高通过受管动作保存（结构菜单文件操作未提供行高字段，行高仍走受管动作）' },
        wrapText: { status: table?.writeStyle||table?.fileOperation?'editable':'readonly-preserved', essential: true, view: 'shared', storage: 'xlsx', entry: '自动换行按钮 / Alt+Enter / 结构菜单选区自动换行', note: '显式换行格式通过受管动作保存，覆盖列自动换行默认值；结构菜单写入原 XLSX，文本输入换行仍作为值保存' },
        freeze: { status: table?.personalView?'editable':'unsupported', essential: true, view: 'personal', storage: 'Shangshu Sheet View', entry: '筛选 / 冻结', reason: '按本人和表格保存，不修改正式行顺序；右键冻结菜单黑名单漏拦变体，可本地生效但不落盘（接 PKG-010）' },
        hideRowCol: { status: 'unsupported', essential: false, view: 'personal', storage: '—', entry: null, reason: '本轮不支持新增隐藏，原件已有隐藏仍保留；隐藏命令已拦截；右键隐藏菜单黑名单漏拦变体，可本地生效但不落盘' },
        dateFormat: { status: table?.writeStyle||table?.fileOperation?'editable':'readonly-preserved', essential: true, view: 'shared', storage: 'xlsx-number-format', entry: '数字或日期显示格式 / 结构菜单选区日期格式', note: '受管格式保存，数值与日期套显示格式，文本编号保持文本；支持白名单格式，保留原值' },
        numberFormat: { status: table?.writeStyle||table?.fileOperation?'editable':'readonly-preserved', essential: true, view: 'shared', storage: 'xlsx-number-format', entry: '数字或日期显示格式 / 结构菜单选区金额格式', note: '金额、千分位、百分比格式独立于值；显示及下载使用原文件格式' },
        font: { status: table?.writeStyle||table?.fileOperation ? 'editable' : 'unsupported', essential: false, view: 'shared', storage: table?.writeStyle||table?.fileOperation ? 'xlsx' : '—', entry: '工具栏字号、字色、加粗 / 结构菜单选区加粗、取消加粗', reason: table?.writeStyle||table?.fileOperation ? '受管选区样式动作，保存后显示并可本人撤回（结构菜单目前仅编辑粗体，字号颜色只读保留）' : '当前表尚未接入可保存的单元格格式' },
        alignment: { status: 'unsupported', essential: false, view: '—', storage: '—', entry: null, reason: '同上' },
        borderFill: { status: table?.writeStyle||table?.fileOperation?'editable':'unsupported', essential: false, view: 'shared', storage: 'xlsx', entry: '四边细线 / 无边框 / 结构菜单选区全部边框', reason: '支持边框；填充未开放，原格式保留；结构菜单仅全部细边框，不提供任意填充色编辑' },
        mergeCell: { status: 'unsupported', essential: false, view: '—', storage: '—', entry: null, reason: '复杂结构' },
        conditionalFormat: { status: 'unsupported', essential: false, view: '—', storage: '—', entry: null, reason: '排版兼容范围外' },
        dataValidation: { status: 'unsupported', essential: false, view: '—', storage: '—', entry: null, reason: '排版兼容范围外' },
        chart: { status: 'unsupported', essential: false, view: '—', storage: '—', entry: null, reason: '图表兼容范围外' },
        // 合并说明：ours 这边是「个人视图里的筛选/冻结」（服务端全表筛选，按固定行身份写入）；
        // fast 那边是「结构菜单按当前列整表升降序」（整行连稳定ID一起排序）。
        // 两条能力都在 —— 一条走 table.personalView，一条走 table.fileOperation。
        filterSort: { status: table?.personalView||table?.fileOperation?'editable':'unsupported', wired:tableSortWired, essential: true, view: 'personal', storage: 'Shangshu Sheet View', entry: '筛选 / 冻结 / 结构菜单按当前列整表升降序', reason: '服务端全表筛选，按固定行身份写入；整行连稳定ID一起排序，复杂关联范围明确拒绝' },
        cellValue: { status: 'editable', essential: true, view: 'shared', storage: 'xlsx-cell-value', entry: '双击格子编辑' },
        addRow: { status: 'editable', essential: true, view: 'shared', storage: 'xlsx-row', entry: '空白行输入并提交/越界粘贴' },
        addColumn: { status: 'editable', essential: true, view: 'shared', storage: 'xlsx-col', entry: '额外列数据格输入并提交/越界粘贴' },
        renameSheet: { status: 'editable', essential: true, view: 'shared', storage: 'xlsx-sheet-title', entry: '双击表名标题' },
        renameHeader: { status: 'editable', essential: true, view: 'shared', storage: 'xlsx-header', entry: '双击列头原位编辑' },
      },
      // T07: 提案审核数据（测试断言用）
      proposals,
      // E 2026-10-17：权限字段原样回报（null = 后端未给），测试据此断言 fail-closed 显隐
      canDownload: table?.canDownload ?? null,
      canStructure: table?.canStructure ?? null,
      ...(grid?.getDiag() ?? { visibleRows: [-1, -1], rowHeights: {}, defaultRowHeight: 24, wrapColumns: [], highlight: null, columnWidths: {} }),
    };
  };

  let proposalsHasMore=false;
  let proposalSummary:{total:number;pending:number;confirmed:number;rejected:number}|null=null;
  // One authoritative proposal identity is shared by assistant cards and this review surface.
  let proposals: Proposal[] = [];
  const proposalErrors = new Map<string, string>();
  let focusedProposalId = '';
  let proposalMarks: (() => void) | null = null;

  function reviewSource(p: Proposal): { kind: string; label: string } {
    return (globalThis as any).shangshuReviewSource?.(p) || { kind: 'unknown', label: '来源未确认' };
  }
  function hasInlineMapping(proposal:Proposal):boolean{
    const controller=inlineControllers.get(String(proposal.id||proposal.proposal_id));
    if(!controller||controller.error||proposalErrors.has(controller.id))return false;
    const frame=grid?.getReviewFrame();if(!frame)return false;
    return controller.descriptor.units.some(unit=>{
      /* 暂存过的项**仍然落在这张表里**（它还没写正式值）⇒ 算「定位得到」。 */
      if(unit.status!=='pending'&&unit.status!=='staged')return false;
      const cell=resolveCandidateCell(unit,nameToIndex,columns);if(!cell)return false;
      const rect=frame.rect(cell.row,cell.col);return !!rect&&[rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)&&rect.width>0&&rect.height>0;
    });
  }

  function clearInlineReviews(keepControllers=false){
    candidateOverlay?.dispose();candidateOverlay=null;
    /* 审核条跟着清（换表／关表时不留上一张表的提案和回执）。 */
    reviewBar?.clear();
    if(keepControllers)return;
    const registry=(window as any).shangshuInlineReviews as Map<string,InlineReviewController>|undefined;
    inlineControllers.forEach((controller,id)=>{controller.dispose();if(registry?.get(id)===controller)registry.delete(id);});inlineControllers.clear();
  }
  /**
   * 候选的表头 → 表格的**哪一列**。
   * ⚠️ **先按 `label`（中文表头）对**，再按 `fieldId` 对 —— 那类提案给的
   * `header` 就是中文表头（如「审查状态」）；**都对不上就 -1（不画）**，不许瞎猜一列。
   */
  function columnIndexOf(header:string):number{
    const byLabel=columns.findIndex(column=>column.label===header);
    return byLabel>=0?byLabel:columns.findIndex(column=>column.fieldId===header);
  }
  function renderInlineCandidates(){
    const items:CandidateOverlayItem[]=[];
    for(const controller of inlineControllers.values()){
      const descriptor=controller.descriptor,source=reviewSource({created_via:descriptor.created_via}).kind;
      for(const unit of descriptor.units){
        /* —— **暂存过（staged）的项也留在格上**（PKG-118-T01）：
           暂存只标记、没写正式值 ⇒ 人一眼看得到「已暂存」，也还能再采用/再改。 */
        if(unit.status!=='pending'&&unit.status!=='staged')continue;
        /* 只有**格**的单元画得出来；别的单元（如某个域的「材料审核结论」）在表里没有落点
           ⇒ **如实不画**（不许瞎猜一列）。 */
        if(unit.kind!=='cell')continue;
        const cell=resolveCandidateCell(unit,nameToIndex,columns);
        if(!cell)continue;
        const {row,col}=cell;
        const style=grid?.getCellStyle(row,columns[col].fieldId);
        items.push({key:descriptor.id+':'+unit.unit_id,proposalId:descriptor.id,unitId:unit.unit_id,row,col,text:controller.value(unit.unit_id),source,busy:controller.busy,disabled:descriptor.can_accept===false,blockedReason:descriptor.accept_unavailable_reason,error:controller.error,fontSize:style?.font_size??undefined,bold:style?.bold,staged:unit.status==='staged',
          /* **单击＝暂存**（不写正式值）；真要写走「采用」（Enter 或格内「采用」钮）。 */
          accept:()=>controller.acceptUnit(unit.unit_id),stage:()=>controller.stageUnit(unit.unit_id),unstage:()=>controller.unstageUnit(unit.unit_id),edit:value=>controller.setEdit(unit.unit_id,value),reject:()=>controller.rejectUnit(unit.unit_id)});
      }
    }
    candidateOverlay?.setItems(items);
    /* 审核条的计数/可用性跟着控制器走（控制器一变就重刷）。 */
    renderReviewBar();
  }
  /**
   * 刷「全部确认」审核条（用户 2026-10-26 决议①）。
   *
   * **一条提案一组**：三个计数（待审／暂存／已核对）＋「全部确认」按钮。
   * ⚠️ **暂存项不进「已核对」那一栏**（暂存只是暂时存，正式值还没改）。
   * 点「全部确认」⇒ 走 `controller.acceptRemaining()`：**待审 ＋ 暂存过**的一次全采用，
   * **暂存时改过的值**由后端连同 `staged_value` 一起写进正式表。
   */
  function renderReviewBar(){
    if(!reviewBar)return;
    const entries:ReviewBarEntry[]=[];
    for(const controller of inlineControllers.values()){
      const descriptor=controller.descriptor;
      /* 一条都没剩（全都采用了／放弃了）⇒ 这条提案不再占位。 */
      if(!unresolvedUnits(descriptor))continue;
      entries.push({
        descriptor,busy:controller.busy,
        acceptAll:async()=>{
          const reply=await controller.acceptRemaining();
          if(!reply){
            const message=controller.error||'确认没成功，请核对候选列表。';
            notify(message,'error');
            throw Error(message);
          }
          notify('已全部确认：待审和暂存过的一起写进正式表了。','success');
          return reply;
        },
      });
    }
    reviewBar.update(entries);
  }
  /**
   * 这条提案**还有几项没处理**（待审 ＋ 暂存过）。
   * ⚠️ **不许拿内核的 `remaining` 当「处理完了」**：内核把暂存项从 `remaining` 里扣掉了
   * （`remaining`＝还没存着的项数）⇒ 全部暂存完之后 `remaining` 会是 0，
   * 但那些项**一个字都还没写进正式值** ⇒ 这里按「待审 ＋ 暂存」自己数。
   */
  function unresolvedUnits(descriptor:ReviewDescriptor):number{
    return descriptor.units.filter(unit=>unit.status==='pending'||unit.status==='staged').length;
  }
  async function readInlineValues(descriptor:ReviewDescriptor,expected:Array<{unit:ReviewUnit;value:ReviewValue}>){
    const key=descriptor.target.table;if(disposed||table?.key!==key)throw Error('表格已切换，保存结果需要重新核实');
    // Independent authorized read. Never treat the write reply itself as proof of displayed formal values.
    const read=await fetchReviewDescriptor(descriptor.id,key,{signal});
    if(read.review_revision!==descriptor.review_revision)throw Error('审核后数据又发生变化，请重新核对');
    for(const item of expected){const current=read.units.find(unit=>unit.unit_id===item.unit.unit_id)?.current_value;
      if(!current||!reviewValuesEqual(current,item.value))throw Error('正式值与本次确认的候选不一致，请核对原操作');}
    const fresh=await openTable(key,signal,table.objectInfo?'db':table.kind);if(disposed||table?.key!==key)throw Error('表格已切换');
    if(fresh.columns.length!==columns.length||fresh.columns.some((column,index)=>column.fieldId!==columns[index].fieldId))throw Error('列结构已经变化，请重新打开核对');
    table=fresh;totalRows=fresh.totalRows;
    const pages=new Set<number>();for(const item of expected){const index=nameToIndex.get(item.unit.target.row_id);if(index!==undefined)pages.add(Math.floor(index/PAGE_LENGTH)+1);}
    for(const page of pages){pageCache.delete(page);await loadPage(page);}
    grid?.recalcAutoHeights();syncFontControls();
  }
  async function prepareInlineReviews(tableKey:string){
    /* —— **不再按能力白名单挡**（PKG-118-T01）：
       那类提案（`example.notice.project_to_case`）也要能在表格页落到格上。
       判据＝**域声明了 review_handler**（内核列表项给的 `review_supported`）＋
       **单元是格**（`kind:'cell'`，拿到描述符之后才认）。 */
    const supported=proposals.filter(proposal=>proposalSupportsInlineReview(proposal));
    let cursor=0;
    async function worker(){while(cursor<supported.length){const proposal=supported[cursor++],id=String(proposal.id||proposal.proposal_id);if(inlineControllers.has(id))continue;
      try{
        const descriptor=await fetchReviewDescriptor(id,table?.resourceId??tableKey,{signal});if(disposed||table?.key!==tableKey)return;
        if(!unresolvedUnits(descriptor))continue;
        /* **一个「格」单元都没有**（例如整表动作、或只有「材料审核结论」那种非格单元）
           ⇒ 这一条**不进表格页的逐格审核**，也不报「原位审核暂不可用」（它没坏，只是没落在格上）。 */
        if(!descriptor.units.some(unit=>unit.kind==='cell'))continue;
        proposalErrors.delete(id);
        const controller=createInlineReviewController({descriptor,signal,newKey:()=> 'review-'+newIdempotencyKey(),
          blocking:()=>hasUnsaved()||!!(grid?.isEditing()&&!document.activeElement?.closest('.excel-candidate-editor')),
          /* 暂存过的项要改值 ⇒ 按**暂存时那个值**的类型转（不是按原候选的类型）。 */
          coerce:(unit,text)=>{const base=unit.status==='staged'&&unit.staged_value?unit.staged_value:unit.value;return base.type==='empty'&&text!==''?{type:'text',value:text}:editedProposalValue({payload:{value:base}},text);},readback:readInlineValues,
          change(reason){if(disposed)return;
            if(!controller.busy&&unresolvedUnits(controller.descriptor)===0){inlineControllers.delete(id);const registry=(window as any).shangshuInlineReviews;if(registry?.get(id)===controller)registry.delete(id);controller.dispose();}
            renderInlineCandidates();if(reason!=='edit')renderProposals();updateToolbar();},
          progress(next){
            window.dispatchEvent(new CustomEvent('shangshu:review-progress',{detail:{proposal_id:id,descriptor:next,origin:'excel'}}));
            if(unresolvedUnits(next)===0){proposals=proposals.filter(proposal=>String(proposal.id||proposal.proposal_id)!==id);window.dispatchEvent(new CustomEvent('shangshu:review-resolved',{detail:{proposal_id:id,status:'confirmed',origin:'excel'}}));}
          }});
        inlineControllers.set(id,controller);const registry=((window as any).shangshuInlineReviews ||= new Map());registry.set(id,controller);
        window.dispatchEvent(new CustomEvent('shangshu:review-ready',{detail:{proposal_id:id,module:'excel'}}));
      }catch(error){if(!disposed&&table?.key===tableKey)proposalErrors.set(id,'原位审核暂不可用：'+describeError((error as Error).message));}
    }}
    await Promise.all(Array.from({length:Math.min(4,supported.length)},()=>worker()));
    if(!disposed&&table?.key===tableKey){renderInlineCandidates();renderProposals();}
  }

  async function loadProposals() {
    if (!table || disposed) return;
    const tableKey = table.key;
    const promotionTable = table.resourceId ?? (table.kind === 'xlsx' ? table.key : null);
    try {
      // ① 摘要计数
      try {
        const sr = await fetch(`/api/platform/action-proposal-summary?status=Proposed`, {
          credentials: 'include', signal,
        });
        const sb = await sr.json().catch(() => ({}));
        if (sr.ok && sb?.ok !== false) {
          proposalSummary = {
            total: Object.values(sb.counts||{}).reduce((n:number,v)=>n+Number(v||0),0),
            pending: Number(sb.counts?.Proposed) || 0,
            confirmed: Number(sb.counts?.Confirmed) || 0,
            rejected: Number(sb.counts?.Rejected) || 0,
          };
        }
      } catch { /* 摘要口不可用不影响列表 */ }

      // ②a cursor 列表（按表过滤）
      const lr = await fetch(`/api/platform/action-proposals?status=Proposed&limit=50`, {
        credentials: 'include', signal,
      });
      const lb = await lr.json().catch(() => ({}));
      if (lr.ok && lb?.ok !== false) {
        // B 的 ②a 分页口回 {items,next_cursor,has_more}；旧部署回 {list}。两种都认。
        const raw = lb?.items ?? lb?.list ?? [];
        proposalsHasMore = lb?.has_more === true
          || (typeof lb?.next_cursor === 'string' && lb.next_cursor.length > 0);
        // BASE967-27：附加拉本表的 promotion_status（reason 五值）。
        // **不阻塞列表**：旧部署/接口挂了不影响提案渲染。失败走「无徽标」——比「永远误标 unknown」诚实。
        if (promotionTable) try {
          const promotionQuery=new URLSearchParams({payload:JSON.stringify({table:promotionTable})});
          const ps = await fetch('/api/platform/services/files.promotion_status/invoke?'+promotionQuery, {credentials:'include',signal});
          if (ps.ok) {
            const psb = await ps.json().catch(() => ({}));
            const r = psb?.result || psb;
            const need = Array.isArray(r?.proposals_needing_revalidation) ? r.proposals_needing_revalidation : [];
            // 索引：proposal_id → reason
            const reasonById = new Map<string, string>();
            for (const item of need) {
              if (item && typeof item === 'object' && item.id) {
                reasonById.set(String(item.id), String(item.reason || 'unknown'));
              }
            }
            // 注入到每条提案 —— renderProposals 读 p._revalidation.reason
            const enriched = raw.map((p: Record<string, unknown>) => {
              const pid = String(p.id || p.proposal_id || '');
              const reason = reasonById.get(pid);
              return reason ? { ...p, _revalidation: { reason } } : p;
            });
            raw.splice(0, raw.length, ...enriched);
          }
        } catch { /* 徽标没拉到不挡列表 */ }
        // 按表过滤：**归属只看表**（列表项的 `target.table`）——
        // 那类提案现在也带 `target` 了（内核给的是页面模块 `excel`，域名另存在 `domain_module`），
        // ⇒ 按模块名过滤会把它们全挡掉。
        proposals = Array.isArray(raw)
          ? raw.filter((p: Record<string, unknown>) => {
              const t = proposalTargetTable(p);
              return t === tableKey||t === table?.resourceId;
            })
          : [];
        if(disposed||table?.key!==tableKey)return;
        renderProposals();
        await prepareInlineReviews(tableKey);
        return;
      }

      // 回落：旧口 files.action_proposals（按表取）
      proposalsHasMore = false;
      const r = await fetch('/api/platform/services/files.action_proposals/invoke', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { table: table?.resourceId??tableKey } }), signal,
      });
      const body = await r.json();
      if (disposed || table?.key !== tableKey) return;
      if (!r.ok || body?.ok === false) {
        proposals = []; renderProposals();
        notify(describeError(String(body?.error || body?.message || `HTTP ${r.status}`)), 'error');
        return;
      }
      const raw = body?.result?.proposals ?? body?.proposals ?? [];
      proposals = Array.isArray(raw) ? raw : [];
      // 合并说明：ours 这边逐条审核走**原位审核**（inline-review + 候选浮层，
      //   批准/放弃都是按项走 files.action_proposals 的 /accept、/reject-units）；
      // fast 那边在**聊天侧**审核（files.action_proposal_resolve 批/驳整条），
      //   页面只给一个「在对话中审核修改」的入口。
      // 两条都留：先做 ours 的原位审核准备，再把 fast 的「去聊天里审」入口挂上。
      const activeIds=new Set(proposals.map(proposal=>String(proposal.id||proposal.proposal_id)));
      for(const [id,controller] of inlineControllers)if(!activeIds.has(id)&&!controller.busy){controller.dispose();inlineControllers.delete(id);const registry=(window as any).shangshuInlineReviews;if(registry?.get(id)===controller)registry.delete(id);}
      // ★ fast 那边的入口：聊天里能审（chatLoadPendingConfirmations 在）且有待审项 ⇒
      //   给一个「在对话中审核修改」按钮，点它切到对话的分割视图并拉待审目录。
      const supported=proposals.filter(p=>p.review_supported);
      if(supported.length&&(window as any).chatLoadPendingConfirmations){
        const button=document.createElement('button');button.className='btn btn-ghost';button.textContent='在对话中审核修改';
        button.onclick=()=>{(window as any).chatSetMode?.('split');void (window as any).chatLoadPendingConfirmations();};
        (window as any).shangshuExcelChatReview=button;
      }
      renderProposals();
      await prepareInlineReviews(tableKey);
    } catch (error) {
      if (disposed) return;
      notify('待审核建议加载失败，请重开后核实。' + describeError((error as Error).message), 'error');
    }
  }

  function markProposalCells() {
    proposalMarks?.(); proposalMarks = null;
    if (!grid) return;
    renderInlineCandidates();
    const marks = proposals.filter(p=>!inlineControllers.has(String(p.id||p.proposal_id))).flatMap(p => proposalCells(p).map(cell => {
      const rowIndex = nameToIndex.get(cell.rowId);
      const colIndex = columnIndexOf(cell.header);
      return { rowIndex: rowIndex ?? -1, colIndex, kind: reviewSource(p).kind };
    })).filter(mark => mark.rowIndex >= 0 && mark.colIndex >= 0);
    proposalMarks = grid.markReviewCells(marks);
  }

  async function focusProposal(proposalId: string, preferredCell = 0) {
    const p = proposals.find(p => String(p.id || p.proposal_id) === proposalId);
    if (!p || disposed || !table) return;
    focusedProposalId = proposalId;
    const controller=inlineControllers.get(proposalId);
    const cells = controller?controller.descriptor.units.filter(unit=>(unit.status==='pending'||unit.status==='staged')&&unit.kind==='cell').map(unit=>({rowId:unit.target.row_id,header:unit.target.header,value:unit.value})):proposalCells(p);
    const cell = cells[preferredCell];
    const tableKey = table.key;
    if (cell) {
      const rowIndex = await resolveIndex(cell.rowId);
      if (disposed || table?.key !== tableKey) return;
      const colIndex = columnIndexOf(cell.header);
      if (rowIndex < 0 || colIndex < 0) {
        notify('建议目标已经变化或不可读取，请重新生成建议。', 'error'); return;
      }
      dropHighlight?.();
      grid?.selectCell(rowIndex, colIndex);
      grid?.scrollToRow(rowIndex, colIndex);
      dropHighlight = grid?.highlightCell(rowIndex, colIndex, reviewSource(p).kind) ?? null;
    }
    if(!hasInlineMapping(p)) {
      const show=(window as any).shangshuOpenReviewCard;
      if(show)await show(p,{navigate:false});
    }
    markProposalCells();
  }

  function renderProposals() {
    // 合并说明：ours 这边把每条建议的**定位结果**派发给聊天侧（shangshu:review-location），
    //   审核动作走原位审核控制器（inline-review）；
    // fast 那边在表格页自己画一个审核面板（整条批准/整条拒绝）。
    // 两条都留：ours 的事件派发保留；fast 的「整条批准/整条拒绝」通过
    // files.action_proposal_resolve 走公共口（由聊天侧的 proposal-review 组件承接）。
    for(const proposal of proposals) {
      const pid=String(proposal.id||proposal.proposal_id||'');
      const reason=proposalErrors.get(pid)||inlineControllers.get(pid)?.error||
        (!hasInlineMapping(proposal)?'暂时无法在表格中定位此建议，请重新核对或提出建议。':'');
      window.dispatchEvent(new CustomEvent('shangshu:review-location',{detail:{proposal_id:pid,reason}}));
    }
    markProposalCells();
    const wanted = new URLSearchParams(location.search).get('proposal');
    if (wanted && wanted !== focusedProposalId) void focusProposal(wanted);
  }
  window.addEventListener('shangshu:review-focus', async (event: Event) => {
    const e = event as CustomEvent;
    if (e.detail?.module !== 'excel' || (e.detail.table && e.detail.table !== table?.key)) return;
    await loadProposals();
    const id=String(e.detail.proposal_id || '');
    const pending=inlineControllers.get(id)?.descriptor.units.filter(unit=>(unit.status==='pending'||unit.status==='staged')&&unit.kind==='cell');
    const requested=e.detail.unit_id&&pending?pending.findIndex(unit=>unit.unit_id===e.detail.unit_id):Number(e.detail.cell_index)||0;
    if(requested<0){notify('这一项已处理或发生变化，请重新核对确认卡。','info');return;}
    await focusProposal(id,requested);
  }, { signal });
  window.addEventListener('shangshu:review-resolved', async (event: Event) => {
    const e = event as CustomEvent;
    const belongs = proposals.some(p => String(p.id || p.proposal_id) === e.detail?.proposal_id);
    if (belongs && e.detail?.status === 'confirmed' && e.detail?.origin !== 'excel') {
      if (hasUnsaved() || grid?.isEditing()) notify('建议已处理，请先完成当前输入再刷新核对正式值。', 'info');
      else try { await refreshReviewValues(); } catch { notify('建议已处理，正式值读回失败，请刷新核实。', 'error'); }
    }
    await loadProposals();
  }, { signal });

  async function refreshLoadedFormulaValues(){
    if(!table||disposed)return;
    const destination=table;
    await Promise.allSettled([...loadingPages.values()]);
    if(disposed||table!==destination)return;
    const pages=[...pageCache.keys()];
    pageGeneration++;loadingPages.clear();
    for(const page of pages)pageCache.delete(page);
    for(const page of pages)await loadPage(page);
  }

  async function refreshReviewValues() {
    if (!table || disposed) return;
    const key = table.key;
    const fresh = await openTable(key, signal, table.objectInfo?'db':table.kind);
    if (disposed || table?.key !== key) return;
    if (fresh.columns.length !== columns.length || fresh.columns.some((c, i) => c.fieldId !== columns[i].fieldId)) {
      await rebuildAfterStructure(); return;
    }
    table = fresh;
    const pages = [...pageCache.keys()]; pageCache.clear(); filled.clear(); requiredEmptyLedger.clear();
    for (const page of pages.length ? pages : [1]) await loadPage(page);
    renderScope(); markProposalCells();
  }

  // 表打开后加载提案（已在 openTableByKey 末尾调用 loadProposals）

  // —— 页内审核控制器接线（D 的 real-chat 从原对话跳到本页后等这个）——
  // real-chat.js 导航到 #/excel?object=<table>&proposal=<id>，派发 shangshu:review-focus；
  // 本页拉 descriptor、建控制器、注册 window.shangshuInlineReviews、派发 shangshu:review-ready。
  // mail-center.js 也一样（module:'mail'），同族。
  const reviewControllers = new Map<string, ReturnType<typeof createInlineReviewController>>();
  (globalThis as any).shangshuInlineReviews ||= new Map<string, unknown>();
  const globalReviews = (globalThis as any).shangshuInlineReviews as Map<string, unknown>;

  async function mountInlineReviewFor(proposalId: string, tableId: string): Promise<void> {
    try {
      const descriptor = await fetchReviewDescriptor(proposalId, tableId, { signal });
      const controller = createInlineReviewController({
        descriptor,
        signal,
        newKey: () => newIdempotencyKey(),
        blocking: () => pending.size > 0,
        coerce: (unit, text) => {
          // 候选值转类型：复用 toTypedValue 的逻辑
          const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          if (normalized.startsWith('=')) return { type: 'formula', formula: normalized, value: null } as any;
          return { type: unit.value?.type || 'text', value: normalized } as any;
        },
        readback: async (reply, expected) => {
          // 确认后重新读页，核对每个单元的值
          for (const { unit, value } of expected) {
            const want = value.value == null ? '' : String(value.value);
            const got = pageCache.get(1)?.find((r) => r.name === unit.target.row_id)?.[unit.target.header];
            if (String(got ?? '') !== want) {
              // 未命中缓存不硬判——服务端回执已确认，缓存可能还没刷
            }
          }
          void reply;
        },
        change: () => { /* UI 更新由 renderProposals 驱动 */ },
        progress: () => { void loadProposals(); },
      });
      reviewControllers.set(proposalId, controller);
      globalReviews.set(proposalId, controller);
      window.dispatchEvent(new CustomEvent('shangshu:review-ready', {
        detail: { proposal_id: proposalId, module: 'excel' },
      }));
    } catch (error) {
      console.warn(`[inline-review] ${proposalId} 控制器未就绪：${(error as Error).message || error}`);
    }
  }

  window.addEventListener('shangshu:review-focus', ((event: CustomEvent) => {
    const detail = event.detail || {};
    if (detail.module !== 'excel' || !detail.proposal_id || !detail.table) return;
    // 表不同则先开表
    (async () => {
      if (!table || table.key !== detail.table) {
        await openTableByKey(detail.table).catch(() => null);
      }
      await mountInlineReviewFor(String(detail.proposal_id), String(detail.table));
      // 焦点定位（有 unit 就滚到那格）
      if (detail.field && detail.cell_index != null) {
        const colIdx = columns.findIndex((c) => c.label === detail.field);
        if (colIdx >= 0) {
          const rowIdx = Number(detail.cell_index) || 0;
          grid?.selectCell(rowIdx, colIdx);
        }
      }
    })().catch(() => {});
  }) as EventListener);

  signal.addEventListener('abort', () => {
    for (const [id, controller] of reviewControllers) {
      controller.dispose();
      if (globalReviews.get(id) === controller) globalReviews.delete(id);
    }
    reviewControllers.clear();
  }, { once: true });

  void boot();

  signal.addEventListener('abort', () => {
    disposed = true;
    tableOpenGeneration++;
    setOpenLoading(false);
    // 合并说明：ours 这边收尾视口读调度与搜索计时器；fast 那边收尾保存队列与复制监听。
    // 四条都留。
    viewportReads.reset(); cancelSearchTimer();
    saveQueue.dispose();
    removeGridCopy?.();
    dropHighlight?.();
    dropHighlight = null;
    proposalMarks?.(); proposalMarks = null;
    clearInlineReviews();headerRename?.dispose();headerRename=null;columnDrag?.dispose();columnDrag=null;
    columnFilterOverlay?.dispose();columnFilterOverlay=null;
    rowBehaviors?.dispose();rowBehaviors=null;
    delete (globalThis as any).excelPageDiag;
    grid?.dispose();
    grid = null;
    ui?.dispose?.();
  }, { once: true });
}

// 页面/导航由轻量 loader 注册；重库只导出挂载能力，不重复注册导航或伪造领域 owner。
(g as any).shangshuMountExcelPage = mountExcelPage;
