import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { openDotdayDB, type DB } from '../src/db/idb';
import { DomainRepository } from '../src/domain/repo';
import type { DomainPushRequest, DomainPushResult, DomainRemote, ServerRow } from '../src/domain/remote';
import { DomainSyncEngine } from '../src/domain/sync';
import type { Entity } from '../src/domain/types';
import { normalizeServerRow } from '../src/lib/serverRow';
import { normalizePushResult, RemoteError, type PushRequest, type PushResult, type ViewRemote } from '../src/views/remote';
import { ViewRepository } from '../src/views/repo';
import { ViewSyncEngine } from '../src/views/sync';
import type { RemoteViewRow } from '../src/views/types';

let dbCounter = 0;

export interface Device {
  db: DB;
  domain: DomainRepository;
  views: ViewRepository;
  sync: ViewSyncEngine;
  domainSync: DomainSyncEngine;
  session: { owner: string | null; ownerId(): string | null; localProfileId: string };
  remote: PgliteRemote | null;
  domainRemote: PgliteDomainRemote | null;
  online: boolean;
}

export async function makeDevice(opts: { owner?: string | null; server?: PGlite; name?: string } = {}): Promise<Device> {
  const db = await openDotdayDB(`test-${opts.name ?? 'dev'}-${++dbCounter}-${Math.random()}`);
  const session = {
    owner: opts.owner ?? null,
    ownerId() {
      return this.owner;
    },
    localProfileId: `profile-${dbCounter}`,
  };
  const domain = new DomainRepository(db, () => session.owner);
  const views = new ViewRepository(db, session, domain);
  const device: Device = { db, domain, views, session, remote: null, domainRemote: null, online: true, sync: null as never, domainSync: null as never };
  device.remote = opts.server ? new PgliteRemote(opts.server, () => session.owner, () => device.online) : null;
  device.domainRemote = opts.server ? new PgliteDomainRemote(opts.server, () => session.owner, () => device.online) : null;
  device.sync = new ViewSyncEngine(db, views, () => device.remote, () => device.online);
  device.domainSync = new DomainSyncEngine(db, domain, () => device.domainRemote, () => device.online);
  return device;
}

/** 업무 데이터 원격: apply_domain_op RPC 와 server_seq 조회를 PGlite 로 실행 */
export class PgliteDomainRemote implements DomainRemote {
  dropNextResponse = false;
  /** 지정한 엔티티 push 시 네트워크 오류 (이전 중단 시나리오) */
  failOnEntity: string | null = null;
  pushCalls: DomainPushRequest[] = [];

  constructor(
    private pg: PGlite,
    private getUser: () => string | null,
    private isOnline: () => boolean,
  ) {}

  userId() {
    return this.getUser();
  }

  async push(req: DomainPushRequest): Promise<DomainPushResult> {
    if (!this.isOnline() || this.failOnEntity === req.entity) throw new RemoteError('network down', 'network');
    this.pushCalls.push(structuredClone(req));
    const uid = this.getUser();
    if (!uid) throw new RemoteError('no session', 'auth');
    const res = await asUser(this.pg, uid, async (tx) => {
      const r = await tx.query(`select public.apply_domain_op($1, $2, $3, $4, $5::jsonb) as r`, [req.op_id, req.entity, req.id, req.base_version, JSON.stringify(req.patch)]);
      return r.rows[0].r;
    });
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new RemoteError('response lost', 'network');
    }
    return normalizePushResult<DomainPushResult>(res);
  }

  async pullSince(entity: Entity, cursor: number, limit = 500): Promise<ServerRow[]> {
    if (!this.isOnline()) throw new RemoteError('network down', 'network');
    const uid = this.getUser();
    if (!uid) throw new RemoteError('no session', 'auth');
    if (!['projects', 'categories', 'events', 'tasks'].includes(entity)) throw new Error('bad entity');
    return asUser(this.pg, uid, async (tx) => {
      const r = await tx.query(`select * from public.${entity} where server_seq > $1 order by server_seq limit $2`, [cursor, limit]);
      return r.rows.map((row: any) => normalizeServerRow<ServerRow>(row));
    });
  }
}

