-- V1__init.sql
-- Initial schema for order-service
-- Conventions (AGENTS.md §4.2):
--   - UUID primary keys
--   - created_at / updated_at on every table
--   - Explicit constraint names

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── order_tickets ─────────────────────────────────────────────────────────────
-- Local replica of ticket data consumed from Kafka.
-- order-service never queries ticket-service's database directly.
CREATE TABLE order_tickets (
  id         UUID          NOT NULL,
  title      TEXT          NOT NULL,
  price      NUMERIC(12,2) NOT NULL,
  version    INT           NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT pk_order_tickets PRIMARY KEY (id),
  CONSTRAINT ck_order_tickets_price_positive CHECK (price >= 0)
);

-- ── orders ────────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id         UUID         NOT NULL DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL,
  status     VARCHAR(30)  NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL,
  ticket_id  UUID         NOT NULL,
  version    INT          NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pk_orders       PRIMARY KEY (id),
  CONSTRAINT fk_orders_ticket FOREIGN KEY (ticket_id) REFERENCES order_tickets(id),
  CONSTRAINT ck_orders_status CHECK (status IN ('CREATED','AWAITING_PAYMENT','COMPLETE','CANCELLED'))
);

CREATE INDEX idx_orders_user_id   ON orders(user_id);
CREATE INDEX idx_orders_ticket_id ON orders(ticket_id);
CREATE INDEX idx_orders_status    ON orders(status);

-- ── outbox ────────────────────────────────────────────────────────────────────
-- Transactional outbox pattern: events written here in same transaction
-- as order state changes; relay reads and publishes to Kafka.
CREATE TABLE outbox (
  id            UUID    NOT NULL DEFAULT gen_random_uuid(),
  topic         TEXT    NOT NULL,
  payload       JSONB   NOT NULL,
  partition_key TEXT    NOT NULL,
  published     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_outbox PRIMARY KEY (id)
);

-- Partial index — only unpublished rows matter for relay polling
CREATE INDEX idx_outbox_unpublished ON outbox(created_at) WHERE published = false;
