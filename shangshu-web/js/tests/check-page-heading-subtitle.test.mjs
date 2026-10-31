// 判据：全站页头条（`.page-hd` / `.page-heading`）**不许挂解释性副标题**。
//
// **测试通过 =**（一句话）
// 「点开任何一个页面，标题下面**都不再有一行『这个页面是干什么的』的解释文字**
//   —— 那 **47** 条解释性子标题**一条都不剩**（连那句字串本身都不许再出现在源码里）；
//   而『这一条记录自己的事实』那 **3** 处（帖子作者·日期 ／ 发票单号·类型 ／ 模板集自己的描述）
//   **原样还在** ⇒ 这一轮删的是**解释**，不是**事实**。」
//
// ⚠️ **为什么判据要同时钉「相反」的两件事**（用户 2026-10-23 原话：
//   「另外拍一个看一下每个页面上面有一些解释性的文字，把它给删一删」）：
//   · 删的是**每个页面自己那一行**的解释 —— 换个说法再写一遍**不算删**；
//   · 但 `.sub` 这个类**不能一刀切**：它装的是「这一条记录自己的事实」时**必须留**
//     （话题集的「作者·日期」、发票详情的「单号·类型」、模板集自己的描述）——
//     把它们一起删了 ＝ 把事实删了 ⇒ 判据必须**同时**钉住「删干净」与「不许过度删除」。
//
// 📌 **清单是扫出来的当前状态，已逐条人工复核**（2026-10-23 · PKG-063-T01）：
//   全站 `shangshu-web/js/` 里 `<div class="sub">` 共 **50** 处
//   ＝ 解释性 **47** ＋ 数据型 **3**。
//   （任务单上写的是「46 条」，实扫是 **47** 条 —— 以实扫为准。）
//   行号是**改之前**的行号；删完之后行号会往上移 ⇒ 判据断的是**字串**，不是行号。
//
//   另外两处页头条的解释文字**不是 `<div class="sub">`**，单列在下面：
//   · 审核中心（`review-center.js`）—— 由 `element('div','sub',description)` 写进去的
//     （它的 `description` 装的是「这一页是干什么的」⇒ 删）；
//   · 流程「待办」页（`real-flowdesign.js`）—— 页头条里的 `<p>`（同样是解释 ⇒ 删）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
// ⚠️ **不许用 `url.pathname` 当文件路径**：仓库路径里有中文（`尚书重构`）⇒
// `.pathname` 给的是**百分号编码**的串（`%E5%B0%9A...`）⇒ 读文件直接 ENOENT。
// ⇒ 一律走 `fileURLToPath()`。
const ROOT_PATH = fileURLToPath(ROOT);

const read = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

