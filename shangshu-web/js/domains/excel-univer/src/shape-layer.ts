/**
 * **渲染层「形状」管理器**（2026-10-30 用户口径：
 * 「那是不是可以把所有的特效、绿底、候选都放进这个里面，
 * 　这样让速度更快，**不用每次都计算一次**」。
 *
 * ⚠️ **Univer 的高亮是「形状」**：加一个形状就要 `refreshShapes()` 一次，
 *   而那一次重画会把**已有的全部形状**重算一遍 ⇒
 *   **逐格加 ⇒ N 次重画 ⇒ 越加越慢**（实测一格约 70ms）。
 * ⇒ 这层管四件事：
 *   ① **成批加**：`highlightRanges` 一次加一整批 ⇒ **一次重画**；
 *   ② **没变就不动**：内容一样 ⇒ **一个形状都不重画**（滚动时不做无谓动作）；
 *   ③ **按组管**：每个效果一组（必填空的红底一组、审核标记按颜色各一组）⇒
 *      改哪组只动哪组；
 *   ④ **增量通道**：规则那边只送「加了几格、撤了几格」⇒
 *      这一层**不必从头比一遍整份清单**。
 *
 * ⚠️ **哪些东西进不来这一层**（如实记着，别硬塞）：
 *   · **受管列的绿底列头** —— 走 Univer 官方的 `customizeColumnHeader`
 *     （**列头那一层**的渲染，和「格上的形状」是两套机制）；
 *   · **案号候选浮层** —— 是**DOM 浮层**（盖在画布上的一层 div）。
 *   两者都不是「格上的形状」⇒ 塞进来就是**复制一份实现**，不是复用。
 *   它们各自的「别重算」另有各法（候选已经**只算看得见的行**）。
 */

/** 一格（用来比「变没变」＋ 拿来画）。 */
export interface ShapeGroupCell {
  /** 这一格的标识（内容没变 ⇒ 标识没变）。 */
  key: string;
  /** 这一格的 Univer 范围对象（`worksheet.getRange(...)` 的结果）。 */
  range: any;
}

export interface ShapeLayerOptions {
  /** 拿到底了才画（网格还没建好时返回 null ⇒ 这一轮不画，等下一轮）。 */
  worksheet(): any | null;
}

export interface ShapeLayer {
  /** 换掉某一组；**内容没变就什么都不做**（连重画都不做）。 */
  setGroup(name: string, style: object, cells: ShapeGroupCell[]): void;
  /**
   * **增量改一组**：加这些、摘那些。
   * ⚠️ **为什么要有**：规则与装饰层之间的通道**只传增量** ⇒
   *   装饰层**不必从头比一遍整份清单**（大表上就是几万次比较）。
   */
  patchGroup(name: string, style: object, delta: { add: ShapeGroupCell[]; remove: string[] }): void;
  /**
   * 换掉某个**前缀**下的全部组（这次没提到的那些组会被摘掉）。
   * ⚠️ **为什么要这个**：某个效果可能**按颜色分好几组**（审核标记有三种来源），
   *   这一轮只剩两种 ⇒ 第三组必须**摘掉**，否则会留下过期的框。
   */
  setGroupSet(prefix: string, entries: Array<{ name: string; style: object; cells: ShapeGroupCell[] }>): void;
  /** 摘掉某一组（这一组的效果没了）。 */
  dropGroup(name: string): void;
  /** 现在有哪几组（诊断口用）。 */
  names(): string[];
  /** 现在有几组、画了几个格子（诊断口用）。 */
  stats(): { groups: number; cells: number };
  /** 全部摘掉（网格没了 / 表关了）。 */
  dispose(): void;
}

/** 样式比大小：只看**我们自己那几个字段**（Univer 的样式对象可能有别的字段）。 */
function styleSignature(style: object): string {
  try {
    return JSON.stringify(style ?? {});
  } catch {
    return String(style);
  }
}

