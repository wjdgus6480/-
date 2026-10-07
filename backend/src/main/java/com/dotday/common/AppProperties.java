package com.dotday.common;

import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "dotday")
public record AppProperties(String jwtSecret, Duration tokenTtl, Duration reauthWindow, String corsOrigins) {
  public List<String> corsOriginList() {
    if (corsOrigins == null) return List.of();
    return Arrays.stream(corsOrigins.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
  }
}
