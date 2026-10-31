// PKG-018-T05 §8.2：**目标模型**（Qwen3.8-27B）12 条固定提示词的跑分脚本。
//
// 为什么单独一个脚本：提示词与判定是**固定集**（`pkg018-prompts.json`），
// 端点到位就能原样复跑；跑完出一张「逐条 PASS/FAIL/NOT_RUN」表 + 工具轮数 + 耗时。
//
// 用法（环境变量给齐）：
//   PKG018_BASE_URL   平台对话口（默认 http://127.0.0.1:3950）
//   PKG018_USER       登录用户名（默认 Administrator）
//   PKG018_PASSWORD   登录口令
//   PKG018_OBJECT_ID  受管对象 id（提示词里的 {{object_id}}）
//   PKG018_MODEL      目标模型标识（写进报告，便于核对实际用的模型）
//
// 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 端点/模型不可达（整组 NOT_RUN）。
// ⚠️ **不许**把 mock 或别的模型的通过当成目标模型已验 —— 报告里写明实际端点与模型。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, 'pkg018-prompts.json'), 'utf8'));
const base = (process.env.PKG018_BASE_URL || 'http://127.0.0.1:3950').replace(/\/$/, '');
const user = process.env.PKG018_USER || 'Administrator';
const password = process.env.PKG018_PASSWORD || '';
const objectId = process.env.PKG018_OBJECT_ID || '';
const model = process.env.PKG018_MODEL || '(未声明)';

async function login() {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  });
  if (!response.ok) throw new Error(`登录失败 HTTP ${response.status}`);
  // ⚠️ 平台的会话认的是 **shangshu_token** 这枚 cookie（不是 sid）⇒
  //   只取第一枚 cookie 会 401。**全部**带上。
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const jar = cookies.filter(Boolean).map(item => item.split(';')[0]).join('; ');
  if (!jar.includes('shangshu_token=')) throw new Error('登录没拿到平台会话 cookie（shangshu_token）');
  return jar;
}

/** 跑一条提示词：收 SSE 拼最终答复，并记工具轮数。
 *  ⚠️ 服务端的 SSE 形状是 `event: <类型>\ndata: <JSON>\n\n` ⇒
 *  **类型在 event 行、数据在 data 行**（只读 data 行会拿到没有 type 的裸 JSON）。
 */
async function ask(cookie, prompt, index) {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ message: prompt, conversation_id: `pkg018-eval-${index}` }),
  });
  if (!response.ok) throw new Error(`对话失败 HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', tools = 0, error = '', event = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event:')) { event = trimmed.slice(6).trim(); continue; }
      if (!trimmed.startsWith('data:')) continue;
      let payload;
      try { payload = JSON.parse(trimmed.slice(5).trim()); } catch { continue; }
      if (event === 'text') text += String(payload.delta || '');
      else if (event === 'tool') tools += 1;
      else if (event === 'error') error = String(payload.error || payload.message || '未知错误');
    }
  }
  if (error) throw new Error(error);
  return { text, tools };
}

/** 判定：must_match 任一不命中 ⇒ FAIL；must_not_match 任一命中 ⇒ FAIL。
 *  判据写成 `/.../` 时按**正则**匹配（用于「10 条」这种带空白的说法），否则按子串。 */
function matches(answer, criterion) {
  const text = String(criterion ?? '');
  if (text.startsWith('/') && text.lastIndexOf('/') > 0) {
    const body = text.slice(1, text.lastIndexOf('/'));
    return new RegExp(body, 'u').test(answer);
  }
  return answer.includes(text);
}

/** 一条判据可以是**字符串**（一个要求）或**字符串数组**（**任一**满足即可）⇒
 *  组与组之间是「全部都要」，组内是「任一」。（2026-10-22 修：原来把组内也当「全部」，
 *  同一个数字的两种写法（13450.5 / 13450.50）永远不可能同时命中 ⇒ 假失败。） */
function groupMatches(answer, group) {
  const items = Array.isArray(group) ? group : [group];
  return items.some(item => matches(answer, item));
}

function judge(prompt, answer) {
  if (!answer.trim()) return { ok: false, reason: '没有收到回答' };
  const missing = (prompt.must_match || []).filter(group => !groupMatches(answer, group));
  const leaked = (prompt.must_not_match || []).filter(group => groupMatches(answer, group));
  if (missing.length || leaked.length) {
    const parts = [];
    if (missing.length) parts.push(`缺:${missing.join('、')}`);
    if (leaked.length) parts.push(`不该出现:${leaked.join('、')}`);
    return { ok: false, reason: parts.join('；') };
  }
  return { ok: true, reason: '' };
}

async function main() {
  if (!objectId) {
    console.error('缺少 PKG018_OBJECT_ID（受管对象 id）——没有数据就没有可判的提示词。');
    process.exit(2);
  }
  let cookie;
  try {
    cookie = await login();
  } catch (error) {
    console.error(`端点不可达：${error.message}（base=${base}）`);
    process.exit(2);
  }
  const results = [];
  for (const [index, item] of spec.prompts.entries()) {
    const prompt = item.prompt.replaceAll('{{object_id}}', objectId);
    const started = Date.now();
    try {
      const { text, tools } = await ask(cookie, prompt, index);
      const verdict = judge(item, text);
      results.push({ no: item.no, covers: item.covers, status: verdict.ok ? 'PASS' : 'FAIL',
        reason: verdict.reason, tools, ms: Date.now() - started, answer: text });
    } catch (error) {
      results.push({ no: item.no, covers: item.covers, status: 'NOT_RUN', reason: error.message,
        tools: 0, ms: Date.now() - started, answer: '' });
    }
  }
  console.log(`目标模型：${model}｜端点：${base}｜对象：${objectId}`);
  for (const row of results) {
    console.log(`${row.no} (${row.covers}) ${row.status.padEnd(8)} 工具${String(row.tools).padStart(2)}次 ${String(row.ms).padStart(6)}ms ${row.reason || ''}`);
  }
  const passed = results.filter(row => row.status === 'PASS').length;
  const failed = results.filter(row => row.status === 'FAIL').length;
  const notRun = results.filter(row => row.status === 'NOT_RUN').length;
  console.log(`合计：PASS ${passed} / FAIL ${failed} / NOT_RUN ${notRun}（共 ${results.length}）`);
  if (notRun === results.length) process.exit(2);
  process.exit(failed ? 1 : 0);
}

main();