export function createShapeLayer(options: ShapeLayerOptions): ShapeLayer {
  const groups = new Map<string, { styleKey: string; cells: Map<string, ShapeGroupCell>; dispose: () => void }>();
  let dead = false;

  function sameKeys(previous: string[], next: string[]): boolean {
    if (previous.length !== next.length) return false;
    for (let i = 0; i < previous.length; i += 1) if (previous[i] !== next[i]) return false;
    return true;
  }

  /** **成批画一组**（一次重画）；没有批量口就一格一格画（慢，但不会没有效果）。 */
  function paintGroup(ws: any, styleKey: string, style: object, list: ShapeGroupCell[]) {
    const paintStyle = { ...(style as Record<string, unknown>) };
    const batch = typeof ws.highlightRanges === 'function'
      ? ws.highlightRanges(list.map((cell) => cell.range), paintStyle)
      : null;
    if (batch) {
      // —— **批量口**：一次重画画一整批（一格一次重画的话几十格就把主线程占住几秒）——
      return {
        styleKey,
        cells: new Map(list.map((cell) => [cell.key, cell])),
        dispose: () => { try { batch.dispose(); } catch { /* 网格可能已经没了。 */ } },
      };
    }
    const marks: Array<{ dispose(): void }> = [];
    for (const cell of list) {
      try {
        const mark = cell.range?.highlight?.(paintStyle);
        if (mark) marks.push(mark);
      } catch { /* 画不上就拉倒。 */ }
    }
    return {
      styleKey,
      cells: new Map(list.map((cell) => [cell.key, cell])),
      dispose: () => { for (const mark of marks) { try { mark.dispose(); } catch { /* 忽略。 */ } } },
    };
  }

  function drop(name: string): void {
    const existing = groups.get(name);
    if (!existing) return;
    groups.delete(name);
    try { existing.dispose(); } catch { /* 网格可能已经没了。 */ }
  }

  return {
    setGroup(name, style, cells) {
      if (dead) return;
      const list = cells || [];
      const styleKey = styleSignature(style);
      const existing = groups.get(name);
      // —— **没变 ⇒ 一个形状都不动**（这就是「不用每次都计算一次」）——
      if (existing && existing.styleKey === styleKey
        && sameKeys([...existing.cells.keys()], list.map((cell) => cell.key))) return;
      const ws = options.worksheet();
      if (!ws) return;            // 网格还没建好 ⇒ 这一轮不画（下一轮再来）
      // —— 摘掉旧的那组（**只摘这一组**）——
      drop(name);
      if (!list.length) return;
      groups.set(name, paintGroup(ws, styleKey, style, list));
    },
    patchGroup(name, style, delta) {
      if (dead) return;
      const ws = options.worksheet();
      if (!ws) return;            // 网格还没建好 ⇒ 这一轮不画（下一轮再来）
      const styleKey = styleSignature(style);
      const existing = groups.get(name);
      const cells = new Map<string, ShapeGroupCell>();
      if (existing) for (const [key, cell] of existing.cells) cells.set(key, cell);
      for (const key of delta?.remove || []) cells.delete(key);
      for (const cell of delta?.add || []) cells.set(cell.key, cell);
      const list = [...cells.values()];
      // —— 增量没带来任何变化 ⇒ **一个形状都不动** ——
      if (existing && existing.styleKey === styleKey
        && sameKeys([...existing.cells.keys()], list.map((cell) => cell.key))) return;
      drop(name);
      if (!list.length) return;
      groups.set(name, paintGroup(ws, styleKey, style, list));
    },
    setGroupSet(prefix, entries) {
      const wanted = new Set<string>();
      for (const entry of entries || []) {
        const name = `${prefix}:${entry.name}`;
        wanted.add(name);
        this.setGroup(name, entry.style, entry.cells);
      }
      // —— **这次没提到的组 ⇒ 摘掉**（否则留下过期的框）——
      for (const name of [...groups.keys()]) {
        if (name.startsWith(`${prefix}:`) && !wanted.has(name)) drop(name);
      }
    },
    dropGroup(name) {
      drop(name);
    },
    names() {
      return [...groups.keys()];
    },
    stats() {
      let cells = 0;
      for (const group of groups.values()) cells += group.cells.size;
      return { groups: groups.size, cells };
    },
    dispose() {
      dead = true;
      for (const name of [...groups.keys()]) drop(name);
    },
  };
}
