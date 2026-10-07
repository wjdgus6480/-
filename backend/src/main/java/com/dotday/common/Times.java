package com.dotday.common;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;

/** DB 의 DATETIME(3) 은 UTC 기준 LocalDateTime 으로 읽고 쓴다. 클라이언트와는 ISO 8601('...Z') 문자열로 주고받는다. */
public final class Times {
  private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private Times() {}

  /** 밀리초 단위로 자른 현재 시각 (DATETIME(3) 정밀도와 맞춤) */
  public static LocalDateTime now() {
    return LocalDateTime.ofInstant(Instant.now().truncatedTo(ChronoUnit.MILLIS), ZoneOffset.UTC);
  }

  public static String format(LocalDateTime utc) {
    return ISO_MILLIS.format(utc.toInstant(ZoneOffset.UTC));
  }

  /**
   * JDBC 드라이버마다 DATETIME 을 LocalDateTime 또는 Timestamp 로 돌려준다.
   * Timestamp 는 시간대 변환 없이 저장된 벽시계 값(=UTC)을 그대로 꺼낸다 (JVM 시간대와 무관).
   */
  public static LocalDateTime fromDb(Object v) {
    if (v instanceof LocalDateTime l) return l;
    if (v instanceof Timestamp t) return t.toLocalDateTime();
    if (v instanceof OffsetDateTime o) return o.withOffsetSameInstant(ZoneOffset.UTC).toLocalDateTime();
    throw new IllegalArgumentException("not a timestamp: " + v);
  }

  public static LocalDate dateFromDb(Object v) {
    if (v instanceof LocalDate d) return d;
    if (v instanceof java.sql.Date d) return d.toLocalDate();
    throw new IllegalArgumentException("not a date: " + v);
  }

  /**
   * 클라이언트 시각 문자열 → UTC LocalDateTime.
   * '2026-10-02T08:48:24.206Z', '+09:00' 같은 오프셋, 오프셋 없는 값(UTC 로 간주), 날짜만 있는 값(UTC 자정)을 받는다.
   */
  public static LocalDateTime parseTimestamp(String s) {
    String v = s.trim().replace(' ', 'T');
    try {
      return OffsetDateTime.parse(v).withOffsetSameInstant(ZoneOffset.UTC).toLocalDateTime().truncatedTo(ChronoUnit.MILLIS);
    } catch (DateTimeParseException ignored) {
      // 오프셋 없는 형식은 아래에서 처리
    }
    try {
      return LocalDateTime.parse(v).truncatedTo(ChronoUnit.MILLIS);
    } catch (DateTimeParseException ignored) {
      // 날짜만 있는 형식은 아래에서 처리
    }
    return LocalDate.parse(v).atStartOfDay();
  }

  /** 'YYYY-MM-DD' (뒤에 시각이 붙어 있으면 날짜 부분만) */
  public static LocalDate parseDate(String s) {
    String v = s.trim();
    return LocalDate.parse(v.length() > 10 ? v.substring(0, 10) : v);
  }
}
