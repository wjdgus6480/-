# Render 는 Java 실행 환경을 기본 제공하지 않으므로 Docker 로 배포한다.
# 1) 빌드: Maven 으로 실행 가능한 jar 생성 (테스트는 로컬·CI 에서 돌리고 이미지 빌드에서는 생략)
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q -DskipTests package

# 2) 실행: JRE 만 담은 작은 이미지, root 가 아닌 사용자로 실행
FROM eclipse-temurin:21-jre
WORKDIR /app
RUN useradd --system --uid 10001 app
COPY --from=build /app/target/dotday-backend.jar app.jar
USER app
# 무료 플랜 메모리(512MB)에 맞춰 힙을 제한한다
ENV JAVA_OPTS="-XX:MaxRAMPercentage=75 -XX:+UseSerialGC -Duser.timezone=UTC"
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar app.jar"]
