// 工作区核心（2026-08-10）：模板读取 + 用户启用 + 角色默认映射 + 可见模块计算。
// 设计：工作区 = 面向岗位的模块集合（modules 按工作流先后顺序）；角色=权限边界，工作区=布局集合，两者正交。
// 用户未配置时按角色映射默认工作区；「全部」视图始终可用（管理/排查用）。
import type { StateStore, WorkspaceDef } from './types.ts';

// 角色 → 默认工作区（用户未配置时用；admin 默认全配）
const ROLE_DEFAULT: Record<string, string[]> = {
  finance: ['finance', 'cashier', 'collab'],
  manager: ['sales', 'supply', 'collab'],
  staff: ['sales', 'collab'],
  admin: ['boss', 'admin', 'finance', 'sales', 'supply', 'collab'],
};

// 用户已启用的工作区 id + 个人自定义工作区（user_workspaces 表；未配置 → 角色默认）
export async function enabledWorkspaceIds(store: StateStore, username: string, role: string): Promise<string[]> {
  const rows = await store.query('cognition', 'user_workspaces', { user_id: username });
  if (rows.length) {
    try {
      const ids = JSON.parse(String(rows[0].workspace_ids || '[]'));
      if (Array.isArray(ids) && ids.length) return ids;
    } catch { /* 解析失败走默认 */ }
  }
  return ROLE_DEFAULT[role] || ['collab'];
}

export async function customWorkspaces(store: StateStore, username: string): Promise<WorkspaceDef[]> {
  const rows = await store.query('cognition', 'user_workspaces', { user_id: username });
  if (!rows.length) return [];
  try {
    const c = JSON.parse(String(rows[0].custom || '[]'));
    return Array.isArray(c) ? c : [];
  } catch { return []; }
}

export async function setEnabledWorkspaces(store: StateStore, username: string, ids: string[], custom?: WorkspaceDef[]): Promise<void> {
  const rows = await store.query('cognition', 'user_workspaces', { user_id: username });
  const json = JSON.stringify(ids);
  const customJson = custom ? JSON.stringify(custom) : undefined;
  const patch: Record<string, any> = { workspace_ids: json, updated_at: new Date().toISOString() };
  if (customJson !== undefined) patch.custom = customJson;
  if (rows.length) await store.update('cognition', 'user_workspaces', rows[0].id, patch);
  else await store.insert('cognition', 'user_workspaces', { user_id: username, ...patch });
}

// 计算用户可见的工作区：模板 ∩ 角色；返回模块是否已实装的判断由前端（RENDER）完成。
export async function visibleWorkspaces(store: StateStore, templates: WorkspaceDef[], username: string, role: string): Promise<{
  templates: WorkspaceDef[];
  enabled: string[];
  default_ids: string[];
}> {
  const enabled = await enabledWorkspaceIds(store, username, role);
  // 角色可见模板（空 roles = 全员）
  const visible = templates.filter((w) => !w.roles.length || w.roles.includes(role) || role === 'admin');
  return { templates: visible, enabled, default_ids: ROLE_DEFAULT[role] || ['collab'] };
}
