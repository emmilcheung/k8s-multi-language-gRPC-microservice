// Package postgres provides PostgreSQL implementations of the repository interfaces.
package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CredentialRepo implements repository.CredentialRepository using pgxpool.
type CredentialRepo struct {
	db *pgxpool.Pool
}

// NewCredentialRepo creates a new CredentialRepo.
func NewCredentialRepo(db *pgxpool.Pool) *CredentialRepo {
	return &CredentialRepo{db: db}
}

// FindByID returns the credential with the given primary key.
func (r *CredentialRepo) FindByID(ctx context.Context, id string) (*repository.AdmissionCredential, error) {
	const q = `
		SELECT id, ticket_id, order_id, event_id, token_version, token_id, issuance_key,
		       status, issued_at, revoked_at, used_at, used_by_user_id, used_by_device_id,
		       created_at, updated_at
		FROM admission_credentials
		WHERE id = $1`

	row := r.db.QueryRow(ctx, q, id)
	cred, err := scanCredential(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, fmt.Errorf("credential_repo: find by id: %w", err)
	}
	return cred, nil
}

// FindByTicketID returns the most recently issued credential for a ticket.
func (r *CredentialRepo) FindByTicketID(ctx context.Context, ticketID string) (*repository.AdmissionCredential, error) {
	const q = `
		SELECT id, ticket_id, order_id, event_id, token_version, token_id, issuance_key,
		       status, issued_at, revoked_at, used_at, used_by_user_id, used_by_device_id,
		       created_at, updated_at
		FROM admission_credentials
		WHERE ticket_id = $1
		ORDER BY issued_at DESC
		LIMIT 1`

	row := r.db.QueryRow(ctx, q, ticketID)
	cred, err := scanCredential(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, fmt.Errorf("credential_repo: find by ticket_id: %w", err)
	}
	return cred, nil
}

// FindByTicketAndOrder returns a credential matching both ticketID and orderID.
func (r *CredentialRepo) FindByTicketAndOrder(ctx context.Context, ticketID, orderID string) (*repository.AdmissionCredential, error) {
	const q = `
		SELECT id, ticket_id, order_id, event_id, token_version, token_id, issuance_key,
		       status, issued_at, revoked_at, used_at, used_by_user_id, used_by_device_id,
		       created_at, updated_at
		FROM admission_credentials
		WHERE ticket_id = $1 AND order_id = $2
		ORDER BY issued_at DESC
		LIMIT 1`

	row := r.db.QueryRow(ctx, q, ticketID, orderID)
	cred, err := scanCredential(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, fmt.Errorf("credential_repo: find by ticket+order: %w", err)
	}
	return cred, nil
}

// FindByIssuanceKey returns the credential with the given idempotency key.
func (r *CredentialRepo) FindByIssuanceKey(ctx context.Context, issuanceKey string) (*repository.AdmissionCredential, error) {
	const q = `
		SELECT id, ticket_id, order_id, event_id, token_version, token_id, issuance_key,
		       status, issued_at, revoked_at, used_at, used_by_user_id, used_by_device_id,
		       created_at, updated_at
		FROM admission_credentials
		WHERE issuance_key = $1`

	row := r.db.QueryRow(ctx, q, issuanceKey)
	cred, err := scanCredential(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, fmt.Errorf("credential_repo: find by issuance_key: %w", err)
	}
	return cred, nil
}

// Create inserts a new admission credential.
func (r *CredentialRepo) Create(ctx context.Context, cred *repository.AdmissionCredential) error {
	const q = `
		INSERT INTO admission_credentials
		    (id, ticket_id, order_id, event_id, token_version, token_id, issuance_key, status, issued_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

	_, err := r.db.Exec(ctx, q,
		cred.ID, cred.TicketID, cred.OrderID, cred.EventID,
		cred.TokenVersion, cred.TokenID, cred.IssuanceKey, string(cred.Status), cred.IssuedAt,
	)
	if err != nil {
		return fmt.Errorf("credential_repo: create: %w", err)
	}
	return nil
}

// UpdateStatus updates the status (and associated timestamps) of a credential.
func (r *CredentialRepo) UpdateStatus(ctx context.Context, id string, status repository.CredentialStatus) error {
	const q = `UPDATE admission_credentials SET status = $1, updated_at = now() WHERE id = $2`
	ct, err := r.db.Exec(ctx, q, string(status), id)
	if err != nil {
		return fmt.Errorf("credential_repo: update status: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return repository.ErrNotFound
	}
	return nil
}

func scanCredential(row pgx.Row) (*repository.AdmissionCredential, error) {
	var c repository.AdmissionCredential
	var status string
	err := row.Scan(
		&c.ID, &c.TicketID, &c.OrderID, &c.EventID,
		&c.TokenVersion, &c.TokenID, &c.IssuanceKey, &status,
		&c.IssuedAt, &c.RevokedAt, &c.UsedAt, &c.UsedByUserID, &c.UsedByDeviceID,
		&c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	c.Status = repository.CredentialStatus(status)
	return &c, nil
}
