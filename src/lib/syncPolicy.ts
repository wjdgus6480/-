// 업무 데이터·보기 설정 동기화 엔진이 함께 쓰는 실패 분류와 재시도 간격.
import { RemoteError } from '../views/remote';

export type FailureKind = 'network' | 'auth' | 'server';

export function classifyFailure(e: unknown): FailureKind {
  if (e instanceof RemoteError) return e.kind;
  if (e instanceof TypeError) return 'network'; // fetch 실패
  return 'server';
}

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

/** 연속 실패마다 30초 → 1분 → 2분 … 최대 10분. 성공하면 초기화. */
export class Backoff {
  failures = 0;
  nextAt = 0;
  constructor(private now: () => number = Date.now) {}
  fail(): number {
    this.failures++;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    this.nextAt = this.now() + delay;
    return delay;
  }
  reset() {
    this.failures = 0;
    this.nextAt = 0;
  }
  ready(): boolean {
    return this.now() >= this.nextAt;
  }
}

export const SYNC_STATUS_LABEL = {
  'local-only': '로컬 전용 (클라우드 미연결)',
  idle: '동기화됨',
  syncing: '동기화 중…',
  offline: '오프라인: 연결되면 전송',
  error: '동기화 오류',
  auth: '로그인 만료: 다시 로그인하세요',
} as const;
export type SyncStatusKind = keyof typeof SYNC_STATUS_LABEL;
