export function chatEngines() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const available = process.env.SS_PI_CHAT_ENABLED !== '0' && (major > 22 || major === 22 && minor >= 19);
  return [{ id: 'classic', label: '原引擎' }, ...(available ? [{ id: 'pi', label: 'Pi 试用' }] : [])];
}
// 运行时配置不改变既有缺省引擎；试接须由管理员显式配置。
export function defaultChatEngine(): 'classic' | 'pi' {
  return process.env.SS_CHAT_ENGINE === 'pi' && chatEngines().some(e => e.id === 'pi') ? 'pi' : 'classic';
}
export function chatEngine(value: unknown): 'classic' | 'pi' {
  if (value === undefined || value === 'classic') return 'classic';
  if (value === 'pi' && chatEngines().some(e => e.id === 'pi')) return 'pi';
  throw Error('该对话引擎未启用，请切回原引擎');
}
