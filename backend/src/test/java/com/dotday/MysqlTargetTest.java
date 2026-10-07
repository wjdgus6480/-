package com.dotday;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * scripts/mysql-test.sh 로 돌릴 때만 실행된다 (MYSQL_TEST=true).
 * 설정이 빠져서 H2 로 돌고도 '통과'로 보이는 일이 없도록, 같은 컨텍스트가 실제 MySQL 8 에 붙었는지 확인한다.
 */
@EnabledIfEnvironmentVariable(named = "MYSQL_TEST", matches = "true")
class MysqlTargetTest extends ApiTestBase {
  @Test
  void 테스트가_실제_MySQL_에서_돈다() {
    String version = jdbc.queryForObject("select version()", String.class);
    String db = jdbc.queryForObject("select database()", String.class);
    System.out.println("[MYSQL-TEST] MySQL " + version + " / " + db);
    assertThat(version).startsWith("8.");
    assertThat(db).isNotEqualTo("defaultdb");
  }
}
