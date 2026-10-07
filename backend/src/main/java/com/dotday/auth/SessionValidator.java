package com.dotday.auth;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;

/** 토큰의 세션(sid)이 로그아웃·탈퇴되지 않았는지 확인한다. 실패하면 401. */
@Component
public class SessionValidator implements OAuth2TokenValidator<Jwt> {
  private static final OAuth2Error REVOKED = new OAuth2Error("invalid_token", "session_not_found", null);

  private final JdbcTemplate jdbc;

  public SessionValidator(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  public OAuth2TokenValidatorResult validate(Jwt jwt) {
    String sid = jwt.getClaimAsString("sid");
    String sub = jwt.getSubject();
    if (sid == null || sub == null) return OAuth2TokenValidatorResult.failure(REVOKED);
    Integer n = jdbc.queryForObject(
        "select count(*) from auth_sessions where id = ? and user_id = ? and revoked_at is null", Integer.class, sid, sub);
    return n != null && n == 1 ? OAuth2TokenValidatorResult.success() : OAuth2TokenValidatorResult.failure(REVOKED);
  }
}
