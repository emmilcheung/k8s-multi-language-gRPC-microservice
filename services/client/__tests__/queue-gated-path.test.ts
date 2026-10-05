import { describe, it, expect } from "vitest";
import { isGatedPath } from "@/lib/queue/gated-path";

describe("isGatedPath", () => {
  // Purchases start on the event page itself (general-admission buy form),
  // the seat picker and the plan pages.
  it("gates the armed event's purchase-start pages", () => {
    for (const p of ["/tickets/X", "/tickets/X/seats", "/tickets/X/plans/p1", "/tickets/X/plans"]) {
      expect(isGatedPath(p, "X"), p).toBe(true);
    }
  });
  it("does not gate other pages of the armed event that are not purchases", () => {
    for (const p of ["/tickets/X/admission", "/tickets/X/attendance"]) {
      expect(isGatedPath(p, "X"), p).toBe(false);
    }
  });
  // A buyer whose pass lapsed mid-payment must still be able to pay.
  it("never gates payment or account pages", () => {
    for (const p of ["/", "/orders", "/orders/o1", "/orders/o1/refund", "/checkout/recover",
      "/settings", "/organizer/events/X/edit", "/auth/signin", "/tickets/new", "/tickets"]) {
      expect(isGatedPath(p, "X"), p).toBe(false);
    }
  });
  it("does not gate other events", () => {
    for (const p of ["/tickets/Y", "/tickets/Y/seats", "/tickets/Y/plans/X"]) {
      expect(isGatedPath(p, "X"), p).toBe(false);
    }
  });
  it("matches the id exactly, not as a prefix or suffix", () => {
    for (const p of ["/tickets/X-other", "/tickets/XX/seats", "/tickets/aX", "/tickets/X.json"]) {
      expect(isGatedPath(p, "X"), p).toBe(false);
    }
  });
  it("ignores trailing and repeated slashes", () => {
    for (const p of ["/tickets/X/", "/tickets/X/seats/", "//tickets//X//seats"]) {
      expect(isGatedPath(p, "X"), p).toBe(true);
    }
  });
  it("sees through URL-encoded ids and sub-paths", () => {
    expect(isGatedPath("/tickets/%58", "X")).toBe(true);
    expect(isGatedPath("/tickets/X/%73eats", "X")).toBe(true);
    expect(isGatedPath("/%74ickets/X", "X")).toBe(true);
    expect(isGatedPath("/tickets/a%2Fb", "a/b")).toBe(true);
    expect(isGatedPath("/tickets/X%2Fseats", "X")).toBe(false);
  });
  it("fails closed on malformed encoding under the tickets tree", () => {
    expect(isGatedPath("/tickets/%E0%A4%A", "X")).toBe(true);
  });
});
