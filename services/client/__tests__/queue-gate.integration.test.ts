import { describe, it, expect } from "vitest";
import { verifyAdmission, gateDecision } from "@/lib/queue/gate";

// Cross-language interop: a token minted by the .NET queue-service must verify
// under the JS gate. Skipped unless QUEUE_REAL_TOKEN is provided — set it to the
// `token` from `POST /api/claim` against a running queue-service, e.g.:
//   QUEUE_REAL_TOKEN=$(curl -s -b jar -X POST localhost:4100/api/claim?e=E2E | jq -r .token) pnpm vitest ...
const TOKEN = process.env.QUEUE_REAL_TOKEN;
const SECRET = process.env.QUEUE_REAL_SECRET || "dev-secret-change-me-32-chars-minimum";
const EVENT = process.env.QUEUE_REAL_EVENT || "E2E";

describe.skipIf(!TOKEN)("real .NET token interop", () => {
  it("verifyAdmission accepts a queue-service-issued token", async () => {
    const p = await verifyAdmission(TOKEN!, SECRET);
    expect(p).not.toBeNull();
    expect(p!.Eid).toBe(EVENT);
    expect(p!.Exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  // A claim token is an admission link, redeemed for a pass; it is not a pass itself.
  it("gateDecision accepts the token as an admission link for a logged-in visitor", async () => {
    const d = await gateDecision({
      armed: true, eventId: EVENT, secret: SECRET, queueUrl: "http://q:4100",
      fullUrl: "http://app:4000/tickets/1?qpass=" + TOKEN!,
      pathWithQuery: "/tickets/1?qpass=" + TOKEN!, qpass: TOKEN!, passCookie: null, admitCookie: null,
      nowSec: Math.floor(Date.now() / 1000), loggedIn: true,
    });
    expect(d.kind).toBe("accept");
  });
});
