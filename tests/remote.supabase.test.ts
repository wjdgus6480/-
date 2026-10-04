import { describe, expect, it } from 'vitest';
import { SupabaseDomainRemote } from '../src/domain/remote';
import { normalizeServerRow } from '../src/lib/serverRow';
import { SupabaseViewRemote } from '../src/views/remote';

/** supabase-js 의 rpc / from().select().gt().order().limit() 호출 모양만 흉내낸 스텁 (실서버 아님) */
function stubClient(opts: { rpcData?: any; rows?: any[]; error?: any }) {
  const calls: any[] = [];
  const chain: any = {
    select: (...a: any[]) => (calls.push(['select', ...a]), chain),
    gt: (...a: any[]) => (calls.push(['gt', ...a]), chain),
    order: (...a: any[]) => (calls.push(['order', ...a]), chain),
    limit: async (...a: any[]) => (calls.push(['limit', ...a]), { data: opts.rows ?? [], error: opts.error ?? null }),
  };
  return {
    calls,
    client: {
      rpc: async (fn: string, args: any) => (calls.push(['rpc', fn, args]), { data: opts.rpcData ?? null, error: opts.error ?? null }),
      from: (t: string) => (calls.push(['from', t]), chain),
    } as any,
  };
}

describe('REM-001 Supabase 원격 어댑터의 서버 행 정규화 (v0.3 결함 수정 회귀)', () => {
  it('PostgREST 의 +00:00 timestamptz 를 클라이언트 Z 표기로 바꿔 거짓 충돌을 막는다', () => {
    const row = normalizeServerRow({ deleted_at: '2026-10-02T08:48:24.206+00:00', updated_at: '2026-10-02T08:48:24.206123+00:00', due_date: '2026-10-05', server_seq: '42', version: '3', start_at: null });
    expect(row).toEqual({ deleted_at: '2026-10-02T08:48:24.206Z', updated_at: '2026-10-02T08:48:24.206Z', due_date: '2026-10-05', server_seq: 42, version: 3, start_at: null });
  });

  it('보기 설정 원격: RPC 결과 row 와 pull 결과를 정규화하고, 쿼리 빌더만 사용한다', async () => {
    const s = stubClient({ rpcData: { status: 'applied', row: { id: 'v', deleted_at: '2026-10-02T00:00:00+00:00', server_seq: 7 } }, rows: [{ id: 'v', updated_at: '2026-10-02T00:00:00.5+00:00', server_seq: 8 }] });
    const r = new SupabaseViewRemote(s.client, () => 'u');
    const pushed = await r.push({ op_id: 'o', view_id: 'v', base_version: 0, patch: {} });
    expect(pushed).toMatchObject({ status: 'applied', row: { deleted_at: '2026-10-02T00:00:00.000Z' } });
    const pulled = await r.pullSince(5);
    expect(pulled[0].updated_at).toBe('2026-10-02T00:00:00.500Z');
    expect(s.calls).toContainEqual(['rpc', 'apply_view_preference_op', { p_op_id: 'o', p_view_id: 'v', p_base_version: 0, p_patch: {} }]);
    expect(s.calls).toContainEqual(['gt', 'server_seq', 5]);
  });

  it('업무 데이터 원격: apply_domain_op 호출과 엔티티별 조회', async () => {
    const s = stubClient({ rpcData: { status: 'conflict', row: { id: 't', start_at: '2026-10-05T01:00:00+00:00', version: 2 } }, rows: [] });
    const r = new SupabaseDomainRemote(s.client, () => 'u');
    const res = await r.push({ op_id: 'o', entity: 'events', id: 't', base_version: 1, patch: { title: 'x' } });
    expect(res).toMatchObject({ status: 'conflict', row: { start_at: '2026-10-05T01:00:00.000Z' } });
    await r.pullSince('tasks', 0);
    expect(s.calls).toContainEqual(['from', 'tasks']);
    expect(s.calls[0]).toEqual(['rpc', 'apply_domain_op', { p_op_id: 'o', p_entity: 'events', p_id: 't', p_base_version: 1, p_patch: { title: 'x' } }]);
  });

  it('네트워크 오류는 offline 으로, 인증 오류는 auth 로 분류한다', async () => {
    const net = new SupabaseDomainRemote(stubClient({ error: { message: 'TypeError: Failed to fetch' } }).client, () => 'u');
    await expect(net.pullSince('tasks', 0)).rejects.toMatchObject({ kind: 'network' });
    const auth = new SupabaseDomainRemote(stubClient({ error: { message: 'JWT expired', code: 'PGRST301' } }).client, () => 'u');
    await expect(auth.push({ op_id: 'o', entity: 'tasks', id: 't', base_version: 0, patch: {} })).rejects.toMatchObject({ kind: 'auth' });
  });
});
