#!/usr/bin/env bash
# 실제 MySQL 에서 서버 테스트 전체(JUnit)를 실행한다. H2 와 MySQL 의 차이를 잡기 위한 검증용.
#   1) backend/local.env 에 TEST_DATABASE_URL=mysql://사용자:비밀번호@호스트:포트/dotday_test 를 적는다 (git 에 올라가지 않음)
#      운영 DB(defaultdb)와 섞이지 않도록 테스트 전용 DB 를 쓴다 (Aiven 콘솔 → Databases → Create database)
#   2) backend 폴더에서: bash scripts/mysql-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f local.env ] || { echo "backend/local.env 가 없습니다 (TEST_DATABASE_URL 필요)"; exit 1; }
set -a; . ./local.env; set +a
[ -n "${TEST_DATABASE_URL:-}" ] || { echo "local.env 에 TEST_DATABASE_URL 이 없습니다"; exit 1; }
DATABASE_URL="$TEST_DATABASE_URL" ./mvnw -B test "$@"
