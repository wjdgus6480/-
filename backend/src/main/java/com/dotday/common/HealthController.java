package com.dotday.common;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** 배포 환경의 상태 확인용. Render 무료 플랜은 잠들었다 깨므로, 프론트가 먼저 이 주소로 서버를 깨울 수 있다. */
@RestController
public class HealthController {
  @GetMapping("/api/health")
  public Map<String, String> health() {
    return Map.of("status", "ok");
  }
}
