import Ajv from 'ajv';
import { authorize, type ActorContext } from './actor.ts';
import type { StateStore } from './types.ts';
export type JsonSchema = Record<string, any>;
export interface ActionExecutionContext { store: StateStore; executionId: string; actor: ActorContext }
export type ActionHandler = (payload: Record<string, unknown>, ctx: ActionExecutionContext) => Promise<string | void>;
export interface ActionContract {
  id: string; revision: number; roles: string[]; confirmation: 'human'; inputSchema: JsonSchema;
  resolve?: (store: StateStore, input: Record<string, unknown>) => Promise<{ entity_type: string; entity_id: string; payload: Record<string, unknown> }>;
  snapshot?: (store: StateStore, input: Record<string, unknown>) => Promise<unknown>;
  execute: ActionHandler;
}
const ajv = new Ajv({ allErrors: true, strict: true, multipleOfPrecision: 8 });
const contracts = new Map<string, ActionContract>();
export function unregisterActionContract(id:string):void { contracts.delete(id); }
export function assertSchema(schema: JsonSchema): void { ajv.compile(schema); }
export function validateSchema(schema: JsonSchema, input: unknown): void {
  const check = ajv.compile(schema);
  if (!check(input)) throw new Error(`参数校验失败: ${ajv.errorsText(check.errors)}`);
}
export function registerActionContract(contract: ActionContract, opts: { replace?: boolean } = {}): void {
  if (!contract.id || !contract.revision || !contract.roles.length) throw new Error('动作契约缺少 id/revision/roles');
  ajv.compile(contract.inputSchema);
  if (contracts.has(contract.id) && !opts.replace) throw new Error(`动作重复注册: ${contract.id}`);
  contracts.set(contract.id, Object.freeze({ ...contract }));
}
export function getActionContract(id: string): ActionContract {
  const contract = contracts.get(id);
  if (!contract) throw new Error(`确认卡 action 未注册: ${id}`);
  return contract;
}
export function checkAction(contract: ActionContract, actor: ActorContext, input?: unknown): void {
  authorize(contract.roles, actor);
  if (actor.kind !== 'human') throw new Error('业务写操作必须由人确认');
  if (input !== undefined) validateSchema(contract.inputSchema, input);
}
