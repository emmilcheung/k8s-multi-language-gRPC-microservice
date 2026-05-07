// Package qr provides QR token generation and verification for admission credentials.
// Tokens are HMAC-SHA256 signed payloads carrying credential metadata.
// The signing key is sourced from QR_SIGNING_KEY; rotation is handled via token_version.
package qr

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrTokenInvalid is returned when a token signature fails verification.
var ErrTokenInvalid = errors.New("qr: token signature invalid")

// ErrTokenExpired is returned when a token is past its expiry.
var ErrTokenExpired = errors.New("qr: token expired")

// ErrTokenMalformed is returned when the token cannot be decoded or parsed.
var ErrTokenMalformed = errors.New("qr: token malformed")

// Claims holds the signed payload embedded in a QR token.
type Claims struct {
	// V is the token format version (always 1 for this schema).
	// Increment if the claims structure changes incompatibly.
	V            int       `json:"v"`
	CredentialID string    `json:"cid"`
	TicketID     string    `json:"tid"`
	EventID      string    `json:"eid"`
	TokenVersion int       `json:"ver"`
	IssuedAt     time.Time `json:"iat"`
	ExpiresAt    time.Time `json:"exp"`
}

// Generator signs and verifies QR tokens.
type Generator struct {
	signingKey []byte
}

// NewGenerator creates a Generator backed by the given signing key.
func NewGenerator(signingKey string) *Generator {
	return &Generator{signingKey: []byte(signingKey)}
}

// Generate creates a signed, base64url-encoded token for the given claims.
// The token format is: base64url(payload) + "." + base64url(signature)
func (g *Generator) Generate(claims Claims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("qr: marshal claims: %w", err)
	}

	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	sig := g.sign(encodedPayload)
	encodedSig := base64.RawURLEncoding.EncodeToString(sig)

	return encodedPayload + "." + encodedSig, nil
}

// Verify decodes and validates a token.
// Returns ErrTokenInvalid, ErrTokenExpired, or ErrTokenMalformed on failure.
func (g *Generator) Verify(token string) (*Claims, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return nil, ErrTokenMalformed
	}

	encodedPayload, encodedSig := parts[0], parts[1]

	expectedSig := g.sign(encodedPayload)
	gotSig, err := base64.RawURLEncoding.DecodeString(encodedSig)
	if err != nil {
		return nil, ErrTokenMalformed
	}
	if !hmac.Equal(expectedSig, gotSig) {
		return nil, ErrTokenInvalid
	}

	payload, err := base64.RawURLEncoding.DecodeString(encodedPayload)
	if err != nil {
		return nil, ErrTokenMalformed
	}

	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, ErrTokenMalformed
	}

	if time.Now().After(claims.ExpiresAt) {
		return nil, ErrTokenExpired
	}

	return &claims, nil
}

func (g *Generator) sign(data string) []byte {
	h := hmac.New(sha256.New, g.signingKey)
	h.Write([]byte(data))
	return h.Sum(nil)
}
