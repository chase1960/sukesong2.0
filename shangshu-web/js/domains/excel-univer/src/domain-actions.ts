/**
 * 业务域在**表格工具栏**里的入口（域贡献；**不新开页面**）。
 *
 * 为什么在这里开口子：Excel 域是「一张表的编辑工作面」；example 这类业务域要做的
 * 是「**在��张表上**做一件事」（读本行受管列的正式值、写客户偏好）。
 * 另开一个页面，就得把表上下文（表身份 ＋ 固定行 ID）再搬一遍 ⇒ 两份事实、两个入口。
 *
 * 契约（三条，就这么多）：
 * 1. 业务域往全局登记表 `shangshuExcelDomainActions` 里放一条
 *    （`{id, label, title?, run}`）—— **域在自己的入口脚本里就能放**：
 *    表格部件是懒加载的（11MB，进了工作面才下），域登记不能等它；
 * 2. Excel 域在工具栏上开一个「业务」下拉，把登记到的条目画出来；
 * 3. 点某一条时，Excel 域把**当前上下文**（表身份 ＋ 选中行的固定行 ID ＋ 选中列）
 *    交给域，域**自己**去调公共动作通道 —— Excel 域不替域调、也不替域解释返回值。
 *
 * ⚠️ **这个模块不许自己长业务**：它只认「登记 → 画出来 → 把上下文递过去」。
 * 返回值是字符串就当**给人看的回执**，显示在入口旁边；别的形状一律忽略。
 */

export type ExcelDomainContext = {
  /** 当前打开的表身份（文件编号）。 */
  table: string;
  /** 当前选中行的**固定行 ID**（不是 Excel 可见行号）。 */
  row_id: string;
  /** 当前选中列的表头。 */
  header: string;
};

export type ExcelDomainAction = {
  /** 入口 id（域内唯一）。 */
  id: string;
  /** 给人看的按钮文字。 */
  label: string;
  /** 悬停说明。 */
  title?: string;
  /** 点下去做什么。返回值是字符串 = 回执（显示在入口旁边）。 */
  run: (context: ExcelDomainContext) => void | string | Promise<void | string>;
};

type Registry = Map<string, ExcelDomainAction>;

/** 全局登记表的键（两个域靠它对上；写进 AGENTS.md 的跨域约定里）。 */
export const EXCEL_DOMAIN_ACTIONS_KEY = 'shangshuExcelDomainActions';

function scope(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

/** 全局登记表（谁先建谁建；域与 Excel 域都走这一个）。 */
export function registry(): Registry {
  const current = scope()[EXCEL_DOMAIN_ACTIONS_KEY];
  if (current instanceof Map) return current as Registry;
  const created = new Map<string, ExcelDomainAction>();
  scope()[EXCEL_DOMAIN_ACTIONS_KEY] = created;
  return created;
}

/** 登记一条业务域入口（域在自己的入口脚本里调它）。 */
export function registerExcelDomainAction(action: ExcelDomainAction): void {
  if (!action || !action.id) throw new Error('业务域入口必须有 id');
  registry().set(action.id, action);
  refresh();
}

/** 已登记的入口（判据与诊断用）。 */
export function listExcelDomainActions(): ExcelDomainAction[] {
  return [...registry().values()];
}

type MountState = {
  toolrow: HTMLElement;
  getContext: () => ExcelDomainContext;
  signal?: AbortSignal;
};

let mounted: MountState | null = null;

/**
 * 把业务域入口挂进工具栏。
 *
 * `getContext` 在**点击那一刻**才取当前上下文（表、选中行、选中列）——
 * 挂上的时候表可能还没打开。
 */
export function mountExcelDomainActions(
  toolrow: HTMLElement | null,
  getContext: () => ExcelDomainContext,
  signal?: AbortSignal,
): void {
  if (!toolrow) return;
  mounted = { toolrow, getContext, signal };
  render();
  signal?.addEventListener('abort', () => {
    if (mounted?.toolrow === toolrow) mounted = null;
  }, { once: true });
}

function refresh(): void {
  if (mounted) render();
}

function render(): void {
  const state = mounted;
  if (!state) return;
  const { toolrow } = state;
  toolrow.querySelector('[data-domain-menu]')?.remove();
  const actions = listExcelDomainActions();
  if (!actions.length) return;

  const menu = document.createElement('div');
  menu.className = 'excel-toolmenu';
  menu.setAttribute('data-domain-menu', '');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn excel-toolmenu-toggle';
  toggle.setAttribute('data-domain-toggle', '');
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '业务 ▾';

  const dropdown = document.createElement('div');
  dropdown.className = 'excel-toolmenu-dropdown';
  dropdown.setAttribute('data-domain-dropdown', '');
  dropdown.setAttribute('role', 'menu');
  dropdown.hidden = true;

  const status = document.createElement('span');
  status.className = 'excel-domain-status';
  status.setAttribute('data-domain-status', '');
  status.setAttribute('role', 'status');

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
    toggle.setAttribute('aria-expanded', String(!dropdown.hidden));
  }, { signal: state.signal });

  for (const action of actions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('data-domain-action', action.id);
    item.textContent = action.label;
    if (action.title) item.title = action.title;
    item.addEventListener('click', async (event) => {
      event.stopPropagation();
      dropdown.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      status.textContent = '';
      try {
        const outcome = await action.run(state.getContext());
        status.textContent = typeof outcome === 'string' ? outcome : '';
      } catch (error) {
        status.textContent = `执行失败：${(error as Error).message}`;
      }
    }, { signal: state.signal });
    dropdown.append(item);
  }

  menu.append(toggle, dropdown, status);
  toolrow.append(menu);
}
