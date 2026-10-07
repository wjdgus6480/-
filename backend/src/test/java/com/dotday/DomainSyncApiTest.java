package com.dotday;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class DomainSyncApiTest extends ApiTestBase {

  private static Map<String, Object> event(String title, String start, String end) {
    Map<String, Object> m = new HashMap<>();
    m.put("title", title);
    m.put("description", "");
    m.put("start_at", start);
    m.put("end_at", end);
    m.put("all_day", false);
    m.put("timezone", "Asia/Seoul");
    m.put("recurrence_rule", null);
    m.put("recurrence_parent_id", null);
    m.put("original_start_at", null);
    m.put("is_cancelled", false);
    m.put("project_id", null);
    m.put("category_id", null);
    m.put("deleted_at", null);
    return m;
  }

  @Test
  void 생성_후_수정하면_버전과_server_seq_가_오르고_행이_정규화되어_돌아온다() throws Exception {
    Session s = signUp();
    String id = uuid();
    JsonNode r = pushDomain(s, uuid(), "tasks", id, 0, Map.of("title", "할 일", "due_date", "2026-10-09", "created_at", "2026-10-01T00:00:00.000Z"));
    assertThat(r.get("status").asText()).isEqualTo("applied");
    JsonNode row = r.get("row");
    assertThat(row.get("version").asInt()).isEqualTo(1);
    assertThat(row.get("owner_id").asText()).isEqualTo(s.userId());
    assertThat(row.get("status").asText()).isEqualTo("todo");
    assertThat(row.get("priority").asText()).isEqualTo("medium");
    assertThat(row.get("due_date").asText()).isEqualTo("2026-10-09");
    assertThat(row.get("created_at").asText()).isEqualTo("2026-10-01T00:00:00.000Z");
    assertThat(row.get("completed_at").isNull()).isTrue();
    long seq1 = row.get("server_seq").asLong();

    JsonNode u = pushDomain(s, uuid(), "tasks", id, 1, Map.of("status", "done", "completed_at", "2026-10-02T09:30:00+09:00"));
    assertThat(u.get("status").asText()).isEqualTo("applied");
    assertThat(u.get("row").get("version").asInt()).isEqualTo(2);
    assertThat(u.get("row").get("completed_at").asText()).isEqualTo("2026-10-02T00:30:00.000Z");
    assertThat(u.get("row").get("title").asText()).isEqualTo("할 일");
    assertThat(u.get("row").get("server_seq").asLong()).isGreaterThan(seq1);
    // DB 의 todos.completed 는 status 에서 계산된다 (미완료 조회: completed = false)
    assertThat(jdbc.queryForObject("select completed from todos where id = ?", Boolean.class, id)).isTrue();
    pushDomain(s, uuid(), "tasks", id, 2, Map.of("status", "in_progress", "completed_at", "2026-10-02T09:30:00Z"));
    assertThat(jdbc.queryForObject("select count(*) from todos where owner_id = ? and completed = false", Integer.class, s.userId())).isEqualTo(1);
  }

  @Test
  void 같은_op_id_재전송은_저장된_결과를_돌려주고_두번_적용하지_않는다() throws Exception {
    Session s = signUp();
    String id = uuid();
    String op = uuid();
    JsonNode first = pushDomain(s, op, "projects", id, 0, Map.of("name", "P"));
    JsonNode again = pushDomain(s, op, "projects", id, 0, Map.of("name", "P"));
    assertThat(again.get("duplicate").asBoolean()).isTrue();
    assertThat(again.get("row")).isEqualTo(first.get("row"));
    assertThat(jdbc.queryForObject("select version from projects where id = ?", Integer.class, id)).isEqualTo(1);
  }

  @Test
  void 기준_버전이_다르면_conflict_와_서버_행을_돌려주고_기록하지_않는다() throws Exception {
    Session s = signUp();
    String id = uuid();
    pushDomain(s, uuid(), "projects", id, 0, Map.of("name", "P"));
    pushDomain(s, uuid(), "projects", id, 1, Map.of("name", "P2"));
    String op = uuid();
    JsonNode c = pushDomain(s, op, "projects", id, 1, Map.of("name", "P-stale"));
    assertThat(c.get("status").asText()).isEqualTo("conflict");
    assertThat(c.get("row").get("name").asText()).isEqualTo("P2");
    // 병합 후 같은 op_id 로 재시도 가능
    assertThat(pushDomain(s, op, "projects", id, 2, Map.of("name", "P3")).get("status").asText()).isEqualTo("applied");
  }

  @Test
  void 없는_행을_수정하면_not_found() throws Exception {
    Session s = signUp();
    assertThat(pushDomain(s, uuid(), "projects", uuid(), 3, Map.of("name", "x")).get("status").asText()).isEqualTo("not_found");
  }

  @Test
  void 허용되지_않은_엔티티_키_값은_거부한다() throws Exception {
    Session s = signUp();
    assertThat(pushDomain(s, uuid(), "users", uuid(), 0, Map.of()).get("reason").asText()).isEqualTo("invalid_entity");
    assertThat(pushDomain(s, uuid(), "projects", uuid(), 0, Map.of("name", "x", "owner_id", uuid())).get("reason").asText()).isEqualTo("invalid_patch_key:owner_id");
    assertThat(pushDomain(s, uuid(), "projects", uuid(), 0, Map.of("name", "x", "version", 99)).get("reason").asText()).isEqualTo("invalid_patch_key:version");
    assertThat(pushDomain(s, uuid(), "projects", uuid(), 0, Map.of("name", "   ")).get("reason").asText()).isEqualTo("invalid_data");
    assertThat(pushDomain(s, uuid(), "projects", uuid(), 0, Map.of("name", "x", "status", "weird")).get("reason").asText()).isEqualTo("invalid_data");
    assertThat(pushDomain(s, uuid(), "tasks", uuid(), 0, Map.of("title", "x", "due_date", "not-a-date")).get("reason").asText()).isEqualTo("invalid_data");
    // created_at 은 생성할 때만
    String id = uuid();
    pushDomain(s, uuid(), "projects", id, 0, Map.of("name", "x"));
    assertThat(pushDomain(s, uuid(), "projects", id, 1, Map.of("created_at", "2020-01-01T00:00:00Z")).get("reason").asText()).isEqualTo("invalid_patch_key:created_at");
  }

  @Test
  void 일정_규칙_검사() throws Exception {
    Session s = signUp();
    assertThat(pushDomain(s, uuid(), "events", uuid(), 0, event("역순", "2026-10-02T10:00:00Z", "2026-10-02T09:00:00Z")).get("reason").asText()).isEqualTo("invalid_data");
    Map<String, Object> badRule = event("규칙", "2026-10-02T09:00:00Z", "2026-10-02T10:00:00Z");
    badRule.put("recurrence_rule", "FREQ=HOURLY");
    assertThat(pushDomain(s, uuid(), "events", uuid(), 0, badRule).get("reason").asText()).isEqualTo("invalid_data");

    String parent = uuid();
    Map<String, Object> weekly = event("매주", "2026-10-02T09:00:00Z", "2026-10-02T10:00:00Z");
    weekly.put("recurrence_rule", "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10");
    assertThat(pushDomain(s, uuid(), "events", parent, 0, weekly).get("status").asText()).isEqualTo("applied");

    // 예외 회차: 원본 ID 와 원래 시작 시각이 함께 있어야 한다
    Map<String, Object> half = event("예외", "2026-10-05T09:00:00Z", "2026-10-05T10:00:00Z");
    half.put("recurrence_parent_id", parent);
    assertThat(pushDomain(s, uuid(), "events", uuid(), 0, half).get("reason").asText()).isEqualTo("invalid_data");
    half.put("original_start_at", "2026-10-05T09:00:00Z");
    assertThat(pushDomain(s, uuid(), "events", uuid(), 0, half).get("status").asText()).isEqualTo("applied");
    // 같은 회차의 두 번째 예외는 거부
    assertThat(pushDomain(s, uuid(), "events", uuid(), 0, half).get("reason").asText()).isEqualTo("id_unavailable");
  }

  @Test
  void 참조_대상이_아직_없으면_retry() throws Exception {
    Session s = signUp();
    String pid = uuid();
    JsonNode r = pushDomain(s, uuid(), "tasks", uuid(), 0, Map.of("title", "x", "project_id", pid));
    assertThat(r.get("status").asText()).isEqualTo("retry");
    assertThat(r.get("reason").asText()).isEqualTo("missing_reference:project_id");
    pushDomain(s, uuid(), "projects", pid, 0, Map.of("name", "P"));
    assertThat(pushDomain(s, uuid(), "tasks", uuid(), 0, Map.of("title", "x", "project_id", pid)).get("status").asText()).isEqualTo("applied");
    assertThat(pushDomain(s, uuid(), "tasks", uuid(), 0, Map.of("title", "x", "project_id", "zzz")).get("reason").asText()).isEqualTo("invalid_reference");
  }

  @Test
  void 다른_사용자의_행은_보이지도_바뀌지도_않는다() throws Exception {
    Session a = signUp();
    Session b = signUp();
    String pid = uuid();
    pushDomain(a, uuid(), "projects", pid, 0, Map.of("name", "A 비밀"));

    // 같은 ID 로 생성 시도 → 내용 노출 없이 거부, 수정 시도 → not_found
    JsonNode steal = pushDomain(b, uuid(), "projects", pid, 0, Map.of("name", "B"));
    assertThat(steal.get("status").asText()).isEqualTo("rejected");
    assertThat(steal.get("reason").asText()).isEqualTo("id_unavailable");
    assertThat(steal.has("row")).isFalse();
    assertThat(pushDomain(b, uuid(), "projects", pid, 1, Map.of("name", "B")).get("status").asText()).isEqualTo("not_found");
    // A 의 프로젝트를 참조할 수 없다
    assertThat(pushDomain(b, uuid(), "tasks", uuid(), 0, Map.of("title", "x", "project_id", pid)).get("status").asText()).isEqualTo("retry");
    // 가져오기에도 보이지 않는다
    assertThat(body(getAs(b, "/api/sync/domain/projects?since=0"))).isEmpty();
    assertThat(jdbc.queryForObject("select name from projects where id = ?", String.class, pid)).isEqualTo("A 비밀");
  }

  @Test
  void 다른_사용자가_같은_op_id_를_써도_서로_영향이_없다() throws Exception {
    Session a = signUp();
    Session b = signUp();
    String op = uuid();
    pushDomain(a, op, "projects", uuid(), 0, Map.of("name", "A"));
    JsonNode rb = pushDomain(b, op, "projects", uuid(), 0, Map.of("name", "B"));
    assertThat(rb.get("status").asText()).isEqualTo("applied");
    assertThat(rb.has("duplicate")).isFalse();
    assertThat(rb.get("row").get("name").asText()).isEqualTo("B");
  }

  @Test
  void pull_은_server_seq_순서로_커서_이후만_돌려준다() throws Exception {
    Session s = signUp();
    String id1 = uuid();
    String id2 = uuid();
    pushDomain(s, uuid(), "categories", id1, 0, Map.of("name", "C1"));
    pushDomain(s, uuid(), "categories", id2, 0, Map.of("name", "C2"));
    pushDomain(s, uuid(), "categories", id1, 1, Map.of("color", "#ff0000"));
    JsonNode all = body(getAs(s, "/api/sync/domain/categories?since=0"));
    List<String> ids = new java.util.ArrayList<>();
    all.forEach(r -> ids.add(r.get("id").asText()));
    assertThat(ids).containsExactly(id2, id1);
    long cursor = all.get(0).get("server_seq").asLong();
    JsonNode after = body(getAs(s, "/api/sync/domain/categories?since=" + cursor));
    assertThat(after).hasSize(1);
    assertThat(after.get(0).get("color").asText()).isEqualTo("#ff0000");
    assertThat(getAs(s, "/api/sync/domain/users?since=0").getResponse().getStatus()).isEqualTo(404);
  }
}
