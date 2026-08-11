package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/acme/attendance-service/internal/repository"
)

const defaultUserLookupTimeout = 5 * time.Second

// UserIdentityLookup resolves user identity from an email address.
type UserIdentityLookup interface {
	LookupUserIDByEmail(ctx context.Context, email, requesterUserID, requesterUserSig string) (string, error)
}

type httpUserIdentityLookup struct {
	baseURL string
	client  *http.Client
	timeout time.Duration
}

// NewHTTPUserIdentityLookup creates an auth-service-backed user lookup adapter.
func NewHTTPUserIdentityLookup(baseURL string, client *http.Client, timeout time.Duration) UserIdentityLookup {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil
	}
	if client == nil {
		client = &http.Client{}
	}
	if timeout <= 0 {
		timeout = defaultUserLookupTimeout
	}
	return &httpUserIdentityLookup{
		baseURL: baseURL,
		client:  client,
		timeout: timeout,
	}
}

func (l *httpUserIdentityLookup) LookupUserIDByEmail(
	ctx context.Context,
	email, requesterUserID, requesterUserSig string,
) (string, error) {
	if requesterUserID == "" {
		return "", ErrForbidden
	}
	normalizedEmail := strings.TrimSpace(strings.ToLower(email))
	if normalizedEmail == "" {
		return "", repository.ErrNotFound
	}

	lookupURL := fmt.Sprintf("%s/api/users/lookup?email=%s", l.baseURL, url.QueryEscape(normalizedEmail))
	callCtx, cancel := context.WithTimeout(ctx, l.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, lookupURL, nil)
	if err != nil {
		return "", fmt.Errorf("build user lookup request: %w", err)
	}
	req.Header.Set("X-User-Id", requesterUserID)
	if requesterUserSig != "" {
		req.Header.Set("X-User-Id-Sig", requesterUserSig)
	}

	resp, err := l.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("user lookup request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return "", repository.ErrNotFound
	case http.StatusUnauthorized, http.StatusForbidden:
		return "", ErrForbidden
	default:
		return "", fmt.Errorf("user lookup failed with status %d", resp.StatusCode)
	}

	var body struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("decode user lookup response: %w", err)
	}
	if strings.TrimSpace(body.User.ID) == "" {
		return "", repository.ErrNotFound
	}
	return body.User.ID, nil
}