export async function serverQuery(pg: PGlite, userId: string, sql: string, params: unknown[] = []): Promise<any[]> {
  return asUser(pg, userId, async (tx) => (await tx.query(sql, params)).rows as any[]);
}

/** 도메인 스토어 전체 스냅샷 (updated_at, version, completed_at 포함) */
export async function domainDump(db: DB) {
  const out: Record<string, unknown[]> = {};
  for (const s of ['tasks', 'events', 'projects', 'categories'] as const) {
    out[s] = (await db.getAll(s)).sort((a, b) => a.id.localeCompare(b.id));
  }
  return JSON.parse(JSON.stringify(out));
}

// ---------- PGlite 서버 (실제 마이그레이션 SQL 실행) ----------

export const USER_A = '00000000-0000-4000-8000-00000000000a';
export const USER_B = '00000000-0000-4000-8000-00000000000b';

export async function makeServer(): Promise<PGlite> {
  const pg = new PGlite();
  // Supabase 환경 대체: auth 스키마, authenticated 역할, auth.uid()
  await pg.exec(`
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant usage on schema public to authenticated;
    insert into auth.users values ('${USER_A}'), ('${USER_B}');
  `);
  const dir = join(process.cwd(), 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return pg;
}

export async function asUser<T>(pg: PGlite, userId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId })]);
    await tx.exec('set local role authenticated');
    return fn(tx);
  });
}

/** Supabase RPC/쿼리 빌더와 같은 계약을 PGlite 로 구현한 원격. 네트워크 단절·응답 유실을 흉내낼 수 있다. */
export class PgliteRemote implements ViewRemote {
  /** true 면 서버에는 적용되지만 응답이 유실된다 (재전송 시나리오) */
  dropNextResponse = false;
  pushCalls: PushRequest[] = [];

  constructor(
    private pg: PGlite,
    private getUser: () => string | null,
    private isOnline: () => boolean,
  ) {}

  userId() {
    return this.getUser();
  }

  async push(req: PushRequest): Promise<PushResult> {
    if (!this.isOnline()) throw new RemoteError('network down', 'network');
    this.pushCalls.push(structuredClone(req));
    const uid = this.getUser();
    if (!uid) throw new RemoteError('no session', 'auth');
    const res = await asUser(this.pg, uid, async (tx) => {
      const r = await tx.query(`select public.apply_view_preference_op($1, $2, $3, $4::jsonb) as r`, [req.op_id, req.view_id, req.base_version, JSON.stringify(req.patch)]);
      return r.rows[0].r as PushResult;
    });
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new RemoteError('response lost', 'network');
    }
    return normalize(res);
  }

  async pullSince(cursor: number, limit = 500): Promise<RemoteViewRow[]> {
    if (!this.isOnline()) throw new RemoteError('network down', 'network');
    const uid = this.getUser();
    if (!uid) throw new RemoteError('no session', 'auth');
    return asUser(this.pg, uid, async (tx) => {
      const r = await tx.query(`select * from public.view_preferences where server_seq > $1 order by server_seq limit $2`, [cursor, limit]);
      return r.rows.map((row: any) => normalizeRow(row));
    });
  }
}

function normalizeRow(row: any): RemoteViewRow {
  const iso = (v: any) => (v === null || v === undefined ? null : new Date(v).toISOString());
  return { ...row, created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!, deleted_at: iso(row.deleted_at), server_seq: Number(row.server_seq) };
}

function normalize(res: any): PushResult {
  if (res.row) res.row = normalizeRow(res.row);
  return res;
}

export function listDbFiles() {
  return readdirSync(join(process.cwd(), 'supabase', 'migrations'));
}
