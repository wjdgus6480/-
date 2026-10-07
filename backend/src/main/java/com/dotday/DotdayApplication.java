package com.dotday;

import java.util.TimeZone;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class DotdayApplication {
  public static void main(String[] args) {
    // DB 의 DATETIME 은 UTC 로 저장한다. JVM 기본 시간대에 따라 값이 바뀌지 않도록 고정한다.
    TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
    SpringApplication.run(DotdayApplication.class, args);
  }
}
