import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeServerRow } from '../lib/serverRow';
import type { RemoteViewRow } from './types';

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

/** 클라우드 보기 설정 저장소 계약. Supabase 구현과 테스트용 PGlite 구현이 같은 SQL 함수를 사용한다. */
export interface ViewRemote {
  userId(): string | null;
  push(req: PushRequest): Promise<PushResult>;
  pullSince(cursor: number, limit?: number): Promise<RemoteViewRow[]>;
}

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'auth' | 'server',
  ) {
    super(message);
  }
}

/** supabase-js 오류를 분류한다. fetch 실패(오프라인 등)는 network 로 본다. */
export function classifyError(error: { message?: string; code?: string; status?: number } | null | undefined): RemoteError {
  const msg = error?.message ?? 'unknown error';
  if (error?.code === '28000' || error?.code === 'PGRST301' || error?.status === 401) return new RemoteError(msg, 'auth');
  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(msg) || error?.status === 0) return new RemoteError(msg, 'network');
  return new RemoteError(msg, 'server');
}

/** RPC 결과의 row 를 정규화한다 */
export function normalizePushResult<R>(res: any): R {
  if (res && res.row) return { ...res, row: normalizeServerRow(res.row) } as R;
  return res as R;
}

export class SupabaseViewRemote implements ViewRemote {
  constructor(
    private client: SupabaseClient,
    private getUserId: () => string | null,
  ) {}

  userId() {
    return this.getUserId();
  }

  async push(req: PushRequest): Promise<PushResult> {
    const { data, error } = await this.client.rpc('apply_view_preference_op', {
      p_op_id: req.op_id,
      p_view_id: req.view_id,
      p_base_version: req.base_version,
      p_patch: req.patch,
    });
    if (error) throw classifyError(error);
    return normalizePushResult<PushResult>(data);
  }

  async pullSince(cursor: number, limit = 500): Promise<RemoteViewRow[]> {
    // 쿼리 빌더만 사용한다. 사용자 입력 문자열을 쿼리에 직접 넣지 않는다.
    const { data, error } = await this.client.from('view_preferences').select('*').gt('server_seq', cursor).order('server_seq', { ascending: true }).limit(limit);
    if (error) throw classifyError(error);
    return (data ?? []).map((r) => normalizeServerRow<RemoteViewRow>(r));
  }
}
