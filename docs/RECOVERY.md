# DOTDAY 복구 절차

## 백업 위치
| 대상 | 위치 | 비고 |
|---|---|---|
| 코드·설정 전체 | `Desktop\DOTDAY_backups\dotday_full_YYYYMMDD_HHMM.zip` | `.env`·`.env.local`·`.vercel` 포함 (**비밀 포함, 공유 금지**). 2026-10-05 08:41 백업은 76/76 파일 해시 일치 복원 확인 |
| 코드 이력 | 로컬 Git (`main`), 태그 `v0.4.1-baseline` = 현재 Production 코드 | 원격 저장소는 아직 없음 |
| 업무 데이터 (기기) | 앱 설정 › 업무 데이터 내보내기 (.json) | 기기마다 IndexedDB 에 있음 |
| 업무 데이터 (서버) | Supabase 대시보드 › Table Editor › Export CSV, 또는 `supabase db dump` (DB 비밀번호 필요, 사용자가 직접 실행) | 무료 플랜 자동 백업 여부는 대시보드 Database › Backups 에서 확인 |

## 1. 배포 되돌리기 (가장 빠름, 코드·DB 변경 없음)
현재 Production: `dotday-mnvrtwrbu-dotday.vercel.app` (2026-10-04, 별칭 `dotday-silk.vercel.app`)

```bash
npx vercel ls dotday --scope dotday
```
```bash
npx vercel rollback <되돌릴 배포 URL> --scope dotday
```
또는 Vercel 대시보드 › Deployments › 이전 배포 › **Promote to Production**.

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

## 주의
- 앱은 로그아웃·인증 실패 때 기기 데이터와 미전송 대기열을 지우지 않는다. 브라우저 사이트 데이터를 직접 삭제하면 미전송 변경은 사라진다.
- `service_role`/secret 키는 어디에도 저장하지 않는다.
