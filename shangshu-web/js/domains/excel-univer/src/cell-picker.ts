/**
 * 单元格上的**两个自绘选择件**：布尔**三态**（未填／是／否）与**日期日历**。
 *
 * **为什么要有**（用户 2026-10-27 交给的 PKG-126-T04／T05）：
 * · **T04「发案日期要日历」** —— 受管日期列（示例企业总表里有 6 个：`申请日`／`发文日期`／`发案日期`／
 *   `导入年费监控列表`／`初稿日期`／`定稿日期`）在表里**只能手打**，人得自己记得格式。
 *   Univer 1.0.3 **没有自带日期选择器**（`@univerjs/sheets-ui` 里没有 DateEditor）⇒ 自己画一个。
 * · **T05「布尔要分得开未填／否」** —— 布尔列原来被当**自由文本**（`adapter.ts` 的
 *   `mapColumnType` 写着「今日不做布尔特化」）⇒ 人分不出「未填」和「否」，
 *   而且写「是」会被服务端按 `开关列请使用 TRUE/FALSE 或 0/1` 拒掉。
 *   ⇒ 给一个**三态**选择件：未填（空）／是／否。
 *
 * **形状照 `cell-dropdown.ts` 那份取值下拉**（同一个产品里两套浮层会长得不一样）：
 * 自绘浮层、挂 `document.body`、`fixed` 定位、点外面／按 Esc 关掉、
 * **Esc 在捕获阶段拦**（不连带关掉外层弹窗）。
 *
 * **纯函数与界面分开**：日期的「哪个月」「哪一天」「能不能选」不碰 DOM
 * ⇒ 判据能离线核「该出现什么」，不靠肉眼看截图。
 */

/** 三态：未填／是／否。**空串＝未填**（与服务端的 NULL 一一对应）。 */
export const TRI_STATE_EMPTY = '';
export const TRI_STATE_YES = '是';
export const TRI_STATE_NO = '否';

/** 三态的三个选项（**顺序固定**：未填在最前——它是最容易误点的一个）。 */
export const TRI_STATE_ITEMS: Array<{ value: string; label: string }> = [
  { value: TRI_STATE_EMPTY, label: '未填' },
  { value: TRI_STATE_YES, label: '是' },
  { value: TRI_STATE_NO, label: '否' },
];

/**
 * 把**任意写法**归一到三态里的一个。
 * ⚠️ **归一，不猜**：认不出来就返回 null（调用方**当场拒**，不替人挑一个）。
 * 认得的写法：`是/否`（界面上的字）、`true/false`、`TRUE/FALSE`、`1/0`、空（未填）。
 */
export function normalizeTriState(raw: unknown): string | null {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return TRI_STATE_EMPTY;
  const lower = text.toLowerCase();
  if (lower === '是' || lower === 'true' || lower === '1') return TRI_STATE_YES;
  if (lower === '否' || lower === 'false' || lower === '0') return TRI_STATE_NO;
  return null;
}

/** 三态里某一项的显示文案（认不出的原样摆着，**不替它挑一个**）。 */
export function triStateLabel(raw: unknown): string {
  const value = normalizeTriState(raw);
  if (value === null) return String(raw == null ? '' : raw);
  const hit = TRI_STATE_ITEMS.find(item => item.value === value);
  return hit ? hit.label : value;
}

/**
 * 「YYYY-MM-DD」能不能算成一个**真的**日期（**不猜**：格式对但日子不存在 ⇒ 不行）。
 *
 * ⚠️ **不要用 `new Date('2026-11-03T00:00:00')` 判**（2026-10-27 实踩）：
 * 不带时区的日期时间串按**本地时间**解析，再 `toISOString()` 转回 UTC 就**跨天了**
 * （东八区：本地 2026-11-03 00:00 → UTC 2026-11-02 16:00 ⇒ 变成 10-02 ⇒ 明明存在的日期被判无效）。
 * ⇒ **拆开年/月/日自己算**：`Date.UTC(year, month, 0)` 给的是**那个月的最后一天**（0 号 ⇒ 上月末）。
 */
