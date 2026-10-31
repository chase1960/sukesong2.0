// execution.events 是审计日志，不是完整事件源。回看绝不能再次执行业务命令。
import type { StateStore } from './types.ts';
export interface RebuildResult { replayed: number; failed: Array<{ id: string; error: string }> }
/** @deprecated 禁止用命令 handler 重建业务状态；恢复应使用经验证的数据库备份。 */
export async function rebuildProjection(_store: StateStore, _entityType?: string): Promise<RebuildResult> {
  throw new Error('已禁用业务命令重放：审计日志不支持重建业务状态，请使用备份恢复');
}
