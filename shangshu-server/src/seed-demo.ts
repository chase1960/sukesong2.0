// 演示种子（2026-08-17）：造一张「已入库·进项」发票，供最小闭环演示的 AI 入账那一步直接开跑。
// 为什么需要它：正常链路第一步靠邮箱/上传 + OCR；本机 OCR 或邮箱不通时演示就卡在起点。
// 这里只补起点数据，且照常写 invoice.ingest 事件——责任链从收票起就是完整的，不是凭空一条记录。
// 幂等：同一发票号已存在就跳过。数据带 review_note「演示数据」，一眼能认出不是真票。
import { getRuntimeStore } from './core/store.ts';
import { appendEvent } from './core/events.ts';

const DEMO = {
  invoice_code: '3100241130',
  invoice_no: 'DEMO-20260817',
  invoice_type: '专票',
  invoice_direction: '进项',
  seller_name: '云腾五金工具有限公司',
  buyer_name: '尚书科技（演示）',
  amount_ex_tax: 8407.08,
  tax_amount: 1092.92,
  total_amount: 9500,
  issued_at: new Date().toISOString().slice(0, 10),
  check_code: '',
};

const store = getRuntimeStore();
const exist = await store.query('business', 'invoices', { invoice_no: DEMO.invoice_no });
if (exist.length) {
  const cur = exist[0] as any;
  console.log(`✓ 演示发票已存在：${DEMO.invoice_no}（当前状态 ${cur.status}）`);
  if (cur.status === '已入账') console.log('  已入账过一次，要重演 AI 入账请换发票号或清 data/store.json');
  process.exit(0);
}

const now = new Date().toISOString();
const id = await store.insert('business', 'invoices', {
  ...DEMO,
  status: '已入库',
  source: 'demo',
  sender_email: 'demo@example.com',
  email_subject: '【演示】11 月五金采购发票',
  received_at: now,
  file_token: '',
  confidence: 0.86,
  validation_warnings: {},
  reviewer: '管理员',
  reviewed_at: now,
  review_note: '演示数据',
  ledger_record_id: null,
  created_at: now,
  updated_at: now,
});
await appendEvent(store, {
  capability: 'invoice.ingest',
  entity_type: 'invoice', entity_id: id,
  payload: { invoice_no: DEMO.invoice_no, amount: DEMO.total_amount, confidence: 0.86, source: 'demo' },
  initiator: 'trigger',
  status: 'confirmed',
});
console.log(`✓ 演示发票已就绪：${DEMO.seller_name} ${DEMO.invoice_no} ¥${DEMO.total_amount}（已入库·进项，id=${id}）`);
console.log('  演示走法：发票审核 →「已入库」tab 点开它 → 右侧对话说「把这张发票入账」→ 同意确认卡。');