export function isValidDateText(text: string): boolean {
  const value = String(text || '').trim();
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** 一个月的格子（**按周排**：周一起头，空位补 null ⇒ 界面上留白，不是挤到前面）。 */
export function monthGrid(year: number, month: number): Array<Array<string | null>> {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;   // 周一 = 0
  const cells: Array<string | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= days; day++) {
    cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** 「YYYY-MM-DD」→ 那一年的那个月（**认不出来返回 null**）。 */
export function monthOf(text: string): { year: number; month: number } | null {
  if (!isValidDateText(text)) return null;
  const [year, month] = String(text).split('-').map(Number);
  return { year, month: month - 1 };
}

export interface PickerAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TriStateOptions {
  /** 面板摆哪儿（视口坐标）。 */
  anchor: PickerAnchor;
  /** 这一格当前的值（不在三态里就当自定义摆着）。 */
  current?: string;
  /** 选中一项时回调（**空串＝未填**）。 */
  onPick: (value: string) => void;
  /** 面板关掉时回调（无论因为选中、点外面还是 Esc）。 */
  onClose?: () => void;
}

export interface TriStateHandle {
  close(): void;
  isOpen(): boolean;
  /** 面板上现在列着的项。 */
  listed(): Array<{ value: string; label: string }>;
}

export interface DatePickerOptions {
  anchor: PickerAnchor;
  /** 这一格当前的日期（`YYYY-MM-DD`；认不出来就当没有）。 */
  current?: string;
  /** 选中一天时回调（**空串＝清空**）。 */
  onPick: (value: string) => void;
  onClose?: () => void;
}

export interface DatePickerHandle {
  close(): void;
  isOpen(): boolean;
  /** 面板现在显示的是哪个月（`YYYY-MM`）。 */
  month(): string;
  /** 面板上现在列着的日子（`YYYY-MM-DD`；空位不列）。 */
  listed(): string[];
  /** 面板上选中的那一天（没有则空串）。 */
  selected(): string;
  /** 那个「自己写一个」的输入框（给判据/诊断用）。 */
  textInput(): HTMLInputElement | null;
}

/** —— 以下是界面 —— */

function overlayShell(host: HTMLElement, className: string, role: string, label: string) {
  const doc = host.ownerDocument;
  const panel = doc.createElement('div');
  panel.className = className;
  panel.setAttribute('role', role);
  panel.setAttribute('aria-label', label);
  return { doc, panel };
}

function placePanel(win: Window, panel: HTMLElement, anchor: PickerAnchor, minWidth: number): void {
  const width = Math.max(anchor.width || 0, minWidth);
  const height = panel.offsetHeight || 0;
  const below = win.innerHeight - (anchor.top + (anchor.height || 0));
  const above = anchor.top;
  const top = below < height + 12 && above > below
    ? Math.max(8, anchor.top - height - 4)
    : anchor.top + (anchor.height || 0) + 4;
  const left = anchor.left + width > win.innerWidth - 8
    ? Math.max(8, win.innerWidth - width - 8)
    : anchor.left;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.minWidth = `${width}px`;
}

/**
 * 打开**布尔三态**选择件：未填／是／否。
 * ⚠️ **当前值不在三态里**（旧数据存过别的写法）⇒ **照原样摆一行并标成「自定义」**，
 * **不推断**成任一标准项（与取值下拉那条口径一致）。
 */
export function openTriState(host: HTMLElement, options: TriStateOptions): TriStateHandle {
  const doc = host.ownerDocument;
  const win = doc.defaultView || window;
  const { panel } = overlayShell(host, 'excel-tri-state', 'listbox', '选择是／否');
  panel.dataset.excelTriState = '';

  const current = String(options.current == null ? '' : options.current);
  const known = normalizeTriState(current);
  const custom = known === null && current !== '' ? current : '';

  let dead = false;

  function close(): void {
    if (dead) return;
    dead = true;
    panel.remove();
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    if (options.onClose) options.onClose();
  }

  function pick(value: string): void {
    close();
    options.onPick(value);
  }

  const list = doc.createElement('div');
  list.className = 'excel-tri-state-list';
  panel.appendChild(list);

  function render(): void {
    list.textContent = '';
    if (custom) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'excel-tri-state-item is-custom';
      row.dataset.value = custom;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const text = doc.createElement('span');
      text.textContent = `${custom}（自定义）`;
      row.appendChild(text);
      row.onclick = event => { event.stopPropagation(); pick(custom); };
      list.appendChild(row);
    }
    for (const item of TRI_STATE_ITEMS) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'excel-tri-state-item';
      row.dataset.value = item.value;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(item.value === known));
      const text = doc.createElement('span');
      text.textContent = item.label;
      row.appendChild(text);
      if (item.value === known) {
        const check = doc.createElement('span');
        check.className = 'excel-tri-state-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = '✓';
        row.appendChild(check);
      }
      row.onclick = event => { event.stopPropagation(); pick(item.value); };
      list.appendChild(row);
    }
  }

  function onOutside(event: Event): void {
    if (panel.contains(event.target as Node)) return;
    close();
  }
  function onKey(event: Event): void {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Escape' || dead) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }

  doc.body.appendChild(panel);
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
  panel.addEventListener('pointerdown', event => event.stopPropagation());
  render();
  placePanel(win, panel, options.anchor, 160);
  placePanel(win, panel, options.anchor, 160);

  return {
    close,
    isOpen: () => !dead,
    listed: () => Array.from(list.querySelectorAll('.excel-tri-state-item')).map(node => ({
      value: String((node as HTMLElement).dataset.value || ''),
      label: (node.textContent || '').replace('✓', '').replace('（自定义）', '').trim(),
    })),
  };
}

/**
 * 打开**日期日历**：一个月的格子 ＋ 前后翻月 ＋「今天」＋「清空」，
 * 外加**一个自己写日期的输入框**（日历不是唯一入口 —— 人记得确切日期时直接敲更快）。
 */
