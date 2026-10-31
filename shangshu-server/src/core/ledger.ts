// 发票入账：往记账表 append-only 插入一条，返回新记录 id。
// 仅通过事务动作写入；历史记录不能修改，以关联红冲纠错。
import type { Invoice, StateStore } from './types.ts';

export interface AccountResult {
  posted: boolean;
  ledger_record_id?: string;
  reason?: string;
}

// 进项→对方=销方；出项→对方=购买方。
function counterpartyOf(inv: Invoice): string {
  return inv.invoice_direction === '进项' ? (inv.seller_name || '') : (inv.buyer_name || '');
}

export async function accountInvoiceToLedger(store: StateStore, inv: Invoice): Promise<AccountResult> {
  const counterparty = counterpartyOf(inv);
  const summary = `${inv.invoice_direction || ''}·${counterparty}`.replace(/^·|·$/g, '') || inv.invoice_no || '入账';
  // 金额强转 number（发票历史数据可能是字符串，写 number 列前必须转，否则 1254001 WrongRequestBody）
  const num = (v: any): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  };
  const record: Record<string, any> = { source_key: `invoice:${inv.id}${(inv as any).booking_cycle ? ':'+(inv as any).booking_cycle : ''}`, invoice_id: inv.id };
  const set = (k: string, v: any) => { if (v !== null && v !== undefined && v !== '') record[k] = v; };
  set('summary', summary);
  set('posted_at', new Date().toISOString());      // 入账日期 = 今天
  set('biz_date', inv.issued_at || '');             // 业务日期 = 开票日期（datetime 列由 store 层转换）
  set('direction', inv.invoice_direction);
  set('counterparty', counterparty);
  set('amount_ex_tax', num(inv.amount_ex_tax));
  set('tax_amount', num(inv.tax_amount));
  set('total_amount', num(inv.total_amount));
  set('invoice_no', inv.invoice_no);
  set('invoice_code', inv.invoice_code);
  set('maker', '尚书');

  try {
    const id = await store.insert('business', 'ledger', record);
    return { posted: true, ledger_record_id: id };
  } catch (e) {
    return { posted: false, reason: (e as Error).message };
  }
}
