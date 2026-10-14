import { describe, expect, it } from "vitest";
import { redactPersonalData } from "./audit";

describe("audit never keeps attendee names or emails", () => {
  it("blanks email and attendee name fields but keeps the fact they changed", () => {
    const out = redactPersonalData({
      status: "ACTIVE",
      contactEmail: "a@b.com",
      attendeeName: "Ada Lovelace",
      holder_email: "c@d.com",
      nested: { buyerName: "Bob", seats: 2 },
      list: [{ firstName: "Eve", row: "A" }],
    });
    expect(out).toEqual({
      status: "ACTIVE",
      contactEmail: "[redacted]",
      attendeeName: "[redacted]",
      holder_email: "[redacted]",
      nested: { buyerName: "[redacted]", seats: 2 },
      list: [{ firstName: "[redacted]", row: "A" }],
    });
  });

  it("keeps the plain name of an account, venue or event, which is not personal data", () => {
    expect(redactPersonalData({ name: "Main Hall" })).toEqual({
      name: "Main Hall",
    });
  });

  it("redacts personal data inside nested arrays of objects and keeps dates intact", () => {
    const when = new Date("2026-01-01T00:00:00Z");
    const out = redactPersonalData({
      rows: [[{ holderEmail: "a@b.com" }]],
      starts: when,
    });
    expect(out).toEqual({
      rows: [[{ holderEmail: "[redacted]" }]],
      starts: when,
    });
  });
});
