package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// dbtx is what a repository needs from either the pool or a transaction.
type dbtx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type txKey struct{}

// WithTx makes the repositories that use conn run on tx for every call made
// with the returned context, so a change and its audit row commit together.
func WithTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, txKey{}, tx)
}

// conn returns the transaction carried by ctx, or the pool when there is none.
func conn(ctx context.Context, pool *pgxpool.Pool) dbtx {
	if tx, ok := ctx.Value(txKey{}).(pgx.Tx); ok {
		return tx
	}
	return pool
}

// TxRunner runs a function inside one database transaction.
type TxRunner struct{ pool *pgxpool.Pool }

// NewTxRunner creates a TxRunner on the given pool.
func NewTxRunner(pool *pgxpool.Pool) *TxRunner { return &TxRunner{pool: pool} }

// InTx begins a transaction, passes fn a context that carries it, and commits
// when fn returns nil; any error rolls the whole transaction back.
func (t *TxRunner) InTx(ctx context.Context, fn func(ctx context.Context, tx pgx.Tx) error) error {
	tx, err := t.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := fn(WithTx(ctx, tx), tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
