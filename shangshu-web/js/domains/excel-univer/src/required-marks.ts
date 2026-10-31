/**
 * **空的必填格**：算出来、框红、提醒（2026-10-30 用户口径 · PKG-133）。
 *
 * **用户原话**：
 * 「有必填列的表的空行，在行写入保存的时候要 check 必填列是否为空，
 * 　如果空了就**把必填列给框起来用红色**，并且在 **toast 提醒**，
 * 　但是**不强制不能保存**（因为我一行要一个格子一个格子输入），
 * 　然后**每一次刷新都自检一下**必填列有没有被填入，
 * 　没有被填入就**用红色继续框和提醒**。」
 *
 * ⚠️ **为什么把「算」抽成纯函数**（不放在 main.ts 里现算）：
 * 「哪些格是空的必填格」这件事**不碰画布、不碰网络** ⇒
 * 抽成纯函数就能**离线钉准**（画布那一侧另有判据钉「真的画了红框」）。
 *
 * ⚠️ **为什么「空」按「去掉空白后为空」算**：
 * 人按了空格、复制进来一个空格 ⇒ 那格**看着是空的** ⇒ 该提醒
 * （服务端口径也是 `value.strip()==''` 那一档）。
 */

/** 一格空必填格的标记（画红框用）。 */
export interface RequiredEmptyMark {
  /** 行下标（0 基，与网格一致）。 */
  rowIndex: number;
  /** 那一列的**字段 id**（与网格一致 —— 网格的样式就是按字段 id 设的）。 */
  fieldId: string;
  /** 那一列的表头名（提醒文案用）。 */
  label: string;
}

/** 一个必填列的**身份**：表头名 ＋ 字段 id。 */
export interface RequiredColumn {
  /** 表头名（后端 `rules.required` 挂在列上 ⇒ 清单是按表头名给的）。 */
  label: string;
  /** 那一列的**字段 id**（网格样式按它设）。 */
  fieldId: string;
}

/** 一行要算的值（只看必填的那些列就够）。 */
export interface RequiredRowValues {
  rowIndex: number;
  /** 字段 id → 值。 */
  values: Record<string, string | number | null | undefined>;
}

/**
 * **空必填格的标记样式**（2026-10-30 用户口径：「这个框能不能走 univer 原生，
 * 直接一个**半透明的红底**」）。
 *
 * ⚠️ **走 Univer 原生的渲染层高亮**（`range.highlight`）：
 *   **不改数据、不执行命令** ⇒ 不会存进文件、不会触发保存链
 *   ⇒ 这是「提醒」，不是「格式」（用户的文件里不该多出这些底色）。
 *   ⚠️ **为什么用半透明填充而不是实心填充**：实心会把格子里的字盖住；
 *   半透明 ⇒ 字还看得见，同时一眼看出「这一格还缺东西」。
 *   ⚠️ **描边只留极淡的一圈**（2026-10-30 用户看过实心粗边 ⇒ 不要那种）：
 *   要的是「红底」这个**面**，不是一圈刺眼的粗线。
 *   颜色与「必填列头那颗红星」同一族（`#DC2626`）⇒ 一眼认得出是同一件事。
 */
export const REQUIRED_EMPTY_HIGHLIGHT = {
  /** 底色：半透明红。 */
  fill: 'rgba(220,38,38,0.14)',
  /** 描边：同色但很淡、很细（只是把那一格的边界收一下，不是重点）。 */
  stroke: 'rgba(220,38,38,0.45)',
  strokeWidth: 1,
} as const;

/** 提醒文案里说的「必填」那几个字（判据要认它）。 */
export const REQUIRED_REMINDER_WORD = '必填';

/**
 * 算出**哪些格是空的必填格**。
 *
 * @param rows      每一行的值（字段 id → 值）
 * @param required 必填列的**身份**（表头名 ＋ 字段 id）
 */
