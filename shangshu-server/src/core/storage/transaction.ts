import type { StateStore } from '../types.ts';
export function atomic<T>(store: StateStore, fn: (tx: StateStore) => Promise<T>): Promise<T> {
  if (!store.guarantees?.transactions || !store.transaction) {
    throw new Error('当前存储不支持原子业务提交；请先显式迁移至事务主存储');
  }
  return store.inTransaction?.() ? fn(store) : store.transaction(fn);
}
