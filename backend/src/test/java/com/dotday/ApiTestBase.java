package com.dotday;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
public abstract class ApiTestBase {
  @Autowired protected MockMvc mvc;
  @Autowired protected ObjectMapper json;
  @Autowired protected JdbcTemplate jdbc;

  protected record Session(String token, String userId, String email) {}

  protected Session signUp() throws Exception {
    String email = "u" + UUID.randomUUID().toString().substring(0, 8) + "@example.com";
    JsonNode r = body(mvc.perform(post("/api/auth/signup").contentType(MediaType.APPLICATION_JSON)
        .content(json.writeValueAsString(Map.of("email", email, "password", "secret123")))).andReturn());
    return new Session(r.get("access_token").asText(), r.get("user").get("id").asText(), email);
  }

  protected JsonNode body(MvcResult r) throws Exception {
    String s = r.getResponse().getContentAsString();
    return s.isEmpty() ? null : json.readTree(s);
  }

  protected MvcResult postJson(Session s, String path, Object payload) throws Exception {
    var req = post(path).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(payload));
    if (s != null) req = req.header("Authorization", "Bearer " + s.token());
    return mvc.perform(req).andReturn();
  }

  protected MvcResult getAs(Session s, String path) throws Exception {
    return mvc.perform(get(path).header("Authorization", "Bearer " + s.token())).andReturn();
  }

  protected JsonNode pushDomain(Session s, String opId, String entity, String id, int base, Map<String, Object> patch) throws Exception {
    return body(postJson(s, "/api/sync/domain/ops", Map.of("op_id", opId, "entity", entity, "id", id, "base_version", base, "patch", patch)));
  }

  protected static String uuid() {
    return UUID.randomUUID().toString();
  }
}