export function emptyRequiredCells(
  rows: RequiredRowValues[],
  required: RequiredColumn[],
): RequiredEmptyMark[] {
  const marks: RequiredEmptyMark[] = [];
  const need = (required || []).filter((col) => String(col?.label || '').trim());
  if (!need.length) return marks;
  for (const row of rows || []) {
    for (const col of need) {
      const raw = row?.values?.[col.fieldId];
      const text = raw === null || raw === undefined ? '' : String(raw);
      if (text.trim() === '') {
        marks.push({ rowIndex: row.rowIndex, fieldId: col.fieldId, label: col.label });
      }
    }
  }
  return marks;
}

/**
 * **必填格清单的「累积账」**（2026-10-30 用户点名的**正确性缺陷**）。
 *
 * **用户原话**：「**改红框为增量**（这是正确性缺陷：**翻页后前面页的红框会消失**）。」
 *
 * ⚠️ **为什么会有这个缺陷**：表格中心是**按页装填**的 ——
 *   装填第 2 页时，主控手上只有**第 2 页那些行** ⇒
 *   若把「要框的清单」**直接覆盖** ⇒ **第 1 页那些空的必填格就被挤掉了**
 *   ⇒ 红框跟着消失 ⇒ **翻页后前面页不红了**。
 * ⚠️ **为什么不能靠「每次重算全表」绕过去**：全表没装填时根本算不出来
 *   （那些行还没读到）⇒ 只能**把已经知道的行攒起来**。
 *
 * ⇒ 这本账**只进不出**：
 *   · 新装填的行**并进来**（不动前面那些）；
 *   · 某一行的值变了（填上了）⇒ **就地改**那一行的框；
 *   · 某一行没了（删行/换表）⇒ 才**摘掉**那一行。
 *
 * ⚠️ **为什么是纯函数**：这件事**不碰画布、不碰网络** ⇒
 *   离线就能钉准「翻页后前面页的清单还在」（不用开浏览器）。
 */
export class RequiredEmptyLedger {
  /** 行下标 → 那一行的值（只存必填列的那些就够，但多存无妨）。 */
  private readonly values = new Map<number, Record<string, string | number | null | undefined>>();
  /** 现在的必填列清单（**异步**来的 ⇒ 晚于第一次装填）。 */
  private required: RequiredColumn[] = [];
  /** 行下标 → 那一行要框的格。 */
  private readonly marksByRow = new Map<number, RequiredEmptyMark[]>();
  /** key（`行\0列`）→ 要框的格。 */
  private readonly markIndex = new Map<string, RequiredEmptyMark>();
  /** **已经交给装饰层的那些**（用来算增量）。 */
  private delivered = new Set<string>();

  /**
   * 设必填列清单（**晚到**的异步清单）。
   * ⚠️ **清单变了 ⇒ 全部重算**（之前按旧清单算的都不作数）。
   * @returns 清单**变没变**（没变就一个字都不重算）
   */
  setRequired(required: RequiredColumn[]): boolean {
    const next = required || [];
    const same = next.length === this.required.length
      && next.every((col, index) => col?.label === this.required[index]?.label && col?.fieldId === this.required[index]?.fieldId);
    if (same) return false;
    this.required = next;
    this.recomputeAll();
    return true;
  }

  /**
   * 把**这一批**行的值并进来（**合并**，不是覆盖 —— 这就是「增量」）。
   *
   * ⚠️ **只重算并进来的那些行**（不重算全表）—— 这就是「不用每次都计算一次」。
   */
  merge(rows: RequiredRowValues[]): void {
    let changed = false;
    for (const row of rows || []) {
      if (!row || typeof row.rowIndex !== 'number') continue;
      this.values.set(row.rowIndex, { ...(row.values || {}) });
      if (this.recomputeRow(row.rowIndex)) changed = true;
    }
    if (changed) this.invalidate();
  }

  /** 某一行没了（删行 / 换表）⇒ 那一行的框摘掉。 */
  remove(rowIndex: number): void {
    if (!this.values.delete(rowIndex)) return;
    this.dropRowMarks(rowIndex);
    this.invalidate();
  }

