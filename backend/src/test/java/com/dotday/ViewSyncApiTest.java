package com.dotday;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ViewSyncApiTest extends ApiTestBase {

  private JsonNode pushView(Session s, String op, String viewId, int base, Map<String, Object> patch) throws Exception {
    return body(postJson(s, "/api/sync/views/ops", Map.of("op_id", op, "view_id", viewId, "base_version", base, "patch", patch)));
  }

  private static Map<String, Object> newView(String name) {
    return Map.of(
        "view_key", "tasks",
        "name", name,
        "column_config", List.of(
            Map.of("field", "title", "width", 240, "position", 0, "visible", true),
            Map.of("field", "due_date", "width", 120, "position", 1, "visible", false)),
        "sort_config", List.of(Map.of("field", "due_date", "dir", "asc")),
        "filter_config", Map.of("search", "", "conditions", List.of(Map.of("field", "status", "type", "in", "values", List.of("todo")))),
        "layout_config", Map.of(),
        "is_default", true,
        "local_profile_id", "profile-1");
  }

  @Test
  void 보기를_만들고_수정하면_JSON_설정이_그대로_돌아온다() throws Exception {
    Session s = signUp();
    String id = uuid();
    JsonNode r = pushView(s, uuid(), id, 0, newView("기본"));
    assertThat(r.get("status").asText()).isEqualTo("applied");
    assertThat(r.get("row").get("column_config").get(1).get("field").asText()).isEqualTo("due_date");
    assertThat(r.get("row").get("is_default").asBoolean()).isTrue();
    assertThat(r.get("row").get("local_profile_id").asText()).isEqualTo("profile-1");

    JsonNode u = pushView(s, uuid(), id, 1, Map.of("name", "이름 변경", "view_key", "events"));
    assertThat(u.get("status").asText()).isEqualTo("applied");
    assertThat(u.get("row").get("name").asText()).isEqualTo("이름 변경");
    // view_key 는 만든 뒤 바뀌지 않는다
    assertThat(u.get("row").get("view_key").asText()).isEqualTo("tasks");
    assertThat(u.get("row").get("version").asInt()).isEqualTo(2);
  }

  @Test
  void 잘못된_설정은_invalid_config() throws Exception {
    Session s = signUp();
    var bad = new java.util.HashMap<>(newView("x"));
    bad.put("column_config", List.of(Map.of("field", "password", "width", 100, "position", 0, "visible", true)));
    assertThat(pushView(s, uuid(), uuid(), 0, bad).get("reason").asText()).isEqualTo("invalid_config");
    bad.put("column_config", List.of(Map.of("field", "title", "width", 10, "position", 0, "visible", true)));
    assertThat(pushView(s, uuid(), uuid(), 0, bad).get("reason").asText()).isEqualTo("invalid_config");
    bad.put("column_config", List.of(Map.of("width", 100, "position", 0, "visible", true)));
    assertThat(pushView(s, uuid(), uuid(), 0, bad).get("reason").asText()).isEqualTo("invalid_config");
    var noName = new java.util.HashMap<>(newView("x"));
    noName.remove("name");
    assertThat(pushView(s, uuid(), uuid(), 0, noName).get("reason").asText()).isEqualTo("invalid_config");
    assertThat(pushView(s, uuid(), uuid(), 0, Map.of("owner_id", "x")).get("reason").asText()).isEqualTo("invalid_patch_key:owner_id");
    var tooManySorts = new java.util.HashMap<>(newView("x"));
    tooManySorts.put("sort_config", List.of(Map.of("field", "title", "dir", "asc"), Map.of("field", "title", "dir", "asc"),
        Map.of("field", "title", "dir", "asc"), Map.of("field", "title", "dir", "asc")));
    assertThat(pushView(s, uuid(), uuid(), 0, tooManySorts).get("reason").asText()).isEqualTo("invalid_config");
  }

  @Test
  void 충돌_멱등성_격리() throws Exception {
    Session a = signUp();
    Session b = signUp();
    String id = uuid();
    String op = uuid();
    pushView(a, op, id, 0, newView("A"));
    assertThat(pushView(a, op, id, 0, newView("A")).get("duplicate").asBoolean()).isTrue();
    assertThat(pushView(a, uuid(), id, 0, newView("A")).get("status").asText()).isEqualTo("conflict");
    assertThat(pushView(b, uuid(), id, 0, newView("B")).get("reason").asText()).isEqualTo("id_unavailable");
    assertThat(pushView(b, uuid(), id, 1, Map.of("name", "B")).get("status").asText()).isEqualTo("not_found");
    assertThat(body(getAs(b, "/api/sync/views?since=0"))).isEmpty();
    assertThat(body(getAs(a, "/api/sync/views?since=0"))).hasSize(1);
  }
}
