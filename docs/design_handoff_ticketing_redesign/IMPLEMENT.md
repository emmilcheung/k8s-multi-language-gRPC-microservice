# IMPLEMENT.md — Ticketing client redesign

You are implementing the design handoff bundle at `design_handoff_ticketing_redesign/`. The repo is the existing Next.js 16 client at `client/`. Your job is to recreate the design surfaces in production code, route by route, phase by phase.

---

## ⛳ Ground rules (read every time you re-enter this file)

1. **Read in this exact order before doing anything:**
   1. `design_handoff_ticketing_redesign/README.md` — full handoff. The "Data layer playbook", "Operations inventory", "What's already shipped", and "Pitfalls" sections are non-negotiable.
   2. `client/AGENTS.md` — codebase-local rules.
   3. The relevant artboard's source file under `design_handoff_ticketing_redesign/src/screens-*.jsx` — the design reference.
   4. The current implementation of the route you're about to change.
   Skipping any of these is the most common failure mode.

2. **The HTML/JSX in `design_handoff_ticketing_redesign/` is a design reference, not code to copy.** It uses inline-style React for the canvas viewer. Production code uses Tailwind utilities + shadcn primitives + CSS variables. Read the design, then implement it idiomatically.

3. **GraphQL-primary, REST keep-list secondary.** Server Components and Server Actions use `executeQuery` / `executeMutation` from `lib/graphql/execute.ts`. The seat map uses `urql` from `app/_lib/urql-client.tsx`. REST (`serverApi`) is for the keep-list only — see README "REST keep-list" section.

4. **All GraphQL operations live in `.graphql` files** under `lib/graphql/operations/<domain>/`. Inline `gql` tags are forbidden by ESLint. To add an operation:
   1. Write `lib/graphql/operations/<domain>/<Name>.graphql`.
   2. Run `pnpm codegen`.
   3. Import the generated `<Name>Document` from `@/lib/graphql/generated`.
   You must complete all three steps in this order. Don't import a Document constant before generating it.

5. **Money is in cents over the wire.** GraphQL prices are integers (`4800` = $48.00). Wrap at the boundary: `Math.round(parseFloat(input) * 100)` for sending, `(value / 100).toFixed(2)` for displaying.

6. **Don't rebuild what already works.** Check `design_handoff_ticketing_redesign/README.md` → "What's already shipped" before touching `seat-map-client.tsx`, `settings-payment-methods.tsx`, `attendance-policy.ts`, the urql provider, or the plan-lifecycle buttons. Restyle, don't rewire.

7. **Always run `pnpm lint && pnpm tsc --noEmit && pnpm test` before declaring a phase done.** E2E (`pnpm test:e2e`) requires the dev server on port 4000 and the docker-compose stack up — run it at the end of each phase if those are available, otherwise note it for the human.

8. **Phase commits.** Each phase below is one PR / one commit boundary. Don't bundle phases. After each phase, stop and summarise what changed, what tests pass, and what's open.

9. **Do not migrate REST keep-list entries to GraphQL during this work.** Even if it looks easy. Separate PR, separate review.

10. **When stuck, ask before guessing.** Specifically:
    - If an operation you need doesn't exist in `lib/graphql/operations/`.
    - If you're tempted to add inline `gql` or a new `lib/api.ts` wrapper.
    - If the design and an existing API capability disagree (e.g. "the design shows X but the schema doesn't have a field for X").
    Ask the human, don't fabricate.

---

## 📋 Phase ledger

Implement in order. Each row is one phase = one commit boundary. Mark a phase done by editing the `Status` column in this file and committing the change as part of that phase's PR.

| # | Phase | Status | SDL change? | Reference artboards |
|---|---|---|---|---|
| 0 | Foundation — tokens, fonts, atoms | DONE | no | `14 · system-ref` |
| 1 | Browse + event detail | DONE | no | `01`, `02` |
| 2 | Seat picker + checkout + countdown | DONE | no | `03`, `04` |
| 3 | Admission pass | DONE | no | `05` |
| 4 | Orders list + hold-expired + payment-failed + states | DONE | no | `06`, `07` (partial), `08` |
| 5 | Auth + settings | TODO | no | `09`, `10` |
| 6 | Organizer surfaces + scanner | TODO | maybe (see Phase 6 notes) | `11`, `12` |
| 7 | Transfer + refund + saved events | TODO | **yes — blocks on backend** | `07` (rest) |
| 8 | Mobile + responsive polish | TODO | no | `13` |

---

## Phase 0 — Foundation

