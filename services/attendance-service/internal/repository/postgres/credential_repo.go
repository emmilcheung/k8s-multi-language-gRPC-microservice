// Package postgres provides PostgreSQL implementations of the repository interfaces.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/jackc/pgconn"
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
		SELECT id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key,
		       status, issued_at, issuance_event_published_at,
		       revoked_at, used_at, used_by_user_id, used_by_device_id,
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
		SELECT id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key,
		       status, issued_at, issuance_event_published_at,
		       revoked_at, used_at, used_by_user_id, used_by_device_id,
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

// FindByTicketAndBuyer returns the most recently issued credential for a ticket owned by buyerUserID.
func (r *CredentialRepo) FindByTicketAndBuyer(ctx context.Context, ticketID, buyerUserID string) (*repository.AdmissionCredential, error) {
	const q = `
		SELECT id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key,
		       status, issued_at, issuance_event_published_at,
		       revoked_at, used_at, used_by_user_id, used_by_device_id,
		       created_at, updated_at
		FROM admission_credentials
		WHERE ticket_id = $1 AND buyer_user_id = $2
		ORDER BY issued_at DESC
		LIMIT 1`

	row := r.db.QueryRow(ctx, q, ticketID, buyerUserID)
	cred, err := scanCredential(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, fmt.Errorf("credential_repo: find by ticket+buyer: %w", err)
	}
	return cred, nil
}

// FindByTicketAndOrder returns a credential matching both ticketID and orderID.
func (r *CredentialRepo) FindByTicketAndOrder(ctx context.Context, ticketID, orderID string) (*repository.AdmissionCredential, error) {
	const q = `
		SELECT id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key,
		       status, issued_at, issuance_event_published_at,
		       revoked_at, used_at, used_by_user_id, used_by_device_id,
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
		SELECT id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key,
		       status, issued_at, issuance_event_published_at,
		       revoked_at, used_at, used_by_user_id, used_by_device_id,
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
		    (id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key, status, issued_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`

	_, err := r.db.Exec(ctx, q,
		cred.ID, cred.TicketID, cred.OrderID, cred.BuyerUserID, cred.EventID,
		cred.TokenVersion, cred.TokenID, cred.QRToken, cred.IssuanceKey, string(cred.Status), cred.IssuedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return repository.ErrDuplicate
		}
		return fmt.Errorf("credential_repo: create: %w", err)
	}
	return nil
}

