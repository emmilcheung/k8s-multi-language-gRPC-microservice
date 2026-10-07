package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

// Platform roles the authorization layer understands. Any other role string in
// X-User-Roles (for example a legacy "organizer") is ignored here.
const (
	RolePlatformAdmin   = "platform_admin"
	RolePlatformSupport = "platform_support"
)

// TrustedCaller is the caller identity that is safe to hand to the permission
// check: the user id is signed by the gateway and PlatformRoles holds only
// platform roles whose own signature verified.
type TrustedCaller struct {
	UserID        string
	PlatformRoles []string
}

// CallerVerifier builds a TrustedCaller from the gateway headers.
type CallerVerifier struct {
	signingKey string
	userID     *UserIDSignatureValidator
}

// NewCallerVerifier creates a verifier using the gateway's signing key.
func NewCallerVerifier(signingKey string) *CallerVerifier {
	return &CallerVerifier{signingKey: signingKey, userID: NewUserIDSignatureValidator(signingKey)}
}

// TrustedCaller verifies X-User-Id-Sig and X-User-Roles-Sig and returns the caller.
//
//   - An invalid user id signature yields an anonymous caller (no user, no roles).
//   - Roles count only when X-User-Roles-Sig = HMAC(userID|roles|minute) matches the
//     current or previous minute. A missing, stale or wrong signature, a missing
//     header, or an unconfigured signing key all mean no platform roles. Unlike the
//     user id check, roles never degrade open when the key is empty.
//   - Only platform_admin and platform_support are kept.
func (v *CallerVerifier) TrustedCaller(userID, userIDSig, rolesHeader, rolesSig string) TrustedCaller {
	if !v.userID.IsValidSignature(userID, userIDSig) {
		return TrustedCaller{}
	}
	caller := TrustedCaller{UserID: userID}
	if userID == "" || rolesHeader == "" || !v.validRolesSignature(userID, rolesHeader, rolesSig) {
		return caller
	}
	seen := map[string]bool{}
	for _, part := range strings.Split(rolesHeader, ",") {
		role := strings.TrimSpace(part)
		if (role == RolePlatformAdmin || role == RolePlatformSupport) && !seen[role] {
			seen[role] = true
			caller.PlatformRoles = append(caller.PlatformRoles, role)
		}
	}
	return caller
}

func (v *CallerVerifier) validRolesSignature(userID, roles, signature string) bool {
	if v.signingKey == "" || signature == "" {
		return false
	}
	minute := time.Now().Unix() / 60
	for _, m := range []int64{minute, minute - 1} {
		if hmac.Equal([]byte(v.rolesSignature(userID, roles, m)), []byte(signature)) {
			return true
		}
	}
	return false
}

func (v *CallerVerifier) rolesSignature(userID, roles string, minute int64) string {
	h := hmac.New(sha256.New, []byte(v.signingKey))
	h.Write([]byte(fmt.Sprintf("%s|%s|%d", userID, roles, minute)))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