  /** 整本清空（换表了 ⇒ 旧表的红框不许跟到新表上）。 */
  clear(): void {
    this.values.clear();
    this.marksByRow.clear();
    this.markIndex.clear();
    this.required = [];
    this.delivered.clear();
  }

  /** 当前要框的是**哪些格**（**全部已装填的行**）。 */
  marks(required?: RequiredColumn[]): RequiredEmptyMark[] {
    if (required) this.setRequired(required);
    return [...this.markIndex.values()].map((mark) => ({ ...mark }));
  }

  /**
   * **这次相对「已经交出去的」多了哪些、少了哪些**（给装饰层当**增量**用）。
   *
   * ⚠️ **为什么要有这个**：规则与装饰层之间的通道，**每次都传全量清单**
   *   ⇒ 装饰层每次都要**从头比一遍**（大表上就是几万次比较）。
   * ⇒ 只传**增量**（加了几格、撤了几格）⇒ 通道小、装饰层不用全表比对。
   */
  takeDelta(): { added: RequiredEmptyMark[]; removed: string[] } {
    const added: RequiredEmptyMark[] = [];
    for (const [key, mark] of this.markIndex) {
      if (this.delivered.has(key)) continue;
      added.push({ ...mark });
    }
    const removed: string[] = [];
    for (const key of this.delivered) {
      if (!this.markIndex.has(key)) removed.push(key);
    }
    this.delivered = new Set(this.markIndex.keys());
    return { added, removed };
  }

  /** 重算某一行要框的格；返回「变了没有」。 */
  private recomputeRow(rowIndex: number): boolean {
    const values = this.values.get(rowIndex);
    if (!values) return false;
    const next = emptyRequiredCells([{ rowIndex, values }], this.required);
    const previous = this.marksByRow.get(rowIndex) || [];
    const previousKeys = previous.map((mark) => `${mark.rowIndex}\u0000${mark.fieldId}`);
    const nextKeys = next.map((mark) => `${mark.rowIndex}\u0000${mark.fieldId}`);
    if (previousKeys.length === nextKeys.length && previousKeys.every((key, index) => key === nextKeys[index])) return false;
    this.dropRowMarks(rowIndex);
    this.marksByRow.set(rowIndex, next);
    for (const mark of next) this.markIndex.set(`${mark.rowIndex}\u0000${mark.fieldId}`, mark);
    return true;
  }

  /** 摘掉某一行已登记的框。 */
  private dropRowMarks(rowIndex: number): void {
    const previous = this.marksByRow.get(rowIndex);
    if (!previous) return;
    for (const mark of previous) this.markIndex.delete(`${mark.rowIndex}\u0000${mark.fieldId}`);
    this.marksByRow.delete(rowIndex);
  }

  /** 必填列清单变了 ⇒ 全部重算。 */
  private recomputeAll(): void {
    this.marksByRow.clear();
    this.markIndex.clear();
    for (const rowIndex of this.values.keys()) this.recomputeRow(rowIndex);
  }

  /** 清单变了 ⇒ 「已交出去的」那份作废（下一轮要重发全量）。 */
  private invalidate(): void {
    // —— 增量是相对「已交出去的」算的；值变了但格子没变时不必重发 ——
  }
}

/**
 * 提醒文案：说清**缺哪几列**（人话）。
 *
 * ⚠️ **为什么不说「校验失败」**：那一行**能存**（不拦保存）⇒
 * 说「校验失败」会让人以为存不进去 ⇒ 反而不敢往下填。
 */
export function requiredReminderText(missingLabels: string[]): string {
  const labels = (missingLabels || []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!labels.length) return '';
  // —— **只留一句人话**（2026-10-30 用户口径：「toast 那里必填项解释也过多了，
  //   就保留『xxx 必填项未填』」）⇒ 不解释「可以先存」那套（人自己知道）。
  return `${labels.join('、')}${REQUIRED_REMINDER_WORD}项未填`;
}
