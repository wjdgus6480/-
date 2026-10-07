package com.dotday.auth;

import org.springframework.security.oauth2.jwt.Jwt;

/** 컨트롤러에서 @AuthenticationPrincipal Jwt 로 받은 토큰의 사용자·세션 */
public record CurrentUser(String id, String sessionId, String email) {
  public static CurrentUser of(Jwt jwt) {
    return new CurrentUser(jwt.getSubject(), jwt.getClaimAsString("sid"), jwt.getClaimAsString("email"));
  }
}
