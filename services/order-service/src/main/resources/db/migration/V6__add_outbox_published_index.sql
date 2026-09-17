-- Cleanup of published outbox rows had no usable index: V1's partial index covers
-- only `published = false`, which is the relay's query, not the cleanup job's.
-- Batched deletes make this mandatory -- without it each batch is a fresh
-- sequential scan of the whole table.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Flyway wraps each migration in a
-- transaction and CONCURRENTLY cannot run inside one. This takes a SHARE lock that
-- blocks writes to `outbox` for the build; acceptable because the table is bounded
-- by the 24h retention window this job enforces.
CREATE INDEX idx_outbox_published_created ON outbox(created_at) WHERE published = true;
