package qr_test

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/acme/attendance-service/internal/qr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testKey = "test-signing-key-that-is-long-enough-32c"

func makeClaims(expOffset time.Duration) qr.Claims {
	now := time.Now()
	return qr.Claims{
		CredentialID: "cred-001",
		TicketID:     "ticket-001",
		EventID:      "event-001",
		TokenVersion: 1,
		IssuedAt:     now,
		ExpiresAt:    now.Add(expOffset),
	}
}

func TestGenerate_ShouldProduceNonEmptyToken(t *testing.T) {
	g := qr.NewGenerator(testKey)
	claims := makeClaims(5 * time.Minute)

	token, err := g.Generate(claims)
	require.NoError(t, err)
	assert.NotEmpty(t, token)
	assert.Contains(t, token, ".")
}

func TestVerify_ShouldSucceed_WithValidToken(t *testing.T) {
	g := qr.NewGenerator(testKey)
	claims := makeClaims(5 * time.Minute)

	token, err := g.Generate(claims)
	require.NoError(t, err)

	got, err := g.Verify(token)
	require.NoError(t, err)
	assert.Equal(t, claims.CredentialID, got.CredentialID)
	assert.Equal(t, claims.TicketID, got.TicketID)
	assert.Equal(t, claims.EventID, got.EventID)
	assert.Equal(t, claims.TokenVersion, got.TokenVersion)
}

func TestVerify_ShouldFail_WithTamperedPayload(t *testing.T) {
	g := qr.NewGenerator(testKey)
	claims := makeClaims(5 * time.Minute)

	token, err := g.Generate(claims)
	require.NoError(t, err)

	// Tamper with the payload section
	parts := splitToken(token)
	require.Len(t, parts, 2)
	tampered := "dGFtcGVyZWQ" + "." + parts[1] // replace payload with "tampered"

	_, err = g.Verify(tampered)
	assert.ErrorIs(t, err, qr.ErrTokenInvalid)
}

func TestVerify_ShouldFail_WithWrongKey(t *testing.T) {
	g1 := qr.NewGenerator(testKey)
	g2 := qr.NewGenerator("completely-different-key-also-long-enough")

	claims := makeClaims(5 * time.Minute)
	token, err := g1.Generate(claims)
	require.NoError(t, err)

	_, err = g2.Verify(token)
	assert.ErrorIs(t, err, qr.ErrTokenInvalid)
}

func TestVerify_ShouldFail_WithExpiredToken(t *testing.T) {
	g := qr.NewGenerator(testKey)
	claims := makeClaims(-1 * time.Second) // already expired

	token, err := g.Generate(claims)
	require.NoError(t, err)

	_, err = g.Verify(token)
	assert.ErrorIs(t, err, qr.ErrTokenExpired)
}

func TestVerify_ShouldFail_WithMalformedToken(t *testing.T) {
	g := qr.NewGenerator(testKey)

	_, err := g.Verify("notavalidtoken")
	assert.ErrorIs(t, err, qr.ErrTokenMalformed)

	_, err = g.Verify("")
	assert.ErrorIs(t, err, qr.ErrTokenMalformed)

	_, err = g.Verify("part1.!!!invalid-base64!!!")
	assert.ErrorIs(t, err, qr.ErrTokenMalformed)
}

func TestGenerate_DifferentKeysProduceDifferentTokens(t *testing.T) {
	g1 := qr.NewGenerator(testKey)
	g2 := qr.NewGenerator("completely-different-key-also-long-enough")
	claims := makeClaims(5 * time.Minute)

	token1, err := g1.Generate(claims)
	require.NoError(t, err)
	token2, err := g2.Generate(claims)
	require.NoError(t, err)

	assert.NotEqual(t, token1, token2)
}

// TestGenerate_ClaimNamesMatchSpec asserts the exact JSON key names in the
// serialized payload match the approved WS2 token claim shape.
func TestGenerate_ClaimNamesMatchSpec(t *testing.T) {
	g := qr.NewGenerator(testKey)
	claims := makeClaims(5 * time.Minute)
	claims.V = 1

	token, err := g.Generate(claims)
	require.NoError(t, err)

	parts := splitToken(token)
	require.Len(t, parts, 2)

	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	require.NoError(t, err)

	var raw map[string]any
	require.NoError(t, json.Unmarshal(payload, &raw))

	assert.Contains(t, raw, "v", "expected key 'v'")
	assert.Contains(t, raw, "credentialId", "expected key 'credentialId'")
	assert.Contains(t, raw, "ticketId", "expected key 'ticketId'")
	assert.Contains(t, raw, "eventId", "expected key 'eventId'")
	assert.Contains(t, raw, "tokenVersion", "expected key 'tokenVersion'")
	assert.Contains(t, raw, "iat", "expected key 'iat'")
	assert.Contains(t, raw, "exp", "expected key 'exp'")

	assert.NotContains(t, raw, "cid", "old key 'cid' must not appear")
	assert.NotContains(t, raw, "tid", "old key 'tid' must not appear")
	assert.NotContains(t, raw, "eid", "old key 'eid' must not appear")
	assert.NotContains(t, raw, "ver", "old key 'ver' must not appear")
}

func splitToken(token string) []string {
	idx := len(token) - 1
	for idx >= 0 && token[idx] != '.' {
		idx--
	}
	if idx < 0 {
		return []string{token}
	}
	return []string{token[:idx], token[idx+1:]}
}
