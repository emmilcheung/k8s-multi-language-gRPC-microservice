# Phase 7b Action-Gap Closure Design (Transfer/Refund + Dead CTA Wiring)

## Context

The v2 revamp still contains UI controls/pages that do not execute meaningful actions:

- Admission pass page has disabled **Download**, **Add to Apple Wallet**, and per-pass **Transfer** actions.
- Orders empty-state **View saved events** is a no-op button.
- Phase 7 transfer/refund routes are absent.
- Supergraph currently includes `saveEvent/unsaveEvent/savedEvents` but does **not** include transfer/refund operations.

## Goals

1. Eliminate dead/no-op CTAs on buyer-facing Phase 7 flows.
2. Keep behavior honest: no fake success states where backend capability is missing.
3. Deliver end-to-end click paths for transfer/refund in v2 UX.

## Approaches Considered

1. **UI-only wiring**: make buttons navigate but keep transfer/refund as placeholders.
   - Pros: fast.
   - Cons: still not truly functional; violates “working action” intent.

2. **Full backend + frontend in one pass** (recommended).
   - Pros: actions become real workflows; aligns with Phase 7 target.
   - Cons: larger change set across services and schema.

3. **Strict backend-first** then UI hookup.
   - Pros: clean layering.
   - Cons: slower user-visible progress; dead CTAs remain longer.

Chosen: **Approach 2** with incremental checkpoints.

## Design

### 1. Immediate CTA Fixes (no backend dependency)

- `components/orders/orders-overview.tsx`
  - Convert empty-state “View saved events” button to set active tab to `saved`.
- `app/tickets/[ticketId]/admission/page.tsx`
  - Replace disabled **Download** with a real file download action (QR/pass asset export).
  - Keep Apple Wallet action explicit and non-fake (opens capability notice route/state, not a disabled button).

### 2. Transfer Flow

- Add route: `app/orders/[orderId]/transfer/page.tsx`.
- Add transfer action module under `app/actions/` and GraphQL operations under `lib/graphql/operations/order/`.
- Wire existing transfer CTAs:
  - Admission pass per-seat transfer button -> transfer page (seat scoped).
  - Checkout/order “Send to friend” entry point -> transfer page.

Behavior:
- Submit transfer request with explicit status/error handling.
- Optional recall/cancel transfer from transfer page if operation is available.

### 3. Refund Flow

- Add route: `app/orders/[orderId]/refund/page.tsx`.
- Add GraphQL operations for eligibility + request.
- Integrate from order detail CTA (eligible completed orders).

Behavior:
- Query eligibility first.
- If ineligible, show reason and disable submit with explicit explanation.
- If eligible, submit refund request and show terminal state.

### 4. Supergraph / Backend Work

Extend schema and resolvers/services to support:

- `transferAdmissionCredential(input)` mutation
- `recallTransfer(credentialId)` mutation
- `refundEligibility(orderId)` query
- `requestRefund(orderId, reason)` mutation

Update Apollo router composition and typed documents/codegen in client.

### 5. Error Handling

- No silent failures.
- Surface user-facing errors near action controls.
- Keep mutation/query failures explicit and loggable.

### 6. Testing

- Client unit tests for new pages/actions.
- E2E:
  - transfer initiation (and recall if present),
  - refund eligibility + request path,
  - admission/order CTA navigation paths.
- Existing suites remain green.

## Scope Boundaries

- This spec focuses on **Phase 7b action gaps**.
- Phase 6 API-gap analytics cards (`organizerStats/recentActivity/attendanceThroughput`) remain documented gaps and are not implemented here.

