package com.dotday;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.dotday.common.Times;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class AuthApiTest extends ApiTestBase {

  @Test
  void 가입하면_바로_로그인되고_me로_본인을_확인한다() throws Exception {
    Session s = signUp();
    JsonNode me = body(getAs(s, "/api/auth/me"));
    assertThat(me.get("id").asText()).isEqualTo(s.userId());
    assertThat(me.get("email").asText()).isEqualTo(s.email());
  }

  @Test
  void 토큰이_없거나_위조되면_401() throws Exception {
    assertThat(mvc.perform(get("/api/auth/me")).andReturn().getResponse().getStatus()).isEqualTo(401);
    assertThat(getAs(new Session("not-a-jwt", "", ""), "/api/auth/me").getResponse().getStatus()).isEqualTo(401);
  }

  @Test
  void 같은_이메일로_다시_가입하면_409() throws Exception {
    Session s = signUp();
    var r = postJson(null, "/api/auth/signup", Map.of("email", s.email().toUpperCase(), "password", "secret123"));
    assertThat(r.getResponse().getStatus()).isEqualTo(409);
    assertThat(body(r).get("code").asText()).isEqualTo("user_already_exists");
  }

  @Test
  void 약한_비밀번호와_잘못된_이메일은_거부한다() throws Exception {
    assertThat(body(postJson(null, "/api/auth/signup", Map.of("email", "a@b.co", "password", "123"))).get("code").asText()).isEqualTo("weak_password");
    assertThat(body(postJson(null, "/api/auth/signup", Map.of("email", "nope", "password", "secret123"))).get("code").asText()).isEqualTo("email_address_invalid");
  }

  @Test
  void 틀린_비밀번호는_400_invalid_credentials_이고_반복하면_잠긴다() throws Exception {
    Session s = signUp();
    for (int i = 0; i < 10; i++) {
      var r = postJson(null, "/api/auth/login", Map.of("email", s.email(), "password", "wrong-pass"));
      assertThat(r.getResponse().getStatus()).isEqualTo(400);
      assertThat(body(r).get("code").asText()).isEqualTo("invalid_credentials");
    }
    // 맞는 비밀번호도 잠금 시간 동안은 거부
    var locked = postJson(null, "/api/auth/login", Map.of("email", s.email(), "password", "secret123"));
    assertThat(locked.getResponse().getStatus()).isEqualTo(429);
  }

  @Test
  void 이_기기_로그아웃은_그_세션만_끊는다() throws Exception {
    Session a = signUp();
    Session b = login(a.email(), "secret123");
    assertThat(postJson(a, "/api/auth/logout", Map.of()).getResponse().getStatus()).isEqualTo(204);
    assertThat(getAs(a, "/api/auth/me").getResponse().getStatus()).isEqualTo(401);
    assertThat(getAs(b, "/api/auth/me").getResponse().getStatus()).isEqualTo(200);
  }

  @Test
  void 모든_기기_로그아웃은_모든_세션을_끊는다() throws Exception {
    Session a = signUp();
    Session b = login(a.email(), "secret123");
    postJson(a, "/api/auth/logout-all", Map.of());
    assertThat(getAs(a, "/api/auth/me").getResponse().getStatus()).isEqualTo(401);
    assertThat(getAs(b, "/api/auth/me").getResponse().getStatus()).isEqualTo(401);
  }

  @Test
  void 비밀번호_변경은_현재_비밀번호가_필요하다() throws Exception {
    Session s = signUp();
    var wrong = mvc.perform(put("/api/auth/password").header("Authorization", "Bearer " + s.token()).contentType(MediaType.APPLICATION_JSON)
        .content(json.writeValueAsString(Map.of("current_password", "nope-nope", "new_password", "newsecret1")))).andReturn();
    assertThat(wrong.getResponse().getStatus()).isEqualTo(400);
    var same = mvc.perform(put("/api/auth/password").header("Authorization", "Bearer " + s.token()).contentType(MediaType.APPLICATION_JSON)
        .content(json.writeValueAsString(Map.of("current_password", "secret123", "new_password", "secret123")))).andReturn();
    assertThat(body(same).get("code").asText()).isEqualTo("same_password");
    var ok = mvc.perform(put("/api/auth/password").header("Authorization", "Bearer " + s.token()).contentType(MediaType.APPLICATION_JSON)
        .content(json.writeValueAsString(Map.of("current_password", "secret123", "new_password", "newsecret1")))).andReturn();
    assertThat(ok.getResponse().getStatus()).isEqualTo(204);
    assertThat(postJson(null, "/api/auth/login", Map.of("email", s.email(), "password", "newsecret1")).getResponse().getStatus()).isEqualTo(200);
  }

  @Test
  void 탈퇴는_최근_로그인이_필요하고_본인_데이터만_지운다() throws Exception {
    Session a = signUp();
    Session other = signUp();
    String pid = uuid();
    pushDomain(a, uuid(), "projects", pid, 0, Map.of("name", "A 프로젝트"));
    String otherPid = uuid();
    pushDomain(other, uuid(), "projects", otherPid, 0, Map.of("name", "B 프로젝트"));

    // 마지막 로그인이 오래되면 재인증 요구
    jdbc.update("update users set last_sign_in_at = ? where id = ?", Times.now().minusHours(1), a.userId());
    assertThat(body(postJson(a, "/api/account/delete", Map.of("confirm", "DELETE"))).get("status").asText()).isEqualTo("reauth_required");
    assertThat(body(postJson(a, "/api/account/delete", Map.of("confirm", "nope"))).get("reason").asText()).isEqualTo("confirm_required");

    // 알림·설정도 함께 지워져야 한다 (고아 데이터 없음)
    String eid = uuid();
    pushDomain(a, uuid(), "events", eid, 0, Map.of("title", "회의", "start_at", "2026-10-08T01:00:00Z", "end_at", "2026-10-08T02:00:00Z"));
    jdbc.update("insert into reminders (id, owner_id, event_id, remind_before_minutes, created_at, updated_at, server_seq) values (?, ?, ?, 10, ?, ?, 999)",
        uuid(), a.userId(), eid, Times.now(), Times.now());
    jdbc.update("insert into user_settings (user_id, created_at, updated_at) values (?, ?, ?)", a.userId(), Times.now(), Times.now());

    // 비밀번호로 재인증 → 탈퇴
    assertThat(postJson(a, "/api/auth/reauth", Map.of("password", "secret123")).getResponse().getStatus()).isEqualTo(204);
    assertThat(body(postJson(a, "/api/account/delete", Map.of("confirm", "DELETE"))).get("status").asText()).isEqualTo("deleted");

    assertThat(jdbc.queryForObject("select count(*) from users where id = ?", Integer.class, a.userId())).isZero();
    assertThat(jdbc.queryForObject("select count(*) from projects where owner_id = ?", Integer.class, a.userId())).isZero();
    for (String t : java.util.List.of("events", "reminders", "auth_sessions"))
      assertThat(jdbc.queryForObject("select count(*) from " + t + " where " + (t.equals("auth_sessions") ? "user_id" : "owner_id") + " = ?", Integer.class, a.userId())).as(t).isZero();
    assertThat(jdbc.queryForObject("select count(*) from user_settings where user_id = ?", Integer.class, a.userId())).isZero();
    assertThat(jdbc.queryForObject("select count(*) from projects where id = ?", Integer.class, otherPid)).isEqualTo(1);
    // 지운 계정의 토큰은 더 이상 쓸 수 없다
    assertThat(getAs(a, "/api/auth/me").getResponse().getStatus()).isEqualTo(401);
  }

  @Test
  void 관리자는_지정을_해제하기_전에는_탈퇴할_수_없다() throws Exception {
    Session a = signUp();
    jdbc.update("insert into app_admins (user_id, note, granted_at) values (?, 'owner', ?)", a.userId(), Times.now());
    assertThat(body(postJson(a, "/api/account/delete", Map.of("confirm", "DELETE"))).get("reason").asText()).isEqualTo("admin_account");
  }

  @Test
  void 허용된_프론트_주소만_CORS_를_통과한다() throws Exception {
    var ok = mvc.perform(options("/api/auth/login").header("Origin", "http://localhost:5173").header("Access-Control-Request-Method", "POST")).andReturn();
    assertThat(ok.getResponse().getHeader("Access-Control-Allow-Origin")).isEqualTo("http://localhost:5173");
    var bad = mvc.perform(options("/api/auth/login").header("Origin", "https://evil.example").header("Access-Control-Request-Method", "POST")).andReturn();
    assertThat(bad.getResponse().getHeader("Access-Control-Allow-Origin")).isNull();
  }

  private Session login(String email, String password) throws Exception {
    JsonNode r = body(postJson(null, "/api/auth/login", Map.of("email", email, "password", password)));
    return new Session(r.get("access_token").asText(), r.get("user").get("id").asText(), email);
  }
}