/* ───────────────── 解释性副标题：47 条（一条都不许再出现） ───────────────── */
/* 每条 = 「文件:行（改前）」＋ 页头条上原来写着的那句原文。 */
const EXPLANATORY = [
  { file: 'shangshu-web/js/domains/example-domain/example-domain-mail-rules.js', line: 208, text: '客户偏好与邮件模板合成的这一张表：谁适用、管什么、现在能不能寄' },
  { file: 'shangshu-web/js/domains/example-domain/example-domain-notice-assistant.js', line: 115, text: '查看桌面收件箱的收件、上传与尚书核验状态' },
  { file: 'shangshu-web/js/erp-mock.js', line: 18, text: '贸易部客户档案 · 数据来自状态数据库，点格子直接改' },
  { file: 'shangshu-web/js/erp-mock.js', line: 55, text: '报价单 AI 生成 · 人可手改 · 成交后自动转销售订单' },
  { file: 'shangshu-web/js/erp-mock.js', line: 120, text: '物流状态与回款自动同步 · 逾期 AI 预警' },
  { file: 'shangshu-web/js/erp-mock.js', line: 143, text: '自产线工单 · 工序进度实时回传 · 缺料自动预警' },
  { file: 'shangshu-web/js/erp-mock.js', line: 205, text: '成品仓 + 原料仓 · 低于预警自动触发采购建议' },
  { file: 'shangshu-web/js/erp-mock.js', line: 247, text: '供应商与采购单 · 缺料自动关联工单' },
  { file: 'shangshu-web/js/erp-mock.js', line: 271, text: '拍照 → OCR → 报销单，全程 AI 代办' },
  { file: 'shangshu-web/js/erp-mock.js', line: 303, text: '账期自动跟踪 · 到期前 AI 提醒' },
  { file: 'shangshu-web/js/erp-mock.js', line: 329, text: 'AI 写的初稿 · 你改完 AI 同步进状态数据库' },
  { file: 'shangshu-web/js/erp-mock.js', line: 374, text: 'AI 产出与人工上传统一归档 · 按业务对象自动分组' },
  { file: 'shangshu-web/js/erp-mock.js', line: 396, text: '企业的可执行流程资产 · 用得越多越值钱' },
  { file: 'shangshu-web/js/erp-mock.js', line: 447, text: '管的不是业务流程，而是「数字员工」本身' },
  { file: 'shangshu-web/js/erp-mock.js', line: 556, text: '任务与截止自动来自 Skill 执行 · 不用手填' },
  { file: 'shangshu-web/js/mock-pages.js', line: 40, text: '排期表拆任务 · 手动添加 · 进度跟踪' },
  { file: 'shangshu-web/js/mock-pages.js', line: 55, text: '分项目成本视图 · 同类型项目人力/价格预测' },
  { file: 'shangshu-web/js/mock-pages.js', line: 82, text: '发帖讨论 · 可关联任务/项目/发票' },
  { file: 'shangshu-web/js/mock-pages.js', line: 110, text: '标准流程 → 人和 AI 按步骤协作执行' },
  { file: 'shangshu-web/js/real-accounting.js', line: 8, text: '记账表 append-only · 写操作走事件写总线（确认卡留痕）' },
  { file: 'shangshu-web/js/real-ai-tools.js', line: 9, text: '当前企业、启用应用和你的权限共同决定可用能力 · 与 AI 实际执行目录一致' },
  { file: 'shangshu-web/js/real-applications.js', line: 404, text: '按数据、页面、流程、权限和发布顺序配置应用' },
  { file: 'shangshu-web/js/real-apps.js', line: 46, text: '已安装的业务域与系统组件 —— 启停、依赖与运行状态都在这里' },
  { file: 'shangshu-web/js/real-config.js', line: 105, text: '单企业单实例 · 配置外部服务后仍需检查连通性并用样本验收' },
  { file: 'shangshu-web/js/real-config.js', line: 141, text: '侧栏显示与布局定制 —— 开关模块入口、拖拽调整分组顺序' },
  { file: 'shangshu-web/js/real-cron.js', line: 28, text: '数字员工按计划自动干活 —— 看得见、随时能改' },
  { file: 'shangshu-web/js/real-dashboard.js', line: 9, text: '我的事项和常用业务' },
  { file: 'shangshu-web/js/real-doc.js', line: 6, text: '管理模板集及其文档类型 · 上传 .docx 模板文件' },
  { file: 'shangshu-web/js/real-doc.js', line: 114, text: '选择模板 → 填写字段 → 一键生成 .docx' },
  { file: 'shangshu-web/js/real-erp.js', line: 23, text: '客户主档 · 订单与应收的关联起点 · 停用代替删除' },
  { file: 'shangshu-web/js/real-erp.js', line: 77, text: '产品主档 · 订单明细与库存的基础 · price 售价 / cost 成本（毛利核算用）' },
  { file: 'shangshu-web/js/real-erp.js', line: 136, text: '销售订单 · 草稿→确认→完成 · 确认后自动生成应收台账 · 金额服务端重算' },
  { file: 'shangshu-web/js/real-erp.js', line: 245, text: '采购单 · 收货自动入库并生成应付台账 · 类型（常规/外采/库存）' },
  { file: 'shangshu-web/js/real-erp.js', line: 346, text: '当前量由出入库流水投影（append-only）· 采购收货自动入库 · 发货出库在「发货与回款」' },
  { file: 'shangshu-web/js/real-erp.js', line: 368, text: '台账余额与实际收付分开管理 · 登记、冲回均留痕' },
  { file: 'shangshu-web/js/real-erp.js', line: 437, text: '发货 = 预校验库存 → 逐项出库（事件留痕）→ 订单完成；回款在「应收应付」页登记' },
  { file: 'shangshu-web/js/real-flows.js', line: 397, text: '链路为主 · 环节可钉到侧栏快速入口' },
  { file: 'shangshu-web/js/real-invoice.js', line: 21, text: '邮箱自动收取 → OCR 抽取 → 待审 → 核对入库' },
  { file: 'shangshu-web/js/real-kanban.js', line: 260, text: '老板驾驶舱聚合 · 数据来自状态数据库（演示数据）' },
  { file: 'shangshu-web/js/real-objects.js', line: 40, text: '按业务数据集查询记录；设计信息与日常使用分开' },
  { file: 'shangshu-web/js/real-skill-sync.js', line: 7, text: '管理 Claude Code skill 的上传密钥、版本历史与冲突' },
  { file: 'shangshu-web/js/real-task.js', line: 86, text: '安排工作、跟进进度、提交结果' },
  { file: 'shangshu-web/js/real-users.js', line: 77, text: '平台身份由内核维护（Frappe 用户 + 不可变身份）· 停用即无法登录并撤销会话 · 身份不可删除，历史与审计保留' },
  { file: 'shangshu-web/js/real-users.js', line: 193, text: '本地兼容模式 · 账号存于 Node 用户表 · 平台模式下由内核身份权威接管' },
  { file: 'shangshu-web/js/real-website.js', line: 7, text: '官网提交的写操作在这里排队 · 通过即生效上线' },
  { file: 'shangshu-web/js/real-website.js', line: 50, text: '同源代理嵌入 · 门禁密钥不出服务端' },
  { file: 'shangshu-web/js/real-workspaces.js', line: 32, text: '按岗位选配模块集合（像装插件）· 工作流先后顺序 = 侧栏显示顺序 · 未实装模块收纳在模块库' },
];

