import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CalendarEvent, Category, DomainSnapshot, Entity, Project, Task } from '../domain/types';
import type { LocalViewRecord, OutboxOp, ViewBackup, ViewConflict } from '../views/types';

/** 업무 데이터 변경 큐 항목 (보기 설정 큐와 별도) */
export interface DomainOp {
  op_id: string;
  entity: Entity;
  record_id: string;
  /** `${entity}:${record_id}` */
  key: string;
  fields: string[];
  status: 'pending' | 'inflight' | 'conflict' | 'rejected';
  seq: number;
  created_at: string;
  attempts: number;
  last_error?: string;
}

export interface DomainConflictGroup {
  fields: string[];
  base: Record<string, unknown> | null;
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
}

export interface DomainConflict {
  id: string;
  entity: Entity;
  record_id: string;
  op_id: string;
  label: string;
  kind: 'field' | 'delete';
  groups: DomainConflictGroup[];
  merged_fields: string[];
  remote_row: Record<string, any>;
  created_at: string;
}

export interface DomainBackup {
  id: string;
  reason: 'import' | 'migration' | 'manual';
  created_at: string;
  owner_id: string | null;
  data: DomainSnapshot;
}

export interface DotdayDB extends DBSchema {
  tasks: { key: string; value: Task };
  events: { key: string; value: CalendarEvent };
  projects: { key: string; value: Project };
  categories: { key: string; value: Category };
  view_preferences: { key: string; value: LocalViewRecord; indexes: { by_view_key: string } };
  view_outbox: { key: string; value: OutboxOp; indexes: { by_view: string } };
  view_conflicts: { key: string; value: ViewConflict };
  view_backups: { key: string; value: ViewBackup };
  meta: { key: string; value: { key: string; value: unknown } };
  // v2
  domain_outbox: { key: string; value: DomainOp; indexes: { by_key: string } };
  domain_conflicts: { key: string; value: DomainConflict };
  domain_backups: { key: string; value: DomainBackup };
}

export type DB = IDBPDatabase<DotdayDB>;

/**
 * v1: v0.3 (업무 스토어 + 보기 설정)
 * v2: v0.4 업무 데이터 동기화 스토어 추가. 기존 스토어와 데이터는 건드리지 않는다.
 */
export const DB_VERSION = 2;

export function openDotdayDB(name = 'dotday', version = DB_VERSION): Promise<DB> {
  return openDB<DotdayDB>(name, version, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('tasks', { keyPath: 'id' });
        db.createObjectStore('events', { keyPath: 'id' });
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('categories', { keyPath: 'id' });
        const views = db.createObjectStore('view_preferences', { keyPath: 'id' });
        views.createIndex('by_view_key', 'view_key');
        const outbox = db.createObjectStore('view_outbox', { keyPath: 'op_id' });
        outbox.createIndex('by_view', 'view_id');
        db.createObjectStore('view_conflicts', { keyPath: 'id' });
        db.createObjectStore('view_backups', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2 && version >= 2) {
        const dout = db.createObjectStore('domain_outbox', { keyPath: 'op_id' });
        dout.createIndex('by_key', 'key');
        db.createObjectStore('domain_conflicts', { keyPath: 'id' });
        db.createObjectStore('domain_backups', { keyPath: 'id' });
      }
    },
  });
}

export async function getMeta<T>(db: DB, key: string): Promise<T | undefined> {
  return (await db.get('meta', key))?.value as T | undefined;
}

export async function setMeta(db: DB, key: string, value: unknown): Promise<void> {
  await db.put('meta', { key, value });
}
