/**
 * 「独立模式」——「示例企业总表脱离成独立页」的落法（用户 2026-10-22 拍板）。
 *
 * 为什么要它（查实的耦合关系，不是猜的）：
 *  · 「返回列表」按钮（`main.ts` 的 `backToList()`）做三件事，**全是清单页的事**：
 *    删掉 URL 的 `object` 参数、把搜索词 `q` 写回 URL、把已加载条数写进 sessionStorage。
 *    表格工作面自己的功能（数据、工具栏、撤回、提案、保存、查找替换、列筛选）
 *    **一个都不调 `backToList()`** ⇒ 去掉返回口不伤工作面。
 *  · 清单页是「表格」侧栏入口的默认落点（没指定表就给统一清单，不替用户猜开哪张）。
 *    示例企业总表是**指定表**（`?object=<file_id>`）⇒ 本来就不过清单页，返回按钮纯属多余。
 *
 * 所以：**不改清单页的行为，只让「独立打开」这条路不渲染返回口**。
 *  · 独立模式 ⇒ 没有「返回列表」（人是从侧栏直接进来的，清单页跟他没关系）。
 *  · 普通模式 ⇒ 一字不变（从清单进来，回得去，搜索和筛选照旧）。
 *
 * ⚠️ 为什么不新开一个域来承载示例企业总表（用户问过，主控给的判断）：
 *  它是**文件域的一张 Excel 文件 ＋ example 域的一条表绑定登记**，不是业务能力，
 *  不拥有业务规则；为它建域会让「表的归属」散到三处（文件域存、example 登记、新域拥有），
 *  正是内核在拆的「同一个值只存一处」的病。详见 `fde/设计/契约/` 里域边界的成文口径。
 */

/** 地址里带 `standalone=1`（或 `true`）⇒ 独立模式：直接进这张表，不给「返回列表」。 */
export function standaloneFromSearch(search: string): boolean {
  const raw = new URLSearchParams(search).get('standalone');
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * 独立模式对人的说法（不是给机器看的布尔）。
 * 用来在代码里点明「为什么这个分支存在」，避免以后有人当成多余代码删掉。
 */
export function describeStandalone(standalone: boolean): string {
  return standalone
    ? '独立模式：这张表有自己的入口，没有「返回列表」——清单页跟这次打开无关。'
    : '普通模式：保留「返回列表」，好回到表清单（搜索和筛选照旧带回去）。';
}
