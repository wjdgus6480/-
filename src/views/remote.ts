import type { ApiClient } from '../app/api';
import { normalizeServerRow } from '../lib/serverRow';
import type { RemoteViewRow } from './types';

export { RemoteError } from '../lib/remoteError';

export type PushResult =
  | { status: 'applied'; row: RemoteViewRow; duplicate?: boolean }
  | { status: 'conflict'; row: RemoteViewRow }
  | { status: 'not_found' }
  | { status: 'rejected'; reason: string };

export interface PushRequest {
  op_id: string;
  view_id: string;
  base_version: number;
  patch: Record<string, unknown>;
}

/** 클라우드 보기 설정 저장소 계약. REST 구현(Spring Boot)과 테스트용 PGlite 구현이 같은 판정 규칙을 따른다. */
export interface ViewRemote {
  userId(): string | null;
  push(req: PushRequest): Promise<PushResult>;
  pullSince(cursor: number, limit?: number): Promise<RemoteViewRow[]>;
}

/** 서버 결과의 row 를 정규화한다 */
export function normalizePushResult<R>(res: any): R {
  if (res && res.row) return { ...res, row: normalizeServerRow(res.row) } as R;
  return res as R;
}

/** Spring Boot API: POST /api/sync/views/ops, GET /api/sync/views?since= */
export class RestViewRemote implements ViewRemote {
  constructor(
    private api: ApiClient,
    private getUserId: () => string | null,
  ) {}

  userId() {
    return this.getUserId();
  }

  async push(req: PushRequest): Promise<PushResult> {
    return normalizePushResult<PushResult>(await this.api.request('POST', '/api/sync/views/ops', req));
  }

  async pullSince(cursor: number, limit = 500): Promise<RemoteViewRow[]> {
    const rows = await this.api.request<Record<string, unknown>[]>('GET', `/api/sync/views?since=${Math.trunc(cursor)}&limit=${Math.trunc(limit)}`);
    return (rows ?? []).map((r) => normalizeServerRow<RemoteViewRow>(r));
  }
}
