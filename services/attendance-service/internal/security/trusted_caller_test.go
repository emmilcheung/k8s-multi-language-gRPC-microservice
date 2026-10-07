package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"reflect"
	"testing"
	"time"
)

const callerKey = "test_signing_key_32_bytes_long"
const callerUser = "550e8400-e29b-41d4-a716-446655440000"

func signRoles(userID, roles string, minute int64, key string) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(fmt.Sprintf("%s|%s|%d", userID, roles, minute)))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func signUserID(userID string, minute int64, key string) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(fmt.Sprintf("%s|%d", userID, minute)))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func nowMinute() int64 { return time.Now().Unix() / 60 }

func TestRolesWithValidSignatureBecomePlatformRoles(t *testing.T) {
	v := NewCallerVerifier(callerKey)
	roles := "platform_admin,platform_support"

	got := v.TrustedCaller(callerUser, signUserID(callerUser, nowMinute(), callerKey),
		roles, signRoles(callerUser, roles, nowMinute(), callerKey))

	want := TrustedCaller{UserID: callerUser, PlatformRoles: []string{"platform_admin", "platform_support"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestRolesSignedInThePreviousMinuteAreStillAccepted(t *testing.T) {
	v := NewCallerVerifier(callerKey)
	roles := "platform_support"

	got := v.TrustedCaller(callerUser, signUserID(callerUser, nowMinute()-1, callerKey),
		roles, signRoles(callerUser, roles, nowMinute()-1, callerKey))

	if !reflect.DeepEqual(got.PlatformRoles, []string{"platform_support"}) {
		t.Errorf("a signature one minute old must still count, got %+v", got.PlatformRoles)
	}
}

func TestRolesWithoutValidRolesSignatureCountAsNoRoles(t *testing.T) {
	v := NewCallerVerifier(callerKey)
	idSig := signUserID(callerUser, nowMinute(), callerKey)
	other := "00000000-0000-0000-0000-000000000000"

	cases := map[string]struct{ roles, sig string }{
		"missing signature":              {"platform_admin", ""},
		"garbage signature":              {"platform_admin", "not-a-signature"},
		"user id signature reused":       {"platform_admin", idSig},
		"roles widened after signing":    {"platform_admin", signRoles(callerUser, "platform_support", nowMinute(), callerKey)},
		"signature of another user":      {"platform_admin", signRoles(other, "platform_admin", nowMinute(), callerKey)},
		"signature from two minutes ago": {"platform_admin", signRoles(callerUser, "platform_admin", nowMinute()-2, callerKey)},
		"signed with another key":        {"platform_admin", signRoles(callerUser, "platform_admin", nowMinute(), "another_key")},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			got := v.TrustedCaller(callerUser, idSig, c.roles, c.sig)
			if len(got.PlatformRoles) != 0 {
				t.Errorf("unsigned or forged roles must count as no roles, got %+v", got.PlatformRoles)
			}
			if got.UserID != callerUser {
				t.Errorf("a bad roles signature must not discard the verified user, got %q", got.UserID)
			}
		})
	}
}

func TestMissingRolesHeaderMeansNoPlatformRoles(t *testing.T) {
	v := NewCallerVerifier(callerKey)

	got := v.TrustedCaller(callerUser, signUserID(callerUser, nowMinute(), callerKey), "", "")

	if got.UserID != callerUser || len(got.PlatformRoles) != 0 {
		t.Errorf("got %+v, want the user with no platform roles", got)
	}
}

func TestOnlyPlatformRolesAreKeptFromSignedRoles(t *testing.T) {
	v := NewCallerVerifier(callerKey)
	roles := "organizer, platform_admin ,buyer,platform_admin,platform_root"

	got := v.TrustedCaller(callerUser, signUserID(callerUser, nowMinute(), callerKey),
		roles, signRoles(callerUser, roles, nowMinute(), callerKey))

	if !reflect.DeepEqual(got.PlatformRoles, []string{"platform_admin"}) {
		t.Errorf("legacy and unknown roles must be ignored, got %+v", got.PlatformRoles)
	}
}

func TestRolesAreNeverTrustedWhenTheSigningKeyIsNotConfigured(t *testing.T) {
	v := NewCallerVerifier("")

	got := v.TrustedCaller(callerUser, "", "platform_admin", signRoles(callerUser, "platform_admin", nowMinute(), ""))

	if len(got.PlatformRoles) != 0 {
		t.Errorf("without a key nothing can be verified, so roles must fail closed, got %+v", got.PlatformRoles)
	}
}

func TestUserWithoutValidUserIDSignatureIsNotATrustedCaller(t *testing.T) {
	v := NewCallerVerifier(callerKey)
	roles := "platform_admin"

	got := v.TrustedCaller(callerUser, "forged", roles, signRoles(callerUser, roles, nowMinute(), callerKey))

	if got.UserID != "" || len(got.PlatformRoles) != 0 {
		t.Errorf("a forged user id must yield an anonymous caller, got %+v", got)
	}
}
