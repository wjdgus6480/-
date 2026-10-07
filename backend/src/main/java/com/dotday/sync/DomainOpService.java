package com.dotday.sync;

import com.dotday.common.Ids;
import com.dotday.common.SeqCounter;
import com.dotday.common.Times;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.interceptor.TransactionAspectSupport;

/**
 * 업무 데이터 변경 적용 (Postgres apply_domain_op 을 옮긴 것).
 * 반환: {status: applied|conflict|not_found|rejected|retry, row?, duplicate?, reason?}
 *   retry: 참조 대상(프로젝트·분류·반복 원본)이 아직 서버에 없음 → 클라이언트가 나중에 재전송
 * 모든 쿼리에 owner_id = (로그인 사용자) 조건을 붙인다 → 다른 사용자의 행은 보이지도, 바뀌지도 않는다 (RLS 대체).
 */
@Service
public class DomainOpService {
  private static final List<String> REFS = List.of("project_id", "category_id", "recurrence_parent_id");
  private static final Map<String, String> REF_TABLE = Map.of("project_id", "projects", "category_id", "categories", "recurrence_parent_id", "events");

  private final JdbcTemplate jdbc;
  private final SeqCounter seq;
  private final ObjectMapper json;

  public DomainOpService(JdbcTemplate jdbc, SeqCounter seq, ObjectMapper json) {
    this.jdbc = jdbc;
    this.seq = seq;
    this.json = json;
  }

  @Transactional
  public ObjectNode apply(String uid, String opIdRaw, String entity, String idRaw, int baseVersion, JsonNode patch) {
    Optional<EntitySpec> specOpt = EntitySpec.of(entity);
    if (specOpt.isEmpty()) return status("rejected").put("reason", "invalid_entity");
    EntitySpec spec = specOpt.get();
    Optional<String> opId = Ids.parse(opIdRaw);
    Optional<String> id = Ids.parse(idRaw);
    if (opId.isEmpty() || id.isEmpty()) return status("rejected").put("reason", "invalid_id");

    // 멱등성: 같은 op_id 를 다시 보내면 저장된 결과를 그대로 돌려준다
    List<String> prev = jdbc.queryForList("select result from domain_ops where owner_id = ? and op_id = ?", String.class, uid, opId.get());
    if (!prev.isEmpty()) return read(prev.get(0)).put("duplicate", true);

    if (patch == null || !patch.isObject()) return status("rejected").put("reason", "invalid_patch");
    for (Iterator<String> it = patch.fieldNames(); it.hasNext(); ) {
      String key = it.next();
      if (!(spec.field(key).isPresent() || (key.equals("created_at") && baseVersion == 0)))
        return status("rejected").put("reason", "invalid_patch_key:" + key);
    }

    // 참조 검사: 내 소유 행만 참조할 수 있다
    for (String ref : REFS) {
      if (spec.field(ref).isEmpty()) continue;
      JsonNode v = patch.get(ref);
      if (v == null || v.isNull() || (v.isTextual() && v.textValue().isEmpty())) continue;
      Optional<String> refId = v.isTextual() ? Ids.parse(v.textValue()) : Optional.empty();
      if (refId.isEmpty()) return status("rejected").put("reason", "invalid_reference");
      Integer n = jdbc.queryForObject("select count(*) from " + REF_TABLE.get(ref) + " where id = ? and owner_id = ?", Integer.class, refId.get(), uid);
      if (n == null || n == 0) return status("retry").put("reason", "missing_reference:" + ref);
    }

    List<Map<String, Object>> found = jdbc.queryForList("select * from " + spec.table() + " where id = ? for update", id.get());
    Map<String, Object> old = found.isEmpty() ? null : found.get(0);
    // 다른 사용자의 ID: 존재 여부를 드러내지 않고, 내 행이 없는 것처럼 처리한다
    boolean foreign = old != null && !uid.equals(old.get("owner_id"));

    try {
      String result;
      if (old == null || foreign) {
        if (baseVersion != 0) return status("not_found");
        if (foreign) return status("rejected").put("reason", "id_unavailable");
        result = insert(spec, uid, id.get(), patch);
      } else if (((Number) old.get("version")).intValue() != baseVersion) {
        // 충돌 결과는 기록하지 않는다. 클라이언트가 병합 후 같은 op_id 로 재시도할 수 있다.
        return status("conflict").set("row", toJson(spec, old));
      } else {
        result = update(spec, uid, id.get(), old, patch);
      }
      if (result != null) return rollback(status("rejected").put("reason", result));
    } catch (FieldSpec.InvalidValue e) {
      return rollback(status("rejected").put("reason", "invalid_data"));
    } catch (DuplicateKeyException e) {
      return rollback(status("rejected").put("reason", "id_unavailable"));
    } catch (DataIntegrityViolationException e) {
      // 검사를 통과한 뒤 참조 대상이 사라진 경우(외래키) 등 → 다시 보내면 해결될 수 있다
      return rollback(isForeignKey(e) ? status("retry").put("reason", "foreign_key") : status("rejected").put("reason", "invalid_data"));
    }

    Map<String, Object> row = jdbc.queryForMap("select * from " + spec.table() + " where id = ? and owner_id = ?", id.get(), uid);
    ObjectNode res = status("applied").set("row", toJson(spec, row));
    jdbc.update("insert into domain_ops (owner_id, op_id, entity, record_id, result, applied_at) values (?, ?, ?, ?, ?, ?)",
        uid, opId.get(), entity, id.get(), write(res), Times.now());
    return res;
  }

