package com.dotday.common;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * server_seq 발급. Postgres 시퀀스 대신 카운터 행을 잠그고 1 증가시킨다.
 * 행 잠금은 트랜잭션이 끝날 때까지 유지되므로, 번호 순서가 커밋 순서와 같다
 * → 다른 기기가 'server_seq > 커서' 로 가져갈 때 늦게 커밋된 작은 번호를 건너뛰는 일이 없다.
 */
@Component
public class SeqCounter {
  public static final String DOMAIN = "domain";
  public static final String VIEWS = "views";

  private final JdbcTemplate jdbc;

  public SeqCounter(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public long next(String name) {
    int n = jdbc.update("update seq_counters set current_value = current_value + 1 where name = ?", name);
    if (n != 1) throw new IllegalStateException("unknown sequence " + name);
    Long v = jdbc.queryForObject("select current_value from seq_counters where name = ?", Long.class, name);
    return v == null ? 0 : v;
  }
}
