/**
 * 从 TS 源码里按名字抽函数（测试用）。
 *
 * 为什么抽出来：判据里要看「生产代码到底怎么写的」时，
 * 抄一份抽取逻辑就会多一份漂移。**公共工具只留一份**。
 *
 * 用法：`const code = ts.transpileModule(functionSource(src, 'editFormula'), ...)`
 */
import ts from 'typescript';

/** 抽出名叫 name 的函数声明原文（找不到就抛错，不静默返回空串）。 */
export function functionSource(source: string, name: string): string {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  let found = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error(`源码里找不到函数 ${name}`);
  return found;
}
