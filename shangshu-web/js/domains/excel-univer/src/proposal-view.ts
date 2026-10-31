export type Proposal = Record<string, any>;
export function proposalCells(proposal: Proposal): Array<{ rowId: string; header: string; value: any }> {
  const payload = proposal.payload || {};
  const cells = Array.isArray(payload.cells) ? payload.cells : payload.row_id && payload.header
    ? [{ row_id: payload.row_id, header: payload.header, value: payload.value }] : [];
  return cells.filter((cell: any) => cell && cell.row_id && cell.header).map((cell: any) => ({
    rowId: String(cell.row_id), header: String(cell.header), value: cell.value,
  }));
}
export function proposalValueText(value: any): string {
  const raw = value && typeof value === 'object' && 'type' in value ? value.value : value;
  if (raw === null || raw === undefined) return '';
  return typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
}
export function editedProposalValue(proposal: Proposal, text: string): { type: string; value: any } | undefined {
  const payload = proposal.payload || {};
  const original = payload.value ?? (Array.isArray(payload.cells) && payload.cells.length === 1 ? payload.cells[0].value : undefined);
  if (original === undefined) throw new Error('该提案不是单值改写，请逐项核对后确认整包');
  if (text === proposalValueText(original)) return undefined; // Do not turn unchanged dates/numbers into text.
  const type = original && typeof original === 'object' ? original.type : typeof original === 'number' ? 'number' : 'text';
  if (type === 'number') {
    if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('建议值必须是有效数字');
    if (/^[-+]?0\d/.test(text.trim())) throw new Error('带前导零的编号不能转成数值');
    const significant = text.replace(/[-+.eE]/g, '').replace(/^0+/, '');
    if (significant.length > 15) throw new Error('数值超过安全精度，请保留为文本');
    return { type, value: Number(text) };
  }
  if (type === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new Error('布尔建议值只接受 true 或 false');
    return { type, value: text === 'true' };
  }
  if (type === 'null') throw new Error('空值提案无法在这里改成另一类型，请重新提议');
  return { type, value: text };
}
