import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeServerRow } from '../lib/serverRow';
import { classifyError, normalizePushResult } from '../views/remote';
import type { Entity } from './types';

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

export class SupabaseDomainRemote implements DomainRemote {
  constructor(
    private client: SupabaseClient,
    private getUserId: () => string | null,
  ) {}

  userId() {
    return this.getUserId();
  }

  async push(req: DomainPushRequest): Promise<DomainPushResult> {
    const { data, error } = await this.client.rpc('apply_domain_op', {
      p_op_id: req.op_id,
      p_entity: req.entity,
      p_id: req.id,
      p_base_version: req.base_version,
      p_patch: req.patch,
    });
    if (error) throw classifyError(error);
    return normalizePushResult<DomainPushResult>(data);
  }

  async pullSince(entity: Entity, cursor: number, limit = 500): Promise<ServerRow[]> {
    const { data, error } = await this.client.from(entity).select('*').gt('server_seq', cursor).order('server_seq', { ascending: true }).limit(limit);
    if (error) throw classifyError(error);
    return (data ?? []).map((r) => normalizeServerRow<ServerRow>(r));
  }
}
