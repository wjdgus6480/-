#!/usr/bin/env bash
# 실제 MySQL 에서 서버 테스트 전체(JUnit)를 실행한다. H2 와 MySQL 의 차이를 잡기 위한 검증용.
#   backend 폴더에서: bash scripts/mysql-test.sh
# 접속 정보: backend/local.env (git 에 올라가지 않음)
#   - TEST_DATABASE_URL=mysql://사용자:비밀번호@호스트:포트/dotday_test 가 있으면 그것을 쓴다.
#   - 없으면 DB_URL·DB_USER·DB_PASSWORD 의 호스트에 테스트 전용 DB(dotday_test)를 자동으로 만들어 쓴다.
#     DB_PASSWORD 는 local.env 또는 Windows 사용자 환경변수에서 읽는다 (db-check.sh 와 같음).
# 운영 DB(defaultdb)와 섞이지 않도록 항상 테스트 전용 DB 를 쓴다.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f local.env ] || { echo "backend/local.env 가 없습니다"; exit 1; }
ENV_DB_PASSWORD="${DB_PASSWORD:-}"
set -a; . ./local.env; set +a
[ -n "${DB_PASSWORD:-}" ] || DB_PASSWORD="$ENV_DB_PASSWORD"
if [ -z "${DB_PASSWORD:-}" ] && command -v powershell >/dev/null 2>&1; then
  DB_PASSWORD="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('DB_PASSWORD','User')" | tr -d '\r')"
fi
# 운영 접속용 DATABASE_URL 이 테스트 설정을 덮어쓰지 않게 비운다
unset DATABASE_URL

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  MYSQL_TEST=true DATABASE_URL="$TEST_DATABASE_URL" ./mvnw -B test "$@"
  exit
fi

[ -n "${DB_URL:-}" ] || { echo "local.env 에 TEST_DATABASE_URL 또는 DB_URL 이 없습니다"; exit 1; }
[ -n "${DB_PASSWORD:-}" ] || { echo "DB_PASSWORD 가 없습니다 (local.env 또는 Windows 사용자 환경변수)"; exit 1; }
# jdbc:mysql://호스트:포트/DB?옵션 → 같은 호스트의 dotday_test (없으면 드라이버가 만든다)
HOST_PORT="$(printf '%s' "$DB_URL" | sed -E 's#^jdbc:mysql://([^/?]+).*#\1#')"
TEST_DB="${TEST_DB_NAME:-dotday_test}"
echo "[mysql-test] $HOST_PORT / $TEST_DB 에서 테스트를 실행합니다"
# 환경변수는 application-test.yml(H2)보다 우선한다
MYSQL_TEST=true \
SPRING_DATASOURCE_URL="jdbc:mysql://$HOST_PORT/$TEST_DB?sslMode=REQUIRED&createDatabaseIfNotExist=true" \
SPRING_DATASOURCE_USERNAME="${DB_USER:-avnadmin}" \
SPRING_DATASOURCE_PASSWORD="$DB_PASSWORD" \
  ./mvnw -B test "$@"
