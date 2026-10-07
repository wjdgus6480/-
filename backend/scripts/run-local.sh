#!/usr/bin/env bash
# 로컬에서 백엔드 실행 (backend/local.env 의 DB·JWT·CORS 설정 사용). http://localhost:8080
#   backend 폴더에서: bash scripts/run-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f local.env ] || { echo "backend/local.env 가 없습니다"; exit 1; }
# java 가 PATH 에 없으면 사용자 폴더의 휴대용 JDK 21(~/.devtools/jdk)을 쓴다
if ! command -v java >/dev/null 2>&1 && [ -z "${JAVA_HOME:-}" ]; then
  JDK="$(ls -d "$HOME"/.devtools/jdk/jdk-21* 2>/dev/null | head -1)"
  [ -n "$JDK" ] && export JAVA_HOME="$JDK" PATH="$JDK/bin:$PATH"
fi
ENV_DB_PASSWORD="${DB_PASSWORD:-}"
set -a; . ./local.env; set +a
[ -n "${DB_PASSWORD:-}" ] || DB_PASSWORD="$ENV_DB_PASSWORD"
if [ -z "${DB_PASSWORD:-}" ] && command -v powershell >/dev/null 2>&1; then
  DB_PASSWORD="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('DB_PASSWORD','User')" | tr -d '\r')"
fi
export DB_PASSWORD
# 비어 있는 DATABASE_URL 줄이 DB_URL 설정보다 우선하지 않게 한다
[ -n "${DATABASE_URL:-}" ] || unset DATABASE_URL
exec ./mvnw -B spring-boot:run "$@"
