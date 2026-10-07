package com.dotday.common;

import java.util.Optional;
import java.util.UUID;

public final class Ids {
  private Ids() {}

  /** UUID 형식이면 소문자 표준 표기로, 아니면 빈 값 */
  public static Optional<String> parse(String s) {
    if (s == null || s.length() != 36) return Optional.empty();
    try {
      return Optional.of(UUID.fromString(s).toString());
    } catch (IllegalArgumentException e) {
      return Optional.empty();
    }
  }

  public static String random() {
    return UUID.randomUUID().toString();
  }
}