**Goal:** every later phase can use the design tokens, fonts, and atomic components as if they're already there.

**Tasks:**

1. Update `app/globals.css` with the token block from `README.md` → "Design tokens (canonical)". Replace the existing `:root` variables; keep the `@theme inline` block from Tailwind v4. **Drop the `--font-display` variable** — Inter at 640 weight covers it.

2. Update `tailwind.config` (or the `@theme inline` block in globals.css for Tailwind v4) so utilities resolve: `bg-card`, `bg-subtle`, `text-ink`, `text-mute`, `border-line`, `bg-accent`, `text-accent`, `bg-ok-soft`/`text-ok`, `bg-warn-soft`/`text-warn`, `bg-bad-soft`/`text-bad`.

3. Add Inter + JetBrains Mono via `next/font/google` in `app/layout.tsx`. Expose as `--font-sans` and `--font-mono` CSS variables on `<html>`. Set tabular-nums on mono.

4. Update CVA variants:
   - `components/ui/button-variants.ts` — add `primary`, `accent`, `danger` variants (in addition to existing `default`, `outline`, `ghost`, `secondary`). Match `Btn` in `src/shared.jsx`.
   - `components/ui/badge.tsx` — add `tone` prop (`neutral`/`accent`/`ok`/`warn`/`bad`/`ink`) and an optional `dot` boolean.
   - `components/ui/card.tsx` — restyle with new tokens; default to hairline border + no shadow. Add an `elev` boolean for the sticky-panel shadow.
   - `components/ui/input.tsx` — restyle. Add support for a leading icon and a trailing suffix (text or node).

5. Create new atoms under `components/system/`:
   - `stat.tsx` — label + big mono value + optional sub. Used by dashboards and totals.
   - `kbd.tsx` — keyboard shortcut chip.
   - `divider.tsx` — horizontal + vertical.
   - `event-poster.tsx` — gradient stripe + title + venue + date + price + optional tag. Replaces ad-hoc cards.
   - `ada-glyph.tsx` — wheelchair SVG, inline-sizeable.
   - `hold-timer.tsx` — accepts `expiresAt: string` (ISO), renders a live `mm:ss` ribbon with `font-mono tabular-nums`. Stops at 00:00. **This component is the single biggest UX win in the whole redesign — get the API right.** Suggested props: `{ expiresAt, tone?: 'accent' | 'warn', onExpire?: () => void }`.

6. Match the existing pattern in `components/ui/` for file structure, "use client" directives (most of these are RSC-friendly), and exports.

