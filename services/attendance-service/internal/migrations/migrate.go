// Package migrations provides a golang-migrate runner for attendance-service.
// It embeds all SQL migration files and applies them at service startup.
package migrations

import (
	"embed"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres" // postgres driver
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"go.uber.org/zap"
)

//go:embed *.sql
var sqlFiles embed.FS

// Run applies all pending up migrations against the given database URL.
// It is idempotent: already-applied migrations are skipped.
// Returns an error if any migration fails; ErrNoChange is treated as success.
func Run(databaseURL string, log *zap.Logger) error {
	src, err := iofs.New(sqlFiles, ".")
	if err != nil {
		return fmt.Errorf("migrations: create iofs source: %w", err)
	}

	m, err := migrate.NewWithSourceInstance("iofs", src, databaseURL)
	if err != nil {
		return fmt.Errorf("migrations: create migrator: %w", err)
	}
	defer func() {
		srcErr, dbErr := m.Close()
		if srcErr != nil {
			log.Warn("migrations: source close error", zap.Error(srcErr))
		}
		if dbErr != nil {
			log.Warn("migrations: db close error", zap.Error(dbErr))
		}
	}()

	if err := m.Up(); err != nil {
		if err == migrate.ErrNoChange {
			log.Info("migrations: no new migrations to apply")
			return nil
		}
		return fmt.Errorf("migrations: up: %w", err)
	}

	version, dirty, err := m.Version()
	if err != nil {
		log.Warn("migrations: could not read version after apply", zap.Error(err))
	} else {
		log.Info("migrations: applied successfully",
			zap.Uint("version", version),
			zap.Bool("dirty", dirty),
		)
	}

	return nil
}
