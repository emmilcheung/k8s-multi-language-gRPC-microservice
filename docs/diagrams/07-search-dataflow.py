"""OpenSearch CQRS search: index path and query path with fallback, in AWS style.
Source of truth: services/ticket-service (search indexer + TicketsConnection), docs/04-asynchronous-messaging.md
Run: python3 07-search-dataflow.py"""
from awsdiagram import Sequence
from diagrams.aws.analytics import AmazonOpensearchService, ManagedStreamingForKafka
from diagrams.aws.compute import Fargate
from diagrams.aws.database import DocumentDB
from diagrams.aws.general import Users

P = [
    dict(id="C", icon=Users, label="Customer / client"),
    dict(id="K", icon=Fargate, label="kong-gateway"),
    dict(id="TS", icon=Fargate, label="ticket-service\nGo"),
    dict(id="MG", icon=DocumentDB, label="ticket_db\nMongoDB-compatible"),
    dict(id="MQ", icon=ManagedStreamingForKafka, label="Amazon MSK\nKafka"),
    dict(id="OS", icon=AmazonOpensearchService, label="Amazon OpenSearch\nsearch read model"),
]
s = Sequence(
    "Ticket search: CQRS index and query on AWS",
    "Mongo stays the source of truth, OpenSearch is a rebuildable read model fed from Kafka",
    P,
    zones=[("Client", 0, 0, "amber"), ("Edge", 1, 1, "teal"), ("EKS", 2, 2, "blue"),
           ("Data + messaging", 3, 5, "purple")],
    spacing=300, margin=190)

s.phase("Phase A  -  Index (CQRS write path)", "amber")
s.m("C", "K", "POST /tickets (create or update)")
s.m("K", "TS", "JWT verified, forward")
s.m("TS", "MG", "BEGIN txn: INSERT/UPDATE ticket + INSERT outbox row", "data")
s.m("MG", "TS", "txn committed", "data", ret=True)
s.m("TS", "K", "201 / 200 OK", ret=True)
s.m("K", "C", "response", ret=True)
s.m("TS", "MQ", "outbox relay publishes tickets.ticket.created or .updated (CloudEvents, key=ticket_id)", "kafka")
s.note("MQ", "Transactional outbox gives at-least-once delivery to Kafka.", "right")
s.m("MQ", "TS", "search-indexer consumer receives event", "kafka", ret=True)
s.m("TS", "OS", "UpsertTicket (external version = Kafka offset, idempotent)", "data")
s.branch("alt", "parse error or transient failure")
s.m("OS", "TS", "error", "data", ret=True)
s.m("TS", "MQ", "route to .dlq + schedule retry (max 3, exponential back-off), never silently dropped", "kafka")
s.branch("else", "success")
s.m("OS", "TS", "200 OK", "data", ret=True)

s.phase("Phase B  -  Query (read path, with graceful fallback)", "blue")
s.m("C", "K", "GET /graphql  TicketsConnection with search filter")
s.m("K", "TS", "JWT verified, forward")
s.branch("alt", "SEARCH_BACKEND=opensearch and a search query is present")
s.m("TS", "OS", "multi_match (fuzziness AUTO, boost eventTitle / title / venueName) + filters", "data")
s.m("OS", "TS", "ranked ticketIds[]", "data", ret=True)
s.m("TS", "MG", "FindByIDs: hydrate canonical data + live availability", "data")
s.m("MG", "TS", "ticket docs (authoritative)", "data", ret=True)
s.self_("TS", "refill loop: apply ticketType filter, fill the page to the requested size", "data")
s.m("TS", "K", "ranked page (OpenSearch order preserved)", ret=True)
s.branch("else", "Mongo backend, or OpenSearch error / circuit open")
s.note("TS", "Graceful fallback: search never hard-fails.", "right")
s.m("TS", "MG", "regex search on title and description (degraded relevance)", "data")
s.m("MG", "TS", "ticket docs", "data", ret=True)
s.m("TS", "K", "page (Mongo ordering)", ret=True)
s.m("K", "C", "TicketsConnection response", ret=True)

s.footer = ("Production takeaway",
            "Availability is hydrated live from Mongo and never read from the index. The index only decides which tickets "
            "match and in what order, so a stale index can mis-rank a result but can never oversell. The authoritative "
            "gate stays at reservation time.")
s.save("07-search-dataflow")
