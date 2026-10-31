// skill.invoice-collect：collect → extract → file，逐封处理。
// 这是「顺序执行」（spec §5.5），无 LLM 决策、无评审阻塞；待审→已入库由人在 web 审核页完成。
import { registerSkill } from '../core/runner.ts';
import { getCapability } from '../core/registry.ts';
import { runWorkflow } from '../core/workflow-engine.ts';
import { getDocType } from '../core/doctypes.ts';
import type { RunSummary } from '../core/runner.ts';

export function registerInvoiceSkill() {
  registerSkill({
    id: 'skill.invoice-collect',
    async run(ctx, params): Promise<RunSummary> {
      const mailbox = params?.mailbox || ctx.config.poll.mailbox;
      const doctypeId=String(params?.doctype || 'invoice_cn_vat');
      const doctype=getDocType(doctypeId);
      if(!doctype) throw new Error(`单据模板未发布: ${doctypeId}`);
      const { collected } = await getCapability('invoice.collect').run({ mailbox }, ctx);
      const del = !!ctx.config.mail.delete_after_read;
      let added = 0, duplicate = 0, failed = 0;
      // 按消息分组：多附件邮件要等所有附件处理完且全部成功，才删整封（删早了会丢剩余附件）。
      const msgKey = (mid: string) => (mid.includes('::') ? mid.split('::')[0] : mid);
      const msgOk = new Map<string, boolean>();
      for (const item of collected) {
        const k = msgKey(item.mail_id);
        if (!msgOk.has(k)) msgOk.set(k, true);
        try {
          const r = await runWorkflow(ctx.store, doctype.intakeFlowId, {
            file_token: item.file_token,
            doctype: doctypeId,
            item,
            initiator: 'trigger',
          }, ctx, { initiator: 'trigger' });
          const fileResult = r.result || {};
          if (fileResult.status === 'duplicate') duplicate++;
          else if (fileResult.status === 'added') added++;
        } catch (e) {
          failed++;
          msgOk.set(k, false); // 该消息有失败 → 不收尾，留下次重试
          ctx.log(`✘ 处理失败 ${item.filename}：${(e as Error).message}`);
        }
      }
      // 整封邮件所有附件处理完后，按 mid 级别统一收尾：
      //  - delete_after_read：全部成功才删整封（删早了/部分失败会丢剩余附件）。
      //  - 否则：全部成功才 markRead（按 mid 记去重表）。
      //    注意：不能在循环内逐附件 markRead —— markRead 会把整封 mid 拉黑，若附件#1 处理成功后
      //    就 markRead(mid)，附件#2 失败时整封已被跳过 → 附件#2 静默丢失。失败的整封不 markRead，
      //    下次重试；已入库的附件由 invoice 去重跳过，不会重复入库。
      for (const [k, ok] of msgOk) {
        if (!ok) continue;
        try {
          if (del) { await ctx.external.mail.deleteMail(k); ctx.log(`🗑 已清理邮件 ${k}`); }
          else { await ctx.external.mail.markRead(k); }
        } catch (e) { ctx.log(`⚠ 收尾失败 ${k}：${(e as Error).message}`); }
      }
      return { collected: collected.length, added, duplicate, failed };
    },
  });
}
