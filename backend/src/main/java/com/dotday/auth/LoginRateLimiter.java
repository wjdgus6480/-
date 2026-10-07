package com.dotday.auth;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * 비밀번호 대입 방지: 같은 이메일로 15분 안에 10번 실패하면 잠시 막는다.
 * 서버 메모리에만 두는 단순한 방식이다 (재시작하면 초기화, 인스턴스 1개 기준).
 */
@Component
public class LoginRateLimiter {
  static final int MAX_FAILURES = 10;
  static final Duration WINDOW = Duration.ofMinutes(15);

  private final Map<String, Deque<Instant>> failures = new ConcurrentHashMap<>();
  private final Clock clock;

  public LoginRateLimiter() {
    this(Clock.systemUTC());
  }

  LoginRateLimiter(Clock clock) {
    this.clock = clock;
  }

  public boolean blocked(String key) {
    Deque<Instant> q = failures.get(key);
    if (q == null) return false;
    synchronized (q) {
      prune(q);
      return q.size() >= MAX_FAILURES;
    }
  }

  public void fail(String key) {
    Deque<Instant> q = failures.computeIfAbsent(key, k -> new ArrayDeque<>());
    synchronized (q) {
      prune(q);
      q.addLast(clock.instant());
    }
  }

  public void reset(String key) {
    failures.remove(key);
  }

  private void prune(Deque<Instant> q) {
    Instant cutoff = clock.instant().minus(WINDOW);
    while (!q.isEmpty() && q.peekFirst().isBefore(cutoff)) q.pollFirst();
  }
}
