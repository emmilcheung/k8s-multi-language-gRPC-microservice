package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"
)

// UserIDSignatureValidator validates X-User-Id-Sig headers using HMAC-SHA256
// with a minute-level time bucket. This limits replay attacks to a 60-second window.
//
// If the signing key is empty, validation is skipped for graceful degradation during rollout.
type UserIDSignatureValidator struct {
	signingKey string
}

// NewUserIDSignatureValidator creates a new validator.
func NewUserIDSignatureValidator(signingKey string) *UserIDSignatureValidator {
	return &UserIDSignatureValidator{signingKey: signingKey}
}

// IsValidSignature validates the X-User-Id-Sig header against the provided userID.
//
// Returns true if:
//   - Signing key is not configured (graceful degradation), OR
//   - Signature is present and matches the current or previous minute bucket
//
// Returns false if:
//   - Signing key is configured but signature is missing, OR
//   - Signature is present but invalid
func (v *UserIDSignatureValidator) IsValidSignature(userID, signature string) bool {
	if v.signingKey == "" {
		return true
	}

	if signature == "" {
		return false
	}

	if userID == "" {
		return false
	}

	currentTime := time.Now().Unix()
	currentMinute := currentTime / 60

	expectedCurrent := v.computeSignature(userID, currentMinute)
	if expectedCurrent == signature {
		return true
	}

	expectedPrevious := v.computeSignature(userID, currentMinute-1)
	return expectedPrevious == signature
}

func (v *UserIDSignatureValidator) computeSignature(userID string, minute int64) string {
	message := fmt.Sprintf("%s|%d", userID, minute)
	h := hmac.New(sha256.New, []byte(v.signingKey))
	h.Write([]byte(message))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
