// 判据工具：算「提交时这个文件算内核、领域还是文档」—— 照 `fde-commit-policy.json`。
//
// **为什么**（2026-10-25 07:5x，PKG-105 收尾时查出来的）：
// `fde-commit-policy.json`（仓库根那份 ＋ 外层那份）是 CLAUDE.md §十 指定的**提交分类尺子**，
// 插件那个提交闸（`check_fde_commit.py`）就是照它判的。实跑那条判定逻辑发现：
//   **全仓 3134 个被跟踪文件里有 290 个在尺子上查不到归属** —— 其中 68 个是公共壳
//   （`shangshu-web/js/*.js`、`shangshu-web/js/tests/**`、`shangshu-web/css/*.css`……），
//   正是这几个月改得最多的那批；而那个闸**根本没装**（仓库 hooks 目录里只有 *.sample）。
// ⇒ 这一份把尺子补齐，并让「有没有漏」变成机器能断的事。
//
// **规则必须与插件那个检查器一模一样**（以 / 结尾按前缀匹配，其余按精确文件匹配）：
// 判据第 ⑤ 条拿插件的真代码逐文件比对，不许两边各写各的。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 三档，顺序与插件那个检查器一致。 */
export const GROUPS = ["core", "special", "docs"];

/** 与插件 `check_fde_commit.py` 同一套规则：以 / 结尾按前缀匹配，其余精确匹配。 */
export function matchesGroup(file, paths) {
  return paths.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

/** 这个文件落在哪几档：正常必须恰好一档；零档＝尺子上查不到，多档＝两处都收了。 */
export function classify(file, policy) {
  return GROUPS.filter((group) => matchesGroup(file, policy[`${group}_paths`] ?? []));
}

export function loadPolicy(base = root) {
  return JSON.parse(readFileSync(resolve(base, "fde-commit-policy.json"), "utf8"));
}

/** 仓里被跟踪的文件（`-z` 不转义中文名 ⇒ 路径逐字对得上）。 */
export function trackedFiles(base = root) {
  const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
    cwd: base,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

/**
 * 公共壳：CLAUDE.md §十 那一档 —— `shangshu-web/js/*.js` 与 `css/*.css`（domains 之外）
 * ＋ 入口页 ＋ 判据目录 `shangshu-web/js/tests/`。
 */
export function isPublicShell(file) {
  if (file === "shangshu-web/index.html") return true;
  if (!/^shangshu-web\/(?:js|css)\//.test(file)) return false;
  return !file.includes("/domains/");
}

/** 行业域自己的代码 —— 该走专属那一档，不是内核。 */
export const DOMAIN_PREFIXES = [
  "shangshu-web/js/domains/",
  "shangshu-web/css/domains/",
  "shangshu-server/src/domains/",
];

export function isDomain(file) {
  return DOMAIN_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/** 尺子体检：查不到的（missing）与两档都收的（conflict）。 */
export function audit(base = root, policy = loadPolicy(base)) {
  const missing = [];
  const conflict = [];
  for (const file of trackedFiles(base)) {
    const hits = classify(file, policy);
    if (hits.length === 0) missing.push(file);
    else if (hits.length > 1) conflict.push({ file, hits });
  }
  return { missing, conflict };
}

function main() {
  const { missing, conflict } = audit();
  for (const file of missing) console.log(`查不到归属：${file}`);
  for (const { file, hits } of conflict) console.log(`两档都收：${file} ⇒ ${hits.join("/")}`);
  console.log(`查不到 ${missing.length} 个 · 两档都收 ${conflict.length} 个`);
  if (missing.length || conflict.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
