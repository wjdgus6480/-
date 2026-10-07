package com.dotday.auth;

import com.dotday.common.ApiException;
import com.dotday.common.AppProperties;
import com.dotday.common.Ids;
import com.dotday.common.Times;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {
  private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");
  private static final String USER_COLS = "select id, email, password_hash, last_sign_in_at from users ";

  public record UserInfo(String id, String email) {}

  public record SessionToken(String accessToken, Instant expiresAt, UserInfo user) {}

  private record UserRow(String id, String email, String passwordHash, LocalDateTime lastSignInAt) {}

  private static final RowMapper<UserRow> USER_ROW = (rs, i) -> {
    Object last = rs.getObject(4);
    return new UserRow(rs.getString(1), rs.getString(2), rs.getString(3), last == null ? null : Times.fromDb(last));
  };

  private final JdbcTemplate jdbc;
  private final PasswordEncoder encoder;
  private final JwtEncoder jwtEncoder;
  private final AppProperties props;
  private final LoginRateLimiter limiter;
  /** 없는 계정에도 같은 시간이 걸리도록 비교할 해시 (계정 존재 여부를 응답 시간으로 드러내지 않음) */
  private final String dummyHash;

  public AuthService(JdbcTemplate jdbc, PasswordEncoder encoder, JwtEncoder jwtEncoder, AppProperties props, LoginRateLimiter limiter) {
    this.jdbc = jdbc;
    this.encoder = encoder;
    this.jwtEncoder = jwtEncoder;
    this.props = props;
    this.limiter = limiter;
    this.dummyHash = encoder.encode(Ids.random());
  }

  @Transactional
  public SessionToken signUp(String rawEmail, String password) {
    String email = normalizeEmail(rawEmail);
    checkPassword(password);
    String id = Ids.random();
    LocalDateTime now = Times.now();
    try {
      jdbc.update("insert into users (id, email, password_hash, created_at, updated_at, last_sign_in_at) values (?, ?, ?, ?, ?, ?)",
          id, email, encoder.encode(password), now, now, now);
    } catch (DuplicateKeyException e) {
      throw new ApiException(HttpStatus.CONFLICT, "user_already_exists", "이미 가입된 이메일입니다.");
    }
    return openSession(new UserInfo(id, email));
  }

  @Transactional
  public SessionToken signIn(String rawEmail, String password) {
    String email = normalizeEmail(rawEmail);
    UserRow u = verify(email, password);
    jdbc.update("update users set last_sign_in_at = ? where id = ?", Times.now(), u.id());
    return openSession(new UserInfo(u.id(), u.email()));
  }

  /** 탈퇴 전 재인증: 비밀번호를 확인하고 '최근 로그인 시각'을 갱신한다. 새 세션은 만들지 않는다. */
  @Transactional
  public void reauthenticate(CurrentUser cu, String password) {
    verify(findUser(cu.id()).email(), password);
    jdbc.update("update users set last_sign_in_at = ? where id = ?", Times.now(), cu.id());
  }

  @Transactional
  public void changePassword(CurrentUser cu, String currentPassword, String newPassword) {
    UserRow u = verify(findUser(cu.id()).email(), currentPassword);
    checkPassword(newPassword);
    if (encoder.matches(newPassword, u.passwordHash())) throw new ApiException(HttpStatus.BAD_REQUEST, "same_password", "이전과 같은 비밀번호입니다.");
    jdbc.update("update users set password_hash = ?, updated_at = ? where id = ?", encoder.encode(newPassword), Times.now(), cu.id());
  }

  public UserInfo me(CurrentUser cu) {
    UserRow u = findUser(cu.id());
    return new UserInfo(u.id(), u.email());
  }

  /** 이 기기만 로그아웃 */
  public void signOut(CurrentUser cu) {
    jdbc.update("update auth_sessions set revoked_at = ? where id = ? and user_id = ? and revoked_at is null", Times.now(), cu.sessionId(), cu.id());
  }

  /** 모든 기기 로그아웃: 이 사용자의 모든 세션을 끊는다 (다음 요청부터 401) */
  public void signOutAll(CurrentUser cu) {
    jdbc.update("update auth_sessions set revoked_at = ? where user_id = ? and revoked_at is null", Times.now(), cu.id());
  }

  /**
   * 본인 계정 탈퇴. 인자로 사용자 ID 를 받지 않는다 → 다른 회원은 지울 수 없다.
   * 최근 로그인(reauth-window) 안에서만 허용하고, 관리자는 먼저 지정을 해제해야 한다.
   * 한 트랜잭션에서 지우므로 중간에 실패하면 전부 되돌아간다.
   */
  @Transactional
  public Map<String, Object> deleteAccount(CurrentUser cu, String confirm) {
    if (!"DELETE".equals(confirm)) return Map.of("status", "rejected", "reason", "confirm_required");
    List<UserRow> rows = jdbc.query(USER_COLS + "where id = ? for update", USER_ROW, cu.id());
    if (rows.isEmpty()) return Map.of("status", "not_found");
    LocalDateTime last = rows.get(0).lastSignInAt();
    if (last == null || last.isBefore(Times.now().minus(props.reauthWindow()))) return Map.of("status", "reauth_required");
    Integer admin = jdbc.queryForObject("select count(*) from app_admins where user_id = ?", Integer.class, cu.id());
    if (admin != null && admin > 0) return Map.of("status", "rejected", "reason", "admin_account");
    // 참조 순서대로 지운다 (외래키 ON DELETE CASCADE 도 있지만, DB 마다 연쇄 동작 차이가 없도록 명시)
    for (String sql : List.of(
        "delete from domain_ops where owner_id = ?",
        "delete from view_preference_ops where owner_id = ?",
        "delete from view_preferences where owner_id = ?",
        "delete from reminders where owner_id = ?",
        "delete from todos where owner_id = ?",
        "delete from events where owner_id = ? and recurrence_parent_id is not null",
        "delete from events where owner_id = ?",
        "delete from projects where owner_id = ?",
        "delete from categories where owner_id = ?",
        "delete from user_settings where user_id = ?",
        "delete from auth_sessions where user_id = ?",
        "delete from users where id = ?"))
      jdbc.update(sql, cu.id());
    return Map.of("status", "deleted");
  }

  // ---------- 내부 ----------

  private SessionToken openSession(UserInfo user) {
    String sid = Ids.random();
    jdbc.update("insert into auth_sessions (id, user_id, created_at) values (?, ?, ?)", sid, user.id(), Times.now());
    Instant now = Instant.now();
    Instant exp = now.plus(props.tokenTtl());
    JwtClaimsSet claims = JwtClaimsSet.builder()
        .issuer("dotday")
        .subject(user.id())
        .issuedAt(now)
        .expiresAt(exp)
        .claim("sid", sid)
        .claim("email", user.email())
        .build();
    String token = jwtEncoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
    return new SessionToken(token, exp, user);
  }

  /** 비밀번호 확인 + 대입 시도 제한 (같은 이메일 기준) */
  private UserRow verify(String email, String password) {
    if (limiter.blocked(email)) throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "over_request_rate_limit", "요청이 너무 많습니다.");
    List<UserRow> rows = jdbc.query(USER_COLS + "where email = ?", USER_ROW, email);
    UserRow u = rows.isEmpty() ? null : rows.get(0);
    boolean ok = encoder.matches(password == null ? "" : password, u == null ? dummyHash : u.passwordHash());
    if (u == null || !ok) {
      limiter.fail(email);
      throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_credentials", "이메일 또는 비밀번호가 맞지 않습니다.");
    }
    limiter.reset(email);
    return u;
  }

  private UserRow findUser(String id) {
    List<UserRow> rows = jdbc.query(USER_COLS + "where id = ?", USER_ROW, id);
    if (rows.isEmpty()) throw new ApiException(HttpStatus.UNAUTHORIZED, "session_not_found", "로그인 세션이 만료되었습니다.");
    return rows.get(0);
  }

  static String normalizeEmail(String raw) {
    String email = raw == null ? "" : raw.trim().toLowerCase();
    if (email.length() > 320 || !EMAIL.matcher(email).matches())
      throw new ApiException(HttpStatus.BAD_REQUEST, "email_address_invalid", "사용할 수 없는 이메일 주소입니다.");
    return email;
  }

  /** 6자 이상. BCrypt 는 72바이트까지만 쓰므로 그 이상은 거부한다. */
  static void checkPassword(String password) {
    if (password == null || password.length() < 6 || password.getBytes(StandardCharsets.UTF_8).length > 72)
      throw new ApiException(HttpStatus.BAD_REQUEST, "weak_password", "비밀번호는 6자 이상, 72바이트 이하여야 합니다.");
  }
}
