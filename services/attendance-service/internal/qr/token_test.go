package qr_test

import (
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