// CreateWithOutbox inserts a new admission credential and its outbox row in one transaction.
func (r *CredentialRepo) CreateWithOutbox(
	ctx context.Context,
	cred *repository.AdmissionCredential,
	outbox *repository.OutboxRow,
) error {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("credential_repo: begin create with outbox tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const credentialInsert = `
		INSERT INTO admission_credentials
		    (id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key, status, issued_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`
	if _, err := tx.Exec(ctx, credentialInsert,
		cred.ID, cred.TicketID, cred.OrderID, cred.BuyerUserID, cred.EventID,
		cred.TokenVersion, cred.TokenID, cred.QRToken, cred.IssuanceKey, string(cred.Status), cred.IssuedAt,
	); err != nil {
		if isUniqueViolation(err) {
			return repository.ErrDuplicate
		}
		return fmt.Errorf("credential_repo: create credential with outbox: %w", err)
	}

	traceHeaders := outbox.TraceHeaders
	if len(traceHeaders) == 0 {
		traceHeaders = json.RawMessage(`{}`)
	}

	const outboxInsert = `
		INSERT INTO outbox (id, topic, payload, trace_headers, partition_key, published)
		VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, false)`
	if _, err := tx.Exec(ctx, outboxInsert,
		outbox.ID, outbox.Topic, string(outbox.Payload), string(traceHeaders), outbox.PartitionKey,
	); err != nil {
		return fmt.Errorf("credential_repo: create outbox row: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("credential_repo: commit create with outbox: %w", err)
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

// ConsumeIssued marks an issued credential as used with row-level locking.
func (r *CredentialRepo) ConsumeIssued(
	ctx context.Context,
	id string,
	usedAt time.Time,
	scannerUserID, deviceID string,
) (*repository.AdmissionCredential, bool, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, false, fmt.Errorf("credential_repo: begin consume tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const lockQuery = `
		SELECT id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key,
		       status, issued_at, issuance_event_published_at,
		       revoked_at, used_at, used_by_user_id, used_by_device_id,
		       created_at, updated_at
		FROM admission_credentials
		WHERE id = $1
		FOR UPDATE`
	cred, err := scanCredential(tx.QueryRow(ctx, lockQuery, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, repository.ErrNotFound
		}
		return nil, false, fmt.Errorf("credential_repo: lock credential: %w", err)
	}

	if cred.Status != repository.CredentialStatusIssued {
		if err := tx.Commit(ctx); err != nil {
			return nil, false, fmt.Errorf("credential_repo: commit consume no-op: %w", err)
		}
		return cred, false, nil
	}

	const updateQuery = `
		UPDATE admission_credentials
		SET status = 'USED',
		    used_at = $2,
		    used_by_user_id = $3,
		    used_by_device_id = $4,
		    updated_at = now()
		WHERE id = $1 AND status = 'ISSUED'`
	ct, err := tx.Exec(ctx, updateQuery, id, usedAt, scannerUserID, deviceID)
	if err != nil {
		return nil, false, fmt.Errorf("credential_repo: consume issued update: %w", err)
	}
	if ct.RowsAffected() == 0 {
		if err := tx.Commit(ctx); err != nil {
			return nil, false, fmt.Errorf("credential_repo: commit consume race: %w", err)
		}
		latest, latestErr := r.FindByID(ctx, id)
		if latestErr != nil {
			return nil, false, latestErr
		}
		return latest, false, nil
	}

	cred.Status = repository.CredentialStatusUsed
	cred.UsedAt = &usedAt
	scanner := scannerUserID
	cred.UsedByUserID = &scanner
	device := deviceID
	cred.UsedByDeviceID = &device

	if err := tx.Commit(ctx); err != nil {
		return nil, false, fmt.Errorf("credential_repo: commit consume success: %w", err)
	}
	return cred, true, nil
}

// MarkEventPublished records the time at which the attendance.qr.issued event was
// successfully published, enabling retries to distinguish "not yet published" from
// "already published" without re-emitting a duplicate event.
func (r *CredentialRepo) MarkEventPublished(ctx context.Context, id string, publishedAt time.Time) error {
	const q = `UPDATE admission_credentials
		SET issuance_event_published_at = $1, updated_at = now()
		WHERE id = $2`
	ct, err := r.db.Exec(ctx, q, publishedAt, id)
	if err != nil {
		return fmt.Errorf("credential_repo: mark event published: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return repository.ErrNotFound
	}
	return nil
}

// ListCheckedInByEventID returns recently used credentials for the given event.
func (r *CredentialRepo) ListCheckedInByEventID(
	ctx context.Context,
	eventID string,
	limit int,
) ([]*repository.AdmissionCredential, error) {
	if limit <= 0 {
		limit = 50
	}
	const q = `
		SELECT id, ticket_id, order_id, buyer_user_id, event_id, token_version, token_id, qr_token, issuance_key,
		       status, issued_at, issuance_event_published_at,
		       revoked_at, used_at, used_by_user_id, used_by_device_id,
		       created_at, updated_at
		FROM admission_credentials
		WHERE event_id = $1 AND status = 'USED'
		ORDER BY used_at DESC, updated_at DESC
		LIMIT $2`
	rows, err := r.db.Query(ctx, q, eventID, limit)
	if err != nil {
		return nil, fmt.Errorf("credential_repo: list checked in by event: %w", err)
	}
	defer rows.Close()

	records := make([]*repository.AdmissionCredential, 0, limit)
	for rows.Next() {
		cred, scanErr := scanCredential(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("credential_repo: scan checked in credential: %w", scanErr)
		}
		records = append(records, cred)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("credential_repo: iterate checked in credentials: %w", err)
	}
	return records, nil
}

func (r *CredentialRepo) CreateTransfer(ctx context.Context, transfer *repository.AdmissionTransfer) error {
	const q = `
		INSERT INTO admission_transfers
			(id, credential_id, sender_user_id, recipient_user_id, recipient_email, state, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`
	_, err := r.db.Exec(
		ctx,
		q,
		transfer.ID,
		transfer.CredentialID,
		transfer.SenderUserID,
		transfer.RecipientUserID,
		transfer.RecipientEmail,
		string(transfer.State),
		transfer.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("credential_repo: create transfer: %w", err)
	}
	return nil
}

func (r *CredentialRepo) FindLatestTransferByCredentialID(ctx context.Context, credentialID string) (*repository.AdmissionTransfer, error) {
	const q = `
		SELECT id, credential_id, sender_user_id, recipient_user_id, recipient_email, state, created_at, accepted_at, recalled_at
		FROM admission_transfers
		WHERE credential_id = $1
		ORDER BY created_at DESC
		LIMIT 1`
	row := r.db.QueryRow(ctx, q, credentialID)
	return scanTransfer(row)
}

func (r *CredentialRepo) FindTransferByID(ctx context.Context, id string) (*repository.AdmissionTransfer, error) {
	const q = `
		SELECT id, credential_id, sender_user_id, recipient_user_id, recipient_email, state, created_at, accepted_at, recalled_at
		FROM admission_transfers
		WHERE id = $1`
	row := r.db.QueryRow(ctx, q, id)
	return scanTransfer(row)
}

func (r *CredentialRepo) AcceptTransfer(
	ctx context.Context,
	transferID string,
	recipientUserID string,
	acceptedAt time.Time,
) (*repository.AdmissionTransfer, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("credential_repo: begin accept transfer tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const lockQ = `
		SELECT id, credential_id, sender_user_id, recipient_user_id, recipient_email, state, created_at, accepted_at, recalled_at
		FROM admission_transfers
		WHERE id = $1
		FOR UPDATE`
	transfer, err := scanTransfer(tx.QueryRow(ctx, lockQ, transferID))
	if err != nil {
		return nil, err
	}
	if transfer.State != repository.TransferStatePending {
		return nil, repository.ErrNotFound
	}

	const updateTransferQ = `
		UPDATE admission_transfers
		SET state = 'ACCEPTED',
		    recipient_user_id = $2,
		    accepted_at = $3
		WHERE id = $1`
	if _, err := tx.Exec(ctx, updateTransferQ, transferID, recipientUserID, acceptedAt); err != nil {
		return nil, fmt.Errorf("credential_repo: accept transfer update transfer: %w", err)
	}

	const updateCredentialQ = `
		UPDATE admission_credentials
		SET buyer_user_id = $2,
		    updated_at = now()
		WHERE id = $1`
	if _, err := tx.Exec(ctx, updateCredentialQ, transfer.CredentialID, recipientUserID); err != nil {
		return nil, fmt.Errorf("credential_repo: accept transfer update credential: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("credential_repo: commit accept transfer: %w", err)
	}

	transfer.State = repository.TransferStateAccepted
	transfer.RecipientUserID = &recipientUserID
	transfer.AcceptedAt = &acceptedAt
	return transfer, nil
}

func (r *CredentialRepo) RecallTransfer(
	ctx context.Context,
	credentialID string,
	senderUserID string,
	recalledAt time.Time,
) (*repository.AdmissionTransfer, error) {
	const q = `
		UPDATE admission_transfers
		SET state = 'RECALLED',
		    recalled_at = $3
		WHERE credential_id = $1
		  AND sender_user_id = $2
		  AND state = 'PENDING'
		RETURNING id, credential_id, sender_user_id, recipient_user_id, recipient_email, state, created_at, accepted_at, recalled_at`
	row := r.db.QueryRow(ctx, q, credentialID, senderUserID, recalledAt)
	transfer, err := scanTransfer(row)
	if err != nil {
		return nil, err
	}
	return transfer, nil
}

func (r *CredentialRepo) UpdateCredentialBuyer(ctx context.Context, credentialID string, buyerUserID string) error {
	const q = `
		UPDATE admission_credentials
		SET buyer_user_id = $2,
		    updated_at = now()
		WHERE id = $1`
	ct, err := r.db.Exec(ctx, q, credentialID, buyerUserID)
	if err != nil {
		return fmt.Errorf("credential_repo: update credential buyer: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return repository.ErrNotFound
	}
	return nil
}

// ListUnpublished returns unpublished outbox rows ordered by creation time.
func (r *CredentialRepo) ListUnpublished(ctx context.Context, limit int) ([]*repository.OutboxRow, error) {
	if limit <= 0 {
		limit = 100
	}
	const q = `
		SELECT id, topic, payload, trace_headers, partition_key, published, created_at
		FROM outbox
		WHERE published = false
		ORDER BY created_at ASC
		LIMIT $1`
	rows, err := r.db.Query(ctx, q, limit)
	if err != nil {
		return nil, fmt.Errorf("credential_repo: list unpublished outbox: %w", err)
	}
	defer rows.Close()

	var outboxRows []*repository.OutboxRow
	for rows.Next() {
		var row repository.OutboxRow
		if err := rows.Scan(
			&row.ID, &row.Topic, &row.Payload, &row.TraceHeaders,
			&row.PartitionKey, &row.Published, &row.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("credential_repo: scan unpublished outbox: %w", err)
		}
		outboxRows = append(outboxRows, &row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("credential_repo: iterate unpublished outbox: %w", err)
	}
	return outboxRows, nil
}

// ListUnpublishedTx selects up to limit unpublished outbox rows inside tx using
// FOR UPDATE SKIP LOCKED so that concurrent relay replicas each claim disjoint
// sets of rows.  The caller must commit or roll back tx.
func (r *CredentialRepo) ListUnpublishedTx(ctx context.Context, tx pgx.Tx, limit int) ([]*repository.OutboxRow, error) {
	if limit <= 0 {
		limit = 100
	}
	const q = `
		SELECT id, topic, payload, trace_headers, partition_key, published, created_at
		FROM outbox
		WHERE published = false
		ORDER BY created_at ASC
		LIMIT $1
		FOR UPDATE SKIP LOCKED`
	rows, err := tx.Query(ctx, q, limit)
	if err != nil {
		return nil, fmt.Errorf("credential_repo: list unpublished tx: %w", err)
	}
	defer rows.Close()

	var outboxRows []*repository.OutboxRow
	for rows.Next() {
		var row repository.OutboxRow
		if err := rows.Scan(
			&row.ID, &row.Topic, &row.Payload, &row.TraceHeaders,
			&row.PartitionKey, &row.Published, &row.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("credential_repo: scan unpublished tx outbox: %w", err)
		}
		outboxRows = append(outboxRows, &row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("credential_repo: iterate unpublished tx outbox: %w", err)
	}
	return outboxRows, nil
}

// MarkPublishedTx marks a single outbox row as published inside an existing
// transaction.  The caller owns the commit/rollback lifecycle.
func (r *CredentialRepo) MarkPublishedTx(ctx context.Context, tx pgx.Tx, id string, publishedAt time.Time) error {
	const q = `UPDATE outbox SET published = true, published_at = $2 WHERE id = $1 AND published = false`
	ct, err := tx.Exec(ctx, q, id, publishedAt)
	if err != nil {
		return fmt.Errorf("credential_repo: mark published tx: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return repository.ErrNotFound
	}
	return nil
}

// MarkPublished marks the outbox row as published and records the publish time on the credential.
func (r *CredentialRepo) MarkPublished(ctx context.Context, id string, publishedAt time.Time) error {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("credential_repo: begin mark published tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const outboxUpdate = `
		UPDATE outbox
		SET published = true
		WHERE id = $1 AND published = false`
	ct, err := tx.Exec(ctx, outboxUpdate, id)
	if err != nil {
		return fmt.Errorf("credential_repo: mark outbox published: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return repository.ErrNotFound
	}

	const credentialUpdate = `
		UPDATE admission_credentials
		SET issuance_event_published_at = $2, updated_at = now()
		WHERE id = $1`
	ct, err = tx.Exec(ctx, credentialUpdate, id, publishedAt)
	if err != nil {
		return fmt.Errorf("credential_repo: mark credential event published: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return repository.ErrNotFound
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("credential_repo: commit mark published: %w", err)
	}
	return nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func scanCredential(row pgx.Row) (*repository.AdmissionCredential, error) {
	var c repository.AdmissionCredential
	var status string
	err := row.Scan(
		&c.ID, &c.TicketID, &c.OrderID, &c.BuyerUserID, &c.EventID,
		&c.TokenVersion, &c.TokenID, &c.QRToken, &c.IssuanceKey, &status,
		&c.IssuedAt, &c.IssuanceEventPublishedAt,
		&c.RevokedAt, &c.UsedAt, &c.UsedByUserID, &c.UsedByDeviceID,
		&c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	c.Status = repository.CredentialStatus(status)
	c.TransferState = repository.TransferStateNone
	return &c, nil
}

func scanTransfer(row pgx.Row) (*repository.AdmissionTransfer, error) {
	var t repository.AdmissionTransfer
	var state string
	err := row.Scan(
		&t.ID,
		&t.CredentialID,
		&t.SenderUserID,
		&t.RecipientUserID,
		&t.RecipientEmail,
		&state,
		&t.CreatedAt,
		&t.AcceptedAt,
		&t.RecalledAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, fmt.Errorf("credential_repo: scan transfer: %w", err)
	}
	t.State = repository.TransferState(state)
	return &t, nil
}