**Done when:**
- `pnpm lint && pnpm tsc --noEmit && pnpm test` pass.
- Existing pages render without visual regression on tokens already used elsewhere (most pages will look slightly different — that's fine; the next phases finish the job).
- New atoms are exported from `components/system/index.ts` (create this file).

---

## Phase 1 — Browse + event detail

**Goal:** restyle `/` and `/tickets/[ticketId]` against artboards `01 · browse-a`, `02 · event-ga`, `02 · event-seated`. **No new operations needed.**

**Tasks:**

1. Restyle `app/page.tsx` against `src/screens-browse.jsx`:
   - Search field in the header (purely client-side filter for now; server-side query params are a follow-up).
   - Category cards row (data is static for now; this is a presentation pattern).
   - Hero event card (use the first "featured" ticket — pick by recency or by flag if one exists; until then, just the first ticket).
   - Filter sidebar (date / price / category / availability) — query params.
   - Grid via `<EventPoster>`.
   - **Throw away the gradient text** in the hero. Read the "Pitfalls" section of the README.

2. Restyle `app/tickets/[ticketId]/page.tsx` against `src/screens-event.jsx`. Branch GA vs seated on `ticket.seatingPlanId`:
   - Hero band with ribbon + chips + save/share.
   - Quick-facts strip (date / venue / age / status).
   - About section.
   - Right-side sticky purchase panel: from-price, quantity stepper (GA) **or** pick-seats / auto-assign choice (seated), event countdown sourced from `ticket.event.startsAt`, trust strip.
   - Related events row.

3. `ticket.event.startsAt` event countdown is **not** the hold timer. Use a separate component (you can inline it for Phase 1; if you find yourself reaching for it twice, extract it).

4. Existing functionality must keep working: purchase button (GA), seat-map navigation (seated), owner edit form when `currentUserId === ticket.userId`.

**Done when:**
- Visual diff against the artboards is close to pixel-faithful.
- The existing `__tests__/pages.test.tsx` and any related component tests still pass.
- `pnpm lint && pnpm tsc --noEmit && pnpm test` pass.

---

## Phase 2 — Seat picker + checkout + countdown

**Goal:** the make-or-break phase. Restyle `components/seat-map-client.tsx` and `/orders/[orderId]/page.tsx`. **No new operations needed.**

**Tasks:**

1. **Reskin `components/seat-map-client.tsx` against `src/screens-seats.jsx` (`03 · seats-manual` + `03 · seats-auto`). Keep the urql plumbing intact.** Specifically:
   - The `useQuery(SeatingPlanAvailabilityDocument)` polling stays as-is.
   - The `useMutation(HoldSeatsDocument)` / `useMutation(ReleaseSeatsDocument)` calls stay as-is.
   - The Server Actions `createManualSeatedOrder` / `createAutoAssignSeatedOrder` stay as-is.
   - Only the **visual layer** changes: section tabs become filter chips; the seat grid uses the new `<SeatGrid>` from `components/system/`; the cart panel uses the new style; the **`<HoldTimerRibbon>` is mounted at the top** driven by the hold mutation's `expiresAt` response field.

2. Add the section-zoom grid below the map (`SeatGrid` in `src/screens-seats.jsx`). Selection state stays in the existing `seat-map-client.tsx`.

3. Add the view-from-seat hover preview as a placeholder (gradient + label). Imagery comes later (Phase 7 / SDL extension).

4. Restyle `app/orders/[orderId]/page.tsx` against `src/screens-checkout.jsx` (`04 · co-summary`, `co-pay`, `co-confirm`). Three logical steps under the same route, gated by order status:
   - `created` → Review step.
   - `awaiting_payment` → Payment step (the existing `<OrderPaymentForm>` already calls `submitPayment`; restyle the form, keep the action).
   - `complete` → Confirmation step (use the existing admission-pass link).
   The countdown ribbon (`<HoldTimerRibbon>`) is mounted on the Review and Payment steps, driven by `order.expiresAt` from `OrderDetailDocument`.

5. Confirmation step uses the existing `AdmissionPassDocument` query to render a mini pass preview.

**Done when:**
- The seat map looks like `03 · seats-manual` but every existing hold / release / order action still fires correctly.
- The countdown actually counts down in real time.
- `pnpm test` passes, especially `seating-plan-canvas.test.tsx`, `order-payment-form.test.tsx`, `purchase-button.test.tsx`.
- `pnpm test:e2e -- ticketing.spec.ts` passes if the stack is up.

---

## Phase 3 — Admission pass

**Goal:** restyle `/tickets/[ticketId]/admission` against `05 · pass-issued`, `pass-used`, `pass-revoked`. **No new operations needed.**

**Tasks:**

1. Replace `components/qr-pass-card.tsx` with a new `components/system/pass-card.tsx` matching the design. Props at minimum: `{ pass: AdmissionPass, qrDataUrl?: string }`.

2. Status drives the visual state — `ISSUED` (full colour), `USED` (faded + stamp overlay), `REVOKED` / `EXPIRED` (red stamp).

3. **Throw away the `FauxQR` from the design files.** Use the real QR rendering already wired into the existing `qr-pass-card.tsx` (server-side `qrcode` or whatever the test expects — keep that pipeline).

4. Group passes list: when an order has multiple seats, show all of them on the right side with transfer status. The data comes from the existing order shape; until the transfer mutation lands (Phase 7), the per-seat transfer button is disabled with a "Coming soon" tooltip.

5. Update `__tests__/qr-pass-card.test.tsx` to test the new component. Tests must still cover the three status states.

**Done when:** existing admission-page tests still pass and the visual matches `05 · pass-issued`.

---

## Phase 4 — Orders list + hold-expired + payment-failed + states

**Goal:** restyle `/orders` and add the recovery surfaces. **No new operations needed.**

**Tasks:**

1. Restyle `app/orders/page.tsx` against `06 · orders`:
   - Tabs: Upcoming / Past / Saved / Refunded. Filter the `OrdersPageDocument` result client-side by status + `event.startsAt`.
   - **Saved tab is empty for now** with a "Save events to come back to them" empty state — Phase 7 wires the real data.
   - **Refunded tab is empty for now** — Phase 7 wires it.
   - Inline timer on `awaiting_payment` orders sourced from `expiresAt`.

2. Build the **hold-expired recovery surface**. Add a `app/checkout/recover/page.tsx` route with the design from `07 · flow-hold-expired`. The `/orders/[orderId]` page redirects here when `order.status === 'created' && new Date(order.expiresAt) < new Date()`. No new mutation — the user re-enters the seat picker or auto-assigns.

3. Build the **payment-failed surface** inline within the Payment step of `/orders/[orderId]`. When `submitPayment` returns an error, show the design from `07 · flow-payment-failed` instead of a generic alert. List the user's other payment methods (from `SettingsPageDocument.currentUser.paymentMethods` — wire a small query if needed) with a "Try this one" button per method.

4. Add `loading.tsx` and `not-found.tsx` per route, matching `08 · state-loading` / `08 · state-not-found`. Use the loading skeleton pattern from `src/screens-states.jsx`.

5. Build the empty-orders state for the Upcoming tab when the user has no orders, matching `08 · state-empty-orders`.

**Done when:** the orders list looks right, hold-expired and payment-failed flows recover gracefully, and 404/loading states exist for every route.

---

## Phase 5 — Auth + settings

**Goal:** restyle `/auth/signin`, `/auth/signup`, `/settings`. **All existing operations.**

**Tasks:**

1. Restyle `app/auth/signin/page.tsx` and `app/auth/signup/page.tsx` against `09 · auth-signin`, `09 · auth-signup`. Split brand panel + form. Tab switch between sign-in and sign-up. The existing `<AuthForm>` handles the actions — restyle, don't rewire.

2. Restyle `app/settings/page.tsx` against `10 · settings-payment`. The `SettingsPageDocument` already aggregates everything needed:
   - Profile section uses `UpdateProfileDocument`.
   - Payment methods uses **existing `components/settings-payment-methods.tsx`** — restyle the component, don't rebuild it.
   - Notifications uses `UpdatePreferencesDocument`. Three toggles map cleanly (`marketingOptIn`, `orderUpdates`, `productUpdates`); the design adds two more (hold-timer reminders, show-day reminders) which need either a Phase 7 SDL extension or hide them until then. **Default: hide until SDL extension lands. Don't ship dead toggles.**
   - Billing address uses `UpdateBillingAddressDocument`.
   - Sessions list uses `RevokeSessionDocument` for "Sign out other device".

**Done when:** the existing settings tests (`settings-payment-methods.test.tsx`, `actions-settings.test.ts`) still pass and the page matches the artboard.

---

## Phase 6 — Organizer surfaces + scanner

**Goal:** build `/organizer/*` and restyle `/scan`. The dashboard and attendance work with existing data today; the live activity feed and throughput chart need new operations.

**Tasks:**

1. Create `app/organizer/layout.tsx` with the organizer `<TopNav organizer>` variant. Different chrome from the buyer pages — no buyer search, organizer-only nav items.

2. Build `app/organizer/page.tsx` (dashboard) against `11 · org-dash`:
   - Top stats row — for now, aggregate client-side from `OrdersPageDocument` filtered by organizer's tickets. **Better long-term: a new `organizerStats(organizerId, since)` query** — flag this as a Phase 6 SDL ask. Until then, the client-side rollup is fine.
   - Active events table — use the existing tickets data plus per-event `AttendancePageDocument`.
   - Recent activity feed — for now, hide this card with a "Live activity coming soon" placeholder. **Don't fake the data.** Phase 6 SDL ask: a `recentActivity(organizerId, since, limit)` query.

3. Build `app/organizer/events/[id]/attendance/page.tsx` against `11 · org-att`. Use the existing `AttendancePageDocument` for stats + check-ins. The throughput chart needs an `attendanceThroughput(eventId, window, bucket)` query — Phase 6 SDL ask. Until then, hide the chart card.

4. Restyle `/scan` (existing) against `12 · scan-*`. The existing `<ScannerClient>` already uses `ValidateScan` — restyle the layout to match the kiosk design with the big viewfinder + state pill. **Light theme** (read the Pitfalls section).

5. Migrate the existing `/tickets/[id]/attendance` route to a redirect to `/organizer/events/[id]/attendance` (or leave it and add the organizer route alongside — decide based on whether there are existing links).

**Phase 6 SDL asks (write a doc, don't implement):**
- `organizerStats(organizerId, since)` → aggregate.
- `recentActivity(organizerId, since, limit)` query or `organizerActivity(organizerId)` subscription.
- `attendanceThroughput(eventId, window, bucket)` → bucketed rollup.

Open a separate "API gaps" doc summarising these and tag the backend team. Don't implement the queries on the frontend until they exist.

**Done when:** organizer pages load, attendance monitor works for existing data, scanner restyle is live, SDL asks are documented.

---

## Phase 7 — Transfer + refund + saved events (BLOCKS ON BACKEND)

**Goal:** add the genuinely-new features that require supergraph SDL extensions.

**Prerequisites:** the backend team has shipped:
- `transferAdmissionCredential(input)` and `recallTransfer(credentialId)` mutations.
- `requestRefund(orderId, reason)` mutation + `refundEligibility(orderId)` query.
- `saveEvent(eventId)` / `unsaveEvent(eventId)` mutations + `Event.savedByMe` field + `savedEvents(first, after)` query.
- (Optional, for accessible seats:) `Seat.accessibility` field.

**If these are not landed, stop and tell the human.** Don't fabricate operations.

**Tasks:**

1. Add the `.graphql` operations for each new mutation/query under the appropriate domain. Run `pnpm codegen`.

2. Build `app/orders/[id]/transfer/page.tsx` against `07 · flow-transfer`. Server Action wraps `TransferAdmissionCredentialDocument`.

3. Build `app/orders/[id]/refund/page.tsx` against `07 · flow-refund`. Use `refundEligibility` in the loader; `requestRefund` in the Server Action.

4. Wire the **Saved tab** in `/orders` against `savedEvents` query.

5. Add a "Save" button to the event detail page and the orders list — `saveEvent` / `unsaveEvent` mutations.

6. If `Seat.accessibility` shipped: surface ADA glyphs in `<SeatGrid>` for seats where `accessibility === 'WHEELCHAIR'` and adjacent companion seats. Add the "Accessible" filter chip in the seat picker. Add the policy strip below the section grid.

7. The "Send to friend" inline link on the checkout review step now points to the transfer flow (was disabled in Phase 2).

**Done when:** transfer flow + refund flow + saved events work end-to-end against the live backend.

---

## Phase 8 — Mobile + responsive polish

**Goal:** the desktop pages should already be responsive from Tailwind utilities. This phase adds mobile-specific compositions where the layout meaningfully differs.

**Tasks:**

1. Audit each page at 390px (iPhone) and 768px (tablet). Fix obvious breakage.

2. For these surfaces, the design has phone-native compositions that are **not just scaled-down desktop**:
   - Browse → bottom tab bar instead of header nav (`13 · m-browse`).
   - Event detail → sticky CTA at the bottom (`13 · m-event`).
   - Seat picker → section chips → mini map → condensed seat grid → sticky cart (`13 · m-seats`).
   - Checkout → single-column with timer in the header (`13 · m-checkout`).
   - Pass → centered card + Wake Lock API to keep screen on (`13 · m-pass`).
   - Orders list → simpler card layout (`13 · m-orders`).
   - Scanner (operator-on-phone) → smaller viewfinder, full-screen state colour (`13 · m-scanner`).

3. For the pass mobile screen, call `navigator.wakeLock?.request('screen')` when the screen mounts. Release on unmount.

4. Increase brightness for the pass screen via CSS only if there's a clean way to do so — note that browsers can't actually set system brightness; if there's no clean way, drop this and document the limitation in a comment.

**Done when:** all critical buyer surfaces (browse → event → seats → checkout → pass → orders) work on a 390px viewport without horizontal scroll, and the mobile-specific compositions match the artboards.

---

## ✅ How to know you're done with all phases

- The phase ledger above shows every row as `DONE`.
- `pnpm lint && pnpm tsc --noEmit` clean.
- `pnpm test` clean.
- `pnpm test:e2e` clean (with stack up).
- Visual diff: each route matches its artboard in `design_handoff_ticketing_redesign/Ticketing redesign.html` (compare in a browser).
- The Phase 6 SDL ask doc exists and is shared with the backend team.
- The Phase 7 prerequisites are clearly tracked in your team's tooling.

---

## 🚫 If you find yourself doing any of these, STOP and re-read this file

- Adding inline `gql` template literals → operations live in `.graphql` files only.
- Adding a new function to `lib/api.ts` → call `serverApi` inline at the keep-list endpoints; no new wrappers.
- Hand-rolling `fetch('/graphql')` → use `executeQuery` / `executeMutation`.
- Migrating a REST keep-list endpoint to GraphQL "while you're here" → separate PR, separate review.
- Faking data for the recent-activity or throughput chart → leave a placeholder, document the SDL ask.
- Skipping `pnpm codegen` after editing a `.graphql` file → the generated Document won't exist.
- Sending dollars to a price mutation → cents on the wire. Multiply by 100.
- Adding a dark theme toggle or "spice up" colour → read the Pitfalls section.
- Rebuilding `seat-map-client.tsx`, `settings-payment-methods.tsx`, `attendance-policy.ts`, the urql provider, or the plan-lifecycle buttons from scratch → restyle the existing components.
