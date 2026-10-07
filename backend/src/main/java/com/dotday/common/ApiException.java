package com.dotday.common;

import org.springframework.http.HttpStatus;

/** 클라이언트에 {code, message} 로 돌려주는 오류. code 는 프론트(auth.ts KO 표)와 맞춘다. */
public class ApiException extends RuntimeException {
  private final HttpStatus status;
  private final String code;

  public ApiException(HttpStatus status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  public HttpStatus status() {
    return status;
  }

  public String code() {
    return code;
  }
}
