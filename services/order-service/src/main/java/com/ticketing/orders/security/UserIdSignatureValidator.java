package com.ticketing.orders.security;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Validates X-User-Id-Sig header using HMAC-SHA256 with a minute-level time bucket.
 *
 * The signature is computed as: HMAC-SHA256(key, userId + "|" + currentMinute)
 * This limits replay attacks to a 60-second window.
 *
 * If X_USER_ID_SIGNING_KEY is not configured, signature validation is skipped
 * but the header is still extracted for backwards compatibility during rollout.
 */
@Component
public class UserIdSignatureValidator {

  private final String signingKey;

  public UserIdSignatureValidator(@Value("${X_USER_ID_SIGNING_KEY:}") String signingKey) {
    this.signingKey = signingKey != null ? signingKey.trim() : "";
  }

  /**
   * Validates the X-User-Id-Sig header against the provided userId.
   *
   * Returns true if:
   *   - Signing key is not configured (graceful degradation during rollout), OR
   *   - Signature is present and matches the current or previous minute bucket
   *
   * Returns false if:
   *   - Signing key is configured but signature is missing, OR
   *   - Signature is present but invalid
   *
   * @param userId the X-User-Id value to validate
   * @param signature the X-User-Id-Sig header value (may be null)
   * @return true if signature is valid or signing is not configured
   */
  public boolean isValidSignature(String userId, String signature) {
    if (signingKey.isEmpty()) {
      return true;
    }

    if (signature == null || signature.trim().isEmpty()) {
      return false;
    }

    if (userId == null || userId.trim().isEmpty()) {
      return false;
    }

    try {
      long currentTime = System.currentTimeMillis() / 1000;
      long currentMinute = currentTime / 60;

      String expectedCurrent = computeSignature(userId, currentMinute);
      if (expectedCurrent.equals(signature)) {
        return true;
      }

      String expectedPrevious = computeSignature(userId, currentMinute - 1);
      if (expectedPrevious.equals(signature)) {
        return true;
      }

      return false;
    } catch (Exception e) {
      return false;
    }
  }

  private String computeSignature(String userId, long minute) throws Exception {
    String message = userId + "|" + minute;
    Mac mac = Mac.getInstance("HmacSHA256");
    SecretKeySpec secretKey = new SecretKeySpec(
        signingKey.getBytes(StandardCharsets.UTF_8),
        0,
        signingKey.length(),
        "HmacSHA256"
    );
    mac.init(secretKey);
    byte[] rawSignature = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
    return Base64.getEncoder().encodeToString(rawSignature);
  }
}
