package com.dotday.sync;

import com.dotday.common.Ids;
import com.dotday.common.Times;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.Reader;
import java.io.UncheckedIOException;
import java.sql.Clob;
import java.sql.SQLException;
import java.time.format.DateTimeParseException;
import java.util.Set;

/**
 * 동기화 필드 하나의 타입·기본값. Postgres 의 jsonb_populate_record 형변환을 대신한다.
 * 형식이 맞지 않으면 InvalidValue → 결과 'rejected: invalid_data'.
 */
public record FieldSpec(String name, Type type, boolean nullable, Object defaultValue, Set<String> allowed) {

  public enum Type { TEXT, ENUM, TIMESTAMP, DATE, BOOL, UUID }

  public static final class InvalidValue extends RuntimeException {
    public InvalidValue(String field) {
      super(field, null, false, false);
    }
  }

  public static FieldSpec text(String name, Object def) {
    return new FieldSpec(name, Type.TEXT, false, def, null);
  }

  public static FieldSpec nullableText(String name) {
    return new FieldSpec(name, Type.TEXT, true, null, null);
  }

  public static FieldSpec oneOf(String name, String def, String... values) {
    return new FieldSpec(name, Type.ENUM, false, def, Set.of(values));
  }

  public static FieldSpec timestamp(String name, boolean nullable) {
    return new FieldSpec(name, Type.TIMESTAMP, nullable, null, null);
  }

  public static FieldSpec date(String name) {
    return new FieldSpec(name, Type.DATE, true, null, null);
  }

  public static FieldSpec bool(String name, boolean def) {
    return new FieldSpec(name, Type.BOOL, false, def, null);
  }

  public static FieldSpec uuid(String name) {
    return new FieldSpec(name, Type.UUID, true, null, null);
  }

  /** JSON 값 → DB 에 넣을 Java 값 */
  public Object fromJson(JsonNode v) {
    if (v == null || v.isNull()) {
      if (!nullable) throw new InvalidValue(name);
      return null;
    }
    try {
      return switch (type) {
        case TEXT -> scalarText(v);
        case ENUM -> {
          String s = scalarText(v);
          if (!allowed.contains(s)) throw new InvalidValue(name);
          yield s;
        }
        case TIMESTAMP -> Times.parseTimestamp(requireText(v));
        case DATE -> Times.parseDate(requireText(v));
        case BOOL -> {
          if (v.isBoolean()) yield v.booleanValue();
          String s = requireText(v).trim().toLowerCase();
          if (s.equals("true") || s.equals("t")) yield true;
          if (s.equals("false") || s.equals("f")) yield false;
          throw new InvalidValue(name);
        }
        case UUID -> Ids.parse(requireText(v)).orElseThrow(() -> new InvalidValue(name));
      };
    } catch (DateTimeParseException e) {
      throw new InvalidValue(name);
    }
  }

  /** DB 값 → 응답 JSON */
  public void putJson(ObjectNode out, Object v) {
    putTyped(out, name, type, v);
  }

  static void putTyped(ObjectNode out, String key, Type type, Object v) {
    if (v == null) {
      out.putNull(key);
      return;
    }
    switch (type) {
      case TIMESTAMP -> out.put(key, Times.format(Times.fromDb(v)));
      case DATE -> out.put(key, Times.dateFromDb(v).toString());
      case BOOL -> out.put(key, (boolean) (v instanceof Boolean b ? b : ((Number) v).intValue() != 0));
      default -> out.put(key, dbText(v));
    }
  }

  /** H2 는 MEDIUMTEXT 를 Clob 으로 돌려준다 */
  static String dbText(Object v) {
    if (v instanceof Clob c) {
      try (Reader r = c.getCharacterStream()) {
        StringBuilder sb = new StringBuilder();
        char[] buf = new char[4096];
        int n;
        while ((n = r.read(buf)) > 0) sb.append(buf, 0, n);
        return sb.toString();
      } catch (SQLException e) {
        throw new IllegalStateException(e);
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }
    return v.toString();
  }

  /** 기존 행 값(DB 표현)을 비교·검증용 Java 값으로 맞춘다 */
  Object normalizeDb(Object v) {
    if (v == null) return null;
    return switch (type) {
      case TIMESTAMP -> Times.fromDb(v);
      case DATE -> Times.dateFromDb(v);
      case BOOL -> v instanceof Boolean b ? b : ((Number) v).intValue() != 0;
      default -> dbText(v);
    };
  }

  private String scalarText(JsonNode v) {
    if (v.isContainerNode()) throw new InvalidValue(name);
    return v.asText();
  }

  private String requireText(JsonNode v) {
    if (!v.isTextual()) throw new InvalidValue(name);
    return v.textValue();
  }
}
