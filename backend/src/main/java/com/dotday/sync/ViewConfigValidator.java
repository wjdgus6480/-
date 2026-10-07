package com.dotday.sync;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 보기 설정 검사 (Postgres view_pref_config_valid 를 옮긴 것).
 * 허용 필드 목록은 프론트 src/views/fields.ts 레지스트리와 같아야 한다 (테스트로 검증).
 * Postgres 판본은 field 키가 빠진 항목을 NULL 비교 때문에 통과시켰는데, 여기서는 거부한다.
 */
public final class ViewConfigValidator {
  public static final Map<String, List<String>> ALLOWED_FIELDS = Map.of(
      "tasks", List.of("title", "description", "status", "priority", "due_date", "project", "category", "created_at", "updated_at", "completed_at"),
      "events", List.of("title", "description", "start_at", "end_at", "all_day", "timezone", "recurring", "project", "category", "updated_at"),
      "projects", List.of("name", "description", "status", "created_at", "updated_at", "task_count", "open_task_count", "event_count"));

  private ViewConfigValidator() {}

  public static boolean valid(String viewKey, JsonNode cols, JsonNode sorts, JsonNode filters) {
    List<String> allowed = ALLOWED_FIELDS.get(viewKey);
    if (allowed == null || cols == null || sorts == null || filters == null) return false;
    if (!cols.isArray() || !sorts.isArray() || !filters.isObject()) return false;

    Set<String> seenFields = new HashSet<>();
    Set<Integer> seenPos = new HashSet<>();
    for (JsonNode el : cols) {
      if (!el.isObject()) return false;
      String field = text(el.get("field"));
      JsonNode width = el.get("width");
      JsonNode position = el.get("position");
      JsonNode visible = el.get("visible");
      if (field == null || !allowed.contains(field) || !seenFields.add(field)) return false;
      if (width == null || !width.isNumber() || width.doubleValue() < 60 || width.doubleValue() > 800) return false;
      // Postgres 의 ::int 는 반올림한다
      if (position == null || !position.isNumber() || !seenPos.add((int) Math.round(position.doubleValue()))) return false;
      if (visible == null || !visible.isBoolean()) return false;
    }

    if (sorts.size() > 3) return false;
    for (JsonNode el : sorts) {
      String field = text(el.get("field"));
      String dir = text(el.get("dir"));
      if (field == null || !allowed.contains(field) || !("asc".equals(dir) || "desc".equals(dir))) return false;
    }

    if (filters.has("search")) {
      JsonNode s = filters.get("search");
      if (!s.isTextual() || s.textValue().codePointCount(0, s.textValue().length()) > 200) return false;
    }
    if (filters.has("conditions")) {
      JsonNode conds = filters.get("conditions");
      if (!conds.isArray()) return false;
      for (JsonNode el : conds) {
        String field = text(el.get("field"));
        String type = text(el.get("type"));
        if (field == null || !allowed.contains(field) || !("in".equals(type) || "dateRange".equals(type) || "bool".equals(type))) return false;
      }
    }
    return true;
  }

  /** Postgres 의 ->> 처럼 스칼라 값을 문자열로 (없거나 null 이면 null) */
  private static String text(JsonNode n) {
    if (n == null || n.isNull() || n.isContainerNode()) return null;
    return n.asText();
  }
}
