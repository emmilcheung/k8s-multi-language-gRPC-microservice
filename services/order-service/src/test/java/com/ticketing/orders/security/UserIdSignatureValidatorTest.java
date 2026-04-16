package com.ticketing.orders.security;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

class UserIdSignatureValidatorTest {

  private static final String TEST_KEY = "test_signing_key_32_bytes_long";
  private static final String TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";

  @Test
  void testValidSignatureCurrentMinute() {
    UserIdSignatureValidator validator = new UserIdSignatureValidator(TEST_KEY);

    long currentTime = System.currentTimeMillis() / 1000;
    long currentMinute = currentTime / 60;

    String expectedSig = computeSignature(TEST_USER_ID, currentMinute, TEST_KEY);

    assertTrue(validator.isValidSignature(TEST_USER_ID, expectedSig),
        "Should accept valid signature from current minute bucket");
  }

  @Test
  void testValidSignaturePreviousMinute() {
    UserIdSignatureValidator validator = new UserIdSignatureValidator(TEST_KEY);

    long currentTime = System.currentTimeMillis() / 1000;
    long previousMinute = (currentTime / 60) - 1;

    String expectedSig = computeSignature(TEST_USER_ID, previousMinute, TEST_KEY);

    assertTrue(validator.isValidSignature(TEST_USER_ID, expectedSig),
        "Should accept valid signature from previous minute bucket");
  }

  @Test
  void testInvalidSignatureWrongMinute() {
    UserIdSignatureValidator validator = new UserIdSignatureValidator(TEST_KEY);

    long currentTime = System.currentTimeMillis() / 1000;
    long twoMinutesAgo = (currentTime / 60) - 2;

    String wrongSig = computeSignature(TEST_USER_ID, twoMinutesAgo, TEST_KEY);

    assertFalse(validator.isValidSignature(TEST_USER_ID, wrongSig),
        "Should reject signature from 2 minutes ago");
  }

  @Test
  void testMissingSignatureWithKeyConfigured() {
    UserIdSignatureValidator validator = new UserIdSignatureValidator(TEST_KEY);

    assertFalse(validator.isValidSignature(TEST_USER_ID, null),
        "Should reject missing signature when key is configured");
    assertFalse(validator.isValidSignature(TEST_USER_ID, ""),
        "Should reject empty signature when key is configured");
  }

  @Test
  void testNoKeyConfiguredSkipsValidation() {
    UserIdSignatureValidator validator = new UserIdSignatureValidator("");

    assertTrue(validator.isValidSignature(TEST_USER_ID, null),
        "Should accept any signature (including null) when key is empty");
    assertTrue(validator.isValidSignature(TEST_USER_ID, "invalid"),
        "Should accept any signature when key is empty");
  }

  @Test
  void testMissingUserIdRejectsSignature() {
    UserIdSignatureValidator validator = new UserIdSignatureValidator(TEST_KEY);

    assertFalse(validator.isValidSignature(null, "anysig"),
        "Should reject null user ID");
    assertFalse(validator.isValidSignature("", "anysig"),
        "Should reject empty user ID");
  }

  private static String computeSignature(String userId, long minute, String key)
      throws AssertionError {
    try {
      String message = userId + "|" + minute;
      Mac mac = Mac.getInstance("HmacSHA256");
      SecretKeySpec secretKey = new SecretKeySpec(
          key.getBytes(StandardCharsets.UTF_8),
          0,
          key.length(),
          "HmacSHA256"
      );
      mac.init(secretKey);
      byte[] rawSignature = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
      return Base64.getEncoder().encodeToString(rawSignature);
    } catch (Exception e) {
      throw new AssertionError("Failed to compute signature", e);
    }
  }
}
