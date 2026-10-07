# 무료 운영 조건 (2026-10-06 공식 페이지 확인)

> 무료 운영을 목표로 하지만 **무제한 무료를 보장하지 않는다.** 아래 한도는 제공자가 언제든 바꿀 수 있어 공개 전·분기마다 다시 확인한다.

## Supabase Free ([pricing](https://supabase.com/pricing))

| 항목 | 한도 | DOTDAY 영향 |
|---|---|---|
| DB 용량 | 500 MB | 텍스트 위주라 여유 있음. tombstone·domain_ops 가 계속 쌓이므로 장기적으로 정리 작업 필요 [제안] |
| 전송량(egress) | 5 GB/월 (+ 캐시 5 GB) | 30초 주기 동기화는 변경분만 조회(`server_seq > 커서`) → 작음. 화면 숨김 시 주기 요청 생략(v0.4.2) |
| 월간 활성 사용자 | 50,000 | 충분 |
| Edge Functions | 50만 회/월 | 현재 미사용 (탈퇴를 Edge Function 으로 바꿀 때만) |
| Realtime | 동시 200, 월 200만 메시지 | **미사용** (폴링) |
| 프로젝트 수 | 활성 2개 | — |
| 일시 중지 | **1주 비활동 시 자동 일시 중지** | 공개 서비스에서 가장 큰 위험. 사용자가 없으면 멈춤 → 대시보드에서 재개. 재개 전까지 기기 데이터는 보존되고 동기화만 실패(앱이 '오프라인/오류'로 표시) |
| 백업 | **자동 백업 미포함** | 정기적으로 CSV 내보내기 또는 `supabase db dump` (운영자 수동) |
| Auth 메일 | 시간당 2통 (기본 SMTP) | 공개 서비스에 부족 → 커스텀 SMTP 또는 소셜 로그인 |
| Auth 요청 한도 | 가입·로그인 IP 당 5분 30회, 토큰 5분 150회 ([rate limits](https://supabase.com/docs/guides/auth/rate-limits)) | 같은 공용 IP(학교·회사)에서 동시 사용 시 제한 가능 |
| 사용자 지정 OAuth 제공자 | 3개 | Naver 1개 |

## Vercel Hobby ([fair use](https://vercel.com/docs/limits/fair-use-guidelines))

| 항목 | 한도 |
|---|---|
| 상업적 이용 | **금지** (광고·결제·유료 의뢰·제휴 링크 포함). 기부 요청은 허용. 비상업 포트폴리오는 가능 |
| Fast Data Transfer | 100 GB/월 |
| Function 호출 | 100만/월 (DOTDAY 는 정적 사이트라 거의 0) |
| 롤백 | Instant Rollback 은 직전 Production 한 단계 ([docs/RECOVERY.md](../RECOVERY.md)) |
| 도메인 | `*.vercel.app` 무료. 보유한 커스텀 도메인 연결은 무료, **도메인 구입 비용은 별도** |

## Cloudflare Turnstile — 무료, 요청 무제한, 위젯 20개, 위젯당 호스트 10개

## 사용량 증가 시 비용 위험과 대응

| 상황 | 신호 | 대응 (무료 유지 순서) |
|---|---|---|
| 메일 한도 초과 | 가입자에게 `over_email_send_rate_limit` | 소셜 로그인 안내 → 무료 SMTP(Resend 100통/일) → 그래도 부족하면 가입 일시 제한 |
| egress 근접 | 대시보드 Usage | 동기화 주기 늘리기(30→60초), 숨김 화면 생략 유지 |
| DB 500MB 근접 | Usage | 오래된 domain_ops·tombstone 정리 작업(설계 필요) |
| 스팸 가입 급증 | auth.users 급증 | CAPTCHA 켜기, 가입 일시 중지(Auth 설정 'Allow new users' 끄기) |
| 1주 비활동 일시 중지 | 프로젝트 Paused | 대시보드에서 재개. 기기 데이터는 안전 |
| Vercel 한도 | Usage 알림 | 정적 자산이라 가능성 낮음 |

결제 수단을 등록하지 않은 Free 플랜은 초과 요금 대신 제한될 것으로 보지만, 한도 초과 시 구체적인 제한 방식(읽기 전용 전환·중지 등)은 이번에 공식 문서로 확인하지 못했다 [미확인]. 서비스 중단 가능성을 이용약관에 명시했다(`src/ui/LegalPages.tsx`). 유료 플랜·결제 수단 등록은 승인 대상이다.