export function openDatePicker(host: HTMLElement, options: DatePickerOptions): DatePickerHandle {
  const doc = host.ownerDocument;
  const win = doc.defaultView || window;
  const { panel } = overlayShell(host, 'excel-date-picker', 'dialog', '选择日期');
  panel.dataset.excelDatePicker = '';

  const current = String(options.current || '');
  const start = monthOf(current) || monthOf(new Date().toISOString().slice(0, 10)) || { year: 2026, month: 0 };
  let year = start.year;
  let month = start.month;
  let selected = isValidDateText(current) ? current : '';
  let dead = false;

  const head = doc.createElement('div');
  head.className = 'excel-date-picker-head';
  panel.appendChild(head);

  const prev = doc.createElement('button');
  prev.type = 'button';
  prev.className = 'excel-date-picker-nav';
  prev.textContent = '‹';
  prev.setAttribute('aria-label', '上一月');
  const label = doc.createElement('span');
  label.className = 'excel-date-picker-label';
  const next = doc.createElement('button');
  next.type = 'button';
  next.className = 'excel-date-picker-nav';
  next.textContent = '›';
  next.setAttribute('aria-label', '下一月');
  head.append(prev, label, next);

  const grid = doc.createElement('div');
  grid.className = 'excel-date-picker-grid';
  panel.appendChild(grid);

  const foot = doc.createElement('div');
  foot.className = 'excel-date-picker-foot';
  const today = doc.createElement('button');
  today.type = 'button';
  today.className = 'excel-date-picker-foot-btn';
  today.textContent = '今天';
  const clear = doc.createElement('button');
  clear.type = 'button';
  clear.className = 'excel-date-picker-foot-btn';
  clear.textContent = '清空';
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'excel-date-picker-input';
  input.setAttribute('aria-label', '填写日期');
  input.placeholder = 'YYYY-MM-DD';
  const ok = doc.createElement('button');
  ok.type = 'button';
  ok.className = 'excel-date-picker-ok';
  ok.textContent = '确定';
  foot.append(today, clear, input, ok);
  panel.appendChild(foot);

  const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  function render(): void {
    label.textContent = `${year}-${String(month + 1).padStart(2, '0')}`;
    grid.textContent = '';
    const weekRow = doc.createElement('div');
    weekRow.className = 'excel-date-picker-week';
    for (const name of WEEK) {
      const cell = doc.createElement('span');
      cell.className = 'excel-date-picker-weekday';
      cell.textContent = name;
      weekRow.appendChild(cell);
    }
    grid.appendChild(weekRow);
    for (const week of monthGrid(year, month)) {
      const row = doc.createElement('div');
      row.className = 'excel-date-picker-days';
      for (const day of week) {
        if (!day) {
          const blank = doc.createElement('span');
          blank.className = 'excel-date-picker-day is-blank';
          row.appendChild(blank);
          continue;
        }
        const cell = doc.createElement('button');
        cell.type = 'button';
        cell.className = 'excel-date-picker-day' + (day === selected ? ' is-selected' : '');
        cell.dataset.date = day;
        cell.textContent = String(Number(day.slice(-2)));
        if (day === selected) cell.setAttribute('aria-selected', 'true');
        cell.onclick = event => { event.stopPropagation(); pick(day); };
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
  }

  function pick(value: string): void {
    close();
    options.onPick(value);
  }

  function close(): void {
    if (dead) return;
    dead = true;
    panel.remove();
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    if (options.onClose) options.onClose();
  }

  function onOutside(event: Event): void {
    if (panel.contains(event.target as Node)) return;
    close();
  }
  function onKey(event: Event): void {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Escape' || dead) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }

  prev.onclick = event => {
    event.stopPropagation();
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    render();
  };
  next.onclick = event => {
    event.stopPropagation();
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    render();
  };
  today.onclick = event => {
    event.stopPropagation();
    const now = new Date();
    const text = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    year = now.getFullYear();
    month = now.getMonth();
    selected = text;
    pick(text);
  };
  clear.onclick = event => {
    event.stopPropagation();
    pick('');
  };
  ok.onclick = event => {
    event.stopPropagation();
    const text = input.value.trim();
    if (!text) { pick(''); return; }
    if (!isValidDateText(text)) { input.setAttribute('aria-invalid', 'true'); return; }
    pick(text);
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); ok.click(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });

  doc.body.appendChild(panel);
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
  panel.addEventListener('pointerdown', event => event.stopPropagation());
  render();
  placePanel(win, panel, options.anchor, 240);
  placePanel(win, panel, options.anchor, 240);

  return {
    close,
    isOpen: () => !dead,
    month: () => `${year}-${String(month + 1).padStart(2, '0')}`,
    listed: () => Array.from(grid.querySelectorAll('.excel-date-picker-day[data-date]')).map(node =>
      String((node as HTMLElement).dataset.date || '')),
    selected: () => selected,
    textInput: () => input,
  };
}
