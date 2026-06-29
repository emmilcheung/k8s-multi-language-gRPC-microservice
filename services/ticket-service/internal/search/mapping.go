package search

// indexMapping is the OpenSearch mapping for the tickets index.
// Matches spec §4.1.
const indexMapping = `{
  "mappings": { "properties": {
    "eventTitle":   {"type":"text"},
    "title":        {"type":"text"},
    "venueName":    {"type":"text"},
    "description":  {"type":"text"},
    "venueAddress": {"type":"text"},
    "category":     {"type":"keyword"},
    "ticketType":   {"type":"keyword"},
    "seatingPlanId":{"type":"keyword"},
    "price":        {"type":"scaled_float","scaling_factor":100},
    "startsAt":     {"type":"date"},
    "createdAt":    {"type":"date"}
  }}
}`
