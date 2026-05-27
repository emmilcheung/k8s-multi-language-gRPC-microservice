# Ticketing redesign API gaps

Phase 6 ships with the organizer dashboard, attendance monitor, and scanner using today's schema. These frontend screens still need dedicated backend support to remove client-side fan-out and unlock the missing cards.

## Needed GraphQL additions

1. `organizerStats(organizerId, since)`
   - Purpose: aggregate organizer dashboard totals without fetching every ticket client-side.
   - Suggested shape: `grossSales`, `ticketsSold`, `activeEvents`, `checkedIn`.

2. `recentActivity(organizerId, since, limit)` or `organizerActivity(organizerId)` subscription
   - Purpose: power the "Live activity" card on `/organizer`.
   - Suggested shape: `type`, `eventId`, `ticketId`, `orderId`, `occurredAt`, `label`.

3. `attendanceThroughput(eventId, window, bucket)`
   - Purpose: bucketed admitted/denied scans for `/organizer/events/[id]/attendance`.
   - Suggested shape: `{ bucket, admitted, denied }[]`.

## Current frontend fallback

- `/organizer` uses the existing `tickets` query, filters to the signed-in organizer's tickets, and fans out to `attendanceSummary`.
- `/organizer/events/[id]/attendance` hides the throughput chart entirely instead of fabricating data.
- `/organizer` shows a "Live activity coming soon" placeholder until dedicated activity data exists.
