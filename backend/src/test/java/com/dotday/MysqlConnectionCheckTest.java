package com.dotday;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 실제 MySQL 연결 확인 (읽기 전용). 평소 테스트에서는 건너뛰고 DB_CONNECTION_CHECK=true 일 때만 실행한다.
 *   bash scripts/db-check.sh
 * - application.yml 의 실제 DB 설정(DB_URL·DB_USER·DB_PASSWORD 또는 DATABASE_URL)을 그대로 쓴다.
 * - Flyway 를 끄므로 테이블을 만들거나 바꾸지 않는다. SELECT·SHOW 만 실행한다 (데이터 변경 없음).
 */
@JdbcTest(properties = "spring.flyway.enabled=false")
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@EnabledIfEnvironmentVariable(named = "DB_CONNECTION_CHECK", matches = "true")
class MysqlConnectionCheckTest {
  @Autowired JdbcTemplate jdbc;

  @Test
  void MySQL_에_SSL_로_연결된다() {
    String version = jdbc.queryForObject("select version()", String.class);
    String db = jdbc.queryForObject("select database()", String.class);
    String user = jdbc.queryForObject("select current_user()", String.class);
    Map<String, Object> cipher = jdbc.queryForMap("show session status like 'Ssl_cipher'");
    Map<String, Object> tls = jdbc.queryForMap("show session status like 'Ssl_version'");
    List<String> tables = jdbc.queryForList(
        "select table_name from information_schema.tables where table_schema = database() order by table_name", String.class);

    System.out.println("[DB-CHECK] MySQL version : " + version);
    System.out.println("[DB-CHECK] database      : " + db);
    System.out.println("[DB-CHECK] user          : " + user);
    System.out.println("[DB-CHECK] TLS           : " + tls.get("Value") + " / " + cipher.get("Value"));
    System.out.println("[DB-CHECK] tables (" + tables.size() + ")   : " + tables);
    // 설계에 영향을 주는 서버 설정 (모두 읽기 전용 조회)
    System.out.println("[DB-CHECK] schemas       : " + jdbc.queryForList("select schema_name from information_schema.schemata order by schema_name", String.class));
    System.out.println("[DB-CHECK] db charset    : " + jdbc.queryForMap(
        "select default_character_set_name cs, default_collation_name co from information_schema.schemata where schema_name = database()"));
    System.out.println("[DB-CHECK] settings      : " + jdbc.queryForMap(
        "select @@global.time_zone gtz, @@session.time_zone stz, @@sql_require_primary_key req_pk, @@default_storage_engine engine,"
            + " @@lower_case_table_names lctn, @@innodb_default_row_format row_fmt"));
    System.out.println("[DB-CHECK] sql_mode      : " + jdbc.queryForObject("select @@sql_mode", String.class));
    System.out.println("[DB-CHECK] privileges    : " + jdbc.queryForList("show grants", String.class).stream().map(g -> g.length() > 160 ? g.substring(0, 160) + "…" : g).toList());
    for (String t : tables) {
      Long rows = jdbc.queryForObject("select count(*) from `" + t.replace("`", "") + "`", Long.class);
      System.out.println("[DB-CHECK]   " + t + " rows=" + rows);
    }
    System.out.println("[DB-CHECK] flyway history: " + (tables.contains("flyway_schema_history") ? "있음" : "없음 (마이그레이션 적용 기록 없음)"));
    System.out.println("[DB-CHECK] PK/UNIQUE     : " + jdbc.queryForList(
        "select concat(table_name, '.', constraint_name, '(', constraint_type, ')') from information_schema.table_constraints where table_schema = database() and constraint_type in ('PRIMARY KEY', 'UNIQUE') order by 1", String.class));
    System.out.println("[DB-CHECK] FK            : " + jdbc.queryForList(
        "select concat(table_name, '.', column_name, ' -> ', referenced_table_name, '.', referenced_column_name) from information_schema.key_column_usage where table_schema = database() and referenced_table_name is not null order by 1", String.class));
    System.out.println("[DB-CHECK] indexes       : " + jdbc.queryForList(
        "select distinct concat(table_name, '.', index_name) from information_schema.statistics where table_schema = database() order by 1", String.class));
    System.out.println("[DB-CHECK] views/routines: " + jdbc.queryForObject(
        "select concat((select count(*) from information_schema.views where table_schema = database()), ' views, ', (select count(*) from information_schema.routines where routine_schema = database()), ' routines, ', (select count(*) from information_schema.triggers where trigger_schema = database()), ' triggers')", String.class));

    assertThat(version).startsWith("8.");
    // SSL REQUIRED: 암호화되지 않은 연결이면 cipher 가 빈 문자열
    assertThat(String.valueOf(cipher.get("Value"))).isNotBlank();
  }
}
