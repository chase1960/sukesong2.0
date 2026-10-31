/**
 * 越界写入（要**加行 / 加列**）准不准 —— 纯函数，好测。
 *
 * ⚠️ **为什么单独拎出来**（用户 2026-10-29 14:5x：「粘贴也要行，输入也要行」）：
 *   原来这道闸问的是 **`exportCapabilities.canStructure`** ——
 *   那是**「导出能力探测」**的结果：`files.versions` 是**异步**探的，
 *   而且失败时**错误被吞掉**（`.catch(()=>{})`）⇒ 它可以一直是空。
 *   ⇒ 拿它当闸 ⇒ **开表后手一快，越界写入就是死的**，
 *   而人看到的是「没有结构编辑权限」——**说错了原因**（权限其实有，只是还没探到）。
 *
 *   现在这道闸问的是**表自己的结构权**（`sheet_read` 回的 `my_access.structure`
 *   ⇒ `table.canStructure`，**开表那一刻就有了**）。
 *
 * **口径**：
 *   · 写**已有格**（不越界）⇒ 不改结构 ⇒ **不看结构权**（能改值就能改值）。
 *   · 写**越界**（要加行/加列）⇒ 改结构 ⇒ **要结构权**；没有就**明确拒**，
 *     不许「嘴上说没权限、实际偷偷放行」，也不许反过来。
 *   · 业务表（db）越界 ＝ **新增记录**（走原对象那条路）⇒ 不由这道闸管。
 */

export type ExtendDecision = {
  /** 准不准这一次写入。 */
  allowed: boolean;
  /** 不准时给**人看**的那句话（准的时候没有）。 */
  reason?: string;
};

/**
 * @param kind 表的种类：'xlsx'（文件表）｜ 'db'（业务对象表）
 * @param outOfBounds 这次写入**越界**了吗（要加行/加列）
 * @param canStructure 这张表**自己的**结构权（`table.canStructure`；不知道＝空）
 */
export function decideExtendWrite(options: {
  kind: 'xlsx' | 'db';
  outOfBounds: boolean;
  canStructure?: boolean;
}): ExtendDecision {
  // 没越界 ⇒ 只是改已有格子的值 ⇒ 不需要结构权。
  if (!options.outOfBounds) return { allowed: true };
  // 业务表越界 ＝ 新增记录 ⇒ 另一条路（那条路自己判「能不能新增」）。
  if (options.kind === 'db') return { allowed: true };
  if (options.canStructure === true) return { allowed: true };
  return {
    allowed: false,
    reason: '当前用户可修改已有值，但没有该表的结构编辑权限；新增行列未保存',
  };
}
