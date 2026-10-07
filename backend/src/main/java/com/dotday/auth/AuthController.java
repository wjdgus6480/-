package com.dotday.auth;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class AuthController {
  public record Credentials(String email, String password) {}

  public record PasswordOnly(String password) {}

  public record PasswordChange(@JsonProperty("current_password") String currentPassword, @JsonProperty("new_password") String newPassword) {}

  public record Confirm(String confirm) {}

  private final AuthService auth;

  public AuthController(AuthService auth) {
    this.auth = auth;
  }

  @PostMapping("/auth/signup")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> signUp(@RequestBody Credentials c) {
    return session(auth.signUp(c.email(), c.password()));
  }

  @PostMapping("/auth/login")
  public Map<String, Object> login(@RequestBody Credentials c) {
    return session(auth.signIn(c.email(), c.password()));
  }

  @GetMapping("/auth/me")
  public Map<String, Object> me(@AuthenticationPrincipal Jwt jwt) {
    return user(auth.me(CurrentUser.of(jwt)));
  }

  @PostMapping("/auth/logout")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void logout(@AuthenticationPrincipal Jwt jwt) {
    auth.signOut(CurrentUser.of(jwt));
  }

  @PostMapping("/auth/logout-all")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void logoutAll(@AuthenticationPrincipal Jwt jwt) {
    auth.signOutAll(CurrentUser.of(jwt));
  }

  @PostMapping("/auth/reauth")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void reauth(@AuthenticationPrincipal Jwt jwt, @RequestBody PasswordOnly p) {
    auth.reauthenticate(CurrentUser.of(jwt), p.password());
  }

  @PutMapping("/auth/password")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void changePassword(@AuthenticationPrincipal Jwt jwt, @RequestBody PasswordChange p) {
    auth.changePassword(CurrentUser.of(jwt), p.currentPassword(), p.newPassword());
  }

  @PostMapping("/account/delete")
  public Map<String, Object> deleteAccount(@AuthenticationPrincipal Jwt jwt, @RequestBody Confirm c) {
    return auth.deleteAccount(CurrentUser.of(jwt), c.confirm());
  }

  private static Map<String, Object> session(AuthService.SessionToken t) {
    return Map.of("access_token", t.accessToken(), "expires_at", t.expiresAt().toString(), "user", user(t.user()));
  }

  private static Map<String, Object> user(AuthService.UserInfo u) {
    return Map.of("id", u.id(), "email", u.email());
  }
}
