// 서버(PostgREST/Postgres)에서 받은 행을 클라이언트 표현으로 맞춘다.
// timestamptz 는 '2026-10-02T08:48:24.206+00:00' 처럼 오므로 클라이언트의 'Z' 표기와 문자열 비교가 어긋난다.
// 정규화하지 않으면 3-way 병합에서 값이 같은데도 '원격 변경'으로 판정되어 거짓 충돌이 생긴다.

const TIMESTAMP_KEYS = ['created_at', 'updated_at', 'deleted_at', 'completed_at', 'start_at', 'end_at', 'original_start_at'];
const DATE_KEYS = ['due_date'];
const INT_KEYS = ['version', 'server_seq'];

export function normalizeServerRow<T = Record<string, any>>(row: Record<string, any>): T {
  const out: Record<string, any> = { ...row };
  for (const k of TIMESTAMP_KEYS) {
    if (out[k] === undefined || out[k] === null) continue;
    const d = out[k] instanceof Date ? out[k] : new Date(out[k]);
    if (!Number.isNaN(d.getTime())) out[k] = d.toISOString();
  }
  for (const k of DATE_KEYS) {
    const v = out[k];
    if (v instanceof Date) {
      // 드라이버가 date 를 Date 로 줄 때: 로컬 자정 또는 UTC 자정 모두 같은 달력 날짜로
      const z = (n: number) => String(n).padStart(2, '0');
      out[k] = v.getUTCHours() === 0 ? v.toISOString().slice(0, 10) : `${v.getFullYear()}-${z(v.getMonth() + 1)}-${z(v.getDate())}`;
    } else if (typeof v === 'string' && v.length > 10) out[k] = v.slice(0, 10);
  }
  for (const k of INT_KEYS) if (out[k] !== undefined && out[k] !== null) out[k] = Number(out[k]);
  return out as T;
}
