package com.dotday.sync;

import static com.dotday.sync.DomainOpService.rollback;

import com.dotday.common.Ids;
import com.dotday.common.SeqCounter;
import com.dotday.common.Times;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.LocalDateTime;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 보기 설정 변경 적용 (Postgres apply_view_preference_op 을 옮긴 것).
 * 반환: {status: applied|conflict|not_found|rejected, row?, duplicate?, reason?}
 */
@Service
public class ViewOpService {
  private static final Set<String> PATCH_KEYS = Set.of("view_key", "name", "column_config", "sort_config", "filter_config",
      "layout_config", "is_default", "deleted_at", "local_profile_id", "created_at");
  private static final List<String> JSON_COLS = List.of("column_config", "sort_config", "filter_config", "layout_config");

  private final JdbcTemplate jdbc;
  private final SeqCounter seq;
  private final ObjectMapper json;

  public ViewOpService(JdbcTemplate jdbc, SeqCounter seq, ObjectMapper json) {
    this.jdbc = jdbc;
    this.seq = seq;
    this.json = json;
  }

  /** 검사·저장에 쓰는 한 행의 값 */
  private record ViewValues(String viewKey, String name, JsonNode cols, JsonNode sorts, JsonNode filters, JsonNode layout,
                            boolean isDefault, LocalDateTime deletedAt) {
    boolean valid() {
      return viewKey != null && EntitySpec.lengthBetween(name, 1, 60) && layout != null && layout.isObject()
          && ViewConfigValidator.valid(viewKey, cols, sorts, filters);
    }
  }

  @Transactional
  public ObjectNode apply(String uid, String opIdRaw, String viewIdRaw, int baseVersion, JsonNode patch) {
    Optional<String> opId = Ids.parse(opIdRaw);
    Optional<String> viewId = Ids.parse(viewIdRaw);
    if (opId.isEmpty() || viewId.isEmpty()) return status("rejected").put("reason", "invalid_id");

    List<String> prev = jdbc.queryForList("select result from view_preference_ops where owner_id = ? and op_id = ?", String.class, uid, opId.get());
    if (!prev.isEmpty()) return read(prev.get(0)).put("duplicate", true);

    if (patch == null || !patch.isObject()) return status("rejected").put("reason", "invalid_patch");
    for (Iterator<String> it = patch.fieldNames(); it.hasNext(); ) {
      String key = it.next();
      if (!PATCH_KEYS.contains(key)) return status("rejected").put("reason", "invalid_patch_key:" + key);
    }

    List<Map<String, Object>> found = jdbc.queryForList("select * from view_preferences where id = ? for update", viewId.get());
    Map<String, Object> old = found.isEmpty() ? null : found.get(0);
    boolean foreign = old != null && !uid.equals(old.get("owner_id"));

    try {
      if (old == null || foreign) {
        if (baseVersion != 0) return status("not_found");
        if (foreign) return status("rejected").put("reason", "id_unavailable");
        ViewValues v = new ViewValues(text(patch, "view_key"), text(patch, "name"), patch.get("column_config"),
            orDefault(patch, "sort_config", "[]"), orDefault(patch, "filter_config", "{}"), orDefault(patch, "layout_config", "{}"),
            bool(patch, "is_default", false), timestamp(patch, "deleted_at"));
        if (!v.valid()) return rollback(status("rejected").put("reason", "invalid_config"));
        LocalDateTime now = Times.now();
        LocalDateTime created = patch.hasNonNull("created_at") ? timestamp(patch, "created_at") : now;
        jdbc.update("insert into view_preferences (id, owner_id, local_profile_id, view_key, name, column_config, sort_config, filter_config, layout_config,"
                + " is_default, created_at, updated_at, deleted_at, version, server_seq) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
            viewId.get(), uid, text(patch, "local_profile_id"), v.viewKey(), v.name(), write(v.cols()), write(v.sorts()), write(v.filters()),
            write(v.layout()), v.isDefault(), created, now, v.deletedAt(), seq.next(SeqCounter.VIEWS));
      } else if (((Number) old.get("version")).intValue() != baseVersion) {
        return status("conflict").set("row", toJson(old));
      } else {
        // view_key·local_profile_id·created_at 은 만든 뒤 바꾸지 않는다 (Postgres 판본과 같음)
        ViewValues v = new ViewValues(FieldSpec.dbText(old.get("view_key")),
            patch.has("name") ? text(patch, "name") : FieldSpec.dbText(old.get("name")),
            patch.has("column_config") ? patch.get("column_config") : parse(old.get("column_config")),
            patch.has("sort_config") ? patch.get("sort_config") : parse(old.get("sort_config")),
            patch.has("filter_config") ? patch.get("filter_config") : parse(old.get("filter_config")),
            patch.has("layout_config") ? patch.get("layout_config") : parse(old.get("layout_config")),
            patch.has("is_default") ? bool(patch, "is_default", false) : (Boolean) FieldSpec.bool("is_default", false).normalizeDb(old.get("is_default")),
            patch.has("deleted_at") ? timestamp(patch, "deleted_at") : (old.get("deleted_at") == null ? null : Times.fromDb(old.get("deleted_at"))));
        if (!v.valid()) return rollback(status("rejected").put("reason", "invalid_config"));
        jdbc.update("update view_preferences set name = ?, column_config = ?, sort_config = ?, filter_config = ?, layout_config = ?, is_default = ?,"
                + " deleted_at = ?, version = version + 1, updated_at = ?, server_seq = ? where id = ? and owner_id = ?",
            v.name(), write(v.cols()), write(v.sorts()), write(v.filters()), write(v.layout()), v.isDefault(), v.deletedAt(),
            Times.now(), seq.next(SeqCounter.VIEWS), viewId.get(), uid);
      }
    } catch (FieldSpec.InvalidValue e) {
      return rollback(status("rejected").put("reason", "invalid_config"));
    } catch (DuplicateKeyException e) {
      return rollback(status("rejected").put("reason", "id_unavailable"));
    } catch (DataIntegrityViolationException e) {
      return rollback(status("rejected").put("reason", "invalid_config"));
    }

    Map<String, Object> row = jdbc.queryForMap("select * from view_preferences where id = ? and owner_id = ?", viewId.get(), uid);
    ObjectNode res = status("applied").set("row", toJson(row));
    jdbc.update("insert into view_preference_ops (owner_id, op_id, view_id, result, applied_at) values (?, ?, ?, ?, ?)",
        uid, opId.get(), viewId.get(), write(res), Times.now());
    return res;
  }

