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
});
