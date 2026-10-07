/**
 * 브라우저 번들에 들어가는 공개 설정. 비밀 값(DB 비밀번호·JWT 비밀 키)은 여기에 두지 않는다 (서버 환경변수에만).
 * - VITE_CONTACT_EMAIL: 개인정보·탈퇴 문의 주소 (처리방침·약관 화면에 표시)
 */
export interface PublicConfig {
  contactEmail: string | null;
}

export function parsePublicConfig(env: Record<string, string | undefined>): PublicConfig {
  return { contactEmail: env.VITE_CONTACT_EMAIL?.trim() || null };
}

// import.meta.env 를 통째로 넘기면 Vite 가 .env 의 VITE_* 값을 전부 번들에 넣는다 → 쓰는 값만 꺼낸다
export const publicConfig: PublicConfig = parsePublicConfig({ VITE_CONTACT_EMAIL: import.meta.env.VITE_CONTACT_EMAIL as string | undefined });
