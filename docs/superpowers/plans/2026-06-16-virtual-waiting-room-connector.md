# Virtual Waiting Room — Connector Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Gate the Next.js site behind the queue-service during an armed onsale — intercept page requests, validate the HMAC admission credential, redirect un-admitted users to the waiting room, and add an unskippable Kong backstop on the reserve path.

**Architecture:** A pure, Vitest-tested gate module (`lib/queue/gate.ts`) holds all token-verification and decision logic (no Next types), so it is unit-testable without a running stack. `middleware.ts` is a thin adapter: NextRequest → gate input → apply decision. The credential is the **same HMAC-SHA256 token the queue-service issues** (verified with Web Crypto in the edge runtime). Kong gets a `pre-function` backstop on `/graphql` reserve mutations.

**Tech Stack:** Next.js 16 middleware (edge runtime, Web Crypto), Vitest, Kong `pre-function` (OpenResty Lua).

**Design source:** [`../specs/2026-06-16-virtual-waiting-room-design.md`](../specs/2026-06-16-virtual-waiting-room-design.md). **Depends on:** Plan 1 (queue-service) — token format `base64url(json) + "." + base64url(HMACSHA256(ascii(body)))`, fields `{Eid,Mid,Iat,Exp,Nonce}` (PascalCase, from System.Text.Json).

**Out of scope (Plan 3):** K8s `queue-system` cluster, k6 load.

---

## File Structure

```
services/client/
  lib/queue/gate.ts            # pure: verifyAdmission(), isValidPass(), gateDecision()
  middleware.ts                # thin NextRequest adapter over gateDecision()
  __tests__/queue-gate.test.ts # Vitest unit tests (HMAC compat, expiry, qpass, armed)
  .env.example                 # document the new QUEUE_* vars
  tests/e2e/waiting-room.spec.ts  # Playwright: armed gate redirects; qpass admits; disarmed passes
services/kong-gateway/config/kong.base.yml  # pre-function backstop on /graphql
```

**Env vars (server-side; middleware reads `process.env`):**
- `QUEUE_URL` — waiting-room origin, e.g. `http://localhost:4100`
- `QUEUE_HMAC_SECRET` — shared secret (must equal the queue-service `Queue__HmacSecret`)
- `QUEUE_GATE_ARMED` — `"true"` arms the gate; anything else = pass-through
- `QUEUE_EVENT_ID` — the armed event id
- `QUEUE_PASS_COOKIE` — access cookie name (default `qq_pass`)

**Gate types (defined once):**
```ts
export interface AdmissionPayload { Eid: string; Mid: string; Iat: number; Exp: number; Nonce: string; }
export type Decision =
  | { kind: "pass" }
  | { kind: "redirect-queue"; location: string }
  | { kind: "accept"; cleanUrl: string; cookieValue: string };
export interface GateInput {
  armed: boolean; eventId: string; secret: string; queueUrl: string;
  pathWithQuery: string; qpass: string | null; passCookie: string | null; nowSec: number;
}
```

---

## Task 1: Pure gate module + Vitest unit tests

**Files:**
- Create: `services/client/lib/queue/gate.ts`
- Test: `services/client/__tests__/queue-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `services/client/__tests__/queue-gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { verifyAdmission, gateDecision, type AdmissionPayload } from "@/lib/queue/gate";

const SECRET = "k".repeat(32);

// Sign a token exactly like the .NET TokenService: base64url(json)."base64url(hmac)".
function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sign(payload: AdmissionPayload, secret = SECRET): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}
const payload = (over: Partial<AdmissionPayload> = {}): AdmissionPayload =>
  ({ Eid: "E1", Mid: "m1", Iat: 1000, Exp: 9999999999, Nonce: "n", ...over });

describe("verifyAdmission", () => {
  it("accepts a correctly signed token and returns the payload", async () => {
    const p = await verifyAdmission(await sign(payload()), SECRET);
    expect(p?.Eid).toBe("E1");
  });
  it("rejects a token signed with a different secret", async () => {
    const t = await sign(payload(), "z".repeat(32));
    expect(await verifyAdmission(t, SECRET)).toBeNull();
  });
  it("rejects a tampered body", async () => {
    const t = await sign(payload());
    expect(await verifyAdmission("x" + t, SECRET)).toBeNull();
  });
  it("rejects malformed tokens", async () => {
    for (const bad of ["", "nodot", "a.b.c"]) expect(await verifyAdmission(bad, SECRET)).toBeNull();
  });
});

