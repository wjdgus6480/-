package com.dotday.common;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * DATABASE_URL 환경변수 하나로 MySQL 접속을 설정한다.
 * Aiven 콘솔의 'Service URI' 를 그대로 넣으면 된다:
 *   mysql://avnadmin:비밀번호@mysql-xxx.aivencloud.com:12345/defaultdb?ssl-mode=REQUIRED
 * → spring.datasource.url / username / password 로 바꾼다. TLS 는 항상 켠다(sslMode=REQUIRED).
 * DATABASE_URL 이 없으면 DB_URL·DB_USER·DB_PASSWORD 를 따로 쓴다.
 *
 * 어느 방식이든, 원격 MySQL(localhost 가 아닌 곳)의 JDBC 주소에 sslMode 가 없으면 sslMode=REQUIRED 를 붙인다
 * → 설정을 빠뜨려도 암호화되지 않은 연결로 접속하지 않는다 (Aiven 은 SSL 필수).
 */
public class DatabaseUrlEnvironment implements EnvironmentPostProcessor {

  @Override
  public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication app) {
    String raw = env.getProperty("DATABASE_URL");
    if (raw != null && !raw.isBlank()) {
      env.getPropertySources().addFirst(new MapPropertySource("databaseUrl", toDatasourceProperties(raw.trim())));
      return;
    }
    String url = env.getProperty("spring.datasource.url");
    String secured = requireSsl(url);
    if (secured != null && !secured.equals(url))
      env.getPropertySources().addFirst(new MapPropertySource("datasourceSsl", Map.of("spring.datasource.url", secured)));
  }

  /** 원격 MySQL JDBC 주소에 sslMode 가 없으면 REQUIRED 를 붙인다. MySQL 이 아니거나 이 PC(localhost)면 그대로. */
  static String requireSsl(String url) {
    if (url == null || !url.startsWith("jdbc:mysql://")) return url;
    String rest = url.substring("jdbc:mysql://".length());
    String host = rest.split("[:/?]", 2)[0].toLowerCase();
    if (host.equals("localhost") || host.equals("127.0.0.1")) return url;
    if (url.toLowerCase().contains("sslmode=") || url.toLowerCase().contains("usessl=")) return url;
    return url + (url.contains("?") ? "&" : "?") + "sslMode=REQUIRED";
  }

  static Map<String, Object> toDatasourceProperties(String raw) {
    URI uri = URI.create(raw);
    if (!"mysql".equals(uri.getScheme()) || uri.getHost() == null)
      throw new IllegalStateException("DATABASE_URL 은 mysql://사용자:비밀번호@호스트:포트/DB이름 형식이어야 합니다.");
    String db = uri.getPath() == null || uri.getPath().length() <= 1 ? "defaultdb" : uri.getPath().substring(1);
    int port = uri.getPort() > 0 ? uri.getPort() : 3306;
    Map<String, Object> props = new LinkedHashMap<>();
    props.put("spring.datasource.url", "jdbc:mysql://" + uri.getHost() + ":" + port + "/" + db + "?sslMode=REQUIRED");
    String info = uri.getRawUserInfo();
    if (info != null) {
      int i = info.indexOf(':');
      props.put("spring.datasource.username", decode(i < 0 ? info : info.substring(0, i)));
      if (i >= 0) props.put("spring.datasource.password", decode(info.substring(i + 1)));
    }
    return props;
  }

  private static String decode(String s) {
    return URLDecoder.decode(s.replace("+", "%2B"), StandardCharsets.UTF_8);
  }
}
