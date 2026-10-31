/** Stored cards are references, not a permission grant to replay old business payloads. */
export function projectHistoryCards(raw: any) {
  if (!raw || typeof raw !== 'object') return null;
  const proposals = Array.isArray(raw.proposals) ? raw.proposals.filter((p: any) => typeof p?.id === 'string' && p.id.length <= 200).map((p: any) => ({ id: p.id })) : [];
  const ids = new Set(proposals.map((p: any) => p.id));
  const tools = Array.isArray(raw.tools) ? raw.tools.map((t: any) => ({
    ok: t?.ok === true ? true : t?.ok === false ? false : null,
    // Only a current-authorized proposal can restore the concrete tool identity.
    ...(typeof t?.receipt_id === 'string' && ids.has(t.receipt_id) ? { proposal_id: t.receipt_id } : {}),
    ...(['withdrawn','partial','rejected_conflict'].includes(t?.undo_state) ? { undo_state: t.undo_state } : {}),
  })) : [];
  const status = raw.status && typeof raw.status === 'object' ? {
    kind: 'history_status',
    error_count: Array.isArray(raw.status.errors) ? raw.status.errors.length : 0,
    empty_count: Array.isArray(raw.status.empty_attempts) ? raw.status.empty_attempts.length : 0,
    unsupported_claim_count: Array.isArray(raw.status.no_receipt_claims) ? raw.status.no_receipt_claims.length : 0,
    auto_retried: raw.status.auto_retried === true,
  } : null;
  return { proposals, tools, status };
}
