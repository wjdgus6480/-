package com.dotday.sync;

import static com.dotday.sync.FieldSpec.bool;
import static com.dotday.sync.FieldSpec.date;
import static com.dotday.sync.FieldSpec.nullableText;
import static com.dotday.sync.FieldSpec.oneOf;
import static com.dotday.sync.FieldSpec.text;
import static com.dotday.sync.FieldSpec.timestamp;
import static com.dotday.sync.FieldSpec.uuid;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * 업무 엔티티별 동기화 필드와 검사 규칙.
 * - 필드 목록은 프론트 src/domain/types.ts ENTITY_FIELDS 와 같아야 한다 (테스트로 검증).
 * - SQL 의 테이블·컬럼 이름은 이 상수 목록에서만 나온다 (사용자 입력을 SQL 에 넣지 않음).
 */
public record EntitySpec(String table, List<FieldSpec> fields, Predicate<Map<String, Object>> rowValid) {

  private static final Pattern RRULE = Pattern.compile(
      "^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;(INTERVAL=[1-9][0-9]{0,2}|COUNT=[1-9][0-9]{0,3}|UNTIL=[0-9]{8}|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU)){0,6}))*$");

  private static final Map<String, EntitySpec> ALL = new LinkedHashMap<>();

  static {
    ALL.put("projects", new EntitySpec("projects", List.of(
        text("name", null),
        text("description", ""),
        oneOf("status", "active", "active", "on_hold", "done", "archived"),
        timestamp("deleted_at", true)),
        r -> lengthBetween(r.get("name"), 1, 120)));

    ALL.put("categories", new EntitySpec("categories", List.of(
        text("name", null),
        text("color", "#888888"),
        timestamp("deleted_at", true)),
        r -> lengthBetween(r.get("name"), 1, 60) && lengthBetween(r.get("color"), 0, 64)));

    // API·프론트의 엔티티 이름은 tasks, DB 테이블 이름은 todos
    ALL.put("tasks", new EntitySpec("todos", List.of(
        text("title", null),
        text("description", ""),
        oneOf("status", "todo", "todo", "in_progress", "done"),
        oneOf("priority", "medium", "low", "medium", "high", "urgent"),
        date("due_date"),
        uuid("project_id"),
        uuid("category_id"),
        timestamp("completed_at", true),
        timestamp("deleted_at", true)),
        r -> lengthBetween(r.get("title"), 1, 300)));

    ALL.put("events", new EntitySpec("events", List.of(
        text("title", null),
        text("description", ""),
        timestamp("start_at", false),
        timestamp("end_at", false),
        bool("all_day", false),
        text("timezone", "Asia/Seoul"),
        nullableText("recurrence_rule"),
        uuid("recurrence_parent_id"),
        timestamp("original_start_at", true),
        bool("is_cancelled", false),
        uuid("project_id"),
        uuid("category_id"),
        timestamp("deleted_at", true)),
        EntitySpec::eventValid));
  }

  public static Optional<EntitySpec> of(String entity) {
    return Optional.ofNullable(entity == null ? null : ALL.get(entity));
  }

  public static Map<String, EntitySpec> all() {
    return ALL;
  }

  public Optional<FieldSpec> field(String name) {
    return fields.stream().filter(f -> f.name().equals(name)).findFirst();
  }

  public List<String> fieldNames() {
    return fields.stream().map(FieldSpec::name).toList();
  }

  /** char_length(btrim(v)) between min and max 와 같다 (btrim 은 공백만 제거) */
  static boolean lengthBetween(Object v, int min, int max) {
    if (!(v instanceof String s)) return false;
    String t = s.replaceAll("^ +| +$", "");
    int n = t.codePointCount(0, t.length());
    return n >= min && n <= max;
  }

  private static boolean eventValid(Map<String, Object> r) {
    if (!lengthBetween(r.get("title"), 1, 300) || !lengthBetween(r.get("timezone"), 1, 64)) return false;
    LocalDateTime start = (LocalDateTime) r.get("start_at");
    LocalDateTime end = (LocalDateTime) r.get("end_at");
    if (start == null || end == null || end.isBefore(start)) return false;
    Object rule = r.get("recurrence_rule");
    if (rule != null && !RRULE.matcher((String) rule).matches()) return false;
    boolean isOverride = r.get("recurrence_parent_id") != null;
    // 예외 회차는 원본 ID 와 원래 시작 시각이 함께 있어야 하고, 자체 반복 규칙을 가질 수 없다
    if (isOverride != (r.get("original_start_at") != null)) return false;
    return !(isOverride && rule != null);
  }
}