  @Transactional(readOnly = true)
  public List<ObjectNode> pullSince(String uid, String entity, long cursor, int limit) {
    EntitySpec spec = EntitySpec.of(entity).orElseThrow(() -> new IllegalArgumentException("invalid entity"));
    return jdbc.queryForList("select * from " + spec.table() + " where owner_id = ? and server_seq > ? order by server_seq limit ?", uid, cursor, limit)
        .stream().map(r -> toJson(spec, r)).toList();
  }

  /** @return 거부 사유, 성공이면 null */
  private String insert(EntitySpec spec, String uid, String id, JsonNode patch) {
    Map<String, Object> values = new LinkedHashMap<>();
    for (FieldSpec f : spec.fields()) {
      Object v = patch.has(f.name()) ? f.fromJson(patch.get(f.name())) : f.defaultValue();
      if (v == null && !f.nullable()) return "invalid_data";
      values.put(f.name(), v);
    }
    if (!spec.rowValid().test(values)) return "invalid_data";
    LocalDateTime now = Times.now();
    LocalDateTime created = patch.has("created_at") ? (LocalDateTime) FieldSpec.timestamp("created_at", false).fromJson(patch.get("created_at")) : now;
    List<String> cols = new ArrayList<>(List.of("id", "owner_id"));
    List<Object> args = new ArrayList<>(List.of(id, uid));
    values.forEach((k, v) -> {
      cols.add(k);
      args.add(v);
    });
    cols.addAll(List.of("created_at", "updated_at", "version", "server_seq"));
    args.addAll(List.of(created, now, 1, seq.next(SeqCounter.DOMAIN)));
    jdbc.update("insert into " + spec.table() + " (" + String.join(", ", cols) + ") values (" + "?, ".repeat(cols.size() - 1) + "?)", args.toArray());
    return null;
  }

  private String update(EntitySpec spec, String uid, String id, Map<String, Object> old, JsonNode patch) {
    Map<String, Object> values = new LinkedHashMap<>();
    for (FieldSpec f : spec.fields()) values.put(f.name(), patch.has(f.name()) ? f.fromJson(patch.get(f.name())) : f.normalizeDb(old.get(f.name())));
    if (!spec.rowValid().test(values)) return "invalid_data";
    List<Object> args = new ArrayList<>(values.values());
    args.addAll(List.of(Times.now(), seq.next(SeqCounter.DOMAIN), id, uid));
    String set = String.join(" = ?, ", values.keySet()) + " = ?";
    jdbc.update("update " + spec.table() + " set " + set + ", version = version + 1, updated_at = ?, server_seq = ? where id = ? and owner_id = ?", args.toArray());
    return null;
  }

  /** 서버 행 → 응답 JSON (Postgres to_jsonb(row) 와 같은 키) */
  ObjectNode toJson(EntitySpec spec, Map<String, Object> row) {
    ObjectNode o = json.createObjectNode();
    o.put("id", (String) row.get("id"));
    o.put("owner_id", (String) row.get("owner_id"));
    for (FieldSpec f : spec.fields()) f.putJson(o, row.get(f.name()));
    FieldSpec.putTyped(o, "created_at", FieldSpec.Type.TIMESTAMP, row.get("created_at"));
    FieldSpec.putTyped(o, "updated_at", FieldSpec.Type.TIMESTAMP, row.get("updated_at"));
    o.put("version", ((Number) row.get("version")).intValue());
    o.put("server_seq", ((Number) row.get("server_seq")).longValue());
    return o;
  }

  static boolean isForeignKey(DataIntegrityViolationException e) {
    String m = String.valueOf(e.getMostSpecificCause().getMessage()).toLowerCase();
    return m.contains("foreign key") || m.contains("referential");
  }

  private ObjectNode status(String s) {
    return json.createObjectNode().put("status", s);
  }

  /** DB 오류 뒤에는 이 트랜잭션의 변경(순번 증가 포함)을 모두 되돌린다 */
  static ObjectNode rollback(ObjectNode res) {
    TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
    return res;
  }

  private ObjectNode read(String s) {
    try {
      return (ObjectNode) json.readTree(s);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }

  private String write(JsonNode n) {
    try {
      return json.writeValueAsString(n);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }
}
