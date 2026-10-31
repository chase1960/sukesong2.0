/**
 * Excel 页**打不开表**时，把失败翻译成**人话**（2026-10-21）。
 *
 * 改前：boot() 的 catch 只把服务端那句**英文**塞进一行小字
 * （例：`打开失败：Shangshu File Center File xxx not found`），
 * 下面就是一大片空白网格 —— 用户看不出是「表没了」「没权限」「断网」还是「服务器坏了」。
 *
 * 改后：页面上给一个**说清原因的面板**（标题 + 原因 + 下一步 + 两个出口：
 * 「重试」「返回表格清单」），**不许再给一片空白**。
 *
 * ⚠️ **2026-10-24 订正**：那个大面板**已经撤掉**了（用户站上说「这个是不是太窄了，
 * 干脆放到 toast 里面去」）⇒ 现在页面上是 **toast + 页头标题 + 底部一行状态**。
 * ⇒ **下面这些「下一步」文案里提到「点重试」「回清单」的说法要跟着改**
 *   （页面上确实没有「重试」按钮了；回到清单的口子是页头的「返回列表」按钮）。
 *   —— 旧文案保留在下面的注释里，方便查回同一条。
 *
 * ⚠️ **只解释、不改语义**：失败的原因判定按服务端的 status/code 原样映射，
 * 这里只负责**翻译成人话**；没有依据的失败一律落到兜底文案，不编原因。
 */

/** 一次「打不开」的解释。 */
export interface OpenFailure {
  /** 面板标题（一句话）。 */
  title: string;
  /** 原因（人话）。 */
  reason: string;
  /** 下一步（人话）。 */
  hint: string;
  /** 能不能直接重试（网络/服务端 ⇒ 能；表没了/没权限 ⇒ 重试没用）。 */
  retryable: boolean;
  /** 服务端原话（**已剥 HTML 标签**；面板上不显示英文，只进控制台）。 */
  detail: string;
  /** 服务端的排查编号（trace id）—— 面板上给用户复制用。 */
  traceId?: string;
}

interface ErrorLike {
  message?: string;
  status?: number;
  code?: string;
  /** 服务端的排查编号（trace id）—— 页面上给用户复制用。 */
  traceId?: string;
}

/**
 * 剥掉服务端消息里的 **HTML 标签**。
 *
 * 为什么（2026-10-21 用户实测）：服务端的报错里带 `<br><strong>…</strong>`，
 * 原样打到页面上就是一串尖括号 —— 看着像坏掉了。
 * ⇒ 任何**要给人看**的原文都先过这一道；控制台那份保留原样（排障要真话）。
 */
