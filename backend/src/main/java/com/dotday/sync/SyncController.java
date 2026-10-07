package com.dotday.sync;

import com.dotday.common.ApiException;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 동기화 API. 사용자는 항상 토큰에서 정한다 (요청 본문의 owner_id 등은 받지 않음).
 *   POST /api/sync/domain/ops           업무 데이터 변경 1건 적용
 *   GET  /api/sync/domain/{entity}      server_seq > since 인 내 행
 *   POST /api/sync/views/ops            보기 설정 변경 1건 적용
 *   GET  /api/sync/views                server_seq > since 인 내 보기 설정
 */
@RestController
@RequestMapping("/api/sync")
public class SyncController {
  static final int MAX_LIMIT = 1000;

  public record DomainOp(@JsonProperty("op_id") String opId, String entity, String id, @JsonProperty("base_version") Integer baseVersion, JsonNode patch) {}

  public record ViewOp(@JsonProperty("op_id") String opId, @JsonProperty("view_id") String viewId, @JsonProperty("base_version") Integer baseVersion, JsonNode patch) {}

  private final DomainOpService domain;
  private final ViewOpService views;

  public SyncController(DomainOpService domain, ViewOpService views) {
    this.domain = domain;
    this.views = views;
  }

  @PostMapping("/domain/ops")
  public ObjectNode pushDomain(@AuthenticationPrincipal Jwt jwt, @RequestBody DomainOp op) {
    if (op.baseVersion() == null || op.baseVersion() < 0) throw bad();
    return domain.apply(jwt.getSubject(), op.opId(), op.entity(), op.id(), op.baseVersion(), op.patch());
  }

  @GetMapping("/domain/{entity}")
  public List<ObjectNode> pullDomain(@AuthenticationPrincipal Jwt jwt, @PathVariable String entity,
                                     @RequestParam(defaultValue = "0") long since, @RequestParam(defaultValue = "500") int limit) {
    if (EntitySpec.of(entity).isEmpty()) throw new ApiException(HttpStatus.NOT_FOUND, "invalid_entity", "알 수 없는 데이터 종류입니다.");
    return domain.pullSince(jwt.getSubject(), entity, since, clamp(limit));
  }

  @PostMapping("/views/ops")
  public ObjectNode pushView(@AuthenticationPrincipal Jwt jwt, @RequestBody ViewOp op) {
    if (op.baseVersion() == null || op.baseVersion() < 0) throw bad();
    return views.apply(jwt.getSubject(), op.opId(), op.viewId(), op.baseVersion(), op.patch());
  }

  @GetMapping("/views")
  public List<ObjectNode> pullViews(@AuthenticationPrincipal Jwt jwt, @RequestParam(defaultValue = "0") long since,
                                    @RequestParam(defaultValue = "500") int limit) {
    return views.pullSince(jwt.getSubject(), since, clamp(limit));
  }

  private static int clamp(int limit) {
    return Math.max(1, Math.min(MAX_LIMIT, limit));
  }

  private static ApiException bad() {
    return new ApiException(HttpStatus.BAD_REQUEST, "bad_request", "요청 형식이 올바르지 않습니다.");
  }
}
