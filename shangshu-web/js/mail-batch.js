/* 邮件批量回收的协调层。权限、版本和幂等仍由注入的现有 action 入口处理。 */
(function (global) {
  'use strict';

  const reasonOf = error => typeof error?.message === 'string' && error.message
    ? error.message : '操作回执无法核实，请刷新核对后重试';
  const validReceipt = (id, result) => result && result.name === id && result.status === 'Trash'
    && Number.isInteger(result.record_version) && result.record_version > 0;

  /**
   * ids 是本次选择的快照；invoke(id, validateReceipt) 返回现有 mail.recycle 的完整回执。
   * validateReceipt 传入现 action 的第三参数，坏回包不会提前删除幂等键。
   * invoke 必须保留未知请求的原载荷和幂等键，不通过重新造请求来“重试”。
   * onProgress 只消费状态；视图异常不改变已经拿到的动作结果。
   */
  global.runMailBatch = async function ({ids, invoke, onProgress} = {}) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('请选择有效的邮件编号');
    }
    if (typeof invoke !== 'function') throw new Error('邮件操作入口不可用');
    const selected = [...new Set(ids)], settled = [], progressErrors = [];
    function snapshot() {
      const group = kind => settled.filter(item => item.kind === kind)
        .map(({kind: ignored, ...item}) => ({...item}));
      const success = group('success'), failed = group('failed'), unknown = group('unknown');
      const completed = settled.length;
      const allSucceeded = selected.length > 0 && completed === selected.length
        && success.length === selected.length;
      return {
        success, failed, unknown,
        retryIds: settled.filter(item => item.kind !== 'success').map(item => item.id),
        counts: {total: selected.length, success: success.length, failed: failed.length, unknown: unknown.length},
        completed, pending: selected.length - completed, allSucceeded,
        status: !selected.length ? 'empty' : completed < selected.length ? 'running'
          : allSucceeded ? 'all_succeeded' : success.length ? 'partial' : 'none_succeeded',
        progressErrors: progressErrors.map(item => ({...item})),
      };
    }
    for (const id of selected) {
      try {
        const result = await invoke(id, receipt => validReceipt(id, receipt));
        if (!validReceipt(id, result)) {
          settled.push({id, kind: 'unknown', reason: '回收回执不完整，请刷新核对后重试'});
        } else {
          settled.push({id, kind: 'success', result});
        }
      } catch (error) {
        settled.push({id, kind: error?.uncertain === false ? 'failed' : 'unknown', reason: reasonOf(error)});
      }
      if (typeof onProgress === 'function') {
        try { await onProgress(snapshot()); }
        catch (error) { progressErrors.push({id, reason: reasonOf(error)}); }
      }
    }
    return snapshot();
  };
})(globalThis);
