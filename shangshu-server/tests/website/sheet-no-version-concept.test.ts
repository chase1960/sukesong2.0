import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * **表格没有「版本」，只有多张表**（FIX-46）——
 * 用户 2026-10-20 13:38 原话：「**这个 excel 以后会有版本的说法吗？不是只有多种表格吗？**」
 *
 * 产品规则（后端 `frappe_apps/shangshu_files/shangshu_files/service.py` 的 `upload()` 里钉着）：
 *   · **普通文件**（docx/pdf/png…）同目录同名重传 ⇒ `_append_version` ⇒ **新增版本，保留旧版**
 *   · **表格（.xlsx）**同名上传 ⇒ `_unique_sheet_name` ⇒ **恒为新表**：
 *     「不追旧版本、不接回原表、不继承绑定（Excel 交互契约 §2）」
 *
 * 也就是说：**表格 ⇒ 多张表，没有版本**；**普通文件 ⇒ 有版本**。
 *
 * 改之前：邮件中心的**示例文件库**（`mail-center.js` 的 `lib`）里，
 * 那个 xlsx 被写成有「当前版本 · 2026-09-18」「历史版本 · 2026-09-02」
 * —— **把普通文件的版本概念套到了表格上**，与后端口径相反。
 *
 * 测试通过 = 下面全部成立：
 *  1. 示例文件库里**表格不列版本**（只列当前这一个）
 *  2. 示例文件库里**普通文件仍然列版本**（版本是它们的正经概念）
 *  3. 界面上不出现「同一文件可选不同版本」这种**把版本说成通用能力**的话
 *  4. **护栏**：后端那条「表格同名上传恒为新表」的规则**一个字没动**
 */

const MAIL = readFileSync(new URL('../../../shangshu-web/js/mail-center.js', import.meta.url), 'utf8');
const SERVICE = readFileSync(
  new URL('../../../frappe_apps/shangshu_files/shangshu_files/service.py', import.meta.url), 'utf8');

/** 从示例文件库那几行里取出 {id, name, versions} */
function libEntries(): { id: string; name: string; versions: { v: string }[] }[] {
  const out: { id: string; name: string; versions: { v: string }[] }[] = [];
  const re = /\{id:\s*'(L\d+)',\s*name:\s*'([^']+)',\s*size:\s*\d+,\s*versions:\s*\[([^\]]*)\]\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(MAIL))) {
    const versions = [...m[3].matchAll(/v:\s*'([^']+)'/g)].map(x => ({ v: x[1] }));
    out.push({ id: m[1], name: m[2], versions });
  }
  return out;
}

it('示例文件库：表格不列版本（表格是「多张表」，不是「一张表的多个版本」）', () => {
  const entries = libEntries();
  assert.ok(entries.length >= 4, `示例文件库应当至少有 4 条，实际 ${entries.length}`);
  for (const entry of entries) {
    if (!/\.xlsx$/i.test(entry.name)) continue;
    assert.equal(entry.versions.length, 1,
      `表格「${entry.name}」列了 ${entry.versions.length} 个版本 —— `
      + `表格同名上传**恒为新表**（Excel 交互契约 §2），表格没有版本这回事`);
    assert.doesNotMatch(entry.versions[0]?.v || '', /历史版本/,
      `表格「${entry.name}」不该出现「历史版本」`);
  }
});

it('示例文件库：普通文件仍然列版本（版本是它们的正经概念）', () => {
  const entries = libEntries();
  const ordinary = entries.filter(e => !/\.xlsx$/i.test(e.name));
  assert.ok(ordinary.length >= 1, '示例文件库应当有普通文件');
  for (const entry of ordinary) {
    assert.ok(entry.versions.length >= 1, `普通文件「${entry.name}」没有版本了`);
  }
  /* 至少一个普通文件要有「历史版本」，让示例仍能演示选版本这件事 */
  assert.ok(ordinary.some(e => e.versions.some(v => /历史版本/.test(v.v))),
    '普通文件里应当有一个带「历史版本」的示例');
});

it('界面话术：不说「同一文件可选不同版本」这种把版本说成通用能力的话', () => {
  assert.doesNotMatch(MAIL, /同一文件可选不同版本/,
    '界面提示还把「版本」说成通用能力 —— 表格没有版本');
});

it('护栏：后端「表格同名上传恒为新表」的规则一个字没动', () => {
  assert.match(SERVICE, /表格资源同名上传恒为新表/,
    '后端那条「表格同名上传恒为新表」的规则不见了 —— 那是版本口径的源头');
  assert.match(SERVICE, /_unique_sheet_name/,
    '后端不再给同名表格改名（新表口径失效了）');
  assert.match(SERVICE, /普通文件同目录同名重传[\s\S]*?_append_version/,
    '普通文件同名重传新增版本的那条规则不见了');
});