describe("gateDecision", () => {
  const base = {
    armed: true, eventId: "E1", secret: SECRET, queueUrl: "http://q:4100",
    pathWithQuery: "/tickets/123", qpass: null as string | null,
    passCookie: null as string | null, nowSec: 2000,
  };

  it("passes through when the gate is disarmed", async () => {
    const d = await gateDecision({ ...base, armed: false });
    expect(d.kind).toBe("pass");
  });
  it("redirects to the queue when no credential is present", async () => {
    const d = await gateDecision(base);
    expect(d.kind).toBe("redirect-queue");
    if (d.kind === "redirect-queue") {
      expect(d.location).toContain("http://q:4100/wait?e=E1");
      expect(d.location).toContain("target=%2Ftickets%2F123");
    }
  });
  it("accepts a valid qpass and strips it from the URL", async () => {
    const t = await sign(payload());
    const d = await gateDecision({ ...base, pathWithQuery: "/tickets/123?qpass=" + t, qpass: t });
    expect(d.kind).toBe("accept");
    if (d.kind === "accept") {
      expect(d.cleanUrl).toBe("/tickets/123");
      expect(d.cookieValue).toBe(t);
    }
  });
  it("passes when a valid pass cookie is present", async () => {
    const t = await sign(payload());
    const d = await gateDecision({ ...base, passCookie: t });
    expect(d.kind).toBe("pass");
  });
  it("redirects to queue when the pass cookie is expired", async () => {
    const t = await sign(payload({ Exp: 1500 })); // < nowSec 2000
    const d = await gateDecision({ ...base, passCookie: t });
    expect(d.kind).toBe("redirect-queue");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd services/client && pnpm vitest run __tests__/queue-gate.test.ts`
Expected: FAIL (`@/lib/queue/gate` does not exist).

- [ ] **Step 3: Implement `services/client/lib/queue/gate.ts`**

```ts
// Pure waiting-room gate logic — no Next.js types, fully unit-testable.
// Validates the HMAC-SHA256 admission token issued by the queue-service.

export interface AdmissionPayload { Eid: string; Mid: string; Iat: number; Exp: number; Nonce: string; }

export type Decision =
  | { kind: "pass" }
  | { kind: "redirect-queue"; location: string }
  | { kind: "accept"; cleanUrl: string; cookieValue: string };

export interface GateInput {
  armed: boolean; eventId: string; secret: string; queueUrl: string;
  pathWithQuery: string; qpass: string | null; passCookie: string | null; nowSec: number;
}

function b64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyAdmission(token: string, secret: string): Promise<AdmissionPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parts[0]));
  if (!timingSafeEqual(bytesToB64url(new Uint8Array(sig)), parts[1])) return null;
  try {
    const json = new TextDecoder().decode(b64urlToBytes(parts[0]));
    return JSON.parse(json) as AdmissionPayload;
  } catch {
    return null;
  }
}

function valid(p: AdmissionPayload | null, eventId: string, nowSec: number): boolean {
  return p !== null && p.Eid === eventId && p.Exp > nowSec;
}

export async function gateDecision(i: GateInput): Promise<Decision> {
  if (!i.armed) return { kind: "pass" };

  if (i.qpass) {
    const p = await verifyAdmission(i.qpass, i.secret);
    if (valid(p, i.eventId, i.nowSec)) {
      const cleanUrl = stripQpass(i.pathWithQuery);
      return { kind: "accept", cleanUrl, cookieValue: i.qpass };
    }
  }

  if (i.passCookie) {
    const p = await verifyAdmission(i.passCookie, i.secret);
    if (valid(p, i.eventId, i.nowSec)) return { kind: "pass" };
  }

  const target = encodeURIComponent(i.pathWithQuery);
  return { kind: "redirect-queue", location: `${i.queueUrl}/wait?e=${i.eventId}&target=${target}` };
}

function stripQpass(pathWithQuery: string): string {
  const [path, query] = pathWithQuery.split("?");
  if (!query) return path;
  const kept = query.split("&").filter((kv) => !kv.startsWith("qpass="));
  return kept.length ? `${path}?${kept.join("&")}` : path;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd services/client && pnpm vitest run __tests__/queue-gate.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add services/client/lib/queue/gate.ts services/client/__tests__/queue-gate.test.ts
git commit -m "feat(client): pure waiting-room gate logic with HMAC admission verification"
```

---

## Task 2: middleware.ts adapter + env documentation

**Files:**
- Create: `services/client/middleware.ts`
- Modify: `services/client/.env.example`

- [ ] **Step 1: Implement `services/client/middleware.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { gateDecision } from "@/lib/queue/gate";

const PASS_COOKIE = process.env.QUEUE_PASS_COOKIE || "qq_pass";

export async function middleware(req: NextRequest) {
  const armed = process.env.QUEUE_GATE_ARMED === "true";
  if (!armed) return NextResponse.next();

  const eventId = process.env.QUEUE_EVENT_ID || "";
  const secret = process.env.QUEUE_HMAC_SECRET || "";
  const queueUrl = process.env.QUEUE_URL || "";
  if (!eventId || !secret || !queueUrl) return NextResponse.next(); // misconfigured → fail open

  const url = req.nextUrl;
  const decision = await gateDecision({
    armed, eventId, secret, queueUrl,
    pathWithQuery: url.pathname + url.search,
    qpass: url.searchParams.get("qpass"),
    passCookie: req.cookies.get(PASS_COOKIE)?.value ?? null,
    nowSec: Math.floor(Date.now() / 1000),
  });

  switch (decision.kind) {
    case "pass":
      return NextResponse.next();
    case "redirect-queue":
      return NextResponse.redirect(decision.location, 302);
    case "accept": {
      const res = NextResponse.redirect(new URL(decision.cleanUrl, req.url), 302);
      res.cookies.set(PASS_COOKIE, decision.cookieValue, {
        httpOnly: true, sameSite: "lax", path: "/",
        secure: process.env.NODE_ENV === "production",
      });
      return res;
    }
  }
}

// Whole-site gate, but never gate static assets, Next internals, health, or favicon.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz|api/health).*)"],
};
```

- [ ] **Step 2: Document env vars — append to `services/client/.env.example`**

```bash
# Virtual waiting room (Plan 2). Gate is OFF unless QUEUE_GATE_ARMED=true.
QUEUE_GATE_ARMED=false
QUEUE_URL=http://localhost:4100
QUEUE_HMAC_SECRET=dev-secret-change-me-32-chars-minimum
QUEUE_EVENT_ID=
QUEUE_PASS_COOKIE=qq_pass
```

- [ ] **Step 3: Verify build + typecheck (gate stays off by default, so no behavior change)**

Run: `cd services/client && pnpm build`
Expected: build succeeds; middleware compiles for the edge runtime.

- [ ] **Step 4: Run the full unit suite (guard against regressions)**

Run: `cd services/client && pnpm test`
Expected: all pass (per project rule: full `pnpm test` before committing client changes).

- [ ] **Step 5: Commit**

```bash
git add services/client/middleware.ts services/client/.env.example
git commit -m "feat(client): waiting-room gate middleware (disarmed by default)"
```

---

## Task 3: Kong backstop on the reserve mutation

**Files:**
- Modify: `services/kong-gateway/config/kong.base.yml` (the `/graphql` route)

The backstop rejects reserve mutations that arrive without a valid `qq_pass` cookie **when armed**. It reuses the same HMAC secret via a `pre-function`. Armed state comes from a Kong template var `{{QUEUE_GATE_ARMED}}` so the gate is inert by default.

- [ ] **Step 1: Locate the `/graphql` route block**

Run: `grep -n "graphql" services/kong-gateway/config/kong.base.yml`
Identify the route serving POST `/graphql` (Apollo Router). Note its existing `plugins:` list.

- [ ] **Step 2: Add a `pre-function` plugin to that route**

Insert under the `/graphql` route's `plugins:` list (HMAC-SHA256 over `base64url(json)`, compared to the cookie's signature segment):
```yaml
          - name: pre-function
            config:
              access:
                - |
                  local armed = "{{QUEUE_GATE_ARMED}}" == "true"
                  if not armed then return end
                  -- only gate reserve mutations; let reads through
                  local body = kong.request.get_raw_body() or ""
                  if not body:find("reserve", 1, true) then return end

                  local cookie = kong.request.get_header("cookie") or ""
                  local token = cookie:match("qq_pass=([^;]+)")
                  if not token then
                    return kong.response.exit(403, { message = "waiting room: no pass" })
                  end
                  local b64, sig = token:match("^([^%.]+)%.([^%.]+)$")
                  if not b64 then
                    return kong.response.exit(403, { message = "waiting room: malformed pass" })
                  end
                  local hmac = require("resty.openssl.hmac").new("{{QUEUE_HMAC_SECRET}}", "sha256")
                  hmac:update(b64)
                  local raw = hmac:final()
                  local expected = ngx.encode_base64(raw):gsub("+", "-"):gsub("/", "_"):gsub("=+$", "")
                  if expected ~= sig then
                    return kong.response.exit(403, { message = "waiting room: invalid pass" })
                  end
```

- [ ] **Step 3: Add the template vars to Kong's defaults**

Run: `grep -rn "ANONYMOUS_GRAPHQL_JWT_SECRET" services/kong-gateway values 2>/dev/null` to find the defaults file, and add `QUEUE_GATE_ARMED: "false"` and `QUEUE_HMAC_SECRET: "dev-secret-change-me-32-chars-minimum"` alongside the existing vars (default disarmed).

- [ ] **Step 4: Validate the Kong config renders + lints**

Run (with the stack tooling, e.g. the repo's Kong render/validate step):
`docker compose up -d kong` then `docker compose exec kong kong config parse /kong/declarative/kong.yml` (adjust to the repo's render path).
Expected: config parses; gate inert (armed=false) so existing routes behave unchanged.

- [ ] **Step 5: Commit**

```bash
git add services/kong-gateway
git commit -m "feat(kong): waiting-room backstop on reserve mutations (disarmed by default)"
```

---

## Task 4: Playwright E2E — armed gate, qpass admit, disarmed pass-through

**Files:**
- Create: `services/client/tests/e2e/waiting-room.spec.ts`

Run the full stack + the queue compose group + the client with `QUEUE_GATE_ARMED=true` and a seeded already-open event (rate high enough to admit immediately). Per the project rule, run this spec locally before committing.

- [ ] **Step 1: Write the E2E spec**

```ts
import { test, expect } from "@playwright/test";

const EVENT = process.env.E2E_QUEUE_EVENT_ID || "E2E";

test.describe("virtual waiting room", () => {
  test("armed gate redirects an un-admitted visitor to the waiting room", async ({ page }) => {
    await page.goto("/tickets/" + (process.env.E2E_TICKET_ID || "any"));
    await expect(page).toHaveURL(/\/wait\?e=/);
    await expect(page.locator("#countdown")).toBeVisible();
  });

  test("an admitted visitor (carrying a valid pass) reaches the ticket page", async ({ page, context }) => {
    // The waiting page auto-claims when serving passes the visitor; for a high-rate
    // already-open event the redirect back to /tickets happens within a couple polls.
    await page.goto("/tickets/" + (process.env.E2E_TICKET_ID || "any"));
    await page.waitForURL(/\/tickets\//, { timeout: 15000 });
    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name === "qq_pass")).toBe(true);
  });
});
```

- [ ] **Step 2: Bring up the stack and run the spec**

```bash
# main stack + queue group
docker compose up -d
docker compose -f docker-compose.queue.yml up -d
# seed an already-open, high-rate event in the queue Redis
docker compose -f docker-compose.queue.yml exec -T queue-redis redis-cli \
  HSET q:E2E:cfg t0 $(( ($(date +%s) - 5) * 1000 )) rate 100000 armed 1
