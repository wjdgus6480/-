# legacy/supabase

v0.4 까지 백엔드로 쓰던 Supabase(Postgres + RLS) SQL 입니다. v0.5 부터 운영 서버는 `backend/`(Spring Boot + MySQL)입니다.

- 운영에는 쓰지 않습니다. 새 변경은 `backend/src/main/resources/db/migration/` 에 Flyway 파일로 추가하세요.
- `tests/helpers.ts` 가 이 SQL 을 PGlite 로 실행해 **동기화 엔진 테스트용 에뮬레이터 서버**로 씁니다.
  같은 판정 규칙(applied/conflict/not_found/rejected/retry)을 Java 로 옮긴 것이 `backend/.../sync/DomainOpService.java`, `ViewOpService.java` 입니다.
- `security.*`, `remote.audit-query` 테스트는 이 SQL 자체(Supabase 시절 보안 설정)를 검증합니다. 현재 서버의 격리·권한은 `backend/src/test` 에서 검증합니다.