  @Transactional(readOnly = true)
  public List<ObjectNode> pullSince(String uid, long cursor, int limit) {
    return jdbc.queryForList("select * from view_preferences where owner_id = ? and server_seq > ? order by server_seq limit ?", uid, cursor, limit)
        .stream().map(this::toJson).toList();
  }

  ObjectNode toJson(Map<String, Object> row) {
    ObjectNode o = json.createObjectNode();
    o.put("id", (String) row.get("id"));
    o.put("owner_id", (String) row.get("owner_id"));
    Object lp = row.get("local_profile_id");
    if (lp == null) o.putNull("local_profile_id");
    else o.put("local_profile_id", FieldSpec.dbText(lp));
    o.put("view_key", FieldSpec.dbText(row.get("view_key")));
    o.put("name", FieldSpec.dbText(row.get("name")));
    for (String c : JSON_COLS) o.set(c, parse(row.get(c)));
    FieldSpec.putTyped(o, "is_default", FieldSpec.Type.BOOL, row.get("is_default"));
    FieldSpec.putTyped(o, "created_at", FieldSpec.Type.TIMESTAMP, row.get("created_at"));
    FieldSpec.putTyped(o, "updated_at", FieldSpec.Type.TIMESTAMP, row.get("updated_at"));
    FieldSpec.putTyped(o, "deleted_at", FieldSpec.Type.TIMESTAMP, row.get("deleted_at"));
    o.put("version", ((Number) row.get("version")).intValue());
    o.put("server_seq", ((Number) row.get("server_seq")).longValue());
    return o;
  }

  // ---------- 값 꺼내기 (Postgres 의 p_patch->>'x' / ::boolean / ::timestamptz 에 해당) ----------

  private static String text(JsonNode patch, String key) {
    JsonNode v = patch.get(key);
    if (v == null || v.isNull()) return null;
    if (v.isContainerNode()) throw new FieldSpec.InvalidValue(key);
    return v.asText();
  }

  private static JsonNode orDefault(JsonNode patch, String key, String def) {
    JsonNode v = patch.get(key);
    if (v == null || v.isNull()) {
      try {
        return new ObjectMapper().readTree(def);
      } catch (JsonProcessingException e) {
        throw new IllegalStateException(e);
      }
    }
    return v;
  }

  private static boolean bool(JsonNode patch, String key, boolean def) {
    JsonNode v = patch.get(key);
    if (v == null || v.isNull()) return def;
    return (Boolean) FieldSpec.bool(key, def).fromJson(v);
  }

  private static LocalDateTime timestamp(JsonNode patch, String key) {
    return (LocalDateTime) FieldSpec.timestamp(key, true).fromJson(patch.get(key));
  }

  private JsonNode parse(Object dbValue) {
    try {
      return json.readTree(FieldSpec.dbText(dbValue));
    } catch (JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }

  private ObjectNode read(String s) {
    return (ObjectNode) parse(s);
  }

  private ObjectNode status(String s) {
    return json.createObjectNode().put("status", s);
  }

  private String write(JsonNode n) {
    try {
      return json.writeValueAsString(n);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }
}
