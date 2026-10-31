/** One read scope per page: obsolete queries stop; writes never use this helper. */
export function createLatestRead(parentSignal) {
  let active = null;
  let disposed = false;
  const cancel = () => { active?.abort(); active = null; };
  const dispose = () => {
    disposed = true;
    cancel();
    parentSignal?.removeEventListener('abort', dispose);
  };
  if (parentSignal?.aborted) dispose();
  else parentSignal?.addEventListener('abort', dispose, {once: true});
  return {
    begin() {
      cancel();
      const controller = new AbortController();
      active = controller;
      if (disposed) controller.abort();
      return {signal: controller.signal, isCurrent: () => !disposed && active === controller && !controller.signal.aborted};
    },
    cancel,
    dispose,
  };
}
