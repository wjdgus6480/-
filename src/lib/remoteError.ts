/** 서버 통신 오류. kind 로 동기화 정책(재시도·일시 정지)을 정한다 (src/lib/syncPolicy.ts). */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'auth' | 'server',
    /** 서버가 돌려준 오류 코드 (예: invalid_credentials). 프론트 안내 문구를 고르는 데 쓴다 */
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
