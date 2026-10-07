# DOTDAY 복구 절차

## 백업 위치
| 대상 | 위치 | 비고 |
|---|---|---|
| 코드·설정 전체 | `Desktop\DOTDAY_backups\dotday_full_YYYYMMDD_HHMM.zip` | `.env`·`.env.local`·`.vercel` 포함 (**비밀 포함, 공유 금지**). 2026-10-05 08:41 백업은 76/76 파일 해시 일치 복원 확인 |
| 코드 이력 | 로컬 Git (`main`), 태그 `v0.4.2-prod` = 현재 Production 코드 (2026-10-05 공개 번들과 바이트 일치 확인, `docs/public/07_REMOTE_AUDIT.md` §2). `v0.4.1-baseline` = 그 이전 Production | 원격 저장소는 아직 없음 |
| 업무 데이터 (기기) | 앱 설정 › 업무 데이터 내보내기 (.json) | 기기마다 IndexedDB 에 있음 |
| 업무 데이터 (서버) | Supabase 대시보드 › Table Editor › Export CSV, 또는 `supabase db dump` (DB 비밀번호 필요, 사용자가 직접 실행) | 무료 플랜 자동 백업 여부는 대시보드 Database › Backups 에서 확인 |

## 1. 배포 되돌리기 (가장 빠름, 코드·DB 변경 없음)
현재 Production (2026-10-07): 별칭 `dotday-silk.vercel.app` → `dotday-pjj91kf64-dotday.vercel.app` = 커밋 `bf042e4` (Stitch 사이드바·카드·월간 보기), `VITE_API_URL=https://dotday-api.onrender.com` (Render `dotday-api`, Aiven MySQL). 운영 서버 대상 E2E(`tests/e2e.backend.test.ts`) 통과. CLI 배포 시 `.vercelignore` 가 `.env`(localhost 주소)를 막는다.
직전 Production: `dotday-i1mw7evkr-dotday.vercel.app` (`c5b7150`, Render API 연결 첫 배포). 그 전: `dotday-gl0ttr55c` (로컬 전용 모드), `dotday-8ldlwners-dotday.vercel.app` = `v0.4.2-prod` (Supabase 버전).

```bash
npx vercel ls dotday --scope dotday
```
```bash
npx vercel rollback <되돌릴 배포 URL> --scope dotday
```
또는 Vercel 대시보드 › Deployments › 이전 배포 › **Promote to Production**.

- Hobby(무료) 플랜의 Instant Rollback 은 **바로 이전 Production 배포로만** 가능하다 ([Vercel 문서](https://vercel.com/docs/instant-rollback)). 그보다 오래된 배포는 `npx vercel promote <배포 URL> --scope dotday` 로 되돌린다.
- 롤백하면 Production 도메인 자동 할당이 꺼진다. 이후 새 배포를 올리려면 `vercel promote` 로 해제한다.
- 롤백은 환경변수를 바꾸지 않는다 (그 배포가 빌드될 때의 값 사용).

### 환경변수 (2026-10-05 등록)
Vercel 프로젝트 Production 에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`(공개용 publishable key) 등록. `.env` 없는 깨끗한 복제본에서 `vercel pull` → `vercel build --prod` 로 두 값이 번들에 들어가고 비밀 키는 없음을 확인함. **secret / service_role 키는 등록 금지.**

## 2. 코드 되돌리기
```bash
git log --oneline
```
```bash
git switch -c restore v0.4.1-baseline
```
그 뒤 빌드·배포:
```bash
npx vercel build --prod --yes
```
```bash
npx vercel deploy --prebuilt --prod
```
빌드는 이 PC 의 `.env`(Supabase URL + **공개용** publishable key)를 사용한다. `.env` 가 없으면 `.env.example` 을 복사해 값을 다시 넣는다(대시보드 › Project Settings › API Keys).

## 3. 전체 폴더 복구
1. 백업 zip 을 새 폴더에 압축 해제
2. `npm ci`
3. `npm test` → `npm run build`

## 4. 데이터 복구
- 기기 데이터: 설정 › 업무 데이터 가져오기 (가져오기 전 자동 백업, 잘못된 파일은 전체 거부)
- 서버 DB 구조: `supabase/remote_setup_0001_0004.sql` (빈 프로젝트에서만 실행, 테이블이 있으면 스스로 중단)

## 5. 권한 강화(0006·0007) 되돌리기 — 적용한 경우에만
- `supabase/remote_rollback_0006_0007.sql` 을 SQL Editor 에서 실행 (데이터 행은 바뀌지 않음, 앱이 쓰는 권한으로 복귀).
- 적용 전과 똑같이 되돌리려면 적용 전에 `supabase/remote_inspect_readonly.sql` [2-b] 로 저장한 GRANT 문을 이어서 실행.
- 탈퇴 RPC 로 삭제된 계정·데이터는 롤백되지 않는다 (CSV 백업으로만 복구).

## 주의
- 앱은 로그아웃·인증 실패 때 기기 데이터와 미전송 대기열을 지우지 않는다. 브라우저 사이트 데이터를 직접 삭제하면 미전송 변경은 사라진다.
- `service_role`/secret 키는 어디에도 저장하지 않는다.
