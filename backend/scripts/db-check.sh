#!/usr/bin/env bash
# 실제 MySQL 연결 확인 (읽기 전용: 테이블 생성·데이터 변경 없음).
#   backend 폴더에서: bash scripts/db-check.sh
# 접속 정보: backend/local.env (git 에 올라가지 않음)의 DB_URL·DB_USER.
# 비밀번호: DB_PASSWORD 를 local.env 에 적거나, Windows 사용자 환경변수 DB_PASSWORD 로 설정한다.
set -euo pipefail
cd "$(dirname "$0")/.."
# 이미 환경변수로 넣은 비밀번호는 local.env 의 빈 줄이 덮어쓰지 않게 보존한다
ENV_DB_PASSWORD="${DB_PASSWORD:-}"
if [ -f local.env ]; then set -a; . ./local.env; set +a; fi
[ -n "${DB_PASSWORD:-}" ] || DB_PASSWORD="$ENV_DB_PASSWORD"
export DB_PASSWORD
# local.env 에 비밀번호가 없으면 Windows 사용자 환경변수에서 읽는다 (새 터미널을 열지 않아도 되도록)
if [ -z "${DB_PASSWORD:-}" ] && command -v powershell >/dev/null 2>&1; then
  DB_PASSWORD="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('DB_PASSWORD','User')" | tr -d '\r')"
  export DB_PASSWORD
fi
[ -n "${DATABASE_URL:-}" ] || [ -n "${DB_URL:-}" ] || { echo "DB_URL 이 없습니다 (backend/local.env)"; exit 1; }
[ -n "${DATABASE_URL:-}" ] || [ -n "${DB_PASSWORD:-}" ] || { echo "DB_PASSWORD 가 없습니다 (local.env 또는 Windows 사용자 환경변수)"; exit 1; }
DB_CONNECTION_CHECK=true ./mvnw -B test -Dtest=MysqlConnectionCheckTest -Dsurefire.failIfNoSpecifiedTests=false "$@"