/* ───────────────── 数据型副标题：3 条（一个字都不许动） ───────────────── */
/* 每条 = 「文件:行（改前）」＋ 现在该在的那句原文 ＋ 为什么必须留。 */
const KEEP = [
  { file: 'shangshu-web/js/mock-pages.js', line: 93, text: '张一诺 · 2026-08-01', why: '这一条帖子自己的事实：作者 · 日期' },
  { file: 'shangshu-web/js/real-doc.js', line: 51, text: '${esc(set.description || \'\')}', why: '这一套模板集自己的描述' },
  { file: 'shangshu-web/js/real-invoice.js', line: 126, text: '${x.invoice_code} ${x.invoice_no} · ${x.invoice_type}', why: '这一张发票自己的事实：单号 · 类型' },
];

/** 全站 `shangshu-web/js/` 下的 .js 文件（构建产物 `domains/excel-univer/` 不算源码）。 */
function jsFiles(dir = new URL('shangshu-web/js/', ROOT)) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) {
      if (fileURLToPath(full).includes('domains/excel-univer')) continue;
      out.push(...jsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(fileURLToPath(full));
    }
  }
  return out;
}

/** 从源码里取出某个页头条那一段（从标记到对应的 `</header>`）。 */
function headingBlock(source, marker) {
  const at = source.search(marker);
  if (at < 0) return null;
  const end = source.indexOf('</header>', at);
  return end < 0 ? null : source.slice(at, end);
}

/* ───────────────── ① 解释性副标题：47 条，一条都不许剩 ───────────────── */
for (const item of EXPLANATORY) {
  test(`① ${item.file}:${item.line} 的解释性副标题没了`, () => {
    const source = read(item.file);
    assert.ok(!source.includes(item.text),
      `${item.file}:${item.line} 还在写着这句解释：${item.text}`
      + ' ⇒ 页头条上不许再挂着「这个页面是干什么的」那种说明。');
  });
}

