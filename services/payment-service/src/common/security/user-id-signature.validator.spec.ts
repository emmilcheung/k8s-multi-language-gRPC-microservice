import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { UserIdSignatureValidator } from './user-id-signature.validator';

describe('UserIdSignatureValidator', () => {
  const TEST_KEY = 'test_signing_key_32_bytes_long';
  const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

  it('should accept valid signature from current minute', () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);
    const currentTimeSeconds = Math.floor(Date.now() / 1000);
    const currentMinute = Math.floor(currentTimeSeconds / 60);

    const expectedSig = computeSignature(TEST_USER_ID, currentMinute, TEST_KEY);

    expect(validator.isValidSignature(TEST_USER_ID, expectedSig)).toBe(true);
  });

  it('should accept valid signature from previous minute', () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);
    const currentTimeSeconds = Math.floor(Date.now() / 1000);
    const previousMinute = Math.floor(currentTimeSeconds / 60) - 1;

    const expectedSig = computeSignature(TEST_USER_ID, previousMinute, TEST_KEY);

    expect(validator.isValidSignature(TEST_USER_ID, expectedSig)).toBe(true);
  });

  it('should reject signature from 2 minutes ago', () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);
    const currentTimeSeconds = Math.floor(Date.now() / 1000);
    const twoMinutesAgo = Math.floor(currentTimeSeconds / 60) - 2;

    const wrongSig = computeSignature(TEST_USER_ID, twoMinutesAgo, TEST_KEY);

    expect(validator.isValidSignature(TEST_USER_ID, wrongSig)).toBe(false);
  });

  it('should reject missing signature when key is configured', () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);

    expect(validator.isValidSignature(TEST_USER_ID, undefined)).toBe(false);
    expect(validator.isValidSignature(TEST_USER_ID, '')).toBe(false);
  });

  it('should skip validation when key is empty', () => {
    const validator = new UserIdSignatureValidator('');

    expect(validator.isValidSignature(TEST_USER_ID, undefined)).toBe(true);
    expect(validator.isValidSignature(TEST_USER_ID, 'invalid')).toBe(true);
  });

  it('should reject when user ID is missing', () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);

    expect(validator.isValidSignature(undefined, 'anysig')).toBe(false);
    expect(validator.isValidSignature('', 'anysig')).toBe(false);
  });

  function computeSignature(userId: string, minute: number, key: string): string {
    const message = `${userId}|${minute}`;
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(message);
    return hmac.digest('base64');
  }
});
