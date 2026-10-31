// 事务主存储。领域只依赖 StateStore；SQLite 文件不是供外部协作编辑的表。
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { StateStore, QueryOpts } from '../types.ts';

const scopes = new AsyncLocalStorage<{ store: SqliteStore; active: boolean }>();
const stores = new Map<string, SqliteStore>();

export function openSqliteStore(path: string): SqliteStore {
  const key = resolve(path);
  let store = stores.get(key);
  if (!store) { store = new SqliteStore(key); stores.set(key, store); }
  return store;
}

export class SqliteStore implements StateStore {
  readonly guarantees = { transactions: true, conditionalUpdate: true, stableIds: true, appendOnlyAudit: true } as const;
  readonly __cacheKey: string;
  private db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.__cacheKey = `sqlite:${path}`;
    this.db = new DatabaseSync(path);
    const schemaVersion=Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if(schemaVersion>1) { this.db.close(); throw new Error('数据库版本高于当前程序，禁止降级打开'); }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        layer TEXT NOT NULL, entity TEXT NOT NULL, id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL CHECK(json_valid(body)),
        UNIQUE(layer,entity,id)
      );
      CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON records
      WHEN (OLD.layer='business' AND OLD.entity IN ('ledger','cash_movements'))
        OR (OLD.layer='execution' AND OLD.entity='events')
        OR (OLD.layer='cognition' AND OLD.entity='meta_revisions')
      BEGIN SELECT RAISE(ABORT,'append-only: 禁止修改历史记录'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON records
      WHEN (OLD.layer='business' AND OLD.entity IN ('ledger','cash_movements'))
        OR (OLD.layer='execution' AND OLD.entity='events')
        OR (OLD.layer='cognition' AND OLD.entity='meta_revisions')
      BEGIN SELECT RAISE(ABORT,'append-only: 禁止删除历史记录'); END;
      CREATE TRIGGER IF NOT EXISTS chat_source_immutable_update BEFORE UPDATE ON records
      WHEN OLD.layer='execution' AND OLD.entity='chat_audit_sources'
      BEGIN SELECT RAISE(ABORT,'append-only: 禁止修改来源对话快照'); END;
      CREATE TRIGGER IF NOT EXISTS chat_source_immutable_delete BEFORE DELETE ON records
      WHEN OLD.layer='execution' AND OLD.entity='chat_audit_sources'
      BEGIN SELECT RAISE(ABORT,'append-only: 禁止删除来源对话快照'); END;
      CREATE TRIGGER IF NOT EXISTS chat_audit_event_update BEFORE UPDATE ON records
      WHEN OLD.layer='execution' AND OLD.entity='chat_audit_events'
      BEGIN SELECT RAISE(ABORT,'append-only: 禁止修改对话动作事实'); END;
      CREATE TRIGGER IF NOT EXISTS chat_audit_event_delete BEFORE DELETE ON records
      WHEN OLD.layer='execution' AND OLD.entity='chat_audit_events'
      BEGIN SELECT RAISE(ABORT,'append-only: 禁止删除对话动作事实'); END;
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_source ON records(json_extract(body,'$.source_key'))
        WHERE layer='business' AND entity='ledger' AND json_extract(body,'$.source_key') IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS movement_source ON records(json_extract(body,'$.execution_id'))
        WHERE layer='business' AND entity='cash_movements' AND json_extract(body,'$.execution_id') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS chat_message_window_v1 ON records(layer,entity,
        json_extract(body,'$."conversation_id"'),json_extract(body,'$."role"'),json_extract(body,'$."created_at"'),id) WHERE layer='execution' AND entity='chat_messages';
      CREATE INDEX IF NOT EXISTS chat_message_turn_v1 ON records(layer,entity,
        json_extract(body,'$."conversation_id"'),json_extract(body,'$."role"'),json_extract(body,'$."turn_id"')) WHERE layer='execution' AND entity='chat_messages';
      CREATE INDEX IF NOT EXISTS chat_event_turn_v1 ON records(layer,entity,
        json_extract(body,'$."actor_key"'),json_extract(body,'$."conversation_id"'),json_extract(body,'$."turn_id"'),seq) WHERE layer='execution' AND entity='chat_audit_events';
      CREATE INDEX IF NOT EXISTS chat_event_request_v1 ON records(layer,entity,
        json_extract(body,'$."actor_key"'),json_extract(body,'$."request_id"')) WHERE layer='execution' AND entity='chat_audit_events';
      CREATE INDEX IF NOT EXISTS chat_source_proposal_v1 ON records(layer,entity,
        json_extract(body,'$."actor_key"'),json_extract(body,'$."proposal_id"')) WHERE layer='execution' AND entity='chat_audit_sources';
      PRAGMA user_version=1;
    `);
  }

  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    const scope = scopes.getStore();
    if (scope?.store === this) {
      if (!scope.active) return Promise.reject(new Error('事务已结束，禁止延迟写入'));
      return Promise.resolve().then(fn);
    }
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  inTransaction(): boolean { return scopes.getStore()?.store === this && !!scopes.getStore()?.active; }

  async close(): Promise<void> {
    await this.run(() => { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); stores.delete(resolve(this.path)); });
  }

  async backup(path:string):Promise<void> {
    if(this.inTransaction()) throw new Error('备份必须在事务之外执行');
    await this.run(()=>{ this.db.prepare('VACUUM INTO ?').run(resolve(path)); });
  }

  async transaction<T>(fn: (store: StateStore) => Promise<T>): Promise<T> {
    if (scopes.getStore()?.store === this) throw new Error('禁止嵌套事务；请传递当前事务 store');
    return this.run(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      const scope = { store: this, active: true };
      try {
        const result = await scopes.run(scope, () => fn(this));
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      } finally { scope.active = false; }
    });
  }

  query(layer: string, entity: string, filter?: Record<string, any>, opts?: QueryOpts): Promise<any[]> {
    return this.run(() => {
      const clauses = ['layer=?', 'entity=?'];
      const values: any[] = [layer, entity];
      for (const [key, value] of Object.entries(filter || {})) {
        if (key === 'id') { clauses.push('id=?'); values.push(value); }
        else if(layer==='execution' && ['chat_messages','chat_audit_events','chat_audit_sources'].includes(entity)
            && ['conversation_id','role','turn_id','actor_key','request_id','proposal_id'].includes(key)) {
          clauses.push(`json_extract(body,'$."${key}"') IS ?`);values.push(typeof value === 'boolean' ? Number(value) : value);
        }
        else { clauses.push('json_extract(body,?) IS ?'); values.push(`$."${key.replaceAll('"', '')}"`, typeof value === 'boolean' ? Number(value) : value); }
      }
      for(const condition of opts?.conditions||[]){
        const path=`$."${condition.key.replaceAll('"','')}"`;
        if(condition.op==='contains'){clauses.push('instr(lower(coalesce(json_extract(body,?),\'\')),lower(?))>0');values.push(path,condition.value);}
        else if(condition.op==='includes'){clauses.push('instr(coalesce(json_extract(body,?),\'\'),?)>0');values.push(path,condition.value);}
        else {clauses.push(`json_extract(body,?) ${condition.op==='gte'?'>=':'<'} ?`);values.push(path,condition.value);}
      }
      if(opts?.cursor){
        if(!opts.sort||!opts.stable)throw new Error('游标查询需要稳定排序');
        const path=`$."${opts.sort.key.replaceAll('"','')}"`,c=opts.cursor,op=c.direction==='before'?'<':'>';
        if(layer==='execution'&&entity==='chat_messages'&&opts.sort.key==='created_at') {
          clauses.push(`(json_extract(body,'$."created_at"'),id) ${op} (?,?)`);values.push(c.value,c.id);
        } else {clauses.push(`(json_extract(body,?) ${op} ? OR (json_extract(body,?)=? AND id ${op} ?))`);values.push(path,c.value,path,c.value,c.id);}
      }
      let sql = `SELECT body,version FROM records WHERE ${clauses.join(' AND ')}`;
      if (opts?.sort) { const dir=opts.sort.dir === 'desc' ? 'DESC' : 'ASC';if(layer==='execution'&&entity==='chat_messages'&&opts.sort.key==='created_at')sql += ` ORDER BY json_extract(body,'$."created_at"') ${dir},${opts.stable?'id '+dir:'seq'}`;
        else {sql += ` ORDER BY json_extract(body,?) ${dir},${opts.stable?'id '+dir:'seq'}`; values.push(`$."${opts.sort.key.replaceAll('"', '')}"`);} }
      else sql += ' ORDER BY seq';
      if (opts?.limit != null) { sql += ' LIMIT ?'; values.push(Math.max(0, Math.floor(opts.limit))); }
      return this.db.prepare(sql).all(...values).map((r: any) => ({ ...JSON.parse(r.body), _version: Number(r.version) }));
    });
  }

  insert(layer: string, entity: string, record: any): Promise<string> {
    return this.run(() => {
      const id = String(record.id || randomUUID());
      const { _version, ...body } = record;
      this.db.prepare('INSERT INTO records(layer,entity,id,body) VALUES (?,?,?,?)').run(layer, entity, id, JSON.stringify({ ...body, id }));
      return id;
    });
  }

  update(layer: string, entity: string, id: string, patch: any): Promise<void> {
    return this.run(() => { this.patch(layer, entity, id, patch); });
  }

  // 物理删除。与 immutable_update 触发器同一护栏：append-only 实体禁止删除（触发器只管 UPDATE，DELETE 需在此拦）。
  private static readonly APPEND_ONLY = new Set([
    'business.ledger', 'business.cash_movements', 'execution.events', 'cognition.meta_revisions',
  ]);
  delete(layer: string, entity: string, id: string): Promise<void> {
    return this.run(() => {
      if (SqliteStore.APPEND_ONLY.has(`${layer}.${entity}`)) {
        throw new Error(`append-only 实体禁止删除: ${layer}.${entity}（红冲纠错，不改历史）`);
      }
      const result = this.db.prepare('DELETE FROM records WHERE layer=? AND entity=? AND id=?').run(layer, entity, id);
      if (!result.changes) throw new Error(`记录不存在: ${layer}.${entity}/${id}`);
    });
  }

  compareAndSet(layer: string, entity: string, id: string, version: number, patch: any): Promise<boolean> {
    return this.run(() => {
      const row: any = this.db.prepare('SELECT version FROM records WHERE layer=? AND entity=? AND id=?').get(layer, entity, id);
      if (!row || Number(row.version) !== version) return false;
      return this.patch(layer, entity, id, patch, version);
    });
  }

  private patch(layer: string, entity: string, id: string, patch: any, version?: number): boolean {
    // 在单 SQL 中合并 JSON，避免读后覆盖；null 保留为显式值。
    const { id: ignoredId, _version, ...fields } = patch;
    fields.updated_at ??= new Date().toISOString();
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    // 空字段集：只 bump 版本（此前会生成 json_set(body,) 语法错误导致 500）
    if (!entries.length) {
      const r = this.db.prepare(`UPDATE records SET version=version+1 WHERE layer=? AND entity=? AND id=?${version == null ? '' : ' AND version=?'}`)
        .run(layer, entity, id, ...(version == null ? [] : [version]));
      if (!r.changes && version == null) throw new Error(`记录不存在: ${layer}.${entity}/${id}`);
      return !!r.changes;
    }
    const args: any[] = [];
    const sets = entries.map(([key, value]) => {
      args.push(`$."${key.replaceAll('"', '')}"`, JSON.stringify(value)); return '?,json(?)';
    });
    const result = this.db.prepare(`UPDATE records SET body=json_set(body,${sets.join(',')}),version=version+1 WHERE layer=? AND entity=? AND id=?${version == null ? '' : ' AND version=?'}`)
      .run(...args, layer, entity, id, ...(version == null ? [] : [version]));
    if (!result.changes && version == null) throw new Error(`记录不存在: ${layer}.${entity}/${id}`);
    return !!result.changes;
  }
}
