import {it} from 'node:test';
import assert from 'node:assert/strict';
import {relationErrorText, relationTargetChoices} from '../../../shangshu-web/js/domains/excel-univer/src/table-relations.ts';

// —— FIX-17：目标表下拉只列「当前身份可访问、且真能当关联目标」的表 ——
// 测试通过 = 什么成立：业务对象（库存/订单/发票/我的邮件…这类 db 表）**不进下拉**——
// 它们既没有关联目标工作簿，也常常读不了，列出来只会让用户点进去撞权限错误；
// 只有 Excel 表格（xlsx）才是合法的关联目标。
it('FIX-17 关联目标下拉只列 Excel 表格，不列业务对象', () => {
  const entries = [
    {key: 'file-1', title: '我的表', kind: 'xlsx'},
    {key: 'warehouse.stock', title: '现存库存', kind: 'db'},
    {key: 'sales.order', title: '订单', kind: 'db'},
    {key: 'mail.thread', title: '我的邮件', kind: 'db'},
    {key: 'file-2', title: '部门表', kind: 'xlsx'},
  ];
  const choices = relationTargetChoices(entries as any);
  assert.deepEqual(choices.map(item => item.id), ['file-1', 'file-2'], '只留 xlsx');
  assert.equal(choices.find(item => item.id === 'file-1')?.label, '我的表');
});

// —— FIX-17：英文内部错误不外露 ——
// 测试通过 = 什么成立：服务端那条英文权限错误
// 「User ... does not have doctype access via role permission for document ...」
// 在界面上变成一句中文业务提示；已经是中文的提示原样保留。
it('FIX-17 英文内部错误翻成中文业务提示', () => {
  const english = 'User trial-jia@trial.invalid does not have doctype access via role permission for document Shangshu Stock Item';
  const text = relationErrorText(english);
  assert.doesNotMatch(text, /doctype access via role permission/i, '英文内部错误不许外露');
  assert.match(text, /权限/, '要说明是权限问题');
  assert.match(text, /[一-龥]/, '提示必须是中文');
  // 已是中文的提示原样保留
  assert.equal(relationErrorText('请使用空白列配置关联，不能覆盖已有值'), '请使用空白列配置关联，不能覆盖已有值');
  // 「目标工作簿没配置」也是内部英文，改成中文
  assert.match(relationErrorText('Target workbook is not configured'), /工作簿/);
});
