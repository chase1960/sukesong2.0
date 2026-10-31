/**
 * 「现在能不能离开这张表」（离页保护的那道判断）。
 *
 * ⚠️ **为什么要有这一件**（真事故：2026-10-29 15:4x，用户原话：
 *   「刷新页面也不能，显示有东西未完成」「出错了 还有未保存的修改，请先保存或重试」）：
 *   原来只要**有**未完成操作就拦人离开 ⇒
 *   而「结果不明」的那笔**永远不能放弃** ⇒ ⇒
 *   **人被锁死在里面**：编辑被拒、刷新被拦、放弃无门 ⇒ 整张表像坏了。
 *
 * **现在只拦「真的还在写」的那几笔**：
 *   · **在飞**（saving／刚入队还没发）⇒ 拦（它可能正在写进去）。
 *   · **失败／冲突／结果不明** ⇒ **没写进去**（重开以服务端正式值为准）⇒ **不拦人**：
 *     工作本身没丢（服务端有操作编号可核）⇒ 留着只会把人困住。
 */

/** 这几种状态＝**确实还在写**。 */
const IN_FLIGHT_STATES = new Set(['idle', 'saving']);

export interface LeaveDecision {
  /** 准不准离开。 */
  allow: boolean;
  /** 不准的话，是因为什么（`in-flight` ＝ 还有东西在写）。 */
  blockedBy: 'in-flight' | null;
}

/**
 * @param inputStates 输入队列里每一笔的状态
 * @param pendingStates 单格保存队列的状态
 * @param pendingWidthStates 列宽保存队列的状态
 * @param pendingFileOpStates 文件操作（粘贴等）的状态
 * @param editing 画布上是不是正在编辑（有一格还没敲完）
 */
export function decideLeaveTable(options: {
  inputStates: string[];
  pendingStates: string[];
  pendingWidthStates: string[];
  pendingFileOpStates: string[];
  editing: boolean;
}): LeaveDecision {
  const inFlight =
    options.inputStates.filter(state => IN_FLIGHT_STATES.has(state)).length +
    options.pendingStates.filter(state => state === 'saving').length +
    options.pendingWidthStates.filter(state => state === 'saving').length +
    options.pendingFileOpStates.filter(state => state === 'saving').length;
  if (inFlight === 0 && !options.editing) return { allow: true, blockedBy: null };
  return { allow: false, blockedBy: 'in-flight' };
}
