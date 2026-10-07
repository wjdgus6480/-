import type { ApiClient } from '../app/api';
import { normalizeServerRow } from '../lib/serverRow';
import { normalizePushResult } from '../views/remote';
import { DOMAIN_STORES, type Entity } from './types';

export type ServerRow = Record<string, any> & { id: string; owner_id: string; version: number; server_seq: number };

export type DomainPushResult =
  | { status: 'applied'; row: ServerRow; duplicate?: boolean }
  | { status: 'conflict'; row: ServerRow }
  | { status: 'not_found' }
  | { status: 'rejected'; reason: string }
  | { status: 'retry'; reason: string };

export interface DomainPushRequest {
  op_id: string;
  entity: Entity;
  id: string;
  base_version: number;
  patch: Record<string, unknown>;
}

/** 업무 데이터 서버 계약 (보기 설정 ViewRemote 와 별개) */
export interface DomainRemote {
  userId(): string | null;
  push(req: DomainPushRequest): Promise<DomainPushResult>;
  pullSince(entity: Entity, cursor: number, limit?: number): Promise<ServerRow[]>;
}

/** Spring Boot API: POST /api/sync/domain/ops, GET /api/sync/domain/{entity}?since= */
export class RestDomainRemote implements DomainRemote {
  constructor(
    private api: ApiClient,
    private getUserId: () => string | null,
  ) {}

  userId() {
    return this.getUserId();
  }

  async push(req: DomainPushRequest): Promise<DomainPushResult> {
    return normalizePushResult<DomainPushResult>(await this.api.request('POST', '/api/sync/domain/ops', req));
  }

  async pullSince(entity: Entity, cursor: number, limit = 500): Promise<ServerRow[]> {
    // 경로에 넣는 엔티티 이름은 고정 목록에서만 (사용자 입력이 URL 에 들어가지 않음)
    if (!DOMAIN_STORES.includes(entity)) throw new Error(`unknown entity ${entity}`);
    const rows = await this.api.request<Record<string, unknown>[]>('GET', `/api/sync/domain/${entity}?since=${Math.trunc(cursor)}&limit=${Math.trunc(limit)}`);
    return (rows ?? []).map((r) => normalizeServerRow<ServerRow>(r));
  }
}