/* ───────────────── ② 数据型副标题：3 条，必须还在（不许过度删除） ───────────────── */
for (const item of KEEP) {
  test(`② ${item.file}:${item.line} 的数据型副标题还在`, () => {
    const source = read(item.file);
    assert.ok(source.includes(item.text),
      `${item.file}:${item.line} 的这句没了：${item.text}`
      + ` ⇒ 它装的是${item.why}，删掉就是把事实删了。`);
  });
}

/* ───────────────── ③ 全站 `<div class="sub">` 只剩那 3 处数据型的 ───────────────── */
test('③ 全站 JS 源码里的 `<div class="sub">` 只剩那 3 处数据型的（不许有新的解释性副标题混进来）', () => {
  const found = [];
  for (const file of jsFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const pattern = /<div class="sub">([\s\S]*?)<\/div>/g;
    let hit;
    while ((hit = pattern.exec(source))) {
      found.push({
        file: path.relative(ROOT_PATH, file),
        line: source.slice(0, hit.index).split('\n').length,
        text: hit[1],
      });
    }
  }
  assert.equal(found.length, KEEP.length,
    `全站还剩 ${found.length} 处「<div class="sub">」，应只剩 ${KEEP.length} 处（数据型的）：`
    + found.map(f => `${f.file}:${f.line} ${f.text}`).join(' ｜ '));
  for (const item of KEEP) {
    assert.ok(found.some(f => f.file === item.file && f.text === item.text),
      `${item.file} 的数据型副标题不见了：${item.text}`);
  }
});

/* ───────────────── ④ 审核中心：页头条那行解释（由 description 写进去的） ───────────────── */
test('④ 审核中心的页头条里那行解释说明没了（它原先是 element(「div」,「sub」,description) 写进去的）', () => {
  const source = read('shangshu-web/js/review-center.js');
  /* 断的是**那一行说明本身**（原封不动摘出来的整句）——
     注意别拿短句去断：这个文件顶头的说明注释里本来就写着「人核对后才落正式值」这几个字
     （那是**文件级**说明，不是页头条上的东西）⇒ 断整句才断得准。 */
  assert.ok(!source.includes('人核对后才落正式值。一份凭据一张卡，点开左边是要改的内容、右边是凭据。'),
    '审核中心页头条还在挂着「这一页是干什么的」那段说明 —— 那也是解释，要删。');
  assert.ok(!source.includes('opts.description'),
    '审核中心还留着「往页头条里塞一段说明」的那个口子（opts.description）—— 要一起去掉。');
  assert.ok(!/element\(\s*['"]div['"]\s*,\s*['"]sub['"]/.test(source),
    '审核中心还在往页头条里 append 一个「div.sub」—— 页头条不许挂解释性副标题。');
});

/* ───────────────── ⑤ 流程「待办」页：页头条里的解释性 `<p>` ───────────────── */
test('⑤ 流程「待办」页（real-flowdesign.js）页头条里那行解释性说明没了', () => {
  const source = read('shangshu-web/js/real-flowdesign.js');
  assert.ok(!source.includes('处理分配给我的事项，查看我发起的业务'),
    '流程「待办」页的页头条还在挂着「这一页是干什么的」那段说明 —— 要删。');
});

/* ───────────────── ⑥ 文件中心／邮件中心：页头条里没有解释性文字 ───────────────── */
test('⑥ 文件中心与邮件中心的页头条里没有解释性文字（这两页的页头条用的是 .file-heading / .mail-heading）', () => {
  for (const [file, marker] of [
    ['shangshu-web/js/file-center.js', /file-heading page-heading/],
    ['shangshu-web/js/mail-center.js', /mail-heading page-heading/],
  ]) {
    const block = headingBlock(read(file), marker);
    assert.ok(block, `${file} 里找不到页头条（${marker.source}）`);
    assert.ok(!/class="sub"/.test(block),
      `${file} 的页头条里又挂了一个 .sub —— 页头条不许挂解释性副标题。`);
    assert.ok(!/<p[\s>]/.test(block),
      `${file} 的页头条里还有一段说明文字（<p>）—— 页头条不许挂解释性副标题。`);
  }
});
