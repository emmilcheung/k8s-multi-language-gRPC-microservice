package repository

import (
	"testing"

	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

// The write concern is the whole reason ticket data lives on a replica set. If
// it silently reverts to the server default, an acknowledged reservation can be
// lost in a primary failover and nothing else in the suite would notice: every
// test here runs against a single-member set, where w:1 and w:majority behave
// identically. This test is the only thing that fails when majority goes away.
func TestMongoClientOptions_WritesRequireMajority(t *testing.T) {
	opts := MongoClientOptions("mongodb://localhost:27017", 25)

	require.NotNil(t, opts.WriteConcern, "write concern must be stated, not left to the server default")
	w, ok := opts.WriteConcern.W.(string)
	require.True(t, ok, "write concern W should be the string majority, got %#v", opts.WriteConcern.W)
	require.Equal(t, "majority", w)
}

// Reservation reads decide whether a seat is still free, so they must not be
// served by a secondary that has not yet applied the write that took it.
func TestMongoClientOptions_ReadsGoToPrimary(t *testing.T) {
	opts := MongoClientOptions("mongodb://localhost:27017", 25)

	require.NotNil(t, opts.ReadPreference)
	require.Equal(t, readpref.PrimaryMode, opts.ReadPreference.Mode())
}

// The pool is per client per pod and is multiplied by the HPA's maxReplicas, so
// it has to come from configuration rather than the driver's default of 100.
func TestMongoClientOptions_PoolSizeIsTheCallersChoice(t *testing.T) {
	opts := MongoClientOptions("mongodb://localhost:27017", 25)

	require.NotNil(t, opts.MaxPoolSize)
	require.Equal(t, uint64(25), *opts.MaxPoolSize)
}

// A URI that spells out its own w= must not quietly win over the setting above.
func TestMongoClientOptions_URICannotDowngradeWriteConcern(t *testing.T) {
	opts := MongoClientOptions("mongodb://localhost:27017/?w=1", 25)

	w, ok := opts.WriteConcern.W.(string)
	require.True(t, ok, "URI w=1 overrode the majority write concern: %#v", opts.WriteConcern.W)
	require.Equal(t, "majority", w)
}
