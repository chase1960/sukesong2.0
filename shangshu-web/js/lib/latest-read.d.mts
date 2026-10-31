export interface ReadTicket {signal: AbortSignal; isCurrent(): boolean;}
export function createLatestRead(parentSignal?: AbortSignal): {
  begin(): ReadTicket;
  cancel(): void;
  dispose(): void;
};
