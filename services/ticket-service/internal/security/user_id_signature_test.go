package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"testing"
	"time"
)

const testKey = "test_signing_key_32_bytes_long"
const testUserID = "550e8400-e29b-41d4-a716-446655440000"

func TestValidSignatureCurrentMinute(t *testing.T) {
	validator := NewUserIDSignatureValidator(testKey)

	currentTime := time.Now().Unix()
	currentMinute := currentTime / 60

	expectedSig := computeSignature(testUserID, currentMinute, testKey)

	if !validator.IsValidSignature(testUserID, expectedSig) {
		t.Error("Should accept valid signature from current minute bucket")
	}
}

func TestValidSignaturePreviousMinute(t *testing.T) {
	validator := NewUserIDSignatureValidator(testKey)

	currentTime := time.Now().Unix()
	previousMinute := (currentTime / 60) - 1

	expectedSig := computeSignature(testUserID, previousMinute, testKey)

	if !validator.IsValidSignature(testUserID, expectedSig) {
		t.Error("Should accept valid signature from previous minute bucket")
	}
}

func TestInvalidSignatureWrongMinute(t *testing.T) {
	validator := NewUserIDSignatureValidator(testKey)

	currentTime := time.Now().Unix()
	twoMinutesAgo := (currentTime / 60) - 2

	wrongSig := computeSignature(testUserID, twoMinutesAgo, testKey)

	if validator.IsValidSignature(testUserID, wrongSig) {
		t.Error("Should reject signature from 2 minutes ago")
	}
}

func TestMissingSignatureWithKeyConfigured(t *testing.T) {
	validator := NewUserIDSignatureValidator(testKey)

	if validator.IsValidSignature(testUserID, "") {
		t.Error("Should reject empty signature when key is configured")
	}
}

func TestNoKeyConfiguredSkipsValidation(t *testing.T) {
	validator := NewUserIDSignatureValidator("")

	if !validator.IsValidSignature(testUserID, "") {
		t.Error("Should accept any signature when key is empty")
	}
	if !validator.IsValidSignature(testUserID, "invalid") {
		t.Error("Should accept any signature when key is empty")
	}
}

func TestMissingUserIDRejectsSignature(t *testing.T) {
	validator := NewUserIDSignatureValidator(testKey)

	if validator.IsValidSignature("", "anysig") {
		t.Error("Should reject empty user ID")
	}
}

func computeSignature(userID string, minute int64, key string) string {
	message := fmt.Sprintf("%s|%d", userID, minute)
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(message))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