export function stripHtml(text: string): string {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function readError(error: unknown): ErrorLike {
  if (!error) return {};
  const candidate = error as ErrorLike;
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const status = typeof candidate.status === 'number' ? candidate.status : 0;
  const traceId = typeof candidate.traceId === 'string' ? candidate.traceId : '';
  return { message, code, status, traceId };
}

/**
 * 把一次开表失败翻译成人话。
 *
 * 映射（按服务端给的 status / code，**不猜**）：
 *  · 404 / NOT_FOUND ⇒ 找不到这张表；
 *  · 403 / FORBIDDEN ⇒ 没有权限；
 *  · 401 ⇒ 登录过期；
 *  · 0 / NETWORK ⇒ 网络没通；
 *  · 5xx ⇒ 服务端出错；
 *  · 内容解析类（CONTENT / PARSE / CORRUPT）⇒ 文件在但内容读不出来；
 *  · 其它 ⇒ 兜底「打不开这张表」，并把服务端原话留在 detail 里。
 */
export function explainOpenFailure(error: unknown): OpenFailure {
  const { message = '', code = '', status = 0, traceId = '' } = readError(error);
  const upper = code.toUpperCase();
  /* detail 是**给人看**的那一份 ⇒ 先剥 HTML 标签；控制台另有原话。 */
  const detail = stripHtml(message);
  const trace = traceId || undefined;

  /* 回收站那一支（2026-10-24 12:2x 补回）。
   *
   * 旧版 `describeOpenFailure` 有这一支（`/回收站|Recycled/i`）；
   * 2026-10-21 改成**纯 status/code 映射**时被**漏掉了** ——
   * 而后端**确实**在说这件事（文件域 `table_analysis.py:156` 抛「该表在回收站，恢复后才能读取」，
   * `promotion.py:406` 抛「该文件在回收站，恢复后才能下载」）
   * ⇒ 表在回收站时页面却显示「没有打开这张表的权限」⇒ **说错了原因**
   *   （人会去找管理员要权限，要不到；真正要做的是**恢复**）。
   * ⇒ 这一支必须排在 403 那一支**前面** —— 它也是 403。 */
  if (/回收站|Recycled/i.test(message)) {
    return {
      title: '这张表在回收站',
      reason: '这张表在回收站，恢复之后才能读取。',
      hint: '请在文件中心把它恢复（或让管理员恢复），再回来打开。',
      retryable: false,
      traceId: trace,
      detail,
    };
  }

  if (upper.includes('NOT_FOUND') || status === 404) {
    return {
      title: '找不到这张表',
      reason: '这张表已经不在了，或者链接里的编号不对 —— 也可能表刚被删掉或改了名。',
      /* 旧文案（面板还在时）：「回到表格清单重新挑一张；要是你确定它该在，请找管理员确认有没有被停用。」 */
      hint: '点页头的「返回列表」重新挑一张；要是你确定它该在，请找管理员确认有没有被停用。',
      retryable: false,
      traceId: trace,
      detail,
    };
  }
  if (upper.includes('FORBIDDEN') || status === 403) {
    return {
      title: '没有打开这张表的权限',
      reason: '你现在的身份看不到这张表的内容。',
      hint: '请让管理员给你开通这张表的权限；开通后刷新就能打开。',
      retryable: false,
      traceId: trace,
      detail,
    };
  }
  if (status === 401) {
    return {
      title: '登录已过期',
      reason: '登录状态已经失效，所以读不到这张表。',
      hint: '重新登录一次，然后再打开这张表。',
      retryable: true,
      traceId: trace,
      detail,
    };
  }
  if (upper.includes('NETWORK') || status === 0) {
    return {
      title: '网络没通',
      reason: '请求没能送到服务器 —— 可能是断网了，也可能是服务在重启。',
      /* 旧文案（面板还在时）：「检查网络后点「重试」；网络正常还不行，就等服务恢复。」 */
      hint: '检查网络后刷新页面再打开；网络正常还不行，就等服务恢复。',
      retryable: true,
      traceId: trace,
      detail,
    };
  }
  if (/CONTENT|PARSE|CORRUPT|DECODE/i.test(upper) || /corrupt|损坏|解析/i.test(message)) {
    return {
      title: '这张表的内容读不出来',
      reason: '文件在，但内容没能解析出来 —— 可能是文件损坏了，或者它本来就不是表格文件。',
      hint: '换一份文件再试；要确认这份文件是否损坏，请下载原件打开看看。',
      retryable: false,
      traceId: trace,
      detail,
    };
  }
  if (status >= 500) {
    return {
      title: '服务器出错了',
      reason: '服务端在读这张表的时候出了错，这张表现在打不开。',
      /* 旧文案（面板还在时）：「稍后点「重试」；一直不行请联系管理员，并把这张表的编号一起给他。」 */
      hint: '稍后刷新页面再打开；一直不行请联系管理员，并把这张表的编号一起给他。',
      retryable: true,
      traceId: trace,
      detail,
    };
  }
  return {
    title: '打不开这张表',
    reason: '没能把这张表的内容读出来。',
    /* 旧文案（面板还在时）：「可以点「重试」再试一次；一直不行就回清单换一张，或联系管理员。」 */
    hint: '可以刷新页面再打开一次；一直不行就点页头的「返回列表」换一张，或联系管理员。',
    retryable: true,
    traceId: trace,
    detail,
  };
}
