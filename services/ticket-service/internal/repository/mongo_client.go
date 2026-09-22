package repository

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
	"go.mongodb.org/mongo-driver/v2/mongo/writeconcern"
)

// MongoClientOptions builds the client options every MongoDB connection in this
// service uses. It exists so that the pool size, the write concern and the read
// preference are stated in one place instead of being inherited as driver
// defaults that nobody chose.
//
// Write concern is majority, which is the point of running a replica set at all:
// an acknowledged write has reached a majority of voting members and survives a
// primary failover. The driver's default is the server default (w:1 in
// practice), so a reservation could be acknowledged to a buyer and then lost
// with the primary — exactly the failure the replica set was introduced to
// prevent. On the single-member local set, majority is one member, so this is
// free locally and only starts costing latency where it starts buying safety.
//
// Read preference is primary, stated rather than assumed: reservation reads
// decide whether a seat is free, and a secondary can lag behind the write that
// took it.
//
// maxPoolSize is per client per pod, and the ceiling that matters is
// maxPoolSize × maxReplicas across every service sharing the deployment. The
// driver default is 100, which was being taken twice per pod because this
// service used to open two clients.
func MongoClientOptions(uri string, maxPoolSize uint64) *options.ClientOptions {
	return options.Client().
		ApplyURI(uri).
		SetMaxPoolSize(maxPoolSize).
		SetWriteConcern(writeconcern.Majority()).
		SetReadPreference(readpref.Primary())
}

// NewMongoClient connects with MongoClientOptions and verifies the connection,
// so a bad URI fails at startup rather than on the first query.
//
// Note that ApplyURI runs first, so a URI that spells out its own w= or
// readPreference= is still overridden here. That is deliberate: these two are
// correctness settings, not deployment knobs.
func NewMongoClient(ctx context.Context, uri string, maxPoolSize uint64) (*mongo.Client, error) {
	client, err := mongo.Connect(MongoClientOptions(uri, maxPoolSize))
	if err != nil {
		return nil, fmt.Errorf("mongo connect: %w", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		return nil, fmt.Errorf("mongo ping: %w", err)
	}
	return client, nil
}

// DefaultMongoMaxPoolSize is used by constructors that dial their own client
// (tests, and any caller that has not been given one). Production wiring passes
// the configured value instead.
const DefaultMongoMaxPoolSize uint64 = 50
