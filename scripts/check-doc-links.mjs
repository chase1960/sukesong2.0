import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const allowedDocsRootMarkdown = new Set(["docs/README.md", "docs/当前方向.md"]);
const requiredProjectDocs = ["README.md", "项目总览.md", "长期路线.md", "当前进展.md"];
const allowedProjectRootMarkdown = new Set([...requiredProjectDocs, "AGENTS.md"]);
const errors = [];

function trackedMarkdownFiles() {
  const output = execFileSync(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"],
    { cwd: root, encoding: "utf8" },
  );
  return [...new Set(output.split("\0").filter(Boolean))].filter((file) => existsSync(join(root, file)));
}

function markdownTargets(source) {
  const targets = [];
  const pattern = /(?<![A-Za-z0-9_$])!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of source.matchAll(pattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    } else {
      target = target.split(/\s+["']/)[0];
    }
    targets.push(target);
  }
  return targets;
}

function ignoredTarget(target) {
  return (
    !target ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(target)
  );
}

const files = trackedMarkdownFiles();
for (const required of requiredProjectDocs) {
  if (!files.includes(required)) errors.push(`${required}: 缺少根目录项目说明`);
}
for (const file of files) {
  if (dirname(file) === "." && !allowedProjectRootMarkdown.has(file)) {
    errors.push(`${file}: 根目录只保留 README、三份项目说明与 AGENTS；其他文档请归入 docs`);
  }
  if (dirname(file) === "docs" && !allowedDocsRootMarkdown.has(file)) {
    errors.push(`${file}: docs 根目录只允许 README.md 与 当前方向.md`);
  }

  const source = readFileSync(join(root, file), "utf8");

  for (const rawTarget of markdownTargets(source)) {
    if (ignoredTarget(rawTarget)) continue;
    let target;
    try {
      target = decodeURI(rawTarget.split("#", 1)[0].split("?", 1)[0]);
    } catch {
      errors.push(`${file}: 链接包含无效 URL 编码 ${rawTarget}`);
      continue;
    }
    const absolute = normalize(resolve(root, dirname(file), target));
    if (!absolute.startsWith(`${root}/`) && absolute !== root) {
      errors.push(`${file}: 链接越出仓库 ${rawTarget}`);
      continue;
    }
    if (!existsSync(absolute)) {
      errors.push(`${file}: 链接目标不存在 ${rawTarget}`);
      continue;
    }
    if (rawTarget.endsWith("/") && !statSync(absolute).isDirectory()) {
      errors.push(`${file}: 目录链接实际不是目录 ${rawTarget}`);
    }
  }
}

const docsRootMarkdown = files.filter(
  (file) => dirname(file) === "docs" && extname(file) === ".md",
);
for (const required of allowedDocsRootMarkdown) {
  if (!docsRootMarkdown.includes(required)) {
    errors.push(`${required}: 缺少必需的文档入口`);
  }
}

if (errors.length > 0) {
  console.error(`文档检查失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `文档检查通过：${files.length} 份 Markdown；docs 根目录 ${docsRootMarkdown.length}/2；本地链接有效。`,
);