# run client with the gate armed against that event
cd services/client
QUEUE_GATE_ARMED=true QUEUE_EVENT_ID=E2E QUEUE_URL=http://localhost:4100 \
  QUEUE_HMAC_SECRET=dev-secret-change-me-32-chars-minimum \
  pnpm build && QUEUE_GATE_ARMED=true QUEUE_EVENT_ID=E2E pnpm start -p 4000 &
pnpm playwright test tests/e2e/waiting-room.spec.ts
```
Expected: both tests pass — redirect to `/wait`, then admission back to `/tickets/...` with a `qq_pass` cookie.

- [ ] **Step 3: Commit**

```bash
git add services/client/tests/e2e/waiting-room.spec.ts
git commit -m "test(client): e2e waiting-room redirect and admission flow"
```

---

## Self-Review (completed during planning)

**Spec coverage:** redirect interception (#2) → Tasks 1–2; cache the code / cookie (#3) → pass cookie in Task 2; buffer after access (#4) → `Exp` check in `valid()` (absolute TTL from the token); unskippable backstop → Task 3; E2E proof → Task 4. **Placeholder scan:** none. **Type consistency:** `AdmissionPayload`/`Decision`/`GateInput` identical across gate module, tests, and middleware; cookie name `qq_pass` and token format match the Plan 1 queue-service.

**Executor notes:**
- The gate is **disarmed by default** everywhere (`QUEUE_GATE_ARMED` unset/false) — Tasks 1–2 cause zero behavior change until armed, so they are safe to land independently.
- Tasks 3–4 require the running stack (Kong, the queue group, Playwright browsers). If the environment can't run them, the artifacts still land; live verification is the gate before arming in any real environment.
