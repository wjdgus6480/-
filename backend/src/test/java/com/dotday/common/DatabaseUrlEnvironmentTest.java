package com.dotday.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;
import org.junit.jupiter.api.Test;

class DatabaseUrlEnvironmentTest {

  @Test
  void Aiven_Service_URI_를_JDBC_설정으로_바꾸고_TLS_를_켠다() {
    Map<String, Object> p = DatabaseUrlEnvironment.toDatasourceProperties(
        "mysql://avnadmin:p%40ss%2Fw0rd@mysql-abc.aivencloud.com:23456/defaultdb?ssl-mode=REQUIRED");
    assertThat(p.get("spring.datasource.url")).isEqualTo("jdbc:mysql://mysql-abc.aivencloud.com:23456/defaultdb?sslMode=REQUIRED");
    assertThat(p.get("spring.datasource.username")).isEqualTo("avnadmin");
    assertThat(p.get("spring.datasource.password")).isEqualTo("p@ss/w0rd");
  }

  @Test
  void 포트와_DB_이름이_없으면_기본값() {
    Map<String, Object> p = DatabaseUrlEnvironment.toDatasourceProperties("mysql://u:p@db.example.com");
    assertThat(p.get("spring.datasource.url")).isEqualTo("jdbc:mysql://db.example.com:3306/defaultdb?sslMode=REQUIRED");
  }

  @Test
  void 비밀번호의_더하기_기호를_공백으로_바꾸지_않는다() {
    assertThat(DatabaseUrlEnvironment.toDatasourceProperties("mysql://u:a+b@h:1/d").get("spring.datasource.password")).isEqualTo("a+b");
  }

  @Test
  void mysql_이_아닌_주소는_거부한다() {
    assertThatThrownBy(() -> DatabaseUrlEnvironment.toDatasourceProperties("postgres://u:p@h:5432/d")).isInstanceOf(IllegalStateException.class);
  }

  @Test
  void 원격_MySQL_주소에_SSL_설정이_없으면_REQUIRED_를_붙인다() {
    assertThat(DatabaseUrlEnvironment.requireSsl("jdbc:mysql://mysql-x.aivencloud.com:19070/defaultdb"))
        .isEqualTo("jdbc:mysql://mysql-x.aivencloud.com:19070/defaultdb?sslMode=REQUIRED");
    assertThat(DatabaseUrlEnvironment.requireSsl("jdbc:mysql://h:1/d?connectTimeout=5000"))
        .isEqualTo("jdbc:mysql://h:1/d?connectTimeout=5000&sslMode=REQUIRED");
    // 이미 지정했거나, 이 PC 의 MySQL 이거나, MySQL 이 아니면 그대로
    assertThat(DatabaseUrlEnvironment.requireSsl("jdbc:mysql://h:1/d?sslMode=VERIFY_CA")).isEqualTo("jdbc:mysql://h:1/d?sslMode=VERIFY_CA");
    assertThat(DatabaseUrlEnvironment.requireSsl("jdbc:mysql://localhost:3306/dotday")).isEqualTo("jdbc:mysql://localhost:3306/dotday");
    assertThat(DatabaseUrlEnvironment.requireSsl("jdbc:h2:mem:x")).isEqualTo("jdbc:h2:mem:x");
  }
}
